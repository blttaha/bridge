'use strict';
// Pure text parsers for the output of the Linux tools. No I/O here, so every function is unit tested.

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

// "_NET_WORKAREA(CARDINAL) = 0, 27, 3840, 1053, 0, 27, ..." -> first desktop's rect
function parseNetWorkarea(text) {
  const m = /=\s*(-?\d+),\s*(-?\d+),\s*(\d+),\s*(\d+)/.exec(String(text || ''));
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
}

// Work area of one monitor = monitor rect ∩ desktop work area (panels are excluded)
function intersectWorkarea(mon, wa) {
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
// wmctrl -lpG
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
// pactl
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
// xdotool
// ---------------------------------------------------------------------------
// "x:812 y:403 screen:0 window:6291462"
function parseMouseLocation(text) {
  const m = /x:(-?\d+)\s+y:(-?\d+)/.exec(String(text || ''));
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

// Windows key names used by the phone -> X keysyms
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
  MENU: 'Menu',
  APPS: 'Menu',
  VOLUME_MUTE: 'XF86AudioMute',
  VOLUME_DOWN: 'XF86AudioLowerVolume',
  VOLUME_UP: 'XF86AudioRaiseVolume',
  MEDIA_NEXT: 'XF86AudioNext',
  MEDIA_PREV: 'XF86AudioPrev',
  MEDIA_STOP: 'XF86AudioStop',
  MEDIA_PLAY_PAUSE: 'XF86AudioPlay'
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

module.exports = {
  parseXrandr,
  parseNetWorkarea,
  intersectWorkarea,
  parseWmctrl,
  parseNetWmState,
  classifyZone,
  resolveZoneRect,
  parsePactlVolume,
  parsePactlMute,
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
  KEY_MAP
};
