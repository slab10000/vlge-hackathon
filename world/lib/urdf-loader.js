// Minimal URDF -> three.js loader.
//
// Covers what our robot packages actually emit: named materials, link <visual>
// lists with mesh (.stl / .obj) / box / cylinder / sphere geometry, and
// fixed/revolute/continuous/prismatic joints with <mimic> coupling. Collision
// geometry is ignored — the scene raycasts against the visual meshes directly.
//
// The URDF is parsed and its meshes fetched ONCE into a `URDFAsset`; every
// `asset.build()` spawns a fresh instance that shares geometries and materials,
// so dropping ten arms into the scene costs ten scene graphs, not ten downloads.

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

// ---------------------------------------------------------------- xml helpers
const childrenByTag = (el, tag) => Array.from(el.children).filter((c) => c.tagName === tag);
const childByTag = (el, tag) => childrenByTag(el, tag)[0] || null;

function numbers(str, fallback) {
  if (!str) return fallback;
  const parts = str.trim().split(/\s+/).map(Number);
  return parts.length === fallback.length && parts.every(Number.isFinite) ? parts : fallback;
}

// URDF rpy is fixed-axis: R = Rz(yaw)·Ry(pitch)·Rx(roll), which is exactly what
// three.js calls Euler order 'ZYX' with components (roll, pitch, yaw).
function originOf(el) {
  const o = el ? childByTag(el, 'origin') : null;
  const xyz = numbers(o && o.getAttribute('xyz'), [0, 0, 0]);
  const rpy = numbers(o && o.getAttribute('rpy'), [0, 0, 0]);
  return {
    pos: new THREE.Vector3().fromArray(xyz),
    quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX')),
  };
}

function resolveMeshURL(filename, baseURL) {
  // package://my_robot/meshes/x.stl -> meshes/x.stl, resolved next to the URDF
  const clean = filename.replace(/^package:\/\/[^/]*\//, '').replace(/^model:\/\//, '');
  return new URL(clean, baseURL).href;
}

// ---------------------------------------------------------------- parsing
function parseURDF(text, baseURL) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(`URDF is not valid XML: ${err.textContent.slice(0, 200)}`);
  const robotEl = doc.querySelector('robot');
  if (!robotEl) throw new Error('URDF has no <robot> element');

  const materials = new Map();
  for (const m of childrenByTag(robotEl, 'material')) {
    const color = childByTag(m, 'color');
    if (color) materials.set(m.getAttribute('name'), numbers(color.getAttribute('rgba'), [0.8, 0.8, 0.8, 1]));
  }

  const links = new Map();
  const meshURLs = new Set();
  for (const linkEl of childrenByTag(robotEl, 'link')) {
    const visuals = [];
    for (const v of childrenByTag(linkEl, 'visual')) {
      const geomEl = childByTag(v, 'geometry');
      if (!geomEl) continue;
      const geom = parseGeometry(geomEl, baseURL);
      if (!geom) continue;
      if (geom.type === 'mesh') meshURLs.add(geom.url);

      // colour: named reference into the robot-level table, or inline
      const matEl = childByTag(v, 'material');
      let rgba = null;
      let matName = null;
      if (matEl) {
        matName = matEl.getAttribute('name');
        const inline = childByTag(matEl, 'color');
        if (inline) rgba = numbers(inline.getAttribute('rgba'), null);
        if (!rgba && materials.has(matName)) rgba = materials.get(matName);
      }
      visuals.push({ ...originOf(v), geom, rgba, matName });
    }
    links.set(linkEl.getAttribute('name'), { visuals });
  }

  const joints = [];
  for (const j of childrenByTag(robotEl, 'joint')) {
    const parent = childByTag(j, 'parent');
    const child = childByTag(j, 'child');
    if (!parent || !child) continue;
    const limitEl = childByTag(j, 'limit');
    const axis = numbers(childByTag(j, 'axis') && childByTag(j, 'axis').getAttribute('xyz'), [1, 0, 0]);
    // <mimic> couples this joint to another (coupled gripper fingers, four-bar
    // linkages). Loaders that skip it report a DOF that is not really commandable.
    const mimicEl = childByTag(j, 'mimic');
    joints.push({
      name: j.getAttribute('name'),
      type: j.getAttribute('type') || 'fixed',
      parent: parent.getAttribute('link'),
      child: child.getAttribute('link'),
      axis: new THREE.Vector3().fromArray(axis),
      lower: limitEl ? Number(limitEl.getAttribute('lower') || 0) : 0,
      upper: limitEl ? Number(limitEl.getAttribute('upper') || 0) : 0,
      mimic: mimicEl ? {
        joint: mimicEl.getAttribute('joint'),
        multiplier: Number(mimicEl.getAttribute('multiplier') ?? 1) || 1,
        offset: Number(mimicEl.getAttribute('offset') ?? 0) || 0,
      } : null,
      ...originOf(j),
    });
  }

  // root = the one link nothing declares as a child
  const childLinks = new Set(joints.map((j) => j.child));
  const roots = [...links.keys()].filter((n) => !childLinks.has(n));
  if (!roots.length) throw new Error('URDF has no root link (every link is a joint child)');

  return { name: robotEl.getAttribute('name') || 'robot', materials, links, joints, root: roots[0], meshURLs };
}

