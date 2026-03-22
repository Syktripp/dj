/**
 * DJ Lab Sync — Signaling & Clock Sync Server
 *
 * Handles:
 *  - Room creation & joining
 *  - WebRTC signaling (SDP offer/answer, ICE candidates)
 *  - NTP-style clock synchronization
 *  - Peer tracking & room state
 *
 * Deploy free on Render.com — see README.md
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");

// ─── In-Memory State ───
const rooms = new Map();   // roomCode → { hostId, peers: Map<peerId, {ws, name}>, createdAt }
const peerToRoom = new Map(); // peerId → roomCode
let peerCounter = 0;

function generatePeerId() {
  return `peer_${++peerCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  // Ensure unique
  if (rooms.has(code)) return generateRoomCode();
  return code;
}

function send(ws, msg) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastToRoom(roomCode, msg, excludePeerId) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const [pid, peer] of room.peers) {
    if (pid !== excludePeerId) {
      send(peer.ws, msg);
    }
  }
}

function cleanupPeer(peerId) {
  const roomCode = peerToRoom.get(peerId);
  if (!roomCode) return;

  const room = rooms.get(roomCode);
  if (!room) { peerToRoom.delete(peerId); return; }

  room.peers.delete(peerId);
  peerToRoom.delete(peerId);

  // Notify others
  broadcastToRoom(roomCode, { type: "peer-left", peerId });

  // If host left, close the room
  if (room.hostId === peerId) {
    broadcastToRoom(roomCode, { type: "room-closed", reason: "Host disconnected" });
    // Disconnect all remaining peers from this room
    for (const [pid] of room.peers) {
      peerToRoom.delete(pid);
    }
    rooms.delete(roomCode);
    console.log(`[Room ${roomCode}] Closed (host left)`);
  } else if (room.peers.size === 0) {
    rooms.delete(roomCode);
    console.log(`[Room ${roomCode}] Closed (empty)`);
  } else {
    console.log(`[Room ${roomCode}] Peer ${peerId} left. ${room.peers.size} remaining.`);
  }
}

// ─── HTTP Server (health check + CORS preflight) ───
const server = http.createServer((req, res) => {
  // CORS headers for all requests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/health") {
    const roomCount = rooms.size;
    let peerCount = 0;
    for (const room of rooms.values()) peerCount += room.peers.size;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime: process.uptime(),
      rooms: roomCount,
      peers: peerCount,
      timestamp: Date.now(),
    }));
    return;
  }

  // Root — serve frontend
  const filePath = req.url === "/" ? "/index.html" : req.url;
  const fullPath = path.join(PUBLIC_DIR, filePath);
  const ext = path.extname(fullPath);
  const mimeTypes = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

  try {
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const content = fs.readFileSync(fullPath);
      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
      res.end(content);
      return;
    }
  } catch (e) {}

  // Fallback — serve index.html for SPA routing (e.g., ?room=XYZ)
  try {
    const indexPath = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(content);
      return;
    }
  } catch (e) {}

  res.writeHead(404);
  res.end("Not found");
});

// ─── WebSocket Server ───
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const peerId = generatePeerId();
  let peerName = "anonymous";

  console.log(`[Connect] ${peerId}`);

  // Send welcome with peerId
  send(ws, { type: "welcome", peerId, serverTime: Date.now() });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    switch (msg.type) {

      // ─── Create Room (Host) ───
      case "create-room": {
        // Clean up any existing room membership
        cleanupPeer(peerId);

        const roomCode = msg.roomCode || generateRoomCode();
        peerName = msg.name || peerName;

        const room = {
          hostId: peerId,
          peers: new Map([[peerId, { ws, name: peerName }]]),
          createdAt: Date.now(),
        };
        rooms.set(roomCode, room);
        peerToRoom.set(peerId, roomCode);

        send(ws, {
          type: "room-created",
          roomCode,
          peerId,
          serverTime: Date.now(),
        });
        console.log(`[Room ${roomCode}] Created by ${peerId} (${peerName})`);
        break;
      }

      // ─── Join Room (Listener) ───
      case "join-room": {
        const { roomCode, name } = msg;
        peerName = name || peerName;

        const room = rooms.get(roomCode);
        if (!room) {
          send(ws, { type: "error", message: "Room not found", code: "ROOM_NOT_FOUND" });
          return;
        }

        // Clean up any existing membership
        cleanupPeer(peerId);

        room.peers.set(peerId, { ws, name: peerName });
        peerToRoom.set(peerId, roomCode);

        // Tell the joiner about the room
        const peerList = [];
        for (const [pid, p] of room.peers) {
          if (pid !== peerId) peerList.push({ peerId: pid, name: p.name, isHost: pid === room.hostId });
        }

        send(ws, {
          type: "room-joined",
          roomCode,
          peerId,
          hostId: room.hostId,
          peers: peerList,
          serverTime: Date.now(),
        });

        // Tell everyone else (especially the host) about the new peer
        broadcastToRoom(roomCode, {
          type: "peer-joined",
          peerId,
          name: peerName,
        }, peerId);

        console.log(`[Room ${roomCode}] ${peerId} (${peerName}) joined. ${room.peers.size} peers.`);
        break;
      }

      // ─── WebRTC Signaling: Offer ───
      case "offer": {
        const { targetId, sdp } = msg;
        const targetRoom = peerToRoom.get(targetId);
        const myRoom = peerToRoom.get(peerId);
        if (!targetRoom || targetRoom !== myRoom) {
          send(ws, { type: "error", message: "Target not in same room" });
          return;
        }
        const room = rooms.get(myRoom);
        const target = room?.peers.get(targetId);
        if (target) {
          send(target.ws, { type: "offer", fromId: peerId, sdp });
        }
        break;
      }

      // ─── WebRTC Signaling: Answer ───
      case "answer": {
        const { targetId, sdp } = msg;
        const targetRoom = peerToRoom.get(targetId);
        const myRoom = peerToRoom.get(peerId);
        if (!targetRoom || targetRoom !== myRoom) return;
        const room = rooms.get(myRoom);
        const target = room?.peers.get(targetId);
        if (target) {
          send(target.ws, { type: "answer", fromId: peerId, sdp });
        }
        break;
      }

      // ─── WebRTC Signaling: ICE Candidate ───
      case "ice-candidate": {
        const { targetId, candidate } = msg;
        const targetRoom = peerToRoom.get(targetId);
        const myRoom = peerToRoom.get(peerId);
        if (!targetRoom || targetRoom !== myRoom) return;
        const room = rooms.get(myRoom);
        const target = room?.peers.get(targetId);
        if (target) {
          send(target.ws, { type: "ice-candidate", fromId: peerId, candidate });
        }
        break;
      }

      // ─── NTP-Style Clock Sync ───
      case "sync-ping": {
        send(ws, {
          type: "sync-pong",
          clientSendTime: msg.clientSendTime,
          serverTime: Date.now(),
          serverReceiveTime: Date.now(),
        });
        break;
      }

      // ─── Leave Room ───
      case "leave-room": {
        cleanupPeer(peerId);
        send(ws, { type: "left-room" });
        break;
      }

      default:
        send(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
    }
  });

  ws.on("close", () => {
    console.log(`[Disconnect] ${peerId}`);
    cleanupPeer(peerId);
  });

  ws.on("error", (err) => {
    console.error(`[WS Error] ${peerId}:`, err.message);
    cleanupPeer(peerId);
  });
});

// ─── Periodic Cleanup: remove stale rooms older than 6 hours ───
setInterval(() => {
  const now = Date.now();
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (now - room.createdAt > SIX_HOURS) {
      broadcastToRoom(code, { type: "room-closed", reason: "Room expired" });
      for (const [pid] of room.peers) peerToRoom.delete(pid);
      rooms.delete(code);
      console.log(`[Cleanup] Room ${code} expired`);
    }
  }
}, 60 * 1000);

// ─── Start ───
server.listen(PORT, () => {
  console.log(`\n🎧 DJ Lab Sync Server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws\n`);
});
