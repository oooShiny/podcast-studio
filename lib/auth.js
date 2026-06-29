const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ═══════════════════════════════════════════════
//  PASSWORDS & ROLES
//  Change these! In production, load from env vars.
// ═══════════════════════════════════════════════
const PASSWORDS = {
  host: process.env.HOST_PASSWORD || "host123",
  member: process.env.MEMBER_PASSWORD || "member123",
  guest: process.env.GUEST_PASSWORD || "guest",
};

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// token -> { role, createdAt }. Persisted to sessions.json so tokens survive restarts.
const sessions = new Map();
let SESSIONS_FILE = null;

function saveSessions() {
  if (!SESSIONS_FILE) return;
  const data = {};
  for (const [token, session] of sessions) data[token] = session;
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data), "utf8");
  } catch (e) {
    console.error("[auth] failed to persist sessions:", e.message);
  }
}

function authenticatePassword(password) {
  if (password === PASSWORDS.host) return "host";
  if (password === PASSWORDS.member) return "member";
  if (password === PASSWORDS.guest) return "guest";
  return null;
}

function issueToken(role) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { role, createdAt: Date.now() });
  saveSessions();
  return token;
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
    handler(req, res, role);
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

module.exports = {
  routes: [
    { method: "POST", match: (url) => url === "/api/auth", handler: handleAuth },
  ],
  init(ctx) {
    SESSIONS_FILE = path.join(ctx.rootDir, "sessions.json");
    try {
      const raw = fs.readFileSync(SESSIONS_FILE, "utf8");
      const data = JSON.parse(raw);
      const now = Date.now();
      for (const [token, session] of Object.entries(data)) {
        if (now - session.createdAt <= TOKEN_TTL_MS) sessions.set(token, session);
      }
      if (sessions.size > 0) console.log(`[auth] restored ${sessions.size} active sessions`);
    } catch {
      // File doesn't exist yet — start fresh
    }
  },
  requireAuth,
  requireHost,
  resolveRole,
  resolveRoleFromToken,
};
