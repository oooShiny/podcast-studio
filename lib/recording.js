const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { sanitize } = require("./util");
const { requireAuth, requireHost, requireAuthOrCookie } = require("./auth");

// Demo and free deployments never persist recordings server-side — each
// participant keeps their own copy in the browser.
const LOCAL_ONLY_RECORDING = !!(process.env.DEMO_MODE || process.env.FREE_MODE);

const MAX_BODY = 5 * 1024 * 1024;

// One chunk is uploaded per second of audio, so six digits (~11 days) keeps
// the zero-padded names in order for any realistic take.
const CHUNK_PAD = 6;
const MAX_CHUNK_INDEX = 10 ** CHUNK_PAD - 1;

function chunkIndexOf(file) {
  const m = /^chunk-(\d+)\.webm$/.exec(file);
  return m ? Number(m[1]) : -1;
}

// Finished files a client may download or delete: participant/mix tracks
// (.webm) and editor exports (EDIT-*.mp3). path.basename plus the allow-list
// keeps the name inside the session directory. Returns null if not allowed.
function safeRecordingFilename(raw) {
  let name;
  try { name = path.basename(decodeURIComponent(raw)); } catch { return null; }
  if (!/^[a-zA-Z0-9_\-.]{1,150}$/.test(name) || name.includes("..")) return null;
  if (name.endsWith(".webm")) return name;
  if (name.endsWith(".mp3") && name.startsWith("EDIT-")) return name;
  return null;
}

let ctx;
function init(c) {
  ctx = c;
  if (!LOCAL_ONLY_RECORDING) {
    setTimeout(sweepStaleChunks, 30 * 1000).unref();
    setInterval(sweepStaleChunks, 5 * 60 * 1000).unref();
  }
}

// ═══════════════════════════════════════════════
//  CHUNK UPLOAD HANDLER
// ═══════════════════════════════════════════════
function handleChunkUpload(req, res) {
  // Demo deployments never persist recordings server-side — drain the body
  // without buffering or writing so the client's success path still fires.
  if (LOCAL_ONLY_RECORDING) {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

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
      // chunkIndex becomes part of a filename — anything but a plain integer
      // (e.g. "../../x") would let the write land outside the session folder.
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > MAX_CHUNK_INDEX) {
        throw new Error("Invalid chunkIndex");
      }

      const safeSession = sanitize(sessionId);
      if (!safeSession) throw new Error("Invalid sessionId");
      const trackLabel = trackType === "mix" ? "MIX" : sanitize(username);
      const safeParticipant = `${trackLabel}-${sanitize(participantId).slice(0, 8)}`;

      const participantDir = path.join(ctx.dirs.RECORDINGS_DIR, safeSession, safeParticipant);
      fs.mkdirSync(participantDir, { recursive: true });

      // Write session metadata if it doesn't exist
      const metaPath = path.join(ctx.dirs.RECORDINGS_DIR, safeSession, "session.json");
      if (!fs.existsSync(metaPath)) {
        fs.writeFileSync(metaPath, JSON.stringify({
          sessionId: safeSession,
          startedAt: new Date().toISOString(),
          participants: [],
        }));
      }

      const chunkFile = `chunk-${String(chunkIndex).padStart(CHUNK_PAD, "0")}.webm`;
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
//  ASSEMBLE A TRACK FROM ITS CHUNKS
// ═══════════════════════════════════════════════
// Concatenates <session>/<participant>/chunk-*.webm into
// <session>/<participant>.webm and removes the chunks. Used by /api/finalize
// and by the sweep that rescues takes whose browser never finalized.
// cb(err) or cb(null, { filename, size, chunks }); err.notFound marks "nothing to do".
const assembling = new Set();

function assembleTrack(safeSession, safeParticipant, cb) {
  const sessionDir = path.join(ctx.dirs.RECORDINGS_DIR, safeSession);
  const participantDir = path.join(sessionDir, safeParticipant);
  const key = `${safeSession}/${safeParticipant}`;
  const notFound = (message) => Object.assign(new Error(message), { notFound: true });

  if (assembling.has(key)) return cb(notFound("Already finalizing"));
  if (!fs.existsSync(participantDir)) return cb(notFound("No chunks found"));

  // Order by the numeric index, not the name: a plain string sort puts
  // chunk-10000 before chunk-2000 once the padding width is exceeded.
  let chunkFiles;
  try {
    chunkFiles = fs.readdirSync(participantDir)
      .filter((f) => chunkIndexOf(f) >= 0)
      .sort((a, b) => chunkIndexOf(a) - chunkIndexOf(b));
  } catch (e) { return cb(e); }
  if (chunkFiles.length === 0) return cb(notFound("No chunk files"));

  const outputFile = `${safeParticipant}.webm`;
  const outputPath = path.join(sessionDir, outputFile);
  // Chunks that arrive after an earlier finalize (a late retry, or a take
  // resumed after a reconnect) are appended to the existing file.
  const appending = fs.existsSync(outputPath);

  assembling.add(key);
  let finished = false;
  const done = (err, result) => {
    if (finished) return;
    finished = true;
    assembling.delete(key);
    cb(err, result);
  };

  // Append one chunk at a time, waiting for each to flush, so a long recording
  // never has to fit in memory (a tenant machine may only have 256 MB).
  const writeStream = fs.createWriteStream(outputPath, { flags: appending ? "a" : "w" });
  writeStream.on("error", done);
  let next = 0;
  const appendNext = () => {
    if (finished) return;
    if (next >= chunkFiles.length) { writeStream.end(); return; }
    const rs = fs.createReadStream(path.join(participantDir, chunkFiles[next++]));
    rs.on("error", (err) => { writeStream.destroy(); done(err); });
    rs.on("end", appendNext);
    rs.pipe(writeStream, { end: false });
  };
  appendNext();

  writeStream.on("finish", () => {
    for (const cf of chunkFiles) {
      try { fs.unlinkSync(path.join(participantDir, cf)); } catch {}
    }
    try { fs.rmdirSync(participantDir); } catch {}

    const metaPath = path.join(sessionDir, "session.json");
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (!meta.participants) meta.participants = [];
        if (!meta.participants.some((p) => p.filename === outputFile)) {
          meta.participants.push({ username: safeParticipant.replace(/-[^-]*$/, ""), filename: outputFile });
        }
        meta.finishedAt = new Date().toISOString();
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      } catch {}
    }

    let size = 0;
    try { size = fs.statSync(outputPath).size; } catch {}
    console.log(`  ✓ finalized ${outputFile} (${(size / (1024 * 1024)).toFixed(1)} MB, ${chunkFiles.length} chunks)`);
    done(null, { filename: outputFile, size, chunks: chunkFiles.length });
  });
}

