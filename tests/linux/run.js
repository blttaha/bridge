#!/usr/bin/env node
'use strict';
// Mock-based tests for the Linux bridge. Runs anywhere (also on Windows): node tests/linux/run.js

const assert = require('assert');
const net = require('net');
const P = require('../../pc-agent/linux/parsers');
const proto = require('../../pc-agent/linux/protocol');
const { InputController, Xdo } = require('../../pc-agent/linux/input');
const { createDesktop } = require('../../pc-agent/linux/desktop');
const { createSystem } = require('../../pc-agent/linux/system');
const stream = require('../../pc-agent/linux/stream');
const { createBridge } = require('../../pc-agent/linux/bridge');
const { createMockSys, createMockFs, FakeProc } = require('./mock');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Sample tool output
// ---------------------------------------------------------------------------
const XRANDR_DUAL = `Screen 0: minimum 8 x 8, current 4480 x 1440, maximum 32767 x 32767
HDMI-1 connected 2560x1440+1920+0 (normal left inverted right x axis y axis) 597mm x 336mm
   2560x1440     59.95*+
eDP-1 connected primary 1920x1080+0+180 (normal left inverted right x axis y axis) 344mm x 194mm
   1920x1080     60.02*+  48.00
DP-1 disconnected (normal left inverted right x axis y axis)
DP-2 connected (normal left inverted right x axis y axis)
   1920x1080     60.00 +
`;
const XRANDR_XVFB = `Screen 0: minimum 1 x 1, current 1920 x 1080, maximum 1920 x 1080
default connected primary 1920x1080+0+0 0mm x 0mm
   1920x1080     10.00*
`;
const XRANDR_NO_OUTPUTS = `Screen 0: minimum 320 x 200, current 1280 x 800, maximum 8192 x 8192\n`;

const WMCTRL = `0x01e00003 -1 1500   0    0    1920 27   ci-host Top Panel
0x03a00003  0 2001   10   52   800  600  ci-host Terminal - taha@ci: ~
0x04000007  0 2002   0    0    1920 1053 ci-host Mozilla Firefox
0x04200001  0 2003   1930 40   1200 800  ci-host Notes
`;

const PACTL_VOL = 'Volume: front-left: 42598 /  65% / -11.23 dB,   front-right: 42598 /  65% / -11.23 dB\n        balance 0.00\n';
const PACTL_SINK_INPUTS = `Sink Input #57
	Driver: protocol-native.c
	Owner Module: 10
	Client: 61
	Sink: 0
	Sample Specification: float32le 2ch 48000Hz
	Channel Map: front-left,front-right
	Format: pcm, format.sample_format = "\\"float32le\\""
	Corked: no
	Mute: no
	Volume: front-left: 52429 /  80% / -5.81 dB,   front-right: 52429 /  80% / -5.81 dB
	        balance 0.00
	Buffer Latency: 0 usec
	Properties:
		media.name = "Playback"
		application.name = "Firefox"
		application.process.id = "2002"
		application.process.binary = "firefox"
Sink Input #58
	Corked: yes
	Mute: yes
	Volume: mono: 32768 /  50% / -18.06 dB
	Properties:
		application.name = "Spotify"
		application.process.id = "3100"
		application.process.binary = "spotify"
`;
const PACTL_SINKS_OLD = `Sink #0
	State: RUNNING
	Name: alsa_output.pci.analog-stereo
	Mute: no
	Volume: front-left: 19661 /  30% / -31.37 dB,   front-right: 19661 /  30% / -31.37 dB
Sink #1
	Name: other
	Mute: yes
	Volume: front-left: 65536 / 100% / 0.00 dB
`;
const PLAYERCTL = 'firefox.instance_1_23\tPaused\tSome Video\t\t300000000\t12500000\nspotify\tPlaying\tSong Title\tThe Artist\t215000000\t61250000\n';

const PROC_STAT_1 = 'cpu  1000 0 500 8000 500 0 0 0 0 0\ncpu0 1 2 3\n';
const PROC_STAT_2 = 'cpu  1300 0 600 8500 600 0 0 0 0 0\ncpu0 1 2 3\n';
const MEMINFO = 'MemTotal:       16000000 kB\nMemFree:         2000000 kB\nMemAvailable:    6000000 kB\nBuffers:          100000 kB\n';

const DESKTOP_FIREFOX = `[Desktop Entry]
Version=1.0
Name=Firefox Web Browser
Name[tr]=Firefox Web Tarayıcısı
Exec=/usr/lib/firefox/firefox %u
Icon=firefox
Type=Application
StartupWMClass=firefox

[Desktop Action new-window]
Name=Open a New Window
Exec=/usr/lib/firefox/firefox -new-window
`;
const DESKTOP_HIDDEN = '[Desktop Entry]\nName=Hidden Helper\nExec=helper\nType=Application\nNoDisplay=true\n';
const DESKTOP_QUOTED = '[Desktop Entry]\nName=Quoted\nExec="/opt/My App/run" --flag "a b" %F\nType=Application\nIcon=/opt/My App/icon.png\n';
const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------
test('xrandr: dual monitor, primary first, disconnected/inactive skipped', () => {
  const r = P.parseXrandr(XRANDR_DUAL);
  assert.deepStrictEqual(
    r.outputs.map((o) => [o.name, o.isPrimary, o.x, o.y, o.width, o.height]),
    [
      ['eDP-1', true, 0, 180, 1920, 1080],
      ['HDMI-1', false, 1920, 0, 2560, 1440]
    ]
  );
  assert.deepStrictEqual(r.inactive, ['DP-2']);
});

test('xrandr: Xvfb and output-less screens', () => {
  const a = P.parseXrandr(XRANDR_XVFB).outputs;
  assert.strictEqual(a.length, 1);
  assert.deepStrictEqual([a[0].name, a[0].width, a[0].height, a[0].isPrimary], ['default', 1920, 1080, true]);
  const b = P.parseXrandr(XRANDR_NO_OUTPUTS).outputs;
  assert.deepStrictEqual([b[0].width, b[0].height], [1280, 800]);
});

test('xprop _NET_WORKAREA + per-monitor intersection', () => {
  const wa = P.parseNetWorkarea('_NET_WORKAREA(CARDINAL) = 0, 27, 4480, 1413, 0, 27, 4480, 1413');
  assert.deepStrictEqual(wa, { x: 0, y: 27, width: 4480, height: 1413 });
  assert.deepStrictEqual(P.intersectWorkarea({ x: 1920, y: 0, width: 2560, height: 1440 }, wa), { x: 1920, y: 27, width: 2560, height: 1413 });
});

test('wmctrl -lpG parsing', () => {
  const w = P.parseWmctrl(WMCTRL);
  assert.strictEqual(w.length, 4);
  assert.deepStrictEqual(w[1], { id: '0x03a00003', hwnd: 0x03a00003, desktop: 0, pid: 2001, x: 10, y: 52, width: 800, height: 600, host: 'ci-host', title: 'Terminal - taha@ci: ~' });
  assert.strictEqual(w[0].desktop, -1);
});

test('_NET_WM_STATE and zone classification', () => {
  assert.deepStrictEqual(P.parseNetWmState('_NET_WM_STATE(ATOM) = _NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_MAXIMIZED_HORZ'), { state: 'maximized', above: false });
  assert.deepStrictEqual(P.parseNetWmState('_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN, _NET_WM_STATE_ABOVE'), { state: 'minimized', above: true });
  assert.strictEqual(P.parseNetWmState('_NET_WM_STATE:  not found.').state, 'normal');
  assert.strictEqual(P.classifyZone('normal', 0, 0, 0.5, 1), 'left-half');
  assert.strictEqual(P.classifyZone('normal', 0.5, 0.5, 0.5, 0.5), 'bottom-right');
  assert.strictEqual(P.classifyZone('maximized', 0.3, 0.3, 0.2, 0.2), 'fullscreen');
  assert.deepStrictEqual(P.resolveZoneRect('right-half'), { x: 0.5, y: 0, w: 0.5, h: 1, state: 'normal' });
  assert.strictEqual(P.resolveZoneRect('full').state, 'maximized');
});

test('pactl: volume, mute, sink inputs, old pactl sinks', () => {
  assert.strictEqual(P.parsePactlVolume(PACTL_VOL), 65);
  assert.strictEqual(P.parsePactlMute('Mute: yes\n'), true);
  assert.strictEqual(P.parsePactlMute('Mute: no\n'), false);
  const s = P.parsePactlSinkInputs(PACTL_SINK_INPUTS);
  assert.deepStrictEqual(s[0], { sinkInputId: 57, pid: 2002, processName: 'Firefox', rawProcessName: 'firefox', icon: '', volume: 80, muted: false, isActive: true });
  assert.deepStrictEqual([s[1].volume, s[1].muted, s[1].isActive, s[1].rawProcessName], [50, true, false, 'spotify']);
  assert.deepStrictEqual(P.parsePactlSinks(PACTL_SINKS_OLD, 'alsa_output.pci.analog-stereo'), { name: 'alsa_output.pci.analog-stereo', volume: 30, muted: false });
});

