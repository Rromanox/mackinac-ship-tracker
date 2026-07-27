/*!
 * Mackinac Bridge Ship Tracker
 * Copyright (c) 2026 Kevin Salazar Fernandes. All rights reserved.
 * Proprietary and confidential -- see LICENSE. Unauthorized copying,
 * modification, or distribution is prohibited.
 */
// server.js - Ship Tracker Backend with MongoDB
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { MongoClient } = require('mongodb');

// Load .env for local dev (Render injects env vars via its dashboard — there is no .env there)
try {
  require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch (e) { /* no .env file — expected on Render */ }

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// MongoDB configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'shiptracker';
let db = null;
let shipsCollection = null;
let passingsCollection = null;
let narrationsCollection = null;

// Connect to MongoDB
async function connectToMongoDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    shipsCollection = db.collection('ships');
    passingsCollection = db.collection('passings');
    narrationsCollection = db.collection('narrations');

    // Create indexes for better performance
    await shipsCollection.createIndex({ mmsi: 1 });
    await shipsCollection.createIndex({ timestamp: -1 });
    await shipsCollection.createIndex({ passedBridge: 1 });
    await passingsCollection.createIndex({ passedTime: -1 });
    await passingsCollection.createIndex({ mmsi: 1 });
    await narrationsCollection.createIndex({ at: -1 });
    
    console.log('✓ Connected to MongoDB');
    console.log('📊 Database:', DB_NAME);
    await loadNameCache();
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    console.error('⚠️ Running without database - data will not be saved');
  }
}

