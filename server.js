require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const authModule = require("./lib/auth");
const recordingModule = require("./lib/recording");
const clipsModule = require("./lib/clips");
const webhookModule = require("./lib/webhook");
const prepNotesModule = require("./lib/prep-notes");
const prepSourcesModule = require("./lib/prep-sources");
const screenshotsModule = require("./lib/screenshots");
const studioSettingsModule = require("./lib/studio-settings");
const roomsModule = require("./lib/rooms");
const editorModule = require("./lib/editor");
const updatesModule = require("./lib/updates");
const freeModeModule = require("./lib/free-mode");
const iceServersModule = require("./lib/ice-servers");
const { loadPlugins } = require("./lib/plugin-loader");
const { createLimiter } = require("./lib/rate-limit");
const { isPublicAddress } = require("./lib/net-guard");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
// Where all mutable state lives (recordings, prep notes, settings, sessions,
// plugin data). Defaults to the app directory, so existing deployments are
// unchanged; set DATA_DIR to put it on a separate persistent volume.
const DATA_ROOT = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;

const DEMO_MODE = !!process.env.DEMO_MODE;
// Public, studio-only deployment: room-scoped access, local-only recording,
// everything else (prep, editor, settings, plugins, webhook) switched off.
const FREE_MODE = freeModeModule.FREE_MODE;
// Both public-facing modes get rate limiting and same-origin CORS.
const PUBLIC_MODE = DEMO_MODE || FREE_MODE;
// The one other origin allowed to call this API from a browser. Unset (the
// default) means same-origin only. DEMO_ALLOWED_ORIGIN is the older name.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || process.env.DEMO_ALLOWED_ORIGIN || "";
const DEMO_WIPE_INTERVAL_MINUTES = Number(process.env.DEMO_WIPE_INTERVAL_MINUTES) || 25;
const DEMO_WIPE_MAX_DEFER_CYCLES = Number(process.env.DEMO_WIPE_MAX_DEFER_CYCLES) || 3;

const dirs = {
  RECORDINGS_DIR: path.join(DATA_ROOT, "recordings"),
  PREP_NOTES_DIR: path.join(DATA_ROOT, "prep-notes"),
  PREP_SOURCES_DIR: path.join(DATA_ROOT, "prep-sources"),
  SCREENSHOTS_DIR: path.join(DATA_ROOT, "screenshots"),
  CLIPS_DIR: path.join(DATA_ROOT, "clips"),
  BRANDING_DIR: path.join(DATA_ROOT, "branding"),
};

for (const dir of Object.values(dirs)) {
  fs.mkdirSync(dir, { recursive: true });
}

const PLUGINS_DATA_DIR = path.join(DATA_ROOT, "plugins-data");

