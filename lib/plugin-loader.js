const fs = require("fs");
const path = require("path");
const { requireHost } = require("./auth");

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
// This is a hard, boot-time gate — plugins it excludes are never required/init'd
// and never appear in /api/plugins, unlike the soft per-plugin toggle below.
function parseEnabledList() {
  const raw = process.env.PLUGINS_ENABLED;
  if (raw === undefined) return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// Soft, host-toggleable enable/disable (via the /settings page) for plugins
// that already passed the PLUGINS_ENABLED gate above. Persisted so it survives
// restarts, but doesn't require one to take effect — route matching below
// checks this set live.
function loadPluginSettings(ctx) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ctx.rootDir, "plugins-settings.json"), "utf8"));
    return new Set(Array.isArray(data.disabledPlugins) ? data.disabledPlugins : []);
  } catch {
    return new Set();
  }
}

function savePluginSettings(ctx, disabledPlugins) {
  fs.writeFileSync(
    path.join(ctx.rootDir, "plugins-settings.json"),
    JSON.stringify({ disabledPlugins: [...disabledPlugins] }, null, 2)
  );
}

// Serves /api/plugins (manifest list) and /plugins/<name>/<asset> (static
// files from each plugin's own public/ dir) so frontend extensions can be
// discovered and loaded without editing index.html. Also exposes a host-only
// PUT to flip a plugin's soft-enabled state without restarting the server.
function buildAssetsModule(ctx, pluginsDir, manifests, disabledPlugins) {
  const knownNames = new Set(manifests.map((m) => m.name));

  function handleList(req, res) {
    const body = manifests.map((m) => ({ ...m, enabled: !disabledPlugins.has(m.name) }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
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

  function handleSetEnabled(req, res) {
    const match = req.url.split("?")[0].match(/^\/api\/plugins\/([^/]+)$/);
    const name = match && decodeURIComponent(match[1]);

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { enabled } = JSON.parse(body);
        if (!knownNames.has(name)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown plugin" }));
          return;
        }

        if (enabled === false) disabledPlugins.add(name);
        else disabledPlugins.delete(name);
        savePluginSettings(ctx, disabledPlugins);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, name, enabled: !disabledPlugins.has(name) }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  return {
    routes: [
      { method: "GET", match: (url) => url.split("?")[0] === "/api/plugins", handler: handleList },
      { method: "PUT", match: (url) => /^\/api\/plugins\/[^/]+$/.test(url.split("?")[0]), handler: requireHost(handleSetEnabled) },
      { method: "GET", match: (url) => url.split("?")[0].startsWith("/plugins/"), handler: handleAsset },
    ],
  };
}

// Wraps a plugin's routes so they stop matching the moment it's soft-disabled,
// without needing to re-require or restart anything.
function wrapRoutesForToggle(mod, pluginName, disabledPlugins) {
  if (!mod.routes) return mod;
  return {
    ...mod,
    routes: mod.routes.map((route) => ({
      ...route,
      match: (url) => !disabledPlugins.has(pluginName) && route.match(url),
    })),
  };
}

// Discovers plugin folders under pluginsDir (each a manifest.json + index.js
// exporting the same {routes, wsHandlers, init(ctx), onClose} shape core lib/
// modules use), requires them, and inits each with its own scoped ctx.
function loadPlugins(ctx, pluginsDir) {
  if (!fs.existsSync(pluginsDir)) return [];

  const enabled = parseEnabledList();
  const disabledPlugins = loadPluginSettings(ctx);
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
    plugins.push(wrapRoutesForToggle(mod, pluginName, disabledPlugins));

    const hasTab = fs.existsSync(path.join(dir, "public", "tab.js"));
    manifests.push({ name: pluginName, version: manifest.version || "0.0.0", hasTab });

    const status = disabledPlugins.has(pluginName) ? "loaded (disabled)" : "loaded";
    console.log(`[plugins] ${status} ${pluginName}@${manifest.version || "0.0.0"}`);
  }

  return [buildAssetsModule(ctx, pluginsDir, manifests, disabledPlugins), ...plugins];
}

module.exports = { loadPlugins };
