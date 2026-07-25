import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// optional physics engine (Rapier, WASM) for draggable props — world still works without it
let RAPIER = null;
try {
  RAPIER = (await import('https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/+esm')).default;
  await RAPIER.init();
} catch (err) {
  console.warn('Rapier unavailable — draggable props disabled:', err);
}

// ---------------------------------------------------------------- config
const MODEL_URL = './assets/desk.glb';
const WORLD_SIZE = 16;     // normalize largest scene dimension to this many meters (big = desk becomes terrain)
// Longest real-world dimension of the scanned scene, in meters. The scan itself
// has no metric scale, so this is what converts captured objects (which ARE
// metric, via tools/make_object.py) into this deliberately scaled-up world.
const REAL_SCENE_SIZE_M = 1.6;
const METERS_TO_WORLD = WORLD_SIZE / REAL_SCENE_SIZE_M;

// Real objects captured with tools/make_object.py. Drop a name in here after
// running the pipeline and it becomes a grabbable, physics-driven prop.
const OBJECT_PROPS = [
  // synthetic placeholder proving the pipeline — replace with a real capture
  { name: 'test_bottle', url: './assets/objects/test_bottle.glb' },
];
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
const colliderGeometries = [];

function addColliderGeometry(mesh) {
  const geom = mesh.geometry.clone();
  geom.applyMatrix4(mesh.matrixWorld);
  for (const name of Object.keys(geom.attributes)) {
    if (name !== 'position') geom.deleteAttribute(name);
  }
  const flat = geom.index ? geom.toNonIndexed() : geom;
  colliderGeometries.push(flat);
}

// safety ground plane so you can never fall out of the world
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
  scene.add(collider);
  initPhysics();
}

// ---------------------------------------------------------------- props physics (Rapier)
let phys = null;
let playerBody = null;
let physReady = false;
const props = []; // {mesh, body, home}
window.__props = props; // debug handle

function initPhysics() {
  if (!RAPIER || physReady || !collider) return;
  phys = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
  // the same merged environment geometry the player collides with, as a static trimesh
  const pos = collider.geometry.attributes.position;
  const idx = new Uint32Array(pos.count);
  for (let i = 0; i < pos.count; i++) idx[i] = i;
  phys.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(pos.array), idx).setFriction(0.9));
  // kinematic capsule mirroring the player, so walking into props shoves them
  playerBody = phys.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
  phys.createCollider(RAPIER.ColliderDesc.capsule(capsuleSegLength / 2, CAPSULE_RADIUS), playerBody);
  physReady = true;
}

const PROP_DEFS = [
  { kind: 'box', size: 0.55, color: 0xd35d47, name: 'crate-red' },
  { kind: 'box', size: 0.45, color: 0x4f9dd8, name: 'crate-blue' },
  { kind: 'box', size: 0.65, color: 0xd8b44f, name: 'crate-yellow' },
  { kind: 'ball', size: 0.32, color: 0x7ac74f, name: 'ball-green' },
];

function spawnProps(origin) {
  if (!physReady || props.length) return;
  PROP_DEFS.forEach((def, i) => {
    const geom = def.kind === 'ball'
      ? new THREE.SphereGeometry(def.size, 24, 16)
      : new THREE.BoxGeometry(def.size, def.size, def.size);
    const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.55, metalness: 0.05 }));
    mesh.name = def.name;
    scene.add(mesh);
    const angle = (i / PROP_DEFS.length) * Math.PI * 2 + 0.6;
    const home = { x: origin.x + Math.cos(angle) * 1.7, y: origin.y + 0.8 + i * 0.35, z: origin.z + Math.sin(angle) * 1.7 };
    const body = phys.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(home.x, home.y, home.z).setLinearDamping(0.05).setAngularDamping(0.15)
    );
    const col = def.kind === 'ball'
      ? RAPIER.ColliderDesc.ball(def.size)
      : RAPIER.ColliderDesc.cuboid(def.size / 2, def.size / 2, def.size / 2);
    phys.createCollider(col.setFriction(0.8).setRestitution(def.kind === 'ball' ? 0.55 : 0.15).setDensity(1), body);
    props.push({ mesh, body, home });
  });
}

// Captured real objects: metric GLB -> scaled visual mesh + convex-hull physics body.
function spawnObjectProps(origin) {
  if (!physReady || !OBJECT_PROPS.length) return;
  const loader = new GLTFLoader();
  OBJECT_PROPS.forEach((def, i) => {
    loader.load(def.url, (gltf) => {
      const src = gltf.scene;
      src.updateMatrixWorld(true);
      const meshes = [];
      src.traverse((o) => { if (o.isMesh) meshes.push(o); });
      if (!meshes.length) return;

      const scale = (def.scale ?? 1) * METERS_TO_WORLD;
      src.scale.setScalar(scale);
      src.updateMatrixWorld(true);
      scene.add(src);

      // Convex hull over all vertices. matrixWorld already carries the scale set
      // above, and the hull must be centered on the body origin — so subtract the
      // group's own position rather than scaling a second time.
      const origin = new THREE.Vector3().setFromMatrixPosition(src.matrixWorld);
      const pts = [];
      for (const m of meshes) {
        const p = m.geometry.attributes.position;
        const v = new THREE.Vector3();
        for (let k = 0; k < p.count; k++) {
          v.fromBufferAttribute(p, k).applyMatrix4(m.matrixWorld).sub(origin);
          pts.push(v.x, v.y, v.z);
        }
      }
      const angle = (i / OBJECT_PROPS.length) * Math.PI * 2 - 0.8;
      const home = { x: origin.x + Math.cos(angle) * 2.4, y: origin.y + 1.0, z: origin.z + Math.sin(angle) * 2.4 };
      const body = phys.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(home.x, home.y, home.z).setLinearDamping(0.05).setAngularDamping(0.2)
      );
      const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
      if (desc) phys.createCollider(desc.setFriction(0.9).setRestitution(0.05).setDensity(1), body);
      props.push({ mesh: src, body, home });
      console.log(`prop "${def.name}" loaded (${meshes.length} mesh(es), scale ${scale.toFixed(1)}x)`);
    }, undefined, (err) => console.warn(`prop "${def.name}" failed to load`, err));
  });
}

