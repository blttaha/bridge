// Unit test: system buttons follow the per-PC function preferences (mock bridge, no real power actions).
//   node tests/windows/function-prefs.test.js
const fs = require('fs');
const src = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '..', '..', 'pc-agent', 'server.js'), 'utf8');
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  let start = src.lastIndexOf('\n', i) + 1;
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(start, k + 1); } }
}
const optsStart = src.indexOf('const FUNCTION_PREF_OPTIONS');
const optsEnd = src.indexOf('};', optsStart) + 2;
const code = [src.slice(optsStart, optsEnd), 'sanitizeFunctionPrefs', 'setMonitorsOff', 'runMonitorPower', 'runLockAction', 'runSystemControl', 'runAudioControl']
  .map((n) => (n.startsWith('const') ? n : grab(n))).join('\n');
const calls = [];
let customLocked = false;
const bridge = {
  call: async (a, p) => {
    calls.push(a + ' ' + JSON.stringify(p));
    if (a === 'get_monitors') return [{}, {}];
    if (a === 'monitor_blackout') return [{ b: 1 }, { b: 1 }];
    if (a === 'system_control' && p.action === 'stats') return { isLocked: customLocked };
    if (a === 'system_control' && p.action === 'lock') { customLocked = true; return { isLocked: true }; }
    if (a === 'system_control' && p.action === 'unlock') { customLocked = false; return { isLocked: false }; }
    return { ok: true };
  }
};
let cmdOk = true;
const make = new Function('bridge', 'spawnCalls', 'state', code + `
  async function runSystemCommand(f, a) { spawnCalls.push(f + ' ' + a.join(' ')); return state.cmdOk; }
  return { sanitizeFunctionPrefs, runMonitorPower, runSystemControl, runAudioControl, setPrefs: (p) => { functionPrefs = sanitizeFunctionPrefs(p); }, get prefs() { return functionPrefs; } };
`.replace('async function runSystemCommand', 'var functionPrefs; var IS_WINDOWS = true; async function runSystemCommand'));
const spawnCalls = [];
const st = { cmdOk: true };
const m = make(bridge, spawnCalls, st);
const assert = require('assert');
(async () => {
  const check = async (prefs, fn, expectCalls, expectSpawn = []) => {
    calls.length = 0; spawnCalls.length = 0;
    m.setPrefs(prefs);
    const r = await fn();
    assert.deepStrictEqual(calls.filter((c) => !c.startsWith('get_monitors')), expectCalls, JSON.stringify(prefs));
    assert.deepStrictEqual(spawnCalls, expectSpawn, JSON.stringify(prefs));
    return r;
  };
  assert.deepStrictEqual(m.sanitizeFunctionPrefs({ lock: 'evil', sleep: 'hibernate', x: 1 }).lock, 'custom');
  assert.strictEqual(m.sanitizeFunctionPrefs({ sleep: 'hibernate' }).sleep, 'hibernate');
  assert.strictEqual(Object.keys(m.sanitizeFunctionPrefs({ x: 1 })).includes('x'), false);
  await check({}, () => m.runSystemControl({ action: 'toggle_lock' }), ['system_control {"action":"toggle_lock"}']);
  let r = await check({ lock: 'windows' }, () => m.runSystemControl({ action: 'toggle_lock' }), ['system_control {"action":"stats"}'], ['rundll32.exe user32.dll,LockWorkStation']);
  assert.strictEqual(r.isLocked, false); assert.ok(r.message);
  customLocked = true;
  r = await check({ lock: 'windows' }, () => m.runSystemControl({ action: 'toggle_lock' }), ['system_control {"action":"stats"}', 'system_control {"action":"unlock"}']);
  assert.strictEqual(r.isLocked, false);
  r = await check({ lock: 'both' }, () => m.runSystemControl({ action: 'toggle_lock' }), ['system_control {"action":"stats"}', 'system_control {"action":"lock"}'], ['rundll32.exe user32.dll,LockWorkStation']);
  assert.strictEqual(r.isLocked, true);
  await check({ sleep: 'hibernate' }, () => m.runSystemControl({ action: 'sleep' }), ['system_control {"action":"hibernate"}']);
  await check({ sleep: 'monitors_off' }, () => m.runSystemControl({ action: 'sleep' }), ['monitor_power {"action":"off"}']);
  await check({ sleep: 'monitors_off', monitorsOff: 'blackout' }, () => m.runSystemControl({ action: 'sleep' }), ['monitor_blackout {"monitorIndex":0,"mode":"on"}', 'monitor_blackout {"monitorIndex":1,"mode":"on"}']);
  await check({ monitorsOff: 'blackout' }, () => m.runMonitorPower({ action: 'on' }), ['monitor_power {"action":"on","clearBlackouts":true}']);
  await check({}, () => m.runMonitorPower({ action: 'on', clearBlackouts: false }), ['monitor_power {"action":"on","clearBlackouts":false}']);
  await check({}, () => m.runSystemControl({ action: 'shutdown' }), ['system_control {"action":"shutdown"}']);
  await check({ shutdown: 'force' }, () => m.runSystemControl({ action: 'shutdown' }), [], ['shutdown.exe /s /f /t 0']);
  await check({ restart: 'force' }, () => m.runSystemControl({ action: 'restart' }), [], ['shutdown.exe /r /f /t 0']);
  st.cmdOk = false;
  await check({ shutdown: 'hybrid' }, () => m.runSystemControl({ action: 'shutdown' }), ['system_control {"action":"shutdown"}'], ['shutdown.exe /s /hybrid /t 0']);
  st.cmdOk = true;
  await check({ showDesktop: 'win_m' }, () => m.runSystemControl({ action: 'show_desktop' }), ['send_input {"type":"key","key":"WIN+M"}']);
  await check({}, () => m.runSystemControl({ action: 'show_desktop' }), ['system_control {"action":"show_desktop"}']);
  await check({ media: 'global' }, () => m.runSystemControl({ action: 'media_key', key: 'media_next' }), ['send_input {"type":"key","key":"MEDIA_NEXT"}']);
  await check({ media: 'global' }, () => m.runAudioControl({ action: 'media_command', key: 'MEDIA_PLAY_PAUSE' }), ['send_input {"type":"key","key":"MEDIA_PLAY_PAUSE"}', 'audio_control {"action":"get"}']);
  await check({}, () => m.runAudioControl({ action: 'media_command', key: 'MEDIA_PLAY_PAUSE' }), ['audio_control {"action":"media_command","key":"MEDIA_PLAY_PAUSE"}']);
  await check({}, () => m.runSystemControl({ action: 'set_brightness', level: 50 }), ['system_control {"action":"set_brightness","level":50}']);
  console.log('all dispatch checks passed');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