test('playerctl: parsing, playing player wins, friendly names', () => {
  const list = P.parsePlayerctlLines(PLAYERCTL);
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual([list[0].durationSec, list[0].positionSec, list[0].isPlaying], [300, 12.5, false]);
  const pick = P.pickPlayer(list);
  assert.deepStrictEqual([pick.player, pick.title, pick.artist, pick.durationSec, pick.positionSec], ['spotify', 'Song Title', 'The Artist', 215, 61.25]);
  assert.strictEqual(P.friendlyPlayerName('firefox.instance_1_23'), 'Firefox');
  assert.strictEqual(P.pickPlayer([]), null);
});

test('/proc: cpu delta, meminfo, uptime', () => {
  const a = P.parseProcStat(PROC_STAT_1);
  const b = P.parseProcStat(PROC_STAT_2);
  // busy delta 400 of total delta 1000
  assert.strictEqual(P.cpuPercent(a, b), 40);
  assert.deepStrictEqual(P.parseMeminfo(MEMINFO), { memoryPercent: 63, usedRamGb: 9.5, totalRamGb: 15.3 });
  assert.strictEqual(P.parseUptime('12345.67 99999.00\n'), 12345);
});

test('.desktop entries: localised name, actions ignored, field codes, quoting', () => {
  const e = P.parseDesktopEntry(DESKTOP_FIREFOX);
  assert.strictEqual(P.desktopName(e), 'Firefox Web Tarayıcısı');
  assert.strictEqual(e.Exec, '/usr/lib/firefox/firefox %u');
  assert.ok(P.isDesktopEntryVisible(e));
  assert.ok(!P.isDesktopEntryVisible(P.parseDesktopEntry(DESKTOP_HIDDEN)));
  assert.deepStrictEqual(P.parseDesktopExec(e.Exec), ['/usr/lib/firefox/firefox']);
  assert.deepStrictEqual(P.parseDesktopExec(P.parseDesktopEntry(DESKTOP_QUOTED).Exec), ['/opt/My App/run', '--flag', 'a b']);
  assert.deepStrictEqual(P.splitArgs(`--a "b c" 'd e' f\\ g`), ['--a', 'b c', 'd e', 'f g']);
});

test('key combos -> xdotool keysyms', () => {
  assert.strictEqual(P.mapKeyCombo('WIN+D'), 'super+d');
  assert.strictEqual(P.mapKeyCombo('CTRL+SHIFT+ESC'), 'ctrl+shift+Escape');
  assert.strictEqual(P.mapKeyCombo('MEDIA_PLAY_PAUSE'), 'XF86AudioPlay');
  assert.strictEqual(P.mapKeyCombo('backspace'), 'BackSpace');
  assert.strictEqual(P.mapKeyCombo('ALT+F4'), 'alt+F4');
  assert.strictEqual(P.mapKeyCombo('CTRL+?'), 'ctrl'); // unknown parts dropped like MapKeyNameToVk
  assert.strictEqual(P.mapKeyCombo(''), '');
  assert.strictEqual(P.parseMouseLocation('x:812 y:403 screen:0 window:6291462').x, 812);
});

// ---------------------------------------------------------------------------
// JSON-line RPC
// ---------------------------------------------------------------------------
test('rpc: reply shapes, id 0 silent, unknown command, bad JSON, thrown errors', async () => {
  const out = [];
  const logs = [];
  const d = proto.createRpcDispatcher(
    { ping: async () => ({ pong: true }), boom: async () => { throw new Error('Patladı'); } },
    (l) => out.push(JSON.parse(l)),
    (m) => logs.push(m)
  );
  await d('{"id":7,"cmd":"ping","args":{}}');
  await d('{"id":0,"cmd":"ping","args":{}}');
  await d('{"id":8,"cmd":"nope"}');
  await d('{"id":9,"cmd":"boom","args":[]}');
  await d('{"id":0,"cmd":"boom"}');
  await d('not json');
  await d('   ');
  assert.deepStrictEqual(out[0], { id: 7, ok: true, data: { pong: true } });
  assert.deepStrictEqual(out[1], { id: 8, ok: false, error: 'Unknown command: nope' });
  assert.deepStrictEqual(out[2], { id: 9, ok: false, error: 'Patladı' });
  assert.strictEqual(out[3].id, 0);
  assert.strictEqual(out[3].ok, false);
  assert.strictEqual(out.length, 4);
  assert.ok(logs.some((l) => l.includes('Patladı')));
});

test('rpc: bridge handlers cover every command the server calls', () => {
  const { handlers } = createBridge(createMockSys());
  for (const c of ['ping', 'get_monitors', 'monitor_power', 'monitor_blackout', 'display_topology', 'get_windows', 'get_installed_apps', 'snap_window', 'focus_window', 'close_window', 'window_action', 'browse_fs', 'inspect_target', 'get_file_icon', 'execute_quick_item', 'capture_screen', 'send_input', 'audio_control', 'system_control']) {
    assert.strictEqual(typeof handlers[c], 'function', c);
  }
});

test('rpc: missing tool gives a Turkish install hint instead of crashing', async () => {
  const sys = createMockSys({ tools: [] });
  const { handlers } = createBridge(sys);
  const out = [];
  const d = proto.createRpcDispatcher(handlers, (l) => out.push(JSON.parse(l)));
  await d('{"id":1,"cmd":"get_monitors"}');
  await d('{"id":2,"cmd":"get_windows"}');
  assert.strictEqual(out[0].ok, false);
  assert.match(out[0].error, /xrandr.*bulunamadı.*sudo apt install x11-xserver-utils/);
  assert.match(out[1].error, /wmctrl/);
});

// ---------------------------------------------------------------------------
// IPC key + TCP ports
// ---------------------------------------------------------------------------
const KEY = 'k'.repeat(48);

function listenGate(onAuthed) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.on('error', () => {});
      proto.gateSocket(sock, KEY, (rest) => onAuthed(sock, rest));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function connectAndSend(port, data) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('error', () => {});
    const chunks = [];
    s.on('data', (d) => chunks.push(d));
    s.on('connect', () => s.write(data));
    s.on('close', () => resolve(Buffer.concat(chunks)));
    setTimeout(() => s.destroy(), 400);
  });
}

test('ipc key: exact match only, short keys never accepted', () => {
  assert.ok(proto.ipcKeyMatches(KEY, KEY));
  assert.ok(proto.ipcKeyMatches(KEY + '\r', KEY));
  assert.ok(!proto.ipcKeyMatches(KEY.slice(1), KEY));
  assert.ok(!proto.ipcKeyMatches('x'.repeat(48), KEY));
  assert.ok(!proto.ipcKeyMatches('short', 'short'));
  assert.ok(!proto.ipcKeyMatches('', ''));
});

test('input port: wrong key closed, right key accepted, first non-JSON line drops', async () => {
  const got = [];
  let dropped = false;
  const srv = await listenGate((sock, rest) => {
    sock.on('close', () => {
      dropped = true;
    });
    proto.attachInputLineProtocol(sock, rest, (a) => got.push(a));
  });
  const port = srv.address().port;
  await connectAndSend(port, 'wrong-key\n{"type":"key","key":"A"}\n');
  assert.strictEqual(got.length, 0);
  await connectAndSend(port, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n');
  assert.strictEqual(got.length, 0);
  await connectAndSend(port, `${KEY}\n{"type":"mouse_move_abs","x":0.5}\n{"type":"key","key":"A"}\nGET /\n{"type":"text","text":"never"}\n`);
  await tick(30);
  srv.close();
  assert.deepStrictEqual(got.map((g) => g.type), ['mouse_move_abs', 'key']);
  assert.ok(dropped);
});

// ---------------------------------------------------------------------------
// Binary stream protocol
// ---------------------------------------------------------------------------
// Copy of measureStreamFrame() from server.js: the frames we build must be parsed identically
function serverMeasure(buf) {
  if (buf.length < 28) return -1;
  if (buf.readUInt32LE(0) !== 0x32464254) throw new Error('stream desync');
  const flags = buf.readUInt16LE(8);
  const rectCount = buf.readUInt16LE(10);
  let off = 28;
  if (flags & 0x08) {
    if (buf.length < off + 12) return -1;
    off += 12 + buf.readUInt32LE(off + 8);
  }
  if (flags & 0x80) {
    if (buf.length < off + 8) return -1;
    off += 8 + buf.readUInt32LE(off + 4);
  }
  for (let i = 0; i < rectCount; i++) {
    if (buf.length < off + 12) return -1;
    off += 12 + buf.readUInt32LE(off + 8);
  }
  return buf.length >= off ? off : -1;
}

test('TBR3 request: built like server.js, parsed with all fields', () => {
  const b = proto.buildStreamRequest({ monitorIndex: 1, maxCanvasWidth: 2560, motionScale: 750, motionQuality: 58, refineQuality: 90, mode: 2, flags: 2, waitMs: 200, videoBitrate100: 120, videoMaxWidth: 1920, fps: 60 });
  assert.strictEqual(b.length, 24);
  assert.strictEqual(b.toString('latin1', 0, 4), 'TBR3');
  const r = proto.parseStreamRequest(b);
  assert.deepStrictEqual(
    [r.monitorIndex, r.maxCanvasWidth, r.motionScale, r.motionQuality, r.refineQuality, r.mode, r.allowVideo, r.allowAv1, r.waitMs, r.videoKbps, r.videoMaxWidth, r.fps],
    [1, 2560, 750, 58, 90, 2, true, false, 200, 12000, 1920, 60]
  );
  assert.throws(() => proto.parseStreamRequest(Buffer.alloc(24)), /magic/);
});

test('TBF2 frame: 28-byte header, video + rects, idle flag, server-compatible length', () => {
  const au = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84]);
  const f = proto.buildFrame({ frameId: 5, flags: proto.FLAGS.KEY | proto.FLAGS.VIDEO_KEY, canvasW: 1920, canvasH: 1080, srcW: 3840, srcH: 2160, cursorX: 65535, cursorY: 0, workMs: 3, video: { width: 1920, height: 1080, data: au }, rects: [{ x: 0, y: 0, w: 1920, h: 1080 }] });
  assert.strictEqual(f.length, 28 + 8 + au.length + 12);
  assert.strictEqual(f.toString('latin1', 0, 4), 'TBF2');
  assert.strictEqual(f.readUInt16LE(8), 0x181);
  assert.strictEqual(serverMeasure(f), f.length);
  assert.strictEqual(serverMeasure(Buffer.concat([f, Buffer.from('TBF2')])), f.length);
  assert.strictEqual(serverMeasure(f.subarray(0, f.length - 1)), -1);
  const p = proto.parseFrame(f);
  assert.deepStrictEqual([p.frameId, p.canvasW, p.srcW, p.cursorX, p.rectCount, p.rects[0].w, p.rects[0].data.length], [5, 1920, 3840, 65535, 1, 1920, 0]);
  assert.ok(p.video.data.equals(au));
  const idle = proto.buildFrame({ frameId: 6, canvasW: 10, canvasH: 10, srcW: 10, srcH: 10 });
  assert.strictEqual(idle.length, 28);
  assert.strictEqual(idle.readUInt16LE(8) & proto.FLAGS.IDLE, proto.FLAGS.IDLE);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const jf = proto.buildFrame({ frameId: 7, flags: 1, canvasW: 64, canvasH: 32, srcW: 64, srcH: 32, rects: [{ x: 0, y: 0, w: 64, h: 32, data: jpg }] });
  assert.strictEqual(serverMeasure(jf), 28 + 12 + 4);
  assert.ok(proto.parseFrame(jf).rects[0].data.equals(jpg));
});

