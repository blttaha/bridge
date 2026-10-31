// Runs inside the sandbox: records Wake-on-LAN magic packets that arrive on UDP 9 / 7
const dgram = require('dgram');
const fs = require('fs');
for (const port of [9, 7]) {
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('message', (msg, rinfo) => {
    fs.appendFileSync('C:\\tb\\out\\wol.txt', JSON.stringify({ port, from: rinfo.address, len: msg.length, hex: msg.toString('hex') }) + '\n');
  });
  s.on('error', (e) => fs.appendFileSync('C:\\tb\\out\\wol.txt', JSON.stringify({ port, error: e.message }) + '\n'));
  s.bind(port, '0.0.0.0');
}
setTimeout(() => process.exit(0), 120000);
