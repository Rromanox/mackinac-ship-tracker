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
  trimStart:    +(process.env.CLIP_TRIM_START || 0),   // seconds to skip from the START of each clip (only when there was no narration)
  narrationLead:+(process.env.NARRATION_LEAD_S ?? 2),  // start the clip this many seconds before the narration starts
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
  liveUrl:    process.env.LIVE_URL || '',
  nameCard:   process.env.NAME_CARD !== '0',          // the banner-style ship card under the video (NAME_CARD=0 turns it off)
  cardFont:   process.env.CARD_FONT || (fs.existsSync('C:/Windows/Fonts/segoeuib.ttf') ? 'C:/Windows/Fonts/segoeuib.ttf' : 'C:/Windows/Fonts/arialbd.ttf'),
  cardFontReg:process.env.CARD_FONT_REGULAR || (fs.existsSync('C:/Windows/Fonts/segoeui.ttf') ? 'C:/Windows/Fonts/segoeui.ttf' : 'C:/Windows/Fonts/arial.ttf')
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
const narrationHeardAt = {}; // mmsi -> when (this PC's clock) the server said the narration started
let factsByName = null;   // normalised vessel name -> [facts]
const lenFtByName = {};   // normalised vessel name -> length in feet (from the fact list)
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
// the same as words, for the name card (no emojis on video)
const COUNTRY = { '316': 'Canada', '366': 'United States', '367': 'United States', '368': 'United States', '369': 'United States',
  '338': 'United States', '311': 'Bahamas', '309': 'Bahamas', '308': 'Bahamas', '305': 'Antigua and Barbuda', '304': 'Antigua and Barbuda',
  '248': 'Malta', '249': 'Malta', '215': 'Malta', '229': 'Malta', '256': 'Malta', '244': 'Netherlands', '245': 'Netherlands',
  '246': 'Netherlands', '538': 'Marshall Islands', '636': 'Liberia', '209': 'Cyprus', '210': 'Cyprus', '212': 'Cyprus',
  '255': 'Portugal', '257': 'Norway', '258': 'Norway', '259': 'Norway', '211': 'Germany', '218': 'Germany', '230': 'Finland',
  '265': 'Sweden', '266': 'Sweden', '235': 'United Kingdom', '232': 'United Kingdom', '563': 'Singapore', '564': 'Singapore',
  '565': 'Singapore', '566': 'Singapore', '477': 'Hong Kong', '228': 'France', '247': 'Italy', '224': 'Spain', '225': 'Spain' };
const countryFromMmsi = m => COUNTRY[String(m).slice(0, 3)] || '';
function typeName(t) {
  if (t >= 70 && t <= 79) return 'Cargo freighter';
  if (t >= 80 && t <= 89) return 'Tanker';
  if (t === 31 || t === 32) return 'Tug and barge';
  if (t === 52) return 'Tug';
  if (t >= 60 && t <= 69) return 'Passenger ship';
  return '';
}
// the card under the video: gold tag, the ship's name, a details line and one fun fact (like the stream banner)
function nameCard({ mmsi, name, direction, fact }) {
  const info = staticInfo[mmsi] || {};
  const ft = lenFtByName[normName(name)] || (info.lengthM ? Math.round(info.lengthM * 3.28084) : 0);
  const dir = /east/i.test(direction || '') ? 'Eastbound' : /west/i.test(direction || '') ? 'Westbound' : '';
  const meta = [typeName(info.type), ft ? ft.toLocaleString('en-US') + ' ft' : '', countryFromMmsi(mmsi), dir].filter(Boolean).join(' · ');
  return { tag: 'UNDER THE MACKINAC BRIDGE', name: String(name).toUpperCase(), meta, fact: noEmoji(fact || '') };
}

