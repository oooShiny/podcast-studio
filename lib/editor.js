const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { sanitize } = require("./util");
const { requireAuth, requireHost } = require("./auth");

const MAX_INTRO_BODY = 50 * 1024 * 1024; // 50 MB
const PREVIEW_MAX_SEC = 90; // cap processed preview renders so they stay snappy

let ctx;
let ffmpegAvailable = false;

function init(c) {
  ctx = c;
  const check = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
  check.on("error", () => {
    console.warn("[editor] FFmpeg not found — audio editing features disabled. Install ffmpeg to enable.");
  });
  check.on("close", (code) => {
    if (code === 0) {
      ffmpegAvailable = true;
      console.log("[editor] FFmpeg available — audio editing enabled");
    }
  });
}

function parseSessionId(url) {
  const parts = url.split("?")[0].split("/");
  return sanitize(parts[3] || "");
}

// ═══════════════════════════════════════════════
//  GET /api/editor/:sessionId
// ═══════════════════════════════════════════════
function handleGetSession(req, res) {
  const sessionId = parseSessionId(req.url);
  const sessionDir = path.join(ctx.dirs.RECORDINGS_DIR, sessionId);

  if (!sessionId || !fs.existsSync(sessionDir)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Session not found" }));
    return;
  }

  let meta = { sessionId };
  const metaPath = path.join(sessionDir, "session.json");
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch {}
  }

  const allFiles = fs.readdirSync(sessionDir);
  const tracks = allFiles
    .filter((f) => f.endsWith(".webm") && !f.startsWith("EDIT-"))
    .map((f) => {
      const stats = fs.statSync(path.join(sessionDir, f));
      return {
        filename: f,
        size: stats.size,
        downloadUrl: `/api/download/${sessionId}/${encodeURIComponent(f)}`,
        isMix: f.startsWith("MIX-"),
      };
    });
  const exports = allFiles
    .filter((f) => f.startsWith("EDIT-") && (f.endsWith(".mp3") || f.endsWith(".webm")))
    .map((f) => {
      const stats = fs.statSync(path.join(sessionDir, f));
      return {
        filename: f,
        size: stats.size,
        downloadUrl: `/api/download/${sessionId}/${encodeURIComponent(f)}`,
      };
    });

  const introFile = fs.readdirSync(sessionDir).find((f) => f.startsWith("intro-upload."));

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    sessionId,
    startedAt: meta.startedAt || null,
    participants: meta.participants || [],
    tracks,
    exports,
    introFilename: introFile || null,
    ffmpegAvailable,
  }));
}

// ═══════════════════════════════════════════════
//  POST /api/editor/:sessionId/detect-sync
// ═══════════════════════════════════════════════
function handleDetectSync(req, res) {
  req.resume();

  if (!ffmpegAvailable) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "FFmpeg not available — install ffmpeg on the server" }));
    return;
  }

  const sessionId = parseSessionId(req.url);
  const sessionDir = path.join(ctx.dirs.RECORDINGS_DIR, sessionId);

  if (!sessionId || !fs.existsSync(sessionDir)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Session not found" }));
    return;
  }

  const trackFiles = fs.readdirSync(sessionDir)
    .filter((f) => f.endsWith(".webm") && !f.startsWith("MIX-") && !f.startsWith("EDIT-"));

  if (trackFiles.length === 0) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, offsets: {}, refTimeSec: 0 }));
    return;
  }

  const detections = trackFiles.map((filename) => new Promise((resolve) => {
    const filePath = path.join(sessionDir, filename);
    const args = [
      "-t", "15",
      "-i", filePath,
      "-af", "bandpass=f=1000:width_type=h:width=200,silencedetect=noise=-30dB:d=0.05",
      "-f", "null", "-",
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", () => {
      const match = /silence_end: ([\d.]+)/.exec(stderr);
      resolve({ filename, syncTimeSec: match ? parseFloat(match[1]) : 0 });
    });
    proc.on("error", () => resolve({ filename, syncTimeSec: 0 }));
  }));

  Promise.all(detections).then((results) => {
    const refTimeSec = Math.max(...results.map((r) => r.syncTimeSec));
    const offsets = {};
    for (const { filename, syncTimeSec } of results) {
      offsets[filename] = Math.round((refTimeSec - syncTimeSec) * 1000);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, offsets, refTimeSec }));
  });
}

