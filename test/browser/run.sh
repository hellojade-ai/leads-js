#!/usr/bin/env bash
# Real-Chrome test for <hellojade-lead-form>. Local only: it needs the chrome
# fleet on this machine, so it is deliberately NOT part of CI (see README).
#
#   npm run test:browser        # or: bash test/browser/run.sh
#
# Self-contained: starts a static server and a stub intake API, checks out a
# HEADLESS fleet instance, drives it over CDP, writes screenshots to
# test/browser/out/, then releases the instance and stops the servers.
# Exits non-zero on the first failing assertion class.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/out"; mkdir -p "$OUT"
CHROME_ROOT=${CHROME_ROOT:-$HOME/cloud/playground/hellojade.ai/subdomains/chrome}
FLEET=$CHROME_ROOT/fleet
ENSURE=${ENSURE:-$HOME/.claude/skills/chrome-ops/scripts/ensure.sh}
D=${DRIVE:-$HOME/.claude/skills/chrome-ops/scripts/drive.mjs}
LABEL="leads-js-test-$$"

for bin in node jq; do command -v "$bin" >/dev/null || { echo "missing dependency: $bin"; exit 2; }; done
[ -x "$ENSURE" ] || { echo "chrome fleet not available at $ENSURE — this test is local-only"; exit 2; }

FAILS=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAILS=$((FAILS+1)); }

SRV=""; ID=""
cleanup() {
  [ -n "$ID" ] && "$FLEET/release.sh" "$ID" >/dev/null 2>&1
  [ -n "$SRV" ] && kill "$SRV" 2>/dev/null
  wait "$SRV" 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM

# ---- servers ---------------------------------------------------------------
rm -f "$OUT/servers.json"; : > "$OUT/servers.json"
node "$HERE/serve.mjs" > "$OUT/servers.json" &
SRV=$!
for _ in $(seq 1 100); do [ -s "$OUT/servers.json" ] && break; sleep 0.1; done
[ -s "$OUT/servers.json" ] || { echo "serve.mjs never printed its origins"; exit 1; }
STATIC=$(jq -r .static "$OUT/servers.json")
STUB=$(jq -r .stub "$OUT/servers.json")
echo "static=$STATIC stub=$STUB"

# ---- headless fleet instance ----------------------------------------------
# --keep pins it to handoff scope so a sibling agent's Stop hook or
# `release.sh --mine` cannot kill it mid-run (observed 2026-09-03). We release
# it by ID ourselves in cleanup().
INFO=$(FLEET_MAX=${FLEET_MAX:-12} "$ENSURE" "$LABEL" --url "about:blank" --purpose "leads-js browser test" --keep) || { echo "checkout failed"; exit 1; }
PORT=$(echo "$INFO" | jq -r .port); ID=$(echo "$INFO" | jq -r .id)
echo "fleet instance id=$ID port=$PORT label=$LABEL"
HEADLESS=$(node "$D" "$PORT" info | jq -r .headless)
[ "$HEADLESS" = "true" ] && pass "instance is headless" || fail "instance is not headless (got $HEADLESS)"

# ---- load, capturing the console from before the first byte ----------------
# `drive.mjs console` only sees what happens while it is attached, so start it
# BEFORE navigating. page.html also installs its own collector in <head>, which
# is the one that cannot miss a load-time throw.
node "$D" "$PORT" console 6000 > "$OUT/console-load.json" 2>/dev/null &
CONSOLE_PID=$!
sleep 0.4
node "$D" "$PORT" open "$STATIC/" >/dev/null || { echo "navigation failed"; exit 1; }
wait $CONSOLE_PID 2>/dev/null

if jq -e '[.[] | select(.type=="error" or .type=="exception")] | length == 0' "$OUT/console-load.json" >/dev/null 2>&1; then
  pass "clean page load: zero console errors and zero exceptions"
else
  fail "console errors during load: $(cat "$OUT/console-load.json")"
fi

# ---- helpers injected once -------------------------------------------------
ev() { node "$D" "$PORT" eval "$1" >/dev/null; }
check() { # name, js (must evaluate to exactly true)
  local r; r=$(node "$D" "$PORT" eval "$2" 2>&1 | tr -d '\n')
  if [ "$r" = "true" ]; then pass "$1"; else fail "$1 -> $r"; fi
}

ev '(() => { const H = (id) => ({
  el: () => document.getElementById(id),
  root: () => document.getElementById(id).shadowRoot,
  set(name, v) { const i = this.root().getElementById("hj-" + name); i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); },
  fill(o) { for (const k in o) this.set(k, o[k]); },
  submit() { this.root().querySelector("button[type=submit]").click(); },
  status() { return this.root().querySelector(".status").textContent; },
  // The element clears its own state in a microtask after the reset event
  // (the event fires before the controls are reset), so yield a macrotask
  // before filling — otherwise that clear lands on top of the new values.
  async reset() { this.root().querySelector("form").reset(); await new Promise((r) => setTimeout(r, 0)); },
});
window.__hj = H("form");
window.__relay = H("relayform");
window.__hj.wait = (fn, ms=8000) => new Promise((res, rej) => { const t0 = Date.now(); (function tick(){ try { const v = fn(); if (v) return res(v); } catch(e){} if (Date.now()-t0 > ms) return rej(new Error("timeout waiting; status=" + window.__hj.status())); setTimeout(tick, 50); })(); });
window.__hj.requests = async () => (await fetch("'"$STUB"'/__requests")).json();
window.__hj.resetStub = async () => (await fetch("'"$STUB"'/__reset")).json();
return true; })()'