// Synthetic H.264 elementary stream: frame = [AUD?] [SPS PPS] slices...; first_mb_in_slice 0 => byte 0x88 (top bit 1)
function nal(type, firstMb0, len = 12, long = true, fill = 0x11) {
  const sc = long ? [0, 0, 0, 1] : [0, 0, 1];
  const hdr = (type === 5 || type === 7 || type === 8 ? 0x60 : 0x40) | type;
  const body = [hdr];
  if (type >= 1 && type <= 5) body.push(firstMb0 ? 0x88 : 0x44);
  while (body.length < len) body.push(fill);
  return Buffer.from([...sc, ...body]);
}

function syntheticStream({ aud = false, slices = 2 } = {}) {
  const aus = [];
  for (let i = 0; i < 6; i++) {
    const key = i % 3 === 0;
    const parts = [];
    if (aud) parts.push(nal(9, false, 2));
    if (key) parts.push(nal(7, false, 10), nal(8, false, 5, false));
    for (let s = 0; s < slices; s++) parts.push(nal(key ? 5 : 1, s === 0, 40 + i, s % 2 === 0, 0x20 + i));
    aus.push({ data: Buffer.concat(parts), isKey: key });
  }
  return aus;
}

test('Annex B splitter: multi-slice pictures, chunked at every boundary', () => {
  for (const opt of [{ slices: 1 }, { slices: 3 }, { aud: true, slices: 2 }]) {
    const expected = syntheticStream(opt);
    const whole = Buffer.concat(expected.map((a) => a.data));
    for (const chunk of [1, 2, 3, 7, 64, whole.length]) {
      const got = [];
      const sp = new proto.AnnexBSplitter((au) => got.push(au));
      for (let i = 0; i < whole.length; i += chunk) sp.push(whole.subarray(i, i + chunk));
      sp.flush();
      assert.strictEqual(got.length, expected.length, `opt ${JSON.stringify(opt)} chunk ${chunk}`);
      got.forEach((au, i) => {
        assert.strictEqual(au.isKey, expected[i].isKey);
        assert.ok(au.data.equals(expected[i].data), `AU ${i} bytes (chunk ${chunk})`);
      });
    }
  }
});

test('Annex B splitter: an AU is emitted as soon as the next one starts; garbage prefix ignored', () => {
  const [a, b] = syntheticStream({ slices: 1 });
  const got = [];
  const sp = new proto.AnnexBSplitter((au) => got.push(au));
  sp.push(Buffer.concat([Buffer.from([7, 7, 7]), a.data]));
  assert.strictEqual(got.length, 0);
  sp.push(b.data.subarray(0, 6));
  assert.strictEqual(got.length, 1);
  assert.ok(got[0].data.equals(a.data));
});

// ---------------------------------------------------------------------------
// Input (xdotool)
// ---------------------------------------------------------------------------
const MONS = [
  { index: 0, x: 0, y: 180, width: 1920, height: 1080 },
  { index: 1, x: 1920, y: 0, width: 2560, height: 1440 }
];
const bounds = async (i) => (i === -1 ? { x: 0, y: 0, width: 4480, height: 1440 } : MONS[i] || MONS[0]);

function inputRig() {
  const sys = createMockSys({ tools: ['xdotool'], responders: [['xdotool getmouselocation', { stdout: 'x:100 y:300 screen:0 window:1\n' }]] });
  const xdo = new Xdo(sys);
  xdo.mode = 'spawn';
  const ran = [];
  xdo.run = (args) => ran.push(args.join(' '));
  const inp = new InputController(sys, xdo, bounds);
  return { sys, xdo, inp, ran };
}

test('send_input: absolute moves, clicks, buttons on monitor offsets', async () => {
  const { inp, ran } = inputRig();
  assert.deepStrictEqual(await inp.handle({ type: 'mouse_move_abs', x: 0.5, y: 0.5, monitorIndex: 1 }), { ok: true, normX: 0.5, normY: 0.5 });
  await inp.handle({ type: 'mouse_click', x: 1, y: 0, monitorIndex: 0, button: 'left', double: true });
  await inp.handle({ type: 'mouse_click', button: 'right' });
  await inp.handle({ type: 'mouse_down', button: 'middle' });
  await inp.handle({ type: 'mouse_up' });
  assert.deepStrictEqual(ran, [
    'mousemove -- 3200 720',
    'mousemove -- 1919 180', // x=1.0 stays on this monitor
    'click --repeat 2 --delay 25 1',
    'click 3',
    'mousedown 2',
    'mouseup 1'
  ]);
  assert.deepStrictEqual(await inp.handle({ type: 'bogus' }), { ok: false });
});

test('send_input: relative move clamps to the virtual desktop and reports normalized position', async () => {
  const { inp, ran } = inputRig();
  const r = await inp.handle({ type: 'mouse_move_rel', dx: -500, dy: 20 });
  assert.deepStrictEqual(ran, ['mousemove -- 0 320']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.normX, 0);
});

test('send_input: wheel 120 units per notch with remainder, horizontal buttons', async () => {
  const { inp, ran } = inputRig();
  await inp.handle({ type: 'mouse_scroll', deltaY: 120 });
  await inp.handle({ type: 'mouse_scroll', deltaY: -240 });
  await inp.handle({ type: 'mouse_scroll', deltaY: 60 });
  await inp.handle({ type: 'mouse_scroll', deltaY: 60, deltaX: -120 });
  assert.deepStrictEqual(ran, ['click --repeat 1 4', 'click --repeat 2 5', 'click --repeat 1 4', 'click --repeat 1 6']);
});

test('send_input: key combos, media keys, text, CTRL+SHIFT+ESC hook', async () => {
  const { inp, ran, sys } = inputRig();
  let hooked = 0;
  inp.hooks.onKeyCombo = async (c) => c === 'CTRL+SHIFT+ESC' && ++hooked > 0;
  await inp.handle({ type: 'key', key: 'WIN+D' });
  await inp.handle({ type: 'key', key: 'media_play_pause' });
  await inp.handle({ type: 'key', key: 'BACKSPACE' });
  await inp.handle({ type: 'key', key: 'CTRL+SHIFT+ESC' });
  await inp.handle({ type: 'text', text: 'Merhaba dünya "x"' });
  assert.deepStrictEqual(ran, ['key --clearmodifiers super+d', 'key --clearmodifiers XF86AudioPlay', 'key --clearmodifiers BackSpace']);
  assert.strictEqual(hooked, 1);
  const typed = sys.calls.find((c) => c.args[0] === 'type');
  assert.deepStrictEqual(typed.args.slice(-2), ['--', 'Merhaba dünya "x"']);
});