function parseGeometry(geomEl, baseURL) {
  const mesh = childByTag(geomEl, 'mesh');
  if (mesh) {
    return {
      type: 'mesh',
      url: resolveMeshURL(mesh.getAttribute('filename'), baseURL),
      scale: numbers(mesh.getAttribute('scale'), [1, 1, 1]),
    };
  }
  const box = childByTag(geomEl, 'box');
  if (box) return { type: 'box', size: numbers(box.getAttribute('size'), [1, 1, 1]) };
  const cyl = childByTag(geomEl, 'cylinder');
  if (cyl) return { type: 'cylinder', radius: Number(cyl.getAttribute('radius')), length: Number(cyl.getAttribute('length')) };
  const sphere = childByTag(geomEl, 'sphere');
  if (sphere) return { type: 'sphere', radius: Number(sphere.getAttribute('radius')) };
  return null;
}

// ---------------------------------------------------------------- robot instance
export class URDFRobot extends THREE.Group {
  constructor(name) {
    super();
    this.name = name;
    this.isURDFRobot = true;
    this.links = new Map();
    this.joints = new Map();
    this.followers = new Map(); // joint name -> [{ name, multiplier, offset }]
  }

  setJointValue(name, value) {
    const j = this.joints.get(name);
    if (!j) return false;
    const v = j.type === 'continuous' ? value : THREE.MathUtils.clamp(value, j.lower, j.upper);
    j.value = v;
    if (j.type === 'prismatic') {
      j.node.position.copy(j.pos).addScaledVector(_axisWorld.copy(j.axis).applyQuaternion(j.quat), v);
    } else {
      j.node.quaternion.copy(j.quat).multiply(_q.setFromAxisAngle(j.axis, v));
    }
    // drag any joint that mimics this one along with it (one level: URDF forbids
    // a mimic joint from itself being mimicked, so this cannot recurse)
    for (const f of this.followers.get(name) || []) {
      this.setJointValue(f.name, v * f.multiplier + f.offset);
    }
    return true;
  }

  /** Joints you can actually command — mimic followers move on their own. */
  get drivenJoints() {
    return new Map([...this.joints].filter(([, j]) => !j.mimic));
  }

  resetJoints() {
    for (const name of this.joints.keys()) this.setJointValue(name, 0);
  }
}

const _q = new THREE.Quaternion();
const _axisWorld = new THREE.Vector3();

// ---------------------------------------------------------------- asset
export class URDFAsset {
  constructor(spec, meshes) {
    this.spec = spec;
    // url -> BufferGeometry (.stl, colour comes from the URDF) or Object3D
    // prototype (.obj, colour comes from its own .mtl)
    this.meshes = meshes;
    this.materials = new Map();
    this.name = spec.name;
  }

