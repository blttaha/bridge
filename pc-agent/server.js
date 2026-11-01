const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const readline = require('readline');
const { spawn, execSync } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.TAHABLT_PORT || 4850);
const DISCOVERY_PORT = 4851;
// cloudflared forwards internet traffic to this loopback-only port, so tunnel requests are recognised by the
// socket they arrive on (cannot be spoofed with headers) instead of trusting "cf-*" headers.
const TUNNEL_INGRESS_PORT = Number(process.env.TAHABLT_TUNNEL_PORT || PORT + 5);
const STREAM_PORT = Number(process.env.TAHABLT_STREAM_PORT || 4852);
const INPUT_PORT = Number(process.env.TAHABLT_INPUT_PORT || 4853);
// Writable state lives in the user's profile (not next to the program files), so the install folder can stay
// read-only for standard users. Older versions kept it in pc-agent/data; that folder is migrated once.
const IS_WINDOWS = process.platform === 'win32';
const LEGACY_DATA_DIR = path.join(__dirname, 'data');
// The product was called "TahaBLT Connect" before it became Bridge; data under the old names is migrated once.
const APP_DIR_NAME = 'Bridge';
const OLD_APP_DIR_NAME = 'TahaBLT Connect';
const PROGRAM_DATA = process.env.PROGRAMDATA || 'C:\\ProgramData';
const SHARED_WIN_DATA_DIR = IS_WINDOWS ? path.join(PROGRAM_DATA, APP_DIR_NAME, 'data') : '';
const USER_WIN_DATA_DIR = IS_WINDOWS && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, APP_DIR_NAME, 'data') : '';
const XDG_DATA_ROOT = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
function defaultDataDir() {
  if (IS_WINDOWS) {
    return SHARED_WIN_DATA_DIR || USER_WIN_DATA_DIR || LEGACY_DATA_DIR;
  }
  // Linux: XDG data directory (~/.local/share/bridge)
  return path.join(XDG_DATA_ROOT, 'bridge');
}
const DATA_DIR = process.env.TAHABLT_DATA_DIR || defaultDataDir();
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SCENES_FILE = path.join(DATA_DIR, 'scenes.json');
const QUICK_ACTIONS_FILE = path.join(DATA_DIR, 'quick-actions.json');
const MACROS_FILE = path.join(DATA_DIR, 'macros.json');
const CUSTOM_APPS_FILE = path.join(DATA_DIR, 'custom-apps.json');
const APP_PREFS_FILE = path.join(DATA_DIR, 'app-prefs.json');
const FUNCTION_PREFS_FILE = path.join(DATA_DIR, 'function-prefs.json');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime-status.json');
const ADMIN_KEY_FILE = path.join(DATA_DIR, 'admin.key');
const MAX_HTTP_BODY_BYTES = 256 * 1024;
// Windows: C# bridge (screen capture, input, audio, media). Linux: Node bridge built on X11 tools + ffmpeg.
const BRIDGE_EXE = IS_WINDOWS ? path.join(__dirname, 'native', 'BridgeHelper.exe') : path.join(__dirname, 'linux', 'bridge.js');
// Per-run secret for the bridge's loopback ports (4852 frames, 4853 input). Without it any web page could
// POST keystrokes to 127.0.0.1:4853.
const BRIDGE_IPC_KEY = crypto.randomBytes(24).toString('hex');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
function migrateExistingWinDataToSharedDir() {
  if (process.env.TAHABLT_DATA_DIR) return;
  if (fs.existsSync(path.join(DATA_DIR, 'config.json'))) return; // already has its own pairing state
  const candidateDirs = [];
  if (!IS_WINDOWS) {
    candidateDirs.push(path.join(XDG_DATA_ROOT, 'tahablt-connect'));
  } else {
    candidateDirs.push(path.join(PROGRAM_DATA, OLD_APP_DIR_NAME, 'data'));
    if (USER_WIN_DATA_DIR && USER_WIN_DATA_DIR !== DATA_DIR) candidateDirs.push(USER_WIN_DATA_DIR);
    try {
      const usersRoot = 'C:\\Users';
      if (fs.existsSync(usersRoot)) {
        for (const u of fs.readdirSync(usersRoot)) {
          for (const name of [APP_DIR_NAME, OLD_APP_DIR_NAME]) {
            const d = path.join(usersRoot, u, 'AppData', 'Local', name, 'data');
            if (d !== DATA_DIR && !candidateDirs.includes(d) && fs.existsSync(path.join(d, 'config.json'))) {
              candidateDirs.push(d);
            }
          }
        }
      }
    } catch {}
  }
  if (LEGACY_DATA_DIR !== DATA_DIR) candidateDirs.push(LEGACY_DATA_DIR);

  for (const srcDir of candidateDirs) {
    if (!fs.existsSync(path.join(srcDir, 'config.json'))) continue;
    try {
      for (const name of fs.readdirSync(srcDir)) {
        const dst = path.join(DATA_DIR, name);
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(path.join(srcDir, name), dst);
        }
      }
      break;
    } catch {}
  }
}
migrateExistingWinDataToSharedDir();

// Crash-safe JSON persistence: write to a temp file, fsync, keep the previous version as .bak, then rename.
// A power cut mid-write used to truncate config.json and silently reset the PC's identity and pairings.
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2), null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch {}
  fs.renameSync(tmp, file);
}

// Reads a JSON file, falling back to its .bak copy; throws when neither is readable
function readJsonValue(file) {
  for (const candidate of [file, `${file}.bak`]) {
    try {
      // A UTF-8 BOM (Notepad, PowerShell 5.1) must not make the file "unreadable" and reset the PC's pairing
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf8').replace(/^﻿/, ''));
    } catch {}
  }
  throw new Error(`unreadable ${path.basename(file)}`);
}

process.on('unhandledRejection', (err) => {
  console.error('[Bridge] unhandled rejection:', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('[Bridge] uncaught exception:', err && err.message ? err.message : err);
});

// Optional parent PID watchdog (when launched by the Bridge.exe system tray app)
const parentPidArgIdx = process.argv.indexOf('--parent-pid');
const parentPid = parentPidArgIdx !== -1 ? Number(process.argv[parentPidArgIdx + 1]) : 0;
if (parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, 3000);
}

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_TTL_MS = 30000; // 30s UI display in taskbar menu
const PAIRING_CODE_SERVER_GRACE_MS = 90000; // 30s UI + 60s network/typing transit grace window
let activePin = '';
let pinExpiresAt = 0;
let pinCreatedAt = 0;
let pinExpiryTimer = null;
const activePinsMap = new Map(); // normalizedCode -> { rawPin, serverExpiresAt, issuedToken }
const failedAuthByIp = new Map();
let cachedMonitorCount = 2;

function checkRateLimit(ip) {
  const key = String(ip || 'unknown');
  const rec = failedAuthByIp.get(key);
  if (!rec) return { allowed: true };
  if (Date.now() > rec.resetAt) {
    failedAuthByIp.delete(key);
    return { allowed: true };
  }
  if (rec.count >= 18) {
    const waitSec = Math.max(1, Math.ceil((rec.resetAt - Date.now()) / 1000));
    return { allowed: false, waitSec };
  }
  return { allowed: true };
}

function recordFailedAuth(ip) {
  const key = String(ip || 'unknown');
  const now = Date.now();
  const rec = failedAuthByIp.get(key);
  if (!rec || now > rec.resetAt) {
    failedAuthByIp.set(key, { count: 1, resetAt: now + 30000 });
  } else {
    rec.count += 1;
    rec.resetAt = now + 30000;
  }
}

function clearFailedAuth(ip) {
  failedAuthByIp.delete(String(ip || 'unknown'));
}

// Expired entries are otherwise only removed when the same address returns; an attacker rotating
// addresses must not be able to grow this map forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of failedAuthByIp) {
    if (now > rec.resetAt) failedAuthByIp.delete(key);
  }
}, 60000).unref();

// Constant-time string comparison for secrets (tokens, admin key)
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Local tray <-> agent secret. Pairing-code rotation and session revocation are only allowed for
// callers that can read this file (the tray app on this PC). Previously /api/pair/rotate was open to
// the whole LAN, the Cloudflare tunnel and any website (CORS *), which handed out a valid pairing code.
const ADMIN_KEY = (() => {
  try {
    const existing = fs.readFileSync(ADMIN_KEY_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      if (IS_WINDOWS && USER_WIN_DATA_DIR && USER_WIN_DATA_DIR !== DATA_DIR) {
        try {
          fs.mkdirSync(USER_WIN_DATA_DIR, { recursive: true });
          fs.writeFileSync(path.join(USER_WIN_DATA_DIR, 'admin.key'), existing, 'utf8');
        } catch {}
      }
      return existing;
    }
  } catch {}
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(ADMIN_KEY_FILE, key, 'utf8');
  if (IS_WINDOWS && USER_WIN_DATA_DIR && USER_WIN_DATA_DIR !== DATA_DIR) {
    try {
      fs.mkdirSync(USER_WIN_DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(USER_WIN_DATA_DIR, 'admin.key'), key, 'utf8');
    } catch {}
  }
  return key;
})();

// Rate limits and pairing-code binding are keyed per client. Tunnel traffic arrives from 127.0.0.1, so the
// real client address comes from cloudflared's header (only trusted on loopback connections).
function isTunnelRequest(req) {
  return Boolean(req && req.socket && req.socket.localPort === TUNNEL_INGRESS_PORT);
}

function getClientKey(req) {
  const addr = String((req && req.socket && req.socket.remoteAddress) || 'unknown').replace(/^::ffff:/i, '');
  if (isTunnelRequest(req)) {
    const h = req.headers || {};
    return `cf:${String(h['cf-connecting-ip'] || 'unknown').split(',')[0].trim()}`;
  }
  return addr;
}

// Global ceiling on wrong pairing codes (independent of client address)
const pinFailureWindow = { count: 0, resetAt: 0 };
function pinAttemptsExhausted() {
  const now = Date.now();
  if (now > pinFailureWindow.resetAt) {
    pinFailureWindow.count = 0;
    pinFailureWindow.resetAt = now + 5 * 60 * 1000;
  }
  return pinFailureWindow.count >= 200;
}
function notePinFailure(code) {
  if (normalizePairingCode(code).length === 8) pinFailureWindow.count += 1;
}

function isLoopbackAddress(addr) {
  const a = String(addr || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function isLocalAdminRequest(req) {
  if (!req || !req.socket || !isLoopbackAddress(req.socket.remoteAddress)) return false;
  if (isTunnelRequest(req)) return false;
  // Defence in depth: anything relayed by a proxy carries one of these headers
  const h = req.headers || {};
  if (h['cf-connecting-ip'] || h['cf-ray'] || h['x-forwarded-for'] || h.origin) return false;
  return safeEqual(h['x-tahablt-admin'], ADMIN_KEY);
}

function isKnownSessionToken(token) {
  const t = String(token || '').trim();
  if (!t) return false;
  if (safeEqual(t, config.authToken)) return true;
  return Array.isArray(config.pairedTokens) && config.pairedTokens.some((x) => safeEqual(t, x));
}

function readRequestBody(req, res, onBody) {
  let body = '';
  let size = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_HTTP_BODY_BYTES) {
      aborted = true;
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'İstek gövdesi çok büyük.' }));
      req.destroy();
      return;
    }
    body += chunk;
  });
  req.on('end', () => {
    if (!aborted) onBody(body);
  });
}

function generatePairingCode() {
  const bytes = crypto.randomBytes(8);
  let raw = '';
  for (let i = 0; i < 8; i++) {
    raw += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function normalizePairingCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function pruneExpiredPins() {
  const now = Date.now();
  for (const [k, entry] of activePinsMap.entries()) {
    if (!entry || now >= entry.serverExpiresAt) {
      activePinsMap.delete(k);
    }
  }
}

function clearUiPairingCodeOnly() {
  if (pinExpiryTimer) {
    clearTimeout(pinExpiryTimer);
    pinExpiryTimer = null;
  }
  activePin = '';
  pinExpiresAt = 0;
  pinCreatedAt = 0;
  if (typeof config !== 'undefined' && config) {
    config.pin = '';
  }
  try {
    updateRuntimeStatusFile();
  } catch {}
}

function clearActivePairingCode(wipeServerGraceMap = false) {
  clearUiPairingCodeOnly();
  if (wipeServerGraceMap) {
    activePinsMap.clear();
  }
}

function isValidEphemeralPin(submittedCode) {
  pruneExpiredPins();
  const now = Date.now();
  const norm = normalizePairingCode(submittedCode);
  if (norm.length !== 8) return false;

  if (activePinsMap.has(norm)) {
    const entry = activePinsMap.get(norm);
    if (entry && now < entry.serverExpiresAt) return true;
    activePinsMap.delete(norm);
  }

  if (activePin && now < pinExpiresAt && norm === normalizePairingCode(activePin)) {
    return true;
  }
  return false;
}

// The first client that redeems a code owns it: parallel HTTP/WebSocket attempts from that same phone get the
// same token, but a replay of the code from any other address (e.g. a rogue host on the Wi-Fi that received
// the code while the phone was probing for the PC) is refused.
function consumeOrReuseEphemeralPin(submittedCode, clientKey = '') {
  pruneExpiredPins();
  const now = Date.now();
  const norm = normalizePairingCode(submittedCode);
  if (norm.length !== 8) return null;
  if (pinAttemptsExhausted()) return null;

  let entry = activePinsMap.get(norm);
  if (!entry && activePin && now < pinExpiresAt && norm === normalizePairingCode(activePin)) {
    entry = {
      rawPin: activePin,
      serverExpiresAt: now + PAIRING_CODE_SERVER_GRACE_MS,
      issuedToken: ''
    };
    activePinsMap.set(norm, entry);
  }

  if (!entry || now >= entry.serverExpiresAt) {
    return null;
  }
  if (entry.issuedToken && entry.consumerKey && entry.consumerKey !== clientKey) {
    return null;
  }

  if (!entry.issuedToken) {
    entry.issuedToken = issueSessionToken();
    entry.consumerKey = clientKey;
  }
  // Keep this PIN entry valid for 25 more seconds so parallel HTTP/WebSocket race requests from the same phone click all receive 200 OK with the exact same token
  entry.serverExpiresAt = Math.min(entry.serverExpiresAt, now + 25000);
  if (entry.serverExpiresAt < now + 15000) {
    entry.serverExpiresAt = now + 15000;
  }
  activePinsMap.set(norm, entry);

  // Hide the code from the tray UI once paired
  clearUiPairingCodeOnly();
  return entry.issuedToken;
}

// Load or create persistent device config (pairing code is on-demand 30s only)
function loadOrCreateConfig() {
  if (fs.existsSync(CONFIG_FILE) || fs.existsSync(`${CONFIG_FILE}.bak`)) {
    try {
      const cfg = readJsonValue(CONFIG_FILE);
      if (cfg.deviceId && cfg.authToken) {
        let modified = false;
        if (cfg.pin) {
          cfg.pin = '';
          modified = true;
        }
        if (!Array.isArray(cfg.pairedTokens)) {
          cfg.pairedTokens = [cfg.authToken];
          modified = true;
        }
        if (modified) {
          writeJsonAtomic(CONFIG_FILE, cfg);
        }
        return cfg;
      }
    } catch {}
  }
  const primaryToken = crypto.randomBytes(32).toString('hex');
  const newCfg = {
    deviceId: crypto.randomUUID(),
    deviceName: os.hostname(),
    pin: '',
    pinUpdatedAt: 0,
    authToken: primaryToken,
    pairedTokens: [primaryToken],
    port: PORT,
    createdAt: new Date().toISOString()
  };
  writeJsonAtomic(CONFIG_FILE, newCfg);
  return newCfg;
}

function rotatePairingCode(consumeImmediately = false) {
  if (consumeImmediately) {
    clearUiPairingCodeOnly();
    return '';
  }
  if (pinExpiryTimer) {
    clearTimeout(pinExpiryTimer);
    pinExpiryTimer = null;
  }
  pruneExpiredPins();
  const now = Date.now();
  // If a code is currently visible in the 30s tray UI, clicking "Bağlantı Kur (Süreyi Yenile)" extends its 30s timer without changing the characters the user is typing!
  if (!activePin || now >= pinExpiresAt) {
    activePin = generatePairingCode();
    pinCreatedAt = now;
  }
  pinExpiresAt = now + PAIRING_CODE_TTL_MS;
  const norm = normalizePairingCode(activePin);
  const existing = activePinsMap.get(norm);
  activePinsMap.set(norm, {
    rawPin: activePin,
    serverExpiresAt: now + PAIRING_CODE_SERVER_GRACE_MS,
    issuedToken: existing ? existing.issuedToken : '',
    consumerKey: existing ? existing.consumerKey : ''
  });
  config.pin = activePin;
  config.pinUpdatedAt = now;
  pinExpiryTimer = setTimeout(() => {
    clearUiPairingCodeOnly();
  }, PAIRING_CODE_TTL_MS);

  updateRuntimeStatusFile();
  publishWanRendezvous(true);
  return activePin;
}

const TOKEN_MAX_COUNT = 20;
const TOKEN_IDLE_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;
let tokenSeenSaveTimer = null;

function getShortTokenId(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 12);
}

function getCleanClientIp(req) {
  if (!req) return 'Bilinmiyor';
  if (isTunnelRequest(req)) {
    const h = req.headers || {};
    const cfIp = String(h['cf-connecting-ip'] || '').split(',')[0].trim();
    return cfIp || 'Mobil Tünel';
  }
  const raw = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/i, '').trim();
  return raw || 'Yerel Ağ';
}

function getClientRouteLabel(req) {
  return isTunnelRequest(req) ? 'Mobil Tünel' : 'Yerel Ağ';
}

function extractClientDeviceName(req, params = {}) {
  const fromParams = String((params && (params.clientName || params.deviceName)) || '').trim();
  if (fromParams && fromParams.length >= 2 && fromParams.length <= 64) {
    return fromParams;
  }
  const ua = String((req && req.headers && req.headers['user-agent']) || '');
  // Extract Android model from User-Agent e.g. "(Linux; Android 14; 23127PN0CG Build/..." or "SM-S918B"
  const m = ua.match(/Android\s+[\d.]+;\s*([^;)]+?)(?:\s+Build\/|\))/i);
  if (m && m[1]) {
    const model = m[1].trim();
    if (model && model !== 'K' && model.toLowerCase() !== 'wv') {
      return `Android (${model})`;
    }
  }
  return 'Mobil Cihaz';
}

function registerOrUpdatePairedDevice(token, req, params = {}) {
  if (!token) return null;
  if (!config.pairedDevices || typeof config.pairedDevices !== 'object') {
    config.pairedDevices = {};
  }
  const nowIso = new Date().toISOString();
  const existing = config.pairedDevices[token] || {};
  const candidateName = extractClientDeviceName(req, params);
  const finalName =
    candidateName !== 'Mobil Cihaz' || !existing.name
      ? candidateName
      : existing.name;
  const clientId = String((params && params.clientId) || existing.clientId || '').trim();
  const cleanIp = getCleanClientIp(req);

  // Deduplicate if the same physical phone re-paired with a new token (match by clientId, or legacy unnamed entry, or same phone model name)
  for (const [oldTok, info] of Object.entries(config.pairedDevices)) {
    if (oldTok === token || !info) continue;
    const sameClient = Boolean(clientId && info.clientId && info.clientId === clientId);
    const sameNamedPhone = Boolean(finalName !== 'Mobil Cihaz' && info.name === finalName);
    const sameLanHost = Boolean(
      cleanIp &&
        cleanIp !== 'Bilinmiyor' &&
        cleanIp !== 'Mobil Tünel' &&
        cleanIp !== 'Yerel Ağ' &&
        info.ip === cleanIp
    );
    const isUnclaimedLegacy = Boolean(!info.clientId && info.name === 'Mobil Cihaz' && (info.ip === '-' || !info.ip));
    if (sameClient || sameNamedPhone || sameLanHost || isUnclaimedLegacy) {
      delete config.pairedDevices[oldTok];
      if (config.tokenSeen) delete config.tokenSeen[oldTok];
      if (Array.isArray(config.pairedTokens)) {
        config.pairedTokens = config.pairedTokens.filter((t) => t !== oldTok || t === config.authToken);
      }
    }
  }

  const changed =
    !config.pairedDevices[token] ||
    existing.name !== finalName ||
    existing.ip !== cleanIp ||
    existing.clientId !== clientId;

  const entry = {
    id: getShortTokenId(token),
    clientId: clientId || existing.clientId || '',
    name: finalName,
    ip: cleanIp && cleanIp !== 'Bilinmiyor' ? cleanIp : existing.ip || '-',
    route: req ? getClientRouteLabel(req) : existing.route || 'Yerel Ağ',
    pairedAt: existing.pairedAt || nowIso,
    lastSeenAt: nowIso
  };
  config.pairedDevices[token] = entry;
  if (changed) {
    try {
      writeJsonAtomic(CONFIG_FILE, config);
    } catch {}
  }
  return entry;
}

// Phone tokens expire after 90 days without use; when the list is full the least recently used one goes
// (previously the oldest pairing was dropped even if that phone was used every day).
function touchSessionToken(token, req = null, params = null) {
  if (!token) return;
  if (!config.tokenSeen || typeof config.tokenSeen !== 'object') config.tokenSeen = {};
  config.tokenSeen[token] = Date.now();
  if (req || params || !config.pairedDevices || !config.pairedDevices[token]) {
    registerOrUpdatePairedDevice(token, req, params || {});
  } else if (config.pairedDevices && config.pairedDevices[token]) {
    config.pairedDevices[token].lastSeenAt = new Date().toISOString();
  }
  if (!tokenSeenSaveTimer) {
    tokenSeenSaveTimer = setTimeout(() => {
      tokenSeenSaveTimer = null;
      try {
        writeJsonAtomic(CONFIG_FILE, config);
      } catch {}
    }, 10000);
  }
}

