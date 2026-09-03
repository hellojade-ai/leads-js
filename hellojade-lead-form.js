/**
 * <hellojade-lead-form> — a form-associated custom element that posts a lead
 * to the hellojade Partner Intake API (or to your own relay).
 *
 * Browser floor: Chrome 84 / Edge 84 / Firefox 98 / Safari 16.4.
 * Set by ElementInternals.setValidity (Firefox 98, Safari 16.4) and by the
 * #private methods in hellojade-intake.js (Chrome/Edge 84, Safari 15) — NOT by
 * attachInternals alone, which would understate Chrome by 7 versions.
 * Verified against MDN BCD 2026-09-03; the table is in README.md.
 *
 * Attributes
 *   api-key       your partner key. VISIBLE TO EVERY VISITOR — prefer relay-url.
 *   base-url      default https://intake.hellojade.ai (needs CORS for your origin)
 *   relay-url     POST the lead here instead, with no X-API-Key; your server
 *                 forwards it with the Node kit (@hellojade/intake)
 *   vocabulary-url  where to GET the project_area list. Defaults to
 *                 <base-url>/v1/vocabulary. In relay mode point it at a path
 *                 your own server proxies, and the page needs no CORS grant at
 *                 all. If the fetch fails the select becomes a free-text input,
 *                 so an unmappable area is still SENT rather than dropped.
 *   namespace     Idempotency-Key prefix (rule 3), e.g. "acme-site". DIRECT MODE
 *                 ONLY — in relay mode your server owns the prefix, where a
 *                 browser cannot tamper with it.
 *   heading       legend text (default "Request a quote")
 *   submit-label  button text (default "Send")
 *
 * Events (bubbling, composed)
 *   hellojade:accepted  detail = { event_id, status, flags, ... }
 *   hellojade:error     detail = the error (ValidationError, ApiError, ...)
 */
import { IntakeClient, ValidationError, ApiError, TransportError, randomId } from "./hellojade-intake.js";

const FIELDS = [
  { name: "first_name", label: "First name", required: true, autocomplete: "given-name", max: 100 },
  { name: "last_name", label: "Last name", required: true, autocomplete: "family-name", max: 100 },
  { name: "phone", label: "Phone", required: true, type: "tel", autocomplete: "tel", max: 40, hint: "Any format — at least 10 digits" },
  { name: "email", label: "Email", type: "email", autocomplete: "email", max: 254 },
  { name: "street_address", label: "Street address", autocomplete: "street-address", max: 200 },
  { name: "city", label: "City", autocomplete: "address-level2", max: 100 },
  { name: "state", label: "State / province", autocomplete: "address-level1", max: 100 },
  { name: "zip", label: "ZIP / postal code", autocomplete: "postal-code", max: 20, hint: "US 12345 or 12345-6789, CA A1A 1A1" },
  { name: "project_area", label: "Project area", kind: "area" },
  { name: "project_service", label: "Service", kind: "service" },
  { name: "project_details", label: "Tell us about the project", kind: "textarea", max: 4000 },
];
const SERVICES = ["replacement", "repair", "remodel", "maintain"];
const US_ZIP = /^\d{5}(-?\d{4})?$/;
const CA_POSTAL = /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/;

