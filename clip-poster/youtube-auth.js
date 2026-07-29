/*
 * One-time YouTube authorization.
 * Run this ONCE (node youtube-auth.js) after you've placed your OAuth client file
 * as "credentials.json" in this folder (see POSTING-SETUP.md). It opens your browser,
 * you approve, and it saves "token.json" so the clip poster can upload on its own.
 */
import { authenticate } from '@google-cloud/local-auth';
import fs from 'node:fs';
import path from 'node:path';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];
const CRED = path.join(process.cwd(), 'credentials.json');
const TOKEN = path.join(process.cwd(), 'token.json');

if (!fs.existsSync(CRED)) {
  console.error('\n❌ credentials.json not found in this folder.');
  console.error('   Download your OAuth client from Google Cloud Console and save it here');
  console.error('   as "credentials.json" first — see POSTING-SETUP.md.\n');
  process.exit(1);
}

console.log('Opening your browser to authorize YouTube uploads…');
const client = await authenticate({ scopes: SCOPES, keyfilePath: CRED });

if (!client.credentials.refresh_token) {
  console.error('\n⚠️ No refresh token returned. In Google Cloud, remove this app\'s prior');
  console.error('   access at https://myaccount.google.com/permissions and run this again.\n');
  process.exit(1);
}

const keys = JSON.parse(fs.readFileSync(CRED, 'utf8'));
const key = keys.installed || keys.web;
fs.writeFileSync(TOKEN, JSON.stringify({
  type: 'authorized_user',
  client_id: key.client_id,
  client_secret: key.client_secret,
  refresh_token: client.credentials.refresh_token
}, null, 2));

console.log('\n✅ Saved token.json — YouTube posting is authorized.');
console.log('   You can close this and start the poster normally (node clip-poster.js).\n');
process.exit(0);
