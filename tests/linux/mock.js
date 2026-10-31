'use strict';
// In-memory stand-ins for the OS so the bridge logic can be tested on any machine (also Windows).

const { EventEmitter } = require('events');
const path = require('path').posix;
const { ToolMissingError } = require('../../pc-agent/linux/util');

// files: { '/abs/path': 'content' | Buffer }, dirs are implied by file paths (+ extra `dirs`)
function createMockFs(files = {}, extraDirs = []) {
  const store = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(String(v))]));
  const links = new Map();
  const dirs = new Set(['/']);
  const addDirs = (p) => {
    let d = path.dirname(p);
    while (d && !dirs.has(d)) {
      dirs.add(d);
      d = path.dirname(d);
    }
  };
  for (const k of store.keys()) addDirs(k);
  for (const d of extraDirs) {
    dirs.add(d);
    addDirs(d + '/x');
  }
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const mtime = new Date(2026, 0, 2, 3, 4);
  return {
    store,
    links,
    existsSync: (p) => store.has(p) || dirs.has(p),
    readFileSync: (p, enc) => {
      if (!store.has(p)) throw enoent(p);
      return enc ? store.get(p).toString(enc) : store.get(p);
    },
    writeFileSync: (p, data) => {
      store.set(p, Buffer.from(data));
      addDirs(p);
    },
    appendFileSync: (p, data) => {
      store.set(p, Buffer.concat([store.get(p) || Buffer.alloc(0), Buffer.from(data)]));
      addDirs(p);
    },
    mkdirSync: (p) => {
      dirs.add(p);
      addDirs(p + '/x');
    },
    readdirSync: (p) => {
      if (!dirs.has(p)) throw enoent(p);
      const names = new Set();
      const prefix = p === '/' ? '/' : p + '/';
      for (const k of [...store.keys(), ...dirs]) {
        if (k.startsWith(prefix) && k !== p) names.add(k.slice(prefix.length).split('/')[0]);
      }
      return [...names];
    },
    statSync: (p) => {
      if (dirs.has(p)) return { isDirectory: () => true, isFile: () => false, size: 0, mode: 0o755, mtime, ctime: mtime, birthtime: mtime };
      if (!store.has(p)) throw enoent(p);
      const exec = /\/bin\//.test(p) || p.endsWith('.sh');
      return { isDirectory: () => false, isFile: () => true, size: store.get(p).length, mode: exec ? 0o755 : 0o644, mtime, ctime: mtime, birthtime: mtime };
    },
    readlinkSync: (p) => {
      if (!links.has(p)) throw enoent(p);
      return links.get(p);
    }
  };
}

// A fake child process for sys.spawn (xdotool -, ffmpeg)
class FakeProc extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.written = [];
    this.killed = false;
    const self = this;
    this.stdin = {
      writable: true,
      on() {},
      write(d) {
        self.written.push(String(d));
        self.emit('stdin', String(d));
        return true;
      },
      end() {
        this.writable = false;
      }
    };
  }
  kill() {
    this.killed = true;
    this.stdin.writable = false;
    setImmediate(() => this.emit('exit', null));
  }
}

// responders: [ [matcher(cmd, args) | 'cmd args prefix', result | (cmd,args,opts)=>result ] ]
function createMockSys(opts = {}) {
  const calls = [];
  const detached = [];
  const spawned = [];
  const tools = new Set(opts.tools || []);
  let clock = opts.now !== undefined ? opts.now : 1000000;
  const responders = opts.responders || [];
  const sys = {
    platform: 'linux',
    env: { DISPLAY: ':99', ...(opts.env || {}) },
    display: ':99',
    fs: opts.fs || createMockFs(opts.files || {}, opts.dirs || []),
    calls,
    detached,
    spawned,
    logs: [],
    has: (t) => tools.has(t),
    addTool: (t) => tools.add(t),
    exec: async (cmd, args = [], o = {}) => {
      calls.push({ cmd, args, opts: o, line: [cmd, ...args].join(' ') });
      if (!tools.has(cmd)) throw new ToolMissingError(cmd);
      const line = [cmd, ...args].join(' ');
      for (const [m, res] of responders) {
        const hit = typeof m === 'function' ? m(cmd, args) : line === m || line.startsWith(m + ' ') || line === m.trim();
        if (hit) {
          const r = typeof res === 'function' ? await res(cmd, args, o) : res;
          const stdout = r.stdout || '';
          const buf = r.stdoutBuf || Buffer.from(stdout);
          return { code: r.code || 0, stdout: buf.toString('utf8'), stdoutBuf: buf, stderr: r.stderr || '' };
        }
      }
      return { code: 0, stdout: '', stdoutBuf: Buffer.alloc(0), stderr: '' };
    },
    spawn: (cmd, args) => {
      const p = (opts.onSpawn && opts.onSpawn(cmd, args)) || new FakeProc();
      p.cmd = cmd;
      p.args = args;
      spawned.push(p);
      return p;
    },
    spawnDetached: (cmd, args = []) => {
      if (!cmd.includes('/') && !tools.has(cmd)) throw new ToolMissingError(cmd);
      detached.push([cmd, ...args].join(' '));
      return 4242;
    },
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    homedir: () => '/home/taha',
    hostname: () => 'ci-host',
    username: () => 'taha',
    log: (...a) => sys.logs.push(a.join(' '))
  };
  return sys;
}

module.exports = { createMockFs, createMockSys, FakeProc };
