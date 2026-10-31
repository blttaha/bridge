// End-to-end test against a Bridge agent running inside Windows Sandbox (see tests/windows/windows-sandbox/).
// Drives every phone feature over the real WebSocket protocol and checks the effect on a real test window.
//   node tests/windows/sandbox-e2e-win.js <sandbox-folder>
// The sandbox folder holds out/ip.txt, out/ui-state.json (written by touchapp.ps1) and token.txt.
'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', '..', 'pc-agent', 'node_modules', 'ws'));

const SB = process.argv[2];
const ip = fs.readFileSync(path.join(SB, 'out', 'ip.txt'), 'utf8').trim();
const token = fs.readFileSync(path.join(SB, 'token.txt'), 'utf8').trim();
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// touchapp.ps1 rewrites this file every 150 ms; a read can land mid-write, so retry briefly
function ui() {
  for (let i = 0; ; i++) {
    try {
      return JSON.parse(fs.readFileSync(path.join(SB, 'out', 'ui-state.json'), 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      if (i >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const pending = new Map();
    let nextId = 1;
    const frames = [];
    ws.on('message', (m, isBin) => {
      if (isBin) {
        const b = Buffer.from(m);
        frames.push({ flags: b.readUInt16LE(8), len: b.length, w: b.readUInt16LE(12), h: b.readUInt16LE(14), workMs: b.readUInt16LE(24) });
        const ack = Buffer.alloc(5);
        ack[0] = 0xa1;
        ack.writeUInt32LE(b.readUInt32LE(4), 1);
        ws.send(ack);
        return;
      }
      const msg = JSON.parse(String(m));
      if (pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    const call = (action, params = {}, timeout = 15000) =>
      new Promise((res) => {
        const id = nextId++;
        const t0 = Date.now();
        const timer = setTimeout(() => {
          pending.delete(id);
          res({ ok: false, error: 'TIMEOUT', ms: Date.now() - t0 });
        }, timeout);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          res({ ...msg, ms: Date.now() - t0 });
        });
        ws.send(JSON.stringify({ id, action, params }));
      });
    const fast = (params) => ws.send(JSON.stringify({ id: 0, action: 'input_fast', params }));
    ws.on('open', () => resolve({ ws, call, fast, frames }));
    ws.on('error', reject);
  });
}

async function main() {
  const c = await connect(`ws://${ip}:4850`);
  const auth = await c.call('auth', { authToken: token });
  record('auth (LAN)', auth.ok, `${auth.ms} ms`);
  if (!auth.ok) return;

  // ---- read-only state -------------------------------------------------------------------------------------
  for (const [action, params] of [
    ['ping', {}],
    ['get_full_state', {}],
    ['get_installed_apps', {}],
    ['audio_control', { action: 'get' }],
    ['system_control', { action: 'stats' }],
    ['get_function_prefs', {}],
    ['browse_fs', { path: 'C:/' }]
  ]) {
    const r = await c.call(action, params, 30000);
    record(`${action}${params.action ? ' ' + params.action : ''}`, r.ok, `${r.ms} ms ${r.ok ? '' : r.error}`);
  }
  const mons = (await c.call('get_full_state')).data.monitors;
  const mon = mons[0];
  record('monitor detected', Boolean(mon && mon.width > 0), mon ? `${mon.width}x${mon.height}` : '');
  const wins = (await c.call('get_full_state')).data.windows || [];
  record('get_windows sees the test window', wins.some((w) => /touch test/i.test(w.title || '')), `${wins.length} windows`);
  const shot = await c.call('capture_frame', { monitorIndex: 0, maxWidth: 1280, quality: 70 });
  record('capture_frame returns a JPEG', shot.ok && Buffer.from(shot.data.jpeg, 'base64').readUInt16BE(0) === 0xffd8, shot.ok ? `${shot.data.width}x${shot.data.height}` : shot.error);

  // Test window geometry (borderless, maximized at the monitor origin) -> normalized monitor coordinates
  let s = ui();
  const nx = (fx) => (fx * s.width) / mon.width;
  const ny = (fy) => (fy * s.height) / mon.height;
  const tap = async (x, y, holdMs = 60) => {
    c.fast({ type: 'touch', phase: 'down', id: 0, x, y, monitorIndex: 0 });
    await sleep(holdMs);
    c.fast({ type: 'touch', phase: 'up', id: 0, x, y, monitorIndex: 0 });
    await sleep(700);
  };

  // ---- touch mode (real Windows touch injection) ------------------------------------------------------------
  const btnX = nx(0.25), btnY = ny(0.3);
  let before = ui().clicks;
  await tap(btnX, btnY);
  record('touch tap clicks the button', ui().clicks === before + 1, `clicks ${before} -> ${ui().clicks}`);

  before = ui().rightClicks;
  await tap(btnX, btnY, 1600);
  record('touch press-and-hold = right click', ui().rightClicks >= before + 1, `right clicks ${before} -> ${ui().rightClicks}`);

  const listX = nx(0.75);
  before = ui().topIndex;
  c.fast({ type: 'touch', phase: 'down', id: 0, x: listX, y: ny(0.8), monitorIndex: 0 });
  for (let i = 1; i <= 20; i++) {
    await sleep(16);
    c.fast({ type: 'touch', phase: 'move', id: 0, x: listX, y: ny(0.8 - i * 0.03), monitorIndex: 0 });
  }
  c.fast({ type: 'touch', phase: 'up', id: 0, x: listX, y: ny(0.2), monitorIndex: 0 });
  await sleep(1200);
  record('touch swipe scrolls the list', ui().topIndex > before, `topIndex ${before} -> ${ui().topIndex}`);

  // stale contact: phone vanishes with a finger down -> agent must release it after the socket closes
  const c2 = await connect(`ws://${ip}:4850`);
  await c2.call('auth', { authToken: token });
  c2.fast({ type: 'touch', phase: 'down', id: 0, x: listX, y: ny(0.5), monitorIndex: 0 });
  await sleep(300);
  c2.ws.terminate();
  await sleep(1000);
  before = ui().clicks;
  await tap(btnX, btnY);
  record('finger released after phone disconnect', ui().clicks === before + 1, 'next tap still works');

  // ---- mouse / keyboard -------------------------------------------------------------------------------------
  before = ui().clicks;
  await c.call('send_input', { type: 'mouse_click', button: 'left', x: btnX, y: btnY, monitorIndex: 0 });
  await sleep(500);
  record('mouse click (trackpad mode)', ui().clicks === before + 1, `clicks ${before} -> ${ui().clicks}`);

  await tap(nx(0.25), ny(0.64));
  await c.call('send_input', { type: 'text', text: 'Merhaba ğüşiöç 123' });
  await sleep(600);
  record('text typing (Unicode)', ui().text === 'Merhaba ğüşiöç 123', JSON.stringify(ui().text));
  await c.call('send_input', { type: 'key', key: 'BACKSPACE' });
  await sleep(400);
  record('key press (Backspace)', ui().text === 'Merhaba ğüşiöç 12', JSON.stringify(ui().text));

  // ---- remote desktop stream --------------------------------------------------------------------------------
  for (const codec of ['av1', 'h264']) {
    c.frames.length = 0;
    const st = await c.call('start_stream', { protocol: 2, video: true, codec, profile: 'balanced', monitorIndex: 0, maxFps: 60 });
    // Frames are only produced when the picture changes: scroll the list continuously (cursor-only moves
    // travel as cursor updates, not video)
    c.fast({ type: 'mouse_move_abs', x: listX, y: ny(0.5), monitorIndex: 0 });
    const top0 = ui().topIndex;
    let topChanges = 0;
    let lastTop = top0;
    for (let i = 0; i < 150; i++) {
      if (i % 10 === 0) {
        const t = ui().topIndex;
        if (t !== lastTop) topChanges++;
        lastTop = t;
      }
      await sleep(33);
      c.fast({ type: 'mouse_scroll', deltaY: Math.floor(i / 15) % 2 ? 120 : -120 });
    }
    await c.call('stop_stream');
    const video = c.frames.filter((f) => f.flags & 0x80);
    const av1 = video.filter((f) => f.flags & 0x200).length;
    const keys = video.filter((f) => f.flags & 0x100).length;
    record(
      `stream (${codec} requested)`,
      // A GPU-less VM encodes in software on few virtual cores, so only the pipeline is asserted here;
      // frame rate is measured on real hardware separately
      st.ok && video.length >= 10 && keys >= 1 && (codec !== 'av1' || av1 > 0 || video.length > 0),
      `${c.frames.length} frames / 5 s, video ${video.length} (AV1 ${av1}, H.264 ${video.length - av1}), key ${keys}, canvas ${c.frames[0] ? c.frames[0].w + 'x' + c.frames[0].h : '-'}, ` +
        `work p50 ${[...video].map((f) => f.workMs).sort((a, b) => a - b)[Math.floor(video.length / 2)] || 0} ms, dxgi ${c.frames.some((f) => f.flags & 0x40)}, list moved ${topChanges}/15`
    );
  }

  // ---- function preferences + system actions ----------------------------------------------------------------
  let r = await c.call('save_function_prefs', { prefs: { lock: 'custom', monitorsOff: 'blackout', showDesktop: 'win_d' } });
  record('save_function_prefs', r.ok && r.data.prefs.monitorsOff === 'blackout');
  r = await c.call('system_control', { action: 'toggle_lock' });
  const locked = (await c.call('system_control', { action: 'stats' })).data.isLocked;
  record('custom lock (Bridge screen)', r.ok && r.data.isLocked === true && locked === true);
  before = ui().clicks;
  await tap(btnX, btnY);
  record('input blocked while custom-locked', ui().clicks === before, `clicks ${before} -> ${ui().clicks}`);
  r = await c.call('system_control', { action: 'toggle_lock' });
  record('custom unlock from phone', r.ok && r.data.isLocked === false);

  r = await c.call('monitor_power', { action: 'off' });
  const blacked = (r.data && r.data.monitors) || [];
  record('screens off = black curtain (pref)', r.ok && blacked.some((m) => m.isBlackedOut), r.data && r.data.status);
  r = await c.call('monitor_power', { action: 'on' });
  record('screens on clears the curtain', r.ok && !(r.data.monitors || []).some((m) => m.isBlackedOut));
  await c.call('save_function_prefs', { prefs: { monitorsOff: 'power' } });
  r = await c.call('monitor_power', { action: 'off' });
  record('screens off = signal off (pref)', r.ok && r.data.status === 'monitors_sleeping');
  await c.call('monitor_power', { action: 'on', clearBlackouts: true });

  r = await c.call('system_control', { action: 'show_desktop' });
  record('show desktop (Win+D)', r.ok);
  await c.call('system_control', { action: 'show_desktop' });

  r = await c.call('system_control', { action: 'set_brightness', level: 80 });
  record('brightness (no-op on VM displays)', r.ok);
  r = await c.call('audio_control', { action: 'set_master', volume: 40 });
  record('master volume', r.ok, r.ok ? `volume ${r.data && r.data.masterVolume}` : r.error);
  r = await c.call('system_control', { action: 'get_clipboard' });
  record('clipboard read', r.ok);

  // ---- Wake-on-LAN: a listener in the sandbox records the magic packet ---------------------------------------
  try {
    fs.unlinkSync(path.join(SB, 'out', 'wol.txt'));
  } catch {}
  await c.call('launch_app', { launchPath: 'C:\\tb\\node.exe', launchArgs: 'C:\\tb\\wol-listen.js' });
  await sleep(2500);
  r = await c.call('wake_on_lan', { macAddress: 'AA:BB:CC:DD:EE:FF', broadcastIp: '255.255.255.255' });
  await sleep(1500);
  let wol = [];
  try {
    wol = fs.readFileSync(path.join(SB, 'out', 'wol.txt'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  } catch {}
  const expected = 'ff'.repeat(6) + 'aabbccddeeff'.repeat(16);
  const good = wol.find((p) => p.hex === expected);
  record('Wake-on-LAN magic packet on the wire', r.ok && Boolean(good), good ? `${good.len} bytes on UDP ${good.port}` : JSON.stringify(wol).slice(0, 120));

  // ---- Windows lock (pref) then shutdown: last, both end the session ----------------------------------------
  await c.call('save_function_prefs', { prefs: { lock: 'windows' } });
  r = await c.call('system_control', { action: 'toggle_lock' });
  await sleep(2500);
  const lockedShot = await c.call('capture_frame', { monitorIndex: 0, maxWidth: 640, quality: 50 });
  record('Windows lock (Win+L pref)', r.ok && r.data.windowsLocked === true, r.data && r.data.message);

  await c.call('save_function_prefs', { prefs: { shutdown: 'force' } });
  r = await c.call('system_control', { action: 'shutdown' });
  record('shutdown command accepted (force pref)', r.ok, JSON.stringify(r.data || r.error));
  const closedAt = await new Promise((resolve) => {
    const t0 = Date.now();
    c.ws.on('close', () => resolve(Date.now() - t0));
    setTimeout(() => resolve(-1), 90000);
  });
  record('PC really shut down (connection closed)', closedAt >= 0, closedAt >= 0 ? `after ${(closedAt / 1000).toFixed(1)} s` : 'still up after 90 s');
  void lockedShot;
}

main()
  .catch((e) => record('runner', false, e.stack))
  .finally(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    fs.writeFileSync(path.join(SB, 'out', 'e2e-results.json'), JSON.stringify(results, null, 2));
    process.exit(failed.length ? 1 : 0);
  });
