// Local harness for the real-Chrome test: a static server for the repo root
// and a CORS-enabled stub of the intake API. Scenario is chosen by first_name.
//   node test/browser/serve.mjs            -> prints JSON {static, stub} then serves
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css" };
const requests = [];
const seen = new Map(); // scenario counters

const VOCAB = {
  project_area: [{ area: "roof", status: "confirmed" }, { area: "siding", status: "confirmed" }, { area: "kitchen", status: "proposed" }, { area: "exterior_paint", status: "proposed" }],
  project_service: ["replacement", "repair", "remodel", "maintain"],
  required: ["first_name", "last_name", "phone"],
};

let staticOrigin = "";

const stub = createServer((req, res) => {
  const cors = {
    "access-control-allow-origin": staticOrigin,
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type, x-api-key, idempotency-key, x-request-id, accept",
    "access-control-expose-headers": "x-request-id, retry-after",
    "access-control-max-age": "600",
  };
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const send = (status, body, extra = {}) => {
      res.writeHead(status, { "content-type": "application/json", "x-request-id": req.headers["x-request-id"] || "stub-" + Date.now(), ...cors, ...extra });
      res.end(body == null ? "" : JSON.stringify(body));
    };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    if (req.url === "/__requests") { send(200, requests); return; }
    if (req.url === "/__reset") { requests.length = 0; seen.clear(); send(200, { ok: true }); return; }
    if (req.url === "/v1/vocabulary") { send(200, VOCAB, { "cache-control": "public, max-age=300" }); return; }
    // What a relay proxying GET /v1/vocabulary looks like. The extra term is
    // how the test proves the select was built from HERE and not from the
    // intake host directly.
    if (req.url === "/__relay-vocab") { send(200, { ...VOCAB, project_area: [...VOCAB.project_area, { area: "gutters", status: "confirmed" }] }); return; }
    if (req.url === "/healthz") { send(200, { ok: true, store_writable: true, pending: 0, dead: 0, oldest_pending_age_s: null }); return; }
    // Stands in for the partner's OWN server (examples/relay-node.mjs). It must
    // receive no X-API-Key at all: in relay mode the key never leaves that server.
    if (req.url === "/__relay") {
      requests.push({ headers: req.headers, body: raw, relay: true });
      if (req.headers["x-api-key"]) { send(500, { error: "relay_saw_api_key" }); return; }
      send(202, {
        event_id: "evt_relay_" + (req.headers["idempotency-key"] || "").slice(0, 8),
        status: "accepted", received_at: new Date().toISOString(), flags: [], source: "test-partner",
      });
      return;
    }
    if (req.url !== "/v1/intake") { send(404, { error: "not_found" }); return; }
    if (req.method !== "POST") { send(405, { error: "method_not_allowed" }); return; }
    requests.push({ headers: req.headers, body: raw });
    if (req.headers["x-api-key"] !== "test-key") { send(401, { error: "unauthorized", request_id: req.headers["x-request-id"] || "" }); return; }
    let lead;
    try { lead = JSON.parse(raw); } catch { send(400, { error: "invalid_json" }); return; }
    const n = (seen.get(lead.first_name) || 0) + 1;
    seen.set(lead.first_name, n);
    const accepted = (status) => ({ event_id: "evt_" + (lead.first_name || "x").toLowerCase() + "_" + (req.headers["idempotency-key"] || "").slice(0, 8), status, received_at: new Date().toISOString(), flags: [], source: "test-partner" });
    switch (lead.first_name) {
      case "Dup": send(200, accepted("duplicate")); return;
      case "Missing": send(422, { error: "validation_failed", request_id: req.headers["x-request-id"] || "", fields: { last_name: "required", phone: "required" } }); return;
      case "Ratelimit": if (n === 1) { send(429, { error: "rate_limited" }, { "retry-after": "1" }); return; } send(202, accepted("accepted")); return;
      case "Down": if (n === 1) { send(503, { error: "not_accepting" }); return; } send(202, accepted("accepted")); return;
      default: send(202, accepted("accepted")); return;
    }
  });
});

const statik = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  // Answer it rather than 404: an unanswered favicon is a console error, and a
  // console-error gate that has to allowlist one message stops catching the
  // next one.
  if (path === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  const file = normalize(join(ROOT, path === "/" ? "/test/browser/page.html" : path));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    let body = await readFile(file);
    if (file.endsWith("page.html")) body = body.toString().replace(/__STUB__/g, stubOrigin);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
});

let stubOrigin = "";
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
stubOrigin = `http://127.0.0.1:${stub.address().port}`;
await new Promise((r) => statik.listen(0, "127.0.0.1", r));
staticOrigin = `http://127.0.0.1:${statik.address().port}`;
console.log(JSON.stringify({ static: staticOrigin, stub: stubOrigin }));