function pruneSessionTokens() {
  if (!Array.isArray(config.pairedTokens)) config.pairedTokens = [config.authToken];
  if (!config.tokenSeen || typeof config.tokenSeen !== 'object') config.tokenSeen = {};
  if (!config.pairedDevices || typeof config.pairedDevices !== 'object') config.pairedDevices = {};
  const now = Date.now();
  for (const t of config.pairedTokens) {
    if (!config.tokenSeen[t]) config.tokenSeen[t] = now; // tokens from older versions start their clock now
  }
  let list = config.pairedTokens.filter((t) => t === config.authToken || now - config.tokenSeen[t] < TOKEN_IDLE_EXPIRY_MS);
  if (list.length > TOKEN_MAX_COUNT) {
    const evictable = list.filter((t) => t !== config.authToken).sort((a, b) => config.tokenSeen[a] - config.tokenSeen[b]);
    const drop = new Set(evictable.slice(0, list.length - TOKEN_MAX_COUNT));
    list = list.filter((t) => !drop.has(t));
  }
  config.pairedTokens = list;
  for (const t of Object.keys(config.tokenSeen)) {
    if (!list.includes(t)) delete config.tokenSeen[t];
  }
  for (const t of Object.keys(config.pairedDevices)) {
    if (!list.includes(t)) delete config.pairedDevices[t];
  }
  // Ensure every verified phone token in pairedTokens has an entry in pairedDevices so it always appears in Bağlı Cihazlar
  for (const t of list) {
    if (t !== config.authToken && !config.pairedDevices[t]) {
      const seenIso = config.tokenSeen[t] ? new Date(config.tokenSeen[t]).toISOString() : new Date(now).toISOString();
      config.pairedDevices[t] = {
        id: getShortTokenId(t),
        clientId: '',
        name: 'Mobil Cihaz',
        ip: '-',
        route: 'Yerel Ağ',
        pairedAt: seenIso,
        lastSeenAt: seenIso
      };
    }
  }
}

function issueSessionToken() {
  const newToken = crypto.randomBytes(32).toString('hex');
  if (!Array.isArray(config.pairedTokens)) {
    config.pairedTokens = [config.authToken];
  }
  config.pairedTokens.push(newToken);
  touchSessionToken(newToken);
  pruneSessionTokens();
  try {
    writeJsonAtomic(CONFIG_FILE, config);
  } catch {}
  return newToken;
}

function disconnectSingleDevice(deviceIdHash) {
  const targetId = String(deviceIdHash || '').trim();
  if (!targetId) return { ok: false, disconnectedCount: 0 };

  let matchedToken = '';
  if (config.pairedDevices && typeof config.pairedDevices === 'object') {
    for (const [tok, info] of Object.entries(config.pairedDevices)) {
      if ((info && info.id === targetId) || getShortTokenId(tok) === targetId) {
        matchedToken = tok;
        break;
      }
    }
  }
  if (!matchedToken && Array.isArray(config.pairedTokens)) {
    matchedToken = config.pairedTokens.find((t) => getShortTokenId(t) === targetId) || '';
  }

  if (matchedToken) {
    if (matchedToken === config.authToken) {
      config.authToken = crypto.randomBytes(32).toString('hex');
      if (!Array.isArray(config.pairedTokens)) config.pairedTokens = [];
      config.pairedTokens.push(config.authToken);
    }
    if (Array.isArray(config.pairedTokens)) {
      config.pairedTokens = config.pairedTokens.filter((t) => t !== matchedToken);
    }
    if (config.tokenSeen) delete config.tokenSeen[matchedToken];
    if (config.pairedDevices) delete config.pairedDevices[matchedToken];
    try {
      writeJsonAtomic(CONFIG_FILE, config);
    } catch {}
  }

  let disconnectedCount = 0;
  const revokeMsg = JSON.stringify({
    type: 'session_revoked',
    payload: {
      reason: 'Bilgisayar görev çubuğundan bu cihazın bağlantısı kesildi.',
      revokedByPc: true,
      ts: Date.now()
    }
  });

  for (const ws of Array.from(authenticatedClients)) {
    const wsId = ws.sessionToken ? getShortTokenId(ws.sessionToken) : '';
    if ((matchedToken && ws.sessionToken === matchedToken) || wsId === targetId) {
      try {
        stopClientStream(ws);
        if (ws.readyState === 1) {
          ws.send(revokeMsg);
        }
        setTimeout(() => {
          try {
            ws.close(4001, 'Session revoked by PC user');
          } catch {}
        }, 80);
        authenticatedClients.delete(ws);
        disconnectedCount++;
      } catch {}
    }
  }

  updateRuntimeStatusFile();
  return { ok: true, disconnectedCount, deviceId: targetId };
}

function disconnectAllSessions() {
  const newMasterToken = crypto.randomBytes(32).toString('hex');
  config.authToken = newMasterToken;
  config.pairedTokens = [newMasterToken];
  config.tokenSeen = {};
  config.pairedDevices = {};
  try {
    writeJsonAtomic(CONFIG_FILE, config);
  } catch {}

  let disconnectedCount = 0;
  const revokeMsg = JSON.stringify({
    type: 'session_revoked',
    payload: {
      reason: 'Bilgisayar görev çubuğundan bağlantı sonlandırıldı.',
      revokedByPc: true,
      ts: Date.now()
    }
  });

  for (const ws of authenticatedClients) {
    try {
      stopClientStream(ws);
      if (ws.readyState === 1) {
        ws.send(revokeMsg);
      }
      setTimeout(() => {
        try {
          ws.close(4001, 'Session revoked by PC user');
        } catch {}
      }, 80);
      disconnectedCount++;
    } catch {}
  }
  authenticatedClients.clear();
  clearActivePairingCode(true);
  updateRuntimeStatusFile();
  return { disconnectedCount, newPin: config.pin };
}

// Load scenes (Strict user requirement: NO default scenes, start empty! Also migrate old "Masaüstü Düzeni (...)" names to "Sahne 1", "Sahne 2", ...)
function loadScenes() {
  if (fs.existsSync(SCENES_FILE) || fs.existsSync(`${SCENES_FILE}.bak`)) {
    try {
      const parsed = readJsonValue(SCENES_FILE);
      if (Array.isArray(parsed)) {
        let modified = false;
        const usedNumbers = new Set();
        for (const sc of parsed) {
          const m = String(sc.name || '').match(/^Sahne\s+(\d+)$/i);
          if (m) usedNumbers.add(Number(m[1]));
        }
        let nextNum = 1;
        for (const sc of parsed) {
          if (!sc.name || /^Masaüstü Düzeni/i.test(String(sc.name).trim())) {
            while (usedNumbers.has(nextNum)) nextNum++;
            sc.name = `Sahne ${nextNum}`;
            usedNumbers.add(nextNum);
            modified = true;
          }
        }
        if (modified) {
          writeJsonAtomic(SCENES_FILE, parsed);
        }
        return parsed;
      }
    } catch {}
  }
  if (!fs.existsSync(SCENES_FILE)) writeJsonAtomic(SCENES_FILE, []);
  return [];
}

function saveScenes(scenes) {
  writeJsonAtomic(SCENES_FILE, scenes);
}

function getNextSceneName() {
  const usedNumbers = new Set();
  for (const sc of scenes) {
    const m = String(sc.name || '').trim().match(/^Sahne\s+(\d+)$/i);
    if (m) usedNumbers.add(Number(m[1]));
  }
  let n = 1;
  while (usedNumbers.has(n)) n++;
  return `Sahne ${n}`;
}

