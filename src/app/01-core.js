/* Sleekmeeter mixer UI, part 1 of 14: Shared helpers, settings, the channel model, faders, meters and incoming state.
   The parts load in order from index.html as plain scripts sharing one global scope (see
   src/app/README.md), so anything declared at the top of one part is visible in the others. */
"use strict";

const { layoutFor, BUS_MODES, DEFAULT_SETTINGS, createEngine } = window.Sleekmeeter;
const { ICONS, COLORS, svg } = window.SleekIcons;
const engine = createEngine();
const $ = (s, el = document) => el.querySelector(s);
const clone = (o) => JSON.parse(JSON.stringify(o));

function bindTabs(root, change) {
  const tabs = [...root.querySelectorAll("[role=tab]")];
  function select(id, focus = false) {
    const active = tabs.find((b) => !b.hidden && b.dataset.tab === id) || tabs.find((b) => !b.hidden);
    for (const b of tabs) {
      b.tabIndex = b === active ? 0 : -1;
      b.setAttribute("aria-selected", String(b === active));
      document.getElementById(b.getAttribute("aria-controls")).hidden = b !== active;
    }
    if (focus) active.focus();
    change(active.dataset.tab);
  }
  root.addEventListener("click", (e) => {
    const tab = e.target.closest("[role=tab]");
    if (tab) select(tab.dataset.tab);
  });
  root.addEventListener("keydown", (e) => {
    const visible = tabs.filter((b) => !b.hidden), i = visible.indexOf(e.target);
    if (i < 0) return;
    const next = { ArrowLeft: (i - 1 + visible.length) % visible.length, ArrowRight: (i + 1) % visible.length,
      Home: 0, End: visible.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    select(visible[next].dataset.tab, true);
  });
  return select;
}

// The tray volume panel loads this same page with SLEEK_FLYOUT set (or ?panel in a browser).
const PANEL = !!window.SLEEK_FLYOUT || /[?&]panel\b/.test(location.search);
// The Output mix popped out into its own window (?mixwin in the browser preview).
const MIXWIN = !!window.SLEEK_MIXWIN || /[?&]mixwin\b/.test(location.search);
// Extra windows show a part of the mixer; the main window alone does updates, prompts and the like.
const SIDE = PANEL || MIXWIN;
let settings = clone(DEFAULT_SETTINGS);
let connected = null;
// False once Voicemeeter turns out not to be installed (for the setup guide).
let vmInstalled = true;
const reveal = { strip: false, bus: false };

/* ---------- fader taper (shared by faders, meters and the scale) ---------- */
// Piecewise taper: more travel around the useful -20…+6 dB range, like a real console.
const TAPER = [[-60, 0], [-40, 0.17], [-20, 0.44], [-10, 0.64], [0, 0.84], [12, 1]];
const MIN_DB = -60, MAX_DB = 12;
function dbToPos(db) {
  if (!(db > MIN_DB)) return 0;
  if (db >= MAX_DB) return 1;
  for (let i = 1; i < TAPER.length; i++) {
    const [d1, p1] = TAPER[i], [d0, p0] = TAPER[i - 1];
    if (db <= d1) return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
  }
  return 1;
}
function posToDb(p) {
  p = Math.max(0, Math.min(1, p));
  for (let i = 1; i < TAPER.length; i++) {
    const [d1, p1] = TAPER[i], [d0, p0] = TAPER[i - 1];
    if (p <= p1) return d0 + ((p - p0) / (p1 - p0)) * (d1 - d0);
  }
  return MAX_DB;
}
const rootStyle = document.documentElement.style;
rootStyle.setProperty("--p-yellow", dbToPos(-9) * 100 + "%");
rootStyle.setProperty("--p-zero", dbToPos(0) * 100 + "%");
rootStyle.setProperty("--p-zero-f", dbToPos(0));
const fmtDb = (db) => (db <= MIN_DB ? "−∞" : (db > 0.04 ? "+" : db < -0.04 ? "−" : "") + Math.abs(db).toFixed(1));

/* ---------- outgoing writes, coalesced to one per frame per parameter ---------- */
const pending = new Map();
let flushQueued = false;
function sendFloat(name, value) {
  pending.set(name, value);
  if (!flushQueued) {
    flushQueued = true;
    requestAnimationFrame(() => {
      flushQueued = false;
      for (const [n, v] of pending) engine.setFloat(n, v).catch(fail);
      pending.clear();
    });
  }
}
function fail(err) {
  const msg = String(err && err.message ? err.message : err);
  toast(msg);
  engine.log("warn", msg).catch(() => {});
}
// Anything that breaks in the window goes in the log file too.
window.addEventListener("error", (e) => {
  engine.log("error", `${e.message} at ${(e.filename || "").split("/").pop()}:${e.lineno}`).catch(() => {});
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  engine.log("error", `Unhandled: ${r && r.message ? r.message : r}`).catch(() => {});
});

/* ---------- settings persistence ---------- */
let saveTimer;
let migrationApplying = false, migrationReloading = false;
function reloadImportedSetup(payload) {
  if (payload?.backup) sessionStorage.setItem("setupImportedBackup", payload.backup);
  if (migrationReloading || !payload?.settings) return;
  migrationReloading = true;
  clearTimeout(saveTimer);
  settings = Object.assign(clone(DEFAULT_SETTINGS), payload.settings);
  delete settings.autoTheme;
  document.body.inert = true;
  location.reload();
}
function saveSettings() {
  clearTimeout(saveTimer);
  if (migrationApplying || migrationReloading) return;
  saveTimer = setTimeout(async () => {
    if (migrationApplying || migrationReloading) return;
    try {
      const res = await engine.saveSettings(settings);
      showProblems((res && res.problems) || []);
    } catch (e) { fail(e); }
  }, 250);
}
// Save right away (before something that reads the saved settings, like switching profiles).
async function saveNow() {
  clearTimeout(saveTimer);
  if (migrationApplying || migrationReloading) return false;
  try {
    const res = await engine.saveSettings(settings);
    showProblems((res && res.problems) || []);
    return true;
  } catch (e) { fail(e); return false; }
}
function showProblems(list) {
  const el = $("#hotkeyProblems");
  el.hidden = !list.length;
  el.textContent = list.join(". ") + (list.length ? "." : "");
}

/* ---------- channels: one model, shown in the full mixer and in mini mode ---------- */
// Built for the running edition (Standard, Banana or Potato) and rebuilt if it changes.
const chans = [];
let layout = null;
function buildChannels(edition) {
  layout = layoutFor(edition);
  let hw = 0;
  for (const b of layout.buses) if (b.kind === "hw" && ++hw > 3) b.extra = true;
  if (drawerCh) closeDrawer();
  for (const id of ["#inputs", "#outputs", "#miniInputs", "#miniOutputs"]) $(id).textContent = "";
  chans.length = 0;
  layout.strips.forEach((info, i) => chans.push({ kind: "strip", i, key: `strip-${i}`, prefix: `Strip[${i}]`, info }));
  layout.buses.forEach((info, j) => chans.push({ kind: "bus", i: j, key: `bus-${j}`, prefix: `Bus[${j}]`, info }));
  for (const ch of chans) {
    Object.assign(ch, {
      data: null, gain: 0, dragging: false, lockUntil: 0,
      faders: [], carriers: [], readouts: [], meterEls: [], toggles: [], chips: [], names: [], miniNames: [], subs: [], rows: [],
      meter: { shown: [-200, -200], peak: [-200, -200], peakAt: [0, 0], target: [-200, -200] },
    });
    buildMixerStrip(ch);
    buildMiniRow(ch);
    paintLook(ch);
    renderFaders(ch);
  }
  // Potato has 16 channels: narrower strips so they still fit.
  document.body.classList.toggle("dense", chans.length > 10);
  applyVisibility();
  applyExtraBuses();
  applySoloMono();
  applyStreamer();
  applyArrangementLock();
  applyRouteNames();
  sizeToNames();
  paintStripApps();
}

/* ---------- size strips and the mini/panel name column to the names ---------- */
const measureCtx = document.createElement("canvas").getContext("2d");
let lastSizes = "";
function textWidth(text, el) {
  const cs = getComputedStyle(el);
  measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const spacing = parseFloat(cs.letterSpacing) || 0;  // canvas doesn't include letter-spacing
  if (cs.textTransform === "uppercase") text = text.toUpperCase();  // themes that capitalise names are wider
  return measureCtx.measureText(text).width + spacing * text.length + 2;
}
// Each strip gets the width its own name needs (within limits), so names show in full
// without making every strip wide. The mini rows share one name column.
function sizeToNames() {
  if (!chans.length) return;
  // Every strip is the same width in every theme, whatever its name: long names are cut
  // short with "…" (hover for the full name). Only the mini rows' name column fits its names.
  const dense = document.body.classList.contains("dense");
  const widths = chans.map(() => (dense ? 124 : 148));
  const miniNameW = Math.round(Math.min(240, Math.max(84, ...chans
    .filter((ch) => !look(ch).hidden)
    .map((ch) => textWidth(ch.miniNames[0].textContent, ch.miniNames[0]) + 2))));
  const key = widths.join(",") + "|" + miniNameW;
  if (key === lastSizes) return;
  lastSizes = key;
  chans.forEach((ch, k) => ch.mixerEl.style.setProperty("--w", widths[k] + "px"));
  document.body.style.setProperty("--mini-name", miniNameW + "px");
  if (PANEL) requestAnimationFrame(fitPanel);
  else if (settings.mini) syncMiniWindow(true);
}
// Window width for mini mode and the panel: padding + chip + name column + fader + mute button.
function miniWidth() {
  const name = parseFloat(getComputedStyle(document.body).getPropertyValue("--mini-name")) || 96;
  return Math.ceil(24 + 12 + 12 + 24 + 8 + name + 8 + 180 + 8 + 54 + 2);
}
const isHw = (ch) => ch.info.kind === "hw";

function look(ch) {
  const saved = (settings.appearance || {})[ch.key] || {};
  return { color: saved.color || "slate", icon: saved.icon || ch.info.icon, hidden: !!saved.hidden, hideSub: !!saved.hideSub, osd: saved.osd !== false, panel: saved.panel !== false, mix: saved.mix !== false };
}
function setLook(ch, patch) {
  settings.appearance = settings.appearance || {};
  settings.appearance[ch.key] = Object.assign({}, settings.appearance[ch.key], patch);
  saveSettings();
  paintLook(ch);
  applyVisibility();
  if (drawerCh === ch) renderDrawerHead();
}
function displayName(ch) {
  const d = ch.data || {};
  if (d.label) return d.label;
  if (ch.kind === "strip") return isHw(ch) ? d.device || ch.info.fallback : ch.info.fallback;
  return isHw(ch) ? d.device || `Output ${ch.info.id}` : `Virtual output ${ch.info.id}`;
}
function subText(ch) {
  const d = ch.data || {};
  if (ch.kind === "strip") {
    if (!isHw(ch)) return "Virtual input";
    if (!d.device) return "No device";
    return displayName(ch) === d.device ? "Hardware input" : d.device;
  }
  const rest = isHw(ch) ? (d.label ? d.device || "No device" : "Hardware output") : "Virtual output";
  return [ch.info.id, rest];
}

function paintLook(ch) {
  const lk = look(ch);
  for (const c of ch.chips) { c.dataset.color = lk.color; c.dataset.icon = lk.icon; c.innerHTML = svg(lk.icon, c.classList.contains("small") ? 14 : 18); }
  for (const r of ch.rows) { r.dataset.color = lk.color; r.classList.toggle("sub-off", lk.hideSub); }
}

/* ---------- fader component (vertical in the mixer, horizontal in mini mode) ---------- */
const mixerUndo = [];
let gainGesture = null;
const gainScope = (ch) => ch.kind === "strip" ? (lastState?.buses || []).findIndex((b) => b.sel) : -1;
function recordMixerChange(changes) {
  const changed = changes.filter((c) => c.before !== c.after);
  if (!changed.length) return;
  mixerUndo.push(changed);
  if (mixerUndo.length > 40) mixerUndo.shift();
  $("#undoMixer").disabled = false;
}
function gainMembers(ch) {
  if (gainScope(ch) >= 0) return [ch];
  const group = faderGroups().find((g) => Array.isArray(g.members) && g.members.includes(ch.prefix));
  const members = group ? chans.filter((c) => group.members.includes(c.prefix)) : [ch];
  return members.some((c) => gainScope(c) >= 0) ? [ch] : members;
}
function gainSnapshot(ch, unlinked = false) {
  return (unlinked ? [ch] : gainMembers(ch)).map((c) => ({ ch: c, before: c.gain, scope: gainScope(c) }));
}
function recordGains(snapshot) {
  recordMixerChange(snapshot.map(({ ch, before, scope }) => ({ ch, param: "Gain", before, after: ch.gain, scope })));
}
function moveGain(ch, v, glide, unlinked) {
  const dragging = gainGesture?.leader === ch;
  const snapshot = dragging ? gainGesture.snapshot : gainSnapshot(ch, unlinked);
  const leader = snapshot.find((entry) => entry.ch === ch);
  const minDelta = Math.max(...snapshot.map(({ before }) => MIN_DB - before));
  const maxDelta = Math.min(...snapshot.map(({ before }) => MAX_DB - before));
  const delta = Math.max(minDelta, Math.min(maxDelta, v - leader.before));
  for (const entry of snapshot) {
    if (glide && fadesOn()) writeGlide(entry.ch, entry.before + delta);
    else writeGain(entry.ch, entry.before + delta);
  }
  if (!dragging) recordGains(snapshot);
}
function setGain(ch, v, unlinked) { moveGain(ch, v, false, unlinked); }
function writeGain(ch, v) {
  v = Math.round(Math.max(MIN_DB, Math.min(MAX_DB, v)) * 10) / 10;
  ch.lockUntil = performance.now() + 500;
  if (v === ch.gain) return;
  ch.gain = v;
  renderFaders(ch);
  sendFloat(`${ch.prefix}.Gain`, v);
}
// Faders only ever change `transform`, so moving one never repaints the page.
function renderFaders(ch) {
  const p = dbToPos(ch.gain), text = fmtDb(ch.gain);
  for (const c of ch.carriers) c.el.style.transform = c.h ? `translateX(${(p * 100).toFixed(2)}%)` : `translateY(${((1 - p) * 100).toFixed(2)}%)`;
  for (const f of ch.faders) {
    f.style.setProperty("--p", p.toFixed(4)); // how far up: the look themes fill the track with it
    const db = f.querySelector(".db");
    if (db) db.textContent = text;
    f.setAttribute("aria-valuenow", ch.gain.toFixed(1));
    f.setAttribute("aria-valuetext", text + " dB");
  }
  for (const r of ch.readouts) r.textContent = text;
}
function remoteGain(ch, v) {
  if (ch.dragging || performance.now() < ch.lockUntil) return;
  if (Math.abs(v - ch.gain) > 0.001) { ch.gain = v; renderFaders(ch); }
}
// Typed levels and double-click to 0 dB glide there (Voicemeeter fades; the cap follows).
const fadesOn = () => !settings.fades || settings.fades.on !== false;
function glideGain(ch, v, unlinked) { moveGain(ch, v, true, unlinked); }
function writeGlide(ch, v) {
  v = Math.round(Math.max(MIN_DB, Math.min(MAX_DB, v)) * 10) / 10;
  ch.lockUntil = performance.now() + 450;
  if (v === ch.gain) return;
  ch.gain = v;
  for (const c of ch.carriers) c.el.classList.add("glide");
  renderFaders(ch);
  clearTimeout(ch.glideTimer);
  ch.glideTimer = setTimeout(() => { for (const c of ch.carriers) c.el.classList.remove("glide"); }, 360);
  pending.delete(`${ch.prefix}.Gain`);
  engine.glide(ch.prefix, v).catch(fail);
}

function makeFader(el, ch) {
  const horizontal = el.classList.contains("h");
  const track = $(".track", el), travel = $(".travel", el);
  ch.faders.push(el);
  ch.carriers.push({ el: $(".carrier", el), h: horizontal });
  const meters = [$(".meter.l", el), $(".meter.r", el)];
  ch.meterEls.push({ lit: meters.map((m) => $(".lit", m)), led: meters.map((m) => $(".lit b", m)), pk: meters.map((m) => $(".pk", m)), h: horizontal, mini: !!el.closest(".mini-row") });

  let start = 0, startPos = 0, span = 1;
  const posAt = (e, r) => horizontal ? (e.clientX - r.left) / span : (r.bottom - e.clientY) / span;
  const coord = (e) => (horizontal ? e.clientX : -e.clientY);
  track.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = travel.getBoundingClientRect();
    span = Math.max(1, horizontal ? r.width : r.height);
    const onThumb = !!e.target.closest(".thumb");
    gainGesture = { leader: ch, snapshot: gainSnapshot(ch, e.altKey) };
    startPos = onThumb ? dbToPos(ch.gain) : posAt(e, r);
    start = coord(e);
    if (!onThumb) setGain(ch, posToDb(startPos));
    ch.dragging = true; el.classList.add("dragging");
    track.setPointerCapture(e.pointerId);
    el.focus({ preventScroll: true });
  });
  track.addEventListener("pointermove", (e) => {
    if (!ch.dragging || !el.classList.contains("dragging")) return;
    const fine = e.shiftKey ? 0.2 : 1;
    setGain(ch, posToDb(startPos + ((coord(e) - start) / span) * fine));
    if (e.shiftKey) { startPos = dbToPos(ch.gain); start = coord(e); }
  });
  const end = () => {
    if (!el.classList.contains("dragging")) return;
    ch.dragging = false; el.classList.remove("dragging"); ch.lockUntil = performance.now() + 500;
    if (gainGesture?.leader === ch) {
      recordGains(gainGesture.snapshot);
      gainGesture = null;
    }
  };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);
  track.addEventListener("lostpointercapture", end);
  track.addEventListener("dblclick", (e) => glideGain(ch, 0, e.altKey));
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    const dir = (horizontal ? (e.deltaY || e.deltaX) : e.deltaY) < 0 ? 1 : -1;
    setGain(ch, ch.gain + dir * (e.altKey ? 0.1 : 1), e.altKey);
  }, { passive: false });
  el.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.5;
    const k = e.key;
    let v = null;
    if (k === "ArrowUp" || k === "ArrowRight") v = ch.gain + step;
    else if (k === "ArrowDown" || k === "ArrowLeft") v = ch.gain - step;
    else if (k === "PageUp") v = ch.gain + 3;
    else if (k === "PageDown") v = ch.gain - 3;
    else if (k === "Home") v = MIN_DB;
    else if (k === "End") v = MAX_DB;
    else if (k === "0") v = 0;
    else if (k === "Enter") {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      return openGainEdit(ch, r.left + r.width / 2, r.top + r.height / 2, el);
    }
    if (v !== null) { e.preventDefault(); setGain(ch, v, e.altKey); }
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openGainEdit(ch, e.clientX, e.clientY, el);
  });
  el.setAttribute("aria-label", `${displayName(ch)} level`);
}

