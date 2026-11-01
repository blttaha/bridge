'use strict';
// Pure text parsers for the output of the Linux tools (X11 + Wayland compositors). No I/O here, so every function is unit tested.

// ---------------------------------------------------------------------------
// xrandr --query
// ---------------------------------------------------------------------------
// Returns connected outputs that have a mode set, primary first, then left-to-right (same order as the
// Windows bridge). Outputs without geometry (connected but off) are reported in `inactive`.
function parseXrandr(text) {
  const outputs = [];
  const inactive = [];
  let screen = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const s = /^Screen \d+:.*current (\d+) x (\d+)/.exec(line);
    if (s) {
      screen = { width: Number(s[1]), height: Number(s[2]) };
      continue;
    }
    const m = /^(\S+) connected( primary)?(?: (\d+)x(\d+)([+-]\d+)([+-]\d+))?/.exec(line);
    if (!m) continue;
    if (m[3] === undefined) {
      inactive.push(m[1]);
      continue;
    }
    outputs.push({
      name: m[1],
      isPrimary: Boolean(m[2]),
      x: Number(m[5]),
      y: Number(m[6]),
      width: Number(m[3]),
      height: Number(m[4])
    });
  }
  // Some virtual servers (old Xvfb) report no outputs at all: fall back to the screen size
  if (outputs.length === 0 && screen) {
    outputs.push({ name: 'default', isPrimary: true, x: 0, y: 0, width: screen.width, height: screen.height, virtual: true });
  }
  return sortMonitorOutputs(outputs, inactive, screen);
}

function sortMonitorOutputs(outputs, inactive = [], screen = null) {
  if (outputs.length > 0 && !outputs.some((o) => o.isPrimary)) {
    const first = outputs.slice().sort((a, b) => a.x - b.x || a.y - b.y)[0];
    first.isPrimary = true;
  }
  outputs.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.x - b.x || a.y - b.y;
  });
  return { outputs, inactive, screen };
}

// ---------------------------------------------------------------------------
// Wayland monitor parsers: Hyprland, Sway/i3, KDE kscreen-doctor, wlr-randr
// ---------------------------------------------------------------------------
function parseHyprMonitors(jsonText) {
  let list = [];
  try {
    list = JSON.parse(String(jsonText || '[]'));
  } catch {
    return { outputs: [], inactive: [], screen: null };
  }
  if (!Array.isArray(list)) return { outputs: [], inactive: [], screen: null };
  const outputs = [];
  const inactive = [];
  for (const m of list) {
    if (!m || !m.name) continue;
    if (m.disabled) {
      inactive.push(m.name);
      continue;
    }
    const scale = Number(m.scale) > 0 ? Number(m.scale) : 1;
    const rawW = Number(m.width) || 1920;
    const rawH = Number(m.height) || 1080;
    const transform = Number(m.transform) || 0;
    const rotated = transform % 2 === 1;
    const w = Math.round((rotated ? rawH : rawW) / scale);
    const h = Math.round((rotated ? rawW : rawH) / scale);
    const x = Number(m.x) || 0;
    const y = Number(m.y) || 0;
    const res = Array.isArray(m.reserved) ? m.reserved : [0, 0, 0, 0]; // [left, top, right, bottom]
    outputs.push({
      name: String(m.name),
      isPrimary: Boolean(m.focused) || m.id === 0,
      x,
      y,
      width: w,
      height: h,
      workX: x + (Number(res[0]) || 0),
      workY: y + (Number(res[1]) || 0),
      workWidth: Math.max(200, w - (Number(res[0]) || 0) - (Number(res[2]) || 0)),
      workHeight: Math.max(200, h - (Number(res[1]) || 0) - (Number(res[3]) || 0))
    });
  }
  return sortMonitorOutputs(outputs, inactive);
}

function parseSwayOutputs(jsonText) {
  let list = [];
  try {
    list = JSON.parse(String(jsonText || '[]'));
  } catch {
    return { outputs: [], inactive: [], screen: null };
  }
  if (!Array.isArray(list)) return { outputs: [], inactive: [], screen: null };
  const outputs = [];
  const inactive = [];
  for (const o of list) {
    if (!o || !o.name) continue;
    if (o.active === false) {
      inactive.push(o.name);
      continue;
    }
    const rect = o.rect || {};
    outputs.push({
      name: String(o.name),
      isPrimary: Boolean(o.primary || o.focused),
      x: Number(rect.x) || 0,
      y: Number(rect.y) || 0,
      width: Number(rect.width) || 1920,
      height: Number(rect.height) || 1080
    });
  }
  return sortMonitorOutputs(outputs, inactive);
}

