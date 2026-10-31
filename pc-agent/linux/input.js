'use strict';
// Mouse / keyboard injection through xdotool, plus the send_input command (same arguments and replies as
// SendInputCommand() in BridgeHelper.cs) and the touch-to-mouse emulation of TouchInjector.cs.

const { parseMouseLocation, mapKeyCombo } = require('./parsers');
const { clamp, num, bool, missingToolMessage } = require('./util');

// ---------------------------------------------------------------------------
// xdotool driver
// ---------------------------------------------------------------------------
// Preferred: ONE long-lived "xdotool -" reading commands from stdin (no fork per mouse move). Some xdotool
// builds only run a script after EOF, so at start-up a getmouselocation probe must answer within 600 ms;
// otherwise every command is spawned on its own (with pending absolute moves coalesced).
class Xdo {
  constructor(sys) {
    this.sys = sys;
    this.mode = 'unknown'; // 'pipe' | 'spawn' | 'missing'
    this.proc = null;
    this.waiters = []; // getmouselocation replies in pipe mode, FIFO
    this.queue = []; // spawn mode
    this.running = false;
    this.restarts = 0;
    this.ready = null;
  }

  available() {
    return this.sys.has('xdotool');
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = this._startPipe().catch(() => {
      this.mode = this.available() ? 'spawn' : 'missing';
    });
    return this.ready;
  }

  _startPipe() {
    return new Promise((resolve, reject) => {
      if (!this.available()) {
        this.mode = 'missing';
        return resolve();
      }
      let proc;
      try {
        proc = this.sys.spawn('xdotool', ['-'], { stdio: ['pipe', 'pipe', 'ignore'] });
      } catch (e) {
        return reject(e);
      }
      let lineBuf = '';
      let settled = false;
      proc.on('error', () => {
        if (!settled) {
          settled = true;
          reject(new Error('xdotool başlatılamadı'));
        }
      });
      proc.stdin.on('error', () => {});
      proc.stdout.on('data', (d) => {
        lineBuf += d.toString('utf8');
        let nl;
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          const loc = parseMouseLocation(line);
          if (loc && this.waiters.length) this.waiters.shift()(loc);
        }
      });
      proc.on('exit', () => {
        if (this.proc === proc) this.proc = null;
        for (const w of this.waiters.splice(0)) w(null);
        if (!settled) {
          settled = true;
          return reject(new Error('xdotool kapandı'));
        }
        // A command xdotool did not like can end the script: restart, then give up on pipe mode
        if (this.mode === 'pipe' && ++this.restarts <= 5) {
          this.ready = null;
          this.start();
        } else if (this.mode === 'pipe') {
          this.mode = 'spawn';
        }
      });
      this.proc = proc;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waiters = [];
        try {
          proc.kill('SIGKILL');
        } catch {}
        this.proc = null;
        reject(new Error('xdotool stdin script mode is buffered'));
      }, 600);
      this.waiters.push((loc) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (loc) {
          this.mode = 'pipe';
          resolve();
        } else reject(new Error('xdotool probe failed'));
      });
      proc.stdin.write('getmouselocation\n');
    });
  }

  _ensure() {
    if (this.mode === 'missing' || (!this.available() && this.mode !== 'pipe')) {
      throw new Error(missingToolMessage('xdotool'));
    }
  }

  // args: xdotool argv, e.g. ['mousemove', '--', '10', '20']
  run(args) {
    this._ensure();
    if (this.mode === 'pipe' && this.proc && this.proc.stdin.writable) {
      // script mode splits on whitespace: only used for commands whose arguments never contain spaces
      this.proc.stdin.write(args.join(' ') + '\n');
      return;
    }
    if (args[0] === 'mousemove') {
      // Coalesce: only the latest pending absolute move matters
      const last = this.queue.length ? this.queue[this.queue.length - 1] : null;
      if (last && last[0] === 'mousemove') this.queue.pop();
    }
    this.queue.push(args);
    this._drain();
  }

  async _drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const args = this.queue.shift();
        await this.sys.exec('xdotool', args, { timeout: 3000 }).catch(() => {});
      }
    } finally {
      this.running = false;
    }
  }

  // Free-text typing always gets its own process (arguments with spaces / unicode)
  async type(text) {
    this._ensure();
    await this.sys.exec('xdotool', ['type', '--clearmodifiers', '--delay', '4', '--', text], { timeout: 15000 });
  }

  async getMouseLocation() {
    if (this.mode === 'pipe' && this.proc && this.proc.stdin.writable) {
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 800);
        this.waiters.push((loc) => {
          clearTimeout(t);
          resolve(loc);
        });
        this.proc.stdin.write('getmouselocation\n');
      });
    }
    if (!this.available()) return null;
    const r = await this.sys.exec('xdotool', ['getmouselocation'], { timeout: 1500 }).catch(() => null);
    return r ? parseMouseLocation(r.stdout) : null;
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.stdin.end();
        this.proc.kill();
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// send_input
// ---------------------------------------------------------------------------
const BUTTONS = { left: '1', middle: '2', right: '3' };

