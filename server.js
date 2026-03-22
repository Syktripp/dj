/**
 * DJ Lab Sync Server v3
 * 
 * Binary PCM relay with timestamp, ring buffer for late joiners,
 * NTP clock sync for all devices.
 */

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

function packChunk(seq, t, pcm) {
  const h = Buffer.alloc(12);
  h.writeUInt32LE(seq, 0);
  h.writeDoubleLE(t, 4);
  return Buffer.concat([h, Buffer.from(pcm)]);
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.url === "/health") {
    let n = 0; for (const r of rooms.values()) n += r.ls.size;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, listeners: n, up: process.uptime() }));
    return;
  }
  const fp = (req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0]);
  const full = path.join(PUBLIC_DIR, fp);
  const mt = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" }[path.extname(full)] || "application/octet-stream";
  try { if (fs.existsSync(full) && fs.statSync(full).isFile()) { res.writeHead(200, { "Content-Type": mt }); res.end(fs.readFileSync(full)); return; } } catch (e) {}
  try { const i = path.join(PUBLIC_DIR, "index.html"); if (fs.existsSync(i)) { res.writeHead(200, { "Content-Type": "text/html" }); res.end(fs.readFileSync(i)); return; } } catch (e) {}
  res.writeHead(404); res.end("Not found");
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 512 * 1024 });

wss.on("connection", ws => {
  const id = gid();
  peers.set(ws, { id, room: null, role: null });
  sj(ws, { type: "welcome", id, t: Date.now() });

  ws.on("message", (raw, bin) => {
    if (bin) {
      const p = peers.get(ws);
      if (!p || p.role !== "host") return;
      const rm = rooms.get(p.room);
      if (!rm) return;
      const seq = ++seqN, t = Date.now();
      const packed = packChunk(seq, t, raw);
      rm.buf.push({ seq, t, d: raw });
      for (const [lw] of rm.ls) { if (lw.readyState === 1) lw.send(packed, { binary: true }); }
      return;
    }
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case "create-room": {
        const p = peers.get(ws), rc = groom();
        rooms.set(rc, { hw: ws, hn: m.name || "Host", ls: new Map(), buf: new RingBuffer(), t0: Date.now(), live: false, sr: m.sr || 48000 });
        p.room = rc; p.role = "host";
        sj(ws, { type: "room-created", room: rc, t: Date.now() });
        break;
      }
      case "host-live": {
        const p = peers.get(ws); if (!p || p.role !== "host") return;
        const rm = rooms.get(p.room); if (!rm) return;
        rm.live = m.live;
        if (!m.live) rm.buf = new RingBuffer();
        for (const [lw] of rm.ls) sj(lw, { type: "host-live", live: m.live, sr: rm.sr });
        break;
      }
      case "join": {
        const rm = rooms.get(m.room);
        if (!rm) { sj(ws, { type: "error", msg: "Room not found", code: "NO_ROOM" }); return; }
        const p = peers.get(ws);
        p.room = m.room; p.role = "listener";
        rm.ls.set(ws, { id: p.id, name: m.name || "Listener" });
        sj(ws, { type: "joined", room: m.room, host: rm.hn, live: rm.live, sr: rm.sr, n: rm.ls.size, t: Date.now() });
        sj(rm.hw, { type: "l+", id: p.id, name: m.name, n: rm.ls.size });
        // Send recent buffer for instant start
        if (rm.live) {
          const recent = rm.buf.getRecent(10);
          for (const ch of recent) {
            const pk = packChunk(ch.seq, ch.t, ch.d);
            if (ws.readyState === 1) ws.send(pk, { binary: true });
          }
        }
        break;
      }
      case "sync-ping": {
        sj(ws, { type: "sync-pong", id: m.id, ct: m.ct, t: Date.now() });
        break;
      }
      case "leave": { cleanup(ws); sj(ws, { type: "left" }); break; }
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
  } else {
    rm.ls.delete(ws);
    if (rm.hw.readyState === 1) sj(rm.hw, { type: "l-", id: p.id, n: rm.ls.size });
  }
  peers.delete(ws);
}

setInterval(() => { for (const [c, r] of rooms) if (Date.now() - r.t0 > 8 * 3600000) rooms.delete(c); }, 300000);

server.listen(PORT, () => console.log(`\n🎧 DJ Lab Sync v3 on port ${PORT}\n`));
