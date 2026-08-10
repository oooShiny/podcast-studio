const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { execFileSync } = require("child_process");
const { requireHost } = require("./auth");

const STATUS_CACHE_MS = 10 * 60 * 1000; // stay well under GitHub's 60 req/hr unauthenticated cap
const CORE_REPO_SLUG = "oooShiny/podcast-studio";

let ctx;
let deploymentType = "unknown"; // "git" | "docker" | "unknown" — only affects the UI label and whether Docker blocks apply

let statusCache = null; // { data, fetchedAt }

function detectDeployment(c) {
  if (fs.existsSync(path.join(c.rootDir, ".git"))) {
    deploymentType = "git";
  } else if (process.env.GIT_SHA) {
    deploymentType = "docker";
  } else {
    deploymentType = "unknown";
  }
}

function init(c) {
  ctx = c;
  detectDeployment(c);
}

// The sha of the last-applied core release, if this instance has ever run an
// apply. Falls back to best-effort guesses for instances that haven't yet —
// see currentVersion() below.
function readTrackedVersion() {
  try {
    const raw = fs.readFileSync(path.join(ctx.rootDir, "core-version.json"), "utf8");
    return JSON.parse(raw).sha || null;
  } catch {
    return null;
  }
}

function currentVersion() {
  const tracked = readTrackedVersion();
  if (tracked) return tracked;
  if (deploymentType === "docker") return process.env.GIT_SHA || null;
  if (deploymentType === "git") {
    // Rough fallback for a podcast-studio clone that's never applied a core
    // release yet — may not exactly match a release sha until the first apply.
    try {
      return execFileSync("git", ["-C", ctx.rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  }
  return null;
}

function githubApiRequest(reqPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path: reqPath,
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
            resolve(JSON.parse(body));
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

async function fetchLatestRelease() {
  const release = await githubApiRequest(`/repos/${CORE_REPO_SLUG}/releases/latest`);
  const tagName = release.tag_name || "";
  const sha = tagName.startsWith("core-") ? tagName.slice("core-".length) : tagName;
  const asset = (release.assets || []).find((a) => /^core-.*\.tar\.gz$/.test(a.name));
  if (!sha || !asset) throw new Error("Latest release is missing a core tarball asset");
  return { sha, tagName, publishedAt: release.published_at, downloadUrl: asset.browser_download_url };
}

// Downloads a URL to destPath, following redirects (GitHub release assets
// redirect to blob storage).
function downloadFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "podcast-studio-updates-check" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("Too many redirects downloading release asset"));
            return;
          }
          resolve(downloadFile(res.headers.location, destPath, redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", reject);
      })
      .on("error", reject);
  });
}

// Overlays every top-level entry found in the extracted tarball onto
// ctx.rootDir. Directories are fully replaced (removed, then re-copied) so
// upstream deletions propagate; files are plain-overwritten. Driven by the
// tarball's own contents rather than a separate manifest, so this can never
// drift from what actually shipped — includes core-version.json itself,
// which is how the local version marker updates, for free.
function overlayExtracted(extractDir) {
  for (const entry of fs.readdirSync(extractDir)) {
    const src = path.join(extractDir, entry);
    const dest = path.join(ctx.rootDir, entry);
    if (fs.statSync(src).isDirectory()) {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }
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

  const current = currentVersion();
  const base = { deploymentType, current, repoSlug: CORE_REPO_SLUG };

  try {
    const release = await fetchLatestRelease();
    const data = {
      ...base,
      latest: release.sha,
      latestPublishedAt: release.publishedAt,
      updateAvailable: current == null || current !== release.sha,
      releaseUrl: `https://github.com/${CORE_REPO_SLUG}/releases/tag/${release.tagName}`,
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
async function handleApply(req, res) {
  req.resume();
  await new Promise((resolve) => req.on("end", resolve));

  if (deploymentType === "docker") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "Automatic update isn't available for this deployment type — pull the new Docker image and restart the container instead.",
    }));
    return;
  }

  let tmpDir;
  try {
    const release = await fetchLatestRelease();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-update-"));
    const tarPath = path.join(tmpDir, "core.tar.gz");
    const extractDir = path.join(tmpDir, "extract");
    fs.mkdirSync(extractDir);

    console.log(`[updates] Downloading core release ${release.tagName}…`);
    await downloadFile(release.downloadUrl, tarPath);
    execFileSync("tar", ["-xzf", tarPath, "-C", extractDir]);

    const pkgPath = path.join(ctx.rootDir, "package.json");
    const lockPath = path.join(ctx.rootDir, "package-lock.json");
    const readIfExists = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
    const before = { pkg: readIfExists(pkgPath), lock: readIfExists(lockPath) };

    overlayExtracted(extractDir);

    const after = { pkg: readIfExists(pkgPath), lock: readIfExists(lockPath) };
    const warnings = [];
    if (before.pkg !== after.pkg || before.lock !== after.lock) {
      console.log("[updates] Dependencies changed — running npm install…");
      try {
        execFileSync("npm", ["install", "--production"], { cwd: ctx.rootDir, stdio: "pipe", timeout: 120000 });
      } catch (e) {
        const msg = "npm install failed after update: " + (e.message || String(e));
        console.error("[updates]", msg);
        warnings.push(msg);
      }
    }

    console.log(`[updates] Applied core release ${release.tagName} — restarting…`);
    res.writeHead(200, { "Content-Type": "application/json" });
    // Exit inside the write callback so the response is guaranteed flushed
    // before the process dies — this overlay is synchronous, unlike
    // webhook.js's git pull, so there's no natural async gap for free.
    res.end(JSON.stringify({ ok: true, warnings }), () => {
      process.exit(0);
    });
  } catch (e) {
    console.error("[updates] Apply failed:", e.message || e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message || String(e) }));
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

module.exports = {
  routes: [
    { method: "GET", match: (url) => url.split("?")[0] === "/api/updates/status", handler: requireHost(handleStatus) },
    { method: "POST", match: (url) => url.split("?")[0] === "/api/updates/apply", handler: requireHost(handleApply) },
  ],
  init,
};