// Normalized 0..1 -> pixel inside the monitor (x=1.0 must stay on this monitor)
function normToScreen(origin, size, norm) {
  const px = Math.floor(norm * size);
  return origin + clamp(px, 0, size - 1);
}

class InputController {
  // getMonitorBounds(index) -> { x, y, width, height } (index -1 = all monitors)
  constructor(sys, xdo, getMonitorBounds, hooks = {}) {
    this.sys = sys;
    this.xdo = xdo;
    this.getMonitorBounds = getMonitorBounds;
    this.hooks = hooks; // { onKeyCombo(combo) -> true when handled (e.g. CTRL+SHIFT+ESC) }
    this.cursor = { x: 0, y: 0, ts: 0 };
    this.scrollAccY = 0;
    this.scrollAccX = 0;
    this.touch = { active: false, startX: 0, startY: 0, lastX: 0, lastY: 0, startTs: 0, scrolling: false, dragging: false, scrollAcc: 0 };
    this.touchWatchdog = null;
    this.chain = Promise.resolve();
  }

  // Cached cursor position; refreshed from X when older than 400 ms (the user may move the real mouse)
  async cursorPos() {
    if (this.sys.now() - this.cursor.ts > 400) {
      const loc = await this.xdo.getMouseLocation();
      if (loc) this.cursor = { x: loc.x, y: loc.y, ts: this.sys.now() };
    }
    return this.cursor;
  }

  moveTo(x, y) {
    this.xdo.run(['mousemove', '--', String(Math.round(x)), String(Math.round(y))]);
    this.cursor = { x: Math.round(x), y: Math.round(y), ts: this.sys.now() };
  }

  // Windows wheel units (120 per notch, + = up) -> X buttons 4/5 (vertical) and 6/7 (horizontal)
  wheel(deltaY, deltaX) {
    this.scrollAccY += deltaY || 0;
    this.scrollAccX += deltaX || 0;
    const ny = Math.trunc(this.scrollAccY / 120);
    const nx = Math.trunc(this.scrollAccX / 120);
    this.scrollAccY -= ny * 120;
    this.scrollAccX -= nx * 120;
    if (ny) this.xdo.run(['click', '--repeat', String(Math.min(30, Math.abs(ny))), ny > 0 ? '4' : '5']);
    if (nx) this.xdo.run(['click', '--repeat', String(Math.min(30, Math.abs(nx))), nx > 0 ? '7' : '6']);
    return { notchesY: ny, notchesX: nx };
  }

  // Inputs are applied strictly in arrival order (a touch "up" must never overtake its "down")
  handle(args) {
    const run = this.chain.then(() => this._handle(args || {}));
    this.chain = run.catch(() => {});
    return run;
  }

  async _handle(args) {
    const type = String(args.type || '');
    const hasMon = args.monitorIndex !== undefined && args.monitorIndex !== null;
    const monIdx = hasMon ? num(args.monitorIndex, 0) : 0;
    const mon = await this.getMonitorBounds(type === 'mouse_move_rel' && !hasMon ? -1 : monIdx);

    const moveToNorm = () => {
      if (args.x === undefined || args.y === undefined) return;
      const nx = clamp(num(args.x, 0.5), 0, 1);
      const ny = clamp(num(args.y, 0.5), 0, 1);
      this.moveTo(normToScreen(mon.x, mon.width, nx), normToScreen(mon.y, mon.height, ny));
    };

    switch (type) {
      case 'touch':
        return this.handleTouch(args, mon);
      case 'mouse_move_rel': {
        const p = await this.cursorPos();
        const nextX = clamp(p.x + Math.round(num(args.dx, 0)), mon.x, mon.x + mon.width - 1);
        const nextY = clamp(p.y + Math.round(num(args.dy, 0)), mon.y, mon.y + mon.height - 1);
        this.moveTo(nextX, nextY);
        return {
          ok: true,
          normX: round4(clamp((nextX - mon.x) / Math.max(1, mon.width), 0, 1)),
          normY: round4(clamp((nextY - mon.y) / Math.max(1, mon.height), 0, 1))
        };
      }
      case 'mouse_move_abs': {
        const nx = args.x !== undefined ? clamp(num(args.x, 0.5), 0, 1) : 0.5;
        const ny = args.y !== undefined ? clamp(num(args.y, 0.5), 0, 1) : 0.5;
        this.moveTo(mon.x + Math.round(nx * mon.width), mon.y + Math.round(ny * mon.height));
        return { ok: true, normX: round4(nx), normY: round4(ny) };
      }
      case 'mouse_down':
        moveToNorm();
        this.xdo.run(['mousedown', BUTTONS[args.button] || '1']);
        return { ok: true, holding: true };
      case 'mouse_up':
        moveToNorm();
        this.xdo.run(['mouseup', BUTTONS[args.button] || '1']);
        return { ok: true, holding: false };
      case 'mouse_click': {
        moveToNorm();
        const btn = BUTTONS[args.button] || '1';
        const dbl = btn === '1' && bool(args.double);
        this.xdo.run(dbl ? ['click', '--repeat', '2', '--delay', '25', '1'] : ['click', btn]);
        return { ok: true };
      }
      case 'mouse_scroll':
        this.wheel(Math.round(num(args.deltaY, 0)), Math.round(num(args.deltaX, 0)));
        return { ok: true };
      case 'text': {
        const text = args.text === undefined || args.text === null ? '' : String(args.text);
        if (text) await this.xdo.type(text);
        return { ok: true };
      }
      case 'key': {
        const combo = String(args.key || '').toUpperCase();
        if (this.hooks.onKeyCombo && (await this.hooks.onKeyCombo(combo))) return { ok: true };
        const keys = mapKeyCombo(combo);
        if (keys) this.xdo.run(['key', '--clearmodifiers', keys]);
        return { ok: true };
      }
      default:
        return { ok: false };
    }
  }

