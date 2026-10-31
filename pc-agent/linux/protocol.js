'use strict';
// Wire formats shared with server.js: JSON-line RPC on stdin/stdout, the IPC-key handshake of the loopback
// ports and the binary remote desktop protocol documented at the top of native/ScreenStreamer.cs.

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// JSON-line RPC (stdin -> stdout)
// ---------------------------------------------------------------------------
// handlers: { cmd: async (args) => data }. write: (line) => void. id 0 = fire-and-forget, no reply.
function createRpcDispatcher(handlers, write, log = () => {}) {
  return async function handleLine(line) {
    if (!line || !line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      write(JSON.stringify({ id: 0, ok: false, error: 'Geçersiz JSON: ' + e.message }));
      return;
    }
    const id = req && req.id !== undefined && req.id !== null ? req.id : 0;
    const cmd = String((req && req.cmd) || '');
    const args = req && req.args && typeof req.args === 'object' && !Array.isArray(req.args) ? req.args : {};
    const silent = String(id) === '0';
    const fn = Object.prototype.hasOwnProperty.call(handlers, cmd) ? handlers[cmd] : null;
    try {
      if (!fn) throw new Error('Unknown command: ' + cmd);
      const data = await fn(args);
      if (!silent) write(JSON.stringify({ id, ok: true, data: data === undefined ? null : data }));
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (!silent) write(JSON.stringify({ id, ok: false, error: msg }));
      else log(`${cmd} hata: ${msg}`);
    }
  };
}

// ---------------------------------------------------------------------------
// IPC key handshake for the loopback TCP ports
// ---------------------------------------------------------------------------
function ipcKeyMatches(got, key) {
  const k = String(key || '');
  if (k.length < 32) return false; // a missing / weak key must lock the ports, never open them
  const g = String(got || '').trim();
  const a = Buffer.from(g, 'utf8');
  const b = Buffer.from(k, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Waits for the first line of a socket, checks the key and hands over whatever arrived after it.
// Anything else (wrong key, >128 bytes without newline, an HTTP request) closes the socket.
function gateSocket(sock, key, onAuthed) {
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => sock.destroy(), 5000);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(10);
    if (nl < 0) {
      if (buf.length > 128) {
        clearTimeout(timer);
        sock.destroy();
      }
      return;
    }
    sock.removeListener('data', onData);
    clearTimeout(timer);
    const line = buf.subarray(0, nl).toString('utf8');
    if (!ipcKeyMatches(line, key)) {
      sock.destroy();
      return;
    }
    onAuthed(buf.subarray(nl + 1));
  };
  sock.on('data', onData);
  sock.on('error', () => clearTimeout(timer));
  sock.on('close', () => clearTimeout(timer));
}

// Fast input port: after the key, JSON lines of send_input args. The first non-JSON line drops the connection.
function attachInputLineProtocol(sock, rest, onArgs) {
  let pending = '';
  const feed = (chunk) => {
    pending += chunk.toString('utf8');
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line) continue;
      let args;
      try {
        args = JSON.parse(line);
      } catch {
        sock.destroy();
        return;
      }
      if (args && typeof args === 'object') {
        try {
          onArgs(args);
        } catch {}
      }
    }
    if (pending.length > 64 * 1024) sock.destroy();
  };
  if (rest && rest.length) feed(rest);
  sock.on('data', feed);
}

// ---------------------------------------------------------------------------
// Remote desktop binary protocol
// ---------------------------------------------------------------------------
const STREAM_REQ_MAGIC = 0x33524254; // "TBR3"
const STREAM_FRAME_MAGIC = 0x32464254; // "TBF2"
const REQ_SIZE = 24;
const FRAME_HEADER_SIZE = 28;

const FLAGS = {
  KEY: 0x01,
  REFINE: 0x02,
  CURSOR_VISIBLE: 0x04,
  CURSOR_SHAPE: 0x08,
  IDLE: 0x10,
  PENDING_REFINE: 0x20,
  DXGI: 0x40,
  VIDEO: 0x80,
  VIDEO_KEY: 0x100,
  VIDEO_AV1: 0x200
};

function parseStreamRequest(b) {
  if (!b || b.length < REQ_SIZE) throw new Error('short stream request');
  if (b.readUInt32LE(0) !== STREAM_REQ_MAGIC) throw new Error('bad stream request magic');
  const reqFlags = b[15];
  return {
    monitorIndex: b.readInt32LE(4),
    maxCanvasWidth: Math.max(640, Math.min(7680, b.readUInt16LE(8))),
    motionScale: b.readUInt16LE(10),
    motionQuality: b[12],
    refineQuality: b[13],
    mode: b[14], // 0 delta, 1 refine, 2 key
    flags: reqFlags,
    allow444: (reqFlags & 1) !== 0,
    allowVideo: (reqFlags & 2) !== 0,
    allowAv1: (reqFlags & 4) !== 0,
    waitMs: b.readUInt16LE(16),
    videoKbps: Math.max(300, b.readUInt16LE(18) * 100),
    videoMaxWidth: Math.max(320, b.readUInt16LE(20) || 1920),
    fps: Math.max(5, Math.min(60, b.readUInt16LE(22) || 30))
  };
}

