const crypto = require("crypto");
const { getSession, issueToken, sweepSessions } = require("./auth");
const { createLimiter } = require("./rate-limit");

// FREE_MODE turns one instance into a public, studio-only service: anyone can
// create a room, share its link, and record. There are no shared passwords —
// access is a room-scoped token (see lib/auth.js) minted when a room is
// created (host) or joined (guest).
const FREE_MODE = !!process.env.FREE_MODE;
const MAX_ROOMS = Number(process.env.FREE_MAX_ROOMS) || 200;
const MAX_PARTICIPANTS = Number(process.env.FREE_MAX_PARTICIPANTS) || 5; // WebRTC mesh: each peer uploads to every other
const ROOM_IDLE_MINUTES = Number(process.env.FREE_ROOM_IDLE_MINUTES) || 120;

const ROOM_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

// roomId -> { createdAt, lastActive, hostKey }. A room must be registered here before
// anyone can join it, so visiting an arbitrary ?room= link can't conjure rooms.
const registry = new Map();
let liveRooms = null; // rooms.js's participant map, set in init()

const createLimiter_ = createLimiter({ windowMs: 10 * 60 * 1000, max: 10 });

function readJson(req, cb) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on("end", () => {
    try { cb(JSON.parse(body || "{}")); } catch { cb(null); }
  });
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  return xff ? xff.split(",")[0].trim() : req.socket.remoteAddress;
}

// POST /api/rooms — creates a room; the creator becomes its host.
function handleCreateRoom(req, res) {
  req.resume();
  if (!createLimiter_.check(clientIp(req))) {
    return send(res, 429, { error: "Too many rooms created — try again later" });
  }
  if (registry.size >= MAX_ROOMS) {
    return send(res, 503, { error: "The studio is at capacity right now — try again later" });
  }
  const room = crypto.randomBytes(8).toString("base64url");
  const now = Date.now();
  // hostKey is the creator's private "host link" secret: presenting it on any
  // device yields host rights, so host status isn't tied to one browser.
  const hostKey = crypto.randomBytes(16).toString("base64url");
  registry.set(room, { createdAt: now, lastActive: now, hostKey });
  send(res, 200, { ok: true, room, role: "host", token: issueToken("host", room), hostKey });
}

function hostKeyMatches(entry, key) {
  if (typeof key !== "string") return false;
  const a = Buffer.from(entry.hostKey);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// POST /api/rooms/join { room, token?, hostKey? } — returns a token for an existing room.
// A still-valid token already scoped to this room is echoed back (refresh keeps
// host rights); a valid hostKey (from the private host link) mints a host token
// on any device; anyone else gets guest.
function handleJoinRoom(req, res) {
  readJson(req, (body) => {
    if (!body || !ROOM_ID_RE.test(body.room || "")) return send(res, 400, { error: "Bad request" });
    const entry = registry.get(body.room);
    if (!entry) return send(res, 404, { error: "Room not found or expired" });
    const existing = getSession(body.token);
    if (existing && existing.room === body.room) {
      return send(res, 200, { ok: true, room: body.room, role: existing.role, token: body.token });
    }
    if (body.hostKey) {
      if (!hostKeyMatches(entry, body.hostKey)) return send(res, 403, { error: "Invalid host link" });
      return send(res, 200, { ok: true, room: body.room, role: "host", token: issueToken("host", body.room) });
    }
    send(res, 200, { ok: true, room: body.room, role: "guest", token: issueToken("guest", body.room) });
  });
}

// Called by rooms.join before a participant is admitted. Returns an error
// string to reject the join, or null to allow it.
function checkJoin(room, session, participantCount) {
  if (!session || session.room !== room) return "Not authorized for this room";
  const entry = registry.get(room);
  if (!entry) return "Room not found or expired";
  if (participantCount >= MAX_PARTICIPANTS) return "Room is full";
  entry.lastActive = Date.now();
  return null;
}

module.exports = {
  FREE_MODE,
  // Only exist in FREE_MODE — a normal instance must not mint room tokens.
  routes: FREE_MODE ? [
    { method: "POST", match: (url) => url === "/api/rooms", handler: handleCreateRoom },
    { method: "POST", match: (url) => url === "/api/rooms/join", handler: handleJoinRoom },
  ] : [],
  checkJoin,
  init(ctx) {
    if (!FREE_MODE) return;
    liveRooms = ctx.rooms;
    setInterval(() => {
      const cutoff = Date.now() - ROOM_IDLE_MINUTES * 60 * 1000;
      for (const [id, entry] of registry) {
        if (!liveRooms.has(id) && entry.lastActive < cutoff) registry.delete(id);
      }
      createLimiter_.sweep();
      sweepSessions();
    }, 5 * 60 * 1000).unref();
    console.log(`[free] FREE_MODE active — max ${MAX_ROOMS} rooms, ${MAX_PARTICIPANTS} per room`);
  },
};