// ═══════════════════════════════════════════════
//  POST /api/editor/:sessionId/upload-intro
// ═══════════════════════════════════════════════
function handleUploadIntro(req, res) {
  if (process.env.DEMO_MODE) {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, filename: "intro-upload.mp3" }));
    });
    return;
  }

  const sessionId = parseSessionId(req.url);
  const sessionDir = path.join(ctx.dirs.RECORDINGS_DIR, sessionId);

  if (!sessionId || !fs.existsSync(sessionDir)) {
    req.resume();
    req.on("end", () => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
    });
    return;
  }

  const contentType = (req.headers["content-type"] || "audio/mpeg").split(";")[0].trim();
  const extMap = {
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3",
    "audio/wav": ".wav", "audio/wave": ".wav", "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/m4a": ".m4a",
    "audio/aac": ".aac",
    "audio/flac": ".flac",
  };
  const ext = extMap[contentType] || ".audio";
  const filename = `intro-upload${ext}`;
  const filePath = path.join(sessionDir, filename);

  // Remove any existing intro with a different extension
  const existing = fs.readdirSync(sessionDir).find((f) => f.startsWith("intro-upload."));
  if (existing && existing !== filename) {
    try { fs.unlinkSync(path.join(sessionDir, existing)); } catch {}
  }

  const chunks = [];
  let size = 0;

  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_INTRO_BODY) {
      if (!res.headersSent) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Intro file too large (50 MB max)" }));
      }
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (res.headersSent) return;
    fs.writeFileSync(filePath, Buffer.concat(chunks));
    console.log(`  ↑ intro uploaded: ${filename} (${(size / 1024).toFixed(1)} KB)`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, filename }));
  });
}

