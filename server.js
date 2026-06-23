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

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

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

// ═══════════════════════════════════════════════
//  HTTP SERVER
// ═══════════════════════════════════════════════
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
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

server.listen(PORT, () => {
  console.log(`Podcast Studio server running on http://localhost:${PORT}`);
  console.log(`Recordings saved to: ${dirs.RECORDINGS_DIR}`);
});
