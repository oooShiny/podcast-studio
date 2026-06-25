// Minimal fixed-window rate limiter, keyed by caller-supplied key (e.g. an
// IP address). No external deps, matching the rest of this app's style.
function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, windowStart }

  // Returns true if this call is allowed, false if the key is over budget
  // for the current window.
  function check(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  }

  // Drops expired windows so the map doesn't grow without bound. Call this
  // periodically (e.g. via setInterval) rather than on every request.
  function sweep() {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.windowStart >= windowMs) hits.delete(key);
    }
  }

  return { check, sweep };
}

module.exports = { createLimiter };
