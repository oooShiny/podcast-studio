// End-to-end checks for the studio server: starts it on a random port with a
// throwaway DATA_DIR and fixed passwords, then exercises auth, recording
// upload/finalize, downloads, prep notes, SSRF guards and WebSocket rules.
// Run with: npm test
const { spawn } = require("child_process");
const os = require("os");
const net = require("net");
const fs = require("fs");
const path = require("path");

const D = fs.mkdtempSync(path.join(os.tmpdir(), "podcast-studio-test-"));
let B, WS, child;

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  B = `http://127.0.0.1:${port}`;
  WS = `ws://127.0.0.1:${port}`;
  // cwd is the temp dir so no local .env is picked up.
  child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: D,
    env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: D, HOST_PASSWORD: "hpw", MEMBER_PASSWORD: "mpw", GUEST_PASSWORD: "gpw" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(B + "/api/health")).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}
const WebSocket = require("ws");

let fails = 0;
const check = (name, ok, extra = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); };
async function auth(pw) { const r = await fetch(B + "/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) }); return { r, j: await r.json() }; }
function chunkBody(meta, data) { return Buffer.concat([Buffer.from(JSON.stringify(meta) + "\n"), Buffer.from(data)]); }
async function up(tok, meta, data) { return fetch(B + "/api/upload-chunk", { method: "POST", headers: { authorization: "Bearer " + tok }, body: chunkBody(meta, data) }); }
const fin = (tok, body) => fetch(B + "/api/finalize", { method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(body) });
function wsMsgs(msg) { return new Promise((res) => { const ws = new WebSocket(WS); const got = []; ws.on("open", () => ws.send(JSON.stringify(msg))); ws.on("message", (d) => got.push(JSON.parse(d))); setTimeout(() => { ws.close(); res(got); }, 400); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await startServer();
  const h = await auth("hpw"); const g = await auth("gpw");
  check("host auth sets cookie", /ps_session=.*HttpOnly/.test(h.r.headers.get("set-cookie") || ""));
  const H = h.j.token, G = g.j.token;
  check("session endpoint", (await (await fetch(B + "/api/auth/session", { headers: { authorization: "Bearer " + G } })).json()).role === "guest");
  check("session endpoint rejects bogus", (await fetch(B + "/api/auth/session", { headers: { authorization: "Bearer x" } })).status === 401);

  let r = await up(H, { sessionId: "s1", participantId: "p1234567", username: "host", chunkIndex: "../../../evil" }, "x");
  check("string chunkIndex rejected", r.status === 400);
  check("no evil file", !fs.readdirSync(D, { recursive: true }).some((f) => String(f).includes("evil")));

  const meta = { sessionId: "s1", participantId: "p1234567", username: "host", trackType: "individual" };
  for (const i of [2, 10000, 1, 9999, 0]) await up(H, { ...meta, chunkIndex: i }, `[${i}]`);
  r = await fin(H, meta);
  const fj = await r.json();
  const outPath = path.join(D, "recordings/s1", fj.filename || "missing");
  const out = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
  check("finalize ordered numerically", out === "[0][1][2][9999][10000]", out);

  await up(H, { ...meta, chunkIndex: 10001 }, "[10001]");
  await fin(H, meta);
  check("late chunk appended", fs.readFileSync(outPath, "utf8").endsWith("[10000][10001]"));
  const m = JSON.parse(fs.readFileSync(path.join(D, "recordings/s1/session.json"), "utf8"));
  check("participant listed once", m.participants.length === 1, JSON.stringify(m.participants));

  fs.writeFileSync(path.join(D, "recordings/s1/EDIT-show.mp3"), "mp3data");
  check("download unauth 401", (await fetch(B + "/api/download/s1/EDIT-show.mp3")).status === 401);
  r = await fetch(B + "/api/download/s1/EDIT-show.mp3", { headers: { cookie: "ps_session=" + G } });
  check("EDIT mp3 downloads via cookie", r.status === 200 && r.headers.get("content-type") === "audio/mpeg", String(r.status));
  check("webm download bearer", (await fetch(B + "/api/download/s1/" + fj.filename, { headers: { authorization: "Bearer " + G } })).status === 200);
  check("download traversal 404", (await fetch(B + "/api/download/s1/..%2F..%2Fsessions.json", { headers: { authorization: "Bearer " + H } })).status === 404);

  check("guest delete session 403", (await fetch(B + "/api/sessions/s1", { method: "DELETE", headers: { authorization: "Bearer " + G } })).status === 403);
  check("guest delete file 403", (await fetch(B + "/api/download/s1/EDIT-show.mp3", { method: "DELETE", headers: { authorization: "Bearer " + G } })).status === 403);
  check("host delete mp3 200", (await fetch(B + "/api/download/s1/EDIT-show.mp3", { method: "DELETE", headers: { authorization: "Bearer " + H } })).status === 200);
  check("host delete empty session id 404", (await fetch(B + "/api/sessions/", { method: "DELETE", headers: { authorization: "Bearer " + H } })).status === 404);
  check("recordings root intact", fs.existsSync(path.join(D, "recordings/s1")));

  const pn = (tok) => fetch(B + "/api/prep-notes", { method: "PUT", headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: JSON.stringify({ user: "_shared", game: "g1", notes: { "n-shared": { html: "x" } } }) });
  check("prep-notes PUT unauth 401", (await pn()).status === 401);
  check("prep-notes PUT auth 200", (await pn(G)).status === 200);

  // merge: true updates only the fields sent; a plain PUT still replaces.
  const putNotes = (body) => fetch(B + "/api/prep-notes", { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer " + G }, body: JSON.stringify({ user: "_shared", game: "gm", ...body }) });
  const getNotes = async () => (await (await fetch(B + "/api/prep-notes?user=_shared&game=gm")).json());
  await putNotes({ title: "Merge test", notes: { a: { html: "A1" }, b: { html: "B1" } } });
  await putNotes({ merge: true, notes: { b: { html: "B2" } } });
  let got = await getNotes();
  check("prep-notes merge keeps untouched fields", got.notes?.a?.html === "A1" && got.notes?.b?.html === "B2", JSON.stringify(got.notes));
  check("prep-notes merge keeps title", got.title === "Merge test", String(got.title));
  await putNotes({ notes: { c: { html: "C1" } } });
  got = await getNotes();
  check("prep-notes plain PUT replaces", !got.notes?.a && got.notes?.c?.html === "C1", JSON.stringify(got.notes));
  check("current-game PUT unauth 401", (await fetch(B + "/api/current-game", { method: "PUT", body: "{}" })).status === 401);

  r = await fetch(B + "/api/prep-notes", { method: "PUT", headers: { authorization: "Bearer " + G }, body: "x".repeat(3 * 1024 * 1024) }).catch((e) => ({ status: "err:" + e.message }));
  check("oversized JSON body 413", r.status === 413, String(r.status));

  fs.mkdirSync(path.join(D, "recordings/s2"), { recursive: true });
  r = await fetch(B + "/api/editor/s2/export", { method: "POST", headers: { authorization: "Bearer " + H, "content-type": "application/json" }, body: JSON.stringify({ tracks: [{ filename: 5 }, null] }) });
  check("editor bad filename 400 (not crash)", r.status === 400, String(r.status));

  for (const u of ["http://127.0.0.1:3901/api/health", "http://localhost:3901/", "http://169.254.169.254/latest/meta-data", "http://[::1]:3901/", "http://10.0.0.1/", "http://[::ffff:127.0.0.1]:3901/", "http://[::ffff:7f00:1]:3901/"]) {
    r = await fetch(B + "/api/prep-sources/url", { method: "POST", headers: { authorization: "Bearer " + H, "content-type": "application/json" }, body: JSON.stringify({ game: "g1", url: u }) });
    check("SSRF blocked " + u, r.status === 400 || r.status === 502, String(r.status));
  }
  r = await fetch(B + "/api/prep-sources/url", { method: "POST", headers: { authorization: "Bearer " + H, "content-type": "application/json" }, body: JSON.stringify({ game: "g1", url: "http://localtest.me:3901/" }) });
  check("SSRF via DNS-to-loopback blocked", r.status === 502, String(r.status) + " " + (await r.text()).slice(0, 80));

  check("no wildcard CORS", !(await fetch(B + "/api/health")).headers.get("access-control-allow-origin"));

  const host = new WebSocket(WS); const hostGot = [];
  await new Promise((r) => host.on("open", r)); host.on("message", (d) => hostGot.push(JSON.parse(d)));
  host.send(JSON.stringify({ type: "join", room: "studio", username: "H", token: H }));
  const guest = new WebSocket(WS); const gGot = [];
  await new Promise((r) => guest.on("open", r)); guest.on("message", (d) => gGot.push(JSON.parse(d)));
  guest.send(JSON.stringify({ type: "join", room: "studio", username: "G", token: G }));
  await sleep(200);
  guest.send(JSON.stringify({ type: "recording-control", action: "stop", sessionId: "abc" }));
  host.send(JSON.stringify({ type: "recording-control", action: "start", sessionId: "take1" }));
  await sleep(200);
  check("guest recording-control ignored", !hostGot.some((m) => m.type === "recording-control" && m.action === "stop"));
  check("host recording-control relayed", gGot.some((m) => m.type === "recording-control" && m.action === "start"));
  guest.close(); await sleep(100);
  const g2 = await wsMsgs({ type: "join", room: "studio", username: "G", token: G });
  const ri = g2.find((m) => m.type === "room-info");
  check("rejoin sees active take", !!(ri && ri.recording && ri.recording.sessionId === "take1" && typeof ri.uptimeMs === "number"));
  host.close();

  check("prep-join no token rejected", (await wsMsgs({ type: "prep-join", room: "prep:g1", username: "x" })).some((m) => m.type === "join-error"));
  check("prep-join with token ok", (await wsMsgs({ type: "prep-join", room: "prep:g1", username: "x", token: G })).some((m) => m.type === "prep-room-info"));


  let last; for (let i = 0; i < 25; i++) last = (await auth("wrong")).r.status;
  check("auth rate-limited", last === 429, String(last));
  check("health", (await fetch(B + "/api/health")).status === 200);
  console.log(fails ? `${fails} FAILED` : "ALL PASS");
  child.kill();
  fs.rmSync(D, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); if (child) child.kill(); process.exit(1); });
