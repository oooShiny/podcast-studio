const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");
const { requireHost } = require("./auth");
const { pullLatestAndRestart } = require("./webhook");

const STATUS_CACHE_MS = 10 * 60 * 1000; // stay well under GitHub's 60 req/hr unauthenticated cap
const DEFAULT_REPO_SLUG = "oooShiny/podcast-studio";

let ctx;
let deploymentType = "unknown"; // "git" | "docker" | "unknown"
let currentVersion = null;
let repoSlug = DEFAULT_REPO_SLUG;

let statusCache = null; // { data, fetchedAt }

function detectDeployment(c) {
  if (fs.existsSync(path.join(c.rootDir, ".git"))) {
    deploymentType = "git";
    try {
      currentVersion = execFileSync("git", ["-C", c.rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      currentVersion = null;
    }
    try {
      const remoteUrl = execFileSync("git", ["-C", c.rootDir, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
      const match = /github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/.exec(remoteUrl);
      if (match) repoSlug = match[1];
    } catch {
      // fall back to DEFAULT_REPO_SLUG
    }
  } else if (process.env.GIT_SHA) {
    deploymentType = "docker";
    currentVersion = process.env.GIT_SHA;
    if (process.env.GITHUB_REPO) repoSlug = process.env.GITHUB_REPO;
  } else {
    deploymentType = "unknown";
    currentVersion = null;
  }
}

function init(c) {
  ctx = c;
  detectDeployment(c);
}

function fetchLatestCommit() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path: `/repos/${repoSlug}/commits/main`,
        method: "GET",
        headers: {
          "User-Agent": "podcast-studio-updates-check",
          Accept: "application/vnd.github+json",
        },
        timeout: 8000,
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API returned ${res.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(body);
            resolve(parsed.sha);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("GitHub API request timed out")));
    req.end();
  });
}

// ═══════════════════════════════════════════════
//  GET /api/updates/status
// ═══════════════════════════════════════════════
async function handleStatus(req, res) {
  const now = Date.now();
  if (statusCache && now - statusCache.fetchedAt < STATUS_CACHE_MS) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(statusCache.data));
    return;
  }

  const base = {
    deploymentType,
    current: currentVersion,
    repoSlug,
  };

  try {
    const latest = await fetchLatestCommit();
    const data = {
      ...base,
      latest,
      updateAvailable: !!currentVersion && latest !== currentVersion,
      compareUrl: currentVersion
        ? `https://github.com/${repoSlug}/compare/${currentVersion}...main`
        : `https://github.com/${repoSlug}/commits/main`,
    };
    statusCache = { data, fetchedAt: now };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch (e) {
    // Degrade gracefully — an offline box or a GitHub API hiccup shouldn't break Settings.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...base, latest: null, updateAvailable: false, error: e.message }));
  }
}

// ═══════════════════════════════════════════════
//  POST /api/updates/apply
// ═══════════════════════════════════════════════
function handleApply(req, res) {
  req.resume();
  req.on("end", () => {
    if (deploymentType !== "git") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Automatic update isn't available for this deployment type — pull the new Docker image and restart the container instead.",
      }));
      return;
    }

    console.log("[updates] Update requested from Settings — pulling…");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    pullLatestAndRestart(ctx, () => {
      // pullLatestAndRestart already logs the failure; nothing else to do here
      // since the response was already sent.
    });
  });
}

module.exports = {
  routes: [
    { method: "GET", match: (url) => url.split("?")[0] === "/api/updates/status", handler: requireHost(handleStatus) },
    { method: "POST", match: (url) => url.split("?")[0] === "/api/updates/apply", handler: requireHost(handleApply) },
  ],
  init,
};
