#!/usr/bin/env node
// Builds Bridge-Linux.tar.gz at the repository root with only what the Linux agent needs at runtime
// (no tests, no Windows binaries, no build scripts). Run after `npm install --omit=dev` in pc-agent:
//   node pc-agent/linux/build-package.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const AGENT = path.resolve(__dirname, '..');
const ROOT = path.resolve(AGENT, '..');
const OUT = path.join(ROOT, 'Bridge-Linux.tar.gz');

const RUNTIME_FILES = [
  'server.js',
  'package.json',
  'package-lock.json',
  'linux/bridge.js',
  'linux/desktop.js',
  'linux/input.js',
  'linux/parsers.js',
  'linux/protocol.js',
  'linux/stream.js',
  'linux/system.js',
  'linux/util.js',
  'linux/bridgectl.js',
  'linux/install.sh',
  'linux/bridge-agent.service',
  'linux/bridge-icon.svg',
  'linux/bridge-icon.png'
];

// Scripts and units must have LF endings on Linux, whatever the Windows checkout did to them
const LF_ONLY = /\.(sh|service|js|json|svg)$/;

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  let data = fs.readFileSync(src);
  if (LF_ONLY.test(src)) data = Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  fs.writeFileSync(dst, data);
}

function copyDir(src, dst) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

const ws = path.join(AGENT, 'node_modules', 'ws');
if (!fs.existsSync(ws)) {
  console.error('pc-agent/node_modules/ws yok: önce "npm install --omit=dev" çalıştırın.');
  process.exit(1);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-linux-'));
try {
  for (const rel of RUNTIME_FILES) copyFile(path.join(AGENT, rel), path.join(stage, 'pc-agent', rel));
  // Bundled so installation works offline and without npm
  copyDir(ws, path.join(stage, 'pc-agent', 'node_modules', 'ws'));
  fs.writeFileSync(
    path.join(stage, 'install.sh'),
    '#!/usr/bin/env bash\nset -euo pipefail\nDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nexec bash "${DIR}/pc-agent/linux/install.sh" "$@"\n'
  );
  for (const exe of ['install.sh', 'pc-agent/linux/install.sh', 'pc-agent/linux/bridgectl.js']) {
    fs.chmodSync(path.join(stage, exe), 0o755);
  }
  // Relative paths with cwd=stage: GNU tar reads "C:\..." as a remote host name
  const tarArgs = ['-czf', 'package.tar.gz', 'install.sh', 'pc-agent'];
  try {
    // --mode keeps the scripts executable even when the staging filesystem has no Unix permissions (Windows)
    execFileSync('tar', ['--owner=0', '--group=0', '--mode=u+rwX,go+rX', ...tarArgs], { cwd: stage, stdio: 'pipe' });
  } catch {
    execFileSync('tar', tarArgs, { cwd: stage, stdio: 'inherit' }); // bsdtar has no GNU-only options
  }
  const listing = execFileSync('tar', ['-tzf', 'package.tar.gz'], { cwd: stage }).toString().trim().split('\n');
  fs.copyFileSync(path.join(stage, 'package.tar.gz'), OUT);
  console.log(`${path.basename(OUT)}: ${listing.length} dosya, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
