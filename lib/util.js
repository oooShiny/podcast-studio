// Shared helpers used across feature modules.

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

module.exports = { sanitize, safeSegment, safeGame, getQuery };
