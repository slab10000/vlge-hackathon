import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ---------------------------------------------------------------- config
// Scenario registry — each entry is a scanned scene the player can hot-swap to
// (picker buttons top-right, or number keys 1..9). Last choice persists.
const SCENARIOS = [
  { id: 'desk',   name: 'Desk',        url: './assets/desk.glb' },
  { id: 'snacks', name: 'Snack Table', url: './assets/snacks.glb' },
  { id: 'laptop', name: 'Laptop Desk', url: './assets/laptop.glb' },
];
const WORLD_SIZE = 16;     // normalize largest scene dimension to this many meters (big = desk becomes terrain)
// If the scan comes out tilted, correct it here (radians), applied X then Y then Z.
const WORLD_ROTATION = new THREE.Euler(0, 0, 0);

const GRAVITY = -18;
const PLAYER_SPEED = 4.5;
const JUMP_VELOCITY = 6.5;
const CAPSULE_RADIUS = 0.28;
const CAPSULE_HEIGHT = 1.55; // total height incl. caps

// ---------------------------------------------------------------- scene
const container = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10151c);
scene.fog = new THREE.Fog(0x10151c, WORLD_SIZE * 1.5, WORLD_SIZE * 5);

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 200);

const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x3a3228, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(4, 8, 3);
scene.add(sun);
scene.add(new THREE.AmbientLight(0xffffff, 0.35));

// subtle grid "void floor" far below as a safety net visual
const grid = new THREE.GridHelper(WORLD_SIZE * 8, 64, 0x2b3946, 0x1a232d);
grid.position.y = -0.01;
scene.add(grid);

// ---------------------------------------------------------------- collider assembly
function bakeColliderGeometry(mesh) {
  const geom = mesh.geometry.clone();
  geom.applyMatrix4(mesh.matrixWorld);
  for (const name of Object.keys(geom.attributes)) {
    if (name !== 'position') geom.deleteAttribute(name);
  }
  return geom.index ? geom.toNonIndexed() : geom;
}

// safety ground plane so you can never fall out of the world (kept across scenario swaps)
const groundGeometry = (() => {
  const ground = new THREE.Mesh(new THREE.BoxGeometry(WORLD_SIZE * 8, 0.2, WORLD_SIZE * 8));
  ground.position.y = -0.1;
  ground.updateMatrixWorld();
  return bakeColliderGeometry(ground);
})();

let collider = null;
function buildCollider(modelGeometries) {
  if (collider) {
    scene.remove(collider);
    collider.geometry.disposeBoundsTree();
    collider.geometry.dispose();
  }
  const merged = mergeGeometries([groundGeometry, ...modelGeometries], false);
  merged.computeBoundsTree();
  collider = new THREE.Mesh(merged);
  collider.visible = false;
  scene.add(collider);
}

// ---------------------------------------------------------------- scenario loading
const overlay = document.getElementById('overlay');
const loadbar = document.getElementById('loadbar');
const loadbarFill = document.querySelector('#loadbar div');
const clicktip = document.getElementById('clicktip');
const overlaySub = document.querySelector('#overlay .sub');
const titleName = document.getElementById('titlename');
let modelReady = false;

// localStorage can throw (cookies blocked, sandboxed iframe) — never let that kill the app
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* non-fatal */ } },
};
const OVERLAY_SUB_DEFAULT = overlaySub.textContent;

let currentModel = null;
let activeScenario = null;
let loadingScenario = null;

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

// normalize + install a loaded scene, replacing whatever is active (hot swap).
// Throws (before touching the active model) if the scene can't produce a walkable world.
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
  const scale = WORLD_SIZE / maxDim;
  model.scale.setScalar(scale);
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

  if (currentModel) disposeModel(currentModel);
  currentModel = model;
  scene.add(model);
  buildCollider(modelGeometries);

  // spawn on top of the scan: raycast down and drop in just above the surface,
  // so the capsule never starts intersecting geometry
  box = new THREE.Box3().setFromObject(model);
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  const ray = new THREE.Raycaster(new THREE.Vector3(cx, box.max.y + 5, cz), new THREE.Vector3(0, -1, 0));
  const hit = ray.intersectObject(model, true)[0];
  if (hit) SPAWN.set(cx, hit.point.y + 1.6, cz);
  else SPAWN.set(cx, box.max.y + 2, cz);
  respawn();
}

const errorTimers = new Map(); // scenario -> pending error-flash reset timeout

function scenarioLoadFailed(scenario, err) {
  console.error(`scenario "${scenario.id}" load failed`, err);
  if (loadingScenario === scenario) loadingScenario = null;
  updateScenarioButtons();
  const btn = scenarioButtons.get(scenario);
  if (btn) {
    btn.classList.add('error');
    btn.textContent = `${scenario.name} — failed`;
    clearTimeout(errorTimers.get(scenario));
    errorTimers.set(scenario, setTimeout(() => {
      errorTimers.delete(scenario);
      btn.classList.remove('error');
      updateScenarioButtons();
    }, 2500));
  }
  if (!currentModel) {
    // nothing loaded yet — fall back to the empty grid so the world still works
    overlaySub.textContent = `Could not load ${scenario.url} — run the reconstruction pipeline first. (Walking on the empty grid instead.)`;
    if (titleName) titleName.textContent = 'Empty grid';
    buildCollider([]);
    modelReady = true;
    loadbar.style.display = 'none';
    clicktip.style.display = 'block';
  }
}