test('touch emulation: tap, long press, swipe scroll, hold-then-drag', async () => {
  const { inp, ran, sys } = inputRig();
  const t = (phase, x, y, extra = {}) => inp.handle({ type: 'touch', phase, id: 0, x, y, monitorIndex: 0, ...extra });
  // tap
  assert.deepStrictEqual(await t('down', 0.5, 0.5), { ok: true, mode: 'mouse' });
  sys.advance(80);
  await t('up', 0.5, 0.5);
  assert.deepStrictEqual(ran.splice(0), ['mousemove -- 960 720', 'click 1']);
  // long press -> right click
  await t('down', 0.25, 0.25);
  sys.advance(600);
  await t('up', 0.25, 0.25);
  assert.deepStrictEqual(ran.splice(0), ['mousemove -- 480 450', 'click 3']);
  // quick swipe up by 100 px -> content scrolls down (button 5), no click
  await t('down', 0.5, 0.5);
  for (let i = 1; i <= 10; i++) {
    sys.advance(10);
    await t('move', 0.5, 0.5 - (i * 10) / 1080);
  }
  await t('up', 0.5, 0.5 - 100 / 1080);
  const swipe = ran.splice(0);
  assert.ok(swipe.some((c) => /^click --repeat \d+ 5$/.test(c)), swipe.join('|'));
  assert.ok(!swipe.includes('click 1'));
  // hold 500 ms then move -> drag with left button
  await t('down', 0.1, 0.1);
  sys.advance(500);
  await t('move', 0.2, 0.1);
  await t('move', 0.3, 0.1);
  await t('up', 0.3, 0.1);
  assert.deepStrictEqual(ran.splice(0), ['mousemove -- 192 288', 'mousemove -- 192 288', 'mousedown 1', 'mousemove -- 384 288', 'mousemove -- 576 288', 'mousemove -- 576 288', 'mouseup 1']);
  // second finger is ignored, cancel never clicks
  await t('down', 0.5, 0.5, { id: 1 });
  await t('down', 0.5, 0.5);
  await t('cancel', 0.5, 0.5);
  assert.deepStrictEqual(ran.splice(0), ['mousemove -- 960 720']);
});

test('xdotool driver: pipe mode when "xdotool -" answers the probe, coalescing spawn mode otherwise', async () => {
  // pipe mode
  const sysA = createMockSys({
    tools: ['xdotool'],
    onSpawn: () => {
      const p = new FakeProc();
      p.on('stdin', (l) => {
        if (l.startsWith('getmouselocation')) setImmediate(() => p.stdout.emit('data', Buffer.from('x:5 y:6 screen:0 window:9\n')));
      });
      return p;
    }
  });
  const a = new Xdo(sysA);
  await a.start();
  assert.strictEqual(a.mode, 'pipe');
  a.run(['mousemove', '--', '1', '2']);
  assert.ok(sysA.spawned[0].written.includes('mousemove -- 1 2\n'));
  assert.deepStrictEqual(await a.getMouseLocation(), { x: 5, y: 6 });
  // buffered xdotool (no probe answer) -> spawn mode
  const sysB = createMockSys({ tools: ['xdotool'] });
  const b = new Xdo(sysB);
  await b.start();
  assert.strictEqual(b.mode, 'spawn');
  b.run(['mousemove', '--', '1', '1']);
  b.run(['mousemove', '--', '2', '2']);
  b.run(['mousemove', '--', '3', '3']);
  b.run(['click', '1']);
  await tick(20);
  assert.deepStrictEqual(sysB.calls.map((c) => c.line), ['xdotool mousemove -- 1 1', 'xdotool mousemove -- 3 3', 'xdotool click 1']);
  // missing xdotool
  const c = new Xdo(createMockSys({ tools: [] }));
  await c.start();
  assert.throws(() => c.run(['click', '1']), /xdotool.*bulunamadı/);
});

// ---------------------------------------------------------------------------
// Desktop: monitors, windows, apps, files, launching
// ---------------------------------------------------------------------------
function desktopRig(extra = {}) {
  const files = {
    '/proc/2001/comm': 'gnome-terminal-\n',
    '/proc/2002/comm': 'firefox\n',
    '/proc/2003/comm': 'gedit\n',
    '/usr/share/applications/firefox.desktop': DESKTOP_FIREFOX,
    '/usr/share/applications/helper.desktop': DESKTOP_HIDDEN,
    '/home/taha/.local/share/applications/quoted.desktop': DESKTOP_QUOTED,
    '/usr/share/icons/hicolor/128x128/apps/firefox.png': PNG_1PX,
    '/home/taha/Desktop/notes.txt': 'hello',
    '/home/taha/Desktop/run.sh': '#!/bin/sh',
    '/home/taha/Desktop/.hidden': 'x',
    '/proc/mounts': '/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /media/taha/USB\\040Disk vfat rw 0 0\n',
    ...(extra.files || {})
  };
  const fs = createMockFs(files, ['/home/taha/Desktop/Projects', '/media/taha/USB Disk']);
  fs.links.set('/proc/2002/exe', '/usr/lib/firefox/firefox');
  const sys = createMockSys({
    fs,
    tools: ['xrandr', 'xprop', 'wmctrl', 'xdotool', 'xset', 'gtk-launch', 'xdg-open', 'brightnessctl', 'pkill'],
    responders: [
      ['xrandr --query', { stdout: XRANDR_DUAL }],
      ['xprop -root _NET_WORKAREA', { stdout: '_NET_WORKAREA(CARDINAL) = 0, 27, 4480, 1413' }],
      ['wmctrl -lpG', { stdout: WMCTRL }],
      ['xprop -id 0x04000007 _NET_WM_STATE', { stdout: '_NET_WM_STATE(ATOM) = _NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_MAXIMIZED_HORZ' }],
      ['xprop -id 0x03a00003 _NET_WM_STATE', { stdout: '_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN' }],
      ...(extra.responders || [])
    ]
  });
  return { sys, d: createDesktop(sys) };
}

test('get_monitors: MonitorData shape, work area, brightness/blackout flags', async () => {
  const { d, sys } = desktopRig();
  const m = await d.getMonitors();
  assert.deepStrictEqual(Object.keys(m[0]).sort(), ['brightness', 'deviceName', 'friendlyName', 'height', 'id', 'index', 'isBlackedOut', 'isPrimary', 'width', 'workHeight', 'workWidth', 'workX', 'workY', 'x', 'y'].sort());
  assert.deepStrictEqual([m[0].id, m[0].deviceName, m[0].isPrimary, m[0].y, m[0].workY, m[0].workHeight], ['MON_1', 'eDP-1', true, 180, 180, 1080]);
  assert.deepStrictEqual([m[1].id, m[1].x, m[1].workY, m[1].workHeight], ['MON_2', 1920, 27, 1413]);
  // blackout uses gamma 0 and is reported
  const after = await d.monitorBlackout({ monitorIndex: 1, mode: 'on' });
  assert.strictEqual(after[1].isBlackedOut, true);
  assert.ok(sys.calls.some((c) => c.line === 'xrandr --output HDMI-1 --brightness 0.00'));
  const toggled = await d.monitorBlackout({ monitorIndex: 1 });
  assert.strictEqual(toggled[1].isBlackedOut, false);
  await assert.rejects(d.monitorBlackout({ monitorIndex: 5, mode: 'on' }), /Geçersiz monitör indeksi: 5/);
  // brightness: internal panel -> brightnessctl, external -> gamma
  await d.setBrightness(-1, 40);
  assert.ok(sys.calls.some((c) => c.line === 'brightnessctl set 40%'));
  assert.ok(sys.calls.some((c) => c.line === 'xrandr --output HDMI-1 --brightness 0.40'));
  assert.strictEqual((await d.getMonitors())[1].brightness, 40);
  // monitor_power
  assert.deepStrictEqual(await d.monitorPower({ action: 'on' }), { status: 'monitors_awake' });
  assert.ok(sys.calls.some((c) => c.line === 'xset dpms force on'));
  assert.deepStrictEqual(await d.monitorPower({ action: 'off' }), { status: 'monitors_sleeping' });
  await tick(120);
  assert.ok(sys.calls.some((c) => c.line === 'xset dpms force off'));
});

test('display_topology: xrandr arguments per mode', async () => {
  const { d, sys } = desktopRig();
  await d.displayTopology({ mode: 'internal' });
  await d.displayTopology({ mode: 'clone' });
  await d.displayTopology({ mode: 'extend' });
  const runs = sys.calls.filter((c) => c.cmd === 'xrandr' && c.args[0] === '--output').map((c) => c.line);
  assert.deepStrictEqual(runs, [
    'xrandr --output eDP-1 --auto --primary --output HDMI-1 --off --output DP-2 --off',
    'xrandr --output eDP-1 --auto --output HDMI-1 --auto --same-as eDP-1 --output DP-2 --auto --same-as eDP-1',
    'xrandr --output eDP-1 --auto --output HDMI-1 --auto --right-of eDP-1 --output DP-2 --auto --right-of HDMI-1'
  ]);
});

test('get_windows: shape, panels skipped, states, monitor, background detection', async () => {
  const { d } = desktopRig();
  const w = await d.getWindows();
  assert.strictEqual(w.length, 3);
  const keys = ['hwnd', 'title', 'processName', 'rawProcessName', 'exePath', 'icon', 'pid', 'monitorIndex', 'state', 'zOrder', 'isBackground', 'backgroundReason', 'isTopMost', 'rect', 'normalized', 'zonePreset'];
  assert.deepStrictEqual(Object.keys(w[0]), keys);
  const ff = w.find((x) => x.processName === 'firefox');
  assert.deepStrictEqual([ff.state, ff.zonePreset, ff.monitorIndex, ff.exePath], ['maximized', 'fullscreen', 0, '/usr/lib/firefox/firefox']);
  assert.ok(ff.icon.startsWith('data:image/png;base64,'));
  const term = w.find((x) => x.pid === 2001);
  assert.deepStrictEqual([term.state, term.isBackground, term.backgroundReason], ['minimized', true, 'Simge Durumunda']);
  const notes = w.find((x) => x.pid === 2003);
  assert.deepStrictEqual([notes.monitorIndex, notes.isBackground], [1, false]);
  assert.strictEqual(w[0].pid, 2003); // topmost first
});