// A browser that crashes or loses its connection mid-take never calls
// /api/finalize, leaving the audio stranded as loose chunks. Anything that
// has received no new chunk for STALE_CHUNK_MS is assembled automatically.
const STALE_CHUNK_MS = 10 * 60 * 1000;

function sweepStaleChunks() {
  let sessions;
  try { sessions = fs.readdirSync(ctx.dirs.RECORDINGS_DIR, { withFileTypes: true }); } catch { return; }
  const now = Date.now();
  for (const session of sessions) {
    if (!session.isDirectory()) continue;
    let entries;
    try { entries = fs.readdirSync(path.join(ctx.dirs.RECORDINGS_DIR, session.name), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(ctx.dirs.RECORDINGS_DIR, session.name, entry.name);
      let newest = 0;
      let count = 0;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (chunkIndexOf(f) < 0) continue;
          count += 1;
          newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs);
        }
      } catch { continue; }
      if (!count || now - newest < STALE_CHUNK_MS) continue;
      console.log(`  ⟳ assembling unfinalized track ${session.name}/${entry.name} (${count} chunks)`);
      assembleTrack(session.name, entry.name, (err) => {
        if (err && !err.notFound) console.error("Stale chunk sweep error:", err.message);
      });
    }
  }
}

// ═══════════════════════════════════════════════
//  FINALIZE
// ═══════════════════════════════════════════════
function handleFinalize(req, res) {
  if (LOCAL_ONLY_RECORDING) {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { sessionId, participantId, username, trackType } = JSON.parse(body);

      const safeSession = sanitize(sessionId);
      if (!safeSession || !participantId) throw new Error("Missing fields");
      const trackLabel = trackType === "mix" ? "MIX" : sanitize(username);
      const safeParticipant = `${trackLabel}-${sanitize(participantId).slice(0, 8)}`;

      assembleTrack(safeSession, safeParticipant, (err, result) => {
        if (err) {
          console.error("Finalize error:", err.message);
          res.writeHead(err.notFound ? 400 : 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.notFound ? err.message : "Could not assemble recording" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...result }));
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
  if (!fs.existsSync(ctx.dirs.RECORDINGS_DIR)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: [] }));
    return;
  }

  const sessions = [];
  const dirs = fs.readdirSync(ctx.dirs.RECORDINGS_DIR).filter((d) =>
    fs.statSync(path.join(ctx.dirs.RECORDINGS_DIR, d)).isDirectory()
  );

  for (const dir of dirs) {
    const sessionDir = path.join(ctx.dirs.RECORDINGS_DIR, dir);

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
  const sessionDir = path.join(ctx.dirs.RECORDINGS_DIR, sessionId);

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
  const safeFilename = safeRecordingFilename(parts.slice(4).join("/").split("?")[0]);
  const recordingPath = safeFilename && path.join(ctx.dirs.RECORDINGS_DIR, sessionId, safeFilename);

  if (!sessionId || !recordingPath || !fs.existsSync(recordingPath)) {
    res.writeHead(404);
    res.end("File not found");
    return;
  }

  const stats = fs.statSync(recordingPath);
  res.writeHead(200, {
    "Content-Type": safeFilename.endsWith(".mp3") ? "audio/mpeg" : "audio/webm",
    "Content-Disposition": `attachment; filename="${safeFilename}"`,
    "Content-Length": stats.size,
  });
  fs.createReadStream(recordingPath).pipe(res);
}

