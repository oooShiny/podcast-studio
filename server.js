require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const RECORDINGS_DIR = path.join(__dirname, "recordings");
const PREP_NOTES_DIR = path.join(__dirname, "prep-notes");
const PREP_SOURCES_DIR  = path.join(__dirname, "prep-sources");
const SCREENSHOTS_DIR   = path.join(__dirname, "screenshots");
const MAX_BODY = 5 * 1024 * 1024;
const MAX_SOURCE_BODY = 2 * 1024 * 1024 * 1024; // 2 GB — sources include uploaded video

fs.mkdirSync(RECORDINGS_DIR,  { recursive: true });
fs.mkdirSync(PREP_NOTES_DIR,  { recursive: true });
fs.mkdirSync(PREP_SOURCES_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ═══════════════════════════════════════════════
//  PASSWORDS & ROLES
//  Change these! In production, load from env vars.
// ═══════════════════════════════════════════════
const PASSWORDS = {
  host: process.env.HOST_PASSWORD || "host123",
  member: process.env.MEMBER_PASSWORD || "member123",
  guest: process.env.GUEST_PASSWORD || "guest",
};

// Note fields broadcast live over WS; everything else is private per-user.
const SHARED_FIELDS = ["n-shared"];

function authenticatePassword(password) {
  if (password === PASSWORDS.host) return "host";
  if (password === PASSWORDS.member) return "member";
  if (password === PASSWORDS.guest) return "guest";
  return null;
}

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

  // ── Auth check: POST /api/auth ──
  if (req.method === "POST" && req.url === "/api/auth") {
    return handleAuth(req, res);
  }

  // ── Upload chunk ──
  if (req.method === "POST" && req.url === "/api/upload-chunk") {
    return handleChunkUpload(req, res);
  }

  // ── Finalize recording ──
  if (req.method === "POST" && req.url === "/api/finalize") {
    return handleFinalize(req, res);
  }

  // ── List ALL recording sessions: GET /api/recordings ──
  if (req.method === "GET" && req.url === "/api/recordings") {
    return handleListAllRecordings(req, res);
  }

  // ── List session recordings: GET /api/sessions/:sessionId ──
  if (req.method === "GET" && req.url.startsWith("/api/sessions/")) {
    return handleListSession(req, res);
  }

  // ── Download: GET /api/download/:sessionId/:filename ──
  if (req.method === "GET" && req.url.startsWith("/api/download/")) {
    return handleDownload(req, res);
  }

  // ── Delete session: DELETE /api/sessions/:sessionId ──
  if (req.method === "DELETE" && req.url.startsWith("/api/sessions/")) {
    return handleDeleteSession(req, res);
  }

  // ── Delete single file: DELETE /api/download/:sessionId/:filename ──
  if (req.method === "DELETE" && req.url.startsWith("/api/download/")) {
    return handleDeleteFile(req, res);
  }

  // ── Clip library: GET /api/clips, POST /api/clips, DELETE /api/clips/:id ──
  if (req.method === "GET" && req.url === "/api/clips") {
    return handleListClips(req, res);
  }
  if (req.method === "POST" && req.url === "/api/clips") {
    return handleUploadClip(req, res);
  }
  if (req.method === "POST" && req.url.match(/^\/api\/clips\/[^/]+\/rename$/)) {
    return handleRenameClip(req, res);
  }
  if (req.method === "DELETE" && req.url.startsWith("/api/clips/")) {
    return handleDeleteClip(req, res);
  }
  // ── Serve clip audio files: GET /api/clips/file/:filename ──
  if (req.method === "GET" && req.url.startsWith("/api/clips/file/")) {
    return handleServeClip(req, res);
  }

  // ── GitHub webhook: POST /webhook ──
  if (req.method === "POST" && req.url === "/webhook") {
    return handleWebhook(req, res);
  }

  // ── Current game: GET/PUT /api/current-game ──
  if (req.method === "GET" && req.url === "/api/current-game") {
    return handleGetCurrentGame(req, res);
  }
  if (req.method === "PUT" && req.url === "/api/current-game") {
    return handlePutCurrentGame(req, res);
  }

  // ── Prep notes: GET/PUT /api/prep-notes ──
  if (req.method === "GET" && req.url.startsWith("/api/prep-notes/games")) {
    return handleListPrepNoteGames(req, res);
  }
  if (req.method === "GET" && req.url.startsWith("/api/prep-notes/users")) {
    return handleListPrepNoteUsers(req, res);
  }
  if (req.method === "GET" && req.url.startsWith("/api/prep-notes")) {
    return handleGetPrepNotes(req, res);
  }
  if (req.method === "PUT" && req.url.startsWith("/api/prep-notes")) {
    return handlePutPrepNotes(req, res);
  }

  // ── OCR via Google Cloud Vision ──
  if (req.method === "POST" && req.url === "/api/ocr") {
    return handleOcr(req, res);
  }

  // ── Prep sources: list / upload / add-url / serve file / delete ──
  if (req.method === "GET" && req.url.startsWith("/api/prep-sources/file/")) {
    return handleServeSourceFile(req, res);
  }
  if (req.method === "GET" && req.url.startsWith("/api/prep-sources")) {
    return handleListSources(req, res);
  }
  if (req.method === "POST" && req.url === "/api/prep-sources/upload") {
    return handleUploadSource(req, res);
  }
  if (req.method === "POST" && req.url === "/api/prep-sources/url") {
    return handleAddUrlSource(req, res);
  }
  if (req.method === "POST" && req.url === "/api/prep-sources/tag-season") {
    return handleTagSeasonSource(req, res);
  }
  if (req.method === "DELETE" && req.url.startsWith("/api/prep-sources/")) {
    return handleDeleteSource(req, res);
  }
  if (req.method === "PATCH" && req.url.startsWith("/api/prep-sources/")) {
    return handleRenameSource(req, res);
  }

  // ── Screenshots: save / list / serve / delete ──
  if (req.method === "POST" && req.url === "/api/screenshots") {
    return handleSaveScreenshot(req, res);
  }
  if (req.method === "GET" && req.url.startsWith("/api/screenshots/file/")) {
    return handleServeScreenshot(req, res);
  }
  if (req.method === "GET" && req.url.startsWith("/api/screenshots")) {
    return handleListScreenshots(req, res);
  }
  if (req.method === "DELETE" && req.url.startsWith("/api/screenshots/")) {
    return handleDeleteScreenshot(req, res);
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
//  AUTH HANDLER
// ═══════════════════════════════════════════════
function handleAuth(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { password } = JSON.parse(body);
      const role = authenticatePassword(password);
      if (role) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, role }));
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

