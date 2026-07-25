import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { EditorControls } from './lib/editor-controls.js';
import { loadURDF } from './lib/urdf-loader.js';
import { scanLibrary, loadLibraryAsset, LIBRARY_URL } from './lib/asset-library.js';
import * as presets from './lib/presets.js';
import { LiveDrive } from './lib/live-drive.js';

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
  piper: { url: './assets/piper/piper_x_arm.urdf', label: 'Piper X', kind: 'urdf', icon: '🤖' },
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
        refreshPresetList();          // presets are per scenario
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
  // `live: true` — follow the live joint stream by default; toggled per instance
  inst.userData = { assetKey: key, robot, isPlaced: true, live: true, baseSize: box.getSize(new THREE.Vector3()) };
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

// ---------------------------------------------------------------- scene presets
// Save/restore what is placed in the current scenario: which assets, where, how
// big, and how the articulated ones are posed. See lib/presets.js for storage.

/** Serializable snapshot of everything currently placed. */
function capturePlacement() {
  return placed.map((inst) => {
    const key = inst.userData.assetKey;
    const robot = inst.userData.robot;
    const out = {
      key,
      // filename lets a preset re-link to the same model after a dragged-in file
      // is copied into assets/library/ (its session key is gone, the file isn't)
      file: ASSETS[key]?.file || null,
      name: inst.name,
      pos: inst.position.toArray(),
      quat: inst.quaternion.toArray(),
      scale: inst.scale.toArray(),
    };
    if (robot?.joints?.size) {
      out.joints = Object.fromEntries([...robot.joints].map(([n, j]) => [n, j.value]));
    }
    return out;
  });
}

/** The live asset key for a stored object, re-linking by filename if needed. */
function resolveAssetKey(saved) {
  if (saved.key && ASSETS[saved.key]) return saved.key;
  if (!saved.file) return null;
  return Object.keys(ASSETS).find((k) => ASSETS[k].file === saved.file) || null;
}

/** Replace everything placed with `objects`. Returns how many could not load. */
async function applyPlacement(objects) {
  if (simulating) stopSimulation();
  for (const inst of [...placed]) removeInstance(inst);

  let missing = 0;
  for (const saved of objects) {
    const key = resolveAssetKey(saved);
    if (!key) { missing++; continue; }
    let inst = null;
    try {
      await loadAsset(key);          // no-op once the asset is cached
      inst = makeInstance(key);
    } catch { /* falls through to the missing count */ }
    if (!inst) { missing++; continue; }

    inst.position.fromArray(saved.pos);
    if (saved.quat) inst.quaternion.fromArray(saved.quat);
    if (saved.scale) inst.scale.fromArray(saved.scale);
    if (saved.name) inst.name = saved.name;
    const robot = inst.userData.robot;
    if (saved.joints && robot?.setJointValue) {
      for (const [n, v] of Object.entries(saved.joints)) robot.setJointValue(n, v);
    }
    scene.add(inst);
    placed.push(inst);
  }
  select(null);
  return missing;
}

// ---- preset panel UI
const presetPanel = document.getElementById('presets');
const presetList = document.getElementById('preset-list');
const presetName = document.getElementById('preset-name');
const presetSave = document.getElementById('preset-save');
const presetNote = document.getElementById('preset-note');
let presetBusy = false;

function setPresetNote(text, tone = '') {
  if (!presetNote) return;
  presetNote.textContent = text;
  presetNote.dataset.tone = tone;
}

// Opening is async (assets may still be downloading) and it empties the scene
// before refilling it — so saving mid-open would capture a half-built layout.
function setPresetBusy(busy) {
  presetBusy = busy;
  if (presetSave) presetSave.disabled = busy;
  if (presetName) presetName.disabled = busy;
  for (const b of presetList?.querySelectorAll('button') || []) b.disabled = busy;
}