function loadQuickActions() {
  if (fs.existsSync(QUICK_ACTIONS_FILE) || fs.existsSync(`${QUICK_ACTIONS_FILE}.bak`)) {
    try {
      const parsed = readJsonValue(QUICK_ACTIONS_FILE);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  if (!fs.existsSync(QUICK_ACTIONS_FILE)) writeJsonAtomic(QUICK_ACTIONS_FILE, []);
  return [];
}

function saveQuickActions(list) {
  writeJsonAtomic(QUICK_ACTIONS_FILE, list);
}

function loadMacros() {
  if (fs.existsSync(MACROS_FILE) || fs.existsSync(`${MACROS_FILE}.bak`)) {
    try {
      const parsed = readJsonValue(MACROS_FILE);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  if (!fs.existsSync(MACROS_FILE)) writeJsonAtomic(MACROS_FILE, []);
  return [];
}

function saveMacros(list) {
  writeJsonAtomic(MACROS_FILE, list);
}

function loadCustomApps() {
  if (fs.existsSync(CUSTOM_APPS_FILE) || fs.existsSync(`${CUSTOM_APPS_FILE}.bak`)) {
    try {
      const parsed = readJsonValue(CUSTOM_APPS_FILE);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  if (!fs.existsSync(CUSTOM_APPS_FILE)) writeJsonAtomic(CUSTOM_APPS_FILE, []);
  return [];
}

function saveCustomApps(list) {
  writeJsonAtomic(CUSTOM_APPS_FILE, list);
}

function loadAppPrefs() {
  if (fs.existsSync(APP_PREFS_FILE) || fs.existsSync(`${APP_PREFS_FILE}.bak`)) {
    try {
      const parsed = readJsonValue(APP_PREFS_FILE);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  if (!fs.existsSync(APP_PREFS_FILE)) writeJsonAtomic(APP_PREFS_FILE, {});
  return {};
}

function saveAppPrefs(prefsObj) {
  writeJsonAtomic(APP_PREFS_FILE, prefsObj);
}

// How this PC carries out the phone's system buttons. Stored on the PC, so every computer keeps its own
// choices whichever phone (or the Android quick tiles / power timer) sends the command.
const FUNCTION_PREF_OPTIONS = {
  lock: ['custom', 'windows', 'both'],
  sleep: ['sleep', 'hibernate', 'monitors_off'],
  shutdown: ['normal', 'force', 'hybrid'],
  restart: ['normal', 'force'],
  monitorsOff: ['power', 'blackout'],
  showDesktop: ['win_d', 'win_m'],
  media: ['session', 'global'],
  mousePriority: ['active_lock', 'pc_first', 'app_first', 'shared']
};

function sanitizeFunctionPrefs(input) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const [key, options] of Object.entries(FUNCTION_PREF_OPTIONS)) {
    out[key] = options.includes(src[key]) ? src[key] : options[0];
  }
  return out;
}

function loadFunctionPrefs() {
  try {
    if (fs.existsSync(FUNCTION_PREFS_FILE) || fs.existsSync(`${FUNCTION_PREFS_FILE}.bak`)) {
      return sanitizeFunctionPrefs(readJsonValue(FUNCTION_PREFS_FILE));
    }
  } catch {}
  return sanitizeFunctionPrefs({});
}

const config = loadOrCreateConfig();
// Secret shared with paired phones only; signs the endpoint updates published on ntfy.sh
if (!/^[0-9a-f]{64}$/.test(String(config.syncKey || ''))) {
  config.syncKey = crypto.randomBytes(32).toString('hex');
}
pruneSessionTokens();
try {
  writeJsonAtomic(CONFIG_FILE, config);
} catch {}
let scenes = loadScenes();
let quickActions = loadQuickActions();
let macros = loadMacros();
let customApps = loadCustomApps();
let appPrefs = loadAppPrefs();
let functionPrefs = loadFunctionPrefs();
let monitorsManuallyOff = false;

// Deterministic private rendezvous topic for Tailscale-free 4.5G/5G Mobile Data discovery
const SYNC_TOPIC =
  'tahablt_' +
  crypto
    .createHash('sha256')
    .update(`${config.deviceId}:${config.authToken}`)
    .digest('hex')
    .slice(0, 24);

let currentTunnelUrl = '';
let currentWsTunnelUrl = '';
let cloudflaredProc = null;

// Active Power Timer state (for timed Sleep / Shutdown / Monitors Off)
let powerTimerState = {
  active: false,
  mode: 'sleep',
  targetTs: 0,
  remainingSec: 0
};
let powerTimerTimeout = null;
let powerTimerTickInterval = null;

// Network discovery helper: Multi-Interface LAN IPs (Ethernet, Wi-Fi, USB RNDIS Tethering, Mobile Hotspot), Subnet Broadcast, MAC Address, Tailscale IP
function computeBroadcastAddress(ip, netmask) {
  try {
    const ipParts = ip.split('.').map(Number);
    const maskParts = (netmask || '255.255.255.0').split('.').map(Number);
    if (ipParts.length !== 4 || maskParts.length !== 4) return '255.255.255.255';
    const bcast = ipParts.map((octet, i) => (octet & maskParts[i]) | (~maskParts[i] & 255));
    return bcast.join('.');
  } catch {
    return '255.255.255.255';
  }
}

function getNetworkInfo() {
  const interfaces = os.networkInterfaces();
  let lanIp = '127.0.0.1';
  let netmask = '255.255.255.0';
  let subnetBroadcast = '255.255.255.255';
  let macAddress = '';
  let tailscaleIp = '-';
  const lanIps = [];
  const subnetBroadcasts = [];
  const macAddresses = [];
  const interfaceDetails = [];

  // Sort interface entries so Ethernet comes before Wi-Fi / Tethering
  const entries = Object.entries(interfaces).sort(([a], [b]) => {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    const aEth = la.includes('ethernet') || la.startsWith('eth') || la.startsWith('enp');
    const bEth = lb.includes('ethernet') || lb.startsWith('eth') || lb.startsWith('enp');
    if (aEth !== bEth) return aEth ? -1 : 1;
    return 0;
  });

  for (const [name, addrs] of entries) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const lowerName = name.toLowerCase();
      // Check for Tailscale CGNAT range 100.64.0.0/10
      if (addr.address.startsWith('100.') || lowerName.includes('tailscale')) {
        tailscaleIp = addr.address;
        continue;
      }
      // Skip hypervisor virtual adapters (WSL, Hyper-V, Docker, VMware)
      if (
        lowerName.includes('vethernet') ||
        lowerName.includes('wsl') ||
        lowerName.includes('docker') ||
        lowerName.includes('vmware') ||
        lowerName.includes('virtualbox')
      ) {
        continue;
      }

      const bcast = computeBroadcastAddress(addr.address, addr.netmask || '255.255.255.0');
      const cleanMac = addr.mac && addr.mac !== '00:00:00:00:00:00' ? addr.mac.toUpperCase() : '';
      if (!lanIps.includes(addr.address)) {
        lanIps.push(addr.address);
      }
      if (bcast && !subnetBroadcasts.includes(bcast)) {
        subnetBroadcasts.push(bcast);
      }
      if (cleanMac && !macAddresses.includes(cleanMac)) {
        macAddresses.push(cleanMac);
      }
      interfaceDetails.push({
        name,
        ip: addr.address,
        netmask: addr.netmask || '255.255.255.0',
        broadcast: bcast,
        mac: cleanMac
      });

      if (lanIp === '127.0.0.1') {
        lanIp = addr.address;
        netmask = addr.netmask || '255.255.255.0';
        subnetBroadcast = bcast;
        if (cleanMac) {
          macAddress = cleanMac;
        }
      }
    }
  }

  // Persist known physical MAC addresses in config so even if an interface is temporarily unplugged, its MAC is remembered
  if (typeof config !== 'undefined' && config) {
    const prevMacs = Array.isArray(config.macAddresses) ? config.macAddresses : [];
    for (const pm of prevMacs) {
      const m = String(pm || '').toUpperCase().trim();
      if (m && m !== '00:00:00:00:00:00' && !macAddresses.includes(m)) {
        macAddresses.push(m);
      }
    }
    if (!macAddress && macAddresses.length > 0) {
      macAddress = macAddresses[0];
    }
    const macChanged =
      macAddress !== (config.macAddress || '') ||
      macAddresses.join(',') !== prevMacs.join(',');
    if (macChanged && macAddresses.length > 0) {
      config.macAddress = macAddress;
      config.macAddresses = macAddresses;
      try {
        writeJsonAtomic(CONFIG_FILE, config);
      } catch {}
    }
  }

  return { lanIp, lanIps, netmask, subnetBroadcast, subnetBroadcasts, macAddress, macAddresses, tailscaleIp, interfaceDetails };
}

function resolveClientNetworkInfo(netInfo, clientAddress = '', hostHeader = '') {
  const base = netInfo || getNetworkInfo();
  const cleanClient = String(clientAddress || '').replace(/^::ffff:/i, '').trim();
  const cleanHost = String(hostHeader || '').split(':')[0].trim();

  let matchedIp = base.lanIp;
  let matchedBcast = base.subnetBroadcast;

  if (cleanHost && Array.isArray(base.interfaceDetails)) {
    const byHost = base.interfaceDetails.find((it) => it.ip === cleanHost);
    if (byHost) {
      matchedIp = byHost.ip;
      matchedBcast = byHost.broadcast || matchedBcast;
      return { ...base, lanIp: matchedIp, subnetBroadcast: matchedBcast };
    }
  }

  if (cleanClient && cleanClient.includes('.') && Array.isArray(base.interfaceDetails)) {
    const clientParts = cleanClient.split('.');
    if (clientParts.length === 4) {
      const prefix24 = `${clientParts[0]}.${clientParts[1]}.${clientParts[2]}.`;
      const bySubnet = base.interfaceDetails.find((it) => String(it.ip || '').startsWith(prefix24));
      if (bySubnet) {
        matchedIp = bySubnet.ip;
        matchedBcast = bySubnet.broadcast || matchedBcast;
      }
    }
  }

  return { ...base, lanIp: matchedIp, subnetBroadcast: matchedBcast };
}

// Persistent Win32 Native Bridge Manager
class NativeBridge {
  constructor() {
    this.proc = null;
    this.reqId = 1;
    this.pending = new Map();
    this.fastInputSock = null;
    this.start();
  }

  connectFastInput() {
    if (this.fastInputSock) {
      try {
        this.fastInputSock.destroy();
      } catch {}
      this.fastInputSock = null;
    }
    const sock = net.createConnection({ host: '127.0.0.1', port: INPUT_PORT });
    sock.setNoDelay(true);
    sock.on('connect', () => {
      sock.write(BRIDGE_IPC_KEY + '\n');
      this.fastInputSock = sock;
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (this.fastInputSock === sock) {
        this.fastInputSock = null;
      }
      if (this.proc) {
        setTimeout(() => this.connectFastInput(), 1200);
      }
    });
  }

  start() {
    if (!fs.existsSync(BRIDGE_EXE)) {
      console.error('Köprü bulunamadı:', BRIDGE_EXE);
      return;
    }

    this.proc = spawn(IS_WINDOWS ? BRIDGE_EXE : process.execPath, IS_WINDOWS ? [] : [BRIDGE_EXE], {
      // The Linux bridge reports missing tools (xdotool, ffmpeg...) on stderr: keep them in the agent's log
      stdio: ['pipe', 'pipe', IS_WINDOWS ? 'ignore' : 'inherit'],
      windowsHide: true,
      env: { ...process.env, TAHABLT_IPC_KEY: BRIDGE_IPC_KEY }
    });
    // A crashed or quarantined bridge must never take Node down (EPIPE / spawn errors were unhandled)
    const proc = this.proc;
    let restartScheduled = false;
    const handleGone = () => {
      if (restartScheduled) return;
      restartScheduled = true;
      if (this.proc === proc) this.proc = null;
      if (this.fastInputSock) {
        try {
          this.fastInputSock.destroy();
        } catch {}
        this.fastInputSock = null;
      }
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Bridge restarted'));
      }
      this.pending.clear();
      // Back off when the exe keeps failing (e.g. quarantined by antivirus)
      this.restartDelayMs = Math.min(30000, (this.restartDelayMs || 500) * 2);
      setTimeout(() => this.start(), this.restartDelayMs);
    };
    proc.on('error', handleGone);
    proc.stdin.on('error', () => {});
    setTimeout(() => {
      if (this.proc === proc) this.restartDelayMs = 500;
    }, 20000);

    setTimeout(() => this.connectFastInput(), 350);

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      if (!line) return;
      try {
        const msg = JSON.parse(line);
        const pending = this.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          if (msg.ok) pending.resolve(msg.data);
          else pending.reject(new Error(msg.error || 'Native bridge error'));
        }
      } catch {}
    });

    proc.on('exit', handleGone);
  }

  call(cmd, args = {}, timeoutMs = 4500) {
    return new Promise((resolve, reject) => {
      const dispatch = () => {
        if (!this.proc || !this.proc.stdin.writable) {
          return reject(new Error('Native bridge not ready'));
        }
        const id = this.reqId++;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Bridge timeout: ${cmd}`));
        }, timeoutMs);

        this.pending.set(id, { resolve, reject, timer });
        const payload = JSON.stringify({ id, cmd, args }) + '\n';
        this.proc.stdin.write(payload);
      };

      if (!this.proc || !this.proc.stdin.writable) {
        try {
          this.start();
        } catch {}
        setTimeout(dispatch, 350);
      } else {
        dispatch();
      }
    });
  }

  sendFast(cmd, args = {}) {
    if (cmd === 'send_input' && this.fastInputSock && this.fastInputSock.writable) {
      try {
        this.fastInputSock.write(JSON.stringify(args) + '\n');
        return;
      } catch {}
    }
    if (!this.proc || !this.proc.stdin.writable) return;
    try {
      this.proc.stdin.write(JSON.stringify({ id: 0, cmd, args }) + '\n');
    } catch {}
  }
}

const bridge = new NativeBridge();

let cachedAutoInstalledApps = [];
let cachedAutoInstalledTs = 0;
let pendingInstalledAppsFetch = null;

async function getCachedAutoInstalledApps(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedAutoInstalledApps.length > 0 && now - cachedAutoInstalledTs < 60000) {
    return cachedAutoInstalledApps;
  }
  if (pendingInstalledAppsFetch) {
    return pendingInstalledAppsFetch;
  }
  pendingInstalledAppsFetch = bridge
    .call('get_installed_apps', {}, 8000)
    .then((list) => {
      if (Array.isArray(list) && list.length > 0) {
        cachedAutoInstalledApps = list;
        cachedAutoInstalledTs = Date.now();
      }
      pendingInstalledAppsFetch = null;
      return cachedAutoInstalledApps;
    })
    .catch(() => {
      pendingInstalledAppsFetch = null;
      return cachedAutoInstalledApps;
    });
  return pendingInstalledAppsFetch;
}

// Zone preset coordinate mapping
const ZONE_PRESETS = {
  fullscreen: { state: 'maximized', x: 0, y: 0, w: 1, h: 1 },
  'left-half': { state: 'normal', x: 0, y: 0, w: 0.5, h: 1 },
  'right-half': { state: 'normal', x: 0.5, y: 0, w: 0.5, h: 1 },
  'top-half': { state: 'normal', x: 0, y: 0, w: 1, h: 0.5 },
  'bottom-half': { state: 'normal', x: 0, y: 0.5, w: 1, h: 0.5 },
  'top-left': { state: 'normal', x: 0, y: 0, w: 0.5, h: 0.5 },
  'top-right': { state: 'normal', x: 0.5, y: 0, w: 0.5, h: 0.5 },
  'bottom-left': { state: 'normal', x: 0, y: 0.5, w: 0.5, h: 0.5 },
  'bottom-right': { state: 'normal', x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  'left-third': { state: 'normal', x: 0, y: 0, w: 0.333, h: 1 },
  'center-third': { state: 'normal', x: 0.333, y: 0, w: 0.334, h: 1 },
  'right-third': { state: 'normal', x: 0.667, y: 0, w: 0.333, h: 1 }
};

function resolveItemGeometry(item) {
  const isExplicitlyMinimized =
    item.state === 'minimized' ||
    item.windowStyle === 'minimized' ||
    item.windowStyle === 'hidden';
  if (item.zonePreset && ZONE_PRESETS[item.zonePreset]) {
    const preset = ZONE_PRESETS[item.zonePreset];
    if (isExplicitlyMinimized) {
      return {
        ...preset,
        state: 'minimized'
      };
    }
    return preset;
  }
  const rect = item.rect || {};
  return {
    state: isExplicitlyMinimized ? 'minimized' : item.state || 'normal',
    x: typeof rect.x === 'number' ? rect.x : 0,
    y: typeof rect.y === 'number' ? rect.y : 0,
    w: typeof rect.w === 'number' ? rect.w : 1,
    h: typeof rect.h === 'number' ? rect.h : 1
  };
}

// Launch an app on Windows via the Native C# Bridge (supports Riot Games, Steam, MSIX/Store apps, Discord, .lnk, .exe, URLs)
async function launchApplication(item) {
  try {
    const rawZone = String(item.zone || item.zonePreset || 'none').trim();
    const effectiveZone = rawZone === 'fullscreen' ? 'full' : rawZone === 'custom' || rawZone === 'default' ? 'none' : rawZone;
    const effectiveMonitor =
      effectiveZone !== 'none' && typeof item.monitorIndex === 'number' && item.monitorIndex >= 0
        ? item.monitorIndex
        : -1;
    const res = await executeQuickItemBridge({
      ...item,
      targetPath: item.launchPath || item.targetPath || item.processName || '',
      arguments: item.launchArgs || item.arguments || '',
      monitorIndex: effectiveMonitor,
      zone: effectiveZone
    });
    return Boolean(res && res.ok !== false);
  } catch {
    return false;
  }
}

function findMatchingWindow(openWindows, item, usedHwnds, allowReusingUsed = false) {
  const procTarget = String(item.processName || item.appName || '').toLowerCase().trim();
  const titleTarget = String(item.windowTitle || '').toLowerCase().trim();
  if (!procTarget && !titleTarget) return null;

  // 1. Prefer unused window with exact process + matching title
  if (titleTarget) {
    for (const w of openWindows) {
      if (usedHwnds.has(w.hwnd)) continue;
      const pName = String(w.processName || '').toLowerCase();
      const title = String(w.title || '').toLowerCase();
      if ((pName === procTarget || pName.includes(procTarget)) && title === titleTarget) {
        return w;
      }
    }
  }

  // 2. Prefer unused window matching process name
  for (const w of openWindows) {
    if (usedHwnds.has(w.hwnd)) continue;
    const pName = String(w.processName || '').toLowerCase();
    const title = String(w.title || '').toLowerCase();
    if (pName === procTarget || (procTarget && pName.includes(procTarget)) || (procTarget.length > 3 && title.includes(procTarget))) {
      return w;
    }
  }

  // 3. Only if allowReusingUsed is true, fallback to an already-used window of the same process
  if (allowReusingUsed) {
    for (const w of openWindows) {
      const pName = String(w.processName || '').toLowerCase();
      if (pName === procTarget || (procTarget && pName.includes(procTarget))) {
        return w;
      }
    }
  }
  return null;
}

async function waitForWindow(item, usedHwnds, maxWaitMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const openWins = await bridge.call('get_windows');
      const match = findMatchingWindow(openWins, item, usedHwnds, false);
      if (match) return match;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

let isSceneExecutionInProgress = false;

// Execute a full multi-monitor Scene sequentially while preserving exact Z-order (Minimized -> Background -> Foreground)
async function executeScene(scene, onProgress) {
  if (isSceneExecutionInProgress) {
    return { sceneId: scene.id, name: scene.name, skippedDuplicate: true, results: [] };
  }
  isSceneExecutionInProgress = true;
  try {
    const startedAt = Date.now();
    await bridge.call('monitor_power', { action: 'on', clearBlackouts: true }).catch(() => {});

    let openWins = await bridge.call('get_windows').catch(() => []);
    const rawItems = Array.isArray(scene.items) ? scene.items : [];

    // Step A: Deduplicate items that refer to the exact same process + monitor + title (preferring foreground over background)
    const dedupedItems = [];
    for (const item of rawItems) {
      const pKey = String(item.processName || item.appName || '').toLowerCase().trim();
      const tKey = String(item.windowTitle || '').toLowerCase().trim();
      const mKey = Number(item.monitorIndex || 0);
      const existingIdx = dedupedItems.findIndex((existing) => {
        const ep = String(existing.processName || existing.appName || '').toLowerCase().trim();
        const et = String(existing.windowTitle || '').toLowerCase().trim();
        const em = Number(existing.monitorIndex || 0);
        return ep === pKey && em === mKey && (et === tKey || (!et && !tKey));
      });
      if (existingIdx >= 0) {
        if (dedupedItems[existingIdx].isBackground && !item.isBackground) {
          dedupedItems[existingIdx] = item;
        }
      } else {
        dedupedItems.push(item);
      }
    }

    // Step B: Launch any process that currently has ZERO open windows on the PC (never launch explorer.exe or duplicate browser instances)
    const launchedProcesses = new Set();
    const emptyUsedSet = new Set();
    const launchedItems = [];
    for (let index = 0; index < dedupedItems.length; index++) {
      const item = dedupedItems[index];
      const procLower = String(item.processName || item.appName || '').toLowerCase().trim();
      const launchKey = `${procLower}|${String(item.launchPath || '').toLowerCase()}|${String(item.launchArgs || '').toLowerCase()}`;
      if (!item.launchPath || !procLower || procLower === 'explorer' || launchedProcesses.has(launchKey)) {
        continue;
      }
      const existingAny = findMatchingWindow(openWins, item, emptyUsedSet, true);
      if (!existingAny) {
        launchedProcesses.add(launchKey);
        launchedItems.push(item);
        const wantMin = item.state === 'minimized' || item.windowStyle === 'minimized';
        if (onProgress) onProgress({ step: 'launching', appName: item.appName || item.processName, index });
        await launchApplication({
          ...item,
          windowStyle: wantMin ? 'minimized' : 'normal',
          ifRunning: 'focus',
          zone: 'none',
          zonePreset: 'none',
          monitorIndex: -1
        });
      }
    }

    // Wait up to 3800ms total in a shared poll loop for any newly launched apps to open their windows
    if (launchedItems.length > 0) {
      const waitStart = Date.now();
      while (Date.now() - waitStart < 3800) {
        await new Promise((r) => setTimeout(r, 250));
        openWins = await bridge.call('get_windows').catch(() => openWins);
        const allReady = launchedItems.every((it) => Boolean(findMatchingWindow(openWins, it, emptyUsedSet, true)));
        if (allReady) break;
      }
    }

    // Step C: Assign open HWNDs prioritizing Foreground items first, then Background items, then Minimized items
    openWins = await bridge.call('get_windows').catch(() => openWins);
    const usedHwnds = new Set();
    const priorityOrder = [...dedupedItems].sort((a, b) => {
      const aMin = a.state === 'minimized' || a.windowStyle === 'minimized';
      const bMin = b.state === 'minimized' || b.windowStyle === 'minimized';
      const aRank = aMin ? 2 : a.isBackground ? 1 : 0;
      const bRank = bMin ? 2 : b.isBackground ? 1 : 0;
      if (aRank !== bRank) return aRank - bRank;
      return (typeof a.zOrder === 'number' ? a.zOrder : 999) - (typeof b.zOrder === 'number' ? b.zOrder : 999);
    });

    const assignments = [];
    for (const item of priorityOrder) {
      const win = findMatchingWindow(openWins, item, usedHwnds, false);
      if (win) {
        usedHwnds.add(win.hwnd);
      }
      assignments.push({ item, win });
    }

    // Step D: Execute window positioning in strict Z-order:
    // Phase 0: Minimized windows (stay minimized on taskbar)
    // Phase 1: Background windows (open behind top windows, sorted back-to-front by descending zOrder)
    // Phase 2: Foreground windows (on top, sorted back-to-front by descending zOrder so zOrder=0 is brought to front last)
    assignments.sort((a, b) => {
      const aMin = a.item.state === 'minimized' || a.item.windowStyle === 'minimized';
      const bMin = b.item.state === 'minimized' || b.item.windowStyle === 'minimized';
      const aPhase = aMin ? 0 : a.item.isBackground ? 1 : 2;
      const bPhase = bMin ? 0 : b.item.isBackground ? 1 : 2;
      if (aPhase !== bPhase) return aPhase - bPhase;
      const aZ = typeof a.item.zOrder === 'number' ? a.item.zOrder : 0;
      const bZ = typeof b.item.zOrder === 'number' ? b.item.zOrder : 0;
      return bZ - aZ;
    });

    const results = [];
    const foregroundHwnds = [];

    for (const { item, win } of assignments) {
      const geom = resolveItemGeometry(item);
      const isMinimized = geom.state === 'minimized' || item.state === 'minimized' || item.windowStyle === 'minimized';
      const isBg = Boolean((item.isBackground && !isMinimized) || isMinimized);

      if (win) {
        const snapRes = await bridge
          .call('snap_window', {
            hwnd: win.hwnd,
            processName: item.processName,
            monitorIndex: Number(item.monitorIndex || 0),
            state: isMinimized ? 'minimized' : geom.state,
            x: geom.x,
            y: geom.y,
            w: geom.w,
            h: geom.h,
            noActivate: isBg
          })
          .catch(() => null);
        if (!isBg && !isMinimized) {
          foregroundHwnds.push(win.hwnd);
        }
        results.push({ item: item.appName || item.processName, ok: Boolean(snapRes && snapRes.snapped) });
      } else {
        results.push({ item: item.appName || item.processName, ok: false });
      }
    }

    // Explicitly bring all Foreground windows to the front in back-to-front Z-order so Background windows stay behind them
    for (const fgHwnd of foregroundHwnds) {
      await bridge.call('focus_window', { hwnd: fgHwnd }).catch(() => {});
    }

    // Apply any monitor blackout rules defined in the scene
    if (Array.isArray(scene.blackoutMonitors)) {
      for (const monIdx of scene.blackoutMonitors) {
        await bridge.call('monitor_blackout', { monitorIndex: Number(monIdx), mode: 'on' }).catch(() => {});
      }
    }

    // Step E: Handle remaining windows outside this scene (keep, minimize or close)
    const otherWindowsMode = String(scene.otherWindowsMode || 'keep').toLowerCase();
    if (otherWindowsMode === 'minimize' || otherWindowsMode === 'close') {
      for (const w of openWins) {
        if (w && w.hwnd && !usedHwnds.has(w.hwnd)) {
          if (otherWindowsMode === 'minimize') {
            await bridge.call('snap_window', { hwnd: w.hwnd, state: 'minimized', noActivate: true }).catch(() => {});
          } else if (otherWindowsMode === 'close') {
            await bridge.call('close_window', { hwnd: w.hwnd }).catch(() => {});
          }
        }
      }
    }

    return {
      sceneId: scene.id,
      name: scene.name,
      elapsedMs: Date.now() - startedAt,
      results
    };
  } finally {
    isSceneExecutionInProgress = false;
  }
}

// Create a Scene Snapshot from currently open windows on the PC (including background & minimized apps on each monitor)
async function createSnapshotScene(customName) {
  const openWins = await bridge.call('get_windows');

  const items = openWins.map((w, idx) => {
    let launchPath = w.exePath || '';
    let launchArgs = '';
    if (String(w.processName).toLowerCase() === 'discord') {
      const localApp = process.env.LOCALAPPDATA || '';
      const updater = path.join(localApp, 'Discord', 'Update.exe');
      if (fs.existsSync(updater)) {
        launchPath = updater;
        launchArgs = '--processStart Discord.exe';
      }
    }
    const isMin = w.state === 'minimized';
    const isBgBehind = Boolean(w.isBackground && !isMin);
    return {
      id: crypto.randomUUID(),
      appName: w.processName,
      processName: w.processName,
      windowTitle: w.title,
      icon: w.icon || '',
      launchPath,
      launchArgs,
      monitorIndex: Number(w.monitorIndex || 0),
      zOrder: typeof w.zOrder === 'number' ? w.zOrder : idx,
      zonePreset: w.zonePreset || 'custom',
      state: w.state || 'normal',
      windowStyle: isMin ? 'minimized' : w.state === 'maximized' ? 'maximized' : 'normal',
      isBackground: isBgBehind,
      backgroundReason: w.backgroundReason || (isMin ? 'Simge Durumunda' : isBgBehind ? 'Arkaplanda' : ''),
      rect: w.normalized || { x: 0, y: 0, w: 1, h: 1 }
    };
  });

  const newScene = {
    id: crypto.randomUUID(),
    name: customName || getNextSceneName(),
    subtitle: `${items.length} uygulama · Otomatik yakalandı`,
    createdAt: new Date().toISOString(),
    blackoutMonitors: [],
    items
  };

  scenes.unshift(newScene);
  saveScenes(scenes);
  return newScene;
}

// Execute a single Quick Launch item or a multi-item Quick Action button
async function executeQuickItemBridge(item) {
  const tType = String(item.targetType || 'file').toLowerCase();
  let targetPath = String(item.targetPath || item.launchPath || '').trim();
  let extraArgs = String(item.arguments || item.launchArgs || '').trim();

  if (tType === 'macro') {
    const mac = macros.find((m) => m.id === item.macroId || m.id === targetPath || m.name === item.name);
    if (!mac) throw new Error('Seçili makro bulunamadı');
    const r = await executeMacro(mac);
    return { ok: true, macroResult: r };
  }

  if (tType === 'scene') {
    const sc = scenes.find((s) => s.id === item.sceneId || s.id === targetPath || s.name === item.name);
    if (!sc) throw new Error('Seçili çalışma sahnesi bulunamadı');
    const r = await executeScene(sc);
    return { ok: true, sceneResult: r };
  }

  if (tType === 'system_action') {
    const code = String(item.actionCode || targetPath || '').trim();
    switch (code) {
      case 'sys:toggle_lock':
        await bridge.call('system_control', { action: 'toggle_lock' }, 4500);
        return { ok: true };
      case 'sys:lock':
        await bridge.call('system_control', { action: 'lock' }, 4500);
        return { ok: true };
      case 'sys:unlock':
        await bridge.call('system_control', { action: 'unlock' }, 4500);
        return { ok: true };
      case 'sys:sleep':
        await bridge.call('system_control', { action: 'sleep' }, 4500);
        return { ok: true };
      case 'sys:hibernate':
        await bridge.call('system_control', { action: 'hibernate' }, 4500);
        return { ok: true };
      case 'sys:restart':
        await bridge.call('system_control', { action: 'restart' }, 4500);
        return { ok: true };
      case 'sys:shutdown':
        await bridge.call('system_control', { action: 'shutdown' }, 4500);
        return { ok: true };
      case 'sys:signout':
        await bridge.call('system_control', { action: 'signout' }, 4500);
        return { ok: true };
      case 'mon:off':
        await bridge.call('monitor_power', { action: 'off' }, 4500);
        return { ok: true };
      case 'mon:on':
        await bridge.call('monitor_power', { action: 'on', clearBlackouts: true }, 4500);
        return { ok: true };
      case 'win:show_desktop':
        await bridge.call('window_action', { action: 'show_desktop' }, 4500);
        return { ok: true };
      case 'win:minimize_all':
        await bridge.call('window_action', { action: 'minimize_all' }, 4500);
        return { ok: true };
      case 'disp:extend':
      case 'disp:clone':
      case 'disp:internal':
      case 'disp:external':
        await bridge.call('display_topology', { mode: code.split(':')[1] }, 6500);
        return { ok: true };
      case 'audio:toggle_mute':
        await runAudioControl({ action: 'toggle_master_mute' });
        return { ok: true };
      case 'audio:toggle_mic':
        await runAudioControl({ action: 'toggle_mic_mute' });
        return { ok: true };
      case 'media:play_pause':
        await bridge.call('send_input', { type: 'key', key: 'MEDIA_PLAY_PAUSE' }, 2500);
        scheduleFastMediaSync();
        return { ok: true };
      case 'media:next':
        await bridge.call('send_input', { type: 'key', key: 'MEDIA_NEXT' }, 2500);
        scheduleFastMediaSync();
        return { ok: true };
      case 'media:prev':
        await bridge.call('send_input', { type: 'key', key: 'MEDIA_PREV' }, 2500);
        scheduleFastMediaSync();
        return { ok: true };
      case 'media:vol_up':
        await bridge.call('send_input', { type: 'key', key: 'VOLUME_UP' }, 2500);
        return { ok: true };
      case 'media:vol_down':
        await bridge.call('send_input', { type: 'key', key: 'VOLUME_DOWN' }, 2500);
        return { ok: true };
      case 'wireless:wifi_on':
        await bridge.call('wireless_control', { action: 'wifi_toggle', enable: true }, 9000);
        return { ok: true };
      case 'wireless:wifi_off':
        await bridge.call('wireless_control', { action: 'wifi_toggle', enable: false }, 9000);
        return { ok: true };
      case 'wireless:hotspot_on':
        await bridge.call('wireless_control', { action: 'hotspot_toggle', enable: true }, 10000);
        return { ok: true };
      case 'wireless:hotspot_off':
        await bridge.call('wireless_control', { action: 'hotspot_toggle', enable: false }, 10000);
        return { ok: true };
      case 'wireless:bt_on':
        await bridge.call('wireless_control', { action: 'bt_toggle', enable: true }, 9000);
        return { ok: true };
      case 'wireless:bt_off':
        await bridge.call('wireless_control', { action: 'bt_toggle', enable: false }, 9000);
        return { ok: true };
      case 'maint:flush_dns':
        await bridge.call('system_control', { action: 'flush_dns' }, 6500);
        return { ok: true };
      case 'maint:optimize_ram':
        await bridge.call('system_control', { action: 'optimize_ram' }, 6500);
        return { ok: true };
      case 'maint:empty_recycle_bin':
        await bridge.call('system_control', { action: 'empty_recycle_bin' }, 6500);
        return { ok: true };
      case 'key:SCREENSHOT':
        await bridge.call('send_input', { type: 'key', key: 'WIN+SHIFT+S' }, 2500);
        return { ok: true };
      case 'key:TASKMGR':
        await bridge.call('send_input', { type: 'key', key: 'CTRL+SHIFT+ESC' }, 2500);
        return { ok: true };
      default:
        if (code.startsWith('key:')) {
          await bridge.call('send_input', { type: 'key', key: code.slice(4) }, 2500);
          return { ok: true };
        }
        throw new Error('Bilinmeyen sistem işlemi: ' + code);
    }
  }

  // Special handling for Discord updater
  if (
    targetPath.toLowerCase().includes('\\discord\\') &&
    targetPath.toLowerCase().endsWith('discord.exe')
  ) {
    const localApp = process.env.LOCALAPPDATA || '';
    const updater = path.join(localApp, 'Discord', 'Update.exe');
    if (fs.existsSync(updater)) {
      targetPath = updater;
      if (!extraArgs) extraArgs = '--processStart Discord.exe';
    }
  }

  return bridge.call(
    'execute_quick_item',
    {
      targetPath,
      openWithMode: item.openWithMode || 'default',
      openWithPath: item.openWithPath || '',
      arguments: extraArgs,
      workingDirectory: item.workingDirectory || '',
      windowStyle: item.windowStyle || 'normal',
      runAsAdmin: Boolean(item.runAsAdmin),
      priority: item.priority || 'normal',
      ifRunning: item.ifRunning || 'new',
      monitorIndex: typeof item.monitorIndex === 'number' ? item.monitorIndex : -1,
      zone: item.zone || 'none',
      alwaysOnTop: Boolean(item.alwaysOnTop)
    },
    8000
  );
}

async function executeQuickAction(qa, onProgress) {
  const startedAt = Date.now();
  const items = Array.isArray(qa.items) ? qa.items : [];
  const shouldWakeScreen = items.some((it) => {
    const t = String((it && it.targetType) || 'file').toLowerCase();
    return t === 'app' || t === 'file' || t === 'folder' || t === 'url' || t === 'scene';
  });
  if (shouldWakeScreen) {
    await bridge.call('monitor_power', { action: 'on', clearBlackouts: false }).catch(() => {});
  }
  const results = [];

  if (qa.executionMode === 'sequential') {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const delayMs = Math.max(0, Number(it.delayMs || 0));
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (onProgress) onProgress({ index: i, name: it.name || it.targetPath });
      try {
        const r = await executeQuickItemBridge(it);
        results.push({ name: it.name, ok: Boolean(r && r.ok), detail: r });
      } catch (e) {
        results.push({ name: it.name, ok: false, error: e.message });
      }
    }
  } else {
    // Parallel execution (honoring per-item delayMs if specified)
    const tasks = items.map(async (it, i) => {
      const delayMs = Math.max(0, Number(it.delayMs || 0));
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (onProgress) onProgress({ index: i, name: it.name || it.targetPath });
      try {
        const r = await executeQuickItemBridge(it);
        return { name: it.name, ok: Boolean(r && r.ok), detail: r };
      } catch (e) {
        return { name: it.name, ok: false, error: e.message };
      }
    });
    const resList = await Promise.all(tasks);
    results.push(...resList);
  }

  qa.runCount = Number(qa.runCount || 0) + 1;
  qa.lastRunAt = new Date().toISOString();
  saveQuickActions(quickActions);

  return {
    id: qa.id,
    name: qa.name,
    elapsedMs: Date.now() - startedAt,
    results
  };
}

const runningMacros = new Map();

function getRunningMacroIds() {
  return Array.from(runningMacros.keys());
}

function broadcastMacrosRuntimeState() {
  broadcastStateUpdate('macros_runtime_updated', { runningMacroIds: getRunningMacroIds() });
}

function normalizeMacroStepPayload(s) {
  const rawType = String((s && s.type) || 'key').toLowerCase();
  const validTypes = ['key', 'key_down', 'key_up', 'text', 'delay', 'system_action', 'app'];
  const type = validTypes.includes(rawType) ? rawType : 'key';
  const value = String((s && s.value) ?? '').trim();
  const rawAction = String((s && s.action) || '').toLowerCase();
  const action = ['tap', 'hold', 'hold_until_stop', 'down', 'up'].includes(rawAction) ? rawAction : 'tap';
  const holdMs = Math.max(0, Math.min(3600000, Number((s && s.holdMs) || 0)));
  return {
    id: (s && s.id) || crypto.randomUUID(),
    type,
    value,
    label: String((s && s.label) || '').trim(),
    action,
    holdMs
  };
}

function normalizeMacroPayload(incoming, prev) {
  if (!incoming || !incoming.name) throw new Error('Makro adı gerekli.');
  const rawSteps = Array.isArray(incoming.steps) ? incoming.steps : [];
  if (rawSteps.length === 0) throw new Error('En az 1 makro adımı eklemelisiniz.');
  const formattedSteps = rawSteps.map(normalizeMacroStepPayload).filter((s) => Boolean(s.value));
  if (formattedSteps.length === 0) throw new Error('En az 1 geçerli makro adımı gerekli.');

  const rawMode = String(incoming.repeatMode || (prev && prev.repeatMode) || 'once').toLowerCase();
  const repeatMode = ['once', 'toggle', 'duration', 'count'].includes(rawMode) ? rawMode : 'once';
  const repeatDurationSec = Math.max(1, Math.min(86400, Number(incoming.repeatDurationSec || (prev && prev.repeatDurationSec) || 5)));
  const repeatCount = Math.max(1, Math.min(10000, Number(incoming.repeatCount || (prev && prev.repeatCount) || 5)));
  const repeatIntervalMs = Math.max(20, Math.min(60000, Number(incoming.repeatIntervalMs ?? (prev && prev.repeatIntervalMs) ?? 120)));

  return {
    id: incoming.id || (prev && prev.id) || crypto.randomUUID(),
    name: String(incoming.name).trim(),
    repeatMode,
    repeatDurationSec,
    repeatCount,
    repeatIntervalMs,
    createdAt: (prev && prev.createdAt) || incoming.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRunAt: (prev && prev.lastRunAt) || null,
    runCount: Number((prev && prev.runCount) || 0),
    steps: formattedSteps
  };
}

async function stopRunningMacro(macroId) {
  const ctx = runningMacros.get(macroId);
  if (!ctx) return { ok: true, stopped: false, runningMacroIds: getRunningMacroIds() };
  ctx.aborted = true;
  if (ctx.wake) ctx.wake();
  return { ok: true, stopped: true, id: macroId, runningMacroIds: getRunningMacroIds() };
}

async function executeMacro(macro) {
  if (runningMacros.has(macro.id)) {
    return stopRunningMacro(macro.id);
  }

  const startedAt = Date.now();
  const steps = Array.isArray(macro.steps) ? macro.steps : [];
  const repeatMode = String(macro.repeatMode || 'once').toLowerCase();
  const repeatDurationMs = Math.max(500, Number(macro.repeatDurationSec || 5) * 1000);
  const repeatCount = Math.max(1, Number(macro.repeatCount || 1));
  const repeatIntervalMs = Math.max(25, Number(macro.repeatIntervalMs ?? 120));

  const hasContinuousHold = steps.some((s) => s && (s.action === 'hold_until_stop' || Number(s.holdMs || 0) >= 800));
  const isLongRunning = repeatMode === 'toggle' || repeatMode === 'duration' || (repeatMode === 'count' && repeatCount > 1) || hasContinuousHold;

  const ctx = {
    id: macro.id,
    aborted: false,
    heldKeys: new Set(),
    wake: null
  };

  const sleepInterruptible = (ms) =>
    new Promise((resolve) => {
      if (ctx.aborted || ms <= 0) return resolve();
      const t = setTimeout(() => {
        ctx.wake = null;
        resolve();
      }, ms);
      ctx.wake = () => {
        clearTimeout(t);
        ctx.wake = null;
        resolve();
      };
    });

  const runSinglePass = async () => {
    for (let i = 0; i < steps.length; i++) {
      if (ctx.aborted) break;
      const step = steps[i] || {};
      const stepType = String(step.type || 'key').toLowerCase();
      const stepAction = String(step.action || 'tap').toLowerCase();
      const holdMs = Math.max(0, Number(step.holdMs || 0));

      if (stepType === 'delay') {
        const ms = Math.max(10, Math.min(300000, Number(step.value || 100)));
        await sleepInterruptible(ms);
      } else if (stepType === 'system_action') {
        const actionCode = String(step.value || '').trim();
        if (actionCode) {
          await executeSystemActionCode(actionCode).catch(() => {});
        }
        if (i < steps.length - 1 && String((steps[i + 1] || {}).type) !== 'delay') {
          await sleepInterruptible(80);
        }
      } else if (stepType === 'app') {
        const launchPath = String(step.value || '').trim();
        if (launchPath) {
          await launchApplication({ name: step.label || launchPath, launchPath, args: step.args || '' }).catch(() => {});
        }
        if (i < steps.length - 1 && String((steps[i + 1] || {}).type) !== 'delay') {
          await sleepInterruptible(120);
        }
      } else if (stepType === 'text') {
        const txt = String(step.value || '');
        if (txt) {
          await bridge.call('send_input', { type: 'text', text: txt }, 3000).catch(() => {});
        }
        if (i < steps.length - 1 && String((steps[i + 1] || {}).type) !== 'delay') {
          await sleepInterruptible(40);
        }
      } else {
        const keyStr = String(step.value || '').trim().toUpperCase();
        if (!keyStr) continue;

        if (stepType === 'key_down' || stepAction === 'down' || stepAction === 'hold_until_stop') {
          ctx.heldKeys.add(keyStr);
          await bridge.call('send_input', { type: 'key_down', key: keyStr }, 2000).catch(() => {});
          if (stepAction === 'hold_until_stop' && repeatMode === 'once') {
            while (!ctx.aborted) {
              await sleepInterruptible(250);
            }
          }
        } else if (stepType === 'key_up' || stepAction === 'up') {
          ctx.heldKeys.delete(keyStr);
          await bridge.call('send_input', { type: 'key_up', key: keyStr }, 2000).catch(() => {});
        } else if (stepAction === 'hold' || holdMs > 0) {
          const effectiveHold = Math.max(50, holdMs || 1000);
          ctx.heldKeys.add(keyStr);
          await bridge.call('send_input', { type: 'key_down', key: keyStr }, 2000).catch(() => {});
          await sleepInterruptible(effectiveHold);
          ctx.heldKeys.delete(keyStr);
          await bridge.call('send_input', { type: 'key_up', key: keyStr }, 2000).catch(() => {});
        } else {
          await bridge.call('send_input', { type: 'key', key: keyStr }, 2000).catch(() => {});
        }

        if (i < steps.length - 1 && String((steps[i + 1] || {}).type) !== 'delay') {
          await sleepInterruptible(40);
        }
      }
    }
  };

  macro.runCount = Number(macro.runCount || 0) + 1;
  macro.lastRunAt = new Date().toISOString();
  saveMacros(macros);

  const executeLoop = async () => {
    runningMacros.set(macro.id, ctx);
    broadcastMacrosRuntimeState();
    try {
      const onlyHoldUntilStop = steps.length > 0 && steps.every((s) => s && s.action === 'hold_until_stop');
      if (onlyHoldUntilStop) {
        for (const s of steps) {
          const k = String(s.value || '').trim().toUpperCase();
          if (k) {
            ctx.heldKeys.add(k);
            await bridge.call('send_input', { type: 'key_down', key: k }, 2000).catch(() => {});
          }
        }
        const waitLimit = repeatMode === 'duration' ? repeatDurationMs : 86400000;
        await sleepInterruptible(waitLimit);
      } else if (repeatMode === 'toggle') {
        while (!ctx.aborted) {
          await runSinglePass();
          if (ctx.aborted) break;
          await sleepInterruptible(repeatIntervalMs);
        }
      } else if (repeatMode === 'duration') {
        const deadline = Date.now() + repeatDurationMs;
        const killTimer = setTimeout(() => {
          ctx.aborted = true;
          if (ctx.wake) ctx.wake();
        }, repeatDurationMs);
        try {
          while (!ctx.aborted && Date.now() < deadline) {
            await runSinglePass();
            if (ctx.aborted || Date.now() >= deadline) break;
            await sleepInterruptible(Math.min(repeatIntervalMs, Math.max(10, deadline - Date.now())));
          }
        } finally {
          clearTimeout(killTimer);
        }
      } else if (repeatMode === 'count') {
        for (let c = 0; c < repeatCount; c++) {
          if (ctx.aborted) break;
          await runSinglePass();
          if (ctx.aborted || c >= repeatCount - 1) break;
          await sleepInterruptible(repeatIntervalMs);
        }
      } else {
        await runSinglePass();
      }
    } finally {
      for (const k of Array.from(ctx.heldKeys)) {
        await bridge.call('send_input', { type: 'key_up', key: k }, 2000).catch(() => {});
      }
      ctx.heldKeys.clear();
      runningMacros.delete(macro.id);
      broadcastMacrosRuntimeState();
    }
  };

  if (isLongRunning) {
    executeLoop().catch(() => {});
    return {
      id: macro.id,
      name: macro.name,
      started: true,
      running: true,
      repeatMode,
      runningMacroIds: getRunningMacroIds(),
      stepCount: steps.length
    };
  }

  await executeLoop();
  return {
    id: macro.id,
    name: macro.name,
    running: false,
    runningMacroIds: getRunningMacroIds(),
    elapsedMs: Date.now() - startedAt,
    stepCount: steps.length
  };
}

// Wake-on-LAN Magic Packet Sender
function sendWakeOnLan(macAddress, broadcastAddress = '255.255.255.255') {
  return new Promise((resolve, reject) => {
    const cleanMac = String(macAddress || '').replace(/[^0-9A-Fa-f]/g, '');
    if (cleanMac.length !== 12) {
      return reject(new Error('Geçersiz MAC adresi formatı'));
    }
    const macBytes = Buffer.from(cleanMac, 'hex');
    const packet = Buffer.alloc(102);
    packet.fill(0xff, 0, 6);
    for (let i = 0; i < 16; i++) {
      macBytes.copy(packet, 6 + i * 6);
    }

    const sock = dgram.createSocket('udp4');
    sock.once('error', (err) => {
      sock.close();
      reject(err);
    });
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(packet, 0, packet.length, 9, broadcastAddress, () => {
        sock.send(packet, 0, packet.length, 7, '255.255.255.255', () => {
          sock.close();
          resolve({ sent: true, macAddress });
        });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// GitHub Auto-Update & Bidirectional File Transfer (v2.17.0+)
// ---------------------------------------------------------------------------
const AGENT_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    if (pkg && pkg.version) return String(pkg.version).trim();
  } catch {}
  return '2.17.0';
})();

const GITHUB_REPO_SLUG = 'blttaha/bridge';

function compareSemverStrings(vA, vB) {
  const cleanA = String(vA || '0.0.0').replace(/^v/i, '').trim().split('.').map((n) => parseInt(n, 10) || 0);
  const cleanB = String(vB || '0.0.0').replace(/^v/i, '').trim().split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const a = cleanA[i] || 0;
    const b = cleanB[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

function httpsGetBuffer(urlStr, timeoutMs = 8000, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) return reject(new Error('Çok fazla yönlendirme'));
    let parsedUrl;
    try {
      parsedUrl = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    const req = mod.request(
      parsedUrl,
      {
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          'User-Agent': `Bridge-PC-Agent/${AGENT_VERSION}`,
          Accept: 'application/vnd.github+json, application/json, */*'
        }
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsedUrl).toString();
          return httpsGetBuffer(nextUrl, timeoutMs, maxRedirects - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('timeout', () => req.destroy(new Error('İstek zaman aşımına uğradı')));
    req.on('error', reject);
    req.end();
  });
}

async function checkGitHubUpdate() {
  let latestVersion = AGENT_VERSION;
  let releaseNotes = '';
  let publishedAt = '';
  let windowsUrl = `https://github.com/${GITHUB_REPO_SLUG}/releases/latest/download/Bridge-Setup.exe`;
  let linuxUrl = `https://github.com/${GITHUB_REPO_SLUG}/releases/latest/download/Bridge-Linux.tar.gz`;
  let androidUrl = `https://github.com/${GITHUB_REPO_SLUG}/releases/latest/download/Bridge.apk`;

  try {
    const buf = await httpsGetBuffer(`https://api.github.com/repos/${GITHUB_REPO_SLUG}/releases/latest`, 6500);
    const rel = JSON.parse(buf.toString('utf8'));
    if (rel && rel.tag_name) {
      latestVersion = String(rel.tag_name).replace(/^v/i, '').trim();
      releaseNotes = String(rel.body || '').trim();
      publishedAt = String(rel.published_at || '');
      if (Array.isArray(rel.assets)) {
        for (const asset of rel.assets) {
          const name = String(asset.name || '');
          if (name === 'Bridge-Setup.exe' && asset.browser_download_url) windowsUrl = asset.browser_download_url;
          else if (name === 'Bridge-Linux.tar.gz' && asset.browser_download_url) linuxUrl = asset.browser_download_url;
          else if (name === 'Bridge.apk' && asset.browser_download_url) androidUrl = asset.browser_download_url;
        }
      }
    }
  } catch {
    try {
      const vBuf = await httpsGetBuffer(`https://raw.githubusercontent.com/${GITHUB_REPO_SLUG}/main/version.json`, 5000);
      const vJson = JSON.parse(vBuf.toString('utf8'));
      if (vJson && vJson.version) {
        latestVersion = String(vJson.version).replace(/^v/i, '').trim();
      }
    } catch {}
  }

  const updateAvailable = compareSemverStrings(latestVersion, AGENT_VERSION) > 0;
  return {
    ok: true,
    platform: IS_WINDOWS ? 'windows' : 'linux',
    currentVersion: AGENT_VERSION,
    latestVersion,
    updateAvailable,
    releaseNotes,
    publishedAt,
    assets: {
      windows: windowsUrl,
      linux: linuxUrl,
      android: androidUrl
    }
  };
}

async function performSelfUpdate() {
  const info = await checkGitHubUpdate();
  const rootDir = path.resolve(__dirname, '..');

  if (IS_WINDOWS) {
    // Download updated core files from main branch / release and swap them via detached PowerShell
    const rawBase = `https://raw.githubusercontent.com/${GITHUB_REPO_SLUG}/main`;
    const filesToUpdate = [
      { url: `${rawBase}/pc-agent/server.js`, dest: path.join(__dirname, 'server.js') },
      { url: `${rawBase}/pc-agent/package.json`, dest: path.join(__dirname, 'package.json') },
      { url: `${rawBase}/pc-agent/native/BridgeHelper.exe`, dest: path.join(__dirname, 'native', 'BridgeHelper.exe') },
      { url: `${rawBase}/Bridge.exe`, dest: path.join(rootDir, 'Bridge.exe') }
    ];

    const stagedMoves = [];
    for (const item of filesToUpdate) {
      try {
        const data = await httpsGetBuffer(item.url, 15000);
        if (data && data.length > 64) {
          const tmpPath = item.dest + '.update_tmp';
          fs.writeFileSync(tmpPath, data);
          stagedMoves.push({ tmpPath, dest: item.dest });
        }
      } catch {}
    }

    if (stagedMoves.length === 0) {
      throw new Error('Güncelleme dosyaları GitHub üzerinden indirilemedi.');
    }

    const bridgeExePath = path.join(rootDir, 'Bridge.exe');
    const moveCommands = stagedMoves
      .map((m) => `Move-Item -Path '${m.tmpPath.replace(/'/g, "''")}' -Destination '${m.dest.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue`)
      .join('\r\n');

    const psUpdater = `
Start-Sleep -Milliseconds 900
Stop-Process -Name "Bridge","BridgeHelper" -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600
${moveCommands}
Start-Sleep -Milliseconds 300
if (Test-Path '${bridgeExePath.replace(/'/g, "''")}') {
  Start-Process '${bridgeExePath.replace(/'/g, "''")}'
}
`;
    const psScriptPath = path.join(os.tmpdir(), `bridge_updater_${Date.now()}.ps1`);
    fs.writeFileSync(psScriptPath, psUpdater, 'utf8');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', psScriptPath], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    });
    child.unref();

    setTimeout(() => process.exit(0), 400);
    return {
      ok: true,
      updating: true,
      latestVersion: info.latestVersion,
      message: `Bridge v${info.latestVersion} indirildi, servis yeniden başlatılıyor...`
    };
  } else {
    // Linux self-updater: download Bridge-Linux.tar.gz and run install.sh
    const tarBuf = await httpsGetBuffer(info.assets.linux, 25000);
    const tmpTar = path.join(os.tmpdir(), `Bridge-Linux-${Date.now()}.tar.gz`);
    const tmpExtract = path.join(os.tmpdir(), `bridge-extract-${Date.now()}`);
    fs.writeFileSync(tmpTar, tarBuf);
    fs.mkdirSync(tmpExtract, { recursive: true });
    const shCmd = `sleep 1 && tar -xzf "${tmpTar}" -C "${tmpExtract}" && bash "${tmpExtract}/Bridge-Linux/install.sh" && rm -rf "${tmpTar}" "${tmpExtract}"`;
    const child = spawn('bash', ['-c', shCmd], { detached: true, stdio: 'ignore' });
    child.unref();
    return {
      ok: true,
      updating: true,
      latestVersion: info.latestVersion,
      message: `Bridge Linux v${info.latestVersion} kuruluyor ve servis yeniden başlatılıyor...`
    };
  }
}

async function handleFileUpload(params) {
  const rawName = path.basename(String((params && params.fileName) || '').trim()).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  if (!rawName) throw new Error('Geçersiz dosya adı.');
  const b64 = String((params && params.base64Data) || '');
  if (!b64) throw new Error('Dosya verisi boş.');
  const commaIdx = b64.indexOf(',');
  const cleanB64 = commaIdx >= 0 ? b64.slice(commaIdx + 1) : b64;
  const buf = Buffer.from(cleanB64, 'base64');
  if (buf.length === 0) throw new Error('Dosya içeriği çözümlenemedi.');

  let destDir = String((params && params.targetDir) || '').trim();
  if (!destDir || !fs.existsSync(destDir)) {
    const dlDir = path.join(os.homedir(), 'Downloads');
    destDir = fs.existsSync(dlDir) ? dlDir : os.homedir();
  }

  const ext = path.extname(rawName);
  const stem = path.basename(rawName, ext);
  let finalName = rawName;
  let finalPath = path.join(destDir, finalName);
  let counter = 1;
  while (fs.existsSync(finalPath) && counter < 500) {
    finalName = `${stem} (${counter})${ext}`;
    finalPath = path.join(destDir, finalName);
    counter++;
  }

  fs.writeFileSync(finalPath, buf);

  if (params && params.openAfterUpload) {
    await executeQuickItemBridge({ targetPath: finalPath }).catch(() => {});
  }

  return {
    ok: true,
    fileName: finalName,
    path: finalPath,
    directory: destDir,
    sizeBytes: buf.length
  };
}

function handleFileDownloadRpc(params) {
  const targetPath = String((params && params.path) || '').trim();
  if (!targetPath || !fs.existsSync(targetPath)) {
    throw new Error('İndirilecek dosya bulunamadı.');
  }
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    throw new Error('Klasörler doğrudan indirilemez, lütfen bir dosya seçin.');
  }
  if (stat.size > 30 * 1024 * 1024) {
    throw new Error('30 MB üzerindeki dosyalar için doğrudan indirme bağlantısını kullanın.');
  }
  const buf = fs.readFileSync(targetPath);
  const fileName = path.basename(targetPath);
  return {
    ok: true,
    fileName,
    path: targetPath,
    sizeBytes: buf.length,
    base64Data: buf.toString('base64')
  };
}

// HTTP Server (CORS enabled + Pairing & Discovery REST fallback)
const handleHttpRequest = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // A malformed Host header used to throw here and kill the whole agent
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    res.writeHead(400);
    return res.end();
  }

  const viaTunnel = isTunnelRequest(req);

  // Public discovery info endpoint (so mobile app can probe LAN / USB Tether / Hotspot / Tunnel / Tailscale IP)
  if (url.pathname === '/api/discover' && req.method === 'GET') {
    // Anyone who learns the tunnel URL can call this: only say which PC it is, never its internal addresses
    if (viaTunnel) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ deviceId: config.deviceId, port: PORT }));
    }
    const netInfo = resolveClientNetworkInfo(getNetworkInfo(), req.socket && req.socket.remoteAddress, req.headers.host);
    let monitors = [];
    try {
      monitors = await bridge.call('get_monitors');
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(
      JSON.stringify({
        deviceId: config.deviceId,
        deviceName: config.deviceName,
        lanIp: netInfo.lanIp,
        lanIps: netInfo.lanIps,
        subnetBroadcast: netInfo.subnetBroadcast,
        subnetBroadcasts: netInfo.subnetBroadcasts,
        macAddress: netInfo.macAddress,
        macAddresses: netInfo.macAddresses,
        tailscaleIp: netInfo.tailscaleIp,
        port: PORT,
        monitorCount: monitors.length
      })
    );
  }

  // Rotate dynamic one-time pairing security code on demand
  const adminOnlyPaths = [
    '/api/pair/rotate',
    '/api/sessions/disconnect',
    '/api/sessions/disconnect-device',
    '/api/takeover',
    '/api/monitors/wake',
    '/api/update/check',
    '/api/update/perform'
  ];
  if (adminOnlyPaths.includes(url.pathname) && !isLocalAdminRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: 'Bu işlem yalnızca bilgisayardaki görev çubuğu uygulamasından yapılabilir.' }));
  }

  if (url.pathname === '/api/update/check' && req.method === 'POST') {
    try {
      const info = await checkGitHubUpdate();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(info));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (url.pathname === '/api/update/perform' && req.method === 'POST') {
    try {
      const upd = await performSelfUpdate();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(upd));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (url.pathname === '/api/download' && req.method === 'GET') {
    const token = String(url.searchParams.get('authToken') || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!isKnownSessionToken(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'Yetkisiz indirme isteği.' }));
    }
    const targetPath = String(url.searchParams.get('path') || '').trim();
    if (!targetPath || !fs.existsSync(targetPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'Dosya bulunamadı.' }));
    }
    try {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'Klasör indirilemez.' }));
      }
      const fileName = path.basename(targetPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
      });
      const stream = fs.createReadStream(targetPath);
      stream.on('error', () => res.end());
      stream.pipe(res);
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (url.pathname === '/api/pair/rotate' && req.method === 'POST') {
    const newCode = rotatePairingCode(false);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, pin: newCode, pinExpiresAt }));
  }

  // 1-Click Taskbar Disconnect: Terminate all active sessions and revoke tokens
  if (url.pathname === '/api/sessions/disconnect' && req.method === 'POST') {
    const result = disconnectAllSessions();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, ...result }));
  }

  // Per-Device Taskbar Disconnect: Terminate a specific device's session and revoke its token
  if (url.pathname === '/api/sessions/disconnect-device' && req.method === 'POST') {
    const queryId = url.searchParams.get('id') || '';
    if (queryId) {
      const result = disconnectSingleDevice(queryId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(result));
    }
    readRequestBody(req, res, (body) => {
      try {
        const parsed = JSON.parse(body || '{}');
        const result = disconnectSingleDevice(parsed.id || parsed.deviceId || '');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Ephemeral 8-character security code pairing endpoint
  if (url.pathname === '/api/pair' && req.method === 'POST') {
    const clientIp = getClientKey(req);
    readRequestBody(req, res, async (body) => {
      try {
        const parsed = JSON.parse(body || '{}');
        const rawInput = String(parsed.pin || '').trim();
        const isTokenMatch = isKnownSessionToken(rawInput);
        // Valid tokens are never rate limited, so a stranger spamming bad codes cannot lock the owner out
        if (!isTokenMatch) {
          const rate = checkRateLimit(clientIp);
          if (!rate.allowed) {
            res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(
              JSON.stringify({ ok: false, error: `Çok fazla hatalı deneme yapıldı. Güvenlik kilidi: ${rate.waitSec} saniye bekleyin.` })
            );
          }
        }
        const consumedToken = isTokenMatch ? null : consumeOrReuseEphemeralPin(rawInput, clientIp);

        if (!consumedToken && !isTokenMatch) {
          notePinFailure(rawInput);
          recordFailedAuth(clientIp);
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(
            JSON.stringify({
              ok: false,
              error: 'Geçersiz veya süresi dolmuş 8 haneli güvenlik kodu. Görev çubuğundaki güncel kodu kontrol edin.'
            })
          );
        }

        clearFailedAuth(clientIp);
        const issuedToken = isTokenMatch ? rawInput : consumedToken;
        touchSessionToken(issuedToken, req, parsed);
        updateRuntimeStatusFile();
        const netInfo = resolveClientNetworkInfo(getNetworkInfo(), req.socket && req.socket.remoteAddress, req.headers.host);
        // Refresh monitor count asynchronously so /api/pair returns in <1ms without blocking on Win32 bridge
        bridge
          .call('get_monitors')
          .then((m) => {
            if (Array.isArray(m) && m.length > 0) cachedMonitorCount = m.length;
          })
          .catch(() => {});

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(
          JSON.stringify({
            ok: true,
            device: {
              deviceId: config.deviceId,
              deviceName: config.deviceName,
              lanIp: netInfo.lanIp,
              lanIps: netInfo.lanIps,
              subnetBroadcast: netInfo.subnetBroadcast,
              subnetBroadcasts: netInfo.subnetBroadcasts,
              tailscaleIp: netInfo.tailscaleIp,
              macAddress: netInfo.macAddress,
              macAddresses: netInfo.macAddresses,
              tunnelUrl: currentTunnelUrl,
              wsTunnelUrl: currentWsTunnelUrl,
              syncTopic: SYNC_TOPIC,
              port: PORT,
              authToken: issuedToken,
              syncKey: config.syncKey,
              monitorCount: cachedMonitorCount
            }
          })
        );
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Stateless Authenticated HTTP Command Fallback (executes commands immediately even when WebSocket is waking from phone Doze)
  if (url.pathname === '/api/command' && req.method === 'POST') {
    const clientIp = getClientKey(req);
    readRequestBody(req, res, async (body) => {
      try {
        const parsed = JSON.parse(body || '{}');
        if (parsed.expectedDeviceId && parsed.expectedDeviceId !== config.deviceId) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: 'Hedef cihaz kimliği uyuşmuyor.' }));
        }
        const token = String(parsed.authToken || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
        const tokenOk = isKnownSessionToken(token);
        if (!tokenOk) {
          const rate = checkRateLimit(clientIp);
          if (!rate.allowed) {
            res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ ok: false, error: `Çok fazla hatalı deneme. ${rate.waitSec} saniye bekleyin.` }));
          }
        }
        const consumedPinForCmd = tokenOk ? null : consumeOrReuseEphemeralPin(String(parsed.pin || ''), clientIp);
        const isTokenValid = tokenOk || Boolean(consumedPinForCmd);
        const activeToken = tokenOk ? token : consumedPinForCmd;
        if (activeToken) {
          touchSessionToken(activeToken, req, parsed);
          updateRuntimeStatusFile();
        }
        if (!isTokenValid) {
          if (parsed.pin) notePinFailure(parsed.pin);
          recordFailedAuth(clientIp);
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: 'Yetkisiz erişim veya sonlandırılmış oturum.' }));
        }

        const cmdId = String(parsed.cmdId || '').trim();
        if (cmdId) {
          if (!global.__recentQuickCmdIds) global.__recentQuickCmdIds = new Map();
          if (global.__recentQuickCmdIds.has(cmdId)) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ ok: true, deduplicated: true, data: global.__recentQuickCmdIds.get(cmdId) }));
          }
          global.__recentQuickCmdIds.set(cmdId, { accepted: true });
          setTimeout(() => {
            if (global.__recentQuickCmdIds) global.__recentQuickCmdIds.delete(cmdId);
          }, 5000);
        }

        const action = String(parsed.action || '');
        const params = parsed.params || parsed.payload || {};
        let resultData = null;

        if (action === 'monitor_power') {
          const r = await runMonitorPower(params);
          const monitors = await bridge.call('get_monitors').catch(() => []);
          broadcastStateUpdate('monitors_updated', monitors);
          resultData = { ...r, monitors };
        } else if (action === 'monitor_blackout') {
          const monitors = await bridge.call('monitor_blackout', params);
          broadcastStateUpdate('monitors_updated', monitors);
          resultData = { monitors };
        } else if (action === 'display_topology') {
          resultData = await bridge.call('display_topology', params);
        } else if (action === 'media_key') {
          resultData = await runSystemControl({ action: 'media_key', key: params.key });
          scheduleFastMediaSync();
        } else if (action === 'send_input') {
          resultData = await bridge.call('send_input', params);
          if (params.type === 'key' && String(params.key || '').toUpperCase().startsWith('MEDIA_')) {
            scheduleFastMediaSync();
          }
        } else if (action === 'system_control') {
          resultData = await runSystemControl(params);
          if (resultData && typeof resultData.isLocked === 'boolean') {
            broadcastStateUpdate('lock_state_updated', { isLocked: resultData.isLocked });
          }
          if (params && params.action === 'set_brightness') {
            const monitors = await bridge.call('get_monitors').catch(() => []);
            broadcastStateUpdate('monitors_updated', monitors);
          }
        } else if (action === 'audio_control') {
          resultData = await runAudioControl(params);
        } else if (action === 'wireless_control') {
          resultData = await bridge.call('wireless_control', params, 10000);
        } else if (action === 'check_update') {
          resultData = await checkGitHubUpdate();
        } else if (action === 'perform_update') {
          resultData = await performSelfUpdate();
        } else if (action === 'upload_file') {
          resultData = await handleFileUpload(params);
        } else if (action === 'download_file') {
          resultData = handleFileDownloadRpc(params);
        } else if (action === 'power_timer') {
          resultData = configurePowerTimer(params.minutes, params.mode);
        } else if (action === 'launch_app') {
          await launchApplication(params);
          resultData = { launched: true };
        } else if (action === 'run_single_item') {
          resultData = await executeQuickItemBridge(params.item || params);
        } else if (action === 'run_quick_action') {
          const targetQa = quickActions.find((q) => q.id === params.id);
          if (!targetQa) throw new Error('Hızlı erişim butonu bulunamadı.');
          resultData = await executeQuickAction(targetQa);
        } else if (action === 'run_macro') {
          const targetMacro = macros.find((m) => m.id === params.id);
          if (!targetMacro) throw new Error('Makro bulunamadı.');
          resultData = await executeMacro(targetMacro);
          broadcastStateUpdate('macros_updated', macros);
        } else if (action === 'stop_macro') {
          resultData = await stopRunningMacro(params.id);
        } else if (action === 'save_macro') {
          const incoming = params.macro || params;
          const existingIdx = macros.findIndex((m) => m.id === incoming.id);
          const prev = existingIdx >= 0 ? macros[existingIdx] : null;
          const formatted = normalizeMacroPayload(incoming, prev);
          if (existingIdx >= 0) macros[existingIdx] = formatted;
          else macros.unshift(formatted);
          saveMacros(macros);
          broadcastStateUpdate('macros_updated', macros);
          resultData = { macro: formatted, macros };
        } else if (action === 'delete_macro') {
          await stopRunningMacro(params.id).catch(() => {});
          macros = macros.filter((m) => m.id !== params.id);
          saveMacros(macros);
          broadcastStateUpdate('macros_updated', macros);
          resultData = { macros };
        } else if (action === 'run_scene') {
          const target = scenes.find((s) => s.id === params.sceneId);
          if (!target) throw new Error('Sahne bulunamadı.');
          resultData = await executeScene(target);
        } else if (action === 'snapshot_scene') {
          const newScene = await createSnapshotScene(params.name);
          broadcastStateUpdate('scenes_updated', scenes);
          resultData = { scene: newScene, scenes };
        } else if (action === 'snap_window') {
          const geom = resolveItemGeometry(params);
          const resSnap = await bridge.call('snap_window', {
            hwnd: params.hwnd,
            processName: params.processName,
            monitorIndex: Number(params.monitorIndex || 0),
            state: geom.state,
            x: geom.x,
            y: geom.y,
            w: geom.w,
            h: geom.h
          });
          const windows = await bridge.call('get_windows').catch(() => []);
          broadcastStateUpdate('windows_updated', windows);
          resultData = { ...resSnap, windows };
        } else if (action === 'window_action') {
          resultData = await bridge.call('window_action', params);
        } else if (action === 'close_window') {
          resultData = await bridge.call('close_window', { hwnd: params.hwnd });
        } else if (action === 'get_installed_apps') {
          const autoInstalled = await getCachedAutoInstalledApps();
          const installed = mergeCustomAndInstalledApps(autoInstalled);
          resultData = { installed, customApps };
        } else if (action === 'get_full_state') {
          const [monitors, windows, autoInstalled, audio, stats] = await Promise.all([
            bridge.call('get_monitors').catch(() => []),
            bridge.call('get_windows').catch(() => []),
            getCachedAutoInstalledApps(),
            bridge.call('audio_control', { action: 'get' }).catch(() => ({ masterVolume: 50, masterMuted: false, sessions: [] })),
            bridge.call('system_control', { action: 'stats' }).catch(() => ({}))
          ]);
          const installed = mergeCustomAndInstalledApps(autoInstalled);
          enrichScenesWithIcons(scenes, windows, installed);
          resultData = {
            monitors,
            windows,
            installed,
            customApps,
            scenes,
            quickActions,
            macros,
            audio,
            stats,
            powerTimer: powerTimerState
          };
        } else {
          resultData = await bridge.call(action, params);
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, data: resultData }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Local Tray helper action: emergency wake all monitors
  if (url.pathname === '/api/monitors/wake' && req.method === 'POST') {
    await bridge.call('monitor_power', { action: 'on', clearBlackouts: true }).catch(() => {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Seamless takeover when the Bridge.exe system tray app starts from the user desktop
  if (url.pathname === '/api/takeover' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, msg: 'yielding_port' }));
    setTimeout(() => process.exit(0), 100);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify(
      viaTunnel
        ? { service: 'Bridge PC Agent', status: 'online' }
        : { service: 'Bridge PC Agent', deviceName: config.deviceName, status: 'online' }
    )
  );
};

