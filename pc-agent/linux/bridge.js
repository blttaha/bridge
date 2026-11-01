#!/usr/bin/env node
'use strict';
// Bridge native helper for Linux (X11). Drop-in replacement for native/BridgeHelper.exe:
//  * stdin/stdout: JSON lines  {"id":N,"cmd":"...","args":{}}  ->  {"id":N,"ok":true,"data":...}
//  * 127.0.0.1:TAHABLT_INPUT_PORT  (4853): IPC key line, then send_input JSON lines (fire-and-forget)
//  * 127.0.0.1:TAHABLT_STREAM_PORT (4852): IPC key line, then the TBR3/TBF2 remote desktop protocol
// Uses system tools only (xrandr, xdotool, wmctrl, pactl, playerctl, xclip, ffmpeg, loginctl, systemctl).

const net = require('net');
const readline = require('readline');
const { createSys } = require('./util');
const { createRpcDispatcher, gateSocket, attachInputLineProtocol } = require('./protocol');
const { Xdo, InputController } = require('./input');
const { createDesktop } = require('./desktop');
const { createSystem } = require('./system');
const { captureScreen, startStreamServer } = require('./stream');

// Builds every command handler around one sys object (tests pass a mock)
function createBridge(sys) {
  const desktop = createDesktop(sys);
  const xdo = new Xdo(sys);
  let system = null;
  const input = new InputController(sys, xdo, (i) => desktop.getMonitorBounds(i), {
    // Windows shortcuts that have no X equivalent
    onKeyCombo: async (combo) => {
      if (combo === 'CTRL+SHIFT+ESC') {
        system.openTaskManager();
        return true;
      }
      return false;
    }
  });
  system = createSystem(sys, desktop, input);

  const getCursor = async () => xdo.getMouseLocation();

  const handlers = {
    ping: async () => ({ pong: true, timestamp: sys.now() }),
    get_monitors: () => desktop.getMonitors(),
    monitor_power: (a) => desktop.monitorPower(a),
    monitor_blackout: (a) => desktop.monitorBlackout(a),
    display_topology: (a) => desktop.displayTopology(a),
    get_windows: () => desktop.getWindows(),
    get_installed_apps: async () => desktop.getInstalledApps(),
    snap_window: (a) => desktop.snapWindow(a),
    focus_window: (a) => desktop.focusWindow(a),
    close_window: (a) => desktop.closeWindow(a),
    window_action: (a) => desktop.windowAction(a),
    browse_fs: async (a) => desktop.browseFs(a),
    inspect_target: async (a) => desktop.inspectTarget(a),
    get_file_icon: async (a) => desktop.getFileIcon(a),
    execute_quick_item: (a) => desktop.executeQuickItem(a),
    capture_screen: (a) => captureScreen(sys, (i) => desktop.getMonitorBounds(i), getCursor, a),
    send_input: (a) => input.handle(a),
    audio_control: (a) => system.audioControl(a),
    system_control: (a) => system.systemControl(a),
    wireless_control: (a) => system.wirelessControl(a)
  };

  return { handlers, desktop, system, input, xdo, getCursor };
}

function main() {
  const sys = createSys();
  const ipcKey = sys.env.TAHABLT_IPC_KEY || '';
  const inputPort = Number(sys.env.TAHABLT_INPUT_PORT) || 4853;
  const streamPort = Number(sys.env.TAHABLT_STREAM_PORT) || 4852;

  // A closed stdout (server.js gone) must not crash us with EPIPE; stdin EOF ends the bridge below
  process.stdout.on('error', () => process.exit(0));
  process.on('uncaughtException', (e) => sys.log('beklenmeyen hata:', (e && e.stack) || e));
  process.on('unhandledRejection', (e) => sys.log('beklenmeyen hata:', (e && e.message) || e));

  const sess = typeof sys.session === 'function' ? sys.session() : { sessionType: 'x11', compositor: 'x11' };
  if (!sys.env.DISPLAY && !sess.isWayland) sys.log('DISPLAY ayarlı değil, :0 varsayılıyor');
  sys.log(`Grafik oturumu: ${sess.sessionType} (${sess.compositor})`);
  if (ipcKey.length < 32) sys.log('TAHABLT_IPC_KEY eksik/kısa: giriş ve yayın portları bağlantı kabul etmeyecek');

  const bridge = createBridge(sys);
  bridge.xdo.start();
  bridge.system.startClipboardWatch();
  bridge.desktop.getMonitors().catch((e) => sys.log(e.message));
  setTimeout(() => {
    try {
      bridge.desktop.getInstalledApps(); // warm the .desktop cache like the MSIX pre-warm on Windows
    } catch {}
  }, 500);

  const write = (line) => {
    try {
      process.stdout.write(line + '\n');
    } catch {}
  };
  const dispatch = createRpcDispatcher(bridge.handlers, write, sys.log);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    dispatch(line);
  });
  rl.on('close', () => {
    bridge.xdo.stop();
    process.exit(0);
  });

  // Fast input port
  const inputServer = net.createServer((sock) => {
    sock.setNoDelay(true);
    sock.on('error', () => {});
    gateSocket(sock, ipcKey, (rest) => {
      attachInputLineProtocol(sock, rest, (args) => {
        bridge.input.handle(args).catch(() => {});
      });
    });
  });
  inputServer.on('error', (e) => sys.log(`giriş portu (${inputPort}) açılamadı: ${e.message}`));
  inputServer.listen(inputPort, '127.0.0.1');

  startStreamServer(sys, {
    port: streamPort,
    key: ipcKey,
    deps: { getMonitorBounds: (i) => bridge.desktop.getMonitorBounds(i), getCursor: bridge.getCursor }
  });
}

if (require.main === module) main();

module.exports = { createBridge };
