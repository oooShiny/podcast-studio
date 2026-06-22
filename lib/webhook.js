const crypto = require("crypto");
const { execFile } = require("child_process");

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

let ctx;
function init(c) {
  ctx = c;
}

// ═══════════════════════════════════════════════
//  GITHUB WEBHOOK
// ═══════════════════════════════════════════════
function handleWebhook(req, res) {
  const sig = req.headers["x-hub-signature-256"] || "";

  if (!WEBHOOK_SECRET) {
    console.warn("[webhook] WEBHOOK_SECRET not set — rejecting request");
    res.writeHead(500);
    res.end("Webhook secret not configured");
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);

    // Verify HMAC-SHA256 signature
    const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    const valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

    if (!valid) {
      console.warn("[webhook] Invalid signature — rejecting");
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }

    // Only handle push events
    if (req.headers["x-github-event"] !== "push") {
      res.writeHead(200);
      res.end("ok");
      return;
    }

    let payload;
    try { payload = JSON.parse(body.toString()); } catch { payload = {}; }

    // Only deploy pushes to the main branch
    const branch = (payload.ref || "").replace("refs/heads/", "");
    if (branch !== "main") {
      res.writeHead(200);
      res.end("ok");
      return;
    }

    const pusher = payload.pusher?.name || "unknown";
    console.log(`[webhook] Push to ${branch} by ${pusher} — pulling…`);

    res.writeHead(200);
    res.end("Deploying");

    // Pull latest code then let PM2 restart the process
    execFile("git", ["-C", ctx.rootDir, "pull", "--ff-only"], (err, stdout, stderr) => {
      if (err) {
        console.error("[webhook] git pull failed:", stderr.trim() || err.message);
        return;
      }
      console.log("[webhook] git pull:", stdout.trim());
      console.log("[webhook] Exiting for PM2 restart…");
      process.exit(0);
    });
  });
}

module.exports = {
  routes: [
    { method: "POST", match: (url) => url === "/webhook", handler: handleWebhook },
  ],
  init,
};