const STYLE = `
:host {
  --hj-accent: #0f6b5c;
  --hj-accent-contrast: #fff;
  --hj-text: #1c1c1c;
  --hj-muted: #5b5f66;
  --hj-border: #c9ced6;
  --hj-invalid: #b3261e;
  --hj-ok: #1b6e3a;
  --hj-bg: transparent;
  --hj-field-bg: #fff;
  --hj-radius: 8px;
  --hj-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  display: block;
  box-sizing: border-box;
  max-width: 100%;
  color: var(--hj-text);
  font: 16px/1.4 var(--hj-font);
  background: var(--hj-bg);
}
:host([hidden]) { display: none; }
*, *::before, *::after { box-sizing: inherit; }
form { display: block; min-width: 0; }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
legend { font-size: 1.25rem; font-weight: 600; margin: 0 0 .75rem; padding: 0; }
.grid { display: grid; grid-template-columns: 1fr; gap: .875rem; }
@media (min-width: 640px) {
  .grid { grid-template-columns: 1fr 1fr; }
  .grid > .wide { grid-column: 1 / -1; }
}
.f { display: flex; flex-direction: column; gap: .3rem; min-width: 0; }
label { font-weight: 500; }
label .req { color: var(--hj-invalid); margin-left: .15rem; }
.hint { color: var(--hj-muted); font-size: .85rem; }
input, select, textarea {
  font: inherit; color: inherit; width: 100%; max-width: 100%; min-width: 0;
  padding: .55rem .7rem; border: 1px solid var(--hj-border); border-radius: var(--hj-radius);
  background: var(--hj-field-bg);
}
textarea { min-height: 6rem; resize: vertical; }
input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible {
  outline: 2px solid var(--hj-accent); outline-offset: 2px;
}
input[aria-invalid="true"], select[aria-invalid="true"], textarea[aria-invalid="true"] {
  border-color: var(--hj-invalid); box-shadow: 0 0 0 1px var(--hj-invalid);
}
.err { color: var(--hj-invalid); font-size: .85rem; }
.err:empty { display: none; }
.actions { margin-top: 1rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
button {
  font: inherit; font-weight: 600; cursor: pointer; border: 0; border-radius: var(--hj-radius);
  padding: .7rem 1.4rem; background: var(--hj-accent); color: var(--hj-accent-contrast);
  transition: opacity .15s;
}
button[disabled] { opacity: .6; cursor: progress; }
.status { margin-top: .75rem; min-height: 1.4em; overflow-wrap: anywhere; }
.status[data-tone="ok"] { color: var(--hj-ok); }
.status[data-tone="error"] { color: var(--hj-invalid); }
.status ul { margin: .25rem 0 0; padding-left: 1.2rem; }
.hp { position: absolute; left: -10000px; top: auto; width: 1px; height: 1px; overflow: hidden; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
`;

export class HelloJadeLeadForm extends HTMLElement {
  static formAssociated = true;
  static get observedAttributes() { return ["heading", "submit-label"]; }

  #internals;
  #form;
  #inputs = new Map();
  #errs = new Map();
  #status;
  #button;
  #idempotencyKey = null;
  #client = null;
  #vocabLoaded = false;

