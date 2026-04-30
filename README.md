# Mackinac Bridge Ship Tracker

Real-time AIS ship tracking for the Mackinac Straits. Ships within a 15-mile radius of the Mackinac Bridge are displayed live, with speed, heading, ETA, destination, and dimensions. Ships that pass under the bridge are logged to MongoDB.

## Architecture

```
AISStream (WebSocket) ──► server.js (Node/Express) ──► index.html (Browser)
                                │
                           MongoDB Atlas
                        (ship passage history)
```

- **Backend** (`server.js`) — proxies AISStream WebSocket data, saves ship records to MongoDB
- **Frontend** (`index.html`) — connects via WebSocket, renders live ship cards, detects bridge passage
- **Hosted on** Render.com (free tier); database on MongoDB Atlas

## Setup

### 1. Clone and install

```bash
git clone https://github.com/Rromanox/mackinac-ship-tracker
cd mackinac-ship-tracker
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
# Edit .env and fill in your keys
```

| Variable | Description |
|---|---|
| `AISSTREAM_API_KEY` | Get a free key at [aisstream.io](https://aisstream.io) |
| `MONGODB_URI` | MongoDB Atlas connection string or `mongodb://localhost:27017` |
| `PORT` | Port to run the server on (default: 3000) |

### 3. Run locally

```bash
npm start
```

Open `index.html` in your browser — it auto-detects localhost and connects to `ws://localhost:3000`.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Health check — server status, DB connection, ship stats |
| `GET` | `/api/ships/recent?limit=10` | Last N ships that passed the bridge |
| `POST` | `/api/ships/:mmsi/passed` | Mark a ship as having passed (called by frontend) |

## Deployment (Render.com)

1. Push to GitHub
2. Create a new **Web Service** on Render pointing to the repo
3. Set environment variables in the Render dashboard:
   - `AISSTREAM_API_KEY`
   - `MONGODB_URI`
4. Deploy — the frontend auto-connects to the correct hostname
