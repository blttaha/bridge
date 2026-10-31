#!/usr/bin/env node
'use strict';
// End-to-end test of the Linux agent inside a virtual X server (see .github/workflows/linux-sandbox.yml).
// Starts the real server.js (which spawns linux/bridge.js), talks to it like the phone does over
// WebSocket / HTTP, and checks the effects with xdotool / ffprobe. Power actions run in dry-run mode.
//
// Needs: DISPLAY with a window manager, xdotool, wmctrl, xrandr, ffmpeg/ffprobe, `npm ci` in pc-agent,
// and permission to bind UDP port 9 on 127.0.0.1 (ip_unprivileged_port_start=0 or root) for Wake-on-LAN.

const assert = require('assert');
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const proto = require('../../pc-agent/linux/protocol');

const ROOT = path.resolve(__dirname, '..', '..');
const AGENT = path.join(ROOT, 'pc-agent');
const WebSocket = require(path.join(AGENT, 'node_modules', 'ws'));

const PORT = 4950;
const TOKEN = crypto.randomBytes(32).toString('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-e2e-'));
const DATA_DIR = path.join(TMP, 'data');
const POWER_LOG = path.join(TMP, 'power.log');
const SERVER_LOG = path.join(TMP, 'server.log');
const AU_FILE = path.join(TMP, 'stream.h264');
const WOL_PORT = 9; // server.js sendWakeOnLan(): UDP 9 to the given broadcast address (+ UDP 7 to 255.255.255.255)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, note: note || '' });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, note: (e && e.message) || String(e) });
  }
}

function xdotoolLocation() {
  const out = execFileSync('xdotool', ['getmouselocation'], { encoding: 'utf8' });
  const m = /x:(-?\d+)\s+y:(-?\d+)/.exec(out);
  return { x: Number(m[1]), y: Number(m[2]) };
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = net.createConnection({ host: '127.0.0.1', port });
      s.on('connect', () => {
        s.destroy();
        resolve();
      });
      s.on('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} did not open`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
class PhoneClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.onBinary = null;
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        if (this.onBinary) this.onBinary(raw);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const p = msg.id !== undefined ? this.pending.get(msg.id) : null;
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    });
  }

  static connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      ws.once('open', () => resolve(new PhoneClient(ws)));
      ws.once('error', reject);
    });
  }

  // Resolves with { ok, data, error }
  raw(action, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${action}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.ws.send(JSON.stringify({ id, action, params }));
    });
  }

  async call(action, params, timeoutMs) {
    const r = await this.raw(action, params, timeoutMs);
    if (!r.ok) throw new Error(`${action}: ${r.error}`);
    return r.data;
  }
}