function writeMixerToggle(ch, param, on) {
  for (const t of ch.toggles) if (t.param === param) t.btn.setAttribute("aria-pressed", String(on));
  if (param === "Mute") markMuted(ch, on);
  if (on && ROUTE.test(param) && partMuted(ch).includes(param)) setPartMuted(ch, partMuted(ch).filter((p) => p !== param));
  sendFloat(`${ch.prefix}.${param}`, on ? 1 : 0);
}
function undoMixer() {
  if (gainGesture) return;
  const changes = mixerUndo.pop();
  $("#undoMixer").disabled = !mixerUndo.length;
  if (!changes) return;
  const stillMatches = ({ ch, param, after, scope }) => {
    if (!chans.includes(ch)) return false;
    if (param === "Gain" && scope !== gainScope(ch)) return false;
    const current = param === "Gain" ? ch.gain : ch.toggles.find((t) => t.param === param)?.btn.getAttribute("aria-pressed") === "true";
    return current === after;
  };
  if (!changes.every(stillMatches)) {
    toast("The mixer has changed since that action");
    return;
  }
  for (const { ch, param, before, wasPartMuted } of changes) {
    if (param === "Gain") {
      if (fadesOn()) writeGlide(ch, before);
      else writeGain(ch, before);
    } else if (wasPartMuted) {
      pending.delete(`${ch.prefix}.${param}`);
      partMuteOutput(ch, param, true);
    } else writeMixerToggle(ch, param, before);
  }
  toast("Mixer change undone");
}
$("#undoMixer").addEventListener("click", undoMixer);
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z"
    && !e.target.closest?.("input, textarea, select, [contenteditable]") && !document.querySelector("dialog[open]")
    && mixerUndo.length) {
    e.preventDefault();
    undoMixer();
  }
});
function makeToggle(btn, ch, param) {
  btn.setAttribute("aria-pressed", "false");
  ch.toggles.push({ btn, param });
  btn.addEventListener("click", () => {
    const on = btn.getAttribute("aria-pressed") !== "true";
    if (param === "Mute" && ch.kind === "strip" && on && scopedMute(ch)) return;
    const returnFocus = !on && settings.simpleMode && ROUTE.test(param) && document.activeElement === btn
      && ch.routeExpand && !ch.routeExpand.parentElement.classList.contains("expanded");
    recordMixerChange([{ ch, param, before: !on, after: on, wasPartMuted: on && ROUTE.test(param) && partMuted(ch).includes(param) }]);
    writeMixerToggle(ch, param, on);
    if (returnFocus) ch.routeExpand.focus();
  });
  if (param === "Mute" && ch.kind === "strip") {
    btn.addEventListener("contextmenu", (e) => { e.preventDefault(); openMuteMenu(ch, btn, e); });
  }
}

