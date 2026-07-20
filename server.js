// server.js - Ship Tracker Backend with MongoDB
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// MongoDB configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'shiptracker';
let db = null;
let shipsCollection = null;
let passingsCollection = null;

// Connect to MongoDB
async function connectToMongoDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    shipsCollection = db.collection('ships');
    passingsCollection = db.collection('passings');

    // Create indexes for better performance
    await shipsCollection.createIndex({ mmsi: 1 });
    await shipsCollection.createIndex({ timestamp: -1 });
    await shipsCollection.createIndex({ passedBridge: 1 });
    await passingsCollection.createIndex({ passedTime: -1 });
    await passingsCollection.createIndex({ mmsi: 1 });
    
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
]);
const ALLOWED_MMSI_SERVER = new Set([311050300]); // VICTORY II — big cruise ship, overrides size/type filters
const MIN_VESSEL_LEN = 50; // metres — below this, a vessel is not a Great Lakes freighter
const staticInfo = {};     // mmsi -> { type, length }  (learned from static messages)

function shouldHideVessel(mmsi) {
  if (ALLOWED_MMSI_SERVER.has(mmsi)) return false;
  if (BLOCKED_MMSI_SERVER.has(mmsi)) return true;
  const info = staticInfo[mmsi];
  if (info) {
    const t = info.type;
    if (t === 30 || t === 36 || t === 37 || (t >= 60 && t <= 69)) return true; // fishing, sailing, pleasure, passenger/ferry
    if (info.length && info.length < MIN_VESSEL_LEN) return true;               // too small to be a freighter
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

const vesselSides         = {}; // mmsi → { side, at }
const lastPassRecordedAt  = {}; // mmsi → timestamp
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
  if (distKm > PASS_TRACK_KM) { delete vesselSides[mmsi]; return; }
  if (!speed || speed < 0.5) return; // ignore drifting/moored vessels

  const side = lon < BRIDGE_LON ? 'west' : 'east';
  const prev = vesselSides[mmsi];
  vesselSides[mmsi] = { side, at: Date.now() };

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

// AISStream configuration
const API_KEY = process.env.AISSTREAM_API_KEY;
if (!API_KEY) {
  console.error('❌ AISSTREAM_API_KEY environment variable is not set');
  process.exit(1);
}

// Mackinac Bridge center point
const BRIDGE_LAT = 45.8174;
const BRIDGE_LON = -84.7278;

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