function parseKscreenMonitors(text) {
  const raw = String(text || '').trim();
  const outputs = [];
  const inactive = [];
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      const list = Array.isArray(obj.outputs) ? obj.outputs : [];
      for (const o of list) {
        if (!o || !o.name) continue;
        if (o.connected === false) continue;
        if (o.enabled === false) {
          inactive.push(String(o.name));
          continue;
        }
        const pos = o.pos || { x: 0, y: 0 };
        const size = o.size || { width: 1920, height: 1080 };
        outputs.push({
          name: String(o.name),
          isPrimary: Boolean(o.primary || o.priority === 1),
          x: Number(pos.x) || 0,
          y: Number(pos.y) || 0,
          width: Number(size.width) || 1920,
          height: Number(size.height) || 1080
        });
      }
      return sortMonitorOutputs(outputs, inactive);
    } catch {}
  }
  // Fallback: kscreen-doctor -o text output (strip ANSI escape codes)
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, '');
  let cur = null;
  for (const line of clean.split('\n')) {
    const h = /^\s*Output:\s*\d+\s+(\S+)/.exec(line);
    if (h) {
      if (cur && cur.connected) {
        if (cur.enabled) outputs.push(cur.data);
        else inactive.push(cur.data.name);
      }
      cur = {
        connected: !/\bdisconnected\b/i.test(line),
        enabled: /\benabled\b/i.test(line),
        data: { name: h[1], isPrimary: /\bprimary\b/i.test(line) || /priority 1\b/i.test(line), x: 0, y: 0, width: 1920, height: 1080 }
      };
      const geo = /Geometry:\s*(-?\d+),(-?\d+)\s+(\d+)x(\d+)/i.exec(line);
      if (geo) {
        cur.data.x = Number(geo[1]);
        cur.data.y = Number(geo[2]);
        cur.data.width = Number(geo[3]);
        cur.data.height = Number(geo[4]);
      }
      continue;
    }
    if (!cur) continue;
    if (/\bdisconnected\b/i.test(line)) cur.connected = false;
    if (/\benabled\b/i.test(line)) cur.enabled = true;
    if (/\bdisabled\b/i.test(line)) cur.enabled = false;
    if (/\bprimary\b/i.test(line) || /priority 1\b/i.test(line)) cur.data.isPrimary = true;
    const geo = /Geometry:\s*(-?\d+),(-?\d+)\s+(\d+)x(\d+)/i.exec(line);
    if (geo) {
      cur.data.x = Number(geo[1]);
      cur.data.y = Number(geo[2]);
      cur.data.width = Number(geo[3]);
      cur.data.height = Number(geo[4]);
    }
  }
  if (cur && cur.connected) {
    if (cur.enabled) outputs.push(cur.data);
    else inactive.push(cur.data.name);
  }
  return sortMonitorOutputs(outputs, inactive);
}

