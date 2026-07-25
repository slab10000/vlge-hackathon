// Blender-style viewport camera: you float around the scene instead of walking it.
//
//   MMB drag / Alt+LMB drag ....... orbit around the pivot
//   Shift+MMB / Shift+LMB drag .... pan the pivot
//   wheel ......................... dolly toward the point under the cursor
//   RMB drag ...................... free look (pivot follows the camera)
//   WASD / QE while RMB held ...... fly, Shift for a boost
//
// The camera is stored as (pivot, yaw, pitch, distance). Orbiting keeps the pivot
// and moves the camera; looking keeps the camera and moves the pivot. That single
// distinction is what makes an editor camera feel like an editor camera.
//
// Navigation drags are *started by the host* (`startDrag`) so it can decide first
// whether a left-press should instead hit a gizmo or grab an object; once started,
// this class owns the move/up handling.

import * as THREE from 'three';

const MODES = ['orbit', 'pan', 'look'];
const FLY_KEYS = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  KeyE: 'up', KeyQ: 'down',
};

export class EditorControls {
  constructor(camera, domElement, { minDistance = 0.05, maxDistance = 500, flySpeed = 5 } = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.pivot = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.5;
    this.distance = 10;
    this.minDistance = minDistance;
    this.maxDistance = maxDistance;
    this.flySpeed = flySpeed;
    this.enabled = true;
    this.mode = null; // active nav drag
    this.keys = new Set();

    this._pointer = { x: 0, y: 0 };
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._ray = new THREE.Raycaster();
    this._plane = new THREE.Plane();

    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onContext = (e) => e.preventDefault();
    this._onBlur = () => { this.keys.clear(); this.mode = null; };

    domElement.addEventListener('wheel', this._onWheel, { passive: false });
    domElement.addEventListener('contextmenu', this._onContext);
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this._onBlur(); });

    this.apply();
  }

  dispose() {
    this.domElement.removeEventListener('wheel', this._onWheel);
    this.domElement.removeEventListener('contextmenu', this._onContext);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
  }

  get flying() { return this.mode === 'look'; }

  // ------------------------------------------------------------ camera maths
  apply() {
    const cp = Math.cos(this.pitch);
    this._forward.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    this.camera.position.copy(this.pivot).addScaledVector(this._forward, -this.distance);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
    this._right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._up.setFromMatrixColumn(this.camera.matrixWorld, 1);
  }

  /** Point the camera at `pivot` from `yaw/pitch/distance`. */
  set(pivot, { yaw = this.yaw, pitch = this.pitch, distance = this.distance } = {}) {
    this.pivot.copy(pivot);
    this.yaw = yaw;
    this.pitch = THREE.MathUtils.clamp(pitch, -1.5533, 1.5533);
    this.distance = THREE.MathUtils.clamp(distance, this.minDistance, this.maxDistance);
    this.apply();
  }

  /** Frame a Box3 so it fills the viewport with a little margin. */
  frame(box, { yaw = this.yaw, pitch = this.pitch } = {}) {
    if (box.isEmpty()) return;
    const size = box.getSize(this._tmp);
    const radius = Math.max(size.length() * 0.5, 1e-3);
    const aspect = this.camera.aspect > 0 ? this.camera.aspect : 1; // NaN-safe
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.1;
    this.set(box.getCenter(new THREE.Vector3()), { yaw, pitch, distance });
  }

  // ------------------------------------------------------------ drag handling
  /** Called by the host on pointerdown once it has decided this press is navigation. */
  startDrag(mode, event) {
    if (!this.enabled || !MODES.includes(mode)) return;
    this.mode = mode;
    this._pointer.x = event.clientX;
    this._pointer.y = event.clientY;
    this._pointerId = event.pointerId;
    if (mode !== 'look') this.keys.clear();
  }

  _onMove(e) {
    if (!this.mode) return;
    const dx = e.clientX - this._pointer.x;
    const dy = e.clientY - this._pointer.y;
    this._pointer.x = e.clientX;
    this._pointer.y = e.clientY;
    if (!dx && !dy) return;

    if (this.mode === 'pan') {
      const h = this.domElement.clientHeight || 1;
      const perPixel = (2 * this.distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / h;
      this.pivot.addScaledVector(this._right, -dx * perPixel).addScaledVector(this._up, dy * perPixel);
    } else {
      this.yaw -= dx * 0.005;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.005, -1.5533, 1.5533);
      if (this.mode === 'look') {
        // keep the eye where it is and swing the pivot around instead
        const eye = this._tmp.copy(this.camera.position);
        const cp = Math.cos(this.pitch);
        this._forward.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
        this.pivot.copy(eye).addScaledVector(this._forward, this.distance);
      }
    }
    this.apply();
  }

  _onUp(e) {
    if (this.mode && (this._pointerId === undefined || e.pointerId === this._pointerId)) {
      this.mode = null;
      this.keys.clear();
    }
  }

  _onWheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    // trackpads emit many small deltas, mice a few big ones — normalise both
    const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const factor = THREE.MathUtils.clamp(Math.exp(step * 0.0015), 0.2, 5);
    const before = this._pointOnFocalPlane(e);
    this.distance = THREE.MathUtils.clamp(this.distance * factor, this.minDistance, this.maxDistance);
    this.apply();
    if (before) {
      const after = this._pointOnFocalPlane(e);
      if (after) this.pivot.add(before.sub(after)); // keep the cursor over the same spot
      this.apply();
    }
  }

  // where the cursor ray meets the plane through the pivot facing the camera
  _pointOnFocalPlane(e) {
    const rect = this.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ndc = {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
    };
    this._ray.setFromCamera(ndc, this.camera);
    this._plane.setFromNormalAndCoplanarPoint(this._forward, this.pivot);
    return this._ray.ray.intersectPlane(this._plane, new THREE.Vector3());
  }

  // ------------------------------------------------------------ fly keys
  _onKeyDown(e) {
    this._shift = e.shiftKey;
    if (!this.flying) return;
    if (FLY_KEYS[e.code]) { this.keys.add(e.code); e.preventDefault(); }
  }

  _onKeyUp(e) {
    this._shift = e.shiftKey;
    this.keys.delete(e.code);
  }

  update(delta) {
    if (!this.flying || !this.keys.size) return;
    const dir = this._tmp.set(0, 0, 0);
    for (const code of this.keys) {
      switch (FLY_KEYS[code]) {
        case 'forward': dir.add(this._forward); break;
        case 'back': dir.sub(this._forward); break;
        case 'right': dir.add(this._right); break;
        case 'left': dir.sub(this._right); break;
        case 'up': dir.y += 1; break;
        case 'down': dir.y -= 1; break;
      }
    }
    if (dir.lengthSq() === 0) return;
    const boost = this._shift ? 3 : 1;
    this.pivot.addScaledVector(dir.normalize(), this.flySpeed * boost * delta);
    this.apply();
  }
}
