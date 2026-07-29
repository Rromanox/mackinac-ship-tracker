/*
 * Mackinac Clip Poster — Phase 1: capture + render
 * Copyright (c) 2026 Kevin Salazar Fernandes. All rights reserved.
 *
 * Runs on the LOCAL machine that runs OBS. Listens to the ship-tracker server's
 * WebSocket; when a vessel passes the bridge it saves the OBS replay buffer,
 * checks the clip is bright enough, renders a vertical 9:16 Short (blur-pad so the
 * boat is never cropped, name + fun-fact burned in, narration ducked over the live
 * ambient), and drops the finished mp4 + metadata into ./clips.
 *
 * Auto-posting to YouTube is Phase 2 (added once OAuth is set up).
 *
 * Run:  npm start           (waits for real passings)
 *       npm run test-clip   (saves + renders the current buffer right now)
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import OBSWebSocket from 'obs-websocket-js';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';

const CFG = {
  serverWs:   process.env.SERVER_WS   || 'wss://mackinac-ship-tracker.onrender.com',
  serverHttp: process.env.SERVER_HTTP || 'https://mackinac-ship-tracker.onrender.com',
  obsUrl:     process.env.OBS_URL     || 'ws://127.0.0.1:4455',
  obsPass:    process.env.OBS_PASSWORD || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  outDir:     process.env.OUTPUT_DIR  || './clips',
  fontFile:   process.env.FONT_FILE   || 'C:/Windows/Fonts/arialbd.ttf',
  clipSeconds:  +(process.env.CLIP_SECONDS || 32),
  saveDelayMs:  +(process.env.SAVE_DELAY_MS || 6000),
  minBright:    +(process.env.QUALITY_MIN_BRIGHTNESS || 45),
  ambientVol:   +(process.env.AMBIENT_VOLUME || 0.30),
  narrationVol: +(process.env.NARRATION_VOLUME || 1.40),
  ytEnabled:  process.env.YT_ENABLED === '1',
  ytPrivacy:  process.env.YT_PRIVACY || 'private',
  ytCategory: process.env.YT_CATEGORY || '19',
  morningHM:  process.env.MORNING_SLOT || '08:30',
  eveningHM:  process.env.EVENING_SLOT || '18:30'
};
const TEST_MODE = process.argv.includes('--test');

const tmpDir = path.join(CFG.outDir, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

// ── shared state populated from the server feed ──────────────────
const staticInfo = {};   // mmsi -> { name, lengthM, flag }
const narrationUrl = {}; // mmsi -> absolute mp3 url
let factsByName = null;   // normalised vessel name -> [facts]
const lastClipAt = {};    // mmsi -> ts (debounce)

const anthropic = CFG.anthropicKey ? new Anthropic({ apiKey: CFG.anthropicKey }) : null;
const obs = new OBSWebSocket();

// ── tiny helpers ─────────────────────────────────────────────────
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const normName = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Maritime Identification Digits → flag (Great Lakes–relevant subset)
const MID = { '316':'🇨🇦', '366':'🇺🇸','367':'🇺🇸','368':'🇺🇸','369':'🇺🇸','338':'🇺🇸',
  '311':'🇧🇸','309':'🇧🇸','308':'🇧🇸','305':'🇦🇬','249':'🇲🇹','248':'🇲🇹','draft':'' };
const flagFromMmsi = m => MID[String(m).slice(0, 3)] || '';

async function loadFacts() {
  try {
    const r = await fetch(CFG.serverHttp + '/api/vessel-facts');
    const j = await r.json();
    const list = Array.isArray(j) ? j : (j.vessels || Object.values(j));
    factsByName = {};
    list.forEach(v => { if (v && v.name) factsByName[normName(v.name)] = v.facts || (v.fact ? [v.fact] : []); });
    log(`loaded facts for ${Object.keys(factsByName).length} vessels`);
  } catch (e) { log('could not load facts:', e.message); factsByName = {}; }
}
function pickFact(name) {
  const pool = (factsByName && factsByName[normName(name)]) || [];
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : '';
}

// ── server WebSocket (trigger + metadata) ────────────────────────
function connectServer() {
  const ws = new WebSocket(CFG.serverWs);
  ws.on('open', () => log('server WS connected'));
  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.type === 'ship_data' && m.data) {
      const d = m.data, meta = d.MetaData || {};
      const mmsi = meta.MMSI;
      if (!mmsi) return;
      staticInfo[mmsi] = staticInfo[mmsi] || {};
      if (meta.ShipName) staticInfo[mmsi].name = meta.ShipName.trim();
      staticInfo[mmsi].flag = flagFromMmsi(mmsi);
      const sd = d.Message && d.Message.ShipStaticData;
      if (sd && sd.Dimension) staticInfo[mmsi].lengthM = (sd.Dimension.A || 0) + (sd.Dimension.B || 0);
    } else if (m.type === 'narrate' && m.data && m.data.mmsi) {
      narrationUrl[m.data.mmsi] = CFG.serverHttp + m.data.url;
    } else if (m.type === 'bridge_passing' && m.data) {
      handlePassing(m.data).catch(e => log('passing error:', e.message));
    }
  });
  ws.on('close', () => { log('server WS closed, retrying in 3s'); setTimeout(connectServer, 3000); });
  ws.on('error', () => { try { ws.close(); } catch {} });
}

// ── OBS connection + replay buffer ───────────────────────────────
async function connectObs() {
  try {
    await obs.connect(CFG.obsUrl, CFG.obsPass || undefined);
    log('OBS connected');
    try {
      const { outputActive } = await obs.call('GetReplayBufferStatus');
      if (!outputActive) { await obs.call('StartReplayBuffer'); log('started replay buffer'); }
    } catch (e) { log('replay buffer check failed (is it enabled in OBS?):', e.message); }
  } catch (e) {
    log('OBS connect failed, retrying in 5s:', e.message);
    setTimeout(connectObs, 5000);
  }
}
obs.on('ConnectionClosed', () => { log('OBS disconnected, reconnecting in 5s'); setTimeout(connectObs, 5000); });

function saveReplay() {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { obs.off('ReplayBufferSaved', h); reject(new Error('replay save timed out')); }, 20000);
    const h = ({ savedReplayPath }) => { clearTimeout(to); obs.off('ReplayBufferSaved', h); resolve(savedReplayPath); };
    obs.on('ReplayBufferSaved', h);
    obs.call('SaveReplayBuffer').catch(err => { clearTimeout(to); obs.off('ReplayBufferSaved', h); reject(err); });
  });
}

// ── ffmpeg helpers ───────────────────────────────────────────────
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(err) : reject(new Error(cmd + ' exited ' + code + '\n' + err.slice(-800))));
  });
}
// Average luma (0-255) across the clip — cheap night/fog gate.
function avgBrightness(file) {
  return new Promise(resolve => {
    const p = spawn('ffmpeg', ['-i', file, '-vf', 'signalstats,metadata=print', '-an', '-f', 'null', '-']);
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', () => resolve(-1));
    p.on('close', () => {
      const vals = [...err.matchAll(/YAVG:([\d.]+)/g)].map(x => +x[1]);
      resolve(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
    });
  });
}
// wrap text to ~n chars per line on word boundaries
function wrap(text, n) {
  const words = String(text).split(/\s+/); const lines = []; let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > n) { if (line) lines.push(line); line = w; }
    else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines.join('\n');
}
const escFilterPath = p => p.replace(/\\/g, '/').replace(/:/g, '\\:');

async function render({ srcVideo, narration, name, fact, outPath }) {
  // caption text files (avoids ffmpeg text-escaping headaches)
  const nameTxt = path.join(tmpDir, 'name.txt');
  const factTxt = path.join(tmpDir, 'fact.txt');
  fs.writeFileSync(nameTxt, name.toUpperCase());
  fs.writeFileSync(factTxt, wrap(fact, 30));
  const font = escFilterPath(CFG.fontFile);
  const nameF = escFilterPath(nameTxt), factF = escFilterPath(factTxt);

  const vf = [
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:4,eq=brightness=-0.05[bg]`,
    `[0:v]scale=1080:-2[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`,
    `[base]drawtext=fontfile='${font}':textfile='${nameF}':fontsize=66:fontcolor=white:borderw=4:bordercolor=black@0.85:x=(w-text_w)/2:y=h-430,` +
      `drawtext=fontfile='${font}':textfile='${factF}':fontsize=40:fontcolor=white:borderw=3:bordercolor=black@0.85:line_spacing=10:x=(w-text_w)/2:y=h-330[v]`
  ].join(';');

  const args = ['-y', '-t', String(CFG.clipSeconds), '-i', srcVideo];
  if (narration) args.push('-i', narration);
  args.push('-filter_complex', vf, '-map', '[v]');

  if (narration) {
    // duck the live ambient under the narration
    const af = `[0:a]volume=${CFG.ambientVol}[amb];[1:a]volume=${CFG.narrationVol}[nar];` +
      `[amb][nar]amix=inputs=2:duration=longest:dropout_transition=3[a]`;
    args.push('-filter_complex', af, '-map', '[a]');
  } else {
    args.push('-map', '0:a?');
  }
  args.push('-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
    '-t', String(CFG.clipSeconds), outPath);
  await run('ffmpeg', args);
}

// ── Haiku-written title + description ────────────────────────────
async function writeTitle({ name, fact, flag, lengthM }) {
  const fallback = {
    title: `${name} passes under the Mackinac Bridge 🚢 #Shorts`,
    description: `${name} crossing the Straits of Mackinac.${fact ? ' ' + fact : ''}\n\n#Shorts #GreatLakes #MackinacBridge #ships #freighter`
  };
  if (!anthropic) return fallback;
  try {
    const sys = 'You write short, punchy YouTube Shorts metadata for a live Great Lakes ship-cam. ' +
      'Return STRICT JSON {"title": "...", "description": "..."} and nothing else. ' +
      'Title: <=90 chars, a scroll-stopping hook + the ship name, end with #Shorts, at most one emoji. ' +
      'Description: 1-2 lively sentences using the fact, then 4-6 relevant hashtags on a new line. No clickbait lies.';
    const facts = [`Ship: ${name}`, lengthM ? `Length: ~${Math.round(lengthM)} m` : '', flag ? `Flag: ${flag}` : '',
      fact ? `Fun fact: ${fact}` : ''].filter(Boolean).join('\n');
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 400,
      messages: [{ role: 'user', content: sys + '\n\n' + facts }]
    });
    const text = (msg.content.find(c => c.type === 'text') || {}).text || '';
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return { title: j.title || fallback.title, description: j.description || fallback.description };
  } catch (e) { log('Haiku title failed, using fallback:', e.message); return fallback; }
}

// ── the pipeline for one passing ─────────────────────────────────
async function handlePassing(data) {
  const mmsi = data.mmsi;
  const now = Date.now();
  if (lastClipAt[mmsi] && now - lastClipAt[mmsi] < 90000) return; // debounce
  lastClipAt[mmsi] = now;

  const info = staticInfo[mmsi] || {};
  const name = (data.name || info.name || 'Unknown Vessel').trim();
  log(`🚢 passing: ${name} (${mmsi}) — clipping in ${CFG.saveDelayMs / 1000}s`);

  await new Promise(r => setTimeout(r, CFG.saveDelayMs)); // let the crossing settle near clip end

  let saved;
  try { saved = await saveReplay(); } catch (e) { return log('  replay save failed:', e.message); }
  log('  saved replay:', saved);

  const bright = await avgBrightness(saved);
  if (bright >= 0 && bright < CFG.minBright) {
    return log(`  ✗ rejected: too dark (brightness ${bright.toFixed(0)} < ${CFG.minBright}) — likely night/fog`);
  }

  // narration audio (already generated on approach) — optional
  let narration = null;
  if (narrationUrl[mmsi]) {
    try {
      const r = await fetch(narrationUrl[mmsi]);
      if (r.ok) { narration = path.join(tmpDir, `narr_${mmsi}.mp3`);
        fs.writeFileSync(narration, Buffer.from(await r.arrayBuffer())); }
    } catch (e) { log('  narration fetch failed:', e.message); }
  }

  const fact = pickFact(name);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = normName(name).slice(0, 24) || 'vessel';
  const outPath = path.join(CFG.outDir, `${stamp}_${safe}.mp4`);

  try {
    await render({ srcVideo: saved, narration, name, fact, outPath });
  } catch (e) { return log('  ✗ render failed:', e.message); }

  const meta = await writeTitle({ name, fact, flag: info.flag, lengthM: info.lengthM });
  const score = Math.round(bright) + (info.lengthM ? Math.min(info.lengthM / 10, 60) : 0); // brightness + size
  const metaOut = { mmsi, name, fact, flag: info.flag || '', lengthM: info.lengthM || null,
    brightness: Math.round(bright), score, ...meta, video: path.basename(outPath),
    createdAt: new Date().toISOString(), posted: false };
  fs.writeFileSync(outPath.replace(/\.mp4$/, '.json'), JSON.stringify(metaOut, null, 2));
  log(`  ✅ clip ready: ${outPath}`);
  log(`     title: ${meta.title}`);
}

// ── YouTube posting + 2/day scheduler (Phase 2) ──────────────────
let youtube = null;
function initYouTube() {
  const tokenPath = path.join(process.cwd(), 'token.json');
  if (!fs.existsSync(tokenPath)) { log('YouTube: no token.json — run "node youtube-auth.js" to enable posting'); return false; }
  try {
    youtube = google.youtube({ version: 'v3', auth: google.auth.fromJSON(JSON.parse(fs.readFileSync(tokenPath, 'utf8'))) });
    return true;
  } catch (e) { log('YouTube auth load failed:', e.message); return false; }
}
async function uploadClip(videoPath, meta) {
  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title: (meta.title || meta.name).slice(0, 100),
        description: (meta.description || '').slice(0, 4900), categoryId: CFG.ytCategory,
        tags: ['Shorts', 'GreatLakes', 'MackinacBridge', 'ships', 'freighter'] },
      status: { privacyStatus: CFG.ytPrivacy, selfDeclaredMadeForKids: false }
    },
    media: { body: fs.createReadStream(videoPath) }
  });
  return res.data.id;
}
function bestUnposted(sinceMs) {
  let best = null;
  for (const f of fs.readdirSync(CFG.outDir)) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    let m; try { m = JSON.parse(fs.readFileSync(path.join(CFG.outDir, f), 'utf8')); } catch { continue; }
    if (m.posted || !m.video) continue;
    if (new Date(m.createdAt).getTime() < sinceMs) continue;
    if (!fs.existsSync(path.join(CFG.outDir, m.video))) continue;
    if (!best || (m.score || 0) > (best.m.score || 0)) best = { file: path.join(CFG.outDir, f), m };
  }
  return best;
}
async function postSlot(slot, windowHours) {
  const pick = bestUnposted(Date.now() - windowHours * 3600e3);
  if (!pick) return log(`🕒 ${slot} slot: no clip in the last ${windowHours}h — skipping`);
  log(`🕒 ${slot} slot: posting "${pick.m.name}" (score ${pick.m.score})`);
  try {
    const id = await uploadClip(path.join(CFG.outDir, pick.m.video), pick.m);
    Object.assign(pick.m, { posted: true, postedSlot: slot, youtubeId: id, postedAt: new Date().toISOString() });
    fs.writeFileSync(pick.file, JSON.stringify(pick.m, null, 2));
    log(`  ✅ uploaded (${CFG.ytPrivacy}): https://youtu.be/${id}`);
    if (CFG.ytPrivacy !== 'public') log('     → open YouTube Studio and hit Publish when ready.');
  } catch (e) { log(`  ✗ ${slot} upload failed:`, e.message); }
}
const slotFile = path.join(CFG.outDir, '.slots.json');
const readSlots = () => { try { return JSON.parse(fs.readFileSync(slotFile, 'utf8')); } catch { return {}; } };
const writeSlots = s => { try { fs.writeFileSync(slotFile, JSON.stringify(s)); } catch {} };
function checkSlots() {
  const now = new Date(), today = now.toISOString().slice(0, 10);
  let st = readSlots(); if (st.date !== today) { st = { date: today }; writeSlots(st); }
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const due = t => { const [h, m] = t.split(':').map(Number); return nowMin >= h * 60 + m && nowMin < h * 60 + m + 6; };
  if (!st.morning && due(CFG.morningHM)) { st.morning = true; writeSlots(st); postSlot('morning', 14); }
  if (!st.evening && due(CFG.eveningHM)) { st.evening = true; writeSlots(st); postSlot('evening', 10); }
}

// ── boot ─────────────────────────────────────────────────────────
(async () => {
  fs.mkdirSync(CFG.outDir, { recursive: true });
  log(`Mackinac Clip Poster — capturing to ${path.resolve(CFG.outDir)}`);
  await loadFacts();
  await connectObs();
  connectServer();
  if (CFG.ytEnabled && initYouTube()) {
    log(`YouTube posting ON — slots ${CFG.morningHM} & ${CFG.eveningHM} local (${CFG.ytPrivacy})`);
    setInterval(checkSlots, 60000);
  } else if (!CFG.ytEnabled) {
    log('YouTube posting OFF (set YT_ENABLED=1 in .env once authorized)');
  }
  if (TEST_MODE) {
    log('TEST MODE: rendering the current replay buffer now…');
    setTimeout(() => handlePassing({ mmsi: 0, name: 'Test Vessel' }).catch(e => log(e.message)), 2500);
  }
})();