function parseWlrRandr(text) {
  const raw = String(text || '').trim();
  const outputs = [];
  const inactive = [];
  if (raw.startsWith('[')) {
    try {
      const list = JSON.parse(raw);
      for (const o of list) {
        if (!o || !o.name) continue;
        if (o.enabled === false) {
          inactive.push(String(o.name));
          continue;
        }
        const curMode = (Array.isArray(o.modes) && o.modes.find((m) => m.current)) || (o.modes && o.modes[0]) || {};
        const pos = o.position || { x: 0, y: 0 };
        const scale = Number(o.scale) > 0 ? Number(o.scale) : 1;
        outputs.push({
          name: String(o.name),
          isPrimary: outputs.length === 0,
          x: Number(pos.x) || 0,
          y: Number(pos.y) || 0,
          width: Math.round((Number(curMode.width) || 1920) / scale),
          height: Math.round((Number(curMode.height) || 1080) / scale)
        });
      }
      return sortMonitorOutputs(outputs, inactive);
    } catch {}
  }
  // Plain text wlr-randr output
  let cur = null;
  for (const line of raw.split('\n')) {
    if (/^\S/.test(line)) {
      if (cur) {
        if (cur.enabled) outputs.push(cur.data);
        else inactive.push(cur.data.name);
      }
      const name = line.trim().split(/\s+/)[0];
      cur = { enabled: true, data: { name, isPrimary: outputs.length === 0, x: 0, y: 0, width: 1920, height: 1080 } };
      continue;
    }
    if (!cur) continue;
    const en = /^\s*Enabled:\s*(yes|no)/i.exec(line);
    if (en) cur.enabled = en[1].toLowerCase() === 'yes';
    const pos = /^\s*Position:\s*(-?\d+)\s*,\s*(-?\d+)/i.exec(line);
    if (pos) {
      cur.data.x = Number(pos[1]);
      cur.data.y = Number(pos[2]);
    }
    const mode = /^\s*(\d+)x(\d+)\s+px,.*current/i.exec(line);
    if (mode) {
      cur.data.width = Number(mode[1]);
      cur.data.height = Number(mode[2]);
    }
  }
  if (cur) {
    if (cur.enabled) outputs.push(cur.data);
    else inactive.push(cur.data.name);
  }
  return sortMonitorOutputs(outputs, inactive);
}

// "_NET_WORKAREA(CARDINAL) = 0, 27, 3840, 1053, 0, 27, ..." -> first desktop's rect
function parseNetWorkarea(text) {
  const m = /=\s*(-?\d+),\s*(-?\d+),\s*(\d+),\s*(\d+)/.exec(String(text || ''));
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
}

// Work area of one monitor = monitor rect ∩ desktop work area (panels are excluded)
function intersectWorkarea(mon, wa) {
  if (mon.workWidth && mon.workHeight) {
    return { x: mon.workX || mon.x, y: mon.workY || mon.y, width: mon.workWidth, height: mon.workHeight };
  }
  if (!wa) return { x: mon.x, y: mon.y, width: mon.width, height: mon.height };
  const x1 = Math.max(mon.x, wa.x);
  const y1 = Math.max(mon.y, wa.y);
  const x2 = Math.min(mon.x + mon.width, wa.x + wa.width);
  const y2 = Math.min(mon.y + mon.height, wa.y + wa.height);
  if (x2 - x1 < mon.width * 0.5 || y2 - y1 < mon.height * 0.5) {
    return { x: mon.x, y: mon.y, width: mon.width, height: mon.height };
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

// ---------------------------------------------------------------------------
// wmctrl -lpG + Wayland window parsers (Hyprland, Sway/i3)
// ---------------------------------------------------------------------------
// "0x03a00003  0 12345  10   52   800  600  host Window title"
function parseWmctrl(text) {
  const list = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line.trim());
    if (!m) continue;
    list.push({
      id: m[1],
      hwnd: parseInt(m[1], 16),
      desktop: Number(m[2]),
      pid: Number(m[3]),
      x: Number(m[4]),
      y: Number(m[5]),
      width: Number(m[6]),
      height: Number(m[7]),
      host: m[8],
      title: m[9] || ''
    });
  }
  return list;
}

function parseHyprClients(jsonText) {
  let list = [];
  try {
    list = JSON.parse(String(jsonText || '[]'));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    if (!c || c.mapped === false || !c.title) continue;
    const addrStr = String(c.address || '');
    // Use low 32 bits of address for numeric hwnd while preserving full hex address
    const cleanHex = addrStr.replace(/^0x/i, '').slice(-8);
    const hwnd = parseInt(cleanHex || '0', 16) || out.length + 1;
    const at = Array.isArray(c.at) ? c.at : [0, 0];
    const sz = Array.isArray(c.size) ? c.size : [800, 600];
    const wsName = String((c.workspace && c.workspace.name) || '');
    const isMin = Boolean(c.hidden) || wsName.startsWith('special:minimized');
    const isMax = Boolean(c.fullscreen) || Number(c.fullscreen) > 0 || Number(c.fullscreenClient) > 0;
    out.push({
      id: addrStr.startsWith('0x') ? addrStr : '0x' + cleanHex,
      hwnd,
      address: addrStr,
      pid: Number(c.pid) || 0,
      title: String(c.title || ''),
      appClass: String(c.class || c.initialClass || ''),
      x: Number(at[0]) || 0,
      y: Number(at[1]) || 0,
      width: Number(sz[0]) || 800,
      height: Number(sz[1]) || 600,
      state: isMin ? 'minimized' : isMax ? 'maximized' : 'normal',
      above: Boolean(c.pinned),
      focusHistoryID: Number(c.focusHistoryID) || 0
    });
  }
  // Sort so most recently focused (lowest focusHistoryID) is last (matching wmctrl bottom-to-top order before reverse)
  out.sort((a, b) => b.focusHistoryID - a.focusHistoryID);
  return out;
}