// ═══════════════════════════════════════════════
//  CHUNK UPLOAD HANDLER
// ═══════════════════════════════════════════════
function handleChunkUpload(req, res) {
  const chunks = [];
  let size = 0;

  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      res.writeHead(413);
      res.end(JSON.stringify({ error: "Chunk too large" }));
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

      const { sessionId, participantId, username, chunkIndex, trackType } = meta;
      if (!sessionId || !participantId || chunkIndex === undefined) {
        throw new Error("Missing fields");
      }

      const safeSession = sanitize(sessionId);
      const trackLabel = trackType === "mix" ? "MIX" : sanitize(username);
      const safeParticipant = `${trackLabel}-${sanitize(participantId).slice(0, 8)}`;

      const participantDir = path.join(RECORDINGS_DIR, safeSession, safeParticipant);
      fs.mkdirSync(participantDir, { recursive: true });

      // Write session metadata if it doesn't exist
      const metaPath = path.join(RECORDINGS_DIR, safeSession, "session.json");
      if (!fs.existsSync(metaPath)) {
        fs.writeFileSync(metaPath, JSON.stringify({
          sessionId: safeSession,
          startedAt: new Date().toISOString(),
          participants: [],
        }));
      }

      const chunkFile = `chunk-${String(chunkIndex).padStart(4, "0")}.webm`;
      fs.writeFileSync(path.join(participantDir, chunkFile), audioData);

      console.log(`  ↑ chunk ${chunkIndex} from ${trackLabel} (${(audioData.length / 1024).toFixed(1)} KB)`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, chunkIndex }));
    } catch (e) {
      console.error("Chunk upload error:", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ═══════════════════════════════════════════════
//  FINALIZE
// ═══════════════════════════════════════════════
function handleFinalize(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { sessionId, participantId, username, mimeType, trackType } = JSON.parse(body);

      const safeSession = sanitize(sessionId);
      const trackLabel = trackType === "mix" ? "MIX" : sanitize(username);
      const safeParticipant = `${trackLabel}-${sanitize(participantId).slice(0, 8)}`;
      const participantDir = path.join(RECORDINGS_DIR, safeSession, safeParticipant);

      if (!fs.existsSync(participantDir)) {
        throw new Error("No chunks found");
      }

      const chunkFiles = fs.readdirSync(participantDir)
        .filter((f) => f.startsWith("chunk-") && f.endsWith(".webm"))
        .sort();

      if (chunkFiles.length === 0) throw new Error("No chunk files");

      const outputFile = `${safeParticipant}.webm`;
      const outputPath = path.join(RECORDINGS_DIR, safeSession, outputFile);

      const writeStream = fs.createWriteStream(outputPath);
      for (const cf of chunkFiles) {
        const data = fs.readFileSync(path.join(participantDir, cf));
        writeStream.write(data);
      }
      writeStream.end();

      writeStream.on("finish", () => {
        for (const cf of chunkFiles) {
          try { fs.unlinkSync(path.join(participantDir, cf)); } catch {}
        }
        try { fs.rmdirSync(participantDir); } catch {}

        // Update session metadata
        const metaPath = path.join(RECORDINGS_DIR, safeSession, "session.json");
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            if (!meta.participants) meta.participants = [];
            meta.participants.push({ username: trackLabel, filename: outputFile });
            meta.finishedAt = new Date().toISOString();
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
          } catch {}
        }

        const stats = fs.statSync(outputPath);
        console.log(`  ✓ finalized ${outputFile} (${(stats.size / (1024 * 1024)).toFixed(1)} MB)`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, filename: outputFile, size: stats.size }));
      });
    } catch (e) {
      console.error("Finalize error:", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ═══════════════════════════════════════════════
//  LIST ALL RECORDING SESSIONS
// ═══════════════════════════════════════════════
function handleListAllRecordings(req, res) {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: [] }));
    return;
  }

  const sessions = [];
  const dirs = fs.readdirSync(RECORDINGS_DIR).filter((d) =>
    fs.statSync(path.join(RECORDINGS_DIR, d)).isDirectory()
  );

  for (const dir of dirs) {
    const sessionDir = path.join(RECORDINGS_DIR, dir);

    // Read session metadata
    let meta = { sessionId: dir };
    const metaPath = path.join(sessionDir, "session.json");
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch {}
    }

    // List recording files
    const files = fs.readdirSync(sessionDir)
      .filter((f) => f.endsWith(".webm"))
      .map((f) => {
        const stats = fs.statSync(path.join(sessionDir, f));
        return {
          filename: f,
          size: stats.size,
          downloadUrl: `/api/download/${dir}/${encodeURIComponent(f)}`,
        };
      });

    // Get total size
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    sessions.push({
      sessionId: dir,
      startedAt: meta.startedAt || null,
      finishedAt: meta.finishedAt || null,
      participants: meta.participants || [],
      files,
      totalSize,
    });
  }

  // Sort newest first
  sessions.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ sessions }));
}

