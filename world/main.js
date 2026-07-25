import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { EditorControls } from './lib/editor-controls.js';
import { loadURDF } from './lib/urdf-loader.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ---------------------------------------------------------------- config
const MODEL_URL = './assets/desk.glb';
const WORLD_SIZE = 16;     // normalize largest scene dimension to this many world units
// If the scan comes out tilted, correct it here (radians), applied X then Y then Z.
const WORLD_ROTATION = new THREE.Euler(0, 0, 0);

// The scan is normalized to WORLD_SIZE units, so world units are not metres.
// URDFs are in metres — measure the longest dimension of the real desk and put it
// here, and every URDF asset lands at true physical scale relative to the scan.
const DESK_SPAN_METERS = 1.6;
const UNITS_PER_METER = WORLD_SIZE / DESK_SPAN_METERS;

const ASSETS = {
  so101: { url: './assets/so101/so101_new_calib.urdf', label: 'SO-101' },
};

// ---------------------------------------------------------------- scene
const container = document.getElementById('app');

// Measure the container, not the window: embedded panes can report innerWidth 0,
// which would poison the camera aspect with NaN and render nothing forever.
function viewportSize() {
  const w = container.clientWidth || innerWidth || document.documentElement.clientWidth;
  const h = container.clientHeight || innerHeight || document.documentElement.clientHeight;
  return { w: Math.max(1, w || 1), h: Math.max(1, h || 1) };
}
const view = viewportSize();

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(view.w, view.h);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10151c);
// fog only swallows the far edge of the grid — the editor camera can pull way back
scene.fog = new THREE.Fog(0x10151c, WORLD_SIZE * 4, WORLD_SIZE * 12);

const camera = new THREE.PerspectiveCamera(55, view.w / view.h, 0.02, 2000);

const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x3a3228, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(4, 8, 3);
scene.add(sun);
scene.add(new THREE.AmbientLight(0xffffff, 0.35));

const grid = new THREE.GridHelper(WORLD_SIZE * 8, 64, 0x2b3946, 0x1a232d);
grid.position.y = -0.01;
scene.add(grid);

// ---------------------------------------------------------------- pick surface
// One merged BVH mesh of everything you can drop something onto. Invisible, but
// the raycaster still sees it (three only filters by layers, not visibility).
const colliderGeometries = [];

function addColliderGeometry(mesh) {
  const geom = mesh.geometry.clone();
  geom.applyMatrix4(mesh.matrixWorld);
  for (const name of Object.keys(geom.attributes)) {
    if (name !== 'position') geom.deleteAttribute(name);
  }
  colliderGeometries.push(geom.index ? geom.toNonIndexed() : geom);
}

// ground plane, so a drop always lands somewhere even off the edge of the scan
{
  const ground = new THREE.Mesh(new THREE.BoxGeometry(WORLD_SIZE * 8, 0.2, WORLD_SIZE * 8));
  ground.position.y = -0.1;
  ground.updateMatrixWorld();
  addColliderGeometry(ground);
}

let collider = null;
function buildCollider() {
  const merged = mergeGeometries(colliderGeometries, false);
  merged.computeBoundsTree();
  collider = new THREE.Mesh(merged);
  collider.visible = false;
  collider.name = 'pick-surface';
  scene.add(collider);
}

// ---------------------------------------------------------------- editor camera
const controls = new EditorControls(camera, renderer.domElement, {
  minDistance: 0.15,
  maxDistance: WORLD_SIZE * 20,
  flySpeed: WORLD_SIZE * 0.35,
});
controls.set(new THREE.Vector3(0, WORLD_SIZE * 0.15, 0), { yaw: 0.6, pitch: -0.45, distance: WORLD_SIZE * 1.4 });

const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSpace('world');
gizmo.addEventListener('dragging-changed', (e) => { controls.enabled = !e.value; });
gizmo.addEventListener('objectChange', () => { selectionBox.update(); syncJointUI(); });
// three r169+ splits the visual helper out of the controls object
scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);

const selectionBox = new THREE.BoxHelper(new THREE.Object3D(), 0x7fd4ff);
selectionBox.visible = false;
selectionBox.material.depthTest = false;
selectionBox.material.transparent = true;
scene.add(selectionBox);

// ---------------------------------------------------------------- world model
const overlay = document.getElementById('overlay');
const loadbarFill = document.querySelector('#loadbar div');
const loadnote = document.getElementById('loadnote');
let worldModel = null;

