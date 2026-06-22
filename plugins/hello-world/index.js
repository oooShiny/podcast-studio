// Minimal example plugin — demonstrates the {routes, init(ctx)} contract
// any plugin under plugins/ must export. Confirms the loader generalizes
// beyond a single example (see google-vision-ocr for a real one).
function handleHello(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, message: "Hello from the hello-world plugin!" }));
}

module.exports = {
  routes: [
    { method: "GET", match: (url) => url === "/api/plugins/hello-world", handler: handleHello },
  ],
  init() {},
};
