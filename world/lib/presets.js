/**
 * Named scene presets, stored per scenario in localStorage.
 *
 * A preset is just the placement list — which assets sit where, how big, and
 * (for URDFs) how they are posed. The scan itself is not stored: presets belong
 * to a scenario, so switching scenario switches which presets you can see.
 *
 * Storage shape:
 *   deskTwin.presets = { "<scenarioId>": { "<name>": { saved, objects: [...] } } }
 *
 * Every call is defensive: localStorage throws when cookies are blocked or the
 * page is a sandboxed iframe, and a half-written value from an older build
 * should degrade to "no presets", never to a crash.
 */
const STORE_KEY = 'deskTwin.presets';
const MAX_NAME = 40;

function readAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(all) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
    return { ok: true };
  } catch (err) {
    // QuotaExceededError is the realistic one — presets are small, but the same
    // origin also holds asset sizes and whatever else the app keeps.
    return { ok: false, error: err?.name === 'QuotaExceededError' ? 'storage full' : 'storage unavailable' };
  }
}

/** Trim/limit a user-typed name. Returns '' if nothing usable is left. */
export function cleanName(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
}

/** [{ name, saved, count }] for one scenario, newest first. */
export function listPresets(scenarioId) {
  const bucket = readAll()[scenarioId];
  if (!bucket || typeof bucket !== 'object') return [];
  return Object.entries(bucket)
    .filter(([, p]) => p && Array.isArray(p.objects))
    .map(([name, p]) => ({ name, saved: p.saved || 0, count: p.objects.length }))
    .sort((a, b) => b.saved - a.saved);
}

export function hasPreset(scenarioId, name) {
  const bucket = readAll()[scenarioId];
  return !!(bucket && bucket[cleanName(name)]);
}

/** The stored object list, or null. */
export function readPreset(scenarioId, name) {
  const entry = readAll()[scenarioId]?.[cleanName(name)];
  return entry && Array.isArray(entry.objects) ? entry.objects : null;
}

export function savePreset(scenarioId, name, objects, now = Date.now()) {
  const key = cleanName(name);
  if (!key) return { ok: false, error: 'name required' };
  const all = readAll();
  if (!all[scenarioId] || typeof all[scenarioId] !== 'object') all[scenarioId] = {};
  all[scenarioId][key] = { saved: now, objects };
  return { ...writeAll(all), name: key };
}

export function deletePreset(scenarioId, name) {
  const all = readAll();
  const bucket = all[scenarioId];
  if (!bucket) return { ok: true };
  delete bucket[cleanName(name)];
  if (!Object.keys(bucket).length) delete all[scenarioId];
  return writeAll(all);
}
