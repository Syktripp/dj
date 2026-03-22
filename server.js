/**
 * DJ Lab Sync Server v5.0
 * 
 * No rooms. One server = one session.
 * - Host broadcasts PCM chunks via WebSocket (binary)
 * - Server timestamps + relays to all listeners
 * - NTP clock sync for all devices
 * - Chat
 */

const VERSION = "v5.1";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");

// ─── Global State (one session, no rooms) ───
let hostWs = null;
let hostName = "";
let isLive = false;
let streamStart = null;
let sampleRate = 48000;
const listeners = new Map(); // ws → {id, name}
const chatLog = [];
let seqN = 0;
let peerN = 0;

// Ring buffer for late joiners
const MAX_CHUNKS = 1500;
const audioBuffer = [];
function pushChunk(c) { audioBuffer.push(c); if (audioBuffer.length > MAX_CHUNKS) audioBuffer.shift(); }
function recentChunks(sec) { const t = Date.now() - sec * 1000; return audioBuffer.filter(c => c.t >= t); }

function gid() { return `p${++peerN}`; }
function sj(ws, m) { if (ws.readyState === 1) ws.send(JSON.stringify(m)); }

function packChunk(seq, t, pcm) {
  const h = Buffer.alloc(12);
  h.writeUInt32LE(seq, 0);
  h.writeDoubleLE(t, 4);
  return Buffer.concat([h, Buffer.from(pcm)]);
}

function broadcastJSON(msg, exclude) {
  if (hostWs && hostWs !== exclude && hostWs.readyState === 1) sj(hostWs, msg);
  for (const [ws] of listeners) { if (ws !== exclude && ws.readyState === 1) sj(ws, msg); }
}

// ─── HTTP ───
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true, version: VERSION, live: isLive, host: hostName || null,
      listeners: listeners.size, uptime: Math.floor(process.uptime()),
    }));
    return;
  }
  const fp = (req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0]);
  const full = path.join(PUBLIC_DIR, fp);
  const mt = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" }[path.extname(full)] || "application/octet-stream";
  try { if (fs.existsSync(full) && fs.statSync(full).isFile()) { res.writeHead(200, { "Content-Type": mt }); res.end(fs.readFileSync(full)); return; } } catch (e) {}
  try { const i = path.join(PUBLIC_DIR, "index.html"); if (fs.existsSync(i)) { res.writeHead(200, { "Content-Type": "text/html" }); res.end(fs.readFileSync(i)); return; } } catch (e) {}
  res.writeHead(404); res.end("Not found");
});

// ─── WebSocket ───
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 512 * 1024 });

wss.on("connection", ws => {
  const id = gid();
  const peer = { id, role: null, name: "anon" };
  ws._peer = peer;

  sj(ws, {
    type: "welcome", id, t: Date.now(), version: VERSION,
    live: isLive, host: hostName, streamStart,
    chatHistory: chatLog.slice(-50),
    listenerCount: listeners.size,
  });

  ws.on("message", (raw, bin) => {
    // Binary = audio from host
    if (bin) {
      if (ws !== hostWs || !isLive) return;
      const seq = ++seqN, t = Date.now();
      const packed = packChunk(seq, t, raw);
      pushChunk({ seq, t, d: raw });
      for (const [lw] of listeners) { if (lw.readyState === 1) lw.send(packed, { binary: true }); }
      return;
    }

    let m; try { m = JSON.parse(raw); } catch { return; }

    switch (m.type) {
      // Become the host
      case "host": {
        if (hostWs && hostWs !== ws && hostWs.readyState === 1) {
          sj(ws, { type: "error", msg: "Someone is already hosting." });
          return;
        }
        peer.role = "host";
        peer.name = m.name || "DJ";
        hostWs = ws;
        hostName = peer.name;
        listeners.delete(ws); // host isn't a listener
        broadcastJSON({ type: "host-changed", host: hostName });
        sj(ws, { type: "host-ok", version: VERSION });
        console.log(`[${VERSION}] Host: ${hostName}`);
        break;
      }

      // Start/stop broadcasting
      case "live": {
        if (ws !== hostWs) return;
        if (m.live) {
          isLive = true;
          streamStart = Date.now();
          audioBuffer.length = 0;
          seqN = 0;
          sampleRate = m.sr || 48000;
        } else {
          isLive = false;
          streamStart = null;
          audioBuffer.length = 0;
        }
        broadcastJSON({ type: "live", live: isLive, streamStart, sr: sampleRate });
        console.log(`[${VERSION}] Live: ${isLive}`);
        break;
      }

      // Join as listener
      case "listen": {
        peer.role = "listener";
        peer.name = m.name || "Listener";
        listeners.set(ws, { id, name: peer.name });
        sj(ws, {
          type: "listen-ok", version: VERSION, live: isLive, host: hostName,
          streamStart, sr: sampleRate, n: listeners.size, t: Date.now(),
          chatHistory: chatLog.slice(-50),
        });
        broadcastJSON({ type: "l+", id, name: peer.name, n: listeners.size }, ws);
        // Send recent audio for instant start
        if (isLive) {
          const recent = recentChunks(10);
          for (const ch of recent) {
            const pk = packChunk(ch.seq, ch.t, ch.d);
            if (ws.readyState === 1) ws.send(pk, { binary: true });
          }
        }
        console.log(`[${VERSION}] +${peer.name} (${listeners.size})`);
        break;
      }

      // Chat
      case "chat": {
        const msg = { from: peer.name, text: (m.text || "").slice(0, 500), t: Date.now() };
        chatLog.push(msg);
        if (chatLog.length > 200) chatLog.shift();
        broadcastJSON({ type: "chat", ...msg });
        break;
      }

      // NTP sync
      case "sync-ping": {
        sj(ws, { type: "sync-pong", id: m.id, ct: m.ct, t: Date.now() });
        break;
      }
    }
  });

  ws.on("close", () => {
    if (ws === hostWs) {
      hostWs = null; isLive = false; streamStart = null;
      hostName = "";
      audioBuffer.length = 0;
      broadcastJSON({ type: "host-gone" });
      console.log(`[${VERSION}] Host disconnected`);
    } else {
      listeners.delete(ws);
      broadcastJSON({ type: "l-", id: peer.id, name: peer.name, n: listeners.size });
    }
  });

  ws.on("error", () => {});
});

server.listen(PORT, () => {
  console.log(`\n🎧 DJ Lab Sync ${VERSION}`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
