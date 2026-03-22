/**
 * DJ Lab Sync — Synchronized Audio Server
 *
 * Architecture:
 *  - Host captures audio → sends PCM chunks via WebSocket (binary)
 *  - Server timestamps each chunk, stores in ring buffer, broadcasts to listeners
 *  - Listeners receive chunks + timestamps, schedule playback synced to server clock
 *  - NTP-style clock sync keeps all devices within ~5ms of server time
 *
 * Audio: 48kHz mono Int16 PCM, ~85ms chunks (4096 samples)
 * Protocol: binary for audio, JSON for signaling
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");

// Ring buffer: stores last ~2 minutes of audio chunks
class AudioRingBuffer {
  constructor(maxChunks = 1400) {
    this.maxChunks = maxChunks;
    this.chunks = [];
  }
  push(chunk) {
    this.chunks.push(chunk);
    if (this.chunks.length > this.maxChunks) this.chunks.shift();
  }
  getRecent(seconds) {
    const cutoff = Date.now() - seconds * 1000;
    return this.chunks.filter(c => c.serverTime >= cutoff);
  }
  clear() { this.chunks = []; }
}

// State
const rooms = new Map();
const wsPeerMap = new Map(); // ws → { peerId, roomCode, role }
let peerCounter = 0;
let chunkSeq = 0;

function genId() { return `p${++peerCounter}_${Math.random().toString(36).slice(2,6)}`; }
function genRoom() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = ""; for (let i=0;i<5;i++) code += c[Math.floor(Math.random()*c.length)];
  return rooms.has(code) ? genRoom() : code;
}
function sendJ(ws, msg) { if (ws.readyState===1) ws.send(JSON.stringify(msg)); }
function sendB(ws, data) { if (ws.readyState===1) ws.send(data); }

// Pack chunk: [Uint32 seq][Float64 serverTime][Int16 PCM data]
function packChunk(seq, serverTime, pcm) {
  const hdr = new ArrayBuffer(12);
  const dv = new DataView(hdr);
  dv.setUint32(0, seq, true);
  dv.setFloat64(4, serverTime, true);
  const out = new Uint8Array(12 + pcm.byteLength);
  out.set(new Uint8Array(hdr), 0);
  out.set(new Uint8Array(pcm), 12);
  return out.buffer;
}

// HTTP
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.url === "/health") {
    let lc = 0; for (const r of rooms.values()) lc += r.listeners.size;
    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(JSON.stringify({status:"ok",rooms:rooms.size,listeners:lc,uptime:process.uptime()}));
    return;
  }
  const fp = (req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0]);
  const full = path.join(PUBLIC_DIR, fp);
  const mime = {".html":"text/html",".js":"application/javascript",".css":"text/css"}[path.extname(full)] || "application/octet-stream";
  try { if (fs.existsSync(full) && fs.statSync(full).isFile()) { res.writeHead(200,{"Content-Type":mime}); res.end(fs.readFileSync(full)); return; } } catch(e){}
  try { const idx=path.join(PUBLIC_DIR,"index.html"); if(fs.existsSync(idx)){res.writeHead(200,{"Content-Type":"text/html"});res.end(fs.readFileSync(idx));return;} } catch(e){}
  res.writeHead(404); res.end("Not found");
});

// WebSocket
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const peerId = genId();
  wsPeerMap.set(ws, { peerId, roomCode: null, role: null });
  console.log(`[+] ${peerId}`);
  sendJ(ws, { type: "welcome", peerId, serverTime: Date.now() });

  ws.on("message", (raw, isBinary) => {
    // Binary = audio chunk from host
    if (isBinary) {
      const peer = wsPeerMap.get(ws);
      if (!peer || peer.role !== "host" || !peer.roomCode) return;
      const room = rooms.get(peer.roomCode);
      if (!room) return;

      const seq = ++chunkSeq;
      const serverTime = Date.now();
      const pcm = Buffer.from(raw);

      room.audioBuffer.push({ seq, serverTime, data: pcm });
      const packed = packChunk(seq, serverTime, pcm);
      for (const [lws] of room.listeners) sendB(lws, packed);
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "create-room": {
        const peer = wsPeerMap.get(ws);
        const roomCode = genRoom();
        rooms.set(roomCode, {
          hostId: peerId, hostWs: ws, hostName: msg.name || "Host",
          listeners: new Map(), audioBuffer: new AudioRingBuffer(),
          createdAt: Date.now(), isStreaming: false,
        });
        peer.roomCode = roomCode;
        peer.role = "host";
        sendJ(ws, { type: "room-created", roomCode, serverTime: Date.now() });
        console.log(`[Room ${roomCode}] Created`);
        break;
      }

      case "host-streaming": {
        const peer = wsPeerMap.get(ws);
        if (!peer || peer.role !== "host") return;
        const room = rooms.get(peer.roomCode);
        if (!room) return;
        room.isStreaming = msg.streaming;
        for (const [lws] of room.listeners) sendJ(lws, { type: "host-streaming", streaming: msg.streaming });
        break;
      }

      case "join-room": {
        const room = rooms.get(msg.roomCode);
        if (!room) { sendJ(ws, { type: "error", message: "Room not found", code: "ROOM_NOT_FOUND" }); return; }
        const peer = wsPeerMap.get(ws);
        peer.roomCode = msg.roomCode;
        peer.role = "listener";
        room.listeners.set(ws, { peerId, name: msg.name || "Listener" });

        sendJ(ws, {
          type: "room-joined", roomCode: msg.roomCode, hostName: room.hostName,
          isStreaming: room.isStreaming, listenerCount: room.listeners.size, serverTime: Date.now(),
        });
        sendJ(room.hostWs, { type: "listener-joined", peerId, name: msg.name, listenerCount: room.listeners.size });

        // Send recent buffer so listener starts immediately
        const recent = room.audioBuffer.getRecent(3);
        if (recent.length > 0) {
          sendJ(ws, { type: "buffer-start", chunkCount: recent.length });
          for (const ch of recent) sendB(ws, packChunk(ch.seq, ch.serverTime, ch.data));
          sendJ(ws, { type: "buffer-end" });
        }
        console.log(`[Room ${msg.roomCode}] +${peerId} (${room.listeners.size} listeners)`);
        break;
      }

      case "sync-ping": {
        sendJ(ws, { type: "sync-pong", id: msg.id, clientSendTime: msg.clientSendTime, serverTime: Date.now() });
        break;
      }

      case "leave-room": { cleanup(ws); sendJ(ws, { type: "left-room" }); break; }
    }
  });

  ws.on("close", () => { console.log(`[-] ${peerId}`); cleanup(ws); });
  ws.on("error", () => cleanup(ws));
});

function cleanup(ws) {
  const peer = wsPeerMap.get(ws);
  if (!peer || !peer.roomCode) { wsPeerMap.delete(ws); return; }
  const room = rooms.get(peer.roomCode);
  if (!room) { wsPeerMap.delete(ws); return; }

  if (peer.role === "host") {
    for (const [lws] of room.listeners) sendJ(lws, { type: "room-closed", reason: "Host disconnected" });
    rooms.delete(peer.roomCode);
    console.log(`[Room ${peer.roomCode}] Closed`);
  } else {
    room.listeners.delete(ws);
    sendJ(room.hostWs, { type: "listener-left", peerId: peer.peerId, listenerCount: room.listeners.size });
  }
  wsPeerMap.delete(ws);
}

setInterval(() => {
  for (const [code, room] of rooms) {
    if (Date.now() - room.createdAt > 6*3600*1000) { rooms.delete(code); }
  }
}, 5*60*1000);

server.listen(PORT, () => {
  console.log(`\n🎧 DJ Lab Sync Server on port ${PORT}\n   Health: http://localhost:${PORT}/health\n   WS: ws://localhost:${PORT}/ws\n`);
});
