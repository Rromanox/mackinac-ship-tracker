/*
 * One-time YouTube authorization (self-contained loopback OAuth flow).
 * Run: node youtube-auth.js   — needs credentials.json in this folder (see POSTING-SETUP.md).
 * Opens your browser, you approve, and it saves token.json so the poster can upload on its own.
 */
import { google } from 'googleapis';
import http from 'node:http';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];
const PORT = 3000;
const REDIRECT = `http://localhost:${PORT}`;
const CRED = path.join(process.cwd(), 'credentials.json');
const TOKEN = path.join(process.cwd(), 'token.json');

if (!fs.existsSync(CRED)) {
  console.error('\n❌ credentials.json not found in this folder — see POSTING-SETUP.md.\n');
  process.exit(1);
}
const keys = JSON.parse(fs.readFileSync(CRED, 'utf8'));
const key = keys.installed || keys.web;
if (!key || !key.client_id || !key.client_secret) {
  console.error('\n❌ credentials.json has no client_id/client_secret. Re-download the OAuth "Desktop app" JSON.\n');
  process.exit(1);
}

const oAuth2 = new google.auth.OAuth2(key.client_id, key.client_secret, REDIRECT);
const authUrl = oAuth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

const server = http.createServer(async (req, res) => {
  try {
    const code = new URL(req.url, REDIRECT).searchParams.get('code');
    if (!code) { res.end('Waiting for Google…'); return; }
    const { tokens } = await oAuth2.getToken(code);
    if (!tokens.refresh_token) {
      res.end('No refresh token returned — see the terminal.');
      console.error('\n⚠️ No refresh token. Revoke this app at https://myaccount.google.com/permissions and run again.\n');
      server.close(); return process.exit(1);
    }
    fs.writeFileSync(TOKEN, JSON.stringify({
      type: 'authorized_user', client_id: key.client_id, client_secret: key.client_secret,
      refresh_token: tokens.refresh_token
    }, null, 2));
    res.end('✅ Authorized! Close this tab and return to the terminal.');
    console.log('\n✅ Saved token.json — YouTube posting is authorized.');
    console.log('   Next: set YT_ENABLED=1 in .env, then run  node clip-poster.js\n');
    server.close(); setTimeout(() => process.exit(0), 200);
  } catch (e) {
    res.end('Error: ' + e.message);
    console.error('\n❌ Token exchange failed:', e.message, '\n');
    server.close(); process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('\nOpening your browser to authorize… if it doesn\'t open, paste this URL:\n');
  console.log(authUrl + '\n');
  const cmd = process.platform === 'win32' ? `start "" "${authUrl}"`
    : process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
  exec(cmd, { shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' }, () => {});
});
