import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { EditorControls } from './lib/editor-controls.js';
import { loadURDF } from './lib/urdf-loader.js';
import { scanLibrary, loadLibraryAsset, LIBRARY_URL } from './lib/asset-library.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// Optional physics engine (Rapier, WASM). The editor is fully usable without it —
// only the Simulate toggle goes dark — so never let a CDN hiccup break the app.
let RAPIER = null;
try {
  RAPIER = (await import('https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/+esm')).default;
  await RAPIER.init();
} catch (err) {
  console.warn('Rapier unavailable — physics simulation disabled:', err);
}

// ---------------------------------------------------------------- config
// Scenario registry — each entry is a scanned scene you can hot-swap to
// (picker buttons top-right, or number keys 1..9). Last choice persists.
const SCENARIOS = [
  { id: 'desk',   name: 'Desk',        url: './assets/desk.glb' },
  { id: 'snacks', name: 'Snack Table', url: './assets/snacks.glb' },
  { id: 'laptop', name: 'Laptop Desk', url: './assets/laptop.glb' },
];
const WORLD_SIZE = 16;     // normalize largest scene dimension to this many world units
// If the scan comes out tilted, correct it here (radians), applied X then Y then Z.
const WORLD_ROTATION = new THREE.Euler(0, 0, 0);

// The scan is normalized to WORLD_SIZE units, so world units are not metres.
// URDFs are in metres — measure the longest dimension of the real desk and put it
// here, and every URDF asset lands at true physical scale relative to the scan.
const DESK_SPAN_METERS = 1.6;
const UNITS_PER_METER = WORLD_SIZE / DESK_SPAN_METERS;

// Droppable assets. URDF entries are articulated robots; mesh entries (.glb /
// .gltf / .ply) are real objects captured with tools/make_object.py — already in
// metres, so they inherit UNITS_PER_METER and land at true physical scale.
//
// This is only the built-in set. Anything dropped into world/assets/library/ is
// discovered at boot and appended — see lib/asset-library.js.
const ASSETS = {
  so101: { url: './assets/so101/so101_new_calib.urdf', label: 'SO-101', kind: 'urdf', icon: '🦾' },
  piper: {
    url: './assets/piper_x_arm/piper_x_arm.urdf', label: 'Piper-X', kind: 'urdf', icon: '🦿',
    // Wrist RealSense D405. The URDF has the sensor *housing* frame but no optical
    // frame — URDF has no camera element — so the optical rotation comes from the
    // package README (converted from the source MJCF's euler="0 -1.2057 -1.5708").
    // That is the MuJoCo/OpenGL convention: +X right, +Y up, -Z forward, which is
    // exactly what a three.js camera expects, so it drops straight in.
    camera: {
      link: 'camera',
      rpy: [1.2057, 0, -1.570796],   // relative to the `camera` link, URDF fixed-axis
      label: 'RealSense D405 · wrist',
      fovY: 58,                      // D405 RGB spec is 87° x 58° (H x V)
      aspect: 848 / 480,             // the stream's own aspect; tune it in the panel
      near: 0.03, far: 0.6,          // metres — the D405's usable depth range
    },
  },
  bottle: { url: './assets/objects/test_bottle.glb', label: 'Bottle', kind: 'glb', icon: '🍶',
            note: 'captured object' },
};

// Size the next drop of each asset uses, as a multiple of true physical scale
// (1 = the asset's own metres). Set from the inspector, kept across reloads.
//
// Keyed on its own map rather than on the ASSETS entries: library assets are
// discovered after boot, and they must still pick up a size saved last session.
const SIZE_STORE_KEY = 'deskTwin.assetScale';
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const savedScales = new Map(); // asset key -> Vector3 multiple of physical scale

function loadDefaultScales() {
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_STORE_KEY) || '{}');
    for (const [key, v] of Object.entries(saved)) {
      const ok = Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n) && n > 0);
      if (ok) savedScales.set(key, new THREE.Vector3().fromArray(v));
    }
  } catch (err) {
    console.warn('ignoring unreadable saved asset sizes', err);
  }
}

function saveDefaultScales() {
  try {
    const out = {};
    for (const [key, v] of savedScales) {
      if (!key.startsWith('file:')) out[key] = v.toArray(); // blob keys die with the session
    }
    localStorage.setItem(SIZE_STORE_KEY, JSON.stringify(out));
  } catch (err) {
    console.warn('could not persist asset sizes', err);
  }
}

/** World scale a fresh instance of `key` should start at. */
function defaultScaleOf(key) {
  return (savedScales.get(key) || UNIT_SCALE).clone().multiplyScalar(UNITS_PER_METER);
}

loadDefaultScales();

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
function bakeColliderGeometry(mesh) {
  const geom = mesh.geometry.clone();
  geom.applyMatrix4(mesh.matrixWorld);
  for (const name of Object.keys(geom.attributes)) {
    if (name !== 'position') geom.deleteAttribute(name);
  }
  return geom.index ? geom.toNonIndexed() : geom;
}

// ground plane, so a drop always lands somewhere even off the edge of the scan
// (kept across scenario swaps — only the scene geometry is rebuilt)
const groundGeometry = (() => {
  const ground = new THREE.Mesh(new THREE.BoxGeometry(WORLD_SIZE * 8, 0.2, WORLD_SIZE * 8));
  ground.position.y = -0.1;
  ground.updateMatrixWorld();
  return bakeColliderGeometry(ground);
})();

