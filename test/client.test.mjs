import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startStub } from "./stub.mjs";
import {
  IntakeClient, ApiError, ValidationError, RateLimitedError, TransportError, parseRetryAfter, randomId, DEFAULT_BASE_URL, VERSION,
} from "../hellojade-intake.js";

// Swap globalThis.crypto for the duration of fn. It is an accessor property in
// modern Node, so a plain assignment silently does nothing — the whole point of
// these tests is a platform where crypto is missing, and a no-op swap would
// make them pass against the very bug they exist to catch.
const withCrypto = async (replacement, fn) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: replacement, configurable: true, writable: true });
  try {
    assert.equal(globalThis.crypto, replacement, "the crypto swap did not take effect");
    return await fn();
  } finally {
    // 🔴 On a platform with NO crypto global — Node 18, the very one these
    // tests exist for — the saved descriptor is `undefined` and defineProperty
    // throws "Property description must be an object". The helper written to
    // test a missing global assumed the global was there. Restore symmetrically.
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else delete globalThis.crypto;
  }
};
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let stub;
const sleeps = [];
const mk = (opts = {}) =>
  new IntakeClient({
    baseUrl: stub.url,
    apiKey: "test-key",
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0,
    ...opts,
  });
const ACCEPTED = { event_id: "evt_01", status: "accepted", received_at: "2026-09-03T00:00:00Z", flags: [], source: "acme" };
const lead = { first_name: "Dana", last_name: "Whitfield", phone: "6305550142" };

before(async () => { stub = await startStub(); });
after(async () => { await stub.close(); });
beforeEach(() => { stub.queue.length = 0; stub.requests.length = 0; sleeps.length = 0; });

test("exports, and VERSION matches package.json", () => {
  // Asserted against package.json rather than a literal, so the release step
  // that bumps both cannot half-happen. A hardcoded expectation here just makes
  // every bump edit a test, which teaches you to edit it without reading it.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
  assert.equal(DEFAULT_BASE_URL, "https://intake.hellojade.ai");
  assert.equal(typeof randomId, "function");
});

test("202 accepted: headers, body, no source, requestId from header", async () => {
  stub.push({ status: 202, body: ACCEPTED });
  const out = await mk().submitLead(lead, { idempotencyKey: "A-1", requestId: "req-1" });
  assert.equal(out.event_id, "evt_01");
  assert.equal(out.status, "accepted");
  assert.deepEqual(out.flags, []);
  assert.equal(out.source, "acme");
  assert.equal(out.requestId, "req-1");
  const r = stub.requests[0];
  assert.equal(r.method, "POST");
  assert.equal(r.url, "/v1/intake");
  assert.equal(r.headers["x-api-key"], "test-key");
  assert.equal(r.headers["idempotency-key"], "A-1");
  assert.equal(r.headers["x-request-id"], "req-1");
  assert.equal(r.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(r.body), lead);
  assert.ok(!("source" in JSON.parse(r.body)));
});

test("200 duplicate returns the ORIGINAL event_id and is success", async () => {
  stub.push({ status: 200, body: { ...ACCEPTED, status: "duplicate" } });
  const out = await mk().submitLead(lead, { idempotencyKey: "A-1" });
  assert.equal(out.status, "duplicate");
  assert.equal(out.event_id, "evt_01");
});

test("flags is always an array even when the body omits it", async () => {
  stub.push({ status: 202, body: { event_id: "evt_02", status: "accepted", received_at: "x" } });
  const out = await mk().submitLead(lead, { idempotencyKey: "A-2" });
  assert.deepEqual(out.flags, []);
});

test("a generated X-Request-Id is sent and is the SAME on every attempt", async () => {
  stub.push({ status: 503, body: { error: "not_accepting" } }, { status: 202, body: ACCEPTED });
  const out = await mk().submitLead(lead, { idempotencyKey: "A-3" });
  assert.equal(stub.requests.length, 2);
  assert.equal(stub.requests[0].headers["x-request-id"], stub.requests[1].headers["x-request-id"]);
  assert.match(out.requestId, /^[0-9a-f-]{36}$/);
});