  constructor() {
    super();
    this.#internals = this.attachInternals();
    const root = this.attachShadow({ mode: "open", delegatesFocus: true });
    root.innerHTML = `<style>${STYLE}</style>${this.#markup()}`;
    this.#form = root.querySelector("form");
    this.#status = root.querySelector(".status");
    this.#button = root.querySelector("button[type=submit]");
    for (const f of FIELDS) {
      const el = root.getElementById(`hj-${f.name}`);
      this.#inputs.set(f.name, el);
      this.#errs.set(f.name, root.getElementById(`hj-${f.name}-err`));
      el.addEventListener("input", () => this.#validateField(f.name, true));
      el.addEventListener("blur", () => this.#validateField(f.name, false));
    }
    this.#form.addEventListener("submit", (e) => { e.preventDefault(); this.#submit(); });
    this.#form.addEventListener("reset", () => queueMicrotask(() => this.#resetState()));
  }

  connectedCallback() {
    this.#applyText();
    this.#validateAll(true);
    this.#loadVocabulary();
  }

  attributeChangedCallback() { if (this.isConnected) this.#applyText(); }

  /* ---- form-associated surface -------------------------------------- */
  get form() { return this.#internals.form; }
  get name() { return this.getAttribute("name"); }
  get type() { return this.localName; }
  get validity() { return this.#internals.validity; }
  get validationMessage() { return this.#internals.validationMessage; }
  get willValidate() { return this.#internals.willValidate; }
  checkValidity() { return this.#internals.checkValidity(); }
  reportValidity() { return this.#internals.reportValidity(); }
  formResetCallback() { this.#form.reset(); this.#resetState(); }
  formDisabledCallback(disabled) { this.#button.disabled = disabled; }

  /** The lead as it would be posted (empty optional fields omitted). */
  get value() {
    const lead = {};
    for (const [name, el] of this.#inputs) {
      const v = (el.value || "").trim();
      if (v) lead[name] = v;
    }
    return lead;
  }

  /** The current Idempotency-Key (minted once per fill, reused on retry). */
  get idempotencyKey() {
    if (!this.#idempotencyKey) this.#idempotencyKey = randomId();
    return this.#idempotencyKey;
  }

  /* ---- internals ---------------------------------------------------- */
  #markup() {
    const field = (f) => {
      const id = `hj-${f.name}`;
      const req = f.required ? '<span class="req" aria-hidden="true">*</span>' : "";
      const describedBy = [f.hint ? `${id}-hint` : null, `${id}-err`].filter(Boolean).join(" ");
      const common = `id="${id}" name="${f.name}" aria-describedby="${describedBy}"${f.required ? " required" : ""}${f.autocomplete ? ` autocomplete="${f.autocomplete}"` : ""}${f.max ? ` maxlength="${f.max}"` : ""}`;
      let control;
      if (f.kind === "area") {
        control = `<select ${common}><option value="">— choose or leave blank —</option></select>`;
      } else if (f.kind === "service") {
        control = `<select ${common}><option value="">— choose or leave blank —</option>${SERVICES.map((s) => `<option value="${s}">${s}</option>`).join("")}</select>`;
      } else if (f.kind === "textarea") {
        control = `<textarea ${common} rows="4"></textarea>`;
      } else {
        control = `<input ${common} type="${f.type || "text"}"${f.type === "tel" ? ' inputmode="tel"' : ""}>`;
      }
      const wide = f.kind === "textarea" || f.name === "street_address" ? " wide" : "";
      return `<div class="f${wide}">
  <label for="${id}">${f.label}${req}</label>
  ${control}
  ${f.hint ? `<div class="hint" id="${id}-hint">${f.hint}</div>` : ""}
  <div class="err" id="${id}-err" aria-live="off"></div>
</div>`;
    };
    return `<form novalidate>
  <fieldset>
    <legend data-heading>Request a quote</legend>
    <div class="grid">${FIELDS.map(field).join("")}</div>
    <div class="hp" aria-hidden="true">
      <label for="hj-website">Website</label>
      <input id="hj-website" name="website" type="text" tabindex="-1" autocomplete="off">
    </div>
  </fieldset>
  <div class="actions">
    <button type="submit" data-submit>Send</button>
  </div>
  <div class="status" role="status" aria-live="polite"></div>
</form>`;
  }

  #applyText() {
    const r = this.shadowRoot;
    r.querySelector("[data-heading]").textContent = this.getAttribute("heading") || "Request a quote";
    r.querySelector("[data-submit]").textContent = this.getAttribute("submit-label") || "Send";
  }

  #clientFor() {
    const relay = this.getAttribute("relay-url");
    const baseUrl = relay ? relay : this.getAttribute("base-url") || undefined;
    const apiKey = relay ? null : this.getAttribute("api-key");
    if (!relay && !apiKey) throw new TypeError("<hellojade-lead-form> needs api-key or relay-url");
    if (!this.#client || this.#client._sig !== `${baseUrl}|${apiKey}|${relay}`) {
      this.#client = relay ? new RelayClient(relay) : new IntakeClient({ baseUrl, apiKey, idempotencyNamespace: this.getAttribute("namespace") || undefined });
      this.#client._sig = `${baseUrl}|${apiKey}|${relay}`;
    }
    return this.#client;
  }

  async #loadVocabulary() {
    if (this.#vocabLoaded) return;
    const sel = this.#inputs.get("project_area");
    try {
      const url = this.getAttribute("vocabulary-url");
      let v;
      if (url) {
        // A path your own server proxies: no API key, no cross-origin request,
        // so relay mode needs no CORS grant on the intake host at all.
        const res = await globalThis.fetch(new URL(url, document.baseURI).href, {
          headers: { Accept: "application/json" },
          credentials: "omit",
        });
        if (!res.ok) throw new Error(`vocabulary ${res.status}`);
        v = await res.json();
      } else {
        const c = new IntakeClient({ baseUrl: this.getAttribute("base-url") || undefined, retry: { maxAttempts: 2 } });
        v = await c.vocabulary();
      }
      const areas = (v && v.project_area) || [];
      if (!areas.length) throw new Error("empty vocabulary");
      for (const a of areas) {
        const o = document.createElement("option");
        o.value = a.area;
        o.textContent = a.area.replace(/_/g, " ");
        sel.appendChild(o);
      }
      this.#vocabLoaded = true;
    } catch (err) {
      // Vocabulary unreachable (no CORS on the intake host is the usual reason):
      // swap the select for free text so an unknown area is still SENT
      // (rule: never drop a value you cannot map).
      if (typeof console !== "undefined") console.warn("hellojade-lead-form: vocabulary unavailable, using free text —", err && err.message);
      const input = document.createElement("input");
      for (const a of ["id", "name", "aria-describedby"]) input.setAttribute(a, sel.getAttribute(a));
      input.type = "text";
      input.maxLength = 100;
      input.placeholder = "e.g. roof, siding, kitchen";
      sel.replaceWith(input);
      this.#inputs.set("project_area", input);
      input.addEventListener("input", () => this.#validateField("project_area", true));
    }
  }

  #fieldProblem(name) {
    const el = this.#inputs.get(name);
    const v = (el.value || "").trim();
    const f = FIELDS.find((x) => x.name === name);
    if (f.required && !v) return { flag: "valueMissing", msg: `${f.label} is required` };
    if (name === "phone" && v && (v.replace(/\D/g, "").length < 10)) return { flag: "patternMismatch", msg: "Enter a phone number with at least 10 digits" };
    if (name === "zip" && v && !US_ZIP.test(v) && !CA_POSTAL.test(v)) return { flag: "patternMismatch", msg: "Enter a US ZIP (12345 or 12345-6789) or a Canadian postal code (A1A 1A1)" };
    if (name === "email" && v && el.validity && el.validity.typeMismatch) return { flag: "typeMismatch", msg: "Enter a valid email address" };
    if (f.max && v.length > f.max) return { flag: "tooLong", msg: `${f.label} must be ${f.max} characters or fewer` };
    return null;
  }

  #mark(name, msg) {
    const el = this.#inputs.get(name);
    const err = this.#errs.get(name);
    if (msg) { el.setAttribute("aria-invalid", "true"); err.textContent = msg; }
    else { el.removeAttribute("aria-invalid"); err.textContent = ""; }
  }

  #validateField(name, quiet) {
    const p = this.#fieldProblem(name);
    if (!quiet || !p) this.#mark(name, p ? p.msg : "");
    this.#validateAll(true);
    return !p;
  }

  /** Mirror the inner state onto ElementInternals so the host form sees it. */
  #validateAll(quiet) {
    let first = null;
    const flags = {};
    for (const f of FIELDS) {
      const p = this.#fieldProblem(f.name);
      if (p) { flags[p.flag] = true; if (!first) first = { ...p, name: f.name }; }
      if (!quiet) this.#mark(f.name, p ? p.msg : "");
    }
    if (first) this.#internals.setValidity(flags, first.msg, this.#inputs.get(first.name));
    else this.#internals.setValidity({});
    this.#internals.setFormValue(JSON.stringify(this.value));
    return !first;
  }

  #setStatus(text, tone, list) {
    this.#status.dataset.tone = tone || "";
    this.#status.textContent = text;
    if (list && list.length) {
      const ul = document.createElement("ul");
      for (const l of list) { const li = document.createElement("li"); li.textContent = l; ul.appendChild(li); }
      this.#status.appendChild(ul);
    }
  }

  #resetState() {
    this.#idempotencyKey = null;
    this.removeAttribute("submitted");
    for (const f of FIELDS) this.#mark(f.name, "");
    this.#setStatus("", "");
    this.#validateAll(true);
  }

  #busy(on) {
    this.#button.disabled = on;
    this.#button.setAttribute("aria-busy", on ? "true" : "false");
    this.#form.setAttribute("aria-busy", on ? "true" : "false");
  }

  async #submit() {
    if (this.#button.disabled) return;
    if (!this.#validateAll(false)) {
      const bad = FIELDS.find((f) => this.#fieldProblem(f.name));
      this.#setStatus("Please fix the highlighted fields.", "error");
      this.#inputs.get(bad.name).focus();
      return;
    }
    // Honeypot: a bot filled the hidden field. Show success, send nothing.
    const hp = this.shadowRoot.getElementById("hj-website");
    if (hp && hp.value) {
      this.#setStatus("Thanks — we received your request.", "ok");
      this.setAttribute("submitted", "");
      return;
    }
    let client;
    try { client = this.#clientFor(); } catch (e) { this.#setStatus(e.message, "error"); return; }
    const lead = this.value;
    const key = this.idempotencyKey;
    this.#busy(true);
    this.#setStatus("Sending…", "");
    try {
      const accepted = await client.submitLead(lead, { idempotencyKey: key });
      this.#idempotencyKey = null; // a NEW fill gets a new key; a retry of this one reused it
      this.setAttribute("submitted", "");
      this.#setStatus(`Thanks — we received your request. Reference ${accepted.event_id}.`, "ok");
      this.dispatchEvent(new CustomEvent("hellojade:accepted", { detail: accepted, bubbles: true, composed: true }));
    } catch (err) {
      this.#renderError(err);
      this.dispatchEvent(new CustomEvent("hellojade:error", { detail: err, bubbles: true, composed: true }));
    } finally {
      this.#busy(false);
    }
  }

  #renderError(err) {
    if (err instanceof ValidationError) {
      const names = Object.keys(err.fields);
      const labels = [];
      for (const n of names) {
        const f = FIELDS.find((x) => x.name === n);
        const label = f ? f.label : n;
        const reason = err.fields[n] === "too_long" ? "is too long" : err.fields[n] === "required" ? "is required" : err.fields[n];
        labels.push(`${label} ${reason}`);
        if (this.#inputs.has(n)) this.#mark(n, `${label} ${reason}`);
      }
      this.#setStatus("We could not accept the request. Please check:", "error", labels);
      const first = names.find((n) => this.#inputs.has(n));
      if (first) this.#inputs.get(first).focus();
      return;
    }
    if (err instanceof TransportError) {
      this.#setStatus("We could not reach the server. Your entries are kept — please try again in a moment.", "error");
      return;
    }
    if (err instanceof ApiError) {
      const ref = err.requestId ? ` (reference ${err.requestId})` : "";
      if (err.status === 429) this.#setStatus(`Too many requests right now — please try again in a moment${ref}.`, "error");
      else if (err.status === 401) this.#setStatus(`This form is not configured correctly${ref}.`, "error");
      else this.#setStatus(`Something went wrong on our side — please try again${ref}.`, "error");
      return;
    }
    this.#setStatus(String(err && err.message ? err.message : err), "error");
  }
}

/**
 * Minimal client for `relay-url`: same submitLead signature, no API key, same
 * headers. The relay (your server) adds the key and forwards with the Node kit.
 */
class RelayClient {
  constructor(url) {
    this.url = new URL(url, typeof document !== "undefined" ? document.baseURI : "http://127.0.0.1/").href;
    // The placeholder baseUrl is never contacted: fetch is redirected to the relay below.
    this.inner = new IntakeClient({ baseUrl: "http://127.0.0.1", apiKey: "relay" });
  }
  async submitLead(lead, opts) {
    // Reuse the retry/timeout machinery; strip the placeholder key by
    // pointing fetch at a wrapper that removes it.
    const inner = this.inner;
    const f = globalThis.fetch;
    inner.fetch = (u, init) => {
      const headers = { ...init.headers };
      delete headers["X-API-Key"];
      return f(this.url, { ...init, headers });
    };
    return inner.submitLead(lead, opts);
  }
}

export function defineLeadForm(tagName = "hellojade-lead-form") {
  if (!customElements.get(tagName)) customElements.define(tagName, HelloJadeLeadForm);
}

if (typeof customElements !== "undefined") defineLeadForm();