function loadScenario(scenario) {
  if (loadingScenario || scenario === activeScenario) return;
  loadingScenario = scenario;
  clearTimeout(errorTimers.get(scenario));
  errorTimers.delete(scenario);
  const btn = scenarioButtons.get(scenario);
  if (btn) btn.classList.remove('error');
  if (!currentModel && titleName) titleName.textContent = scenario.name;
  updateScenarioButtons();
  new GLTFLoader().load(
    scenario.url,
    (gltf) => {
      // GLTFLoader reroutes onLoad exceptions to onError — keep failure handling explicit
      try {
        installModel(gltf.scene);
        activeScenario = scenario;
        loadingScenario = null;
        storage.set('scenario', scenario.id);
        if (titleName) titleName.textContent = scenario.name;
        overlaySub.textContent = OVERLAY_SUB_DEFAULT;
        updateScenarioButtons();
        modelReady = true;
        loadbarFill.style.width = '100%';
        loadbar.style.display = 'none';
        clicktip.style.display = 'block';
      } catch (e) {
        scenarioLoadFailed(scenario, e);
      }
    },
    (ev) => {
      if (!ev.total) return;
      const pct = Math.round((ev.loaded / ev.total) * 100);
      loadbarFill.style.width = `${pct}%`;
      const b = scenarioButtons.get(scenario);
      if (b) b.textContent = `${scenario.name} ${pct}%`;
    },
    (err) => scenarioLoadFailed(scenario, err)
  );
}

// ---------------------------------------------------------------- scenario picker UI
const scenarioPanel = document.getElementById('scenarios');
const scenarioButtons = new Map();
SCENARIOS.forEach((sc, i) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = sc.name;
  btn.title = `Switch to ${sc.name} (key ${i + 1})`;
  btn.addEventListener('click', () => { btn.blur(); loadScenario(sc); });
  scenarioPanel.appendChild(btn);
  scenarioButtons.set(sc, btn);
});
function updateScenarioButtons() {
  for (const [sc, btn] of scenarioButtons) {
    btn.classList.toggle('active', sc === activeScenario);
    btn.classList.toggle('loading', sc === loadingScenario);
    if (sc !== loadingScenario && !btn.classList.contains('error')) btn.textContent = sc.name;
  }
}

// debug handles (used by headless verification)
window.__scenarios = SCENARIOS;
window.__loadScenario = (id) => { const sc = SCENARIOS.find((s) => s.id === id); if (sc) loadScenario(sc); };
window.__activeScenario = () => (activeScenario ? activeScenario.id : null);

// ---------------------------------------------------------------- player
const player = {
  position: new THREE.Vector3(0, 2, 2.2),
  velocity: new THREE.Vector3(),
  onGround: false,
  yaw: 0,
  pitch: -0.15,
};
const SPAWN = player.position.clone();
window.__player = player; // debug handle

const keys = new Set();
window.__keys = keys; // debug handle
// arrows work everywhere, even where a host app steals single-letter shortcuts
const KEY_ALIAS = { ArrowUp: 'KeyW', ArrowDown: 'KeyS', ArrowLeft: 'KeyA', ArrowRight: 'KeyD' };
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return; // shortcuts shouldn't latch movement
  const code = KEY_ALIAS[e.code] || e.code;
  if (KEY_ALIAS[e.code]) e.preventDefault(); // arrows shouldn't scroll the page
  keys.add(code);
  if (code === 'KeyR') respawn();
  if (code.startsWith('Digit')) {
    const sc = SCENARIOS[Number(code.slice(5)) - 1];
    if (sc) loadScenario(sc); // hot swap without leaving pointer lock
  }
});
addEventListener('keyup', (e) => keys.delete(KEY_ALIAS[e.code] || e.code));

// a missed keyup (focus loss, Esc out of pointer lock, Cmd+Tab) would latch a key
// forever -> phantom drift + the opposite key seeming dead. Clear on any state change.
function clearKeys() { keys.clear(); dragging = false; }
addEventListener('blur', clearKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearKeys(); });

function respawn() {
  player.position.copy(SPAWN);
  player.velocity.set(0, 0, 0);
}

// pointer lock with drag-to-look fallback (embedded panes, touch devices)
let dragLook = false;
let dragging = false;
let entered = false;

function enterWorld() {
  entered = true;
  overlay.style.display = 'none';
}

overlay.addEventListener('click', () => {
  if (!modelReady) return;
  const p = renderer.domElement.requestPointerLock?.();
  if (p && p.catch) p.catch(() => { dragLook = true; enterWorld(); });
  // if pointer lock never engages, fall back after a beat
  setTimeout(() => {
    if (!document.pointerLockElement) { dragLook = true; enterWorld(); }
  }, 350);
});
document.addEventListener('pointerlockchange', () => {
  clearKeys();
  if (document.pointerLockElement) { dragLook = false; enterWorld(); }
  else if (!dragLook) overlay.style.display = 'flex';
});
document.addEventListener('pointerlockerror', () => { dragLook = true; enterWorld(); });

