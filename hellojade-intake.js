/**
 * hellojade Partner Intake API — browser client.
 *
 * Zero dependencies, no build step. Uses only fetch, AbortController and
 * crypto, so the same file runs unchanged under Node 18+ (that is how the
 * unit tests exercise it).
 *
 * Contract: https://intake.hellojade.ai/api/openapi.json
 * Brief:    https://intake.hellojade.ai/api/INTEGRATION.md
 */

export const VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://intake.hellojade.ai";

const DEFAULT_RETRY = Object.freeze({
  maxAttempts: 5,
  maxRateLimitWaits: 10,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterMs: 500,
});

/** Base class for everything this client throws on purpose. */
export class IntakeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "IntakeError";
  }
}

/** The API answered with a status this client does not treat as success. */
export class ApiError extends IntakeError {
  constructor(message, { status, code, requestId, body, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.body = body;
  }
}

/** 422 — `fields` names EVERY failing field at once. Never retry as-is. */
export class ValidationError extends ApiError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = "ValidationError";
    this.fields = opts.fields || {};
  }
}

/** 429 — thrown only after the retry policy has waited `maxRateLimitWaits` times. */
export class RateLimitedError extends ApiError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = "RateLimitedError";
    this.retryAfter = opts.retryAfter;
  }
}

/** Network failure or timeout, after every retry has been used. */
export class TransportError extends IntakeError {
  constructor(message, { cause, attempts } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "TransportError";
    this.attempts = attempts;
  }
}

/* ------------------------------------------------------------------ */

/**
 * A v4-shaped id, for `X-Request-Id` and (in the element) `Idempotency-Key`.
 *
 * Three tiers, because `crypto` is not always there:
 *   1. `crypto.randomUUID()`      — the normal path
 *   2. `crypto.getRandomValues()` — WebCrypto present, `randomUUID` absent
 *   3. `Math.random()`            — no WebCrypto global at all
 *
 * 🔴 Tier 3 is not hypothetical. It is reached on **Node 18**, where
 * `globalThis.crypto` only became a global in Node 19, and in **any browser on
 * a non-secure origin**, where WebCrypto is not exposed at all — a plain
 * `http://` dev server is the usual case. Reaching for `c.getRandomValues`
 * without the guard is a `TypeError` on both, which is exactly what CI caught
 * on the Node 18 leg after 0.1.0 shipped.
 *
 * Tier 3 is safe HERE and nowhere else: both ids need to be **unique**, not
 * **unguessable**. A request id is a correlation handle, and an idempotency key
 * is scoped to a tenant and only usable by someone who already holds the API
 * key. Do not reuse this for a token, a nonce, a session id, or anything an
 * attacker benefits from predicting.
 */
export function randomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function assertBaseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new TypeError(`baseUrl is not a valid URL: ${raw}`);
  }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !loopback) {
    throw new TypeError(
      `baseUrl must be https:// (nothing listens on port 80 at intake.hellojade.ai, and it does not redirect); got ${raw}`,
    );
  }
  return u.origin + u.pathname.replace(/\/+$/, "");
}

/** Parse Retry-After as integer seconds or an HTTP-date. Floor is 1 s. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === "") return 1;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Math.max(1, Number(s));
  // The edge and the app may both set the header; Headers.get joins them with
  // ", ". An HTTP-date also contains a comma, so only split an integer list.
  const m = /^(\d+)\s*,/.exec(s);
  if (m) return Math.max(1, Number(m[1]));
  const t = Date.parse(s);
  if (Number.isNaN(t)) return 1;
  return Math.max(1, Math.ceil((t - now) / 1000));
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headerRequestId(res, fallback) {
  // The edge and the app both set X-Request-Id to the same value; take the first.
  const h = res.headers && res.headers.get ? res.headers.get("x-request-id") : null;
  if (!h) return fallback;
  return h.split(",")[0].trim();
}

/**
 * The client. One instance per API key; safe to share.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl=DEFAULT_BASE_URL]  https:// required unless loopback
 * @param {string} [options.apiKey]                    needed for submitLead / checkKey
 * @param {Function} [options.fetch=globalThis.fetch]
 * @param {number} [options.timeoutMs=20000]
 * @param {object} [options.retry]                     see DEFAULT_RETRY
 * @param {string} [options.idempotencyNamespace]      prefixed as `${ns}:${key}` (rule 3)
 * @param {Function} [options.sleep]                   injectable for tests
 * @param {Function} [options.random]                  injectable for tests
 */
