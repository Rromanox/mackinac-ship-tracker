// server.js - Ship Tracker Backend with MongoDB
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
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
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Health check endpoint
app.get('/', async (req, res) => {
  const stats = await getShipStats();
  res.json({ 
    status: 'Ship Tracker Proxy Server Running',
    connections: wss.clients.size,
    database: db ? 'Connected' : 'Disconnected',
    stats: stats,
    timestamp: new Date().toISOString()
  });
});

// AISStream configuration
const API_KEY = "fe7a0e7dd439780159d6c3694023e6791ad63e2f";

// Mackinac Bridge bounding box
const BRIDGE_LAT = 45.8174;
const BRIDGE_LON = -84.7278;
const BBOX = {
  minLat: BRIDGE_LAT - 0.23,
  maxLat: BRIDGE_LAT + 0.23,
  minLon: BRIDGE_LON - 0.35,
  maxLon: BRIDGE_LON + 0.35
};

let aisConnection = null;
let reconnectTimeout = null;
let isConnecting = false;

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
    
    // Subscribe to Mackinac Bridge area
    const subscription = {
      APIKey: API_KEY,
      BoundingBoxes: [[
        [BBOX.minLon, BBOX.minLat],
        [BBOX.maxLon, BBOX.maxLat]
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
    
    // Reconnect after 5 seconds
    reconnectTimeout = setTimeout(() => {
      if (wss.clients.size > 0) {
        console.log('Reconnecting to AISStream...');
        connectToAISStream();
      }
    }, 5000);
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
    
    // If no clients left, close AISStream connection
    if (wss.clients.size === 0) {
      console.log('No clients connected. Closing AISStream connection.');
      if (aisConnection) {
        aisConnection.close();
        aisConnection = null;
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
    }
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