test('snap / focus / close / window_action map to wmctrl', async () => {
  const { d, sys } = desktopRig();
  const r = await d.snapWindow({ hwnd: 0x04200001, monitorIndex: 1, zonePreset: 'right-half' });
  assert.deepStrictEqual(r, { snapped: true, hwnd: 0x04200001, monitorIndex: 1, rect: { x: 3200, y: 27, width: 1280, height: 1413 } });
  const m = await d.snapWindow({ processName: 'firefox', monitorIndex: 0, state: 'maximized', x: 0, y: 0, w: 1, h: 1 });
  assert.deepStrictEqual(m, { snapped: true, hwnd: 0x04000007, state: 'maximized', monitorIndex: 0 });
  assert.deepStrictEqual(await d.snapWindow({ processName: 'nothing' }), { snapped: false, reason: 'window_not_found' });
  await d.focusWindow({ hwnd: 0x04200001 });
  await d.closeWindow({ hwnd: 0x04200001 });
  assert.deepStrictEqual(await d.windowAction({ hwnd: 0x04200001, action: 'toggle_topmost', topMost: true }), { ok: true, action: 'toggle_topmost', isTopMost: true });
  await d.windowAction({ hwnd: 0x04200001, action: 'minimize' });
  const lines = sys.calls.filter((c) => c.cmd === 'wmctrl' && c.args[0] === '-i').map((c) => c.line);
  assert.deepStrictEqual(lines.slice(0, 3), ['wmctrl -i -r 0x04200001 -b remove,maximized_vert,maximized_horz,fullscreen', 'wmctrl -i -r 0x04200001 -e 0,3200,27,1280,1413', 'wmctrl -i -a 0x04200001']);
  assert.ok(lines.includes('wmctrl -i -r 0x04000007 -b add,maximized_vert,maximized_horz'));
  assert.ok(lines.includes('wmctrl -i -c 0x04200001'));
  assert.ok(lines.includes('wmctrl -i -r 0x04200001 -b add,above'));
  assert.ok(sys.calls.some((c) => c.line === 'xdotool windowminimize ' + 0x04200001));
});

test('get_installed_apps: .desktop scan, hidden skipped, icons, launch shape', () => {
  const { d } = desktopRig();
  const apps = d.getInstalledApps();
  assert.deepStrictEqual(apps.map((a) => a.name), ['Firefox Web Tarayıcısı', 'Quoted']);
  const ff = apps[0];
  assert.deepStrictEqual([ff.processName, ff.launchPath, ff.launchArgs, ff.source], ['firefox', '/usr/share/applications/firefox.desktop', '', 'desktop']);
  assert.ok(ff.icon.startsWith('data:image/png;base64,'));
  assert.strictEqual(apps[1].icon, ''); // icon path does not exist
});

test('execute_quick_item: .desktop via gtk-launch, URLs/folders via xdg-open, executables, errors', async () => {
  const { d, sys } = desktopRig();
  const r = await d.executeQuickItem({ targetPath: '/usr/share/applications/firefox.desktop' });
  assert.deepStrictEqual(r, { ok: true, targetPath: '/usr/share/applications/firefox.desktop', openWithPath: '', hwnd: 0, processName: 'firefox' });
  await d.executeQuickItem({ targetPath: '/home/taha/.local/share/applications/quoted.desktop', arguments: '--x' });
  await d.executeQuickItem({ targetPath: 'https://example.com' });
  await d.executeQuickItem({ targetPath: '/home/taha/Desktop/Projects' });
  await d.executeQuickItem({ targetPath: '/home/taha/Desktop/run.sh', arguments: '"a b" c' });
  await d.executeQuickItem({ targetPath: '/home/taha/Desktop/notes.txt', openWithMode: 'custom', openWithPath: '/usr/bin/gedit' });
  assert.deepStrictEqual(sys.detached, [
    'gtk-launch firefox',
    '/opt/My App/run --flag a b --x',
    'xdg-open https://example.com',
    'xdg-open /home/taha/Desktop/Projects',
    '/home/taha/Desktop/run.sh a b c',
    '/usr/bin/gedit /home/taha/Desktop/notes.txt'
  ]);
  assert.deepStrictEqual(await d.executeQuickItem({ targetPath: '' }), { ok: false, error: 'Hedef yol boş' });
  assert.strictEqual((await d.executeQuickItem({ targetPath: '/nope/x' })).ok, false);
  const focus = await d.executeQuickItem({ targetPath: '/usr/share/applications/firefox.desktop', ifRunning: 'focus' });
  assert.deepStrictEqual([focus.mode, focus.hwnd], ['reused_existing', 0x04000007]);
});

test('browse_fs / inspect_target / get_file_icon shapes', () => {
  const { d } = desktopRig();
  const b = d.browseFs({});
  assert.strictEqual(b.currentPath, '/home/taha/Desktop');
  assert.strictEqual(b.parentPath, '/home/taha');
  assert.deepStrictEqual(b.entries.map((e) => [e.name, e.targetType, e.ext]), [
    ['Projects', 'folder', 'KLASÖR'],
    ['notes.txt', 'file', 'TXT'],
    ['run.sh', 'app', 'SH']
  ]);
  assert.deepStrictEqual(Object.keys(b.entries[1]), ['name', 'path', 'isDir', 'targetType', 'ext', 'sizeBytes', 'sizeFormatted', 'modifiedAt', 'defaultAppName', 'defaultAppExe']);
  assert.strictEqual(b.entries[1].modifiedAt, '02.01.2026 03:04');
  assert.ok(b.roots.some((r) => r.path === '/media/taha/USB Disk' && r.kind === 'drive'));
  assert.strictEqual(d.browseFs({ path: '/home/taha/Desktop', query: 'NOT' }).entries.length, 1);
  assert.strictEqual(d.browseFs({ path: '/does/not/exist' }).currentPath, '/home/taha/Desktop');
  const i = d.inspectTarget({ path: '/home/taha/Desktop/notes.txt' });
  assert.deepStrictEqual([i.exists, i.name, i.extension, i.sizeBytes, i.sizeFormatted, i.directory], [true, 'notes.txt', 'TXT', 5, '5 B', '/home/taha/Desktop']);
  assert.strictEqual(d.inspectTarget({ path: 'https://x.y' }).targetType, 'url');
  assert.strictEqual(d.inspectTarget({ path: '/home/taha/Desktop' }).sizeFormatted, '1 klasör, 3 dosya');
  assert.ok(d.getFileIcon({ path: '/usr/share/applications/firefox.desktop' }).icon.startsWith('data:image/png'));
});

// ---------------------------------------------------------------------------
// Audio + system
// ---------------------------------------------------------------------------
function systemRig(env = {}, extraResponders = []) {
  const files = { '/proc/stat': PROC_STAT_1, '/proc/meminfo': MEMINFO, '/proc/uptime': '3600.5 100\n' };
  const fs = createMockFs(files);
  let clip = 'kopya metin';
  const sys = createMockSys({
    fs,
    env,
    tools: ['xrandr', 'pactl', 'playerctl', 'loginctl', 'systemctl', 'xclip', 'xdotool', 'gio', 'xdg-open', 'xterm'],
    responders: [
      ...extraResponders,
      ['xclip -selection clipboard -i', (c, a, o) => ((clip = String(o.input)), {})],
      ['xclip -selection clipboard -o', () => ({ stdout: clip })],
      ['xrandr --query', { stdout: XRANDR_XVFB }],
      ['pactl get-sink-volume @DEFAULT_SINK@', { stdout: PACTL_VOL }],
      ['pactl get-sink-mute @DEFAULT_SINK@', { stdout: 'Mute: no\n' }],
      ['pactl list sink-inputs', { stdout: PACTL_SINK_INPUTS }],
      ['playerctl -a metadata', { stdout: PLAYERCTL }],
    ]
  });
  const d = createDesktop(sys);
  const ran = [];
  const fakeInput = { handle: async (a) => ran.push(a) };
  return { sys, fs, s: createSystem(sys, d, fakeInput), ran };
}

test('stats: cpu/memory/uptime/isLocked shape', async () => {
  const { s, fs } = systemRig({ TAHABLT_POWER_DRYRUN: '1' });
  setTimeout(() => fs.writeFileSync('/proc/stat', PROC_STAT_2), 30);
  const st = await s.systemControl({ action: 'stats' });
  assert.deepStrictEqual(Object.keys(st), ['machineName', 'userName', 'cpuPercent', 'memoryPercent', 'usedRamGb', 'totalRamGb', 'uptimeSeconds', 'isLocked', 'brightness', 'battery', 'disks']);
  assert.deepStrictEqual([st.cpuPercent, st.memoryPercent, st.uptimeSeconds, st.isLocked, st.machineName], [40, 63, 3600, false, 'ci-host']);
  assert.deepStrictEqual(await s.systemControl({}), { ...st, cpuPercent: 0 }); // default action = stats
});