// grab / carry / throw (E — object under the crosshair)
let carried = null;
const grabRaycaster = new THREE.Raycaster();
function toggleGrab() {
  if (!physReady) return;
  if (carried) { releaseCarried(); return; }
  camera.updateMatrixWorld(); // matrices only refresh on render — force them current
  for (const p of props) p.mesh.updateMatrixWorld(true);
  grabRaycaster.setFromCamera({ x: 0, y: 0 }, camera);
  grabRaycaster.far = 6;
  // recursive: captured objects are GLB groups, primitives are bare meshes
  const hit = grabRaycaster.intersectObjects(props.map(p => p.mesh), true)[0];
  if (!hit) return;
  const entry = props.find(p => {
    let o = hit.object;
    while (o) { if (o === p.mesh) return true; o = o.parent; }
    return false;
  });
  if (!entry) return;
  entry.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
  const t = entry.body.translation();
  carried = { entry, prev: new THREE.Vector3(t.x, t.y, t.z), vel: new THREE.Vector3() };
}
function releaseCarried() {
  const { entry, vel } = carried;
  entry.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  const v = vel.clampLength(0, 9); // throw with carry momentum, capped
  entry.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
  carried = null;
}

let physAcc = 0;
const FIXED_DT = 1 / 60;
function stepPhysics(delta) {
  if (!physReady) return;
  playerBody.setNextKinematicTranslation({
    x: player.position.x,
    y: player.position.y + CAPSULE_HEIGHT / 2,
    z: player.position.z,
  });
  if (carried) {
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const target = camera.position.clone().addScaledVector(dir, 2.2);
    const next = carried.prev.clone().lerp(target, Math.min(1, delta * 14));
    carried.vel.copy(next).sub(carried.prev).divideScalar(Math.max(delta, 1e-4));
    carried.prev.copy(next);
    carried.entry.body.setNextKinematicTranslation({ x: next.x, y: next.y, z: next.z });
  }
  physAcc = Math.min(physAcc + delta, 0.2);
  while (physAcc >= FIXED_DT) {
    phys.timestep = FIXED_DT;
    phys.step();
    physAcc -= FIXED_DT;
  }
  for (const p of props) {
    const t = p.body.translation(), r = p.body.rotation();
    p.mesh.position.set(t.x, t.y, t.z);
    p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    if (t.y < -12 && carried?.entry !== p) { // fell off the world: back to home
      p.body.setTranslation(p.home, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }
}

// ---------------------------------------------------------------- model loading
const overlay = document.getElementById('overlay');
const loadbarFill = document.querySelector('#loadbar div');
const clicktip = document.getElementById('clicktip');
const overlaySub = document.querySelector('#overlay .sub');
let modelReady = false;

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
    buildCollider();

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
    spawnProps(SPAWN);
    spawnObjectProps(SPAWN);
    modelReady = true;
    loadbarFill.style.width = '100%';
    document.getElementById('loadbar').style.display = 'none';
    clicktip.style.display = 'block';
  },
  (ev) => {
    if (ev.total) loadbarFill.style.width = `${Math.round((ev.loaded / ev.total) * 100)}%`;
  },
  (err) => {
    console.error('model load failed', err);
    overlaySub.textContent = 'Could not load assets/desk.glb — run the reconstruction pipeline first. (Walking on the empty grid instead.)';
    buildCollider();
    spawnProps(new THREE.Vector3(0, 1, 1.5));
    modelReady = true;
    document.getElementById('loadbar').style.display = 'none';
    clicktip.style.display = 'block';
  }
);

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
  if (code === 'KeyE') toggleGrab();
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

function updateCamera() {
  camera.position.copy(player.position);
  camera.position.y += CAPSULE_HEIGHT - 0.12; // eyes near capsule top
  camera.rotation.set(0, 0, 0);
  camera.rotateY(player.yaw);
  camera.rotateX(player.pitch);
}

// debug: drive the full sim without rAF (hidden tabs pause rAF)
window.__step = (dt) => { updatePlayer(dt); updateCamera(); stepPhysics(dt); };

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  // substep for stability
  const steps = 3;
  for (let i = 0; i < steps; i++) updatePlayer(delta / steps);
  updateCamera();
  stepPhysics(delta);

  renderer.render(scene, camera);
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
