# Clip Poster — Setup (Phase 1: capture + render)

This runs on the **same machine as OBS**. When a ship passes the bridge it saves an
OBS replay, checks it isn't dark, and renders a vertical Short (name + fact burned in,
narration ducked over the live sound) into the `clips/` folder. **Nothing posts yet** —
Phase 1 is about getting great clips on disk so you can eyeball the quality.

## 1. Install the two tools

- **Node.js 18+** — https://nodejs.org (LTS). Check: `node -v`
- **ffmpeg** — the render engine. Easiest on Windows:
  ```
  winget install Gyan.FFmpeg
  ```
  Then **close and reopen** the terminal and check: `ffmpeg -version` and `ffprobe -version`.

## 2. Turn on two things in OBS

**a) WebSocket server** (lets the script talk to OBS)
- OBS ▸ **Tools ▸ WebSocket Server Settings**
- ✅ Enable WebSocket server → **Show Connect Info** → note the **Port** (4455) and **Password**.

**b) Replay Buffer** (the rolling recording we clip from)
- OBS ▸ **Settings ▸ Output ▸ Replay Buffer** → ✅ Enable
- **Maximum Replay Time: 40 seconds** (must be ≥ `CLIP_SECONDS`)
- Also check **Settings ▸ Output ▸ Recording ▸ Recording Format = mp4** (not mkv) so clips are upload-ready.
- Click **Start Replay Buffer** (the script also starts it automatically, but do it once to confirm it works).

## 3. Configure

```bash
cd clip-poster
npm install
copy .env.example .env
```
Open `.env` and fill in:
- `OBS_PASSWORD` — from step 2a
- `ANTHROPIC_API_KEY` — the same key the server uses (for Haiku-written titles). *Optional* — without it you still get clips, just with a simple templated title.

Everything else has working defaults.

## 4. Test it right now (no boat needed)

With OBS running and the replay buffer started:
```bash
npm run test-clip
```
It saves the **current** buffer and renders one clip immediately. Look in `clips/` — you
should get a vertical `.mp4` plus a `.json` with the title/description. **Send me that clip**
and I'll help tune the framing, caption size, and audio balance.

## 5. Run it for real

```bash
npm start
```
Leave it running. Next time a ship crosses the bridge you'll get a finished Short in `clips/`.
It skips clips that are too dark (night/fog) automatically.

## Tuning knobs (in `.env`)
- `CLIP_SECONDS` — Short length (keep ≤ your replay buffer time)
- `SAVE_DELAY_MS` — how long after the crossing to grab the clip (so the boat sits nicely in frame)
- `QUALITY_MIN_BRIGHTNESS` — raise to reject more marginal (dim) clips
- `AMBIENT_VOLUME` / `NARRATION_VOLUME` — the mix between live sound and the AI voice

## What's next (Phase 2)
Once the clips look good, I add the **auto-post half**: a scored daily pool that picks the
**best morning + best evening clip** and uploads them to YouTube Shorts. That needs a one-time
Google sign-in — I'll walk you through it then.
