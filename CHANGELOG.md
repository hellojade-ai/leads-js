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
  `Idempotency-Key` namespacing; `AbortController` timeouts and caller cancellation;
  `crypto.randomUUID()` request ids with a `getRandomValues()` fallback for non-secure
  origins; and an exported `parseRetryAfter()` that handles integers, HTTP-dates and the
  duplicated header our edge and application both set.
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
- A `node:test` suite (28 tests) against a local stub covering every documented status code,
  the exact backoff sequence, and the client-side guards.
- A real-Chrome test harness (`test/browser/`, 21 checks) driving the element end to end
  against a stub API in a headless fleet instance, gating on zero console errors and zero
  horizontal overflow, with screenshots at 360 and 1280.
