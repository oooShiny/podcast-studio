const fs = require("fs");
const path = require("path");
const { sanitize } = require("./util");

const MAX_BODY = 5 * 1024 * 1024;

let ctx;
function init(c) {
  ctx = c;
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
      const participantDir = path.join(ctx.dirs.RECORDINGS_DIR, safeSession, safeParticipant);

      if (!fs.existsSync(participantDir)) {
        throw new Error("No chunks found");
      }

      const chunkFiles = fs.readdirSync(participantDir)
        .filter((f) => f.startsWith("chunk-") && f.endsWith(".webm"))
        .sort();

      if (chunkFiles.length === 0) throw new Error("No chunk files");

      const outputFile = `${safeParticipant}.webm`;
      const outputPath = path.join(ctx.dirs.RECORDINGS_DIR, safeSession, outputFile);

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
        const metaPath = path.join(ctx.dirs.RECORDINGS_DIR, safeSession, "session.json");
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
  const filename = decodeURIComponent(parts.slice(4).join("/"));
  const safeFilename = sanitize(filename.replace(/\.webm$/, "")) + ".webm";
  const recordingPath = path.join(ctx.dirs.RECORDINGS_DIR, sessionId, safeFilename);

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
  const sessionDir = path.join(ctx.dirs.RECORDINGS_DIR, sessionId);

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
  const parts = req.url.split("/");
  const sessionId = sanitize(parts[3]);
  const filename = decodeURIComponent(parts.slice(4).join("/"));
  const safeFilename = sanitize(filename.replace(/\.webm$/, "")) + ".webm";
  const filePath = path.join(ctx.dirs.RECORDINGS_DIR, sessionId, safeFilename);

  if (!fs.existsSync(filePath)) {
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
    { method: "POST", match: (url) => url === "/api/upload-chunk", handler: handleChunkUpload },
    { method: "POST", match: (url) => url === "/api/finalize", handler: handleFinalize },
    { method: "GET", match: (url) => url === "/api/recordings", handler: handleListAllRecordings },
    { method: "GET", match: (url) => url.startsWith("/api/sessions/"), handler: handleListSession },
    { method: "GET", match: (url) => url.startsWith("/api/download/"), handler: handleDownload },
    { method: "DELETE", match: (url) => url.startsWith("/api/sessions/"), handler: handleDeleteSession },
    { method: "DELETE", match: (url) => url.startsWith("/api/download/"), handler: handleDeleteFile },
  ],
  init,
};
