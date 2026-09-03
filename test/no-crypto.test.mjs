// The Node 18 / non-secure-origin platform, reproduced on EVERY Node version.
//
// `node --test` runs each test file in its own process, so deleting the global
// here affects nothing else. That matters: v0.1.0 shipped a TypeError that only
// Node 18 could see, and the first fix for it shipped a second one that only
// Node 18 could see, because the condition was never reproducible locally.
// Now it is, everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomId, IntakeClient } from "../hellojade-intake.js";
import { startStub } from "./stub.mjs";

// Module bodies run after imports are evaluated and before any test callback,
// and randomId() reads globalThis.crypto lazily — so this lands in time.
delete globalThis.crypto;

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("the platform under test genuinely has no crypto global", () => {
  assert.equal(globalThis.crypto, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(globalThis, "crypto"), undefined,
    "not even a descriptor — this is exactly Node 18's shape, and what broke the first fix");
});

test("randomId still returns unique v4-shaped ids", () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) {
    const id = randomId();
    assert.match(id, V4);
    ids.add(id);
  }
  assert.equal(ids.size, 500);
});

test("a full submitLead round trip works with no crypto at all", async () => {
  const stub = await startStub();
  try {
    stub.push({ status: 202, body: { event_id: "evt_01", status: "accepted", received_at: "2026-09-03T00:00:00Z", flags: [] } });
    const client = new IntakeClient({ baseUrl: stub.url, apiKey: "test-key" });
    const out = await client.submitLead(
      { first_name: "Dana", last_name: "Whitfield", phone: "6305550142" },
      { idempotencyKey: "acme:A-1" },
    );
    assert.equal(out.event_id, "evt_01");
    assert.match(stub.requests.at(-1).headers["x-request-id"], V4);
  } finally { await stub.close(); }
});

test("checkKey works with no crypto at all", async () => {
  const stub = await startStub();
  try {
    stub.push({ status: 422, body: { error: "validation_failed", fields: { first_name: "required", last_name: "required", phone: "required" } } });
    const out = await new IntakeClient({ baseUrl: stub.url, apiKey: "test-key" }).checkKey();
    assert.equal(out.valid, true);
    assert.deepEqual(out.required, ["first_name", "last_name", "phone"]);
  } finally { await stub.close(); }
});
