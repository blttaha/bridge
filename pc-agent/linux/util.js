'use strict';
// Process / filesystem helpers for the Linux bridge. Everything that touches the OS goes through the "sys"
// object built here, so the unit tests can swap it for a mock and run on any platform.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Package that provides each external tool (used in the Turkish "not installed" messages)
const TOOL_PACKAGES = {
  xrandr: 'x11-xserver-utils',
  xset: 'x11-xserver-utils',
  xprop: 'x11-utils',
  xdotool: 'xdotool',
  wmctrl: 'wmctrl',
  xclip: 'xclip',
  xsel: 'xsel',
  'wl-copy': 'wl-clipboard',
  'wl-paste': 'wl-clipboard',
  'wlr-randr': 'wlr-randr',
  wlrctl: 'wlrctl',
  wtype: 'wtype',
  ydotool: 'ydotool',
  dotool: 'dotool',
  kdotool: 'kdotool',
  'kscreen-doctor': 'kscreen',
  hyprctl: 'hyprland',
  swaymsg: 'sway',
  'i3-msg': 'i3-wm',
  grim: 'grim',
  'wf-recorder': 'wf-recorder',
  'gnome-screenshot': 'gnome-screenshot',
  spectacle: 'kde-spectacle',
  pactl: 'pulseaudio-utils',
  wpctl: 'wireplumber',
  playerctl: 'playerctl',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffmpeg',
  brightnessctl: 'brightnessctl',
  ddcutil: 'ddcutil',
  loginctl: 'systemd',
  systemctl: 'systemd',
  'gtk-launch': 'libgtk-3-bin',
  'xdg-open': 'xdg-utils',
  gio: 'libglib2.0-bin'
};

class ToolMissingError extends Error {
  constructor(tool) {
    const pkg = TOOL_PACKAGES[tool];
    super(`'${tool}' aracı bulunamadı. Kurmak için: sudo apt install ${pkg || tool}`);
    this.code = 'TOOL_MISSING';
    this.tool = tool;
  }
}

function missingToolMessage(tool) {
  return new ToolMissingError(tool).message;
}