test("namespace prefixes the idempotency key", async () => {
  stub.push({ status: 202, body: ACCEPTED });
  await mk({ idempotencyNamespace: "acme-leads" }).submitLead(lead, { idempotencyKey: "1234" });
  assert.equal(stub.requests[0].headers["idempotency-key"], "acme-leads:1234");
});

test("400 invalid_json throws ApiError, no retry", async () => {
  stub.push({ status: 400, body: { error: "invalid_json", request_id: "r" } });
  await assert.rejects(mk().submitLead(lead, { idempotencyKey: "A" }), (e) => e instanceof ApiError && e.status === 400 && e.code === "invalid_json");
  assert.equal(stub.requests.length, 1);
});

test("401 unauthorized throws ApiError with requestId, no retry", async () => {
  stub.push({ status: 401, body: { error: "unauthorized", request_id: "abc" }, headers: { "x-request-id": "abc" } });
  await assert.rejects(mk().submitLead(lead, { idempotencyKey: "A" }), (e) => e instanceof ApiError && e.status === 401 && e.requestId === "abc");
  assert.equal(stub.requests.length, 1);
});

test("413 body_too_large throws ApiError, no retry", async () => {
  stub.push({ status: 413, body: { error: "body_too_large" } });
  await assert.rejects(mk().submitLead(lead, { idempotencyKey: "A" }), (e) => e instanceof ApiError && e.status === 413);
  assert.equal(stub.requests.length, 1);
});

test("422 lists EVERY failing field and never retries", async () => {
  stub.push({ status: 422, body: { error: "validation_failed", request_id: "r", fields: { first_name: "required", last_name: "required", phone: "required" } } });
  await assert.rejects(mk().submitLead({}, { idempotencyKey: "A" }), (e) => {
    assert.ok(e instanceof ValidationError);
    assert.ok(e instanceof ApiError);
    assert.deepEqual(Object.keys(e.fields).sort(), ["first_name", "last_name", "phone"]);
    assert.equal(e.code, "validation_failed");
    return true;
  });
  assert.equal(stub.requests.length, 1);
  assert.equal(sleeps.length, 0);
});

test("429 waits Retry-After then succeeds without consuming an attempt", async () => {
  const c = mk({ retry: { maxAttempts: 1 } });
  stub.push({ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "3" } }, { status: 202, body: ACCEPTED });
  const out = await c.submitLead(lead, { idempotencyKey: "A" });
  assert.equal(out.status, "accepted");
  assert.equal(stub.requests.length, 2);
  assert.deepEqual(sleeps, [3000]); // max(3s floor, 1s backoff)
});

test("429 backoff grows past the floor on repeated limits", async () => {
  const c = mk();
  stub.push(
    { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "1" } },
    { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "1" } },
    { status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "1" } },
    { status: 202, body: ACCEPTED },
  );
  await c.submitLead(lead, { idempotencyKey: "A" });
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
});

test("429 beyond maxRateLimitWaits throws RateLimitedError with retryAfter", async () => {
  const c = mk({ retry: { maxRateLimitWaits: 2 } });
  for (let i = 0; i < 3; i++) stub.push({ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "1" } });
  await assert.rejects(c.submitLead(lead, { idempotencyKey: "A" }), (e) => e instanceof RateLimitedError && e.status === 429 && e.retryAfter === 1);
  assert.equal(stub.requests.length, 3);
});

