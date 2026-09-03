// A ~30-line relay for `relay-url`. Runs on YOUR server so the API key never
// reaches a browser. It forwards with the Node kit, which lives at
// https://github.com/hellojade-ai/leads-node (npm package name @hellojade/intake).
//
//   HELLOJADE_API_KEY=... node relay-node.mjs      # then point relay-url at http://127.0.0.1:8787/api/lead
import { createServer } from "node:http";
import { IntakeClient, ValidationError, ApiError } from "@hellojade/intake"; // from the Node kit

const client = new IntakeClient({ apiKey: process.env.HELLOJADE_API_KEY, idempotencyNamespace: "acme-site" });

createServer(async (req, res) => {
  // Proxy the (unauthenticated, 5-minute-cacheable) vocabulary so the page can
  // populate its project_area select without a CORS grant on the intake host.
  // Point the element's vocabulary-url attribute here.
  if (req.method === "GET" && req.url === "/api/vocabulary") {
    try {
      const v = await client.vocabulary();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
      return res.end(JSON.stringify(v));
    } catch { res.writeHead(502); return res.end('{"error":"vocabulary_unavailable"}'); }
  }
  if (req.method !== "POST" || req.url !== "/api/lead") { res.writeHead(404); return res.end(); }
  let raw = ""; for await (const c of req) raw += c;
  const key = req.headers["idempotency-key"]; // minted by the element, stable across its retries
  const requestId = req.headers["x-request-id"];
  const reply = (status, body) => { res.writeHead(status, { "content-type": "application/json", "x-request-id": requestId || "" }); res.end(JSON.stringify(body)); };
  if (!key) return reply(400, { error: "missing_idempotency_key" });
  try {
    const lead = JSON.parse(raw);
    delete lead.source; // rule 6: never forward a source
    const accepted = await client.submitLead(lead, { idempotencyKey: key, requestId });
    reply(accepted.status === "duplicate" ? 200 : 202, accepted);
  } catch (err) {
    if (err instanceof ValidationError) return reply(422, { error: "validation_failed", fields: err.fields, request_id: err.requestId });
    if (err instanceof ApiError) return reply(err.status === 429 ? 429 : 502, { error: err.code || "upstream", request_id: err.requestId });
    reply(502, { error: "unreachable" });
  }
}).listen(8787, "127.0.0.1", () => console.log("relay on http://127.0.0.1:8787/api/lead"));
