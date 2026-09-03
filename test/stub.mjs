// A scriptable local stub of the intake API for node:test.
import { createServer } from "node:http";

export async function startStub() {
  const queue = [];
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rec = { method: req.method, url: req.url, headers: req.headers, body: raw };
      requests.push(rec);
      const next = queue.shift();
      if (!next) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "stub_queue_empty" }));
        return;
      }
      if (next.hang) return; // never answer — exercises the timeout
      const headers = { "content-type": "application/json", ...(next.headers || {}) };
      if (req.headers["x-request-id"] && !headers["x-request-id"]) headers["x-request-id"] = req.headers["x-request-id"];
      res.writeHead(next.status, headers);
      res.end(next.body == null ? "" : typeof next.body === "string" ? next.body : JSON.stringify(next.body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    queue,
    requests,
    push(...items) { queue.push(...items); },
    close: () => new Promise((r) => server.close(r)),
  };
}