test("503 then 202 retries with growing backoff", async () => {
  stub.push({ status: 503, body: { error: "not_accepting" } }, { status: 503, body: { error: "not_accepting" } }, { status: 202, body: ACCEPTED });
  const out = await mk().submitLead(lead, { idempotencyKey: "A" });
  assert.equal(out.event_id, "evt_01");
  assert.equal(stub.requests.length, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
  // the same Idempotency-Key on every retry
  assert.equal(new Set(stub.requests.map((r) => r.headers["idempotency-key"])).size, 1);
});

test("5xx on every attempt throws ApiError after maxAttempts", async () => {
  const c = mk({ retry: { maxAttempts: 3 } });
  for (let i = 0; i < 3; i++) stub.push({ status: 503, body: { error: "not_accepting" } });
  await assert.rejects(c.submitLead(lead, { idempotencyKey: "A" }), (e) => e instanceof ApiError && e.status === 503);
  assert.equal(stub.requests.length, 3);
});

test("transport failure on every attempt throws TransportError", async () => {
  const c = new IntakeClient({ baseUrl: "http://127.0.0.1:1", apiKey: "k", sleep: async () => {}, retry: { maxAttempts: 2 } });
  await assert.rejects(c.submitLead(lead, { idempotencyKey: "A" }), (e) => e instanceof TransportError && e.attempts === 2 && !!e.cause);
});

test("timeout aborts a hanging request and retries, then TransportError", async () => {
  const c = mk({ timeoutMs: 60, retry: { maxAttempts: 2 } });
  stub.push({ hang: true }, { hang: true });
  await assert.rejects(c.submitLead(lead, { idempotencyKey: "A" }), (e) => e instanceof TransportError && /timeout/.test(String(e.cause && e.cause.message)));
  assert.equal(stub.requests.length, 2);
});

test("caller signal abort is surfaced, not retried", async () => {
  const c = mk({ retry: { maxAttempts: 5 } });
  stub.push({ hang: true });
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("user canceled")), 30);
  await assert.rejects(c.submitLead(lead, { idempotencyKey: "A", signal: ac.signal }), /user canceled/);
  assert.equal(stub.requests.length, 1);
});

test("checkKey: 422 => valid with required fields; nothing stored, no Idempotency-Key sent", async () => {
  stub.push({ status: 422, body: { error: "validation_failed", request_id: "r", fields: { phone: "required", first_name: "required", last_name: "required" } } });
  const out = await mk().checkKey();
  assert.equal(out.valid, true);
  assert.equal(out.status, 422);
  assert.deepEqual(out.required, ["first_name", "last_name", "phone"]);
  assert.equal(stub.requests[0].body, "{}");
  assert.equal(stub.requests[0].headers["idempotency-key"], undefined);
});

test("checkKey: 401 => valid false, does not throw", async () => {
  stub.push({ status: 401, body: { error: "unauthorized", request_id: "r" } });
  const out = await mk().checkKey();
  assert.equal(out.valid, false);
  assert.equal(out.status, 401);
});

test("checkKey: 429 is retried transparently", async () => {
  stub.push({ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "1" } }, { status: 422, body: { error: "validation_failed", fields: { phone: "required" } } });
  const out = await mk().checkKey();
  assert.equal(out.valid, true);
});

test("vocabulary: GET, unauthenticated, retries 5xx", async () => {
  const vocab = { project_area: [{ area: "roof", status: "confirmed" }], project_service: ["replacement", "repair", "remodel", "maintain"], required: ["first_name", "last_name", "phone"] };
  stub.push({ status: 503, body: { error: "x" } }, { status: 200, body: vocab });
  const out = await new IntakeClient({ baseUrl: stub.url, sleep: async () => {} }).vocabulary();
  assert.deepEqual(out, vocab);
  assert.equal(stub.requests[0].method, "GET");
  assert.equal(stub.requests[0].url, "/v1/vocabulary");
  assert.equal(stub.requests[0].headers["x-api-key"], undefined);
});

test("health: 200 and 503 both return the body, no retry", async () => {
  stub.push({ status: 200, body: { ok: true, store_writable: true, pending: 0, dead: 0, oldest_pending_age_s: null } });
  const ok = await mk().health();
  assert.equal(ok.ok, true); assert.equal(ok.status, 200);
  stub.push({ status: 503, body: { ok: false, store_writable: false } });
  const bad = await mk().health();
  assert.equal(bad.ok, false); assert.equal(bad.status, 503);
  assert.equal(sleeps.length, 0);
});

