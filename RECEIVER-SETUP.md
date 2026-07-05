# Local AIS Receiver Setup (Riviera Motel)

Turns the streaming PC + RTL-SDR dongle + roof antenna into a live AIS feed
for the ship tracker. Do the indoor test (steps 1–4) BEFORE any roof work.

## Hardware chain

```
[Shakespeare 5215 antenna] → [4187-BX mount] → [50ft KMR-400 coax]
  → [SMA-to-SO-239 adapter] → [NESDR Smart dongle] → [streaming PC USB]
```

## 1. Install the dongle driver

1. Plug the dongle into the PC.
2. Download Zadig from https://zadig.akeo.ie
3. Run it → Options → List All Devices → select **Bulk-In, Interface (Interface 0)**
   (or "RTL2838UHIDIR") → driver **WinUSB** → Install/Replace Driver.

## 2. Install AIS-catcher

1. Download the latest Windows release zip:
   https://github.com/jvde-github/AIS-catcher/releases
2. Extract to a folder, e.g. `C:\AIS-catcher`.

## 3. Indoor smoke test

Screw the antenna onto the coax + adapter, stand it upright near a window
facing the water, then in a command prompt:

```
cd C:\AIS-catcher
AIS-catcher -d 0 -N 8100
```

Open http://localhost:8100 — AIS-catcher's own live map. Ships in the
straits should appear within a minute or two. If you see ships, the whole
radio chain works; everything after this is just improving range.

## 4. Feed the tracker

Get the `LOCAL_AIS_KEY` value (same one set in Render's environment), then:

```
AIS-catcher -d 0 -N 8100 -H "https://mackinac-ship-tracker.onrender.com/api/local-ais?key=YOUR_KEY_HERE" INTERVAL 5
```

Verify: open https://mackinac-ship-tracker.onrender.com/api/status —
`localReceiver.lastMessageSecondsAgo` should be a small number and
`messagesSinceBoot` climbing.

If AIS-catcher errors on the https URL (some builds lack SSL), use the
relay instead — it needs Node.js (nodejs.org, LTS installer):

```
node ais-relay.js YOUR_KEY_HERE 8110
AIS-catcher -d 0 -N 8100 -H "http://localhost:8110" INTERVAL 5
```

## 5. Run it 24/7

Create `run-ais.bat` in the AIS-catcher folder with the working command,
then Task Scheduler → Create Basic Task → "AIS Receiver" → At startup →
Start that .bat. (Add a second task for the relay if using it.)

## 6. Mount the antenna (after the smoke test passes)

- As high as possible — roof edge/peak, clear line of sight to the water.
- Vertical, a few feet away from metal (AC units, gutters, other antennas).
- Drip loop in the coax where it enters the building.
- Rerun the smoke test after mounting — range should jump dramatically.

## 7. Optional: free premium accounts

Register the station and split the feed (AIS-catcher supports multiple
`-u` UDP outputs alongside `-H`):

- MarineTraffic: https://www.marinetraffic.com/en/join-us/cover-your-area
- VesselFinder: https://stations.vesselfinder.com
- AISHub (data-sharing co-op): https://www.aishub.net

Each gives feed contributors a free premium/pro account.
