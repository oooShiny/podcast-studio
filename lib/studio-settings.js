const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { requireHost } = require("./auth");

const DEFAULT_STUDIO_SETTINGS = {
  brandName: "Podcast Studio",
  accentColor: "#ef4a52",
  bgColor: "#024",
  surfaceColor: "#001327",
  textColor: "#e8e6f0",
  textDimColor: "#8a879a",
  menuTextColor: "#8a879a",
  logoUrl: "",
  backgroundUrl: "",
  disabledTabs: [],
  guestPrepAccess: true,
  guestChatTab: true,
  memberChatTab: true,
};
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
// Covers the 4 core tab ids plus any plugin-registered tab id (which follows
// the same slug shape — see plugins/hello-world/public/tab.js).
const TAB_ID_RE = /^[a-zA-Z0-9_-]{1,60}$/;

let ctx;
let STUDIO_SETTINGS_FILE;
function init(c) {
  ctx = c;
  STUDIO_SETTINGS_FILE = path.join(ctx.rootDir, "studio-settings.json");
}

// ═══════════════════════════════════════════════
//  STUDIO LOOK & FEEL (host-customizable branding)
// ═══════════════════════════════════════════════
function loadStudioSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(STUDIO_SETTINGS_FILE, "utf8"));
    return { ...DEFAULT_STUDIO_SETTINGS, ...data };
  } catch {
    return { ...DEFAULT_STUDIO_SETTINGS };
  }
}

function saveStudioSettings(settings) {
  fs.writeFileSync(STUDIO_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// Removes a previously uploaded branding image once it's replaced or cleared.
function cleanupBrandingFile(url) {
  if (url && url.startsWith("/api/branding/file/")) {
    try { fs.unlinkSync(path.join(ctx.dirs.BRANDING_DIR, url.split("/").pop())); } catch {}
  }
}

function broadcastStudioSettings(settings) {
  ctx.broadcast("studio", { type: "studio-settings-update", settings });
}

function resetToDefaults() {
  const next = { ...DEFAULT_STUDIO_SETTINGS };
  saveStudioSettings(next);
  broadcastStudioSettings(next);
  return next;
}

function handleGetStudioSettings(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(loadStudioSettings()));
}

function handlePutStudioSettings(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { brandName, accentColor, bgColor, surfaceColor, textColor, textDimColor, menuTextColor, logoUrl, backgroundUrl, disabledTabs, guestPrepAccess, guestChatTab, memberChatTab } = JSON.parse(body);

      const current = loadStudioSettings();
      const next = { ...current };

      if (brandName !== undefined) {
        next.brandName = String(brandName).trim().slice(0, 60) || DEFAULT_STUDIO_SETTINGS.brandName;
      }
      if (accentColor !== undefined && HEX_COLOR_RE.test(accentColor)) next.accentColor = accentColor;
      if (bgColor !== undefined && HEX_COLOR_RE.test(bgColor)) next.bgColor = bgColor;
      if (surfaceColor !== undefined && HEX_COLOR_RE.test(surfaceColor)) next.surfaceColor = surfaceColor;
      if (textColor !== undefined && HEX_COLOR_RE.test(textColor)) next.textColor = textColor;
      if (textDimColor !== undefined && HEX_COLOR_RE.test(textDimColor)) next.textDimColor = textDimColor;
      if (menuTextColor !== undefined && HEX_COLOR_RE.test(menuTextColor)) next.menuTextColor = menuTextColor;
      if (logoUrl !== undefined && logoUrl !== current.logoUrl) {
        cleanupBrandingFile(current.logoUrl);
        next.logoUrl = String(logoUrl).slice(0, 300);
      }
      if (backgroundUrl !== undefined && backgroundUrl !== current.backgroundUrl) {
        cleanupBrandingFile(current.backgroundUrl);
        next.backgroundUrl = String(backgroundUrl).slice(0, 300);
      }
      if (Array.isArray(disabledTabs)) {
        next.disabledTabs = [...new Set(disabledTabs.filter((id) => typeof id === "string" && TAB_ID_RE.test(id)))];
      }
      if (typeof guestPrepAccess === "boolean") next.guestPrepAccess = guestPrepAccess;
      if (typeof guestChatTab === "boolean") next.guestChatTab = guestChatTab;
      if (typeof memberChatTab === "boolean") next.memberChatTab = memberChatTab;

      saveStudioSettings(next);
      broadcastStudioSettings(next);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, settings: next }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function handleUploadBrandingImage(req, res) {
  const chunks = [];
  let size = 0;
  const MAX_IMAGE = process.env.DEMO_MODE ? 2 * 1024 * 1024 : 8 * 1024 * 1024; // 2 MB in demo mode, 8 MB otherwise

  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_IMAGE) {
      res.writeHead(413);
      res.end(JSON.stringify({ error: "Image too large (max 8 MB)" }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    try {
      const body = Buffer.concat(chunks);
      const newlineIdx = body.indexOf(10);
      if (newlineIdx === -1) throw new Error("Invalid format");

      const meta = JSON.parse(body.slice(0, newlineIdx).toString());
      const imageData = body.slice(newlineIdx + 1);

      const { kind, mimeType } = meta;
      if (kind !== "logo" && kind !== "background") throw new Error("Invalid kind");
      if (!imageData.length) throw new Error("Empty image");

      const ext = mimeType && mimeType.includes("png") ? ".png"
        : mimeType && mimeType.includes("webp") ? ".webp"
        : mimeType && mimeType.includes("gif") ? ".gif"
        : mimeType && mimeType.includes("svg") ? ".svg"
        : ".jpg";
      const filename = `${kind}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
      fs.writeFileSync(path.join(ctx.dirs.BRANDING_DIR, filename), imageData);

      const current = loadStudioSettings();
      const field = kind === "logo" ? "logoUrl" : "backgroundUrl";
      cleanupBrandingFile(current[field]);

      const next = { ...current, [field]: `/api/branding/file/${filename}` };
      saveStudioSettings(next);
      broadcastStudioSettings(next);

      console.log(`  🎨 ${kind} uploaded (${(imageData.length / 1024).toFixed(0)} KB)`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, settings: next }));
    } catch (e) {
      console.error("Branding upload error:", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function handleServeBrandingFile(req, res) {
  const filename = decodeURIComponent(req.url.split("/").pop());
  const safeName = filename.replace(/[^a-zA-Z0-9\-_.]/g, "");
  const filePath = path.join(ctx.dirs.BRANDING_DIR, safeName);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(safeName).toLowerCase();
    const mimeTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream", "Cache-Control": "max-age=86400" });
    res.end(data);
  });
}

module.exports = {
  routes: [
    { method: "GET", match: (url) => url === "/api/studio-settings", handler: handleGetStudioSettings },
    { method: "PUT", match: (url) => url === "/api/studio-settings", handler: requireHost(handlePutStudioSettings) },
    { method: "POST", match: (url) => url === "/api/studio-settings/upload", handler: requireHost(handleUploadBrandingImage) },
    { method: "GET", match: (url) => url.startsWith("/api/branding/file/"), handler: handleServeBrandingFile },
  ],
  init,
  DEFAULT_STUDIO_SETTINGS,
  resetToDefaults,
};