test("client-side guards: source, non-object extra, missing idempotencyKey, missing apiKey", async () => {
  const c = mk();
  await assert.rejects(c.submitLead({ ...lead, source: "x" }, { idempotencyKey: "A" }), TypeError);
  await assert.rejects(c.submitLead({ ...lead, extra: "nope" }, { idempotencyKey: "A" }), TypeError);
  await assert.rejects(c.submitLead(lead, {}), TypeError);
  await assert.rejects(new IntakeClient({ baseUrl: stub.url }).submitLead(lead, { idempotencyKey: "A" }), TypeError);
  assert.equal(stub.requests.length, 0);
});

test("http:// base URL is rejected unless loopback", () => {
  assert.throws(() => new IntakeClient({ baseUrl: "http://intake.hellojade.ai" }), /https/);
  assert.doesNotThrow(() => new IntakeClient({ baseUrl: "http://localhost:9095" }));
  assert.doesNotThrow(() => new IntakeClient({ baseUrl: "https://intake.hellojade.ai/" }));
});

test("duplicate X-Request-Id / Retry-After headers (edge + app) read as the FIRST value", async () => {
  stub.push({ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": ["2", "2"], "x-request-id": ["a", "a"] } }, { status: 202, body: ACCEPTED, headers: { "x-request-id": ["a", "a"] } });
  const out = await mk().submitLead(lead, { idempotencyKey: "A" });
  assert.equal(out.requestId, "a");
  assert.deepEqual(sleeps, [2000]);
  stub.push({ status: 401, body: { error: "unauthorized" }, headers: { "x-request-id": ["b", "b"] } });
  await assert.rejects(mk().submitLead(lead, { idempotencyKey: "A" }), (e) => e.requestId === "b");
  assert.equal(parseRetryAfter("3, 3"), 3);
});

test("fetch is invoked as a plain function (browser 'Illegal invocation' guard)", async () => {
  stub.push({ status: 202, body: ACCEPTED });
  const strict = function (url, init) { if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation"); return fetch(url, init); };
  const out = await mk({ fetch: strict }).submitLead(lead, { idempotencyKey: "A" });
  assert.equal(out.event_id, "evt_01");
});

test("parseRetryAfter: seconds, HTTP-date, garbage", () => {
  assert.equal(parseRetryAfter("5"), 5);
  assert.equal(parseRetryAfter("0"), 1);
  assert.equal(parseRetryAfter(null), 1);
  assert.equal(parseRetryAfter("garbage"), 1);
  const now = Date.UTC(2026, 8, 3, 12, 0, 0);
  assert.equal(parseRetryAfter(new Date(now + 4000).toUTCString(), now), 4);
});

test("randomId works with NO crypto global at all (Node 18, and any http:// origin)", async () => {
  // Node only exposed globalThis.crypto from v19, and browsers do not expose
  // WebCrypto on a non-secure origin. 0.1.0 dereferenced it unguarded and threw
  // TypeError on both; CI caught it on the Node 18 leg.
  await withCrypto(undefined, () => {
    const ids = new Set();
    for (let i = 0; i < 200; i++) {
      const id = randomId();
      assert.match(id, V4, "fallback id must still be v4-shaped");
      ids.add(id);
    }
    assert.equal(ids.size, 200, "fallback ids must be unique");
  });
});

test("randomId uses getRandomValues when randomUUID is absent (non-secure context)", async () => {
  let used = 0;
  await withCrypto({ getRandomValues: (b) => { used++; for (let i = 0; i < b.length; i++) b[i] = i * 7; return b; } }, () => {
    assert.match(randomId(), V4);
    assert.equal(used, 1);
  });
});

test("randomId prefers crypto.randomUUID when it exists", async () => {
  await withCrypto({ randomUUID: () => "11111111-2222-4333-8444-555555555555", getRandomValues: () => { throw new Error("must not be called"); } }, () => {
    assert.equal(randomId(), "11111111-2222-4333-8444-555555555555");
  });
});

test("a whole submitLead round trip survives a missing crypto global", async () => {
  stub.push({ status: 202, body: ACCEPTED });
  await withCrypto(undefined, async () => {
    const out = await mk().submitLead(lead, { idempotencyKey: "A" });
    assert.equal(out.event_id, "evt_01");
    assert.match(stub.requests.at(-1).headers["x-request-id"], V4);
  });
});
