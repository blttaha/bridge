#!/usr/bin/env node
// Linux replacement for the Windows tray app: pairing codes, session control and status from the terminal.
//   bridgectl pair              new 30 s pairing code (also shown as a desktop notification)
//   bridgectl disconnect  end every phone session (all phones must pair again)
//   bridgectl status          agent, tunnel and connected phones
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DATA_DIR =
  process.env.TAHABLT_DATA_DIR || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'bridge');
const PORT = Number(process.env.TAHABLT_PORT || 4850);

function readAdminKey() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, 'admin.key'), 'utf8').trim();
  } catch {
    return '';
  }
}

function adminPost(pathname, payloadObj = null) {
  return new Promise((resolve, reject) => {
    const bodyBuf = payloadObj ? Buffer.from(JSON.stringify(payloadObj), 'utf8') : Buffer.alloc(0);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: pathname,
        method: 'POST',
        timeout: 4000,
        headers: {
          'X-TahaBLT-Admin': readAdminKey(),
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.length
        }
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (res.statusCode !== 200) return reject(new Error(data.error || `HTTP ${res.statusCode}`));
            resolve(data);
          } catch {
            reject(new Error('Ajandan geçersiz yanıt'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Ajan yanıt vermedi')));
    req.on('error', (e) => reject(new Error(`Ajana bağlanılamadı (${e.message}). "systemctl --user start bridge-agent" ile başlatın.`)));
    if (bodyBuf.length > 0) req.write(bodyBuf);
    req.end();
  });
}

function hasBin(bin) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      const full = path.join(dir, bin);
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) return true;
    } catch {}
  }
  return false;
}

function copyToClipboard(text) {
  const candidates = process.env.WAYLAND_DISPLAY
    ? [
        ['wl-copy', []],
        ['xclip', ['-selection', 'clipboard']]
      ]
    : [
        ['xclip', ['-selection', 'clipboard']],
        ['wl-copy', []]
      ];
  for (const [bin, args] of candidates) {
    if (!hasBin(bin)) continue;
    try {
      const p = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
      p.on('error', () => {});
      if (p.stdin) {
        p.stdin.on('error', () => {});
        p.stdin.end(String(text));
      }
      p.unref();
      return;
    } catch {}
  }
}

function notify(title, text) {
  try {
    const iconSvg = path.join(__dirname, 'bridge-icon.svg');
    const iconArg = fs.existsSync(iconSvg) ? iconSvg : 'bridge';
    const p = spawn('notify-send', ['-a', 'Bridge', '-i', iconArg, '-t', '30000', title, text], { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch {}
}

function readRuntimeStatus() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runtime-status.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'pair') {
    const res = await adminPost('/api/pair/rotate');
    copyToClipboard(res.pin);
    console.log(`Eşleştirme kodu: ${res.pin}  (30 saniye geçerli - Panoya kopyalandı)`);
    notify('Eşleştirme kodu', `${res.pin} — telefondaki Bridge uygulamasına girin (30 sn)`);
    return;
  }
  if (cmd === 'disconnect') {
    const res = await adminPost('/api/sessions/disconnect');
    console.log(`Tüm oturumlar sonlandırıldı (${res.disconnectedCount || 0} bağlı telefon).`);
    return;
  }
  if (cmd === 'devices') {
    const st = readRuntimeStatus();
    const list = st && Array.isArray(st.pairedDevices) ? st.pairedDevices : [];
    if (!list.length) {
      console.log('Eşleştirilmiş cihaz bulunmuyor.');
      return;
    }
    console.log(`Eşleştirilmiş Cihazlar (${list.length}):`);
    for (const d of list) {
      const stateStr = d.online ? 'Çevrimiçi (Aktif)' : 'Çevrimdışı (Eşli)';
      console.log(`  - ${d.clientName || 'Mobil Cihaz'} [${stateStr}]`);
      console.log(`    ID: ${d.id} | IP: ${d.ip || '-'} | Son Görülme: ${d.lastSeenAt || '-'}`);
    }
    return;
  }
  if (cmd === 'revoke') {
    const target = (process.argv[3] || '').trim();
    if (!target) {
      console.error('Kullanım: bridgectl revoke <cihaz_id_veya_isim>');
      process.exitCode = 2;
      return;
    }
    const st = readRuntimeStatus();
    const list = st && Array.isArray(st.pairedDevices) ? st.pairedDevices : [];
    const match = list.find(
      (d) =>
        d.id === target ||
        String(d.id || '').startsWith(target) ||
        String(d.clientName || '').toLowerCase() === target.toLowerCase()
    );
    const deviceId = match ? match.id : target;
    await adminPost('/api/devices/revoke', { deviceId });
    console.log(`Cihaz eşleştirmesi iptal edildi: ${match ? `${match.clientName} (${match.id})` : deviceId}`);
    return;
  }
  if (cmd === 'status') {
    const st = readRuntimeStatus();
    if (!st) {
      console.log('Ajan henüz çalışmadı.');
      return;
    }
    const pairedCount = Array.isArray(st.pairedDevices) ? st.pairedDevices.length : 0;
    console.log(`Cihaz      : ${st.deviceName}`);
    console.log(`Yerel ağ   : ${(st.lanIps || [st.lanIp]).join(', ')}:${st.port}`);
    console.log(`Tünel      : ${st.tunnelUrl || '(yok)'}`);
    console.log(`Eşli Cihaz : ${pairedCount} cihaz (${st.connectedClients || 0} aktif bağlı)`);
    console.log(`Güncelleme : ${st.updatedAt}`);
    return;
  }
  if (cmd === 'restart') {
    const { execSync } = require('child_process');
    try {
      execSync('systemctl --user restart bridge-agent.service', { stdio: 'inherit' });
      console.log('Bridge servisi yeniden başlatıldı.');
    } catch (e) {
      console.error('Servis yeniden başlatılamadı:', e.message);
    }
    return;
  }
  if (cmd === 'logs') {
    const { spawn } = require('child_process');
    const p = spawn('journalctl', ['--user', '-u', 'bridge-agent.service', '-f', '-n', '50'], { stdio: 'inherit' });
    p.on('error', (e) => console.error('Loglar açılamadı:', e.message));
    return;
  }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }
  printHelp();
  process.exitCode = 2;
}

function printHelp() {
  console.log(`
Bridge — Linux Yönetim Aracı

Kullanım:
  bridgectl [komut]

Komutlar:
  pair              30 saniyelik yeni eşleştirme kodu üretir, panoya kopyalar
                    ve masaüstü bildirimi olarak ekranda gösterir.
  status            Sunucu durumu, yerel IP, port, tünel adresi ve bağlantıları listeler.
  devices           Eşleştirilmiş tüm telefonları ve çevrimiçi/çevrimdışı durumlarını listeler.
  revoke <id/isim>  Belirtilen telefonun eşleştirmesini iptal eder.
  disconnect        Tüm bağlı telefonların oturumunu anında sonlandırır.
  restart           Arka plandaki Bridge servisini yeniden başlatır.
  logs              Servisin canlı sistem loglarını ekrana döker (journalctl).
  help, --help, -h  Bu yardım menüsünü görüntüler.
`);
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