// ═══════════════════════════════════════════════
//  LIST SESSION RECORDINGS
// ═══════════════════════════════════════════════
function handleListSession(req, res) {
  const parts = req.url.split("/");
  const sessionId = sanitize(parts[3]);
  const sessionDir = path.join(RECORDINGS_DIR, sessionId);

  if (!fs.existsSync(sessionDir)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ files: [] }));
    return;
  }

  const files = fs.readdirSync(sessionDir)
    .filter((f) => f.endsWith(".webm"))
    .map((f) => {
      const stats = fs.statSync(path.join(sessionDir, f));
      return {
        filename: f,
        size: stats.size,
        downloadUrl: `/api/download/${sessionId}/${encodeURIComponent(f)}`,
      };
    });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ files }));
}

// ═══════════════════════════════════════════════
//  DOWNLOAD
// ═══════════════════════════════════════════════
function handleDownload(req, res) {
  const parts = req.url.split("/");
  const sessionId = sanitize(parts[3]);
  const filename = decodeURIComponent(parts.slice(4).join("/"));
  const safeFilename = sanitize(filename.replace(/\.webm$/, "")) + ".webm";
  const recordingPath = path.join(RECORDINGS_DIR, sessionId, safeFilename);

  if (!fs.existsSync(recordingPath)) {
    res.writeHead(404);
    res.end("File not found");
    return;
  }

  const stats = fs.statSync(recordingPath);
  res.writeHead(200, {
    "Content-Type": "audio/webm",
    "Content-Disposition": `attachment; filename="${safeFilename}"`,
    "Content-Length": stats.size,
  });
  fs.createReadStream(recordingPath).pipe(res);
}

// ═══════════════════════════════════════════════
//  DELETE SESSION
// ═══════════════════════════════════════════════
function handleDeleteSession(req, res) {
  const parts = req.url.split("/");
  const sessionId = sanitize(parts[3]);
  const sessionDir = path.join(RECORDINGS_DIR, sessionId);

  if (!fs.existsSync(sessionDir)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Session not found" }));
    return;
  }

  // Recursively delete
  fs.rmSync(sessionDir, { recursive: true, force: true });
  console.log(`  ✗ deleted session ${sessionId}`);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

// ═══════════════════════════════════════════════
//  DELETE FILE
// ═══════════════════════════════════════════════
function handleDeleteFile(req, res) {
  if (req.method !== "DELETE") return;
  const parts = req.url.split("/");
  const sessionId = sanitize(parts[3]);
  const filename = decodeURIComponent(parts.slice(4).join("/"));
  const safeFilename = sanitize(filename.replace(/\.webm$/, "")) + ".webm";
  const filePath = path.join(RECORDINGS_DIR, sessionId, safeFilename);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "File not found" }));
    return;
  }

  fs.unlinkSync(filePath);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

// ═══════════════════════════════════════════════
//  CLIP LIBRARY — persistent soundboard clips
// ═══════════════════════════════════════════════
const CLIPS_DIR = path.join(__dirname, "clips");
const CLIPS_META = path.join(CLIPS_DIR, "clips.json");
fs.mkdirSync(CLIPS_DIR, { recursive: true });

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

      fs.writeFileSync(path.join(CLIPS_DIR, filename), audioData);

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
  const clipPath = path.join(CLIPS_DIR, clip.filename);
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
  const clipPath = path.join(CLIPS_DIR, safeName);

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

// ═══════════════════════════════════════════════
//  PREP NOTES (per-user, per-game)
// ═══════════════════════════════════════════════
function safeSegment(str, maxLen) {
  return (str || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, maxLen);
}

function handleListPrepNoteGames(req, res) {
  const sharedDir = path.join(PREP_NOTES_DIR, "_shared");
  let games = [];
  try {
    games = fs.readdirSync(sharedDir)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        const slug = f.replace(/\.json$/, "");
        try {
          const d = JSON.parse(fs.readFileSync(path.join(sharedDir, f)));
          return { slug, title: d.title || slug };
        } catch {
          return { slug, title: slug };
        }
      })
      .sort((a, b) => a.slug.localeCompare(b.slug));
  } catch {}
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(games));
}