// Photogrammetry scans come out slightly tilted (video frames carry no gravity
// metadata) — measure the dominant upward-facing surface and rotate it level.
function autoLevel(model) {
  model.traverse((o) => { if (o.isMesh && !o.geometry.boundsTree) o.geometry.computeBoundsTree(); });
  const box = new THREE.Box3().setFromObject(model);
  const ray = new THREE.Raycaster();
  ray.far = (box.max.y - box.min.y) + 2;
  const normalSum = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  let hits = 0;
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 7; j++) {
      const x = THREE.MathUtils.lerp(box.min.x, box.max.x, 0.2 + 0.6 * (i / 6));
      const z = THREE.MathUtils.lerp(box.min.z, box.max.z, 0.2 + 0.6 * (j / 6));
      ray.set(new THREE.Vector3(x, box.max.y + 1, z), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(model, true)[0];
      if (hit && hit.face) {
        const n = hit.face.normal.clone().applyMatrix3(nm.getNormalMatrix(hit.object.matrixWorld)).normalize();
        if (n.y > 0.7) { normalSum.add(n); hits++; }
      }
    }
  }
  if (hits >= 5) {
    const avg = normalSum.normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(avg, new THREE.Vector3(0, 1, 0));
    model.quaternion.premultiply(q);
    model.updateMatrixWorld(true);
    console.log('auto-level: tilt was', THREE.MathUtils.radToDeg(avg.angleTo(new THREE.Vector3(0, 1, 0))).toFixed(2), 'deg,', hits, 'samples');
  }
}

new GLTFLoader().load(
  MODEL_URL,
  (gltf) => {
    const model = gltf.scene;

    // normalize: rotate, scale to WORLD_SIZE, center XZ on origin, floor at y=0
    model.rotation.copy(WORLD_ROTATION);
    model.updateMatrixWorld(true);
    autoLevel(model);
    let box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const scale = WORLD_SIZE / Math.max(size.x, size.y, size.z);
    model.scale.setScalar(scale);
    model.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box.min.y;
    model.updateMatrixWorld(true);

    model.traverse((o) => {
      if (o.isMesh) {
        o.material.side = THREE.DoubleSide;
        addColliderGeometry(o);
      }
    });
    scene.add(model);
    worldModel = model;
    buildCollider();
    controls.frame(new THREE.Box3().setFromObject(model), { yaw: 0.6, pitch: -0.5 });
    worldReady();
  },
  (ev) => {
    if (ev.total) loadbarFill.style.width = `${Math.round((ev.loaded / ev.total) * 55)}%`;
  },
  (err) => {
    console.error('model load failed', err);
    buildCollider();
    worldReady('Could not load assets/desk.glb — dropping assets onto the empty grid instead.');
  }
);

function worldReady(warning) {
  loadbarFill.style.width = '60%';
  loadnote.textContent = warning || 'loading SO-101 meshes…';
  loadURDF(ASSETS.so101.url, {
    onProgress: (done, total) => {
      loadbarFill.style.width = `${60 + Math.round((done / total) * 40)}%`;
      loadnote.textContent = `loading SO-101 meshes… ${done}/${total}`;
    },
  })
    .then((asset) => {
      ASSETS.so101.asset = asset;
      buildGhost(asset);
      shelfItem.setAttribute('draggable', 'true');
      shelfItem.setAttribute('aria-disabled', 'false');
      shelfStatus.textContent = `${asset.spec.joints.filter((j) => j.type !== 'fixed').length} joints · URDF`;
      dismissOverlay();
    })
    .catch((err) => {
      console.error('URDF load failed', err);
      shelfStatus.textContent = 'failed to load';
      dismissOverlay();
    });
}

function dismissOverlay() {
  loadbarFill.style.width = '100%';
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.style.display = 'none'; }, 380);
}

// ---------------------------------------------------------------- instances
const placed = [];
let instanceCount = 0;

function makeInstance(key) {
  const entry = ASSETS[key];
  if (!entry || !entry.asset) return null;
  const robot = entry.asset.build();
  robot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(robot);
  robot.position.y = -box.min.y; // stand the base on the instance origin

  const inst = new THREE.Group();
  inst.name = `${entry.label} ${String(++instanceCount).padStart(2, '0')}`;
  inst.scale.setScalar(UNITS_PER_METER);
  inst.userData = { assetKey: key, robot, isPlaced: true };
  inst.add(robot);
  return inst;
}