function parseSwayTree(jsonText) {
  let root = null;
  try {
    root = JSON.parse(String(jsonText || '{}'));
  } catch {
    return [];
  }
  if (!root || typeof root !== 'object') return [];
  const out = [];
  function walk(node, inScratchpad = false) {
    if (!node || typeof node !== 'object') return;
    const scratch = inScratchpad || node.name === '__i3_scratch';
    const isCon = (node.type === 'con' || node.type === 'floating_con') && (node.pid || node.app_id || node.window_properties);
    if (isCon && node.name) {
      const rect = node.rect || {};
      const wp = node.window_properties || {};
      const isMax = Number(node.fullscreen_mode) > 0;
      out.push({
        id: '0x' + Number(node.id || out.length + 1).toString(16).padStart(8, '0'),
        hwnd: Number(node.id) || out.length + 1,
        pid: Number(node.pid) || 0,
        title: String(node.name || wp.title || ''),
        appClass: String(node.app_id || wp.class || wp.instance || ''),
        x: Number(rect.x) || 0,
        y: Number(rect.y) || 0,
        width: Number(rect.width) || 800,
        height: Number(rect.height) || 600,
        state: scratch ? 'minimized' : isMax ? 'maximized' : 'normal',
        above: Boolean(node.sticky),
        focused: Boolean(node.focused)
      });
    }
    const children = [].concat(node.nodes || [], node.floating_nodes || []);
    for (const ch of children) walk(ch, scratch);
  }
  walk(root, false);
  return out;
}

// xprop -id X _NET_WM_STATE  ->  "minimized" | "maximized" | "normal" (+ above flag)
function parseNetWmState(text) {
  const t = String(text || '');
  const above = t.includes('_NET_WM_STATE_ABOVE');
  if (t.includes('_NET_WM_STATE_HIDDEN')) return { state: 'minimized', above };
  if (t.includes('_NET_WM_STATE_MAXIMIZED_VERT') && t.includes('_NET_WM_STATE_MAXIMIZED_HORZ')) return { state: 'maximized', above };
  if (t.includes('_NET_WM_STATE_FULLSCREEN')) return { state: 'maximized', above };
  return { state: 'normal', above };
}

// Same zone names as ClassifyZone() in the C# bridge
function classifyZone(state, x, y, w, h) {
  const near = (a, b, tol) => Math.abs(a - b) < tol;
  if (state === 'maximized' || (w >= 0.92 && h >= 0.92)) return 'fullscreen';
  if (near(x, 0, 0.08) && near(y, 0, 0.08) && near(w, 0.5, 0.1) && h >= 0.9) return 'left-half';
  if (near(x, 0.5, 0.08) && near(y, 0, 0.08) && near(w, 0.5, 0.1) && h >= 0.9) return 'right-half';
  if (near(x, 0, 0.08) && near(y, 0, 0.08) && w >= 0.9 && near(h, 0.5, 0.1)) return 'top-half';
  if (near(x, 0, 0.08) && near(y, 0.5, 0.08) && w >= 0.9 && near(h, 0.5, 0.1)) return 'bottom-half';
  if (near(x, 0, 0.08) && near(y, 0, 0.08) && near(w, 0.5, 0.1) && near(h, 0.5, 0.1)) return 'top-left';
  if (near(x, 0.5, 0.08) && near(y, 0, 0.08) && near(w, 0.5, 0.1) && near(h, 0.5, 0.1)) return 'top-right';
  if (near(x, 0, 0.08) && near(y, 0.5, 0.08) && near(w, 0.5, 0.1) && near(h, 0.5, 0.1)) return 'bottom-left';
  if (near(x, 0.5, 0.08) && near(y, 0.5, 0.08) && near(w, 0.5, 0.1) && near(h, 0.5, 0.1)) return 'bottom-right';
  return 'custom';
}