function handleGetCurrentGame(req, res) {
  fs.readFile(path.join(PREP_NOTES_DIR, "current-game.json"), (err, data) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(err ? JSON.stringify({ game: null, title: null }) : data);
  });
}

function handlePutCurrentGame(req, res) {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    try {
      const { game, title } = JSON.parse(body);
      const safeGame = (game || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150);
      if (!safeGame) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing game" })); return; }
      const data = JSON.stringify({ game: safeGame, title: title || safeGame, updatedAt: new Date().toISOString() });
      fs.mkdirSync(PREP_NOTES_DIR, { recursive: true });
      fs.writeFile(path.join(PREP_NOTES_DIR, "current-game.json"), data, err => {
        if (err) { res.writeHead(500); res.end(JSON.stringify({ error: "Write failed" })); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    } catch {
      res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
  });
}

function handleListPrepNoteUsers(req, res) {
  // Returns users who have a private notes file for a given game (excludes _shared)
  const game = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("game") || "";
  const safeG = (game).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150);
  if (!safeG) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing game" })); return; }
  let users = [];
  try {
    users = fs.readdirSync(PREP_NOTES_DIR)
      .filter(d => d !== "_shared" && fs.statSync(path.join(PREP_NOTES_DIR, d)).isDirectory())
      .filter(d => {
        try { fs.accessSync(path.join(PREP_NOTES_DIR, d, `${safeG}.json`)); return true; } catch { return false; }
      })
      .sort();
  } catch {}
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(users));
}

function handleGetPrepNotes(req, res) {
  const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
  const user = safeSegment(params.get("user"), 50);
  const game = (params.get("game") || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150);

  if (!user || !game) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing user or game" }));
    return;
  }

  const filePath = path.join(PREP_NOTES_DIR, user, `${game}.json`);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ notes: null }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(data);
  });
}

function handlePutPrepNotes(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { user, game, title, notes } = JSON.parse(body);
      const safeUser = safeSegment(user, 50);
      const safeGame = (game || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150);

      if (!safeUser || !safeGame || !notes) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing fields" }));
        return;
      }

      const userDir = path.join(PREP_NOTES_DIR, safeUser);
      fs.mkdirSync(userDir, { recursive: true });

      const record = { user: safeUser, game: safeGame, savedAt: new Date().toISOString(), notes };
      if (title && safeUser === "_shared") record.title = String(title).slice(0, 300);
      const data = JSON.stringify(record, null, 2);
      fs.writeFile(path.join(userDir, `${safeGame}.json`), data, (err) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Write failed" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
  });
}

// ═══════════════════════════════════════════════
//  OCR — Google Cloud Vision
// ═══════════════════════════════════════════════
function handleOcr(req, res) {
  const https = require("https");
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "GOOGLE_VISION_API_KEY is not set on the server." }));
    return;
  }

  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > 10 * 1024 * 1024) { res.writeHead(413); res.end(JSON.stringify({ error: "Image too large (max 10 MB)" })); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    try {
      const { imageBase64, mime } = JSON.parse(Buffer.concat(chunks).toString());
      if (!imageBase64) throw new Error("Missing imageBase64");

      const payload = JSON.stringify({
        requests: [{
          image: { content: imageBase64 },
          features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
          imageContext: { languageHints: ["en"] },
        }],
      });

      const options = {
        hostname: "vision.googleapis.com",
        path: `/v1/images:annotate?key=${apiKey}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      };

      const vReq = https.request(options, (vRes) => {
        let data = "";
        vRes.on("data", (c) => (data += c));
        vRes.on("end", () => {
          try {
            const result = JSON.parse(data);
            if (result.error) throw new Error(result.error.message);
            const r = result.responses?.[0];
            if (!r) throw new Error("Empty response from Vision API");
            if (r.error) throw new Error(r.error.message);

            const text = (r.fullTextAnnotation?.text || "").trim();

            // Average word-level confidence across all words on the first page
            let confidence = null;
            const words = [];
            r.fullTextAnnotation?.pages?.[0]?.blocks?.forEach((b) =>
              b.paragraphs?.forEach((p) =>
                p.words?.forEach((w) => { if (w.confidence != null) words.push(w.confidence); })
              )
            );
            if (words.length) confidence = Math.round(words.reduce((a, b) => a + b, 0) / words.length * 100);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ text, confidence }));
          } catch (e) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      });

      vReq.on("error", (e) => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Vision API unreachable: " + e.message }));
      });
      vReq.write(payload);
      vReq.end();
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ═══════════════════════════════════════════════
//  PREP SOURCES
// ═══════════════════════════════════════════════
function safeGame(raw) {
  return (raw || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150);
}

function sourcesManifestPath(game, user) {
  const dir = path.join(PREP_SOURCES_DIR, safeGame(game));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${safeSegment(user, 50) || "_shared"}.json`);
}

function readManifest(game, user) {
  try { return JSON.parse(fs.readFileSync(sourcesManifestPath(game, user), "utf8")); }
  catch { return []; }
}

function writeManifest(game, user, list) {
  fs.writeFileSync(sourcesManifestPath(game, user), JSON.stringify(list, null, 2));
}

function handleListSources(req, res) {
  const p = new URL(req.url, `http://localhost:${PORT}`).searchParams;
  const game = p.get("game") || "";
  const season = (p.get("season") || "").replace(/[^0-9]/g, "").slice(0, 4);
  if (!game) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing game" })); return; }

  const gameDir = path.join(PREP_SOURCES_DIR, safeGame(game));
  let all = [];
  try {
    const files = fs.readdirSync(gameDir).filter(f => f.endsWith(".json"));
    for (const f of files) {
      try {
        const ownerUser = f.replace(/\.json$/, "");
        const entries = JSON.parse(fs.readFileSync(path.join(gameDir, f), "utf8"));
        entries.forEach(e => { if (!e.owner) e.owner = ownerUser === "_shared" ? "" : ownerUser; });
        all = all.concat(entries);
      } catch {}
    }
  } catch {}

  if (season) {
    const seasonDir = path.join(PREP_SOURCES_DIR, safeGame(`_season_${season}`));
    try {
      const files = fs.readdirSync(seasonDir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        try {
          const entries = JSON.parse(fs.readFileSync(path.join(seasonDir, f), "utf8"));
          entries.forEach(e => { e.seasonLong = true; if (!e.owner) e.owner = ""; });
          all = all.concat(entries);
        } catch {}
      }
    } catch {}
    // Season entries take priority: deduplicate so season version wins
    const seasonIds = new Set(all.filter(e => e.seasonLong).map(e => e.id));
    all = all.filter(e => e.seasonLong || !seasonIds.has(e.id));
  }

  all.sort((a, b) => (a.addedAt || "").localeCompare(b.addedAt || ""));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(all));
}