# ---- structure -------------------------------------------------------------
check "element upgraded and is form-associated" \
  'customElements.get("hellojade-lead-form") !== undefined && window.__hj.el().constructor.formAssociated === true'
check "shadow root is open and the form rendered all 11 controls" \
  '(() => { const r = window.__hj.root(); return !!r && ["first_name","last_name","phone","email","street_address","city","state","zip","project_area","project_service","project_details"].every(n => r.getElementById("hj-" + n)); })()'
check "vocabulary populated the project_area select from GET /v1/vocabulary" \
  '(() => { const s = window.__hj.root().getElementById("hj-project_area"); return s.tagName === "SELECT" && [...s.options].some(o => o.value === "kitchen") && [...s.options].some(o => o.value === "roof"); })()'
check "vocabulary-url: the relay form built its select from the relay path, not the intake host" \
  '(() => { const s = window.__relay.root().getElementById("hj-project_area"); return s.tagName === "SELECT" && [...s.options].some(o => o.value === "gutters"); })()'
check "empty form is invalid through ElementInternals" \
  '!window.__hj.el().checkValidity() && window.__hj.el().validity.valueMissing === true'
check "a11y: every control has a <label for>, status is role=status aria-live=polite" \
  '(() => { const root = window.__hj.root(); const ids = ["first_name","last_name","phone","email","street_address","city","state","zip","project_area","project_service","project_details"]; const ok = ids.every(n => root.querySelector("label[for=hj-" + n + "]")); const s = root.querySelector(".status"); return ok && s.getAttribute("role") === "status" && s.getAttribute("aria-live") === "polite"; })()'
check "honeypot input is off-screen, aria-hidden and not tabbable" \
  '(() => { const i = window.__hj.root().getElementById("hj-website"); const cs = getComputedStyle(i.parentElement); return cs.display !== "none" && cs.position === "absolute" && i.parentElement.getAttribute("aria-hidden") === "true" && i.tabIndex === -1; })()'

# ---- 1. happy path: 202 ----------------------------------------------------
check "202 accepted: reference shown, hellojade:accepted dispatched, submitted attribute set" \
  '(async () => { await window.__hj.resetStub(); window.__events.length = 0; await window.__hj.reset(); window.__hj.fill({first_name:"Dana", last_name:"Whitfield", phone:"(630) 555-0142", email:"dana@example.com", zip:"60540", project_area:"roof", project_service:"replacement", project_details:"Hail damage"}); window.__hj.submit(); await window.__hj.wait(() => /Reference evt_/.test(window.__hj.status())); return window.__events.length === 1 && window.__events[0].type === "hellojade:accepted" && window.__events[0].detail.status === "accepted" && window.__hj.el().hasAttribute("submitted"); })()'
check "202 wire: X-API-Key, namespaced UUID Idempotency-Key, X-Request-Id, JSON body, no source, no honeypot" \
  '(async () => { const r = await window.__hj.requests(); if (r.length !== 1) return "n=" + r.length; const h = r[0].headers; const b = JSON.parse(r[0].body); return h["x-api-key"] === "test-key" && /^test-site:[0-9a-f-]{36}$/.test(h["idempotency-key"]) && typeof h["x-request-id"] === "string" && h["x-request-id"].length > 0 && h["content-type"] === "application/json" && b.first_name === "Dana" && b.phone === "(630) 555-0142" && b.project_area === "roof" && !("source" in b) && !("website" in b); })()'

# ---- 2. 503 then 202 -------------------------------------------------------
check "503 then 202: retried with the SAME Idempotency-Key and X-Request-Id" \
  '(async () => { await window.__hj.resetStub(); await window.__hj.reset(); window.__hj.fill({first_name:"Down", last_name:"Time", phone:"3125550188"}); window.__hj.submit(); await window.__hj.wait(() => /Reference evt_/.test(window.__hj.status())); const r = await window.__hj.requests(); return r.length === 2 && r[0].headers["idempotency-key"] === r[1].headers["idempotency-key"] && r[0].headers["x-request-id"] === r[1].headers["x-request-id"]; })()'

# ---- 3. 429 then 202 -------------------------------------------------------
check "429 then 202: waited at least Retry-After and did not consume an attempt" \
  '(async () => { await window.__hj.resetStub(); await window.__hj.reset(); window.__hj.fill({first_name:"Ratelimit", last_name:"Hit", phone:"3125550188"}); const t0 = Date.now(); window.__hj.submit(); await window.__hj.wait(() => /Reference evt_/.test(window.__hj.status())); const r = await window.__hj.requests(); return r.length === 2 && (Date.now() - t0) >= 1000; })()'