// CORS middleware
const ALLOWED_ORIGINS = [
  'https://mackinac-ship-tracker.onrender.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Allow file:// opened locally (origin is null/undefined) and known domains
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

app.use(express.json({ limit: '2mb' })); // AIS-catcher batches can be sizeable

// Shared secret for the local AIS receiver feed (set on Render)
const LOCAL_AIS_KEY = process.env.LOCAL_AIS_KEY;

// Serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Overlays (transparent, OBS browser source friendly)
app.get('/overlay',           (req, res) => res.sendFile(path.join(__dirname, 'overlay.html')));
app.get('/overlay/bar',       (req, res) => res.sendFile(path.join(__dirname, 'overlay-bar.html')));
app.get('/overlay/spotlight', (req, res) => res.sendFile(path.join(__dirname, 'overlay-spotlight.html')));
app.get('/overlay/alert',     (req, res) => res.sendFile(path.join(__dirname, 'overlay-alert.html')));
app.get('/overlay/minimal',   (req, res) => res.sendFile(path.join(__dirname, 'overlay-minimal.html')));
app.get('/overlay/corner',    (req, res) => res.sendFile(path.join(__dirname, 'overlay-corner.html')));
app.get('/overlay/banner',    (req, res) => res.sendFile(path.join(__dirname, 'overlay-banner.html')));
app.get('/overlay/banner2',   (req, res) => res.sendFile(path.join(__dirname, 'overlay-banner2.html')));
app.get('/overlay/banner3',   (req, res) => res.sendFile(path.join(__dirname, 'overlay-banner3.html')));
app.get('/overlay/narration', (req, res) => res.sendFile(path.join(__dirname, 'overlay-narration.html'))); // audio-only vessel narration player
app.get('/missing-facts',     (req, res) => res.sendFile(path.join(__dirname, 'missing-facts.html'))); // human-readable fact-gap list
// New high-visibility overlay options (design candidates)
app.get('/overlay/hud/board',     (req, res) => res.sendFile(path.join(__dirname, 'overlay-hud-board.html')));
app.get('/overlay/hud/spotlight', (req, res) => res.sendFile(path.join(__dirname, 'overlay-hud-spotlight.html')));
app.get('/overlay/hud/rail',      (req, res) => res.sendFile(path.join(__dirname, 'overlay-hud-rail.html')));

// Local AIS receiver feed — AIS-catcher (or the ais-relay.js helper) POSTs
// its decoded JSON here. Accepts either a bare array of messages or the
// AIS-catcher envelope { protocol, msgs: [...] }.
app.post('/api/local-ais', (req, res) => {
  if (!LOCAL_AIS_KEY) return res.status(503).json({ error: 'LOCAL_AIS_KEY not configured on server' });
  const key = req.query.key || req.headers['x-api-key'];
  if (key !== LOCAL_AIS_KEY) return res.status(403).json({ error: 'Invalid key' });

  const body = req.body;
  const msgs = Array.isArray(body) ? body
             : (body && Array.isArray(body.msgs)) ? body.msgs
             : null;
  if (!msgs) return res.status(400).json({ error: 'Expected an array of AIS messages or { msgs: [...] }' });

  let accepted = 0;
  for (const m of msgs) {
    try {
      const converted = aisCatcherToStreamMessage(m);
      if (converted) { processAisMessage(converted, 'local'); accepted++; }
    } catch (err) {
      console.error('Local AIS message error:', err.message);
    }
  }
  lastLocalMessageAt = Date.now();
  localMessagesTotal += accepted;
  res.json({ ok: true, accepted });
});

// Curated vessel fun facts (shown in the banner notch). Re-read from disk on each
// request so the list can be updated by editing vessel-facts.json + redeploying.
app.get('/api/vessel-facts', (req, res) => {
  try {
    const raw = require('fs').readFileSync(path.join(__dirname, 'vessel-facts.json'), 'utf8');
    res.type('application/json').send(raw);
  } catch (err) {
    res.json({ vessels: [] });
  }
});

// Which vessels have shown up but still have NO curated fun fact?
// Self-maintaining gap list — check this periodically and research the top entries.
// Confirmed bridge crossings are ranked first: those are guaranteed straits traffic.
app.get('/api/missing-facts', async (req, res) => {
  try {
    const facts = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'vessel-facts.json'), 'utf8'));
    const have = new Set((facts.vessels || []).map(v => factKey(v.name)));
    const skip = n => !n || n === 'Unknown' || /^CG\d/i.test(n) || /^DIVE BOAT/i.test(n);

    // 1) vessels that actually crossed the bridge (highest value)
    let crossed = [];
    if (passingsCollection) {
      const rows = await passingsCollection.find({}).sort({ passedTime: -1 }).limit(400).toArray();
      const seen = new Set();
      rows.forEach(r => {
        const n = (r.name || '').trim();
        if (skip(n) || shouldHideVessel(r.mmsi) || seen.has(factKey(n)) || have.has(factKey(n))) return;
        seen.add(factKey(n));
        crossed.push({ name: n, mmsi: r.mmsi, lastPassed: r.passedTime });
      });
    }

    // 2) heard by the local antenna recently but never given a fact
    const heard = [];
    const seenH = new Set();
    Object.values(localReception)
      .sort((a, b) => b.at - a.at)
      .forEach(v => {
        const n = (v.name || '').trim();
        if (skip(n) || shouldHideVessel(v.mmsi) || seenH.has(factKey(n)) || have.has(factKey(n))) return;
        seenH.add(factKey(n));
        heard.push({ name: n, mmsi: v.mmsi, milesFromBridge: +v.distanceMi.toFixed(1) });
      });

    res.json({
      note: 'Vessels seen at the bridge with no curated fun fact yet. Research these next.',
      curatedFactCount: have.size,
      crossedBridgeNeedingFacts: crossed.slice(0, 40),
      heardRecentlyNeedingFacts: heard.slice(0, 40),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Local antenna range diagnostics — how far out the receiver is hearing vessels.
app.get('/api/local-range', (req, res) => {
  const now = Date.now();
  const windowMin = Math.min(parseInt(req.query.mins) || 20, 180);
  const windowMs = windowMin * 60 * 1000;
  // prune anything older than 3 h so the map doesn't grow forever
  Object.keys(localReception).forEach(k => { if (now - localReception[k].at > 3 * 60 * 60 * 1000) delete localReception[k]; });
  const recent = Object.values(localReception).filter(v => now - v.at < windowMs).sort((a, b) => b.distanceMi - a.distanceMi);
  const buckets = { '0-5mi': 0, '5-10mi': 0, '10-20mi': 0, '20-30mi': 0, '30-40mi': 0, '40-50mi': 0, '50mi+': 0 };
  recent.forEach(v => {
    const d = v.distanceMi;
    if (d < 5) buckets['0-5mi']++; else if (d < 10) buckets['5-10mi']++; else if (d < 20) buckets['10-20mi']++;
    else if (d < 30) buckets['20-30mi']++; else if (d < 40) buckets['30-40mi']++; else if (d < 50) buckets['40-50mi']++; else buckets['50mi+']++;
  });
  res.json({
    note: 'Range the LOCAL antenna is currently hearing vessels (all vessels, incl. filtered small craft).',
    windowMinutes: windowMin,
    vesselsHeard: recent.length,
    maxRangeMi: recent.length ? +recent[0].distanceMi.toFixed(1) : null,
    farthest: recent.slice(0, 12).map(v => ({ name: v.name, mmsi: v.mmsi, mi: +v.distanceMi.toFixed(1) })),
    buckets: buckets
  });
});

// Health / status check (used by UptimeRobot and monitoring)
app.get('/api/status', async (req, res) => {
  const stats = await getShipStats();
  // Prune vessels not heard from in 10 minutes
  const cutoff = Date.now() - 10 * 60 * 1000;
  Object.keys(recentVessels).forEach(k => { if (recentVessels[k].lastSeen < cutoff) delete recentVessels[k]; });
  res.json({
    status: 'Ship Tracker Proxy Server Running',
    connections: wss.clients.size,
    database: db ? 'Connected' : 'Disconnected',
    aisstream: {
      connected: !!(aisConnection && aisConnection.readyState === WebSocket.OPEN),
      lastMessageSecondsAgo: lastAisMessageAt ? Math.round((Date.now() - lastAisMessageAt) / 1000) : null,
      messagesSinceBoot: aisMessagesTotal,
      vesselsLast10Min: Object.values(recentVessels).map(v => v.name)
    },
    localReceiver: {
      configured: !!LOCAL_AIS_KEY,
      lastMessageSecondsAgo: lastLocalMessageAt ? Math.round((Date.now() - lastLocalMessageAt) / 1000) : null,
      messagesSinceBoot: localMessagesTotal
    },
    stats: stats,
    timestamp: new Date().toISOString()
  });
});

// ── PTZ camera cue ─────────────────────────────────────────────
// Which preset should the PTZ camera hold right now? Home Assistant polls this
// every ~15s and calls ptz_goto_preset for the returned zone. POSITION-driven
// (not a timer), so vessel speed doesn't matter — the closest in-range moving
// vessel wins, and the camera follows it through west → bridge → east zones.
const PTZ_BRIDGE_IN_MI  = 0.5;    // zoom IN when an APPROACHING vessel is within this of the bridge (perfect entry timing)
const PTZ_BRIDGE_OUT_MI = 0.15;   // zoom back to Home once a DEPARTING vessel passes this — asymmetric, so it releases ~40 s after the pass instead of lingering ~2.5 min
const PTZ_FRESH_MS  = 90 * 1000;  // ignore a vessel not heard from in 90 s
app.get('/api/ptz-cue', (req, res) => {
  const now = Date.now();
  let best = null;
  Object.keys(nearBridge).forEach(k => {
    const v = nearBridge[k];
    if (now - v.at > PTZ_FRESH_MS) { delete nearBridge[k]; return; }
    if (!best || v.distKm < best.distKm) best = Object.assign({ mmsi: +k }, v);
  });
  if (!best) return res.json({ active: false, zone: 'home' });
  const distMi = +(best.distKm * 0.621371).toFixed(2);
  // Asymmetric: hold the close-up out to 0.5 mi while approaching, but release at just
  // 0.15 mi once departing — so the camera doesn't linger on empty water after the pass.
  const threshold = best.closing === false ? PTZ_BRIDGE_OUT_MI : PTZ_BRIDGE_IN_MI;
  const zone = distMi <= threshold ? 'bridge' : (best.side === 'west' ? 'west' : 'east');
  res.json({ active: true, zone: zone, mmsi: best.mmsi, name: best.name, side: best.side,
             distanceMi: distMi, speedKn: +(best.speed || 0).toFixed(1), closing: best.closing !== false });
});

// Recent ships that passed the bridge (server-detected longitude crossings)
app.get('/api/ships/recent', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const ships = await getRecentPassings(limit);
  res.json({ ships });
});

// Mark a ship as having passed the bridge (called by frontend)
app.post('/api/ships/:mmsi/passed', async (req, res) => {
  const mmsi = parseInt(req.params.mmsi);
  const { name } = req.body;
  if (!mmsi) return res.status(400).json({ error: 'Invalid MMSI' });
  await markShipAsPassed(mmsi, name || 'Unknown');
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// VESSEL VISIBILITY FILTER — THE SINGLE SOURCE OF TRUTH.
// The server decides which vessels appear and drops the rest BEFORE
// broadcasting, so every banner/overlay shows the same thing and
// future changes happen in ONE place (this file). The client-side
// lists in the HTML overlays are now just harmless fallback.
//
//   • ALLOWED (whitelist) → always show (overrides everything)
//   • BLOCKED (blocklist) → always hide (known ferries/small craft)
//   • AIS type            → hide passenger/ferry (60-69), pleasure (37),
//                           sailing (36), fishing (30)
//   • size                → hide vessels known to be under MIN_VESSEL_LEN
//                           metres (freighters are 150m+; ferries, tour
//                           boats and pleasure craft are 15-40m)
//
// Type & length come from AIS static messages (broadcast ~every 6 min).
// A vessel with no static yet is SHOWN — we never hide a possible
// freighter just because its details haven't arrived.  ← To block a new
// ferry by hand, add its MMSI to BLOCKED_MMSI_SERVER below. That's it.
// ─────────────────────────────────────────────────────────────
const BLOCKED_MMSI_SERVER = new Set([
  368165150, 367031360, 367139210, 367349450, 367721870, 367721930, 367721960,
  367782080, 338158987, 338926364, 367721890, 367783160,
  // Unnamed local craft — never broadcast a name we could catch, but loiter in the
  // ferry zone all day at ferry speeds (not freighter behaviour). Unblock if identified.
  367706323, 368162611,
  // Named pleasure craft / charters (US 338-series recreational MMSIs) that crossed
  // the bridge but aren't Great Lakes freight — off the banners and the fact-gap list.
  338441735, // MISTY MAIDEN
  338095227, // TRANQUILLITY
]);
const ALLOWED_MMSI_SERVER = new Set([311050300]); // VICTORY II — big cruise ship, overrides size/type filters
const MIN_VESSEL_LEN = 50; // metres — below this, a vessel is not a Great Lakes freighter
const staticInfo = {};     // mmsi -> { type, length }  (learned from static messages)

// Tug (52) and towing (31/32) vessels are EXEMPT from the size filter: a tug
// pushing a barge broadcasts only its OWN length (often 30-45 m) while the barge
// it's moving is the actual cargo and can be hundreds of feet. Tug-barge units
// are real freight traffic through the straits, so size must not hide them.
// (Nuisance harbour tugs are still handled by the MMSI blocklist.)
const TOW_TYPES = new Set([31, 32, 52]);

function shouldHideVessel(mmsi) {
  if (ALLOWED_MMSI_SERVER.has(mmsi)) return false;
  if (BLOCKED_MMSI_SERVER.has(mmsi)) return true;
  const info = staticInfo[mmsi];
  if (info) {
    const t = info.type;
    if (t === 30 || t === 36 || t === 37 || (t >= 60 && t <= 69)) return true; // fishing, sailing, pleasure, passenger/ferry
    if (!TOW_TYPES.has(t) && info.length && info.length < MIN_VESSEL_LEN) return true; // too small to be a freighter
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// BRIDGE PASSING DETECTION
// The bridge spans the straits north–south, so any vessel that
// transits it crosses the bridge's longitude. We track which side
// (west = Lake Michigan, east = Lake Huron) each vessel is on while
// it's near the bridge; a side flip = it passed underneath.
// ─────────────────────────────────────────────────────────────
const PASS_TRACK_KM     = 16;                 // only watch vessels within ~10 mi of the bridge
const PASS_STALE_MS     = 30 * 60 * 1000;     // forget a side observation older than 30 min
const PASS_COOLDOWN_MS  = 60 * 60 * 1000;     // record at most one pass per vessel per hour
const NARRATE_TRIGGER_KM  = 0.35;             // ~0.22 mi — fire narration as an APPROACHING vessel reaches the bridge, so the ~5-10s of script + voice generation lands as it arrives (not after the pass)
const NARRATE_COOLDOWN_MS = 60 * 60 * 1000;   // one narration per vessel per hour

const vesselSides         = {}; // mmsi → { side, at }
const nearBridge          = {}; // mmsi → { name, distKm, side, speed, lat, lon, at } — live PTZ-cue feed
const lastPassRecordedAt  = {}; // mmsi → timestamp
const lastNarratedAt      = {}; // mmsi → timestamp (narration cooldown; shared by approach + pass triggers)
const recentPassingsMemory = []; // newest first — fallback + fast reads if DB is down

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function checkBridgePassing(mmsi, name, lat, lon, speed) {
  if (BLOCKED_MMSI_SERVER.has(mmsi) && !ALLOWED_MMSI_SERVER.has(mmsi)) return;

  const distKm = haversineKm(lat, lon, BRIDGE_LAT, BRIDGE_LON);
  if (distKm > PASS_TRACK_KM) { delete vesselSides[mmsi]; delete nearBridge[mmsi]; return; }
  if (!speed || speed < 0.5) return; // ignore drifting/moored vessels

  const side = lon < BRIDGE_LON ? 'west' : 'east';
  const prev = vesselSides[mmsi];
  vesselSides[mmsi] = { side, at: Date.now() };
  // Live camera-cue feed: closest in-range moving vessel drives the PTZ preset (see /api/ptz-cue)
  const prevNear = nearBridge[mmsi];
  const closing = prevNear ? (distKm <= prevNear.distKm + 0.02) : true; // approaching vs receding (20 m noise margin)
  nearBridge[mmsi] = { name: name, distKm: distKm, side: side, speed: speed, lat: lat, lon: lon, at: Date.now(), closing: closing };

  // Narrate as an APPROACHING vessel reaches the bridge (not on the pass), so the
  // ~5-10s of script + voice generation lands while it's on camera. narrateVessel()
  // dedupes via its own cooldown, so calling it on each nearing update is safe.
  if (prevNear && distKm < prevNear.distKm && distKm <= NARRATE_TRIGGER_KM) {
    narrateVessel(mmsi, name, side === 'west' ? 'eastbound' : 'westbound', speed)
      .catch(err => console.error('🎙️ narrateVessel(approach) error:', err.message));
  }

  if (!prev) {
    console.log(`🌉 Near bridge: ${name} (${mmsi}) on ${side} side, ${(distKm * 0.621371).toFixed(1)} mi out`);
    return;
  }
  if (prev.side === side) return;
  if (Date.now() - prev.at > PASS_STALE_MS) return; // old observation — treat as a fresh sighting

  // Side flipped while near the bridge → it passed underneath
  const last = lastPassRecordedAt[mmsi];
  if (last && Date.now() - last < PASS_COOLDOWN_MS) return;
  lastPassRecordedAt[mmsi] = Date.now();

  const direction = side === 'east' ? 'eastbound' : 'westbound';
  recordPassing(mmsi, name, direction).catch(err =>
    console.error('❌ Error recording passing:', err.message));
  narrateVessel(mmsi, name, direction, speed).catch(err =>
    console.error('🎙️ narrateVessel error:', err.message));
}

async function recordPassing(mmsi, name, direction) {
  const rec = { mmsi, name, direction, passedTime: new Date() };
  recentPassingsMemory.unshift(rec);
  if (recentPassingsMemory.length > 20) recentPassingsMemory.pop();
  console.log(`🌉 PASSED THE BRIDGE: ${name} (${mmsi}) ${direction} at ${rec.passedTime.toISOString()}`);
  if (passingsCollection) {
    await passingsCollection.insertOne({ ...rec });
  }
  // Push to connected banners so they can update without waiting for the next poll
  broadcastToClients({ type: 'bridge_passing', data: { mmsi, name, direction, passedTime: rec.passedTime.toISOString() } });
}

async function getRecentPassings(limit = 10) {
  if (!passingsCollection) return recentPassingsMemory.slice(0, limit);
  try {
    const rows = await passingsCollection.find({}).sort({ passedTime: -1 }).limit(limit).toArray();
    return rows.map(r => ({ mmsi: r.mmsi, name: r.name, direction: r.direction, passedTime: r.passedTime }));
  } catch (error) {
    console.error('❌ Error reading passings:', error.message);
    return recentPassingsMemory.slice(0, limit);
  }
}

// ═══════════════════════════════════════════════════════════════
//  VESSEL VOICE NARRATION  (Claude Haiku script → ElevenLabs TTS)
//  When a notable vessel passes the bridge, generate a short spoken
//  narration and broadcast a `narrate` event with an audio URL. The
//  overlay plays it, and OBS captures that browser-source audio onto
//  the stream. Falls back to a template script if ANTHROPIC_API_KEY
//  isn't set; a no-op entirely if ELEVENLABS_API_KEY is missing.
// ═══════════════════════════════════════════════════════════════
const ELEVEN_KEY    = process.env.ELEVENLABS_API_KEY || null;
const ELEVEN_VOICE  = process.env.ELEVENLABS_VOICE_ID || 'Dslrhjl3ZpzrctukrQSN';
const ELEVEN_MODEL  = 'eleven_multilingual_v2';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || null;
const NARRATE_MIN_LEN_M = 120;   // ~400 ft — narrate only big vessels (unless they have a curated fact)
const NARRATION_ON  = !!ELEVEN_KEY && typeof fetch === 'function';

if (!ELEVEN_KEY) console.log('🎙️ Vessel narration OFF (set ELEVENLABS_API_KEY to enable)');
else if (typeof fetch !== 'function') console.error('🎙️ Vessel narration needs Node 18+ (global fetch). Disabled.');
else console.log('🎙️ Vessel narration ENABLED — ' + (ANTHROPIC_KEY ? 'Claude Haiku scripts' : 'template scripts (set ANTHROPIC_API_KEY for LLM-written)'));

// Canonical key for matching a live AIS name to a curated fact.
// US Coast Guard cutters broadcast their AIS name as "CG NEAH BAY", but references
// (and our curated facts) key them as "CGC NEAH BAY" / "USCGC NEAH BAY". Collapse
// every Coast-Guard prefix to one form so those facts actually match the live name.
function factKey(name) {
  return String(name || '').trim().toUpperCase().replace(/^(?:USCGC|USCG|CGC|CG)\s+/, 'CG ');
}

// Curated facts for the narrator (NAME -> fact), loaded once at startup
let NARR_FACTS = {};
(function loadNarrationFacts() {
  try {
    const f = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'vessel-facts.json'), 'utf8'));
    (f.vessels || []).forEach(v => { if (v.name && v.fact) NARR_FACTS[factKey(v.name)] = v.fact; });
    console.log('🎙️ Narrator loaded ' + Object.keys(NARR_FACTS).length + ' vessel facts');
  } catch (e) { console.error('🎙️ Narration facts load failed:', e.message); }
})();

// Say-it-right map — applied to the SPOKEN text only (the banner keeps correct spelling)
const PRONUNCIATION = [ [/Mackinac/gi, 'Mackinaw'] ];
function applyPronunciation(t) { PRONUNCIATION.forEach(p => { t = t.replace(p[0], p[1]); }); return t; }

// Current time of day in the Straits (US Eastern) so the narrator never guesses wrong
// (e.g. says "this morning" at night). Render runs on UTC, so convert explicitly.
function localTimeOfDay() {
  try {
    const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Detroit', hour: '2-digit', hourCycle: 'h23' }).format(new Date()), 10);
    if (h < 5)  return 'overnight';
    if (h < 12) return 'this morning';
    if (h < 17) return 'this afternoon';
    if (h < 21) return 'this evening';
    return 'tonight';
  } catch (e) { return 'today'; }
}

function narrationTemplate(v) {
  const dir = v.direction === 'eastbound' ? 'heading east toward Lake Huron'
            : v.direction === 'westbound' ? 'heading west toward Lake Michigan'
            : 'transiting the straits';
  const fact = v.fact ? ' ' + v.fact.replace(/[.\s]+$/, '') + '.' : '';
  const spd  = v.speed ? ` She's ${dir} at about ${v.speed} knots.` : ` She's ${dir}.`;
  return `Now passing beneath the Mackinac Bridge — the ${v.name}.${fact}${spd}`;
}

async function narrationScriptLLM(v) {
  const system =
    'You narrate a live webcam of ships passing under the Mackinac Bridge in the Straits of Mackinac. ' +
    'Write 2 to 3 sentences (about 45 to 60 words, ~20 seconds spoken) introducing this Great Lakes vessel as it passes beneath the bridge. ' +
    'Warm, documentary tone, like a knowledgeable local. Weave the fun fact in naturally; you may note its direction and speed. ' +
    'If you refer to the time of day, use EXACTLY the "Time of day" value provided below — never guess it (it may be evening or night, not morning). ' +
    'Spell numbers out as words. No markdown, no quotes, no preamble — output ONLY the narration text.';
  const user =
    'Vessel name: ' + v.name + '\n' +
    'Fun fact: ' + (v.fact || '(none provided)') + '\n' +
    'Length: ' + (v.lengthFt ? v.lengthFt + ' feet' : 'unknown') + '\n' +
    'Direction: ' + (v.direction || 'unknown') + '\n' +
    'Speed: ' + (v.speed || '?') + ' knots\n' +
    'Time of day: ' + localTimeOfDay();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 300, system, messages: [{ role: 'user', content: user }] })
  });
  if (!res.ok) throw new Error('Anthropic ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
  if (!text) throw new Error('empty script');
  return { text: text, usage: j.usage || null };
}

