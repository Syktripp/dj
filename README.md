# 🎧 DJ Lab Sync

Multi-device audio streaming with WebRTC. Capture audio from your DJM-A9 (or any audio source) and stream it to every phone in the room, perfectly synchronized.

## How It Works

1. **Host** opens the app, selects an audio source (DJM-A9, system audio, etc.)
2. **Host** clicks "Start Capturing" → audio is captured in real-time
3. **Listeners** scan a QR code or enter a room code on their phones
4. Audio streams **peer-to-peer via WebRTC** — the server only handles signaling
5. **NTP-style clock sync** keeps all devices aligned

## Architecture

```
┌──────────────┐     WebSocket      ┌──────────────┐
│   Host Mac   │◄──── signaling ───►│  Sync Server │
│  (DJM-A9)    │                    │  (Render.com) │
└──────┬───────┘                    └──────┬───────┘
       │                                   │
       │  WebRTC (peer-to-peer audio)      │ WebSocket
       │                                   │ signaling
       ▼                                   ▼
┌──────────────┐                    ┌──────────────┐
│   Phone 1    │                    │   Phone 2    │
│  (listener)  │                    │  (listener)  │
└──────────────┘                    └──────────────┘
```

The server is tiny — it just relays WebRTC signaling messages and clock sync pings. All audio goes directly between devices.

---

## Local Development

### Prerequisites
- Node.js 18+
- npm

### Run locally

```bash
# Install dependencies
npm install

# Start the server
npm start
```

The server starts on `http://localhost:8080`. Open it in Chrome.

- **Host:** Click "Create Room & Start Broadcasting", select your audio source, hit Start
- **Listener:** Open `http://localhost:8080?room=XXXXX` on another device (or another browser tab)

---

## Deploy to Render.com (Free)

### Step 1: Push to GitHub

Create a new GitHub repository and push this project:

```bash
git init
git add .
git commit -m "DJ Lab Sync server"
git remote add origin https://github.com/YOUR_USERNAME/djlab-sync.git
git push -u origin main
```

### Step 2: Deploy on Render

1. Go to [render.com](https://render.com) and sign up (free)
2. Click **New** → **Web Service**
3. Connect your GitHub repo
4. Settings:
   - **Name:** `djlab-sync`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
5. Click **Create Web Service**

Your app will be live at: `https://djlab-sync.onrender.com`

### Step 3: Update the Frontend URL

In `public/index.html`, find the CONFIG section and update the URL:

```javascript
const CONFIG = {
  WS_URL: window.location.hostname === "localhost"
    ? "ws://localhost:8080/ws"
    : "wss://djlab-sync.onrender.com/ws",  // ← your Render URL
```

> **Note:** Render's free tier spins down after 15 minutes of inactivity. The first request takes ~30 seconds to wake up. For a paid plan ($7/month), you get always-on.

---

## Deploy Frontend to thedjlab.ca (Optional)

If you want the app at `thedjlab.ca/sync`:

1. Copy `public/index.html` to your NamesPro cPanel
2. Upload it to a `/sync/` folder as `index.html`
3. Make sure the WebSocket URL in CONFIG points to your Render server

People would then visit `https://thedjlab.ca/sync?room=XXXXX`

---

## Troubleshooting

**"Permission denied" on audio capture**
- Chrome requires HTTPS or localhost for audio access
- Make sure you're on `localhost:8080` or your HTTPS domain

**DJM-A9 doesn't appear in device list**
- Make sure the USB cable is connected
- Check System Preferences → Sound → Input — the DJM-A9 should be listed
- Try unplugging and reconnecting

**System Audio capture has no sound**
- When Chrome asks what to share, pick a **Chrome Tab** (not Entire Screen)
- Make sure to check **"Also share tab audio"** at the bottom

**Listeners can't connect**
- Make sure the Render server is awake (visit the URL in a browser first)
- Both host and listener must be on a network that allows WebRTC
- Some corporate firewalls block WebRTC

**Audio cuts out on phones**
- iOS Safari can suspend audio — tap the screen to resume
- Keep the phone screen on during listening