// Drop a new arm turned toward the viewer: the URDF's base points along its own
// +X, so we rotate that axis to face the camera.
function facingYaw() {
  return controls.yaw - Math.PI / 2;
}

function addInstance(key, position, yaw = 0) {
  const inst = makeInstance(key);
  if (!inst) return null;
  inst.position.copy(position);
  inst.rotation.y = yaw;
  scene.add(inst);
  placed.push(inst);
  select(inst);
  return inst;
}

function removeInstance(inst) {
  const i = placed.indexOf(inst);
  if (i >= 0) placed.splice(i, 1);
  if (selection === inst) select(null);
  scene.remove(inst);
  // geometries and materials belong to the shared URDFAsset — nothing to dispose
}

// ---------------------------------------------------------------- drag preview
let ghost = null;
const ghostMaterial = new THREE.MeshBasicMaterial({
  color: 0x7fd4ff, transparent: true, opacity: 0.4, depthWrite: false,
});
// radii are in the URDF's own metres — the ghost group applies the world scale
const ghostRing = new THREE.Mesh(
  new THREE.RingGeometry(0.13, 0.16, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthTest: false })
);

function buildGhost(asset) {
  const robot = asset.build(ghostMaterial);
  robot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(robot);
  robot.position.y = -box.min.y;
  ghost = new THREE.Group();
  ghost.scale.setScalar(UNITS_PER_METER);
  ghost.visible = false;
  ghost.add(robot);
  ghost.add(ghostRing);
  scene.add(ghost);
}

// ---------------------------------------------------------------- picking
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const ndc = new THREE.Vector2();

function toNDC(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  return ndc;
}

/** Closest point on the desk / ground / other placed assets under the cursor. */
function surfaceHit(clientX, clientY, exclude) {
  raycaster.setFromCamera(toNDC(clientX, clientY), camera);
  const targets = collider ? [collider] : [];
  for (const p of placed) if (p !== exclude) targets.push(p);
  return raycaster.intersectObjects(targets, true)[0] || null;
}

/** Straight-down probe used to keep a dragged object glued to whatever is beneath it. */
const downRay = new THREE.Raycaster();
downRay.firstHitOnly = true;
function surfaceHeightAt(x, z, fromY, exclude) {
  downRay.set(new THREE.Vector3(x, fromY, z), new THREE.Vector3(0, -1, 0));
  const targets = collider ? [collider] : [];
  for (const p of placed) if (p !== exclude) targets.push(p);
  const hit = downRay.intersectObjects(targets, true)[0];
  return hit ? hit.point.y : null;
}

function pickInstance(clientX, clientY) {
  if (!placed.length) return null;
  raycaster.setFromCamera(toNDC(clientX, clientY), camera);
  const hit = raycaster.intersectObjects(placed, true)[0];
  if (!hit) return null;
  let o = hit.object;
  while (o && !o.userData.isPlaced) o = o.parent;
  return o ? { inst: o, point: hit.point } : null;
}

function dropToSurface(inst) {
  const y = surfaceHeightAt(inst.position.x, inst.position.z, inst.position.y + WORLD_SIZE, inst);
  if (y !== null) inst.position.y = y;
  selectionBox.update();
}

// ---------------------------------------------------------------- selection
let selection = null;

function select(inst) {
  selection = inst;
  if (inst) {
    gizmo.attach(inst);
    selectionBox.setFromObject(inst);
    selectionBox.visible = true;
  } else {
    gizmo.detach();
    selectionBox.visible = false;
  }
  refreshInspector();
}

// ---------------------------------------------------------------- pointer input
const shelfItem = document.getElementById('asset-so101');
const shelfStatus = document.getElementById('asset-so101-status');

let objDrag = null;      // { inst, offsetX, offsetZ, startX, startY, moved }
let clickCandidate = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (gizmo.dragging || gizmo.axis) return; // the gizmo owns this press

  if (e.button === 1) { e.preventDefault(); controls.startDrag(e.shiftKey ? 'pan' : 'orbit', e); return; }
  if (e.button === 2) { controls.startDrag('look', e); return; }
  if (e.button !== 0) return;

  if (e.altKey) { controls.startDrag(e.shiftKey ? 'pan' : 'orbit', e); return; }
  if (e.shiftKey) { controls.startDrag('pan', e); return; }

  const hit = pickInstance(e.clientX, e.clientY);
  if (hit) {
    select(hit.inst);
    objDrag = {
      inst: hit.inst,
      offsetX: hit.inst.position.x - hit.point.x,
      offsetZ: hit.inst.position.z - hit.point.z,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    renderer.domElement.setPointerCapture?.(e.pointerId);
  } else {
    clickCandidate = { x: e.clientX, y: e.clientY };
    controls.startDrag('orbit', e);
  }
});

