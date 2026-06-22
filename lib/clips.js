const fs = require("fs");
const path = require("path");

let ctx;
let CLIPS_META;
function init(c) {
  ctx = c;
  CLIPS_META = path.join(ctx.dirs.CLIPS_DIR, "clips.json");
}

function loadClipsMeta() {
  if (fs.existsSync(CLIPS_META)) {
    try { return JSON.parse(fs.readFileSync(CLIPS_META, "utf8")); } catch {}
  }
  return [];
}

function saveClipsMeta(clips) {
  fs.writeFileSync(CLIPS_META, JSON.stringify(clips, null, 2));
}

function handleListClips(req, res) {
  const clips = loadClipsMeta();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ clips }));
}

function handleUploadClip(req, res) {
  const chunks = [];
  let size = 0;
  const MAX_CLIP = 20 * 1024 * 1024; // 20 MB max per clip

  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_CLIP) {
      res.writeHead(413);
      res.end(JSON.stringify({ error: "Clip too large (max 20 MB)" }));
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
      const audioData = body.slice(newlineIdx + 1);

      const { name, category } = meta;
      if (!name) throw new Error("Missing clip name");

      const id = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ext = meta.mimeType && meta.mimeType.includes("wav") ? ".wav"
        : meta.mimeType && meta.mimeType.includes("mp3") ? ".mp3"
        : meta.mimeType && meta.mimeType.includes("mpeg") ? ".mp3"
        : ".audio";
      const filename = `${id}${ext}`;

      fs.writeFileSync(path.join(ctx.dirs.CLIPS_DIR, filename), audioData);

      const clips = loadClipsMeta();
      clips.push({
        id,
        name,
        filename,
        category: category || "general",
        size: audioData.length,
        uploadedAt: new Date().toISOString(),
        url: `/api/clips/file/${filename}`,
      });
      saveClipsMeta(clips);

      console.log(`  ♫ clip uploaded: ${name} (${(audioData.length / 1024).toFixed(0)} KB)`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, id }));
    } catch (e) {
      console.error("Clip upload error:", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function handleRenameClip(req, res) {
  // URL: /api/clips/:clipId/rename
  const parts = req.url.split("/");
  const clipId = parts[3]; // ["", "api", "clips", "<id>", "rename"]

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { name } = JSON.parse(body);
      if (!name || !name.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Name is required" }));
        return;
      }

      const clips = loadClipsMeta();
      const clip = clips.find((c) => c.id === clipId);

      if (!clip) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Clip not found" }));
        return;
      }

      clip.name = name.trim();
      saveClipsMeta(clips);

      console.log(`  ✎ clip renamed: ${clipId} → "${clip.name}"`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: clip.name }));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad request" }));
    }
  });
}

function handleDeleteClip(req, res) {
  const clipId = req.url.split("/").pop();
  const clips = loadClipsMeta();
  const clip = clips.find((c) => c.id === clipId);

  if (!clip) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Clip not found" }));
    return;
  }

  // Delete file
  const clipPath = path.join(ctx.dirs.CLIPS_DIR, clip.filename);
  if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);

  // Remove from metadata
  const updated = clips.filter((c) => c.id !== clipId);
  saveClipsMeta(updated);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

function handleServeClip(req, res) {
  const filename = decodeURIComponent(req.url.split("/").pop());
  const safeName = filename.replace(/[^a-zA-Z0-9\-_.]/g, "");
  const clipPath = path.join(ctx.dirs.CLIPS_DIR, safeName);

  if (!fs.existsSync(clipPath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const stats = fs.statSync(clipPath);
  const ext = path.extname(safeName);
  const mimeTypes = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".webm": "audio/webm" };

  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "audio/mpeg",
    "Content-Length": stats.size,
  });
  fs.createReadStream(clipPath).pipe(res);
}

module.exports = {
  routes: [
    { method: "GET", match: (url) => url === "/api/clips", handler: handleListClips },
    { method: "POST", match: (url) => url === "/api/clips", handler: handleUploadClip },
    { method: "POST", match: (url) => /^\/api\/clips\/[^/]+\/rename$/.test(url), handler: handleRenameClip },
    { method: "DELETE", match: (url) => url.startsWith("/api/clips/"), handler: handleDeleteClip },
    { method: "GET", match: (url) => url.startsWith("/api/clips/file/"), handler: handleServeClip },
  ],
  init,
};