// Same table as ResolveZoneRect() in the C# bridge
function resolveZoneRect(zone) {
  const z = String(zone || '').toLowerCase();
  const r = (x, y, w, h, state = 'normal') => ({ x, y, w, h, state });
  switch (z) {
    case 'full':
    case 'fullscreen':
    case 'maximized':
      return r(0, 0, 1, 1, 'maximized');
    case 'left-half':
      return r(0, 0, 0.5, 1);
    case 'right-half':
      return r(0.5, 0, 0.5, 1);
    case 'top-half':
      return r(0, 0, 1, 0.5);
    case 'bottom-half':
      return r(0, 0.5, 1, 0.5);
    case 'top-left':
      return r(0, 0, 0.5, 0.5);
    case 'top-right':
      return r(0.5, 0, 0.5, 0.5);
    case 'bottom-left':
      return r(0, 0.5, 0.5, 0.5);
    case 'bottom-right':
      return r(0.5, 0.5, 0.5, 0.5);
    case 'center':
      return r(0.12, 0.1, 0.76, 0.8);
    default:
      return r(0.08, 0.08, 0.84, 0.84);
  }
}

// ---------------------------------------------------------------------------
// pactl + wpctl (PipeWire / WirePlumber)
// ---------------------------------------------------------------------------
// "Volume: front-left: 32768 /  50% / -18.06 dB,   front-right: ..." -> 50 (average of channels)
function parsePactlVolume(text) {
  const pcts = [];
  const re = /(\d+)%/g;
  const line = String(text || '').split('\n').find((l) => /Volume:/.test(l) && !/Base Volume/.test(l)) || String(text || '');
  let m;
  while ((m = re.exec(line))) pcts.push(Number(m[1]));
  if (pcts.length === 0) return null;
  return Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
}

// "Mute: yes" -> true
function parsePactlMute(text) {
  const m = /Mute:\s*(yes|no)/i.exec(String(text || ''));
  return m ? m[1].toLowerCase() === 'yes' : null;
}

// "Volume: 0.65 [MUTED]" -> { volume: 65, muted: true }
function parseWpctlVolume(text) {
  const s = String(text || '');
  const m = /Volume:\s*([0-9.]+)/i.exec(s);
  if (!m) return null;
  return {
    volume: Math.max(0, Math.min(100, Math.round(Number(m[1]) * 100))),
    muted: /\[MUTED\]/i.test(s)
  };
}

// Splits "pactl list <kind>" output into blocks: { id, fields: {Key: value}, props: {key: value} }
function parsePactlBlocks(text, header) {
  const blocks = [];
  let cur = null;
  let inProps = false;
  const headerRe = new RegExp('^' + header + ' #(\\d+)');
  for (const raw of String(text || '').split('\n')) {
    const h = headerRe.exec(raw);
    if (h) {
      cur = { id: Number(h[1]), fields: {}, props: {} };
      blocks.push(cur);
      inProps = false;
      continue;
    }
    if (!cur) continue;
    const line = raw.trim();
    if (!line) continue;
    if (/^Properties:$/.test(line)) {
      inProps = true;
      continue;
    }
    const prop = /^([\w.\-]+) = "(.*)"$/.exec(line);
    if (inProps && prop) {
      cur.props[prop[1]] = prop[2];
      continue;
    }
    const f = /^([A-Z][\w ]*):\s*(.*)$/.exec(line);
    if (f) {
      inProps = false;
      cur.fields[f[1]] = f[2];
    }
  }
  return blocks;
}

// Per-application audio sessions, shaped like the Windows mixer sessions
function parsePactlSinkInputs(text) {
  return parsePactlBlocks(text, 'Sink Input').map((b) => {
    const binary = b.props['application.process.binary'] || '';
    const name = b.props['application.name'] || binary || b.props['media.name'] || 'Uygulama';
    return {
      sinkInputId: b.id,
      pid: Number(b.props['application.process.id'] || 0),
      processName: name,
      rawProcessName: binary || name,
      icon: '',
      volume: parsePactlVolume('Volume: ' + (b.fields.Volume || '')) ?? 100,
      muted: /^yes$/i.test(b.fields.Mute || ''),
      isActive: !/^yes$/i.test(b.fields.Corked || '')
    };
  });
}

