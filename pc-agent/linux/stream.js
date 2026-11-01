'use strict';
// Remote desktop for Linux (X11 & Wayland): the TBR3/TBF2 stream port (wire format: native/ScreenStreamer.cs)
// fed by an ffmpeg x11grab / wf-recorder -> H.264 pipeline, a JPEG fallback (grim / spectacle / gnome-screenshot /
// ffmpeg x11grab), and capture_screen.

const net = require('net');
const crypto = require('crypto');
const path = require('path').posix;
const { gateSocket, parseStreamRequest, buildFrame, AnnexBSplitter, FLAGS, REQ_SIZE } = require('./protocol');
const { getSession, clamp, missingToolMessage } = require('./util');

const MAX_QUEUE = 6;

// Canvas = monitor scaled to maxCanvasWidth, video = canvas scaled to videoMaxWidth (even sizes for 4:2:0)
function computeGeometry(mon, req) {
  const cs = mon.width > req.maxCanvasWidth ? req.maxCanvasWidth / mon.width : 1;
  const canvasW = Math.max(16, Math.round(mon.width * cs)) & ~1;
  const canvasH = Math.max(16, Math.round(mon.height * cs)) & ~1;
  const vs = canvasW > req.videoMaxWidth ? req.videoMaxWidth / canvasW : 1;
  return {
    canvasW,
    canvasH,
    videoW: Math.max(64, Math.round(canvasW * vs)) & ~1,
    videoH: Math.max(64, Math.round(canvasH * vs)) & ~1
  };
}

function x11Input(display, mon) {
  return ['-f', 'x11grab', '-draw_mouse', '1', '-video_size', `${mon.width & ~1}x${mon.height & ~1}`];
}

