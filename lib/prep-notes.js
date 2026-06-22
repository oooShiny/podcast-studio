const fs = require("fs");
const path = require("path");
const { safeSegment, safeGame, getQuery } = require("./util");

let ctx;
function init(c) {
  ctx = c;
}

// ═══════════════════════════════════════════════
//  CURRENT GAME (per-server "what episode are we prepping" pointer)
// ═══════════════════════════════════════════════
function handleGetCurrentGame(req, res) {
  fs.readFile(path.join(ctx.dirs.PREP_NOTES_DIR, "current-game.json"), (err, data) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(err ? JSON.stringify({ game: null, title: null }) : data);
  });
}

function handlePutCurrentGame(req, res) {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    try {
      const { game, title } = JSON.parse(body);
      const safeGameSlug = safeGame(game);
      if (!safeGameSlug) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing game" })); return; }
      const data = JSON.stringify({ game: safeGameSlug, title: title || safeGameSlug, updatedAt: new Date().toISOString() });
      fs.mkdirSync(ctx.dirs.PREP_NOTES_DIR, { recursive: true });
      fs.writeFile(path.join(ctx.dirs.PREP_NOTES_DIR, "current-game.json"), data, err => {
        if (err) { res.writeHead(500); res.end(JSON.stringify({ error: "Write failed" })); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    } catch {
      res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
  });
}

// ═══════════════════════════════════════════════
//  PREP NOTES (per-user, per-game)
// ═══════════════════════════════════════════════
function handleListPrepNoteGames(req, res) {
  const sharedDir = path.join(ctx.dirs.PREP_NOTES_DIR, "_shared");
  let games = [];
  try {
    games = fs.readdirSync(sharedDir)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        const slug = f.replace(/\.json$/, "");
        try {
          const d = JSON.parse(fs.readFileSync(path.join(sharedDir, f)));
          return { slug, title: d.title || slug };
        } catch {
          return { slug, title: slug };
        }
      })
      .sort((a, b) => a.slug.localeCompare(b.slug));
  } catch {}
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(games));
}

function handleListPrepNoteUsers(req, res) {
  // Returns users who have a private notes file for a given game (excludes _shared)
  const game = safeGame(getQuery(req).get("game") || "");
  if (!game) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing game" })); return; }
  let users = [];
  try {
    users = fs.readdirSync(ctx.dirs.PREP_NOTES_DIR)
      .filter(d => d !== "_shared" && fs.statSync(path.join(ctx.dirs.PREP_NOTES_DIR, d)).isDirectory())
      .filter(d => {
        try { fs.accessSync(path.join(ctx.dirs.PREP_NOTES_DIR, d, `${game}.json`)); return true; } catch { return false; }
      })
      .sort();
  } catch {}
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(users));
}

function handleGetPrepNotes(req, res) {
  const params = getQuery(req);
  const user = safeSegment(params.get("user"), 50);
  const game = safeGame(params.get("game"));

  if (!user || !game) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing user or game" }));
    return;
  }

  const filePath = path.join(ctx.dirs.PREP_NOTES_DIR, user, `${game}.json`);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ notes: null }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(data);
  });
}

function handlePutPrepNotes(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { user, game, title, notes } = JSON.parse(body);
      const safeUser = safeSegment(user, 50);
      const safeGameSlug = safeGame(game);

      if (!safeUser || !safeGameSlug || !notes) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing fields" }));
        return;
      }

      const userDir = path.join(ctx.dirs.PREP_NOTES_DIR, safeUser);
      fs.mkdirSync(userDir, { recursive: true });

      const record = { user: safeUser, game: safeGameSlug, savedAt: new Date().toISOString(), notes };
      if (title && safeUser === "_shared") record.title = String(title).slice(0, 300);
      const data = JSON.stringify(record, null, 2);
      fs.writeFile(path.join(userDir, `${safeGameSlug}.json`), data, (err) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Write failed" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
  });
}

module.exports = {
  routes: [
    { method: "GET", match: (url) => url === "/api/current-game", handler: handleGetCurrentGame },
    { method: "PUT", match: (url) => url === "/api/current-game", handler: handlePutCurrentGame },
    { method: "GET", match: (url) => url.startsWith("/api/prep-notes/games"), handler: handleListPrepNoteGames },
    { method: "GET", match: (url) => url.startsWith("/api/prep-notes/users"), handler: handleListPrepNoteUsers },
    { method: "GET", match: (url) => url.startsWith("/api/prep-notes"), handler: handleGetPrepNotes },
    { method: "PUT", match: (url) => url.startsWith("/api/prep-notes"), handler: handlePutPrepNotes },
  ],
  init,
};