const ctx = {
  rootDir: ROOT,
  dataDir: DATA_ROOT,
  dirs,
  rooms: roomsModule.rooms,
  broadcast: roomsModule.broadcast,
  // Plugins get their own storage namespace so they never write into core dirs.
  pluginDir(name) {
    const dir = path.join(PLUGINS_DATA_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  },
};

const coreModules = [
  authModule,
  recordingModule,
  clipsModule,
  webhookModule,
  prepNotesModule,
  prepSourcesModule,
  screenshotsModule,
  studioSettingsModule,
  roomsModule,
  editorModule,
  updatesModule,
  freeModeModule,
  iceServersModule,
];

for (const mod of coreModules) {
  if (mod.init) mod.init(ctx);
}

const plugins = FREE_MODE ? [] : loadPlugins(ctx, path.join(ROOT, "plugins"));
const modules = [...coreModules, ...plugins];

const routes = modules.flatMap((mod) => mod.routes || []);

const wsHandlers = new Map();
for (const mod of modules) {
  for (const [type, handler] of Object.entries(mod.wsHandlers || {})) {
    wsHandlers.set(type, handler);
  }
}

const closeHandlers = modules.map((mod) => mod.onClose).filter(Boolean);

// Password guessing is throttled everywhere; the general API limit only runs
// in DEMO_MODE / FREE_MODE — self-hosted deployments behind a trusted login
// shouldn't have to think about it.
const authLimiter = createLimiter({ windowMs: 60 * 1000, max: PUBLIC_MODE ? 10 : 20 });
const apiLimiter = PUBLIC_MODE ? createLimiter({ windowMs: 60 * 1000, max: 120 }) : null;
setInterval(() => { authLimiter.sweep(); if (apiLimiter) apiLimiter.sweep(); }, 5 * 60 * 1000).unref();

// Forwarded-for headers are only believed when the connection itself comes
// from a proxy (loopback/private peer — Caddy, Fly's edge). A client talking
// to us directly could put anything in them to dodge the rate limit.
function getClientIp(req) {
  const peer = req.socket.remoteAddress || "";
  if (isPublicAddress(peer.replace(/^::ffff:/i, ""))) return peer;
  // Fly's edge overwrites this header, so it is trustworthy there and only there.
  const flyIp = process.env.FLY_APP_NAME && req.headers["fly-client-ip"];
  if (flyIp) return String(flyIp).trim();
  const xff = req.headers["x-forwarded-for"];
  // The right-most entry is the one our own proxy appended; anything to its
  // left was supplied by the client.
  if (xff) return String(xff).split(",").pop().trim();
  return peer;
}

// JSON endpoints have no business receiving more than this. Upload routes
// (listed below) enforce their own, larger limits.
const MAX_JSON_BODY = 2 * 1024 * 1024;
const OWN_BODY_LIMIT = [
  /^\/api\/upload-chunk$/, /^\/api\/clips$/, /^\/api\/screenshots$/,
  /^\/api\/studio-settings\/upload$/, /^\/api\/prep-sources\/upload$/,
  /^\/api\/editor\/[^/]+\/upload-intro$/, /^\/api\/plugins\//, /^\/plugins\//,
];
function capBody(req, res) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") return true;
  const url = req.url.split("?")[0];
  if (OWN_BODY_LIMIT.some((re) => re.test(url))) return true;
  const tooLarge = () => {
    if (!res.headersSent) {
      res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ error: "Request body too large" }));
    }
  };
  if (Number(req.headers["content-length"]) > MAX_JSON_BODY) { tooLarge(); return false; }
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_JSON_BODY) { tooLarge(); req.destroy(); }
  });
  return true;
}

// ═══════════════════════════════════════════════
//  HTTP SERVER
// ═══════════════════════════════════════════════

// FREE_MODE exposes only the studio. Anything not on this list (or not a
// plain static asset) 404s server-side, so hiding links in the UI is never
// the only thing standing between a visitor and prep/editor/admin routes.
const FREE_API_ROUTES = new Set([
  "GET /api/studio-settings",
  "GET /api/ice-servers",
  "POST /api/rooms",
  "POST /api/rooms/join",
  "POST /api/upload-chunk",
  "POST /api/finalize",
]);
const FREE_BLOCKED_PAGES = new Set([
  "/prep", "/prep.html", "/settings", "/settings.html", "/editor", "/editor.html",
]);
function isFreeModeAllowed(req) {
  const url = req.url.split("?")[0];
  if (FREE_API_ROUTES.has(`${req.method} ${url}`)) return true;
  if (req.method === "GET" && url.startsWith("/api/branding/file/")) return true;
  return !(url.startsWith("/api/") || url.startsWith("/plugins/") || url === "/webhook" || FREE_BLOCKED_PAGES.has(url));
}

// Only the signaling messages the studio itself uses; prep/notes/clip/game
// messages are dropped in FREE_MODE.
const FREE_WS_TYPES = new Set([
  "join", "signal", "chat", "recording-control", "remote-mute", "remove-peer", "host-left",
]);

