// Pin the viewport, screenshot, and measure horizontal overflow in ONE CDP
// session. An Emulation override lives and dies with its session, so setting
// the width in one process and measuring in the next reads whatever width the
// window happened to be left at.
//
//   node test/browser/cdp-shot.mjs <port> <width> <out.png>
//
// Prints {file,width,sw,cw,iw,overflow} on stdout. Node 22+ (global WebSocket).
import { writeFileSync } from "node:fs";

const [port, wRaw, out] = process.argv.slice(2);
const width = Number(wRaw);
if (!port || !Number.isFinite(width) || !out) {
  console.error("usage: cdp-shot.mjs <port> <width> <out.png>");
  process.exit(2);
}
const HEIGHT = { 360: 780, 414: 800, 768: 1024, 1024: 800, 1280: 900, 1440: 900 };

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && /^https?:/.test(t.url)) || targets.find((t) => t.type === "page");
if (!page) { console.error("no page target on :" + port); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP websocket failed")); });

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  // A CDP reply is {id, result} or {id, error}. `result` is the METHOD's own
  // envelope — for Runtime.evaluate that is {result:{type,value}}, so the
  // caller unwraps one more level. Resolving `m` itself here would hand every
  // caller the transport frame instead of the payload.
  const m = JSON.parse(e.data);
  if (!m.id || !pending.has(m.id)) return;
  const { res, rej } = pending.get(m.id);
  pending.delete(m.id);
  m.error ? rej(new Error(`${m.error.message} (code ${m.error.code})`)) : res(m.result);
};
const send = (method, params = {}) =>
  new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value; // one unwrap past send()'s envelope
};

try {
  await send("Page.bringToFront"); // headless background tabs do not rasterize
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height: HEIGHT[width] || 900,
    deviceScaleFactor: width < 768 ? 2 : 1,
    mobile: width < 768,
  });
  // Two frames plus a beat: geometry read before layout settles reports the
  // PREVIOUS width, which every overflow check reads as clean.
  await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,250))))");
  const v = await evaluate(
    "({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, iw: innerWidth})",
  );
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(out, Buffer.from(data, "base64"));
  await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  console.log(JSON.stringify({ file: out, width, ...v, overflow: v.sw > v.cw }));
} catch (err) {
  console.error(String(err && err.message ? err.message : err));
  process.exitCode = 1;
} finally {
  ws.close();
}