addEventListener('mousemove', (e) => {
  if (document.pointerLockElement) {
    player.yaw -= e.movementX * 0.0022;
    player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch - e.movementY * 0.0022));
  } else if (dragLook && dragging) {
    player.yaw -= e.movementX * 0.004;
    player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch - e.movementY * 0.004));
  }
});
addEventListener('mousedown', () => { dragging = true; });
addEventListener('mouseup', () => { dragging = false; });

// ---------------------------------------------------------------- capsule vs BVH
const upVector = new THREE.Vector3(0, 1, 0);
const tempVector = new THREE.Vector3();
const tempVector2 = new THREE.Vector3();
const tempBox = new THREE.Box3();
const tempMat = new THREE.Matrix4();
const tempSegment = new THREE.Line3();
const capsuleSegLength = CAPSULE_HEIGHT - 2 * CAPSULE_RADIUS;

function updatePlayer(delta) {
  player.velocity.y += GRAVITY * delta;

  // horizontal input relative to yaw
  const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const hasInput = f !== 0 || s !== 0;
  const dir = tempVector.set(s, 0, -f).normalize().applyAxisAngle(upVector, player.yaw);
  if (f || s) {
    player.position.addScaledVector(dir, PLAYER_SPEED * delta);
  }
  if (keys.has('Space') && player.onGround) {
    player.velocity.y = JUMP_VELOCITY;
    player.onGround = false;
  }
  player.position.addScaledVector(player.velocity, delta);

  if (!collider) return;

  // capsule segment in collider local space (collider is at identity, but keep general)
  tempSegment.start.copy(player.position);
  tempSegment.start.y += CAPSULE_RADIUS + capsuleSegLength; // top sphere center
  tempSegment.end.copy(player.position);
  tempSegment.end.y += CAPSULE_RADIUS; // bottom sphere center

  tempMat.copy(collider.matrixWorld).invert();
  tempSegment.start.applyMatrix4(tempMat);
  tempSegment.end.applyMatrix4(tempMat);

  tempBox.makeEmpty();
  tempBox.expandByPoint(tempSegment.start);
  tempBox.expandByPoint(tempSegment.end);
  tempBox.min.addScalar(-CAPSULE_RADIUS);
  tempBox.max.addScalar(CAPSULE_RADIUS);

  const triPoint = tempVector;
  const capsulePoint = tempVector2;
  collider.geometry.boundsTree.shapecast({
    intersectsBounds: (box) => box.intersectsBox(tempBox),
    intersectsTriangle: (tri) => {
      const distance = tri.closestPointToSegment(tempSegment, triPoint, capsulePoint);
      if (distance < CAPSULE_RADIUS) {
        const depth = CAPSULE_RADIUS - distance;
        const direction = capsulePoint.sub(triPoint).normalize();
        tempSegment.start.addScaledVector(direction, depth);
        tempSegment.end.addScaledVector(direction, depth);
      }
    },
  });

  // resolved bottom-sphere center back in world space
  const newPosition = tempSegment.end.clone().applyMatrix4(collider.matrixWorld);
  newPosition.y -= CAPSULE_RADIUS; // back to feet
  const deltaVector = newPosition.sub(player.position);

  player.onGround = deltaVector.y > Math.abs(delta * player.velocity.y * 0.25);

  // standing still on ground: keep vertical support but cancel micro slope-slide
  if (player.onGround && !hasInput) {
    deltaVector.x = 0;
    deltaVector.z = 0;
  }

  const offset = Math.max(0, deltaVector.length() - 1e-5);
  deltaVector.normalize().multiplyScalar(offset);
  player.position.add(deltaVector);

  if (player.onGround) {
    // horizontal motion is position-driven (input); never let collision-injected
    // momentum persist on the ground -> no phantom drift
    player.velocity.set(0, Math.max(0, player.velocity.y), 0);
  } else {
    // slide: remove velocity into the surface
    deltaVector.normalize();
    player.velocity.addScaledVector(deltaVector, -deltaVector.dot(player.velocity));
    // damp airborne horizontal momentum so glancing hits can't pump runaway speed
    const damp = Math.max(0, 1 - 4 * delta);
    player.velocity.x *= damp;
    player.velocity.z *= damp;
  }

  if (player.position.y < -10) respawn();
}

window.__step = (dt) => updatePlayer(dt); // debug: drive physics without rAF

// ---------------------------------------------------------------- boot
{
  const saved = storage.get('scenario');
  loadScenario(SCENARIOS.find((s) => s.id === saved) || SCENARIOS[0]);
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  // substep for stability
  const steps = 3;
  for (let i = 0; i < steps; i++) updatePlayer(delta / steps);

  camera.position.copy(player.position);
  camera.position.y += CAPSULE_HEIGHT - 0.12; // eyes near capsule top
  camera.rotation.set(0, 0, 0);
  camera.rotateY(player.yaw);
  camera.rotateX(player.pitch);

  renderer.render(scene, camera);
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