function refreshPresetList() {
  if (!presetList) return;
  const id = activeScenario?.id;
  presetList.replaceChildren();
  const saved = id ? presets.listPresets(id) : [];

  if (!saved.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = id
      ? 'No saved layouts for this scene yet.'
      : 'Waiting for a scene…';
    presetList.appendChild(empty);
    return;
  }

  for (const item of saved) {
    const row = document.createElement('div');
    row.className = 'preset';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'preset-open';
    open.title = `Open "${item.name}"`;
    open.innerHTML = `<span class="pname"></span><em>${item.count} object${item.count === 1 ? '' : 's'}</em>`;
    open.querySelector('.pname').textContent = item.name;
    open.addEventListener('click', () => openPreset(item.name));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'preset-del';
    del.title = `Delete "${item.name}"`;
    del.textContent = '×';
    del.addEventListener('click', () => {
      // saved layouts have no undo, and the × sits next to the open button
      if (!confirm(`Delete the layout "${item.name}"?`)) return;
      presets.deletePreset(activeScenario.id, item.name);
      refreshPresetList();
      setPresetNote(`deleted "${item.name}"`);
    });

    row.append(open, del);
    presetList.appendChild(row);
  }
  // a scenario swap can rebuild this list mid-open — keep the lock visible
  if (presetBusy) for (const b of presetList.querySelectorAll('button')) b.disabled = true;
}

function saveCurrentPreset() {
  if (!activeScenario || presetBusy) return;
  const name = presets.cleanName(presetName.value || `Layout ${presets.listPresets(activeScenario.id).length + 1}`);
  if (!name) { setPresetNote('give it a name first', 'warn'); presetName.focus(); return; }
  if (presets.hasPreset(activeScenario.id, name)
      && !confirm(`"${name}" already exists in ${activeScenario.name}. Overwrite it?`)) return;

  const res = presets.savePreset(activeScenario.id, name, capturePlacement());
  if (!res.ok) { setPresetNote(res.error, 'warn'); return; }
  presetName.value = '';
  refreshPresetList();
  setPresetNote(`saved "${name}" · ${placed.length} object${placed.length === 1 ? '' : 's'}`, 'ok');
}

async function openPreset(name) {
  if (presetBusy || !activeScenario) return;
  const objects = presets.readPreset(activeScenario.id, name);
  if (!objects) { setPresetNote(`"${name}" is gone`, 'warn'); refreshPresetList(); return; }

  setPresetBusy(true);
  setPresetNote(`opening "${name}"…`);
  try {
    const missing = await applyPlacement(objects);
    setPresetNote(
      missing
        ? `opened "${name}" · ${objects.length - missing}/${objects.length} restored — ${missing} asset${missing === 1 ? '' : 's'} unavailable`
        : `opened "${name}" · ${objects.length} object${objects.length === 1 ? '' : 's'}`,
      missing ? 'warn' : 'ok');
  } catch (err) {
    console.error('preset failed to open', err);
    setPresetNote(`could not open "${name}"`, 'warn');
  } finally {
    setPresetBusy(false);
  }
}

presetSave?.addEventListener('click', saveCurrentPreset);
presetName?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveCurrentPreset(); }
});
refreshPresetList();

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
  // follow/ignore the live stream per instance — one arm can mirror the real
  // robot while another stays hand-posed
  const follow = document.createElement('label');
  follow.className = 'chk';
  follow.title = 'Follow the live joint stream when connected';
  const followChk = document.createElement('input');
  followChk.type = 'checkbox';
  followChk.checked = selection.userData.live !== false;
  followChk.addEventListener('change', () => {
    selection.userData.live = followChk.checked;
    syncLiveJointLock();
  });
  follow.append(followChk, document.createTextNode('live'));
  const reset = document.createElement('button');
  reset.textContent = 'Reset';
  reset.addEventListener('click', () => {
    robot.resetJoints();
    syncJointUI();
    selectionBox.update();
  });
  head.append(follow, reset);
  jointsBox.appendChild(head);

  for (const [name, j] of robot.joints) {
    if (j.mimic) continue; // driven by its master joint — a slider would fight it
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
  syncLiveJointLock();
}

