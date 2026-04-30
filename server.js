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
  
  aisConnection = new WebSocket('wss://stream.aisstream.io/v0/stream');
  
  aisConnection.on('open', () => {
    console.log('✓ Connected to AISStream');
    isConnecting = false;
    reconnectAttempts = 0;
    
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