function buildStreamRequest(r) {
  const req = Buffer.alloc(REQ_SIZE);
  req.writeUInt32LE(STREAM_REQ_MAGIC, 0);
  req.writeInt32LE(r.monitorIndex || 0, 4);
  req.writeUInt16LE(r.maxCanvasWidth || 1920, 8);
  req.writeUInt16LE(r.motionScale || 1000, 10);
  req[12] = r.motionQuality || 70;
  req[13] = r.refineQuality || 90;
  req[14] = r.mode || 0;
  req[15] = r.flags || 0;
  req.writeUInt16LE(r.waitMs || 0, 16);
  req.writeUInt16LE(r.videoBitrate100 || 50, 18);
  req.writeUInt16LE(r.videoMaxWidth || 1920, 20);
  req.writeUInt16LE(r.fps || 30, 22);
  return req;
}

const u16 = (v) => Math.max(0, Math.min(65535, Math.round(Number(v) || 0)));

// f: { frameId, flags, canvasW, canvasH, srcW, srcH, cursorX, cursorY (0..65535), workMs,
//      video?: { width, height, data }, rects?: [{ x, y, w, h, data }] }
function buildFrame(f) {
  const rects = f.rects || [];
  let size = FRAME_HEADER_SIZE;
  if (f.video) size += 8 + f.video.data.length;
  for (const r of rects) size += 12 + (r.data ? r.data.length : 0);
  const b = Buffer.alloc(size);
  let flags = f.flags || 0;
  if (f.video) flags |= FLAGS.VIDEO;
  if (rects.length === 0) flags |= FLAGS.IDLE;
  b.writeUInt32LE(STREAM_FRAME_MAGIC, 0);
  b.writeUInt32LE(f.frameId >>> 0, 4);
  b.writeUInt16LE(flags & 0xffff, 8);
  b.writeUInt16LE(rects.length, 10);
  b.writeUInt16LE(u16(f.canvasW), 12);
  b.writeUInt16LE(u16(f.canvasH), 14);
  b.writeUInt16LE(u16(f.srcW), 16);
  b.writeUInt16LE(u16(f.srcH), 18);
  b.writeUInt16LE(u16(f.cursorX), 20);
  b.writeUInt16LE(u16(f.cursorY), 22);
  b.writeUInt16LE(u16(f.workMs), 24);
  b.writeUInt16LE(0, 26);
  let off = FRAME_HEADER_SIZE;
  if (f.video) {
    b.writeUInt16LE(u16(f.video.width), off);
    b.writeUInt16LE(u16(f.video.height), off + 2);
    b.writeUInt32LE(f.video.data.length, off + 4);
    f.video.data.copy(b, off + 8);
    off += 8 + f.video.data.length;
  }
  for (const r of rects) {
    const data = r.data || Buffer.alloc(0);
    b.writeUInt16LE(u16(r.x), off);
    b.writeUInt16LE(u16(r.y), off + 2);
    b.writeUInt16LE(u16(r.w), off + 4);
    b.writeUInt16LE(u16(r.h), off + 6);
    b.writeUInt32LE(data.length, off + 8);
    data.copy(b, off + 12);
    off += 12 + data.length;
  }
  return b;
}

// Same as measureStreamFrame() in server.js: byte length of the first complete frame, -1 if incomplete
function measureFrame(buf) {
  if (buf.length < FRAME_HEADER_SIZE) return -1;
  if (buf.readUInt32LE(0) !== STREAM_FRAME_MAGIC) throw new Error('stream desync');
  const flags = buf.readUInt16LE(8);
  const rectCount = buf.readUInt16LE(10);
  let off = FRAME_HEADER_SIZE;
  if (flags & FLAGS.CURSOR_SHAPE) {
    if (buf.length < off + 12) return -1;
    off += 12 + buf.readUInt32LE(off + 8);
  }
  if (flags & FLAGS.VIDEO) {
    if (buf.length < off + 8) return -1;
    off += 8 + buf.readUInt32LE(off + 4);
  }
  for (let i = 0; i < rectCount; i++) {
    if (buf.length < off + 12) return -1;
    off += 12 + buf.readUInt32LE(off + 8);
  }
  return buf.length >= off ? off : -1;
}

// Parses one frame (tests / e2e)
function parseFrame(buf) {
  const flags = buf.readUInt16LE(8);
  const rectCount = buf.readUInt16LE(10);
  const f = {
    frameId: buf.readUInt32LE(4),
    flags,
    rectCount,
    canvasW: buf.readUInt16LE(12),
    canvasH: buf.readUInt16LE(14),
    srcW: buf.readUInt16LE(16),
    srcH: buf.readUInt16LE(18),
    cursorX: buf.readUInt16LE(20),
    cursorY: buf.readUInt16LE(22),
    video: null,
    rects: []
  };
  let off = FRAME_HEADER_SIZE;
  if (flags & FLAGS.CURSOR_SHAPE) off += 12 + buf.readUInt32LE(off + 8);
  if (flags & FLAGS.VIDEO) {
    const len = buf.readUInt32LE(off + 4);
    f.video = { width: buf.readUInt16LE(off), height: buf.readUInt16LE(off + 2), data: buf.subarray(off + 8, off + 8 + len) };
    off += 8 + len;
  }
  for (let i = 0; i < rectCount; i++) {
    const len = buf.readUInt32LE(off + 8);
    f.rects.push({
      x: buf.readUInt16LE(off),
      y: buf.readUInt16LE(off + 2),
      w: buf.readUInt16LE(off + 4),
      h: buf.readUInt16LE(off + 6),
      data: buf.subarray(off + 12, off + 12 + len)
    });
    off += 12 + len;
  }
  return f;
}