// ffmpeg argv for the live H.264 stream (Annex B on stdout, SPS/PPS repeated before every IDR)
function buildVideoArgs(cfg) {
  const { display, mon, fps, kbps, videoW, videoH, vaapi } = cfg;
  const grab = [...x11Input(display, mon), '-framerate', String(fps), '-i', `${display}+${mon.x},${mon.y}`];
  const gop = String(Math.max(2, fps * 2));
  const rate = ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${Math.max(100, Math.round((kbps * 2) / fps) * 2)}k`];
  const head = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-fflags', 'nobuffer'];
  const tail = ['-flush_packets', '1', '-f', 'h264', 'pipe:1'];
  if (vaapi) {
    return [
      ...head,
      '-vaapi_device',
      '/dev/dri/renderD128',
      ...grab,
      '-vf',
      `scale=${videoW}:${videoH},format=nv12,hwupload`,
      '-c:v',
      'h264_vaapi',
      '-bf',
      '0',
      '-g',
      gop,
      ...rate,
      '-aud',
      '1',
      ...tail
    ];
  }
  const scale = videoW !== (mon.width & ~1) || videoH !== (mon.height & ~1) ? ['-vf', `scale=${videoW}:${videoH}:flags=fast_bilinear`] : [];
  return [
    ...head,
    ...grab,
    ...scale,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-bf',
    '0',
    '-g',
    gop,
    '-pix_fmt',
    'yuv420p',
    ...rate,
    '-x264-params',
    'repeat-headers=1',
    ...tail
  ];
}

// wf-recorder argv for native Wayland live H.264 streaming (Sway, Hyprland, wlroots)
function buildWfRecorderArgs(cfg) {
  const { mon, fps, videoW, videoH, vaapi } = cfg;
  const args = [];
  if (mon.deviceName && mon.deviceName !== 'ALL_MONITORS' && mon.deviceName !== 'default') {
    args.push('-o', mon.deviceName);
  } else {
    args.push('-g', `${mon.x},${mon.y} ${mon.width}x${mon.height}`);
  }
  args.push('-r', String(fps), '-m', 'h264', '--file=pipe:1');
  if (vaapi) {
    args.push('-c', 'h264_vaapi', '-d', '/dev/dri/renderD128', '-F', `scale_vaapi=w=${videoW}:h=${videoH}:format=nv12`);
  } else {
    args.push('-c', 'libx264', '-p', 'preset=ultrafast', '-p', 'tune=zerolatency', '-x', 'yuv420p');
    if (videoW !== (mon.width & ~1) || videoH !== (mon.height & ~1)) {
      args.push('-F', `scale=${videoW}:${videoH}:flags=fast_bilinear`);
    }
  }
  return args;
}

// Quality 0..100 -> mjpeg qscale 31..2
function jpegQscale(quality) {
  return String(clamp(Math.round(2 + ((100 - clamp(quality, 0, 100)) * 29) / 100), 2, 31));
}

function buildJpegArgs(display, mon, outW, outH, quality, drawMouse = true) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-f',
    'x11grab',
    '-draw_mouse',
    drawMouse ? '1' : '0',
    '-video_size',
    `${mon.width}x${mon.height}`,
    '-i',
    `${display}+${mon.x},${mon.y}`,
    '-frames:v',
    '1',
    '-vf',
    `scale=${outW}:${outH}`,
    '-pix_fmt',
    'yuvj420p',
    '-q:v',
    jpegQscale(quality),
    '-f',
    'mjpeg',
    'pipe:1'
  ];
}

async function scaleImageBufferWithFfmpeg(sys, inputBuf, outW, outH, quality) {
  if (!sys.has('ffmpeg')) return inputBuf;
  const r = await sys
    .exec(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-frames:v',
        '1',
        '-vf',
        `scale=${outW}:${outH}`,
        '-pix_fmt',
        'yuvj420p',
        '-q:v',
        jpegQscale(quality),
        '-f',
        'mjpeg',
        'pipe:1'
      ],
      { input: inputBuf, timeout: 5000 }
    )
    .catch(() => null);
  if (r && r.code === 0 && r.stdoutBuf.length >= 4 && r.stdoutBuf[0] === 0xff && r.stdoutBuf[1] === 0xd8) {
    return r.stdoutBuf;
  }
  return inputBuf;
}

async function grabWaylandJpeg(sys, mon, outW, outH, quality, drawMouse = true) {
  const q = clamp(Math.round(Number(quality) || 80), 10, 100);
  // 1. grim (Sway, Hyprland, wlroots, Cosmic, River, Wayfire, Labwc)
  if (sys.has('grim')) {
    const gArgs = [
      ...(drawMouse ? ['-c'] : []),
      '-t',
      'jpeg',
      '-q',
      String(q),
      '-g',
      `${mon.x},${mon.y} ${mon.width}x${mon.height}`,
      '-'
    ];
    const r = await sys.exec('grim', gArgs, { timeout: 5000 }).catch(() => null);
    if (r && r.code === 0 && r.stdoutBuf.length >= 4 && r.stdoutBuf[0] === 0xff && r.stdoutBuf[1] === 0xd8) {
      if (outW === mon.width && outH === mon.height) return r.stdoutBuf;
      return scaleImageBufferWithFfmpeg(sys, r.stdoutBuf, outW, outH, q);
    }
  }
  // 2. KDE Plasma Wayland (spectacle) + GNOME Wayland (gnome-screenshot)
  const tmpFile = path.join(sys.env.XDG_RUNTIME_DIR || '/tmp', `bridge-cap-${process.pid}.jpg`);
  if (sys.has('spectacle')) {
    const r = await sys.exec('spectacle', ['-b', '-n', ...(drawMouse ? ['-p'] : []), '-o', tmpFile], { timeout: 5000 }).catch(() => null);
    if (r && r.code === 0) {
      try {
        const raw = sys.fs.readFileSync(tmpFile);
        try { sys.fs.unlinkSync(tmpFile); } catch {}
        if (raw && raw.length > 4) return scaleImageBufferWithFfmpeg(sys, raw, outW, outH, q);
      } catch {}
    }
  }
  if (sys.has('gnome-screenshot')) {
    const r = await sys.exec('gnome-screenshot', [...(drawMouse ? ['-p'] : []), '-f', tmpFile], { timeout: 5000 }).catch(() => null);
    if (r && r.code === 0) {
      try {
        const raw = sys.fs.readFileSync(tmpFile);
        try { sys.fs.unlinkSync(tmpFile); } catch {}
        if (raw && raw.length > 4) return scaleImageBufferWithFfmpeg(sys, raw, outW, outH, q);
      } catch {}
    }
  }
  return null;
}

async function grabJpeg(sys, mon, outW, outH, quality, drawMouse) {
  const sess = getSession(sys);
  if (sess.isWayland && (sys.has('grim') || sys.has('spectacle') || sys.has('gnome-screenshot'))) {
    const wlBuf = await grabWaylandJpeg(sys, mon, outW, outH, quality, drawMouse);
    if (wlBuf) return wlBuf;
  }
  if (!sys.has('ffmpeg')) throw new Error(missingToolMessage('ffmpeg'));
  const r = await sys.exec('ffmpeg', buildJpegArgs(sys.display, mon, outW, outH, quality, drawMouse), { timeout: 6000 });
  if (r.code !== 0 || r.stdoutBuf.length < 4 || r.stdoutBuf[0] !== 0xff || r.stdoutBuf[1] !== 0xd8) {
    if (sess.isWayland) {
      const wlBuf = await grabWaylandJpeg(sys, mon, outW, outH, quality, drawMouse);
      if (wlBuf) return wlBuf;
    }
    throw new Error('Ekran yakalanamadı (ffmpeg x11grab): ' + (r.stderr || '').trim().split('\n').pop());
  }
  return r.stdoutBuf;
}

// capture_screen command
async function captureScreen(sys, getMonitorBounds, getCursor, args) {
  const monitorIndex = typeof args.monitorIndex === 'number' ? args.monitorIndex : 0;
  const maxWidth = Number(args.maxWidth) || 1920;
  const quality = Number(args.quality) || 80;
  const mon = await getMonitorBounds(monitorIndex);
  const srcW = Math.max(1, mon.width);
  const srcH = Math.max(1, mon.height);
  const scale = srcW > maxWidth ? maxWidth / srcW : 1;
  const dstW = Math.max(2, Math.round(srcW * scale)) & ~1;
  const dstH = Math.max(2, Math.round(srcH * scale)) & ~1;
  const [jpeg, cur] = await Promise.all([grabJpeg(sys, mon, dstW, dstH, quality, args.drawCursor !== false), getCursor().catch(() => null)]);
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return {
    monitorIndex,
    width: dstW,
    height: dstH,
    sourceWidth: srcW,
    sourceHeight: srcH,
    cursorNormX: cur ? r4(clamp((cur.x - mon.x) / srcW, 0, 1)) : 0.5,
    cursorNormY: cur ? r4(clamp((cur.y - mon.y) / srcH, 0, 1)) : 0.5,
    jpeg: jpeg.toString('base64')
  };
}

// ---------------------------------------------------------------------------
// One phone stream = one session = (at most) one video encoder
// ---------------------------------------------------------------------------
class StreamSession {
  constructor(sys, deps) {
    this.sys = sys;
    this.deps = deps; // { getMonitorBounds(idx), getCursor() }
    this.frameId = 0;
    this.closed = false;
    this.enc = null; // { proc, key, kbps, startedAt, vaapi, bin }
    this.queue = [];
    this.waiter = null;
    this.awaitIdr = false;
    this.lastIdrTs = 0;
    this.vaapiFailed = !sys.fs.existsSync('/dev/dri/renderD128') || sys.env.TAHABLT_NO_VAAPI === '1';
    this.wfRecorderFailed = false;
    this.videoCaptureFailed = false;
    this.restartTimes = [];
    this.lastJpegHash = '';
    this.cursor = null;
    this.cursorTimer = null;
    this.failed = null;
  }

  // Cursor position for the frame header (the phone's touchpad mode starts from it)
  _startCursorPoll() {
    if (this.cursorTimer) return;
    const poll = () => {
      this.deps
        .getCursor()
        .then((c) => {
          if (c) this.cursor = c;
        })
        .catch(() => {});
    };
    poll();
    this.cursorTimer = setInterval(poll, 150);
    if (this.cursorTimer.unref) this.cursorTimer.unref();
  }

  _cursorNorm(mon) {
    const c = this.cursor;
    if (!c) return { cx: 32768, cy: 32768 };
    return {
      cx: Math.round(clamp((c.x - mon.x) / Math.max(1, mon.width), 0, 1) * 65535),
      cy: Math.round(clamp((c.y - mon.y) / Math.max(1, mon.height), 0, 1) * 65535)
    };
  }

  _hasWaylandStillTool() {
    const sess = getSession(this.sys);
    return sess.isWayland && (this.sys.has('grim') || this.sys.has('spectacle') || this.sys.has('gnome-screenshot'));
  }

  async handle(req) {
    if (this.failed) throw this.failed;
    this._startCursorPoll();
    const t0 = this.sys.now();
    const mon = await this.deps.getMonitorBounds(req.monitorIndex);
    const g = computeGeometry(mon, req);
    if (!req.allowVideo || this.videoCaptureFailed) return this._jpegFrame(req, mon, g, t0);

    this._ensureEncoder(req, mon, g);
    if (req.mode === 2 || this.queue.length > MAX_QUEUE) this._dropUntilIdr();
    const wait = req.mode === 2 ? Math.max(req.waitMs, 1500) : Math.min(req.waitMs, 2000);
    const au = await this._nextAu(wait);
    if (this.videoCaptureFailed) return this._jpegFrame(req, mon, g, t0);
    const { cx, cy } = this._cursorNorm(mon);
    const base = { canvasW: g.videoW, canvasH: g.videoH, srcW: mon.width, srcH: mon.height, cursorX: cx, cursorY: cy, workMs: this.sys.now() - t0 };
    if (!au) return buildFrame({ ...base, frameId: ++this.frameId, flags: FLAGS.IDLE, rects: [] });
    return buildFrame({
      ...base,
      frameId: ++this.frameId,
      flags: au.isKey ? FLAGS.KEY | FLAGS.VIDEO_KEY : 0,
      video: { width: g.videoW, height: g.videoH, data: au.data },
      rects: [{ x: 0, y: 0, w: g.videoW, h: g.videoH, data: null }]
    });
  }

  _ensureEncoder(req, mon, g) {
    const sess = getSession(this.sys);
    const canWf = sess.isWayland && this.sys.has('wf-recorder') && !this.wfRecorderFailed;
    if (!canWf && !this.sys.has('ffmpeg')) {
      if (this._hasWaylandStillTool()) {
        this.videoCaptureFailed = true;
        return;
      }
      this.failed = new Error(missingToolMessage('ffmpeg'));
      throw this.failed;
    }
    const key = `${mon.x},${mon.y},${mon.width},${mon.height},${g.videoW},${g.videoH},${req.fps}`;
    const e = this.enc;
    if (e && e.key === key) {
      // Bitrate follows the latency controller every few seconds: restart only on a real change
      const change = Math.abs(req.videoKbps - e.kbps) / e.kbps;
      if (change < 0.25 || this.sys.now() - e.startedAt < 3000) return;
    }
    this._startEncoder({ key, mon, fps: req.fps, kbps: req.videoKbps, videoW: g.videoW, videoH: g.videoH });
  }

  _startEncoder(cfg) {
    this._stopEncoder();
    const sess = getSession(this.sys);
    const useWf = sess.isWayland && this.sys.has('wf-recorder') && !this.wfRecorderFailed;
    const vaapi = !this.vaapiFailed;
    const bin = useWf ? 'wf-recorder' : 'ffmpeg';
    const args = useWf ? buildWfRecorderArgs({ ...cfg, vaapi }) : buildVideoArgs({ display: this.sys.display, ...cfg, vaapi });
    const proc = this.sys.spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const enc = { proc, bin, useWf, key: cfg.key, kbps: cfg.kbps, startedAt: this.sys.now(), vaapi, cfg, gotAu: false, stderr: '' };
    this.enc = enc;
    this.queue = [];
    this.awaitIdr = true; // a fresh encoder starts with an IDR; anything else is useless to the decoder
    let flushTimer = null;
    const splitter = new AnnexBSplitter((au) => this._onAu(enc, au));
    proc.stdout.on('data', (chunk) => {
      splitter.push(chunk);
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => splitter.flush(), 4);
    });
    proc.stderr.on('data', (d) => {
      enc.stderr = (enc.stderr + d.toString()).slice(-2000);
    });
    proc.on('error', () => {});
    proc.on('exit', (code) => {
      if (flushTimer) clearTimeout(flushTimer);
      if (this.enc !== enc || this.closed) return;
      this.enc = null;
      const msg = enc.stderr.trim().split('\n').pop() || `kod ${code}`;
      if (enc.vaapi && !enc.gotAu) {
        this.vaapiFailed = true; // no usable VA-API encoder: libx264 for the rest of the session
        this.sys.log('h264_vaapi kullanılamadı, libx264 kullanılıyor:', msg);
      } else if (enc.useWf && !enc.gotAu) {
        this.wfRecorderFailed = true;
        this.sys.log('wf-recorder kullanılamadı, alternatif yakalamaya geçiliyor:', msg);
      } else {
        this.sys.log(`${enc.bin} durdu:`, msg);
      }
      const now = this.sys.now();
      this.restartTimes = this.restartTimes.filter((t) => now - t < 10000);
      this.restartTimes.push(now);
      if (this.restartTimes.length > 5) {
        if (this._hasWaylandStillTool()) {
          this.videoCaptureFailed = true;
          if (this.waiter) this.waiter(null);
          return;
        }
        this.failed = new Error('ffmpeg tekrar tekrar kapandı: ' + msg);
        if (this.waiter) this.waiter(null);
        return;
      }
      setTimeout(() => {
        if (!this.closed && !this.enc && !this.videoCaptureFailed) this._startEncoder(enc.cfg);
      }, (enc.vaapi || enc.useWf) && !enc.gotAu ? 0 : 400);
    });
  }

  _stopEncoder() {
    if (!this.enc) return;
    const p = this.enc.proc;
    this.enc = null;
    try {
      p.kill('SIGKILL');
    } catch {}
  }

  _onAu(enc, au) {
    if (this.enc !== enc) return;
    enc.gotAu = true;
    if (au.isKey) this.lastIdrTs = this.sys.now();
    if (this.awaitIdr && !au.isKey) return;
    this.awaitIdr = false;
    this.queue.push(au);
    if (this.queue.length > 120) this.queue.splice(0, this.queue.length - 120); // phone gone quiet
    if (this.waiter) this.waiter(true);
  }

  // Key request or backlog: skip to the newest IDR; without one, discard deltas until the next IDR
  _dropUntilIdr() {
    let idx = -1;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].isKey) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      this.queue.splice(0, idx);
      return;
    }
    this.queue = [];
    this.awaitIdr = true;
    // The GOP is 2 s: when the last IDR is old, restart the encoder for an immediate one (rate-limited)
    const e = this.enc;
    const now = this.sys.now();
    if (e && e.gotAu && now - this.lastIdrTs > 1000 && now - e.startedAt > 1500) this._startEncoder(e.cfg);
  }

  _nextAu(waitMs) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (waitMs <= 0 || this.failed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiter = null;
        resolve(this.queue.length ? this.queue.shift() : null);
      };
      const timer = setTimeout(done, waitMs);
      this.waiter = done;
    });
  }

  // JPEG fallback: one full-canvas JPEG per changed screen
  async _jpegFrame(req, mon, g, t0) {
    this._stopEncoder();
    const scale = req.motionScale > 0 && req.motionScale < 1000 && req.mode !== 1 ? req.motionScale / 1000 : 1;
    const w = Math.max(16, Math.round(g.canvasW * scale)) & ~1;
    const h = Math.max(16, Math.round(g.canvasH * scale)) & ~1;
    const quality = req.mode === 1 ? req.refineQuality : req.motionQuality;
    const jpeg = await grabJpeg(this.sys, mon, w, h, quality || 70, true);
    const hash = crypto.createHash('md5').update(jpeg).digest('hex');
    const { cx, cy } = this._cursorNorm(mon);
    const base = { canvasW: w, canvasH: h, srcW: mon.width, srcH: mon.height, cursorX: cx, cursorY: cy };
    if (hash === this.lastJpegHash && req.mode !== 2) {
      // Unchanged: hold the request like the change-driven Windows capture does, then report idle
      if (req.waitMs > 0) await new Promise((r) => setTimeout(r, Math.min(req.waitMs, 1000)));
      return buildFrame({ ...base, frameId: ++this.frameId, flags: FLAGS.IDLE, workMs: this.sys.now() - t0, rects: [] });
    }
    this.lastJpegHash = hash;
    return buildFrame({ ...base, frameId: ++this.frameId, flags: FLAGS.KEY, workMs: this.sys.now() - t0, rects: [{ x: 0, y: 0, w, h, data: jpeg }] });
  }

  close() {
    this.closed = true;
    if (this.cursorTimer) clearInterval(this.cursorTimer);
    this._stopEncoder();
    if (this.waiter) this.waiter(null);
  }
}

// TCP server on 127.0.0.1:<port>; each connection: IPC key line, then 24-byte requests answered in order
function startStreamServer(sys, { port, key, deps, onListening }) {
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    gateSocket(sock, key, (rest) => {
      const session = new StreamSession(sys, deps);
      let buf = rest && rest.length ? Buffer.from(rest) : Buffer.alloc(0);
      let busy = false;
      const pump = async () => {
        if (busy) return;
        busy = true;
        try {
          while (buf.length >= REQ_SIZE && !sock.destroyed) {
            const raw = buf.subarray(0, REQ_SIZE);
            buf = buf.subarray(REQ_SIZE);
            let req;
            try {
              req = parseStreamRequest(raw);
            } catch {
              sock.destroy(); // desync: not our protocol
              return;
            }
            let frame;
            try {
              frame = await session.handle(req);
            } catch (e) {
              sys.log('stream:', e.message);
              sock.destroy(); // server.js tells the phone "stream_ended"
              return;
            }
            if (!sock.destroyed) sock.write(frame);
          }
        } finally {
          busy = false;
        }
      };
      sock.on('data', (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        pump();
      });
      sock.on('close', () => session.close());
      pump();
    });
    sock.on('error', () => {});
  });
  server.on('error', (e) => sys.log(`stream portu (${port}) açılamadı: ${e.message}`));
  server.listen(port, '127.0.0.1', onListening);
  return server;
}

module.exports = {
  computeGeometry,
  buildVideoArgs,
  buildWfRecorderArgs,
  buildJpegArgs,
  jpegQscale,
  grabJpeg,
  captureScreen,
  StreamSession,
  startStreamServer
};