test('audio get: master, sessions, nowPlaying from playerctl', async () => {
  const { s } = systemRig();
  const a = await s.audioControl({ action: 'get' });
  assert.deepStrictEqual(Object.keys(a), ['masterVolume', 'masterMuted', 'micVolume', 'micMuted', 'hasMic', 'outputDevices', 'inputDevices', 'sessions', 'nowPlaying']);
  assert.deepStrictEqual([a.masterVolume, a.masterMuted, a.sessions.length], [65, false, 2]);
  assert.deepStrictEqual(Object.keys(a.sessions[0]).filter((k) => k !== 'sinkInputId'), ['pid', 'processName', 'rawProcessName', 'icon', 'volume', 'muted', 'isActive']);
  const np = a.nowPlaying;
  assert.deepStrictEqual([np.active, np.isPlaying, np.title, np.appName, np.processName, np.pid, np.positionSec, np.durationSec], [true, true, 'The Artist - Song Title', 'Spotify', 'spotify', 3100, 61.25, 215]);
});

test('audio: no players / no pulse -> Windows-like fallback shapes', async () => {
  const { s } = systemRig({}, []);
  const sys2 = createMockSys({ tools: [] });
  const s2 = createSystem(sys2, createDesktop(sys2), { handle: async () => {} });
  const a = await s2.audioControl({ action: 'get' });
  assert.deepStrictEqual([a.masterVolume, a.masterMuted, a.sessions.length, a.nowPlaying.active, a.nowPlaying.title], [50, false, 0, false, 'Medya Oynatılmıyor']);
  assert.match(a.warning, /pactl/);
  void s;
});

test('audio: set_master / set_app / media_command / seek commands', async () => {
  const { s, sys, ran } = systemRig();
  await s.audioControl({ action: 'set_master', volume: 33, muted: true });
  await s.audioControl({ action: 'set_app', processName: 'firefox', volume: 10 });
  await s.audioControl({ action: 'set_app', pid: 3100, muted: false });
  await s.audioControl({ action: 'media_command', key: 'MEDIA_NEXT' });
  await s.audioControl({ action: 'seek', positionSec: 90 });
  const lines = sys.calls.map((c) => c.line);
  for (const l of [
    'pactl set-sink-volume @DEFAULT_SINK@ 33%',
    'pactl set-sink-mute @DEFAULT_SINK@ 1',
    'pactl set-sink-input-volume 57 10%',
    'pactl set-sink-input-mute 58 0',
    'playerctl -p spotify next',
    'playerctl -p spotify position 90'
  ]) {
    assert.ok(lines.includes(l), 'missing ' + l);
  }
  assert.strictEqual(ran.length, 0);
  // no MPRIS player -> media key through xdotool
  const r2 = systemRig({}, [['playerctl -a metadata', { code: 1, stderr: 'No players found' }]]);
  await r2.s.systemControl({ action: 'media_key', key: 'media_play_pause' });
  assert.deepStrictEqual(r2.ran, [{ type: 'key', key: 'MEDIA_PLAY_PAUSE' }]);
});

test('power: dry-run logs exact commands (force -> -i), lock state tracked', async () => {
  const { s, sys, fs } = systemRig({ TAHABLT_POWER_DRYRUN: '1', TAHABLT_POWER_LOG: '/tmp/power.log' });
  assert.deepStrictEqual(await s.systemControl({ action: 'lock' }), { ok: true, action: 'lock', isLocked: true });
  assert.strictEqual((await s.stats()).isLocked, true);
  assert.deepStrictEqual(await s.systemControl({ action: 'toggle_lock' }), { ok: true, action: 'unlock', isLocked: false });
  await s.systemControl({ action: 'sleep' });
  await s.systemControl({ action: 'hibernate' });
  const sd = await s.systemControl({ action: 'shutdown' });
  await s.systemControl({ action: 'shutdown', mode: 'force' });
  await s.systemControl({ action: 'restart' });
  await s.systemControl({ action: 'restart', mode: 'force' });
  assert.deepStrictEqual([sd.ok, sd.action, sd.dryRun, sd.command], [true, 'shutdown', true, 'systemctl poweroff']);
  const log = fs.readFileSync('/tmp/power.log', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(log.map((l) => l.command), [
    'loginctl lock-session',
    'loginctl unlock-session',
    'systemctl suspend',
    'systemctl hibernate',
    'systemctl poweroff',
    'systemctl poweroff -i',
    'systemctl reboot',
    'systemctl reboot -i'
  ]);
  assert.ok(!sys.calls.some((c) => c.cmd === 'systemctl' || c.cmd === 'loginctl'), 'dry run must not execute');
});

test('power: real mode executes systemctl after the reply', async () => {
  const { s, sys } = systemRig({ XDG_SESSION_ID: 'c2' });
  await s.systemControl({ action: 'lock' });
  assert.ok(sys.calls.some((c) => c.line === 'loginctl lock-session c2'));
  await s.systemControl({ action: 'restart', mode: 'force' });
  assert.ok(!sys.calls.some((c) => c.cmd === 'systemctl'));
  await tick(150);
  assert.ok(sys.calls.some((c) => c.line === 'systemctl reboot -i'));
});

test('system_control: clipboard, open_url, task manager, recycle bin, optimize', async () => {
  const { s, sys, ran } = systemRig({ TAHABLT_DATA_DIR: '/data' });
  const g = await s.systemControl({ action: 'get_clipboard' });
  assert.strictEqual(g.text, 'kopya metin');
  assert.deepStrictEqual(Object.keys(g.history[0]), ['id', 'type', 'text', 'time', 'charCount']);
  await s.systemControl({ action: 'set_clipboard', text: 'yeni' });
  const set = sys.calls.find((c) => c.line === 'xclip -selection clipboard -i');
  assert.deepStrictEqual([set.opts.input, set.opts.waitExit], ['yeni', true]);
  const h = await s.systemControl({ action: 'get_clipboard_history' });
  assert.deepStrictEqual(h.items.map((x) => x.text), ['yeni', 'kopya metin']);
  assert.ok(sys.fs.existsSync('/data/clipboard_history.json'));
  assert.deepStrictEqual(await s.systemControl({ action: 'clear_clipboard_history' }), { ok: true, history: [] });
  assert.deepStrictEqual(await s.systemControl({ action: 'open_url', url: 'example.com' }), { ok: true, url: 'https://example.com' });
  await s.systemControl({ action: 'task_manager' });
  await s.systemControl({ action: 'show_desktop' });
  assert.deepStrictEqual(await s.systemControl({ action: 'optimize_memory' }), { ok: true, trimmedProcesses: 0 });
  await s.systemControl({ action: 'empty_recycle_bin' });
  assert.deepStrictEqual(sys.detached, ['xdg-open https://example.com', 'xterm -e top']);
  assert.deepStrictEqual(ran, [{ type: 'key', key: 'WIN+D' }]);
  assert.ok(sys.calls.some((c) => c.line === 'gio trash --empty'));
  const br = await s.systemControl({ action: 'set_brightness', brightness: 70, monitorIndex: 0 });
  assert.deepStrictEqual([br.ok, br.brightness, br.monitors[0].brightness], [true, 70, 70]);
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------
test('stream geometry and ffmpeg arguments', () => {
  const g = stream.computeGeometry({ width: 3840, height: 2160 }, { maxCanvasWidth: 2560, videoMaxWidth: 1920 });
  assert.deepStrictEqual(g, { canvasW: 2560, canvasH: 1440, videoW: 1920, videoH: 1080 });
  const args = stream.buildVideoArgs({ display: ':99', mon: { x: 1920, y: 0, width: 3840, height: 2160 }, fps: 30, kbps: 8000, videoW: 1920, videoH: 1080, vaapi: false });
  const s = args.join(' ');
  for (const part of ['-f x11grab', '-draw_mouse 1', '-framerate 30', '-video_size 3840x2160', '-i :99+1920,0', 'scale=1920:1080', '-c:v libx264', '-preset ultrafast', '-tune zerolatency', '-bf 0', '-g 60', '-pix_fmt yuv420p', '-b:v 8000k', '-x264-params repeat-headers=1', '-f h264 pipe:1']) {
    assert.ok(s.includes(part), 'missing ' + part);
  }
  const va = stream.buildVideoArgs({ display: ':0', mon: { x: 0, y: 0, width: 1920, height: 1080 }, fps: 60, kbps: 12000, videoW: 1920, videoH: 1080, vaapi: true }).join(' ');
  assert.ok(va.includes('-vaapi_device /dev/dri/renderD128') && va.includes('-c:v h264_vaapi') && va.includes('hwupload'));
  const j = stream.buildJpegArgs(':99', { x: 0, y: 0, width: 1920, height: 1080 }, 1280, 720, 70).join(' ');
  assert.ok(j.includes('-frames:v 1') && j.includes('-f mjpeg') && j.includes('scale=1280:720') && j.includes('-q:v 11'));
});

// Fake ffmpeg that writes the synthetic H.264 stream, one AU per write
function fakeFfmpegSys() {
  const aus = syntheticStream({ slices: 2 });
  const sys = createMockSys({
    tools: ['ffmpeg'],
    onSpawn: (cmd) => {
      const p = new FakeProc();
      if (cmd === 'ffmpeg') {
        let i = 0;
        const timer = setInterval(() => {
          if (p.killed) return clearInterval(timer);
          p.stdout.emit('data', aus[i % aus.length].data);
          i++;
        }, 15);
      }
      return p;
    }
  });
  return { sys, aus };
}

const deps = { getMonitorBounds: async () => ({ x: 0, y: 0, width: 1920, height: 1080 }), getCursor: async () => ({ x: 960, y: 540 }) };
const vreq = (o = {}) => proto.parseStreamRequest(proto.buildStreamRequest({ maxCanvasWidth: 2560, flags: 2, waitMs: 200, videoBitrate100: 80, videoMaxWidth: 2560, fps: 30, ...o }));

test('stream session: first frame is an IDR, then deltas; flags, sizes, idle on timeout', async () => {
  const { sys } = fakeFfmpegSys();
  const s = new stream.StreamSession(sys, deps);
  const f1 = proto.parseFrame(await s.handle(vreq({ mode: 2, waitMs: 0 })));
  assert.strictEqual(f1.flags & 0x181, 0x181, 'video + key + IDR flags');
  assert.deepStrictEqual([f1.canvasW, f1.canvasH, f1.srcW, f1.srcH, f1.rectCount, f1.rects[0].w, f1.rects[0].data.length], [1920, 1080, 1920, 1080, 1, 1920, 0]);
  assert.strictEqual(f1.flags & 0x04, 0, 'cursor is drawn into the video');
  const f2 = proto.parseFrame(await s.handle(vreq()));
  assert.strictEqual(f2.flags & 0x180, 0x80);
  assert.strictEqual(f2.frameId, f1.frameId + 1);
  assert.strictEqual(sys.spawned.length, 1);
  assert.ok(sys.spawned[0].args.includes('libx264'));
  // same config -> same encoder; fps change -> restart
  await s.handle(vreq({ fps: 60, mode: 2 }));
  assert.strictEqual(sys.spawned.length, 2);
  assert.ok(sys.spawned[0].killed);
  s.close();
  assert.ok(sys.spawned[1].killed);
  // nothing produced within waitMs -> idle frame
  const quiet = createMockSys({ tools: ['ffmpeg'] });
  const s2 = new stream.StreamSession(quiet, deps);
  const idle = proto.parseFrame(await s2.handle(vreq({ waitMs: 30 })));
  assert.deepStrictEqual([idle.rectCount, (idle.flags & 0x10) !== 0, idle.video], [0, true, null]);
  s2.close();
});

test('stream session: backlog > 6 AUs and key requests skip to the newest IDR', async () => {
  const sys = createMockSys({ tools: ['ffmpeg'] });
  const s = new stream.StreamSession(sys, deps);
  s.enc = { key: 'k', kbps: 8000, startedAt: sys.now(), gotAu: true, proc: new FakeProc(), cfg: {} };
  const enc = s.enc;
  s.awaitIdr = false;
  const mk = (isKey, n) => ({ data: Buffer.from([n]), isKey });
  [mk(false, 1), mk(true, 2), mk(false, 3), mk(false, 4), mk(true, 5), mk(false, 6), mk(false, 7), mk(false, 8)].forEach((a) => s._onAu(enc, a));
  s._ensureEncoder = () => {};
  const f = proto.parseFrame(await s.handle(vreq()));
  assert.deepStrictEqual([f.video.data[0], (f.flags & 0x100) !== 0], [5, true]);
  assert.strictEqual(s.queue.length, 3);
  // key request with no IDR queued: drop deltas until the next IDR arrives
  s._dropUntilIdr();
  s._onAu(enc, mk(false, 9));
  assert.strictEqual(s.queue.length, 0);
  s._onAu(enc, mk(true, 10));
  assert.strictEqual(s.queue[0].data[0], 10);
  s.close();
});

test('stream session: JPEG fallback when video is not allowed, unchanged screen -> idle', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const sys = createMockSys({ tools: ['ffmpeg'], responders: [[(c, a) => c === 'ffmpeg' && a.includes('mjpeg'), { stdoutBuf: jpeg }]] });
  const s = new stream.StreamSession(sys, deps);
  const f = proto.parseFrame(await s.handle(vreq({ flags: 0, motionScale: 500, mode: 0 })));
  assert.deepStrictEqual([f.flags & 0x81, f.rectCount, f.rects[0].w, f.rects[0].h, f.canvasW], [0x01, 1, 960, 540, 960]);
  assert.ok(f.rects[0].data.equals(jpeg));
  const again = proto.parseFrame(await s.handle(vreq({ flags: 0, waitMs: 10 })));
  assert.strictEqual(again.rectCount, 0);
  s.close();
});

test('stream server over TCP: key gate, request/response framing, missing ffmpeg closes', async () => {
  const { sys } = fakeFfmpegSys();
  const port = await new Promise((resolve) => {
    const srv = stream.startStreamServer(sys, { port: 0, key: KEY, deps, onListening: () => resolve(srv.address().port) });
    after.push(() => srv.close());
  });
  const frames = await new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    const got = [];
    s.on('connect', () => {
      s.write(KEY + '\n');
      s.write(Buffer.concat([proto.buildStreamRequest({ mode: 2, flags: 2, fps: 30, videoMaxWidth: 1920, maxCanvasWidth: 1920 }), proto.buildStreamRequest({ mode: 0, flags: 2, waitMs: 500, fps: 30, videoMaxWidth: 1920, maxCanvasWidth: 1920 })]));
    });
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      let len;
      while ((len = serverMeasure(buf)) > 0) {
        got.push(proto.parseFrame(Buffer.from(buf.subarray(0, len))));
        buf = buf.subarray(len);
      }
      if (got.length === 2) {
        s.destroy();
        resolve(got);
      }
    });
    setTimeout(() => {
      s.destroy();
      resolve(got);
    }, 3000);
  });
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[0].flags & 0x101, 0x101);
  assert.ok(frames[1].video);
  // wrong key: closed without a frame
  const out = await connectAndSend(port, 'bad\n' + proto.buildStreamRequest({ flags: 2 }).toString('latin1'));
  assert.strictEqual(out.length, 0);
  // no ffmpeg: the connection is closed (server.js then sends stream_ended)
  const noff = createMockSys({ tools: [] });
  const port2 = await new Promise((resolve) => {
    const srv = stream.startStreamServer(noff, { port: 0, key: KEY, deps, onListening: () => resolve(srv.address().port) });
    after.push(() => srv.close());
  });
  const closed = await connectAndSend(port2, KEY + '\n' + proto.buildStreamRequest({ flags: 2 }).toString('latin1'));
  assert.strictEqual(closed.length, 0);
  assert.ok(noff.logs.some((l) => /ffmpeg.*bulunamadı/.test(l)));
});

