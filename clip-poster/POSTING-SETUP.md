# YouTube Auto-Posting — Setup (Phase 2)

One-time Google authorization so the poster can upload to **your** channel. ~10 minutes.
Do this **on any computer** (you'll copy one small file to the OBS PC). Sign in with the
**Google account that owns your stream's YouTube channel** — that's where clips post.

---

## Part 1 — Google Cloud Console (get a credentials file)

1. Go to **https://console.cloud.google.com** and sign in (channel-owner account).
2. Top bar ▸ project dropdown ▸ **New Project** → name it `Mackinac Clips` ▸ **Create**. Make sure it's selected.
3. **Enable the API:** left menu ▸ **APIs & Services ▸ Library** → search **"YouTube Data API v3"** → click it ▸ **Enable**.
4. **Consent screen:** **APIs & Services ▸ OAuth consent screen**
   - User Type **External** ▸ Create
   - App name `Mackinac Clips`, your email for both support + developer contact ▸ Save and Continue
   - Scopes page → **Save and Continue** (skip; the script asks for what it needs)
   - Test users page → **Save and Continue** → **Back to Dashboard**
   - Click **PUBLISH APP** ▸ Confirm. *(This moves it to "Production" so your login doesn't expire every 7 days. It stays "unverified" — that's fine for your own channel.)*
5. **Create the credential:** **APIs & Services ▸ Credentials** ▸ **+ Create Credentials ▸ OAuth client ID**
   - Application type: **Desktop app** ▸ name it `clip-poster` ▸ **Create**
   - In the popup, click **Download JSON**.
6. **Rename that file to `credentials.json`** and put it **in the `clip-poster` folder on the OBS PC**
   (`...\mackinac-ship-tracker\clip-poster\credentials.json`).

## Part 2 — Authorize (on the OBS PC)

In PowerShell, in the `clip-poster` folder:
```
git pull
npm install
node youtube-auth.js
```
- A browser opens → pick your channel's Google account.
- You'll see **"Google hasn't verified this app"** → click **Advanced ▸ Go to Mackinac Clips (unsafe)**. *(It's your own app — safe.)*
- Approve the **"Upload YouTube videos"** permission.
- Back in the terminal you'll see **✅ Saved token.json**. Done.

## Part 3 — Turn it on

Edit `.env`:
```
notepad .env
```
- Set **`YT_ENABLED=1`**
- Set **`QUALITY_MIN_BRIGHTNESS=40`** (back on, so night junk is skipped)
- Optional: change `MORNING_SLOT` / `EVENING_SLOT` (24h local time)

Save, then run it for real:
```
node clip-poster.js
```
You'll see `YouTube posting ON — slots 08:30 & 18:30`. From now on it captures every
passing, and at each slot it **uploads the best clip of that window as private**. You just
open **YouTube Studio**, glance at it, and hit **Publish** (that's the "tap-to-publish" step).

---

### How it picks
Every clip gets a **score** (brightness + vessel size). The morning slot posts the best clip
from the last ~14h; the evening slot the best from the last ~10h. If nothing clears the bar,
it skips that slot — no dud posts.

### Going fully hands-off later
`YT_PRIVACY=private` is required until you pass Google's one-time **YouTube API compliance
audit** (a form + short demo video). After that you can set `YT_PRIVACY=public` and it posts
with zero taps. We can tackle that whenever you're ready.

### Keep it running
Leave `node clip-poster.js` running on the OBS PC. (Later we can make it auto-start with
Windows so it survives reboots.)