let collider = null;
function buildCollider(modelGeometries = []) {
  if (collider) {
    scene.remove(collider);
    collider.geometry.disposeBoundsTree?.();
    collider.geometry.dispose();
  }
  const merged = mergeGeometries([groundGeometry, ...modelGeometries], false);
  merged.computeBoundsTree();
  collider = new THREE.Mesh(merged);
  collider.visible = false;
  collider.name = 'pick-surface';
  scene.add(collider);
  rebuildPhysicsGround();
}

// ---------------------------------------------------------------- physics (Rapier)
// The editor places objects; physics lets them settle realistically. Bodies only
// exist while simulation is running, so the gizmo and the solver never fight.
const GRAVITY = -9.81 * UNITS_PER_METER; // world units are not metres
let phys = null;
let groundBody = null;
let simulating = false;
const simBodies = new Map(); // instance -> rigid body

function rebuildPhysicsGround() {
  if (!RAPIER || !collider) return;
  if (!phys) phys = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
  if (groundBody) { phys.removeRigidBody(groundBody); groundBody = null; }
  const pos = collider.geometry.attributes.position;
  const idx = new Uint32Array(pos.count);
  for (let i = 0; i < pos.count; i++) idx[i] = i;
  groundBody = phys.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  phys.createCollider(
    RAPIER.ColliderDesc.trimesh(new Float32Array(pos.array), idx).setFriction(0.9),
    groundBody
  );
}

// convex hull of an instance's meshes, expressed around the instance origin
function instanceHull(inst) {
  inst.updateMatrixWorld(true);
  const origin = new THREE.Vector3().setFromMatrixPosition(inst.matrixWorld);
  const v = new THREE.Vector3();
  const pts = [];
  inst.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    const stride = Math.max(1, Math.floor(p.count / 2000)); // cap hull input cost
    for (let k = 0; k < p.count; k += stride) {
      v.fromBufferAttribute(p, k).applyMatrix4(o.matrixWorld).sub(origin);
      pts.push(v.x, v.y, v.z);
    }
  });
  return pts.length ? new Float32Array(pts) : null;
}

function startSimulation() {
  if (!RAPIER || !phys || simulating) return;
  for (const inst of placed) {
    const pts = instanceHull(inst);
    const desc = pts && RAPIER.ColliderDesc.convexHull(pts);
    if (!desc) continue;
    const q = inst.quaternion;
    const body = phys.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(inst.position.x, inst.position.y, inst.position.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinearDamping(0.1).setAngularDamping(0.3)
    );
    phys.createCollider(desc.setFriction(0.9).setRestitution(0.05).setDensity(1), body);
    simBodies.set(inst, body);
  }
  simulating = true;
  select(null);          // gizmo must not fight the solver
  gizmo.enabled = false;
  updateSimButton();
}

function stopSimulation() {
  if (!simulating) return;
  for (const [, body] of simBodies) phys.removeRigidBody(body);
  simBodies.clear();
  simulating = false;
  gizmo.enabled = true;
  updateSimButton();
}

function toggleSimulation() { simulating ? stopSimulation() : startSimulation(); }

const simButton = document.getElementById('simulate');
function updateSimButton() {
  if (!simButton) return;
  simButton.setAttribute('aria-pressed', String(simulating));
  simButton.innerHTML = simulating
    ? '⏸ Stop physics <kbd>P</kbd>'
    : '▶ Simulate physics <kbd>P</kbd>';
  simButton.disabled = !RAPIER;
  simButton.title = RAPIER
    ? 'Let placed objects fall and settle on the scan'
    : 'Physics engine unavailable';
}
simButton?.addEventListener('click', toggleSimulation);
updateSimButton();

function stepPhysics() {
  if (!simulating || !phys) return;
  phys.step();
  for (const [inst, body] of simBodies) {
    const t = body.translation(), r = body.rotation();
    inst.position.set(t.x, t.y, t.z);
    inst.quaternion.set(r.x, r.y, r.z, r.w);
  }
}

// when the scene swaps, settle whatever is placed onto the new surface
function respawnProps() {
  if (simulating) stopSimulation();
  for (const inst of placed) dropToSurface(inst);
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
gizmo.addEventListener('mouseDown', () => { scaleDragStart = selection ? selection.scale.clone() : null; });
gizmo.addEventListener('mouseUp', () => { scaleDragStart = null; });
gizmo.addEventListener('objectChange', () => {
  lockAspectRatio();
  selectionBox.update();
  syncJointUI();
  syncSizeUI();
});
// three r169+ splits the visual helper out of the controls object
const gizmoHelper = gizmo.getHelper ? gizmo.getHelper() : gizmo;
scene.add(gizmoHelper);

const selectionBox = new THREE.BoxHelper(new THREE.Object3D(), 0x7fd4ff);
selectionBox.visible = false;
selectionBox.material.depthTest = false;
selectionBox.material.transparent = true;
scene.add(selectionBox);

// ---------------------------------------------------------------- world model
const overlay = document.getElementById('overlay');
const loadbarFill = document.querySelector('#loadbar div');
const loadnote = document.getElementById('loadnote');
const titleName = document.getElementById('titlename');
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

// localStorage can throw (cookies blocked, sandboxed iframe) — never let that kill the app
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* non-fatal */ } },
};