addEventListener('pointermove', (e) => {
  if (!objDrag) return;
  if (!objDrag.moved) {
    if (Math.hypot(e.clientX - objDrag.startX, e.clientY - objDrag.startY) < 4) return;
    objDrag.moved = true;
  }
  const hit = surfaceHit(e.clientX, e.clientY, objDrag.inst);
  if (!hit) return;
  // the cursor hit is under the grab point, not under the object's base — re-probe
  // at the base's own x/z, from just above, so it tracks the surface it is sliding on
  const x = hit.point.x + objDrag.offsetX;
  const z = hit.point.z + objDrag.offsetZ;
  const y = surfaceHeightAt(x, z, hit.point.y + WORLD_SIZE * 0.05, objDrag.inst);
  objDrag.inst.position.set(x, y === null ? hit.point.y : y, z);
  selectionBox.update();
});

addEventListener('pointerup', (e) => {
  if (objDrag) {
    renderer.domElement.releasePointerCapture?.(e.pointerId);
    objDrag = null;
  }
  if (clickCandidate) {
    // a press on empty space that never turned into an orbit = deselect
    if (Math.hypot(e.clientX - clickCandidate.x, e.clientY - clickCandidate.y) < 4) select(null);
    clickCandidate = null;
  }
});

// ---------------------------------------------------------------- drag & drop
function placementFromEvent(e) {
  const hit = surfaceHit(e.clientX, e.clientY, null);
  if (hit) return hit.point.clone();
  // no surface under the cursor: drop it on the ground plane at the cursor ray
  raycaster.setFromCamera(toNDC(e.clientX, e.clientY), camera);
  const p = new THREE.Vector3();
  return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? p : null;
}

shelfItem.addEventListener('dragstart', (e) => {
  if (!ASSETS.so101.asset) { e.preventDefault(); return; }
  e.dataTransfer.setData('text/plain', 'so101');
  e.dataTransfer.effectAllowed = 'copy';
});
shelfItem.addEventListener('dragend', () => { if (ghost) ghost.visible = false; });

renderer.domElement.addEventListener('dragover', (e) => {
  if (!ghost) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const p = placementFromEvent(e);
  ghost.visible = !!p;
  if (p) ghost.position.copy(p);
});
renderer.domElement.addEventListener('dragleave', () => { if (ghost) ghost.visible = false; });
renderer.domElement.addEventListener('drop', (e) => {
  e.preventDefault();
  if (ghost) ghost.visible = false;
  const p = placementFromEvent(e);
  if (p) addInstance('so101', p, facingYaw());
});

// click the shelf card to place one in front of the camera
shelfItem.addEventListener('click', () => {
  if (!ASSETS.so101.asset) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const fake = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  const p = placementFromEvent(fake) || controls.pivot.clone();
  addInstance('so101', p, facingYaw());
});

// ---------------------------------------------------------------- keyboard
const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

addEventListener('keydown', (e) => {
  if (TYPING.has(e.target.tagName)) return;
  if (e.metaKey || e.ctrlKey) return;
  if (controls.flying) return; // WASD belongs to the fly camera while RMB is down

  switch (e.code) {
    case 'KeyG': setMode('translate'); break;
    case 'KeyR': setMode('rotate'); break;
    case 'KeyS': setMode('scale'); break;
    case 'KeyF': frameSelection(); break;
    case 'Home': frameAll(); break;
    case 'Escape': select(null); break;
    case 'KeyD':
      if (e.shiftKey) duplicateSelection();
      break;
    case 'KeyX':
    case 'Delete':
    case 'Backspace':
      if (selection) { e.preventDefault(); removeInstance(selection); }
      break;
    default: return;
  }
});

