// ═══════════════════════════════════════════════
//  PASSWORDS & ROLES
//  Change these! In production, load from env vars.
// ═══════════════════════════════════════════════
const PASSWORDS = {
  host: process.env.HOST_PASSWORD || "host123",
  member: process.env.MEMBER_PASSWORD || "member123",
  guest: process.env.GUEST_PASSWORD || "guest",
};

function authenticatePassword(password) {
  if (password === PASSWORDS.host) return "host";
  if (password === PASSWORDS.member) return "member";
  if (password === PASSWORDS.guest) return "guest";
  return null;
}

function handleAuth(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { password } = JSON.parse(body);
      const role = authenticatePassword(password);
      if (role) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, role }));
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid password" }));
      }
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad request" }));
    }
  });
}

module.exports = {
  routes: [
    { method: "POST", match: (url) => url === "/api/auth", handler: handleAuth },
  ],
  init() {},
};
