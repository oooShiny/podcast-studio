const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ═══════════════════════════════════════════════
//  PASSWORDS & ROLES
//  Change these! In production, load from env vars.
// ═══════════════════════════════════════════════
const DEFAULT_PASSWORDS = { host: "host123", member: "member123", guest: "guest" };
const PASSWORDS = {
  host: process.env.HOST_PASSWORD || DEFAULT_PASSWORDS.host,
  member: process.env.MEMBER_PASSWORD || DEFAULT_PASSWORDS.member,
  guest: process.env.GUEST_PASSWORD || DEFAULT_PASSWORDS.guest,
};

const SESSION_COOKIE = "ps_session";

// Changes whenever any password changes. Stored next to the persisted
// sessions so that new passwords (e.g. rotated from the control plane) also
// sign out everyone who logged in with the old ones.
const PASSWORD_FINGERPRINT = crypto.createHash("sha256")
  .update(JSON.stringify([PASSWORDS.host, PASSWORDS.member, PASSWORDS.guest])).digest("hex");

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// token -> { role, createdAt, room? }. Persisted to sessions.json so tokens survive restarts.
// Sessions with a `room` (free-mode room tokens) are valid for that room only and are
// kept in memory — rooms themselves don't survive a restart, so neither should their tokens.
const sessions = new Map();
let SESSIONS_FILE = null;

function saveSessions() {
  if (!SESSIONS_FILE) return;
  const data = { _fingerprint: PASSWORD_FINGERPRINT };
  for (const [token, session] of sessions) {
    if (!session.room) data[token] = session;
  }
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data), "utf8");
  } catch (e) {
    console.error("[auth] failed to persist sessions:", e.message);
  }
}

// Constant-time string compare (hashing first so lengths never have to match).
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function authenticatePassword(password) {
  if (typeof password !== "string" || !password) return null;
  if (safeEqual(password, PASSWORDS.host)) return "host";
  if (safeEqual(password, PASSWORDS.member)) return "member";
  if (safeEqual(password, PASSWORDS.guest)) return "guest";
  return null;
}

function issueToken(role, room) {
  const token = crypto.randomBytes(24).toString("hex");
  const session = { role, createdAt: Date.now() };
  if (room) session.room = room;
  sessions.set(token, session);
  if (!room) saveSessions();
  return token;
}

// Drops expired sessions. getSession() only evicts lazily on lookup, which is
// fine for a handful of passwords but would leak with per-visitor room tokens.
function sweepSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.createdAt > TOKEN_TTL_MS) sessions.delete(token);
  }
}

// Looks up a token, evicting it first if its TTL has lapsed (lazy expiry — no timer needed).
function getSession(token) {
  if (!token) return undefined;
  const session = sessions.get(token);
  if (!session) return undefined;
  if (Date.now() - session.createdAt > TOKEN_TTL_MS) {
    sessions.delete(token);
    saveSessions();
    return undefined;
  }
  return session;
}

function getTokenFromRequest(req) {
  const match = /^Bearer (.+)$/.exec(req.headers["authorization"] || "");
  return match ? match[1] : null;
}

function getCookieToken(req) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

// Mirrors the bearer token into an HttpOnly cookie so plain links (<a download>,
// <audio src>) to protected files work. The cookie is only ever honoured by
// requireAuthOrCookie routes, which are read-only GETs, so it adds no CSRF surface.
function setSessionCookie(req, res, token) {
  if (getCookieToken(req) === token || res.headersSent) return;
  const secure = req.headers["x-forwarded-proto"] === "https" || (req.socket && req.socket.encrypted);
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/api/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}${secure ? "; Secure" : ""}`);
}

// Verified role for an HTTP request, or null if missing/invalid/expired.
function resolveRole(req) {
  const session = getSession(getTokenFromRequest(req));
  return session ? session.role : null;
}

// Same lookup for WS messages, where the token travels in the message body
// instead of an HTTP header.
function resolveRoleFromToken(token) {
  const session = getSession(token);
  return session ? session.role : null;
}

// Rejects with 401 before the wrapped handler reads the request body; calls
// the handler with the verified role as a third argument.
function requireAuth(handler) {
  return (req, res) => {
    const role = resolveRole(req);
    if (!role) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    setSessionCookie(req, res, getTokenFromRequest(req));
    handler(req, res, role);
  };
}

// For read-only file links that can't carry an Authorization header: accepts
// the bearer token or the session cookie set alongside it.
function requireAuthOrCookie(handler) {
  return (req, res) => {
    const session = getSession(getTokenFromRequest(req)) || getSession(getCookieToken(req));
    if (!session) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized — sign in to the studio and try again" }));
      return;
    }
    handler(req, res, session.role);
  };
}

// Same as requireAuth, but only a verified "host" session passes.
function requireHost(handler) {
  return (req, res) => {
    const role = resolveRole(req);
    if (role !== "host") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Host only" }));
      return;
    }
    setSessionCookie(req, res, getTokenFromRequest(req));
    handler(req, res, role);
  };
}

function handleAuth(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { password } = JSON.parse(body);
      const role = authenticatePassword(password);
      if (role) {
        const token = issueToken(role);
        setSessionCookie(req, res, token);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, role, token }));
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid password" }));
      }
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad request" }));
    }
  });
}

// Lets a page holding a stored token confirm it is still valid (and learn the
// role the server will actually enforce) without re-sending a password.
function handleSession(req, res, role) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, role }));
}

module.exports = {
  routes: [
    { method: "POST", match: (url) => url === "/api/auth", handler: handleAuth },
    { method: "GET", match: (url) => url === "/api/auth/session", handler: requireAuth(handleSession) },
  ],
  init(ctx) {
    SESSIONS_FILE = path.join(ctx.dataDir, "sessions.json");
    if (!process.env.FREE_MODE && !process.env.DEMO_MODE) {
      const defaults = Object.keys(PASSWORDS).filter((r) => PASSWORDS[r] === DEFAULT_PASSWORDS[r]);
      if (defaults.length) {
        console.warn(`[auth] WARNING: default password in use for: ${defaults.join(", ")}. ` +
          "Set HOST_PASSWORD, MEMBER_PASSWORD and GUEST_PASSWORD before exposing this server.");
      }
    }
    try {
      const raw = fs.readFileSync(SESSIONS_FILE, "utf8");
      const data = JSON.parse(raw);
      const now = Date.now();
      // Files written before the fingerprint existed have none; keep those
      // sessions once rather than signing everyone out on upgrade.
      if (data._fingerprint && data._fingerprint !== PASSWORD_FINGERPRINT) {
        console.log("[auth] passwords changed — previous sessions signed out");
      } else {
        for (const [token, session] of Object.entries(data)) {
          if (token === "_fingerprint" || !session || typeof session !== "object") continue;
          if (now - session.createdAt <= TOKEN_TTL_MS) sessions.set(token, session);
        }
      }
      saveSessions();
      if (sessions.size > 0) console.log(`[auth] restored ${sessions.size} active sessions`);
    } catch {
      // File doesn't exist yet — start fresh
    }
  },
  requireAuth,
  requireHost,
  requireAuthOrCookie,
  resolveRole,
  resolveRoleFromToken,
  getSession,
  getTokenFromRequest,
  issueToken,
  sweepSessions,
};