/* ---------- muting an input on some outputs only (right-click Mute) ---------- */
// Sleekmeeter turns the input's send to those outputs off and remembers which ones it turned off,
// so unmuting puts back exactly those (and survives a restart).
const ROUTE = /^[AB]\d$/;
function muteDestination(ch) {
  const cfg = settings.muteDestinations?.[ch.key] || {};
  const buses = chans.filter((c) => c.kind === "bus");
  if (cfg.mode === "personal") return buses.find((c) => c.prefix === (settings.personalBus || settings.chatBalance?.bus) && isHw(c)) || buses.find(isHw);
  if (cfg.mode === "audience") return buses.find((c) => c.prefix === settings.audienceBus && !isHw(c)) || streamBus();
  if (cfg.mode === "chat") return buses.find((c) => c.prefix === cfg.bus && !isHw(c));
  return null;
}
function scopedMute(ch) {
  const mode = settings.muteDestinations?.[ch.key]?.mode;
  if (!["personal", "audience", "chat"].includes(mode)) return false;
  const bus = muteDestination(ch);
  if (!bus) { toast("Choose a mute destination in the channel’s Routing tab"); return true; }
  const route = bus.info.param, muted = partMuted(ch).includes(route);
  if (!muted && !routeOn(ch, route)) { toast(`${displayName(ch)} is already off on ${displayName(bus)}`); return true; }
  partMuteOutput(ch, route, !muted);
  return true;
}
const partMuted = (ch) => ((settings.partMute || {})[ch.key] || []).filter((p) => ROUTE.test(p));
function setPartMuted(ch, list) {
  settings.partMute = Object.assign({}, settings.partMute);
  if (list.length) settings.partMute[ch.key] = list; else delete settings.partMute[ch.key];
  ch.partAt = performance.now();
  saveSettings();
  paintPartMute(ch);
}
const routeOn = (ch, param) => {
  const d = ch.data;
  if (!d) return false;
  return !!(param[0] === "A" ? d.a : d.b)[+param.slice(1) - 1];
};
function partMuteOutput(ch, param, mute) {
  const list = partMuted(ch);
  if (mute === list.includes(param)) return;
  setPartMuted(ch, mute ? [...list, param] : list.filter((p) => p !== param));
  for (const t of ch.toggles) if (t.param === param) t.btn.setAttribute("aria-pressed", String(!mute));
  // On Potato this fades the input's level on that output first (fades.rs route_mute).
  engine.routeMute(ch.i, param, mute).catch(fail);
}
function busLabel(param) {
  const j = layout.buses.findIndex((b) => b.param === param);
  const bus = chans.find((c) => c.kind === "bus" && c.i === j);
  const name = bus && bus.data && bus.data.label;
  return name ? `${param} · ${name}` : param;
}
function paintPartMute(ch) {
  const list = partMuted(ch);
  for (const t of ch.toggles) {
    if (t.param === "Mute") {
      t.btn.classList.toggle("part", list.length > 0);
      if (list.length) {
        t.btn.dataset.part = list.join(" ");
        t.btn.title = `Muted on ${list.map(busLabel).join(", ")}. Right-click to change`;
      } else {
        delete t.btn.dataset.part;
        const destination = muteDestination(ch);
        t.btn.title = destination ? `Mute to ${displayName(destination)} · Right-click for other outputs`
          : "Right-click to mute on some outputs only";
      }
    } else if (ROUTE.test(t.param)) {
      t.btn.classList.toggle("part-muted", list.includes(t.param));
    }
  }
}
// Someone sent the input to that output again elsewhere (Voicemeeter, a scene): forget the mute.
// Right after Sleekmeeter changes it, the state can still be a poll behind, so wait a moment.
function reconcilePartMute(ch) {
  // The app keeps the list (partmute.rs), so a Stream Deck key or the phone can change it too:
  // follow it, except right after a change made here, while the app catches up.
  const d = ch.data;
  if (d && Array.isArray(d.partMute)) {
    if (performance.now() - (ch.partAt || 0) >= 2000) {
      const now = d.partMute.filter((p) => ROUTE.test(p));
      if (now.join() !== partMuted(ch).join()) {
        settings.partMute = Object.assign({}, settings.partMute);
        if (now.length) settings.partMute[ch.key] = now; else delete settings.partMute[ch.key];
      }
    }
    return paintPartMute(ch);
  }
  const list = partMuted(ch);
  if (!list.length || performance.now() - (ch.partAt || 0) < 2000) return paintPartMute(ch);
  const left = list.filter((p) => !routeOn(ch, p));
  if (left.length !== list.length) setPartMuted(ch, left); else paintPartMute(ch);
}

