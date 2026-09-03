# @hellojade/intake-browser (JavaScript, browser)

Browser client for the **hellojade Partner Intake API** — one `POST` that hands a lead to a
hellojade customer, durably, with idempotency and sane retries built in. Two files, no build
step, no bundler, no dependencies.

- **`hellojade-intake.js`** — `IntakeClient`, an ES module using only `fetch`,
  `AbortController` and `crypto`. The same file runs unchanged under Node 18+, which is how
  its unit tests exercise it.
- **`hellojade-lead-form.js`** — `<hellojade-lead-form>`, a form-associated custom element:
  shadow DOM, real constraint validation through `ElementInternals`, a `project_area` select
  built live from `GET /v1/vocabulary`, a honeypot, and a per-fill `Idempotency-Key`.
- A retry policy that follows the API's rules: 5xx and timeouts back off with jitter, `429`
  honors `Retry-After` without spending a delivery attempt, every other 4xx is final.
- Typed errors — `ApiError`, `ValidationError.fields`, `RateLimitedError.retryAfter`,
  `TransportError.attempts`.
- **A relay mode that keeps your API key off the page entirely.** Read
  [Two things that are only true in a browser](#two-things-that-are-only-true-in-a-browser)
  before you choose an architecture.

| | |
|---|---|
| API reference and live playground | <https://intake.hellojade.ai/api> |
| OpenAPI 3.0 contract | <https://intake.hellojade.ai/api/openapi.json> |
| Integration brief (the eight rules) | <https://intake.hellojade.ai/api/INTEGRATION.md> |
| Becoming a lead provider | <https://hellojade.ai/developers/provide-leads> |
| Other kits | [Go](https://github.com/hellojade-ai/leads-go) · [Node](https://github.com/hellojade-ai/leads-node) · [Python](https://github.com/hellojade-ai/leads-python) · [Ruby](https://github.com/hellojade-ai/leads-ruby) · [.NET](https://github.com/hellojade-ai/leads-dotnet) |

## Install

**This package is not published to npm.** It is consumed from GitHub. There is no CDN
either — we do not host one, and a third-party CDN is a script-injection surface on a page
that handles a visitor's phone number. Serve these files from your own origin.

`package.json` carries `"private": true` so `npm publish` is refused.

### Copy the two files (what most sites do)

```sh
curl -O https://raw.githubusercontent.com/hellojade-ai/leads-js/v0.1.0/hellojade-intake.js
curl -O https://raw.githubusercontent.com/hellojade-ai/leads-js/v0.1.0/hellojade-lead-form.js
```

They must sit **next to each other** — `hellojade-lead-form.js` imports
`./hellojade-intake.js` by relative path. Then:

```html
<script type="module" src="/assets/hellojade-lead-form.js"></script>
<hellojade-lead-form relay-url="/api/lead"></hellojade-lead-form>
```

Importing the element **defines it automatically** as `<hellojade-lead-form>`. If you only
want the client, import `hellojade-intake.js` alone — it defines nothing and touches no
globals.

### As a submodule

```sh
git submodule add https://github.com/hellojade-ai/leads-js.git third_party/leads-js
cd third_party/leads-js && git checkout v0.1.0 && cd -
```

### From a bundler

```sh
npm install github:hellojade-ai/leads-js#v0.1.0
```

```js
import { IntakeClient } from "@hellojade/intake-browser";
import "@hellojade/intake-browser/form";
```

| | |
|---|---|
| Package name | `@hellojade/intake-browser` |
| Version | `0.1.0` |
| Module format | ES module only (`"type": "module"`), no CommonJS build |
| Runtime dependencies | none |
| Build step | none |

## Two things that are only true in a browser

Everything else in this README matches the other kits. These two do not, and they decide
your architecture — read them before you write any code.

### 1. An API key in a browser is public

Anything that reaches a page is readable by every visitor: an HTML attribute, a module
constant, a value fetched from your own config endpoint. View-source and devtools are all it
takes. A leaked key lets anyone post leads under your label until it is rotated.

**So the default architecture is a server-side relay.** The element posts to *your* server
with no key at all; your server adds the key and forwards it with the
[Node kit](https://github.com/hellojade-ai/leads-node).

```html
<hellojade-lead-form relay-url="/api/lead" vocabulary-url="/api/vocabulary"></hellojade-lead-form>
```

A working relay is [`examples/relay-node.mjs`](examples/relay-node.mjs) — 38 lines,
comments included — and the page that uses it is [`examples/relay-usage.html`](examples/relay-usage.html). The
relay owns the `Idempotency-Key` prefix, which a browser cannot tamper with, and it is also
where a rate limit or an abuse rule belongs.

Direct mode (`api-key="…"`) exists because it is occasionally the right call — a low-value
key on a single landing page, scoped to one tenant, that you are willing to rotate. It is
not the default, and it is not a mode to reach for because the relay is inconvenient.

### 2. The intake host must allow your origin (CORS)

A cross-origin `POST` from a browser is not a normal request. Because it sends
`Content-Type: application/json` plus `X-API-Key`, `Idempotency-Key` and `X-Request-Id`, the
browser sends an `OPTIONS` preflight first and refuses the real request unless the response
allows your origin, your method and every one of those headers.

**`intake.hellojade.ai` does not allow arbitrary origins.** If you are using direct mode,
ask hellojade to allowlist your site's exact origin (scheme, host and port — `https://acme.com`
and `https://www.acme.com` are different origins) when your key is issued. Until then every
request fails in the browser with a CORS error and **no status code you can read**, which is
the confusing part: `submitLead` rejects with a `TransportError`, not a `401`, because the
browser never let the response through.

Relay mode sidesteps this completely — a same-origin `POST` to your own server needs no CORS
at all. That is the second reason it is the default.

## Quickstart

### 1. Prove the key first — from a terminal, not the browser

The API authenticates *before* it validates, so an empty body sent with a valid key comes
back `422` and nothing is stored, delivered or emailed. Do this before you write any code
and again on launch day. Run it from a shell or your server, where the key belongs:

```sh
curl -i -X POST https://intake.hellojade.ai/v1/intake \
  -H "X-API-Key: $HELLOJADE_API_KEY" \
  -H 'Content-Type: application/json' -d '{}'
```

`422` → the key is valid and active, and nothing was stored. `401` → missing, mistyped,
revoked, or pointed at the wrong host. The client has the same check when you are running it
under Node:

```js
import { IntakeClient } from "./hellojade-intake.js";

const client = new IntakeClient({ apiKey: process.env.HELLOJADE_API_KEY });
const check = await client.checkKey();
check.valid;     // true on 422, false on 401 — neither throws
check.required;  // ["first_name", "last_name", "phone"] — read from the live 422
check.requestId; // quote this to support; never the key
```

### 2. Drop in the element

```html
<script type="module" src="/assets/hellojade-lead-form.js"></script>

<hellojade-lead-form
  relay-url="/api/lead"
  vocabulary-url="/api/vocabulary"
  heading="Request a free roof inspection"
  submit-label="Request inspection"></hellojade-lead-form>

<script type="module">
  document.addEventListener("hellojade:accepted", (e) => {
    // e.detail = { event_id, status: "accepted" | "duplicate", flags, source, requestId }
    // Both statuses are success. Store event_id against your own record.
    window.gtag?.("event", "generate_lead", { form: "roof-inspection" });
    location.href = "/thanks";
  });
  document.addEventListener("hellojade:error", (e) => {
    // The element has already rendered the message; this is for your telemetry.
    console.warn("lead rejected", e.detail.name, e.detail.status, e.detail.requestId);
  });
</script>
```

That is the whole integration. The element renders the eleven fields the API models, marks
the three required ones, validates on input and blur, disables the button while sending,
announces the outcome in an `aria-live` region, and mints one `Idempotency-Key` per fill that
is reused across its own retries.

### 3. Or use the client without the element

For your own markup, a framework component, or a Node script — the same module, unchanged:

```js
import { IntakeClient, ValidationError, ApiError, TransportError } from "./hellojade-intake.js";

const client = new IntakeClient({
  apiKey: HELLOJADE_API_KEY,
  idempotencyNamespace: "acme-site",  // rule 3: keys go out as "acme-site:<id>"
});

const accepted = await client.submitLead(
  {
    first_name: "Dana",
    last_name: "Whitfield",
    phone: "(630) 555-0142",
    email: "dana.whitfield@example.com",
    street_address: "418 N Maple St",
    city: "Naperville",
    state: "IL",
    zip: "60540",
    country: "US",
    project_area: "roof",             // live list: await client.vocabulary()
    project_service: "replacement",   // replacement | repair | remodel | maintain
    project_material: "asphalt shingle",
    project_details: "Hail damage on the south slope, insurance claim already filed.",
    external_id: "A-99812",
    cost: 555.55,                     // omit if there is no charge — never send 0
    partner_job_id: "XZ-1",           // unmodeled keys are preserved under `extra`
  },
  { idempotencyKey: "A-99812", requestId: "acme-site/A-99812" },
);

accepted.event_id;    // "evt_0198f2c1a4b00000a3d19f4c2b7e" — store it against your lead
accepted.status;      // "accepted" (202) or "duplicate" (200) — both are success
accepted.flags;       // [] — non-fatal observations, never errors
accepted.source;      // your key's registered label
```

Only `first_name`, `last_name` and `phone` are required. Send everything you have and nothing
you do not — omit a field rather than sending `null` or a placeholder. Do **not** send
`source`: it comes from your API key, and `submitLead` throws a `TypeError` if you try (rule 6).

A full runnable version is [`examples/client-only.js`](examples/client-only.js).

### 4. Handle every outcome

```js
try {
  const accepted = await client.submitLead(lead, { idempotencyKey: `acme-site:${leadId}` });
} catch (err) {
  if (err instanceof ValidationError) {        // 422
    err.fields;      // { first_name: "required", phone: "required" } — ALL of them at once
    err.requestId;
  } else if (err instanceof RateLimitedError) { // 429, after the wait budget is spent
    err.retryAfter;  // seconds
  } else if (err instanceof ApiError) {         // 400, 401, 413, or a 5xx after retries
    err.status; err.code; err.requestId; err.body;
  } else if (err instanceof TransportError) {   // no response after retries — or a CORS block
    err.attempts; err.cause;
  } else {
    throw err;       // a TypeError from the client-side guards: a real bug in the call
  }
}
```

`ValidationError` and `RateLimitedError` both extend `ApiError`, so order the branches most
specific first. All four extend `IntakeError`.

## The `<hellojade-lead-form>` element

### Attributes

| attribute | what it does |
|---|---|
| `relay-url` | POST the lead here instead of to the intake host, with **no** `X-API-Key`. Relative URLs resolve against the page. **The recommended mode.** |
| `api-key` | direct mode. Visible to every visitor — see [above](#1-an-api-key-in-a-browser-is-public) |
| `base-url` | default `https://intake.hellojade.ai`. Must be `https://` unless it is loopback |
| `vocabulary-url` | where to `GET` the `project_area` list. Defaults to `<base-url>/v1/vocabulary`. Point it at a path your relay proxies and the page makes no cross-origin request at all |
| `namespace` | `Idempotency-Key` prefix (rule 3), e.g. `acme-site`. **Direct mode only** — in relay mode your server owns the prefix, where a browser cannot tamper with it |
| `heading` | legend text, default `Request a quote` |
| `submit-label` | button text, default `Send` |
| `submitted` | *set by the element* once a submission has been accepted |

`relay-url` wins if both it and `api-key` are present. With neither, the first submit shows a
configuration error and sends nothing.

### Events

Both bubble and cross the shadow boundary, so `document.addEventListener` works.

| event | `detail` |
|---|---|
| `hellojade:accepted` | `{ event_id, status, received_at, flags, source, requestId }` |
| `hellojade:error` | the thrown error — a `ValidationError`, `ApiError`, `RateLimitedError` or `TransportError` |

### Properties and methods

It is a real form control: put it inside a `<form>` and it participates.

| member | |
|---|---|
| `.value` | the lead as it would be posted — empty optional fields omitted |
| `.idempotencyKey` | the current key, minted once per fill and reused across retries |
| `.form` `.name` `.type` | standard form-associated surface |
| `.validity` `.validationMessage` `.willValidate` | mirrored onto `ElementInternals`, so the host form's own `checkValidity()` sees the fields inside the shadow root |
| `.checkValidity()` `.reportValidity()` | standard |
| `defineLeadForm(tagName?)` | exported, for registering under a different tag name |

### Styling

The shadow root keeps your page's CSS out. Style it through custom properties, which do cross
the boundary:

```css
hellojade-lead-form {
  --hj-accent: #0f6b5c;          --hj-accent-contrast: #fff;
  --hj-text: #1c1c1c;            --hj-muted: #5b5f66;
  --hj-border: #c9ced6;          --hj-field-bg: #fff;
  --hj-invalid: #b3261e;         --hj-ok: #1b6e3a;
  --hj-bg: transparent;          --hj-radius: 8px;
  --hj-font: system-ui, sans-serif;
}
```

The layout is one column below 640px and two above it, with street address and project details
spanning both. It has no horizontal overflow at any width — that is asserted in the browser
test at 360 and 1280.

### The parts worth knowing

- **The `project_area` select is built from `GET /v1/vocabulary` at connect time**, because
  that list grows by database insert with no deploy on our side. If the fetch fails — no CORS
  grant is the usual reason — the select is **replaced by a free-text input** rather than
  disappearing, so an area your visitor names is still sent. Never hard-code the list.
- **A hidden `website` field is a honeypot.** If it is filled the element shows the success
  state and sends nothing. Never fill it in a test that expects delivery.
- **Client-side validation is a courtesy, not the contract.** The server validates
  independently, and a `422` re-marks the exact fields it named.
- **The `Idempotency-Key` is minted once per fill and cleared on a successful send**, so a
  retry of a failed submit reuses it and a genuinely new lead gets a new one.

## Client options

```js
new IntakeClient({
  apiKey: "…",                        // required for submitLead / checkKey
  baseUrl: "https://intake.hellojade.ai",  // the default. https:// only (loopback excepted)
  timeoutMs: 20000,                   // per request; the API bounds its own handler at 20 s
  idempotencyNamespace: "acme-site",  // prefixed as `${ns}:${key}` — rule 3
  retry: {
    maxAttempts: 5,                   // delivery attempts (a 429 does not consume one)
    maxRateLimitWaits: 10,            // consecutive 429s to wait out before throwing
    baseDelayMs: 1000,                // min(base * 2^(n-1), max) + random() * jitter
    maxDelayMs: 30000,
    jitterMs: 500,
  },
  fetch: globalThis.fetch,            // inject your own (tests, a proxy, a polyfill)
  sleep: (ms) => …,                   // injectable; the tests assert the backoff sequence
  random: Math.random,                // injectable, to make jitter deterministic
});
```

`baseUrl` is validated in the constructor: an `http://` URL throws a `TypeError` unless the
host is loopback, because nothing listens on port 80 at `intake.hellojade.ai` and it does not
redirect. That is the most common first-day failure, and it is better as a throw at startup
than a connection error at 2am.

## Client surface

| method | HTTP | returns |
|---|---|---|
| `checkKey({ requestId, signal })` | `POST /v1/intake` with `{}` | `{ valid, status, requestId, required }` — never throws on 401/422 |
| `submitLead(lead, { idempotencyKey, requestId, signal })` | `POST /v1/intake` | `{ event_id, status, received_at, flags, source, requestId }` on 202 or 200 |
| `vocabulary({ signal })` | `GET /v1/vocabulary` (unauthenticated) | `{ project_area: [{area,status}], project_service: [...], required: [...] }` |
| `health({ signal })` | `GET /healthz` (unauthenticated) | the body on both 200 and 503, plus `status` |
| `parseRetryAfter(value)` | *(exported function)* | seconds, floor 1 — handles integers, HTTP-dates and a duplicated header |

Every method takes an `AbortSignal`. Aborting it is **not** a transport error: the abort
reason propagates immediately and is never retried.

## Errors

| HTTP | API `error` | thrown | retried? | what to do |
|---|---|---|---|---|
| 202 | — | *(returns, `status: "accepted"`)* | — | store `event_id`; done |
| 200 | — | *(returns, `status: "duplicate"`)* | — | same `event_id` as before; done |
| 400 | `invalid_json` | `ApiError` | no | log, alert |
| 401 | `unauthorized` | `ApiError` | no | fix the key or host; see the key check |
| 413 | `body_too_large` | `ApiError` | no | body over 64 KiB — trim `project_details` |
| 422 | `validation_failed` | `ValidationError` (`.fields`) | no | fix every listed field |
| 429 | `rate_limited` | `RateLimitedError` (`.retryAfter`) only after the wait budget | yes — waits `max(Retry-After, backoff)` | usually nothing; back off further if sustained |
| 503 | `not_accepting` | `ApiError` after `maxAttempts` | yes — exponential backoff | this is hellojade's side |
| other 5xx | — | `ApiError` after `maxAttempts` | yes | |
| no response | — | `TransportError` after `maxAttempts` | yes | check `https://`, egress, DNS — **and CORS** |

Every `ApiError` carries `requestId` (from the body, or the `X-Request-Id` header when the
body has none), `status`, `code` and the parsed `body`. Quote the `requestId` — or the
`event_id` — in any support conversation. Never the key.

🔴 **In a browser, a CORS block looks exactly like the server being down.** The browser
refuses the response before your code sees it, so you get a `TransportError` after the full
retry sequence rather than the `401` or `202` the server actually sent. If a request works
from `curl` and fails from the page, it is CORS, not the API.

## Retry and idempotency semantics

1. **Always pass `idempotencyKey`, and make it your own stable id for the lead**, namespaced
   to you: `acme-site:1234`, not `1234`, not a timestamp, not a fresh UUID per attempt.
   Dedupe is scoped to the *tenant*, so a bare `1234` can collide with another source's lead
   and yours is silently never stored. The client refuses an empty key, and one over 200
   characters, with a `TypeError` before any request goes out. The element mints one UUID per
   fill, which satisfies this.
2. A repeat of an accepted key returns `200` with the **original** `event_id` and status
   `duplicate`. That is success — it is what a retry is supposed to produce.
3. **Retries are automatic** for transport errors and 5xx, with exponential backoff plus
   jitter, up to `maxAttempts`. The same `Idempotency-Key` **and the same `X-Request-Id`** go
   out on every attempt, so a request that actually arrived cannot create a duplicate, and one
   correlation id covers the whole sequence in our logs.
4. **`429` waits `max(Retry-After, backoff(n))`** and does not consume a delivery attempt, so
   a rate limit cannot exhaust your retries. `Retry-After` is a floor, not a strategy, so the
   wait grows with consecutive 429s; with no header the floor is one second. After
   `maxRateLimitWaits` consecutive 429s it throws `RateLimitedError`.
5. **Any other 4xx is never retried.** A `422` means the body needs fixing; a `401` means the
   configuration does.
6. **Flags are not errors.** `phone_unnormalized`, `project_area_unknown`,
   `project_service_unknown`, `email_shape_suspect`, `extra_fields_preserved` and
   `country_unrecognized` arrive on a *successful* response, in `.flags`. Read them, do not
   retry on them, do not treat them as a failure.
7. A `422` does not consume the `Idempotency-Key`; send the same key again with a fixed body.
8. `requestId` — pass your own correlation id (up to 64 chars) or let the client generate one.
   It is sent as `X-Request-Id`, echoed in the response header, and appears in any error body.
   Our edge and our application both set that header, so it can arrive twice; the client takes
   the first value, and does the same for a duplicated `Retry-After`.
9. **Cancellation is not a transport error.** Aborting the `AbortSignal` you passed propagates
   immediately; it is never retried and never wrapped.

## Browser support

There is no build step, so these are the versions that run the source as written. Every
number below is MDN Browser Compatibility Data, read 2026-09-03 — not an estimate.

| feature | BCD key | Chrome | Edge | Firefox | Safari |
|---|---|---|---|---|---|
| Custom elements v1 | `api.CustomElementRegistry.define` | 54 | 79 | 63 | 10.1 |
| `AbortController` | `api.AbortController` | 66 | 16 | 57 | 12.1 |
| `attachInternals()` | `api.HTMLElement.attachInternals` | 77 | 79 | 93 | 16.4 |
| **Private class methods** (`#request`) | `javascript.classes.private_class_methods` | **84** | **84** | 90 | **15** |
| `ShadowRoot` `delegatesFocus` | `api.ShadowRoot.delegatesFocus` | 53 | 79 | 94 | 15 |
| `ElementInternals.setValidity()` | `api.ElementInternals.setValidity` | 77 | 79 | **98** | **16.4** |
| `crypto.randomUUID()` | `api.Crypto.randomUUID` | 92 | 92 | 95 | 15.4 |

| | minimum |
|---|---|
| **`<hellojade-lead-form>`** | **Chrome 84 · Edge 84 · Firefox 98 · Safari 16.4** |
| **`IntakeClient` alone** | **Chrome 84 · Edge 84 · Firefox 90 · Safari 15** |

Two of those are worth naming, because the obvious answer is wrong in both directions:

- **The client's floor is a language feature, not a Web API.** `fetch` and `AbortController`
  reach back to Safari 12.1, but the class uses `#private` **methods**, which Safari did not
  ship until 15. Quoting the API floor would have promised four Safari versions that cannot
  parse the file at all.
- **`crypto.randomUUID()` is in neither floor**, and neither is WebCrypto at all. Request
  ids and idempotency keys come from a three-tier `randomId()`: `crypto.randomUUID()`, then
  `crypto.getRandomValues()`, then `Math.random()`. The last tier exists because a browser on
  a **non-secure origin exposes no `crypto` object whatsoever** — any plain `http://` dev
  server — and because Node only made `globalThis.crypto` a global in v19, which is what broke
  0.1.0 on its own declared Node 18 floor. Both ids need to be *unique*, not *unguessable*, so
  the fallback is sound here; do not reuse `randomId()` for a token or a nonce.

Internet Explorer is not supported and never will be; it has no custom elements at all.
There is no polyfill path and no transpiled build. To reach older browsers, use `IntakeClient`
with your own markup, or post to your relay from a plain `<form>`.

## Development

```sh
npm run check         # syntax check of both modules
npm test              # node:test against a local stub — 28 tests, no network
npm run test:browser  # real Chrome — 21 checks; LOCAL ONLY, see below
```

`npm test` runs the same `hellojade-intake.js` a browser loads; it needs no shim because the
module uses only `fetch`, `AbortController` and `crypto`. It scripts every documented status
code (200, 202, 400, 401, 413, 422, 429, 500, 503, plus timeouts, connection refusals and
caller cancellation) against a local `node:http` stub, asserts the exact backoff sequence, that
a 429 does not consume an attempt, and that the same `Idempotency-Key` is resent on every
retry. Nothing in it touches the real API.

`npm run test:browser` starts a static server and a stub intake API, checks out a **headless**
Chrome instance from the local fleet, exercises the element end to end — 202, 200 duplicate,
422 field errors, 503 and 429 retries, client-side validation, the honeypot, relay mode, the
`vocabulary-url` proxy, labels and the live region — and writes screenshots at 360 and 1280 to
`test/browser/out/`. It gates on zero console errors and zero horizontal overflow, and **read
the screenshots**: the gates cannot see overlapping text or a wrapped label.

🔴 **The browser test is deliberately not in CI.** It drives a real Chrome from the fleet on
the maintainer's machine, and a workflow that cannot pass is worse than an honest note. CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `npm run check` and `npm test`
on Node 18/20/22/24 on Linux, plus Node 22 on macOS and Windows. The browser test is run
before every tag — see [CONTRIBUTING.md](CONTRIBUTING.md#releasing).

Never post a real-looking lead to production while developing: real names and phone numbers
reach a real salesperson's phone. The only live call that is ever appropriate is the key check
(`POST {}` → `422`), which stores nothing. If you need a live round trip, ask hellojade for a
sandbox key.

## Releasing

Tags on GitHub only — this package is **not** published to npm, and CI does not publish
anywhere. See [CONTRIBUTING.md](CONTRIBUTING.md#releasing).

## License

[MIT](LICENSE) © hellojade
