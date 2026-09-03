// Using IntakeClient without the element — e.g. from your own form handler.
// Runs in the browser (module script) and, unchanged, under Node 18+.
import { IntakeClient, ValidationError, ApiError, TransportError } from "../hellojade-intake.js";

const client = new IntakeClient({
  apiKey: globalThis.HELLOJADE_API_KEY || "REPLACE_WITH_YOUR_PARTNER_KEY",
  idempotencyNamespace: "acme-site", // rule 3: keys are sent as "acme-site:<id>"
  timeoutMs: 20000,
});

// 1. The key check FIRST. A 422 proves the key; nothing is stored.
const check = await client.checkKey();
console.log(check.valid ? `key OK, required: ${check.required.join(", ")}` : `key rejected (${check.status}, request ${check.requestId})`);

// 2. Submit one lead. idempotencyKey = YOUR stable id for this lead.
try {
  const accepted = await client.submitLead(
    { first_name: "Dana", last_name: "Whitfield", phone: "(630) 555-0142", project_area: "roof", project_service: "replacement" },
    { idempotencyKey: "lead-99812" },
  );
  console.log(accepted.status, accepted.event_id, accepted.flags); // "accepted" | "duplicate" — both are success
} catch (err) {
  if (err instanceof ValidationError) console.error("fix these fields:", err.fields); // every failing field at once
  else if (err instanceof ApiError) console.error("api", err.status, err.code, err.requestId);
  else if (err instanceof TransportError) console.error("unreachable after retries", err.attempts);
  else throw err;
}

// 3. Vocabulary — fetch it, never hard-code it.
const vocab = await client.vocabulary();
console.log(vocab.project_area.map((a) => a.area));
