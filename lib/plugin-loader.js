const fs = require("fs");
const path = require("path");

// PLUGINS_ENABLED unset = every discovered plugin loads (zero-config default).
// Set to a comma-separated list to opt into only those plugins (empty = none).
function parseEnabledList() {
  const raw = process.env.PLUGINS_ENABLED;
  if (raw === undefined) return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
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
    console.log(`[plugins] loaded ${pluginName}@${manifest.version || "0.0.0"}`);
  }
  return plugins;
}

module.exports = { loadPlugins };
