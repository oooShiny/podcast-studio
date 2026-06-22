const fs = require("fs");
const path = require("path");

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

// PLUGINS_ENABLED unset = every discovered plugin loads (zero-config default).
// Set to a comma-separated list to opt into only those plugins (empty = none).
function parseEnabledList() {
  const raw = process.env.PLUGINS_ENABLED;
  if (raw === undefined) return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// Serves /api/plugins (manifest list) and /plugins/<name>/<asset> (static
// files from each plugin's own public/ dir) so frontend extensions can be
// discovered and loaded without editing index.html.
function buildAssetsModule(pluginsDir, manifests) {
  function handleList(req, res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(manifests));
  }

  function handleAsset(req, res) {
    const url = req.url.split("?")[0];
    const match = url.match(/^\/plugins\/([^/]+)\/(.+)$/);
    if (!match) { res.writeHead(404); res.end("Not found"); return; }

    const [, name, asset] = match;
    const publicDir = path.join(pluginsDir, name, "public");
    const filePath = path.join(publicDir, asset);

    if (!filePath.startsWith(publicDir + path.sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end("Not found"); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
      res.end(data);
    });
  }

  return {
    routes: [
      { method: "GET", match: (url) => url.split("?")[0] === "/api/plugins", handler: handleList },
      { method: "GET", match: (url) => url.split("?")[0].startsWith("/plugins/"), handler: handleAsset },
    ],
  };
}

// Discovers plugin folders under pluginsDir (each a manifest.json + index.js
// exporting the same {routes, wsHandlers, init(ctx), onClose} shape core lib/
// modules use), requires them, and inits each with its own scoped ctx.
function loadPlugins(ctx, pluginsDir) {
  if (!fs.existsSync(pluginsDir)) return [];

  const enabled = parseEnabledList();
  const names = fs.readdirSync(pluginsDir)
    .filter((name) => fs.statSync(path.join(pluginsDir, name)).isDirectory())
    .sort();

  const plugins = [];
  const manifests = [];
  for (const name of names) {
    if (enabled && !enabled.includes(name)) continue;

    const dir = path.join(pluginsDir, name);
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const pluginName = manifest.name || name;
    const mod = require(path.join(dir, "index.js"));
    const pluginCtx = { ...ctx, pluginDir: () => ctx.pluginDir(pluginName) };

    if (mod.init) mod.init(pluginCtx);
    plugins.push(mod);

    const hasTab = fs.existsSync(path.join(dir, "public", "tab.js"));
    manifests.push({ name: pluginName, version: manifest.version || "0.0.0", hasTab });

    console.log(`[plugins] loaded ${pluginName}@${manifest.version || "0.0.0"}`);
  }

  return [buildAssetsModule(pluginsDir, manifests), ...plugins];
}

module.exports = { loadPlugins };