const server = http.createServer(handleHttpRequest);
const tunnelIngressServer = http.createServer(handleHttpRequest);
tunnelIngressServer.on('error', () => {});

// ---------------------------------------------------------------------------
// System buttons, carried out the way this PC's function preferences say
// ---------------------------------------------------------------------------
function runSystemCommand(file, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

async function setMonitorsOff() {
  monitorsManuallyOff = true;
  if (functionPrefs.monitorsOff === 'blackout') {
    let monitors = await bridge.call('get_monitors').catch(() => []);
    const count = Array.isArray(monitors) ? monitors.length : 0;
    for (let i = 0; i < count; i++) {
      const updated = await bridge.call('monitor_blackout', { monitorIndex: i, mode: 'on' }).catch(() => null);
      if (Array.isArray(updated)) monitors = updated;
    }
    return { status: 'monitors_blackout', monitors };
  }
  return bridge.call('monitor_power', { action: 'off' });
}

function runMonitorPower(params) {
  const p = params || {};
  if (p.action === 'off') return setMonitorsOff();
  monitorsManuallyOff = false;
  // Black curtains from the "blackout" style must also go away when the screens are switched back on
  if (functionPrefs.monitorsOff === 'blackout') return bridge.call('monitor_power', { ...p, clearBlackouts: true });
  return bridge.call('monitor_power', p);
}

async function runLockAction(kind) {
  const mode = functionPrefs.lock;
  // Linux has a single (loginctl) session lock that the phone can also unlock, so every style maps to it
  if (!IS_WINDOWS || mode === 'custom' || kind === 'unlock') {
    const r = await bridge.call('system_control', { action: kind });
    if (monitorsManuallyOff && functionPrefs.monitorsOff !== 'blackout') {
      setTimeout(() => bridge.call('monitor_power', { action: 'off' }).catch(() => {}), 220);
    }
    return r;
  }
  const stats = await bridge.call('system_control', { action: 'stats' }).catch(() => ({}));
  if (kind === 'toggle_lock' && stats && stats.isLocked) {
    const r = await bridge.call('system_control', { action: 'unlock' });
    if (monitorsManuallyOff && functionPrefs.monitorsOff !== 'blackout') {
      setTimeout(() => bridge.call('monitor_power', { action: 'off' }).catch(() => {}), 220);
    }
    return r;
  }
  let res = { ok: true, isLocked: false };
  if (mode === 'both') res = await bridge.call('system_control', { action: 'lock' });
  await runSystemCommand('rundll32.exe', ['user32.dll,LockWorkStation']);
  if (monitorsManuallyOff && functionPrefs.monitorsOff !== 'blackout') {
    setTimeout(() => bridge.call('monitor_power', { action: 'off' }).catch(() => {}), 260);
    setTimeout(() => bridge.call('monitor_power', { action: 'off' }).catch(() => {}), 650);
  }
  return {
    ...res,
    action: 'lock',
    lockMode: mode,
    windowsLocked: true,
    message: mode === 'both' ? 'Windows kilitlendi, Bridge kilit ekranı da açık' : 'Windows kilitlendi (Win+L)'
  };
}

async function runSystemControl(params) {
  const p = params || {};
  switch (p.action) {
    case 'lock':
    case 'unlock':
    case 'toggle_lock':
      return runLockAction(p.action);
    case 'sleep':
      if (functionPrefs.sleep === 'monitors_off') return { ...(await setMonitorsOff()), action: 'monitors_off' };
      return bridge.call('system_control', { action: functionPrefs.sleep });
    case 'shutdown':
    case 'restart': {
      const mode = functionPrefs[p.action];
      if (!IS_WINDOWS) return bridge.call('system_control', { action: p.action, mode }); // systemctl in the bridge
      const flag = p.action === 'shutdown' ? '/s' : '/r';
      if (mode === 'force' || mode === 'hybrid') {
        const ok = await runSystemCommand('shutdown.exe', [flag, mode === 'force' ? '/f' : '/hybrid', '/t', '0']);
        if (ok) return { ok: true, action: p.action, mode };
        // /hybrid fails when Fast Startup is disabled: fall back to a normal shutdown
      }
      return bridge.call('system_control', { action: p.action });
    }
    case 'show_desktop':
      if (IS_WINDOWS && functionPrefs.showDesktop === 'win_m') {
        await bridge.call('send_input', { type: 'key', key: 'WIN+M' });
        return { ok: true, action: 'show_desktop', mode: 'win_m' };
      }
      break;
    case 'media_key':
      if (functionPrefs.media === 'global') {
        const key = String(p.key || 'MEDIA_PLAY_PAUSE').toUpperCase();
        await bridge.call('send_input', { type: 'key', key });
        return { ok: true, key };
      }
      break;
    default:
      break;
  }
  return bridge.call('system_control', p);
}

async function runAudioControl(params) {
  const p = params || {};
  if (p.action === 'media_command' && functionPrefs.media === 'global') {
    await bridge.call('send_input', { type: 'key', key: String(p.key || 'MEDIA_PLAY_PAUSE').toUpperCase() });
    const audio = await bridge.call('audio_control', { action: 'get' });
    scheduleFastMediaSync();
    return audio;
  }
  const audio = await bridge.call('audio_control', p);
  if (p.action === 'seek' || p.action === 'media_command') {
    if (audio) broadcastStateUpdate('audio_updated', audio);
    scheduleFastMediaSync();
  }
  return audio;
}

// Power Countdown Timer Manager
function configurePowerTimer(minutes, mode = 'sleep') {
  if (powerTimerTimeout) {
    clearTimeout(powerTimerTimeout);
    powerTimerTimeout = null;
  }
  if (powerTimerTickInterval) {
    clearInterval(powerTimerTickInterval);
    powerTimerTickInterval = null;
  }

  const mins = Number(minutes || 0);
  if (mins <= 0 || mode === 'cancel') {
    powerTimerState = { active: false, mode: 'sleep', targetTs: 0, remainingSec: 0 };
    broadcastStateUpdate('power_timer_updated', powerTimerState);
    return powerTimerState;
  }

  const durationMs = Math.round(mins * 60 * 1000);
  const targetTs = Date.now() + durationMs;
  powerTimerState = {
    active: true,
    mode,
    targetTs,
    remainingSec: Math.round(durationMs / 1000)
  };

  powerTimerTickInterval = setInterval(() => {
    if (!powerTimerState.active) return;
    const rem = Math.max(0, Math.round((powerTimerState.targetTs - Date.now()) / 1000));
    powerTimerState.remainingSec = rem;
    broadcastStateUpdate('power_timer_updated', powerTimerState);
  }, 5000);

  powerTimerTimeout = setTimeout(async () => {
    const finalMode = powerTimerState.mode;
    powerTimerState = { active: false, mode: finalMode, targetTs: 0, remainingSec: 0 };
    if (powerTimerTickInterval) {
      clearInterval(powerTimerTickInterval);
      powerTimerTickInterval = null;
    }
    broadcastStateUpdate('power_timer_updated', powerTimerState);
    try {
      if (finalMode === 'monitors_off') {
        await setMonitorsOff();
      } else if (finalMode === 'shutdown') {
        await runSystemControl({ action: 'shutdown' });
      } else if (finalMode === 'hibernate') {
        await bridge.call('system_control', { action: 'hibernate' });
      } else {
        await runSystemControl({ action: 'sleep' });
      }
    } catch {}
  }, durationMs);

  broadcastStateUpdate('power_timer_updated', powerTimerState);
  return powerTimerState;
}

// WebSocket Server for Ultra-Low Latency Control & Live Screen Streaming
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
wss.on('error', () => {});
for (const srv of [server, tunnelIngressServer]) {
  srv.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}
const authenticatedClients = new Set();
const clientStreams = new Map();
let pendingAuthTotal = 0;
const touchActiveSockets = new Set();
const pendingAuthByClient = new Map();

// ---------------------------------------------------------------------------
// Remote Desktop streaming (wire format: native/ScreenStreamer.cs)
//
// Chrome Remote Desktop style pipeline: the bridge only produces a frame when the
// screen (or cursor) actually changed; motion is H.264 (hardware encoder when the
// PC has one) decoded by WebCodecs on the phone, and once the screen is still a
// "top-off" frame re-sends every degraded tile as sharp 4:4:4 JPEG. The phone acks
// every frame after drawing it and only a few frames may be un-acked, so latency
// stays flat on slow links instead of frames piling up in socket buffers. Bitrate
// (video) or scale/quality (JPEG fallback) adapt to the measured ack latency.
// ---------------------------------------------------------------------------
const STREAM_REQ_MAGIC = 0x33524254; // "TBR3"
const STREAM_FRAME_MAGIC = 0x32464254; // "TBF2"
const STREAM_ACK_OPCODE = 0xa1;
const STREAM_MAX_INFLIGHT_JPEG = 3;
const STREAM_MAX_INFLIGHT_VIDEO = 5;
const STREAM_MAX_INFLIGHT_VIDEO_CAP = 24;
const STREAM_REFINE_DELAY_MS = 450;
const STREAM_ACK_TIMEOUT_MS = 4000;
// Motion levels. JPEG: scale (permille, multiple of 1/8 so 64px tiles map to whole pixels) + quality.
// Video: H.264 target bitrate in kbps.
const STREAM_LEVELS = [
  { scale: 500, quality: 45, kbps: 1500 },
  { scale: 625, quality: 52, kbps: 3000 },
  { scale: 750, quality: 58, kbps: 5000 },
  { scale: 875, quality: 64, kbps: 8000 },
  { scale: 1000, quality: 68, kbps: 12000 },
  { scale: 1000, quality: 76, kbps: 18000 },
  { scale: 1000, quality: 84, kbps: 26000 }
];
// Video is sent at 1080p for balanced (so GPU H.264/AV1 encodes in <4 ms for rock-solid 60 FPS) while static
// top-off refinement stays at native 1440p/4K (maxCanvasWidth).
const STREAM_PROFILES = {
  saver: { maxCanvasWidth: 1920, videoMaxWidth: 1600, startLevel: 2, maxLevel: 4, refineQuality: 84, maxFps: 30 },
  balanced: { maxCanvasWidth: 2560, videoMaxWidth: 1920, startLevel: 4, maxLevel: 6, refineQuality: 90, maxFps: 60 },
  hd: { maxCanvasWidth: 3840, videoMaxWidth: 2560, startLevel: 5, maxLevel: 6, refineQuality: 94, maxFps: 60 }
};
// Over the Cloudflare tunnel (mobile data) streams start lower and climb only as far as latency allows
const STREAM_TUNNEL_START_LEVEL = 3;
const STREAM_TUNNEL_MAX_LEVEL = 5;

// Once a second the phone gets what the PC side sees, for the stats panel on the remote screen: together with
// the phone's own numbers it shows whether a low frame rate comes from the PC, the network or the phone.
function sendStreamStats(ws, st) {
  const now = Date.now();
  if (!st.stats.since) st.stats.since = now;
  const elapsed = now - st.stats.since;
  if (elapsed < 1000) return;
  const n = st.stats.frames;
  const payload = {
    sentFps: Math.round((n * 1000) / elapsed),
    sentMbps: Math.round(((st.stats.bytes * 8) / elapsed / 1000) * 10) / 10,
    captureMs: n ? Math.round(st.stats.workMs / n) : 0,
    level: st.level,
    targetKbps: STREAM_LEVELS[st.level].kbps,
    rttMs: Math.round(st.baseLatency || 0),
    latencyMs: Math.round(st.latencyEwma || 0),
    window: streamInFlightLimit(st),
    inFlight: st.inFlight,
    fpsCap: st.maxFps
  };
  st.stats = { frames: 0, bytes: 0, workMs: 0, since: now };
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'stream_stats', payload }));
}