// Old pactl (< 14) has no get-sink-volume: find the default sink in "pactl list sinks"
function parsePactlSinks(text, defaultName) {
  const blocks = parsePactlBlocks(text, 'Sink');
  const pick = blocks.find((b) => b.fields.Name === defaultName) || blocks[0];
  if (!pick) return null;
  return {
    name: pick.fields.Name,
    volume: parsePactlVolume('Volume: ' + (pick.fields.Volume || '')),
    muted: /^yes$/i.test(pick.fields.Mute || '')
  };
}

// ---------------------------------------------------------------------------
// playerctl -a metadata --format '...'
// ---------------------------------------------------------------------------
const PLAYERCTL_FORMAT = '{{playerName}}\t{{status}}\t{{title}}\t{{artist}}\t{{mpris:length}}\t{{position}}';

function parsePlayerctlLines(text) {
  const players = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim() || line.indexOf('\t') < 0) continue;
    const [player, status, title, artist, length, position] = line.split('\t');
    players.push({
      player: player || '',
      status: status || '',
      isPlaying: /^playing$/i.test(status || ''),
      title: title || '',
      artist: artist || '',
      durationSec: Math.round((Number(length) || 0) / 1e4) / 100, // microseconds
      positionSec: Math.round((Number(position) || 0) / 1e4) / 100
    });
  }
  return players;
}

// Playing players win, otherwise the first (playerctl lists the most recently active first)
function pickPlayer(players) {
  return players.find((p) => p.isPlaying) || players.find((p) => /^paused$/i.test(p.status)) || players[0] || null;
}

// "spotify" / "firefox.instance_1_23" -> "Spotify" / "Firefox"
function friendlyPlayerName(player) {
  const base = String(player || '').split('.')[0];
  if (!base) return 'Medya';
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// ---------------------------------------------------------------------------
// /proc
// ---------------------------------------------------------------------------
// First "cpu" line of /proc/stat -> { idle, total }
function parseProcStat(text) {
  const line = String(text || '').split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (v[3] || 0) + (v[4] || 0); // idle + iowait
  const total = v.slice(0, 8).reduce((a, b) => a + (b || 0), 0); // guest is already in user
  return { idle, total };
}

function cpuPercent(prev, cur) {
  if (!prev || !cur) return 0;
  const dt = cur.total - prev.total;
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((dt - (cur.idle - prev.idle)) / dt) * 100)));
}

function parseMeminfo(text) {
  const kb = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kb[m[1]] = Number(m[2]);
  }
  const total = kb.MemTotal || 0;
  const avail = kb.MemAvailable !== undefined ? kb.MemAvailable : (kb.MemFree || 0) + (kb.Buffers || 0) + (kb.Cached || 0);
  const used = Math.max(0, total - avail);
  const gb = (k) => Math.round((k / 1024 / 1024) * 10) / 10;
  return {
    memoryPercent: total ? Math.round((used / total) * 100) : 0,
    usedRamGb: gb(used),
    totalRamGb: gb(total)
  };
}

function parseUptime(text) {
  const v = parseFloat(String(text || '').split(/\s+/)[0]);
  return Number.isFinite(v) ? Math.floor(v) : 0;
}

// ---------------------------------------------------------------------------
// .desktop entries
// ---------------------------------------------------------------------------
function parseDesktopEntry(text) {
  const out = {};
  let inMain = false;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inMain = line === '[Desktop Entry]';
      continue;
    }
    if (!inMain) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!(key in out)) out[key] = line.slice(eq + 1).trim();
  }
  return out;
}

// Localised Name (Name[tr]) wins over Name
function desktopName(entry, lang = 'tr') {
  return entry[`Name[${lang}]`] || entry.Name || '';
}

function isDesktopEntryVisible(entry) {
  if (!entry || (entry.Type && entry.Type !== 'Application')) return false;
  if (/^true$/i.test(entry.NoDisplay || '') || /^true$/i.test(entry.Hidden || '')) return false;
  if (!entry.Exec || !entry.Name) return false;
  return true;
}

// Shell-like split that honours double/single quotes and backslash escapes
function splitArgs(str) {
  const args = [];
  let cur = '';
  let quote = null;
  let has = false;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) args.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur) args.push(cur);
  return args;
}

