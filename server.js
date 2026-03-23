/**
 * DJ Lab Sync Server v6.0
 * No rooms. One server = one session.
 * Binary PCM relay, NTP sync, chat.
 */
const VERSION = "v6.1";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const PORT = process.env.PORT || 8080;
const PUB = path.join(__dirname, "public");

// State
let hostWs = null, hostName = "", isLive = false, streamStart = null, sr = 48000;
const listeners = new Map();
const chatLog = [];
let seqN = 0, peerN = 0;

// Audio ring buffer (5 minutes of chunks)
const chunks = [];
const MAX_CHUNKS = 3500;
function pushChunk(c) { chunks.push(c); if (chunks.length > MAX_CHUNKS) chunks.shift(); }
function recentChunks(sec) { const t = Date.now() - sec * 1000; return chunks.filter(c => c.t >= t); }

function gid() { return `p${++peerN}`; }
function sj(ws, m) { if (ws.readyState === 1) ws.send(JSON.stringify(m)); }
function packChunk(seq, t, pcm) {
  const h = Buffer.alloc(12);
  h.writeUInt32LE(seq, 0);
  h.writeDoubleLE(t, 4);
  return Buffer.concat([h, Buffer.from(pcm)]);
}
function broadcast(msg, skip) {
  if (hostWs && hostWs !== skip && hostWs.readyState === 1) sj(hostWs, msg);
  for (const [ws] of listeners) if (ws !== skip && ws.readyState === 1) sj(ws, msg);
}

// HTTP
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: VERSION, live: isLive, host: hostName, listeners: listeners.size, uptime: Math.floor(process.uptime()) }));
    return;
  }
  const fp = (req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0]);
  const full = path.join(PUB, fp);
  const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" }[path.extname(full)] || "application/octet-stream";
  try { if (fs.existsSync(full) && fs.statSync(full).isFile()) { res.writeHead(200, { "Content-Type": mime }); res.end(fs.readFileSync(full)); return; } } catch (e) {}
  try { const i = path.join(PUB, "index.html"); if (fs.existsSync(i)) { res.writeHead(200, { "Content-Type": "text/html" }); res.end(fs.readFileSync(i)); return; } } catch (e) {}
  res.writeHead(404); res.end("Not found");
});

// WebSocket
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 512 * 1024 });
wss.on("connection", ws => {
  const id = gid();
  const peer = { id, role: null, name: "anon" };
  ws._p = peer;
  sj(ws, { type: "welcome", id, t: Date.now(), version: VERSION, live: isLive, host: hostName, streamStart, chatHistory: chatLog.slice(-50), listeners: listeners.size });

  ws.on("message", (raw, bin) => {
    if (bin) {
      if (ws !== hostWs || !isLive) return;
      const seq = ++seqN, t = Date.now();
      pushChunk({ seq, t, d: raw });
      const packed = packChunk(seq, t, raw);
      for (const [lw] of listeners) if (lw.readyState === 1) lw.send(packed, { binary: true });
      return;
    }
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case "host": {
        if (hostWs && hostWs !== ws && hostWs.readyState === 1) { sj(ws, { type: "error", msg: "Already hosted" }); return; }
        peer.role = "host"; peer.name = m.name || "DJ";
        hostWs = ws; hostName = peer.name;
        listeners.delete(ws);
        broadcast({ type: "host-changed", host: hostName });
        sj(ws, { type: "host-ok", version: VERSION });
        break;
      }
      case "live": {
        if (ws !== hostWs) return;
        if (m.live) { isLive = true; streamStart = Date.now(); chunks.length = 0; seqN = 0; sr = m.sr || 48000; }
        else { isLive = false; streamStart = null; chunks.length = 0; }
        broadcast({ type: "live", live: isLive, streamStart, sr });
        break;
      }
      case "listen": {
        peer.role = "listener"; peer.name = m.name || "Listener";
        listeners.set(ws, { id, name: peer.name });
        sj(ws, { type: "listen-ok", version: VERSION, live: isLive, host: hostName, streamStart, sr, n: listeners.size, t: Date.now(), chatHistory: chatLog.slice(-50) });
        broadcast({ type: "l+", id, name: peer.name, n: listeners.size }, ws);
        if (isLive) { const r = recentChunks(12); for (const c of r) { const p = packChunk(c.seq, c.t, c.d); if (ws.readyState === 1) ws.send(p, { binary: true }); } }
        break;
      }
      case "chat": {
        const msg = { from: peer.name, text: (m.text || "").slice(0, 500), t: Date.now() };
        chatLog.push(msg); if (chatLog.length > 200) chatLog.shift();
        broadcast({ type: "chat", ...msg });
        break;
      }
      case "sync-ping": { sj(ws, { type: "sync-pong", id: m.id, ct: m.ct, t: Date.now() }); break; }
    }
  });

  ws.on("close", () => {
    if (ws === hostWs) { hostWs = null; isLive = false; streamStart = null; hostName = ""; chunks.length = 0; broadcast({ type: "host-gone" }); }
    else { listeners.delete(ws); broadcast({ type: "l-", id: peer.id, name: peer.name, n: listeners.size }); }
  });
  ws.on("error", () => {});
});

server.listen(PORT, () => console.log(`\n🎧 DJ Lab Sync ${VERSION} on port ${PORT}\n`));
