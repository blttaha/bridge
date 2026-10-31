'use strict';
// Process / filesystem helpers for the Linux bridge. Everything that touches the OS goes through the "sys"
// object built here, so the unit tests can swap it for a mock and run on any platform.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// apt package that provides each external tool (used in the Turkish "not installed" messages)
const TOOL_PACKAGES = {
  xrandr: 'x11-xserver-utils',
  xset: 'x11-xserver-utils',
  xprop: 'x11-utils',
  xdotool: 'xdotool',
  wmctrl: 'wmctrl',
  xclip: 'xclip',
  pactl: 'pulseaudio-utils',
  playerctl: 'playerctl',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffmpeg',
  brightnessctl: 'brightnessctl',
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
      // xclip -i forks a daemon that inherits our pipes, so for it we only wait for the parent to exit
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