  // EmulateTouchWithMouse(): tap = click, quick swipe = wheel, hold > 450 ms then move = drag,
  // hold > 550 ms and release = right click
  handleTouch(args, mon) {
    const phase = String(args.phase || '');
    const id = num(args.id, 0);
    const px = normToScreen(mon.x, mon.width, clamp(num(args.x, 0.5), 0, 1));
    const py = normToScreen(mon.y, mon.height, clamp(num(args.y, 0.5), 0, 1));
    const t = this.touch;
    const now = this.sys.now();
    this._armTouchWatchdog();
    if (id !== 0) return { ok: true, mode: 'mouse' }; // the mouse has one pointer
    if (phase === 'down') {
      if (t.dragging) this.xdo.run(['mouseup', '1']); // a lost "up": never leave the button pressed
      Object.assign(t, { active: true, startX: px, startY: py, lastX: px, lastY: py, startTs: now, scrolling: false, dragging: false, scrollAcc: 0 });
      this.moveTo(px, py);
      return { ok: true, mode: 'mouse' };
    }
    if (!t.active) return { ok: true, mode: 'mouse' };
    const held = now - t.startTs;
    const moved = Math.abs(px - t.startX) + Math.abs(py - t.startY);
    if (phase === 'move') {
      if (!t.scrolling && !t.dragging && moved > 12) {
        if (held > 450) {
          t.dragging = true;
          this.moveTo(t.startX, t.startY);
          this.xdo.run(['mousedown', '1']);
        } else t.scrolling = true;
      }
      if (t.dragging) {
        this.moveTo(px, py);
      } else if (t.scrolling) {
        // Content follows the finger: moving the finger up scrolls the page down
        t.scrollAcc += (py - t.lastY) * 3.0;
        const step = Math.trunc(t.scrollAcc);
        if (Math.abs(step) >= 15) {
          t.scrollAcc -= step;
          this.wheel(step, 0);
        }
      }
      t.lastX = px;
      t.lastY = py;
      return { ok: true, mode: 'mouse' };
    }
    // up / cancel
    t.active = false;
    if (t.dragging) {
      t.dragging = false;
      this.moveTo(px, py);
      this.xdo.run(['mouseup', '1']);
      return { ok: true, mode: 'mouse' };
    }
    if (t.scrolling || phase === 'cancel') return { ok: true, mode: 'mouse' };
    this.xdo.run(['click', held > 550 ? '3' : '1']);
    return { ok: true, mode: 'mouse' };
  }

  // The phone vanished mid-drag (network drop): release the button after 8 s without touch events
  _armTouchWatchdog() {
    if (this.touchWatchdog) clearTimeout(this.touchWatchdog);
    this.touchWatchdog = setTimeout(() => {
      this.touchWatchdog = null;
      if (this.touch.dragging) {
        this.touch.dragging = false;
        this.touch.active = false;
        try {
          this.xdo.run(['mouseup', '1']);
        } catch {}
      }
    }, 8000);
    if (this.touchWatchdog.unref) this.touchWatchdog.unref();
  }
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

module.exports = { Xdo, InputController, normToScreen };