// ═══════════════════════════════════════════════
//  ADD MARKER
// ═══════════════════════════════════════════════
function handleAddMarker(req, res) {
  if (LOCAL_ONLY_RECORDING) {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const parts = req.url.split("?")[0].split("/");
      const sessionId = sanitize(parts[3]);
      const sessionDir = path.join(ctx.dirs.RECORDINGS_DIR, sessionId);

      if (!fs.existsSync(sessionDir)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      const { offsetSec, label } = JSON.parse(body || "{}");
      if (typeof offsetSec !== "number" || !isFinite(offsetSec) || offsetSec < 0) {
        throw new Error("Invalid offsetSec");
      }

      const metaPath = path.join(sessionDir, "session.json");
      let meta = { sessionId };
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch {}
      }
      if (!meta.markers) meta.markers = [];

      const marker = {
        id: crypto.randomUUID(),
        offsetSec,
        label: typeof label === "string" ? label.slice(0, 200) : "",
        createdAt: new Date().toISOString(),
      };
      meta.markers.push(marker);
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, marker }));
    } catch (e) {
      console.error("Add marker error:", e.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ═══════════════════════════════════════════════
//  DELETE SESSION
// ═══════════════════════════════════════════════
function handleDeleteSession(req, res) {
  const parts = req.url.split("/");
  const sessionId = sanitize(parts[3]);
  const sessionDir = path.join(ctx.dirs.RECORDINGS_DIR, sessionId);

  // An empty id would resolve to the recordings root and delete everything.
  if (!sessionId || !fs.existsSync(sessionDir)) {
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
  const parts = req.url.split("/");
  const sessionId = sanitize(parts[3]);
  const safeFilename = safeRecordingFilename(parts.slice(4).join("/").split("?")[0]);
  const filePath = safeFilename && path.join(ctx.dirs.RECORDINGS_DIR, sessionId, safeFilename);

  if (!sessionId || !filePath || !fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "File not found" }));
    return;
  }

  fs.unlinkSync(filePath);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

module.exports = {
  routes: [
    { method: "POST", match: (url) => url === "/api/upload-chunk", handler: requireAuth(handleChunkUpload) },
    { method: "POST", match: (url) => url === "/api/finalize", handler: requireAuth(handleFinalize) },
    { method: "GET", match: (url) => url === "/api/recordings", handler: requireAuth(handleListAllRecordings) },
    { method: "GET", match: (url) => url.startsWith("/api/sessions/"), handler: requireAuth(handleListSession) },
    { method: "POST", match: (url) => /^\/api\/sessions\/[^/]+\/markers$/.test(url.split("?")[0]), handler: requireHost(handleAddMarker) },
    // A plain <a href download> can't send an Authorization header, so this
    // also accepts the session cookie that every authenticated request sets.
    { method: "GET", match: (url) => url.startsWith("/api/download/"), handler: requireAuthOrCookie(handleDownload) },
    // Deleting recordings is host-only, matching the Settings page that offers it.
    { method: "DELETE", match: (url) => url.startsWith("/api/sessions/"), handler: requireHost(handleDeleteSession) },
    { method: "DELETE", match: (url) => url.startsWith("/api/download/"), handler: requireHost(handleDeleteFile) },
  ],
  init,
};