function stopClientStream(ws) {
  const entry = clientStreams.get(ws);
  if (entry) {
    entry.active = false;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.wake) entry.wake();
    if (entry.tcpSock) {
      try {
        entry.tcpSock.destroy();
      } catch {}
      entry.tcpSock = null;
    }
    clientStreams.delete(ws);
  }
}

function handleStreamAck(ws, raw) {
  const st = clientStreams.get(ws);
  if (!st || !st.active || !st.sentTimes || raw.length < 5) return;
  const frameId = raw.readUInt32LE(1);
  const sentTs = st.sentTimes.get(frameId);
  if (sentTs === undefined) return;
  st.sentTimes.delete(frameId);
  st.inFlight = Math.max(0, st.inFlight - 1);
  st.lastAckTs = Date.now();
  const meta = st.sentMeta.get(frameId);
  st.sentMeta.delete(frameId);
  if (meta && !meta.refine && meta.bytes > 2048) adaptStreamLevel(st, Date.now() - sentTs);
  if (st.wake) st.wake();
}

// Bitrate follows queuing delay, not raw latency: over the tunnel the base round trip is ~150-250 ms even on a
// fast link, which the old absolute thresholds mistook for congestion and pushed the stream to its lowest level.
function adaptStreamLevel(st, latencyMs) {
  const now = Date.now();
  st.latencyEwma = st.latencyEwma ? st.latencyEwma * 0.7 + latencyMs * 0.3 : latencyMs;
  if (!st.baseLatency || latencyMs < st.baseLatency) st.baseLatency = latencyMs;
  else st.baseLatency += (latencyMs - st.baseLatency) * 0.002; // follows route changes slowly
  const queueMs = st.latencyEwma - st.baseLatency;
  if (queueMs > 160 && st.level > 0 && now - st.levelChangedTs > 500) {
    st.level -= 1;
    st.levelChangedTs = now;
  } else if (queueMs < 45 && st.level < st.profile.maxLevel && now - st.levelChangedTs > 2500) {
    st.level += 1;
    st.levelChangedTs = now;
  }
}

