// ais-relay.js — tiny helper for the motel streaming PC.
//
// Some AIS-catcher builds can only POST to plain http:// addresses.
// This script listens on localhost and forwards every POST to the
// Render server over HTTPS. Zero dependencies — plain Node.
//
// Usage:
//   node ais-relay.js <YOUR_LOCAL_AIS_KEY> [listenPort]
//
// Then point AIS-catcher at it:
//   AIS-catcher -d 0 -N 8100 -H http://localhost:8110 INTERVAL 5
//
// (Only needed if posting straight to
//  https://mackinac-ship-tracker.onrender.com/api/local-ais?key=... fails.)

const http = require('http');
const https = require('https');

const KEY = process.argv[2];
const LISTEN_PORT = parseInt(process.argv[3]) || 8110;
const TARGET_HOST = 'mackinac-ship-tracker.onrender.com';
const TARGET_PATH = '/api/local-ais';

if (!KEY) {
  console.error('Usage: node ais-relay.js <LOCAL_AIS_KEY> [listenPort]');
  process.exit(1);
}

http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(200); res.end('ais-relay running'); return; }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const fwd = https.request({
      hostname: TARGET_HOST,
      path: `${TARGET_PATH}?key=${encodeURIComponent(KEY)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
    }, fres => {
      let out = '';
      fres.on('data', d => out += d);
      fres.on('end', () => {
        if (fres.statusCode !== 200) console.error(`Server responded ${fres.statusCode}: ${out}`);
      });
    });
    fwd.on('error', err => console.error('Forward failed:', err.message));
    fwd.setTimeout(15000, () => fwd.destroy(new Error('timeout')));
    fwd.write(body);
    fwd.end();

    // Reply to AIS-catcher immediately — don't make it wait on Render
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
}).listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`ais-relay listening on http://localhost:${LISTEN_PORT}`);
  console.log(`forwarding to https://${TARGET_HOST}${TARGET_PATH}`);
});
