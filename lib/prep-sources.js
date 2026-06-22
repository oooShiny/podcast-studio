const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http2 = require("http");
const { safeSegment, safeGame, getQuery } = require("./util");

const MAX_SOURCE_BODY = 2 * 1024 * 1024 * 1024; // 2 GB — sources include uploaded video

let ctx;
function init(c) {
  ctx = c;
}

// ═══════════════════════════════════════════════
//  PREP SOURCES
// ═══════════════════════════════════════════════
function sourcesManifestPath(game, user) {
  const dir = path.join(ctx.dirs.PREP_SOURCES_DIR, safeGame(game));
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
  const p = getQuery(req);
  const game = p.get("game") || "";
  const season = (p.get("season") || "").replace(/[^0-9]/g, "").slice(0, 4);
  if (!game) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing game" })); return; }

  const gameDir = path.join(ctx.dirs.PREP_SOURCES_DIR, safeGame(game));
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
    const seasonDir = path.join(ctx.dirs.PREP_SOURCES_DIR, safeGame(`_season_${season}`));
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
      const gameDir = path.join(ctx.dirs.PREP_SOURCES_DIR, safeGame(meta.game));
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

// Recognizes links from common video providers and maps them to the provider's
// dedicated embeddable player URL — the regular watch/share page is usually blocked
// from framing, but the /embed/ variant is explicitly designed to be embedded.
function detectVideoEmbed(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, "");

  if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "youtu.be") {
    let id = null;
    if (host === "youtu.be") {
      id = u.pathname.slice(1).split("/")[0];
    } else if (u.pathname === "/watch") {
      id = u.searchParams.get("v");
    } else if (/^\/(shorts|embed|live)\//.test(u.pathname)) {
      id = u.pathname.split("/")[2];
    }
    if (!id) return null;
    const start = parseInt(String(u.searchParams.get("t") || u.searchParams.get("start") || "").replace(/[^0-9]/g, ""), 10);
    const qs = start > 0 ? `?start=${start}` : "";
    return { provider: "youtube", embedUrl: `https://www.youtube-nocookie.com/embed/${id}${qs}` };
  }

  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = u.pathname.split("/").filter(Boolean).pop();
    if (!id || !/^\d+$/.test(id)) return null;
    return { provider: "vimeo", embedUrl: `https://player.vimeo.com/video/${id}` };
  }

  return null;
}

// Video providers block their oEmbed endpoint from X-Frame-Options sniffing concerns
// (it's just JSON, never framed) so we can fetch it for a clean title/author without
// the generic full-page scrape used for ordinary links.
function addVideoEmbedSource(user, game, url, parsed, videoEmbed, res) {
  const oembedUrl = videoEmbed.provider === "youtube"
    ? `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
    : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;

  const finish = (title, desc) => {
    const id = crypto.randomBytes(8).toString("hex");
    const entry = {
      id, owner: user || "", type: "url", name: title || parsed.hostname, url,
      embedUrl: videoEmbed.embedUrl, domain: parsed.hostname, desc: (desc || "").slice(0, 200),
      addedAt: new Date().toISOString(), embeddable: true,
    };
    const list = readManifest(game, user);
    list.push(entry);
    writeManifest(game, user, list);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(entry));
  };

  const oReq = https.get(oembedUrl, { timeout: 6000 }, (oRes) => {
    let data = "";
    oRes.setEncoding("utf8");
    oRes.on("data", (c) => { data += c; });
    oRes.on("end", () => {
      try {
        const j = JSON.parse(data);
        finish(j.title, j.author_name ? `By ${j.author_name}` : "");
      } catch { finish(null, ""); }
    });
  });
  oReq.on("error", () => finish(null, ""));
  oReq.on("timeout", () => { oReq.destroy(); finish(null, ""); });
}

function handleAddUrlSource(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { user, game, url } = JSON.parse(body);
      if (!game || !url) throw new Error("Missing game or url");
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error("Invalid URL"); }
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http/https allowed");

      const videoEmbed = detectVideoEmbed(url);
      if (videoEmbed) return addVideoEmbedSource(user, game, url, parsed, videoEmbed, res);

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
  const filePath = path.join(ctx.dirs.PREP_SOURCES_DIR, game, filename);
  if (!filePath.startsWith(ctx.dirs.PREP_SOURCES_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }

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
  const qs = getQuery(req);
  const requester = qs.get("user") || "";
  const role = qs.get("role") || "";

  // Scan all manifests to find the entry
  const gameDir = path.join(ctx.dirs.PREP_SOURCES_DIR, safeGame(game));
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
    const fp = path.join(ctx.dirs.PREP_SOURCES_DIR, safeGame(game), foundEntry.filename);
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
      const gameDir = path.join(ctx.dirs.PREP_SOURCES_DIR, safeGame(game));
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

      const gameDir = path.join(ctx.dirs.PREP_SOURCES_DIR, safeGame(game));
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

module.exports = {
  routes: [
    { method: "GET", match: (url) => url.startsWith("/api/prep-sources/file/"), handler: handleServeSourceFile },
    { method: "GET", match: (url) => url.startsWith("/api/prep-sources"), handler: handleListSources },
    { method: "POST", match: (url) => url === "/api/prep-sources/upload", handler: handleUploadSource },
    { method: "POST", match: (url) => url === "/api/prep-sources/url", handler: handleAddUrlSource },
    { method: "POST", match: (url) => url === "/api/prep-sources/tag-season", handler: handleTagSeasonSource },
    { method: "DELETE", match: (url) => url.startsWith("/api/prep-sources/"), handler: handleDeleteSource },
    { method: "PATCH", match: (url) => url.startsWith("/api/prep-sources/"), handler: handleRenameSource },
  ],
  init,
};
