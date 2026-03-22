/**
 * DJ Lab Sync Server v4
 * - Binary PCM chunk relay with server timestamps
 * - NTP clock sync
 * - streamStart shared across all listeners (sync anchor)
 * - Chat room
 * - Version indicator
 */

const VERSION = "v4.0";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");

class RingBuffer {
  constructor(max = 1500) { this.max = max; this.chunks = []; }
  push(c) { this.chunks.push(c); if (this.chunks.length > this.max) this.chunks.shift(); }
  getRecent(sec) { const t = Date.now() - sec * 1000; return this.chunks.filter(c => c.t >= t); }
}

const rooms = new Map();
const peers = new Map();
let peerN = 0, seqN = 0;

function gid() { return `p${++peerN}`; }
function groom() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let r = ""; for (let i = 0; i < 5; i++) r += c[Math.floor(Math.random() * c.length)];
  return rooms.has(r) ? groom() : r;
}
function sj(ws, m) { if (ws.readyState === 1) ws.send(JSON.stringify(m)); }

// Binary chunk: [4B seq uint32LE][8B serverTime float64LE][PCM data]
function packChunk(seq, t, pcm) {
  const h = Buffer.alloc(12);
  h.writeUInt32LE(seq, 0);
  h.writeDoubleLE(t, 4);
  return Buffer.concat([h, Buffer.from(pcm)]);
}

// HTTP
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.url === "/health") {
    let n = 0; for (const r of rooms.values()) n += r.ls.size;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: VERSION, rooms: rooms.size, listeners: n, up: Math.floor(process.uptime()) }));
    return;
  }
  const fp = (req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0]);
  const full = path.join(PUBLIC_DIR, fp);
  const mt = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" }[path.extname(full)] || "application/octet-stream";
  try { if (fs.existsSync(full) && fs.statSync(full).isFile()) { res.writeHead(200, { "Content-Type": mt }); res.end(fs.readFileSync(full)); return; } } catch (e) {}
  try { const i = path.join(PUBLIC_DIR, "index.html"); if (fs.existsSync(i)) { res.writeHead(200, { "Content-Type": "text/html" }); res.end(fs.readFileSync(i)); return; } } catch (e) {}
  res.writeHead(404); res.end("Not found");
});

// WebSocket
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 512 * 1024 });