const muteMenu = Object.assign(document.createElement("div"), { className: "menu mute-menu", id: "muteMenu", hidden: true });
muteMenu.setAttribute("role", "menu");
document.body.appendChild(muteMenu);
let muteMenuBack = null;
function closeMuteMenu(focusBack) {
  if (muteMenu.hidden) return;
  muteMenu.hidden = true;
  if (focusBack && muteMenuBack) muteMenuBack.focus({ preventScroll: true });
  muteMenuBack = null;
}
function openMuteMenu(ch, btn, e) {
  if (!ch.data) return;
  muteMenuBack = btn;
  muteMenu.textContent = "";
  const item = (text, checked, run) => {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: text });
    b.setAttribute("role", "menuitemcheckbox");
    b.setAttribute("aria-checked", String(checked));
    b.addEventListener("click", () => { closeMuteMenu(true); run(); });
    muteMenu.appendChild(b);
    return b;
  };
  const head = Object.assign(document.createElement("div"), { className: "menu-head", textContent: displayName(ch) });
  muteMenu.appendChild(head);
  const full = !!ch.data.mute;
  item("Mute everywhere", full, () => btn.click());
  muteMenu.appendChild(Object.assign(document.createElement("hr"), {}));
  const list = partMuted(ch);
  let any = false;
  for (const bus of layout.buses) {
    const muted = list.includes(bus.param);
    if (!muted && !routeOn(ch, bus.param)) continue;
    any = true;
    item(`Mute on ${busLabel(bus.param)}`, muted, () => partMuteOutput(ch, bus.param, !muted));
  }
  if (!any) {
    const none = Object.assign(document.createElement("p"), { className: "menu-note", textContent: "Not sent to any output. Turn on A1–B3 above the fader first." });
    muteMenu.appendChild(none);
  }
  if (list.length > 1) {
    muteMenu.appendChild(document.createElement("hr"));
    const b = item("Unmute all outputs", false, () => { for (const p of list) partMuteOutput(ch, p, false); });
    b.setAttribute("role", "menuitem");
    b.removeAttribute("aria-checked");
  }
  muteMenu.hidden = false;
  // Keyboard (Shift+F10, Menu key) has no pointer position: open under the button.
  const r = btn.getBoundingClientRect();
  const fromKey = !e || (e.clientX === 0 && e.clientY === 0);
  let x = fromKey ? r.left : e.clientX, y = fromKey ? r.bottom + 4 : e.clientY;
  const w = muteMenu.offsetWidth, h = muteMenu.offsetHeight;
  x = Math.max(4, Math.min(x, innerWidth - w - 4));
  if (y + h > innerHeight - 4) y = Math.max(4, (fromKey ? r.top - 4 : y) - h);
  muteMenu.style.left = `${x}px`;
  muteMenu.style.top = `${y}px`;
  muteMenu.querySelector("button")?.focus({ preventScroll: true });
}
document.addEventListener("pointerdown", (e) => { if (!muteMenu.hidden && !muteMenu.contains(e.target)) closeMuteMenu(false); }, true);
addEventListener("blur", () => closeMuteMenu(false));
addEventListener("resize", () => closeMuteMenu(false));
muteMenu.addEventListener("keydown", (e) => {
  const items = [...muteMenu.querySelectorAll("button")];
  const at = items.indexOf(document.activeElement);
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMuteMenu(true); }
  else if (e.key === "Tab") { e.preventDefault(); closeMuteMenu(true); }
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = items.length;
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + n) % n].focus();
  } else if (e.key === "Home") { e.preventDefault(); items[0].focus(); }
  else if (e.key === "End") { e.preventDefault(); items[items.length - 1].focus(); }
});
function markMuted(ch, on) {
  // A mute or unmute fades levels inside Voicemeeter. The fader's own level doesn't change, so while
  // that runs the cap ignores incoming levels and can't wobble with the fade's in-between values.
  if (ch.mutedShown !== on) {
    if (ch.mutedShown !== undefined) ch.lockUntil = Math.max(ch.lockUntil, performance.now() + 900);
    ch.mutedShown = on;
  }
  for (const f of ch.faders) f.closest(".strip, .mini-row").classList.toggle("muted", on);
}

