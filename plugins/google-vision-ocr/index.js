const https = require("https");

// ═══════════════════════════════════════════════
//  OCR — Google Cloud Vision
// ═══════════════════════════════════════════════
function handleOcr(req, res) {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "GOOGLE_VISION_API_KEY is not set on the server." }));
    return;
  }

  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > 10 * 1024 * 1024) { res.writeHead(413); res.end(JSON.stringify({ error: "Image too large (max 10 MB)" })); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    try {
      const { imageBase64, mime } = JSON.parse(Buffer.concat(chunks).toString());
      if (!imageBase64) throw new Error("Missing imageBase64");

      const payload = JSON.stringify({
        requests: [{
          image: { content: imageBase64 },
          features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
          imageContext: { languageHints: ["en"] },
        }],
      });

      const options = {
        hostname: "vision.googleapis.com",
        path: `/v1/images:annotate?key=${apiKey}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      };

      const vReq = https.request(options, (vRes) => {
        let data = "";
        vRes.on("data", (c) => (data += c));
        vRes.on("end", () => {
          try {
            const result = JSON.parse(data);
            if (result.error) throw new Error(result.error.message);
            const r = result.responses?.[0];
            if (!r) throw new Error("Empty response from Vision API");
            if (r.error) throw new Error(r.error.message);

            const text = (r.fullTextAnnotation?.text || "").trim();

            // Average word-level confidence across all words on the first page
            let confidence = null;
            const words = [];
            r.fullTextAnnotation?.pages?.[0]?.blocks?.forEach((b) =>
              b.paragraphs?.forEach((p) =>
                p.words?.forEach((w) => { if (w.confidence != null) words.push(w.confidence); })
              )
            );
            if (words.length) confidence = Math.round(words.reduce((a, b) => a + b, 0) / words.length * 100);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ text, confidence }));
          } catch (e) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      });

      vReq.on("error", (e) => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Vision API unreachable: " + e.message }));
      });
      vReq.write(payload);
      vReq.end();
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

module.exports = {
  routes: [
    { method: "POST", match: (url) => url === "/api/ocr", handler: handleOcr },
  ],
  init() {},
};