wss.on("connection", ws => {
  const id = gid();
  peers.set(ws, { id, room: null, role: null, name: "anon" });
  sj(ws, { type: "welcome", id, t: Date.now(), version: VERSION });

  ws.on("message", (raw, bin) => {
    // Binary = audio chunk from host
    if (bin) {
      const p = peers.get(ws);
      if (!p || p.role !== "host") return;
      const rm = rooms.get(p.room);
      if (!rm || !rm.live) return;
      const seq = ++seqN, t = Date.now();
      const packed = packChunk(seq, t, raw);
      rm.buf.push({ seq, t, d: raw });
      for (const [lw] of rm.ls) { if (lw.readyState === 1) lw.send(packed, { binary: true }); }
      return;
    }

    let m; try { m = JSON.parse(raw); } catch { return; }

    switch (m.type) {
      case "create-room": {
        const p = peers.get(ws);
        const rc = groom();
        p.name = m.name || "Host";
        rooms.set(rc, {
          hw: ws, hn: p.name, ls: new Map(), buf: new RingBuffer(),
          t0: Date.now(), live: false, streamStart: null, sr: m.sr || 48000,
          chat: [],
        });
        p.room = rc; p.role = "host";
        sj(ws, { type: "room-created", room: rc, t: Date.now(), version: VERSION });
        console.log(`[${VERSION}] Room ${rc} created`);
        break;
      }

      case "host-live": {
        const p = peers.get(ws);
        if (!p || p.role !== "host") return;
        const rm = rooms.get(p.room);
        if (!rm) return;
        if (m.live) {
          rm.live = true;
          rm.streamStart = Date.now();
          rm.buf = new RingBuffer();
        } else {
          rm.live = false;
          rm.streamStart = null;
          rm.buf = new RingBuffer();
        }
        // Broadcast to ALL listeners
        for (const [lw] of rm.ls) {
          sj(lw, { type: "host-live", live: rm.live, sr: rm.sr, streamStart: rm.streamStart });
        }
        console.log(`[${VERSION}] Room ${p.room} streaming: ${rm.live}`);
        break;
      }

      case "join": {
        const rm = rooms.get(m.room);
        if (!rm) { sj(ws, { type: "error", msg: "Room not found", code: "NO_ROOM" }); return; }
        const p = peers.get(ws);
        p.name = m.name || "Listener";
        p.room = m.room; p.role = "listener";
        rm.ls.set(ws, { id: p.id, name: p.name });
        sj(ws, {
          type: "joined", room: m.room, host: rm.hn, live: rm.live,
          sr: rm.sr, n: rm.ls.size, t: Date.now(),
          streamStart: rm.streamStart, version: VERSION,
          // Send recent chat history
          chatHistory: rm.chat.slice(-50),
        });
        sj(rm.hw, { type: "l+", id: p.id, name: p.name, n: rm.ls.size });

        // Broadcast join to other listeners
        for (const [lw] of rm.ls) {
          if (lw !== ws) sj(lw, { type: "l+", id: p.id, name: p.name, n: rm.ls.size });
        }

        // Send recent audio buffer for instant start
        if (rm.live) {
          const recent = rm.buf.getRecent(10);
          for (const ch of recent) {
            const pk = packChunk(ch.seq, ch.t, ch.d);
            if (ws.readyState === 1) ws.send(pk, { binary: true });
          }
        }
        console.log(`[${VERSION}] Room ${m.room} +${p.name} (${rm.ls.size} listeners)`);
        break;
      }

      case "chat": {
        const p = peers.get(ws);
        if (!p || !p.room) return;
        const rm = rooms.get(p.room);
        if (!rm) return;
        const msg = { from: p.name, text: (m.text || "").slice(0, 500), t: Date.now() };
        rm.chat.push(msg);
        if (rm.chat.length > 200) rm.chat.shift();
        // Broadcast to host + all listeners
        sj(rm.hw, { type: "chat", ...msg });
        for (const [lw] of rm.ls) sj(lw, { type: "chat", ...msg });
        break;
      }

      case "sync-ping": {
        sj(ws, { type: "sync-pong", id: m.id, ct: m.ct, t: Date.now() });
        break;
      }

      case "leave": {
        cleanup(ws);
        sj(ws, { type: "left" });
        break;
      }
    }
  });

  ws.on("close", () => cleanup(ws));
  ws.on("error", () => cleanup(ws));
});

function cleanup(ws) {
  const p = peers.get(ws);
  if (!p || !p.room) { peers.delete(ws); return; }
  const rm = rooms.get(p.room);
  if (!rm) { peers.delete(ws); return; }
  if (p.role === "host") {
    for (const [lw] of rm.ls) sj(lw, { type: "closed", why: "Host left" });
    rooms.delete(p.room);
    console.log(`[${VERSION}] Room ${p.room} closed`);
  } else {
    rm.ls.delete(ws);
    if (rm.hw.readyState === 1) sj(rm.hw, { type: "l-", id: p.id, name: p.name, n: rm.ls.size });
    for (const [lw] of rm.ls) sj(lw, { type: "l-", id: p.id, name: p.name, n: rm.ls.size });
  }
  peers.delete(ws);
}

setInterval(() => {
  for (const [c, r] of rooms) {
    if (Date.now() - r.t0 > 8 * 3600000) {
      for (const [lw] of r.ls) sj(lw, { type: "closed", why: "Expired" });
      rooms.delete(c);
    }
  }
}, 300000);

server.listen(PORT, () => {
  console.log(`\n🎧 DJ Lab Sync Server ${VERSION}`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
