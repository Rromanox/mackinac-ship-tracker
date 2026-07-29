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
  trimStart:    +(process.env.CLIP_TRIM_START || 0),   // seconds to skip from the START of each clip
  fgWidthPct:   +(process.env.FG_WIDTH_PCT || 0.92),   // boat-band width vs full frame; <1 leaves side margin so phones (Shorts) don't crop the boat
  clipStyle:    (process.env.CLIP_STYLE || 'pad'),     // 'pad' = blur-pad (nothing cropped) | 'zoom' = zoomed-in on a blurred bg
  clipZoom:     +(process.env.CLIP_ZOOM || 1.5),       // (zoom style) 1 = full width, higher = bigger subject + more side crop; blur fills the rest
  clipPanX:     +(process.env.CLIP_PAN_X || 0),         // (zoom style) horizontal shift in px: + moves the picture RIGHT, - moves it LEFT
  clipStartHour:+(process.env.CLIP_START_HOUR ?? 6),   // only clip between these local hours
  clipEndHour:  +(process.env.CLIP_END_HOUR ?? 24),    // 6–24 = 6:00am to 11:59pm (skip the dark overnight)
  ambientVol:   +(process.env.AMBIENT_VOLUME || 0.30),
  narrationVol: +(process.env.NARRATION_VOLUME || 1.40),
  ytEnabled:  process.env.YT_ENABLED === '1',
  postEach:   process.env.POST_EACH === '1',   // 1 = upload every clip immediately (private) | 0 = 2/day best-of slots
  ytPrivacy:  process.env.YT_PRIVACY || 'private',
  ytCategory: process.env.YT_CATEGORY || '19',
  ytPlaylist: process.env.YT_PLAYLIST || '',
  morningHM:  process.env.MORNING_SLOT || '08:30',
  eveningHM:  process.env.EVENING_SLOT || '18:30',
  liveUrl:    process.env.LIVE_URL || ''
};
const TEST_MODE = process.argv.includes('--test');
const POST_NOW  = process.argv.includes('--post-now');
function argVal(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }
const RENDER_FILE = argVal('--render');   // manually render a raw replay file into the pool
const RENDER_NAME = argVal('--name');
const RENDER_STYLE = argVal('--style');   // 'pad' | 'zoom' — override the clip style for this manual render
const RENDER_ZOOM  = argVal('--zoom');    // override CLIP_ZOOM for this manual render (e.g. --zoom 1.3)
const RENDER_PAN   = argVal('--panx');    // override CLIP_PAN_X for this manual render (e.g. --panx 150)

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
// (brightness gate removed — it was unreliable; clips are now gated by time-of-day and you review each one)
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

async function render({ srcVideo, outPath, style, zoom, panX }) {
  // vertical 9:16, keeping the FULL buffer and its ORIGINAL audio (stream audio already carries the
  // live narration at the right moment). Two looks: 'pad' = blur-pad (nothing cropped); 'fill' =
  // crop the 16:9 to fill the whole 9:16 (bigger subject, but the far sides are cut).
  const st = style || CFG.clipStyle;
  let vf;
  if (st === 'zoom' || st === 'fill') {
    // Zoom in on a BLURRED background (never black): scale the video up by `zoom`, crop the width to
    // the frame. Higher zoom = bigger subject + more side crop; lower = more of the scene + more blur.
    const zm = Math.max(1, +(zoom ?? CFG.clipZoom) || 1);
    const fw = Math.round(1080 * zm / 2) * 2;
    const pan = +(panX ?? CFG.clipPanX) || 0;
    const cx = Math.max(0, Math.min(fw - 1080, Math.round((fw - 1080) / 2 - pan)));   // + pan = picture moves right
    vf = [
      `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:4,eq=brightness=-0.05[bg]`,
      `[0:v]scale=${fw}:-2,crop=1080:ih:${cx}:0[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[v]`
    ].join(';');
  } else {
    const fgW = Math.round(1080 * CFG.fgWidthPct / 2) * 2;   // inset so phone (Shorts) side-crop eats the margin, not the boat
    vf = [
      `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:4,eq=brightness=-0.05[bg]`,
      `[0:v]scale=${fgW}:-2[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[v]`
    ].join(';');
  }
  const args = ['-y', '-ss', String(CFG.trimStart), '-i', srcVideo, '-filter_complex', vf, '-map', '[v]', '-map', '0:a?',
    '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath];
  await run('ffmpeg', args);
}

// ── Haiku-written title + description ────────────────────────────
const noEmoji = s => String(s || '').replace(/[\p{Extended_Pictographic}️‍]/gu, '').replace(/[ \t]{2,}/g, ' ').trim();
async function writeTitle({ name, fact, flag, lengthM }) {
  const cta = CFG.liveUrl ? `\n\nJoin our 24/7 livestream to watch the Mackinac Bridge and passing freighters live: ${CFG.liveUrl}` : '';
  let out = {
    title: `${name} passes under the Mackinac Bridge #Shorts`,
    description: `${name} crossing the Straits of Mackinac.${fact ? ' ' + fact : ''}\n\n#Shorts #GreatLakes #MackinacBridge #ships #freighter`
  };
  if (anthropic) {
    try {
      const sys = 'You write short, punchy YouTube Shorts metadata for a live Great Lakes ship-cam. ' +
        'Return STRICT JSON {"title": "...", "description": "..."} and nothing else. ' +
        'Do NOT use any emojis anywhere. ' +
        'Title: <=90 chars, a scroll-stopping hook plus the ship name, end with #Shorts. ' +
        'Description: 1-2 lively sentences using the fact, then 4-6 relevant hashtags on a new line. No clickbait lies.';
      const facts = [`Ship: ${name}`, lengthM ? `Length: ~${Math.round(lengthM)} m` : '', flag ? `Flag: ${flag}` : '',
        fact ? `Fun fact: ${fact}` : ''].filter(Boolean).join('\n');
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5', max_tokens: 400,
        messages: [{ role: 'user', content: sys + '\n\n' + facts }]
      });
      const text = (msg.content.find(c => c.type === 'text') || {}).text || '';
      const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      out = { title: j.title || out.title, description: j.description || out.description };
    } catch (e) { log('Haiku title failed, using fallback:', e.message); }
  }
  return { title: noEmoji(out.title), description: noEmoji(out.description) + cta };
}