async function loadFacts() {
  try {
    const r = await fetch(CFG.serverHttp + '/api/vessel-facts');
    const j = await r.json();
    const list = Array.isArray(j) ? j : (j.vessels || Object.values(j));
    factsByName = {};
    list.forEach(v => {
      if (!v || !v.name) return;
      factsByName[normName(v.name)] = v.facts || (v.fact ? [v.fact] : []);
      if (v.lengthFt) lenFtByName[normName(v.name)] = v.lengthFt;
    });
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
      if (sd && sd.Type) staticInfo[mmsi].type = sd.Type;
    } else if (m.type === 'narrate' && m.data && m.data.mmsi) {
      narrationUrl[m.data.mmsi] = CFG.serverHttp + m.data.url;
      narrationHeardAt[m.data.mmsi] = Date.now();   // the narration starts playing on the stream about now
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

// length of a saved replay in seconds (null if ffprobe can't tell)
function probeSeconds(file) {
  return new Promise(resolve => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', () => { const s = parseFloat(out); resolve(isFinite(s) ? s : null); });
  });
}

// fromEnd: start the clip this many seconds before the END of the saved replay (used to begin a couple
// of seconds before the narration); otherwise CLIP_TRIM_START seconds in from the start
// The ship card drawn under the video (ffmpeg drawbox/drawtext, same colours as the stream banner).
// Returns { height, filters(x, y) } so render() can make room for it.
const CARD_W = 900, CARD_BOTTOM_LIMIT = 1560;    // narrower than the frame so the Shorts buttons on the right don't cover it,
                                                  // and above the Shorts title at the bottom of a phone
function cardLayout(card, stamp) {
  if (!card || !card.name) return null;
  const write = (key, text) => { const p = path.join(tmpDir, `${stamp}-${key}.txt`); fs.writeFileSync(p, text, 'utf8'); return escFilterPath(p); };
  const lines = card.fact ? wrap(card.fact, 44).split('\n') : [];
  const fact = lines.length > 2 ? lines.slice(0, 2).join('\n').replace(/[\s,.;:]*$/, '...') : lines.join('\n');
  const nameSize = Math.max(44, Math.min(72, Math.floor((CARD_W - 80) / (0.66 * Math.max(1, card.name.length)))));
  const factLines = fact ? fact.split('\n').length : 0;
  const metaSize = Math.max(24, Math.min(31, Math.floor((CARD_W - 80) / (0.5 * Math.max(1, (card.meta || '').length)))));
  const yName = 96, yMeta = yName + nameSize + 16, yFact = yMeta + (card.meta ? metaSize + 23 : 6);
  const height = yFact + (factLines ? factLines * 44 + 30 : 0);
  const bold = escFilterPath(CFG.cardFont), reg = escFilterPath(CFG.cardFontReg);
  const files = { tag: write('tag', card.tag), name: write('name', card.name), meta: card.meta && write('meta', card.meta), fact: fact && write('fact', fact) };
  return {
    height,
    filters: (x, y) => [
      `drawbox=x=${x}:y=${y}:w=${CARD_W}:h=${height}:color=0x0B1420@0.88:t=fill`,
      `drawbox=x=${x}:y=${y}:w=${CARD_W}:h=6:color=0xF2C14E@1:t=fill`,
      `drawtext=fontfile='${bold}':textfile='${files.tag}':fontsize=30:fontcolor=0x1B1405:box=1:boxcolor=0xF2C14E@1:boxborderw=12:x=${x + 44}:y=${y + 36}`,
      `drawtext=fontfile='${bold}':textfile='${files.name}':fontsize=${nameSize}:fontcolor=white:x=${x + 38}:y=${y + yName}`,
      files.meta && `drawtext=fontfile='${reg}':textfile='${files.meta}':fontsize=${metaSize}:fontcolor=0xC9D6E3:x=${x + 40}:y=${y + yMeta}`,
      files.fact && `drawbox=x=${x + 42}:y=${y + yFact + 12}:w=12:h=12:color=0xF2C14E@1:t=fill`,
      files.fact && `drawtext=fontfile='${reg}':textfile='${files.fact}':fontsize=32:fontcolor=0xCFE3F2:line_spacing=10:x=${x + 70}:y=${y + yFact}`,
    ].filter(Boolean).join(',')
  };
}

async function render({ srcVideo, outPath, style, zoom, panX, fromEnd, card }) {
  // vertical 9:16, keeping the FULL buffer and its ORIGINAL audio (stream audio already carries the
  // live narration at the right moment). Two looks: 'pad' = blur-pad (nothing cropped); 'fill' =
  // crop the 16:9 to fill the whole 9:16 (bigger subject, but the far sides are cut).
  // With a ship card, the video sits higher so the card fits under it (above the phone's Shorts buttons).
  const st = style || CFG.clipStyle;
  const lay = CFG.nameCard ? cardLayout(card, path.basename(outPath, '.mp4')) : null;
  const place = (fgH) => {                         // top of the video, and of the card under it
    if (!lay) return { top: Math.round((1920 - fgH) / 2) };
    const top = Math.max(250, Math.min(Math.round((1920 - fgH) / 2), CARD_BOTTOM_LIMIT - 30 - lay.height - fgH));
    return { top, cardY: top + fgH + 30 };
  };
  const bg = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:4,eq=brightness=-0.05[bg]`;
  let fgChain, fgH, fgW = 1080;
  if (st === 'zoom' || st === 'fill') {
    // Zoom in on a BLURRED background (never black): scale the video up by `zoom`, crop the width to
    // the frame. Higher zoom = bigger subject + more side crop; lower = more of the scene + more blur.
    const zm = Math.max(1, +(zoom ?? CFG.clipZoom) || 1);
    const fw = Math.round(1080 * zm / 2) * 2;
    const pan = +(panX ?? CFG.clipPanX) || 0;
    const cx = Math.max(0, Math.min(fw - 1080, Math.round((fw - 1080) / 2 - pan)));   // + pan = picture moves right
    fgChain = `[0:v]scale=${fw}:-2,crop=1080:ih:${cx}:0[fg]`;
    fgH = Math.round(fw * 9 / 16 / 2) * 2;
  } else {
    fgW = Math.round(1080 * CFG.fgWidthPct / 2) * 2;   // inset so phone (Shorts) side-crop eats the margin, not the boat
    fgChain = `[0:v]scale=${fgW}:-2[fg]`;
    fgH = Math.round(fgW * 9 / 16 / 2) * 2;
  }
  const p = place(fgH);
  const vf = [bg, fgChain,
    lay ? `[bg][fg]overlay=(W-w)/2:${p.top}[base];[base]${lay.filters(Math.max(40, Math.round((1080 - fgW) / 2)), p.cardY)}[v]`
        : `[bg][fg]overlay=(W-w)/2:${p.top}[v]`].join(';');
  const seek = fromEnd ? ['-sseof', '-' + fromEnd.toFixed(2)] : ['-ss', String(CFG.trimStart)];
  const args = ['-y', ...seek, '-i', srcVideo, '-filter_complex', vf, '-map', '[v]', '-map', '0:a?',
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
  const savedAt = Date.now();                       // the replay ends (about) now
  try { saved = await saveReplay(); } catch (e) { return log('  replay save failed:', e.message); }
  log('  saved replay:', saved);

  // start the clip NARRATION_LEAD_S seconds before the narration began (if it played for this ship)
  let fromEnd = null;
  const heard = narrationHeardAt[mmsi];
  if (heard && savedAt - heard < 150000) {
    fromEnd = (savedAt - heard) / 1000 + CFG.narrationLead;
    const len = await probeSeconds(saved);
    if (len && fromEnd > len) {
      log(`  ⚠ the replay is only ${len.toFixed(0)}s but the narration started ${(fromEnd - CFG.narrationLead).toFixed(0)}s ago: ` +
          `raise OBS Settings > Output > Replay Buffer > Maximum Replay Time to at least ${Math.ceil(fromEnd + 10)}s. Using the whole replay.`);
      fromEnd = null;
    } else {
      log(`  clip starts ${CFG.narrationLead}s before the narration (${fromEnd.toFixed(1)}s before the end)`);
    }
  }

  const fact = pickFact(name);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = normName(name).slice(0, 24) || 'vessel';
  const outPath = path.join(CFG.outDir, `${stamp}_${safe}.mp4`);

  try {
    await render({ srcVideo: saved, outPath, fromEnd,        // audio comes from the raw capture (already has narration)
                   card: nameCard({ mmsi, name, direction: data.direction, fact }) });
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
    const fct = pickFact(nm);
    try { await render({ srcVideo: RENDER_FILE, outPath, style: RENDER_STYLE, zoom: RENDER_ZOOM, panX: RENDER_PAN,
                         card: nameCard({ mmsi: 0, name: nm, direction: argVal('--dir') || '', fact: fct }) }); }
    catch (e) { log('  render failed:', e.message); return process.exit(1); }
    const meta = await writeTitle({ name: nm, fact: fct, flag: '', lengthM: null });
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
