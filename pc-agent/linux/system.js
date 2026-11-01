'use strict';
// audio_control (pactl / wpctl + playerctl) and system_control (power, lock, clipboard, stats, ...)
// across X11 and Wayland desktops. Return shapes follow HandleAudioControl() / HandleSystemControl() in BridgeHelper.cs.

const path = require('path').posix; // Linux paths, also when the tests run on Windows
const {
  parsePactlVolume,
  parsePactlMute,
  parseWpctlVolume,
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
const { execOk, getSession, sleep, clamp, num, missingToolMessage } = require('./util');

const NOT_PLAYING = { active: false, isPlaying: false, title: 'Medya Oynatılmıyor', appName: 'Masaüstü Ses Sistemi', processName: '', pid: 0, icon: '', positionSec: 0, durationSec: 0 };

function createSystem(sys, desktop, input) {
  const st = {
    isLocked: false,
    lockedHintTs: 0,
    cpuPrev: null,
    clipHistory: [],
    lastClipText: '',
    stickyPlayer: '',
    fallbackTrackKey: '',
    fallbackPosSec: 0,
    fallbackLastTs: 0
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

  function launchWaylandLocker() {
    for (const locker of ['hyprlock', 'swaylock', 'gtklock', 'waylock', 'i3lock']) {
      if (sys.has(locker)) {
        try {
          sys.spawnDetached(locker, locker === 'swaylock' ? ['-f'] : []);
          return true;
        } catch {}
      }
    }
    return false;
  }

  async function lockSession(lock) {
    const sid = sys.env.XDG_SESSION_ID;
    const argv = ['loginctl', lock ? 'lock-session' : 'unlock-session', ...(sid ? [sid] : [])];
    if (dryRun) {
      await runPower(lock ? 'lock' : 'unlock', argv);
    } else if (sys.has('loginctl')) {
      const r = await sys.exec(argv[0], argv.slice(1), { timeout: 5000 });
      // Outside a logind session or on standalone Wayland compositors without lock handler, fall back to locker binaries
      if (r.code !== 0 && lock) {
        if (!launchWaylandLocker() && sys.has('xdg-screensaver')) {
          await sys.exec('xdg-screensaver', ['lock'], { timeout: 5000 }).catch(() => {});
        }
      } else if (r.code !== 0) {
        throw new Error('loginctl başarısız: ' + (r.stderr || '').trim());
      } else if (lock && getSession(sys).isWayland && ['hyprland', 'sway', 'wlroots'].includes(getSession(sys).compositor)) {
        // On standalone wlroots compositors loginctl lock-session only emits a D-Bus signal; if no daemon listens, spawn locker
        launchWaylandLocker();
      }
    } else if (lock && launchWaylandLocker()) {
      // Locked via standalone locker
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

  function readBatteryStatus() {
    for (const bat of ['BAT0', 'BAT1', 'BATC', 'BATT']) {
      const capStr = readText(`/sys/class/power_supply/${bat}/capacity`).trim();
      if (capStr && /^\d+$/.test(capStr)) {
        const statusStr = readText(`/sys/class/power_supply/${bat}/status`).trim().toLowerCase();
        const isCharging = statusStr === 'charging' || statusStr === 'full';
        return {
          hasBattery: true,
          percent: clamp(Number(capStr), 0, 100),
          isCharging,
          acOnline: isCharging,
          remainingSeconds: -1
        };
      }
    }
    return { hasBattery: false, percent: 100, isCharging: true, acOnline: true, remainingSeconds: -1 };
  }

  async function readDisksUsage() {
    if (!sys.has('df')) return [];
    const r = await sys.exec('df', ['-BG', '-P', '/'], { timeout: 2000 }).catch(() => null);
    if (!r || r.code !== 0 || !r.stdout) return [];
    const list = [];
    const lines = r.stdout.trim().split('\n').slice(1);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const totalGb = parseFloat(parts[1]) || 0;
      const usedGb = parseFloat(parts[2]) || 0;
      const freeGb = parseFloat(parts[3]) || 0;
      const usedPercent = parseInt(parts[4], 10) || 0;
      const mount = parts[5] || '/';
      if (totalGb > 0) {
        list.push({ name: mount, label: parts[0] || 'Root', totalGb, freeGb, usedGb, usedPercent });
      }
    }
    return list;
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
      brightness: mons.length ? mons[0].brightness : 100,
      battery: readBatteryStatus(),
      disks: await readDisksUsage()
    };
  }

  // -------------------------------------------------------------------------
  // Clipboard (wl-clipboard on Wayland, xclip / xsel on X11)
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

  function hasClipboardTool() {
    return sys.has('wl-paste') || sys.has('xclip') || sys.has('xsel');
  }

  async function readClipboard() {
    const sess = getSession(sys);
    if (sess.isWayland && sys.has('wl-paste')) {
      const r = await sys.exec('wl-paste', ['--no-newline'], { timeout: 2000 }).catch(() => null);
      if (r && r.code === 0) return r.stdout;
    }
    if (sys.has('xclip')) {
      const r = await sys.exec('xclip', ['-selection', 'clipboard', '-o'], { timeout: 2000 }).catch(() => null);
      return r && r.code === 0 ? r.stdout : '';
    }
    if (sys.has('wl-paste')) {
      const r = await sys.exec('wl-paste', ['--no-newline'], { timeout: 2000 }).catch(() => null);
      return r && r.code === 0 ? r.stdout : '';
    }
    if (sys.has('xsel')) {
      const r = await sys.exec('xsel', ['--clipboard', '--output'], { timeout: 2000 }).catch(() => null);
      return r && r.code === 0 ? r.stdout : '';
    }
    throw new Error(missingToolMessage(sess.isWayland ? 'wl-paste' : 'xclip'));
  }

  async function pollClipboard() {
    if (!hasClipboardTool()) return;
    const t = (await readClipboard().catch(() => '')).trim();
    if (t && t !== st.lastClipText && t.length < 100000) addHistory(t);
  }

  async function writeClipboard(data, mime) {
    const sess = getSession(sys);
    if (sess.isWayland && sys.has('wl-copy')) {
      const wArgs = mime ? ['--type', mime] : [];
      const r = await sys.exec('wl-copy', wArgs, { input: data, waitExit: true, ignoreOutput: true, timeout: 3000 }).catch(() => null);
      if (r && r.code === 0) return;
    }
    if (sys.has('xclip')) {
      const args = ['-selection', 'clipboard', ...(mime ? ['-t', mime] : []), '-i'];
      await sys.exec('xclip', args, { input: data, waitExit: true, ignoreOutput: true, timeout: 3000 });
      return;
    }
    if (sys.has('wl-copy')) {
      const wArgs = mime ? ['--type', mime] : [];
      await sys.exec('wl-copy', wArgs, { input: data, waitExit: true, ignoreOutput: true, timeout: 3000 });
      return;
    }
    if (sys.has('xsel')) {
      await sys.exec('xsel', ['--clipboard', '--input'], { input: data, waitExit: true, ignoreOutput: true, timeout: 3000 });
      return;
    }
    throw new Error(missingToolMessage(sess.isWayland ? 'wl-copy' : 'xclip'));
  }

  // -------------------------------------------------------------------------
  // Audio (pactl + PipeWire wpctl fallback + playerctl)
  // -------------------------------------------------------------------------
  async function pactl(args) {
    if (!sys.has('pactl')) throw new Error(missingToolMessage('pactl'));
    return sys.exec('pactl', args, { timeout: 3000 });
  }

  async function masterState() {
    if (sys.has('pactl')) {
      const [v, m] = await Promise.all([pactl(['get-sink-volume', '@DEFAULT_SINK@']), pactl(['get-sink-mute', '@DEFAULT_SINK@'])]);
      if (v.code === 0 && m.code === 0) return { volume: parsePactlVolume(v.stdout) ?? 0, muted: Boolean(parsePactlMute(m.stdout)) };
      // pactl < 14: no get-sink-* subcommands
      const info = await pactl(['info']);
      const def = (/Default Sink:\s*(\S+)/.exec(info.stdout) || [])[1] || '';
      const sinks = await pactl(['list', 'sinks']);
      const s = parsePactlSinks(sinks.stdout, def);
      if (s) return { volume: s.volume ?? 0, muted: s.muted };
    }
    // PipeWire WirePlumber native CLI fallback
    if (sys.has('wpctl')) {
      const r = await sys.exec('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'], { timeout: 2500 }).catch(() => null);
      if (r && r.code === 0) {
        const parsed = parseWpctlVolume(r.stdout);
        if (parsed) return parsed;
      }
    }
    if (!sys.has('pactl')) throw new Error(missingToolMessage('pactl'));
    throw new Error('Ses çıkışı bulunamadı (PulseAudio/PipeWire çalışıyor mu?)');
  }

  async function sinkInputs() {
    if (!sys.has('pactl')) return [];
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

  async function outputDevicesList() {
    if (!sys.has('pactl')) return [];
    const [infoRes, shortRes] = await Promise.all([
      pactl(['info']).catch(() => ({ code: 1, stdout: '' })),
      pactl(['list', 'short', 'sinks']).catch(() => ({ code: 1, stdout: '' }))
    ]);
    if (shortRes.code !== 0 || !shortRes.stdout) return [];
    const defSink = (/Default Sink:\s*(\S+)/.exec(infoRes.stdout || '') || [])[1] || '';
    const devices = [];
    for (const line of shortRes.stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.trim().split(/\t+/);
      const id = parts[1] || parts[0] || '';
      if (!id) continue;
      const friendly = id
        .replace(/^alsa_output\./, '')
        .replace(/^bluez_output\./, 'Bluetooth ')
        .replace(/\.analog-stereo$/, ' (Analog Stereo)')
        .replace(/\.hdmi-stereo.*$/, ' (HDMI)');
      devices.push({
        id,
        name: friendly || id,
        isDefault: Boolean(defSink && id === defSink)
      });
    }
    if (devices.length && !devices.some((d) => d.isDefault)) devices[0].isDefault = true;
    return devices;
  }

  async function micState() {
    if (sys.has('pactl')) {
      const [v, m] = await Promise.all([
        pactl(['get-source-volume', '@DEFAULT_SOURCE@']).catch(() => ({ code: 1, stdout: '' })),
        pactl(['get-source-mute', '@DEFAULT_SOURCE@']).catch(() => ({ code: 1, stdout: '' }))
      ]);
      if (v.code === 0 && m.code === 0 && v.stdout) {
        return {
          volume: parsePactlVolume(v.stdout) ?? 100,
          muted: Boolean(parsePactlMute(m.stdout)),
          hasMic: true
        };
      }
    }
    if (sys.has('wpctl')) {
      const r = await sys.exec('wpctl', ['get-volume', '@DEFAULT_AUDIO_SOURCE@'], { timeout: 2000 }).catch(() => null);
      if (r && r.code === 0) {
        const parsed = parseWpctlVolume(r.stdout);
        if (parsed) return { volume: parsed.volume, muted: parsed.muted, hasMic: true };
      }
    }
    return { volume: 100, muted: false, hasMic: false };
  }

  async function audioGet() {
    let master;
    try {
      master = await masterState();
    } catch (e) {
      return {
        masterVolume: 50,
        masterMuted: false,
        micVolume: 100,
        micMuted: false,
        hasMic: false,
        outputDevices: [],
        inputDevices: [],
        sessions: [],
        nowPlaying: { ...NOT_PLAYING, appName: 'PC' },
        warning: e.message
      };
    }
    const [sessions, outputDevices, mic] = await Promise.all([
      sinkInputs().catch(() => []),
      outputDevicesList().catch(() => []),
      micState().catch(() => ({ volume: 100, muted: false, hasMic: false }))
    ]);
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
    // Continuous elapsed time tracking for live streams or players that report 0 position/duration
    if (nowPlaying.active) {
      const trackKey = `${nowPlaying.processName}|${nowPlaying.title}`;
      const nowMs = sys.now();
      if (nowPlaying.durationSec > 0 && nowPlaying.positionSec > 0) {
        st.fallbackTrackKey = trackKey;
        st.fallbackPosSec = nowPlaying.positionSec;
        st.fallbackLastTs = nowMs;
      } else {
        if (st.fallbackTrackKey !== trackKey) {
          st.fallbackTrackKey = trackKey;
          st.fallbackPosSec = nowPlaying.positionSec > 0 ? nowPlaying.positionSec : 0;
          st.fallbackLastTs = nowMs;
        } else if (nowPlaying.isPlaying && st.fallbackLastTs > 0) {
          const dt = Math.max(0, (nowMs - st.fallbackLastTs) / 1000);
          if (dt < 60) st.fallbackPosSec += dt;
          if (nowPlaying.durationSec > 0 && st.fallbackPosSec > nowPlaying.durationSec) {
            st.fallbackPosSec = nowPlaying.durationSec;
          }
          st.fallbackLastTs = nowMs;
        } else {
          st.fallbackLastTs = nowMs;
        }
        if (nowPlaying.positionSec <= 0 && st.fallbackPosSec > 0) {
          nowPlaying.positionSec = Math.round(st.fallbackPosSec * 10) / 10;
        }
      }
    }
    return {
      masterVolume: master.volume,
      masterMuted: master.muted,
      micVolume: mic.volume,
      micMuted: mic.muted,
      hasMic: mic.hasMic,
      outputDevices,
      inputDevices: [],
      sessions,
      nowPlaying
    };
  }

  async function audioControl(args) {
    const action = String(args.action || 'get');
    if (action === 'media_command') {
      await mediaCommand(args.key);
    } else if (action === 'seek') {
      const sec = num(args.positionSec !== undefined ? args.positionSec : args.position, 0);
      const pick = await currentPlayer();
      if (pick) await sys.exec('playerctl', ['-p', pick.player, 'position', String(Math.max(0, sec))], { timeout: 2000 }).catch(() => {});
    } else if (action === 'set_default_device') {
      const devId = String(args.deviceId || '').trim();
      if (devId && sys.has('pactl')) {
        await pactl(['set-default-sink', devId]).catch(() => {});
      }
    } else if (action === 'set_mic_mute' || action === 'set_mic') {
      if (sys.has('pactl')) {
        if (args.volume !== undefined) {
          await pactl(['set-source-volume', '@DEFAULT_SOURCE@', clamp(Math.round(num(args.volume, 100)), 0, 100) + '%']).catch(() => {});
        }
        if (args.muted !== undefined) {
          await pactl(['set-source-mute', '@DEFAULT_SOURCE@', args.muted ? '1' : '0']).catch(() => {});
        } else if (action === 'set_mic_mute') {
          await pactl(['set-source-mute', '@DEFAULT_SOURCE@', 'toggle']).catch(() => {});
        }
      } else if (sys.has('wpctl')) {
        if (args.volume !== undefined) {
          await sys.exec('wpctl', ['set-volume', '@DEFAULT_AUDIO_SOURCE@', clamp(Math.round(num(args.volume, 100)), 0, 100) + '%'], { timeout: 2500 }).catch(() => {});
        }
        if (args.muted !== undefined) {
          await sys.exec('wpctl', ['set-mute', '@DEFAULT_AUDIO_SOURCE@', args.muted ? '1' : '0'], { timeout: 2500 }).catch(() => {});
        } else if (action === 'set_mic_mute') {
          await sys.exec('wpctl', ['set-mute', '@DEFAULT_AUDIO_SOURCE@', 'toggle'], { timeout: 2500 }).catch(() => {});
        }
      }
    } else if (action === 'set_master') {
      if (sys.has('pactl')) {
        if (args.volume !== undefined) await execOk(sys, 'pactl', ['set-sink-volume', '@DEFAULT_SINK@', clamp(Math.round(num(args.volume, 50)), 0, 100) + '%'], { timeout: 3000 });
        if (args.muted !== undefined) await execOk(sys, 'pactl', ['set-sink-mute', '@DEFAULT_SINK@', args.muted ? '1' : '0'], { timeout: 3000 });
      } else if (sys.has('wpctl')) {
        if (args.volume !== undefined) await execOk(sys, 'wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', clamp(Math.round(num(args.volume, 50)), 0, 100) + '%'], { timeout: 3000 });
        if (args.muted !== undefined) await execOk(sys, 'wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', args.muted ? '1' : '0'], { timeout: 3000 });
      }
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

  async function getProcessesList() {
    if (!sys.has('ps')) return [];
    const r = await sys.exec('ps', ['-eo', 'pid,comm,rss', '--sort=-rss'], { timeout: 2500 }).catch(() => null);
    if (!r || r.code !== 0 || !r.stdout) return [];
    const list = [];
    const lines = r.stdout.trim().split('\n').slice(1);
    for (const line of lines) {
      if (list.length >= 25) break;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const pid = parseInt(parts[0], 10);
      const name = parts[1] || '';
      const rssKb = parseInt(parts[2], 10) || 0;
      const memoryMb = Math.round((rssKb / 1024) * 10) / 10;
      if (!pid || pid <= 2 || !name || memoryMb < 10) continue;
      list.push({
        pid,
        name,
        title: name,
        hasWindow: false,
        memoryMb,
        responding: true
      });
    }
    return list;
  }

  async function killProcessById(args) {
    const pid = num(args.pid, 0);
    if (pid <= 2) return { ok: false, error: 'Geçersiz PID', processes: await getProcessesList() };
    if (sys.has('kill')) {
      await sys.exec('kill', ['-9', String(pid)], { timeout: 2000 }).catch(() => {});
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    return { ok: true, killedPid: pid, processes: await getProcessesList() };
  }

  async function wirelessControl(args) {
    const action = String(args.action || 'status');
    const hasNmcli = sys.has('nmcli');

    if (action === 'wifi_toggle' && hasNmcli) {
      const en = args.enabled === undefined ? true : Boolean(args.enabled);
      await sys.exec('nmcli', ['radio', 'wifi', en ? 'on' : 'off'], { timeout: 4000 }).catch(() => {});
    } else if (action === 'wifi_connect' && hasNmcli) {
      const ssid = String(args.ssid || '').trim();
      const pass = String(args.password || '');
      if (ssid) {
        const cmdArgs = ['device', 'wifi', 'connect', ssid, ...(pass ? ['password', pass] : [])];
        await sys.exec('nmcli', cmdArgs, { timeout: 8000 }).catch(() => {});
      }
    } else if (action === 'wifi_disconnect' && hasNmcli) {
      const devRes = await sys.exec('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'device'], { timeout: 2500 }).catch(() => null);
      if (devRes && devRes.stdout) {
        for (const l of devRes.stdout.trim().split('\n')) {
          const [dev, type, state] = l.split(':');
          if (type === 'wifi' && state === 'connected' && dev) {
            await sys.exec('nmcli', ['device', 'disconnect', dev], { timeout: 3000 }).catch(() => {});
          }
        }
      }
    } else if (action === 'hotspot_toggle' && hasNmcli) {
      const en = args.enabled === undefined ? true : Boolean(args.enabled);
      if (en) {
        const ssid = String(args.ssid || sys.hostname() + '-Hotspot');
        const pass = String(args.password || 'bridge1234');
        await sys.exec('nmcli', ['device', 'wifi', 'hotspot', 'ssid', ssid, 'password', pass], { timeout: 6000 }).catch(() => {});
      } else {
        await sys.exec('nmcli', ['connection', 'down', 'Hotspot'], { timeout: 4000 }).catch(() => {});
      }
    } else if (action === 'bt_toggle') {
      const en = args.enabled === undefined ? true : Boolean(args.enabled);
      if (sys.has('rfkill')) {
        await sys.exec('rfkill', [en ? 'unblock' : 'block', 'bluetooth'], { timeout: 3000 }).catch(() => {});
      }
      if (sys.has('bluetoothctl')) {
        await sys.exec('bluetoothctl', ['power', en ? 'on' : 'off'], { timeout: 3000 }).catch(() => {});
      }
    }

    let wifiEnabled = false;
    let wifiConnected = false;
    let wifiSsid = '';
    let wifiSignal = 0;
    let hotspotEnabled = false;
    let networks = null;

    if (hasNmcli) {
      const radioRes = await sys.exec('nmcli', ['radio', 'wifi'], { timeout: 2000 }).catch(() => null);
      if (radioRes && radioRes.stdout) {
        wifiEnabled = radioRes.stdout.trim().toLowerCase() === 'enabled';
      }
      const listRes = await sys.exec('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', action === 'wifi_scan' ? 'yes' : 'no'], { timeout: 4500 }).catch(() => null);
      const scanned = [];
      if (listRes && listRes.stdout) {
        for (const rawLine of listRes.stdout.trim().split('\n')) {
          if (!rawLine.trim()) continue;
          const parts = rawLine.split(':');
          if (parts.length < 4) continue;
          const inUse = parts[0].trim() === '*';
          const ssid = parts[1].trim();
          const sig = parseInt(parts[2], 10) || 0;
          const sec = parts.slice(3).join(':').trim() || 'Open';
          if (!ssid) continue;
          if (inUse) {
            wifiConnected = true;
            wifiSsid = ssid;
            wifiSignal = sig;
          }
          if (!scanned.some((n) => n.ssid === ssid)) {
            scanned.push({ ssid, signal: sig, security: sec, isSaved: inUse, isConnected: inUse });
          }
        }
      }
      if (action === 'wifi_scan') networks = scanned;
      const conRes = await sys.exec('nmcli', ['-t', '-f', 'NAME,TYPE', 'connection', 'show', '--active'], { timeout: 2000 }).catch(() => null);
      if (conRes && conRes.stdout && /hotspot/i.test(conRes.stdout)) {
        hotspotEnabled = true;
      }
    }

    let btSupported = sys.has('bluetoothctl') || sys.has('rfkill');
    let btEnabled = false;
    if (sys.has('rfkill')) {
      const rfRes = await sys.exec('rfkill', ['list', 'bluetooth'], { timeout: 2000 }).catch(() => null);
      if (rfRes && rfRes.stdout) {
        btSupported = true;
        btEnabled = !/Soft blocked:\s*yes/i.test(rfRes.stdout);
      }
    }

    return {
      ok: true,
      action,
      wifi: {
        supported: hasNmcli,
        enabled: wifiEnabled,
        connected: wifiConnected,
        ssid: wifiSsid,
        signal: wifiSignal,
        radioType: '802.11'
      },
      hotspot: {
        supported: hasNmcli,
        enabled: hotspotEnabled,
        ssid: sys.hostname() + '-Hotspot',
        clients: 0
      },
      bluetooth: {
        supported: btSupported,
        enabled: btEnabled,
        devices: []
      },
      networks
    };
  }

  function openTaskManager() {
    for (const app of ['gnome-system-monitor', 'plasma-systemmonitor', 'ksysguard', 'mate-system-monitor', 'xfce4-taskmanager', 'lxtask']) {
      if (sys.has(app)) return sys.spawnDetached(app, []);
    }
    for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'kitty', 'alacritty', 'foot', 'wezterm', 'xterm']) {
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
      case 'get_processes':
        return { ok: true, processes: await getProcessesList() };
      case 'kill_process':
        return killProcessById(args);
      default:
        return stats();
    }
  }

  loadHistory();
  let clipTimer = null;
  function startClipboardWatch() {
    if (clipTimer || !hasClipboardTool()) return;
    clipTimer = setInterval(() => pollClipboard().catch(() => {}), 2000);
    if (clipTimer.unref) clipTimer.unref();
  }

  return { st, systemControl, audioControl, wirelessControl, audioGet, stats, mediaCommand, openTaskManager, startClipboardWatch, historyFile, dryRun };
}

module.exports = { createSystem, NOT_PLAYING };
