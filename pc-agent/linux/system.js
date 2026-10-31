'use strict';
// audio_control (pactl + playerctl) and system_control (power, lock, clipboard, stats, ...).
// Return shapes follow HandleAudioControl() / HandleSystemControl() in BridgeHelper.cs.

const path = require('path').posix; // Linux paths, also when the tests run on Windows
const {
  parsePactlVolume,
  parsePactlMute,
  parsePactlSinkInputs,
  parsePactlSinks,
  PLAYERCTL_FORMAT,
  parsePlayerctlLines,
  pickPlayer,
  friendlyPlayerName,
  parseProcStat,
  cpuPercent,
  parseMeminfo,
  parseUptime
} = require('./parsers');
const { execOk, sleep, clamp, num, missingToolMessage } = require('./util');

const NOT_PLAYING = { active: false, isPlaying: false, title: 'Medya Oynatılmıyor', appName: 'Masaüstü Ses Sistemi', processName: '', pid: 0, icon: '', positionSec: 0, durationSec: 0 };

function createSystem(sys, desktop, input) {
  const st = {
    isLocked: false,
    lockedHintTs: 0,
    cpuPrev: null,
    clipHistory: [],
    lastClipText: '',
    stickyPlayer: ''
  };
  const dryRun = sys.env.TAHABLT_POWER_DRYRUN === '1';

  // -------------------------------------------------------------------------
  // Power actions (dry-run aware: CI must never suspend the runner)
  // -------------------------------------------------------------------------
  async function runPower(action, argv) {
    const command = argv.join(' ');
    if (dryRun) {
      sys.log(`DRYRUN ${action}: ${command}`);
      const logFile = sys.env.TAHABLT_POWER_LOG;
      if (logFile) {
        try {
          sys.fs.appendFileSync(logFile, JSON.stringify({ ts: sys.now(), action, command, argv }) + '\n');
        } catch (e) {
          sys.log('power log yazılamadı:', e.message);
        }
      }
      return { dryRun: true, command };
    }
    if (!sys.has(argv[0])) throw new Error(missingToolMessage(argv[0]));
    // Let the reply leave before the machine goes away (SetSuspendState was delayed 100 ms too)
    setTimeout(() => {
      sys.exec(argv[0], argv.slice(1), { timeout: 15000 }).then(
        (r) => r.code !== 0 && sys.log(`${command} başarısız: ${(r.stderr || '').trim()}`),
        (e) => sys.log(`${command}: ${e.message}`)
      );
    }, 100);
    return { command };
  }

  async function lockSession(lock) {
    const sid = sys.env.XDG_SESSION_ID;
    const argv = ['loginctl', lock ? 'lock-session' : 'unlock-session', ...(sid ? [sid] : [])];
    if (dryRun) {
      await runPower(lock ? 'lock' : 'unlock', argv);
    } else if (sys.has('loginctl')) {
      const r = await sys.exec(argv[0], argv.slice(1), { timeout: 5000 });
      // Outside a logind session (e.g. started by cron) fall back to the screensaver
      if (r.code !== 0 && lock && sys.has('xdg-screensaver')) await sys.exec('xdg-screensaver', ['lock'], { timeout: 5000 }).catch(() => {});
      else if (r.code !== 0) throw new Error('loginctl başarısız: ' + (r.stderr || '').trim());
    } else if (lock && sys.has('xdg-screensaver')) {
      await sys.exec('xdg-screensaver', ['lock'], { timeout: 5000 });
    } else {
      throw new Error(missingToolMessage('loginctl'));
    }
    st.isLocked = lock;
    st.lockedHintTs = sys.now();
  }

  // logind knows when the user locked the screen themselves; cached for 1.5 s
  async function refreshLockedHint() {
    if (dryRun || !sys.env.XDG_SESSION_ID || !sys.has('loginctl')) return st.isLocked;
    if (sys.now() - st.lockedHintTs < 1500) return st.isLocked;
    st.lockedHintTs = sys.now();
    const r = await sys.exec('loginctl', ['show-session', sys.env.XDG_SESSION_ID, '-p', 'LockedHint', '--value'], { timeout: 1500 }).catch(() => null);
    if (r && r.code === 0 && /^(yes|no)$/.test(r.stdout.trim())) st.isLocked = r.stdout.trim() === 'yes';
    return st.isLocked;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------
  function readText(p) {
    try {
      return sys.fs.readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  }

  async function stats() {
    let cur = parseProcStat(readText('/proc/stat'));
    if (!st.cpuPrev && cur) {
      // First call: sample twice so the value is meaningful
      st.cpuPrev = cur;
      await sleep(120);
      cur = parseProcStat(readText('/proc/stat'));
    }
    const cpu = cpuPercent(st.cpuPrev, cur);
    if (cur) st.cpuPrev = cur;
    const mem = parseMeminfo(readText('/proc/meminfo'));
    const mons = await desktop.getMonitors(2500).catch(() => []);
    return {
      machineName: sys.hostname(),
      userName: sys.username(),
      cpuPercent: cpu,
      memoryPercent: mem.memoryPercent,
      usedRamGb: mem.usedRamGb,
      totalRamGb: mem.totalRamGb,
      uptimeSeconds: parseUptime(readText('/proc/uptime')),
      isLocked: await refreshLockedHint(),
      brightness: mons.length ? mons[0].brightness : 100
    };
  }

  // -------------------------------------------------------------------------
  // Clipboard (xclip), history persisted like the Windows bridge
  // -------------------------------------------------------------------------
  const historyFile = path.join(
    sys.env.TAHABLT_DATA_DIR || path.join(sys.homedir(), '.local', 'share', 'bridge'),
    'clipboard_history.json'
  );

  function loadHistory() {
    try {
      const list = JSON.parse(sys.fs.readFileSync(historyFile, 'utf8'));
      if (Array.isArray(list)) st.clipHistory = list.slice(0, 40);
    } catch {}
  }

  function saveHistory() {
    try {
      sys.fs.mkdirSync(path.dirname(historyFile), { recursive: true });
      sys.fs.writeFileSync(historyFile, JSON.stringify(st.clipHistory));
    } catch {}
  }

  function addHistory(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    st.lastClipText = clean;
    st.clipHistory = st.clipHistory.filter((h) => h.text !== clean);
    const d = new Date(sys.now());
    const p = (n) => String(n).padStart(2, '0');
    st.clipHistory.unshift({
      id: Math.random().toString(16).slice(2, 12),
      type: 'text',
      text: clean,
      time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
      charCount: clean.length
    });
    if (st.clipHistory.length > 40) st.clipHistory.length = 40;
    saveHistory();
  }

  async function readClipboard() {
    if (!sys.has('xclip')) throw new Error(missingToolMessage('xclip'));
    const r = await sys.exec('xclip', ['-selection', 'clipboard', '-o'], { timeout: 2000 }).catch(() => null);
    return r && r.code === 0 ? r.stdout : '';
  }

  async function pollClipboard() {
    if (!sys.has('xclip')) return;
    const t = (await readClipboard().catch(() => '')).trim();
    if (t && t !== st.lastClipText && t.length < 100000) addHistory(t);
  }

  async function writeClipboard(data, mime) {
    if (!sys.has('xclip')) throw new Error(missingToolMessage('xclip'));
    const args = ['-selection', 'clipboard', ...(mime ? ['-t', mime] : []), '-i'];
    await sys.exec('xclip', args, { input: data, waitExit: true, ignoreOutput: true, timeout: 3000 });
  }

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------
  async function pactl(args) {
    if (!sys.has('pactl')) throw new Error(missingToolMessage('pactl'));
    return sys.exec('pactl', args, { timeout: 3000 });
  }

  async function masterState() {
    const [v, m] = await Promise.all([pactl(['get-sink-volume', '@DEFAULT_SINK@']), pactl(['get-sink-mute', '@DEFAULT_SINK@'])]);
    if (v.code === 0 && m.code === 0) return { volume: parsePactlVolume(v.stdout) ?? 0, muted: Boolean(parsePactlMute(m.stdout)) };
    // pactl < 14: no get-sink-* subcommands
    const info = await pactl(['info']);
    const def = (/Default Sink:\s*(\S+)/.exec(info.stdout) || [])[1] || '';
    const sinks = await pactl(['list', 'sinks']);
    const s = parsePactlSinks(sinks.stdout, def);
    if (!s) throw new Error('Ses çıkışı bulunamadı (PulseAudio/PipeWire çalışıyor mu?)');
    return { volume: s.volume ?? 0, muted: s.muted };
  }

  async function sinkInputs() {
    const r = await pactl(['list', 'sink-inputs']);
    const list = r.code === 0 ? parsePactlSinkInputs(r.stdout) : [];
    for (const s of list) s.icon = desktop.iconForProcess(s.rawProcessName) || '';
    return list;
  }

  async function players() {
    if (!sys.has('playerctl')) return [];
    const r = await sys.exec('playerctl', ['-a', 'metadata', '--format', PLAYERCTL_FORMAT], { timeout: 2000 }).catch(() => null);
    return r && r.code === 0 ? parsePlayerctlLines(r.stdout) : [];
  }

  async function currentPlayer() {
    const list = await players();
    const sticky = list.find((p) => p.player === st.stickyPlayer && p.isPlaying);
    return sticky || pickPlayer(list);
  }

  // ExecuteMediaCommand(): MPRIS session first, media key when no player is known
  async function mediaCommand(key) {
    const k = String(key || 'MEDIA_PLAY_PAUSE').toUpperCase();
    const pick = sys.has('playerctl') ? await currentPlayer() : null;
    if (!pick) {
      await input.handle({ type: 'key', key: k });
      return;
    }
    const verb = k === 'MEDIA_NEXT' ? 'next' : k === 'MEDIA_PREV' ? 'previous' : k === 'MEDIA_STOP' ? 'stop' : 'play-pause';
    const r = await sys.exec('playerctl', ['-p', pick.player, verb], { timeout: 2000 }).catch(() => null);
    if (!r || r.code !== 0) {
      await input.handle({ type: 'key', key: k });
      return;
    }
    st.stickyPlayer = pick.player;
    if (verb === 'play-pause') {
      // Wait briefly until the player reports the new state so the reply is not stale
      for (let i = 0; i < 12; i++) {
        await sleep(40);
        const again = (await players()).find((p) => p.player === pick.player);
        if (!again || again.isPlaying !== pick.isPlaying) break;
      }
    }
  }

  async function audioGet() {
    let master;
    try {
      master = await masterState();
    } catch (e) {
      return { masterVolume: 50, masterMuted: false, sessions: [], nowPlaying: { ...NOT_PLAYING, appName: 'PC' }, warning: e.message };
    }
    const sessions = await sinkInputs().catch(() => []);
    let nowPlaying = { ...NOT_PLAYING };
    const active = sessions.find((s) => s.isActive);
    if (active) nowPlaying = { ...nowPlaying, active: true, isPlaying: true, title: active.processName, appName: active.processName, processName: active.rawProcessName, pid: active.pid, icon: active.icon };
    // MPRIS (playerctl) is authoritative: title, play state and timeline come from the same player
    const pick = await currentPlayer().catch(() => null);
    if (pick) {
      const appName = friendlyPlayerName(pick.player);
      let title = pick.title || '';
      if (pick.artist && !title.toLowerCase().includes(pick.artist.toLowerCase())) title = title ? `${pick.artist} - ${title}` : pick.artist;
      const match = sessions.find((s) => s.rawProcessName && pick.player.toLowerCase().includes(String(s.rawProcessName).toLowerCase()));
      nowPlaying = {
        active: true,
        isPlaying: pick.isPlaying,
        title: title || appName,
        appName,
        processName: match ? match.rawProcessName : pick.player,
        pid: match ? match.pid : 0,
        icon: match ? match.icon : desktop.iconForProcess(pick.player.split('.')[0]),
        sourceAppId: pick.player,
        positionSec: pick.positionSec,
        durationSec: pick.durationSec
      };
    }
    return { masterVolume: master.volume, masterMuted: master.muted, sessions, nowPlaying };
  }

  async function audioControl(args) {
    const action = String(args.action || 'get');
    if (action === 'media_command') {
      await mediaCommand(args.key);
    } else if (action === 'seek') {
      const sec = num(args.positionSec !== undefined ? args.positionSec : args.position, 0);
      const pick = await currentPlayer();
      if (pick) await sys.exec('playerctl', ['-p', pick.player, 'position', String(Math.max(0, sec))], { timeout: 2000 }).catch(() => {});
    } else if (action === 'set_master') {
      if (args.volume !== undefined) await execOk(sys, 'pactl', ['set-sink-volume', '@DEFAULT_SINK@', clamp(Math.round(num(args.volume, 50)), 0, 100) + '%'], { timeout: 3000 });
      if (args.muted !== undefined) await execOk(sys, 'pactl', ['set-sink-mute', '@DEFAULT_SINK@', args.muted ? '1' : '0'], { timeout: 3000 });
    } else if (action === 'set_app') {
      const pid = num(args.pid, 0);
      const proc = String(args.processName || '').toLowerCase();
      for (const s of await sinkInputs()) {
        const match = (pid && s.pid === pid) || (proc && (String(s.rawProcessName).toLowerCase() === proc || String(s.processName).toLowerCase() === proc));
        if (!match) continue;
        if (args.volume !== undefined) await pactl(['set-sink-input-volume', String(s.sinkInputId), clamp(Math.round(num(args.volume, 100)), 0, 100) + '%']);
        if (args.muted !== undefined) await pactl(['set-sink-input-mute', String(s.sinkInputId), args.muted ? '1' : '0']);
      }
    }
    return audioGet();
  }

  // -------------------------------------------------------------------------
  // system_control
  // -------------------------------------------------------------------------
  function openTaskManager() {
    for (const app of ['gnome-system-monitor', 'plasma-systemmonitor', 'ksysguard', 'mate-system-monitor', 'xfce4-taskmanager', 'lxtask']) {
      if (sys.has(app)) return sys.spawnDetached(app, []);
    }
    for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm']) {
      if (sys.has(term)) return sys.spawnDetached(term, term === 'gnome-terminal' ? ['--', 'top'] : ['-e', 'top']);
    }
    throw new Error('Görev yöneticisi bulunamadı (gnome-system-monitor veya xterm kurun)');
  }

  async function systemControl(args) {
    const action = String(args.action || 'stats');
    const force = String(args.mode || '') === 'force';
    switch (action) {
      case 'lock':
        await lockSession(true);
        return { ok: true, action: 'lock', isLocked: true };
      case 'unlock':
        await lockSession(false);
        return { ok: true, action: 'unlock', isLocked: false };
      case 'toggle_lock': {
        const next = !(await refreshLockedHint());
        await lockSession(next);
        return { ok: true, action: next ? 'lock' : 'unlock', isLocked: next };
      }
      case 'sleep':
        return { ok: true, action, ...(await runPower(action, ['systemctl', 'suspend'])) };
      case 'hibernate':
        return { ok: true, action, ...(await runPower(action, ['systemctl', 'hibernate'])) };
      case 'shutdown':
        return { ok: true, action, ...(force ? { mode: 'force' } : {}), ...(await runPower(action, ['systemctl', 'poweroff', ...(force ? ['-i'] : [])])) };
      case 'restart':
        return { ok: true, action, ...(force ? { mode: 'force' } : {}), ...(await runPower(action, ['systemctl', 'reboot', ...(force ? ['-i'] : [])])) };
      case 'show_desktop':
        await input.handle({ type: 'key', key: 'WIN+D' });
        return { ok: true, action };
      case 'task_manager':
        openTaskManager();
        return { ok: true, action };
      case 'media_key': {
        const key = String(args.key || 'MEDIA_PLAY_PAUSE').toUpperCase();
        await mediaCommand(key);
        return { ok: true, key };
      }
      case 'set_brightness': {
        const level = num(args.brightness !== undefined ? args.brightness : args.level, 100);
        const monitorIndex = num(args.monitorIndex, -1);
        await desktop.setBrightness(monitorIndex, level);
        return { ok: true, monitorIndex, brightness: level, monitors: await desktop.getMonitors() };
      }
      case 'empty_recycle_bin':
        if (!sys.has('gio')) throw new Error(missingToolMessage('gio'));
        await sys.exec('gio', ['trash', '--empty'], { timeout: 30000 });
        return { ok: true, action };
      case 'optimize_memory':
        return { ok: true, trimmedProcesses: 0 }; // the Linux kernel manages page cache itself
      case 'open_url': {
        let url = String(args.url || '').trim();
        if (url) {
          if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
          desktop.openPath(url);
        }
        return { ok: true, url };
      }
      case 'get_clipboard': {
        let text = await readClipboard().catch(() => '');
        if (text.trim()) addHistory(text);
        else if (st.clipHistory.length) text = st.clipHistory[0].text || '';
        return { text, history: st.clipHistory.slice() };
      }
      case 'get_clipboard_history': {
        await pollClipboard().catch(() => {});
        const items = st.clipHistory.slice();
        return { items, history: items };
      }
      case 'clear_clipboard_history':
        st.clipHistory = [];
        saveHistory();
        return { ok: true, history: [] };
      case 'set_clipboard': {
        const text = args.text === undefined || args.text === null ? '' : String(args.text);
        await writeClipboard(text);
        addHistory(text);
        return { ok: true, history: st.clipHistory.slice() };
      }
      case 'set_clipboard_image': {
        const url = String(args.image || '');
        const comma = url.indexOf(',');
        const buf = Buffer.from(comma >= 0 ? url.slice(comma + 1) : url, 'base64');
        const mime = (/^data:([^;,]+)/.exec(url) || [])[1] || 'image/png';
        if (buf.length) await writeClipboard(buf, mime);
        return { ok: true };
      }
      default:
        return stats();
    }
  }

  loadHistory();
  let clipTimer = null;
  function startClipboardWatch() {
    if (clipTimer || !sys.has('xclip')) return;
    clipTimer = setInterval(() => pollClipboard().catch(() => {}), 2000);
    if (clipTimer.unref) clipTimer.unref();
  }

  return { st, systemControl, audioControl, audioGet, stats, mediaCommand, openTaskManager, startClipboardWatch, historyFile, dryRun };
}

module.exports = { createSystem, NOT_PLAYING };