// Streams the upload straight to disk (rather than buffering in memory) so
// multi-hundred-MB video files don't have to fit in a single Buffer.
function handleUploadSource(req, res) {
  let metaBuffer = Buffer.alloc(0);
  let meta = null;
  let writeStream = null;
  let filePath = null;
  let size = 0;
  let done = false;

  function fail(code, message) {
    if (done) return;
    done = true;
    req.destroy();
    if (writeStream) writeStream.destroy();
    if (filePath) fs.unlink(filePath, () => {});
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }

  req.on("data", (chunk) => {
    if (done) return;
    size += chunk.length;
    if (size > MAX_SOURCE_BODY) { fail(413, `File too large (max ${Math.floor(MAX_SOURCE_BODY / (1024 * 1024))} MB)`); return; }

    if (!meta) {
      metaBuffer = Buffer.concat([metaBuffer, chunk]);
      const nl = metaBuffer.indexOf(10);
      if (nl === -1) {
        if (metaBuffer.length > 8192) fail(400, "Bad format");
        return;
      }
      try {
        meta = JSON.parse(metaBuffer.slice(0, nl).toString());
        if (!meta.game || !meta.name) throw new Error("Missing game or name");
      } catch (e) {
        fail(400, e.message || "Bad format");
        return;
      }

      const id = crypto.randomBytes(8).toString("hex");
      const ext = (meta.name.match(/\.[a-zA-Z0-9]{1,6}$/) || [""])[0];
      const filename = id + ext;
      const gameDir = path.join(PREP_SOURCES_DIR, safeGame(meta.game));
      fs.mkdirSync(gameDir, { recursive: true });
      filePath = path.join(gameDir, filename);
      meta.id = id;
      meta.filename = filename;
      writeStream = fs.createWriteStream(filePath);

      const rest = metaBuffer.slice(nl + 1);
      metaBuffer = null;
      if (rest.length && !writeStream.write(rest)) {
        req.pause();
        writeStream.once("drain", () => req.resume());
      }
      return;
    }

    if (!writeStream.write(chunk)) {
      req.pause();
      writeStream.once("drain", () => req.resume());
    }
  });

  req.on("end", () => {
    if (done || !meta || !writeStream) { if (!done) fail(400, "Bad format"); return; }
    writeStream.end(() => {
      if (done) return;
      const entry = {
        id: meta.id, owner: meta.user || "", type: "file", name: meta.name,
        filename: meta.filename, mime: meta.mime || "application/octet-stream",
        addedAt: new Date().toISOString(),
      };
      const list = readManifest(meta.game, meta.user);
      list.push(entry);
      writeManifest(meta.game, meta.user, list);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(entry));
    });
  });

  req.on("error", () => fail(500, "Upload failed"));
}