// ═══════════════════════════════════════════════
//  POST /api/editor/:sessionId/export
// ═══════════════════════════════════════════════
function handleExport(req, res) {
  const sessionId = parseSessionId(req.url);
  const sessionDir = path.join(ctx.dirs.RECORDINGS_DIR, sessionId);

  if (!sessionId || !fs.existsSync(sessionDir)) {
    req.resume();
    req.on("end", () => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
    });
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (process.env.DEMO_MODE) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, filename: "EDIT-demo.mp3", downloadUrl: "#" }));
      return;
    }

    if (!ffmpegAvailable) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "FFmpeg not available — install ffmpeg on the server" }));
      return;
    }

    let params;
    try { params = JSON.parse(body); } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    const { tracks, trim, silenceRemoval, autoLevel, introFilename, outputFilename } = params;
    const includedTracks = (tracks || []).filter((t) => t.include !== false);

    if (includedTracks.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No tracks included" }));
      return;
    }

    for (const t of includedTracks) {
      const safeFile = sanitize(t.filename.replace(/\.webm$/, "")) + ".webm";
      if (!fs.existsSync(path.join(sessionDir, safeFile))) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Track not found: ${t.filename}` }));
        return;
      }
    }

    const introFile = introFilename
      ? fs.readdirSync(sessionDir).find((f) => f.startsWith("intro-upload."))
      : null;

    if (introFilename && !introFile) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Intro file not found — upload it first" }));
      return;
    }

    const timestamp = new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-");
    let exportFilename;
    if (outputFilename) {
      const safeName = String(outputFilename)
        .replace(/[^a-zA-Z0-9_\-. ]/g, "")
        .replace(/\s+/g, "-")
        .trim()
        .slice(0, 100);
      exportFilename = safeName ? `EDIT-${safeName}.mp3` : `EDIT-${timestamp}.mp3`;
    } else {
      exportFilename = `EDIT-${timestamp}.mp3`;
    }
    const outputPath = path.join(sessionDir, exportFilename);

    const args = buildFfmpegArgs(sessionDir, includedTracks, trim, silenceRemoval, autoLevel, introFile, outputPath);
    console.log(`[editor] exporting ${exportFilename} (${includedTracks.length} tracks)`);

    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to spawn FFmpeg", detail: err.message }));
      }
    });

    proc.on("close", (code) => {
      if (res.headersSent) return;
      if (code === 0) {
        const stats = fs.statSync(outputPath);
        console.log(`  ✓ exported ${exportFilename} (${(stats.size / (1024 * 1024)).toFixed(1)} MB)`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          filename: exportFilename,
          downloadUrl: `/api/download/${sessionId}/${encodeURIComponent(exportFilename)}`,
        }));
      } else {
        const detail = stderr.split("\n").slice(-10).join("\n");
        console.error(`[editor] FFmpeg exit ${code}:`, detail);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "FFmpeg processing failed", detail }));
      }
    });
  });
}

// ═══════════════════════════════════════════════
//  POST /api/editor/:sessionId/preview
// ═══════════════════════════════════════════════
function handlePreview(req, res) {
  const sessionId = parseSessionId(req.url);
  const sessionDir = path.join(ctx.dirs.RECORDINGS_DIR, sessionId);

  if (!sessionId || !fs.existsSync(sessionDir)) {
    req.resume();
    req.on("end", () => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
    });
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (process.env.DEMO_MODE) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Preview is disabled in demo mode" }));
      return;
    }

    if (!ffmpegAvailable) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "FFmpeg not available — install ffmpeg on the server" }));
      return;
    }

    let params;
    try { params = JSON.parse(body); } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    const { tracks, trim, silenceRemoval, autoLevel } = params;
    const includedTracks = (tracks || []).filter((t) => t.include !== false);

    if (includedTracks.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No tracks included" }));
      return;
    }

    for (const t of includedTracks) {
      const safeFile = sanitize(t.filename.replace(/\.webm$/, "")) + ".webm";
      if (!fs.existsSync(path.join(sessionDir, safeFile))) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Track not found: ${t.filename}` }));
        return;
      }
    }

    const previewStart = Math.max(0, Number(trim && trim.startSec) || 0);
    const requestedEnd = trim && Number(trim.endSec) > previewStart ? Number(trim.endSec) : null;
    const previewEnd = requestedEnd !== null
      ? Math.min(requestedEnd, previewStart + PREVIEW_MAX_SEC)
      : previewStart + PREVIEW_MAX_SEC;

    const args = buildFfmpegArgs(
      sessionDir,
      includedTracks,
      { startSec: previewStart, endSec: previewEnd },
      silenceRemoval,
      autoLevel,
      null,
      "pipe:1"
    );
    args.splice(args.length - 1, 0, "-f", "mp3");

    console.log(`[editor] rendering preview (${includedTracks.length} tracks, ${previewStart}s-${previewEnd}s)`);
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let headerSent = false;
    proc.stderr.on("data", (d) => (stderr += d));

    proc.stdout.on("data", (chunk) => {
      if (!headerSent) {
        headerSent = true;
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
      }
      res.write(chunk);
    });

    proc.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to spawn FFmpeg", detail: err.message }));
      } else {
        res.end();
      }
    });

    proc.on("close", (code) => {
      if (headerSent) {
        res.end();
        return;
      }
      const detail = stderr.split("\n").slice(-10).join("\n");
      console.error(`[editor] preview FFmpeg exit ${code}:`, detail);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "FFmpeg processing failed", detail }));
      }
    });
  });
}

