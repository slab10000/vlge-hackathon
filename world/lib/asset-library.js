// Drop-in asset library.
//
// Anything copied into world/assets/library/ (.glb, .gltf or .ply — subfolders
// fine) shows up in the editor's asset shelf. Discovery is zero-config: the dev
// server (`python3 -m http.server --directory world`) serves a directory index and
// we parse it. Servers that hide directory listings are covered by an optional
// manifest.json in the same folder — regenerate it with `python3 tools/scan_assets.py`.
//
// Every asset is normalized on load into the same contract the URDF loader
// exposes ({ build(material) -> fresh Object3D }), expressed in METRES, centred on
// its own XZ origin with its floor at y=0 — so main.js can drop one into the world
// without knowing where it came from.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

export const LIBRARY_URL = './assets/library/';

const SUPPORTED = /\.(glb|gltf|ply)$/i;
const MAX_DEPTH = 3;      // how deep to walk subfolders
const MAX_FILES = 200;    // sanity cap so a stray huge folder can't hang the boot

// A file whose longest side lands outside this range is almost certainly not in
// metres (millimetre exports, unit-cube normalized meshes, arbitrary scanner
// units...) — those get scaled to AUTO_SIZE_M so they are at least placeable.
const MIN_SANE_M = 0.02;
const MAX_SANE_M = 3.0;
const AUTO_SIZE_M = 0.25;

// ---------------------------------------------------------------- discovery
async function listDirectory(url, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let html;
  try {
    const res = await fetch(url, { headers: { Accept: 'text/html' } });
    if (!res.ok) return;
    html = await res.text();
  } catch {
    return; // no listing (or no server) — manifest.json is the fallback
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const subdirs = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    // stay inside the library: no absolute paths, no parents, no other origins
    if (!href || href.startsWith('/') || href.startsWith('?') || href.startsWith('#')) continue;
    if (href.includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    const resolved = new URL(href, url).href;
    if (href.endsWith('/')) subdirs.push(resolved);
    else if (SUPPORTED.test(href)) out.push(resolved);
  }
  for (const dir of subdirs) await listDirectory(dir, depth + 1, out);
}

async function loadManifest(base) {
  const entries = new Map();
  try {
    const res = await fetch(new URL('manifest.json', base));
    if (!res.ok) return entries;
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.assets || []);
    for (const raw of list) {
      const entry = typeof raw === 'string' ? { file: raw } : raw;
      if (entry && typeof entry.file === 'string') entries.set(entry.file, entry);
    }
  } catch {
    // no manifest, or it is malformed — the directory listing already covers us
  }
  return entries;
}

function labelFor(file) {
  const stem = file.replace(/\.[^.]+$/, '').split('/').pop();
  const words = stem.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : file;
}

const ICONS = { ply: '🌫️', glb: '📦', gltf: '📦' };

/**
 * Find every model file in the library folder.
 * Returns [{ key, file, url, label, icon, kind, scale?, size? }] sorted by name.
 * Manifest entries win over auto-discovered ones (that is where you put overrides).
 */