function makeName(btn, input, ch) {
  let original = "";
  const open = () => {
    original = (ch.data && ch.data.label) || "";
    input.value = original;
    btn.hidden = true; input.hidden = false; input.focus(); input.select();
  };
  const close = (commit) => {
    if (input.hidden) return;
    input.hidden = true; btn.hidden = false;
    const v = input.value.trim();
    if (commit && v !== original) engine.setString(`${ch.prefix}.Label`, v).catch(fail);
  };
  // One click shows or hides the device line under the name; a double-click renames.
  let clickTimer = null;
  btn.addEventListener("click", () => {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => setLook(ch, { hideSub: !look(ch).hideSub }), 230);
  });
  btn.addEventListener("dblclick", () => { clearTimeout(clickTimer); open(); });
  btn.addEventListener("keydown", (e) => { if (e.key === "F2" || e.key === "Enter") { e.preventDefault(); open(); } });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); close(true); btn.focus(); }
    if (e.key === "Escape") { e.preventDefault(); close(false); btn.focus(); }
  });
  input.addEventListener("blur", () => close(true));
  ch.names.push(btn);
}

function buildScale(el) {
  for (const db of [12, 0, -10, -20, -40, -60]) {
    const s = document.createElement("span");
    s.textContent = db > 0 ? "+" + db : db === 0 ? "0" : "−" + Math.abs(db);
    if (db === 0) s.className = "zero";
    s.style.bottom = `calc(var(--cap-h) / 2 + (100% - var(--cap-h)) * ${dbToPos(db)})`;
    el.appendChild(s);
  }
}

function positionAppList(strip, box) {
  const { left, right, top } = strip.getBoundingClientRect();
  const roomRight = innerWidth - right;
  const width = Math.min(200, Math.max(120, Math.max(left, roomRight) - 8), innerWidth - 16);
  const x = roomRight >= width + 8 || roomRight >= left ? right : left - width;
  box.style.width = `${width}px`;
  box.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
  const height = box.getBoundingClientRect().height;
  box.style.top = `${Math.max(8, Math.min(top + 8, innerHeight - height - 8))}px`;
}

function syncAppList(strip, box, stack) {
  const open = !stack.hidden && (strip.classList.contains("app-list-open") || strip.classList.contains("apps-hover"));
  if (open) {
    if (!box.matches(":popover-open")) box.showPopover();
    positionAppList(strip, box);
  } else if (box.matches(":popover-open")) {
    box.hidePopover();
  }
  stack.setAttribute("aria-expanded", String(open));
}

function closeAppLists(except = null, restoreFocus = false) {
  let closed = false, focus = null;
  document.querySelectorAll(".strip").forEach((strip) => {
    const box = $(".app-chips", strip);
    if (strip === except || !box?.matches(":popover-open")) return;
    if (box.contains(document.activeElement) || !focus) focus = $(".app-stack", strip);
    strip.classList.remove("app-list-open");
    strip.classList.remove("apps-hover");
    syncAppList(strip, box, $(".app-stack", strip));
    closed = true;
  });
  if (restoreFocus && focus && !focus.hidden) focus.focus();
  return closed;
}
document.addEventListener("click", (e) => {
  // Removal can rebuild a row before this click reaches document. Use its original path.
  if (!e.composedPath().some((node) => node.matches?.(".app-stack, .app-chips"))) closeAppLists();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.querySelector("dialog[open]") && closeAppLists(null, true)) e.preventDefault();
});
window.addEventListener("resize", () => closeAppLists());
document.addEventListener("scroll", (e) => {
  if (e.target === $("#desk")) closeAppLists();
}, true);