function buildFfmpegArgs(sessionDir, tracks, trim, silenceRemoval, autoLevel, introFile, outputPath) {
  const args = ["-y"];

  for (const t of tracks) {
    const safeFile = sanitize(t.filename.replace(/\.webm$/, "")) + ".webm";
    args.push("-i", path.join(sessionDir, safeFile));
  }

  let introIndex = null;
  if (introFile) {
    args.push("-i", path.join(sessionDir, introFile));
    introIndex = tracks.length;
  }

  const filterParts = [];
  let currentLabel;

  if (tracks.length === 1) {
    const offsetMs = Math.max(0, Math.round(tracks[0].offsetMs || 0));
    filterParts.push(`[0:a]adelay=${offsetMs}|${offsetMs}[premix]`);
    currentLabel = "premix";
  } else {
    const mixInputs = [];
    tracks.forEach((t, i) => {
      const offsetMs = Math.max(0, Math.round(t.offsetMs || 0));
      filterParts.push(`[${i}:a]adelay=${offsetMs}|${offsetMs}[a${i}]`);
      mixInputs.push(`[a${i}]`);
    });
    filterParts.push(
      `${mixInputs.join("")}amix=inputs=${tracks.length}:normalize=0:dropout_transition=0[premix]`
    );
    currentLabel = "premix";
  }

  if (silenceRemoval && silenceRemoval.enabled) {
    const threshold = Number(silenceRemoval.thresholdDb) || -45;
    const minDuration = Number(silenceRemoval.minDurationSec) || 1.0;
    filterParts.push(
      `[${currentLabel}]silenceremove=start_periods=0:stop_periods=-1` +
      `:stop_threshold=${threshold}dB:stop_duration=${minDuration}:stop_silence=0.3[sil]`
    );
    currentLabel = "sil";
  }

  if (autoLevel && autoLevel.enabled) {
    // dynaudnorm is FFmpeg's closest built-in analog to what the Levelator app did:
    // it rides gain over time so quiet talkers get boosted and loud ones get tamed,
    // rather than applying one static gain for the whole file.
    filterParts.push(`[${currentLabel}]dynaudnorm[leveled]`);
    currentLabel = "leveled";
  }

  const trimStart = trim && trim.startSec > 0 ? Number(trim.startSec) : 0;
  const trimEnd = trim && trim.endSec > 0 ? Number(trim.endSec) : null;
  if (trimStart > 0 || trimEnd !== null) {
    const trimFilter = trimEnd !== null
      ? `atrim=start=${trimStart}:end=${trimEnd},asetpts=PTS-STARTPTS`
      : `atrim=start=${trimStart},asetpts=PTS-STARTPTS`;
    filterParts.push(`[${currentLabel}]${trimFilter}[trimmed]`);
    currentLabel = "trimmed";
  }

  if (introIndex !== null) {
    filterParts.push(`[${introIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo[intro]`);
    filterParts.push(`[intro][${currentLabel}]concat=n=2:v=0:a=1[final]`);
    currentLabel = "final";
  }

  args.push("-filter_complex", filterParts.join(";"));
  args.push("-map", `[${currentLabel}]`);
  args.push("-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100");
  args.push(outputPath);

  return args;
}

module.exports = {
  routes: [
    {
      method: "GET",
      match: (url) => {
        const parts = url.split("?")[0].split("/");
        return parts[1] === "api" && parts[2] === "editor" && !!parts[3] && !parts[4];
      },
      handler: requireAuth(handleGetSession),
    },
    {
      method: "POST",
      match: (url) => {
        const clean = url.split("?")[0];
        return clean.startsWith("/api/editor/") && clean.endsWith("/detect-sync");
      },
      handler: requireAuth(handleDetectSync),
    },
    {
      method: "POST",
      match: (url) => {
        const clean = url.split("?")[0];
        return clean.startsWith("/api/editor/") && clean.endsWith("/upload-intro");
      },
      handler: requireHost(handleUploadIntro),
    },
    {
      method: "POST",
      match: (url) => {
        const clean = url.split("?")[0];
        return clean.startsWith("/api/editor/") && clean.endsWith("/export");
      },
      handler: requireAuth(handleExport),
    },
    {
      method: "POST",
      match: (url) => {
        const clean = url.split("?")[0];
        return clean.startsWith("/api/editor/") && clean.endsWith("/preview");
      },
      handler: requireAuth(handlePreview),
    },
  ],
  init,
};
