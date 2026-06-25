// Shared helpers used across feature modules.
const fs = require("fs");
const path = require("path");

// Strips to a safe identifier for session/participant ids (no dots).
function sanitize(name) {
  return String(name || "").replace(/[^a-zA-Z0-9\-_]/g, "").slice(0, 100);
}

// Strips to a safe path segment for usernames/ids (no dots, no underscore substitution).
function safeSegment(str, maxLen) {
  return (str || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, maxLen);
}

// Strips to a safe directory-name slug for game/episode identifiers (dots allowed).
function safeGame(raw) {
  return (raw || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150);
}

// Parses the query string off a request URL without needing the real host/port.
function getQuery(req) {
  return new URL(req.url, "http://localhost").searchParams;
}

// Recursive size sum over a directory, in bytes. Missing dirs/files count as 0.
function dirSize(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }

  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(full);
    } else {
      try { total += fs.statSync(full).size; } catch {}
    }
  }
  return total;
}

// Backstop for DEMO_MODE: true once clips + screenshots + branding combined
// reach capBytes, so uploads get rejected even if the scheduled wipe is
// delayed or fails. Recording/prep-source uploads don't need this — they're
// already blocked/no-op'd outright in demo mode.
function checkDemoStorageCap(ctx, capBytes) {
  const total = dirSize(ctx.dirs.CLIPS_DIR) + dirSize(ctx.dirs.SCREENSHOTS_DIR) + dirSize(ctx.dirs.BRANDING_DIR);
  return total < capBytes;
}

module.exports = { sanitize, safeSegment, safeGame, getQuery, dirSize, checkDemoStorageCap };