function buildMixerStrip(ch) {
  const tpl = ch.kind === "strip" ? "#inputTpl" : "#outputTpl";
  const el = $(tpl).content.firstElementChild.cloneNode(true);
  el.dataset.kind = ch.info.kind;
  ch.mixerEl = el;
  ch.rows.push(el);
  const chip = $(".chip", el);
  ch.chips.push(chip);
  $(".head", el).addEventListener("pointerdown", (e) => startReorder(e, ch));
  chip.addEventListener("click", () => openDrawer(ch));
  if (ch.kind === "strip") {
    if (isHw(ch)) {
      const warning = Object.assign(document.createElement("button"), { type: "button", className: "input-fx-warning", textContent: "!", hidden: true });
      warning.addEventListener("click", () => openInputEffects(ch, warning.dataset.chain));
      el.append(warning);
      ch.fxWarning = warning;
    }
    const stack = Object.assign(document.createElement("button"), { type: "button", className: "app-stack", hidden: true });
    const box = Object.assign(document.createElement("div"), { className: "app-chips", id: `apps-${ch.key}` });
    box.setAttribute("popover", "manual");
    stack.setAttribute("aria-expanded", "false");
    stack.setAttribute("aria-controls", box.id);
    box.setAttribute("role", "group");
    stack.addEventListener("click", () => {
      const open = !el.classList.contains("app-list-open");
      closeAppLists(el);
      el.classList.toggle("app-list-open", open);
      el.classList.remove("apps-hover");
      syncAppList(el, box, stack);
    });
    el.addEventListener("pointerleave", () => {
      if (box.contains(document.activeElement)) return;
      el.classList.remove("apps-hover");
      syncAppList(el, box, stack);
    });
    el.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "touch" || e.buttons || stack.hidden || el.classList.contains("app-list-open")) return;
      closeAppLists(el);
      el.classList.add("apps-hover");
      syncAppList(el, box, stack);
    });
    box.addEventListener("focusout", (e) => {
      if (el.matches(":hover") || box.contains(e.relatedTarget) || el.classList.contains("app-list-open")) return;
      el.classList.remove("apps-hover");
      syncAppList(el, box, stack);
    });
    $(".head", el).append(stack);
    $(".head", el).after(box);
  }
  makeName($(".name", el), $(".name-edit", el), ch);
  ch.subs.push($(".sub", el));
  buildScale($(".scale", el));
  makeFader($(".fader", el), ch);
  const readout = $(".readout", el);
  ch.readouts.push(readout);
  readout.addEventListener("click", () => {
    const r = readout.getBoundingClientRect();
    openGainEdit(ch, r.left, r.top - 40, $(".fader", el));
  });
  readout.addEventListener("contextmenu", (e) => { e.preventDefault(); readout.click(); });
  makeToggle($(".mute", el), ch, "Mute");
  if (ch.kind === "strip") {
    const routes = $(".routes", el);
    routes.classList.add("strip-routes");
    routes.id = `routes-${ch.key}`;
    let firstB = true;
    for (const bus of layout.buses) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `route ${bus.kind === "hw" ? "a" : "b"}`;
      if (bus.extra) b.classList.add("extra");
      if (bus.kind === "virt" && firstB) { b.classList.add("first-b"); firstB = false; }
      b.textContent = bus.id;
      b.title = `Send to ${bus.id}`;
      routes.appendChild(b);
      makeToggle(b, ch, bus.param);
    }
    const expand = Object.assign(document.createElement("button"), { type: "button", className: "btn route-expand", textContent: "All routes" });
    expand.setAttribute("aria-controls", routes.id);
    expand.setAttribute("aria-expanded", "false");
    expand.addEventListener("click", () => {
      const open = routes.classList.toggle("expanded");
      expand.setAttribute("aria-expanded", String(open));
      expand.textContent = open ? "Active routes" : "All routes";
    });
    routes.prepend(expand);
    ch.routeExpand = expand;
    makeToggle($(".solo", el), ch, "Solo");
    const mono = $(".mono", el);
    if (!isHw(ch)) { mono.textContent = "M.C."; mono.title = "Mute center channel"; }
    makeToggle(mono, ch, isHw(ch) ? "Mono" : "MC");
    $("#inputs").appendChild(el);
  } else {
    makeToggle($(".mono", el), ch, "Mono");
    makeToggle($(".eq", el), ch, "EQ.on");
    $("#outputs").appendChild(el);
  }
}

function buildMiniRow(ch) {
  const el = $("#miniTpl").content.firstElementChild.cloneNode(true);
  ch.miniEl = el;
  ch.rows.push(el);
  const chip = $(".chip", el);
  ch.chips.push(chip);
  ch.miniNames.push($(".mini-name", el));
  // Columns: the mixer's own vertical fader (every theme already styles it), level underneath.
  if (PANEL && settings.panelLayout === "columns") {
    const vertical = $("#inputTpl").content.querySelector(".fader").cloneNode(true);
    $(".fader", el).replaceWith(vertical);
    buildScale($(".scale", vertical));
    const level = Object.assign(document.createElement("span"), { className: "mini-db" });
    vertical.after(level);
    ch.readouts.push(level);
  }
  makeFader($(".fader", el), ch);
  makeToggle($(".mute", el), ch, "Mute");
  $(ch.kind === "strip" ? "#miniInputs" : "#miniOutputs").appendChild(el);
}

/* ---------- incoming state ---------- */
const EDITIONS = { 1: "Voicemeeter", 2: "Voicemeeter Banana", 3: "Voicemeeter Potato" };

let lastState = null;
function applyState(st) {
  lastState = st;
  const status = $("#status"), text = $("#statusText");
  if (!st.installed) {
    status.dataset.state = "offline"; text.textContent = "Voicemeeter isn't installed";
  } else if (!st.connected) {
    status.dataset.state = "offline"; text.textContent = "Voicemeeter isn't running";
  } else {
    status.dataset.state = "online";
    const ed = EDITIONS[st.edition] || "Voicemeeter";
    text.textContent = engine.simulated ? `Preview with a simulated ${ed}` : `${ed} ${st.version || ""}`.trim();
  }
  const statusLabel = `${text.textContent}. Check my setup`;
  if (status.title !== statusLabel) {
    status.title = statusLabel;
    status.setAttribute("aria-label", statusLabel);
  }
  showOffline(!st.installed ? "missing" : !st.connected ? "stopped" : null);
  const wasConnected = connected;
  connected = !!st.connected;
  vmInstalled = !!st.installed;
  if (setupDlg.open && setup.step === 0) paintSetupStart();
  $("#balanceMixer").hidden = SIDE || !connected || !st.strips;
  $("#balancePin").hidden = SIDE || !connected || !settings.chatBalancePinned || !settings.chatBalance;
  if (!st.connected || !st.strips) {
    if (balanceDlg.open) paintBalance();
    scheduleRouteTrace();
    if (outputsDlg.open) paintOutputDevices();
    return;
  }
  if (st.edition && st.edition !== layout.edition) buildChannels(st.edition);

  for (const ch of chans) {
    const d = (ch.kind === "strip" ? st.strips : st.buses)[ch.i];
    if (!d) continue;
    ch.data = d;
    const name = displayName(ch);
    if (ch.kind === "bus") queueRouteNames();
    for (const n of ch.names) { n.textContent = name; n.title = channelNameHint(name); }
    for (const n of ch.miniNames) { n.textContent = name; n.title = name; }
    for (const s of ch.subs) {
      const sub = subText(ch);
      if (Array.isArray(sub)) {
        s.textContent = "";
        s.append(Object.assign(document.createElement("span"), { className: "bus-tag", textContent: sub[0] }), " " + sub[1]);
        s.title = sub.join(" ");
      } else { s.textContent = sub; s.title = sub; }
    }
    for (const f of ch.faders) f.setAttribute("aria-label", `${name} level`);
    remoteGain(ch, d.gain);
    for (const t of ch.toggles) {
      let on;
      if (/^[AB]\d$/.test(t.param)) on = t.param[0] === "A" ? d.a[+t.param[1] - 1] : d.b[+t.param[1] - 1];
      else on = { Mute: d.mute, Solo: d.solo, Mono: d.mono, MC: d.mc, "EQ.on": d.eq }[t.param];
      t.btn.setAttribute("aria-pressed", String(!!on));
    }
    if (settings.simpleMode && ch.routeExpand && ch.routeExpand.parentElement.contains(document.activeElement)
        && document.activeElement.matches('.route[aria-pressed="false"]') && !ch.routeExpand.parentElement.classList.contains("expanded")) ch.routeExpand.focus();
    markMuted(ch, !!d.mute);
    if (ch.kind === "strip") reconcilePartMute(ch);
    for (const r of ch.rows) r.classList.toggle("ducked", !!d.ducked);
  }
  scheduleRouteTrace();
  applyMixFor(st);
  if (balanceDlg.open || !$("#balancePin").hidden) {
    if (!balanceDlg.open && !balanceBusy && balanceQueued === null && !balanceSession) populateBalance();
    paintBalance();
  }
  if (!wasConnected && !SIDE) refreshBalanceStatus();
  applyRecorder(st.recorder);
  applyOutputs(st);
  applyBrb(st);
  applyStreamButtons(st);
  if (!wasConnected && !SIDE) pollInputEffects();
  sizeToNames();
  if (drawerCh) renderDrawerValues();
  if (!fitted) { fitted = true; requestAnimationFrame(fitWindowToMixer); }
}