async function synthesizeVoice(text) {
  const url = 'https://api.elevenlabs.io/v1/text-to-speech/' + ELEVEN_VOICE + '?output_format=mp3_44100_128';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: ELEVEN_MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.8, use_speaker_boost: true, speed: 1.1 } })
  });
  if (!res.ok) throw new Error('ElevenLabs ' + res.status + ': ' + (await res.text()).slice(0, 200));
  return Buffer.from(await res.arrayBuffer());
}

const narrationCache = {};        // mmsi -> { buffer, at }
const narrationInFlight = new Set();

// ── Narration cost logging ─────────────────────────────────────
// ElevenLabs Multilingual v2 bills 1 credit / character (~$0.10 per 1,000 chars
// at pay-as-you-go; within a monthly plan it draws from included credits).
// Flash v2.5 is half that. Claude Haiku 4.5 writes the script at $1 / 1M input
// tokens and $5 / 1M output tokens.
const ELEVEN_USD_PER_1K   = /flash/i.test(ELEVEN_MODEL) ? 0.05 : 0.10;
const HAIKU_USD_IN_PER_1M = 1.0;
const HAIKU_USD_OUT_PER_1M = 5.0;
const recentNarrationsMemory = []; // newest first — fallback if the DB is down

async function recordNarration(ev) {
  recentNarrationsMemory.unshift(ev);
  if (recentNarrationsMemory.length > 1000) recentNarrationsMemory.pop();
  if (narrationsCollection) {
    try { await narrationsCollection.insertOne({ ...ev }); }
    catch (e) { console.error('🎙️ Narration log write failed:', e.message); }
  }
}