test('capture_screen: shape, scaling, cursor normalization', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const sys = createMockSys({ tools: ['ffmpeg'], responders: [[(c) => c === 'ffmpeg', { stdoutBuf: jpeg }]] });
  const r = await stream.captureScreen(sys, async () => ({ x: 1920, y: 0, width: 2560, height: 1440 }), async () => ({ x: 3200, y: 360 }), { monitorIndex: 1, maxWidth: 1280, quality: 70 });
  assert.deepStrictEqual(r, { monitorIndex: 1, width: 1280, height: 720, sourceWidth: 2560, sourceHeight: 1440, cursorNormX: 0.5, cursorNormY: 0.25, jpeg: jpeg.toString('base64') });
  assert.ok(sys.calls[0].args.join(' ').includes('-i :99+1920,0'));
  const bad = createMockSys({ tools: ['ffmpeg'], responders: [[(c) => c === 'ffmpeg', { code: 1, stderr: 'Cannot open display' }]] });
  await assert.rejects(stream.captureScreen(bad, async () => ({ x: 0, y: 0, width: 10, height: 10 }), async () => null, {}), /Ekran yakalanamadı/);
});

// ---------------------------------------------------------------------------
// Wayland & Multi-Compositor Compatibility Tests
// ---------------------------------------------------------------------------
const { detectGraphicalSession } = require('../../pc-agent/linux/util');