function handleAddUrlSource(req, res) {
  const https = require("https");
  const http2 = require("http");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { user, game, url } = JSON.parse(body);
      if (!game || !url) throw new Error("Missing game or url");
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error("Invalid URL"); }
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http/https allowed");

      const fetch = parsed.protocol === "https:" ? https : http2;
      const req2 = fetch.get(url, { headers: { "User-Agent": "PodcastStudio/1.0" }, timeout: 8000 }, (resp) => {
        const xfo = resp.headers['x-frame-options'] || '';
        const csp = resp.headers['content-security-policy'] || '';
        let embeddable = true;
        if (/DENY|SAMEORIGIN/i.test(xfo)) embeddable = false;
        if (embeddable && csp) {
          const fa = csp.match(/frame-ancestors\s+([^;]+)/i);
          if (fa && !/\*/.test(fa[1])) embeddable = false;
        }
        let html = "";
        resp.setEncoding("utf8");
        resp.on("data", (c) => { if (html.length < 50000) html += c; });
        resp.on("end", () => {
          const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim()
            || (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1]?.trim()
            || parsed.hostname;
          const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || [])[1]?.trim()
            || (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) || [])[1]?.trim()
            || "";

          const id = crypto.randomBytes(8).toString("hex");
          const entry = { id, owner: user || "", type: "url", name: title, url, domain: parsed.hostname, desc: desc.slice(0, 200), addedAt: new Date().toISOString(), embeddable };
          const list = readManifest(game, user);
          list.push(entry);
          writeManifest(game, user, list);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(entry));
        });
      });
      req2.on("error", (e) => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Could not fetch URL: " + e.message }));
      });
      req2.on("timeout", () => { req2.destroy(); });
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function handleServeSourceFile(req, res) {
  // GET /api/prep-sources/file/{game}/{filename}
  const parts = req.url.replace(/\?.*$/, "").split("/");
  // parts: ["", "api", "prep-sources", "file", game, filename]
  if (parts.length < 6) { res.writeHead(400); res.end("Bad path"); return; }
  const game = safeGame(decodeURIComponent(parts[4]));
  const filename = path.basename(decodeURIComponent(parts[5]));
  const filePath = path.join(PREP_SOURCES_DIR, game, filename);
  if (!filePath.startsWith(PREP_SOURCES_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }

  fs.stat(filePath, (err, stat) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filename).toLowerCase();
    const mimes = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
      ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
      ".txt": "text/plain",
      ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
      ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4" };
    const contentType = mimes[ext] || "application/octet-stream";

    // Video/audio scrubbing needs Range support for efficient seeking.
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        let start = match[1] ? parseInt(match[1], 10) : 0;
        let end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
        if (start >= stat.size || end >= stat.size || start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          "Content-Type": contentType,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }

    res.writeHead(200, { "Content-Type": contentType, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(filePath).pipe(res);
  });
}

function handleDeleteSource(req, res) {
  // DELETE /api/prep-sources/{game}/{id}?user=&role=
  const parts = req.url.replace(/\?.*$/, "").split("/");
  if (parts.length < 5) { res.writeHead(400); res.end("Bad path"); return; }
  const game = decodeURIComponent(parts[3]);
  const id = safeSegment(decodeURIComponent(parts[4]), 50);
  const qs = new URL(req.url, `http://localhost:${PORT}`).searchParams;
  const requester = qs.get("user") || "";
  const role = qs.get("role") || "";

  // Scan all manifests to find the entry
  const gameDir = path.join(PREP_SOURCES_DIR, safeGame(game));
  let foundEntry = null, foundOwnerUser = null;
  try {
    const files = fs.readdirSync(gameDir).filter(f => f.endsWith(".json"));
    for (const f of files) {
      try {
        const ownerUser = f.replace(/\.json$/, "");
        const entries = JSON.parse(fs.readFileSync(path.join(gameDir, f), "utf8"));
        const entry = entries.find(e => e.id === id);
        if (entry) { foundEntry = entry; foundOwnerUser = ownerUser; break; }
      } catch {}
    }
  } catch {}

  if (!foundEntry) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  // Determine owner: stored on entry, or derived from manifest filename
  const owner = foundEntry.owner !== undefined ? foundEntry.owner
    : (foundOwnerUser === "_shared" ? "" : foundOwnerUser);

  if (role !== "host" && requester !== owner) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Only the owner or a host can remove this source" }));
    return;
  }

  if (foundEntry.filename) {
    const fp = path.join(PREP_SOURCES_DIR, safeGame(game), foundEntry.filename);
    try { fs.unlinkSync(fp); } catch {}
  }
  const ownerList = readManifest(game, foundOwnerUser);
  writeManifest(game, foundOwnerUser, ownerList.filter(e => e.id !== id));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

function handleRenameSource(req, res) {
  // PATCH /api/prep-sources/{game}/{id}  body: { name, user, role }
  const parts = req.url.replace(/\?.*$/, "").split("/");
  if (parts.length < 5) { res.writeHead(400); res.end(JSON.stringify({ error: "Bad path" })); return; }
  const game = decodeURIComponent(parts[3]);
  const id   = safeSegment(decodeURIComponent(parts[4]), 50);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { name, user, role } = JSON.parse(body);
      if (!name || !name.trim()) throw new Error("Name is required");
      const gameDir = path.join(PREP_SOURCES_DIR, safeGame(game));
      const files = fs.readdirSync(gameDir).filter(f => f.endsWith(".json"));
      let found = false;
      for (const f of files) {
        try {
          const ownerUser = f.replace(/\.json$/, "");
          const entries = JSON.parse(fs.readFileSync(path.join(gameDir, f), "utf8"));
          const idx = entries.findIndex(e => e.id === id);
          if (idx === -1) continue;
          const entry = entries[idx];
          const owner = entry.owner !== undefined ? entry.owner : (ownerUser === "_shared" ? "" : ownerUser);
          if (role !== "host" && user !== owner) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Only the owner or a host can rename this source" }));
            return;
          }
          entries[idx] = { ...entry, name: name.trim() };
          fs.writeFileSync(path.join(gameDir, f), JSON.stringify(entries, null, 2));
          found = true;
          break;
        } catch {}
      }
      if (!found) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Not found" })); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function handleTagSeasonSource(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { id, game, season, user, role } = JSON.parse(body);
      if (role !== "host") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Host only" }));
        return;
      }
      const safeY = (season || "").replace(/[^0-9]/g, "").slice(0, 4);
      if (safeY.length !== 4) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid season" }));
        return;
      }

      const gameDir = path.join(PREP_SOURCES_DIR, safeGame(game));
      let foundEntry = null;
      try {
        const files = fs.readdirSync(gameDir).filter(f => f.endsWith(".json"));
        for (const f of files) {
          const entries = JSON.parse(fs.readFileSync(path.join(gameDir, f), "utf8"));
          const entry = entries.find(e => e.id === id);
          if (entry) { foundEntry = entry; break; }
        }
      } catch {}

      if (!foundEntry) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      const seasonSlug = `_season_${safeY}`;
      const seasonList = readManifest(seasonSlug, "_shared");
      const existingIdx = seasonList.findIndex(e => e.id === id);
      let nowSeason;
      if (existingIdx >= 0) {
        seasonList.splice(existingIdx, 1);
        nowSeason = false;
      } else {
        seasonList.push({ ...foundEntry, seasonLong: true });
        nowSeason = true;
      }
      writeManifest(seasonSlug, "_shared", seasonList);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, seasonLong: nowSeason }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ═══════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════