// Exec line -> argv without the %f/%U/... field codes (the spec's "%%" means a literal percent)
function parseDesktopExec(exec) {
  return splitArgs(exec)
    .filter((a) => !/^%[fFuUdDnNickvm]$/.test(a))
    .map((a) => a.replace(/%[fFuUdDnNickvm]/g, '').replace(/%%/g, '%'))
    .filter((a) => a.length > 0);
}

// ---------------------------------------------------------------------------
// xdotool / Wayland cursor & key mapping
// ---------------------------------------------------------------------------
// "x:812 y:403 screen:0 window:6291462" or Hyprland "812, 403"
function parseMouseLocation(text) {
  const s = String(text || '').trim();
  const m = /x:(-?\d+)\s+y:(-?\d+)/.exec(s);
  if (m) return { x: Number(m[1]), y: Number(m[2]) };
  const h = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(s);
  if (h) return { x: Number(h[1]), y: Number(h[2]) };
  return null;
}

// Windows key names used by the phone -> X / XKB keysyms
const KEY_MAP = {
  CTRL: 'ctrl',
  CONTROL: 'ctrl',
  ALT: 'alt',
  SHIFT: 'shift',
  WIN: 'super',
  LWIN: 'super',
  SUPER: 'super',
  ENTER: 'Return',
  RETURN: 'Return',
  ESC: 'Escape',
  ESCAPE: 'Escape',
  BACKSPACE: 'BackSpace',
  BS: 'BackSpace',
  TAB: 'Tab',
  SPACE: 'space',
  DELETE: 'Delete',
  DEL: 'Delete',
  INSERT: 'Insert',
  UP: 'Up',
  DOWN: 'Down',
  LEFT: 'Left',
  RIGHT: 'Right',
  HOME: 'Home',
  END: 'End',
  PGUP: 'Prior',
  PAGEUP: 'Prior',
  PGDN: 'Next',
  PAGEDOWN: 'Next',
  PRINTSCREEN: 'Print',
  PRTSC: 'Print',
  CAPSLOCK: 'Caps_Lock',
  NUMLOCK: 'Num_Lock',
  SCROLLLOCK: 'Scroll_Lock',
  PAUSE: 'Pause',
  MENU: 'Menu',
  APPS: 'Menu',
  VOLUME_MUTE: 'XF86AudioMute',
  VOLUME_DOWN: 'XF86AudioLowerVolume',
  VOLUME_UP: 'XF86AudioRaiseVolume',
  MEDIA_NEXT: 'XF86AudioNext',
  MEDIA_PREV: 'XF86AudioPrev',
  MEDIA_STOP: 'XF86AudioStop',
  MEDIA_PLAY_PAUSE: 'XF86AudioPlay',
  BROWSER_BACK: 'XF86Back',
  BROWSER_FORWARD: 'XF86Forward',
  BROWSER_REFRESH: 'XF86Reload',
  BROWSER_HOME: 'XF86HomePage'
};

// Linux evdev keycodes (<linux/input-event-codes.h>) for ydotool on Wayland
const EVDEV_KEYCODES = {
  ESC: 1, ESCAPE: 1,
  '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
  BACKSPACE: 14, BS: 14, TAB: 15,
  Q: 16, W: 17, E: 18, R: 19, T: 20, Y: 21, U: 22, I: 23, O: 24, P: 25,
  ENTER: 28, RETURN: 28, CTRL: 29, CONTROL: 29,
  A: 30, S: 31, D: 32, F: 33, G: 34, H: 35, J: 36, K: 37, L: 38,
  SHIFT: 42,
  Z: 44, X: 45, C: 46, V: 47, B: 48, N: 49, M: 50,
  ALT: 56, SPACE: 57, CAPSLOCK: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  NUMLOCK: 69, SCROLLLOCK: 70,
  F11: 87, F12: 88,
  PRINTSCREEN: 99, PRTSC: 99,
  HOME: 102, UP: 103, PGUP: 104, PAGEUP: 104, LEFT: 105, RIGHT: 106, END: 107, DOWN: 108, PGDN: 109, PAGEDOWN: 109,
  INSERT: 110, DELETE: 111, DEL: 111,
  VOLUME_MUTE: 113, VOLUME_DOWN: 114, VOLUME_UP: 115,
  PAUSE: 119,
  WIN: 125, LWIN: 125, SUPER: 125,
  MENU: 127, APPS: 127,
  MEDIA_STOP: 128, MEDIA_NEXT: 163, MEDIA_PLAY_PAUSE: 164, MEDIA_PREV: 165
};