// Detects the active Linux graphical session (Wayland vs X11) and compositor/DE family
// (hyprland, sway, kde, gnome, wlroots, i3, cinnamon, xfce, mate, x11).
// Also auto-discovers display sockets from /run/user/<uid> and /tmp/.X11-unix when started by systemd linger.
function detectGraphicalSession(env = process.env, fsImpl = fs) {
  const e = env || {};
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const runtimeDir = e.XDG_RUNTIME_DIR || `/run/user/${uid}`;

  let waylandDisplay = e.WAYLAND_DISPLAY || '';
  let x11Display = e.DISPLAY || '';
  let hyprSig = e.HYPRLAND_INSTANCE_SIGNATURE || '';
  let swaySock = e.SWAYSOCK || '';
  let i3Sock = e.I3SOCK || '';
  let xauthority = e.XAUTHORITY || '';

  // Auto-discover sockets from XDG_RUNTIME_DIR if systemd user service started before the DM session
  try {
    if (fsImpl && typeof fsImpl.readdirSync === 'function') {
      const runEntries = fsImpl.readdirSync(runtimeDir);
      if (!waylandDisplay) {
        const wl = runEntries.find((n) => /^wayland-\d+$/.test(n));
        if (wl) waylandDisplay = wl;
      }
      if (!swaySock) {
        const sw = runEntries.find((n) => /^sway-ipc\..*\.sock$/.test(n));
        if (sw) swaySock = path.posix.join(runtimeDir, sw);
      }
      if (!hyprSig && runEntries.includes('hypr')) {
        try {
          const hyprDirs = fsImpl.readdirSync(path.posix.join(runtimeDir, 'hypr'));
          if (hyprDirs.length > 0) hyprSig = hyprDirs[0];
        } catch {}
      }
      if (!xauthority) {
        const mutterAuth = runEntries.find((n) => /^\.mutter-Xwaylandauth\./.test(n) || /^xauth_/.test(n));
        if (mutterAuth) xauthority = path.posix.join(runtimeDir, mutterAuth);
      }
    }
  } catch {}

  if (!x11Display) {
    try {
      if (fsImpl && typeof fsImpl.readdirSync === 'function') {
        const xSock = fsImpl.readdirSync('/tmp/.X11-unix').find((n) => /^X\d+$/.test(n));
        if (xSock) x11Display = ':' + xSock.slice(1);
      }
    } catch {}
  }

  const rawType = String(e.XDG_SESSION_TYPE || '').toLowerCase();
  const isWayland = rawType === 'wayland' || Boolean(waylandDisplay && rawType !== 'x11');
  const sessionType = isWayland ? 'wayland' : 'x11';

  const desktopRaw = [e.XDG_CURRENT_DESKTOP, e.DESKTOP_SESSION, e.GDMSESSION, e.XDG_SESSION_DESKTOP]
    .filter(Boolean)
    .join(':')
    .toLowerCase();

  let compositor = isWayland ? 'wlroots' : 'x11';
  if (hyprSig || desktopRaw.includes('hyprland')) {
    compositor = 'hyprland';
  } else if (swaySock || desktopRaw.includes('sway')) {
    compositor = 'sway';
  } else if (desktopRaw.includes('kde') || desktopRaw.includes('plasma') || e.KDE_FULL_SESSION) {
    compositor = 'kde';
  } else if (desktopRaw.includes('gnome') || desktopRaw.includes('ubuntu') || desktopRaw.includes('unity') || e.GNOME_DESKTOP_SESSION_ID) {
    compositor = 'gnome';
  } else if (desktopRaw.includes('cosmic')) {
    compositor = 'cosmic';
  } else if (i3Sock || desktopRaw.includes('i3')) {
    compositor = 'i3';
  } else if (desktopRaw.includes('cinnamon') || desktopRaw.includes('x-cinnamon')) {
    compositor = 'cinnamon';
  } else if (desktopRaw.includes('xfce')) {
    compositor = 'xfce';
  } else if (desktopRaw.includes('mate')) {
    compositor = 'mate';
  } else if (
    desktopRaw.includes('wlroots') ||
    desktopRaw.includes('wayfire') ||
    desktopRaw.includes('river') ||
    desktopRaw.includes('labwc') ||
    desktopRaw.includes('niri')
  ) {
    compositor = 'wlroots';
  }

  return {
    sessionType,
    isWayland,
    compositor,
    display: x11Display || ':0',
    waylandDisplay,
    hyprSig,
    swaySock,
    i3Sock,
    xauthority,
    runtimeDir
  };
}