function sanitize(name) {
  return String(name || "").replace(/[^a-zA-Z0-9\-_]/g, "").slice(0, 100);
}

// ═══════════════════════════════════════════════
//  GITHUB WEBHOOK
// ═══════════════════════════════════════════════
function handleWebhook(req, res) {
  const sig = req.headers["x-hub-signature-256"] || "";

  if (!WEBHOOK_SECRET) {
    console.warn("[webhook] WEBHOOK_SECRET not set — rejecting request");
    res.writeHead(500);
    res.end("Webhook secret not configured");
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);

    // Verify HMAC-SHA256 signature
    const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    const valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

    if (!valid) {
      console.warn("[webhook] Invalid signature — rejecting");
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }

    // Only handle push events
    if (req.headers["x-github-event"] !== "push") {
      res.writeHead(200);
      res.end("ok");
      return;
    }

    let payload;
    try { payload = JSON.parse(body.toString()); } catch { payload = {}; }

    // Only deploy pushes to the main branch
    const branch = (payload.ref || "").replace("refs/heads/", "");
    if (branch !== "main") {
      res.writeHead(200);
      res.end("ok");
      return;
    }

    const pusher = payload.pusher?.name || "unknown";
    console.log(`[webhook] Push to ${branch} by ${pusher} — pulling…`);

    res.writeHead(200);
    res.end("Deploying");

    // Pull latest code then let PM2 restart the process
    execFile("git", ["-C", __dirname, "pull", "--ff-only"], (err, stdout, stderr) => {
      if (err) {
        console.error("[webhook] git pull failed:", stderr.trim() || err.message);
        return;
      }
      console.log("[webhook] git pull:", stdout.trim());
      console.log("[webhook] Exiting for PM2 restart…");
      process.exit(0);
    });
  });
}

// ═══════════════════════════════════════════════
//  WEBSOCKET SIGNALING SERVER
// ═══════════════════════════════════════════════
const wss = new WebSocketServer({ server });
const rooms = new Map();