// /api/command forwards unknown actions straight to the bridge (bridge.call(action, params))
function apiCommand(action, params = {}) {
  const body = JSON.stringify({ authToken: TOKEN, action, params });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/api/command', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          try {
            const j = JSON.parse(text);
            if (!j.ok) return reject(new Error(`${action}: ${j.error}`));
            resolve(j.data);
          } catch (e) {
            reject(new Error(`${action}: HTTP ${res.statusCode} ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('HTTP timeout ' + action)));
    req.end(body);
  });
}

function readPowerLog() {
  try {
    return fs
      .readFileSync(POWER_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function expectPowerCommand(phone, params, expected) {
  const before = readPowerLog().length;
  await phone.call('system_control', params);
  for (let i = 0; i < 20 && readPowerLog().length === before; i++) await sleep(100);
  const added = readPowerLog().slice(before).map((l) => l.command);
  assert.deepStrictEqual(added, [expected], `${JSON.stringify(params)} logged ${JSON.stringify(added)}`);
  return expected;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, 'config.json'),
    JSON.stringify({ deviceId: 'ci-device', deviceName: 'ci', authToken: TOKEN, port: PORT, createdAt: new Date().toISOString(), pairedTokens: [TOKEN] }, null, 2)
  );
  fs.mkdirSync(path.join(TMP, 'browse'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'browse', 'hello.txt'), 'merhaba');

  const logFd = fs.openSync(SERVER_LOG, 'w');
  const server = spawn(process.execPath, [path.join(AGENT, 'server.js')], {
    cwd: AGENT,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      TAHABLT_DATA_DIR: DATA_DIR,
      TAHABLT_PORT: String(PORT),
      TAHABLT_STREAM_PORT: '4952',
      TAHABLT_INPUT_PORT: '4953',
      TAHABLT_POWER_DRYRUN: '1',
      TAHABLT_POWER_LOG: POWER_LOG,
      TAHABLT_NO_TUNNEL: '1'
    }
  });
  let serverExited = null;
  server.on('exit', (code, sig) => (serverExited = `server exited (${code !== null ? code : sig})`));

  let phone = null;
  try {
    await waitForPort(PORT, 30000);
    await waitForPort(4952, 15000); // bridge stream port = bridge is up
    phone = await PhoneClient.connect();

    await check('auth (pre-seeded token)', async () => {
      const d = await phone.call('auth', { authToken: TOKEN });
      assert.strictEqual(d.device.deviceId, 'ci-device');
      assert.ok(Array.isArray(d.monitors) && d.monitors.length >= 1, 'monitors in auth reply');
      assert.strictEqual(typeof d.stats.cpuPercent, 'number');
      return `${d.monitors.length} monitor(s)`;
    });

    await check('ping (WebSocket + bridge)', async () => {
      await phone.call('ping');
      const p = await apiCommand('ping');
      assert.strictEqual(p.pong, true);
    });

    await check('get_monitors', async () => {
      const m = await apiCommand('get_monitors');
      assert.ok(m.length >= 1);
      assert.deepStrictEqual([m[0].width, m[0].height, m[0].isPrimary, m[0].id], [1920, 1080, true, 'MON_1']);
      for (const k of ['workX', 'workY', 'workWidth', 'workHeight', 'brightness', 'isBlackedOut', 'deviceName', 'friendlyName']) assert.ok(k in m[0], k);
      return `${m[0].deviceName} ${m[0].width}x${m[0].height}`;
    });

    await check('get_windows', async () => {
      const w = await apiCommand('get_windows');
      assert.ok(Array.isArray(w));
      if (process.env.E2E_EXPECT_WINDOW === '1') assert.ok(w.length >= 1, 'expected the test pattern window');
      if (w[0]) for (const k of ['hwnd', 'title', 'processName', 'pid', 'monitorIndex', 'state', 'rect', 'normalized', 'zonePreset']) assert.ok(k in w[0], k);
      return w.map((x) => x.processName).join(', ');
    });

    await check('get_full_state', async () => {
      const s = await phone.call('get_full_state', {}, 20000);
      assert.ok(Array.isArray(s.monitors) && s.monitors.length >= 1);
      assert.ok(Array.isArray(s.windows));
      assert.ok(Array.isArray(s.installed));
      assert.strictEqual(typeof s.audio.masterVolume, 'number');
      assert.strictEqual(typeof s.stats.memoryPercent, 'number');
    });

    await check('get_installed_apps', async () => {
      const d = await phone.call('get_installed_apps', { force: true }, 20000);
      assert.ok(Array.isArray(d.installed));
      if (d.installed[0]) for (const k of ['name', 'processName', 'launchPath']) assert.ok(k in d.installed[0], k);
      return `${d.installed.length} apps`;
    });

    await check('audio_control get', async () => {
      const a = await phone.call('audio_control', { action: 'get' });
      for (const k of ['masterVolume', 'masterMuted', 'sessions', 'nowPlaying']) assert.ok(k in a, k);
      for (const k of ['active', 'isPlaying', 'title', 'appName', 'positionSec', 'durationSec']) assert.ok(k in a.nowPlaying, 'nowPlaying.' + k);
      return a.warning ? `warning: ${a.warning}` : `volume ${a.masterVolume}%`;
    });

    await check('system_control stats', async () => {
      const s = await phone.call('system_control', { action: 'stats' });
      for (const k of ['isLocked', 'cpuPercent', 'memoryPercent', 'uptimeSeconds', 'totalRamGb']) assert.ok(k in s, k);
      assert.ok(s.totalRamGb > 0);
      return `cpu ${s.cpuPercent}% mem ${s.memoryPercent}%`;
    });

    await check('capture_frame (JPEG)', async () => {
      const f = await phone.call('capture_frame', { monitorIndex: 0, maxWidth: 1280, quality: 70 }, 10000);
      const jpg = Buffer.from(f.jpeg, 'base64');
      assert.deepStrictEqual([jpg[0], jpg[1], jpg[2]], [0xff, 0xd8, 0xff]);
      assert.deepStrictEqual([f.width, f.height, f.sourceWidth, f.sourceHeight], [1280, 720, 1920, 1080]);
      return `${jpg.length} bytes`;
    });

    await check('browse_fs', async () => {
      const d = await phone.call('browse_fs', { path: path.join(TMP, 'browse') });
      assert.strictEqual(d.currentPath, path.join(TMP, 'browse'));
      const e = d.entries.find((x) => x.name === 'hello.txt');
      assert.ok(e, 'hello.txt listed');
      assert.deepStrictEqual([e.isDir, e.sizeBytes, e.ext], [false, 7, 'TXT']);
    });

    await check('send_input mouse_move_abs', async () => {
      await phone.call('send_input', { type: 'mouse_move_abs', x: 0.25, y: 0.5, monitorIndex: 0 });
      await sleep(200);
      const loc = xdotoolLocation();
      assert.ok(Math.abs(loc.x - 480) <= 2 && Math.abs(loc.y - 540) <= 2, `cursor at ${loc.x},${loc.y}`);
      return `${loc.x},${loc.y}`;
    });

    await check('touch tap (input_fast -> 4953)', async () => {
      // the phone sends touches fire-and-forget through the fast input socket
      // (input_fast never replies)
      phone.ws.send(JSON.stringify({ id: 'fast-1', action: 'input_fast', params: { type: 'touch', phase: 'down', id: 0, x: 0.75, y: 0.25, monitorIndex: 0 } }));
      await sleep(60);
      phone.ws.send(JSON.stringify({ id: 'fast-2', action: 'input_fast', params: { type: 'touch', phase: 'up', id: 0, x: 0.75, y: 0.25, monitorIndex: 0 } }));
      await sleep(300);
      const loc = xdotoolLocation();
      assert.ok(Math.abs(loc.x - 1440) <= 2 && Math.abs(loc.y - 270) <= 2, `cursor at ${loc.x},${loc.y}`);
      const r = await phone.call('send_input', { type: 'touch', phase: 'down', id: 0, x: 0.5, y: 0.5, monitorIndex: 0 });
      await phone.call('send_input', { type: 'touch', phase: 'up', id: 0, x: 0.5, y: 0.5, monitorIndex: 0 });
      assert.deepStrictEqual(r, { ok: true, mode: 'mouse' });
    });

    await check('send_input key + text', async () => {
      assert.deepStrictEqual(await phone.call('send_input', { type: 'key', key: 'CTRL+A' }), { ok: true });
      assert.deepStrictEqual(await phone.call('send_input', { type: 'key', key: 'BACKSPACE' }), { ok: true });
      assert.deepStrictEqual(await phone.call('send_input', { type: 'text', text: 'Merhaba CI' }, 10000), { ok: true });
    });

    await check('stream protocol 2 (H.264, 5 s)', async () => {
      const frames = [];
      const aus = [];
      phone.onBinary = (buf) => {
        const f = proto.parseFrame(buf);
        frames.push(f);
        if (f.video) aus.push(Buffer.from(f.video.data));
        // ack like the phone: [0xA1, u32 frameId]
        const ack = Buffer.alloc(5);
        ack[0] = 0xa1;
        ack.writeUInt32LE(f.frameId, 1);
        phone.ws.send(ack);
      };
      const info = await phone.call('start_stream', { protocol: 2, video: true, monitorIndex: 0, maxFps: 60, profile: 'balanced' });
      assert.strictEqual(info.protocol, 2);
      await sleep(5000);
      await phone.call('stop_stream');
      phone.onBinary = null;
      const video = frames.filter((f) => f.flags & 0x80);
      const keys = frames.filter((f) => f.flags & 0x100);
      fs.writeFileSync(AU_FILE, Buffer.concat(aus));
      assert.ok(frames.length >= 100, `only ${frames.length} frames in 5 s`);
      assert.ok(video.length >= 100, `only ${video.length} video frames`);
      assert.ok(keys.length >= 1, 'no IDR frame (0x100)');
      assert.ok((keys[0].flags & 0x01) !== 0, 'IDR frame lacks FRAME_FLAG_KEY');
      const probe = JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-f', 'h264', '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', AU_FILE], { encoding: 'utf8' })
      );
      const st = probe.streams[0];
      assert.strictEqual(st.codec_name, 'h264');
      assert.deepStrictEqual([st.width, st.height], [1920, 1080]);
      assert.ok(Number(st.nb_read_frames) >= video.length * 0.9, `ffprobe decoded ${st.nb_read_frames} of ${video.length}`);
      return `${frames.length} frames, ${keys.length} IDR, ffprobe ${st.nb_read_frames} frames`;
    });

    await check('scene save/delete', async () => {
      const s = await phone.call('save_scene', { scene: { name: 'CI Sahne', items: [] } });
      assert.ok(s.scene.id && s.scenes.some((x) => x.id === s.scene.id));
      const d = await phone.call('delete_scene', { sceneId: s.scene.id });
      assert.ok(!d.scenes.some((x) => x.id === s.scene.id));
    });

    await check('quick action save/delete', async () => {
      const q = await phone.call('save_quick_action', { quickAction: { name: 'CI Buton', items: [{ name: 'true', targetPath: '/bin/true' }] } });
      assert.ok(q.quickAction.id);
      const d = await phone.call('delete_quick_action', { id: q.quickAction.id });
      assert.ok(!d.quickActions.some((x) => x.id === q.quickAction.id));
    });

    await check('function prefs get/save', async () => {
      const g = await phone.call('get_function_prefs');
      assert.ok(g.prefs && g.options);
      const s = await phone.call('save_function_prefs', { prefs: { shutdown: 'normal', restart: 'normal', sleep: 'sleep', lock: 'custom' } });
      assert.strictEqual(s.prefs.shutdown, 'normal');
    });

    await check('power: lock -> loginctl', () => expectPowerCommand(phone, { action: 'lock' }, 'loginctl lock-session' + (process.env.XDG_SESSION_ID ? ' ' + process.env.XDG_SESSION_ID : '')));
    await check('power: sleep -> systemctl suspend', () => expectPowerCommand(phone, { action: 'sleep' }, 'systemctl suspend'));
    await check('power: hibernate', () => expectPowerCommand(phone, { action: 'hibernate' }, 'systemctl hibernate'));
    await check('power: shutdown', () => expectPowerCommand(phone, { action: 'shutdown' }, 'systemctl poweroff'));
    await check('power: restart', () => expectPowerCommand(phone, { action: 'restart' }, 'systemctl reboot'));
    await check('power: shutdown with prefs shutdown=force', async () => {
      await phone.call('save_function_prefs', { prefs: { shutdown: 'force' } });
      try {
        return await expectPowerCommand(phone, { action: 'shutdown' }, 'systemctl poweroff -i');
      } finally {
        await phone.call('save_function_prefs', { prefs: { shutdown: 'normal' } }).catch(() => {});
      }
    });

    await check('wake_on_lan magic packet (UDP 9)', async () => {
      const sock = dgram.createSocket('udp4');
      const received = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no packet within 3 s')), 3000);
        sock.on('message', (msg) => {
          clearTimeout(t);
          resolve(msg);
        });
      });
      await new Promise((resolve, reject) => {
        sock.once('error', (e) => reject(new Error(`cannot bind 127.0.0.1:${WOL_PORT} (${e.code}); run: sudo sysctl -w net.ipv4.ip_unprivileged_port_start=0`)));
        sock.bind(WOL_PORT, '127.0.0.1', resolve);
      });
      try {
        await phone.call('wake_on_lan', { macAddress: 'AA:BB:CC:DD:EE:FF', broadcastIp: '127.0.0.1' });
        const msg = await received;
        const mac = Buffer.from('AABBCCDDEEFF', 'hex');
        const expected = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(mac)]);
        assert.strictEqual(msg.length, 102);
        assert.ok(msg.equals(expected), 'magic packet bytes');
        return '102 bytes ok';
      } finally {
        sock.close();
      }
    });
  } catch (e) {
    results.push({ name: 'setup', ok: false, ms: 0, note: e.message });
  } finally {
    if (phone) phone.ws.terminate();
    if (serverExited) results.push({ name: 'server alive', ok: false, ms: 0, note: serverExited });
    server.kill('SIGTERM');
    await sleep(300);
  }

  // Report
  const w = Math.max(...results.map((r) => r.name.length), 10);
  console.log('\nBridge Linux sandbox e2e\n' + '='.repeat(w + 40));
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${String(r.ms).padStart(5)} ms  ${r.note}`);
  const failed = results.filter((r) => !r.ok);
  console.log('='.repeat(w + 40) + `\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\n--- server.log (tail) ---');
    try {
      console.log(fs.readFileSync(SERVER_LOG, 'utf8').split('\n').slice(-60).join('\n'));
    } catch {}
    console.log(`power log: ${JSON.stringify(readPowerLog())}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