test('wayland session detection: Hyprland, Sway, KDE, GNOME, wlroots, X11', () => {
  const hypr = detectGraphicalSession({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-1', HYPRLAND_INSTANCE_SIGNATURE: 'abc' }, null);
  assert.deepStrictEqual([hypr.isWayland, hypr.sessionType, hypr.compositor], [true, 'wayland', 'hyprland']);
  const sway = detectGraphicalSession({ WAYLAND_DISPLAY: 'wayland-0', SWAYSOCK: '/run/user/1000/sway.sock' }, null);
  assert.deepStrictEqual([sway.isWayland, sway.compositor], [true, 'sway']);
  const kde = detectGraphicalSession({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' }, null);
  assert.deepStrictEqual([kde.isWayland, kde.compositor], [true, 'kde']);
  const gnome = detectGraphicalSession({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, null);
  assert.deepStrictEqual([gnome.isWayland, gnome.compositor], [true, 'gnome']);
  const x11 = detectGraphicalSession({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'XFCE' }, null);
  assert.deepStrictEqual([x11.isWayland, x11.compositor], [false, 'xfce']);
});

test('wayland monitor parsers: Hyprland, Sway, KDE kscreen-doctor, wlr-randr', () => {
  const hyprMons = P.parseHyprMonitors(
    JSON.stringify([
      { id: 0, name: 'eDP-1', width: 1920, height: 1080, x: 0, y: 0, scale: 1, focused: true, reserved: [0, 32, 0, 0] },
      { id: 1, name: 'HDMI-A-1', width: 3840, height: 2160, x: 1920, y: 0, scale: 2, focused: false, reserved: [0, 0, 0, 0] }
    ])
  );
  assert.strictEqual(hyprMons.outputs.length, 2);
  assert.deepStrictEqual([hyprMons.outputs[0].name, hyprMons.outputs[0].workY, hyprMons.outputs[0].workHeight], ['eDP-1', 32, 1048]);
  assert.deepStrictEqual([hyprMons.outputs[1].name, hyprMons.outputs[1].width, hyprMons.outputs[1].height], ['HDMI-A-1', 1920, 1080]);

  const swayMons = P.parseSwayOutputs(
    JSON.stringify([
      { name: 'DP-1', active: true, focused: true, rect: { x: 0, y: 0, width: 2560, height: 1440 } },
      { name: 'HDMI-1', active: false, rect: { x: 0, y: 0, width: 0, height: 0 } }
    ])
  );
  assert.deepStrictEqual([swayMons.outputs[0].name, swayMons.outputs[0].width, swayMons.inactive], ['DP-1', 2560, ['HDMI-1']]);

  const kscreenMons = P.parseKscreenMonitors(
    JSON.stringify({
      outputs: [
        { name: 'eDP-1', connected: true, enabled: true, primary: true, pos: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } },
        { name: 'DP-2', connected: true, enabled: false }
      ]
    })
  );
  assert.deepStrictEqual([kscreenMons.outputs[0].name, kscreenMons.inactive], ['eDP-1', ['DP-2']]);

  const wlrMons = P.parseWlrRandr(`eDP-1 "Monitor 1"\n  Enabled: yes\n  Modes:\n    1920x1080 px, 60.00 Hz (preferred, current)\n  Position: 0,0\nHDMI-A-1 "Monitor 2"\n  Enabled: no\n`);
  assert.deepStrictEqual([wlrMons.outputs[0].name, wlrMons.outputs[0].width, wlrMons.inactive], ['eDP-1', 1920, ['HDMI-A-1']]);
});

test('wayland desktop: Hyprland and Sway monitors, topology, and windows', async () => {
  const hyprClientsJson = JSON.stringify([
    { address: '0x55aabb1122', mapped: true, title: 'Kitty Terminal', class: 'kitty', pid: 4001, at: [20, 50], size: [900, 600], fullscreen: 0, pinned: false, focusHistoryID: 1, workspace: { name: '1' } },
    { address: '0x55aabb3344', mapped: true, title: 'Firefox', class: 'firefox', pid: 4002, at: [0, 0], size: [1920, 1080], fullscreen: 1, pinned: true, focusHistoryID: 0, workspace: { name: '1' } }
  ]);
  const hyprMonsJson = JSON.stringify([
    { id: 0, name: 'eDP-1', width: 1920, height: 1080, x: 0, y: 0, scale: 1, focused: true, reserved: [0, 0, 0, 0] },
    { id: 1, name: 'HDMI-A-1', width: 1920, height: 1080, x: 1920, y: 0, scale: 1, focused: false, reserved: [0, 0, 0, 0] }
  ]);
  const sys = createMockSys({
    env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-1', HYPRLAND_INSTANCE_SIGNATURE: 'sig1' },
    tools: ['hyprctl'],
    responders: [
      ['hyprctl -j monitors all', { stdout: hyprMonsJson }],
      ['hyprctl -j clients', { stdout: hyprClientsJson }]
    ]
  });
  const d = createDesktop(sys);
  const mons = await d.getMonitors();
  assert.strictEqual(mons.length, 2);
  assert.strictEqual(mons[0].deviceName, 'eDP-1');
  await d.displayTopology({ mode: 'clone' });
  assert.ok(sys.calls.some((c) => c.line.includes('hyprctl keyword monitor HDMI-A-1,preferred,auto,1,mirror,eDP-1')));

  const wins = await d.getWindows();
  assert.strictEqual(wins.length, 2);
  assert.strictEqual(wins[0].title, 'Firefox');
  assert.strictEqual(wins[0].state, 'maximized');
  assert.strictEqual(wins[0].isTopMost, true);
  await d.focusWindow({ hwnd: wins[1].hwnd });
  assert.ok(sys.calls.some((c) => c.line === 'hyprctl dispatch focuswindow address:0x55aabb1122'));
  await d.closeWindow({ hwnd: wins[1].hwnd });
  assert.ok(sys.calls.some((c) => c.line === 'hyprctl dispatch closewindow address:0x55aabb1122'));
});

test('wayland input: ydotool / wtype / hyprctl + key_down / key_up / mouse macro tokens', async () => {
  const sys = createMockSys({
    env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-1', HYPRLAND_INSTANCE_SIGNATURE: 'sig1' },
    tools: ['hyprctl', 'ydotool', 'wtype'],
    responders: [['hyprctl cursorpos', { stdout: '400, 300\n' }]]
  });
  const xdo = new Xdo(sys);
  await xdo.start();
  assert.strictEqual(xdo.mode, 'wayland');
  const inp = new InputController(sys, xdo, bounds);
  await inp.handle({ type: 'mouse_move_abs', x: 0.5, y: 0.5, monitorIndex: 0 });
  await inp.handle({ type: 'key_down', key: 'SHIFT+W' });
  await inp.handle({ type: 'key_up', key: 'SHIFT+W' });
  await inp.handle({ type: 'key_down', key: 'MOUSE_LEFT' });
  await inp.handle({ type: 'key_up', key: 'MOUSE_LEFT' });
  await inp.handle({ type: 'text', text: 'Wayland Test' });
  await tick(30);
  const lines = sys.calls.map((c) => c.line);
  assert.ok(lines.includes('hyprctl dispatch movecursor 960 720'));
  assert.ok(lines.includes('wtype -M shift -P w'));
  assert.ok(lines.includes('wtype -p w -m shift'));
  assert.ok(lines.includes('ydotool click 0x40'));
  assert.ok(lines.includes('ydotool click 0x80'));
  assert.ok(lines.includes('wtype -- Wayland Test'));
});

test('wayland clipboard & audio: wl-copy / wl-paste and PipeWire wpctl fallback', async () => {
  let wlClip = 'wayland pano';
  const sys = createMockSys({
    env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', TAHABLT_DATA_DIR: '/data' },
    tools: ['wl-copy', 'wl-paste', 'wpctl'],
    responders: [
      ['wl-paste --no-newline', () => ({ stdout: wlClip })],
      ['wl-copy', (c, a, o) => ((wlClip = String(o.input)), {})],
      ['wpctl get-volume @DEFAULT_AUDIO_SINK@', { stdout: 'Volume: 0.75\n' }],
      ['wpctl get-volume @DEFAULT_AUDIO_SOURCE@', { stdout: 'Volume: 0.50 [MUTED]\n' }]
    ]
  });
  const s = createSystem(sys, createDesktop(sys), { handle: async () => {} });
  const c1 = await s.systemControl({ action: 'get_clipboard' });
  assert.strictEqual(c1.text, 'wayland pano');
  await s.systemControl({ action: 'set_clipboard', text: 'yeni wayland' });
  assert.strictEqual(wlClip, 'yeni wayland');

  const a = await s.audioControl({ action: 'get' });
  assert.deepStrictEqual([a.masterVolume, a.masterMuted, a.micVolume, a.micMuted, a.hasMic], [75, false, 50, true, true]);
  await s.audioControl({ action: 'set_master', volume: 40, muted: true });
  const lines = sys.calls.map((c) => c.line);
  assert.ok(lines.includes('wpctl set-volume @DEFAULT_AUDIO_SINK@ 40%'));
  assert.ok(lines.includes('wpctl set-mute @DEFAULT_AUDIO_SINK@ 1'));
});

test('wayland screen capture: grim JPEG capture and wf-recorder args', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const sys = createMockSys({
    env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-1' },
    tools: ['grim'],
    responders: [[(c) => c === 'grim', { stdoutBuf: jpeg }]]
  });
  const r = await stream.captureScreen(sys, async () => ({ x: 0, y: 0, width: 1920, height: 1080 }), async () => ({ x: 960, y: 540 }), { monitorIndex: 0, maxWidth: 1920, quality: 80 });
  assert.strictEqual(r.jpeg, jpeg.toString('base64'));
  assert.ok(sys.calls.some((c) => c.cmd === 'grim'));
  const wfArgs = stream.buildWfRecorderArgs({ mon: { deviceName: 'eDP-1', x: 0, y: 0, width: 1920, height: 1080 }, fps: 60, videoW: 1920, videoH: 1080, vaapi: false }).join(' ');
  assert.ok(wfArgs.includes('-o eDP-1') && wfArgs.includes('-c libx264') && wfArgs.includes('--file=pipe:1'));
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
const after = [];

(async () => {
  const rows = [];
  for (const t of tests) {
    const started = Date.now();
    try {
      await t.fn();
      rows.push({ ok: true, name: t.name, ms: Date.now() - started });
    } catch (e) {
      rows.push({ ok: false, name: t.name, ms: Date.now() - started, err: e });
    }
  }
  for (const fn of after) fn();
  const width = Math.max(...rows.map((r) => r.name.length));
  console.log('\nLinux bridge unit tests\n' + '-'.repeat(width + 16));
  for (const r of rows) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${String(r.ms).padStart(5)} ms`);
    if (!r.ok) console.log('      ' + String((r.err && r.err.stack) || r.err).split('\n').slice(0, 6).join('\n      '));
  }
  const failed = rows.filter((r) => !r.ok).length;
  console.log('-'.repeat(width + 16) + `\n${rows.length - failed}/${rows.length} passed`);
  process.exit(failed ? 1 : 0);
})();