function narrationCost(r) {
  const eleven = (r.chars || 0) / 1000 * ELEVEN_USD_PER_1K;
  const llm = (r.inTok || 0) / 1e6 * HAIKU_USD_IN_PER_1M + (r.outTok || 0) / 1e6 * HAIKU_USD_OUT_PER_1M;
  return { eleven: eleven, llm: llm, total: eleven + llm };
}

// Narration cost/usage dashboard data — which vessels were narrated and what it cost
app.get('/api/narrations', async (req, res) => {
  try {
    let rows;
    if (narrationsCollection) rows = await narrationsCollection.find({}).sort({ at: -1 }).limit(300).toArray();
    else rows = recentNarrationsMemory.slice(0, 300);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const totals = { today: { count: 0, usd: 0, chars: 0 }, month: { count: 0, usd: 0, chars: 0 }, all: { count: 0, usd: 0, chars: 0 } };
    const add = (b, c, chars) => { b.count++; b.usd += c.total; b.chars += chars; };
    const list = rows.map(r => {
      const c = narrationCost(r);
      const chars = r.chars || 0;
      add(totals.all, c, chars);
      if (r.at >= startMonth) add(totals.month, c, chars);
      if (r.at >= startToday) add(totals.today, c, chars);
      return {
        mmsi: r.mmsi, name: r.name, direction: r.direction || null, at: r.at, chars: chars,
        model: r.model || '?', hadFact: !!r.hadFact,
        usd: +c.total.toFixed(4), elevenUsd: +c.eleven.toFixed(4), llmUsd: +c.llm.toFixed(5)
      };
    });
    const round = o => ({ count: o.count, chars: o.chars, usd: +o.usd.toFixed(2), usdPrecise: +o.usd.toFixed(4) });
    res.json({
      rate: { elevenUsdPer1kChars: ELEVEN_USD_PER_1K, model: ELEVEN_MODEL,
        note: 'ElevenLabs $ is an estimate at pay-as-you-go rates; inside your monthly plan it draws from included credits (1 character = 1 credit on Multilingual v2). Claude Haiku cost is billed as real dollars.' },
      totals: { today: round(totals.today), month: round(totals.month), all: round(totals.all) },
      narrations: list
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/narrations', (req, res) => res.sendFile(path.join(__dirname, 'narrations.html')));

async function narrateVessel(mmsi, name, direction, speed) {
  if (!NARRATION_ON) return;
  const cleanName = (name || '').trim();
  if (!cleanName || cleanName.toUpperCase() === 'UNKNOWN') return; // never narrate an un-named vessel
  const fact = NARR_FACTS[factKey(cleanName)] || null;
  const info = staticInfo[mmsi] || {};
  const bigEnough = info.length && info.length >= NARRATE_MIN_LEN_M;
  if (!fact && !bigEnough) return;                 // only notable / big vessels get narrated
  if (narrationInFlight.has(mmsi)) return;
  if (lastNarratedAt[mmsi] && Date.now() - lastNarratedAt[mmsi] < NARRATE_COOLDOWN_MS) return;
  narrationInFlight.add(mmsi);
  lastNarratedAt[mmsi] = Date.now();
  try {
    const v = {
      name: name, direction: direction, speed: Math.round(speed || 0), fact: fact,
      lengthFt: info.length ? Math.round(info.length * 3.28084) : null
    };
    let text, llmUsage = null, usedLLM = false;
    try {
      if (ANTHROPIC_KEY) { const r = await narrationScriptLLM(v); text = r.text; llmUsage = r.usage; usedLLM = true; }
      else text = narrationTemplate(v);
    }
    catch (e) { console.error('🎙️ Script gen failed (' + name + '), using template:', e.message); text = narrationTemplate(v); }
    text = applyPronunciation(text);
    const buffer = await synthesizeVoice(text);
    narrationCache[mmsi] = { buffer: buffer, at: Date.now() };
    console.log('🎙️ Narration ready: ' + name + '  "' + text.slice(0, 90) + '"');
    recordNarration({
      mmsi: mmsi, name: name, direction: direction || null, at: Date.now(),
      chars: text.length, model: usedLLM ? 'llm' : 'template', hadFact: !!fact,
      inTok: llmUsage ? (llmUsage.input_tokens || 0) : 0,
      outTok: llmUsage ? (llmUsage.output_tokens || 0) : 0
    }).catch(e => console.error('🎙️ recordNarration:', e.message));
    broadcastToClients({ type: 'narrate', data: { mmsi: mmsi, name: name, url: '/api/narration/' + mmsi + '?t=' + Date.now() } });
  } catch (e) {
    console.error('🎙️ Narration failed (' + name + '):', e.message);
  } finally {
    narrationInFlight.delete(mmsi);
  }
}

// Serve a generated vessel narration clip (kept in memory ~30 min)
app.get('/api/narration/:mmsi', (req, res) => {
  const entry = narrationCache[req.params.mmsi];
  if (!entry) return res.status(404).end();
  res.set('Cache-Control', 'no-store');
  res.type('audio/mpeg').send(entry.buffer);
});

// Manual test — fire a narration on demand so you can verify audio/ducking without
// waiting for a real vessel. Gated by LOCAL_AIS_KEY (the key already set on Render).
//   GET /api/narrate-test?name=MESABI%20MINER&direction=eastbound&speed=13&key=YOUR_KEY
app.get('/api/narrate-test', async (req, res) => {
  if (LOCAL_AIS_KEY && (req.query.key || req.headers['x-api-key']) !== LOCAL_AIS_KEY)
    return res.status(403).json({ error: 'invalid key' });
  if (!NARRATION_ON) return res.status(503).json({ error: 'narration off — set ELEVENLABS_API_KEY on Render' });
  const name = String(req.query.name || 'MESABI MINER');
  const mmsi = 'test-' + name.replace(/\s+/g, '').slice(0, 16);
  const direction = String(req.query.direction || 'eastbound');
  const speed = Number(req.query.speed) || 12;
  // If the vessel has no curated fact, give it a length so it clears the size gate
  if (!NARR_FACTS[factKey(name)]) staticInfo[mmsi] = { type: 70, length: 300 };
  try {
    await narrateVessel(mmsi, name, direction, speed);
    res.json({ ok: true, name, played: '/api/narration/' + mmsi });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Keep the in-memory audio cache bounded — drop clips older than 30 minutes
setInterval(() => {
  const cut = Date.now() - 30 * 60 * 1000;
  Object.keys(narrationCache).forEach((k) => { if (narrationCache[k].at < cut) delete narrationCache[k]; });
}, 5 * 60 * 1000);

// AISStream configuration
const API_KEY = process.env.AISSTREAM_API_KEY;
if (!API_KEY) {
  console.error('❌ AISSTREAM_API_KEY environment variable is not set');
  process.exit(1);
}

// Mackinac Bridge center point
// Exact center of the Mackinac Bridge. The passing detector fires when a vessel's
// longitude crosses BRIDGE_LON, so this longitude IS the "under the bridge" line.
const BRIDGE_LAT = 45.81169175762412;
const BRIDGE_LON = -84.72866535186769;

// Large bounding box covering Lake Michigan + Lake Huron
// ~400km north/south, ~600km east/west — maximizes AISStream coverage for diagnostics
const BBOX = {
  minLat: 41.5,   // southern Lake Michigan (Chicago area)
  maxLat: 47.5,   // northern Lake Superior approach
  minLon: -88.5,  // western Lake Michigan (Milwaukee)
  maxLon: -79.5   // eastern Lake Huron (Ontario border)
};

let aisConnection = null;
let reconnectTimeout = null;
let isConnecting = false;
let reconnectAttempts = 0;

// Live diagnostics for /api/status — proves whether AIS data is flowing
let lastAisMessageAt = null;
let aisMessagesTotal = 0;
const recentVessels = {}; // mmsi → { name, lastSeen } for vessels seen in last 10 min

// Watchdog — if no message arrives within this window, assume zombie connection and reconnect
const WATCHDOG_MS = 5 * 60 * 1000; // 5 minutes
let watchdogTimer = null;

function resetWatchdog() {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(() => {
    console.warn('⚠️  Watchdog: no AISStream data for 5 minutes — forcing reconnect');
    if (aisConnection) {
      aisConnection.terminate(); // hard-kill so onclose fires immediately
    } else {
      connectToAISStream();
    }
  }, WATCHDOG_MS);
}

function stopWatchdog() {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
}

// Database helper functions
async function saveShipToDatabase(shipData) {
  if (!shipsCollection) return;
  
  try {
    const shipRecord = {
      mmsi: shipData.mmsi,
      name: shipData.name,
      type: shipData.type || 'Unknown',
      destination: shipData.destination || null,
      dimensions: shipData.dimensions || null,
      firstSeen: new Date(),
      lastSeen: new Date(),
      direction: shipData.direction,
      maxSpeed: shipData.speed || 0,
      passedBridge: false,
      passedBridgeTime: null
    };
    
    await shipsCollection.updateOne(
      { 
        mmsi: shipData.mmsi,
        passedBridge: false
      },
      { 
        $set: {
          lastSeen: new Date(),
          direction: shipData.direction,
          maxSpeed: Math.max(shipData.speed || 0, shipRecord.maxSpeed)
        },
        $setOnInsert: {
          mmsi: shipRecord.mmsi,
          name: shipRecord.name,
          type: shipRecord.type,
          destination: shipRecord.destination,
          dimensions: shipRecord.dimensions,
          firstSeen: shipRecord.firstSeen,
          passedBridge: false
        }
      },
      { upsert: true }
    );
    
    console.log('💾 Saved ship to database:', shipData.name);
  } catch (error) {
    console.error('❌ Error saving ship:', error.message);
  }
}

async function markShipAsPassed(mmsi, name) {
  if (!shipsCollection) return;
  
  try {
    await shipsCollection.updateOne(
      { mmsi: mmsi, passedBridge: false },
      { 
        $set: { 
          passedBridge: true,
          passedBridgeTime: new Date()
        }
      }
    );
    console.log('🌉 Marked ship as passed:', name);
  } catch (error) {
    console.error('❌ Error marking ship as passed:', error.message);
  }
}

async function getRecentShips(limit = 10) {
  if (!shipsCollection) return [];
  
  try {
    const recentShips = await shipsCollection
      .find({ passedBridge: true })
      .sort({ passedBridgeTime: -1 })
      .limit(limit)
      .toArray();
    
    return recentShips.map(ship => ({
      mmsi: ship.mmsi,
      name: ship.name,
      direction: ship.direction,
      passedTime: ship.passedBridgeTime
    }));
  } catch (error) {
    console.error('❌ Error getting recent ships:', error.message);
    return [];
  }
}

async function getShipStats() {
  if (!shipsCollection) return null;
  
  try {
    const total = await shipsCollection.countDocuments({ passedBridge: true });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayCount = await shipsCollection.countDocuments({
      passedBridge: true,
      passedBridgeTime: { $gte: today }
    });
    
    return { total, today: todayCount };
  } catch (error) {
    console.error('❌ Error getting stats:', error.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// VESSEL NAME CACHE — position reports carry no name; names arrive
// only in infrequent static messages (every ~6 min). We seed a cache
// from names AISStream logged historically (the `ships` collection)
// and learn new ones live, so "Unknown" vessels get named on their
// next position report instead of waiting for a static broadcast.
// ─────────────────────────────────────────────────────────────
const nameCache = {}; // mmsi -> name

async function loadNameCache() {
  if (!shipsCollection) return;
  try {
    const rows = await shipsCollection
      .find({ name: { $nin: [null, '', 'Unknown'] } }, { projection: { mmsi: 1, name: 1 } })
      .toArray();
    let n = 0;
    for (const r of rows) {
      if (r.mmsi && r.name) { nameCache[r.mmsi] = r.name; n++; }
    }
    console.log(`📇 Loaded ${n} vessel names from history`);
  } catch (err) {
    console.error('❌ Name cache load error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// SHARED AIS PIPELINE — every message, whether from AISStream or
// the local motel receiver, goes through here: DB save,
// bridge-passing detection, and broadcast to connected banners.
// ─────────────────────────────────────────────────────────────
function processAisMessage(message, source) {
  // Resolve the vessel name against the cache before anything else,
  // so both the DB save and the banner broadcast carry the real name.
  const meta = message.MetaData;
  if (meta && meta.MMSI) {
    const rawName = (meta.ShipName || '').trim();
    if (rawName && rawName !== 'Unknown') {
      // Learn a real name (and persist it once so it survives restarts)
      if (nameCache[meta.MMSI] !== rawName) {
        nameCache[meta.MMSI] = rawName;
        if (shipsCollection) shipsCollection.updateMany({ mmsi: meta.MMSI }, { $set: { name: rawName } }).catch(() => {});
      }
    } else if (nameCache[meta.MMSI]) {
      // Backfill an "Unknown" from the cache so the banner shows a name now
      meta.ShipName = nameCache[meta.MMSI];
    }
  }

  // Range diagnostics — record how far the LOCAL antenna heard this vessel (pre-filter,
  // so ferries/small craft count too; they still prove the antenna reached that distance).
  if (source === 'local' && message.MessageType === 'PositionReport' && message.Message && message.Message.PositionReport && meta && meta.MMSI) {
    const p = message.Message.PositionReport;
    if (typeof p.Latitude === 'number' && typeof p.Longitude === 'number') {
      const dMi = haversineKm(p.Latitude, p.Longitude, BRIDGE_LAT, BRIDGE_LON) * 0.621371;
      localReception[meta.MMSI] = { name: (meta.ShipName || 'Unknown'), mmsi: meta.MMSI, distanceMi: dMi, lat: p.Latitude, lon: p.Longitude, at: Date.now() };
    }
  }

  // Learn vessel type + length from static messages (drives the size/type filter)
  if (message.MessageType === 'ShipStaticData' && message.Message && message.Message.ShipStaticData && meta && meta.MMSI) {
    const sd = message.Message.ShipStaticData;
    const dim = sd.Dimension || {};
    const length = (dim.A || 0) + (dim.B || 0);
    staticInfo[meta.MMSI] = { type: sd.Type || null, length: length || null };
  }

  if (message.MessageType === 'PositionReport' && message.MetaData) {
    // Single source of truth: drop hidden vessels (ferries, small craft,
    // blocklist) here so no overlay ever sees them.
    if (shouldHideVessel(message.MetaData.MMSI)) return;

    const shipInfo = {
      mmsi: message.MetaData.MMSI,
      name: message.MetaData.ShipName?.trim() || 'Unknown',
      type: message.MetaData.ShipType || null,
      speed: message.Message?.PositionReport?.Sog || 0,
      direction: null // Will be calculated by frontend
    };

    console.log(`🚢 Ship received (${source}): ${shipInfo.name} (MMSI: ${shipInfo.mmsi}) Speed: ${shipInfo.speed} kts`);

    // Track for /api/status diagnostics
    recentVessels[shipInfo.mmsi] = { name: shipInfo.name, lastSeen: Date.now() };

    // Detect bridge passings (side-of-bridge crossing)
    const pos = message.Message.PositionReport;
    checkBridgePassing(shipInfo.mmsi, shipInfo.name, pos.Latitude, pos.Longitude, shipInfo.speed);

    // Save to database (async, don't wait)
    saveShipToDatabase(shipInfo).catch(err =>
      console.error('Database save error:', err.message)
    );
  }

  // Enrich position reports with the vessel's known size/type so overlays can
  // build a fallback "fun fact" for vessels that aren't in the curated list.
  if (message.MessageType === 'PositionReport' && meta && meta.MMSI) {
    const si = staticInfo[meta.MMSI];
    if (si) {
      if (si.length) meta.VesselLengthM = si.length;
      if (si.type) meta.VesselType = si.type;
    }
  }

  // Forward all messages to connected clients (banners)
  broadcastToClients({
    type: 'ship_data',
    data: message
  });
}

// ─────────────────────────────────────────────────────────────
// LOCAL AIS RECEIVER — AIS-catcher on the motel streaming PC
// POSTs decoded JSON here. Messages are converted to the same
// shape AISStream uses and fed through the shared pipeline.
// ─────────────────────────────────────────────────────────────
let lastLocalMessageAt = null;
let localMessagesTotal = 0;
const localShipNames = {}; // mmsi → name learned from static messages (position reports carry no name)
// Range diagnostics: how far from the bridge the LOCAL antenna is actually hearing vessels.
// Tracks every local-source position report (pre-filter, so small craft count too).
const localReception = {}; // mmsi → { name, mmsi, distanceMi, lat, lon, at }

// Convert one AIS-catcher decoded message (gpsd-style fields) to the AISStream shape
function aisCatcherToStreamMessage(m) {
  if (!m || typeof m.mmsi !== 'number') return null;
  const t = m.type;

  // Position reports: CLASS A ONLY (1,2,3) + long-range (27).
  // Class B (18/19) is small recreational craft — excluded so the banner
  // shows commercial ships, matching how AISStream's feed behaved.
  if ([1, 2, 3, 27].includes(t) && typeof m.lat === 'number' && typeof m.lon === 'number') {
    if (m.lat > 90 || m.lat < -90 || m.lon > 180 || m.lon < -180) return null; // "unavailable" AIS placeholders
    const name = (m.shipname || localShipNames[m.mmsi] || 'Unknown');
    return {
      MessageType: 'PositionReport',
      MetaData: {
        MMSI: m.mmsi,
        ShipName: name,
        latitude: m.lat,
        longitude: m.lon,
        time_utc: m.rxtime || new Date().toISOString()
      },
      Message: {
        PositionReport: {
          Latitude: m.lat,
          Longitude: m.lon,
          Sog: m.speed ?? m.sog ?? 0,
          Cog: m.course ?? m.cog ?? 0
        }
      }
    };
  }

  // Static data: Class A voyage data (5), Class B static (24)
  if ((t === 5 || t === 24) && (m.shipname || m.shiptype || m.destination)) {
    if (m.shipname) localShipNames[m.mmsi] = String(m.shipname).trim();
    return {
      MessageType: 'ShipStaticData',
      MetaData: {
        MMSI: m.mmsi,
        ShipName: m.shipname || localShipNames[m.mmsi] || 'Unknown'
      },
      Message: {
        ShipStaticData: {
          Type: m.shiptype || null,
          Destination: (m.destination || '').trim() || null,
          Dimension: { A: m.to_bow || 0, B: m.to_stern || 0, C: m.to_port || 0, D: m.to_starboard || 0 }
        }
      }
    };
  }

  return null;
}

// Connect to AISStream
function connectToAISStream() {
  if (isConnecting) return;
  isConnecting = true;

  console.log('Connecting to AISStream...');
  
  // rejectUnauthorized: false works around expired/untrusted TLS cert on Render's container
  aisConnection = new WebSocket('wss://stream.aisstream.io/v0/stream', [], {
    rejectUnauthorized: false
  });
  
  aisConnection.on('open', () => {
    console.log('✓ Connected to AISStream');
    isConnecting = false;
    reconnectAttempts = 0;
    resetWatchdog(); // start watchdog now that we're connected
    
    // Subscribe to Mackinac Bridge area
    const subscription = {
      APIKey: API_KEY,
      BoundingBoxes: [[
        [BBOX.minLat, BBOX.minLon],
        [BBOX.maxLat, BBOX.maxLon]
      ]]
      // No FilterMessageTypes - get all message types including ShipStaticData
    };
    
    aisConnection.send(JSON.stringify(subscription));
    console.log('✓ Subscribed to Mackinac Bridge area');
    
    // Broadcast connection status to all clients
    broadcastToClients({
      type: 'status',
      message: 'Connected to AISStream',
      connected: true
    });
  });
  
  aisConnection.on('message', (data) => {
    resetWatchdog(); // any incoming message proves the connection is alive
    lastAisMessageAt = Date.now();
    aisMessagesTotal++;
    try {
      const message = JSON.parse(data);
      processAisMessage(message, 'aisstream');
    } catch (error) {
      console.error('Error parsing AIS message:', error);
    }
  });
  
  aisConnection.on('error', (error) => {
    console.error('AISStream error:', error);
    isConnecting = false;
    
    broadcastToClients({
      type: 'status',
      message: 'AISStream connection error',
      connected: false
    });
  });
  
  aisConnection.on('close', () => {
    console.log('AISStream connection closed');
    isConnecting = false;
    aisConnection = null;
    stopWatchdog();
    
    broadcastToClients({
      type: 'status',
      message: 'Disconnected from AISStream',
      connected: false
    });
    
    // Exponential backoff: 5s, 10s, 20s, 40s, capped at 60s
    reconnectAttempts++;
    const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000);
    console.log(`Reconnecting to AISStream in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
    reconnectTimeout = setTimeout(() => {
      connectToAISStream();
    }, delay);
  });
}

// Broadcast message to all connected clients
function broadcastToClients(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// Handle client connections
wss.on('connection', (ws) => {
  console.log('Client connected. Total clients:', wss.clients.size);
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'status',
    message: 'Connected to proxy server',
    connected: true
  }));
  
  // Connect to AISStream if not already connected
  if (!aisConnection && !isConnecting) {
    connectToAISStream();
  } else if (aisConnection && aisConnection.readyState === WebSocket.OPEN) {
    // Send current connection status
    ws.send(JSON.stringify({
      type: 'status',
      message: 'AISStream active',
      connected: true
    }));
  }
  
  ws.on('close', () => {
    console.log('Client disconnected. Total clients:', wss.clients.size);
    
    // Note: We keep AISStream connected even with 0 clients
    // This allows continuous ship tracking when UptimeRobot pings keep server awake
  });
  
  ws.on('error', (error) => {
    console.error('Client WebSocket error:', error);
  });
});

// Start server
const PORT = process.env.PORT || 3000;

// Initialize MongoDB first, then start server
connectToMongoDB().then(() => {
  server.listen(PORT, () => {
    console.log(`🚢 Ship Tracker Proxy Server running on port ${PORT}`);
    console.log(`📍 Monitoring Mackinac Bridge area`);
    console.log(`📡 Lat: ${BBOX.minLat.toFixed(4)} to ${BBOX.maxLat.toFixed(4)}`);
    console.log(`📡 Lon: ${BBOX.minLon.toFixed(4)} to ${BBOX.maxLon.toFixed(4)}`);
    
    // Connect to AISStream immediately for 24/7 monitoring
    connectToAISStream();
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing connections...');
  if (aisConnection) {
    aisConnection.close();
  }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