function syncJointUI() {
  for (const r of jointRows) {
    r.input.value = String(r.j.value);
    r.out.textContent = `${THREE.MathUtils.radToDeg(r.j.value).toFixed(0)}°`;
  }
}

// ---------------------------------------------------------------- live mirroring
// The robot laptop runs actuacore-feetech's zmq_so_arm_handler.py with
// ACTUACORE_ZMQ_TRANSPORT=tcp; tools/so101_ws_bridge.py runs HERE and turns that
// ZMQ stream into ws://localhost:8765. Every placed arm whose joint names match
// the incoming state follows it (uncheck "live" in the inspector to hand-pose
// one while the rest keep mirroring).
const liveUrl = document.getElementById('live-url');
const liveBtn = document.getElementById('live-connect');
const liveDot = document.getElementById('live-dot');
const liveNote = document.getElementById('live-note');

liveUrl.value = storage.get('liveUrl') || 'ws://localhost:8765';

let liveDriven = 0;  // instances the last state message actually moved
let liveNames = [];  // joint_names of the last state message

function applyLiveState(msg) {
  liveDriven = 0;
  liveNames = msg.joint_names;
  for (const inst of placed) {
    const robot = inst.userData.robot;
    if (!robot?.joints?.size || inst.userData.live === false) continue;
    let moved = false;
    for (let i = 0; i < msg.joint_names.length; i++) {
      const v = msg.joint_pos[i];
      if (v == null) continue; // that servo's read failed — keep the last pose
      if (robot.setJointValue(msg.joint_names[i], v)) moved = true;
    }
    if (moved) liveDriven++;
  }
  if (liveDriven) syncJointUI();
}

// grey out the sliders of a robot that is being live-driven — wiggling them
// would just fight the stream
function syncLiveJointLock() {
  const robot = selection?.userData.robot;
  const lock = live.status === 'live'
    && selection?.userData.live !== false
    && !!robot?.joints
    && liveNames.some((n) => robot.joints.has(n));
  for (const r of jointRows) r.input.disabled = lock;
}

function updateLiveUI() {
  liveDot.dataset.state = live.status;
  liveBtn.textContent = live.enabled ? 'Stop' : 'Connect';
  if (live.status === 'live') {
    const hz = `${Math.round(live.rate)} Hz`;
    liveNote.textContent = liveDriven
      ? `${hz} — driving ${liveDriven} arm${liveDriven === 1 ? '' : 's'}`
      : `${hz} — drop a matching arm (SO-101) to see it move`;
  } else if (live.status === 'waiting') {
    liveNote.textContent = 'connected — waiting for joint states…';
  } else if (live.status === 'connecting') {
    liveNote.textContent = 'connecting…';
  } else if (live.status === 'retry') {
    liveNote.textContent = 'stream dropped — retrying…';
  } else {
    liveNote.innerHTML =
      'Mirror the real arm: <code>python3 tools/so101_ws_bridge.py --host &lt;robot-laptop&gt;</code> on this machine, then Connect.';
  }
  syncLiveJointLock();
}

const live = new LiveDrive({ onState: applyLiveState, onStatus: updateLiveUI });
updateLiveUI();

liveBtn.addEventListener('click', () => {
  if (live.enabled) { live.disconnect(); return; }
  const url = liveUrl.value.trim();
  if (!url) return;
  storage.set('liveUrl', url);
  live.connect(url);
});
liveUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') liveBtn.click(); });

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  controls.update(Math.min(clock.getDelta(), 0.05));
  stepPhysics();
  if (selection) selectionBox.setFromObject(selection);
  renderer.render(scene, camera);
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
  get selection() { return selection; },
};
