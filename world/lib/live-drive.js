// Live joint mirroring: subscribe to the robot laptop's state stream over a
// WebSocket and hand every joint-state message to the scene.
//
// The wire format is whatever tools/so101_ws_bridge.py forwards: the state dict
// of actuacore-feetech's scripts/zmq_so_arm_handler.py, one message per tick,
// as JSON text — { "joint_names": [...], "joint_pos": [radians|null, ...], ... }.
// Binary frames are accepted too and decoded as msgpack, so a bridge that skips
// the JSON re-encode still works. Anything without joint_names/joint_pos is
// silently ignored, which also lets the friend's so101_web_ui.py WebSocket
// (its {"type": "state", ...} spread carries the same keys) drive us directly.

export class LiveDrive {
  constructor({ onState, onStatus } = {}) {
    this.onState = onState;
    this.onStatus = onStatus;
    this.ws = null;
    this.url = null;
    this.enabled = false;
    this.status = 'idle'; // idle | connecting | waiting | live | retry
    this._times = [];     // recent message timestamps, for the Hz readout
    this._retryTimer = null;
  }

  connect(url) {
    this.disconnect();
    this.enabled = true;
    this.url = url;
    this._open();
  }

  disconnect() {
    this.enabled = false;
    clearTimeout(this._retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; ws.close(); }
    this._times.length = 0;
    this._setStatus('idle');
  }

  /** Messages per second over the last ~2s window. */
  get rate() {
    if (this._times.length < 2) return 0;
    const span = this._times[this._times.length - 1] - this._times[0];
    return span > 0 ? ((this._times.length - 1) * 1000) / span : 0;
  }

  _open() {
    this._setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) { // malformed URL — retrying can't fix it
      console.warn('live: bad WebSocket URL', err);
      this.enabled = false;
      this._setStatus('idle');
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { if (ws === this.ws) this._setStatus('waiting'); };
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      let msg = null;
      try {
        msg = typeof e.data === 'string' ? JSON.parse(e.data) : decodeMsgpack(new DataView(e.data));
      } catch { return; } // not a payload we understand — skip it
      if (!msg || !Array.isArray(msg.joint_names) || !Array.isArray(msg.joint_pos)) return;
      const now = performance.now();
      this._times.push(now);
      while (this._times.length && now - this._times[0] > 2000) this._times.shift();
      if (this.status !== 'live') this._setStatus('live');
      else if (this.onStatus) this.onStatus(this); // keep the Hz readout fresh
      if (this.onState) this.onState(msg);
    };
    // errors always end in a close event — reconnect from one place only
    ws.onclose = () => { if (ws === this.ws) this._dropped(); };
  }

  _dropped() {
    this.ws = null;
    this._times.length = 0;
    if (!this.enabled) return;
    this._setStatus('retry');
    this._retryTimer = setTimeout(() => this._open(), 1500);
  }

  _setStatus(s) {
    this.status = s;
    if (this.onStatus) this.onStatus(this);
  }
}

// ---------------------------------------------------------------- msgpack
// Just enough of the msgpack spec to read msgpack-python's default encoding of
// a dict of strings, numbers, bools, nulls and nested arrays. Ext types never
// appear in that payload, so they are a hard error rather than a guess.
const utf8 = new TextDecoder();

export function decodeMsgpack(view) {
  return readValue({ view, off: 0 });
}

function readValue(s) {
  const b = s.view.getUint8(s.off++);
  if (b <= 0x7f) return b;             // positive fixint
  if (b >= 0xe0) return b - 0x100;     // negative fixint
  if (b >= 0xa0 && b <= 0xbf) return readStr(s, b - 0xa0);
  if (b >= 0x90 && b <= 0x9f) return readArray(s, b - 0x90);
  if (b >= 0x80 && b <= 0x8f) return readMap(s, b - 0x80);
  switch (b) {
    case 0xc0: return null;
    case 0xc2: return false;
    case 0xc3: return true;
    case 0xc4: return readBin(s, readUint(s, 1));
    case 0xc5: return readBin(s, readUint(s, 2));
    case 0xc6: return readBin(s, readUint(s, 4));
    case 0xca: { const v = s.view.getFloat32(s.off); s.off += 4; return v; }
    case 0xcb: { const v = s.view.getFloat64(s.off); s.off += 8; return v; }
    case 0xcc: return readUint(s, 1);
    case 0xcd: return readUint(s, 2);
    case 0xce: return readUint(s, 4);
    case 0xcf: { const v = Number(s.view.getBigUint64(s.off)); s.off += 8; return v; }
    case 0xd0: { const v = s.view.getInt8(s.off); s.off += 1; return v; }
    case 0xd1: { const v = s.view.getInt16(s.off); s.off += 2; return v; }
    case 0xd2: { const v = s.view.getInt32(s.off); s.off += 4; return v; }
    case 0xd3: { const v = Number(s.view.getBigInt64(s.off)); s.off += 8; return v; }
    case 0xd9: return readStr(s, readUint(s, 1));
    case 0xda: return readStr(s, readUint(s, 2));
    case 0xdb: return readStr(s, readUint(s, 4));
    case 0xdc: return readArray(s, readUint(s, 2));
    case 0xdd: return readArray(s, readUint(s, 4));
    case 0xde: return readMap(s, readUint(s, 2));
    case 0xdf: return readMap(s, readUint(s, 4));
    default: throw new Error(`msgpack: unsupported type 0x${b.toString(16)}`);
  }
}

function readUint(s, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + s.view.getUint8(s.off++);
  return v;
}

function readStr(s, n) {
  const v = utf8.decode(new Uint8Array(s.view.buffer, s.view.byteOffset + s.off, n));
  s.off += n;
  return v;
}

function readBin(s, n) {
  const v = new Uint8Array(s.view.buffer.slice(s.view.byteOffset + s.off, s.view.byteOffset + s.off + n));
  s.off += n;
  return v;
}

function readArray(s, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = readValue(s);
  return out;
}

function readMap(s, n) {
  const out = {};
  for (let i = 0; i < n; i++) {
    const k = readValue(s);
    out[typeof k === 'string' ? k : String(k)] = readValue(s);
  }
  return out;
}