// Real implementation of the sys interface
function createSys() {
  const whichCache = new Map();

  function has(tool) {
    if (whichCache.has(tool)) return whichCache.get(tool);
    let found = false;
    if (tool.includes('/')) {
      found = isExecutable(tool);
    } else {
      for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        if (dir && isExecutable(path.join(dir, tool))) {
          found = true;
          break;
        }
      }
    }
    whichCache.set(tool, found);
    return found;
  }

  function isExecutable(p) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }

  const session = detectGraphicalSession(process.env, fs);
  if (!process.env.DISPLAY && session.display) process.env.DISPLAY = session.display;
  if (!process.env.WAYLAND_DISPLAY && session.waylandDisplay) process.env.WAYLAND_DISPLAY = session.waylandDisplay;
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE && session.hyprSig) process.env.HYPRLAND_INSTANCE_SIGNATURE = session.hyprSig;
  if (!process.env.SWAYSOCK && session.swaySock) process.env.SWAYSOCK = session.swaySock;
  if (!process.env.XAUTHORITY && session.xauthority) process.env.XAUTHORITY = session.xauthority;

  // Runs a tool and collects its output. Never rejects for a non-zero exit code (callers check .code);
  // rejects only when the tool is missing or the timeout hits.
  function exec(cmd, args = [], opts = {}) {
    return new Promise((resolve, reject) => {
      if (!has(cmd)) return reject(new ToolMissingError(cmd));
      let child;
      try {
        child = spawn(cmd, args, {
          stdio: [opts.input !== undefined ? 'pipe' : 'ignore', opts.ignoreOutput ? 'ignore' : 'pipe', opts.ignoreOutput ? 'ignore' : 'pipe'],
          env: opts.env || process.env
        });
      } catch (e) {
        return reject(e);
      }
      const out = [];
      const err = [];
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try {
          child.kill('SIGKILL');
        } catch {}
        reject(new Error(`${cmd} zaman aşımına uğradı (${opts.timeout || 5000} ms)`));
      }, opts.timeout || 5000);
      if (child.stdout) child.stdout.on('data', (d) => out.push(d));
      if (child.stderr) child.stderr.on('data', (d) => err.push(d));
      child.on('error', (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e.code === 'ENOENT' ? new ToolMissingError(cmd) : e);
      });
      // xclip -i / wl-copy forks a daemon that inherits our pipes, so for it we only wait for the parent to exit
      child.on(opts.waitExit ? 'exit' : 'close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const stdoutBuf = Buffer.concat(out);
        resolve({ code, stdout: stdoutBuf.toString('utf8'), stdoutBuf, stderr: Buffer.concat(err).toString('utf8') });
      });
      if (opts.input !== undefined && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(opts.input);
      }
    });
  }

  // Fire-and-forget launch that survives the bridge (apps, xdg-open, task manager)
  function spawnDetached(cmd, args = [], opts = {}) {
    if (!cmd.includes('/') && !has(cmd)) throw new ToolMissingError(cmd);
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      cwd: opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir(),
      env: process.env
    });
    child.on('error', () => {});
    child.unref();
    return child.pid || 0;
  }

  return {
    platform: process.platform,
    env: process.env,
    display: process.env.DISPLAY || ':0',
    session: () => detectGraphicalSession(process.env, fs),
    has,
    exec,
    spawn,
    spawnDetached,
    fs,
    now: () => Date.now(),
    homedir: () => os.homedir(),
    hostname: () => os.hostname(),
    username: () => {
      try {
        return os.userInfo().username;
      } catch {
        return process.env.USER || '';
      }
    },
    log: (...a) => process.stderr.write('[linux-bridge] ' + a.join(' ') + '\n')
  };
}

// Helper for modules that receive either real `sys` or test `mockSys`
function getSession(sys) {
  if (sys && typeof sys.session === 'function') return sys.session();
  return detectGraphicalSession((sys && sys.env) || {}, (sys && sys.fs) || null);
}

// exec that throws a readable error on a non-zero exit code
async function execOk(sys, cmd, args, opts) {
  const r = await sys.exec(cmd, args, opts);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || '').trim().split('\n')[0];
    throw new Error(`${cmd} başarısız oldu${msg ? ': ' + msg : ''} (kod ${r.code})`);
  }
  return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(v, def = false) {
  if (v === undefined || v === null) return def;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return Boolean(v);
}

// dd.MM.yyyy HH:mm like the Windows bridge
function formatDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const kb = bytes / 1024;
  if (kb < 1024) return Math.round(kb * 10) / 10 + ' KB';
  const mb = kb / 1024;
  if (mb < 1024) return Math.round(mb * 10) / 10 + ' MB';
  return Math.round((mb / 1024) * 100) / 100 + ' GB';
}

module.exports = {
  ToolMissingError,
  missingToolMessage,
  detectGraphicalSession,
  getSession,
  createSys,
  execOk,
  sleep,
  clamp,
  num,
  bool,
  formatDate,
  formatFileSize,
  TOOL_PACKAGES
};
