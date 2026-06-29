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
const { loadPlugins } = require("./lib/plugin-loader");
const { createLimiter } = require("./lib/rate-limit");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const DEMO_MODE = !!process.env.DEMO_MODE;
const DEMO_ALLOWED_ORIGIN = process.env.DEMO_ALLOWED_ORIGIN || "";
const DEMO_WIPE_INTERVAL_MINUTES = Number(process.env.DEMO_WIPE_INTERVAL_MINUTES) || 25;
const DEMO_WIPE_MAX_DEFER_CYCLES = Number(process.env.DEMO_WIPE_MAX_DEFER_CYCLES) || 3;

const dirs = {
  RECORDINGS_DIR: path.join(ROOT, "recordings"),
  PREP_NOTES_DIR: path.join(ROOT, "prep-notes"),
  PREP_SOURCES_DIR: path.join(ROOT, "prep-sources"),
  SCREENSHOTS_DIR: path.join(ROOT, "screenshots"),
  CLIPS_DIR: path.join(ROOT, "clips"),
  BRANDING_DIR: path.join(ROOT, "branding"),
};

for (const dir of Object.values(dirs)) {
  fs.mkdirSync(dir, { recursive: true });
}

const PLUGINS_DATA_DIR = path.join(ROOT, "plugins-data");

const ctx = {
  rootDir: ROOT,
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
];

for (const mod of coreModules) {
  if (mod.init) mod.init(ctx);
}

const plugins = loadPlugins(ctx, path.join(ROOT, "plugins"));
const modules = [...coreModules, ...plugins];

const routes = modules.flatMap((mod) => mod.routes || []);

const wsHandlers = new Map();
for (const mod of modules) {
  for (const [type, handler] of Object.entries(mod.wsHandlers || {})) {
    wsHandlers.set(type, handler);
  }
}

const closeHandlers = modules.map((mod) => mod.onClose).filter(Boolean);

// Rate limiting only runs in DEMO_MODE — self-hosted deployments behind a
// trusted login shouldn't have to think about it.
const authLimiter = DEMO_MODE ? createLimiter({ windowMs: 60 * 1000, max: 10 }) : null;
const apiLimiter = DEMO_MODE ? createLimiter({ windowMs: 60 * 1000, max: 120 }) : null;
if (DEMO_MODE) {
  setInterval(() => { authLimiter.sweep(); apiLimiter.sweep(); }, 5 * 60 * 1000);
}

// Caddy (the reverse proxy this app is normally deployed behind) sets
// X-Forwarded-For; fall back to the raw socket address for direct connections.
function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  return req.socket.remoteAddress;
}

// ═══════════════════════════════════════════════
//  HTTP SERVER
// ═══════════════════════════════════════════════
const server = http.createServer((req, res) => {
  if (DEMO_MODE) {
    if (DEMO_ALLOWED_ORIGIN) res.setHeader("Access-Control-Allow-Origin", DEMO_ALLOWED_ORIGIN);
    // else: no ACAO header at all — same-origin only, the safe default for a demo.
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (DEMO_MODE) {
    const ip = getClientIp(req);
    const isAuth = req.method === "POST" && req.url === "/api/auth";
    const limiter = isAuth ? authLimiter : req.url.startsWith("/api/") ? apiLimiter : null;
    if (limiter && !limiter.check(ip)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many requests — try again later" }));
      return;
    }
  }

  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, uptime: Math.floor(process.uptime()) }));
    return;
  }

  for (const route of routes) {
    if (route.method === req.method && route.match(req.url)) {
      return route.handler(req, res);
    }
  }

  // ── Root-level HTML tools ──
  if (req.method === "GET" && (req.url === "/prep" || req.url === "/prep.html")) {
    const p = path.join(__dirname, "prep.html");
    return fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
  }

  if (req.method === "GET" && (req.url === "/settings" || req.url === "/settings.html")) {
    const p = path.join(__dirname, "settings.html");
    return fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
  }

  // ── Static files ──
  let filePath = req.url.split("?")[0];
  filePath = filePath === "/" ? "/index.html" : filePath;
  filePath = path.join(__dirname, "public", filePath);

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
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const state = { currentRoom: null, currentUser: null };

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    const handler = wsHandlers.get(msg.type);
    if (handler) handler(ws, msg, state);
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
