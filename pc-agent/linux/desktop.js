'use strict';
// Monitors, windows, installed apps, file browsing and launching on an X11 desktop.
// Return shapes follow BridgeHelper.cs (MonitorData, GetOpenWindows, GetInstalledApps, ...).

const path = require('path').posix; // Linux paths, also when the tests run on Windows
const {
  parseXrandr,
  parseNetWorkarea,
  intersectWorkarea,
  parseWmctrl,
  parseNetWmState,
  classifyZone,
  resolveZoneRect,
  parseDesktopEntry,
  desktopName,
  isDesktopEntryVisible,
  parseDesktopExec,
  splitArgs
} = require('./parsers');
const { execOk, sleep, clamp, num, bool, formatDate, formatFileSize, missingToolMessage } = require('./util');

const INTERNAL_OUTPUT_RE = /^(eDP|LVDS|DSI)/i;

function createDesktop(sys) {
  const state = {
    monitorsCache: null,
    monitorsTs: 0,
    brightness: new Map(), // output name -> 0..100
    blackout: new Set(), // output names blacked out (xrandr brightness 0)
    iconCache: new Map(),
    appsCache: null,
    appsTs: 0
  };

  // -------------------------------------------------------------------------
  // Monitors
  // -------------------------------------------------------------------------
  async function readMonitors() {
    if (!sys.has('xrandr')) throw new Error(missingToolMessage('xrandr'));
    const r = await execOk(sys, 'xrandr', ['--query'], { timeout: 4000 });
    const { outputs } = parseXrandr(r.stdout);
    let workarea = null;
    if (sys.has('xprop')) {
      const wa = await sys.exec('xprop', ['-root', '_NET_WORKAREA'], { timeout: 1500 }).catch(() => null);
      if (wa && wa.code === 0) workarea = parseNetWorkarea(wa.stdout);
    }
    return outputs.map((o, i) => {
      const work = intersectWorkarea(o, workarea);
      return {
        index: i,
        id: 'MON_' + (i + 1),
        deviceName: o.name,
        friendlyName: `Ekran ${i + 1} (${o.name})`,
        isPrimary: o.isPrimary,
        x: o.x,
        y: o.y,
        width: o.width,
        height: o.height,
        workX: work.x,
        workY: work.y,
        workWidth: work.width,
        workHeight: work.height,
        isBlackedOut: state.blackout.has(o.name),
        brightness: state.brightness.has(o.name) ? state.brightness.get(o.name) : 100
      };
    });
  }

  async function getMonitors(maxAgeMs = 0) {
    if (maxAgeMs > 0 && state.monitorsCache && sys.now() - state.monitorsTs < maxAgeMs) {
      // flags can change between reads
      return state.monitorsCache.map((m) => ({
        ...m,
        isBlackedOut: state.blackout.has(m.deviceName),
        brightness: state.brightness.has(m.deviceName) ? state.brightness.get(m.deviceName) : 100
      }));
    }
    // Concurrent callers share one xrandr run
    if (!state.monitorsPending) {
      state.monitorsPending = readMonitors().finally(() => {
        state.monitorsPending = null;
      });
    }
    const list = await state.monitorsPending;
    state.monitorsCache = list;
    state.monitorsTs = sys.now();
    return list.map((m) => ({ ...m }));
  }

  // GetTargetMonitorBounds(): -1 = bounding box of all monitors, out of range = primary
  async function getMonitorBounds(index) {
    let mons = [];
    try {
      mons = await getMonitors(2500);
    } catch {}
    if (mons.length === 0) return { index: 0, x: 0, y: 0, width: 1920, height: 1080 };
    if (index === -1) {
      const minX = Math.min(...mons.map((m) => m.x));
      const minY = Math.min(...mons.map((m) => m.y));
      const maxR = Math.max(...mons.map((m) => m.x + m.width));
      const maxB = Math.max(...mons.map((m) => m.y + m.height));
      return { index: -1, id: 'ALL_MONITORS', friendlyName: 'Tüm Ekranlar', x: minX, y: minY, width: maxR - minX, height: maxB - minY };
    }
    const i = Number.isInteger(index) && index >= 0 && index < mons.length ? index : 0;
    return mons[i];
  }

  // Software brightness through the gamma ramp; brightness 0 = black screen ("blackout")
  async function applyXrandrBrightness(output, level) {
    if (!sys.has('xrandr')) throw new Error(missingToolMessage('xrandr'));
    const v = (Math.max(0, Math.min(100, level)) / 100).toFixed(2);
    return execOk(sys, 'xrandr', ['--output', output, '--brightness', v], { timeout: 4000 });
  }

  async function setBrightness(monitorIndex, level) {
    level = clamp(Math.round(num(level, 100)), 0, 100);
    const mons = await getMonitors();
    const targets = monitorIndex >= 0 ? mons.filter((m) => m.index === monitorIndex) : mons;
    if (targets.length === 0) throw new Error('Geçersiz monitör indeksi: ' + monitorIndex);
    const errors = [];
    for (const m of targets) {
      state.brightness.set(m.deviceName, level);
      try {
        // Laptop panels: real backlight. External monitors: gamma (DDC/CI would need root / ddcutil)
        if (INTERNAL_OUTPUT_RE.test(m.deviceName) && sys.has('brightnessctl')) {
          await execOk(sys, 'brightnessctl', ['set', Math.max(1, level) + '%'], { timeout: 4000 });
        } else if (!state.blackout.has(m.deviceName)) {
          await applyXrandrBrightness(m.deviceName, Math.max(10, level)); // never fully dark by accident
        }
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (errors.length === targets.length) throw new Error('Parlaklık ayarlanamadı: ' + errors[0]);
  }

  async function monitorPower(args) {
    const action = String(args.action || 'off');
    if (!sys.has('xset')) throw new Error(missingToolMessage('xset'));
    if (action === 'off') {
      // Give the reply time to leave before the screens go dark
      setTimeout(() => sys.exec('xset', ['dpms', 'force', 'off'], { timeout: 3000 }).catch(() => {}), 80);
      return { status: 'monitors_sleeping' };
    }
    await sys.exec('xset', ['dpms', 'force', 'on'], { timeout: 3000 }).catch(() => {});
    // Wake pulse like the Windows bridge (some screens only wake on input)
    if (sys.has('xdotool')) sys.exec('xdotool', ['mousemove_relative', '--', '1', '1'], { timeout: 2000 }).then(() => sys.exec('xdotool', ['mousemove_relative', '--', '-1', '-1'], { timeout: 2000 })).catch(() => {});
    if (args.clearBlackouts === undefined || bool(args.clearBlackouts)) await clearBlackouts();
    return { status: 'monitors_awake' };
  }

  async function clearBlackouts() {
    for (const name of Array.from(state.blackout)) {
      state.blackout.delete(name);
      const lvl = state.brightness.has(name) ? state.brightness.get(name) : 100;
      await applyXrandrBrightness(name, Math.max(10, lvl)).catch(() => {});
    }
  }

  async function monitorBlackout(args) {
    if (bool(args.clearAll)) {
      await clearBlackouts();
      return getMonitors();
    }
    const idx = num(args.monitorIndex, 0);
    const mode = String(args.mode || 'toggle');
    const mons = await getMonitors();
    if (idx < 0 || idx >= mons.length) throw new Error('Geçersiz monitör indeksi: ' + idx);
    const name = mons[idx].deviceName;
    const currentlyOn = state.blackout.has(name);
    const shouldBeOn = mode === 'toggle' ? !currentlyOn : mode === 'on' || mode === 'true';
    if (shouldBeOn && !currentlyOn) {
      state.blackout.add(name);
      // Gamma 0 is a real black curtain (input keeps working). Virtual screens without gamma just keep the flag.
      await applyXrandrBrightness(name, 0).catch((e) => sys.log('blackout:', e.message));
    } else if (!shouldBeOn && currentlyOn) {
      state.blackout.delete(name);
      const lvl = state.brightness.has(name) ? state.brightness.get(name) : 100;
      await applyXrandrBrightness(name, Math.max(10, lvl)).catch(() => {});
    }
    return getMonitors();
  }

  // DisplaySwitch.exe equivalent with xrandr
  async function displayTopology(args) {
    const mode = String(args.mode || 'extend');
    if (!sys.has('xrandr')) throw new Error(missingToolMessage('xrandr'));
    const r = await execOk(sys, 'xrandr', ['--query'], { timeout: 4000 });
    const { outputs, inactive } = parseXrandr(r.stdout);
    const all = outputs.filter((o) => !o.virtual).map((o) => o.name).concat(inactive);
    const internal = all.filter((n) => INTERNAL_OUTPUT_RE.test(n));
    const external = all.filter((n) => !INTERNAL_OUTPUT_RE.test(n));
    const primary = (outputs.find((o) => o.isPrimary) || {}).name || all[0];
    const argv = [];
    if (mode === 'internal' || mode === 'primary_only') {
      const keep = internal[0] || primary;
      for (const n of all) argv.push('--output', n, ...(n === keep ? ['--auto', '--primary'] : ['--off']));
    } else if (mode === 'external' || mode === 'secondary_only') {
      const keep = external[0] || primary;
      for (const n of all) argv.push('--output', n, ...(n === keep ? ['--auto', '--primary'] : ['--off']));
    } else if (mode === 'clone' || mode === 'duplicate') {
      for (const n of all) argv.push('--output', n, '--auto', ...(n === primary ? [] : ['--same-as', primary]));
    } else {
      let prev = null;
      for (const n of [primary, ...all.filter((x) => x !== primary)]) {
        argv.push('--output', n, '--auto', ...(prev ? ['--right-of', prev] : []));
        prev = n;
      }
    }
    if (all.length > 0) await execOk(sys, 'xrandr', argv, { timeout: 8000 });
    state.monitorsCache = null;
    return { mode, applied: all.length > 0 };
  }

  // -------------------------------------------------------------------------
  // Icons
  // -------------------------------------------------------------------------
  const ICON_DIRS = [
    '/usr/share/icons/hicolor/256x256/apps',
    '/usr/share/icons/hicolor/128x128/apps',
    '/usr/share/icons/hicolor/96x96/apps',
    '/usr/share/icons/hicolor/64x64/apps',
    '/usr/share/icons/hicolor/48x48/apps',
    '/usr/share/icons/hicolor/scalable/apps',
    '/var/lib/flatpak/exports/share/icons/hicolor/128x128/apps',
    '/var/lib/flatpak/exports/share/icons/hicolor/scalable/apps',
    '/usr/share/pixmaps'
  ];

  // Icon name or path -> data URL (PNG / SVG), '' when not found
  function iconDataUrl(icon) {
    if (!icon) return '';
    if (state.iconCache.has(icon)) return state.iconCache.get(icon);
    let file = '';
    const exists = (p) => {
      try {
        return sys.fs.statSync(p).isFile();
      } catch {
        return false;
      }
    };
    if (icon.startsWith('/')) {
      if (exists(icon)) file = icon;
    } else {
      const home = sys.homedir();
      const dirs = [path.join(home, '.local/share/icons/hicolor/128x128/apps'), path.join(home, '.local/share/icons/hicolor/scalable/apps'), ...ICON_DIRS];
      outer: for (const d of dirs) {
        for (const ext of ['.png', '.svg', '.xpm']) {
          if (ext === '.xpm') continue; // phone cannot draw XPM
          const p = path.join(d, icon + ext);
          if (exists(p)) {
            file = p;
            break outer;
          }
        }
      }
    }
    let url = '';
    if (file) {
      try {
        const data = sys.fs.readFileSync(file);
        if (data.length < 300 * 1024) {
          const mime = file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : '';
          if (mime) url = `data:${mime};base64,` + data.toString('base64');
        }
      } catch {}
    }
    state.iconCache.set(icon, url);
    return url;
  }

  // -------------------------------------------------------------------------
  // Installed apps (.desktop files)
  // -------------------------------------------------------------------------
  function appDirs() {
    const home = sys.homedir();
    const dataDirs = String(sys.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
      .split(':')
      .filter(Boolean)
      .map((d) => path.join(d, 'applications'));
    const dirs = [
      path.join(home, '.local/share/applications'),
      '/usr/share/applications',
      '/usr/local/share/applications',
      '/var/lib/flatpak/exports/share/applications',
      path.join(home, '.local/share/flatpak/exports/share/applications'),
      '/var/lib/snapd/desktop/applications',
      ...dataDirs
    ];
    return Array.from(new Set(dirs));
  }

  function readDesktopFile(file) {
    try {
      return parseDesktopEntry(sys.fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function getInstalledApps() {
    if (state.appsCache && sys.now() - state.appsTs < 30000) return state.appsCache;
    const byId = new Map(); // desktop id -> entry (first dir wins, like XDG lookup order)
    for (const dir of appDirs()) {
      let names = [];
      try {
        names = sys.fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.desktop') || byId.has(name)) continue;
        const file = path.join(dir, name);
        const e = readDesktopFile(file);
        byId.set(name, e ? { file, e } : null);
      }
    }
    const apps = [];
    const seenNames = new Set();
    for (const [id, item] of byId) {
      if (!item || !isDesktopEntryVisible(item.e)) continue;
      const name = desktopName(item.e).trim();
      if (!name || seenNames.has(name.toLowerCase())) continue;
      seenNames.add(name.toLowerCase());
      const argv = parseDesktopExec(item.e.Exec);
      const bin = argv[0] ? path.basename(argv[0]) : '';
      apps.push({
        name,
        processName: item.e.StartupWMClass || (bin === 'flatpak' ? name : bin) || name,
        launchPath: item.file,
        launchArgs: '',
        icon: iconDataUrl(item.e.Icon || ''),
        source: id.includes('flatpak') || item.file.includes('flatpak') ? 'flatpak' : 'desktop',
        desktopId: id
      });
    }
    apps.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    state.appsCache = apps;
    state.appsTs = sys.now();
    return apps;
  }

  // -------------------------------------------------------------------------
  // Windows
  // -------------------------------------------------------------------------
  function procInfo(pid) {
    let name = '';
    let exe = '';
    try {
      name = sys.fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    } catch {}
    try {
      exe = sys.fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {}
    return { name, exe };
  }

  // Icon for a running process: match a .desktop entry by WM class / binary name
  function iconForProcess(procName) {
    const p = String(procName || '').toLowerCase();
    if (!p) return '';
    let apps = [];
    try {
      apps = getInstalledApps();
    } catch {}
    const hit = apps.find((a) => String(a.processName).toLowerCase() === p || String(a.desktopId).toLowerCase() === p + '.desktop');
    return hit ? hit.icon : '';
  }

  async function getWindows() {
    if (!sys.has('wmctrl')) throw new Error(missingToolMessage('wmctrl'));
    const r = await execOk(sys, 'wmctrl', ['-lpG'], { timeout: 4000 });
    const raw = parseWmctrl(r.stdout).filter((w) => w.desktop !== -1 && w.title);
    const mons = await getMonitors(2500).catch(() => []);
    const ownPid = process.pid;
    // Window states in parallel (one xprop each); wmctrl lists bottom-to-top stacking order
    const states = await Promise.all(
      raw.map((w) =>
        sys.has('xprop')
          ? sys
              .exec('xprop', ['-id', w.id, '_NET_WM_STATE'], { timeout: 1500 })
              .then((x) => parseNetWmState(x.stdout))
              .catch(() => ({ state: 'normal', above: false }))
          : Promise.resolve({ state: 'normal', above: false })
      )
    );
    const results = [];
    const rectsAbove = new Map(); // monitor -> rects of windows above (we walk top-down)
    let zOrderCounter = 0;
    for (let i = raw.length - 1; i >= 0; i--) {
      const w = raw[i];
      if (w.pid === ownPid) continue;
      const { state: winState, above } = states[i];
      const { name: procName, exe } = procInfo(w.pid);
      const cx = w.x + w.width / 2;
      const cy = w.y + w.height / 2;
      let monIdx = mons.findIndex((m) => cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height);
      if (monIdx < 0) monIdx = 0;
      const mon = mons[monIdx] || { workX: 0, workY: 0, workWidth: 1920, workHeight: 1080, x: 0, y: 0, width: 1920, height: 1080 };
      const ww = Math.max(200, w.width);
      const wh = Math.max(120, w.height);
      let normX = clamp(round2((w.x - mon.workX) / Math.max(1, mon.workWidth)), 0, 1);
      let normY = clamp(round2((w.y - mon.workY) / Math.max(1, mon.workHeight)), 0, 1);
      let normW = clamp(round2(ww / Math.max(1, mon.workWidth)), 0.1, 1);
      let normH = clamp(round2(wh / Math.max(1, mon.workHeight)), 0.1, 1);
      if (winState === 'maximized') [normX, normY, normW, normH] = [0, 0, 1, 1];

      const currentZOrder = zOrderCounter++;

      let isBackground = false;
      let backgroundReason = '';
      if (winState === 'minimized') {
        isBackground = true;
        backgroundReason = 'Simge Durumunda';
      } else {
        const list = rectsAbove.get(monIdx) || [];
        const selfArea = Math.max(1, ww * wh);
        for (const a of list) {
          const ix = Math.max(0, Math.min(w.x + w.width, a.r) - Math.max(w.x, a.l));
          const iy = Math.max(0, Math.min(w.y + w.height, a.b) - Math.max(w.y, a.t));
          if ((cx >= a.l && cx <= a.r && cy >= a.t && cy <= a.b) || (ix * iy * 100) / selfArea >= 25) {
            isBackground = true;
            backgroundReason = 'Arkaplanda';
            break;
          }
        }
        list.push(
          winState === 'maximized'
            ? { l: mon.x, t: mon.y, r: mon.x + mon.width, b: mon.y + mon.height }
            : { l: w.x, t: w.y, r: w.x + w.width, b: w.y + w.height }
        );
        rectsAbove.set(monIdx, list);
      }
      results.push({
        hwnd: w.hwnd,
        title: w.title,
        processName: procName || 'bilinmiyor',
        rawProcessName: procName,
        exePath: exe,
        icon: iconForProcess(procName),
        pid: w.pid,
        monitorIndex: monIdx,
        state: winState,
        zOrder: currentZOrder,
        isBackground,
        backgroundReason,
        isTopMost: above,
        rect: { x: w.x, y: w.y, width: ww, height: wh },
        normalized: { x: normX, y: normY, w: normW, h: normH },
        zonePreset: classifyZone(winState, normX, normY, normW, normH)
      });
    }
    return results;
  }

  const hexId = (hwnd) => '0x' + Number(hwnd).toString(16).padStart(8, '0');

  async function wm(args) {
    if (!sys.has('wmctrl')) throw new Error(missingToolMessage('wmctrl'));
    return sys.exec('wmctrl', args, { timeout: 3000 });
  }

  async function findWindowByProcess(processName) {
    const p = String(processName || '').toLowerCase();
    if (!p) return 0;
    const wins = await getWindows().catch(() => []);
    const hit =
      wins.find((w) => String(w.processName).toLowerCase() === p || String(w.rawProcessName).toLowerCase() === p) ||
      wins.find((w) => String(w.processName).toLowerCase().includes(p));
    return hit ? hit.hwnd : 0;
  }

  async function snapWindow(args) {
    let hwnd = num(args.hwnd, 0);
    let state0 = String(args.state || 'normal');
    let { x, y, w, h } = { x: num(args.x, 0), y: num(args.y, 0), w: num(args.w, 1), h: num(args.h, 1) };
    const zone = String(args.zonePreset || '').trim().toLowerCase();
    if (zone && zone !== 'custom' && zone !== 'none' && args.x === undefined) {
      const z = resolveZoneRect(zone);
      ({ x, y, w, h } = z);
      if (state0 !== 'minimized') state0 = z.state;
    }
    if (!hwnd && args.processName) hwnd = await findWindowByProcess(args.processName);
    if (!hwnd) return { snapped: false, reason: 'window_not_found' };
    const mons = await getMonitors(2500).catch(() => []);
    if (mons.length === 0) return { snapped: false, reason: 'no_monitors' };
    let monitorIndex = num(args.monitorIndex, 0);
    if (monitorIndex < 0 || monitorIndex >= mons.length) monitorIndex = 0;
    const mon = mons[monitorIndex];
    const id = hexId(hwnd);

    if (state0 === 'minimized') {
      if (!sys.has('xdotool')) throw new Error(missingToolMessage('xdotool'));
      await sys.exec('xdotool', ['windowminimize', String(hwnd)], { timeout: 3000 });
      return { snapped: true, hwnd, state: 'minimized' };
    }
    // Un-maximize first, otherwise the window manager ignores the move
    await wm(['-i', '-r', id, '-b', 'remove,maximized_vert,maximized_horz,fullscreen']);
    const tx = mon.workX + Math.round(x * mon.workWidth);
    const ty = mon.workY + Math.round(y * mon.workHeight);
    const tw = Math.round(w * mon.workWidth);
    const th = Math.round(h * mon.workHeight);
    await wm(['-i', '-r', id, '-e', `0,${tx},${ty},${tw},${th}`]);
    const noActivate = bool(args.noActivate);
    if (state0 === 'maximized' || (w >= 0.98 && h >= 0.98 && x <= 0.02 && y <= 0.02)) {
      await wm(['-i', '-r', id, '-b', 'add,maximized_vert,maximized_horz']);
      if (!noActivate) await wm(['-i', '-a', id]);
      return { snapped: true, hwnd, state: 'maximized', monitorIndex };
    }
    if (!noActivate) await wm(['-i', '-a', id]);
    return { snapped: true, hwnd, monitorIndex, rect: { x: tx, y: ty, width: tw, height: th } };
  }

  async function focusWindow(args) {
    const hwnd = num(args.hwnd, 0);
    if (!hwnd) return { ok: false };
    const r = await wm(['-i', '-a', hexId(hwnd)]); // also de-iconifies
    return { ok: r.code === 0 };
  }

  async function closeWindow(args) {
    const hwnd = num(args.hwnd, 0);
    if (!hwnd) return { ok: false };
    const r = await wm(['-i', '-c', hexId(hwnd)]); // graceful, like WM_CLOSE
    return { ok: r.code === 0 };
  }

  async function windowPid(hwnd) {
    const r = await wm(['-lp']).catch(() => null);
    if (!r) return 0;
    const line = r.stdout.split('\n').find((l) => l.trim() && parseInt(l.split(/\s+/)[0], 16) === hwnd);
    return line ? Number(line.trim().split(/\s+/)[2]) || 0 : 0;
  }

  async function windowAction(args) {
    const hwnd = num(args.hwnd, 0);
    const action = String(args.action || 'focus');
    if (!hwnd) return { ok: false };
    const id = hexId(hwnd);
    switch (action) {
      case 'minimize':
        if (!sys.has('xdotool')) throw new Error(missingToolMessage('xdotool'));
        await sys.exec('xdotool', ['windowminimize', String(hwnd)], { timeout: 3000 });
        return { ok: true, action };
      case 'maximize':
        await wm(['-i', '-r', id, '-b', 'add,maximized_vert,maximized_horz']);
        await wm(['-i', '-a', id]);
        return { ok: true, action };
      case 'restore':
        await wm(['-i', '-r', id, '-b', 'remove,maximized_vert,maximized_horz,fullscreen']);
        await wm(['-i', '-a', id]);
        return { ok: true, action };
      case 'close':
        await wm(['-i', '-c', id]);
        return { ok: true, action };
      case 'move_to_monitor': {
        const wins = await getWindows().catch(() => []);
        const cur = wins.find((w) => w.hwnd === hwnd);
        const wasMax = cur && cur.state === 'maximized';
        return snapWindow({
          hwnd,
          monitorIndex: num(args.monitorIndex, 0),
          state: wasMax ? 'maximized' : 'normal',
          x: wasMax ? 0 : 0.08,
          y: wasMax ? 0 : 0.08,
          w: wasMax ? 1 : 0.84,
          h: wasMax ? 1 : 0.84
        });
      }
      case 'snap_zone': {
        const z = resolveZoneRect(String(args.zone || 'full'));
        return snapWindow({ hwnd, monitorIndex: num(args.monitorIndex, 0), state: z.state, x: z.x, y: z.y, w: z.w, h: z.h });
      }
      case 'toggle_topmost': {
        let next;
        if (args.topMost !== undefined) next = bool(args.topMost);
        else {
          const st = sys.has('xprop') ? await sys.exec('xprop', ['-id', id, '_NET_WM_STATE'], { timeout: 1500 }).catch(() => null) : null;
          next = !(st && parseNetWmState(st.stdout).above);
        }
        await wm(['-i', '-r', id, '-b', (next ? 'add' : 'remove') + ',above']);
        return { ok: true, action, isTopMost: next };
      }
      case 'set_opacity': {
        const pct = clamp(Math.round(num(args.opacity, 100)), 25, 100);
        if (!sys.has('xprop')) throw new Error(missingToolMessage('xprop'));
        // Needs a compositing window manager to be visible
        await sys.exec('xprop', ['-id', id, '-f', '_NET_WM_WINDOW_OPACITY', '32c', '-set', '_NET_WM_WINDOW_OPACITY', String(Math.round((pct / 100) * 0xffffffff))], { timeout: 2000 });
        return { ok: true, action, opacity: pct };
      }
      case 'open_file_location': {
        const pid = await windowPid(hwnd);
        const { exe } = pid ? procInfo(pid) : { exe: '' };
        if (exe) {
          openPath(path.dirname(exe));
          return { ok: true, path: exe };
        }
        return { ok: false };
      }
      case 'kill_process': {
        const pid = await windowPid(hwnd);
        if (!pid) return { ok: false };
        try {
          process.kill(pid, 'SIGTERM');
          return { ok: true, pid };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
      default:
        return focusWindow({ hwnd });
    }
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------
  // ~/.config/user-dirs.dirs: XDG_DESKTOP_DIR="$HOME/Masaüstü"
  function xdgUserDir(key, fallback) {
    const home = sys.homedir();
    try {
      const text = sys.fs.readFileSync(path.join(home, '.config/user-dirs.dirs'), 'utf8');
      const m = new RegExp('^XDG_' + key + '_DIR="(.*)"', 'm').exec(text);
      if (m) return m[1].replace(/^\$HOME/, home);
    } catch {}
    return path.join(home, fallback);
  }

  function isDir(p) {
    try {
      return sys.fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  function mountRoots() {
    const roots = [];
    let text = '';
    try {
      text = sys.fs.readFileSync('/proc/mounts', 'utf8');
    } catch {}
    const points = ['/'];
    for (const line of text.split('\n')) {
      const mp = (line.split(' ')[1] || '').replace(/\\040/g, ' ');
      if (/^\/(media|mnt|run\/media)\//.test(mp)) points.push(mp);
    }
    for (const p of Array.from(new Set(points))) {
      const entry = { label: p === '/' ? 'Kök (/)' : path.basename(p), path: p, kind: 'drive' };
      try {
        if (typeof sys.fs.statfsSync === 'function') {
          const s = sys.fs.statfsSync(p);
          entry.freeGb = Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
          entry.totalGb = Math.round(((s.blocks * s.bsize) / 1024 ** 3) * 10) / 10;
          entry.label += ` (${entry.freeGb} GB boş)`;
        }
      } catch {}
      roots.push(entry);
    }
    return roots;
  }

  function isExecutableFile(p, mode) {
    return (mode & 0o111) !== 0 || /\.(sh|appimage|run)$/i.test(p);
  }

  function browseFs(args) {
    const rawPath = String(args.path || '').trim();
    const filter = String(args.query || '').trim().toLowerCase();
    const home = sys.homedir();
    const desktop = xdgUserDir('DESKTOP', 'Desktop');
    const downloads = xdgUserDir('DOWNLOAD', 'Downloads');
    const documents = xdgUserDir('DOCUMENTS', 'Documents');
    const roots = [
      { label: 'Masaüstü', path: desktop, kind: 'special' },
      { label: 'İndirilenler', path: downloads, kind: 'special' },
      { label: 'Belgeler', path: documents, kind: 'special' },
      { label: 'Ev Klasörü', path: home, kind: 'special' },
      ...mountRoots()
    ];
    const quick = { 'quick:desktop': desktop, 'quick:downloads': downloads, 'quick:documents': documents, 'quick:recent': home, 'quick:home': home };
    let target = !rawPath ? desktop : quick[rawPath] || rawPath;
    if (!isDir(target)) target = isDir(desktop) ? desktop : home;
    const parentPath = path.dirname(target) === target ? '' : path.dirname(target);

    const dirs = [];
    const files = [];
    let names = [];
    try {
      names = sys.fs.readdirSync(target);
    } catch {}
    names.sort((a, b) => a.localeCompare(b, 'tr', { sensitivity: 'base' }));
    for (const name of names) {
      if (name.startsWith('.')) continue; // hidden on Linux
      if (filter && !name.toLowerCase().includes(filter)) continue;
      const full = path.join(target, name);
      let st;
      try {
        st = sys.fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        dirs.push({
          name,
          path: full,
          isDir: true,
          targetType: 'folder',
          ext: 'KLASÖR',
          sizeBytes: 0,
          sizeFormatted: 'Klasör',
          modifiedAt: formatDate(st.mtime),
          defaultAppName: 'Dosya Yöneticisi',
          defaultAppExe: 'xdg-open'
        });
      } else if (st.isFile() && files.length < 160) {
        const ext = path.extname(name).toLowerCase();
        files.push({
          name,
          path: full,
          isDir: false,
          targetType: isExecutableFile(name, st.mode) || ext === '.desktop' ? 'app' : 'file',
          ext: ext ? ext.slice(1).toUpperCase() : 'DOSYA',
          sizeBytes: st.size,
          sizeFormatted: formatFileSize(st.size),
          modifiedAt: formatDate(st.mtime),
          defaultAppName: 'Varsayılan Uygulama',
          defaultAppExe: 'xdg-open'
        });
      }
    }
    return { currentPath: target, parentPath, roots, entries: dirs.concat(files) };
  }

  function inspectTarget(args) {
    let rawPath = String(args.path || '').trim();
    const hwnd = num(args.hwnd, 0);
    const info = {
      path: rawPath,
      hwnd,
      exists: false,
      isDir: false,
      isUrl: false,
      targetType: 'file',
      name: '',
      fullPath: rawPath,
      directory: '',
      extension: '',
      sizeBytes: 0,
      sizeFormatted: '-',
      createdAt: '-',
      modifiedAt: '-',
      productName: '',
      fileDescription: '',
      fileVersion: '',
      companyName: '',
      defaultAppName: 'Varsayılan Uygulama',
      defaultAppExe: 'xdg-open'
    };
    if (/^https?:\/\//i.test(rawPath)) {
      return { ...info, exists: true, isUrl: true, targetType: 'url', name: rawPath, extension: 'URL', defaultAppName: 'Varsayılan Tarayıcı' };
    }
    if (!rawPath) return info;
    let st;
    try {
      st = sys.fs.statSync(rawPath);
    } catch {
      return info;
    }
    info.exists = true;
    info.name = path.basename(rawPath);
    info.fullPath = path.resolve(rawPath);
    info.directory = path.dirname(info.fullPath);
    info.createdAt = formatDate(st.birthtime && st.birthtime.getTime() > 0 ? st.birthtime : st.ctime);
    info.modifiedAt = formatDate(st.mtime);
    if (st.isDirectory()) {
      info.isDir = true;
      info.targetType = 'folder';
      info.extension = 'KLASÖR';
      info.defaultAppName = 'Dosya Yöneticisi';
      try {
        const names = sys.fs.readdirSync(rawPath);
        let d = 0;
        for (const n of names) if (isDir(path.join(rawPath, n))) d++;
        info.sizeFormatted = `${d} klasör, ${names.length - d} dosya`;
      } catch {
        info.sizeFormatted = 'Klasör';
      }
      return info;
    }
    const ext = path.extname(rawPath).toLowerCase();
    info.extension = ext ? ext.slice(1).toUpperCase() : 'DOSYA';
    info.sizeBytes = st.size;
    info.sizeFormatted = formatFileSize(st.size);
    if (ext === '.desktop') {
      const e = readDesktopFile(rawPath) || {};
      info.targetType = 'app';
      info.productName = desktopName(e);
      info.fileDescription = e.Comment || '';
    } else if (isExecutableFile(rawPath, st.mode)) {
      info.targetType = 'app';
    }
    return info;
  }

  function getFileIcon(args) {
    const p = String(args.path || '').trim();
    if (!p) return { icon: '' };
    if (p.endsWith('.desktop')) {
      const e = readDesktopFile(p);
      return { icon: e ? iconDataUrl(e.Icon || '') : '' };
    }
    if (/\.(png|svg)$/i.test(p)) return { icon: iconDataUrl(p) };
    // A bare program name: look it up among the installed apps
    return { icon: iconForProcess(path.basename(p)) };
  }

  // -------------------------------------------------------------------------
  // Launching
  // -------------------------------------------------------------------------
  function openPath(target) {
    if (sys.has('xdg-open')) return sys.spawnDetached('xdg-open', [target]);
    if (sys.has('gio')) return sys.spawnDetached('gio', ['open', target]);
    throw new Error(missingToolMessage('xdg-open'));
  }

  function launchDesktopFile(file, extraArgs) {
    const id = path.basename(file);
    const e = readDesktopFile(file);
    if (!e) throw new Error('Uygulama kısayolu okunamadı: ' + file);
    // gtk-launch only finds entries in the standard directories and cannot pass extra arguments
    const inStdDir = appDirs().includes(path.dirname(file));
    if (sys.has('gtk-launch') && inStdDir && extraArgs.length === 0) {
      return { pid: sys.spawnDetached('gtk-launch', [id.replace(/\.desktop$/, '')]), processName: e.StartupWMClass || path.basename(parseDesktopExec(e.Exec)[0] || '') };
    }
    const argv = parseDesktopExec(e.Exec).concat(extraArgs);
    if (!argv.length) throw new Error('Uygulama komutu boş: ' + file);
    return { pid: sys.spawnDetached(argv[0], argv.slice(1), { cwd: e.Path }), processName: e.StartupWMClass || path.basename(argv[0]) };
  }

  function isExecutablePath(p) {
    try {
      const st = sys.fs.statSync(p);
      return st.isFile() && (st.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  }

  async function executeQuickItem(args) {
    const targetPath = String(args.targetPath || '').trim();
    const openWithMode = String(args.openWithMode || 'default');
    const openWithPath = String(args.openWithPath || '').trim();
    const extraArgs = splitArgs(String(args.arguments || '').trim());
    const workingDir = String(args.workingDirectory || '').trim();
    const ifRunning = String(args.ifRunning || 'new').toLowerCase();
    const monitorIndex = args.monitorIndex === undefined ? -1 : num(args.monitorIndex, -1);
    const zone = String(args.zone || 'none').toLowerCase();
    const windowStyle = String(args.windowStyle || 'normal').toLowerCase();
    const alwaysOnTop = bool(args.alwaysOnTop);
    if (!targetPath) return { ok: false, error: 'Hedef yol boş' };

    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(targetPath);
    let procCandidate = String(args.processName || '').trim();
    if (!procCandidate) {
      if (openWithMode !== 'default' && openWithPath) procCandidate = path.basename(openWithPath).replace(/\.desktop$/, '');
      else if (targetPath.endsWith('.desktop')) {
        const e = readDesktopFile(targetPath);
        if (e) procCandidate = e.StartupWMClass || path.basename(parseDesktopExec(e.Exec || '')[0] || '');
      } else if (!isUrl && !isDir(targetPath) && (isExecutablePath(targetPath) || !targetPath.includes('/'))) {
        procCandidate = path.basename(targetPath);
      }
    }

    if (procCandidate && ifRunning === 'focus') {
      const hwnd = await findWindowByProcess(procCandidate);
      if (hwnd) {
        await applyPostLaunchRules(hwnd, procCandidate, monitorIndex, zone, windowStyle, alwaysOnTop);
        return { ok: true, mode: 'reused_existing', hwnd, processName: procCandidate };
      }
    } else if (procCandidate && ifRunning === 'restart' && sys.has('pkill')) {
      await sys.exec('pkill', ['-x', procCandidate.slice(0, 15)], { timeout: 3000 }).catch(() => {});
      await sleep(400);
    }

    const before = new Set((await getWindows().catch(() => [])).map((w) => w.hwnd));
    let startedPid = 0;
    try {
      if (openWithMode !== 'default' && openWithPath) {
        if (openWithPath.endsWith('.desktop')) startedPid = launchDesktopFile(openWithPath, [targetPath, ...extraArgs]).pid;
        else startedPid = sys.spawnDetached(openWithPath, [targetPath, ...extraArgs], { cwd: workingDir });
      } else if (targetPath.endsWith('.desktop')) {
        const r = launchDesktopFile(targetPath, extraArgs);
        startedPid = r.pid;
        if (!procCandidate) procCandidate = r.processName;
      } else if (isUrl || isDir(targetPath)) {
        startedPid = openPath(targetPath);
      } else if (isExecutablePath(targetPath)) {
        startedPid = sys.spawnDetached(targetPath, extraArgs, { cwd: workingDir || path.dirname(targetPath) });
      } else if (!targetPath.includes('/') && sys.has(targetPath)) {
        startedPid = sys.spawnDetached(targetPath, extraArgs, { cwd: workingDir });
      } else if (sys.fs.existsSync(targetPath)) {
        startedPid = openPath(targetPath);
      } else {
        return { ok: false, error: 'Hedef bulunamadı: ' + targetPath };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }

    // Place the new window in the background so launching returns immediately
    if (monitorIndex >= 0 || (zone !== 'none' && zone) || alwaysOnTop || windowStyle === 'maximized' || windowStyle === 'minimized') {
      (async () => {
        for (let attempt = 1; attempt <= 22; attempt++) {
          await sleep(250);
          const wins = await getWindows().catch(() => []);
          const pc = procCandidate.toLowerCase();
          let hit = wins.find(
            (w) => !before.has(w.hwnd) && (!pc || String(w.processName).toLowerCase() === pc || (startedPid && w.pid === startedPid))
          );
          if (!hit && pc && attempt >= 5) hit = wins.find((w) => String(w.processName).toLowerCase() === pc);
          if (hit) {
            await applyPostLaunchRules(hit.hwnd, procCandidate, monitorIndex, zone, windowStyle, alwaysOnTop);
            return;
          }
        }
      })().catch(() => {});
    }
    return { ok: true, targetPath, openWithPath, hwnd: 0, processName: procCandidate };
  }

  async function applyPostLaunchRules(hwnd, procName, monitorIndex, zone, windowStyle, alwaysOnTop) {
    const explicitZone = zone && zone !== 'none' && zone !== 'custom' && zone !== 'default';
    if (windowStyle === 'minimized') {
      await windowAction({ hwnd, action: 'minimize' }).catch(() => {});
    } else if (explicitZone || windowStyle === 'maximized') {
      const z = explicitZone ? resolveZoneRect(zone) : { x: 0, y: 0, w: 1, h: 1, state: 'maximized' };
      await snapWindow({ hwnd, processName: procName, monitorIndex: monitorIndex >= 0 ? monitorIndex : 0, state: z.state, x: z.x, y: z.y, w: z.w, h: z.h }).catch(() => {});
    } else if (monitorIndex >= 0) {
      // Keep the app's own size, centre it on the requested monitor
      const wins = await getWindows().catch(() => []);
      const cur = wins.find((w) => w.hwnd === hwnd);
      const mons = await getMonitors(2500).catch(() => []);
      const mon = mons[monitorIndex] || mons[0];
      if (cur && mon) {
        const nx = mon.workX + Math.max(0, Math.round((mon.workWidth - cur.rect.width) / 2));
        const ny = mon.workY + Math.max(0, Math.round((mon.workHeight - cur.rect.height) / 2));
        await wm(['-i', '-r', hexId(hwnd), '-e', `0,${nx},${ny},-1,-1`]).catch(() => {});
      }
    }
    if (alwaysOnTop) await wm(['-i', '-r', hexId(hwnd), '-b', 'add,above']).catch(() => {});
  }

  return {
    state,
    getMonitors,
    getMonitorBounds,
    setBrightness,
    monitorPower,
    monitorBlackout,
    displayTopology,
    getInstalledApps,
    getWindows,
    snapWindow,
    focusWindow,
    closeWindow,
    windowAction,
    browseFs,
    inspectTarget,
    getFileIcon,
    executeQuickItem,
    openPath,
    iconForProcess
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

module.exports = { createDesktop };