// ── the pipeline for one passing ─────────────────────────────────
async function handlePassing(data) {
  const mmsi = data.mmsi;
  const now = Date.now();
  if (lastClipAt[mmsi] && now - lastClipAt[mmsi] < 90000) return; // debounce
  lastClipAt[mmsi] = now;

  const info = staticInfo[mmsi] || {};
  const name = (data.name || info.name || 'Unknown Vessel').trim();

  // Only clip during daylight-ish hours (local time); you review each clip before publishing.
  const hr = new Date().getHours();
  if (!TEST_MODE && (hr < CFG.clipStartHour || hr >= CFG.clipEndHour)) {
    return log(`  ⏰ ${name}: outside clip hours (${CFG.clipStartHour}:00–${CFG.clipEndHour}:00) — skipping`);
  }
  log(`🚢 passing: ${name} (${mmsi}) — clipping in ${CFG.saveDelayMs / 1000}s`);

  await new Promise(r => setTimeout(r, CFG.saveDelayMs)); // let the crossing settle near clip end

  let saved;
  try { saved = await saveReplay(); } catch (e) { return log('  replay save failed:', e.message); }
  log('  saved replay:', saved);

  const fact = pickFact(name);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = normName(name).slice(0, 24) || 'vessel';
  const outPath = path.join(CFG.outDir, `${stamp}_${safe}.mp4`);

  try {
    await render({ srcVideo: saved, outPath });   // audio comes from the raw capture (already has narration)
  } catch (e) { return log('  ✗ render failed:', e.message); }

  const meta = await writeTitle({ name, fact, flag: info.flag, lengthM: info.lengthM });
  const score = info.lengthM ? Math.min(info.lengthM / 10, 100) : 20; // bigger vessel = higher priority
  const metaOut = { mmsi, name, fact, flag: info.flag || '', lengthM: info.lengthM || null,
    score, ...meta, video: path.basename(outPath),
    createdAt: new Date().toISOString(), posted: false };
  fs.writeFileSync(outPath.replace(/\.mp4$/, '.json'), JSON.stringify(metaOut, null, 2));
  log(`  ✅ clip ready: ${outPath}`);
  log(`     title: ${meta.title}`);

  if (CFG.postEach && youtube) {   // upload every clip immediately (private) — you publish the good ones
    try {
      const id = await uploadClip(outPath, metaOut);
      Object.assign(metaOut, { posted: true, youtubeId: id, postedAt: new Date().toISOString() });
      fs.writeFileSync(outPath.replace(/\.mp4$/, '.json'), JSON.stringify(metaOut, null, 2));
      log(`  ✅ uploaded (${CFG.ytPrivacy}): https://youtu.be/${id}`);
    } catch (e) { log('  ✗ upload failed:', e.message); }
  }
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
  const id = res.data.id;
  if (CFG.ytPlaylist) {
    try {
      await youtube.playlistItems.insert({ part: ['snippet'],
        requestBody: { snippet: { playlistId: CFG.ytPlaylist, resourceId: { kind: 'youtube#video', videoId: id } } } });
      log('  added to playlist');
    } catch (e) { log('  (playlist add failed:', e.message + ')'); }
  }
  return id;
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
  if (!pick) return false;   // nothing to post yet — caller keeps the slot armed and retries next minute
  log(`🕒 ${slot} slot: posting "${pick.m.name}" (score ${pick.m.score})`);
  try {
    const id = await uploadClip(path.join(CFG.outDir, pick.m.video), pick.m);
    Object.assign(pick.m, { posted: true, postedSlot: slot, youtubeId: id, postedAt: new Date().toISOString() });
    fs.writeFileSync(pick.file, JSON.stringify(pick.m, null, 2));
    log(`  ✅ uploaded (${CFG.ytPrivacy}): https://youtu.be/${id}`);
    if (CFG.ytPrivacy !== 'public') log('     → open YouTube Studio and hit Publish when ready.');
    return true;
  } catch (e) { log(`  ✗ ${slot} upload failed:`, e.message); return false; }
}
const slotFile = path.join(CFG.outDir, '.slots.json');
const readSlots = () => { try { return JSON.parse(fs.readFileSync(slotFile, 'utf8')); } catch { return {}; } };
const writeSlots = s => { try { fs.writeFileSync(slotFile, JSON.stringify(s)); } catch {} };
// A slot stays ARMED from its time until SLOT_ARM_MIN later (6h). We check hourly: if the pool was
// empty at slot time, it posts the first good clip that lands on a later hourly check — so a 9am
// boat still gets a morning post instead of waiting for evening. Marked done only once it posts.
const SLOT_ARM_MIN = 6 * 60;
let slotBusy = false;
async function checkSlots() {
  if (slotBusy) return;
  slotBusy = true;
  try {
    const now = new Date(), today = now.toISOString().slice(0, 10);
    let st = readSlots(); if (st.date !== today) { st = { date: today }; writeSlots(st); }
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const armed = t => { const [h, m] = t.split(':').map(Number); const s = h * 60 + m; return nowMin >= s && nowMin < s + SLOT_ARM_MIN; };
    if (!st.morning && armed(CFG.morningHM)) { if (await postSlot('morning', 14)) { st.morning = true; writeSlots(st); } }
    if (!st.evening && armed(CFG.eveningHM)) { if (await postSlot('evening', 10)) { st.evening = true; writeSlots(st); } }
  } finally { slotBusy = false; }
}