  materialFor(visual) {
    const key = visual.matName || (visual.rgba ? visual.rgba.join(',') : 'default');
    let mat = this.materials.get(key);
    if (!mat) {
      const [r, g, b, a] = visual.rgba || [0.75, 0.75, 0.78, 1];
      mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(r, g, b),
        metalness: 0.15,
        roughness: 0.55,
        transparent: a < 1,
        opacity: a,
      });
      this.materials.set(key, mat);
    }
    return mat;
  }

  geometryFor(visual) {
    const g = visual.geom;
    if (g.type === 'mesh') {
      const m = this.meshes.get(g.url);
      return m && m.isBufferGeometry ? m : null;
    }
    if (g.type === 'box') return new THREE.BoxGeometry(...g.size);
    if (g.type === 'sphere') return new THREE.SphereGeometry(g.radius, 24, 16);
    if (g.type === 'cylinder') return new THREE.CylinderGeometry(g.radius, g.radius, g.length, 24);
    return null;
  }

  /**
   * One visual as a scene node. OBJ visuals arrive as a prototype Object3D that
   * already carries its own MTL colours; cloning shares geometry and materials,
   * so extra copies are cheap. Everything else is a single Mesh.
   */
  nodeFor(visual, materialOverride) {
    const g = visual.geom;
    const proto = g.type === 'mesh' ? this.meshes.get(g.url) : null;

    if (proto && proto.isObject3D) {
      const node = proto.clone(true);
      // a URDF <material> on the visual outranks the file's own materials
      const override = materialOverride || (visual.rgba ? this.materialFor(visual) : null);
      if (override) node.traverse((o) => { if (o.isMesh) o.material = override; });
      node.scale.fromArray(g.scale);
      return node;
    }

    const geometry = this.geometryFor(visual);
    if (!geometry) return null;
    const mesh = new THREE.Mesh(geometry, materialOverride || this.materialFor(visual));
    // URDF cylinders run along +Z; three.js builds them along +Y
    if (g.type === 'cylinder') mesh.rotation.x = Math.PI / 2;
    if (g.type === 'mesh') mesh.scale.fromArray(g.scale);
    return mesh;
  }

  // `materialOverride` renders the whole robot in one material (used for the
  // translucent drag-preview ghost) without touching the shared materials.
  build(materialOverride = null) {
    const robot = new URDFRobot(this.spec.name);
    const zUp = new THREE.Group(); // URDF is Z-up, three.js is Y-up
    zUp.rotation.x = -Math.PI / 2;
    zUp.name = '__urdf_z_up';
    robot.add(zUp);
    zUp.add(this._buildLink(this.spec.root, robot, materialOverride, new Set()));
    return robot;
  }

  _buildLink(linkName, robot, materialOverride, visiting) {
    if (visiting.has(linkName)) throw new Error(`URDF joint tree has a cycle at "${linkName}"`);
    visiting.add(linkName);

    const link = new THREE.Group();
    link.name = linkName;
    robot.links.set(linkName, link);

    const spec = this.spec.links.get(linkName);
    for (const v of (spec ? spec.visuals : [])) {
      const visual = this.nodeFor(v, materialOverride);
      if (!visual) continue;
      visual.name = `${linkName}_visual`;
      const node = new THREE.Group();
      node.position.copy(v.pos);
      node.quaternion.copy(v.quat);
      node.add(visual);
      link.add(node);
    }

    for (const j of this.spec.joints.filter((x) => x.parent === linkName)) {
      const node = new THREE.Group();
      node.name = j.name;
      node.position.copy(j.pos);
      node.quaternion.copy(j.quat);
      link.add(node);
      node.add(this._buildLink(j.child, robot, materialOverride, visiting));
      if (j.type !== 'fixed') {
        robot.joints.set(j.name, {
          node,
          type: j.type,
          axis: j.axis.clone().normalize(),
          pos: j.pos.clone(),
          quat: j.quat.clone(),
          lower: j.type === 'continuous' ? -Math.PI : j.lower,
          upper: j.type === 'continuous' ? Math.PI : j.upper,
          mimic: j.mimic,
          value: 0,
        });
        if (j.mimic) {
          const list = robot.followers.get(j.mimic.joint) || [];
          list.push({ name: j.name, multiplier: j.mimic.multiplier, offset: j.mimic.offset });
          robot.followers.set(j.mimic.joint, list);
        }
      }
    }

    visiting.delete(linkName);
    return link;
  }
}

// ---------------------------------------------------------------- mesh loading
// main.js installs three-mesh-bvh on the prototype; use it when present so
// dragging an arm around raycasts against it cheaply.
function prepareGeometry(geometry) {
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  if (geometry.computeBoundsTree) geometry.computeBoundsTree();
  return geometry;
}

async function loadSTL(url) {
  const geometry = await new STLLoader().loadAsync(url);
  geometry.computeVertexNormals(); // STL face normals are per-facet and often stale
  return prepareGeometry(geometry);
}

// OBJ carries its own materials in a side-car .mtl. Read the file first so the
// `mtllib` line names it — deriving the name from the .obj path guesses wrong on
// packages where several meshes share one library.
async function loadOBJ(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mesh fetch failed: ${res.status} ${url}`);
  const text = await res.text();

  const loader = new OBJLoader();
  const lib = text.match(/^\s*mtllib\s+(.+?)\s*$/m);
  if (lib) {
    try {
      const materials = await new MTLLoader().loadAsync(new URL(lib[1], url).href);
      materials.preload();
      loader.setMaterials(materials);
    } catch (err) {
      console.warn(`URDF: could not load materials for ${url} — using default grey`, err);
    }
  }

  const root = loader.parse(text);
  root.traverse((o) => {
    if (!o.isMesh) return;
    prepareGeometry(o.geometry);
    // MTLLoader hands back Phong; the rest of the scene is lit as Standard
    const src = Array.isArray(o.material) ? o.material[0] : o.material;
    o.material = new THREE.MeshStandardMaterial({
      color: src && src.color ? src.color.clone() : new THREE.Color(0.75, 0.75, 0.78),
      metalness: 0.15,
      roughness: 0.55,
      opacity: src && src.opacity != null ? src.opacity : 1,
      transparent: !!(src && src.opacity != null && src.opacity < 1),
    });
  });
  return root;
}

function loadMesh(url) {
  if (/\.stl(\?|$)/i.test(url)) return loadSTL(url);
  if (/\.obj(\?|$)/i.test(url)) return loadOBJ(url);
  return Promise.reject(new Error(`unsupported URDF mesh format: ${url}`));
}

// ---------------------------------------------------------------- entry point
export async function loadURDF(url, { onProgress } = {}) {
  const baseURL = new URL(url, location.href).href;
  const res = await fetch(baseURL);
  if (!res.ok) throw new Error(`URDF fetch failed: ${res.status} ${baseURL}`);
  const spec = parseURDF(await res.text(), baseURL);

  const urls = [...spec.meshURLs];
  const meshes = new Map();
  let done = 0;
  await Promise.all(
    urls.map(async (u) => {
      meshes.set(u, await loadMesh(u));
      if (onProgress) onProgress(++done, urls.length);
    })
  );

  return new URDFAsset(spec, meshes);
}