# ---- 4. 200 duplicate is success ------------------------------------------
check "200 duplicate is treated as success" \
  '(async () => { await window.__hj.resetStub(); window.__events.length = 0; await window.__hj.reset(); window.__hj.fill({first_name:"Dup", last_name:"Licate", phone:"3125550188"}); window.__hj.submit(); await window.__hj.wait(() => /Reference evt_/.test(window.__hj.status())); return window.__events[0].detail.status === "duplicate"; })()'

# ---- 5. 422: every failing field at once -----------------------------------
check "422: every failing field listed and marked aria-invalid, hellojade:error dispatched" \
  '(async () => { await window.__hj.resetStub(); window.__events.length = 0; await window.__hj.reset(); window.__hj.fill({first_name:"Missing", last_name:"X", phone:"3125550188"}); window.__hj.submit(); await window.__hj.wait(() => /check:/.test(window.__hj.status())); const root = window.__hj.root(); const s = window.__hj.status(); return /Last name is required/.test(s) && /Phone is required/.test(s) && root.getElementById("hj-last_name").getAttribute("aria-invalid") === "true" && root.getElementById("hj-phone").getAttribute("aria-invalid") === "true" && root.getElementById("hj-phone").getAttribute("aria-describedby").includes("hj-phone-err") && window.__events[0].type === "hellojade:error" && window.__events[0].detail.name === "ValidationError"; })()'
S422=$(node "$HERE/cdp-shot.mjs" "$PORT" 360 "$OUT/form-422-360.png"); echo "$S422"

# ---- 6. client-side constraint validation blocks the POST -------------------
check "client-side: short phone and bad ZIP block the submit, nothing is sent" \
  '(async () => { await window.__hj.resetStub(); await window.__hj.reset(); window.__hj.fill({first_name:"A", last_name:"B", phone:"555", zip:"abc"}); window.__hj.submit(); await new Promise(r => setTimeout(r, 400)); const root = window.__hj.root(); const r = await window.__hj.requests(); return r.length === 0 && root.getElementById("hj-phone").getAttribute("aria-invalid") === "true" && root.getElementById("hj-zip").getAttribute("aria-invalid") === "true" && /highlighted/.test(window.__hj.status()); })()'

# ---- 7. honeypot -----------------------------------------------------------
check "honeypot: a filled website field shows success and sends zero requests" \
  '(async () => { await window.__hj.resetStub(); await window.__hj.reset(); window.__hj.fill({first_name:"Bot", last_name:"Bot", phone:"3125550188"}); window.__hj.root().getElementById("hj-website").value = "http://spam.example"; window.__hj.submit(); await new Promise(r => setTimeout(r, 500)); const r = await window.__hj.requests(); return r.length === 0 && /received your request/.test(window.__hj.status()) && window.__hj.el().hasAttribute("submitted"); })()'

# ---- 8. relay mode: the key never reaches the browser ----------------------
check "relay-url: posts to the relay with NO X-API-Key and the same Idempotency-Key contract" \
  '(async () => { await window.__hj.resetStub(); window.__events.length = 0; await window.__relay.reset(); window.__relay.fill({first_name:"Relay", last_name:"Mode", phone:"3125550188"}); window.__relay.submit(); await window.__hj.wait(() => /Reference evt_relay_/.test(window.__relay.status())); const r = await window.__hj.requests(); return r.length === 1 && r[0].relay === true && !("x-api-key" in r[0].headers) && typeof r[0].headers["idempotency-key"] === "string" && JSON.parse(r[0].body).first_name === "Relay"; })()'

# ---- 9. screenshots + horizontal overflow ---------------------------------
node "$D" "$PORT" eval '(async () => { await window.__hj.reset(); await window.__relay.reset(); return true; })()' >/dev/null
S360=$(node "$HERE/cdp-shot.mjs" "$PORT" 360 "$OUT/form-360.png"); echo "$S360"
S1280=$(node "$HERE/cdp-shot.mjs" "$PORT" 1280 "$OUT/form-1280.png"); echo "$S1280"
for pair in "360:$S360" "1280:$S1280"; do
  w=${pair%%:*}; j=${pair#*:}
  if echo "$j" | jq -e '.overflow == false' >/dev/null 2>&1; then pass "no horizontal overflow at $w"; else fail "horizontal overflow at $w: $j"; fi
done
echo "screenshots: $OUT/form-360.png $OUT/form-1280.png $OUT/form-422-360.png"

# ---- 10. the page's own console collector, over the whole run ---------------
IN_PAGE=$(node "$D" "$PORT" eval 'JSON.stringify(window.__console)')
if [ "$IN_PAGE" = '"[]"' ]; then pass "zero page console errors/warnings across the whole run"; else fail "page console: $IN_PAGE"; fi

echo "RESULT: $FAILS failure(s)"
[ "$FAILS" -eq 0 ]
