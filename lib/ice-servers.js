const crypto = require("crypto");
const { requireAuth, getSession } = require("./auth");

// GET /api/ice-servers — hands authenticated clients their WebRTC ICE config.
// STUN alone connects most peers directly; TURN is the relay fallback for
// networks that block direct paths, so it's only added when a provider is
// configured. With nothing configured this returns the public STUN servers,
// i.e. exactly what the client hardcoded before.
//
// Providers (first one configured wins):
//   cloudflare — TURN_KEY_ID + TURN_KEY_API_TOKEN: Cloudflare Realtime TURN,
//                short-lived credentials minted via their API per request.
//   coturn     — TURN_URLS + TURN_SECRET: self-hosted coturn using
//                `use-auth-secret`; credentials are an HMAC we compute locally.
const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// Must outlast the longest session; defaults to the 12h auth token lifetime.
const TTL_SECONDS = Number(process.env.TURN_TTL_SECONDS) || 12 * 60 * 60;

async function cloudflareIceServers() {
  const { TURN_KEY_ID, TURN_KEY_API_TOKEN } = process.env;
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(TURN_KEY_ID)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
      signal: AbortSignal.timeout(5000),
    }
  );
  if (!res.ok) throw new Error(`Cloudflare TURN responded ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.iceServers)) throw new Error("Cloudflare TURN returned no iceServers");
  return data.iceServers;
}

// coturn "TURN REST API" credentials: username is `<expiry-unix>:<label>` and
// the password is base64(HMAC-SHA1(shared-secret, username)). coturn recomputes
// and checks both, so nothing needs storing and credentials expire on their own.
function coturnIceServers(label) {
  const urls = process.env.TURN_URLS.split(",").map((u) => u.trim()).filter(Boolean);
  const username = `${Math.floor(Date.now() / 1000) + TTL_SECONDS}:${label}`;
  const credential = crypto.createHmac("sha1", process.env.TURN_SECRET).update(username).digest("base64");
  return [{ urls, username, credential }];
}

function provider() {
  if (process.env.TURN_KEY_ID && process.env.TURN_KEY_API_TOKEN) return "cloudflare";
  if (process.env.TURN_URLS && process.env.TURN_SECRET) return "coturn";
  return null;
}

async function resolveIceServers(label) {
  try {
    switch (provider()) {
      case "cloudflare": return await cloudflareIceServers();
      case "coturn": return [...STUN_SERVERS, ...coturnIceServers(label)];
    }
  } catch (e) {
    // A TURN outage shouldn't stop calls that STUN can connect — degrade, don't fail.
    console.error("[ice] TURN credential generation failed, falling back to STUN only:", e.message);
  }
  return STUN_SERVERS;
}

function handleIceServers(req, res) {
  const session = getSession(req.headers.authorization?.slice(7));
  // Label ties relay usage to a room in coturn logs without exposing anything identifying.
  const label = session?.room || "studio";
  resolveIceServers(label).then((iceServers) => {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ iceServers }));
  });
}

module.exports = {
  routes: [
    { method: "GET", match: (url) => url.split("?")[0] === "/api/ice-servers", handler: requireAuth(handleIceServers) },
  ],
  init() {
    const p = provider();
    if (p) console.log(`[ice] TURN enabled via ${p}`);
  },
};