// Frames allowed on the wire before an ack: enough to cover one round trip at the target frame rate, so a
// 200 ms tunnel still carries 60 FPS (a fixed window of 4 capped it at ~20 FPS)
function streamInFlightLimit(st) {
  if (!st.videoActive) return STREAM_MAX_INFLIGHT_JPEG;
  const frameMs = 1000 / Math.max(10, st.maxFps);
  const rtt = st.baseLatency || 0;
  return Math.max(STREAM_MAX_INFLIGHT_VIDEO, Math.min(STREAM_MAX_INFLIGHT_VIDEO_CAP, Math.ceil(rtt / frameMs) + 3));
}

// Byte length of the first complete frame in buf, or -1 when more data is needed
function measureStreamFrame(buf) {
  if (buf.length < 28) return -1;
  if (buf.readUInt32LE(0) !== STREAM_FRAME_MAGIC) throw new Error('stream desync');
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

function startStreamV2(ws, params) {
  const baseProfile = STREAM_PROFILES[params.profile] || STREAM_PROFILES.balanced;
  const profile = params.tunnel
    ? {
        ...baseProfile,
        startLevel: Math.min(baseProfile.startLevel, STREAM_TUNNEL_START_LEVEL),
        maxLevel: Math.min(baseProfile.maxLevel, STREAM_TUNNEL_MAX_LEVEL)
      }
    : baseProfile;
  const monIdx = typeof params.monitorIndex === 'number' ? params.monitorIndex : 0;
  const isAllMonitors = monIdx < 0;
  const defaultCanvasCap = isAllMonitors ? Math.max(3840, profile.maxCanvasWidth * 2) : profile.maxCanvasWidth;
  const maxAllowedCanvasWidth = isAllMonitors ? 5120 : 3840;
  const effectiveVideoMaxWidth = isAllMonitors ? Math.max(3840, profile.videoMaxWidth * 2) : profile.videoMaxWidth;
  const st = {
    active: true,
    timer: null,
    wake: null,
    tcpSock: null,
    profile: {
      ...profile,
      maxCanvasWidth: Math.max(640, Math.min(maxAllowedCanvasWidth, Number(params.maxCanvasWidth) || defaultCanvasCap)),
      videoMaxWidth: effectiveVideoMaxWidth
    },
    monitorIndex: monIdx,
    isAllMonitors,
    maxFps: Math.max(10, Math.min(240, Number(params.maxFps) || profile.maxFps)),
    // The phone only advertises video when WebCodecs can decode H.264
    allowVideo: params.video === true,
    // AV1 when the phone asked for it; the bridge falls back to H.264 if this PC has no AV1 encoder
    allowAv1: params.video === true && params.codec === 'av1',
    videoActive: false,
    level: profile.startLevel,
    levelChangedTs: Date.now(),
    latencyEwma: 0,
    inFlight: 0,
    sentTimes: new Map(),
    sentMeta: new Map(),
    lastAckTs: Date.now(),
    lastSendTs: 0,
    lastChangeTs: Date.now(),
    pendingRefine: false,
    needKey: true,
    lastCursorSig: '',
    stats: { frames: 0, bytes: 0, workMs: 0, since: 0 }
  };
  clientStreams.set(ws, st);

  const waitForAck = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        st.wake = null;
        resolve();
      }, ms);
      st.wake = () => {
        clearTimeout(t);
        st.wake = null;
        resolve();
      };
    });

  const sock = net.createConnection({ host: '127.0.0.1', port: STREAM_PORT });
  sock.setNoDelay(true);
  sock.write(BRIDGE_IPC_KEY + '\n');
  st.tcpSock = sock;
  let recvBuf = Buffer.alloc(0);
  let pendingFrame = null;
  let pendingFail = null;
  const failPending = (err) => {
    const fail = pendingFail;
    pendingFrame = null;
    pendingFail = null;
    if (fail) fail(err);
  };
  sock.on('data', (chunk) => {
    recvBuf = recvBuf.length === 0 ? chunk : Buffer.concat([recvBuf, chunk]);
    try {
      const len = measureStreamFrame(recvBuf);
      if (len < 0) return;
      const frame = Buffer.from(recvBuf.subarray(0, len));
      recvBuf = recvBuf.subarray(len);
      const done = pendingFrame;
      pendingFrame = null;
      pendingFail = null;
      if (done) done(frame);
    } catch (e) {
      failPending(e);
      sock.destroy();
    }
  });
  sock.on('error', () => failPending(new Error('bridge stream error')));
  sock.on('close', () => {
    failPending(new Error('bridge stream closed'));
    if (st.active) {
      // Bridge restarted: let the phone restart the stream instead of showing a frozen frame
      stopClientStream(ws);
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'stream_ended', payload: { reason: 'bridge' } }));
    }
  });
  const requestFrame = (mode, waitMs) =>
    new Promise((resolve, reject) => {
      const lv = STREAM_LEVELS[st.level];
      const req = Buffer.alloc(24);
      req.writeUInt32LE(STREAM_REQ_MAGIC, 0);
      req.writeInt32LE(st.monitorIndex, 4);
      req.writeUInt16LE(st.profile.maxCanvasWidth, 8);
      req.writeUInt16LE(lv.scale, 10);
      req[12] = lv.quality;
      req[13] = st.profile.refineQuality;
      req[14] = mode;
      req[15] = (st.allowVideo ? 2 : 0) | (st.allowAv1 ? 4 : 0);
      req.writeUInt16LE(waitMs, 16);
      const effectiveKbps = st.isAllMonitors ? Math.round(lv.kbps * 1.5) : lv.kbps;
      req.writeUInt16LE(Math.round(effectiveKbps / 100), 18);
      req.writeUInt16LE(st.profile.videoMaxWidth, 20);
      req.writeUInt16LE(st.maxFps, 22);
      pendingFrame = resolve;
      pendingFail = reject;
      sock.write(req);
    });

  (async () => {
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    while (st.active && ws.readyState === 1) {
      // Ack-based flow control
      const maxInFlight = streamInFlightLimit(st);
      if (st.inFlight >= maxInFlight || ws.bufferedAmount > 1.5 * 1024 * 1024) {
        await waitForAck(250);
        if (st.inFlight > 0 && Date.now() - st.lastAckTs > STREAM_ACK_TIMEOUT_MS) {
          // Acks lost (phone backgrounded / route switch): resync with a key frame
          st.inFlight = 0;
          st.sentTimes.clear();
          st.sentMeta.clear();
          st.needKey = true;
          st.level = Math.max(0, st.level - 1);
        }
        continue;
      }

      // No sleeping here: Node timers on Windows have ~15.6 ms granularity, which halved the frame rate.
      // The bridge blocks until the next screen update and enforces the fps cap with a 1 ms timer.

      const idleFor = Date.now() - st.lastChangeTs;
      let mode = 0;
      let waitMs = 200;
      if (st.needKey) {
        mode = 2;
        waitMs = 0;
      } else if (st.pendingRefine && idleFor >= STREAM_REFINE_DELAY_MS) {
        mode = 1;
        waitMs = 0;
      } else if (st.pendingRefine) {
        waitMs = Math.max(8, Math.round(STREAM_REFINE_DELAY_MS - idleFor));
      }

      const frame = await requestFrame(mode, waitMs);
      if (!st.active || ws.readyState !== 1) break;

      const frameId = frame.readUInt32LE(4);
      const flags = frame.readUInt16LE(8);
      const rectCount = frame.readUInt16LE(10);
      st.pendingRefine = (flags & 0x20) !== 0;
      if (flags & 0x80) st.videoActive = true;
      if (mode === 2 && flags & 0x01) st.needKey = false;
      if (rectCount > 0 && mode !== 1) st.lastChangeTs = Date.now();

      const cursorSig = `${frame.readUInt16LE(20)}|${frame.readUInt16LE(22)}|${flags & 0x04}`;
      const cursorChanged = cursorSig !== st.lastCursorSig || (flags & 0x08) !== 0;
      if (rectCount === 0 && !cursorChanged) continue;
      st.lastCursorSig = cursorSig;

      st.inFlight += 1;
      st.lastSendTs = Date.now();
      st.sentTimes.set(frameId, st.lastSendTs);
      st.sentMeta.set(frameId, { refine: mode === 1, bytes: frame.length });
      st.stats.frames += 1;
      st.stats.bytes += frame.length;
      st.stats.workMs += frame.readUInt16LE(24);
      ws.send(frame, { binary: true, compress: false });
      sendStreamStats(ws, st);
    }
  })()
    .catch(() => {})
    .finally(() => {
      if (clientStreams.get(ws) === st) stopClientStream(ws);
    });

  return {
    streaming: true,
    protocol: 2,
    monitorIndex: st.monitorIndex,
    maxFps: st.maxFps,
    maxCanvasWidth: st.profile.maxCanvasWidth
  };
}

// Compatibility path for APKs older than protocol v2: periodic full JPEG frames over JSON
function startLegacyStream(ws, params) {
  const st = { active: true, timer: null, tcpSock: null };
  clientStreams.set(ws, st);
  const monitorIndex = typeof params.monitorIndex === 'number' ? params.monitorIndex : 0;
  const tick = async () => {
    if (!st.active || ws.readyState !== 1) return;
    try {
      const frame = await bridge.call(
        'capture_screen',
        { monitorIndex, maxWidth: Number(params.maxWidth || 1280), quality: Number(params.quality || 70), drawCursor: true },
        2000
      );
      if (st.active && ws.readyState === 1 && ws.bufferedAmount < 512 * 1024) {
        ws.send(JSON.stringify({ type: 'screen_frame', payload: { monitorIndex, ...frame } }));
      }
    } catch {}
    if (st.active) st.timer = setTimeout(tick, 100);
  };
  tick();
  return { streaming: true, protocol: 1, monitorIndex };
}

function mergeCustomAndInstalledApps(autoInstalled = []) {
  const result = [];
  const seenPaths = new Set();
  const seenNames = new Set();

  if (Array.isArray(customApps)) {
    for (const c of customApps) {
      if (!c || !c.name || !c.launchPath) continue;
      const rawPathKey = String(c.launchPath).toLowerCase();
      const pKey = `${rawPathKey}|${String(c.launchArgs || '').trim().toLowerCase()}`;
      const nKey = String(c.name).toLowerCase();
      seenPaths.add(pKey);
      seenNames.add(nKey);
      const savedPref = (appPrefs && (appPrefs[pKey] || appPrefs[rawPathKey] || appPrefs[nKey])) || {};
      result.push({
        ...c,
        ...savedPref,
        source: 'custom',
        isCustom: true
      });
    }
  }

  if (Array.isArray(autoInstalled)) {
    for (const a of autoInstalled) {
      if (!a || !a.name || !a.launchPath) continue;
      const rawPathKey = String(a.launchPath).toLowerCase();
      const pKey = `${rawPathKey}|${String(a.launchArgs || '').trim().toLowerCase()}`;
      const nKey = String(a.name).toLowerCase();
      if (seenPaths.has(pKey) || seenNames.has(nKey)) continue;
      seenPaths.add(pKey);
      seenNames.add(nKey);
      const savedPref = (appPrefs && (appPrefs[pKey] || appPrefs[rawPathKey] || appPrefs[nKey])) || {};
      result.push({
        ...a,
        ...savedPref
      });
    }
  }

  return result;
}

const SHARED_LAUNCHER_EXES = new Set([
  'riotclientservices.exe',
  'steam.exe',
  'epicgameslauncher.exe',
  'battle.net.exe',
  'eadesktop.exe',
  'ubisoftconnect.exe',
  'update.exe',
  'explorer.exe',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'conhost.exe',
  'rundll32.exe'
]);

function isSharedLauncherExePath(exePath) {
  const base = path.basename(String(exePath || '').trim().toLowerCase());
  return SHARED_LAUNCHER_EXES.has(base);
}

function enrichScenesWithIcons(scenesList, openWindows = [], installedApps = []) {
  const nameIconMap = new Map();
  const pathArgsIconMap = new Map();
  const pathIconMap = new Map();
  const procIconMap = new Map();

  for (const w of openWindows) {
    if (!w.icon) continue;
    if (w.processName) procIconMap.set(String(w.processName).toLowerCase(), w.icon);
    if (w.exePath && !isSharedLauncherExePath(w.exePath)) {
      pathIconMap.set(String(w.exePath).toLowerCase(), w.icon);
    }
  }
  for (const a of installedApps) {
    if (!a.icon) continue;
    if (a.name) {
      nameIconMap.set(String(a.name).toLowerCase(), a.icon);
    }
    if (a.processName && !SHARED_LAUNCHER_EXES.has(String(a.processName).toLowerCase() + '.exe')) {
      procIconMap.set(String(a.processName).toLowerCase(), a.icon);
    }
    if (a.launchPath) {
      const pLow = String(a.launchPath).toLowerCase();
      const argsLow = String(a.launchArgs || '').trim().toLowerCase();
      if (argsLow) {
        pathArgsIconMap.set(`${pLow}|${argsLow}`, a.icon);
      }
      if (!isSharedLauncherExePath(pLow) && !pathIconMap.has(pLow)) {
        pathIconMap.set(pLow, a.icon);
      }
    }
  }

  const resolveIcon = (it, pathField) => {
    if (it.icon && String(it.icon).startsWith('data:image/')) return it.icon;
    const appNameKey = String(it.appName || it.name || '').toLowerCase().trim();
    const procKey = String(it.processName || '').toLowerCase().trim();
    const pKey = String(it[pathField] || '').toLowerCase().trim();
    const argsKey = String(it.launchArgs || it.arguments || '').toLowerCase().trim();

    if (appNameKey && nameIconMap.has(appNameKey)) return nameIconMap.get(appNameKey);
    if (pKey && argsKey && pathArgsIconMap.has(`${pKey}|${argsKey}`)) return pathArgsIconMap.get(`${pKey}|${argsKey}`);
    if (pKey && !isSharedLauncherExePath(pKey) && pathIconMap.has(pKey)) return pathIconMap.get(pKey);
    if (procKey && nameIconMap.has(procKey)) return nameIconMap.get(procKey);
    if (procKey && procIconMap.has(procKey)) return procIconMap.get(procKey);
    return it.icon || '';
  };

  for (const sc of scenesList) {
    if (!Array.isArray(sc.items)) continue;
    for (const it of sc.items) {
      const resolved = resolveIcon(it, 'launchPath');
      if (resolved) it.icon = resolved;
    }
  }
  if (Array.isArray(quickActions)) {
    for (const qa of quickActions) {
      if (!Array.isArray(qa.items)) continue;
      for (const it of qa.items) {
        const resolved = resolveIcon(it, 'targetPath');
        if (resolved) it.icon = resolved;
      }
    }
  }
  return scenesList;
}

// Server-side protocol-level WebSocket heartbeat (prevents NAT, Wi-Fi, or Cloudflare tunnel idle drops)
setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try {
        client.ping();
      } catch {}
    }
  }
}, 12000);

