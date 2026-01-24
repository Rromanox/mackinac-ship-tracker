// server.js - Glitch Backend for AISStream Proxy
const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Ship Tracker Proxy Server Running',
    connections: wss.clients.size,
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
server.listen(PORT, () => {
  console.log(`🚢 Ship Tracker Proxy Server running on port ${PORT}`);
  console.log(`📍 Monitoring Mackinac Bridge area`);
  console.log(`📡 Lat: ${BBOX.minLat.toFixed(4)} to ${BBOX.maxLat.toFixed(4)}`);
  console.log(`📡 Lon: ${BBOX.minLon.toFixed(4)} to ${BBOX.maxLon.toFixed(4)}`);
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