// First launch only (Rust ignores it once a size is saved): make the window as wide as the mixer.
let fitted = false;
function fitWindowToMixer() {
  if (SIDE || settings.mini) return;
  const desk = $("#desk"), cs = getComputedStyle(desk);
  const groups = [...desk.querySelectorAll(".group")].filter((g) => g.offsetWidth > 0);
  const width = groups.reduce((w, g) => w + g.offsetWidth, 0)
    + Math.max(0, groups.length - 1) * parseFloat(cs.columnGap || cs.gap || 0)
    + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 4;
  engine.fitWindow(Math.ceil(width)).catch(() => {});
}

/* ---------- channel order: drag the top of a channel to move it ---------- */
function orderList(kind) {
  const all = chans.filter((c) => c.kind === kind).map((c) => c.i);
  const out = (((settings.order || {})[kind]) || []).filter((i) => all.includes(i));
  for (const i of all) if (!out.includes(i)) out.push(i);
  return out;
}
// The window shows channels in this order (CSS `order`), so the underlying lists never change.
function applyOrder() {
  for (const kind of ["strip", "bus"]) {
    orderList(kind).forEach((idx, pos) => {
      const ch = chans.find((c) => c.kind === kind && c.i === idx);
      if (ch && ch.mixerEl) { ch.mixerEl.style.order = pos; ch.miniEl.style.order = pos; }
    });
  }
}
// Slide the channels from where they were to where they are now.
function reorderAnimated(kind, list) {
  const els = chans.filter((c) => c.kind === kind).map((c) => c.mixerEl);
  const before = new Map(els.map((el) => [el, el.getBoundingClientRect().left]));
  settings.order = Object.assign({}, settings.order, { [kind]: list });
  applyOrder();
  for (const el of els) {
    const dx = before.get(el) - el.getBoundingClientRect().left;
    if (!dx) continue;
    el.style.transition = "none";
    el.style.transform = `translateX(${dx}px)`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.transition = "transform .18s ease";
      el.style.transform = "";
      setTimeout(() => { el.style.transition = ""; }, 220);
    }));
  }
}
function startReorder(e, ch) {
  if (settings.lockArrangement || e.button !== 0 || e.target.closest(".name-edit, .app-stack")) return;
  const sx = e.clientX, sy = e.clientY;
  let dragging = false;
  const move = (ev) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
      dragging = true;
      ch.mixerEl.classList.add("reordering");
      document.body.classList.add("reorder-active");
    }
    const box = ch.mixerEl.parentElement.getBoundingClientRect();
    if (ev.clientX < box.left || ev.clientX > box.right) return;
    // Layout positions, so the sliding animation of the others doesn't confuse the hit test.
    const x0 = box.left - ch.mixerEl.parentElement.scrollLeft;
    const target = chans.find((c) => c.kind === ch.kind && c !== ch && !c.mixerEl.hidden
      && ev.clientX >= x0 + c.mixerEl.offsetLeft - ch.mixerEl.parentElement.offsetLeft
      && ev.clientX <= x0 + c.mixerEl.offsetLeft - ch.mixerEl.parentElement.offsetLeft + c.mixerEl.offsetWidth);
    if (!target) return;
    const list = orderList(ch.kind);
    const from = list.indexOf(ch.i), to = list.indexOf(target.i);
    if (from < 0 || to < 0 || from === to) return;
    list.splice(from, 1);
    list.splice(to, 0, ch.i);
    reorderAnimated(ch.kind, list);
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    ch.mixerEl.classList.remove("reordering");
    document.body.classList.remove("reorder-active");
    if (dragging) {
      saveSettings();
      // The release must not count as a click on the icon or name underneath.
      const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener("click", swallow, true);
      setTimeout(() => window.removeEventListener("click", swallow, true), 60);
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

/* ---------- visibility (hidden strips) ---------- */
function applyVisibility() {
  applyOrder();
  const hiddenCount = { strip: 0, bus: 0 };
  for (const ch of chans) {
    const h = look(ch).hidden;
    if (h) hiddenCount[ch.kind]++;
    ch.mixerEl.hidden = h && !reveal[ch.kind];
    ch.mixerEl.classList.toggle("is-hidden", h);
    ch.miniEl.hidden = h || (PANEL && !look(ch).panel);
  }
  document.querySelectorAll("[data-reveal]").forEach((b) => {
    const k = b.dataset.reveal, n = hiddenCount[k];
    b.hidden = n === 0;
    if (n === 0) reveal[k] = false;
    b.textContent = reveal[k] ? "Done" : `Show hidden (${n})`;
  });
  lastSizes = "";
  sizeToNames();
  if (settings.mini && !PANEL) syncMiniWindow(true);
  if (PANEL) requestAnimationFrame(fitPanel);
}
document.querySelectorAll("[data-reveal]").forEach((b) => b.addEventListener("click", () => {
  reveal[b.dataset.reveal] = !reveal[b.dataset.reveal];
  applyVisibility();
}));
const miniRows = () => chans.filter((c) => !look(c).hidden).length;

/* ---------- meters: fast attack, smooth release, 1.5 s peak hold ---------- */
function applyLevels(lv) {
  chans.forEach((ch) => {
    const pair = (ch.kind === "strip" ? lv.inputs : lv.outputs || [])[ch.i];
    if (pair) ch.meter.target = pair;
  });
  wakeMeters();
  if (settingsDlg.open) paintDuckLevel(false, lv);
  if (recDlg.open) paintRecLevel(lv);
  checkClip(lv);
  if (micDlg.open) micLevels(lv);
  if (tuneDlg.open) micTuneLevels(lv);
  if (chainDlg.open) chainLevels(lv);
  if (balanceDlg.open) paintBalanceSignal(lv);
  if (setupDlg.open) setupLevels(lv);
  loudLevels(lv);
}
// Meters move with `transform` only (scale for the bar, translate for the peak line), so they
// are composited on the GPU without repainting. The loop stops when every meter is at rest
// and starts again when new levels arrive.
let lastT = performance.now(), running = false, lastLevels = 0;
let lastMeterView = "";
const writeMeter = (ch, c, p, pk, mini) => {
  const off = ((1 - p) * 100).toFixed(2);
  const opacity = pk > 0.01 ? "1" : "0";
  for (const v of ch.meterEls) {
    if (v.mini !== mini) continue;
    v.lit[c].style.transform = v.h ? `translateX(-${off}%)` : `translateY(${off}%)`;
    v.led[c].style.transform = v.h ? `translateX(${off}%)` : `translateY(-${off}%)`;
    v.pk[c].style.transform = v.h ? `translateX(${(pk * 100).toFixed(2)}%)` : `translateY(${((1 - pk) * 100).toFixed(2)}%)`;
    if (v.pk[c].style.opacity !== opacity) v.pk[c].style.opacity = opacity;
  }
};
function wakeMeters() {
  lastLevels = performance.now();
  if (MIXWIN) return; // the output mix window has no meters to draw
  if (!running) { running = true; lastT = performance.now(); requestAnimationFrame(frame); }
}
function frame(t) {
  // At most ~60-80 draws a second, even on 144 Hz+ screens: levels only arrive 30 times a second.
  if (t - lastT < 12) { requestAnimationFrame(frame); return; }
  // Hidden in the tray: nothing to draw. The next levels to arrive wake the loop again.
  if (document.hidden) { running = false; return; }
  const dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
  const mini = document.body.classList.contains("is-mini");
  const show = !MIXWIN && !(PANEL && document.body.classList.contains("panel-no-meters"));
  const view = show ? (mini ? "mini" : "full") : "hidden";
  const viewChanged = view !== lastMeterView;
  lastMeterView = view;
  let busy = false;
  for (const ch of chans) {
    const M = ch.meter;
    for (let c = 0; c < 2; c++) {
      const target = connected ? M.target[c] : -200;
      const cur = M.shown[c];
      const next = target >= cur ? target : Math.max(target, cur - 26 * dt);
      let changed = false;
      if (next !== cur) { M.shown[c] = next; changed = true; }
      if (next > M.peak[c]) { M.peak[c] = next; M.peakAt[c] = t; changed = true; }
      else if (t - M.peakAt[c] > 1500 && M.peak[c] > next) { M.peak[c] = Math.max(next, M.peak[c] - 20 * dt); changed = true; }
      busy ||= changed;
      if (show && (changed || viewChanged)) {
        const p = dbToPos(M.shown[c]), pk = dbToPos(M.peak[c]);
        if (viewChanged || Math.abs(p - (M.drawn ? M.drawn[c] : -1)) > 0.0015 || Math.abs(pk - (M.drawnPk ? M.drawnPk[c] : -1)) > 0.0015) {
          M.drawn = M.drawn || [0, 0]; M.drawnPk = M.drawnPk || [0, 0];
          M.drawn[c] = p; M.drawnPk[c] = pk;
          writeMeter(ch, c, p, pk, mini);
        }
      }
    }
  }
  // keep running while levels are arriving or anything is still falling
  if (busy || t - lastLevels < 250) requestAnimationFrame(frame);
  else running = false;
}

/* ---------- type-a-value box: right-click a fader (or press Enter on it) ---------- */
const gainEdit = $("#gainEdit"), gainInput = $("#gainInput"), gainHint = $("#gainHint");
let editCh = null, editReturn = null;
const HINT = "−60 to +12, Enter to set";

function openGainEdit(ch, x, y, returnTo) {
  editCh = ch; editReturn = returnTo;
  $("#gainLabel").textContent = `Set ${displayName(ch)}`;
  gainInput.value = ch.gain <= MIN_DB ? "-60" : String(+ch.gain.toFixed(1));
  gainEdit.classList.remove("invalid");
  gainHint.textContent = HINT;
  gainEdit.hidden = false;
  const r = gainEdit.getBoundingClientRect();
  gainEdit.style.left = Math.max(8, Math.min(x + 10, innerWidth - r.width - 8)) + "px";
  gainEdit.style.top = Math.max(8, Math.min(y - 24, innerHeight - r.height - 8)) + "px";
  gainInput.focus();
  gainInput.select();
}
function closeGainEdit() {
  if (gainEdit.hidden) return;
  gainEdit.hidden = true;
  const back = editReturn;
  editCh = editReturn = null;
  if (back && document.activeElement === document.body) back.focus({ preventScroll: true });
}
// Accepts "-10", "-10db", "+3 dB", "−4,5", "0", "-inf".
function parseDb(text) {
  const t = text.trim().toLowerCase().replace(/[−–—]/g, "-").replace(",", ".").replace(/\s+/g, "").replace(/db$/, "");
  if (/^-?(inf|∞)/.test(t)) return MIN_DB;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  return parseFloat(t);
}
gainEdit.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = parseDb(gainInput.value);
  if (v === null) {
    gainEdit.classList.add("invalid");
    gainHint.textContent = "Type a number, like -10";
    gainInput.select();
    return;
  }
  const ch = editCh, back = editReturn;
  glideGain(ch, v);
  if (v < MIN_DB || v > MAX_DB) toast(`${displayName(ch)} set to ${fmtDb(ch.gain)} dB, the closest Voicemeeter allows`);
  closeGainEdit();
  if (back) back.focus({ preventScroll: true });
});
gainInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); const back = editReturn; closeGainEdit(); if (back) back.focus({ preventScroll: true }); }
});
gainInput.addEventListener("input", () => { gainEdit.classList.remove("invalid"); gainHint.textContent = HINT; });
gainInput.addEventListener("blur", () => setTimeout(closeGainEdit, 0));
// Keep the browser's own right-click menu (Reload, Inspect…) out of the app, except in text fields.
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest("input, textarea")) e.preventDefault();
});

/* ---------- settings sliders (used while the later parts load) ---------- */
const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s`);
const fmtDbShort = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v) + " dB";
// A settings slider: amber fill up to the knob, value on the right.
function bindRange(id, get, set, format) {
  const input = $("#" + id), out = $(`output[for="${id}"]`);
  const paint = () => {
    const v = +input.value, min = +input.min, max = +input.max;
    out.textContent = format(v);
    if (input.classList.contains("level-range")) return; // painted by the live level instead
    const p = ((v - min) / (max - min)) * 100;
    input.style.setProperty("--track-bg", `linear-gradient(to right, var(--amber) ${p}%, var(--rail) ${p}%)`);
  };
  input.addEventListener("input", () => { set(+input.value); paint(); saveSettings(); });
  input._sync = () => { input.value = get(); paint(); };
  return input;
}