// hold Ctrl/Cmd for grid snapping while dragging the gizmo
addEventListener('keydown', (e) => {
  if (e.key === 'Control' || e.key === 'Meta') {
    gizmo.setTranslationSnap(WORLD_SIZE / 32);
    gizmo.setRotationSnap(THREE.MathUtils.degToRad(15));
    gizmo.setScaleSnap(0.1);
  }
});
addEventListener('keyup', (e) => {
  if (e.key === 'Control' || e.key === 'Meta') {
    gizmo.setTranslationSnap(null);
    gizmo.setRotationSnap(null);
    gizmo.setScaleSnap(null);
  }
});

function setMode(mode) {
  gizmo.setMode(mode);
  for (const b of document.querySelectorAll('#insp-modes button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  }
}

function frameSelection() {
  if (!selection) return frameAll();
  controls.frame(new THREE.Box3().setFromObject(selection));
}

function frameAll() {
  const box = new THREE.Box3();
  if (worldModel) box.expandByObject(worldModel);
  for (const p of placed) box.expandByObject(p);
  if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(WORLD_SIZE, 1, WORLD_SIZE));
  controls.frame(box);
}

function duplicateSelection() {
  if (!selection) return;
  const copy = makeInstance(selection.userData.assetKey);
  if (!copy) return;
  copy.position.copy(selection.position);
  copy.quaternion.copy(selection.quaternion);
  copy.scale.copy(selection.scale);
  copy.position.x += WORLD_SIZE * 0.05;
  for (const [name, j] of selection.userData.robot.joints) copy.userData.robot.setJointValue(name, j.value);
  scene.add(copy);
  placed.push(copy);
  dropToSurface(copy);
  select(copy);
}

// ---------------------------------------------------------------- inspector UI
const inspector = document.getElementById('inspector');
const inspName = document.getElementById('insp-name');
const jointsBox = document.getElementById('joints');
let jointRows = [];

document.getElementById('insp-modes').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setMode(b.dataset.mode);
});
document.getElementById('insp-drop').addEventListener('click', () => selection && dropToSurface(selection));
document.getElementById('insp-dup').addEventListener('click', duplicateSelection);
document.getElementById('insp-focus').addEventListener('click', frameSelection);
document.getElementById('insp-del').addEventListener('click', () => selection && removeInstance(selection));

function refreshInspector() {
  jointRows = [];
  if (!selection) { inspector.hidden = true; jointsBox.replaceChildren(); return; }
  inspector.hidden = false;
  inspName.textContent = selection.name;

  const robot = selection.userData.robot;
  jointsBox.replaceChildren();
  if (!robot || !robot.joints.size) return;

  const head = document.createElement('div');
  head.className = 'jhead';
  head.innerHTML = '<span>Joints</span>';
  const reset = document.createElement('button');
  reset.textContent = 'Reset';
  reset.addEventListener('click', () => {
    robot.resetJoints();
    syncJointUI();
    selectionBox.update();
  });
  head.appendChild(reset);
  jointsBox.appendChild(head);

  for (const [name, j] of robot.joints) {
    const row = document.createElement('div');
    row.className = 'joint';
    const label = document.createElement('label');
    label.textContent = name;
    const out = document.createElement('output');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(j.lower);
    input.max = String(j.upper);
    input.step = '0.005';
    input.value = String(j.value);
    input.addEventListener('input', () => {
      robot.setJointValue(name, Number(input.value));
      out.textContent = `${THREE.MathUtils.radToDeg(j.value).toFixed(0)}°`;
      selectionBox.update();
    });
    out.textContent = `${THREE.MathUtils.radToDeg(j.value).toFixed(0)}°`;
    row.append(label, out, input);
    jointsBox.appendChild(row);
    jointRows.push({ name, j, input, out });
  }
}

function syncJointUI() {
  for (const r of jointRows) {
    r.input.value = String(r.j.value);
    r.out.textContent = `${THREE.MathUtils.radToDeg(r.j.value).toFixed(0)}°`;
  }
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  controls.update(Math.min(clock.getDelta(), 0.05));
  renderer.render(scene, camera);
}
animate();

function onViewportChange() {
  const { w, h } = viewportSize();
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
addEventListener('resize', onViewportChange);
new ResizeObserver(onViewportChange).observe(container);

// debug handle: drive the editor from the console / automation
window.__editor = {
  THREE, scene, camera, controls, gizmo, placed, ASSETS,
  addInstance, removeInstance, select, frameAll, frameSelection, dropToSurface, syncJointUI,
  get selection() { return selection; },
};