export async function scanLibrary(baseURL = LIBRARY_URL) {
  const base = new URL(baseURL.endsWith('/') ? baseURL : `${baseURL}/`, location.href);
  const [overrides, urls] = await Promise.all([
    loadManifest(base),
    (async () => { const out = []; await listDirectory(base.href, 0, out); return out; })(),
  ]);

  const files = new Map(); // relative path -> manifest override (or {})
  for (const [file, entry] of overrides) files.set(file, entry);
  for (const url of urls) {
    const file = decodeURIComponent(url.startsWith(base.href) ? url.slice(base.href.length) : url);
    if (!files.has(file)) files.set(file, {});
  }

  return [...files.entries()]
    .filter(([file]) => SUPPORTED.test(file))
    .map(([file, entry]) => {
      const kind = file.split('.').pop().toLowerCase();
      return {
        key: `lib:${file}`,
        file,
        url: new URL(encodeURI(file), base).href,
        label: entry.label || labelFor(file),
        icon: entry.icon || ICONS[kind] || '📦',
        kind,
        scale: entry.scale,
        size: entry.size,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------- ply
// 3D Gaussian splat exports are PLY files too, but their colour lives in
// spherical-harmonic DC terms (f_dc_*) instead of red/green/blue, so a plain read
// gives a colourless cloud. We can't render true anisotropic splats here, but
// decoding the DC term + opacity gives a properly coloured point cloud.
const SH_C0 = 0.28209479177387814;
const MIN_SPLAT_ALPHA = 0.25;   // splat trainers leave a haze of near-invisible blobs

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function decodeSplat(geometry) {
  const pos = geometry.attributes.position;
  const dc = geometry.attributes.splatColor;
  const raw = geometry.attributes.splatAlpha;
  const positions = new Float32Array(pos.count * 3);
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  let kept = 0;

  for (let i = 0; i < pos.count; i++) {
    if (raw && 1 / (1 + Math.exp(-raw.getX(i))) < MIN_SPLAT_ALPHA) continue;
    positions[kept * 3] = pos.getX(i);
    positions[kept * 3 + 1] = pos.getY(i);
    positions[kept * 3 + 2] = pos.getZ(i);
    // DC term -> display colour; setRGB converts into the renderer's working space
    c.setRGB(
      clamp01(0.5 + SH_C0 * dc.getX(i)),
      clamp01(0.5 + SH_C0 * dc.getY(i)),
      clamp01(0.5 + SH_C0 * dc.getZ(i)),
      THREE.SRGBColorSpace
    );
    colors[kept * 3] = c.r;
    colors[kept * 3 + 1] = c.g;
    colors[kept * 3 + 2] = c.b;
    kept++;
  }

  // an unusual export where almost everything reads as transparent: keep it all
  // rather than hand back an empty cloud
  if (kept < pos.count * 0.02) return decodeSplat(stripAlpha(geometry));

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, kept * 3), 3));
  out.setAttribute('color', new THREE.BufferAttribute(colors.subarray(0, kept * 3), 3));
  return out;
}

function stripAlpha(geometry) {
  geometry.deleteAttribute('splatAlpha');
  return geometry;
}

function plyToObject(geometry) {
  if (geometry.attributes.splatColor) geometry = decodeSplat(geometry);
  const hasColor = !!geometry.attributes.color;

  if (geometry.index && geometry.index.count) {
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    if (geometry.computeBoundsTree) geometry.computeBoundsTree();
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      vertexColors: hasColor,
      color: hasColor ? 0xffffff : 0xb9c4d0,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0.0,
    }));
  }

  // No faces: a point cloud. Point size follows the sample spacing (points sit on
  // a surface, so spacing ~ extent / sqrt(count)) — a fixed size is either an
  // invisible dust cloud or one solid blob depending on the file.
  geometry.computeBoundingBox();
  const extent = geometry.boundingBox.getSize(new THREE.Vector3());
  const count = geometry.attributes.position.count;
  const maxDim = Math.max(extent.x, extent.y, extent.z) || 1;
  return new THREE.Points(geometry, new THREE.PointsMaterial({
    size: Math.max(1e-6, (maxDim / Math.max(8, Math.sqrt(count))) * 1.6),
    sizeAttenuation: true,
    vertexColors: hasColor,
    color: hasColor ? 0xffffff : 0x9fb4c8,
  }));
}

// PLY needs the bytes up front: the header tells us whether this is a splat, which
// decides how we ask PLYLoader to read it. One fetch, streamed for progress.
async function loadPLY(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PLY fetch failed: ${res.status} ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;

  let buffer;
  if (res.body && onProgress && total) {
    const chunks = [];
    let loaded = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(Math.min(1, loaded / total));
    }
    buffer = new Blob(chunks).arrayBuffer();
    buffer = await buffer;
  } else {
    buffer = await res.arrayBuffer();
  }

  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096)));
  const loader = new PLYLoader();
  if (/property\s+float\s+f_dc_0/.test(head)) {
    loader.setCustomPropertyNameMapping({
      splatColor: ['f_dc_0', 'f_dc_1', 'f_dc_2'],
      splatAlpha: ['opacity'],
    });
  }
  return plyToObject(loader.parse(buffer));
}