function broadcastStateUpdate(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of authenticatedClients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

function scheduleFastMediaSync() {
  const pollOnce = async () => {
    if (authenticatedClients.size === 0) return;
    try {
      const audio = await bridge.call('audio_control', { action: 'get' }, 2000);
      if (audio) {
        const np = audio.nowPlaying || {};
        lastMediaSignature = `${Boolean(np.active)}|${Boolean(np.isPlaying)}|${np.title || ''}|${np.appName || ''}|${audio.masterVolume}|${audio.masterMuted}`;
        broadcastStateUpdate('audio_updated', audio);
      }
    } catch {}
  };
  setTimeout(pollOnce, 220);
  setTimeout(pollOnce, 650);
}

wss.on('connection', (ws, req) => {
  if (req && req.socket) {
    try {
      req.socket.setNoDelay(true);
    } catch {}
  }
  if (ws._socket && typeof ws._socket.setNoDelay === 'function') {
    try {
      ws._socket.setNoDelay(true);
    } catch {}
  }
  let isAuthed = false;
  ws.on('error', () => {});
  // Unauthenticated sockets get their own small budget (total and per address) so a stranger who found the
  // tunnel URL cannot fill the server and lock the paired phones out; they are dropped after 10 s.
  const clientKey = getClientKey(req);
  const pendingFromClient = pendingAuthByClient.get(clientKey) || 0;
  if (wss.clients.size > 96 || pendingAuthTotal >= 32 || pendingFromClient >= 6) {
    try {
      ws.close(1013, 'busy');
    } catch {}
    return;
  }
  pendingAuthTotal++;
  pendingAuthByClient.set(clientKey, pendingFromClient + 1);
  let pendingReleased = false;
  const releasePending = () => {
    if (pendingReleased) return;
    pendingReleased = true;
    pendingAuthTotal--;
    const left = (pendingAuthByClient.get(clientKey) || 1) - 1;
    if (left > 0) pendingAuthByClient.set(clientKey, left);
    else pendingAuthByClient.delete(clientKey);
  };
  ws.on('close', releasePending);
  const authDeadline = setTimeout(() => {
    if (!isAuthed) {
      try {
        ws.close(4008, 'auth timeout');
      } catch {}
    }
  }, 10000);

  ws.on('message', async (raw, isBinary) => {
    // Before authentication only small control messages are accepted
    if (!isAuthed && raw.length > 8192) {
      try {
        ws.terminate();
      } catch {}
      return;
    }
    if (isBinary) {
      // Remote desktop frame ack: [0xA1, u32 frameId]
      if (isAuthed && raw.length >= 5 && raw[0] === STREAM_ACK_OPCODE) handleStreamAck(ws, raw);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { id, action, params = {} } = msg;
    const reply = (ok, data, error) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ id, ok, data, error }));
      }
    };

    // Allow auth / pair / ping without prior auth
    if (action === 'ping') {
      return reply(true, { ts: Date.now(), serverTs: Date.now() });
    }

    if (action === 'auth') {
      const clientIp = getClientKey(req);
      const token = String(params.authToken || '').trim();
      const rawPin = String(params.pin || '').trim();
      const isTokenValid = isKnownSessionToken(token);
      if (!isTokenValid) {
        const rate = checkRateLimit(clientIp);
        if (!rate.allowed) {
          return reply(false, null, `Çok fazla hatalı deneme. Güvenlik kilidi: ${rate.waitSec} saniye bekleyin.`);
        }
      }
      const consumedPinToken = isTokenValid ? null : consumeOrReuseEphemeralPin(rawPin, clientIp);

      if (isTokenValid || consumedPinToken) {
        clearFailedAuth(clientIp);
        isAuthed = true;
        releasePending();
        clearTimeout(authDeadline);
        const sessionToken = isTokenValid ? token : consumedPinToken;
        ws.sessionToken = sessionToken;
        ws.clientIp = getCleanClientIp(req);
        ws.clientRoute = getClientRouteLabel(req);
        authenticatedClients.add(ws);
        touchSessionToken(sessionToken, req, params);
        updateRuntimeStatusFile();

        const [monitors, windows, audio, stats] = await Promise.all([
          bridge.call('get_monitors').catch(() => []),
          bridge.call('get_windows').catch(() => []),
          bridge.call('audio_control', { action: 'get' }).catch(() => ({ masterVolume: 50, masterMuted: false, sessions: [] })),
          bridge.call('system_control', { action: 'stats' }).catch(() => ({}))
        ]);

        // Use in-memory cached installed apps ONLY for icon enrichment on scenes; do NOT bloat the initial auth frame with 1.2MB of app icons so 4.5G/Tunnel auth completes in <120ms!
        const cachedInstalled = mergeCustomAndInstalledApps(cachedAutoInstalledApps);
        enrichScenesWithIcons(scenes, windows, cachedInstalled);
        // Trigger background warm-up if cache is empty
        if (cachedAutoInstalledApps.length === 0) {
          getCachedAutoInstalledApps().catch(() => {});
        }

        const netInfo = resolveClientNetworkInfo(
          getNetworkInfo(),
          req && req.socket && req.socket.remoteAddress,
          req && req.headers && req.headers.host
        );
        return reply(true, {
          device: {
            deviceId: config.deviceId,
            deviceName: config.deviceName,
            lanIp: netInfo.lanIp,
            lanIps: netInfo.lanIps,
            subnetBroadcast: netInfo.subnetBroadcast,
            subnetBroadcasts: netInfo.subnetBroadcasts,
            tailscaleIp: netInfo.tailscaleIp,
            macAddress: netInfo.macAddress,
            macAddresses: netInfo.macAddresses,
            tunnelUrl: currentTunnelUrl,
            wsTunnelUrl: currentWsTunnelUrl,
            syncTopic: SYNC_TOPIC,
            port: PORT,
            authToken: sessionToken,
            syncKey: config.syncKey
          },
          monitors,
          windows,
          installed: [],
          customApps,
          scenes,
          quickActions,
          macros,
          audio,
          stats,
          powerTimer: powerTimerState,
          functionPrefs
        });
      } else {
        if (rawPin) notePinFailure(rawPin);
        recordFailedAuth(clientIp);
        reply(false, null, 'Yetkisiz bağlantı veya süresi dolmuş 8 haneli güvenlik kodu.');
        setTimeout(() => {
          try {
            ws.close(4003, 'auth failed');
          } catch {}
        }, 250);
        return;
      }
    }

    if (!isAuthed) {
      return reply(false, null, 'Önce cihaz eşleştirmesi yapılmalıdır.');
    }

    const wsCmdId = String((params && params.cmdId) || msg.cmdId || '').trim();
    if (wsCmdId) {
      if (!global.__recentQuickCmdIds) global.__recentQuickCmdIds = new Map();
      if (global.__recentQuickCmdIds.has(wsCmdId)) {
        return reply(true, { deduplicated: true });
      }
      global.__recentQuickCmdIds.set(wsCmdId, { accepted: true });
      setTimeout(() => {
        if (global.__recentQuickCmdIds) global.__recentQuickCmdIds.delete(wsCmdId);
      }, 5000);
    }

    try {
      switch (action) {
        case 'get_full_state': {
          const [monitors, windows, autoInstalled, audio, stats] = await Promise.all([
            bridge.call('get_monitors').catch(() => []),
            bridge.call('get_windows').catch(() => []),
            getCachedAutoInstalledApps(),
            bridge.call('audio_control', { action: 'get' }).catch(() => ({ masterVolume: 50, masterMuted: false, sessions: [] })),
            bridge.call('system_control', { action: 'stats' }).catch(() => ({}))
          ]);
          const installed = mergeCustomAndInstalledApps(autoInstalled);
          enrichScenesWithIcons(scenes, windows, installed);
          return reply(true, {
            monitors,
            windows,
            installed,
            customApps,
            scenes,
            quickActions,
            macros,
            audio,
            stats,
            powerTimer: powerTimerState,
            tunnelUrl: currentTunnelUrl,
            wsTunnelUrl: currentWsTunnelUrl,
            syncTopic: SYNC_TOPIC
          });
        }

        case 'get_installed_apps': {
          const [autoInstalled, windows] = await Promise.all([
            getCachedAutoInstalledApps(Boolean(params && params.force)),
            bridge.call('get_windows').catch(() => [])
          ]);
          const installed = mergeCustomAndInstalledApps(autoInstalled);
          return reply(true, { installed, customApps, windows });
        }

        case 'save_custom_app': {
          const src = params.app || params;
          const rawName = String(src.name || '').trim();
          const rawPath = String(src.launchPath || src.targetPath || '').trim();
          if (!rawName || !rawPath) {
            throw new Error('Uygulama adı ve dosya yolu gerekli.');
          }
          let iconData = String(src.icon || '');
          if (!iconData) {
            try {
              const iconRes = await bridge.call('get_file_icon', { path: rawPath }, 4000);
              if (iconRes && iconRes.icon) iconData = iconRes.icon;
            } catch {}
          }
          const procName = path.basename(rawPath).replace(/\.[^/.]+$/, '') || rawName;
          const entry = {
            id: src.id || crypto.randomUUID(),
            name: rawName,
            processName: procName,
            launchPath: rawPath,
            launchArgs: String(src.launchArgs || src.arguments || '').trim(),
            runAsAdmin: Boolean(src.runAsAdmin),
            monitorIndex: typeof src.monitorIndex === 'number' ? Number(src.monitorIndex) : -1,
            icon: iconData,
            source: 'custom',
            isCustom: true,
            createdAt: new Date().toISOString()
          };
          const existingIdx = customApps.findIndex(
            (c) => c.id === entry.id || String(c.launchPath || '').toLowerCase() === rawPath.toLowerCase()
          );
          if (existingIdx >= 0) {
            customApps[existingIdx] = { ...customApps[existingIdx], ...entry };
          } else {
            customApps.unshift(entry);
          }
          saveCustomApps(customApps);
          const autoInstalled = await bridge.call('get_installed_apps').catch(() => []);
          const installed = mergeCustomAndInstalledApps(autoInstalled);
          broadcastStateUpdate('apps_updated', { installed, customApps });
          return reply(true, { customApp: entry, customApps, installed });
        }

        case 'delete_custom_app': {
          const targetId = String(params.id || '');
          const targetPath = String(params.launchPath || '').toLowerCase();
          customApps = customApps.filter(
            (c) => c.id !== targetId && (!targetPath || String(c.launchPath || '').toLowerCase() !== targetPath)
          );
          saveCustomApps(customApps);
          const autoInstalled = await bridge.call('get_installed_apps').catch(() => []);
          const installed = mergeCustomAndInstalledApps(autoInstalled);
          broadcastStateUpdate('apps_updated', { installed, customApps });
          return reply(true, { customApps, installed });
        }

        case 'save_app_prefs': {
          const src = params.prefs || params;
          const key = String(params.key || params.launchPath || params.name || '').trim().toLowerCase();
          if (key) {
            const rawZone = String(src.zone || src.zonePreset || 'none').trim();
            appPrefs[key] = {
              ...(appPrefs[key] || {}),
              monitorIndex: typeof src.monitorIndex === 'number' ? Number(src.monitorIndex) : -1,
              zone: rawZone,
              zonePreset: String(src.zonePreset || (rawZone === 'full' ? 'fullscreen' : rawZone)),
              windowStyle: String(src.windowStyle || 'normal'),
              ifRunning: String(src.ifRunning || 'new'),
              runAsAdmin: Boolean(src.runAsAdmin),
              alwaysOnTop: Boolean(src.alwaysOnTop)
            };
            saveAppPrefs(appPrefs);
          }
          return reply(true, { ok: true, prefs: appPrefs[key] || {} });
        }

        case 'get_function_prefs': {
          return reply(true, { prefs: functionPrefs, options: FUNCTION_PREF_OPTIONS });
        }

        case 'save_function_prefs': {
          functionPrefs = sanitizeFunctionPrefs({ ...functionPrefs, ...(params.prefs || {}) });
          writeJsonAtomic(FUNCTION_PREFS_FILE, functionPrefs);
          broadcastStateUpdate('function_prefs_updated', functionPrefs);
          return reply(true, { prefs: functionPrefs });
        }

        case 'monitor_power': {
          const res = await runMonitorPower(params);
          const monitors = await bridge.call('get_monitors').catch(() => []);
          broadcastStateUpdate('monitors_updated', monitors);
          return reply(true, { ...res, monitors });
        }

        case 'monitor_blackout': {
          const monitors = await bridge.call('monitor_blackout', params);
          broadcastStateUpdate('monitors_updated', monitors);
          return reply(true, { monitors });
        }

        case 'display_topology': {
          const res = await bridge.call('display_topology', params);
          setTimeout(async () => {
            const monitors = await bridge.call('get_monitors').catch(() => []);
            broadcastStateUpdate('monitors_updated', monitors);
          }, 1200);
          return reply(true, res);
        }

        case 'snapshot_scene': {
          const newScene = await createSnapshotScene(params.name);
          broadcastStateUpdate('scenes_updated', scenes);
          return reply(true, { scene: newScene, scenes });
        }

        case 'save_scene': {
          const incoming = params.scene;
          if (!incoming || !incoming.name) throw new Error('Sahne adı gerekli.');
          const existingIdx = scenes.findIndex((s) => s.id === incoming.id);
          const formatted = {
            id: incoming.id || crypto.randomUUID(),
            name: String(incoming.name).trim(),
            subtitle: incoming.subtitle || `${(incoming.items || []).length} uygulama`,
            createdAt: incoming.createdAt || new Date().toISOString(),
            blackoutMonitors: Array.isArray(incoming.blackoutMonitors) ? incoming.blackoutMonitors : [],
            otherWindowsMode: incoming.otherWindowsMode || 'keep',
            items: Array.isArray(incoming.items) ? incoming.items : []
          };
          if (existingIdx >= 0) {
            scenes[existingIdx] = formatted;
          } else {
            scenes.push(formatted);
          }
          saveScenes(scenes);
          broadcastStateUpdate('scenes_updated', scenes);
          return reply(true, { scene: formatted, scenes });
        }

        case 'delete_scene': {
          scenes = scenes.filter((s) => s.id !== params.sceneId);
          saveScenes(scenes);
          broadcastStateUpdate('scenes_updated', scenes);
          return reply(true, { scenes });
        }

        case 'run_scene': {
          const target = scenes.find((s) => s.id === params.sceneId);
          if (!target) throw new Error('Sahne bulunamadı.');
          const execRes = await executeScene(target, (prog) => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'scene_progress', payload: prog }));
            }
          });
          const windows = await bridge.call('get_windows').catch(() => []);
          const monitors = await bridge.call('get_monitors').catch(() => []);
          broadcastStateUpdate('windows_updated', windows);
          broadcastStateUpdate('monitors_updated', monitors);
          return reply(true, execRes);
        }

        case 'save_quick_action': {
          const incoming = params.quickAction;
          if (!incoming || !incoming.name) throw new Error('Hızlı erişim butonu adı gerekli.');
          const rawItems = Array.isArray(incoming.items) ? incoming.items : [];
          if (rawItems.length === 0) throw new Error('En az 1 uygulama veya dosya eklemelisiniz.');

          const formattedItems = rawItems.map((it) => ({
            id: it.id || crypto.randomUUID(),
            name: String(it.name || path.basename(String(it.targetPath || '')) || 'Öğe').trim(),
            icon: it.icon || '',
            targetType: it.targetType || 'file',
            targetPath: String(it.targetPath || '').trim(),
            openWithMode: it.openWithMode || 'default',
            openWithPath: String(it.openWithPath || '').trim(),
            openWithName: String(it.openWithName || 'Varsayılan Uygulama').trim(),
            arguments: String(it.arguments || '').trim(),
            workingDirectory: String(it.workingDirectory || '').trim(),
            monitorIndex: typeof it.monitorIndex === 'number' ? Number(it.monitorIndex) : -1,
            zone: it.zone || 'none',
            windowStyle: it.windowStyle || 'normal',
            runAsAdmin: Boolean(it.runAsAdmin),
            priority: it.priority || 'normal',
            delayMs: Math.max(0, Number(it.delayMs || 0)),
            ifRunning: it.ifRunning || 'new',
            alwaysOnTop: Boolean(it.alwaysOnTop)
          }));

          const existingIdx = quickActions.findIndex((q) => q.id === incoming.id);
          const prev = existingIdx >= 0 ? quickActions[existingIdx] : null;
          const formatted = {
            id: incoming.id || crypto.randomUUID(),
            name: String(incoming.name).trim(),
            category: String(incoming.category || 'Genel').trim(),
            executionMode: incoming.executionMode === 'sequential' ? 'sequential' : 'parallel',
            createdAt: (prev && prev.createdAt) || incoming.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastRunAt: (prev && prev.lastRunAt) || null,
            runCount: Number((prev && prev.runCount) || 0),
            items: formattedItems
          };

          if (existingIdx >= 0) {
            quickActions[existingIdx] = formatted;
          } else {
            quickActions.unshift(formatted);
          }

          saveQuickActions(quickActions);
          broadcastStateUpdate('quick_actions_updated', quickActions);
          return reply(true, { quickAction: formatted, quickActions });
        }

        case 'delete_quick_action': {
          quickActions = quickActions.filter((q) => q.id !== params.id);
          saveQuickActions(quickActions);
          broadcastStateUpdate('quick_actions_updated', quickActions);
          return reply(true, { quickActions });
        }

        case 'duplicate_quick_action': {
          const orig = quickActions.find((q) => q.id === params.id);
          if (!orig) throw new Error('Kopyalanacak buton bulunamadı.');
          const copy = {
            ...orig,
            id: crypto.randomUUID(),
            name: `${orig.name} (Kopya)`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            runCount: 0,
            lastRunAt: null,
            items: (orig.items || []).map((it) => ({ ...it, id: crypto.randomUUID() }))
          };
          quickActions.unshift(copy);
          saveQuickActions(quickActions);
          broadcastStateUpdate('quick_actions_updated', quickActions);
          return reply(true, { quickAction: copy, quickActions });
        }

        case 'run_quick_action': {
          const targetQa = quickActions.find((q) => q.id === params.id);
          if (!targetQa) throw new Error('Hızlı erişim butonu bulunamadı.');
          const execRes = await executeQuickAction(targetQa);
          const windows = await bridge.call('get_windows').catch(() => []);
          broadcastStateUpdate('windows_updated', windows);
          broadcastStateUpdate('quick_actions_updated', quickActions);
          return reply(true, { ...execRes, quickActions, windows });
        }

        case 'save_macro': {
          const incoming = params.macro || params;
          const existingIdx = macros.findIndex((m) => m.id === incoming.id);
          const prev = existingIdx >= 0 ? macros[existingIdx] : null;
          const formatted = normalizeMacroPayload(incoming, prev);
          if (existingIdx >= 0) macros[existingIdx] = formatted;
          else macros.unshift(formatted);
          saveMacros(macros);
          broadcastStateUpdate('macros_updated', macros);
          return reply(true, { macro: formatted, macros });
        }

        case 'delete_macro': {
          await stopRunningMacro(params.id).catch(() => {});
          macros = macros.filter((m) => m.id !== params.id);
          saveMacros(macros);
          broadcastStateUpdate('macros_updated', macros);
          return reply(true, { macros });
        }

        case 'run_macro': {
          const targetMacro = macros.find((m) => m.id === params.id);
          if (!targetMacro) throw new Error('Makro bulunamadı.');
          const execRes = await executeMacro(targetMacro);
          broadcastStateUpdate('macros_updated', macros);
          return reply(true, { ...execRes, macros });
        }

        case 'stop_macro': {
          const stopRes = await stopRunningMacro(params.id);
          return reply(true, stopRes);
        }

        case 'run_single_item': {
          const item = params.item || params;
          const res = await executeQuickItemBridge(item);
          setTimeout(async () => {
            const windows = await bridge.call('get_windows').catch(() => []);
            broadcastStateUpdate('windows_updated', windows);
          }, 900);
          return reply(true, res);
        }

        case 'browse_fs': {
          const fsData = await bridge.call('browse_fs', params, 6000);
          return reply(true, fsData);
        }

        case 'inspect_target': {
          const info = await bridge.call('inspect_target', params, 4500);
          return reply(true, info);
        }

        case 'snap_window': {
          const geom = resolveItemGeometry(params);
          const res = await bridge.call('snap_window', {
            hwnd: params.hwnd,
            processName: params.processName,
            monitorIndex: Number(params.monitorIndex || 0),
            state: geom.state,
            x: geom.x,
            y: geom.y,
            w: geom.w,
            h: geom.h
          });
          const windows = await bridge.call('get_windows').catch(() => []);
          broadcastStateUpdate('windows_updated', windows);
          return reply(true, { ...res, windows });
        }

        case 'window_action': {
          const res = await bridge.call('window_action', params);
          setTimeout(async () => {
            const windows = await bridge.call('get_windows').catch(() => []);
            broadcastStateUpdate('windows_updated', windows);
          }, 180);
          return reply(true, res);
        }

        case 'focus_window': {
          await bridge.call('focus_window', { hwnd: params.hwnd });
          return reply(true, { ok: true });
        }

        case 'close_window': {
          await bridge.call('close_window', { hwnd: params.hwnd });
          setTimeout(async () => {
            const windows = await bridge.call('get_windows').catch(() => []);
            broadcastStateUpdate('windows_updated', windows);
          }, 250);
          return reply(true, { ok: true });
        }

        case 'launch_app': {
          await launchApplication(params);
          const requestedZone = String(params.zonePreset || params.zone || 'none').trim();
          const hasExplicitZone =
            requestedZone !== 'none' &&
            requestedZone !== 'default' &&
            requestedZone !== 'custom' &&
            Boolean(ZONE_PRESETS[requestedZone] || requestedZone === 'full');
          if (hasExplicitZone && typeof params.monitorIndex === 'number' && params.monitorIndex >= 0) {
            setTimeout(async () => {
              const geom = resolveItemGeometry({
                ...params,
                zonePreset: requestedZone === 'full' ? 'fullscreen' : requestedZone
              });
              await bridge
                .call('snap_window', {
                  processName: params.processName || params.name,
                  monitorIndex: Number(params.monitorIndex || 0),
                  state: geom.state,
                  x: geom.x,
                  y: geom.y,
                  w: geom.w,
                  h: geom.h
                })
                .catch(() => {});
              const windows = await bridge.call('get_windows').catch(() => []);
              broadcastStateUpdate('windows_updated', windows);
            }, 1400);
          } else {
            setTimeout(async () => {
              const windows = await bridge.call('get_windows').catch(() => []);
              broadcastStateUpdate('windows_updated', windows);
            }, 900);
          }
          return reply(true, { launched: true });
        }

        case 'open_url': {
          const res = await bridge.call('system_control', { action: 'open_url', url: params.url });
          return reply(true, res);
        }

        case 'media_key': {
          const res = await runSystemControl({ action: 'media_key', key: params.key });
          scheduleFastMediaSync();
          return reply(true, res);
        }

        case 'power_timer': {
          const state = configurePowerTimer(params.minutes, params.mode);
          return reply(true, state);
        }

        case 'capture_frame': {
          const frame = await bridge.call(
            'capture_screen',
            {
              monitorIndex: typeof params.monitorIndex === 'number' ? params.monitorIndex : 0,
              maxWidth: Number(params.maxWidth || 1280),
              quality: Number(params.quality || 70),
              drawCursor: params.drawCursor !== false
            },
            2000
          );
          return reply(true, frame);
        }

        case 'start_stream': {
          stopClientStream(ws);
          const info = Number(params.protocol) === 2 ? startStreamV2(ws, params) : startLegacyStream(ws, params);
          return reply(true, info);
        }

        case 'stream_keyframe': {
          // Phone's video decoder lost sync (error / dropped chunk): next frame becomes an IDR
          const st = clientStreams.get(ws);
          if (st && st.active && st.sentTimes) st.needKey = true;
          return reply(true, { ok: true });
        }

        case 'stop_stream': {
          stopClientStream(ws);
          return reply(true, { streaming: false });
        }

        case 'input_fast': {
          if (params && params.type === 'touch') {
            touchActiveSockets.add(ws);
            if (params.phase === 'up' || params.phase === 'cancel') touchActiveSockets.delete(ws);
          }
          const fastPayload =
            params && typeof params === 'object'
              ? { ...params, mousePriority: (functionPrefs && functionPrefs.mousePriority) || 'active_lock' }
              : params;
          bridge.sendFast('send_input', fastPayload);
          return;
        }

        case 'send_input': {
          const inputPayload =
            params && typeof params === 'object'
              ? { ...params, mousePriority: (functionPrefs && functionPrefs.mousePriority) || 'active_lock' }
              : params;
          const res = await bridge.call('send_input', inputPayload, 1500);
          if (params.type === 'key') {
            const kUpper = String(params.key || '').toUpperCase();
            if (kUpper.startsWith('MEDIA_') || kUpper === 'LEFT' || kUpper === 'RIGHT' || kUpper === 'SPACE' || kUpper === 'J' || kUpper === 'L' || kUpper === 'K') {
              scheduleFastMediaSync();
            }
          }
          return reply(true, res);
        }

        case 'audio_control': {
          const audio = await runAudioControl(params);
          return reply(true, audio);
        }

        case 'wireless_control': {
          const wRes = await bridge.call('wireless_control', params, 10000);
          return reply(true, wRes);
        }

        case 'check_update': {
          const uRes = await checkGitHubUpdate();
          return reply(true, uRes);
        }

        case 'perform_update': {
          const pRes = await performSelfUpdate();
          return reply(true, pRes);
        }

        case 'upload_file': {
          const upRes = await handleFileUpload(params);
          return reply(true, upRes);
        }

        case 'download_file': {
          const dlRes = handleFileDownloadRpc(params);
          return reply(true, dlRes);
        }

        case 'system_control': {
          if (params && params.action === 'regenerate_pairing_code') {
            const newCode = rotatePairingCode(false);
            return reply(true, { pairingCode: newCode, pin: newCode, pinExpiresAt });
          }
          if (params && params.action === 'disconnect_all_sessions') {
            const disc = disconnectAllSessions();
            return reply(true, { ok: true, ...disc });
          }
          const res = await runSystemControl(params);
          if (res && typeof res.isLocked === 'boolean') {
            broadcastStateUpdate('lock_state_updated', { isLocked: res.isLocked });
          }
          if (params && params.action === 'set_brightness') {
            const monitors = await bridge.call('get_monitors').catch(() => []);
            broadcastStateUpdate('monitors_updated', monitors);
          }
          return reply(true, res);
        }

        case 'wake_on_lan': {
          const res = await sendWakeOnLan(params.macAddress, params.broadcastIp);
          return reply(true, res);
        }

        default:
          return reply(false, null, `Bilinmeyen eylem: ${action}`);
      }
    } catch (err) {
      return reply(false, null, err.message);
    }
  });

  ws.on('close', () => {
    clearTimeout(authDeadline);
    // A phone that disconnects with a finger down must not leave the PC touch-pressed
    if (touchActiveSockets.delete(ws)) bridge.sendFast('send_input', { type: 'touch', phase: 'cancel', id: 0 });
    stopClientStream(ws);
    authenticatedClients.delete(ws);
    updateRuntimeStatusFile();
  });
});