// "CTRL+SHIFT+ESC" -> "ctrl+shift+Escape"; unknown parts are dropped like MapKeyNameToVk() does
function mapKeyCombo(combo) {
  const parts = String(combo || '')
    .toUpperCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (KEY_MAP[p]) out.push(KEY_MAP[p]);
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(p)) out.push(p);
    else if (/^[A-Z]$/.test(p)) out.push(p.toLowerCase());
    else if (/^[0-9]$/.test(p)) out.push(p);
  }
  return out.join('+');
}

// Convert combo into ydotool key sequence args: e.g. "CTRL+C" -> ["29:1", "46:1", "46:0", "29:0"]
// action: 'tap' | 'down' | 'up'
function mapYdotoolKeys(combo, action = 'tap') {
  const parts = String(combo || '')
    .toUpperCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const codes = parts.map((p) => EVDEV_KEYCODES[p]).filter((c) => Number.isInteger(c));
  if (!codes.length) return [];
  if (action === 'down') return codes.map((c) => `${c}:1`);
  if (action === 'up') return codes.slice().reverse().map((c) => `${c}:0`);
  return [...codes.map((c) => `${c}:1`), ...codes.slice().reverse().map((c) => `${c}:0`)];
}

// Convert combo into wtype arguments for wlroots Wayland virtual keyboard
function mapWtypeArgs(combo, action = 'tap') {
  const parts = String(combo || '')
    .toUpperCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const modMap = { CTRL: 'ctrl', CONTROL: 'ctrl', ALT: 'alt', SHIFT: 'shift', WIN: 'logo', LWIN: 'logo', SUPER: 'logo' };
  const mods = [];
  const keys = [];
  for (const p of parts) {
    if (modMap[p]) mods.push(modMap[p]);
    else {
      const k = KEY_MAP[p] || (/^F([1-9]|1[0-9]|2[0-4])$/.test(p) ? p : /^[A-Z0-9]$/.test(p) ? p.toLowerCase() : '');
      if (k) keys.push(k);
    }
  }
  const argv = [];
  if (action === 'down') {
    for (const m of mods) argv.push('-M', m);
    for (const k of keys) argv.push('-P', k);
  } else if (action === 'up') {
    for (const k of keys.slice().reverse()) argv.push('-p', k);
    for (const m of mods.slice().reverse()) argv.push('-m', m);
  } else {
    for (const m of mods) argv.push('-M', m);
    for (const k of keys) argv.push('-k', k);
    if (!keys.length && mods.length) {
      // Bare modifier tap (e.g. WIN)
      const m = mods.pop();
      argv.length = 0;
      for (const om of mods) argv.push('-M', om);
      argv.push('-k', m === 'logo' ? 'Super_L' : m);
    }
    for (const m of mods.slice().reverse()) argv.push('-m', m);
  }
  return argv;
}

module.exports = {
  parseXrandr,
  parseHyprMonitors,
  parseSwayOutputs,
  parseKscreenMonitors,
  parseWlrRandr,
  parseNetWorkarea,
  intersectWorkarea,
  parseWmctrl,
  parseHyprClients,
  parseSwayTree,
  parseNetWmState,
  classifyZone,
  resolveZoneRect,
  parsePactlVolume,
  parsePactlMute,
  parseWpctlVolume,
  parsePactlBlocks,
  parsePactlSinkInputs,
  parsePactlSinks,
  PLAYERCTL_FORMAT,
  parsePlayerctlLines,
  pickPlayer,
  friendlyPlayerName,
  parseProcStat,
  cpuPercent,
  parseMeminfo,
  parseUptime,
  parseDesktopEntry,
  desktopName,
  isDesktopEntryVisible,
  splitArgs,
  parseDesktopExec,
  parseMouseLocation,
  mapKeyCombo,
  mapYdotoolKeys,
  mapWtypeArgs,
  KEY_MAP,
  EVDEV_KEYCODES
};
