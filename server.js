/**
 * DJ Lab Sync Server v2
 *
 * - Host sends PCM audio chunks (binary) via WebSocket
 * - Server timestamps, stores in ring buffer, relays to all listeners
 * - NTP-style clock sync for all devices
 * - 5-second playback buffer for bulletproof sync
 * - Ring buffer stores ~3 minutes for late joiners
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");

// ─── Ring Buffer ───
class AudioRingBuffer {
  constructor(maxChunks = 1500) {
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
}

// ─── State ───
const rooms = new Map();
const wsPeerMap = new Map();
let peerCounter = 0;
let chunkSeq = 0;

function genId() { return `p${++peerCounter}`; }
function genRoom() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += c[Math.floor(Math.random() * c.length)];
  return rooms.has(code) ? genRoom() : code;
}
function sendJ(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

// Chunk binary format:
// [4 bytes: Uint32 seq] [8 bytes: Float64 serverTime] [rest: Int16 PCM]
function packChunk(seq, serverTime, pcm) {
  const hdr = Buffer.alloc(12);
  hdr.writeUInt32LE(seq, 0);
  hdr.writeDoubleLE(serverTime, 4);
  return Buffer.concat([hdr, Buffer.from(pcm)]);
}

// ─── HTTP ───
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.url === "/health") {
    let lc = 0;
    for (const r of rooms.values()) lc += r.listeners.size;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", rooms: rooms.size, listeners: lc, uptime: process.uptime() }));
    return;
  }

  // Static files
  const urlPath = req.url.split("?")[0];
  const fp = urlPath === "/" ? "/index.html" : urlPath;
  const full = path.join(PUBLIC_DIR, fp);
  const mimes = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  const mime = mimes[path.extname(full)] || "application/octet-stream";

  try {
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { "Content-Type": mime });
      res.end(fs.readFileSync(full));
      return;
    }
  } catch (e) {}

  // SPA fallback
  try {
    const idx = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(idx)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(idx));
      return;
    }
  } catch (e) {}

  res.writeHead(404);
  res.end("Not found");
});

// ─── WebSocket ───
const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 512 * 1024, // 512KB max message
});

wss.on("connection", (ws) => {
  const peerId = genId();
  wsPeerMap.set(ws, { peerId, roomCode: null, role: null });
  sendJ(ws, { type: "welcome", peerId, serverTime: Date.now() });

  ws.on("message", (raw, isBinary) => {
    // ─── Binary = audio chunk from host ───
    if (isBinary) {
      const peer = wsPeerMap.get(ws);
      if (!peer || peer.role !== "host") return;
      const room = rooms.get(peer.roomCode);
      if (!room) return;

      const seq = ++chunkSeq;
      const serverTime = Date.now();
      const packed = packChunk(seq, serverTime, raw);

      room.audioBuffer.push({ seq, serverTime, data: raw });

      // Relay to every listener
      for (const [lws] of room.listeners) {
        if (lws.readyState === 1) {
          lws.send(packed, { binary: true });
        }
      }
      return;
    }

    // ─── JSON = signaling ───
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "create-room": {
        const peer = wsPeerMap.get(ws);
        const roomCode = genRoom();
        rooms.set(roomCode, {
          hostWs: ws,
          hostName: msg.name || "Host",
          listeners: new Map(),
          audioBuffer: new AudioRingBuffer(),
          createdAt: Date.now(),
          isStreaming: false,
          sampleRate: msg.sampleRate || 48000,
        });
        peer.roomCode = roomCode;
        peer.role = "host";
        sendJ(ws, { type: "room-created", roomCode, serverTime: Date.now() });
        console.log(`[Room ${roomCode}] Created by ${peer.peerId}`);
        break;
      }

      case "host-streaming": {
        const peer = wsPeerMap.get(ws);
        if (!peer || peer.role !== "host") return;
        const room = rooms.get(peer.roomCode);
        if (!room) return;
        room.isStreaming = msg.streaming;
        if (!msg.streaming) room.audioBuffer = new AudioRingBuffer(); // clear on stop
        for (const [lws] of room.listeners) {
          sendJ(lws, { type: "host-streaming", streaming: msg.streaming, sampleRate: room.sampleRate });
        }
        console.log(`[Room ${peer.roomCode}] Streaming: ${msg.streaming}`);
        break;
      }

      case "join-room": {
        const room = rooms.get(msg.roomCode);
        if (!room) {
          sendJ(ws, { type: "error", message: "Room not found", code: "ROOM_NOT_FOUND" });
          return;
        }
        const peer = wsPeerMap.get(ws);
        peer.roomCode = msg.roomCode;
        peer.role = "listener";
        room.listeners.set(ws, { peerId: peer.peerId, name: msg.name || "Listener" });

        sendJ(ws, {
          type: "room-joined",
          roomCode: msg.roomCode,
          hostName: room.hostName,
          isStreaming: room.isStreaming,
          sampleRate: room.sampleRate,
          listenerCount: room.listeners.size,
          serverTime: Date.now(),
        });

        // Notify host
        sendJ(room.hostWs, {
          type: "listener-joined",
          peerId: peer.peerId,
          name: msg.name,
          listenerCount: room.listeners.size,
        });

        // Send recent buffer (last 8 seconds) so listener fills buffer fast
        if (room.isStreaming) {
          const recent = room.audioBuffer.getRecent(8);
          if (recent.length > 0) {
            for (const ch of recent) {
              const packed = packChunk(ch.seq, ch.serverTime, ch.data);
              if (ws.readyState === 1) ws.send(packed, { binary: true });
            }
          }
        }

        console.log(`[Room ${msg.roomCode}] +listener (${room.listeners.size} total)`);
        break;
      }

      case "sync-ping": {
        sendJ(ws, {
          type: "sync-pong",
          id: msg.id,
          clientSendTime: msg.clientSendTime,
          serverTime: Date.now(),
        });
        break;
      }

      case "leave-room": {
        cleanup(ws);
        sendJ(ws, { type: "left-room" });
        break;
      }
    }
  });

  ws.on("close", () => cleanup(ws));
  ws.on("error", () => cleanup(ws));
});

function cleanup(ws) {
  const peer = wsPeerMap.get(ws);
  if (!peer || !peer.roomCode) { wsPeerMap.delete(ws); return; }
  const room = rooms.get(peer.roomCode);
  if (!room) { wsPeerMap.delete(ws); return; }

  if (peer.role === "host") {
    for (const [lws] of room.listeners) {
      sendJ(lws, { type: "room-closed", reason: "Host disconnected" });
    }
    rooms.delete(peer.roomCode);
    console.log(`[Room ${peer.roomCode}] Closed (host left)`);
  } else {
    room.listeners.delete(ws);
    if (room.hostWs.readyState === 1) {
      sendJ(room.hostWs, {
        type: "listener-left",
        peerId: peer.peerId,
        listenerCount: room.listeners.size,
      });
    }
  }
  wsPeerMap.delete(ws);
}

// Cleanup stale rooms every 5 min
setInterval(() => {
  for (const [code, room] of rooms) {
    if (Date.now() - room.createdAt > 8 * 3600 * 1000) {
      for (const [lws] of room.listeners) sendJ(lws, { type: "room-closed", reason: "Expired" });
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`\n🎧 DJ Lab Sync Server v2`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   WS: ws://localhost:${PORT}/ws\n`);
});