// ---------------------------------------------------------------- loading
async function loadSource(url, onProgress) {
  const path = url.split(/[?#]/)[0];
  const track = onProgress ? (ev) => { if (ev.total) onProgress(ev.loaded / ev.total); } : undefined;

  if (/\.ply$/i.test(path)) return loadPLY(url, onProgress);

  const gltf = await new GLTFLoader().loadAsync(url, track);
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.material.side = THREE.DoubleSide;   // scans are often single-sided shells
    if (o.geometry.computeBoundsTree && !o.geometry.boundsTree) o.geometry.computeBoundsTree();
  });
  return gltf.scene;
}

// Put the object in metres, centred on XZ, floor at y=0, inside a wrapper Group.
function normalize(object, { scale, size } = {}) {
  const root = new THREE.Group();
  root.add(object);
  object.updateMatrixWorld(true);

  let box = new THREE.Box3().setFromObject(object);
  let extent = box.getSize(new THREE.Vector3());
  let maxDim = Math.max(extent.x, extent.y, extent.z);
  if (!(maxDim > 0) || !isFinite(maxDim)) throw new Error('asset has degenerate bounds');

  let factor = 1;
  let autoScaled = false;
  if (Number.isFinite(size) && size > 0) {
    factor = size / maxDim;                       // manifest: "make it this tall"
  } else if (Number.isFinite(scale) && scale > 0) {
    factor = scale;                               // manifest: "source units -> metres"
  } else if (maxDim < MIN_SANE_M || maxDim > MAX_SANE_M) {
    factor = AUTO_SIZE_M / maxDim;                // not metres — guess something usable
    autoScaled = true;
  }

  if (factor !== 1) {
    object.scale.multiplyScalar(factor);
    object.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(object);
  }
  const center = box.getCenter(new THREE.Vector3());
  object.position.x -= center.x;
  object.position.z -= center.z;
  object.position.y -= box.min.y;
  object.updateMatrixWorld(true);

  extent = box.getSize(new THREE.Vector3());
  return { root, autoScaled, extent };
}

function describe(root, extent, autoScaled) {
  let tris = 0;
  let points = 0;
  root.traverse((o) => {
    if (o.isPoints) points += o.geometry.attributes.position.count;
    else if (o.isMesh) {
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });
  const cm = Math.round(Math.max(extent.x, extent.y, extent.z) * 100);
  const body = points
    ? `${(points / 1000).toFixed(points > 1e5 ? 0 : 1)}k points`
    : `${tris >= 1000 ? `${Math.round(tris / 1000)}k` : Math.round(tris)} tris`;
  return `${body} · ${cm} cm${autoScaled ? ' (auto-scaled)' : ''}`;
}

// Ghosts are drawn in a flat tint; Points need a PointsMaterial, not the mesh one.
function ghostify(object, material) {
  object.traverse((o) => {
    if (o.isPoints) {
      const m = o.material.clone();
      m.transparent = true;
      m.opacity = 0.5;
      m.vertexColors = false;
      m.color = new THREE.Color(material.color?.getHex?.() ?? 0x7fd4ff);
      m.depthWrite = false;
      o.material = m;
    } else if (o.isMesh) {
      o.material = material;
    }
  });
}

/**
 * Load one .glb/.gltf/.ply into a shelf-ready asset.
 * Matches the URDFAsset contract: geometries are shared, build() is cheap.
 */
export async function loadLibraryAsset(url, opts = {}) {
  const source = await loadSource(url, opts.onProgress);
  const { root, autoScaled, extent } = normalize(source, opts);
  root.updateMatrixWorld(true);

  return {
    spec: null,                       // not articulated — the inspector shows no joints
    autoScaled,
    extent,
    note: describe(root, extent, autoScaled),
    build(material) {
      const copy = root.clone(true);
      if (material) ghostify(copy, material);
      return copy;
    },
  };
}