let activeScenario = null;
let loadingScenario = null;
let bootstrapped = false;

function disposeModel(model) {
  scene.remove(model);
  model.traverse((o) => {
    if (!o.isMesh) return;
    if (o.geometry.boundsTree) o.geometry.disposeBoundsTree();
    o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
}

// normalize + install a loaded scene, replacing whatever is active (hot swap).
// Throws BEFORE touching the active model if the scene can't produce a world,
// so a bad swap leaves the current one standing.
function installModel(model) {
  let meshCount = 0;
  model.traverse((o) => { if (o.isMesh) meshCount++; });
  if (!meshCount) throw new Error('scene contains no meshes');

  // normalize: rotate, scale to WORLD_SIZE, center XZ on origin, floor at y=0
  model.rotation.copy(WORLD_ROTATION);
  model.updateMatrixWorld(true);
  autoLevel(model);
  let box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (!(maxDim > 0) || !isFinite(maxDim)) throw new Error('scene has degenerate bounds');
  model.scale.setScalar(WORLD_SIZE / maxDim);
  model.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box.min.y;
  model.updateMatrixWorld(true);

  const modelGeometries = [];
  model.traverse((o) => {
    if (o.isMesh) {
      o.material.side = THREE.DoubleSide;
      modelGeometries.push(bakeColliderGeometry(o));
    }
  });

  if (worldModel) disposeModel(worldModel);
  worldModel = model;
  scene.add(model);
  buildCollider(modelGeometries);
  return new THREE.Box3().setFromObject(model);
}

function loadScenario(scenario, { frame = true } = {}) {
  if (loadingScenario || scenario === activeScenario) return;
  loadingScenario = scenario;
  updateScenarioButtons();
  loadnote.textContent = `loading ${scenario.name.toLowerCase()}…`;

  new GLTFLoader().load(
    scenario.url,
    (gltf) => {
      try {
        const box = installModel(gltf.scene);
        activeScenario = scenario;
        loadingScenario = null;
        storage.set('scenario', scenario.id);
        titleName.textContent = scenario.name;
        updateScenarioButtons();
        if (frame) controls.frame(box, { yaw: 0.6, pitch: -0.5 });
        respawnProps();
        if (!bootstrapped) { bootstrapped = true; worldReady(); }
        else loadnote.textContent = '';
      } catch (err) {
        scenarioLoadFailed(scenario, err);
      }
    },
    (ev) => {
      if (ev.total) loadbarFill.style.width = `${Math.round((ev.loaded / ev.total) * 55)}%`;
    },
    (err) => scenarioLoadFailed(scenario, err)
  );
}

const errorTimers = new Map();

function scenarioLoadFailed(scenario, err) {
  console.error(`scenario "${scenario.id}" load failed`, err);
  if (loadingScenario === scenario) loadingScenario = null;
  updateScenarioButtons();
  const btn = scenarioButtons.get(scenario);
  if (btn) {
    btn.dataset.error = 'true';
    clearTimeout(errorTimers.get(scenario));
    errorTimers.set(scenario, setTimeout(() => { delete btn.dataset.error; }, 2000));
  }
  if (!bootstrapped) {
    bootstrapped = true;
    buildCollider();
    worldReady(`Could not load ${scenario.url} — dropping assets onto the empty grid instead.`);
  } else {
    loadnote.textContent = `could not load ${scenario.name}`;
  }
}

// ---------------------------------------------------------------- scenario picker
const scenarioPanel = document.getElementById('scenarios');
const scenarioButtons = new Map();

function updateScenarioButtons() {
  for (const [scenario, btn] of scenarioButtons) {
    btn.setAttribute('aria-pressed', String(scenario === activeScenario));
    btn.disabled = !!loadingScenario;
    btn.classList.toggle('loading', scenario === loadingScenario);
  }
}

if (scenarioPanel) {
  SCENARIOS.forEach((scenario, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = `${scenario.name} <kbd>${i + 1}</kbd>`;
    btn.addEventListener('click', () => loadScenario(scenario));
    scenarioPanel.appendChild(btn);
    scenarioButtons.set(scenario, btn);
  });
}

const remembered = SCENARIOS.find((s) => s.id === storage.get('scenario')) || SCENARIOS[0];
loadScenario(remembered);

// One loader for every shelf entry. URDF entries go through the URDF parser; mesh
// entries (.glb / .gltf / .ply — built-in, dropped into assets/library/, or dragged
// in from Finder) go through the asset library. Both hand back the same
// { build(material) -> Object3D } contract, so nothing downstream has to care.
// Cached per key: dropping ten copies costs ten scene graphs, not ten downloads.
function loadAsset(key, { onProgress } = {}) {
  const entry = ASSETS[key];
  if (!entry) return Promise.reject(new Error(`unknown asset "${key}"`));
  if (entry.loading) return entry.loading;

  const setStatus = (text) => {
    const ui = shelfCards.get(key);
    if (ui) ui.status.textContent = text;
  };
  setStatus('loading…');

  const job = entry.kind === 'urdf'
    ? loadURDF(entry.url, {
        onProgress: (done, total) => {
          setStatus(`meshes ${done}/${total}`);
          onProgress?.(done / total);
        },
      })
    : loadLibraryAsset(entry.url, {
        scale: entry.scale,
        size: entry.size,
        onProgress: (frac) => { setStatus(`loading ${Math.round(frac * 100)}%`); onProgress?.(frac); },
      });

  entry.loading = job
    .then((asset) => {
      entry.asset = asset;
      // mimic followers are not a DOF you can command — don't count them
      const joints = asset.spec?.joints?.filter((j) => j.type !== 'fixed' && !j.mimic).length;
      markAssetReady(key, joints != null
        ? `${joints} joints · URDF`
        : (asset.note || entry.note || entry.kind.toUpperCase()));
      return asset;
    })
    .catch((err) => {
      console.error(`asset "${key}" failed to load`, err);
      entry.loading = null;          // let a rescan / re-drop try again
      setStatus('failed to load');
      throw err;
    });

  return entry.loading;
}

function worldReady(warning) {
  loadbarFill.style.width = '60%';
  loadnote.textContent = warning || 'loading SO-101 meshes…';

  const jobs = Object.keys(ASSETS).map((key) =>
    loadAsset(key, {
      onProgress: (frac) => {
        if (ASSETS[key].kind !== 'urdf') return;      // the URDF is the slow one
        loadbarFill.style.width = `${60 + Math.round(frac * 40)}%`;
        loadnote.textContent = `loading ${ASSETS[key].label} meshes… ${Math.round(frac * 100)}%`;
      },
    }).catch(() => null));

  Promise.allSettled(jobs).then(() => {
    const firstReady = Object.keys(ASSETS).find((k) => ASSETS[k].asset);
    if (firstReady) buildGhost(firstReady);
    dismissOverlay();
    refreshLibrary();               // user-dropped files land after the world is up
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
  inst.scale.copy(defaultScaleOf(key));
  // unscaled extents in the URDF's own metres, so the inspector can talk in cm
  inst.userData = { assetKey: key, robot, isPlaced: true, baseSize: box.getSize(new THREE.Vector3()) };
  inst.add(robot);
  mountCamera(inst, key);
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
  refreshCameraPanel();
  return inst;
}

function removeInstance(inst) {
  const i = placed.indexOf(inst);
  if (i >= 0) placed.splice(i, 1);
  if (selection === inst) select(null);
  unmountCamera(inst);
  scene.remove(inst);
  refreshCameraPanel();   // the panel may have just lost the lens it was driving
  // geometries and materials belong to the shared URDFAsset — nothing to dispose
}

// ---------------------------------------------------------------- mounted cameras
// A robot that carries a camera in its URDF gets a real three.js camera bolted to
// the same link, so it moves with the arm. Settings live per *asset*, not per
// instance: they describe one physical sensor, so every Piper-X in the scene sees
// through the same lens. Tuned in the camera panel, kept across reloads.
const CAMERA_STORE_KEY = 'deskTwin.cameraSettings';
const cameraSettings = new Map(); // asset key -> { fovY, aspect, near, far }
const cameraHelpers = new Map();  // instance -> CameraHelper

function loadCameraSettings() {
  try {
    const saved = JSON.parse(storage.get(CAMERA_STORE_KEY) || '{}');
    for (const [key, v] of Object.entries(saved)) {
      if (v && ['fovY', 'aspect', 'near', 'far'].every((f) => Number.isFinite(v[f]) && v[f] > 0)) {
        cameraSettings.set(key, { fovY: v.fovY, aspect: v.aspect, near: v.near, far: v.far });
      }
    }
  } catch (err) {
    console.warn('ignoring unreadable saved camera settings', err);
  }
}

function saveCameraSettings() {
  storage.set(CAMERA_STORE_KEY, JSON.stringify(Object.fromEntries(cameraSettings)));
}

/** Spec defaults for `key`, with any saved overrides on top. */
function cameraConfigOf(key) {
  const spec = ASSETS[key] && ASSETS[key].camera;
  if (!spec) return null;
  const { fovY, aspect, near, far } = spec;
  return { fovY, aspect, near, far, ...(cameraSettings.get(key) || {}) };
}

function mountCamera(inst, key) {
  const spec = ASSETS[key] && ASSETS[key].camera;
  if (!spec) return;
  const link = inst.userData.robot && inst.userData.robot.links.get(spec.link);
  if (!link) {
    console.warn(`asset "${key}": URDF has no link "${spec.link}" to mount the camera on`);
    return;
  }
  const cam = new THREE.PerspectiveCamera();
  cam.name = `${inst.name} camera`;
  // the link is the sensor housing; the optical frame is a fixed rotation off it
  cam.rotation.set(spec.rpy[0], spec.rpy[1], spec.rpy[2], 'ZYX');
  link.add(cam);
  inst.userData.camera = cam;

  const helper = new THREE.CameraHelper(cam);
  // default colours are a rainbow that shouts over the scene; keep the frustum
  // edges readable and mute the crosshair/up/target guides
  helper.setColors?.(
    new THREE.Color(0x7fd4ff), new THREE.Color(0x2b4b5e), new THREE.Color(0x2b4b5e),
    new THREE.Color(0x2b4b5e), new THREE.Color(0x2b4b5e)
  );
  helper.visible = showFrustum;
  scene.add(helper);
  cameraHelpers.set(inst, helper);
  // configure this one directly: makeInstance runs before the instance joins
  // `placed`, so the walk in applyCameraConfig would not see it yet
  applyCameraTo(inst, cameraConfigOf(key));
}

function unmountCamera(inst) {
  const helper = cameraHelpers.get(inst);
  if (helper) {
    scene.remove(helper);
    helper.dispose();
    cameraHelpers.delete(inst);
  }
  delete inst.userData.camera;
}

function applyCameraTo(inst, cfg) {
  const cam = inst.userData.camera;
  if (!cam || !cfg) return;
  cam.fov = cfg.fovY;
  cam.aspect = cfg.aspect;
  // near/far are metres: the camera hangs under the instance scale, so its view
  // space stays in the URDF's own units however the instance is resized
  cam.near = cfg.near;
  cam.far = cfg.far;
  cam.updateProjectionMatrix();
  const helper = cameraHelpers.get(inst);
  if (helper) helper.update();
}

/** Push the asset's current lens settings onto every instance of it. */
function applyCameraConfig(key) {
  const cfg = cameraConfigOf(key);
  if (!cfg) return;
  for (const inst of placed) {
    if (inst.userData.assetKey === key) applyCameraTo(inst, cfg);
  }
}

/** The instance the camera panel is driving: the selection if it has a lens, else the newest. */
function activeCameraInstance() {
  if (selection && selection.userData.camera) return selection;
  for (let i = placed.length - 1; i >= 0; i--) if (placed[i].userData.camera) return placed[i];
  return null;
}

loadCameraSettings();

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

let ghostKey = null;
function buildGhost(key) {
  const entry = ASSETS[key];
  if (!entry || !entry.asset || ghostKey === key) return;
  if (ghost) { scene.remove(ghost); ghost.remove(ghostRing); }
  const body = entry.asset.build(ghostMaterial);
  body.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(body);
  body.position.y = -box.min.y;
  ghost = new THREE.Group();
  ghost.scale.copy(defaultScaleOf(key)); // preview the size that will be dropped
  ghost.visible = false;
  ghost.add(body);
  ghost.add(ghostRing);
  scene.add(ghost);
  ghostKey = key;
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
  refreshCameraPanel();   // the panel follows the selection when it has a lens
}

// ---------------------------------------------------------------- asset shelf
const shelfList = document.getElementById('shelf-items');
const libraryNote = document.getElementById('libnote');
const shelfCards = new Map(); // key -> { card, status }

function addShelfCard(key) {
  const entry = ASSETS[key];
  const card = document.createElement('div');
  card.className = 'asset';
  card.setAttribute('aria-disabled', 'true');
  card.title = `${entry.label} · ${entry.file || entry.url}`;
  card.innerHTML =
    `<div class="thumb">${entry.icon || '📦'}</div>` +
    `<div class="meta"><b></b><span>loading…</span></div>`;
  card.querySelector('.meta b').textContent = entry.label;   // filenames are user input
  shelfList.appendChild(card);
  shelfCards.set(key, { card, status: card.querySelector('.meta span') });

  card.addEventListener('dragstart', (e) => {
    if (!entry.asset) { e.preventDefault(); return; }
    buildGhost(key);
    e.dataTransfer.setData('text/plain', key);
    e.dataTransfer.effectAllowed = 'copy';
  });
  card.addEventListener('dragend', () => { if (ghost) ghost.visible = false; });
  card.addEventListener('click', () => {
    if (!entry.asset) return;
    buildGhost(key);
    const rect = renderer.domElement.getBoundingClientRect();
    const fake = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    const p = placementFromEvent(fake) || controls.pivot.clone();
    addInstance(key, p, facingYaw());
  });
  return card;
}

for (const key of Object.keys(ASSETS)) addShelfCard(key);

const assetNotes = new Map(); // key -> the card's base subtitle, minus the size suffix

function markAssetReady(key, note) {
  const ui = shelfCards.get(key);
  if (!ui) return;
  ui.card.setAttribute('draggable', 'true');
  ui.card.setAttribute('aria-disabled', 'false');
  assetNotes.set(key, note);
  refreshShelfNote(key);
}

// A saved default size is a setting you can't see in the scene — show it on the card.
function refreshShelfNote(key) {
  const ui = shelfCards.get(key);
  if (!ui) return;
  const f = savedScales.get(key);
  const size = f && Math.abs(f.y - 1) > 0.005 ? ` · ×${f.y.toFixed(2)}` : '';
  ui.status.textContent = `${assetNotes.get(key) || ''}${size}`;
}

// ---------------------------------------------------------------- drop-in library
// Everything in world/assets/library/ becomes a shelf card. No registration step:
// the dev server lists the directory, we read the listing (see lib/asset-library.js).
let scanning = false;

// Big scans are heavy; a few at a time keeps the tab responsive while they arrive.
async function loadInSeries(keys, width) {
  const queue = keys.slice();
  const worker = async () => {
    while (queue.length) await loadAsset(queue.shift()).catch(() => null);
  };
  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, worker));
}

async function refreshLibrary() {
  if (scanning) return;
  scanning = true;
  const rescanBtn = document.getElementById('rescan');
  if (rescanBtn) rescanBtn.disabled = true;

  try {
    const found = await scanLibrary();
    const added = [];
    for (const item of found) {
      if (ASSETS[item.key]) continue;
      ASSETS[item.key] = {
        url: item.url, file: item.file, label: item.label, kind: item.kind,
        icon: item.icon, scale: item.scale, size: item.size, source: 'library',
      };
      addShelfCard(item.key);
      added.push(item.key);
    }
    setLibraryNote(found.length, added.length);
    await loadInSeries(added, 2);
  } catch (err) {
    console.warn('library scan failed', err);
    setLibraryNote(null);
  } finally {
    scanning = false;
    if (rescanBtn) rescanBtn.disabled = false;
  }
}

function setLibraryNote(total, added = 0) {
  if (!libraryNote) return;
  if (total === null) {
    libraryNote.innerHTML =
      `Could not read <code>${LIBRARY_URL}</code> — run <code>python3 tools/scan_assets.py</code>.`;
    return;
  }
  const what = total
    ? `${total} file${total === 1 ? '' : 's'} in <code>assets/library/</code>${added ? ` · +${added} new` : ''}`
    : `Drop <b>.glb</b> / <b>.ply</b> files into <code>assets/library/</code>`;
  libraryNote.innerHTML = `${what} — or drag one straight onto the view.`;
}

document.getElementById('rescan')?.addEventListener('click', refreshLibrary);

// Files dragged in from Finder: usable immediately, but only for this session —
// they live at a blob: URL, not on disk next to the world.
let droppedCount = 0;
async function adoptFiles(files, position) {
  for (const file of files) {
    const key = `file:${++droppedCount}:${file.name}`;
    ASSETS[key] = {
      url: URL.createObjectURL(file),
      file: file.name,
      label: file.name.replace(/\.[^.]+$/, ''),
      kind: file.name.split('.').pop().toLowerCase(),
      icon: '📥',
      note: 'dropped file · copy into assets/library/ to keep',
      source: 'drop',
    };
    addShelfCard(key);
    try {
      await loadAsset(key);
      addInstance(key, position ? position.clone() : controls.pivot.clone(), facingYaw());
    } catch { /* the card already says it failed */ }
    URL.revokeObjectURL(ASSETS[key].url);   // the asset is in memory now
  }
}

// ---------------------------------------------------------------- pointer input

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

const MODEL_FILE = /\.(glb|gltf|ply)$/i;
const carriesFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

renderer.domElement.addEventListener('dragover', (e) => {
  if (carriesFiles(e)) { if (ghost) ghost.visible = false; return; } // handled window-side
  if (!ghost) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const p = placementFromEvent(e);
  ghost.visible = !!p;
  if (p) ghost.position.copy(p);
});
renderer.domElement.addEventListener('dragleave', () => { if (ghost) ghost.visible = false; });
renderer.domElement.addEventListener('drop', (e) => {
  if (carriesFiles(e)) return;
  e.preventDefault();
  if (ghost) ghost.visible = false;
  const key = e.dataTransfer.getData('text/plain');
  const p = placementFromEvent(e);
  if (p && ASSETS[key]?.asset) addInstance(key, p, facingYaw());
});

// Files dragged in from Finder — caught on the window so a miss lands in the scene
// instead of navigating the browser away from the editor.
addEventListener('dragover', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
addEventListener('drop', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  if (ghost) ghost.visible = false;
  const files = Array.from(e.dataTransfer.files).filter((f) => MODEL_FILE.test(f.name));
  if (!files.length) return;
  const overCanvas = e.target === renderer.domElement;
  adoptFiles(files, (overCanvas && placementFromEvent(e)) || null);
});

// ---------------------------------------------------------------- keyboard
const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

addEventListener('keydown', (e) => {
  if (TYPING.has(e.target.tagName)) return;
  if (e.metaKey || e.ctrlKey) return;
  if (controls.flying) return; // WASD belongs to the fly camera while RMB is down

  // 1..9 hot-swap scenarios
  if (/^Digit[1-9]$/.test(e.code)) {
    const scenario = SCENARIOS[Number(e.code.slice(5)) - 1];
    if (scenario) { e.preventDefault(); loadScenario(scenario); }
    return;
  }

  switch (e.code) {
    case 'KeyG': setMode('translate'); break;
    case 'KeyR': setMode('rotate'); break;
    case 'KeyS': setMode('scale'); break;
    case 'KeyF': frameSelection(); break;
    case 'KeyP': toggleSimulation(); break;
    case 'KeyC': toggleCameraPanel(); break;
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
  // only URDF instances carry joints — a mesh asset is just a scene graph
  for (const [name, j] of selection.userData.robot?.joints || []) copy.userData.robot.setJointValue(name, j.value);
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

// ---------------------------------------------------------------- size / scale
const sizeUniform = document.getElementById('size-uniform');
const sizeHeight = document.getElementById('size-height');
const sizeFactorOut = document.getElementById('size-factor');
const sizeDefaultBtn = document.getElementById('size-default');
let scaleDragStart = null;

/** Real-world height of an instance, in metres. */
function heightOf(inst) {
  return inst.userData.baseSize.y * (inst.scale.y / UNITS_PER_METER);
}

// TransformControls has no uniform mode — each handle drives its own axis. Find
// the axis the drag actually changed and mirror its ratio onto the other two.
function lockAspectRatio() {
  if (!sizeUniform.checked || gizmo.mode !== 'scale' || !selection || !scaleDragStart) return;
  const s = selection.scale;
  const s0 = scaleDragStart;
  if (!s0.x || !s0.y || !s0.z) return;
  let ratio = s.x / s0.x;
  for (const r of [s.y / s0.y, s.z / s0.z]) {
    if (Math.abs(r - 1) > Math.abs(ratio - 1)) ratio = r;
  }
  s.copy(s0).multiplyScalar(ratio);
}

function syncSizeUI() {
  if (!selection || !selection.userData.baseSize) return;
  sizeHeight.value = (heightOf(selection) * 100).toFixed(1);
  sizeFactorOut.textContent = `×${(selection.scale.y / UNITS_PER_METER).toFixed(2)}`;
}

// typing a height always scales uniformly — one number, one ratio
sizeHeight.addEventListener('input', () => {
  if (!selection) return;
  const metres = Number(sizeHeight.value) / 100;
  const base = selection.userData.baseSize;
  if (!(metres > 0) || !base || !(base.y > 0)) return;
  selection.scale.setScalar((metres / base.y) * UNITS_PER_METER);
  selectionBox.update();
  sizeFactorOut.textContent = `×${(selection.scale.y / UNITS_PER_METER).toFixed(2)}`;
});

sizeDefaultBtn.addEventListener('click', () => {
  if (!selection) return;
  const key = selection.userData.assetKey;
  savedScales.set(key, selection.scale.clone().divideScalar(UNITS_PER_METER));
  saveDefaultScales();
  if (ghost && ghostKey === key) ghost.scale.copy(selection.scale);
  refreshShelfNote(key);
  flash(sizeDefaultBtn, `Default: ${(heightOf(selection) * 100).toFixed(0)} cm ✓`);
});

function flash(button, text) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.textContent = text;
  clearTimeout(button._flashTimer);
  button._flashTimer = setTimeout(() => { button.textContent = button.dataset.label; }, 1400);
}

function refreshInspector() {
  jointRows = [];
  if (!selection) { inspector.hidden = true; jointsBox.replaceChildren(); return; }
  inspector.hidden = false;
  inspName.textContent = selection.name;
  syncSizeUI();

  const robot = selection.userData.robot;
  jointsBox.replaceChildren();
  if (!robot?.joints?.size) return;   // mesh assets have no joints panel

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

  // mimic followers (coupled gripper fingers) move on their own — one slider each
  // would let you drive them out of sync with the joint they are supposed to track
  for (const [name, j] of robot.drivenJoints) {
    const row = document.createElement('div');
    row.className = 'joint';
    const label = document.createElement('label');
    label.textContent = name;
    const out = document.createElement('output');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(j.lower);
    input.max = String(j.upper);
    input.step = String(Math.max((j.upper - j.lower) / 200, 1e-4));
    input.value = String(j.value);
    input.addEventListener('input', () => {
      robot.setJointValue(name, Number(input.value));
      out.textContent = jointReadout(j);
      selectionBox.update();
    });
    out.textContent = jointReadout(j);
    row.append(label, out, input);
    jointsBox.appendChild(row);
    jointRows.push({ name, j, input, out });
  }
}

// revolute joints are radians, prismatic ones are metres — never label mm as degrees
function jointReadout(j) {
  return j.type === 'prismatic'
    ? `${(j.value * 1000).toFixed(0)} mm`
    : `${THREE.MathUtils.radToDeg(j.value).toFixed(0)}°`;
}

function syncJointUI() {
  for (const r of jointRows) {
    r.input.value = String(r.j.value);
    r.out.textContent = jointReadout(r.j);
  }
}

// ---------------------------------------------------------------- camera panel
const camDock = document.getElementById('camdock');
const camToggleBtn = document.getElementById('camtoggle');
const camBody = document.getElementById('cambody');
const camEmpty = document.getElementById('camempty');
const camLensEl = document.getElementById('camlens');
const camViewEl = document.getElementById('camview');
const camFrustumChk = document.getElementById('cam-frustum');
const camLiveChk = document.getElementById('cam-live');
const camHFov = document.getElementById('cam-hfov');
const camVFov = document.getElementById('cam-vfov');
const camNear = document.getElementById('cam-near');
const camFar = document.getElementById('cam-far');
const camAspectOut = document.getElementById('cam-aspect');

let showFrustum = true;
let panelOpen = false;

const hFovOf = (cfg) =>
  THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(cfg.fovY) / 2) * cfg.aspect));

/** Aspect that pairs a horizontal and a vertical FOV — the two numbers datasheets quote. */
const aspectFor = (hFovDeg, vFovDeg) =>
  Math.tan(THREE.MathUtils.degToRad(hFovDeg) / 2) / Math.tan(THREE.MathUtils.degToRad(vFovDeg) / 2);

function toggleCameraPanel(on) {
  panelOpen = on === undefined ? !panelOpen : !!on;
  camDock.hidden = !panelOpen;
  camToggleBtn.setAttribute('aria-pressed', String(panelOpen));
  if (panelOpen) refreshCameraPanel();
}

function refreshCameraPanel() {
  if (!panelOpen) return;
  const inst = activeCameraInstance();
  camBody.hidden = !inst;
  camEmpty.hidden = !!inst;
  camViewEl.hidden = !inst || !camLiveChk.checked;
  if (!inst) return;

  const key = inst.userData.assetKey;
  const cfg = cameraConfigOf(key);
  const spec = ASSETS[key].camera;
  camLensEl.innerHTML = '';
  camLensEl.append(spec.label || 'camera', ' · ');
  const who = document.createElement('b');
  who.textContent = inst.name;              // instance names can carry a filename
  camLensEl.append(who);

  camVFov.value = cfg.fovY.toFixed(1);
  camHFov.value = hFovOf(cfg).toFixed(1);
  camNear.value = (cfg.near * 100).toFixed(1);
  camFar.value = (cfg.far * 100).toFixed(0);
  camAspectOut.textContent = cfg.aspect.toFixed(3);
  camViewEl.style.aspectRatio = String(cfg.aspect);
  camViewEl.dataset.label = `${hFovOf(cfg).toFixed(0)}° × ${cfg.fovY.toFixed(0)}°`;
}

function editCamera(patch) {
  const inst = activeCameraInstance();
  if (!inst) return;
  const key = inst.userData.assetKey;
  cameraSettings.set(key, { ...cameraConfigOf(key), ...patch });
  saveCameraSettings();
  applyCameraConfig(key);
  const cfg = cameraConfigOf(key);
  camAspectOut.textContent = cfg.aspect.toFixed(3);
  camViewEl.style.aspectRatio = String(cfg.aspect);
  camViewEl.dataset.label = `${hFovOf(cfg).toFixed(0)}° × ${cfg.fovY.toFixed(0)}°`;
}

const numberIn = (el, min, max) => {
  const v = Number(el.value);
  return Number.isFinite(v) && v >= min && v <= max ? v : null;
};

// H and V FOV are edited independently — a datasheet quotes both, and the aspect
// is whatever makes them agree. Changing one holds the other and moves the aspect.
camVFov.addEventListener('input', () => {
  const v = numberIn(camVFov, 1, 179);
  const h = numberIn(camHFov, 1, 179);
  if (v === null || h === null) return;
  editCamera({ fovY: v, aspect: aspectFor(h, v) });
});
camHFov.addEventListener('input', () => {
  const v = numberIn(camVFov, 1, 179);
  const h = numberIn(camHFov, 1, 179);
  if (v === null || h === null) return;
  editCamera({ fovY: v, aspect: aspectFor(h, v) });
});
camNear.addEventListener('input', () => {
  const cm = numberIn(camNear, 0.1, 1e5);
  const far = numberIn(camFar, 0.1, 1e6);
  if (cm === null || far === null || cm / 100 >= far / 100) return;
  editCamera({ near: cm / 100 });
});
camFar.addEventListener('input', () => {
  const cm = numberIn(camFar, 0.2, 1e6);
  const near = numberIn(camNear, 0.1, 1e5);
  if (cm === null || near === null || cm <= near) return;
  editCamera({ far: cm / 100 });
});

camFrustumChk.addEventListener('change', () => {
  showFrustum = camFrustumChk.checked;
  for (const helper of cameraHelpers.values()) helper.visible = showFrustum;
});
camLiveChk.addEventListener('change', () => {
  camViewEl.hidden = !camLiveChk.checked || !activeCameraInstance();
});

document.getElementById('cam-reset').addEventListener('click', () => {
  const inst = activeCameraInstance();
  if (!inst) return;
  cameraSettings.delete(inst.userData.assetKey);
  saveCameraSettings();
  applyCameraConfig(inst.userData.assetKey);
  refreshCameraPanel();
});

camToggleBtn.addEventListener('click', () => toggleCameraPanel());
document.getElementById('camclose').addEventListener('click', () => toggleCameraPanel(false));

// The live view is a second pass over the same scene through the mounted lens.
// Editor furniture is not part of the world the sensor sees, so it blinks off.
function renderCameraPreview() {
  if (!panelOpen || !camLiveChk.checked) return;
  const inst = activeCameraInstance();
  const cam = inst && inst.userData.camera;
  if (!cam) return;

  const rect = camViewEl.getBoundingClientRect();
  const canvasRect = renderer.domElement.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;

  const overlays = [gizmoHelper, selectionBox, grid, ghost, ...cameraHelpers.values()];
  const wasVisible = overlays.map((o) => o && o.visible);
  for (const o of overlays) if (o) o.visible = false;

  const x = rect.left - canvasRect.left;
  const y = canvasRect.bottom - rect.bottom;   // WebGL counts from the bottom
  renderer.setScissorTest(true);
  renderer.setViewport(x, y, rect.width, rect.height);
  renderer.setScissor(x, y, rect.width, rect.height);
  renderer.render(scene, cam);
  renderer.setScissorTest(false);
  const v = viewportSize();
  renderer.setViewport(0, 0, v.w, v.h);

  overlays.forEach((o, i) => { if (o) o.visible = wasVisible[i]; });
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  controls.update(Math.min(clock.getDelta(), 0.05));
  stepPhysics();
  if (selection) selectionBox.setFromObject(selection);
  renderer.render(scene, camera);
  renderCameraPreview();
}
animate();

// debug: drive physics without rAF (hidden tabs pause rAF)
window.__stepPhysics = (n = 1) => { for (let i = 0; i < n; i++) stepPhysics(); };
window.__sim = { start: startSimulation, stop: stopSimulation, bodies: simBodies, placed };

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
  defaultScaleOf, saveDefaultScales, heightOf,
  cameraSettings, cameraHelpers, cameraConfigOf, applyCameraConfig, activeCameraInstance,
  toggleCameraPanel, refreshCameraPanel, hFovOf,
  get selection() { return selection; },
};