// UDP Auto-Discovery Responder (Port 4851)
const udpServer = dgram.createSocket('udp4');
// Discovery is answered only for private / tethering / Tailscale source addresses
function isPrivateIPv4(ip) {
  const p = String(ip || '').replace(/^::ffff:/i, '').split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return false;
  return (
    p[0] === 10 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    p[0] === 127
  );
}

udpServer.on('message', (msg, rinfo) => {
  const text = msg.toString().trim();
  if (text.startsWith('TAHABLT_DISCOVER') && rinfo && isPrivateIPv4(rinfo.address)) {
    const netInfo = resolveClientNetworkInfo(getNetworkInfo(), rinfo && rinfo.address, '');
    const payload = JSON.stringify({
      type: 'TAHABLT_ANNOUNCE',
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      lanIp: netInfo.lanIp,
      lanIps: netInfo.lanIps,
      subnetBroadcast: netInfo.subnetBroadcast,
      subnetBroadcasts: netInfo.subnetBroadcasts,
      macAddress: netInfo.macAddress,
      macAddresses: netInfo.macAddresses,
      tailscaleIp: netInfo.tailscaleIp,
      port: PORT
    });
    udpServer.send(Buffer.from(payload), rinfo.port, rinfo.address);
  }
});
udpServer.on('error', () => {});
try {
  udpServer.bind(DISCOVERY_PORT);
} catch {}

// Publish live WAN Tunnel & Multi-Interface LAN Info to private ntfy.sh rendezvous topic
// so the paired phone on 4.5G/5G Mobile Data or USB Tether + Hotspot can always locate the PC!
function publishToNtfyTopic(topic, body) {
  try {
    const req = https.request(
      {
        hostname: 'ntfy.sh',
        port: 443,
        path: '/' + topic,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Title: 'Bridge Endpoint Sync',
          Priority: 'min'
        },
        timeout: 8000
      },
      (res) => {
        res.resume();
      }
    );
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch {}
}

let lastPublishedPayloadSig = '';
let lastPublishedWallTs = 0;

// ntfy.sh topics are public and unauthenticated, so every published endpoint carries an HMAC. Phones only
// follow updates signed with the key they received at pairing (pin topics: keyed by the pairing code).
function wanSyncCanonical(msg) {
  return [msg.deviceId, msg.tunnelUrl || '', (msg.lanIps || []).join(','), msg.tailscaleIp || '', msg.ts].join('|');
}

function signWanSync(msg, key) {
  return { ...msg, v: 2, sig: crypto.createHmac('sha256', key).update(wanSyncCanonical(msg)).digest('hex') };
}

function publishWanRendezvous(force = false) {
  try {
    const netInfo = getNetworkInfo();
    const sig = `${currentTunnelUrl}|${(netInfo.lanIps || []).join(',')}|${netInfo.tailscaleIp}|${config.pin}`;
    const now = Date.now();
    const isStale = now - lastPublishedWallTs >= 45 * 60 * 1000;
    if (!force && !isStale && sig === lastPublishedPayloadSig) return;
    // Avoid overwriting a valid tunnel on ntfy.sh with an empty tunnelUrl while cloudflared is still booting
    if (!force && !currentTunnelUrl && process.uptime() < 12) return;
    lastPublishedPayloadSig = sig;
    lastPublishedWallTs = now;

    const message = {
      type: 'TAHABLT_WAN_SYNC',
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      tunnelUrl: currentTunnelUrl,
      wsTunnelUrl: currentWsTunnelUrl,
      lanIp: netInfo.lanIp,
      lanIps: netInfo.lanIps,
      subnetBroadcast: netInfo.subnetBroadcast,
      subnetBroadcasts: netInfo.subnetBroadcasts,
      tailscaleIp: netInfo.tailscaleIp,
      macAddress: netInfo.macAddress,
      syncTopic: SYNC_TOPIC,
      port: PORT,
      ts: Date.now()
    };
    delete message.macAddress;
    delete message.syncTopic;

    publishToNtfyTopic(SYNC_TOPIC, JSON.stringify(signWanSync(message, config.syncKey)));
    pruneExpiredPins();
    const publishedPinTopics = new Set();
    const publishPinNorm = (normPin) => {
      if (!normPin || normPin.length !== 8 || publishedPinTopics.has(normPin)) return;
      publishedPinTopics.add(normPin);
      const pinTopicNorm =
        'tahablt_pin_' +
        crypto
          .createHash('sha256')
          .update('tahablt_v2_' + normPin)
          .digest('hex')
          .slice(0, 20);
      publishToNtfyTopic(pinTopicNorm, JSON.stringify(signWanSync(message, normPin)));
    };

    if (activePin && Date.now() < pinExpiresAt) {
      publishPinNorm(normalizePairingCode(activePin));
    }
    for (const [normKey, entry] of activePinsMap.entries()) {
      if (entry && Date.now() < entry.serverExpiresAt) {
        publishPinNorm(normKey);
      }
    }
  } catch {}
}

// Automatic Zero-Config Outbound Cloudflared Tunnel (for Mobile Data 4.5G/5G without Tailscale)
let tunnelRetryMs = 4000;
function startCloudflaredTunnel() {
  try {
    if (cloudflaredProc) return;
    const candidates = IS_WINDOWS
      ? [
          path.join(__dirname, 'native', 'cloudflared.exe'),
          path.join(__dirname, '..', 'cloudflared.exe'),
          'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
          'C:\\Program Files\\cloudflared\\cloudflared.exe'
        ]
      : [path.join(__dirname, 'linux', 'cloudflared'), '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'];
    const bin = candidates.find((p) => fs.existsSync(p)) || (IS_WINDOWS ? 'cloudflared.exe' : 'cloudflared');

    cloudflaredProc = spawn(
      bin,
      ['tunnel', '--url', `http://127.0.0.1:${TUNNEL_INGRESS_PORT}`, '--protocol', 'http2', '--no-autoupdate'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    );

    const handleOutput = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && match[0]) tunnelRetryMs = 4000;
      if (match && match[0] && match[0] !== currentTunnelUrl) {
        currentTunnelUrl = match[0];
        currentWsTunnelUrl = currentTunnelUrl.replace(/^https:/i, 'wss:');
        updateRuntimeStatusFile();
        publishWanRendezvous(true);
        const netInfo = getNetworkInfo();
        broadcastStateUpdate('tunnel_updated', {
          lanIp: netInfo.lanIp,
          lanIps: netInfo.lanIps,
          tailscaleIp: netInfo.tailscaleIp,
          tunnelUrl: currentTunnelUrl,
          wsTunnelUrl: currentWsTunnelUrl,
          syncTopic: SYNC_TOPIC
        });
      }
    };

    cloudflaredProc.stdout.on('data', handleOutput);
    cloudflaredProc.stderr.on('data', handleOutput);
    cloudflaredProc.on('error', () => {
      cloudflaredProc = null;
    });
    cloudflaredProc.on('exit', () => {
      cloudflaredProc = null;
      // Exponential backoff with jitter: thousands of installs must not hammer trycloudflare when it is down
      tunnelRetryMs = Math.min(5 * 60 * 1000, Math.max(8000, tunnelRetryMs * 2));
      setTimeout(startCloudflaredTunnel, tunnelRetryMs + Math.floor(Math.random() * 3000));
    });
  } catch {}
}

process.on('exit', () => {
  try {
    if (cloudflaredProc) cloudflaredProc.kill();
  } catch {}
});

function updateRuntimeStatusFile() {
  try {
    const netInfo = getNetworkInfo();
    const isPinActive = Boolean(activePin && Date.now() < pinExpiresAt);
    const onlineTokenMap = new Map();
    for (const ws of authenticatedClients) {
      if (ws && ws.readyState === 1 && ws.sessionToken) {
        onlineTokenMap.set(ws.sessionToken, {
          ip: ws.clientIp || '',
          route: ws.clientRoute || ''
        });
      }
    }

    const devices = [];
    const pairedDevicesObj = (config && config.pairedDevices && typeof config.pairedDevices === 'object') ? config.pairedDevices : {};
    const validTokens = Array.isArray(config.pairedTokens) ? config.pairedTokens : [];
    const tokenSeenObj = (config && config.tokenSeen && typeof config.tokenSeen === 'object') ? config.tokenSeen : {};

    for (const tok of validTokens) {
      if (tok === config.authToken && !pairedDevicesObj[tok] && !onlineTokenMap.has(tok)) continue;
      const info = pairedDevicesObj[tok] || {};
      const liveInfo = onlineTokenMap.get(tok);
      const fallbackIso = tokenSeenObj[tok] ? new Date(tokenSeenObj[tok]).toISOString() : '';
      devices.push({
        id: info.id || getShortTokenId(tok),
        name: info.name || 'Mobil Cihaz',
        ip: (liveInfo && liveInfo.ip) || info.ip || '-',
        route: (liveInfo && liveInfo.route) || info.route || 'Yerel Ağ',
        online: onlineTokenMap.has(tok),
        pairedAt: info.pairedAt || fallbackIso,
        lastSeenAt: info.lastSeenAt || fallbackIso
      });
    }

    // Also include any active WebSocket session whose token wasn't yet in pairedDevicesObj
    for (const [tok, liveInfo] of onlineTokenMap.entries()) {
      const shortId = getShortTokenId(tok);
      if (!devices.some((d) => d.id === shortId)) {
        devices.push({
          id: shortId,
          name: 'Mobil Cihaz',
          ip: liveInfo.ip || 'Yerel Ağ',
          route: liveInfo.route || 'Yerel Ağ',
          online: true,
          pairedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString()
        });
      }
    }

    // Sort: online devices first, then by most recent lastSeenAt
    devices.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || ''));
    });

    const statusData = {
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      pin: isPinActive ? activePin : '',
      pinExpiresAt: isPinActive ? pinExpiresAt : 0,
      lanIp: netInfo.lanIp,
      lanIps: netInfo.lanIps,
      tailscaleIp: netInfo.tailscaleIp,
      macAddress: netInfo.macAddress,
      tunnelUrl: currentTunnelUrl,
      wsTunnelUrl: currentWsTunnelUrl,
      syncTopic: SYNC_TOPIC,
      port: PORT,
      connectedClients: authenticatedClients.size,
      pairedDeviceCount: devices.length,
      devices,
      updatedAt: new Date().toISOString()
    };
    const jsonStr = JSON.stringify(statusData, null, 2);
    fs.writeFileSync(RUNTIME_FILE, jsonStr, 'utf8');
    if (IS_WINDOWS && USER_WIN_DATA_DIR && USER_WIN_DATA_DIR !== DATA_DIR) {
      try {
        fs.mkdirSync(USER_WIN_DATA_DIR, { recursive: true });
        fs.writeFileSync(path.join(USER_WIN_DATA_DIR, 'runtime-status.json'), jsonStr, 'utf8');
      } catch {}
    }
  } catch {}
}

function ensureWakeOnLanEnabledInBackground() {
  if (!IS_WINDOWS) return;
  try {
    const psCmd = [
      'try { Set-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power" -Name "HiberbootEnabled" -Value 0 -Type DWord -ErrorAction SilentlyContinue } catch {}',
      'Get-NetAdapter -Physical -ErrorAction SilentlyContinue | ForEach-Object {',
      '  $n = $_.Name; $d = $_.InterfaceDescription;',
      '  try { Enable-NetAdapterPowerManagement -Name $n -WakeOnMagicPacket -WakeOnPattern -NoRestart -ErrorAction SilentlyContinue } catch {}',
      '  foreach ($p in @("*WakeOnMagicPacket", "*ModernStandbyWoLMagicPacket", "*WakeOnPattern", "S5WakeOnLan", "WakeOnMagicPacket", "ShutdownWake", "WolShutdownLinkSpeed")) {',
      '    try { Set-NetAdapterAdvancedProperty -Name $n -RegistryKeyword $p -RegistryValue 1 -NoRestart -ErrorAction SilentlyContinue } catch {}',
      '  }',
      '  try { powercfg /deviceenablewake "$d" | Out-Null } catch {}',
      '}'
    ].join('; ');
    const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psCmd], {
      stdio: 'ignore',
      windowsHide: true
    });
    child.on('error', () => {});
  } catch {}
}

// Watch for USB Tethering / Mobile Hotspot interface changes and Now-Playing Media updates
let lastNetSignature = '';
let lastMediaSignature = '';

function startBackgroundWatchers() {
  try {
    const initNet = getNetworkInfo();
    lastNetSignature = `${(initNet.lanIps || []).join(',')}|${initNet.tailscaleIp}`;
  } catch {}

  // 1. Network Interface Watcher (detects USB RNDIS Tethering & Hotspot IP changes within 6s, and keeps WAN rendezvous fresh)
  setInterval(() => {
    try {
      const netInfo = getNetworkInfo();
      const sig = `${(netInfo.lanIps || []).join(',')}|${netInfo.tailscaleIp}`;
      if (sig !== lastNetSignature) {
        lastNetSignature = sig;
        updateRuntimeStatusFile();
        publishWanRendezvous(true);
        broadcastStateUpdate('tunnel_updated', {
          lanIp: netInfo.lanIp,
          lanIps: netInfo.lanIps,
          subnetBroadcast: netInfo.subnetBroadcast,
          subnetBroadcasts: netInfo.subnetBroadcasts,
          tailscaleIp: netInfo.tailscaleIp,
          tunnelUrl: currentTunnelUrl,
          wsTunnelUrl: currentWsTunnelUrl,
          syncTopic: SYNC_TOPIC
        });
      } else if (currentTunnelUrl && Date.now() - lastPublishedWallTs >= 45 * 60 * 1000) {
        publishWanRendezvous(true);
      }
    } catch {}
  }, 6000);

  // 2. Real-Time PC Media / Now-Playing Watcher (pushes audio_updated to phone Notification Bar & Media Mixer)
  let lastBroadcastMediaTick = 0;
  let lastWatchedMediaPos = -1;
  let lastWatchedMediaTs = 0;
  setInterval(async () => {
    if (authenticatedClients.size === 0) return;
    try {
      const audio = await bridge.call('audio_control', { action: 'get' }, 2500);
      if (!audio) return;
      const np = audio.nowPlaying || {};
      const sig = `${Boolean(np.active)}|${Boolean(np.isPlaying)}|${np.title || ''}|${np.appName || ''}|${np.durationSec || 0}|${audio.masterVolume}|${audio.masterMuted}`;
      const now = Date.now();
      const curPos = Number(np.positionSec || 0);
      const dtSec = lastWatchedMediaTs > 0 && np.isPlaying ? Math.max(0, (now - lastWatchedMediaTs) / 1000) : 0;
      const expectedPos = lastWatchedMediaPos >= 0 ? lastWatchedMediaPos + dtSec : curPos;
      const posJumped = np.active && lastWatchedMediaPos >= 0 && Math.abs(curPos - expectedPos) >= 2.0;
      lastWatchedMediaPos = np.active ? curPos : -1;
      lastWatchedMediaTs = now;
      if (sig !== lastMediaSignature || posJumped || (np.active && now - lastBroadcastMediaTick >= 4500)) {
        lastMediaSignature = sig;
        lastBroadcastMediaTick = now;
        broadcastStateUpdate('audio_updated', audio);
      }
    } catch {}
  }, 2200);
}

// The tunnel is only started once its private ingress port is ours (an exiting older agent may still hold it)
function listenTunnelIngress(attempt) {
  if (tunnelIngressServer.listening || process.env.TAHABLT_NO_TUNNEL === '1') return;
  const onError = () => {
    if (attempt < 10) setTimeout(() => listenTunnelIngress(attempt + 1), 1000);
  };
  tunnelIngressServer.once('error', onError);
  tunnelIngressServer.listen(TUNNEL_INGRESS_PORT, '127.0.0.1', () => {
    tunnelIngressServer.removeListener('error', onError);
    startCloudflaredTunnel();
  });
}

let agentListening = false;

function startListening(retryCount = 0) {
  const onListenError = (err) => {
    if (err.code !== 'EADDRINUSE' || retryCount >= 3) return;
    // An older agent still holds the port: ask it to exit, then retry exactly once per attempt
    let retried = false;
    const retry = () => {
      if (retried) return;
      retried = true;
      setTimeout(() => startListening(retryCount + 1), 400);
    };
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path: '/api/takeover', method: 'POST', timeout: 1000, headers: { 'X-TahaBLT-Admin': ADMIN_KEY } },
      (res) => {
        res.resume();
        retry();
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', retry);
    req.end();
  };
  server.once('error', onListenError);

  // listen() keeps the callback of a failed attempt registered, so startup work is guarded to run once
  server.listen(PORT, '0.0.0.0', () => {
    server.removeListener('error', onListenError);
    if (agentListening) return;
    agentListening = true;
    ensureWakeOnLanEnabledInBackground();
    updateRuntimeStatusFile();
    setInterval(updateRuntimeStatusFile, 10000);
    // Warm up installed apps cache in background on startup
    setTimeout(() => {
      getCachedAutoInstalledApps().catch(() => {});
    }, 800);
    listenTunnelIngress(0);
    startBackgroundWatchers();
    // Publish WAN rendezvous once tunnel URL is ready (or after 7s fallback) so ntfy.sh never gets an empty tunnelUrl
    setTimeout(() => {
      if (currentTunnelUrl) publishWanRendezvous();
    }, 7000);
    // Re-publish WAN rendezvous every 45 minutes so ntfy.sh cache never expires (even across >4h idle periods)
    setInterval(() => publishWanRendezvous(true), 45 * 60 * 1000);
    const netInfo = getNetworkInfo();
    console.log(
      `[Bridge] PC Agent aktif -> LAN: ${(netInfo.lanIps || [netInfo.lanIp]).join(', ')}:${PORT} | PIN: ${config.pin}`
    );
  });
}

startListening();