export class IntakeClient {
  constructor(options = {}) {
    this.baseUrl = assertBaseUrl(options.baseUrl || DEFAULT_BASE_URL);
    this.apiKey = options.apiKey || null;
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== "function") {
      throw new TypeError("no fetch available; pass options.fetch");
    }
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.retry = { ...DEFAULT_RETRY, ...(options.retry || {}) };
    this.idempotencyNamespace = options.idempotencyNamespace || null;
    this.sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random || Math.random;
  }

  backoff(n) {
    const r = this.retry;
    return Math.min(r.maxDelayMs, r.baseDelayMs * 2 ** (n - 1)) + this.random() * r.jitterMs;
  }

  /**
   * Prove the key without creating a lead: POST `{}`. A 422 means the key
   * authenticated and nothing was stored; a 401 means it did not. Neither throws.
   * @returns {Promise<{valid:boolean,status:number,requestId:string,required:string[]}>}
   */
  async checkKey({ requestId, signal } = {}) {
    if (!this.apiKey) throw new TypeError("checkKey needs options.apiKey");
    const rid = requestId || randomId();
    const res = await this.#request("POST", "/v1/intake", {
      body: "{}",
      headers: { "X-API-Key": this.apiKey, "X-Request-Id": rid },
      signal,
      retry: true,
      // 401 and 422 are the two answers this check exists to distinguish.
      pass: (s) => s === 401 || s === 422,
    });
    const body = res.json;
    if (res.status === 422) {
      const required = Object.keys((body && body.fields) || {}).sort();
      return { valid: true, status: 422, requestId: res.requestId, required };
    }
    if (res.status === 401) {
      return { valid: false, status: 401, requestId: res.requestId, required: [] };
    }
    throw this.#toError(res);
  }

  /**
   * Submit one lead. `idempotencyKey` is REQUIRED and must be your own stable
   * id for the lead (rule 2), namespaced to you (rule 3).
   * @returns {Promise<{event_id:string,status:'accepted'|'duplicate',received_at:string,flags:string[],source?:string,requestId:string}>}
   */
  async submitLead(lead, { idempotencyKey, requestId, signal } = {}) {
    if (!this.apiKey) throw new TypeError("submitLead needs options.apiKey");
    if (!lead || typeof lead !== "object" || Array.isArray(lead)) {
      throw new TypeError("lead must be a plain object");
    }
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      throw new TypeError(
        "idempotencyKey is required: your own stable id for this lead (rule 2). Not a timestamp, not regenerated per attempt.",
      );
    }
    if (Object.prototype.hasOwnProperty.call(lead, "source")) {
      throw new TypeError("do not send `source` — it comes from your API key (rule 6)");
    }
    if (
      Object.prototype.hasOwnProperty.call(lead, "extra") &&
      (lead.extra === null || typeof lead.extra !== "object" || Array.isArray(lead.extra))
    ) {
      throw new TypeError("`extra` is reserved; if sent it must be a JSON object");
    }
    const key = this.idempotencyNamespace ? `${this.idempotencyNamespace}:${idempotencyKey}` : idempotencyKey;
    if (key.length > 200) throw new TypeError("Idempotency-Key exceeds 200 characters");
    const rid = requestId || randomId();
    const res = await this.#request("POST", "/v1/intake", {
      body: JSON.stringify(lead),
      headers: { "X-API-Key": this.apiKey, "Idempotency-Key": key, "X-Request-Id": rid },
      signal,
      retry: true,
      pass: (s) => s === 200 || s === 202,
    });
    if (res.status === 200 || res.status === 202) {
      const b = res.json || {};
      return {
        event_id: b.event_id,
        status: b.status || (res.status === 200 ? "duplicate" : "accepted"),
        received_at: b.received_at,
        flags: Array.isArray(b.flags) ? b.flags : [],
        source: b.source,
        requestId: res.requestId,
      };
    }
    throw this.#toError(res);
  }

  /** GET /v1/vocabulary — unauthenticated, cacheable 5 minutes. Fetch it; never hard-code it. */
  async vocabulary({ signal } = {}) {
    const res = await this.#request("GET", "/v1/vocabulary", { signal, retry: true, pass: (s) => s === 200 });
    if (res.status === 200) return res.json;
    throw this.#toError(res);
  }

  /** GET /healthz — returns the body on 200 AND on 503. No retries. */
  async health({ signal } = {}) {
    const res = await this.#request("GET", "/healthz", {
      signal,
      retry: false,
      pass: (s) => s === 200 || s === 503,
    });
    if (res.status === 200 || res.status === 503) return { ...(res.json || {}), status: res.status };
    throw this.#toError(res);
  }

  /* ---------------------------------------------------------------- */

  #toError(res) {
    const b = res.json || {};
    const base = { status: res.status, code: b.error, requestId: res.requestId, body: b };
    if (res.status === 422) {
      return new ValidationError(
        `intake: validation failed (${Object.keys(b.fields || {}).join(", ") || "no fields"})`,
        { ...base, fields: b.fields || {} },
      );
    }
    if (res.status === 429) {
      return new RateLimitedError("intake: rate limited for too long", { ...base, retryAfter: res.retryAfter });
    }
    return new ApiError(`intake: ${res.status} ${b.error || ""}`.trim(), base);
  }

  async #once(method, path, { body, headers, signal }) {
    const ctl = new AbortController();
    const onOuter = () => ctl.abort(signal.reason);
    if (signal) {
      if (signal.aborted) throw signal.reason || new Error("aborted");
      signal.addEventListener("abort", onOuter, { once: true });
    }
    const timer = this.timeoutMs > 0 ? setTimeout(() => ctl.abort(new Error(`timeout after ${this.timeoutMs} ms`)), this.timeoutMs) : null;
    // Call fetch as a plain function: invoking it as a method of this client
    // makes Chrome throw "Illegal invocation" (Node is lenient, so unit tests
    // alone would never catch it).
    const doFetch = this.fetch;
    try {
      const res = await doFetch(this.baseUrl + path, {
        method,
        headers: {
          Accept: "application/json",
          ...(body != null ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body,
        signal: ctl.signal,
        // Never let a browser attach cookies to a cross-origin API call.
        credentials: "omit",
      });
      const json = await readJson(res);
      return {
        status: res.status,
        json,
        requestId: headerRequestId(res, headers && headers["X-Request-Id"]),
        retryAfterRaw: res.headers && res.headers.get ? res.headers.get("retry-after") : null,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onOuter);
    }
  }

  /**
   * Rule 5: retry transport errors and 5xx with backoff; on 429 wait
   * max(Retry-After, backoff) WITHOUT consuming an attempt; any other 4xx
   * is returned immediately for the caller to raise.
   */
  async #request(method, path, { body, headers = {}, signal, retry, pass }) {
    const r = this.retry;
    const maxAttempts = retry ? r.maxAttempts : 1;
    let rateLimitWaits = 0;
    let lastRes = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res;
      try {
        res = await this.#once(method, path, { body, headers, signal });
      } catch (err) {
        if (signal && signal.aborted) throw err; // the caller canceled; not ours to retry
        if (!retry || attempt === maxAttempts) {
          throw new TransportError(`intake: ${method} ${path} failed after ${attempt} attempt(s): ${err && err.message}`, {
            cause: err,
            attempts: attempt,
          });
        }
        await this.sleep(this.backoff(attempt));
        continue;
      }
      lastRes = res;
      if (pass(res.status)) return res;
      if (res.status === 429 && retry) {
        const floor = parseRetryAfter(res.retryAfterRaw);
        rateLimitWaits += 1;
        if (rateLimitWaits > r.maxRateLimitWaits) {
          return { ...res, retryAfter: floor };
        }
        await this.sleep(Math.max(floor * 1000, this.backoff(rateLimitWaits)));
        attempt -= 1; // a rate-limit wait is not a delivery attempt
        continue;
      }
      if (res.status >= 500 && retry) {
        if (attempt === maxAttempts) return res;
        await this.sleep(this.backoff(attempt));
        continue;
      }
      return res; // any other 4xx: the body needs fixing, retrying will not help
    }
    return lastRes;
  }
}

export default IntakeClient;
