const fs = require("fs");
const path = require("path");
const { safeGame, getQuery, checkDemoStorageCap } = require("./util");
const { requireAuth } = require("./auth");

const DEMO_STORAGE_CAP_BYTES = (Number(process.env.DEMO_STORAGE_CAP_MB) || 300) * 1024 * 1024;

let ctx;
function init(c) {
  ctx = c;
}

// ═══════════════════════════════════════════════
//  SCREENSHOTS (per-game)
// ═══════════════════════════════════════════════
function screenshotsDir(game) {
  const dir = path.join(ctx.dirs.SCREENSHOTS_DIR, safeGame(game));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function handleSaveScreenshot(req, res) {
  if (process.env.DEMO_MODE && !checkDemoStorageCap(ctx, DEMO_STORAGE_CAP_BYTES)) {
    res.writeHead(507, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Demo storage is full — try again after the next reset" }));
    return;
  }

  const chunks = [];
  let size = 0;
  const MAX_SCREENSHOT = process.env.DEMO_MODE ? 3 * 1024 * 1024 : 10 * 1024 * 1024; // 3 MB in demo mode, 10 MB otherwise
  req.on("data", chunk => {
    size += chunk.length;
    if (size > MAX_SCREENSHOT) { res.writeHead(413); res.end(JSON.stringify({ error: "Too large" })); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      const { game, dataUrl, videoTime } = JSON.parse(Buffer.concat(chunks).toString());
      if (!game || !dataUrl) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing game or dataUrl" })); return; }
      const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const vtSuffix = (videoTime != null && isFinite(videoTime)) ? `_t${Math.floor(videoTime)}` : "";
      const filename = `${ts}${vtSuffix}.png`;
      fs.writeFileSync(path.join(screenshotsDir(game), filename), Buffer.from(b64, "base64"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ filename, url: `/api/screenshots/file/${encodeURIComponent(game)}/${filename}` }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function handleListScreenshots(req, res) {
  const game = getQuery(req).get("game") || "";
  if (!game) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing game" })); return; }
  try {
    const dir = screenshotsDir(game);
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".png")).sort();
    const list = files.map(f => {
      const vtMatch = f.match(/_t(\d+)\.png$/);
      return {
        filename: f,
        url: `/api/screenshots/file/${encodeURIComponent(game)}/${f}`,
        videoTime: vtMatch ? parseInt(vtMatch[1], 10) : null,
      };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
  } catch { res.writeHead(200, { "Content-Type": "application/json" }); res.end("[]"); }
}

function handleServeScreenshot(req, res) {
  const parts = req.url.replace("/api/screenshots/file/", "").split("/");
  if (parts.length < 2) { res.writeHead(400); res.end("Bad request"); return; }
  const game = decodeURIComponent(parts[0]);
  const filename = parts[1];
  if (!/^[\w.-]+$/.test(filename)) { res.writeHead(400); res.end("Bad filename"); return; }
  const filePath = path.join(screenshotsDir(game), filename);
  if (!filePath.startsWith(ctx.dirs.SCREENSHOTS_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400" });
    res.end(data);
  });
}

function handleDeleteScreenshot(req, res) {
  const parts = req.url.replace("/api/screenshots/", "").split("/");
  if (parts.length < 2) { res.writeHead(400); res.end("Bad request"); return; }
  const game = decodeURIComponent(parts[0]);
  const filename = parts[1];
  if (!/^[\w.-]+$/.test(filename)) { res.writeHead(400); res.end("Bad filename"); return; }
  const filePath = path.join(screenshotsDir(game), filename);
  if (!filePath.startsWith(ctx.dirs.SCREENSHOTS_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  try { fs.unlinkSync(filePath); } catch {}
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

module.exports = {
  routes: [
    { method: "POST", match: (url) => url === "/api/screenshots", handler: requireAuth(handleSaveScreenshot) },
    { method: "GET", match: (url) => url.startsWith("/api/screenshots/file/"), handler: handleServeScreenshot },
    { method: "GET", match: (url) => url.startsWith("/api/screenshots"), handler: handleListScreenshots },
    { method: "DELETE", match: (url) => url.startsWith("/api/screenshots/"), handler: requireAuth(handleDeleteScreenshot) },
  ],
  init,
};