wss.on("connection", (ws) => {
  let currentRoom = null;
  let currentUser = null;

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case "join": {
        const { room, username, role } = msg;
        currentRoom = room;
        currentUser = { username, ws, id: crypto.randomUUID(), role: role || "guest" };

        if (!rooms.has(room)) rooms.set(room, []);
        const participants = rooms.get(room);

        const existingUsers = participants.map((p) => ({
          id: p.id,
          username: p.username,
          role: p.role,
        }));

        ws.send(JSON.stringify({
          type: "room-info",
          yourId: currentUser.id,
          participants: existingUsers,
        }));

        for (const p of participants) {
          p.ws.send(JSON.stringify({
            type: "peer-joined",
            id: currentUser.id,
            username: currentUser.username,
            role: currentUser.role,
          }));
        }

        participants.push(currentUser);
        console.log(`${username} (${currentUser.role}) joined room "${room}" (${participants.length} participants)`);
        break;
      }

      case "signal": {
        const { targetId, signal } = msg;
        if (!currentRoom || !currentUser) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        const target = room.find((p) => p.id === targetId);
        if (target) {
          target.ws.send(JSON.stringify({ type: "signal", fromId: currentUser.id, signal }));
        }
        break;
      }

      case "chat": {
        if (!currentRoom || !currentUser) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        for (const p of room) {
          p.ws.send(JSON.stringify({
            type: "chat",
            fromId: currentUser.id,
            username: currentUser.username,
            text: msg.text,
          }));
        }
        break;
      }

      case "recording-control": {
        if (!currentRoom || !currentUser) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        for (const p of room) {
          p.ws.send(JSON.stringify({
            type: "recording-control",
            action: msg.action,
            fromId: currentUser.id,
            username: currentUser.username,
            sessionId: msg.sessionId,
          }));
        }
        break;
      }

      case "game-load": {
        if (!currentRoom || !currentUser) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        for (const p of room) {
          if (p.id === currentUser.id) continue;
          p.ws.send(JSON.stringify({
            type: "game-load",
            season: msg.season,
            week: msg.week,
            gameId: msg.gameId,
            username: currentUser.username,
          }));
        }
        break;
      }

      case "remote-mute": {
        // Host can mute/unmute other participants
        if (!currentRoom || !currentUser) return;
        if (currentUser.role !== "host") return; // only host can do this
        const room = rooms.get(currentRoom);
        if (!room) return;
        const target = room.find((p) => p.id === msg.targetId);
        if (target) {
          target.ws.send(JSON.stringify({
            type: "remote-mute",
            muted: msg.muted,
            fromUsername: currentUser.username,
          }));
        }
        break;
      }

      case "remove-peer": {
        if (!currentRoom || !currentUser) return;
        if (currentUser.role !== "host") return; // only host can do this
        const room = rooms.get(currentRoom);
        if (!room) return;
        const targetIdx = room.findIndex((p) => p.id === msg.targetId);
        if (targetIdx !== -1) {
          const target = room[targetIdx];
          room.splice(targetIdx, 1);
          target.ws.send(JSON.stringify({ type: "you-were-removed" }));
          for (const p of room) {
            p.ws.send(JSON.stringify({ type: "peer-left", id: target.id, username: target.username }));
          }
          if (room.length === 0) rooms.delete(currentRoom);
          target.ws.terminate();
        }
        break;
      }

      case "host-left": {
        if (!currentRoom || !currentUser) return;
        if (currentUser.role !== "host") return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        for (const p of room) {
          if (p.id !== currentUser.id) {
            p.ws.send(JSON.stringify({ type: "session-ended" }));
          }
        }
        break;
      }

      case "clip-share-request": {
        if (!currentRoom || !currentUser) return;
        if (currentUser.role === "host") return; // hosts don't share with themselves
        const room = rooms.get(currentRoom);
        if (!room) return;
        for (const p of room) {
          if (p.role === "host") {
            p.ws.send(JSON.stringify({
              type: "clip-share-request",
              clipName: msg.clipName,
              fromUsername: currentUser.username,
              fromId: currentUser.id,
              audioData: msg.audioData,
              mimeType: msg.mimeType,
            }));
          }
        }
        break;
      }

      case "prep-join": {
        const { room, username } = msg;
        if (!room || !username) return;

        // Leave previous prep room cleanly
        if (currentRoom && currentUser) {
          const old = rooms.get(currentRoom);
          if (old) {
            const i = old.findIndex((p) => p.id === currentUser.id);
            if (i !== -1) old.splice(i, 1);
            for (const p of old) {
              p.ws.send(JSON.stringify({ type: "peer-left", id: currentUser.id, username: currentUser.username }));
            }
            if (!old.length) rooms.delete(currentRoom);
          }
        }

        currentRoom = room;
        if (!currentUser) currentUser = { id: crypto.randomUUID(), role: "member", ws };
        currentUser.username = username;

        if (!rooms.has(room)) rooms.set(room, []);
        const prepParticipants = rooms.get(room);
        prepParticipants.push(currentUser);

        ws.send(JSON.stringify({ type: "prep-room-info", yourId: currentUser.id, count: prepParticipants.length }));
        for (const p of prepParticipants) {
          if (p !== currentUser) {
            p.ws.send(JSON.stringify({ type: "peer-joined", id: currentUser.id, username: currentUser.username }));
          }
        }
        console.log(`[prep] ${username} joined "${room}" (${prepParticipants.length} in room)`);
        break;
      }

      case "prep-notes-update": {
        if (!currentRoom || !currentUser) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        const { field, content } = msg;
        if (!SHARED_FIELDS.includes(field)) return;
        for (const p of room) {
          if (p.ws !== ws) {
            p.ws.send(JSON.stringify({
              type: "prep-notes-update",
              fromId: currentUser.id,
              username: currentUser.username,
              field,
              content,
            }));
          }
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const idx = room.findIndex((p) => p.id === currentUser.id);
    if (idx === -1) return; // Already removed (e.g., by force-remove)
    room.splice(idx, 1);

    for (const p of room) {
      p.ws.send(JSON.stringify({
        type: "peer-left",
        id: currentUser.id,
        username: currentUser.username,
      }));
    }

    if (room.length === 0) rooms.delete(currentRoom);
    console.log(`${currentUser.username} left room "${currentRoom}"`);
  });
});

// ═══════════════════════════════════════════════
//  SCREENSHOTS (per-game)
// ═══════════════════════════════════════════════
function screenshotsDir(game) {
  const dir = path.join(SCREENSHOTS_DIR, (game || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function handleSaveScreenshot(req, res) {
  const chunks = [];
  let size = 0;
  req.on("data", chunk => {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) { res.writeHead(413); res.end(JSON.stringify({ error: "Too large" })); req.destroy(); return; }
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
  const game = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("game") || "";
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
  if (!filePath.startsWith(SCREENSHOTS_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
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
  if (!filePath.startsWith(SCREENSHOTS_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  try { fs.unlinkSync(filePath); } catch {}
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

server.listen(PORT, () => {
  console.log(`Podcast Studio server running on http://localhost:${PORT}`);
  console.log(`Recordings saved to: ${RECORDINGS_DIR}`);
});
