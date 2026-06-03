// server.js - Ship Tracker Backend with MongoDB
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { MongoClient } = require('mongodb');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// MongoDB configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'shiptracker';
let db = null;
let shipsCollection = null;

// Connect to MongoDB
async function connectToMongoDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    shipsCollection = db.collection('ships');
    
    // Create indexes for better performance
    await shipsCollection.createIndex({ mmsi: 1 });
    await shipsCollection.createIndex({ timestamp: -1 });
    await shipsCollection.createIndex({ passedBridge: 1 });
    
    console.log('✓ Connected to MongoDB');
    console.log('📊 Database:', DB_NAME);
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

app.use(express.json());

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

// Test notification endpoint
app.get('/api/test-notify', async (req, res) => {
  if (!mailTransporter) {
    return res.json({ success: false, error: 'Mail transporter not initialized — check GMAIL_USER and GMAIL_PASS env vars' });
  }
  const to = [NOTIFY_EMAIL, NOTIFY_SMS].filter(Boolean);
  try {
    await mailTransporter.sendMail({
      from: GMAIL_USER,
      to,
      subject: '🚢 Test — Ship Tracker Alert',
      text: 'This is a test notification from the Mackinac Bridge Ship Tracker. Alerts are working!'
    });
    res.json({ success: true, to });
  } catch (err) {
    res.json({ success: false, error: err.message, to });
  }
});

// Health / status check (used by UptimeRobot and monitoring)
app.get('/api/status', async (req, res) => {
  const stats = await getShipStats();
  res.json({
    status: 'Ship Tracker Proxy Server Running',
    connections: wss.clients.size,
    database: db ? 'Connected' : 'Disconnected',
    stats: stats,
    timestamp: new Date().toISOString()
  });
});

// Recent ships that passed the bridge
app.get('/api/ships/recent', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const ships = await getRecentShips(limit);
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
// VESSEL ALERT NOTIFICATIONS — email + free SMS via carrier gateway
// ─────────────────────────────────────────────────────────────
const GMAIL_USER  = process.env.GMAIL_USER;       // mundograficokevinai@gmail.com
const GMAIL_PASS  = process.env.GMAIL_PASS;       // Gmail app password
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;    // romandicesare@outlook.com
const NOTIFY_SMS   = process.env.NOTIFY_SMS;      // 2318186017@txt.att.net

const ETA_ALERT_MIN = 10;   // notify when vessel is within this many minutes
const ALERT_COOLDOWN_MS = 90 * 60 * 1000; // 90 min cooldown per vessel

// Vessels that should never trigger alerts (same blocklist as frontend)
const BLOCKED_MMSI_ALERT = new Set([368165150, 367031360, 367139210, 367349450, 367721870, 367721930, 367721960]);
const ALLOWED_MMSI_ALERT = new Set([311050300]); // VICTORY II — override passenger filter

const alertedVessels = {}; // mmsi → timestamp of last alert

let mailTransporter = null;
if (GMAIL_USER && GMAIL_PASS) {
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
  });
  console.log('✉️  Mail transporter ready');
} else {
  console.warn('⚠️  GMAIL_USER / GMAIL_PASS not set — notifications disabled');
}

async function sendVesselAlert(name, distMi, etaMin) {
  if (!mailTransporter) return;
  const subject = `🚢 ${name} approaching Mackinac Bridge`;
  const text    = `${name} is ~${distMi} miles from the Mackinac Bridge with an ETA of approximately ${etaMin} minutes.\n\nhttps://mackinac-ship-tracker.onrender.com`;
  const to      = [NOTIFY_EMAIL, NOTIFY_SMS].filter(Boolean);
  try {
    await mailTransporter.sendMail({ from: GMAIL_USER, to, subject, text });
    console.log(`📱 Alert sent for ${name} (ETA ~${etaMin} min)`);
  } catch (err) {
    console.error('❌ Alert send error:', err.message);
  }
}

function checkVesselAlert(mmsi, name, lat, lon, speed, course) {
  // Skip blocked vessels (unless explicitly allowed)
  if (BLOCKED_MMSI_ALERT.has(mmsi) && !ALLOWED_MMSI_ALERT.has(mmsi)) return;

  // Only approaching vessels
  const dLat = lat - BRIDGE_LAT, dLon = lon - BRIDGE_LON;
  const bearing = (Math.atan2(-dLon, -dLat) * 180 / Math.PI + 360) % 360;
  const diff = Math.abs(((course - bearing) + 180 + 360) % 360 - 180);
  if (diff >= 90) return; // departing

  // Calculate distance and ETA
  const R = 6371;
  const dLatR = (BRIDGE_LAT - lat) * Math.PI / 180;
  const dLonR = (BRIDGE_LON - lon) * Math.PI / 180;
  const a = Math.sin(dLatR/2)**2 + Math.cos(lat*Math.PI/180)*Math.cos(BRIDGE_LAT*Math.PI/180)*Math.sin(dLonR/2)**2;
  const distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distMi = (distKm * 0.621371).toFixed(1);

  if (!speed || speed < 0.5) return;
  const etaMin = Math.round(distKm / (speed * 1.852) * 60);
  if (etaMin > ETA_ALERT_MIN || etaMin < 1) return;

  // Cooldown check
  const lastAlert = alertedVessels[mmsi];
  if (lastAlert && (Date.now() - lastAlert) < ALERT_COOLDOWN_MS) return;

  alertedVessels[mmsi] = Date.now();
  sendVesselAlert(name, distMi, etaMin).catch(console.error);
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
    try {
      const message = JSON.parse(data);
      
      // Save ship data to database when received
      if (message.MessageType === "PositionReport" && message.MetaData) {
        const shipInfo = {
          mmsi: message.MetaData.MMSI,
          name: message.MetaData.ShipName?.trim() || 'Unknown',
          type: message.MetaData.ShipType || null,
          speed: message.Message?.PositionReport?.Sog || 0,
          direction: null // Will be calculated by frontend
        };
        
        // Log ship received from AISStream
        console.log(`🚢 Ship received: ${shipInfo.name} (MMSI: ${shipInfo.mmsi}) Speed: ${shipInfo.speed} kts`);

        // Check if this vessel should trigger an alert
        const pos = message.Message.PositionReport;
        checkVesselAlert(shipInfo.mmsi, shipInfo.name, pos.Latitude, pos.Longitude, shipInfo.speed, pos.Cog || 0);
        
        // Save to database (async, don't wait)
        saveShipToDatabase(shipInfo).catch(err => 
          console.error('Database save error:', err.message)
        );
      }
      
      // Forward all messages to connected clients
      broadcastToClients({
        type: 'ship_data',
        data: message
      });
      
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
