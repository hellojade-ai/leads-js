# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-09-03

First release.

### Added

- **`hellojade-intake.js`** — `IntakeClient` with `checkKey()`, `submitLead()`,
  `vocabulary()` and `health()`; typed errors (`IntakeError`, `ApiError`,
  `ValidationError.fields`, `RateLimitedError.retryAfter`, `TransportError.attempts`); the
  INTEGRATION.md retry policy (5xx and timeouts with jittered exponential backoff, `429`
  honoring `Retry-After` without consuming a delivery attempt, no retry on any other 4xx);
  `Idempotency-Key` namespacing; `AbortController` timeouts and caller cancellation; and an
  exported `parseRetryAfter()` that handles integers, HTTP-dates and the duplicated header
  our edge and application both set.
- **`hellojade-lead-form.js`** — `<hellojade-lead-form>`, a form-associated custom element:
  the eleven modeled fields, constraint validation mirrored onto `ElementInternals`, a
  `project_area` select built live from `GET /v1/vocabulary` that degrades to a free-text
  input when the fetch fails, a honeypot, a per-fill `Idempotency-Key`, an `aria-live`
  status region, `hellojade:accepted` / `hellojade:error` events, and CSS custom properties
  for theming.
- **`relay-url` mode** — post to your own server with no `X-API-Key`, so the key never
  reaches a browser. `vocabulary-url` lets the same server proxy the vocabulary, which
  removes the last cross-origin request and means a relay-mode page needs no CORS grant on
  the intake host at all.
- `examples/` — direct mode, relay mode, a 38-line Node relay, and client-only usage.
- A `node:test` suite (36 tests, two files) against a local stub covering every documented
  status code, the exact backoff sequence, the client-side guards, and a full round trip on
  a platform with **no `crypto` global**.
- A real-Chrome test harness (`test/browser/`, 21 checks) driving the element end to end
  against a stub API in a headless fleet instance, gating on zero console errors and zero
  horizontal overflow, with screenshots at 360 and 1280.

### Notes

- **`randomId()` has three tiers — `crypto.randomUUID()`, `crypto.getRandomValues()`, then
  `Math.random()` — and the third one is load-bearing.** A pre-release build dereferenced
  `crypto` unconditionally in the fallback and threw `TypeError` on Node 18, which only got
  `globalThis.crypto` in v19, and in any browser on a **non-secure origin**, where WebCrypto
  is not exposed at all — every plain `http://` dev server. `test/no-crypto.test.mjs` now
  deletes the global and re-runs the client against it, so that platform is exercised on
  every Node version rather than only on the one CI leg that could see it. The fallback is
  sound only because these ids must be *unique*, not *unguessable*; `randomId()` is not a
  source of secure randomness and its doc comment says so.