// ── boot ─────────────────────────────────────────────────────────
(async () => {
  fs.mkdirSync(CFG.outDir, { recursive: true });
  log(`Mackinac Clip Poster — capturing to ${path.resolve(CFG.outDir)}`);
  if (POST_NOW) {   // one-shot: upload the best recent clip immediately, then exit
    if (initYouTube()) { log('POST-NOW: uploading the best clip from the last 48h…'); if (!(await postSlot('manual', 48))) log('POST-NOW: no clip in the last 48h to post'); }
    else log('POST-NOW: no token.json — run "node youtube-auth.js" first');
    return process.exit(0);
  }
  if (RENDER_FILE) {   // one-shot: render a raw replay file into the pool, then exit
    if (!fs.existsSync(RENDER_FILE)) { log('--render: file not found:', RENDER_FILE); return process.exit(1); }
    await loadFacts();
    const nm = (RENDER_NAME || 'Great Lakes Freighter').trim();
    log(`RENDER: "${nm}" from ${RENDER_FILE}`);
    const outPath = path.join(CFG.outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${normName(nm).slice(0, 24) || 'vessel'}.mp4`);
    try { await render({ srcVideo: RENDER_FILE, outPath, style: RENDER_STYLE, zoom: RENDER_ZOOM, panX: RENDER_PAN }); }
    catch (e) { log('  render failed:', e.message); return process.exit(1); }
    const meta = await writeTitle({ name: nm, fact: pickFact(nm), flag: '', lengthM: null });
    fs.writeFileSync(outPath.replace(/\.mp4$/, '.json'), JSON.stringify(
      { mmsi: 0, name: nm, score: 50, ...meta, video: path.basename(outPath), createdAt: new Date().toISOString(), posted: false }, null, 2));
    log(`  ✅ rendered: ${outPath}`);
    log('  now upload it:  node clip-poster.js --post-now');
    return process.exit(0);
  }
  await loadFacts();
  await connectObs();
  if (CFG.ytEnabled && initYouTube()) {
    if (CFG.postEach) {
      log(`YouTube posting ON — uploading EVERY clip as ${CFG.ytPrivacy} (you publish the good ones)`);
    } else {
      log(`YouTube posting ON — slots ${CFG.morningHM} & ${CFG.eveningHM} local (${CFG.ytPrivacy}); checking hourly`);
      checkSlots();                        // check once at startup, then every hour
      setInterval(checkSlots, 60 * 60000);
    }
  } else if (!CFG.ytEnabled) {
    log('YouTube posting OFF (set YT_ENABLED=1 in .env once authorized)');
  }
  connectServer();                         // start listening AFTER YouTube is ready
  if (TEST_MODE) {
    log('TEST MODE: rendering the current replay buffer now…');
    setTimeout(() => handlePassing({ mmsi: 0, name: 'Test Vessel' }).catch(e => log(e.message)), 2500);
  }
})();