const server = http.createServer((req, res) => {
  // No ACAO header at all unless an origin is configured — same-origin only.
  if (ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  {
    const isAuth = req.method === "POST" && (req.url === "/api/auth" || req.url === "/api/rooms/join");
    const limiter = isAuth ? authLimiter : req.url.startsWith("/api/") ? apiLimiter : null;
    if (limiter && !limiter.check(getClientIp(req))) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many requests — try again later" }));
      return;
    }
  }

  if (!capBody(req, res)) return;

  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, uptime: Math.floor(process.uptime()) }));
    return;
  }

  if (req.method === "GET" && req.url === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ demoMode: DEMO_MODE, freeMode: FREE_MODE, wipeIntervalMinutes: DEMO_WIPE_INTERVAL_MINUTES }));
    return;
  }

  if (FREE_MODE && !isFreeModeAllowed(req)) {
    // The client probes /api/plugins on load; give it an empty list, not a 404.
    if (req.method === "GET" && req.url.split("?")[0] === "/api/plugins") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
      return;
    }
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  for (const route of routes) {
    if (route.method === req.method && route.match(req.url)) {
      return route.handler(req, res);
    }
  }

  // ── Root-level HTML tools ──
  if (req.method === "GET" && (req.url === "/prep" || req.url === "/prep.html")) {
    const p = path.join(__dirname, "public", "prep.html");
    return fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
  }

  if (req.method === "GET" && (req.url === "/settings" || req.url === "/settings.html")) {
    const p = path.join(__dirname, "public", "settings.html");
    return fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
  }

  // ── Static files ──
  let filePath = req.url.split("?")[0];
  filePath = filePath === "/" ? "/index.html" : filePath;
  const publicDir = path.join(__dirname, "public");
  filePath = path.join(publicDir, filePath);
  // path.join resolves ".." segments, so a raw request for /../lib/auth.js
  // would otherwise escape public/ and serve any file the process can read.
  if (!filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const mimeTypes = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
});

// ═══════════════════════════════════════════════
//  WEBSOCKET SIGNALING SERVER
// ═══════════════════════════════════════════════
// Free mode takes anonymous connections, so cap frame size (signaling and chat are tiny).
const wss = new WebSocketServer({ server, maxPayload: FREE_MODE ? 64 * 1024 : undefined });

wss.on("connection", (ws) => {
  const state = { currentRoom: null, currentUser: null };

  // Without a listener, a protocol error (bad frame, oversized payload) is an
  // unhandled 'error' event and takes the whole process down.
  ws.on("error", (err) => console.warn("[ws] connection error:", err.message));

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    // Valid JSON isn't necessarily an object ("null", "5", "[]").
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

    if (FREE_MODE && !FREE_WS_TYPES.has(msg.type)) return;
    const handler = wsHandlers.get(msg.type);
    if (!handler) return;
    // A handler throwing on a malformed message must not crash the server
    // for everyone else.
    try {
      handler(ws, msg, state);
    } catch (err) {
      console.error(`[ws] handler for "${msg.type}" failed:`, err.message);
    }
  });

  ws.on("close", () => {
    for (const onClose of closeHandlers) onClose(ws, state);
  });
});

// ═══════════════════════════════════════════════
//  DEMO_MODE: SCHEDULED FULL DATA WIPE
// ═══════════════════════════════════════════════
if (DEMO_MODE) {
  const wipeDirs = [
    dirs.RECORDINGS_DIR,
    dirs.PREP_NOTES_DIR,
    dirs.PREP_SOURCES_DIR,
    dirs.SCREENSHOTS_DIR,
    dirs.CLIPS_DIR,
    dirs.BRANDING_DIR,
  ];
  let deferCount = 0;

  function runDemoWipe() {
    if (roomsModule.rooms.size > 0 && deferCount < DEMO_WIPE_MAX_DEFER_CYCLES) {
      deferCount += 1;
      console.log(`[demo] wipe deferred — room active (${deferCount}/${DEMO_WIPE_MAX_DEFER_CYCLES})`);
      return;
    }
    deferCount = 0;
    for (const dir of wipeDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    }
    studioSettingsModule.resetToDefaults();
    console.log("[demo] full data wipe complete");
  }

  setInterval(runDemoWipe, DEMO_WIPE_INTERVAL_MINUTES * 60 * 1000);
  console.log(`[demo] DEMO_MODE active — wiping demo data every ${DEMO_WIPE_INTERVAL_MINUTES} min`);
}

server.listen(PORT, () => {
  console.log(`Podcast Studio server running on http://localhost:${PORT}`);
  console.log(`Recordings saved to: ${dirs.RECORDINGS_DIR}`);
});
