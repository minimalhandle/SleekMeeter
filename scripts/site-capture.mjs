// Makes the site's still images from Sleekmeeter's browser preview (the simulator in src/),
// using headless Microsoft Edge, so every theme is shot the same way.
//   1. Serve src/ (npm run preview, or any static server).
//   2. node scripts/site-capture.mjs http://localhost:8000
// Writes site/img/themes/<id>.webp (1440x812) and <id>-sm.webp (360x203), and site/img/mix.webp.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.argv[2] || "http://localhost:8000").replace(/\/$/, "");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "site", "img");
const EDGE = process.env.EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const THEMES = ["console", "oled", "afterburner", "lunar", "onyx", "opal", "glass", "neon", "terminal", "bubblegum", "blueprint", "block", "arcade", "peach", "sticker"];
const W = 1440, H = 812;

const profile = join(tmpdir(), "sleekmeeter-capture-" + process.pid);
const edge = spawn(EDGE, ["--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${profile}`, "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) { /* Edge is starting */ }
    await sleep(200);
  }
  throw new Error("Edge didn't start");
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const waiting = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { const { ok, no } = waiting.get(m.id); waiting.delete(m.id); m.error ? no(new Error(m.error.message)) : ok(m.result); }
});
const send = (method, params = {}) => new Promise((ok, no) => { const n = ++id; waiting.set(n, { ok, no }); ws.send(JSON.stringify({ id: n, method, params })); });
const run = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });

async function open(url, theme) {
  await send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(600);
  // The preview keeps its settings in localStorage: pick the theme, hide first-run questions.
  await run(`(() => { const s = JSON.parse(localStorage.getItem("sleekmeeter-preview-settings") || "{}");
    Object.assign(s, { theme: ${JSON.stringify(theme)}, usagePing: false, streamDeckOffered: "x" });
    localStorage.setItem("sleekmeeter-preview-settings", JSON.stringify(s)); })()`);
  await send("Page.navigate", { url });
  await sleep(2600); // meters settle
}
// A PNG of the page, turned into WebP at the given size by Edge itself.
async function shot(file, sizes) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  for (const [suffix, w, h, q] of sizes) {
    const url = await run(`new Promise((ok) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas");
      c.width = ${w}; c.height = ${h}; const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(i, 0, 0, ${w}, ${h});
      ok(c.toDataURL("image/webp", ${q})); }; i.src = "data:image/png;base64,${data}"; })`);
    const path = join(OUT, file + suffix + ".webp");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(url.split(",")[1], "base64"));
    console.log("wrote", path);
  }
}

for (const t of THEMES) {
  await open(`${BASE}/index.html?edition=2`, t);
  await shot(`themes/${t}`, [["", W, H, 0.86], ["-sm", 360, 203, 0.8]]);
}
// The output mix, popped out into its own window (Potato).
await open(`${BASE}/index.html?edition=3&mixwin`, "console");
// Give a few inputs a different level per output, as people use it: desktop and Discord
// quieter on the stream buses (B1–B3) than in the headphones (A1). Each wheel step is 0.5 dB.
await run(`(() => { const s = [...document.querySelectorAll(".mx-sl")];
  const wheel = (i, steps) => { for (let k = 0; k < Math.abs(steps); k++) s[i].dispatchEvent(new WheelEvent("wheel", { deltaY: steps < 0 ? 1 : -1, bubbles: true, cancelable: true })); };
  [[32, 6], [37, -20], [38, -20], [39, -20], [40, 4], [45, -30], [46, -30], [47, -30], [0, -4]].forEach(([i, n]) => wheel(i, n)); })()`);
await sleep(1200);
await shot("mix", [["", W, H, 0.88]]);

ws.close();
edge.kill();
await sleep(500);
try { rmSync(profile, { recursive: true, force: true }); } catch (_) { /* Edge may still hold it */ }