// ---------------------------------------------------------------------------
// H.264 Annex B -> access units
// ---------------------------------------------------------------------------
// A new access unit starts at an AUD, at SPS/PPS/SEI that follow a picture, or at a slice whose
// first_mb_in_slice is 0 (ue(v) 0 is a single '1' bit, i.e. the top bit of the byte after the header)
// when the current AU already has a slice. x264 --tune zerolatency uses sliced threads, so one picture
// is often several slice NALs and "every VCL NAL is a frame" would be wrong.
class AnnexBSplitter {
  constructor(onAu) {
    this.onAu = onAu;
    this.buf = Buffer.alloc(0);
    this.scanFrom = 0;
    this.nals = [];
    this.hasVcl = false;
    this.hasIdr = false;
  }

  // Offset of the next start code (00 00 01) at or after `from`, including a leading zero of 00 00 00 01
  static findStart(buf, from) {
    for (let i = Math.max(0, from); i + 2 < buf.length; i++) {
      if (buf[i + 2] > 1) {
        i += 2;
        continue;
      }
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
        return i > 0 && buf[i - 1] === 0 ? { pos: i - 1, len: 4 } : { pos: i, len: 3 };
      }
    }
    return null;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    // The first start code is the beginning of the NAL in progress; each following one completes a NAL
    const first = AnnexBSplitter.findStart(this.buf, 0);
    if (!first) return;
    if (first.pos > 0) this.buf = this.buf.subarray(first.pos); // garbage before the first start code
    let cur = AnnexBSplitter.findStart(this.buf, 0);
    let next = AnnexBSplitter.findStart(this.buf, Math.max(cur.len, this.scanFrom));
    while (next) {
      this._nal(this.buf.subarray(cur.pos, next.pos), cur.len);
      cur = next;
      next = AnnexBSplitter.findStart(this.buf, cur.pos + cur.len);
    }
    this.buf = this.buf.subarray(cur.pos);
    this.scanFrom = Math.max(cur.len, this.buf.length - 3);
    // The NAL in progress already tells whether a new picture started: emit the finished AU right away
    // instead of waiting for the end of that NAL (saves one frame of latency)
    if (this.hasVcl && this._startsNewAu(this.buf, cur.len)) this._emit();
  }

  _startsNewAu(nal, scLen) {
    if (nal.length <= scLen) return false;
    const type = nal[scLen] & 0x1f;
    if (type === 9 || type === 6 || type === 7 || type === 8 || (type >= 14 && type <= 18)) return true;
    if (type >= 1 && type <= 5) return nal.length > scLen + 1 && (nal[scLen + 1] & 0x80) !== 0;
    return false;
  }

  _nal(nal, scLen) {
    if (nal.length <= scLen) return;
    const type = nal[scLen] & 0x1f;
    const isVcl = type >= 1 && type <= 5;
    if (this.hasVcl && this._startsNewAu(nal, scLen)) this._emit();
    this.nals.push(Buffer.from(nal));
    if (isVcl) this.hasVcl = true;
    if (type === 5) this.hasIdr = true;
  }

  _emit() {
    if (this.nals.length && this.hasVcl) {
      this.onAu({ data: Buffer.concat(this.nals), isKey: this.hasIdr });
      this.nals = [];
      this.hasVcl = false;
      this.hasIdr = false;
    }
    // without a slice yet, leading AUD / parameter sets stay with the picture that follows
  }

  // Treat the buffered tail as a complete NAL and emit the AU (stream end, or the producer went quiet:
  // ffmpeg writes one packet per frame with -flush_packets 1, so a quiet pipe means the AU is complete)
  flush() {
    if (this.buf.length) {
      const st = AnnexBSplitter.findStart(this.buf, 0);
      if (st) this._nal(this.buf.subarray(st.pos), st.len);
      this.buf = Buffer.alloc(0);
      this.scanFrom = 0;
    }
    this._emit();
  }
}

module.exports = {
  createRpcDispatcher,
  ipcKeyMatches,
  gateSocket,
  attachInputLineProtocol,
  STREAM_REQ_MAGIC,
  STREAM_FRAME_MAGIC,
  REQ_SIZE,
  FRAME_HEADER_SIZE,
  FLAGS,
  parseStreamRequest,
  buildStreamRequest,
  buildFrame,
  measureFrame,
  parseFrame,
  AnnexBSplitter
};
