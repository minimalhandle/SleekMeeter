/* Sleekmeeter mixer UI, part 11 of 14: Level history and the mic clip warning.
   The parts load in order from index.html as plain scripts sharing one global scope (see
   src/app/README.md), so anything declared at the top of one part is visible in the others. */
"use strict";

/* ---------- level history ---------- */
const HI = () => (settings.history = Object.assign({}, DEFAULT_SETTINGS.history, settings.history));
$("#historyOn").addEventListener("change", (e) => { HI().on = e.target.checked; saveSettings(); });
const historyDlg = $("#historyDlg"), histCanvas = $("#histCanvas");
const HIST_RANGES = [[5, "5 min"], [15, "15 min"], [60, "1 hour"], [180, "3 hours"]];
let histMinutes = 15, histTimer = null, histData = null;
const histHidden = new Set();
const colorCache = new Map();
function chanColor(key) {
  const ch = chans.find((c) => c.prefix === key);
  const name = ch ? look(ch).color : "slate";
  if (!colorCache.has(name)) {
    const el = document.createElement("span");
    el.dataset.color = name; el.hidden = true;
    document.body.appendChild(el);
    colorCache.set(name, getComputedStyle(el).getPropertyValue("--acc").trim() || "#8aa");
    el.remove();
  }
  return colorCache.get(name);
}
const chanName = (key) => { const ch = chans.find((c) => c.prefix === key); return ch ? displayName(ch) : key; };
const fmtSecs = (s) => (s < 1 ? "none" : s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
function buildHistControls() {
  const seg = $("#histRange");
  seg.textContent = "";
  for (const [m, label] of HIST_RANGES) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "tog"; b.textContent = label;
    b.setAttribute("aria-pressed", String(m === histMinutes));
    b.addEventListener("click", () => { histMinutes = m; buildHistControls(); refreshHistory(); });
    seg.appendChild(b);
  }
}
function drawHistory() {
  const d = histData, c = histCanvas;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 640, h = 240;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const cs = getComputedStyle(document.body);
  const ink = cs.getPropertyValue("--ink-2").trim() || "#999", red = cs.getPropertyValue("--red").trim() || "#f55", rail = cs.getPropertyValue("--rail").trim() || "#444";
  const L = 38, R = 8, T = 8, B = 20, MAXDB = 6, MINDB = -60;
  const X = (i, n) => L + ((w - L - R) * i) / Math.max(1, n - 1);
  const Y = (db) => T + ((MAXDB - Math.max(MINDB, Math.min(MAXDB, db))) / (MAXDB - MINDB)) * (h - T - B);
  g.font = "11px system-ui, sans-serif"; g.textBaseline = "middle"; g.lineWidth = 1;
  for (const db of [0, -10, -20, -40, -60]) {
    g.strokeStyle = db === 0 ? red : rail; g.globalAlpha = db === 0 ? 0.9 : 0.6;
    g.beginPath(); g.moveTo(L, Y(db) + 0.5); g.lineTo(w - R, Y(db) + 0.5); g.stroke();
    g.globalAlpha = 1; g.fillStyle = db === 0 ? red : ink; g.textAlign = "right";
    g.fillText(String(db), L - 6, Y(db));
  }
  g.textAlign = "left"; g.fillStyle = ink; g.textBaseline = "alphabetic";
  g.fillText(`−${HIST_RANGES.find((r) => r[0] === histMinutes)[1]}`, L, h - 4);
  g.textAlign = "right"; g.fillText("now", w - R, h - 4);
  if (!d) return;
  const dots = [];
  d.keys.forEach((key, i) => {
    if (histHidden.has(key)) return;
    const s = d.series[i], n = s.length;
    g.strokeStyle = chanColor(key); g.lineWidth = 1.6; g.lineJoin = "round";
    g.beginPath();
    let pen = false;
    s.forEach((v, j) => {
      if (v == null || v <= MINDB) { pen = false; return; }
      const x = X(j, n), y = Y(v);
      if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y);
      if (v >= 0) dots.push([x, y]);
    });
    g.stroke();
  });
  g.fillStyle = red;
  for (const [x, y] of dots) { g.beginPath(); g.arc(x, y, 2.6, 0, 7); g.fill(); }
}
function renderHistory() {
  const d = histData;
  const empty = !d || !d.stats.some((s) => s.peak != null);
  $("#histEmpty").hidden = !empty;
  const keysEl = $("#histKeys");
  keysEl.textContent = "";
  if (d) for (const key of d.keys) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "hist-key";
    b.setAttribute("aria-pressed", String(!histHidden.has(key)));
    b.style.setProperty("--k", chanColor(key));
    b.textContent = chanName(key);
    b.addEventListener("click", () => { if (histHidden.has(key)) histHidden.delete(key); else histHidden.add(key); renderHistory(); });
    keysEl.appendChild(b);
  }
  const stats = $("#histStats");
  stats.textContent = "";
  if (d && !empty) {
    const head = document.createElement("div");
    head.className = "hist-row head";
    head.innerHTML = "<span>Channel</span><span>Loudest</span><span>Over 0 dB</span><span>Had sound</span>";
    stats.appendChild(head);
    for (const s of d.stats) {
      if (s.peak == null) continue;
      const row = document.createElement("div");
      row.className = "hist-row";
      if (s.clipSeconds > 0) row.dataset.clip = "1";
      const cells = [chanName(s.key), `${s.peak > 0 ? "+" : ""}${s.peak.toFixed(1)} dB`, fmtSecs(s.clipSeconds), fmtSecs(s.activeSeconds)];
      for (const t of cells) row.appendChild(Object.assign(document.createElement("span"), { textContent: t }));
      stats.appendChild(row);
    }
  }
  drawHistory();
}
async function refreshHistory() {
  try { histData = await engine.historyGet(histMinutes); renderHistory(); } catch (e) { fail(e); }
}
function openHistory() {
  buildHistControls();
  historyDlg.showModal();
  refreshHistory();
  clearInterval(histTimer);
  histTimer = setInterval(refreshHistory, 2000);
}
historyDlg.addEventListener("close", () => { clearInterval(histTimer); histTimer = null; });
historyDlg.addEventListener("click", (e) => { if (e.target === historyDlg) historyDlg.close(); });
$("#historyOpen").addEventListener("click", () => { settingsDlg.close(); openHistory(); });
let histClearArmed = false;
$("#histClear").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  if (!histClearArmed) { histClearArmed = true; b.textContent = "Confirm"; setTimeout(() => { histClearArmed = false; b.textContent = "Clear"; }, 3000); return; }
  histClearArmed = false; b.textContent = "Clear";
  try { await engine.historyClear(); await refreshHistory(); } catch (err) { fail(err); }
});

/* ---------- mic level: clip warning and the level check ---------- */
const CW = () => (settings.clipWarn = Object.assign({}, DEFAULT_SETTINGS.clipWarn, settings.clipWarn));
function syncClip() {
  const c = CW();
  $("#clipOn").checked = !!c.on;
  document.querySelector('[data-needs="clip"]').classList.toggle("off", !c.on);
  const sel = $("#clipTarget");
  sel.textContent = "";
  for (const ch of chans) sel.appendChild(new Option(displayName(ch), ch.prefix));
  sel.value = c.target;
  if (sel.selectedIndex < 0) { sel.selectedIndex = 0; c.target = sel.value; }
}
$("#clipOn").addEventListener("change", (e) => { CW().on = e.target.checked; saveSettings(); syncClip(); });
$("#clipTarget").addEventListener("change", (e) => { CW().target = e.target.value; saveSettings(); });
