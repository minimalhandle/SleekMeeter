(function () {
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
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const res = await engine.saveSettings(settings);
        showProblems((res && res.problems) || []);
      } catch (e) { fail(e); }
    }, 250);
  }
  // Save right away (before something that reads the saved settings, like switching profiles).
  async function saveNow() {
    clearTimeout(saveTimer);
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
    if (!running) { running = true; lastT = performance.now(); requestAnimationFrame(frame); }
  }
  function frame(t) {
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

  /* ---------- channel drawer ---------- */
  let drawerCh = null;
  let deviceCache = null;
  const drawer = $("#drawer"), drawerBody = $("#drawerBody");
  const drawerPanels = { routing: $("#drawerRouting"), sound: $("#drawerSound"), apps: $("#drawerApps"), look: $("#drawerLook") };
  let drawerTab = "routing";
  const selectDrawerTab = bindTabs($("#drawerTabs"), (tab) => {
    drawerTab = tab;
    drawerBody.scrollTop = 0;
    if (tab === "apps") paintDrawerApps();
  });

  function openDrawer(ch, tab = "routing") {
    drawerCh = ch;
    drawerTab = tab;
    drawer.hidden = false;
    renderDrawerHead();
    buildDrawerBody();
    selectDrawerTab(drawerTab, true);
    engine.devices().then((d) => { deviceCache = d; if (drawerCh === ch) fillDevices(); }).catch(() => {});
  }
  function closeDrawer() {
    const ch = drawerCh;
    drawerCh = null;
    drawer.hidden = true;
    if (ch && ch.chips[0]) ch.chips[0].focus();
  }
  $("#drawerClose").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawerCh && !document.querySelector("dialog[open]")) closeDrawer();
  });

  function renderDrawerHead() {
    const ch = drawerCh, lk = look(ch);
    const chip = $("#drawerChip");
    chip.dataset.color = lk.color;
    chip.innerHTML = svg(lk.icon, 22);
    $("#drawerTitle").textContent = displayName(ch);
    const sub = subText(ch);
    $("#drawerSub").textContent = Array.isArray(sub) ? sub.join(" ") : sub;
    drawer.dataset.color = lk.color;
    drawerBody.querySelectorAll(".swatch").forEach((s) => s.setAttribute("aria-pressed", String(s.dataset.value === lk.color)));
    drawerBody.querySelectorAll(".icon-pick").forEach((s) => s.setAttribute("aria-pressed", String(s.dataset.value === lk.icon)));
    const hide = $("#lookHidden");
    if (hide) hide.checked = lk.hidden;
    const inOsd = $("#lookOsd"), inPanel = $("#lookPanel");
    if (inOsd) inOsd.checked = lk.osd;
    if (inPanel) inPanel.checked = lk.panel;
    const inMix = $("#lookMix");
    if (inMix) inMix.checked = lk.mix;
  }

  function section(title, tab = "sound") {
    const s = document.createElement("section");
    if (title) s.appendChild(Object.assign(document.createElement("h3"), { textContent: title }));
    drawerPanels[tab].appendChild(s);
    return s;
  }

  // A labelled slider bound to one Voicemeeter parameter.
  function rangeField(parent, { id, label, param, min, max, step, center, format, reset }) {
    const row = document.createElement("div");
    row.className = "field";
    row.innerHTML = `<label for="${id}">${label}</label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}"><output for="${id}"></output>`;
    const input = $("input", row), out = $("output", row);
    input.dataset.param = param;
    const paint = () => {
      const v = +input.value;
      out.textContent = format(v);
      const p = ((v - min) / (max - min)) * 100;
      const c = center === undefined ? 0 : ((center - min) / (max - min)) * 100;
      const [a, b] = p < c ? [p, c] : [c, p];
      input.style.setProperty("--track-bg",
        `linear-gradient(to right, var(--track) ${a}%, var(--acc) ${a}%, var(--acc) ${b}%, var(--track) ${b}%)`);
    };
    input.addEventListener("input", () => { paint(); sendFloat(`${drawerCh.prefix}.${param}`, +input.value); });
    input.addEventListener("dblclick", () => { input.value = reset; paint(); sendFloat(`${drawerCh.prefix}.${param}`, reset); });
    input._paint = paint;
    parent.appendChild(row);
    return input;
  }

  function buildDrawerBody() {
    const ch = drawerCh;
    for (const panel of Object.values(drawerPanels)) panel.replaceChildren();
    $("#drawerAppsTab").hidden = ch.kind !== "strip";
    if (ch.kind === "strip") {
      const dest = section("Mute button destination", "routing");
      const mode = Object.assign(document.createElement("select"), { ariaLabel: "Mute button destination" });
      const chat = Object.assign(document.createElement("select"), { ariaLabel: "Voice chat output" });
      mode.append(new Option("Everyone", "all"), new Option("Audience", "audience"),
        new Option("Headphones", "personal"), new Option("Voice chat", "chat"));
      chat.append(new Option("Choose voice chat output", ""), ...busOptions(chans.filter((c) => c.kind === "bus" && !isHw(c))));
      const cfg = settings.muteDestinations?.[ch.key] || {};
      mode.value = cfg.mode || "all";
      chat.value = cfg.bus || "";
      chat.hidden = mode.value !== "chat";
      const update = () => {
        settings.muteDestinations = { ...settings.muteDestinations, [ch.key]: { mode: mode.value, bus: chat.value } };
        chat.hidden = mode.value !== "chat";
        paintPartMute(ch); saveSettings();
      };
      mode.addEventListener("change", update); chat.addEventListener("change", update);
      dest.append(mode, chat, Object.assign(document.createElement("p"), {
        className: "hint", textContent: "Applies to the main Mute button in the mixer and tray. Right-click to choose other outputs."
      }));
      const monitor = section("Private monitoring");
      const cue = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: "Cue in headphones…" });
      cue.addEventListener("click", () => openMonitor(ch));
      monitor.append(cue);
    }

    const lookSec = section("Look", "look");
    const sw = document.createElement("div");
    sw.className = "swatches"; sw.setAttribute("role", "group"); sw.setAttribute("aria-label", "Color");
    for (const [key, label] of Object.entries(COLORS)) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "swatch"; b.dataset.color = key; b.dataset.value = key;
      b.title = label; b.setAttribute("aria-label", label);
      b.addEventListener("click", () => setLook(ch, { color: key }));
      sw.appendChild(b);
    }
    const grid = document.createElement("div");
    grid.className = "icon-grid"; grid.setAttribute("role", "group"); grid.setAttribute("aria-label", "Icon");
    for (const [key, [label]] of Object.entries(ICONS)) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "icon-pick"; b.dataset.value = key; b.title = label;
      b.setAttribute("aria-label", label);
      b.innerHTML = svg(key, 18);
      b.addEventListener("click", () => setLook(ch, { icon: key }));
      grid.appendChild(b);
    }
    const hide = document.createElement("label");
    hide.className = "check";
    hide.innerHTML = `<input type="checkbox" id="lookHidden"><span>Hide this ${ch.kind === "strip" ? "input" : "output"} from the mixer</span>`;
    $("input", hide).addEventListener("change", (e) => setLook(ch, { hidden: e.target.checked }));
    const inOsd = document.createElement("label");
    inOsd.className = "check";
    inOsd.innerHTML = `<input type="checkbox" id="lookOsd"><span>Show in the volume overlay when its level changes</span>`;
    $("input", inOsd).addEventListener("change", (e) => setLook(ch, { osd: e.target.checked }));
    const inPanel = document.createElement("label");
    inPanel.className = "check";
    inPanel.innerHTML = `<input type="checkbox" id="lookPanel"><span>Show in the tray volume panel</span>`;
    $("input", inPanel).addEventListener("change", (e) => setLook(ch, { panel: e.target.checked }));
    lookSec.append(sw, grid, hide, inOsd, inPanel);
    // Potato's output mix: leave an unused output out of Mix without hiding its fader here.
    if (ch.kind === "bus" && layout && layout.edition === 3) {
      const inMix = document.createElement("label");
      inMix.className = "check";
      inMix.innerHTML = `<input type="checkbox" id="lookMix"><span>Show in Mix (the output mix)</span>`;
      $("input", inMix).addEventListener("change", (e) => setLook(ch, { mix: e.target.checked }));
      lookSec.appendChild(inMix);
    }

    if (isHw(ch)) {
      const devSec = section(ch.kind === "strip" ? "Input device" : "Output device", "routing");
      const sel = document.createElement("select");
      sel.id = "deviceSelect";
      sel.setAttribute("aria-label", "Device");
      sel.innerHTML = `<option>Loading devices…</option>`;
      sel.addEventListener("change", () => {
        const [type, ...rest] = sel.value.split("|");
        const name = rest.join("|");
        engine.setString(`${ch.prefix}.device.${type || "wdm"}`, name)
          .then(() => toast(name ? `Switched to ${name}` : "Device removed"))
          .catch(fail);
      });
      devSec.appendChild(sel);
      if (ch.kind === "bus") {
        const fallback = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: "Open output fallbacks…" });
        fallback.addEventListener("click", () => { closeDrawer(); openOutputFallback(ch.i); });
        devSec.append(fallback);
      }
      if (deviceCache) fillDevices();
    }

    if (ch.kind === "strip") {
      const sends = section("Send to", "routing");
      const routeRow = Object.assign(document.createElement("div"), { className: "routes drawer-routes" });
      routeRow.setAttribute("role", "group");
      routeRow.setAttribute("aria-label", "Send to");
      for (const t of ch.toggles.filter(({ param }) => /^[AB]\d$/.test(param))) {
        const b = t.btn.cloneNode(true);
        b.removeAttribute("id");
        b.dataset.param = t.param;
        b.addEventListener("click", () => { t.btn.click(); renderDrawerValues(); });
        routeRow.appendChild(b);
      }
      sends.appendChild(routeRow);
      if (isHw(ch)) {
        const effects = section("Input effects");
        const open = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: "Open this input’s effects chain…" });
        open.addEventListener("click", () => openInputEffects(ch));
        effects.append(open);
      }
      const pos = section("Position");
      rangeField(pos, { id: "fPan", label: "Pan", param: "Pan_x", min: -0.5, max: 0.5, step: 0.01, center: 0, reset: 0,
        format: (v) => (Math.abs(v) < 0.005 ? "C" : (v < 0 ? "L " : "R ") + Math.round(Math.abs(v) * 200)) });
      const dyn = section("Dynamics");
      rangeField(dyn, { id: "fComp", label: "Compressor", param: "Comp", min: 0, max: 10, step: 0.1, reset: 0, format: (v) => v.toFixed(1) });
      rangeField(dyn, { id: "fGate", label: "Gate", param: "Gate", min: 0, max: 10, step: 0.1, reset: 0, format: (v) => v.toFixed(1) });
      // Voicemeeter's input limiter (Banana and Potato): at +12 dB it's off.
      if (ch.data && ch.data.limit != null) {
        rangeField(dyn, { id: "fLimit", label: "Limiter", param: "Limit", min: -40, max: 12, step: 0.5, reset: 12,
          format: (v) => (v >= 12 ? "Off" : fmtDb(v) + " dB") });
      }
      // Potato's gain layers: this input's own level on each output.
      if (ch.data && (ch.data.layers || []).length) {
        const lay = section("Level on each output", "routing");
        const note = document.createElement("p");
        note.className = "hint";
        note.textContent = "Give one output its own level, like less game on your stream than in your headphones. The main fader moves them all together and keeps the differences.";
        lay.appendChild(note);
        chans.filter((b) => b.kind === "bus").forEach((b) => {
          const tag = (b.info && b.info.id) || "";
          rangeField(lay, { id: `fLayer${b.i}`, label: tag ? `${tag} ${displayName(b)}` : displayName(b), param: `GainLayer[${b.i}]`,
            min: -60, max: 12, step: 0.5, center: 0, reset: ch.gain || 0, format: (v) => fmtDb(v) });
        });
      }
      if (!isHw(ch)) {
        const eq = section("EQ");
        const f = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1);
        rangeField(eq, { id: "fEq1", label: "Bass", param: "EQGain1", min: -12, max: 12, step: 0.5, center: 0, reset: 0, format: f });
        rangeField(eq, { id: "fEq2", label: "Mid", param: "EQGain2", min: -12, max: 12, step: 0.5, center: 0, reset: 0, format: f });
        rangeField(eq, { id: "fEq3", label: "Treble", param: "EQGain3", min: -12, max: 12, step: 0.5, center: 0, reset: 0, format: f });
      }
    } else {
      const sources = section("Inputs sent to this output", "routing");
      const list = Object.assign(document.createElement("div"), { className: "drawer-sources" });
      list.setAttribute("role", "group");
      list.setAttribute("aria-label", `Inputs sent to ${ch.info.id}`);
      for (const input of chans.filter((c) => c.kind === "strip")) {
        const send = input.toggles.find((t) => t.param === ch.info.param);
        if (!send) continue;
        const b = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: displayName(input) });
        b.dataset.source = input.prefix;
        b.addEventListener("click", () => { send.btn.click(); renderDrawerValues(); });
        list.append(b);
      }
      sources.append(list);
      const modeSec = section("Bus mode");
      const sel = document.createElement("select");
      sel.id = "busMode"; sel.setAttribute("aria-label", "Bus mode");
      for (const [v, label] of BUS_MODES) sel.appendChild(new Option(label, v));
      sel.addEventListener("change", () => sendFloat(`${ch.prefix}.mode.${sel.value}`, 1));
      modeSec.appendChild(sel);
    }
    // With Solo, Mono and EQ hidden from the mixer, they're still here.
    if (settings.hideSoloMono || settings.simpleMode) {
      const btnSec = section("Buttons");
      const row = document.createElement("div");
      row.className = "routes modes drawer-togs";
      const keys = ch.kind === "strip"
        ? [["Solo", "solo", "Solo"], isHw(ch) ? ["Mono", "mono", "Mono"] : ["MC", "mono", "M.C."]]
        : [["Mono", "mono", "Mono"], ["EQ.on", "eq", "EQ"]];
      for (const [param, cls, label] of keys) {
        const b = document.createElement("button");
        b.type = "button"; b.className = `tog ${cls}`; b.dataset.param = param; b.textContent = label;
        b.addEventListener("click", () => {
          const t = ch.toggles.find((x) => x.param === param);
          if (t) { t.btn.click(); renderDrawerValues(); }
        });
        row.appendChild(b);
      }
      btnSec.appendChild(row);
    }
    renderDrawerHead();
    renderDrawerValues();
    selectDrawerTab(drawerTab);
  }

  function fillDevices() {
    const sel = $("#deviceSelect");
    if (!sel || !drawerCh) return;
    const ch = drawerCh;
    const current = (ch.data && ch.data.device) || "";
    const list = (ch.kind === "strip" ? deviceCache.inputs : deviceCache.outputs) || [];
    const groups = [["wdm", "WDM (recommended)"], ["ks", "Kernel streaming"], ["mme", "MME"]];
    if (ch.kind === "bus" && ch.i === 0) groups.push(["asio", "ASIO"]);
    sel.textContent = "";
    sel.appendChild(new Option("No device", "wdm|"));
    let picked = !current;
    for (const [type, label] of groups) {
      const items = list.filter((d) => d.type === type);
      if (!items.length) continue;
      const og = document.createElement("optgroup");
      og.label = label;
      for (const d of items) {
        const o = new Option(d.name, `${type}|${d.name}`);
        if (!picked && d.name === current) { o.selected = true; picked = true; }
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    if (!picked) {
      const o = new Option(`${current} (current)`, `wdm|${current}`);
      o.selected = true;
      sel.insertBefore(o, sel.options[1] || null);
    }
  }

  function renderDrawerValues() {
    const ch = drawerCh, d = ch && ch.data;
    if (!d) return;
    renderDrawerHead();
    const map = { Pan_x: d.pan, Comp: d.comp, Gate: d.gate, EQGain1: (d.eq || [])[0], EQGain2: (d.eq || [])[1], EQGain3: (d.eq || [])[2], Limit: d.limit };
    (d.layers || []).forEach((v, j) => { map[`GainLayer[${j}]`] = v; });
    drawerBody.querySelectorAll("input[type=range]").forEach((inp) => {
      const v = map[inp.dataset.param];
      if (v === undefined || document.activeElement === inp) return;
      inp.value = v;
      inp._paint();
    });
    const mode = $("#busMode");
    if (mode && document.activeElement !== mode) mode.value = d.mode || "normal";
    drawerBody.querySelectorAll(".drawer-sources [data-source]").forEach((b) => {
      const input = chans.find((c) => c.prefix === b.dataset.source);
      const send = input?.toggles.find((t) => t.param === ch.info.param);
      if (!send) return;
      const name = displayName(input);
      if (b.textContent !== name) b.textContent = name;
      b.setAttribute("aria-label", `Send ${name} to ${ch.info.id}`);
      b.setAttribute("aria-pressed", send.btn.getAttribute("aria-pressed"));
    });
    drawerBody.querySelectorAll(".drawer-togs .tog, .drawer-routes .route").forEach((b) => {
      const t = ch.toggles.find((x) => x.param === b.dataset.param);
      if (t) b.setAttribute("aria-pressed", t.btn.getAttribute("aria-pressed"));
    });
  }

  /* ---------- Output mix: every input's level on every output (Potato gain layers) ---------- */
  const mixViewDlg = $("#mixViewDlg"), mixViewBtn = $("#mixViewBtn"), mixViewEl = $("#mixView");
  let mixSliders = [];
  function mixSlider(ch, bus, role) {
    const el = document.createElement("div");
    el.className = "mx-sl"; el.tabIndex = 0; el.setAttribute("role", "slider");
    el.setAttribute("aria-valuemin", String(MIN_DB)); el.setAttribute("aria-valuemax", String(MAX_DB));
    const id = bus.info.id, param = `GainLayer[${bus.i}]`;
    // Same look as the strips' A/B buttons, so it lights up in every theme when on.
    el.innerHTML = `<span class="mx-val"></span><div class="mx-track"><div class="mx-unity"></div><div class="mx-fill"></div><div class="mx-thumb"></div></div><button type="button" class="route ${id[0] === "A" ? "a" : "b"}"></button>`;
    const track = $(".mx-track", el), route = $(".route", el);
    route.textContent = id;
    if (role) el.prepend(Object.assign(document.createElement("span"), { className: "mx-role", textContent: role }));
    route.title = `Send ${displayName(ch)} to ${id} ${displayName(bus)}`;
    $(".mx-unity", el).style.bottom = `${dbToPos(0) * 100}%`;
    const s = { ch, bus, el, v: 0, lockUntil: 0, routeLock: 0 };
    const paint = () => {
      const p = dbToPos(s.v);
      $(".mx-fill", el).style.height = `${p * 100}%`;
      $(".mx-thumb", el).style.bottom = `${p * 100}%`;
      $(".mx-val", el).textContent = fmtDb(s.v);
      el.setAttribute("aria-valuenow", s.v.toFixed(1));
      el.setAttribute("aria-label", `${displayName(ch)} on ${id} ${displayName(bus)}`);
    };
    const set = (v) => {
      s.v = Math.round(Math.min(MAX_DB, Math.max(MIN_DB, v)) * 10) / 10;
      s.lockUntil = performance.now() + 800;
      paint();
      sendFloat(`${ch.prefix}.${param}`, s.v);
    };
    const at = (e) => { const r = track.getBoundingClientRect(); return posToDb(Math.min(1, Math.max(0, (r.bottom - e.clientY) / r.height))); };
    track.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; track.setPointerCapture(e.pointerId); s.drag = true; set(at(e)); el.focus({ preventScroll: true }); });
    track.addEventListener("pointermove", (e) => { if (s.drag) set(at(e)); });
    const end = () => { s.drag = false; };
    track.addEventListener("pointerup", end); track.addEventListener("pointercancel", end);
    el.addEventListener("dblclick", (e) => { if (!e.target.closest(".route")) set((ch.data && ch.data.gain) || 0); });
    el.addEventListener("wheel", (e) => { e.preventDefault(); set(s.v + (e.deltaY < 0 ? 1 : -1) * (e.altKey ? 0.1 : 0.5)); }, { passive: false });
    el.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.1 : 0.5;
      const v = { ArrowUp: s.v + step, ArrowRight: s.v + step, ArrowDown: s.v - step, ArrowLeft: s.v - step, PageUp: s.v + 3, PageDown: s.v - 3, Home: MIN_DB, End: MAX_DB }[e.key];
      if (v !== undefined) { e.preventDefault(); set(v); }
    });
    route.addEventListener("click", () => {
      const on = route.getAttribute("aria-pressed") !== "true";
      route.setAttribute("aria-pressed", String(on));
      el.classList.toggle("off", !on);
      s.routeLock = performance.now() + 800;   // until Voicemeeter's state catches up
      sendFloat(`${ch.prefix}.${id}`, on ? 1 : 0);
    });
    s.paint = paint; s.route = route;
    mixSliders.push(s);
    return el;
  }
  const mixMode = $("#mixViewMode");
  const busOptions = (list) => list.map((b) => new Option(`${b.info.id} · ${displayName(b)}`, b.prefix));
  const streamBus = () => chans.find((b) => b.prefix === settings.streamBus && b.info.kind === "virt")
    || chans.find((b) => b.prefix === `Bus[${defaultStreamBus()}]`);
  function captureForBus(bus, devices) {
    const number = bus.info.id.slice(1) || "1";
    if (isHw(bus)) return devices.find((d) => new RegExp(`voicemeeter out a${number}\\b`, "i").test(d)) || "";
    const legacy = { 1: /voicemeeter output/i, 2: /voicemeeter aux output/i, 3: /vaio3 output/i }[number];
    return devices.find((d) => new RegExp(`voicemeeter out b${number}\\b`, "i").test(d)) || devices.find((d) => legacy?.test(d)) || "";
  }
  const physicalPlayback = (devices) => [...new Set(devices)].filter((d) => !/voicemeeter|vb-audio|virtual cable|cable input|cable-[abcd]/i.test(d));
  const mixSig = () => [settings.mixViewMode, settings.personalBus, settings.audienceBus, settings.streamBus, ...chans.map((c) => { const l = look(c); return `${c.kind}${c.i}:${displayName(c)}:${l.hidden ? 1 : 0}${l.mix ? 1 : 0}:${l.color}:${l.icon}`; })].join("|");
  function buildMixView() {
    mixViewEl.textContent = "";
    mixSliders = [];
    mixViewDlg.dataset.built = mixSig();
    // Outputs hidden from the mixer, or just from Mix (output settings), stay out.
    const outputs = chans.filter((c) => c.kind === "bus");
    const personal = outputs.filter((c) => c.info.kind === "hw"), audience = outputs.filter((c) => c.info.kind !== "hw");
    mixMode.value = settings.mixViewMode === "pair" ? "pair" : "all";
    const pair = mixMode.value === "pair";
    mixViewEl.classList.toggle("mix-paired", pair);
    const audienceBus = audience.some((b) => b.prefix === settings.audienceBus) ? settings.audienceBus : streamBus()?.prefix;
    for (const [selector, list, value] of [["#mixPersonal", personal, settings.personalBus], ["#mixStream", audience, audienceBus]]) {
      const select = $(selector);
      select.replaceChildren(...busOptions(list));
      if (list.some((b) => b.prefix === value)) select.value = value;
      select.parentElement.hidden = !pair;
    }
    const buses = pair ? [$("#mixPersonal").value, $("#mixStream").value].map((p) => outputs.find((b) => b.prefix === p)).filter(Boolean)
      : outputs.filter((c) => !look(c).hidden && look(c).mix);
    for (const ch of chans.filter((c) => c.kind === "strip" && !look(c).hidden)) {
      const col = document.createElement("div");
      col.className = "mx-col";
      col.dataset.color = look(ch).color;
      const head = document.createElement("div");
      head.className = "mx-head";
      const chip = Object.assign(document.createElement("span"), { className: "chip small" });
      chip.innerHTML = svg(look(ch).icon, 14);
      head.append(chip, Object.assign(document.createElement("span"), { textContent: displayName(ch), title: displayName(ch) }));
      const row = document.createElement("div");
      row.className = "mx-row";
      for (const b of buses) row.appendChild(mixSlider(ch, b, pair ? (b.info.kind === "hw" ? "Personal" : "Stream") : ""));
      col.append(head, row);
      mixViewEl.appendChild(col);
    }
    paintMixView();
  }
  function paintMixView() {
    if (!mixViewDlg.open) return;
    const st = lastState;
    const picked = st ? (st.buses || []).findIndex((b) => b.sel) : -1;
    for (const s of mixSliders) {
      const d = s.ch.data || {};
      const v = (d.layers || [])[s.bus.i];
      if (v !== undefined && !s.drag && performance.now() > s.lockUntil) s.v = v;
      const id = s.bus.info.id, n = +id.slice(1) - 1;
      const on = !!(id[0] === "A" ? (d.a || [])[n] : (d.b || [])[n]);
      // Follow every change (Stream Deck, Voicemeeter, the strips), except just after a click here.
      if (performance.now() > s.routeLock) {
        s.route.setAttribute("aria-pressed", String(on));
        s.el.classList.toggle("off", !on);
      }
      s.el.classList.toggle("picked", picked === s.bus.i);
      s.paint();
    }
  }
  mixViewBtn.addEventListener("click", () => {
    // Already popped out: bring that window forward instead of opening a second copy.
    if (settings.mixWinOpen) { engine.mixWindow(true).catch(() => {}); return; }
    mixViewDlg.showModal(); buildMixView();
  });
  async function setMixPreference(key, value) {
    const previous = settings[key];
    settings[key] = value;
    if (mixViewDlg.open) buildMixView();
    try { await engine.mixPreferenceSet(key, value); return true; }
    catch (err) {
      if (settings[key] === value) settings[key] = previous;
      if (mixViewDlg.open) buildMixView();
      fail(err);
      return false;
    }
  }
  for (const [id, key] of [["mixViewMode", "mixViewMode"], ["mixPersonal", "personalBus"], ["mixStream", "audienceBus"]]) {
    $(`#${id}`).addEventListener("change", (e) => setMixPreference(key, e.target.value));
  }
  mixViewDlg.addEventListener("click", (e) => { if (e.target === mixViewDlg) mixViewDlg.close(); });
  $("#mixPopBtn").addEventListener("click", () => {
    mixViewDlg.close();
    settings.mixWinOpen = true;
    engine.mixWindow(true).catch((e) => { settings.mixWinOpen = false; toast(`Couldn't open the window: ${e}`); });
  });
  // In its own window the dialog is the whole page: close and minimise act on the window.
  function setupMixWindow() {
    document.body.classList.add("is-mixwin");
    $("#mixPopBtn").hidden = true;
    $("#mixMinBtn").hidden = false;
    const api = window.__TAURI__ && window.__TAURI__.window ? window.__TAURI__.window.getCurrentWindow() : null;
    $("#mixMinBtn").addEventListener("click", () => { if (api) api.minimize().catch(() => {}); });
    $("#mixCloseBtn").addEventListener("click", (e) => { e.preventDefault(); engine.mixWindow(false).catch(() => window.close()); });
    mixViewDlg.addEventListener("cancel", (e) => e.preventDefault());
    // Drag the window by its heading; double-click to maximise or restore.
    $(".dlg-head", mixViewDlg).addEventListener("mousedown", (e) => {
      if (!api || e.button !== 0 || e.target.closest("button")) return;
      if (e.detail === 2) api.toggleMaximize().catch(() => {}); else api.startDragging().catch(() => {});
    });
    mixViewDlg.show();
    buildMixView();
  }

  /* ---------- live monitor of a virtual output ---------- */
  const monitorDlg = $("#mixMonitorDlg"), monitorIn = $("#mixMonitorInput"), monitorOut = $("#mixMonitorOutput");
  const monitorStart = $("#mixMonitorStart"), monitorStop = $("#mixMonitorStop"), monitorStatus = $("#mixMonitorStatus");
  let monitorBusy = false, monitoring = false, monitorGeneration = 0;
  let monitorCue = null, monitorStreamEndpoint = "", monitorPersonalEndpoint = "", monitorPersonalDevice = "";
  function paintMonitor() {
    monitorStart.disabled = monitorBusy || monitoring || !monitorIn.value || !monitorOut.value;
    monitorStop.disabled = monitorBusy || !monitoring;
    monitorIn.disabled = monitorOut.disabled = monitorBusy || monitoring;
    $("#mixMonitorPersonal").disabled = monitorBusy;
    $("#mixMonitorStream").disabled = monitorBusy || !monitorOut.value || !monitorStreamEndpoint;
  }
  async function openMonitor(source) {
    if (!connected) return toast("Start Voicemeeter to listen to a mix");
    if (monitorDlg.open) return;
    const cue = source?.kind === "strip" ? source : null;
    monitorCue = null;
    monitorStreamEndpoint = "";
    monitorPersonalEndpoint = monitorPersonalDevice = "";
    $("#monitorMixSwitch").hidden = !!cue;
    $("#mixMonitorTitle").textContent = cue ? `Cue · ${displayName(cue)}` : "Listen to a mix";
    const generation = ++monitorGeneration, previous = monitorOut.value;
    monitorIn.replaceChildren();
    monitorOut.replaceChildren();
    monitorStatus.textContent = "Reading audio devices…";
    paintMonitor();
    monitorDlg.showModal();
    try {
      const [capture, playback, routes] = await Promise.all([
        engine.selftestInputs(), engine.soundDevices(), cue ? engine.appRouteDevices() : Promise.resolve(null),
      ]);
      if (generation !== monitorGeneration) return;
      const available = chans.filter((c) => c.kind === "bus").map((c) => [c, captureForBus(c, capture.devices || [])])
        .filter(([, endpoint]) => endpoint);
      monitorIn.replaceChildren(...available.map(([c, endpoint]) => new Option(`${c.info.id} · ${displayName(c)}`, endpoint)));
      const desired = available.find(([c]) => !isHw(c) && c.prefix === settings.audienceBus) || available.find(([c]) => c === streamBus());
      monitorStreamEndpoint = desired?.[1] || "";
      if (monitorStreamEndpoint) monitorIn.value = monitorStreamEndpoint;
      const outputs = physicalPlayback(playback.devices || []);
      monitorOut.replaceChildren(new Option("Choose a playback device", ""), ...outputs.map((name) => new Option(name, name)));
      const personal = chans.find((c) => c.kind === "bus" && c.prefix === settings.personalBus)
        || chans.find((c) => c.kind === "bus" && isHw(c) && c.i === 0);
      const device = outputs.find((name) => name === personal?.data?.device);
      monitorPersonalEndpoint = available.find(([c]) => c === personal)?.[1] || "";
      monitorPersonalDevice = device || "";
      if (outputs.includes(previous) || device) monitorOut.value = outputs.includes(previous) ? previous : device;
      monitorStatus.textContent = !available.length ? "No Voicemeeter virtual recording outputs are available." : !outputs.length ? "No headphones or speakers are available." : "";
      if (cue) {
        routeDevices = routes;
        const hardwareCapture = isHw(cue) && cue.data?.device && !/cable|voicemeeter/i.test(cue.data.device);
        const render = hardwareCapture ? null : deviceForChannel(cue);
        monitorCue = !!render;
        const input = render?.name || (isHw(cue) ? cue.data?.device : "");
        monitorIn.replaceChildren(...(input ? [new Option(input, input)] : []));
        monitorStatus.textContent = input
          ? "The cue uses the input before the mixer fader and effects. Choose headphones outside your streaming app’s desktop capture."
          : "This input has no Windows playback or recording endpoint available for cue.";
      }
    } catch (e) { if (generation === monitorGeneration) monitorStatus.textContent = String(e); }
    finally { paintMonitor(); }
  }
  async function stopMonitor() {
    monitoring = false;
    monitorBusy = true;
    paintMonitor();
    try { await engine.mixMonitorStop(); }
    catch (e) { fail(e); }
    finally { monitorBusy = false; paintMonitor(); }
  }
  $("#mixMonitorOpen").addEventListener("click", openMonitor);
  $("#outputsMonitorOpen").addEventListener("click", openMonitor);
  monitorIn.addEventListener("change", paintMonitor);
  monitorOut.addEventListener("change", paintMonitor);
  async function startMonitor() {
    const generation = monitorGeneration;
    monitorBusy = true;
    paintMonitor();
    try {
      await engine.mixMonitorStart(monitorIn.value, monitorOut.value, monitorCue);
      if (generation !== monitorGeneration || !monitorDlg.open) { await engine.mixMonitorStop(); return; }
      monitoring = true;
      monitorStatus.textContent = monitorCue !== null ? `Cueing ${monitorIn.selectedOptions[0].textContent}`
        : `Listening to ${monitorIn.selectedOptions[0].textContent}. For an isolated comparison, select a different device from your normal personal output.`;
    } catch (e) { if (generation === monitorGeneration) monitorStatus.textContent = String(e); }
    finally { monitorBusy = false; paintMonitor(); }
  }
  monitorStart.addEventListener("click", startMonitor);
  $("#mixMonitorPersonal").addEventListener("click", async () => {
    if (monitoring && monitorIn.value === monitorPersonalEndpoint) return;
    if (monitoring) await stopMonitor();
    if (!monitorDlg.open) return;
    if (monitorPersonalEndpoint && monitorOut.value && monitorOut.value !== monitorPersonalDevice) {
      monitorIn.value = monitorPersonalEndpoint;
      await startMonitor();
      return;
    }
    monitorStatus.textContent = "Personal mix · listening through your normal mixer outputs";
  });
  $("#mixMonitorStream").addEventListener("click", async () => {
    if (monitoring && monitorIn.value === monitorStreamEndpoint) return;
    if (monitoring) await stopMonitor();
    if (!monitorDlg.open) return;
    monitorIn.value = monitorStreamEndpoint;
    await startMonitor();
  });
  monitorStop.addEventListener("click", async () => { await stopMonitor(); monitorStatus.textContent = "Stopped"; });
  monitorDlg.addEventListener("close", () => { monitorGeneration++; if (monitoring || monitorBusy) stopMonitor(); });
  engine.onMixMonitorEnded((message) => { monitoring = false; monitorStatus.textContent = message; paintMonitor(); }).catch(() => {});

  /* ---------- Potato output select: the faders set one output's mix ---------- */
  const mixFor = $("#mixFor");
  function applyMixFor(st) {
    const on = st.edition === 3 && (st.buses || []).length > 0;
    $("#mixForWrap").hidden = !on || PANEL;
    mixViewBtn.hidden = !on || SIDE;
    if (MIXWIN) {
      $("#mixViewNote").hidden = on;
      $("#mixView").hidden = !on;
      $("#mixViewControls").hidden = !on;
    } else if (!on && mixViewDlg.open) mixViewDlg.close();
    // Channels and outputs can change (renamed, hidden, recoloured) while Mix is open: rebuild when they do.
    if (!on) mixViewDlg.dataset.built = "";
    else if ((MIXWIN || mixViewDlg.open) && mixSig() !== mixViewDlg.dataset.built) buildMixView();
    paintMixView();
    if (!on) { document.body.classList.remove("mixing-output"); return; }
    const buses = chans.filter((c) => c.kind === "bus");
    const want = ["", ...buses.map((b) => String(b.i))].join("|") + "#" + buses.map(displayName).join("|");
    if (mixFor.dataset.built !== want) {
      mixFor.dataset.built = want;
      mixFor.textContent = "";
      mixFor.appendChild(new Option("All outputs", ""));
      for (const b of buses) mixFor.appendChild(new Option(`${(b.info && b.info.id) || ""} ${displayName(b)}`.trim(), String(b.i)));
    }
    const sel = st.buses.findIndex((b) => b.sel);
    if (document.activeElement !== mixFor) mixFor.value = sel < 0 ? "" : String(sel);
    document.body.classList.toggle("mixing-output", sel >= 0);
  }
  mixFor.addEventListener("change", () => {
    const pick = mixFor.value === "" ? -1 : +mixFor.value;
    // Voicemeeter lets several be selected through its API; Sleekmeeter keeps it to one.
    chans.filter((c) => c.kind === "bus").forEach((b) => sendFloat(`Bus[${b.i}].Sel`, b.i === pick ? 1 : 0));
    toast(pick < 0 ? "Faders set every output again" : `Input faders now set ${mixFor.selectedOptions[0].textContent}'s mix`);
  });

  /* ---------- Game / Chat balance ---------- */
  const balanceDlg = $("#balanceDlg"), balanceSlider = $("#balanceValue");
  const balanceGame = $("#balanceGame"), balanceChat = $("#balanceChat"), balanceBus = $("#balanceBus");
  const balancePinned = $("#balancePinnedValue");
  const balancePickers = [balanceGame, balanceChat, balanceBus];
  let balanceSession = null, balanceBusy = false, balanceQueued = null, balanceTimer = 0;
  let balanceMeterAt = 0;
  function openBalance() {
    if (balanceDlg.open) return;
    if (!connected || !layout) { toast("Start Voicemeeter to balance game and chat"); return; }
    if (balanceBusy || balanceQueued !== null) { balanceDlg.showModal(); return; }
    populateBalance();
    balanceSlider.value = balanceQueued ?? balanceSession?.position ?? 0;
    $("#balancePinToggle").checked = !!settings.chatBalancePinned;
    $("#balanceGameApp").value = settings.chatBalanceApps?.game || "";
    $("#balanceChatApp").value = settings.chatBalanceApps?.chat || "";
    $("#balanceSetupStatus").textContent = "";
    paintBalance();
    balanceDlg.showModal();
    refreshBalanceApps();
    refreshBalanceStatus();
  }
  function populateBalance() {
    const inputs = chans.filter((c) => c.kind === "strip");
    const hardware = chans.filter((c) => c.kind === "bus" && c.info.kind === "hw");
    if (balanceSession?.edition !== layout.edition) balanceSession = null;
    const prefs = balanceSession?.prefs || settings.chatBalance || {};
    for (const [el, list, value, pattern] of [
      [balanceGame, inputs, prefs.game, /^(?!.*(?:chat|discord)).*\bgame\b/i],
      [balanceChat, inputs, prefs.chat, /chat|discord/i],
      [balanceBus, hardware, prefs.bus || settings.personalBus, /headphone/i],
    ]) {
      el.replaceChildren(new Option("Choose…", ""), ...list.map((c) => new Option(displayName(c), c.prefix)));
      el.value = list.find((c) => c.prefix === value)?.prefix || list.find((c) => pattern.test(displayName(c)))?.prefix
        || (el === balanceBus ? list.find((c) => c.data?.device)?.prefix : "") || "";
    }
    $("#balanceScope").textContent = layout.edition === 3
      ? "Drag to balance your listening output live. Other outputs keep their levels."
      : "Drag to balance both inputs live. On this edition their main faders affect every route, including stream sends.";
  }
  function balanceSelection() {
    return { game: balanceGame.value, chat: balanceChat.value, bus: balanceBus.value };
  }
  function balanceProblem(prefs) {
    if (!connected) return "Start Voicemeeter to adjust the balance.";
    const game = chans.find((c) => c.prefix === prefs.game), chat = chans.find((c) => c.prefix === prefs.chat);
    if (!game || !chat || game === chat) return "Choose two separate inputs for Game and Chat.";
    if (layout.edition !== 3) return "";
    const bus = chans.find((c) => c.prefix === prefs.bus);
    if (!bus) return "Choose your listening output.";
    const name = `${bus.info.id} · ${displayName(bus)}`;
    if (!bus.data?.device) return `Choose a playback device for ${name} in Outputs.`;
    if (bus.data.mute) return `Unmute ${name} to hear the balance.`;
    if (bus.data.mode?.toLowerCase() === "composite") return `Set ${name} to Normal mode, or choose another listening output.`;
    const missing = [game, chat].filter((c) => !c.data?.a?.[bus.i]);
    if (missing.length) return `Enable ${bus.info.id} on ${missing.map(displayName).join(" and ")} to hear both inputs there.`;
    return "";
  }
  function paintBalance() {
    const v = +balanceSlider.value;
    const status = !v ? "Centred" : Math.abs(v) === 100 ? `${v < 0 ? "Chat" : "Game"} at minimum` : `${v < 0 ? "Chat" : "Game"} −${(Math.abs(v) * .3).toFixed(1)} dB`;
    if ($("#balanceStatus").textContent !== status) $("#balanceStatus").textContent = status;
    const prefs = balanceSelection(), problem = balanceProblem(prefs);
    const muted = [prefs.game, prefs.chat].map((key) => chans.find((c) => c.prefix === key)).filter((ch) => ch?.data?.mute);
    const route = problem || (muted.length ? `Muted input · ${muted.map(displayName).join(", ")}` : "");
    if ($("#balanceRoute").textContent !== route) $("#balanceRoute").textContent = route;
    balanceSlider.disabled = !!problem;
    balancePinned.value = balanceSlider.value;
    balancePinned.title = problem || status;
    balancePinned.disabled = !!problem;
    balancePickers.forEach((el) => { el.disabled = !!balanceSession || balanceBusy || balanceQueued !== null; });
    $("#balanceReset").disabled = !connected || (!balanceSession && !v);
    $("#balancePinnedReset").disabled = $("#balanceReset").disabled;
    $("#balanceSave").disabled = !prefs.game || !prefs.chat || prefs.game === prefs.chat || (layout.edition === 3 && !prefs.bus);
    $("#balanceUseMain").hidden = layout.edition !== 3;
    $("#balanceUseMain").disabled = !connected || balanceBusy || balanceQueued !== null || $("#balanceSave").disabled;
  }
  function paintBalanceSignal(lv) {
    if (performance.now() - balanceMeterAt < 260) return;
    balanceMeterAt = performance.now();
    const prefs = balanceSelection();
    const output = $("#balanceSignal");
    output.textContent = !prefs.game || !prefs.chat ? "" : ["game", "chat"].map((key) => {
      const ch = chans.find((c) => c.prefix === prefs[key]);
      const pair = lv.inputs?.[ch?.i];
      const level = pair ? Math.max(...pair) : -200;
      return `${key === "game" ? "Game" : "Chat"} ${level > -80 ? fmtDb(level) + " dBFS" : "quiet"}`;
    }).join(" · ");
  }
  function queueBalance(position) {
    balanceQueued = position;
    paintBalance();
    if (!balanceBusy && !balanceTimer) {
      balanceTimer = setTimeout(() => {
        balanceTimer = 0;
        const next = balanceQueued;
        balanceQueued = null;
        applyBalance(next);
      }, 90);
    }
  }
  async function applyBalance(position, useMain = false) {
    const prefs = balanceSelection();
    if (!connected || (position ? balanceProblem(prefs) : !balanceSession && !useMain)) {
      balanceSlider.value = balanceSession?.position ?? 0;
      paintBalance();
      return;
    }
    balanceBusy = true;
    paintBalance();
    try {
      const result = await engine.chatBalanceSet(prefs, position, useMain);
      acceptBalance(result, prefs);
      if (JSON.stringify(settings.chatBalance) !== JSON.stringify(prefs)) {
        settings.chatBalance = prefs;
        saveSettings();
      }
    } catch (e) { $("#balanceApplied").textContent = String(e); fail(e); }
    finally {
      balanceBusy = false;
      if (balanceQueued !== null) queueBalance(balanceQueued);
      else balanceSlider.value = balanceSession?.position ?? 0;
      paintBalance();
    }
  }
  function acceptBalance(result, prefs = settings.chatBalance) {
    if (result.edition && result.edition !== layout.edition) return;
    prefs = result.selection || prefs;
    balanceSession = result.position && prefs ? { position: result.position, prefs, edition: layout.edition } : null;
    if (!balanceBusy && balanceQueued === null) balanceSlider.value = result.position || 0;
    if (result.levels) $("#balanceApplied").textContent = `Voicemeeter levels · Game ${fmtDb(result.levels[0])} dB · Chat ${fmtDb(result.levels[1])} dB`;
    paintBalance();
  }
  function refreshBalanceStatus() {
    engine.chatBalanceStatus().then((result) => {
      if (connected && layout && !balanceBusy && balanceQueued === null && result.position) {
        acceptBalance(result);
        populateBalance();
        paintBalance();
      }
    }).catch(fail);
  }
  async function refreshBalanceApps() {
    try {
      const [devices, apps] = await Promise.all([engine.appRouteDevices(), engine.appVolumes()]);
      routeDevices = devices;
      $("#balanceApps").replaceChildren(...apps.filter((a) => a.exe?.endsWith(".exe")).map((a) => new Option(a.name, a.exe)));
      return apps;
    } catch (e) { $("#balanceSetupStatus").textContent = String(e); return []; }
  }
  $("#balanceAssign").addEventListener("click", async (e) => {
    const button = e.currentTarget, status = $("#balanceSetupStatus");
    const exes = ["#balanceGameApp", "#balanceChatApp"].map((id) => $(id).value.trim().toLowerCase());
    if (exes[0] === exes[1] || exes.some((exe) => !/^[^\\/:*?"<>|]+\.exe$/i.test(exe))) {
      status.textContent = "Enter two different executable names, such as game.exe and discord.exe."; return;
    }
    button.disabled = true;
    try {
      await refreshBalanceApps();
      const prefs = balanceSelection();
      const channels = [prefs.game, prefs.chat].map((key) => chans.find((c) => c.prefix === key));
      const devices = channels.map((ch) => ch && deviceForChannel(ch));
      if (!devices.every(Boolean) || devices[0].id === devices[1].id) {
        status.textContent = "Choose two inputs with separate Windows playback devices. Voicemeeter virtual inputs and virtual cables can be assigned."; return;
      }
      for (const [i, exe] of exes.entries()) {
        if (!await saveAssignment(exe, channels[i])) {
          status.textContent = `Could not save the assignment for ${exe}. Check Windows audio routing and retry.`; return;
        }
      }
      settings.chatBalanceApps = { game: exes[0], chat: exes[1] };
      settings.chatBalance = prefs;
      await saveNow();
      status.textContent = `Game → ${devices[0].name} · Chat → ${devices[1].name}. If an app is still on its old device, restart its audio.`;
    } finally { button.disabled = false; }
  });
  $("#balanceSend").addEventListener("click", async () => {
    const prefs = balanceSelection();
    const bus = chans.find((c) => c.prefix === prefs.bus && isHw(c));
    const inputs = [prefs.game, prefs.chat].map((key) => chans.find((c) => c.prefix === key && c.kind === "strip"));
    if (!bus || !inputs.every(Boolean) || inputs[0] === inputs[1]) {
      $("#balanceSetupStatus").textContent = "Choose two separate inputs and a hardware listening output first."; return;
    }
    try {
      for (const ch of inputs) {
        if (partMuted(ch).includes(bus.info.param)) await engine.routeMute(ch.i, bus.info.param, false);
        else if (!routeOn(ch, bus.info.param)) await engine.setFloat(`${ch.prefix}.${bus.info.param}`, 1);
      }
      $("#balanceSetupStatus").textContent = `Both inputs are sent to ${displayName(bus)}.`;
    } catch (e) { $("#balanceSetupStatus").textContent = String(e); }
  });
  $("#balanceVerify").addEventListener("click", async (e) => {
    const button = e.currentTarget, status = $("#balanceSetupStatus");
    button.disabled = true;
    try {
      const apps = await refreshBalanceApps();
      const prefs = balanceSelection();
      const paths = ["game", "chat"].map((key) => {
        const title = key === "game" ? "Game" : "Chat";
        const exe = $(key === "game" ? "#balanceGameApp" : "#balanceChatApp").value.trim().toLowerCase();
        if (!exe) return `${title}: choose an app`;
        const channel = chans.find((c) => c.prefix === prefs[key]);
        const expected = channel && deviceForChannel(channel);
        if (!expected) return `${title}: selected input has no Windows endpoint`;
        const app = apps.find((a) => a.exe === exe);
        if (!app?.endpoints?.length) return `${title}: play audio in ${exe} to verify`;
        const matches = app.endpoints.some((id) => id.toLowerCase() === expected.id.toLowerCase());
        return `${title}: ${matches ? displayName(channel) + " confirmed" : exe + " is playing through a different Windows device"}`;
      });
      status.textContent = paths.join(" · ");
    } finally { button.disabled = false; }
  });
  $("#balanceSave").addEventListener("click", async () => {
    settings.chatBalance = balanceSelection();
    if (await saveNow()) $("#balanceApplied").textContent = "Assignments saved. Game / Chat shortcuts are available in Controls & remote.";
    if (lastState) applyState(lastState);
  });
  $("#balancePinToggle").addEventListener("change", (e) => {
    settings.chatBalancePinned = e.target.checked;
    if (!$("#balanceSave").disabled) settings.chatBalance = balanceSelection();
    saveSettings();
    if (lastState) applyState(lastState);
  });
  balancePickers.forEach((el) => el.addEventListener("change", paintBalance));
  balanceSlider.addEventListener("input", () => queueBalance(+balanceSlider.value));
  balancePinned.addEventListener("input", () => { balanceSlider.value = balancePinned.value; queueBalance(+balanceSlider.value); });
  $("#balanceReset").addEventListener("click", () => { balanceSlider.value = 0; queueBalance(0); });
  $("#balancePinnedReset").addEventListener("click", () => $("#balanceReset").click());
  $("#balanceUseMain").addEventListener("click", () => applyBalance(0, true));
  engine.onChatBalance((result) => {
    if (!balanceBusy && layout) { if (!balanceDlg.open) populateBalance(); acceptBalance(result); }
  }).catch(() => {});
  $("#balanceMixer").addEventListener("click", openBalance);
  $("#balanceMix").hidden = SIDE;
  $("#balanceMix").addEventListener("click", openBalance);

  /* ---------- offline overlay ---------- */
  const launchBtn = $("#launchBtn");
  function showOffline(kind) {
    $("#offline").hidden = !kind;
    if (!kind) { launchBtn.disabled = false; launchBtn.textContent = "Start Voicemeeter"; return; }
    if (kind === "missing") {
      $("#offlineTitle").textContent = "Voicemeeter isn't installed";
      $("#offlineBody").textContent = "Install Voicemeeter (Standard, Banana or Potato) from voicemeeter.com, then reopen Sleekmeeter.";
      launchBtn.hidden = true;
    } else {
      $("#offlineTitle").textContent = "Voicemeeter isn't running";
      $("#offlineBody").textContent = "Sleekmeeter controls Voicemeeter. Start it and your mixer appears here.";
      launchBtn.hidden = false;
    }
  }
  launchBtn.addEventListener("click", () => {
    launchBtn.disabled = true; launchBtn.textContent = "Starting Voicemeeter…";
    engine.launch().catch(fail);
    setTimeout(() => { launchBtn.disabled = false; launchBtn.textContent = "Start Voicemeeter"; }, 10000);
  });

  /* ---------- header: pin, mini mode, more menu ---------- */
  const pinBtn = $("#pinBtn"), miniBtn = $("#miniBtn");
  pinBtn.addEventListener("click", () => {
    settings.alwaysOnTop = !settings.alwaysOnTop;
    pinBtn.setAttribute("aria-pressed", String(settings.alwaysOnTop));
    toast(settings.alwaysOnTop ? "Sleekmeeter stays on top" : "Sleekmeeter no longer stays on top");
    saveSettings();
  });
  function setMini(on, save) {
    settings.mini = on;
    document.body.classList.toggle("is-mini", on);
    $("#desk").hidden = on;
    $("#miniView").hidden = !on;
    wakeMeters();
    miniBtn.setAttribute("aria-pressed", String(on));
    miniBtn.title = miniBtn.ariaLabel = on ? "Full mixer" : "Mini mode";
    if (on && drawerCh) closeDrawer();
    syncMiniWindow(on);
    if (save) saveSettings();
  }
  miniBtn.addEventListener("click", () => setMini(!settings.mini, true));

  const moreBtn = $("#moreBtn"), moreMenu = $("#moreMenu");
  const menuItems = () => [...moreMenu.querySelectorAll("button")].filter((b) => !b.hidden && !b.disabled);
  const setMenu = (open, last = false) => {
    moreMenu.hidden = !open;
    moreBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      const items = menuItems();
      (last ? items[items.length - 1] : items[0])?.focus();
    }
  };
  moreBtn.addEventListener("click", () => setMenu(moreMenu.hidden));
  moreBtn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setMenu(true, e.key === "ArrowUp"); }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !moreMenu.hidden) { setMenu(false); moreBtn.focus(); } });
  moreMenu.addEventListener("keydown", (e) => {
    if (e.key === "Tab") { setMenu(false); moreBtn.focus(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const items = menuItems(), at = items.indexOf(document.activeElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1
      : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  });
  moreMenu.addEventListener("click", (e) => {
    const a = e.target.closest("button")?.dataset.action;
    if (!a) return;
    setMenu(false);
    moreBtn.focus();
    if (a === "quick") openQuickActions();
    if (a === "events") openAudioEvents();
    if (a === "show") engine.showWindow().catch(fail);
    if (a === "restart") engine.setFloat("Command.Restart", 1).then(() => toast("Restarting audio engine")).catch(fail);
    if (a === "options") openOptions();
    if (a === "setup") openSetup();
    if (a === "balance") openBalance();
    if (a === "hear") openHear();
    if (a === "chain") openChain();
    if (a === "history") openHistory();
    if (a === "subs") {
      // One click: if any device line is showing, hide them all; otherwise show them all.
      const chs = chans;
      const hide = chs.some((c) => !look(c).hideSub);
      settings.appearance = settings.appearance || {};
      for (const c of chs) settings.appearance[c.key] = Object.assign({}, settings.appearance[c.key], { hideSub: hide });
      saveSettings(); chs.forEach(paintLook);
      toast(hide ? "Device names hidden" : "Device names shown");
    }
    if (a === "simple") setSimple(!settings.simpleMode);
    if (a === "resetorder") { settings.order = {}; applyOrder(); saveSettings(); toast("Channels are back in Voicemeeter's order"); }
    if (a === "unsolo") chans.forEach((ch) => { if (ch.kind === "strip" && ch.data && ch.data.solo) sendFloat(`${ch.prefix}.Solo`, 0); });
  });

  /* ---------- settings dialog ---------- */
  const streamBtn = $("#streamBtn"), streamMenu = $("#streamMenu"), streamWrap = $("#streamWrap");
  let obsRecording = false;
  const mixerRecording = () => $("#recBtn").dataset.state === "recording" && !$("#recBtn").hidden;
  const streamTools = [
    ["goLiveBtn", "Go-live check"], ["brbBtn", "Be right back"], ["recBtn", "Recorder"], ["soundsBtn", "Soundboard"],
    ["musicBtn", "Music off stream"], ["replayBtn", "Save a replay"],
  ].map(([id, title]) => {
    const original = $(`#${id}`);
    const row = Object.assign(document.createElement("div"), { className: "stream-item" });
    const action = Object.assign(document.createElement("button"), { type: "button", textContent: title });
    const label = document.createElement("label"), pin = Object.assign(document.createElement("input"), { type: "checkbox" });
    pin.setAttribute("aria-label", `Pin ${title} to the toolbar`);
    label.append(pin, "Pin");
    row.append(action, label);
    streamMenu.append(row);
    action.addEventListener("click", () => { setStreamMenu(false, true); original.click(); });
    pin.addEventListener("change", () => {
      const pins = new Set(Array.isArray(settings.streamPins) ? settings.streamPins : []);
      if (pin.checked) pins.add(id); else pins.delete(id);
      settings.streamPins = [...pins];
      saveSettings();
      paintStreamToolbar();
    });
    return { id, title, original, row, action, pin };
  });
  function paintStreamToolbar() {
    const pins = Array.isArray(settings.streamPins) ? settings.streamPins : [];
    const recording = mixerRecording();
    const away = $("#brbBtn").getAttribute("aria-pressed") === "true";
    for (const { id, title, original, row, action, pin } of streamTools) {
      const pinned = pins.includes(id);
      original.toggleAttribute("data-unpinned", !pinned);
      row.hidden = original.hidden;
      action.disabled = original.disabled;
      pin.checked = pinned;
      const text = id === "brbBtn" && away ? "Back live" : id === "recBtn" && recording ? "Recorder · recording" : title;
      if (action.textContent !== text) action.textContent = text;
    }
    const badge = $("#recordingBadge");
    badge.hidden = !obsRecording && (!recording || (pins.includes("recBtn") && settings.streamerMode !== false));
    badge.textContent = obsRecording ? "OBS Rec" : "Recording";
    badge.title = recording ? "Open Recorder" : "Open OBS Studio settings";
    $("#awayBadge").hidden = !away || (pins.includes("brbBtn") && settings.streamerMode !== false);
  }
  function setStreamMenu(open, focus = false) {
    if (open) paintStreamToolbar();
    streamMenu.hidden = !open;
    streamBtn.setAttribute("aria-expanded", String(open));
    if (focus) (open ? streamMenu.querySelector(".stream-item:not([hidden]) > button:not(:disabled)") || streamBtn : streamBtn).focus();
  }
  streamBtn.addEventListener("click", () => setStreamMenu(streamMenu.hidden, streamMenu.hidden));
  streamWrap.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || streamMenu.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    setStreamMenu(false, true);
  });
  streamWrap.addEventListener("focusout", (e) => {
    if (e.relatedTarget && !streamWrap.contains(e.relatedTarget)) setStreamMenu(false);
  });
  document.addEventListener("click", (e) => { if (!streamWrap.contains(e.target)) setStreamMenu(false); });
  $("#liveTag").addEventListener("click", () => $("#goLiveBtn").click());
  $("#recordingBadge").addEventListener("click", () => {
    if (mixerRecording()) $("#recBtn").click();
    else {
      openSettings("streaming");
      const fold = $("#obsFold");
      fold.open = true;
      $("summary", fold).focus();
      fold.scrollIntoView({ block: "nearest" });
    }
  });
  $("#awayBadge").addEventListener("click", () => $("#brbBtn").click());
  paintStreamToolbar();

  const settingsDlg = $("#settingsDlg");
  function faderGroups() {
    return Array.isArray(settings.faderGroups) ? settings.faderGroups : (settings.faderGroups = []);
  }
  function renderFaderGroups() {
    const root = $("#faderGroupList");
    root.replaceChildren();
    for (const group of faderGroups()) {
      const field = document.createElement("fieldset");
      field.className = "inspect-panel";
      field.append(Object.assign(document.createElement("legend"), { textContent: group.name }));
      const members = Array.isArray(group.members) ? group.members : (group.members = []);
      for (const ch of chans) {
        const label = document.createElement("label");
        label.className = "check";
        const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: members.includes(ch.prefix) });
        box.disabled = faderGroups().some((g) => g !== group && g.members?.includes(ch.prefix));
        box.addEventListener("change", () => {
          group.members = box.checked ? [...members, ch.prefix] : members.filter((p) => p !== ch.prefix);
          saveSettings();
          renderFaderGroups();
          [...root.querySelectorAll("fieldset")][faderGroups().indexOf(group)]?.querySelectorAll("input")[chans.indexOf(ch)]?.focus();
        });
        label.append(box, document.createTextNode(displayName(ch)));
        field.append(label);
      }
      const remove = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: "Remove group" });
      remove.addEventListener("click", () => {
        settings.faderGroups = faderGroups().filter((g) => g !== group);
        saveSettings();
        renderFaderGroups();
        $("#faderGroupName").focus();
      });
      field.append(remove);
      root.append(field);
    }
  }
  $("#faderGroupAdd").addEventListener("click", () => {
    const input = $("#faderGroupName");
    const name = input.value.trim();
    if (!name || faderGroups().some((g) => g.name.toLowerCase() === name.toLowerCase())) return;
    faderGroups().push({ name, members: [] });
    input.value = "";
    saveSettings();
    renderFaderGroups();
  });
  // Overlay screen and tray panel choices (selects, not checkboxes).
  async function syncDisplayOptions() {
    const screen = $("#setOverlayScreen");
    const list = await engine.screens().catch(() => []);
    screen.innerHTML = "";
    const add = (value, label) => screen.appendChild(Object.assign(document.createElement("option"), { value, textContent: label }));
    add("", "The screen the mixer is on");
    add("primary", "The main screen");
    for (const m of list) add(m.name, m.label);
    if (settings.overlayScreen && ![...screen.options].some((o) => o.value === settings.overlayScreen)) add(settings.overlayScreen, "A screen that isn't connected");
    screen.value = settings.overlayScreen || "";
    $("#setPanelLayout").value = settings.panelLayout === "columns" ? "columns" : "rows";
    $("#setPanelScale").value = String(settings.panelScale || 100);
    $("#setPanelOpacity").value = String(settings.panelOpacity || 100);
  }
  $("#setOverlayScreen").addEventListener("change", (e) => { settings.overlayScreen = e.target.value; saveSettings(); });
  $("#setPanelLayout").addEventListener("change", (e) => { settings.panelLayout = e.target.value; saveSettings(); });
  $("#setPanelScale").addEventListener("change", (e) => { settings.panelScale = +e.target.value; saveSettings(); });
  $("#setPanelOpacity").addEventListener("change", (e) => { settings.panelOpacity = +e.target.value; saveSettings(); });
  const CHECKS = {
    setStartWithWindows: "startWithWindows", setStartInTray: "startInTray",
    setLaunchVoicemeeter: "launchVoicemeeter", setHideVoicemeeter: "hideVoicemeeter", setOverlay: "overlay",
    setCheckUpdates: "checkUpdates", setBetaUpdates: "betaUpdates", setAutoRestart: "autoRestart", setKeepWindowsOutput: "keepWindowsOutput", setUsagePing: "usagePing", setPanelDocked: "panelDocked", setPanelIcons: "panelIcons", setPanelMeters: "panelMeters", setPanelMute: "panelMute", setExtraBuses: "showExtraBuses",
    setHideSoloMono: "hideSoloMono", setStreamerMode: "streamerMode", setLockArrangement: "lockArrangement",
  };
  for (const [id, key] of Object.entries(CHECKS)) {
    $("#" + id).addEventListener("change", (e) => {
      settings[key] = e.target.checked;
      syncChecks();
      saveSettings();
      if (key === "showExtraBuses") applyExtraBuses();
      if (key === "hideSoloMono") applySoloMono();
      if (key === "streamerMode") applyStreamer();
      if (key === "lockArrangement") applyArrangementLock();
      if (key === "checkUpdates") { if (e.target.checked) checkForUpdate(); else $("#updateWrap").hidden = true; }
      if (key === "betaUpdates") { $("#updateWrap").hidden = true; checkForUpdate(); }
    });
  }
  function syncChecks() {
    for (const [id, key] of Object.entries(CHECKS)) $("#" + id).checked = !!settings[key];
    const tray = $("#setStartInTray");
    tray.disabled = !settings.startWithWindows;
    tray.closest(".check").classList.toggle("disabled", tray.disabled);
    // Only Potato has the extra hardware buses (A4, A5) to show.
    $("#extraBusesRow").hidden = !hasExtraBuses();
  }
  const hasExtraBuses = () => !!layout && layout.buses.some((b) => b.extra);
  // A4 and A5 stay out of the way unless you turn them on (or a strip already sends there).
  function applyExtraBuses() {
    document.body.classList.toggle("show-extra-buses", !!settings.showExtraBuses);
  }
  // Streamer mode off hides Be right back, Rec and Sounds from the header.
  function applyStreamer() {
    document.body.classList.toggle("no-streamer", settings.streamerMode === false);
    if (settings.streamerMode === false) setStreamMenu(false);
    paintStreamToolbar();
  }
  function applyArrangementLock() {
    document.body.classList.toggle("arrangement-locked", !!settings.lockArrangement);
    for (const ch of chans) for (const n of ch.names) n.title = channelNameHint(displayName(ch));
  }
  function channelNameHint(name) {
    return `${name}\nClick: show or hide the device name. Double-click: rename. ${settings.lockArrangement ? "Channel arrangement is locked" : "Drag the top of the channel to move it"}`;
  }
  function applySoloMono() {
    document.body.classList.toggle("hide-solo-mono", !!settings.hideSoloMono);
    document.body.classList.toggle("focused-mixer", !!settings.simpleMode);
    $('#moreMenu [data-action="simple"]').setAttribute("aria-checked", String(!!settings.simpleMode));
    if (drawerCh) buildDrawerBody();
  }
  // Simple mode hides Solo, Mono and EQ, every device line and the A4/A5 buttons in one go;
  // turning it off puts back what you had before.
  function setSimple(on) {
    settings.appearance = settings.appearance || {};
    const setSubs = (hidden) => {
      for (const c of chans) settings.appearance[c.key] = Object.assign({}, settings.appearance[c.key], { hideSub: hidden(c) });
    };
    if (on) {
      settings.simplePrev = {
        hideSoloMono: !!settings.hideSoloMono, showExtraBuses: !!settings.showExtraBuses,
        hideSub: chans.filter((c) => look(c).hideSub).map((c) => c.key),
      };
      settings.hideSoloMono = true; settings.showExtraBuses = false;
      setSubs(() => true);
    } else {
      const p = Object.assign({ hideSoloMono: false, showExtraBuses: false, hideSub: [] }, settings.simplePrev);
      settings.hideSoloMono = p.hideSoloMono; settings.showExtraBuses = p.showExtraBuses;
      setSubs((c) => p.hideSub.includes(c.key));
      delete settings.simplePrev;
    }
    settings.simpleMode = on;
    saveSettings(); chans.forEach(paintLook); applyExtraBuses(); applySoloMono();
    toast(on ? "Focused mixer on" : "Full mixer restored");
  }
  const settingsCategories = [
    ["appearance", "Appearance & layout", "Themes, animation, channel visibility and the volume overlay."],
    ["mixer", "Mixer & devices", "Mixing tools, fader behaviour, audio devices and output recovery."],
    ["microphone", "Microphone", "Mic levels, noise clean-up and VST3 processing."],
    ["streaming", "Streaming", "Go-live checks, replay, OBS and Twitch."],
    ["controls", "Controls & remote", "Shortcuts, Stream Deck and phone control."],
    ["system", "System & backup", "Startup, privacy, updates, backups and diagnostics."],
  ];
  const settingsSearch = $("#settingsSearch"), settingsContent = $("#settingsContent");
  const settingsCards = [...settingsContent.querySelectorAll("[data-settings-category]")].map((el) => ({
    el, detail: el.querySelector(":scope > details"),
    text: `${el.dataset.settingsKeywords || ""} ${el.textContent}`.toLowerCase().replace(/\s+/g, " "),
  }));
  const settingsOpenFolds = new Map();
  let settingsCategory = "appearance";
  function renderSettingsCategory() {
    const query = settingsSearch.value.trim().toLowerCase();
    const words = query.split(/\s+/);
    const [, label, description] = settingsCategories.find(([id]) => id === settingsCategory);
    let matches = 0;
    for (const { el, text, detail } of settingsCards) {
      const category = settingsCategories.find(([id]) => id === el.dataset.settingsCategory);
      const show = query ? words.every((word) => (text + " " + category[1].toLowerCase()).includes(word)) : category[0] === settingsCategory;
      el.classList.toggle("settings-filtered", !show);
      if (show && !el.hidden) matches++;
      if (detail && query && show && !settingsOpenFolds.has(detail)) {
        settingsOpenFolds.set(detail, detail.open);
        detail.open = true;
      } else if (detail && (!query || !show) && settingsOpenFolds.has(detail)) {
        detail.open = settingsOpenFolds.get(detail);
        settingsOpenFolds.delete(detail);
      }
    }
    $("#settingsCategory").textContent = query ? "Search results" : label;
    $("#settingsDescription").textContent = query ? (matches ? `${matches} matching ${matches === 1 ? "section" : "sections"}` : "No matching settings. Try a shorter search.") : description;
    $("#settingsClear").hidden = !settingsSearch.value;
    $("#settingsNav").querySelectorAll("button").forEach((b) => {
      if (!query && b.dataset.category === settingsCategory) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    });
    settingsContent.scrollTop = 0;
    if (!settingsShowing("micFxFold")) stopListening();
  }
  function settingsShowing(id) { return settingsDlg.open && !$(`#${id}`).closest("section")?.classList.contains("settings-filtered"); }
  function selectSettingsCategory(id) {
    settingsCategory = id;
    settingsSearch.value = "";
    renderSettingsCategory();
  }
  for (const [id, name] of settingsCategories) {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: name });
    b.dataset.category = id;
    b.addEventListener("click", () => selectSettingsCategory(id));
    $("#settingsNav").append(b);
  }
  settingsSearch.addEventListener("input", renderSettingsCategory);
  $("#settingsClear").addEventListener("click", () => { settingsSearch.value = ""; renderSettingsCategory(); settingsSearch.focus(); });
  function openSettings(category = settingsCategory) {
    renderFaderGroups();
    syncChecks();
    renderThemes();
    renderAbout();
    syncFadeDuck();
    syncBrb();
    syncObs();
    syncClip();
    syncMicFx();
    syncTwitch();
    syncLive();
    syncReplay();
    syncRemote();
    $("#historyOn").checked = HI().on !== false;
    renderHotkeys();
    refreshStreamDeck();
    syncDisplayOptions();
    renderBackups();
    selectSettingsCategory(category);
    if (!settingsDlg.open) settingsDlg.showModal();
  }
  $("#settingsBtn").addEventListener("click", () => openSettings());
  settingsDlg.addEventListener("click", (e) => { if (e.target === settingsDlg) settingsDlg.close(); });
  $("#settingsBalance").addEventListener("click", () => { settingsDlg.close(); openBalance(); });
  $("#settingsMix").addEventListener("click", async () => {
    if (!connected || layout.edition !== 3) { toast("Personal / Stream mix requires Voicemeeter Potato"); return; }
    if (!await setMixPreference("mixViewMode", "pair")) return;
    settingsDlg.close();
    mixViewBtn.click();
  });

  const H = () => (settings.hold = Object.assign({}, DEFAULT_SETTINGS.hold, settings.hold));
  const ACTIONS = [["mute", "Mute or unmute"], ["ptt", "Push to talk (hold)"], ["ptm", "Push to mute (hold)"],
    ["volup", "Turn up 2 dB"], ["voldown", "Turn down 2 dB"],
    ["output", "Switch to an output profile"], ["outputnext", "Next output profile"],
    ["window", "Show or hide Sleekmeeter"], ["duck", "Talk-over ducking on or off"], ["record", "Start or stop recording"],
    ["brb", "Be right back on or off"], ["scene", "Load a scene"], ["sound", "Play a sound"], ["soundstop", "Stop all sounds"],
    ["replay", "Save an instant replay"], ["musicguard", "Music off stream on or off"],
    ["micfx", "Mic clean-up on or off"], ["chatgame", "Game / Chat toward game"],
    ["chatchat", "Game / Chat toward chat"], ["chatcentre", "Game / Chat restore centre"]];
  // Mic clean-up targets: every mic, or one hardware input. [label, target] pairs.
  const micTargets = () => {
    const hw = layout.strips.filter((s) => s.kind === "hw").length;
    return [["Every mic", ""], ...chans.filter((ch) => { const m = /^Strip\[(\d+)\]$/.exec(ch.prefix); return m && +m[1] < hw; }).map((ch) => [displayName(ch), ch.prefix])];
  };
  // Actions that aren't about one channel.
  const NO_TARGET = new Set(["window", "duck", "record", "outputnext", "brb", "soundstop", "replay", "musicguard", "chatgame", "chatchat", "chatcentre"]);
  // Actions whose second box is a list of names, not channels.
  const NAMED = { output: "Output profile", scene: "Scene", sound: "Sound" };
  let knownScenes = [];
  const namesFor = (action) => action === "output" ? (settings.outputProfiles || []).map((p) => p.name)
    : action === "scene" ? knownScenes : action === "sound" ? ((settings.soundboard || {}).sounds || []).map((s) => s.name) : [];
  // Fill the second box of a shortcut row: channels for most actions, profile names for "output".
  function fillTarget(tgt, h) {
    tgt.textContent = "";
    if (NAMED[h.action]) {
      tgt.setAttribute("aria-label", NAMED[h.action]);
      const names = namesFor(h.action);
      if (!names.length) { tgt.appendChild(new Option(h.action === "output" ? "Save a profile first" : h.action === "scene" ? "Save a scene first" : "Add a sound first", "")); tgt.value = ""; return; }
      for (const n of names) tgt.appendChild(new Option(n, n));
      if (!names.includes(h.target)) h.target = names[0];
      tgt.value = h.target;
      return;
    }
    if (h.action === "micfx") {
      tgt.setAttribute("aria-label", "Mic");
      for (const [l, v] of micTargets()) tgt.appendChild(new Option(l, v));
      if (![...tgt.options].some((o) => o.value === (h.target || ""))) h.target = "";
      tgt.value = h.target || "";
      return;
    }
    tgt.setAttribute("aria-label", "Channel");
    for (const ch of chans) tgt.appendChild(new Option(displayName(ch), ch.prefix));
    if (!/^(Strip|Bus)\[/.test(h.target || "")) h.target = "Strip[0]";
    tgt.value = h.target;
  }
  function renderHotkeys() {
    engine.listScenes().then((n) => { if (n.join("|") !== knownScenes.join("|")) { knownScenes = n; if ((settings.hotkeys || []).some((h) => h.action === "scene")) renderHotkeys(); } }).catch(() => {});
    const list = $("#hotkeyList");
    list.textContent = "";
    (settings.hotkeys || []).forEach((h, idx) => {
      const row = document.createElement("div");
      row.className = "hotkey";
      const act = document.createElement("select");
      act.setAttribute("aria-label", "Action");
      for (const [v, l] of ACTIONS) act.appendChild(new Option(l, v));
      act.value = h.action;
      const tgt = document.createElement("select");
      fillTarget(tgt, h);
      tgt.disabled = NO_TARGET.has(h.action);
      act.addEventListener("change", () => {
        h.action = act.value;
        tgt.disabled = NO_TARGET.has(h.action);
        if (tgt.disabled) h.target = "";
        else { if (!NAMED[h.action] && !/^(Strip|Bus)\[/.test(h.target || "")) h.target = ""; else if (NAMED[h.action]) h.target = ""; fillTarget(tgt, h); }
        syncHold();
        saveSettings();
      });
      tgt.addEventListener("change", () => { h.target = tgt.value; saveSettings(); });
      const keys = document.createElement("button");
      keys.type = "button";
      keys.className = "keys" + (h.keys ? "" : " empty");
      keys.textContent = h.keys || "Set shortcut";
      keys.setAttribute("aria-label", h.keys ? `Shortcut ${h.keys}, click to change` : "Set shortcut");
      keys.addEventListener("click", () => recordKeys(keys, h));
      const del = document.createElement("button");
      del.type = "button"; del.className = "btn icon"; del.setAttribute("aria-label", "Remove shortcut");
      del.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
      del.addEventListener("click", () => { settings.hotkeys.splice(idx, 1); renderHotkeys(); saveSettings(); });
      row.append(act, tgt, keys, del);
      list.appendChild(row);
    });
    syncHold();
  }
  // "Mic stays open" only matters once there's a push-to-talk shortcut.
  const holdRange = bindRange("holdTail", () => H().releaseMs, (v) => { H().releaseMs = v; }, (v) => fmtMs(v));
  function syncHold() {
    const any = (settings.hotkeys || []).some((h) => h.action === "ptt");
    $("#holdRow").hidden = !any;
    $("#holdHint").hidden = !any;
    if (any) holdRange._sync();
  }
  $("#addHotkey").addEventListener("click", () => {
    settings.hotkeys = settings.hotkeys || [];
    settings.hotkeys.push({ keys: "", action: "mute", target: "Strip[0]" });
    renderHotkeys();
    const all = document.querySelectorAll("#hotkeyList .keys");
    all[all.length - 1].click();
  });

  // Turn a key press into a shortcut string Windows understands, e.g. "Ctrl+Alt+M".
  function keyName(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F\d{1,2}$/.test(code)) return code;
    if (/^Numpad\d$/.test(code)) return code;
    const map = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Space: "Space",
      PageUp: "PageUp", PageDown: "PageDown", Home: "Home", End: "End", Insert: "Insert",
      Minus: "Minus", Equal: "Equal", Comma: "Comma", Period: "Period", Slash: "Slash", Backquote: "Backquote",
      BracketLeft: "BracketLeft", BracketRight: "BracketRight", Semicolon: "Semicolon", Quote: "Quote",
      MediaPlayPause: "MediaPlayPause", AudioVolumeMute: "AudioVolumeMute", AudioVolumeUp: "AudioVolumeUp", AudioVolumeDown: "AudioVolumeDown" };
    return map[code] || null;
  }
  function recordKeys(btn, h) {
    btn.classList.add("recording");
    btn.classList.remove("empty");
    btn.textContent = "Press keys… (Esc to cancel)";
    btn.focus();
    const onKey = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") return done();
      if (e.key === "Backspace" || e.key === "Delete") { h.keys = ""; return done(true); }
      const key = keyName(e.code);
      if (!key) return; // a modifier on its own, keep listening
      const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
      if (!mods.length && !/^F\d/.test(key) && !/^Media|^Audio/.test(key)) {
        btn.textContent = "Add Ctrl, Alt or Shift";
        return;
      }
      h.keys = [...mods, key].join("+");
      done(true);
    };
    const done = (changed) => {
      btn.removeEventListener("keydown", onKey, true);
      btn.removeEventListener("blur", cancel);
      btn.classList.remove("recording");
      renderHotkeys();
      if (changed) saveSettings();
    };
    const cancel = () => done();
    btn.addEventListener("keydown", onKey, true);
    btn.addEventListener("blur", cancel);
  }

  /* ---------- scenes ---------- */
  const dlg = $("#scenesDlg"), list = $("#sceneList");
  let previewScene = "";
  let previewGeneration = 0;
  function closeScenePreview() {
    previewGeneration++;
    previewScene = "";
    $("#scenePreview").hidden = true;
  }
  dlg.addEventListener("close", closeScenePreview);
  $("#scenePreviewCancel").addEventListener("click", closeScenePreview);
  $("#sceneApply").addEventListener("click", async () => {
    const name = previewScene;
    if (!name) return;
    $("#sceneApply").disabled = true;
    try { await engine.loadScene(name); setScene(name); toast(`Loaded “${name}”`); dlg.close(); }
    catch (e) { fail(e); if (previewScene === name) $("#sceneApply").disabled = false; }
  });
  async function openScenePreview(name) {
    const generation = ++previewGeneration;
    const result = $("#sceneChanges");
    const add = (text) => result.append(Object.assign(document.createElement("li"), { textContent: text }));
    previewScene = "";
    $("#scenePreviewTitle").textContent = `Preview “${name}”`;
    $("#scenePreview").hidden = false;
    $("#sceneApply").disabled = true;
    result.textContent = "";
    add("Reading saved mix…");
    try {
      const saved = await engine.scenePreview(name);
      if (generation !== previewGeneration) return;
      result.textContent = "";
      let hasRoutes = false;
      const differs = (a, b) => typeof a === "number" && typeof b === "number" ? Math.abs(a - b) >= 0.05 : a !== b;
      const compare = (label, a, b, format) => {
        if (a != null && b != null && differs(a, b)) add(`${label} · ${format(a)} → ${format(b)}`);
      };
      const db = (x) => `${Number(x).toFixed(1)} dB`;
      const on = (x) => x ? "on" : "off";
      for (const ch of chans) {
        const target = saved.channels?.[ch.prefix], live = ch.data;
        if (!target || !live) continue;
        const label = displayName(ch);
        compare(`${label} level`, live.gain, target.gain, db);
        compare(`${label} mute`, live.mute, target.mute, on);
        for (const bus of chans.filter((c) => c.kind === "bus")) {
          const id = bus.info.id, kind = id[0].toLowerCase(), index = Number(id.slice(1) || "1") - 1;
          hasRoutes ||= Array.isArray(target[kind]);
          compare(`${label} → ${displayName(bus)} route`, live[kind]?.[index], target[kind]?.[index], on);
          compare(`${label} → ${displayName(bus)} level`, live.layers?.[bus.i], target.layers?.[bus.i], db);
        }
      }
      for (const [key, target] of Object.entries(saved.mics || {})) {
        const live = saved.currentMics?.[key];
        if (!live) continue;
        const ch = chans.find((c) => c.prefix === key);
        const label = ch ? displayName(ch) : key;
        compare(`${label} mic chain bypass`, live.off, target.off, on);
        compare(`${label} mic strength`, live.strength, target.strength, (x) => `${x}%`);
      }
      if (!result.childElementCount) add(saved.channels ? "No differences found in the available preview data." : "This scene has no saved preview data.");
      if (!hasRoutes) add("Routing preview is unavailable for this scene. Save it again to capture routes.");
      add("Applying also restores the Voicemeeter settings stored in the scene file.");
      previewScene = name;
      $("#sceneApply").disabled = false;
      $("#sceneApply").focus();
    } catch (e) {
      if (generation !== previewGeneration) return;
      result.textContent = "";
      add(String(e));
    }
  }
  async function renderScenes() {
    const names = await engine.listScenes().catch((e) => { fail(e); return []; });
    list.textContent = "";
    if (!names.length) {
      list.appendChild(Object.assign(document.createElement("li"), { className: "empty", textContent: "No scenes yet. Set up your mix, name it below and save it." }));
      return;
    }
    for (const n of names) {
      const li = document.createElement("li");
      const load = Object.assign(document.createElement("button"), { type: "button", className: "load", textContent: n });
      load.addEventListener("click", () => openScenePreview(n));
      const del = Object.assign(document.createElement("button"), { type: "button", className: "btn del", textContent: "Delete" });
      del.setAttribute("aria-label", `Delete ${n}`);
      let armed = false;
      del.addEventListener("click", async () => {
        if (!armed) { armed = true; del.textContent = "Confirm"; setTimeout(() => { armed = false; del.textContent = "Delete"; }, 3000); return; }
        try { await engine.deleteScene(n); toast(`Deleted “${n}”`); renderScenes(); } catch (e) { fail(e); }
      });
      li.append(load, del);
      list.appendChild(li);
    }
  }
  function setScene(n) {
    const el = $("#sceneNow");
    el.hidden = false; el.textContent = "";
    el.append("Scene: ", Object.assign(document.createElement("b"), { textContent: n }));
  }
  $("#scenesBtn").addEventListener("click", () => {
    renderScenes();
    renderRules();
    engine.runningApps().then((apps) => {
      const dl = $("#appList");
      dl.textContent = "";
      for (const a of apps) dl.appendChild(new Option(a));
    }).catch(() => {});
    dlg.showModal();
  });

  /* ---------- automatic scene switching ---------- */
  let sceneNames = [];
  async function renderRules() {
    sceneNames = await engine.listScenes().catch(() => []);
    const listEl = $("#ruleList");
    listEl.textContent = "";
    const rules = settings.sceneRules || (settings.sceneRules = []);
    const profiles = (settings.outputProfiles || []).map((p) => p.name);
    $("#rulesEmpty").hidden = sceneNames.length > 0 || profiles.length > 0 || rules.length > 0;
    $("#ruleHead").hidden = rules.length === 0;
    rules.forEach((r, idx) => {
      const wrap = document.createElement("div");
      wrap.className = "rule-wrap";
      const row = document.createElement("div");
      row.className = "rule";
      const app = document.createElement("input");
      app.type = "text"; app.value = r.app || ""; app.placeholder = "e.g. valorant.exe";
      app.setAttribute("list", "appList"); app.setAttribute("aria-label", "App");
      app.spellcheck = false; app.autocomplete = "off";
      app.addEventListener("change", () => { r.app = app.value.trim().toLowerCase(); app.value = r.app; saveSettings(); });
      const scene = document.createElement("select");
      scene.setAttribute("aria-label", "Scene to load");
      scene.appendChild(new Option("Keep the mix", ""));
      for (const n of sceneNames) scene.appendChild(new Option(n, n));
      if (r.scene && !sceneNames.includes(r.scene)) scene.appendChild(new Option(`${r.scene} (deleted)`, r.scene));
      scene.value = r.scene || "";
      scene.addEventListener("change", () => { r.scene = scene.value; saveSettings(); });
      const restore = document.createElement("select");
      restore.setAttribute("aria-label", "When the app closes");
      restore.appendChild(new Option("Keep the scene", ""));
      for (const n of sceneNames) restore.appendChild(new Option(`Load ${n}`, n));
      restore.value = r.restore || "";
      restore.addEventListener("change", () => { r.restore = restore.value; saveSettings(); });
      const del = document.createElement("button");
      del.type = "button"; del.className = "btn icon"; del.setAttribute("aria-label", "Remove rule");
      del.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
      del.addEventListener("click", () => { rules.splice(idx, 1); saveSettings(); renderRules(); });
      row.append(app, scene, restore, del);
      // Per-game extras: switch the outputs and the look while the app runs.
      const extra = document.createElement("div");
      extra.className = "rule-extra";
      const outs = document.createElement("select");
      outs.setAttribute("aria-label", "Output profile while it runs");
      outs.appendChild(new Option("Keep my outputs", ""));
      for (const n of profiles) outs.appendChild(new Option(`Outputs: ${n}`, n));
      if (r.outputs && !profiles.includes(r.outputs)) outs.appendChild(new Option(`Outputs: ${r.outputs} (deleted)`, r.outputs));
      outs.value = r.outputs || "";
      outs.addEventListener("change", () => { r.outputs = outs.value; saveSettings(); });
      const theme = document.createElement("select");
      theme.setAttribute("aria-label", "Theme while it runs");
      theme.appendChild(new Option("Keep my theme", ""));
      for (const [id, name] of THEMES) theme.appendChild(new Option(`Theme: ${name}`, id));
      theme.value = RETIRED[r.theme] || r.theme || "";
      theme.addEventListener("change", () => { r.theme = theme.value; saveSettings(); });
      extra.append(Object.assign(document.createElement("span"), { textContent: "And while it runs" }), outs, theme, document.createElement("span"));
      wrap.append(row, extra);
      listEl.appendChild(wrap);
    });
  }
  $("#addRule").addEventListener("click", async () => {
    settings.sceneRules = settings.sceneRules || [];
    settings.sceneRules.push({ app: "", scene: sceneNames[0] || "", restore: "", outputs: "", theme: "" });
    await renderRules();
    const inputs = document.querySelectorAll("#ruleList input");
    inputs[inputs.length - 1].focus();
  });

  /* ---------- update notifications ---------- */
  let update = null;
  const updateBtn = $("#updateBtn"), updateMenu = $("#updateMenu");
  // `asked`: from the Check for updates button. Then it runs even with automatic checks off,
  // offers a version that was skipped, and returns what it found.
  async function checkForUpdate(asked = false) {
    if (SIDE || (!asked && !settings.checkUpdates)) return null;
    try {
      const u = await engine.checkUpdate();
      if (!u || !u.newer || (!asked && u.latest === settings.skippedVersion)) return u;
      update = u;
      updateBtn.textContent = `Update to ${u.latest}`;
      $("#updateText").textContent = `Sleekmeeter ${u.latest} is out. You have ${u.current}.`;
      updateNow.hidden = u.canInstall === false;
      $("#updateWrap").hidden = false;
      return u;
    } catch (e) {
      // Offline or GitHub unreachable: the next check tries again.
      if (asked) throw e;
      return null;
    }
  }
  // Sleekmeeter often runs for days, so look again every 6 hours, not only at start.
  if (!SIDE) setInterval(() => checkForUpdate(), 6 * 60 * 60 * 1000);
  $("#checkUpdateNow").addEventListener("click", async (e) => {
    const btn = e.currentTarget, status = $("#updateStatus");
    btn.disabled = true;
    status.textContent = "Checking…";
    try {
      const u = await checkForUpdate(true);
      status.textContent = u && u.newer
        ? `Sleekmeeter ${u.latest} is out. Use the Update button at the top of the window.`
        : `You have the newest version${u && u.current ? ` (${u.current})` : ""}.`;
    } catch (err) {
      // Rust explains what went wrong (offline, GitHub's hourly limit, ...).
      const msg = typeof err === "string" ? err : err && err.message;
      status.textContent = msg || "Couldn't reach GitHub. Check your internet connection and try again.";
    }
    btn.disabled = false;
  });
  const setUpdateMenu = (open) => { updateMenu.hidden = !open; updateBtn.setAttribute("aria-expanded", String(open)); };
  updateBtn.addEventListener("click", () => setUpdateMenu(updateMenu.hidden));
  document.addEventListener("click", (e) => { if (!e.target.closest("#updateWrap")) setUpdateMenu(false); });
  let updating = false;
  const updateNow = $("#updateNow");
  engine.onUpdateProgress((p) => {
    if (updating) updateBtn.textContent = p.percent >= 100 ? "Restarting…" : `Downloading ${p.percent}%`;
  });
  updateNow.addEventListener("click", async () => {
    setUpdateMenu(false);
    if (!update || updating) return;
    updating = true;
    updateBtn.disabled = true;
    updateBtn.textContent = "Downloading 0%";
    try {
      await engine.updateInstall();
      toast("Restarting to finish the update");
    } catch (err) {
      updating = false;
      updateBtn.disabled = false;
      updateBtn.textContent = `Update to ${update.latest}`;
      fail(err);
    }
  });
  $("#updateGet").addEventListener("click", () => {
    setUpdateMenu(false);
    if (update) engine.openRelease(update.url).then(() => toast("Opening the download page")).catch(fail);
  });
  $("#updateSkip").addEventListener("click", () => {
    setUpdateMenu(false);
    if (!update) return;
    settings.skippedVersion = update.latest;
    saveSettings();
    $("#updateWrap").hidden = true;
    toast(`You won't be reminded about ${update.latest}`);
  });
  /* ---------- Stream Deck plugin offer ---------- */
  const streamDeckDlg = $("#streamDeckDlg");
  let streamDeck = null;
  const streamDeckCopy = {
    install: { go: "Install plugin", title: "Add Sleekmeeter to your Stream Deck",
      text: () => "The Stream Deck app is on this PC. The Sleekmeeter plugin controls your mixer from its keys and dials. The Stream Deck app will open to finish installing." },
    update: { go: "Update plugin", title: "Update the Stream Deck plugin",
      text: (s) => `This Sleekmeeter includes plugin ${s.bundledVersion}. You have ${s.installedVersion}. The Stream Deck app will open to finish updating, and your keys and dials stay as they are.` },
    getApp: { go: "Open Elgato's download page", title: "Your Stream Deck needs its app",
      text: () => "A Stream Deck has been connected to this PC, but Elgato's Stream Deck app isn't installed. Install the app first, then Sleekmeeter can add its plugin." },
  };
  async function runStreamDeckOffer() {
    if (!streamDeck || !streamDeck.offer) return;
    try {
      if (streamDeck.offer === "getApp") {
        await engine.streamDeckGetApp();
        toast("Opening Elgato's download page");
      } else {
        await engine.streamDeckInstall();
        toast("Finish in the Stream Deck app, then turn on Settings → Phone remote");
      }
    } catch (err) { fail(err); }
  }
  function paintStreamDeck() {
    const s = streamDeck, action = $("#streamDeckAction");
    const copy = streamDeckCopy[s?.offer];
    $("#streamDeckNote").textContent = copy ? copy.text(s) : s?.installedVersion
      ? `Plugin ${s.installedVersion} is installed. Connect it with the address from Phone remote.`
      : "Use Sleekmeeter actions on a Stream Deck with the Studio plugin.";
    action.hidden = !copy;
    if (copy) action.textContent = copy.go;
  }
  async function refreshStreamDeck() {
    try { streamDeck = await engine.streamDeckStatus(); } catch { streamDeck = null; }
    paintStreamDeck();
  }
  // Asks once per plugin version. Settings keeps the same action for anyone who said not now.
  async function offerStreamDeck() {
    if (SIDE) return;
    await refreshStreamDeck();
    const copy = streamDeck && streamDeckCopy[streamDeck.offer];
    if (!copy || document.querySelector("dialog[open]")) return;
    const key = `${streamDeck.offer}:${streamDeck.bundledVersion}`;
    if (settings.streamDeckOffered === key) return;
    settings.streamDeckOffered = key;
    saveSettings();
    $("#streamDeckTitle").textContent = copy.title;
    $("#streamDeckText").textContent = copy.text(streamDeck);
    $("#streamDeckGo").textContent = copy.go;
    streamDeckDlg.showModal();
  }
  /* ---------- What's new: the release notes, once after an update ---------- */
  const whatsNewDlg = $("#whatsNewDlg");
  // The changelog's own markup, kept to what it uses: **bold** and `code`. Escaped first.
  function noteHtml(text) {
    return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>");
  }
  function fillWhatsNew(info) {
    const body = $("#whatsNewBody");
    body.textContent = "";
    for (const sec of info.sections) {
      const h = document.createElement("h3");
      h.textContent = sec.title;
      body.appendChild(h);
      let ul = null;
      for (const b of sec.blocks || []) {
        if (b.kind === "li") {
          if (!ul) { ul = document.createElement("ul"); body.appendChild(ul); }
          const li = document.createElement("li"); li.innerHTML = noteHtml(b.text); ul.appendChild(li);
        } else {
          ul = null;
          const el = document.createElement(b.kind === "h" ? "h4" : "p");
          el.innerHTML = noteHtml(b.text);
          body.appendChild(el);
        }
      }
    }
    $("#whatsNewTitle").textContent = `What's new in Sleekmeeter ${info.version}`;
  }
  // Resolves once it's been read (or straight away when there's nothing new), so the other
  // first-start questions, such as updating the Stream Deck plugin, still get their turn.
  async function offerWhatsNew() {
    if (SIDE) return;
    let info = null;
    try { info = await engine.whatsNew(false); } catch (_) { return; }
    if (!info || !info.sections || !info.sections.length || document.querySelector("dialog[open]")) return;
    fillWhatsNew(info);
    whatsNewDlg.showModal();
    await new Promise((done) => whatsNewDlg.addEventListener("close", done, { once: true }));
  }
  $("#whatsNewOk").addEventListener("click", () => whatsNewDlg.close());
  $("#whatsNewAll").addEventListener("click", () => engine.openRelease("https://github.com/minimalhandle/SleekMeeter/blob/main/CHANGELOG.md").catch(() => {}));
  $("#whatsNewBtn").addEventListener("click", async () => {
    try {
      const info = await engine.whatsNew(true);
      if (!info || !info.sections.length) { toast("No release notes in this version"); return; }
      fillWhatsNew(info);
      whatsNewDlg.showModal();
    } catch (e) { toast(`Couldn't show the release notes: ${e}`); }
  });
  // Asked once, after any other first-run question; until then nothing is sent.
  const usageDlg = $("#usageDlg");
  function offerUsage() {
    if (SIDE || typeof settings.usagePing === "boolean" || document.querySelector("dialog[open]")) return;
    usageDlg.showModal();
  }
  const answerUsage = (yes) => { settings.usagePing = yes; saveSettings(); usageDlg.close(); if (yes) toast("Thanks! You can turn this off in Settings → Privacy"); };
  $("#usageYes").addEventListener("click", () => answerUsage(true));
  $("#usageNo").addEventListener("click", () => answerUsage(false));
  $("#streamDeckGo").addEventListener("click", () => { streamDeckDlg.close(); runStreamDeckOffer(); });
  $("#streamDeckLater").addEventListener("click", () => streamDeckDlg.close());
  $("#streamDeckAction").addEventListener("click", runStreamDeckOffer);
  $("#streamDeckProfile").addEventListener("click", async () => {
    try { if (await engine.streamDeckProfileSave()) toast("Stream Deck + profile saved"); }
    catch (e) { fail(e); }
  });
  $("#sceneSave").addEventListener("submit", async (e) => {
    e.preventDefault();
    const n = $("#sceneName").value.trim().replace(/[\\/:*?"<>|]/g, "");
    if (!n) return;
    try { await engine.saveScene(n); $("#sceneName").value = ""; setScene(n); toast(`Saved “${n}”`); renderScenes(); } catch (err) { fail(err); }
  });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });



  /* ---------- output profiles ---------- */
  // A profile is a saved set of output devices ("Headphones", "Speakers"). The app applies it
  // and, with "Auto", applies it when one of its devices connects.
  const outputsDlg = $("#outputsDlg"), outputsBtn = $("#outputsBtn"), profileUl = $("#profileList");
  let activeProfile = null;
  const profiles = () => (settings.outputProfiles || (settings.outputProfiles = []));
  function fallbackChains() {
    if (!settings.outputFallbacks || typeof settings.outputFallbacks !== "object" || Array.isArray(settings.outputFallbacks)) settings.outputFallbacks = {};
    return settings.outputFallbacks;
  }
  function fallbackLinks() {
    if (!settings.outputFallbackLinks || typeof settings.outputFallbackLinks !== "object" || Array.isArray(settings.outputFallbackLinks)) settings.outputFallbackLinks = {};
    return settings.outputFallbackLinks;
  }
  let fallbackDevices = [], fallbackStatusRequest = 0;
  const outputReasons = new Map(), outputDeviceRows = new Map(), fallbackRequests = new Map();
  const hasFallback = (i) => !!fallbackChains()[fallbackLinks()[i] ?? i]?.length;
  function readFallbackReason(i) {
    if (!hasFallback(i)) return Promise.resolve("No fallback policy configured");
    if (fallbackRequests.has(i)) return fallbackRequests.get(i);
    const request = engine.fallbackStatus(i).catch((e) => String(e)).finally(() => fallbackRequests.delete(i));
    fallbackRequests.set(i, request);
    return request;
  }
  function paintOutputDevices() {
    if (!outputsDlg.open) return;
    const list = $("#outputDevices"), hardware = chans.filter((c) => c.kind === "bus" && isHw(c));
    for (const [i, row] of outputDeviceRows) if (!hardware.some((c) => c.i === i)) { row.el.remove(); outputDeviceRows.delete(i); }
    for (const bus of hardware) {
      if (!outputDeviceRows.has(bus.i)) {
        const el = document.createElement("li"), content = document.createElement("div");
        const device = document.createElement("strong"), reason = document.createElement("span");
        const edit = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: "Fallbacks…" });
        edit.setAttribute("aria-label", `Manage fallbacks for ${bus.info.id}`);
        edit.addEventListener("click", () => openOutputFallback(bus.i));
        content.append(device, reason);
        el.append(content, edit);
        list.append(el);
        outputDeviceRows.set(bus.i, { el, device, reason });
      }
      const row = outputDeviceRows.get(bus.i);
      const device = `${bus.info.id} · ${!connected ? "Voicemeeter disconnected" : bus.data?.device || "No playback device"}`;
      const reason = !connected ? "" : hasFallback(bus.i) ? outputReasons.get(bus.i) || "Checking fallback policy…" : "No fallback policy configured";
      if (row.device.textContent !== device) row.device.textContent = device;
      if (row.reason.textContent !== reason) row.reason.textContent = reason;
    }
  }
  async function refreshOutputReasons() {
    if (!outputsDlg.open || !connected) return;
    const current = chans.filter((c) => c.kind === "bus" && isHw(c) && hasFallback(c.i));
    await Promise.all(current.map(async (c) => outputReasons.set(c.i, await readFallbackReason(c.i))));
    paintOutputDevices();
  }
  async function refreshFallbackStatus() {
    const bus = $("#fallbackBus").value;
    if (!outputsDlg.open || !$("#fallbackFold").open || bus === "") return;
    const request = ++fallbackStatusRequest;
    const result = await readFallbackReason(+bus);
    if (request === fallbackStatusRequest) $("#fallbackStatus").textContent = result;
  }
  function renderFallbackList() {
    const bus = $("#fallbackBus").value;
    const links = fallbackLinks(), linked = links[bus];
    const entries = fallbackChains()[linked ?? bus] || [];
    const source = $("#fallbackSource"), previous = source.value;
    const sources = [...$("#fallbackBus").options].filter((o) => o.value !== bus && links[o.value] == null && fallbackChains()[o.value]?.length);
    source.replaceChildren(new Option(linked == null ? "Use a policy from…" : `Linked to ${$("#fallbackBus").options[+linked]?.textContent || `A${+linked + 1}`}`, ""),
      ...sources.map((o) => new Option(o.textContent, o.value)));
    if (sources.some((o) => o.value === previous) && linked == null) source.value = previous;
    source.disabled = linked != null || !sources.length;
    $("#fallbackDevice").disabled = linked != null;
    $("#fallbackAdd").disabled = linked != null || bus === "" || !fallbackDevices.length;
    $("#fallbackUnlink").hidden = linked == null;
    paintFallbackActions();
    const list = $("#fallbackList");
    list.replaceChildren();
    entries.forEach((device, i) => {
      const item = Object.assign(document.createElement("li"), { textContent: `${device.name} (${device.type.toUpperCase()}) ` });
      const action = (label, disabled, change) => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: label, disabled });
        b.setAttribute("aria-label", `${label} ${device.name}`);
        b.addEventListener("click", () => { change(); saveFallback(); });
        return b;
      };
      const move = (j) => { [entries[i], entries[j]] = [entries[j], entries[i]]; };
      if (linked == null) item.append(action("↑", !i, () => move(i - 1)), action("↓", i === entries.length - 1, () => move(i + 1)), action("Remove", false, () => {
        entries.splice(i, 1);
        if (!entries.length) delete fallbackChains()[bus];
      }));
      list.append(item);
    });
  }
  function paintFallbackActions() {
    const bus = $("#fallbackBus").value, source = $("#fallbackSource").value;
    const blocked = bus === "" || source === "" || fallbackLinks()[bus] != null;
    $("#fallbackCopy").disabled = blocked;
    const hasDependants = Object.values(fallbackLinks()).includes(bus);
    $("#fallbackLink").disabled = blocked || hasDependants;
    $("#fallbackLink").title = hasDependants ? "Other outputs already share this output’s policy" : "";
  }
  async function saveFallback() {
    renderFallbackList();
    await saveNow();
    outputReasons.clear();
    paintOutputDevices();
    refreshOutputReasons();
    refreshFallbackStatus();
  }
  async function loadFallbackEditor() {
    const bus = $("#fallbackBus"), device = $("#fallbackDevice");
    const previous = bus.value;
    bus.replaceChildren(...chans.filter((c) => c.kind === "bus" && c.info.kind === "hw")
      .map((c) => new Option(`${c.info.id} · ${displayName(c)}`, String(c.i))));
    if ([...bus.options].some((o) => o.value === previous)) bus.value = previous;
    fallbackDevices = [];
    renderFallbackList();
    refreshFallbackStatus();
    $("#fallbackAdd").disabled = true;
    device.replaceChildren(new Option("Loading playback devices…", ""));
    try {
      const found = await engine.devices();
      fallbackDevices = (found.outputs || []).filter((d) => ["wdm", "ks", "mme"].includes(d.type));
      device.replaceChildren(new Option("Choose a playback device", ""), ...fallbackDevices.map((d, i) => new Option(`${d.name} (${d.type.toUpperCase()})`, String(i))));
      renderFallbackList();
    } catch (e) { device.replaceChildren(new Option("Playback devices unavailable", "")); fail(e); }
  }
  $("#fallbackBus").addEventListener("change", () => { renderFallbackList(); refreshFallbackStatus(); });
  $("#fallbackSource").addEventListener("change", paintFallbackActions);
  $("#fallbackFold").addEventListener("toggle", refreshFallbackStatus);
  for (const [id, link] of [["fallbackCopy", false], ["fallbackLink", true]]) {
    $(`#${id}`).addEventListener("click", () => {
      const bus = $("#fallbackBus").value, source = $("#fallbackSource").value;
      if (bus === "" || !fallbackChains()[source]?.length || fallbackLinks()[bus] != null) return;
      if (fallbackChains()[bus]?.length && !window.confirm("Replace this output’s current fallback policy?")) return;
      if (link) {
        if (Object.values(fallbackLinks()).includes(bus)) return;
        fallbackLinks()[bus] = source;
        delete fallbackChains()[bus];
      } else fallbackChains()[bus] = clone(fallbackChains()[source]);
      saveFallback();
    });
  }
  $("#fallbackUnlink").addEventListener("click", () => {
    const bus = $("#fallbackBus").value, source = fallbackLinks()[bus];
    if (source == null) return;
    fallbackChains()[bus] = clone(fallbackChains()[source] || []);
    delete fallbackLinks()[bus];
    saveFallback();
  });
  $("#fallbackAdd").addEventListener("click", () => {
    const bus = $("#fallbackBus").value, selected = $("#fallbackDevice").value;
    const device = selected === "" ? null : fallbackDevices[Number(selected)];
    if (bus === "" || !device || fallbackLinks()[bus] != null) return;
    const entries = fallbackChains()[bus] || (fallbackChains()[bus] = []);
    if (entries.some((d) => d.name === device.name)) return;
    entries.push({ name: device.name, type: device.type });
    saveFallback();
  });
  function profileSummary(p) {
    return p.buses.map((e) => {
      const b = layout && layout.buses[e.bus];
      return `${b ? b.id : "A" + (e.bus + 1)} ${e.name || "none"}`;
    }).join("   ·   ");
  }
  function applyOutputs(st) {
    activeProfile = st.outputProfile || null;
    outputsBtn.dataset.live = activeProfile ? "1" : "";
    outputsBtn.title = activeProfile ? `Outputs: ${activeProfile}` : "Switch between saved output devices";
    if (outputsDlg.open) { markProfiles(); paintOutputDevices(); }
  }
  function markProfiles() {
    profileUl.querySelectorAll("li[data-name]").forEach((li) => li.classList.toggle("live", li.dataset.name === activeProfile));
  }
  async function applyProfile(name) {
    try {
      await saveNow();
      await engine.outputsApply(name);
      toast(`Switched outputs to “${name}”`);
    } catch (e) { fail(e); }
  }
  function renderProfiles() {
    profileUl.textContent = "";
    const list = profiles();
    $("#profileNote").hidden = !list.length;
    $("#profileNote").textContent = "Switching only changes the devices on your outputs. Levels, routing and everything else stay as they are. “Auto” switches to a setup by itself when one of its devices connects, like turning on your headset.";
    if (!list.length) {
      profileUl.appendChild(Object.assign(document.createElement("li"), { className: "empty", textContent: "Nothing saved yet. Pick the devices for your outputs, then name this setup below to save it." }));
      return;
    }
    for (const p of list) {
      const li = document.createElement("li");
      li.dataset.name = p.name;
      const load = document.createElement("button");
      load.type = "button"; load.className = "load";
      const nm = Object.assign(document.createElement("span"), { className: "pf-name", textContent: p.name });
      const dev = Object.assign(document.createElement("span"), { className: "pf-devices", textContent: profileSummary(p) });
      dev.title = profileSummary(p);
      const live = Object.assign(document.createElement("span"), { className: "pf-live", textContent: "In use" });
      load.append(nm, dev, live);
      load.addEventListener("click", () => applyProfile(p.name));
      const auto = document.createElement("button");
      auto.type = "button"; auto.className = "tog auto-pf"; auto.textContent = "Auto";
      auto.title = "Switch to this setup automatically when one of its devices connects";
      auto.setAttribute("aria-pressed", String(!!p.auto));
      auto.addEventListener("click", () => {
        p.auto = !p.auto;
        auto.setAttribute("aria-pressed", String(p.auto));
        saveSettings();
      });
      const del = Object.assign(document.createElement("button"), { type: "button", className: "btn del", textContent: "Delete" });
      del.setAttribute("aria-label", `Delete ${p.name}`);
      let armed = false;
      del.addEventListener("click", () => {
        if (!armed) { armed = true; del.textContent = "Confirm"; setTimeout(() => { armed = false; del.textContent = "Delete"; }, 3000); return; }
        const at = profiles().indexOf(p);
        if (at >= 0) profiles().splice(at, 1);
        saveSettings();
        renderProfiles();
        toast(`Deleted “${p.name}”`);
      });
      li.append(load, auto, del);
      profileUl.appendChild(li);
    }
    markProfiles();
  }
  $("#profileSave").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#profileName").value.trim().slice(0, 40);
    if (!name) return;
    try {
      const buses = await engine.outputsCapture();
      if (!buses.some((b) => b.name)) { toast("None of your outputs has a device yet"); return; }
      const list = profiles();
      const at = list.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
      const entry = { name: at >= 0 ? list[at].name : name, auto: at >= 0 ? !!list[at].auto : false, buses };
      if (at >= 0) list[at] = entry; else list.push(entry);
      $("#profileName").value = "";
      await saveNow();
      renderProfiles();
      toast(at >= 0 ? `Updated “${entry.name}”` : `Saved “${entry.name}”`);
    } catch (err) { fail(err); }
  });
  let fallbackTimer;
  outputsBtn.addEventListener("click", () => {
    renderProfiles(); outputsDlg.showModal(); loadFallbackEditor();
    paintOutputDevices(); refreshOutputReasons();
    clearInterval(fallbackTimer);
    fallbackTimer = setInterval(() => { refreshOutputReasons(); refreshFallbackStatus(); }, 3000);
  });
  outputsDlg.addEventListener("close", () => clearInterval(fallbackTimer));
  function openOutputFallback(i) {
    if (!outputsDlg.open) outputsBtn.click();
    const select = $("#fallbackBus");
    if (i != null && [...select.options].some((o) => o.value === String(i))) select.value = String(i);
    const fold = $("#fallbackFold");
    fold.open = true;
    renderFallbackList();
    refreshFallbackStatus();
    $("summary", fold).focus();
    fold.scrollIntoView({ block: "nearest" });
  }
  $("#settingsFallback").addEventListener("click", () => {
    settingsDlg.close(); openOutputFallback();
  });
  outputsDlg.addEventListener("click", (e) => { if (e.target === outputsDlg) outputsDlg.close(); });

  /* ---------- volume per app ---------- */
  // Windows' own per-app volume (the volume mixer), read once a second while this window is open.
  const appsDlg = $("#appsDlg"), appsBtn = $("#appsBtn"), appListEl = $("#appVolList");
  const appsFlowVisible = () => appsDlg.open && !$("#appsFlow").hidden;
  const selectAppsTab = bindTabs($("#appsTabs"), (tab) => {
    if (!appsDlg.open) return;
    if (tab === "assignments") paintAppAssignments();
    if (tab === "flow") {
      paintAudioFlow();
      refreshRouteTrace();
    } else if ($("#guidedAudio").open) $("#guidedAudio").open = false;
  });
  const appRows = new Map(); // exe → { el, slider, out, mute, name, live, lockUntil }
  let appsTimer = null, appsBusy = false, appsFailed = false;
  function paintAppSlider(slider) {
    const p = +slider.value;
    slider.style.setProperty("--track-bg", `linear-gradient(to right, var(--amber) ${p}%, var(--rail) ${p}%)`);
  }
  function sendApp(exe, volume, mute) {
    engine.appVolumeSet(exe, volume, mute).catch((e) => { fail(e); refreshApps(); });
  }
  const appPending = new Map();
  function sendAppVolume(exe, v) {
    if (appPending.has(exe)) { appPending.set(exe, v); return; }
    appPending.set(exe, v);
    setTimeout(() => { const val = appPending.get(exe); appPending.delete(exe); sendApp(exe, val, null); }, 60);
  }
  let routeDevices = [];
  let routeTraceGeneration = 0, routeInspectTarget = "";
  function syncRouteInspector(apps) {
    const select = $("#routeInspectApp");
    const selected = routeInspectTarget || select.value;
    const choices = apps.map(({ exe, name }) => [exe, name]);
    if (routeInspectTarget && !apps.some((a) => a.exe === routeInspectTarget)) {
      choices.push([routeInspectTarget, exeName(routeInspectTarget) + " (no active session)"]);
    }
    const signature = JSON.stringify(choices);
    if (select.dataset.apps === signature && selected === select.value) return;
    select.dataset.apps = signature;
    select.replaceChildren(new Option("Choose an app", ""), ...choices.map(([exe, name]) => new Option(name, exe)));
    select.value = choices.some(([exe]) => exe === selected) ? selected : "";
    if (apps.some((a) => a.exe === routeInspectTarget)) routeInspectTarget = "";
    if (!select.value) {
      routeTraceGeneration++;
      showRouteTrace([]);
    }
  }

  let routeTraceDefaults = null;
  let routeTraceAt = 0;
  let routeTraceRequest = null;
  let routeTracePaint = 0;
  function showRouteTrace(rows) {
    const result = $("#routeInspectResult");
    const signature = JSON.stringify(rows);
    if (result.dataset.trace === signature) return;
    result.dataset.trace = signature;
    const firstWarning = rows.findIndex((row) => row.warning);
    result.replaceChildren(...rows.map(({ text, warning }, index) => Object.assign(document.createElement("li"), {
      textContent: index === firstWarning ? "Check first · " + text : text,
      className: index === firstWarning ? "route-warning" : warning ? "route-issue" : "",
    })));
  }
  function paintRouteTrace() {
    const exe = $("#routeInspectApp").value;
    if (!appsFlowVisible() || !exe) return;
    const app = appRows.get(exe)?.session;
    if (!app) { showRouteTrace([{ text: "This app has no Windows audio session." }]); return; }
    if (!routeTraceAt) { showRouteTrace([{ text: "Reading playback devices…" }]); return; }
    const defaults = routeTraceDefaults;
    const rows = [];
    const add = (text, warning = false) => rows.push({ text, warning });
    add(`${app.name} · ${app.volume}%${app.mute ? " · muted in Windows" : app.volume === 0 ? " · volume is zero" : ""}`, app.mute || app.volume === 0);
    const chosen = (settings.appRoutes || {})[app.exe];
    const observed = app.endpoints || [];
    const ids = [...new Set(observed.length ? observed : chosen ? [chosen] : defaults?.filter(Boolean) || [])];
    if (!ids.length) add("Windows playback device could not be determined.", true);
    const outputs = chans.filter((c) => c.kind === "bus");
    const anySolo = chans.some((c) => c.kind === "strip" && c.data?.solo);
    for (const id of ids) {
      const device = routeDevices.find((d) => d.id.toLowerCase() === id.toLowerCase());
      const source = observed.length ? "Windows audio session" : chosen ? "Saved app route" : "Possible Windows default";
      add(`${source} → ${device?.name || "device unavailable"}`, !device);
      if (!device) continue;
      const input = channelForDevice(device.id);
      if (!connected) { add("Voicemeeter is disconnected.", true); continue; }
      if (!input?.data) { add("No matching Voicemeeter input. This device may play outside the mixer."); continue; }
      const d = input.data;
      const blocked = d.mute ? "muted" : anySolo && !d.solo ? "another input is soloed" : d.gain <= -60 ? "fader at minimum" : "";
      add(`Voicemeeter input → ${displayName(input)}${blocked ? " · " + blocked : ""}`, !!blocked);
      let routed = 0;
      for (const bus of outputs) {
        const name = bus.info.id;
        const on = d[name[0].toLowerCase()]?.[Number(name.slice(1) || "1") - 1];
        if (!on) continue;
        routed++;
        const out = bus.data || {};
        const problem = out.mute ? "muted" : out.gain <= -60 || d.layers?.[bus.i] <= -60 ? "fader at minimum" :
          bus.info.kind === "hw" && !out.device ? "no playback device selected" : "";
        add(`${name} → ${displayName(bus)}${out.device ? " · " + out.device : ""}${problem ? " · " + problem : ""}`, !!problem);
      }
      if (!routed) add("No output routes enabled on this input.", true);
    }

    showRouteTrace(rows);
  }
  function scheduleRouteTrace() {
    if (!appsFlowVisible() || routeTracePaint) return;
    routeTracePaint = setTimeout(() => { routeTracePaint = 0; paintRouteTrace(); paintAudioFlow(); }, 120);
  }
  async function refreshRouteTrace(force = false) {
    if (!appsFlowVisible()) return;
    if (!force && Date.now() - routeTraceAt < 3000) { scheduleRouteTrace(); return; }
    if (routeTraceRequest) return routeTraceRequest;
    const generation = routeTraceGeneration;
    routeTraceRequest = Promise.all([engine.appRouteDevices(), engine.appRouteDefaults()])
      .then(([devices, defaults]) => {
        if (generation !== routeTraceGeneration || !appsDlg.open) return;
        if (JSON.stringify(devices || []) !== JSON.stringify(routeDevices)) {
          routeDevices = devices || [];
          for (const row of appRows.values()) fillRoute(row, row.session);
        }
        routeTraceDefaults = defaults;
        routeTraceAt = Date.now();
        paintRouteTrace();
        paintAudioFlow();
        paintAppAssignments();
      })
      .catch((e) => {
        if (generation === routeTraceGeneration && appsDlg.open && !routeTraceAt) showRouteTrace([{ text: String(e), warning: true }]);
      })
      .finally(() => { routeTraceRequest = null; });
    return routeTraceRequest;
  }
  $("#routeInspectApp").addEventListener("change", () => {
    if (!$("#routeInspectApp").value) { showRouteTrace([]); return; }
    paintRouteTrace();
    refreshRouteTrace();
  });
  $("#routeInspectRefresh").addEventListener("click", async () => {
    await refreshApps();
    await refreshRouteTrace(true);
  });
  appsDlg.addEventListener("close", () => {
    routeTraceGeneration++;
    routeInspectTarget = "";
    routeTraceAt = 0;
    clearTimeout(routeTracePaint);
    routeTracePaint = 0;
  });
  function fillRoute(row, a) {
    const sel = row.route, saved = (settings.appRoutes || {})[a.exe] || "";
    sel.textContent = "";
    sel.appendChild(new Option("Windows default", ""));
    for (const d of routeDevices) sel.appendChild(new Option(d.name, d.id));
    if (saved && !routeDevices.some((d) => d.id === saved)) sel.appendChild(new Option("Chosen device (not found)", saved));
    sel.value = saved;
    sel.disabled = !(a.pids && a.pids.length);
  }
  function makeAppRow(a) {
    const el = document.createElement("div");
    el.className = "app-row";
    el.innerHTML = `<span class="app-name"><i class="live" aria-hidden="true"></i><span class="t"></span></span>`
      + `<input type="range" min="0" max="100" step="1"><output></output><button type="button" class="tog mute" aria-pressed="false">Mute</button>`
      + `<select class="route" title="Which output this app plays to"></select>`;
    const row = { el, slider: $("input", el), out: $("output", el), mute: $(".mute", el), name: $(".t", el), live: $(".live", el), route: $(".route", el), pids: a.pids || [], lockUntil: 0, isMuted: false };
    row.route.setAttribute("aria-label", `${a.name} output`);
    fillRoute(row, a);
    row.route.addEventListener("change", async () => {
      const dev = row.route.value, before = (settings.appRoutes || {})[a.exe] || "";
      try {
        await engine.appRouteSet(row.pids, dev);
        settings.appRoutes = settings.appRoutes || {};
        if (dev) settings.appRoutes[a.exe] = dev; else delete settings.appRoutes[a.exe];
        saveSettings();
        const d = routeDevices.find((x) => x.id === dev);
        toast(dev ? `${a.name} now plays to ${d ? d.name : "that device"}` : `${a.name} is back on the Windows default`);
      } catch (err) { row.route.value = before; fail(err); }
    });
    row.slider.setAttribute("aria-label", `${a.name} volume`);
    row.slider.addEventListener("input", () => {
      row.lockUntil = Date.now() + 1200;
      row.out.textContent = row.slider.value + "%";
      paintAppSlider(row.slider);
      sendAppVolume(a.exe, +row.slider.value);
    });
    row.slider.addEventListener("dblclick", () => {
      row.slider.value = 100; row.slider.dispatchEvent(new Event("input"));
    });
    row.mute.addEventListener("click", () => {
      row.lockUntil = Date.now() + 1200;
      row.isMuted = !row.isMuted;
      row.mute.setAttribute("aria-pressed", String(row.isMuted));
      el.classList.toggle("muted", row.isMuted);
      sendApp(a.exe, null, row.isMuted);
    });
    return row;
  }
  function updateAppRow(row, a) {
    row.session = a;
    row.name.textContent = a.name;
    row.name.title = a.exe;
    row.pids = a.pids || [];
    row.route.disabled = !row.pids.length;
    row.live.classList.toggle("on", !!a.active);
    row.live.title = a.active ? "Playing sound" : "Not playing right now";
    if (Date.now() < row.lockUntil || document.activeElement === row.slider) return;
    row.slider.value = a.volume;
    row.out.textContent = a.volume + "%";
    paintAppSlider(row.slider);
    row.isMuted = !!a.mute;
    row.mute.setAttribute("aria-pressed", String(row.isMuted));
    row.el.classList.toggle("muted", row.isMuted);
  }
  async function refreshApps() {
    if (appsBusy) return;
    appsBusy = true;
    try {
      const list = await engine.appVolumes();
      syncRouteInspector(list);
      const seen = new Set();
      for (const a of list) {
        seen.add(a.exe);
        let row = appRows.get(a.exe);
        if (!row) { row = makeAppRow(a); appRows.set(a.exe, row); appListEl.appendChild(row.el); }
        updateAppRow(row, a);
      }
      for (const [exe, row] of appRows) if (!seen.has(exe)) { row.el.remove(); appRows.delete(exe); }
      $("#appVolEmpty").hidden = appRows.size > 0;
      appsFailed = false;
      refreshRouteTrace();
      paintAppAssignments();
    } catch (e) {
      if (!appsFailed) fail(e);
      appsFailed = true;
    } finally { appsBusy = false; }
  }
  function openAppVolumes(tab = "volumes", destination = "") {
    appRows.clear();
    appListEl.textContent = "";
    syncRouteInspector([]);
    $("#appVolEmpty").hidden = true;
    appsFailed = false;
    assignmentSignature = "";
    assignmentDestination = destination;
    if (!appsDlg.open) appsDlg.showModal();
    selectAppsTab(tab, true);
    refreshApps();
    engine.appRouteDevices().then((d) => {
      routeDevices = d || [];
      for (const [, row] of appRows) fillRoute(row, row.session);
      paintAppAssignments();
    }).catch(() => {});
    clearInterval(appsTimer);
    appsTimer = setInterval(refreshApps, 1000);
  }
  appsDlg.addEventListener("close", () => { clearInterval(appsTimer); appsTimer = null; });
  appsDlg.addEventListener("click", (e) => { if (e.target === appsDlg) appsDlg.close(); });


  /* ---------- apps tray: drag an app onto a channel (like Wave Link) ---------- */
  // Voicemeeter's virtual inputs are Windows playback devices, so "putting an app on a channel"
  // means pointing that app's output at the channel's device. Routes are remembered by program
  // name and put back when the program starts again.
  const trayEl = $("#appTray"), trayAppsEl = $("#trayApps"), trayEmpty = $("#trayEmpty");
  let trayRunning = []; // from the last poll: [{exe, name, pids, active}]
  let trayTimer = null, trayBusy = false, trayPolls = 0;

  const virtualStrips = () => chans.filter((c) => c.kind === "strip" && !isHw(c));
  // Which Windows playback device feeds a channel?
  //  - Voicemeeter's own virtual inputs, in order: VAIO, AUX, then VAIO3 (Potato).
  //  - A hardware input that listens to a virtual cable (VB-Cable): the cable's "Input" playback
  //    device is the other end of that cable, so an app played into it arrives on this channel.
  const adapterOf = (name) => { const m = /\(([^)]+)\)\s*$/.exec(name || ""); return m ? m[1].trim().toLowerCase() : ""; };
  function deviceForChannel(ch) {
    if (ch.kind !== "strip") return null;
    if (!isHw(ch)) {
      const at = virtualStrips().indexOf(ch);
      const vm = routeDevices.filter((d) => /voicemeeter/i.test(d.name));
      const label = [/^voicemeeter\s+input\b/i, /^voicemeeter\s+aux\s+input\b/i, /^voicemeeter\s+vaio3\s+input\b/i][at];
      return vm.find((d) => label?.test(d.name)) || null;
    }
    const dev = (ch.data && ch.data.device) || "";
    const extension = routeDevices.find((d) => new RegExp(`^voicemeeter\\s+in\\s+${ch.i + 1}\\b`, "i").test(d.name));
    if (!/cable|vb-?audio/i.test(dev) || /voicemeeter/i.test(dev)) return extension || null;
    const render = routeDevices.filter((d) => !/voicemeeter/i.test(d.name));
    const heard = adapterOf(dev), sameName = dev.replace(/output/i, "input").toLowerCase();
    const letter = (n) => { const m = /cable[\s-]*([a-z])\b/i.exec(n || ""); return m ? m[1].toLowerCase() : ""; };
    return render.find((d) => d.name.toLowerCase() === sameName)
      || (heard && render.find((d) => adapterOf(d.name) === heard))
      || (letter(dev) && render.find((d) => letter(d.name) === letter(dev)))
      || extension || null;
  }
  const channelForDevice = (id) => chans.find((c) => { const d = deviceForChannel(c); return d && d.id === id; }) || null;

  /* ---------- saved app assignments ---------- */
  const appAssignments = $("#appAssignments");
  let assignmentSignature = "", assignmentDestination = "";
  function paintAppAssignments() {
    if (!appsDlg.open || appAssignments.hidden) return;
    const destinations = chans.filter((c) => deviceForChannel(c));
    const routes = Object.entries(settings.appRoutes || {});
    const signature = JSON.stringify([destinations.map((c) => [c.prefix, displayName(c)]), routes.map(([exe, id]) =>
      [exe, id, displayNameSafe(channelForDevice(id)), appRows.get(exe)?.session?.endpoints, !!appRows.get(exe)?.pids.length])]);
    if (signature === assignmentSignature) return;
    assignmentSignature = signature;
    const select = $("#appAssignChannel"), previous = assignmentDestination || select.value;
    select.replaceChildren(new Option("Choose an input", ""), ...destinations.map((c) => new Option(displayName(c), c.prefix)));
    if (destinations.some((c) => c.prefix === previous)) {
      select.value = previous;
      assignmentDestination = "";
    }
    $("#appAssignList").replaceChildren(...routes.map(([exe, id]) => {
      const row = appRows.get(exe), dest = channelForDevice(id);
      const state = !id ? "Waiting to reset to Windows default" : !dest ? "Destination unavailable" : !row?.pids.length ? "Waiting for audio session"
        : row.session.endpoints?.some((ep) => ep.toLowerCase() === id.toLowerCase()) ? "Routed" : "Saved · awaiting confirmation";
      const item = document.createElement("li");
      item.append(document.createTextNode(`${exe} → ${dest ? displayName(dest) : id ? "saved device" : "Windows default"} · ${state}`));
      const remove = Object.assign(document.createElement("button"), { className: "btn", type: "button", textContent: "Remove" });
      remove.setAttribute("aria-label", `Remove assignment for ${exe}`);
      remove.addEventListener("click", () => saveAssignment(exe, null));
      if (id) item.append(remove);
      return item;
    }));
  }
  const displayNameSafe = (ch) => ch ? displayName(ch) : "";
  async function saveAssignment(exe, destination) {
    const row = appRows.get(exe);
    const device = destination && deviceForChannel(destination);
    if (destination && !device) { toast("This input has no available Windows playback device"); return false; }
    try {
      const pids = appsDlg.open ? row?.pids || [] : (await engine.appVolumes()).find((app) => app.exe === exe)?.pids || [];
      if (pids.length) await engine.appRouteSet(pids, device?.id || "");
      const routes = settings.appRoutes || (settings.appRoutes = {});
      if (device) routes[exe] = device.id;
      else if (pids.length || !window.__TAURI__) delete routes[exe];
      else routes[exe] = "";
      if (!await saveNow()) return false;
      if (row) fillRoute(row, row.session);
      paintAppAssignments(); paintTray(); paintStripApps(); scheduleRouteTrace();
      toast(device ? (pids.length ? "App assignment saved" : "App assignment saved. Waiting for an audio session.")
        : routes[exe] === "" ? "Will restore the Windows default when the app plays audio" : "App assignment removed");
      return true;
    } catch (e) { fail(e); return false; }
  }
  engine.onAppRouteReset((exe) => {
    if (settings.appRoutes?.[exe] !== "") return;
    delete settings.appRoutes[exe];
    paintAppAssignments(); paintTray(); paintStripApps(); scheduleRouteTrace();
  }).catch(() => {});
  $("#appAssignBrowse").addEventListener("click", () => $("#appAssignFile").click());
  $("#appAssignFile").addEventListener("change", (e) => {
    if (e.target.files[0]) $("#appAssignName").value = e.target.files[0].name;
    e.target.value = "";
  });
  $("#appAssignForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#appAssignName"), exe = name.value.trim().toLowerCase();
    if (!/^[^\\/:*?"<>|\u0000-\u001f]+\.exe$/i.test(exe)) { toast("Enter a Windows executable filename such as game.exe"); name.focus(); return; }
    const dest = chans.find((c) => c.prefix === $("#appAssignChannel").value);
    if (!dest) return;
    const submit = $('button[type="submit"]', e.currentTarget);
    submit.disabled = true;
    try { await saveAssignment(exe, dest); } finally { submit.disabled = false; }
  });

  /* ---------- live signal paths ---------- */
  const flowGraph = $("#audioFlowGraph"), flowPaths = $("#audioFlowPaths");
  let flowSignature = "", flowFocus = "", flowEdges = [], flowNodes = new Map();
  function drawFlowPaths() {
    if (!appsFlowVisible()) return;
    const kept = new Set(flowFocus ? [flowFocus] : flowNodes.keys());
    for (const direction of [0, 1]) {
      const walk = flowFocus ? [flowFocus] : [];
      const seen = new Set(walk);
      while (walk.length) {
        const next = walk.pop();
        for (const edge of flowEdges) {
          if (edge[direction] !== next || seen.has(edge[1 - direction])) continue;
          const node = edge[1 - direction];
          kept.add(node); seen.add(node); walk.push(node);
        }
      }
    }
    for (const [id, node] of flowNodes) {
      node.classList.toggle("dim", !kept.has(id));
      node.setAttribute("aria-pressed", String(id === flowFocus));
    }
    const { left, top } = flowGraph.getBoundingClientRect();
    flowPaths.replaceChildren(...flowEdges.flatMap(([from, to, issue]) => {
      const a = flowNodes.get(from)?.getBoundingClientRect(), b = flowNodes.get(to)?.getBoundingClientRect();
      if (!a || !b) return [];
      const x = a.right - left, y = a.top + a.height / 2 - top;
      const xx = b.left - left, yy = b.top + b.height / 2 - top;
      const mid = (x + xx) / 2;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M${x} ${y} C${mid} ${y} ${mid} ${yy} ${xx} ${yy}`);
      if (issue) path.classList.add("issue");
      if (!kept.has(from) || !kept.has(to)) path.classList.add("dim");
      return [path];
    }));
  }
  function paintAudioFlow() {
    if (!appsFlowVisible()) return;
    $("#audioFlowStatus").textContent = routeTraceAt ? "" : "Reading Windows playback devices…";
    const columns = [[], [], []], edges = [];
    const strips = chans.filter((c) => c.kind === "strip"), outputs = chans.filter((c) => c.kind === "bus");
    const solo = strips.some((c) => c.data?.solo);
    const issues = new Map();
    for (const input of strips) {
      const d = input.data || {};
      const issue = !connected ? "Voicemeeter disconnected" : d.mute ? "Muted" : solo && !d.solo ? "Other input soloed" :
        d.gain <= MIN_DB ? "Fader at minimum" : isHw(input) && !d.device ? "No input device" : "";
      issues.set(input.prefix, issue);
      const sends = outputs.filter((b) => d[b.info.id[0].toLowerCase()]?.[+(b.info.id.slice(1) || 1) - 1]);
      columns[1].push([input.prefix, displayName(input), issue || (!sends.length ? "No output routes" : d.device || "Virtual input"), !!issue || !sends.length]);
      for (const bus of sends) edges.push([input.prefix, bus.prefix, !!issue || !!bus.data?.mute || bus.data?.gain <= MIN_DB ||
        d.layers?.[bus.i] <= MIN_DB || (isHw(bus) && !bus.data?.device)]);
    }
    for (const bus of outputs) {
      const d = bus.data || {};
      const issue = !connected ? "Voicemeeter disconnected" : d.mute ? "Muted" : d.gain <= MIN_DB ? "Fader at minimum" : isHw(bus) && !d.device ? "No playback device" : "";
      columns[2].push([bus.prefix, `${bus.info.id} · ${displayName(bus)}`, issue || d.device || "Virtual output", !!issue]);
    }
    const assigned = settings.appRoutes || {}, direct = new Set();
    const programs = new Map([...appRows].map(([exe, row]) => [exe, row.session]));
    for (const exe of Object.keys(assigned)) if (!programs.has(exe)) programs.set(exe, { name: exeName(exe), waiting: true });
    for (const [exe, a] of programs) {
      const observed = a.endpoints || [];
      const ids = observed.length ? observed : assigned[exe] ? [assigned[exe]] : routeTraceDefaults?.filter(Boolean) || [];
      const state = a.waiting ? "Waiting for audio session" : a.mute ? "Muted in Windows" : a.volume === 0 ? "Volume is zero" :
        observed.length ? (a.active ? "Playing" : "Idle") : assigned[exe] ? "Saved route" : ids.length ? "Possible Windows default" : "Playback device unknown";
      columns[0].push([exe, a.name, state, !!(a.waiting || a.mute || a.volume === 0 || !observed.length)]);
      for (const id of new Set(ids)) {
        const device = routeDevices.find((d) => d.id.toLowerCase() === id.toLowerCase());
        const input = device && channelForDevice(device.id);
        const target = input?.prefix || `endpoint:${id}`;
        if (!input && !direct.has(target)) {
          direct.add(target);
          columns[2].push([target, device?.name || "Unavailable playback device", device ? "Direct Windows playback" : "Disconnected", !device]);
        }
        edges.push([exe, target, !observed.length || !!a.mute || a.volume === 0 || !device || !!issues.get(target)]);
      }
    }
    const signature = JSON.stringify([columns, edges]);
    if (signature === flowSignature) return;
    flowSignature = signature;
    flowEdges = edges;
    const keyboard = [...flowNodes].find(([, node]) => node === document.activeElement)?.[0];
    flowNodes = new Map();
    columns.forEach((list, i) => {
      const column = $([`#flowApps`, `#flowInputs`, `#flowOutputs`][i]);
      column.replaceChildren(...list.map(([id, title, detail, issue]) => {
        const button = Object.assign(document.createElement("button"), { className: `btn flow-node${issue ? " issue" : ""}`, type: "button", textContent: title });
        button.append(Object.assign(document.createElement("span"), { textContent: detail }));
        button.addEventListener("click", () => { flowFocus = flowFocus === id ? "" : id; drawFlowPaths(); });
        flowNodes.set(id, button);
        return button;
      }));
    });
    if (!flowNodes.has(flowFocus)) flowFocus = "";
    flowNodes.get(keyboard)?.focus({ preventScroll: true });
    drawFlowPaths();
  }
  new ResizeObserver(drawFlowPaths).observe(flowGraph);
  /* ---------- guided audio tests inside the route inspector ---------- */
  const guided = $("#guidedAudio"), guidedMonitor = $("#guidedMonitor"), guidedMic = $("#guidedMic");
  const guidedInputs = ["game", "chat", "stream"].map((kind) => $(`#guided${kind[0].toUpperCase() + kind.slice(1)}`));
  const guidedStatus = $("#guidedStatus");
  let guidedBusy = false, guidedTake = false, guidedEpoch = 0, guidedCapture = "";
  function paintGuidedControls() {
    for (const [i, id] of ["guidedGameRun", "guidedChatRun", "guidedStreamRun"].entries()) {
      $(`#${id}`).disabled = guidedBusy || !guidedInputs[i].value || (i === 2 && (!guidedCapture || !guidedMonitor.value));
    }
    $("#guidedRecord").disabled = guidedBusy || !guidedMic.value;
    for (const id of ["guidedRaw", "guidedProcessed"]) $(`#${id}`).disabled = guidedBusy || !guidedTake || !guidedMonitor.value;
    guidedMic.disabled = guidedBusy || !guidedMic.options.length;
    guidedMonitor.disabled = guidedBusy || !guidedMonitor.options.length;
    guidedInputs.forEach((el) => { el.disabled = guidedBusy || !el.options.length; });
  }
  async function loadGuidedAudio() {
    if (!guided.open || !appsDlg.open) return;
    const epoch = ++guidedEpoch;
    guidedCapture = "";
    paintGuidedControls();
    try {
      const [routes, playback, capture] = await Promise.all([engine.appRouteDevices(), engine.soundDevices(), engine.selftestInputs()]);
      if (epoch !== guidedEpoch) return;
      routeDevices = routes || [];
      const inputs = chans.filter((c) => c.kind === "strip").map((c) => ({ c, d: deviceForChannel(c) }))
        .filter(({ d }) => d && playback.devices?.includes(d.name));
      guidedInputs.forEach((el, i) => {
        const saved = el.value, balance = settings.chatBalance || {};
        const preferred = i === 0 ? balance.game : i === 1 ? balance.chat : "";
        const pattern = i === 0 ? /game/i : /chat|discord/i;
        const pick = inputs.find(({ d }) => d.id === saved) || inputs.find(({ c }) => c.prefix === preferred)
          || (i < 2 && inputs.find(({ c }) => pattern.test(displayName(c)))) || inputs[i % Math.max(inputs.length, 1)] || inputs[0];
        el.replaceChildren(...inputs.map(({ c, d }) => new Option(`${displayName(c)} · ${d.name}`, d.id)));
        if (pick) el.value = pick.d.id;
      });
      const monitor = guidedMonitor.value;
      const physical = physicalPlayback(playback.devices || []);
      guidedMonitor.replaceChildren(new Option("Choose playback device", ""), ...physical.map((d) => new Option(d, d)));
      if (physical.includes(monitor)) guidedMonitor.value = monitor;
      const chosenMic = guidedMic.value;
      guidedMic.replaceChildren(...MF().chains.map((chain) => new Option(
        chans.find((c) => c.prefix === chain.target) ? displayName(chans.find((c) => c.prefix === chain.target)) : chain.target, chain.id)));
      if ([...guidedMic.options].some((o) => o.value === chosenMic)) guidedMic.value = chosenMic;
      const stream = streamBus();
      guidedCapture = stream ? captureForBus(stream, capture.devices || []) : "";
      $("#guidedStreamBus").textContent = stream
        ? `Stream output: ${stream.info.id} · ${displayName(stream)}${guidedCapture ? "" : " (Windows recording endpoint unavailable)"}`
        : "No stream output is available.";
      if (!guidedBusy) guidedStatus.textContent = inputs.length ? "" : "No playback devices map to your mixer inputs. Connect Voicemeeter, then reopen this test.";
    } catch (e) { if (epoch === guidedEpoch) guidedStatus.textContent = String(e); }
    finally { paintGuidedControls(); }
  }
  async function runGuided(message, action) {
    if (guidedBusy) return;
    const epoch = guidedEpoch;
    guidedBusy = true;
    guidedStatus.textContent = message;
    paintGuidedControls();
    try {
      const result = await action();
      if (epoch === guidedEpoch) guidedStatus.textContent = result;
    } catch (e) { if (epoch === guidedEpoch) guidedStatus.textContent = String(e); }
    finally { guidedBusy = false; paintGuidedControls(); }
  }
  for (const [i, kind] of ["game", "chat", "stream"].entries()) {
    $(`#guided${kind[0].toUpperCase() + kind.slice(1)}Run`).addEventListener("click", () => {
      const device = routeDevices.find((d) => d.id === guidedInputs[i].value);
      if (!device) return;
      if (kind === "stream") {
        const input = channelForDevice(device.id), stream = streamBus();
        const send = +(stream?.info.id.slice(1) || 1) - 1;
        if (!input?.data?.b?.[send]) {
          guidedStatus.textContent = "Enable this input’s route to the stream output in the mixer, then try again.";
          return;
        }
      }
      runGuided(`Testing ${kind}…`, () => engine.guidedTest(device.name, kind === "stream" ? guidedCapture : "", guidedMonitor.value, kind));
    });
  }
  $("#guidedRecord").addEventListener("click", () => {
    const epoch = guidedEpoch;
    guidedTake = false;
    runGuided("Recording for four seconds. Speak now.", async () => {
      if (!await saveNow()) throw new Error("Could not save the current mic settings.");
      if (epoch !== guidedEpoch) return "";
      await engine.micTakeRecord(guidedMic.value);
      if (epoch === guidedEpoch) guidedTake = true;
      return "Comparison ready. Choose a playback device and listen to both versions.";
    });
  });
  for (const [id, processed] of [["guidedRaw", false], ["guidedProcessed", true]]) {
    $(`#${id}`).addEventListener("click", () => runGuided("Playing mic comparison…", async () => {
      await engine.micTakePlay(guidedMonitor.value, processed);
      return processed ? "Played the processed recording." : "Played the raw recording.";
    }));
  }
  function clearGuidedAudio() {
    guidedEpoch++;
    guidedTake = false;
    guidedStatus.textContent = "";
    engine.micTakeClear().catch(fail);
    paintGuidedControls();
  }
  guided.addEventListener("toggle", () => guided.open ? loadGuidedAudio() : clearGuidedAudio());
  guidedMonitor.addEventListener("change", paintGuidedControls);
  guidedMic.addEventListener("change", clearGuidedAudio);
  appsDlg.addEventListener("close", () => { if (guided.open) guided.open = false; clearGuidedAudio(); });
  $("#settingsAudioTest").addEventListener("click", () => {
    settingsDlg.close(); openAppVolumes("flow"); guided.open = true;
    requestAnimationFrame(() => guided.scrollIntoView({ block: "nearest" }));
  });
  paintGuidedControls();
  function whyNot(ch) {
    if (!ch || ch.kind !== "strip") return "Outputs can't take apps. Drop it on an input channel";
    const dev = (ch.data && ch.data.device) || "";
    if (!isHw(ch)) return "Windows doesn't list a playback device for this Voicemeeter input. Is Voicemeeter running?";
    if (!/cable|vb-?audio/i.test(dev)) return `“${displayName(ch)}” listens to a real device, so apps can't be sent to it. Use a channel that listens to a virtual cable, or one of Voicemeeter's own inputs`;
    const found = routeDevices.filter((d) => /cable/i.test(d.name)).map((d) => d.name);
    return `“${displayName(ch)}” listens to “${dev}”, but Windows doesn't list a matching playback device. Cable playback devices found: ${found.length ? found.join(", ") : "none"}`;
  }
  const exeName = (exe) => { const t = exe.replace(/\.exe$/i, ""); return exe === "system sounds" ? "System sounds" : t.charAt(0).toUpperCase() + t.slice(1); };
  const hueOf = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const initialOf = (name) => (name.trim().charAt(0) || "?").toUpperCase();
  const pidsOf = (exe) => { const a = trayRunning.find((x) => x.exe === exe); return a ? a.pids || [] : []; };

  async function routeApp(a, ch) {
    const dev = ch ? deviceForChannel(ch) : null;
    if (ch && !dev) { toast(whyNot(ch)); return; }
    const name = a.name || exeName(a.exe);
    const pids = a.pids || [];
    try {
      if (pids.length) await engine.appRouteSet(pids, dev ? dev.id : "");
    } catch (e) { fail(e); return; }
    settings.appRoutes = settings.appRoutes || {};
    if (dev) settings.appRoutes[a.exe] = dev.id; else delete settings.appRoutes[a.exe];
    saveSettings();
    paintTray();
    paintStripApps();
    if (ch) toast(`${name} now plays through ${displayName(ch)}. If it doesn't move, pause and play it once.`);
    else toast(`${name} is back on the Windows default`);
  }

  function chipFor(a, routedCh) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "app-chip" + (a.active ? " on" : "") + (a.pids && a.pids.length ? "" : " idle") + (a.exe === "system sounds" ? " fixed" : "");
    b.dataset.exe = a.exe;
    b.style.setProperty("--hue", hueOf(a.exe));
    b.title = a.exe === "system sounds" ? "Windows system sounds can't be moved" : `${a.name}: drag onto a channel`;
    b.innerHTML = `<span class="av"><span></span><i></i></span><span class="nm"></span>`;
    $(".av span", b).textContent = initialOf(a.name);
    $(".nm", b).textContent = a.name;
    if (routedCh) { const t = document.createElement("span"); t.className = "to"; t.textContent = displayName(routedCh); b.appendChild(t); }
    if (a.exe !== "system sounds") b.addEventListener("pointerdown", (e) => startAppDrag(e, a, b));
    return b;
  }

  function trayModel() {
    const routes = settings.appRoutes || {};
    const list = trayRunning.map((a) => ({ exe: a.exe, name: a.name, pids: a.pids || [], active: !!a.active }));
    // Remembered routes whose program isn't making sound right now.
    for (const exe of Object.keys(routes)) if (!list.some((a) => a.exe === exe)) list.push({ exe, name: exeName(exe), pids: [], active: false });
    return list;
  }
  let lastTraySig = "";
  function paintTray() {
    if (!settings.appTray) return;
    const list = trayModel();
    const sig = JSON.stringify(list.map((a) => [a.exe, a.active, a.pids.length, (settings.appRoutes || {})[a.exe] || "", a.pids.length ? 1 : 0])) + chans.map((c) => displayName(c)).join("|");
    if (sig === lastTraySig) return;
    lastTraySig = sig;
    trayAppsEl.textContent = "";
    const routes = settings.appRoutes || {};
    for (const a of list) trayAppsEl.appendChild(chipFor(a, routes[a.exe] ? channelForDevice(routes[a.exe]) : null));
    trayEmpty.hidden = list.length > 0;
  }

  // The glyph indicates a routed app list without putting a count on the strip.
  const APPS_GLYPH = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 4V3a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-1"/><rect x="2" y="5" width="8" height="9" rx="1.5"/></svg>`;
  function paintStripApps() {
    if (drawerTab === "apps") paintDrawerApps();
    const routes = settings.appRoutes || {};
    const running = new Set(trayRunning.filter((a) => a.pids && a.pids.length).map((a) => a.exe));
    for (const ch of chans.filter((c) => c.kind === "strip")) {
      const box = $(".app-chips", ch.mixerEl), stack = $(".app-stack", ch.mixerEl);
      const mine = Object.keys(routes).filter((exe) => channelForDevice(routes[exe]) === ch);
      const sig = displayName(ch) + "|" + mine.map((e) => e + (running.has(e) ? "+" : "-")).join(",");
      if (box.dataset.sig === sig) continue;
      box.dataset.sig = sig;
      const focusedExe = box.contains(document.activeElement) ? document.activeElement.dataset.exe : null;
      box.textContent = ""; stack.textContent = "";
      box.setAttribute("aria-label", `Apps on ${displayName(ch)}`);
      for (const exe of mine) {
        const b = document.createElement("div");
        b.className = "sa-chip" + (running.has(exe) ? "" : " idle");
        b.style.setProperty("--hue", hueOf(exe));
        b.title = `${exeName(exe)} plays through this channel${running.has(exe) ? "" : " (not running)"}`;
        b.innerHTML = `<span class="av" aria-hidden="true"></span><span class="t"></span><button class="sa-remove" type="button">×</button>`;
        $(".av", b).textContent = initialOf(exeName(exe));
        $(".t", b).textContent = exeName(exe);
        const remove = $(".sa-remove", b);
        remove.dataset.exe = exe;
        remove.setAttribute("aria-label", `Remove ${exeName(exe)} from ${displayName(ch)}`);
        remove.title = `Return ${exeName(exe)} to the Windows default`;
        remove.addEventListener("click", () => routeApp({ exe, name: exeName(exe), pids: pidsOf(exe) }, null));
        box.appendChild(b);
      }
      stack.hidden = !mine.length;
      stack.setAttribute("aria-label", `${mine.length} ${mine.length === 1 ? "app" : "apps"} on ${displayName(ch)}`);
      stack.title = "Click to keep the app list open";
      if (mine.length) stack.innerHTML = APPS_GLYPH;
      else {
        ch.mixerEl.classList.remove("app-list-open", "apps-hover");
      }
      syncAppList(ch.mixerEl, box, stack);
      if (focusedExe) {
        const next = [...box.querySelectorAll(".sa-remove")].find((b) => b.dataset.exe === focusedExe)
          || $(".sa-remove", box) || (!stack.hidden ? stack : $(".chip", ch.mixerEl));
        next.focus();
      }
    }
  }

  function paintDrawerApps() {
    const ch = drawerCh;
    if (!ch || ch.kind !== "strip" || drawerTab !== "apps") return;
    const panel = drawerPanels.apps;
    const routes = settings.appRoutes || {};
    const apps = trayModel().filter((a) => routes[a.exe] && channelForDevice(routes[a.exe]) === ch);
    const signature = JSON.stringify([ch.key, apps.map((a) => [a.exe, a.name, a.active, !!a.pids.length])]);
    if (panel.dataset.list === signature && panel.childElementCount) return;
    panel.dataset.list = signature;
    const list = document.createElement("ul");
    list.className = "drawer-apps";
    const note = Object.assign(document.createElement("p"), { className: "hint", textContent: apps.length ? "Saved assignments for this input." : "No apps are assigned to this input." });
    for (const a of apps) {
      const item = document.createElement("li");
      const name = Object.assign(document.createElement("span"), { textContent: `${a.name} · ${a.active ? "Playing" : a.pids.length ? "Idle" : "Waiting"}` });
      const remove = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: "Remove" });
      remove.setAttribute("aria-label", `Remove ${a.name} from this input`);
      remove.addEventListener("click", () => saveAssignment(a.exe, null));
      item.append(name, remove); list.append(item);
    }
    const manage = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: "Manage app assignments…" });
    manage.addEventListener("click", () => { closeDrawer(); openAppVolumes("assignments", ch.prefix); });
    const content = document.createElement("section");
    content.append(note);
    if (apps.length) content.append(list);
    content.append(manage);
    const focused = panel.contains(document.activeElement);
    panel.replaceChildren(content);
    if (focused) manage.focus();
  }

  // Drag with the pointer (works the same in every theme, and doesn't depend on the webview's file-drop handling).
  function startAppDrag(e, a, chipEl) {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let ghost = null, lastStrip = null, mode = "none";
    const clear = () => {
      if (lastStrip) lastStrip.classList.remove("drop-ok", "drop-no");
      lastStrip = null;
      trayEl.classList.remove("drop-home");
    };
    const move = (ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        ghost = chipEl.cloneNode(true);
        ghost.classList.add("app-ghost");
        document.body.appendChild(ghost);
        document.body.classList.add("app-dragging");
      }
      ghost.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY + 8}px)`;
      clear();
      const t = document.elementFromPoint(ev.clientX, ev.clientY);
      const strip = t && t.closest ? t.closest(".strip") : null;
      const target = strip ? chans.find((c) => c.mixerEl === strip) : null;
      mode = "none";
      move.target = null;
      if (target) {
        lastStrip = strip;
        if (deviceForChannel(target)) { mode = "channel"; strip.classList.add("drop-ok"); }
        else { mode = "bad"; strip.classList.add("drop-no"); }
        move.target = target;
      } else if (t && t.closest && t.closest("#appTray")) {
        mode = "home";
        trayEl.classList.add("drop-home");
      }
    };
    const end = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", esc);
      document.body.classList.remove("app-dragging");
      if (ghost) ghost.remove();
      const target = move.target;
      clear();
      if (!ghost || ev.type === "pointercancel") return;
      if (mode === "channel") routeApp(a, target);
      else if (mode === "home") routeApp(a, null);
      else if (mode === "bad") toast(whyNot(target));
    };
    const esc = (ev) => { if (ev.key === "Escape") { mode = "none"; end({ type: "pointercancel" }); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", esc);
  }

  // Remembered routes are put back on programs that start later by Sleekmeeter's background
  // side (routing.rs), so it works with the window hidden too.

  async function pollTray() {
    if (trayBusy || SIDE || settings.mini || document.hidden) return;
    trayBusy = true;
    try {
      if (!routeDevices.length || trayPolls++ % 20 === 0) routeDevices = (await engine.appRouteDevices().catch(() => routeDevices)) || routeDevices;
      trayRunning = (await engine.appVolumes()) || [];
      paintStripApps();
      paintTray();
    } catch (_) { /* Windows audio unavailable; the tray just stays as it was */ } finally { trayBusy = false; }
  }
  function startTray() {
    if (SIDE || trayTimer) return;
    pollTray();
    trayTimer = setInterval(() => { if (settings.appTray || Object.keys(settings.appRoutes || {}).length) pollTray(); }, settings.appTray ? 1500 : 3000);
  }
  function applyTray() {
    const on = !SIDE && !!settings.appTray;
    trayEl.hidden = !on;
    const toggle = $("#appsTrayToggle");
    toggle.setAttribute("aria-pressed", String(on));
    toggle.textContent = on ? "Hide apps tray" : "Show apps tray";
    clearInterval(trayTimer); trayTimer = null;
    lastTraySig = "";
    startTray();
    if (on) paintTray();
  }
  appsBtn.addEventListener("click", () => openAppVolumes());
  $("#appsTrayToggle").addEventListener("click", () => {
    settings.appTray = !settings.appTray;
    saveSettings();
    applyTray();
    if (settings.appTray) { appsDlg.close(); $("#trayVolumes").focus(); }
  });
  $("#trayClose").addEventListener("click", () => { settings.appTray = false; saveSettings(); applyTray(); });
  $("#trayVolumes").addEventListener("click", () => openAppVolumes());

  /* ---------- settings: about and logs ---------- */
  let appInfo = null;
  async function renderAbout() {
    if (!appInfo) appInfo = await engine.appInfo().catch(() => null);
    const v = appInfo && appInfo.version;
    $("#aboutVersion").textContent = !v ? "Sleekmeeter" : v === "preview" ? "Sleekmeeter (browser preview)" : `Sleekmeeter ${v}`;
    const d = lastState;
    $("#aboutVm").textContent = d && d.connected
      ? `${EDITIONS[d.edition] || "Voicemeeter"} ${d.version || ""}`.trim()
      : d && d.installed === false ? "Voicemeeter isn't installed" : "Voicemeeter isn't running";
    $("#openLogs").hidden = !(appInfo && appInfo.logDir);
    $("#logsHint").hidden = !(appInfo && appInfo.logDir);
  }
  $("#openLogs").addEventListener("click", () => engine.openLogs().catch(fail));

  /* ---------- settings: smooth fades and talk-over ducking ---------- */
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
  const F = () => (settings.fades = Object.assign({}, DEFAULT_SETTINGS.fades, settings.fades));
  const D = () => (settings.ducking = Object.assign({}, DEFAULT_SETTINGS.ducking, settings.ducking));
  const fadeDuckRanges = [
    bindRange("setMuteMs", () => F().muteMs, (v) => { F().muteMs = v; }, fmtMs),
    bindRange("setSceneMs", () => F().sceneMs, (v) => { F().sceneMs = v; }, fmtMs),
    bindRange("duckAmount", () => D().amount, (v) => { D().amount = v; }, (v) => fmtDbShort(-v)),
    bindRange("duckThreshold", () => D().threshold, (v) => { D().threshold = v; paintDuckLevel(true); }, fmtDbShort),
    bindRange("duckHold", () => D().holdMs, (v) => { D().holdMs = v; }, fmtMs),
    bindRange("duckRelease", () => D().releaseMs, (v) => { D().releaseMs = v; }, fmtMs),
  ];
  $("#setFades").addEventListener("change", (e) => { F().on = e.target.checked; saveSettings(); syncFadeDuck(); });
  $("#setDuck").addEventListener("change", (e) => {
    const d = D();
    d.on = e.target.checked;
    // First time on: turn down the virtual inputs (desktop audio, music) by default.
    if (d.on && !(d.targets || []).length) {
      d.targets = chans.filter((c) => c.kind === "strip" && !isHw(c) && c.prefix !== d.trigger).map((c) => c.prefix);
    }
    saveSettings();
    syncFadeDuck();
  });
  $("#duckTrigger").addEventListener("change", (e) => {
    const d = D();
    d.trigger = e.target.value;
    d.also = (d.also || []).filter((t) => t !== d.trigger);
    d.targets = (d.targets || []).filter((t) => t !== d.trigger);
    saveSettings();
    syncFadeDuck();
  });
  function syncFadeDuck() {
    const f = F(), d = D();
    $("#setFades").checked = f.on !== false;
    $("#setDuck").checked = !!d.on;
    document.querySelectorAll('[data-needs="fades"]').forEach((el) => el.classList.toggle("off", f.on === false));
    $(".duck-opts").hidden = !d.on;
    const trig = $("#duckTrigger");
    trig.textContent = "";
    for (const ch of chans) if (ch.kind === "strip") trig.appendChild(new Option(displayName(ch), ch.prefix));
    trig.value = d.trigger;
    if (trig.selectedIndex < 0) { trig.selectedIndex = 0; d.trigger = trig.value; }
    const alsoList = $("#duckAlso");
    alsoList.textContent = "";
    for (const ch of chans) {
      if (ch.kind !== "strip" || ch.prefix === d.trigger) continue;
      const b = Object.assign(document.createElement("button"), { type: "button", className: "tog arm", textContent: displayName(ch) });
      b.title = `Also turn things down when ${displayName(ch)} is loud`;
      b.dataset.color = look(ch).color;
      b.setAttribute("aria-pressed", String((d.also || []).includes(ch.prefix)));
      b.addEventListener("click", () => {
        const cur = D();
        const set = new Set(cur.also || []);
        if (set.has(ch.prefix)) set.delete(ch.prefix); else set.add(ch.prefix);
        cur.also = chans.filter((c) => set.has(c.prefix)).map((c) => c.prefix);
        // A channel that triggers ducking can't also be turned down.
        cur.targets = (cur.targets || []).filter((t) => !set.has(t));
        saveSettings();
        syncFadeDuck();
      });
      alsoList.appendChild(b);
    }
    const list = $("#duckTargets");
    list.textContent = "";
    for (const ch of chans) {
      if (ch.kind !== "strip" || ch.prefix === d.trigger || (d.also || []).includes(ch.prefix)) continue;
      const b = Object.assign(document.createElement("button"), { type: "button", className: "tog arm", textContent: displayName(ch) });
      b.title = displayName(ch);
      b.dataset.color = look(ch).color;
      b.setAttribute("aria-pressed", String((d.targets || []).includes(ch.prefix)));
      b.addEventListener("click", () => {
        const on = b.getAttribute("aria-pressed") !== "true";
        b.setAttribute("aria-pressed", String(on));
        // Fetch the live settings object: D() hands back a fresh copy each call,
        // so the one captured when the list was drawn can be stale by now.
        const cur = D();
        const set = new Set(cur.targets || []);
        if (on) set.add(ch.prefix); else set.delete(ch.prefix);
        cur.targets = chans.filter((c) => set.has(c.prefix)).map((c) => c.prefix);
        saveSettings();
      });
      list.appendChild(b);
    }
    for (const r of fadeDuckRanges) r._sync();
    paintDuckLevel(true);
  }
  // The "Starts at" slider's track lights up with the talking channel's level, so you can see
  // where to put the knob. Amber once it passes the knob (ducking would start).
  let duckShown = -200, duckDrawn = "";
  function paintDuckLevel(force, lv) {
    if (!settingsDlg.open || !settings.ducking || !settings.ducking.on) return;
    const d = settings.ducking;
    let hit = -200;
    for (const k of [d.trigger, ...(d.also || [])]) { const m = /^Strip\[(\d)\]$/.exec(k || ""); const pr = lv && m ? (lv.inputs || [])[+m[1]] : null; if (pr) hit = Math.max(hit, pr[0], pr[1]); }
    const pair = hit > -200 ? [hit, hit] : null;
    if (pair) { const db = Math.max(pair[0], pair[1]); duckShown = db > duckShown ? db : Math.max(db, duckShown - 3); }
    const input = $("#duckThreshold"), min = +input.min, max = +input.max;
    const p = Math.max(0, Math.min(1, (duckShown - min) / (max - min))) * 100;
    const color = duckShown >= d.threshold ? "var(--amber)" : "var(--led-g)";
    const bg = `linear-gradient(to right, ${color} ${p.toFixed(1)}%, var(--rail) ${p.toFixed(1)}%)`;
    if (force || bg !== duckDrawn) { duckDrawn = bg; input.style.setProperty("--track-bg", bg); }
  }

  /* ---------- recorder (Banana and Potato) ---------- */
  const recBtn = $("#recBtn"), recDlg = $("#recDlg");
  let rec = null, recHoldUntil = 0, recTimer = null, recArmKey = "";
  const REC_STATES = { stopped: "Stopped", recording: "Recording", playing: "Playing", paused: "Paused" };
  const recRunning = () => rec && (rec.state === "recording" || (rec.state === "playing" && !rec.external));
  function recClock() {
    if (!rec) return "00:00";
    const ms = (rec.elapsed || 0) + (rec.since && recRunning() ? Math.max(0, Date.now() - rec.since) : 0);
    const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    const two = (n) => String(n).padStart(2, "0");
    return (h ? `${h}:${two(m)}` : two(m)) + ":" + two(sec);
  }
  function applyRecorder(r) {
    if (!r) {
      rec = null;
      recBtn.hidden = true;
      paintStreamToolbar();
      if (recDlg.open) recDlg.close();
      return;
    }
    // Right after a button press the snapshot can be a moment behind: keep what the press said.
    if (rec && performance.now() < recHoldUntil) r = Object.assign({}, r, { state: rec.state, elapsed: rec.elapsed, since: rec.since });
    rec = r;
    recBtn.hidden = PANEL;
    paintRecorder();
  }
  function paintRecorder() {
    if (!rec) return;
    // Playback started outside Sleekmeeter (a macro button's sound, Voicemeeter's window):
    // Voicemeeter keeps calling it playing after the file ends, so don't run a clock for it.
    const state = rec.state === "playing" && rec.external ? "stopped" : rec.state || "stopped";
    recBtn.dataset.state = state;
    $("#recLabel").textContent = state === "stopped" ? "" : state === "paused" ? "Paused" : recClock();
    recBtn.title = state === "stopped" ? "Recorder" : `Recorder: ${REC_STATES[state].toLowerCase()}`;
    paintStreamToolbar();
    clearInterval(recTimer);
    if (recRunning()) recTimer = setInterval(tickRecClock, 250);
    if (!recDlg.open) return;
    recDlg.dataset.state = state;
    $("#recClock").textContent = recClock();
    $("#recState").textContent = REC_STATES[state] || "Stopped";
    recDlg.querySelectorAll("[data-rec]").forEach((b) => {
      const a = b.dataset.rec;
      const on = (a === "record" && state === "recording") || (a === "play" && state === "playing") || (a === "pause" && state === "paused");
      b.setAttribute("aria-pressed", String(on));
    });
    $("#recFromIn").setAttribute("aria-pressed", String(!rec.recBus));
    $("#recFromOut").setAttribute("aria-pressed", String(!!rec.recBus));
    // What to record: inputs or outputs, each one a key that lights up when armed.
    const kind = rec.recBus ? "bus" : "strip";
    const armed = (rec.recBus ? rec.armBuses : rec.armStrips) || [];
    const key = kind + chans.map((c) => displayName(c)).join("|");
    const list = $("#armList");
    if (key !== recArmKey) {
      recArmKey = key;
      list.textContent = "";
      for (const ch of chans) {
        if (ch.kind !== kind) continue;
        const b = Object.assign(document.createElement("button"), { type: "button", className: "tog arm", textContent: kind === "bus" ? ch.info.id : displayName(ch) });
        b.title = displayName(ch);
        b.dataset.i = ch.i;
        if (kind === "bus") b.textContent = `${ch.info.id} · ${displayName(ch)}`;
        b.addEventListener("click", () => {
          const on = b.getAttribute("aria-pressed") !== "true";
          b.setAttribute("aria-pressed", String(on));
          const name = rec.recBus ? `Recorder.ArmBus[${ch.i}]` : `Recorder.ArmStrip[${ch.i}]`;
          (rec.recBus ? rec.armBuses : rec.armStrips)[ch.i] = on;
          recHoldUntil = performance.now() + 600;
          sendFloat(name, on ? 1 : 0);
        });
        list.appendChild(b);
      }
    }
    list.querySelectorAll(".arm").forEach((b) => b.setAttribute("aria-pressed", String(!!armed[+b.dataset.i])));
    const fmt = $("#recFormat");
    if (rec.fileType != null && document.activeElement !== fmt) fmt.value = String(rec.fileType);
    // MP3 is always made from 16-bit audio (see setRecFormat); bit depth is for the other formats.
    $("#recBitsRow").hidden = rec.fileType === 100;
    const bits = $("#recBits");
    if (rec.bits != null && document.activeElement !== bits && rec.fileType !== 100) bits.value = String(rec.bits);
    // Which outputs the player plays into.
    const out = $("#recOut");
    if (out.childElementCount !== layout.buses.length) {
      out.textContent = "";
      out.style.gridTemplateColumns = `repeat(${layout.buses.length}, minmax(0, 1fr))`;
      let firstB = true;
      for (const bus of layout.buses) {
        const b = Object.assign(document.createElement("button"), { type: "button", className: `route ${bus.kind === "hw" ? "a" : "b"}`, textContent: bus.id });
        if (bus.kind === "virt" && firstB) { b.classList.add("first-b"); firstB = false; }
        b.title = `Play into ${bus.id}`;
        b.dataset.param = bus.param;
        b.addEventListener("click", () => {
          const on = b.getAttribute("aria-pressed") !== "true";
          b.setAttribute("aria-pressed", String(on));
          const [k, n] = [bus.param[0].toLowerCase(), +bus.param.slice(1) - 1];
          if (rec[k]) rec[k][n] = on;
          recHoldUntil = performance.now() + 600;
          sendFloat(`Recorder.${bus.param}`, on ? 1 : 0);
        });
        out.appendChild(b);
      }
    }
    out.querySelectorAll(".route").forEach((b) => {
      const p = b.dataset.param, list2 = rec[p[0].toLowerCase()] || [];
      b.setAttribute("aria-pressed", String(!!list2[+p.slice(1) - 1]));
    });
    const g = $("#recGain");
    if (rec.gain != null && document.activeElement !== g) { g.value = rec.gain; paintRecGain(); }
    fillRecChoices();
    const setSel = (id, v) => { const el = $(id); if (v != null && document.activeElement !== el) el.value = String(v); if (id !== "#recKbps") el.closest(".field").hidden = v == null; };
    setSel("#recChannels", rec.channel); setSel("#recRate", rec.sampleRate); setSel("#recKbps", rec.kbps);
    $("#recKbpsRow").hidden = rec.fileType !== 100 || rec.kbps == null;
    for (const [id, v] of [["#recMulti", rec.multiTrack], ["#recLoop", rec.loop], ["#recPlayOnLoad", rec.playOnLoad]]) {
      const el = $(id);
      el.closest("label").hidden = v == null;
      if (v != null && document.activeElement !== el) el.checked = !!v;
    }
  }
  let recChoicesDone = false;
  function fillRecChoices() {
    if (recChoicesDone) return;
    recChoicesDone = true;
    const names = { 1: "Mono", 2: "Stereo", 6: "5.1 surround (6)", 8: "7.1 surround (8)" };
    for (let n = 1; n <= 8; n++) $("#recChannels").appendChild(new Option(names[n] || `${n} channels`, n));
    for (const r of [22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000]) $("#recRate").appendChild(new Option(`${r / 1000} kHz`, r));
    for (const k of [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]) $("#recKbps").appendChild(new Option(`${k} kbps`, k));
  }
  const recSet = (name, v, key) => { if (rec) rec[key] = v; recHoldUntil = performance.now() + 600; sendFloat(name, v); };
  $("#recChannels").addEventListener("change", (e) => recSet("Recorder.Channel", +e.target.value, "channel"));
  $("#recRate").addEventListener("change", (e) => recSet("Recorder.samplerate", +e.target.value, "sampleRate"));
  $("#recKbps").addEventListener("change", (e) => recSet("Recorder.kbps", +e.target.value, "kbps"));
  $("#recMulti").addEventListener("change", (e) => recSet("Recorder.mode.MultiTrack", e.target.checked ? 1 : 0, "multiTrack"));
  $("#recLoop").addEventListener("change", (e) => recSet("Recorder.mode.Loop", e.target.checked ? 1 : 0, "loop"));
  $("#recPlayOnLoad").addEventListener("change", (e) => recSet("Recorder.mode.PlayOnLoad", e.target.checked ? 1 : 0, "playOnLoad"));
  // "1:30", "90" or "0:01:30" all work.
  function parseTime(text) {
    const t = text.trim();
    if (/^\d+$/.test(t)) { const n = +t; return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60]; }
    const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(t);
    return m ? [+(m[1] || 0), +m[2], +m[3]] : null;
  }
  async function recGoto() {
    const p = parseTime($("#recGoto").value);
    if (!p) { toast("Type a time like 1:30 or 0:01:30"); return; }
    const hms = p.map((n) => String(n).padStart(2, "0")).join(":");
    try { await engine.setString("Recorder.goto", hms); toast(`Jumped to ${hms}`); } catch (e) { fail(e); }
  }
  $("#recGotoBtn").addEventListener("click", recGoto);
  $("#recGoto").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); recGoto(); } });
  // How loud the recording is: the channels being recorded, added together (the recorder mixes
  // them into one file). Over 0 dB the file distorts, so that gets a warning that stays a few seconds.
  let recLevel = -200, recOverAt = -1e9, recLevelDrawn = -1, recWarnText = null;
  function paintRecLevel(lv) {
    if (!rec) return;
    const armed = (rec.recBus ? rec.armBuses : rec.armStrips) || [];
    const list = (rec.recBus ? lv.outputs : lv.inputs) || [];
    let power = 0, count = 0;
    armed.forEach((on, i) => {
      if (!on || !list[i]) return;
      count++;
      const db = Math.max(list[i][0], list[i][1]);
      if (db > -150) power += Math.pow(10, db / 10);
    });
    const db = power > 0 ? 10 * Math.log10(power) : -200;
    recLevel = db > recLevel ? db : Math.max(db, recLevel - 1.5);
    const now = performance.now();
    if (db > -0.3) recOverAt = now;
    const p = dbToPos(recLevel);
    if (Math.abs(p - recLevelDrawn) > 0.002) {
      recLevelDrawn = p;
      const off = ((1 - p) * 100).toFixed(2);
      $("#recMeter .lit").style.transform = `translateX(-${off}%)`;
      $("#recMeter .lit b").style.transform = `translateX(${off}%)`;
      $("#recLevelDb").textContent = recLevel <= MIN_DB ? "−∞" : fmtDb(recLevel);
    }
    let warn = "";
    if (!count) warn = `Nothing is selected to record. Pick the ${rec.recBus ? "outputs" : "inputs"} to record below.`;
    else if (now - recOverAt < 3000) warn = "Too loud: this goes over 0 dB, so the recording will distort. Turn down what you're recording"
      + (count > 1 ? `, or record fewer channels (the ${count} you picked are added together).` : ".");
    if (warn !== recWarnText) {
      recWarnText = warn;
      const el = $("#recWarn");
      el.textContent = warn;
      el.classList.toggle("over", warn.startsWith("Too loud"));
      $(".rec-level").classList.toggle("over", warn.startsWith("Too loud"));
    }
  }
  function tickRecClock() {
    if (!recRunning()) { clearInterval(recTimer); return; }
    const t = recClock();
    $("#recLabel").textContent = t;
    if (recDlg.open) $("#recClock").textContent = t;
  }
  function paintRecGain() {
    const g = $("#recGain"), v = +g.value;
    $("#recGainOut").textContent = fmtDb(v);
    const p = dbToPos(v) * 100;
    g.style.setProperty("--track-bg", `linear-gradient(to right, var(--amber) ${p}%, var(--rail) ${p}%)`);
  }
  recBtn.addEventListener("click", () => { recArmKey = ""; recDlg.showModal(); paintRecorder(); });
  recDlg.addEventListener("click", (e) => { if (e.target === recDlg) recDlg.close(); });
  recDlg.querySelectorAll("[data-rec]").forEach((b) => b.addEventListener("click", async () => {
    try {
      // Recording MP3 at a higher bit depth distorts: put it right first.
      if (b.dataset.rec === "record" && rec && rec.fileType === MP3 && rec.bits !== 16) {
        await engine.setFloat("Recorder.bitResolution", 16);
        rec.bits = 16;
      }
      const v = await engine.recorder(b.dataset.rec);
      if (rec && v) { Object.assign(rec, v); recHoldUntil = performance.now() + 900; paintRecorder(); }
    } catch (e) { fail(e); }
  }));
  for (const [id, bus] of [["#recFromIn", false], ["#recFromOut", true]]) {
    $(id).addEventListener("click", () => {
      if (!rec || !!rec.recBus === bus) return;
      rec.recBus = bus;
      recHoldUntil = performance.now() + 600;
      sendFloat("Recorder.mode.recbus", bus ? 1 : 0);
      paintRecorder();
    });
  }
  // Voicemeeter's MP3 encoder reads its audio as 16-bit: at 24 or 32-bit it comes out about
  // 48 dB too loud and badly distorted. So MP3 always records at 16-bit, and the other formats
  // go back to the bit depth picked for them.
  const MP3 = 100;
  function recBitsFor(type) { return type === MP3 ? 16 : +(settings.recorderBits || 24); }
  async function setRecFormat(type) {
    if (!rec) return;
    rec.fileType = type;
    rec.bits = recBitsFor(type);
    recHoldUntil = performance.now() + 600;
    try {
      await engine.setFloat("Recorder.bitResolution", rec.bits);
      await engine.setFloat("Recorder.FileType", type);
    } catch (e) { fail(e); }
    paintRecorder();
  }
  $("#recFormat").addEventListener("change", (e) => setRecFormat(+e.target.value));
  $("#recBits").addEventListener("change", (e) => {
    settings.recorderBits = +e.target.value;
    saveSettings();
    setRecFormat(rec ? rec.fileType : 1);
  });
  $("#recGain").addEventListener("input", (e) => { if (rec) rec.gain = +e.target.value; paintRecGain(); sendFloat("Recorder.gain", +e.target.value); });
  $("#recGain").addEventListener("dblclick", (e) => { e.target.value = 0; if (rec) rec.gain = 0; paintRecGain(); sendFloat("Recorder.gain", 0); });
  function loadedFile(name) {
    if (!name) return;
    const el = $("#recFile");
    el.textContent = name; el.title = name; el.classList.add("loaded");
    toast(`Loaded “${name}”. Press play to hear it.`);
  }
  $("#recOpen").addEventListener("click", () => engine.recorderOpen().then(loadedFile).catch(fail));
  const AUDIO_FILE = /\.(wav|mp3|aiff?|wma|m4a|flac|ogg|bwf)$/i;
  function onFilesDropped(paths) {
    if (!rec || SIDE) return;
    const file = paths.find((p) => AUDIO_FILE.test(p));
    if (!file) { if (paths.length) toast("Drop an audio file (WAV, MP3, AIFF…) to play it"); return; }
    engine.recorderLoad(file).then((name) => {
      if (!recDlg.open) { recArmKey = ""; recDlg.showModal(); paintRecorder(); }
      loadedFile(name);
    }).catch(fail);
  }

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  /* ---------- tray volume panel ---------- */
  $("#openMixerBtn").addEventListener("click", () => engine.openMixer().catch(fail));
  $("#closePanelBtn").addEventListener("click", () => engine.closePanel().catch(fail));
  // Ask the panel window to be exactly as tall as its content.
  // Height the mini list needs to show every channel with no scroll bar.
  function miniHeight() {
    const view = $("#miniView");
    const cs = getComputedStyle(view);
    const lists = [...view.children].filter((el) => el.offsetHeight > 0);
    // Rows stack the inputs and outputs; the panel's column layout puts them side by side.
    const across = getComputedStyle(view).flexDirection === "row";
    const content = (across
      ? Math.max(0, ...lists.map((el) => el.offsetHeight))
      : lists.reduce((h, el) => h + el.offsetHeight, 0) + Math.max(0, lists.length - 1) * parseFloat(cs.rowGap || cs.gap || 0))
      + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const border = parseFloat(getComputedStyle(document.body).borderTopWidth) * 2;
    return { h: Math.ceil($(".bar").offsetHeight + content + border), border };
  }
  function fitPanel() {
    const { h, border } = miniHeight();
    const zoom = (+settings.panelScale || 100) / 100;
    const view = $("#miniView");
    const width = settings.panelLayout === "columns"
      ? Math.max(view.scrollWidth, $(".bar").scrollWidth) + border
      : miniWidth() + border;
    engine.fitPanel(Math.ceil(h * zoom), Math.ceil(width * zoom)).catch(() => {});
  }
  // Settings → Tray volume panel: size, opacity and what the panel shows.
  let panelLayoutBuilt = null;
  function applyPanelOptions() {
    if (!PANEL) return;
    const layout = settings.panelLayout === "columns" ? "columns" : "rows";
    // The faders are built for one layout, so switching layout reloads the panel.
    if (panelLayoutBuilt && panelLayoutBuilt !== layout) { location.reload(); return; }
    panelLayoutBuilt = layout;
    const b = document.body;
    b.classList.toggle("panel-columns", layout === "columns");
    b.classList.toggle("panel-no-icons", settings.panelIcons === false);
    b.classList.toggle("panel-no-mute", settings.panelMute === false);
    b.classList.toggle("panel-no-meters", settings.panelMeters === false);
    b.style.setProperty("--panel-opacity", String(Math.min(100, Math.max(30, +settings.panelOpacity || 100)) / 100));
    document.documentElement.style.zoom = String((+settings.panelScale || 100) / 100);
    requestAnimationFrame(fitPanel);
  }
  // Mini mode in the main window: size it to the channels, so it never needs a scroll bar and
  // switching to and from the full mixer is seamless. Redone whenever the channels change.
  function syncMiniWindow(on) {
    if (SIDE) return;
    const send = () => engine.windowMini(on, miniRows(), miniWidth(), on ? miniHeight().h : undefined).catch(() => {});
    if (on) requestAnimationFrame(send); else send();
  }
  // The tray panel: docked to the corner by default; undocked, the header drags it.
  const dockBtn = $("#dockBtn");
  function applyPanelDock() {
    if (!PANEL) return;
    const docked = settings.panelDocked !== false;
    dockBtn.setAttribute("aria-pressed", String(docked));
    dockBtn.title = docked ? "Docked to the corner. Click to undock and move it" : "Click to dock it to the corner";
    dockBtn.setAttribute("aria-label", docked ? "Docked to the corner" : "Undocked");
    document.querySelectorAll(".bar, .bar .brand, .bar .brand *, .bar .status, .bar .status *, .bar .spacer").forEach((el) => {
      if (docked) el.removeAttribute("data-tauri-drag-region"); else el.setAttribute("data-tauri-drag-region", "");
    });
    document.body.classList.toggle("undocked", !docked);
  }
  dockBtn.addEventListener("click", () => {
    settings.panelDocked = settings.panelDocked === false;
    applyPanelDock();
    engine.panelDock(settings.panelDocked).catch(fail);
  });
  async function loadSettings() {
    try {
      const s = await engine.getSettings();
      settings = Object.assign(clone(DEFAULT_SETTINGS), s || {});
      // The theme an app rule asked for is transient: never part of the saved settings.
      autoTheme = settings.autoTheme || "";
      delete settings.autoTheme;
    } catch (e) { /* keep defaults */ }
  }


  /* ---------- stream mode: Be right back ---------- */
  const brbBtn = $("#brbBtn");
  const B = () => (settings.brb = Object.assign({}, DEFAULT_SETTINGS.brb, settings.brb));
  brbBtn.addEventListener("click", () => engine.brbToggle().catch(fail));
  function applyBrb(st) {
    const on = !!st.brb;
    brbBtn.setAttribute("aria-pressed", String(on));
    brbBtn.setAttribute("aria-label", on ? "Back live" : "Be right back");
  }
  const brbRanges = [
    bindRange("brbAmount", () => B().amount, (v) => { B().amount = v; }, (v) => fmtDbShort(-v)),
    bindRange("brbPlayDb", () => B().playDb, (v) => { B().playDb = v; }, fmtDbShort),
  ];
  // A row of channel keys you can switch on and off (like the ducking list).
  function channelKeys(listEl, field) {
    listEl.textContent = "";
    const b = B();
    for (const ch of chans) {
      if (ch.kind !== "strip") continue;
      const btn = Object.assign(document.createElement("button"), { type: "button", className: "tog arm", textContent: displayName(ch) });
      btn.title = displayName(ch);
      btn.dataset.color = look(ch).color;
      btn.setAttribute("aria-pressed", String((b[field] || []).includes(ch.prefix)));
      btn.addEventListener("click", () => {
        const on = btn.getAttribute("aria-pressed") !== "true";
        btn.setAttribute("aria-pressed", String(on));
        const set = new Set(B()[field] || []);
        if (on) set.add(ch.prefix); else set.delete(ch.prefix);
        B()[field] = chans.filter((c) => set.has(c.prefix)).map((c) => c.prefix);
        saveSettings();
      });
      listEl.appendChild(btn);
    }
  }
  function syncBrb() {
    const b = B();
    channelKeys($("#brbMute"), "mute");
    channelKeys($("#brbLower"), "lower");
    const play = $("#brbPlay");
    play.textContent = "";
    play.appendChild(new Option("Nothing", ""));
    for (const ch of chans) if (ch.kind === "strip") play.appendChild(new Option(displayName(ch), ch.prefix));
    play.value = b.play || "";
    if (play.selectedIndex < 0) { play.value = ""; b.play = ""; }
    document.querySelector('[data-needs="brbplay"]').classList.toggle("off", !b.play);
    $("#brbOverlay").checked = b.overlay !== false;
    for (const r of brbRanges) r._sync();
  }
  $("#brbPlay").addEventListener("change", (e) => { B().play = e.target.value; saveSettings(); syncBrb(); });
  $("#brbOverlay").addEventListener("change", (e) => { B().overlay = e.target.checked; saveSettings(); });

  /* ---------- OBS Studio link ---------- */
  const OB = () => (settings.obs = Object.assign({}, DEFAULT_SETTINGS.obs, settings.obs));
  const OBS_DO = [["scene", "Load a scene"], ["brb-on", "Start Be right back"], ["brb-off", "End Be right back"]];
  let obsState = null, obsScenesKey = "";
  function applyObs(st) {
    obsState = st || null;
    const connected = !!(st && st.connected);
    $("#liveTag").hidden = PANEL || !(connected && st.live);
    obsRecording = connected && !!st.recording;
    paintStreamToolbar();
    const note = $("#obsNote");
    note.textContent = !OB().on ? "" : connected ? "Connected" : "Not connected";
    note.dataset.ok = connected ? "1" : "";
    const text = $("#obsStatusText");
    text.textContent = st && st.message ? st.message : "";
    text.dataset.ok = connected ? "1" : "";
    const key = ((st && st.scenes) || []).join("\n");
    if (key !== obsScenesKey) {
      obsScenesKey = key;
      const dl = $("#obsSceneList");
      dl.textContent = "";
      for (const n of (st && st.scenes) || []) dl.appendChild(new Option(n));
    }
  }
  const doSelect = (value, withNothing, onChange, label) => {
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", label);
    if (withNothing) sel.appendChild(new Option("Do nothing", ""));
    for (const [v, l] of OBS_DO) sel.appendChild(new Option(l, v));
    sel.value = value || (withNothing ? "" : "scene");
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  };
  const sceneSelect = (names, value, onChange, label) => {
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", label);
    for (const n of names) sel.appendChild(new Option(n, n));
    if (value && !names.includes(value)) sel.appendChild(new Option(`${value} (deleted)`, value));
    sel.value = value || names[0] || "";
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  };
  async function syncObs() {
    const o = OB();
    $("#obsOn").checked = !!o.on;
    $("#obsOpts").hidden = !o.on;
    $("#obsHost").value = o.host || "";
    $("#obsPort").value = o.port || 4455;
    $("#obsPass").value = o.password || "";
    applyObs(obsState);
    const names = await engine.listScenes().catch(() => []);
    const list = $("#obsRules");
    list.textContent = "";
    const rules = o.rules || (o.rules = []);
    $("#obsHead").hidden = rules.length === 0;
    rules.forEach((r, idx) => {
      const row = document.createElement("div");
      row.className = "rule";
      const obs = document.createElement("input");
      obs.type = "text"; obs.value = r.obs || ""; obs.placeholder = "OBS scene, e.g. BRB";
      obs.setAttribute("list", "obsSceneList"); obs.setAttribute("aria-label", "OBS scene");
      obs.spellcheck = false; obs.autocomplete = "off";
      obs.addEventListener("change", () => { r.obs = obs.value.trim(); saveSettings(); });
      const what = doSelect(r.do, false, (v) => { r.do = v; saveSettings(); syncObs(); }, "What to do");
      r.do = r.do || "scene";
      const scene = sceneSelect(names, r.scene, (v) => { r.scene = v; saveSettings(); }, "Scene to load");
      if (r.do === "scene" && !r.scene && names.length) { r.scene = names[0]; saveSettings(); }
      scene.style.visibility = r.do === "scene" ? "visible" : "hidden";
      const del = document.createElement("button");
      del.type = "button"; del.className = "btn icon"; del.setAttribute("aria-label", "Remove rule");
      del.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
      del.addEventListener("click", () => { rules.splice(idx, 1); saveSettings(); syncObs(); });
      row.append(obs, what, scene, del);
      list.appendChild(row);
    });
    // When I go live / when the stream ends
    const fill = (selDo, selScene, doKey, sceneKey) => {
      const d = $("#" + selDo), s = $("#" + selScene);
      d.textContent = "";
      d.appendChild(new Option("Do nothing", ""));
      for (const [v, l] of OBS_DO) d.appendChild(new Option(l, v));
      d.value = o[doKey] || "";
      s.textContent = "";
      for (const n of names) s.appendChild(new Option(n, n));
      if (o[sceneKey] && !names.includes(o[sceneKey])) s.appendChild(new Option(`${o[sceneKey]} (deleted)`, o[sceneKey]));
      s.value = o[sceneKey] || names[0] || "";
      s.style.visibility = d.value === "scene" ? "visible" : "hidden";
      d.onchange = () => { o[doKey] = d.value; if (d.value === "scene" && !o[sceneKey]) o[sceneKey] = s.value; saveSettings(); s.style.visibility = d.value === "scene" ? "visible" : "hidden"; };
      s.onchange = () => { o[sceneKey] = s.value; saveSettings(); };
    };
    fill("obsLiveDo", "obsLiveScene", "liveDo", "liveScene");
    fill("obsOffDo", "obsOffScene", "offDo", "offScene");
  }
  $("#obsOn").addEventListener("change", (e) => { OB().on = e.target.checked; saveSettings(); syncObs(); });
  $("#obsHost").addEventListener("change", (e) => { OB().host = e.target.value.trim() || "127.0.0.1"; saveSettings(); });
  $("#obsPort").addEventListener("change", (e) => { OB().port = Math.max(1, Math.min(65535, +e.target.value || 4455)); e.target.value = OB().port; saveSettings(); });
  $("#obsPass").addEventListener("change", (e) => { OB().password = e.target.value; saveSettings(); });
  $("#addObsRule").addEventListener("click", async () => {
    OB().rules.push({ obs: "", do: "scene", scene: "" });
    await syncObs();
    const inputs = document.querySelectorAll("#obsRules input");
    if (inputs.length) inputs[inputs.length - 1].focus();
  });


  /* ---------- soundboard ---------- */
  const SB = () => (settings.soundboard = Object.assign({}, DEFAULT_SETTINGS.soundboard, settings.soundboard));
  const soundsDlg = $("#soundsDlg");
  let soundEdit = false;
  const soundRange = bindRange("soundVolume", () => SB().volume, (v) => { SB().volume = v; }, (v) => v + "%");
  let soundTab = "";
  const soundHotkey = (s) => (settings.hotkeys || []).find((h) => h.action === "sound" && h.target === s.name);
  function renderSounds() {
    const grid = $("#soundGrid");
    grid.textContent = "";
    const list = SB().sounds || (SB().sounds = []);
    $("#soundsEmpty").hidden = list.length > 0;
    // Groups: a sound's `tab` is any name you like. The bar shows once there is at least one.
    const tabs = [...new Set(list.map((s) => (s.tab || "").trim()).filter(Boolean))];
    if (soundTab && !tabs.includes(soundTab)) soundTab = "";
    const bar = $("#soundTabs");
    bar.hidden = !tabs.length;
    bar.textContent = "";
    for (const t of ["", ...tabs]) {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "sound-tab", textContent: t || "All" });
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(t === soundTab));
      b.addEventListener("click", () => { soundTab = t; renderSounds(); });
      bar.appendChild(b);
    }
    const dl = $("#soundTabList");
    dl.textContent = "";
    for (const t of tabs) dl.appendChild(new Option(t));
    list.forEach((s, idx) => {
      if (soundTab && (s.tab || "").trim() !== soundTab) return;
      const tile = document.createElement("div");
      tile.className = "sound-tile";
      tile.dataset.n = String(idx % 6);
      const play = document.createElement("button");
      play.type = "button"; play.className = "sound-play";
      play.textContent = (s.folder ? "🎲 " : "") + s.name;
      play.title = s.folder ? `A random sound from ${s.folder}` : s.path;
      const hk = soundHotkey(s);
      if (hk && hk.keys) { const k = document.createElement("small"); k.className = "sound-key"; k.textContent = hk.keys; play.appendChild(k); }
      play.addEventListener("click", () => {
        if (soundEdit) return;
        tile.classList.add("hit"); setTimeout(() => tile.classList.remove("hit"), 350);
        engine.soundPlay(s.name).catch(fail);
      });
      tile.appendChild(play);
      if (soundEdit) {
        const del = document.createElement("button");
        del.type = "button"; del.className = "sound-del"; del.setAttribute("aria-label", `Remove ${s.name}`);
        del.innerHTML = `<svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
        del.addEventListener("click", () => {
          list.splice(idx, 1);
          settings.hotkeys = (settings.hotkeys || []).filter((h) => !(h.action === "sound" && h.target === s.name));
          saveSettings(); renderSounds();
        });
        const name = document.createElement("input");
        name.type = "text"; name.className = "sound-name"; name.value = s.name; name.maxLength = 30; name.setAttribute("aria-label", "Sound name");
        name.addEventListener("change", () => {
          const n = name.value.trim().replace(/\s+/g, " ");
          if (!n || list.some((o, i) => i !== idx && o.name.toLowerCase() === n.toLowerCase())) { name.value = s.name; return; }
          const h = soundHotkey(s);
          if (h) h.target = n;
          s.name = n; saveSettings();
        });
        play.replaceWith(name);
        tile.appendChild(del);
        const extra = document.createElement("div");
        extra.className = "sound-extra";
        const tab = document.createElement("input");
        tab.type = "text"; tab.className = "sound-tabname"; tab.value = s.tab || ""; tab.maxLength = 16; tab.placeholder = "Group"; tab.setAttribute("list", "soundTabList"); tab.setAttribute("aria-label", "Group");
        tab.addEventListener("change", () => { s.tab = tab.value.trim(); saveSettings(); });
        tab.addEventListener("blur", () => renderSounds());
        const key = document.createElement("button");
        key.type = "button"; key.className = "keys" + (hk && hk.keys ? "" : " empty");
        key.textContent = hk && hk.keys ? hk.keys : "Key";
        key.title = "A shortcut that plays this sound from anywhere";
        key.addEventListener("click", () => {
          let h = soundHotkey(s);
          if (!h) { h = { keys: "", action: "sound", target: s.name }; settings.hotkeys = settings.hotkeys || []; settings.hotkeys.push(h); }
          recordKeys(key, h);
        });
        extra.append(tab, key);
        tile.appendChild(extra);
      }
      grid.appendChild(tile);
    });
  }
  async function fillSoundDevices() {
    const sel = $("#soundDevice");
    let info = { devices: [], auto: "" };
    try { info = await engine.soundDevices(); } catch (e) { fail(e); }
    sel.textContent = "";
    sel.appendChild(new Option(info.auto ? `Automatic (${info.auto})` : "Automatic (the Windows default)", ""));
    for (const d of info.devices) sel.appendChild(new Option(d, d));
    const cur = SB().device || "";
    if (cur && !info.devices.includes(cur)) sel.appendChild(new Option(`${cur} (not found)`, cur));
    sel.value = cur;
  }
  $("#soundDevice").addEventListener("change", (e) => { SB().device = e.target.value; saveSettings(); });
  $("#soundsBtn").addEventListener("click", () => {
    soundEdit = false;
    $("#soundEdit").setAttribute("aria-pressed", "false");
    renderSounds(); soundRange._sync(); fillSoundDevices();
    soundsDlg.showModal();
  });
  // Add any number of sound files (new ones only), each named after its file.
  async function addSounds(picked) {
    // Copy into Sleekmeeter's own folder first, so the originals can be moved or deleted.
    let paths = picked || [];
    if (paths.length) { try { paths = await engine.soundImport(paths); } catch (e) { fail(e); return; } }
    const list = SB().sounds || (SB().sounds = []);
    const have = new Set(list.map((s) => s.path.toLowerCase()));
    let added = 0;
    for (const path of paths || []) {
      if (have.has(path.toLowerCase())) continue;
      have.add(path.toLowerCase());
      const base = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim().slice(0, 30) || "Sound";
      let name = base, n = 2;
      while (list.some((s) => s.name.toLowerCase() === name.toLowerCase())) name = `${base} ${n++}`;
      list.push(soundTab ? { name, path, volume: 100, tab: soundTab } : { name, path, volume: 100 });
      added++;
    }
    if (!added) { toast(picked && picked.length ? "Those sounds are already on the board" : "No sounds found"); return; }
    await saveNow();
    renderSounds();
    toast(added === 1 ? `Added “${list[list.length - 1].name}”` : `Added ${added} sounds`);
  }
  $("#soundAdd").addEventListener("click", async () => {
    try { await addSounds(await engine.soundPick()); } catch (e) { fail(e); }
  });
  $("#soundAddFolder").addEventListener("click", async () => {
    try { await addSounds(await engine.soundPickFolder()); } catch (e) { fail(e); }
  });
  $("#soundAddPack").addEventListener("click", async () => {
    try {
      const r = await engine.soundPickPack();
      if (!r || !r.folder) return;
      if (!r.count) { toast("No sounds found in that folder"); return; }
      const list = SB().sounds || (SB().sounds = []);
      if (list.some((s) => s.folder && s.folder.toLowerCase() === r.folder.toLowerCase())) { toast("That folder is already a pack"); return; }
      const base = (r.folder.split(/[\\/]/).filter(Boolean).pop() || "Pack").replace(/[-_]+/g, " ").trim().slice(0, 26) || "Pack";
      let name = base, n = 2;
      while (list.some((s) => s.name.toLowerCase() === name.toLowerCase())) name = `${base} ${n++}`;
      list.push(Object.assign({ name, path: "", folder: r.folder, volume: 100 }, soundTab ? { tab: soundTab } : {}));
      await saveNow();
      renderSounds();
      toast(`Added “${name}”: plays one of ${r.count} sounds at random`);
    } catch (e) { fail(e); }
  });
  $("#soundStop").addEventListener("click", () => engine.soundStop().catch(fail));
  $("#soundEdit").addEventListener("click", (e) => {
    soundEdit = !soundEdit;
    e.currentTarget.setAttribute("aria-pressed", String(soundEdit));
    renderSounds();
  });
  soundsDlg.addEventListener("click", (e) => { if (e.target === soundsDlg) soundsDlg.close(); });

  /* ---------- Twitch chat commands ---------- */
  const TW = () => (settings.twitch = Object.assign({}, DEFAULT_SETTINGS.twitch, settings.twitch));
  const TW_ACTIONS = [["brb", "Be right back on or off"], ["scene", "Load a scene"], ["sound", "Play a sound"], ["soundstop", "Stop all sounds"],
    ["mute", "Mute or unmute"], ["output", "Switch to an output profile"], ["outputnext", "Next output profile"],
    ["duck", "Talk-over ducking on or off"], ["record", "Start or stop recording"],
    ["replay", "Save an instant replay"], ["musicguard", "Music off stream on or off"],
    ["micfx", "Mic clean-up on or off"]];
  const TW_NO_TARGET = new Set(["brb", "soundstop", "outputnext", "duck", "record", "replay", "musicguard"]);
  let twitchState = null;
  function applyTwitch(st) {
    twitchState = st || null;
    const on = !!(st && st.connected);
    const note = $("#twitchNote");
    note.textContent = !TW().on ? "" : on ? "In chat" : "Not connected";
    note.dataset.ok = on ? "1" : "";
    const text = $("#twitchStatusText");
    text.textContent = st ? [st.message, st.last ? `Last: ${st.last}` : ""].filter(Boolean).join(". ") : "";
    text.dataset.ok = on ? "1" : "";
  }
  const twRange = bindRange("twitchCooldown", () => TW().cooldown, (v) => { TW().cooldown = v; }, (v) => (v ? `${v} s` : "none"));
  function twTarget(sel, cmd, typed = "What's typed after it") {
    sel.textContent = "";
    const none = TW_NO_TARGET.has(cmd.action);
    sel.style.visibility = none ? "hidden" : "visible";
    if (none) { cmd.target = ""; return; }
    sel.setAttribute("aria-label", "On");
    if (cmd.action === "scene" || cmd.action === "sound") sel.appendChild(new Option(typed, ""));
    const names = cmd.action === "mute" ? chans.map((ch) => [displayName(ch), ch.prefix])
      : cmd.action === "micfx" ? micTargets() : namesFor(cmd.action).map((n) => [n, n]);
    for (const [label, value] of names) sel.appendChild(new Option(label, value));
    if (cmd.action === "mute" && !/^(Strip|Bus)\[/.test(cmd.target || "")) cmd.target = "Strip[0]";
    if (cmd.target && ![...sel.options].some((o) => o.value === cmd.target)) sel.appendChild(new Option(`${cmd.target} (gone)`, cmd.target));
    sel.value = cmd.target || (sel.options[0] ? sel.options[0].value : "");
    if ((cmd.action === "output") && !cmd.target && sel.value) cmd.target = sel.value;
  }
  function renderTwitchCmds() {
    const list = $("#twitchCmds");
    list.textContent = "";
    const cmds = TW().commands || (TW().commands = []);
    $("#twitchHead").hidden = cmds.length === 0;
    cmds.forEach((c, idx) => {
      const row = document.createElement("div");
      row.className = "rule twitch-rule";
      const cmd = document.createElement("input");
      cmd.type = "text"; cmd.value = c.cmd || ""; cmd.placeholder = "!brb"; cmd.spellcheck = false; cmd.autocomplete = "off"; cmd.setAttribute("aria-label", "Chat command");
      cmd.addEventListener("change", () => { let v = cmd.value.trim().toLowerCase().replace(/\s+/g, ""); if (v && !v.startsWith("!")) v = "!" + v; c.cmd = v; cmd.value = v; saveSettings(); });
      const act = document.createElement("select");
      act.setAttribute("aria-label", "What it does");
      for (const [v, l] of TW_ACTIONS) act.appendChild(new Option(l, v));
      act.value = c.action || "brb";
      const tgt = document.createElement("select");
      twTarget(tgt, c);
      act.addEventListener("change", () => { c.action = act.value; c.target = ""; twTarget(tgt, c); saveSettings(); });
      tgt.addEventListener("change", () => { c.target = tgt.value; saveSettings(); });
      const del = document.createElement("button");
      del.type = "button"; del.className = "btn icon"; del.setAttribute("aria-label", "Remove command");
      del.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
      del.addEventListener("click", () => { cmds.splice(idx, 1); saveSettings(); renderTwitchCmds(); });
      row.append(cmd, act, tgt, del);
      list.appendChild(row);
    });
  }
  // Channel point rewards: like commands, but found by the reward's id (learned from chat).
  function renderTwitchRewards() {
    const list = $("#twitchRewards");
    list.textContent = "";
    const rewards = TW().rewards || (TW().rewards = []);
    $("#rewardHead").hidden = rewards.length === 0;
    rewards.forEach((r, idx) => {
      const row = document.createElement("div");
      row.className = "rule twitch-rule";
      const name = Object.assign(document.createElement("input"), { type: "text", value: r.name || "", placeholder: "Reward name", spellcheck: false, autocomplete: "off" });
      name.maxLength = 40;
      name.title = `Reward id ${r.id}`;
      name.setAttribute("aria-label", "Reward name");
      name.addEventListener("change", () => { r.name = name.value.trim(); saveSettings(); });
      const act = document.createElement("select");
      act.setAttribute("aria-label", "What it does");
      for (const [v, l] of TW_ACTIONS) act.appendChild(new Option(l, v));
      act.value = r.action || "sound";
      const tgt = document.createElement("select");
      twTarget(tgt, r, "What the viewer typed");
      act.addEventListener("change", () => { r.action = act.value; r.target = ""; twTarget(tgt, r, "What the viewer typed"); saveSettings(); });
      tgt.addEventListener("change", () => { r.target = tgt.value; saveSettings(); });
      const del = document.createElement("button");
      del.type = "button"; del.className = "btn icon"; del.setAttribute("aria-label", "Remove reward");
      del.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
      del.addEventListener("click", () => { rewards.splice(idx, 1); saveSettings(); renderTwitchRewards(); });
      row.append(name, act, tgt, del);
      list.appendChild(row);
    });
  }
  // "Add a reward…": wait for the next redemption in chat and add its id.
  let learnTimer = null;
  function stopLearn(note) {
    clearInterval(learnTimer); learnTimer = null;
    $("#addReward").textContent = "Add a reward…";
    if (note !== undefined) $("#rewardLearn").textContent = note;
  }
  $("#addReward").addEventListener("click", () => {
    if (learnTimer) { stopLearn(""); return; }
    const t = TW();
    if (!t.on || !t.channel) { $("#rewardLearn").textContent = "Turn on chat commands and enter your channel first."; return; }
    const since = Date.now();
    $("#addReward").textContent = "Stop waiting";
    $("#rewardLearn").textContent = "Now redeem the reward on your channel (type anything)…";
    learnTimer = setInterval(async () => {
      const st = await engine.twitchStatus().catch(() => null);
      const r = st && st.reward;
      if (!r || !r.id || !(r.at > since)) return;
      const list = TW().rewards || (TW().rewards = []);
      if (list.some((x) => x.id === r.id)) { stopLearn("That reward is already in the list."); return; }
      list.push({ id: r.id, name: `Reward ${list.length + 1}`, action: "sound", target: "" });
      saveSettings();
      renderTwitchRewards();
      stopLearn(`Got it: ${r.user} redeemed it${r.text ? ` with “${r.text}”` : ""}. Give it a name and choose what it does.`);
      const names = document.querySelectorAll("#twitchRewards input");
      if (names.length) { names[names.length - 1].focus(); names[names.length - 1].select(); }
    }, 1000);
  });
  function syncTwitch() {
    engine.listScenes().then((n) => { knownScenes = n; renderTwitchCmds(); renderTwitchRewards(); }).catch(() => { renderTwitchCmds(); renderTwitchRewards(); });
    stopLearn("");
    const t = TW();
    $("#twitchOn").checked = !!t.on;
    $("#twitchOpts").hidden = !t.on;
    $("#twitchChannel").value = t.channel || "";
    $("#twitchWho").value = t.who || "mods";
    twRange._sync();
    applyTwitch(twitchState);
  }
  $("#twitchOn").addEventListener("change", (e) => { TW().on = e.target.checked; saveSettings(); syncTwitch(); });
  $("#twitchChannel").addEventListener("change", (e) => { TW().channel = e.target.value.trim().replace(/^#/, "").toLowerCase(); e.target.value = TW().channel; saveSettings(); });
  $("#twitchWho").addEventListener("change", (e) => { TW().who = e.target.value; saveSettings(); });
  $("#addTwitchCmd").addEventListener("click", () => {
    TW().commands.push({ cmd: "", action: "brb", target: "" });
    renderTwitchCmds();
    const inputs = document.querySelectorAll("#twitchCmds input");
    inputs[inputs.length - 1].focus();
  });

  /* ---------- going live: muted mic, stream sound, the go-live check, music off stream ---------- */
  const MT = () => (settings.mutedTalk = Object.assign({}, DEFAULT_SETTINGS.mutedTalk, settings.mutedTalk));
  const SW = () => (settings.streamWatch = Object.assign({}, DEFAULT_SETTINGS.streamWatch, settings.streamWatch));
  const GL = () => (settings.goLive = Object.assign({}, DEFAULT_SETTINGS.goLive, settings.goLive));
  const MG = () => (settings.musicGuard = Object.assign({}, DEFAULT_SETTINGS.musicGuard, settings.musicGuard));
  const RP = () => (settings.replay = Object.assign({}, DEFAULT_SETTINGS.replay, settings.replay));
  // The output the stream gets: the setting, else B2 (B on Standard), like watch.rs.
  function defaultStreamBus() {
    const hb = layout.buses.filter((b) => b.kind === "hw").length, vb = layout.buses.length - hb;
    const j = hb + (vb >= 2 ? 1 : 0);
    return j < layout.buses.length ? j : -1;
  }
  const liveRanges = [
    bindRange("mutedTalkDb", () => MT().threshold, (v) => { MT().threshold = v; }, fmtDbShort),
    bindRange("watchSecs", () => SW().silentSecs, (v) => { SW().silentSecs = v; }, (v) => `${v} s`),
  ];
  // A list of the inputs, by name.
  function fillStrips(sel, value, none) {
    sel.textContent = "";
    if (none) sel.appendChild(new Option(none, ""));
    for (const ch of chans) if (ch.kind === "strip") sel.appendChild(new Option(displayName(ch), ch.prefix));
    sel.value = value || "";
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
    return sel.value;
  }
  function syncLive() {
    const sb = $("#streamBus");
    sb.textContent = "";
    const def = defaultStreamBus();
    sb.appendChild(new Option(def >= 0 ? `Automatic (${busLabel(layout.buses[def].param)})` : "Automatic", ""));
    layout.buses.forEach((b, j) => sb.appendChild(new Option(busLabel(b.param), `Bus[${j}]`)));
    sb.value = settings.streamBus || "";
    if (sb.selectedIndex < 0) sb.value = "";
    const mt = MT();
    $("#mutedTalkOn").checked = mt.on !== false;
    $('[data-needs="mutedtalk"]').hidden = mt.on === false;
    mt.target = fillStrips($("#mutedTalkTarget"), mt.target);
    $("#mutedTalkPtt").checked = !!mt.ptt;
    $("#mutedTalkPttRow").hidden = !(settings.hotkeys || []).some((h) => h.action === "ptt" && h.target === mt.target);
    const w = SW();
    $("#watchOn").checked = !!w.on;
    $('[data-needs="watch"]').hidden = !w.on;
    $("#watchClip").checked = w.clip !== false;
    $("#watchLive").checked = w.onlyLive !== false;
    $("#goLiveOnLive").checked = GL().onLive !== false;
    const g = MG();
    $("#guardOn").checked = !!g.on;
    $('[data-needs="guard"]').hidden = !g.on;
    g.strip = fillStrips($("#guardStrip"), g.strip, "Choose the channel");
    $("#guardWhen").value = g.when || "either";
    for (const r of liveRanges) r._sync();
  }
  const onCheck = (id, set) => $("#" + id).addEventListener("change", (e) => { set(e.target.checked); saveSettings(); syncLive(); applyStreamButtons(lastState); });
  onCheck("mutedTalkOn", (v) => { MT().on = v; });
  onCheck("mutedTalkPtt", (v) => { MT().ptt = v; });
  onCheck("watchOn", (v) => { SW().on = v; });
  onCheck("watchClip", (v) => { SW().clip = v; });
  onCheck("watchLive", (v) => { SW().onlyLive = v; });
  onCheck("goLiveOnLive", (v) => { GL().onLive = v; });
  onCheck("guardOn", (v) => { MG().on = v; });
  const onPick = (id, set) => $("#" + id).addEventListener("change", (e) => { set(e.target.value); saveSettings(); syncLive(); applyStreamButtons(lastState); });
  onPick("streamBus", (v) => { settings.streamBus = v; });
  onPick("mutedTalkTarget", (v) => { MT().target = v; });
  onPick("guardStrip", (v) => { MG().strip = v; });
  onPick("guardWhen", (v) => { MG().when = v; });

  // The header buttons for Music off stream and Instant replay show once they're set up.
  function applyStreamButtons(st) {
    const g = MG();
    const mb = $("#musicBtn");
    mb.hidden = SIDE || !g.on || !g.strip;
    const on = !!(st && st.musicGuard);
    mb.setAttribute("aria-pressed", String(on));
    mb.title = on ? "Your music is off the stream. Click to put it back on" : "Music off stream: click to keep your music out of the stream now";
    mb.setAttribute("aria-label", on ? "Music is off the stream" : "Music off stream");
    $("#replayBtn").hidden = SIDE || !RP().on;
    paintStreamToolbar();
  }
  $("#musicBtn").addEventListener("click", () => engine.musicGuardToggle().catch(fail));

  // Warnings from the app: talking while muted, a silent or clipping stream.
  function onAlert(a) {
    if (!a || SIDE) return;
    toast(`${a.name}: ${a.text}`);
    if (a.kind !== "mutedTalk") return;
    const ch = chans.find((c) => c.prefix === MT().target);
    if (!ch) return;
    for (const r of ch.rows) r.classList.add("clipped");
    setTimeout(() => { for (const r of ch.rows) r.classList.remove("clipped"); }, 2500);
  }

  // The go-live check.
  const goLiveDlg = $("#goLiveDlg");
  const RANK = { bad: 0, warn: 1, ok: 2 };
  function paintGoLive(items) {
    const list = $("#goLiveList");
    list.textContent = "";
    const todo = items.filter((i) => i.state !== "ok").length;
    const sum = $("#goLiveSum");
    sum.textContent = !todo ? "All good. Have a great stream!" : todo === 1 ? "1 thing to check before you go live." : `${todo} things to check before you go live.`;
    sum.dataset.ok = todo ? "" : "1";
    for (const it of [...items].sort((a, b) => (RANK[a.state] ?? 2) - (RANK[b.state] ?? 2))) {
      const li = document.createElement("li");
      li.dataset.state = it.state;
      const mark = Object.assign(document.createElement("span"), { className: "mark", textContent: it.state === "ok" ? "✓" : it.state === "warn" ? "!" : "×" });
      const body = document.createElement("div");
      body.append(Object.assign(document.createElement("b"), { textContent: it.label }), Object.assign(document.createElement("span"), { className: "detail", textContent: it.detail }));
      const button = (text, run) => {
        const b = Object.assign(document.createElement("button"), { className: "btn primary", type: "button", textContent: text });
        b.addEventListener("click", async () => { b.disabled = true; try { await run(); } catch (e) { fail(e); } setTimeout(runGoLive, 700); });
        body.appendChild(b);
      };
      if (it.action === "fixAudio") button("Fix my audio", () => fixAudio());
      else if (it.action === "set" && it.param) button(it.button || "Fix it", () => engine.setFloat(it.param, it.value));
      li.append(mark, body);
      list.appendChild(li);
    }
  }
  async function runGoLive() {
    const list = $("#goLiveList");
    list.textContent = "";
    $("#goLiveSum").textContent = "";
    list.appendChild(Object.assign(document.createElement("li"), { className: "busy", textContent: "Checking…" }));
    let items;
    try { items = await engine.goLiveCheck(); } catch (e) { items = [{ state: "bad", label: "Go-live check", detail: String(e && e.message ? e.message : e) }]; }
    paintGoLive(items);
  }
  $("#goLiveBtn").addEventListener("click", () => { if (!goLiveDlg.open) goLiveDlg.showModal(); runGoLive(); });
  $("#goLiveAgain").addEventListener("click", runGoLive);
  $("#goLiveSettings").addEventListener("click", () => {
    goLiveDlg.close();
    $("#settingsBtn").click();
    selectSettingsCategory("streaming");
    const fold = $("#liveFold");
    fold.open = true;
    requestAnimationFrame(() => fold.scrollIntoView({ block: "start" }));
  });
  goLiveDlg.addEventListener("click", (e) => { if (e.target === goLiveDlg) goLiveDlg.close(); });
  // OBS went live and the check found something: show what (the overlay already said so).
  function onGoLive(p) {
    if (SIDE || !p || !p.items) return;
    paintGoLive(p.items);
    if (!goLiveDlg.open) goLiveDlg.showModal();
  }

  // Instant replay.
  const replayRange = bindRange("replaySecs", () => RP().secs, (v) => { RP().secs = v; }, (v) => `${v} s`);
  let replayTimer = null;
  async function refreshReplay() {
    let st = { running: false, message: "" };
    try { st = await engine.replayStatus(); } catch (e) { /* keep the blank state */ }
    const on = !!st.running;
    $("#replayNote").textContent = !RP().on ? "" : on ? "On" : "Not running";
    $("#replayNote").dataset.ok = on ? "1" : "";
    const text = $("#replayStatusText");
    text.textContent = RP().on ? st.message || "" : "";
    text.dataset.ok = on ? "1" : "";
  }
  async function syncReplay() {
    const r = RP();
    $("#replayOn").checked = !!r.on;
    $('[data-needs="replay"]').hidden = !r.on;
    replayRange._sync();
    let devs = [];
    try { devs = await engine.replayDevices(); } catch (e) { /* none listed */ }
    const sel = $("#replayDevice");
    sel.textContent = "";
    sel.appendChild(new Option("The stream output (automatic)", ""));
    for (const d of devs) sel.appendChild(new Option(d, d));
    if (r.device && !devs.includes(r.device)) sel.appendChild(new Option(`${r.device} (not connected)`, r.device));
    sel.value = r.device || "";
    refreshReplay();
    clearInterval(replayTimer);
    replayTimer = setInterval(() => {
      if (!settingsDlg.open) { clearInterval(replayTimer); replayTimer = null; return; }
      if (settingsShowing("replayOn")) refreshReplay();
    }, 2000);
  }
  $("#replayOn").addEventListener("change", (e) => { RP().on = e.target.checked; saveSettings(); syncReplay(); applyStreamButtons(lastState); setTimeout(refreshReplay, 1200); });
  $("#replayDevice").addEventListener("change", (e) => { RP().device = e.target.value; saveSettings(); setTimeout(refreshReplay, 1500); });
  function saveReplay() {
    engine.replaySave().then((p) => toast(`Replay saved: ${String(p).split(/[\\/]/).pop()}`)).catch(fail);
  }
  $("#replayBtn").addEventListener("click", saveReplay);
  $("#replaySaveNow").addEventListener("click", saveReplay);
  $("#replayFolder").addEventListener("click", () => engine.replayOpenFolder().catch(fail));
  settingsDlg.addEventListener("close", () => stopLearn(""));

  /* ---------- phone remote ---------- */
  const RM = () => (settings.remote = Object.assign({}, DEFAULT_SETTINGS.remote, settings.remote));
  const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
  let remoteTimer = null;
  async function refreshRemote() {
    let st = { running: false, message: "", urls: [] };
    try { st = await engine.remoteStatus(); } catch (e) { /* keep the blank state */ }
    const on = !!st.running;
    $("#remoteNote").textContent = !RM().on ? "" : on ? "On" : "Not running";
    $("#remoteNote").dataset.ok = on ? "1" : "";
    const url = (st.urls || [])[0] || "";
    $("#remoteUrl").hidden = !url;
    $("#remoteUrlText").textContent = url;
    let ov = "";
    try { const u = new URL(url); u.hostname = "localhost"; u.pathname = "/overlay"; ov = u.toString(); } catch (e) { /* no address yet */ }
    $("#overlayUrl").hidden = !ov;
    $("#overlayUrlText").textContent = ov;
    const text = $("#remoteStatusText");
    text.textContent = RM().on ? (on ? "Open this address on your phone while it's on the same Wi-Fi as this PC." : st.message || "") : "";
    text.dataset.ok = on ? "1" : "";
  }
  function syncRemote() {
    const r = RM();
    $("#remoteOn").checked = !!r.on;
    $("#remoteOpts").hidden = !r.on;
    $("#remotePort").value = r.port || 8787;
    refreshRemote();
    clearInterval(remoteTimer);
    remoteTimer = setInterval(() => {
      if (!settingsDlg.open) { clearInterval(remoteTimer); remoteTimer = null; }
      else if (settingsShowing("remoteOn")) refreshRemote();
    }, 2000);
  }
  const remoteSaved = async () => { await saveNow(); setTimeout(refreshRemote, 700); };
  $("#remoteOn").addEventListener("change", async (e) => {
    RM().on = e.target.checked;
    if (RM().on && !RM().key) RM().key = newKey();
    $("#remoteOpts").hidden = !RM().on;
    await remoteSaved();
  });
  $("#remotePort").addEventListener("change", async (e) => { RM().port = Math.max(1024, Math.min(65535, +e.target.value || 8787)); e.target.value = RM().port; await remoteSaved(); });
  $("#remoteNewKey").addEventListener("click", async () => { RM().key = newKey(); await remoteSaved(); toast("Made a new key"); });
  $("#overlayCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#overlayUrlText").textContent); toast("OBS address copied"); }
    catch (e) { toast("Select the address and press Ctrl+C"); }
  });
  $("#remoteCopy").addEventListener("click", async () => {
    const text = $("#remoteUrlText").textContent;
    try { await navigator.clipboard.writeText(text); toast("Address copied"); }
    catch (e) { const r = document.createRange(); r.selectNodeContents($("#remoteUrlText")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast("Press Ctrl+C to copy"); }
  });

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

  /* ---------- mic clean-up: NVIDIA's AI and VST3 plugins, one chain per mic (micfx.rs, pluginhost.rs) ---------- */
  const MICFX_EFFECTS = [["denoiser", "Background noise"], ["dereverb", "Room echo"], ["dereverb_denoiser", "Noise and room echo"]];
  const newChain = (target) => ({ id: "c" + Date.now().toString(36), target: target || "", on: false, effect: "denoiser", strength: 100, aec: false, plugins: [] });
  // Before several mics, one chain's fields lived in micFx itself: that becomes the first chain.
  const MF = () => {
    const raw = settings.micFx || {};
    if (!Array.isArray(raw.chains)) {
      const flat = raw.target !== undefined || raw.on !== undefined || Array.isArray(raw.plugins);
      raw.chains = [{ id: "c1", target: raw.target || "Strip[0]", on: flat ? !!raw.on : false, effect: raw.effect || "denoiser",
        strength: raw.strength ?? 100, aec: false, plugins: Array.isArray(raw.plugins) ? raw.plugins : [] }];
      for (const k of ["target", "on", "effect", "strength", "plugins"]) delete raw[k];
      settings.micFx = raw;
      setTimeout(saveSettings, 0);
    }
    if (!raw.chains.length) raw.chains.push(Object.assign(newChain("Strip[0]"), { id: "c1" }));
    if (!raw.aecRef) raw.aecRef = "Bus[0]";
    return (settings.micFx = raw);
  };
  let micSel = 0;
  const CH = () => { const cs = MF().chains; if (micSel >= cs.length) micSel = 0; return cs[micSel]; };
  const PLUGINS = () => (CH().plugins = Array.isArray(CH().plugins) ? CH().plugins : []);
  const micFxRange = bindRange("micFxStrength", () => CH().strength ?? 100, (v) => { CH().strength = v; }, (v) => `${v}%`);
  const hwInputs = () => {
    const hw = layout.strips.filter((s) => s.kind === "hw").length;
    return chans.filter((ch) => { const m = /^Strip\[(\d+)\]$/.exec(ch.prefix); return m && +m[1] < hw; });
  };
  const micName = (c, i) => { const ch = chans.find((x) => x.prefix === c.target); return ch ? displayName(ch) : `Mic ${i + 1}`; };
  let micFxTimer = null;
  let micFxLast = { chains: {}, plugins: {} };
  let micFxRequest = null;
  let vstFound = null; // last scan, for the Add list
  let listening = false;
  function openInputEffects(ch, preferred = "") {
    const chains = MF().chains;
    let i = chains.findIndex((c) => c.target === ch.prefix && (!preferred || c.id === preferred));
    if (i < 0) i = chains.findIndex((c) => c.target === ch.prefix);
    if (i < 0) {
      if (chains.length >= 5) { toast("Remove an unused input chain before adding another"); return; }
      chains.push(newChain(ch.prefix));
      i = chains.length - 1;
      saveSettings();
    }
    stopListening();
    if (drawerCh) closeDrawer();
    micSel = i;
    openSettings("microphone");
    const fold = $("#micFxFold");
    fold.open = true;
    const active = $("#micTabs [aria-selected=true]");
    if (active) active.focus();
    requestAnimationFrame(() => fold.scrollIntoView({ block: "start" }));
  }
  function paintInputWarnings(st) {
    const chains = settings.micFx?.chains || [];
    const warnings = new Map();
    for (const c of chains) {
      const chain = st.chains?.[c.id];
      const plugin = (c.plugins || []).find((p) => st.plugins?.[p.id]?.bypassed || (p.on !== false && st.plugins?.[p.id]?.error));
      if (plugin) warnings.set(c.target, { id: c.id, text: `${plugin.name} · ${st.plugins[plugin.id].error || "Bypassed for recovery"}` });
      else if (chain && !chain.off && !chain.running && !c.stereo && (c.on || c.aec) && chain.message) {
        warnings.set(c.target, { id: c.id, text: chain.message });
      }
    }
    for (const ch of chans) {
      const el = ch.fxWarning;
      if (!el) continue;
      const warning = warnings.get(ch.prefix);
      el.hidden = !warning;
      if (!warning) continue;
      el.dataset.chain = warning.id;
      el.title = warning.text;
      el.setAttribute("aria-label", `${displayName(ch)} effects warning. ${warning.text} Open input effects`);
    }
  }
  function fetchMicFxStatus() {
    if (!micFxRequest) micFxRequest = engine.micFxStatus().then((st) => {
      micFxLast = st;
      paintInputWarnings(st);
      return st;
    }).catch(() => micFxLast).finally(() => { micFxRequest = null; });
    return micFxRequest;
  }
  function pollInputEffects() {
    const m = settings.micFx;
    const configured = m?.on || m?.aec || m?.plugins?.length
      || m?.chains?.some((c) => c.on || c.aec || c.plugins?.length);
    if (configured && connected) {
      if (!Array.isArray(m.chains)) MF();
      fetchMicFxStatus();
    }
    else paintInputWarnings({});
  }
  async function recoverPlugin(bypass) {
    const id = $("#vstRecoveryPlugin").value;
    if (!id) return;
    try {
      await engine.vstRecover(id, bypass);
      toast(bypass ? "Plugin bypassed for recovery" : "Retry requested");
      setTimeout(refreshMicFx, 750);
    } catch (e) { fail(e); }
  }
  $("#vstBypass").addEventListener("click", () => recoverPlugin(true));
  $("#vstRetry").addEventListener("click", () => recoverPlugin(false));

  async function refreshMicFx() {
    const st = await fetchMicFxStatus();
    if (!settingsDlg.open) return;
    const c = CH(), cs = (st.chains || {})[c.id] || {};
    const set = (x) => (!x.stereo && (x.on || x.aec)) || (x.plugins || []).some((p) => p.on !== false);
    const runningCount = Object.values(st.chains || {}).filter((x) => x.running).length;
    const wanted = MF().chains.some(set);
    $("#micFxMissing").hidden = !!c.stereo || !!st.available || !(c.on || c.aec);
    $("#micFxNote").textContent = !wanted ? "" : runningCount ? (MF().chains.length > 1 ? `On (${runningCount})` : "On") : "Not running";
    $("#micFxNote").dataset.ok = runningCount ? "1" : "";
    $("#micFxOffRow").hidden = !cs.off;
    const text = $("#micFxStatusText");
    const extra = cs.running && cs.latencyMs ? ` Adds about ${Math.round(cs.latencyMs)} ms of delay.` : "";
    text.textContent = cs.off ? "" : set(c) ? (cs.message || st.message || "") + extra : "";
    text.dataset.ok = cs.running ? "1" : "";
    // Tabs: a green dot on mics that are running.
    document.querySelectorAll("#micTabs [data-chain]").forEach((b) => {
      const d = b.querySelector(".dot");
      if (d) d.classList.toggle("on", !!((st.chains || {})[b.dataset.chain] || {}).running);
    });
    // Each plugin: why it didn't load, if it didn't.
    const ps = st.plugins || {};
    const recovery = $("#vstRecovery");
    const recoverySelect = $("#vstRecoveryPlugin");
    const choices = MF().chains.flatMap((c) => c.plugins || []);
    recovery.hidden = !choices.length || !st.recovery?.message;
    if (!recovery.hidden) {
      const message = $("#vstRecoveryMessage");
      if (message.textContent !== st.recovery.message) message.textContent = st.recovery.message;
      const signature = JSON.stringify(choices.map((p) => [p.id, p.name, !!ps[p.id]?.bypassed]));
      if (recoverySelect.dataset.choices !== signature) {
        const selected = recoverySelect.value;
        recoverySelect.dataset.choices = signature;
        recoverySelect.replaceChildren(...choices.map((p) => new Option(p.name + (ps[p.id]?.bypassed ? " · bypassed" : ""), p.id)));
        recoverySelect.value = choices.some((p) => p.id === selected) ? selected :
          (choices.find((p) => ps[p.id]?.bypassed) || choices[0]).id;
      }
    }
    for (const row of document.querySelectorAll("#vstList .vst-rule")) {
      const p = PLUGINS().find((x) => x.id === row.dataset.id);
      const s = ps[row.dataset.id];
      const small = row.querySelector(".vst-name small");
      const edit = row.querySelector(".vst-edit");
      if (!p || !small) continue;
      const err = s && s.error;
      small.textContent = err ? err : s && s.loaded ? (p.vendor || "VST3") : "Loading…";
      small.classList.toggle("err", !!err);
      if (edit) edit.disabled = !(s && s.loaded && s.editor);
    }
  }

  function renderMicTabs() {
    const tabs = $("#micTabs");
    tabs.textContent = "";
    const cs = MF().chains;
    if (micSel >= cs.length) micSel = 0;
    cs.forEach((c, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn"; b.setAttribute("role", "tab");
      b.dataset.chain = c.id;
      b.setAttribute("aria-selected", i === micSel ? "true" : "false");
      const dot = document.createElement("span"); dot.className = "dot";
      b.append(dot, document.createTextNode(micName(c, i)));
      b.addEventListener("click", () => { if (micSel !== i) { stopListening(); micSel = i; syncMicFx(); } });
      tabs.appendChild(b);
    });
    const free = hwInputs().filter((ch) => !cs.some((c) => c.target === ch.prefix));
    if (free.length && cs.length < 5) {
      const add = document.createElement("button");
      add.type = "button"; add.className = "btn";
      add.textContent = "+ Add a mic";
      add.title = "Clean up another of Voicemeeter's hardware inputs too, like a guest mic";
      add.addEventListener("click", () => {
        stopListening();
        cs.push(newChain(free[0].prefix));
        micSel = cs.length - 1;
        saveSettings();
        syncMicFx();
      });
      tabs.appendChild(add);
    }
    tabs.hidden = cs.length < 2 && !free.length;
    $("#micFxRemoveMic").hidden = cs.length < 2;
  }

  const svgIcon = (d) => `<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const presetsFor = (cid) => (Array.isArray(settings.vstPresets) ? settings.vstPresets : []).filter((p) => p.cid === cid);
  // The plugin whose settings the name box saves.
  let presetFor = null;
  async function savePreset() {
    const name = $("#presetName").value.trim();
    if (!presetFor) return;
    if (!name) { $("#presetName").focus(); return; }
    try {
      settings.vstPresets = await engine.vstPresetSave(presetFor.id, name);
      toast(`Saved preset “${name}” for ${presetFor.name}`);
      $("#presetSave").hidden = true;
      presetFor = null;
      renderPlugins();
    } catch (e) { fail(e); }
  }
  $("#presetSaveOk").addEventListener("click", savePreset);
  $("#presetName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); savePreset(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); $("#presetSave").hidden = true; presetFor = null; }
  });
  function presetMenu(p) {
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", `${p.name} presets`);
    sel.title = "Save this plugin's settings as a preset, or load one";
    sel.appendChild(new Option("Presets", ""));
    const mine = presetsFor(p.cid);
    for (const pr of mine) sel.appendChild(new Option(pr.name, "apply:" + pr.name));
    sel.appendChild(new Option("Save as a preset…", "save"));
    for (const pr of mine) sel.appendChild(new Option(`Delete “${pr.name}”`, "del:" + pr.name));
    sel.addEventListener("change", async () => {
      const v = sel.value;
      sel.value = "";
      try {
        if (v === "save") {
          // Ask for the name in the box under the list.
          presetFor = p;
          $("#presetSave").hidden = false;
          $("#presetName").placeholder = `Name this preset for ${p.name}`;
          $("#presetName").value = "";
          $("#presetName").focus();
        } else if (v.startsWith("apply:")) {
          await engine.vstPresetApply(p.id, v.slice(6));
          toast(`${p.name}: “${v.slice(6)}” loaded`);
        } else if (v.startsWith("del:")) {
          settings.vstPresets = await engine.vstPresetDelete(p.cid, v.slice(4));
          toast(`Deleted preset “${v.slice(4)}”`);
          renderPlugins();
        }
      } catch (e) { fail(e); }
    });
    return sel;
  }

  function renderPlugins() {
    const list = $("#vstList");
    list.textContent = "";
    const ps = PLUGINS();
    $("#vstEmpty").hidden = ps.length > 0;
    ps.forEach((p, idx) => {
      const row = document.createElement("div");
      row.className = "rule vst-rule with-presets";
      row.dataset.id = p.id;
      const on = document.createElement("input");
      on.type = "checkbox"; on.checked = p.on !== false; on.setAttribute("aria-label", `${p.name} on`);
      on.addEventListener("change", () => { p.on = on.checked; saveSettings(); setTimeout(refreshMicFx, 800); });
      const name = document.createElement("div");
      name.className = "vst-name";
      const b = document.createElement("b"); b.textContent = p.name; b.title = p.path;
      const small = document.createElement("small"); small.textContent = p.vendor || "VST3";
      name.append(b, small);
      const edit = document.createElement("button");
      edit.type = "button"; edit.className = "btn vst-edit"; edit.textContent = "Edit";
      edit.title = `Open ${p.name}'s window`;
      edit.addEventListener("click", () => engine.vstEditor(p.id).catch(fail));
      const move = (d, label, path) => {
        const btn = document.createElement("button");
        btn.type = "button"; btn.className = "btn icon"; btn.setAttribute("aria-label", label); btn.title = label;
        btn.innerHTML = svgIcon(path);
        const to = idx + d;
        btn.disabled = to < 0 || to >= ps.length;
        btn.addEventListener("click", () => { ps.splice(to, 0, ps.splice(idx, 1)[0]); saveSettings(); renderPlugins(); });
        return btn;
      };
      const del = document.createElement("button");
      del.type = "button"; del.className = "btn icon"; del.setAttribute("aria-label", `Remove ${p.name}`); del.title = "Remove";
      del.innerHTML = svgIcon("M5 5l10 10M15 5L5 15");
      del.addEventListener("click", () => { ps.splice(idx, 1); saveSettings(); renderPlugins(); refreshMicFx(); });
      row.append(on, name, presetMenu(p), edit, move(-1, "Move up", "M10 15V5M5 10l5-5 5 5"), move(1, "Move down", "M10 5v10M5 10l5 5 5-5"), del);
      list.appendChild(row);
    });
    refreshMicFx();
  }
  function addPlugin(f) {
    const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    PLUGINS().push({ id, name: f.name, vendor: f.vendor || "", path: f.path, cid: f.cid, on: true });
    saveSettings();
    renderPlugins();
    toast(`${f.name} added to ${micName(CH(), micSel)}`);
    setTimeout(refreshMicFx, 1500);
  }
  $("#vstAdd").addEventListener("click", async () => {
    const pick = $("#vstPick"), sel = $("#vstChoice"), btn = $("#vstAdd");
    if (!pick.hidden) { pick.hidden = true; return; }
    btn.disabled = true; btn.textContent = "Looking for plugins…";
    try { vstFound = await engine.vstScan(); } catch (e) { fail(e); vstFound = []; }
    btn.disabled = false; btn.textContent = "Add a plugin…";
    sel.textContent = "";
    if (!vstFound.length) {
      toast("No VST3 effects in the usual folders. Use Browse to pick one.");
      return;
    }
    vstFound.forEach((f, i) => sel.appendChild(new Option(f.vendor ? `${f.name} (${f.vendor})` : f.name, String(i))));
    pick.hidden = false;
    sel.focus();
  });
  $("#vstAddOk").addEventListener("click", () => {
    const f = (vstFound || [])[+$("#vstChoice").value];
    if (!f) return;
    $("#vstPick").hidden = true;
    addPlugin(f);
  });
  $("#vstBrowse").addEventListener("click", async () => {
    let found = [];
    try { found = await engine.vstBrowse(); } catch (e) { fail(e); return; }
    if (!found.length) return; // cancelled
    if (found.length === 1) { addPlugin(found[0]); return; }
    // A file with several effects: offer them in the Add list.
    vstFound = found;
    const sel = $("#vstChoice");
    sel.textContent = "";
    found.forEach((f, i) => sel.appendChild(new Option(f.name, String(i))));
    $("#vstPick").hidden = false;
  });

  const micPresetDlg = $("#micPresetDlg");
  const micPresetStatus = $("#micPresetStatus");
  const micPresetButtons = [$("#micPresetImport"), $("#micPresetExport")];
  let micPresetTarget = "";
  for (const [index, button] of micPresetButtons.entries()) {
    button.addEventListener("click", async () => {
      const selected = CH(), id = selected.id, name = micName(selected, micSel);
      micPresetButtons.forEach((b) => { b.disabled = true; });
      try {
        if (!await saveNow()) return;
        if (index === 1) {
          if (await engine.micPresetExport(id)) toast("Mic chain exported");
          return;
        }
        const preview = await engine.micPresetPreview(id);
        if (!preview || !settingsDlg.open) { await engine.micPresetClear(); return; }
        micPresetTarget = id;
        $("#micPresetDestination").textContent = `Destination: ${name}. Applying this preset replaces that mic’s effects and plugin list.`;
        $("#micPresetEffects").textContent = preview.stereo ? "Stereo VST3 chain" :
          `${preview.on ? `${preview.effect}, ${preview.strength}%` : "NVIDIA clean-up off"} · Speaker echo removal ${preview.aec ? "on" : "off"}`;
        $("#micPresetReview").replaceChildren(...[
          ...preview.notes, ...preview.plugins.map((p) => `${p.name} · ${p.status}`),
          ...(!preview.plugins.length ? ["This preset has no VST3 plugins."] : []),
        ].map((textContent) => Object.assign(document.createElement("li"), { textContent })));
        micPresetStatus.textContent = "";
        micPresetDlg.showModal();
      } catch (e) { fail(e); }
      finally { micPresetButtons.forEach((b) => { b.disabled = false; }); }
    });
  }
  $("#micPresetApply").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    micPresetStatus.textContent = "Applying preset…";
    try {
      stopListening();
      settings.micFx = await engine.micPresetApply(micPresetTarget);
      syncMicFx();
      micPresetDlg.close();
      toast("Mic-chain preset applied");
    } catch (err) { micPresetStatus.textContent = String(err); }
    finally { btn.disabled = false; }
  });
  micPresetDlg.addEventListener("close", () => { micPresetTarget = ""; engine.micPresetClear().catch(fail); });

  // Listen (A1 on while you set it up) and hold-to-compare.
  function stopListening() {
    if (!listening) return;
    listening = false;
    $("#micFxListen").setAttribute("aria-pressed", "false");
    $("#micFxListen").textContent = "Listen to this mic";
    engine.micFxListen("", false).catch(() => {});
  }
  $("#micFxListen").addEventListener("click", async () => {
    try {
      listening = await engine.micFxListen(CH().id, !listening);
      $("#micFxListen").setAttribute("aria-pressed", listening ? "true" : "false");
      $("#micFxListen").textContent = listening ? "Stop listening" : "Listen to this mic";
    } catch (e) { fail(e); }
  });
  const compareBtn = $("#micFxCompare");
  const compare = (on) => {
    compareBtn.classList.toggle("held", on);
    compareBtn.textContent = on ? "Without clean-up…" : "Hold to hear it without";
    engine.micFxCompare(CH().id, on).catch(() => {});
  };
  compareBtn.addEventListener("pointerdown", (e) => { compareBtn.setPointerCapture(e.pointerId); compare(true); });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) compareBtn.addEventListener(ev, () => { if (compareBtn.classList.contains("held")) compare(false); });
  settingsDlg.addEventListener("close", stopListening);

  $("#micFxBackOn").addEventListener("click", () => engine.micFxToggle(CH().target).then(() => setTimeout(refreshMicFx, 600)).catch(fail));
  $("#micFxRemoveMic").addEventListener("click", () => {
    const cs = MF().chains;
    if (cs.length < 2) return;
    const c = CH();
    // A mic with plugins: click twice, so its plugins aren't lost by accident.
    const btn = $("#micFxRemoveMic");
    if (c.plugins.length && !btn.dataset.sure) {
      btn.dataset.sure = "1";
      btn.textContent = `Click again to remove it and its ${c.plugins.length === 1 ? "plugin" : "plugins"}`;
      setTimeout(() => { delete btn.dataset.sure; btn.textContent = "Remove this mic"; }, 4000);
      return;
    }
    delete btn.dataset.sure;
    btn.textContent = "Remove this mic";
    stopListening();
    cs.splice(micSel, 1);
    micSel = Math.max(0, micSel - 1);
    saveSettings();
    syncMicFx();
  });

  function syncMicFx() {
    const m = MF(), c = CH();
    renderMicTabs();
    $("#micFxOn").checked = !!c.on;
    $("#micFxMode").value = c.stereo ? "stereo" : "mic";
    $("#micFxStereoHint").hidden = !c.stereo;
    $("#micFxOn").closest("label").hidden = !!c.stereo;
    $("#micFxAec").closest("label").hidden = !!c.stereo;
    $('[data-needs="micfx"]').hidden = !!c.stereo || !c.on;
    $("#micFxAec").checked = !!c.aec;
    $('[data-needs="micaec"]').hidden = !!c.stereo || !c.aec;
    // Only hardware inputs: those are where mics are, and where Voicemeeter's insert has them.
    const sel = $("#micFxTarget");
    sel.textContent = "";
    for (const ch of hwInputs()) {
      const taken = m.chains.some((x) => x !== c && x.target === ch.prefix);
      const o = new Option(displayName(ch) + (taken ? " (another mic tab)" : ""), ch.prefix);
      o.disabled = taken;
      sel.appendChild(o);
    }
    sel.value = c.target;
    if (sel.selectedIndex < 0 || sel.options[sel.selectedIndex].disabled) {
      const first = [...sel.options].find((o) => !o.disabled);
      if (first) { sel.value = first.value; c.target = first.value; }
    }
    const eff = $("#micFxEffect");
    if (!eff.options.length) for (const [k, n] of MICFX_EFFECTS) eff.appendChild(new Option(n, k));
    eff.value = c.effect || "denoiser";
    if (eff.selectedIndex < 0) eff.value = "denoiser";
    const ref = $("#micFxAecRef");
    ref.textContent = "";
    layout.buses.forEach((b, j) => ref.appendChild(new Option(busLabel(b.param), `Bus[${j}]`)));
    ref.value = m.aecRef;
    if (ref.selectedIndex < 0) ref.value = "Bus[0]";
    micFxRange._sync();
    $("#vstPick").hidden = true;
    $("#presetSave").hidden = true;
    presetFor = null;
    renderPlugins();
    clearInterval(micFxTimer);
    micFxTimer = setInterval(() => {
      if (!settingsDlg.open) { clearInterval(micFxTimer); micFxTimer = null; return; }
      if (settingsShowing("micFxFold")) refreshMicFx();
    }, 1500);
  }
  $("#micFxOn").addEventListener("change", (e) => { CH().on = e.target.checked; saveSettings(); syncMicFx(); });
  $("#micFxMode").addEventListener("change", (e) => {
    stopListening();
    CH().stereo = e.target.value === "stereo";
    saveSettings();
    syncMicFx();
  });
  $("#micFxAec").addEventListener("change", (e) => { CH().aec = e.target.checked; saveSettings(); syncMicFx(); });
  $("#micFxAecRef").addEventListener("change", (e) => { MF().aecRef = e.target.value; saveSettings(); });
  $("#micFxTarget").addEventListener("change", (e) => { stopListening(); CH().target = e.target.value; saveSettings(); renderMicTabs(); setTimeout(refreshMicFx, 800); });
  $("#micFxEffect").addEventListener("change", (e) => { CH().effect = e.target.value; saveSettings(); setTimeout(refreshMicFx, 800); });

  const levelOf = (lv, prefix) => {
    const m = /^(Strip|Bus)\[(\d)\]$/.exec(prefix || "");
    const pair = m ? ((m[1] === "Strip" ? lv.inputs : lv.outputs) || [])[+m[2]] : null;
    return pair ? Math.max(pair[0], pair[1]) : -200;
  };
  let clipRun = 0, clipAt = 0;
  function checkClip(lv) {
    const c = settings.clipWarn;
    if (SIDE || !c || !c.on) return;
    clipRun = levelOf(lv, c.target) >= -0.3 ? clipRun + 1 : 0;
    const now = performance.now();
    if (clipRun < 2 || now - clipAt < 15000) return;
    clipAt = now;
    const ch = chans.find((x) => x.prefix === c.target);
    const name = ch ? displayName(ch) : "Your mic";
    toast(`${name} is too loud: it went over 0 dB and will distort. Turn it down a little.`);
    if (ch) {
      for (const r of ch.rows) r.classList.add("clipped");
      setTimeout(() => { for (const r of ch.rows) r.classList.remove("clipped"); }, 2500);
    }
  }


  /* ---------- Voicemeeter options (System Settings) ---------- */
  const optDlg = $("#optDlg");
  const OPT_RATES = [44100, 48000, 88200, 96000, 176400, 192000];
  const OPT_BUFFERS = [["mme", "MME buffer"], ["wdm", "WDM buffer"], ["ks", "KS buffer"], ["asio", "ASIO buffer (0 = driver default)"]];
  async function openOptions() {
    const hw = layout.buses.filter((b) => b.kind === "hw");
    const names = ["Option.sr", "Option.ASIOsr", ...OPT_BUFFERS.map((b) => `Option.buffer.${b[0]}`), "Option.mode.exclusif", "Option.mode.swift", "Option.MonitorOnSEL", "Option.SliderMode", ...hw.map((_, i) => `Option.delay[${i}]`)];
    let vals = [];
    try { vals = await engine.getFloats(names); } catch (e) { fail(e); }
    const V = Object.fromEntries(names.map((n, i) => [n, vals[i]]));
    const body = $("#optBody");
    body.textContent = "";
    let any = false;
    const write = (name, v) => { engine.setFloat(name, v).then(() => toast("Saved. Voicemeeter may restart its audio engine.")).catch(fail); };
    const row = (label, ctl, hint) => {
      const f = document.createElement("div"); f.className = "field wide";
      const l = document.createElement("label"); l.textContent = label; f.append(l, ctl);
      if (hint) { l.title = hint; }
      body.appendChild(f); any = true;
    };
    const select = (name, choices, scale) => {
      const el = document.createElement("select");
      const cur = V[name];
      for (const [v, t] of choices) el.appendChild(new Option(t, v));
      if (![...el.options].some((o) => +o.value === cur)) el.appendChild(new Option(String(cur), cur));
      el.value = String(cur);
      el.addEventListener("change", () => write(name, +el.value));
      return el;
    };
    const check = (name, text) => {
      const lab = document.createElement("label"); lab.className = "check";
      const i = document.createElement("input"); i.type = "checkbox"; i.checked = !!V[name];
      const sp = document.createElement("span"); sp.textContent = text;
      i.addEventListener("change", () => write(name, i.checked ? 1 : 0));
      lab.append(i, sp); body.appendChild(lab); any = true;
    };
    const h = (t) => { const e = document.createElement("h3"); e.textContent = t; body.appendChild(e); };
    if (V["Option.sr"] != null) {
      h("Engine");
      // Voicemeeter reports the rate in Hz (48000); if a version reports kHz (48) write it back the same way.
      const khz = V["Option.sr"] < 1000;
      const el = select("Option.sr", OPT_RATES.map((r) => [khz ? r / 1000 : r, `${r / 1000} kHz`]));
      row("Sample rate", el, "The rate Voicemeeter mixes at");
    }
    if (V["Option.ASIOsr"] != null) check("Option.ASIOsr", "Use the ASIO device's preferred sample rate");
    for (const [k, t] of OPT_BUFFERS) {
      const n = `Option.buffer.${k}`;
      if (V[n] == null) continue;
      const el = document.createElement("input"); el.type = "number"; el.min = k === "asio" ? 0 : 128; el.max = 2048; el.step = 16; el.value = V[n];
      el.addEventListener("change", () => { let v = Math.round(+el.value || 0); if (!(k === "asio" && v === 0)) v = Math.max(128, Math.min(2048, v)); el.value = v; write(n, v); });
      row(t, el);
    }
    if (V["Option.mode.exclusif"] != null || V["Option.mode.swift"] != null || V["Option.MonitorOnSEL"] != null || V["Option.SliderMode"] != null) h("Behaviour");
    if (V["Option.mode.exclusif"] != null) check("Option.mode.exclusif", "WDM exclusive mode (lower latency, other apps can't share the device)");
    if (V["Option.mode.swift"] != null) check("Option.mode.swift", "Swift mode");
    if (V["Option.MonitorOnSEL"] != null) check("Option.MonitorOnSEL", "Monitor the selected bus (Sel button)");
    if (V["Option.SliderMode"] != null) check("Option.SliderMode", "Relative slider mode for MIDI controllers");
    if (hw.some((_, i) => V[`Option.delay[${i}]`] != null)) {
      h("Output delay (to line up speakers with video)");
      hw.forEach((b, i) => {
        const n = `Option.delay[${i}]`;
        if (V[n] == null) return;
        const el = document.createElement("input"); el.type = "number"; el.min = 0; el.max = 500; el.step = 1; el.value = V[n];
        el.addEventListener("change", () => { const v = Math.max(0, Math.min(500, Math.round(+el.value || 0))); el.value = v; write(n, v); });
        row(`${b.id} delay (ms)`, el);
      });
    }
    $("#optNone").hidden = any;
    optDlg.showModal();
  }
  optDlg.addEventListener("click", (e) => { if (e.target === optDlg) optDlg.close(); });

  /* ---------- hear yourself ---------- */
  const hearDlg = $("#hearDlg");
  let hearBusy = false;
  async function openHear() {
    $("#hearStatus").textContent = "";
    let ins = [], outs = { devices: [] };
    try { ins = (await engine.selftestInputs()).devices || []; } catch (e) { fail(e); }
    try { outs = await engine.soundDevices(); } catch (e) { /* default only */ }
    const si = $("#hearInput"), so = $("#hearOutput");
    si.textContent = ""; so.textContent = "";
    // Prefer B2 (the stream mix) when there is one, otherwise B1.
    for (const d of ins) si.appendChild(new Option(d.replace(/\s*\(.*\)$/, ""), d));
    const pick = ins.find((d) => /out b2/i.test(d)) || ins[0];
    if (pick) si.value = pick;
    so.appendChild(new Option("My default speakers or headphones", ""));
    for (const d of outs.devices || []) if (!/voicemeeter/i.test(d)) so.appendChild(new Option(d, d));
    $("#hearNone").hidden = ins.length > 0;
    $("#hearStart").disabled = !ins.length || hearBusy;
    hearDlg.showModal();
  }
  hearDlg.addEventListener("click", (e) => { if (e.target === hearDlg) hearDlg.close(); });
  $("#hearStart").addEventListener("click", async () => {
    if (hearBusy) return;
    hearBusy = true;
    const b = $("#hearStart"), st = $("#hearStatus");
    b.disabled = true;
    const SECS = 5;
    let left = SECS;
    st.textContent = `Recording… talk now (${left} s)`;
    const t = setInterval(() => { left = Math.max(0, left - 1); st.textContent = left ? `Recording… talk now (${left} s)` : "Playing it back…"; }, 1000);
    try {
      await engine.selftestRun($("#hearInput").value, $("#hearOutput").value, SECS);
      st.textContent = "Done. Press the button to try again.";
    } catch (e) { st.textContent = String((e && e.message) || e); }
    clearInterval(t);
    hearBusy = false; b.disabled = false; b.textContent = "Record again";
  });

  /* ---------- setup assistant ---------- */
  const setupDlg = $("#setupDlg");
  const setupKind = () => setupDlg.querySelector("input[name=setupKind]:checked").value;
  const strips = () => chans.filter((c) => c.kind === "strip");
  // What each strip should send to, per scenario. A = headphones/speakers, B = virtual outputs.
  function setupRoutes(kind, micI, discI) {
    const virt = layout.buses.filter((b) => b.kind === "virt");
    const plan = [];
    for (const ch of strips()) {
      const on = {};
      for (const b of layout.buses) on[b.param] = false;
      const isMic = ch.i === micI, isDisc = kind === "stream" && ch.i === discI;
      if (virt[0]) on[virt[0].param] = isMic;                       // B1: what friends hear
      if (!isMic) { const a = layout.buses.find((b) => b.kind === "hw"); if (a) on[a.param] = true; } // A1: your ears
      if (kind === "stream" && virt[1]) on[virt[1].param] = true;   // B2: the stream mix
      plan.push({ ch, on, isMic, isDisc });
    }
    return plan;
  }
  function paintSetupPlan() {
    const kind = setupKind(), mic = +$("#setupMic").value, disc = +$("#setupDiscord").value;
    $("#setupDiscordRow").hidden = kind !== "stream";
    const virt = layout.buses.filter((b) => b.kind === "virt");
    const ul = $("#setupPlan");
    ul.textContent = "";
    for (const p of setupRoutes(kind, mic, disc)) {
      const li = document.createElement("li");
      const sends = layout.buses.filter((b) => p.on[b.param]).map((b) => b.id);
      li.textContent = `${displayName(p.ch)}: ${sends.length ? sends.join(" ") : "nothing"}`;
      ul.appendChild(li);
    }
    if (kind === "stream" && virt.length < 2) {
      const li = document.createElement("li");
      li.className = "warn";
      li.textContent = "This Voicemeeter has only one virtual output (B1), so no separate stream mix can be made. Banana and Potato have more.";
      ul.appendChild(li);
    }
  }
  function openSetup() {
    for (const id of ["#setupMic", "#setupDiscord"]) {
      const sel = $(id); sel.textContent = "";
      for (const ch of strips()) sel.appendChild(new Option(displayName(ch), ch.i));
    }
    // Hardware strips come first; virtual ones are usually Voicemeeter VAIO/AUX, which Discord plays on.
    const virtStrips = strips().filter((c) => !isHw(c));
    $("#setupMic").value = "0";
    if (virtStrips[0]) $("#setupDiscord").value = String(virtStrips[0].i);
    paintSetupPlan();
    setupDlg.showModal();
  }
  setupDlg.addEventListener("change", paintSetupPlan);
  setupDlg.addEventListener("click", (e) => { if (e.target === setupDlg) setupDlg.close(); });
  $("#setupApply").addEventListener("click", async () => {
    await engine.backupBefore("the setup assistant").catch(() => {});
    for (const p of setupRoutes(setupKind(), +$("#setupMic").value, +$("#setupDiscord").value)) {
      for (const [param, v] of Object.entries(p.on)) sendFloat(`${p.ch.prefix}.${param}`, v ? 1 : 0);
    }
    setupDlg.close();
    toast("Routing set up");
  });

  /* ---------- mic chain (gate / compressor / denoiser) ---------- */
  const chainDlg = $("#chainDlg"), chainFill = $("#chainFill");
  const CHAIN_KNOBS = [
    ["Gate", "Noise gate", "Silences the room when you stop talking"],
    ["Comp", "Compressor", "Evens out loud and quiet speech"],
    ["Denoiser", "Denoiser", "Removes steady hiss and fan noise"],
  ];
  // Potato exposes the detail behind each knob; shown only when the probe finds it.
  const CHAIN_DETAIL = [
    ["Comp.Threshold", "Comp threshold", -40, -3, 1, " dB"],
    ["Comp.Ratio", "Comp ratio", 1, 8, 0.1, ":1"],
    ["Gate.Threshold", "Gate threshold", -60, -10, 1, " dB"],
  ];
  const CHAIN_PRESETS = {
    off: { Gate: 0, Comp: 0, Denoiser: 0 },
    gentle: { Gate: 2, Comp: 3, Denoiser: 2 },
    streamer: { Gate: 4, Comp: 5.5, Denoiser: 4, "Comp.Ratio": 3, "Comp.Threshold": -24, "Gate.Threshold": -52 },
    noisy: { Gate: 7, Comp: 5, Denoiser: 8, "Comp.Ratio": 3.5, "Comp.Threshold": -26, "Gate.Threshold": -42 },
  };
  let chainShown = -200, chainFound = {};
  const chainPrefix = () => $("#chainWhich").value;
  async function buildChain() {
    const box = $("#chainKnobs"), pre = chainPrefix();
    box.textContent = "";
    chainFound = {};
    const defs = [...CHAIN_KNOBS.map((k) => [k[0], k[1], 0, 10, 0.1, "", k[2]]), ...CHAIN_DETAIL];
    let vals = [];
    try { vals = await engine.getFloats(defs.map((d) => `${pre}.${d[0]}`)); } catch (e) { vals = []; }
    let any = false;
    defs.forEach((d, i) => {
      const v = vals[i];
      if (v == null) return;
      any = true; chainFound[d[0]] = true;
      const row = document.createElement("div");
      row.className = "field wide chain-row";
      const id = `chain_${d[0].replace(/\W/g, "_")}`;
      row.innerHTML = `<label for="${id}"></label><input type="range" id="${id}"><output></output>`;
      row.firstChild.textContent = d[1];
      if (d[6]) row.firstChild.title = d[6];
      const r = row.querySelector("input"), o = row.querySelector("output");
      r.min = d[2]; r.max = d[3]; r.step = d[4]; r.value = v;
      const show = () => { o.textContent = (d[4] < 1 ? (+r.value).toFixed(1) : Math.round(r.value)) + d[5]; };
      show();
      r.addEventListener("input", () => { show(); sendFloat(`${pre}.${d[0]}`, +r.value); });
      box.appendChild(row);
    });
    $("#chainNone").hidden = any;
    chainDlg.querySelector(".chain-presets").hidden = !any;
  }
  function openChain() {
    if (chainDlg.open) return;
    const sel = $("#chainWhich");
    sel.textContent = "";
    for (const ch of chans) if (ch.kind === "strip") sel.appendChild(new Option(displayName(ch), ch.prefix));
    sel.value = (settings.ducking && settings.ducking.trigger) || "Strip[0]";
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
    updateChainTune();
    buildChain();
    chainDlg.showModal();
  }
  function updateChainTune() {
    $("#micTuneOpen").disabled = !connected || !hwInputs().some((ch) => ch.prefix === chainPrefix());
  }
  $("#chainWhich").addEventListener("change", () => { updateChainTune(); buildChain(); });
  $("#settingsMicChain").addEventListener("click", openChain);
  chainDlg.addEventListener("click", (e) => {
    if (e.target === chainDlg) { chainDlg.close(); return; }
    const p = e.target.closest("[data-preset]");
    if (!p) return;
    const preset = CHAIN_PRESETS[p.dataset.preset], pre = chainPrefix();
    for (const [k, v] of Object.entries(preset)) {
      if (!chainFound[k]) continue;
      sendFloat(`${pre}.${k}`, v);
      const r = $(`#chain_${k.replace(/\W/g, "_")}`);
      if (r) { r.value = v; r.dispatchEvent(new Event("input")); }
    }
    toast(`Applied: ${p.textContent}`);
  });
  function chainLevels(lv) {
    const db = levelOf(lv, chainPrefix());
    chainShown = db > chainShown ? db : Math.max(db, chainShown - 2);
    chainFill.style.transform = `scaleX(${Math.max(0, Math.min(1, (chainShown + 60) / 60)).toFixed(3)})`;
  }

  const micDlg = $("#micDlg"), micFill = $("#micFill"), micResult = $("#micResult"), micStart = $("#micStart"), micApply = $("#micApply");
  const MIC_SECONDS = 8, MIC_TARGET_PEAK = -10, MIC_CEILING = -3;
  let micRun = null, micSuggest = null, micShown = -200;
  $("#micCheckBtn").addEventListener("click", () => {
    const sel = $("#micWhich");
    sel.textContent = "";
    for (const ch of chans) if (ch.kind === "strip") sel.appendChild(new Option(displayName(ch), ch.prefix));
    sel.value = (settings.ducking && settings.ducking.trigger) || "Strip[0]";
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
    micRun = null; micSuggest = null;
    micResult.textContent = "";
    micApply.hidden = true;
    micStart.textContent = "Start"; micStart.disabled = false;
    micDlg.showModal();
  });
  micDlg.addEventListener("click", (e) => { if (e.target === micDlg) micDlg.close(); });
  micDlg.addEventListener("close", () => { micRun = null; });
  $("#micWhich").addEventListener("change", () => { micRun = null; micSuggest = null; micApply.hidden = true; micResult.textContent = ""; micStart.textContent = "Start"; micStart.disabled = false; });
  micStart.addEventListener("click", () => {
    micSuggest = null; micApply.hidden = true;
    micRun = { prefix: $("#micWhich").value, until: performance.now() + MIC_SECONDS * 1000, vals: [] };
    micStart.disabled = true;
    micResult.textContent = `Listening… talk now (${MIC_SECONDS} s)`;
  });
  micApply.addEventListener("click", () => {
    if (!micSuggest) return;
    const ch = chans.find((c) => c.prefix === micSuggest.prefix);
    if (ch) glideGain(ch, ch.gain + micSuggest.delta);
    micDlg.close();
    toast(`Set ${ch ? displayName(ch) : "the channel"} to ${fmtDb(ch ? ch.gain : 0)} dB`);
  });
  // Meter and listening, one call per level update.
  function micLevels(lv) {
    const sel = micRun ? micRun.prefix : $("#micWhich").value;
    const db = levelOf(lv, sel);
    micShown = db > micShown ? db : Math.max(db, micShown - 2);
    micFill.style.transform = `scaleX(${Math.max(0, Math.min(1, (micShown + 60) / 60)).toFixed(3)})`;
    if (!micRun) return;
    micRun.vals.push(db);
    const left = micRun.until - performance.now();
    if (left > 0) { micResult.textContent = `Listening… talk now (${Math.ceil(left / 1000)} s)`; return; }
    finishMic();
  }
  function finishMic() {
    const run = micRun; micRun = null;
    micStart.disabled = false; micStart.textContent = "Try again";
    const heard = run.vals.filter((v) => v > -50).sort((a, b) => a - b);
    const ch = chans.find((c) => c.prefix === run.prefix);
    if (!ch) return;
    if (heard.length < 10) {
      micResult.textContent = "I couldn't hear anything. Is the mic muted, the wrong channel picked, or too quiet to register? Try again after checking.";
      return;
    }
    const p95 = heard[Math.floor(heard.length * 0.95)], top = heard[heard.length - 1];
    // Fine when speech peaks between -14 and -7 dB and nothing touches -3; otherwise move toward -10.
    let delta = 0;
    if (top > MIC_CEILING || p95 > -7) delta = Math.min(MIC_TARGET_PEAK - p95, MIC_CEILING - top);
    else if (p95 < -14) delta = Math.min(MIC_TARGET_PEAK - p95, MIC_CEILING - top);
    delta = Math.round(Math.max(-24, Math.min(24, delta)) * 2) / 2;
    const f = (v) => `${fmtDb(Math.round(v * 10) / 10)} dB`;
    const next = Math.max(MIN_DB, Math.min(MAX_DB, ch.gain + delta));
    micSuggest = { prefix: run.prefix, delta: next - ch.gain };
    if (Math.abs(delta) < 1) {
      micResult.innerHTML = `<b>That's about right.</b> Your voice peaks around ${f(p95)} and your loudest moment was ${f(top)}, so there's room for a laugh or a jump scare. No change needed.`;
      micSuggest = null;
    } else if (delta < 0) {
      micResult.innerHTML = `<b>A bit hot.</b> Your voice peaks around ${f(p95)} and your loudest moment reached ${f(top)}, close to distorting. Turn it down ${Math.abs(delta)} dB (${f(ch.gain)} → ${f(next)}).`;
      micApply.hidden = false;
    } else {
      micResult.innerHTML = `<b>A bit quiet.</b> Your voice peaks around ${f(p95)}. Turn it up ${delta} dB (${f(ch.gain)} → ${f(next)}) so viewers don't have to.`;
      micApply.hidden = false;
    }
  }

  /* ---------- mic tune-up wizard ---------- */
  const tuneDlg = $("#micTuneDlg"), tuneInput = $("#micTuneInput"), tuneStatus = $("#micTuneStatus");
  const tuneMeasure = $("#micTuneMeasure"), tuneApply = $("#micTuneApply"), tunePreview = $("#micTunePreview");
  const tuneRestore = $("#micTuneRestore"), tuneGain = $("#micTuneGain"), tuneGate = $("#micTuneGate");
  const tuneStages = [
    { label: "room tone", prompt: "Stay quiet and leave the room as it normally sounds.", secs: 3 },
    { label: "normal speech", prompt: "Speak at your normal distance and volume.", secs: 5 },
    { label: "a loud phrase", prompt: "Say a phrase as loudly as you might during a stream.", secs: 3 },
  ];
  let tuning = null, tuneBusy = false, tunePreviewing = false, tuneGeneration = 0;
  const tuneDb = (n) => n <= -100 ? "Below meter range" : `${n.toFixed(1)} dBFS`;
  const percentile = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * p)];
  };
  function setTuneStatus(text) { if (tuneStatus.textContent !== text) tuneStatus.textContent = text; }
  function paintMicTune() {
    const step = tuning?.stages.length || 0, result = tuning?.result;
    const selected = (result?.gain != null && tuneGain.checked) || (result?.gate != null && tuneGate.checked);
    tuneInput.disabled = tuneBusy || tunePreviewing;
    tuneMeasure.hidden = tunePreviewing;
    tuneMeasure.disabled = tuneBusy || !tuneInput.value;
    tuneMeasure.textContent = step >= 3 ? "Measure again" : `Measure ${tuneStages[step].label}`;
    tunePreview.hidden = !result || tunePreviewing;
    tunePreview.disabled = tuneBusy || !selected;
    tuneRestore.hidden = !tunePreviewing;
    tuneRestore.disabled = tuneBusy;
    tuneApply.hidden = !result;
    tuneApply.disabled = tuneBusy || !selected;
    tuneApply.textContent = tunePreviewing ? "Keep preview settings" : "Apply selected settings";
    tuneGain.disabled = tuneGate.disabled = tuneBusy || tunePreviewing;
    document.querySelectorAll(".mic-tune-steps li").forEach((li, i) => {
      if (step === i) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
  }
  function resetMicTune() {
    clearTimeout(tuning?.run?.timer);
    tuning = null;
    $("#micTuneReadings").hidden = true;
    $("#micTuneOptions").hidden = true;
    $("#micTuneFill").style.transform = "scaleX(0)";
    setTuneStatus(tuneStages[0].prompt);
    paintMicTune();
  }
  function openMicTune(preferred) {
    if (!connected) return toast("Start Voicemeeter to tune a microphone");
    if (tuneDlg.open) return;
    const inputs = hwInputs();
    tuneInput.replaceChildren(...inputs.map((ch) => new Option(displayName(ch), ch.prefix)));
    const target = preferred || settings.ducking?.trigger;
    if (inputs.some((ch) => ch.prefix === target)) tuneInput.value = target;
    tuneDlg.showModal();
    resetMicTune();
    tuneInput.focus();
  }
  function completeTuneMeasurements() {
    const { stages, baseline } = tuning;
    const [room, speech, loud] = stages;
    const roomDb = percentile(room.pre, .9), talking = speech.pre.filter((v) => v > Math.max(-85, roomDb + 4));
    const loudSpeech = loud.pre.filter((v) => v > Math.max(-85, roomDb + 4));
    const normal = percentile(speech.post.filter((_, i) => speech.pre[i] > Math.max(-85, roomDb + 4)), .9);
    const loudest = Math.max(...loud.post), prePeak = Math.max(...loud.pre, ...speech.pre);
    const readings = $("#micTuneReadings");
    readings.replaceChildren(...[["Room tone before fader", roomDb], ["Speech after fader", normal], ["Loud peak after fader", loudest]].flatMap(([label, value]) => [
      Object.assign(document.createElement("dt"), { textContent: label }),
      Object.assign(document.createElement("dd"), { textContent: Number.isFinite(value) ? tuneDb(value) : "No usable speech" }),
    ]));
    readings.hidden = false;
    if (talking.length < 10 || loudSpeech.length < 5) {
      setTuneStatus("The speech did not stand out from the room tone. Check the input and measure again.");
      return;
    }
    if (prePeak >= -.5) {
      setTuneStatus("The input is reaching full scale. Lower the mic or interface gain, then measure again.");
      return;
    }
    const loudPeak = Math.max(loudest, ...speech.post);
    const correction = Math.max(-18, Math.min(18, -14 - normal, -3 - loudPeak));
    const gain = Math.max(MIN_DB, Math.min(MAX_DB, Math.round((baseline.gain + correction) * 2) / 2));
    const threshold = Math.max(-60, Math.min(-10, Math.ceil(roomDb + 6)));
    const separation = percentile(talking, .25) - threshold;
    const gate = Number.isFinite(baseline.gate) && baseline.gate < .1 && roomDb >= -62 && separation >= 8;
    const result = { gain: Math.abs(gain - baseline.gain) >= .5 ? gain : null,
      gate: gate ? 2 : null, threshold: gate && Number.isFinite(baseline.threshold) ? threshold : null };
    if (result.gain == null && result.gate == null) {
      setTuneStatus("The current level has useful headroom. No gate change is suggested for this take.");
      return;
    }
    tuning.result = result;
    tuneGain.checked = result.gain != null;
    tuneGate.checked = result.gate != null;
    $("#micTuneGainRow").hidden = !tuneGain.checked;
    $("#micTuneGateRow").hidden = !tuneGate.checked;
    $("#micTuneGainText").textContent = `Fader ${fmtDb(baseline.gain)} → ${fmtDb(gain)} dB`;
    $("#micTuneGateText").textContent = result.threshold == null ? "Gentle noise gate · 2.0" :
      `Gentle noise gate · 2.0 with a ${threshold} dB threshold`;
    $("#micTuneNote").textContent = gate ? "Check that the preview keeps the starts and ends of quiet words." :
      baseline.gate > .1 ? "This input already has a gate. The wizard is suggesting a fader change only." : "The take did not call for a gate change.";
    $("#micTuneOptions").hidden = false;
    setTuneStatus("Choose which changes to preview or apply.");
  }
  function micTuneLevels(lv) {
    if (tunePreviewing && tuning) {
      const level = levelOf(lv, tuning.ch.prefix);
      $("#micTuneFill").style.transform = `scaleX(${Math.max(0, Math.min(1, (level + 60) / 60)).toFixed(3)})`;
      return;
    }
    const sample = lv.micTune, run = tuning?.run;
    if (!sample || !run || sample.strip !== tuning.ch.i || !Number.isFinite(sample.pre)) return;
    const post = sample.post ?? levelOf(lv, tuning.ch.prefix);
    if (!Number.isFinite(post)) return;
    $("#micTuneFill").style.transform = `scaleX(${Math.max(0, Math.min(1, (sample.pre + 60) / 60)).toFixed(3)})`;
    const now = performance.now();
    if (now >= run.start + 300) { run.pre.push(sample.pre); run.post.push(post); }
    const left = Math.max(1, Math.ceil((run.end - now) / 1000));
    setTuneStatus(`${tuneStages[tuning.stages.length].prompt} · ${left}s`);
  }
  tuneMeasure.addEventListener("click", async () => {
    if (tuneBusy || tunePreviewing) return;
    if (tuning?.stages.length >= 3) resetMicTune();
    const ch = chans.find((c) => c.prefix === tuneInput.value && isHw(c));
    if (!ch || !connected) return setTuneStatus("Choose a connected hardware input.");
    if (gainScope(ch) >= 0) return setTuneStatus("Set Faders set to All outputs before measuring.");
    if (ch.data?.ducked) return setTuneStatus("Wait until talk-over ducking has released this input.");
    const generation = tuneGeneration;
    tuneBusy = true;
    paintMicTune();
    try {
      if (!tuning) {
        const [gain, gate, threshold] = await engine.getFloats(["Gain", "Gate", "Gate.Threshold"].map((f) => `${ch.prefix}.${f}`));
        if (!Number.isFinite(gain)) throw new Error("Could not read this input’s fader.");
        if (generation !== tuneGeneration) return;
        tuning = { ch, baseline: { gain, gate, threshold }, stages: [] };
      }
      const step = tuning.stages.length, stage = tuneStages[step];
      await engine.micTuneMeter(ch.i, step);
      if (generation !== tuneGeneration) { await engine.micTuneMeter(null); return; }
      const start = performance.now();
      const run = { start, end: start + stage.secs * 1000, pre: [], post: [], timer: null };
      tuning.run = run;
      setTuneStatus(`${stage.prompt} · ${stage.secs}s`);
      run.timer = setTimeout(async () => {
        tuning.run = null;
        await engine.micTuneMeter(null).catch(fail);
        if (generation !== tuneGeneration) return;
        tuneBusy = false;
        if (!connected || !chans.includes(ch) || ch.data?.ducked || gainScope(ch) >= 0 || run.pre.length < 12) {
          setTuneStatus("Meter readings were interrupted. Measure this step again.");
        } else {
          tuning.stages.push(run);
          if (tuning.stages.length === 3) completeTuneMeasurements();
          else setTuneStatus(tuneStages[tuning.stages.length].prompt);
        }
        paintMicTune();
      }, stage.secs * 1000);
    } catch (e) {
      if (generation === tuneGeneration) { tuneBusy = false; setTuneStatus(String(e)); paintMicTune(); }
    }
  });
  async function changeMicTune(preview) {
    const result = tuning?.result;
    if (!result || tuneBusy) return;
    const generation = tuneGeneration;
    tuneBusy = true;
    paintMicTune();
    try {
      if (!chans.includes(tuning.ch) || !connected) throw new Error("The input changed. Run the tune-up again.");
      if (tunePreviewing) {
        if (!await engine.micTuneFinish(true)) {
          tunePreviewing = false;
          throw new Error("The preview ended or the input changed. Review the result before applying.");
        }
      } else {
        const next = { gain: tuneGain.checked ? result.gain : null, gate: tuneGate.checked ? result.gate : null,
          threshold: tuneGate.checked ? result.threshold : null };
        await engine.micTuneChange(tuning.ch.i, tuning.baseline, next, preview);
      }
      if (generation !== tuneGeneration) {
        if (preview) await engine.micTuneFinish(false);
        return;
      }
      tunePreviewing = preview;
      if (preview) setTuneStatus(tuning.ch.data?.mute
        ? "Preview active for eight seconds. This input is muted in the mixer."
        : "Preview active for eight seconds. Listen on your current monitor mix.");
      else { tuneDlg.close(); toast("Mic tune-up applied"); }
    } catch (e) { if (generation === tuneGeneration) setTuneStatus(String(e)); }
    finally { if (generation === tuneGeneration) { tuneBusy = false; paintMicTune(); } }
  }
  tunePreview.addEventListener("click", () => changeMicTune(true));
  tuneApply.addEventListener("click", () => changeMicTune(false));
  tuneRestore.addEventListener("click", async () => {
    tuneBusy = true; paintMicTune();
    try { await engine.micTuneFinish(false); tunePreviewing = false; setTuneStatus("Preview ended. Previous settings restored."); }
    catch (e) { setTuneStatus(String(e)); }
    finally { tuneBusy = false; paintMicTune(); }
  });
  tuneGain.addEventListener("change", paintMicTune);
  tuneGate.addEventListener("change", paintMicTune);
  tuneInput.addEventListener("change", resetMicTune);
  tuneDlg.addEventListener("close", () => {
    tuneGeneration++;
    if (tuning?.run || tuneBusy) engine.micTuneMeter(null).catch(fail);
    if (tunePreviewing) engine.micTuneFinish(false).catch(fail);
    tuneBusy = tunePreviewing = false;
    resetMicTune();
    if (chainDlg.open) buildChain();
  });
  if (!SIDE) engine.onMicTuneEnded((error) => {
    if (!tuneDlg.open || !tunePreviewing) return;
    tunePreviewing = false;
    setTuneStatus(error || "Preview ended. Previous settings restored.");
    paintMicTune();
  }).catch(() => {});
  $("#micTuneOpen").addEventListener("click", () => openMicTune(chainPrefix()));

  /* ---------- check my setup ---------- */
  /* ---------- Windows sound output ---------- */
  const fixAudioBtn = $("#fixAudioBtn");
  function paintWindowsOutput(s) {
    const wrong = !!s && s.state === "wrong";
    fixAudioBtn.hidden = !wrong;
    $("#status").dataset.audioWarning = String(wrong);
    if (wrong) fixAudioBtn.title = `Windows is sending sound to ${s.output}, not Voicemeeter, so the mixer can't hear your apps`;
    if (s && s.fixed) toast(`Windows switched sound to ${s.from}, so Sleekmeeter put it back on ${s.target}`);
  }
  async function fixAudio() {
    fixAudioBtn.disabled = true;
    try {
      const r = await engine.fixAudio();
      const parts = [r.moved ? `Windows sound is back on ${r.moved}` : "Windows sound was already on Voicemeeter", r.restarted ? "the audio engine restarted" : ""];
      toast(parts.filter(Boolean).join(", and "));
      paintWindowsOutput(await engine.windowsOutput());
    } catch (err) { fail(err); }
    fixAudioBtn.disabled = false;
  }
  fixAudioBtn.addEventListener("click", fixAudio);
  const healthDlg = $("#healthDlg");
  async function runHealth() {
    const list = $("#healthList");
    list.textContent = "";
    list.appendChild(Object.assign(document.createElement("li"), { className: "busy", textContent: "Checking…" }));
    let items;
    try { items = await engine.healthCheck(); } catch (e) { items = [{ state: "bad", label: "Setup check", detail: String(e && e.message ? e.message : e) }]; }
    list.textContent = "";
    for (const it of items) {
      const li = document.createElement("li");
      li.dataset.state = it.state;
      const mark = Object.assign(document.createElement("span"), { className: "mark", textContent: it.state === "ok" ? "✓" : it.state === "warn" ? "!" : "×" });
      const body = document.createElement("div");
      body.append(Object.assign(document.createElement("b"), { textContent: it.label }), Object.assign(document.createElement("span"), { className: "detail", textContent: it.detail }));
      if (it.action === "fixAudio") {
        const fix = Object.assign(document.createElement("button"), { className: "btn primary", type: "button", textContent: "Fix my audio" });
        fix.addEventListener("click", async () => { fix.disabled = true; await fixAudio(); runHealth(); });
        body.appendChild(fix);
      }
      li.append(mark, body);
      list.appendChild(li);
    }
  }
  const openHealth = () => { if (!healthDlg.open) healthDlg.showModal(); runHealth(); };
  $("#openHealth").addEventListener("click", openHealth);
  $("#status").addEventListener("click", openHealth);
  $("#healthAgain").addEventListener("click", runHealth);
  $("#offlineHealth").addEventListener("click", openHealth);
  healthDlg.addEventListener("click", (e) => { if (e.target === healthDlg) healthDlg.close(); });

  /* ---------- backup and layout ---------- */
  async function renderBackups() {
    const list = $("#backupList");
    const items = await engine.backupsList().catch(() => []);
    list.textContent = "";
    if (!items.length) {
      list.appendChild(Object.assign(document.createElement("li"), { className: "empty", textContent: "No backups yet. The first one is saved a minute or two after Sleekmeeter connects to Voicemeeter." }));
      return;
    }
    for (const b of items) {
      const li = document.createElement("li");
      const restore = Object.assign(document.createElement("button"), { className: "btn", type: "button", textContent: "Restore" });
      restore.addEventListener("click", async () => {
        if (!confirm(`Put back Voicemeeter's setup from ${b.label}? Your current setup is saved first, so you can undo this.`)) return;
        try { await engine.backupRestore(b.file); toast(`Restored Voicemeeter's setup from ${b.label}`); renderBackups(); } catch (err) { fail(err); }
      });
      li.append(Object.assign(document.createElement("span"), { textContent: b.label }), restore);
      list.appendChild(li);
    }
  }
  $("#exportSettings").addEventListener("click", async () => {
    try { const p = await engine.settingsExport(); if (p) toast("Saved your settings"); } catch (e) { fail(e); }
  });
  $("#importSettings").addEventListener("click", async () => {
    try {
      const p = await engine.settingsImport();
      if (!p) return;
      toast("Restored your settings");
      setTimeout(() => location.reload(), 700);
    } catch (e) { fail(e); }
  });
  $("#resetLayout").addEventListener("click", async () => {
    try {
      if (settings.mini) { setMini(false, false); await new Promise((r) => setTimeout(r, 450)); }
      for (const k of Object.keys(settings.appearance || {})) if (settings.appearance[k]) settings.appearance[k].hidden = false;
      settings.mini = false; settings.panelDocked = true;
      saveSettings();
      await engine.resetLayout();
      chans.forEach(paintLook);
      applyVisibility();
      syncChecks();
      toast("Layout reset");
    } catch (e) { fail(e); }
  });

  /* ---------- Quick Actions ---------- */
  const obsAudioDlg = $("#obsAudioDlg"), obsAudioRefresh = $("#obsAudioRefresh");
  async function checkObsAudio() {
    if (obsAudioRefresh.disabled) return;
    const status = $("#obsAudioStatus"), warnings = $("#obsAudioWarnings"), list = $("#obsAudioSources");
    warnings.replaceChildren(); list.replaceChildren();
    obsAudioRefresh.disabled = true;
    status.textContent = "Reading OBS audio sources and tracks…";
    const item = (text) => Object.assign(document.createElement("li"), { textContent: text });
    try {
      const report = await engine.obsAudioCheck();
      const sources = report.sources || [];
      const active = sources.filter((source) => source.active !== false && !source.mute);
      const track = (n) => n ? `track ${n}` : "unavailable";
      status.textContent = `Live ${track(report.live)} · VOD ${report.vod ? track(report.vod) : "off or unavailable"} · Recording ${report.recording?.length ? report.recording.join(", ") : "unavailable"}`;
      if (report.limited) warnings.append(item("Showing the first 120 OBS sources."));
      if (report.live && !active.some((source) => source.tracks.includes(report.live))) warnings.append(item("No active unmuted source was found on the live track."));
      if (report.vod && !active.some((source) => source.tracks.includes(report.vod))) warnings.append(item("No active unmuted source was found on the VOD track."));
      const vmCapture = (s) => /voicemeeter.*(?:out|output)|vaio3 output/i.test(`${s.deviceName || ""} ${s.name}`);
      const renderCapture = (s) => s.kind === "wasapi_output_capture";
      const overlap = (a, b) => a.tracks.filter((n) => b.tracks.includes(n));
      let duplicates = 0;
      for (const [i, a] of active.entries()) for (const b of active.slice(i + 1)) {
        const tracks = overlap(a, b);
        if (!tracks.length) continue;
        const same = a.device && a.kind === b.kind && a.device.toLowerCase() === b.device?.toLowerCase();
        const potential = (vmCapture(a) && renderCapture(b)) || (vmCapture(b) && renderCapture(a));
        if ((same || potential) && ++duplicates <= 12) warnings.append(item(`${same ? "Duplicate device" : "Possible double capture"} · ${a.name} and ${b.name} share track${tracks.length > 1 ? "s" : ""} ${tracks.join(", ")}.`));
      }
      if (duplicates > 12) warnings.append(item(`${duplicates - 12} more source pairs share a capture device or overlapping mix.`));
      const roleOf = (s) => vmCapture(s) ? "Voicemeeter mix" : /discord|chat|comms/i.test(s.name) ? "Chat"
        : /game/i.test(s.name) ? "Game" : /mic/i.test(s.name) ? "Mic" : renderCapture(s) ? "Desktop" : "";
      list.replaceChildren(...sources.map((s) => item([
        s.name, roleOf(s), s.deviceName, s.tracks.length ? `Tracks ${s.tracks.join(", ")}` : "No tracks",
        s.mute ? "Muted" : s.active === false ? "Inactive" : "",
      ].filter(Boolean).join(" · "))));
      if (!sources.length) list.append(item("OBS did not report any audio sources."));
    } catch (e) { status.textContent = String(e); }
    finally { obsAudioRefresh.disabled = false; }
  }
  function openObsAudio() {
    if (obsAudioDlg.open) return;
    obsAudioDlg.showModal();
    checkObsAudio();
  }
  $("#obsAudioOpen").addEventListener("click", openObsAudio);
  obsAudioRefresh.addEventListener("click", checkObsAudio);

  const quickDlg = $("#quickDlg"), quickSearch = $("#quickSearch"), quickList = $("#quickResults");
  let quickItems = [], quickMatches = [], quickSelected = 0, quickGeneration = 0;
  function focusSetting(card) {
    openSettings(card.el.dataset.settingsCategory);
    if (card.detail) card.detail.open = true;
    const head = card.detail?.querySelector("summary") || card.el.querySelector("h3");
    if (head && head.tagName !== "SUMMARY") head.tabIndex = -1;
    head?.focus({ preventScroll: true });
    requestAnimationFrame(() => card.el.scrollIntoView({ block: "start" }));
  }
  function quickActions() {
    const button = (id) => () => $(`#${id}`).click();
    const actions = [
      ["Check my setup", "Tools", "health diagnostics fix audio", openHealth],
      ["Audio Event History", "Tools", "timeline log fallback device plugin quarantine", openAudioEvents],
      ["OBS audio tracks", "Tools", "stream vod recording duplicate desktop capture", openObsAudio],
      ["Game / Chat balance", "Tools", "chatmix discord headset", openBalance],
      ["Mic Chain", "Tools", "microphone tune-up wizard calibration room tone gate gain compressor denoiser", openChain],
      ["Apps · Volumes", "Tools", "windows application mixer per-app volume", () => openAppVolumes()],
      ["Apps · Audio Flow", "Tools", "route inspector guided audio test", () => openAppVolumes("flow")],
      ["Outputs", "Tools", "headphones speakers profiles", button("outputsBtn")],
      ["Scenes", "Tools", "mix setup presets", button("scenesBtn")],
      ["Settings", "Tools", "preferences options", () => { openSettings(); settingsSearch.focus(); }],
      [settings.simpleMode ? "Restore full mixer" : "Turn on Focused mixer", "Tools", "simple mode layout routing", () => setSimple(!settings.simpleMode)],
    ];
    if (connected) {
      actions.push(["Listen to a mix", "Tools", "monitor stream headphones audition", openMonitor]);
      for (const ch of chans) actions.push([displayName(ch), "Channel", `${ch.info.id || ""} ${ch.kind === "strip" ? "input" : "output"} ${ch.data?.device || ""}`, () => {
        if (settings.mini) setMini(false, true);
        openDrawer(ch);
      }]);
      for (const p of profiles()) actions.push([`Switch outputs to ${p.name}`, "Output profile", p.name, () => applyProfile(p.name)]);
    }
    for (const card of settingsCards) {
      if (card.el.hidden) continue;
      const label = card.el.querySelector("h3")?.textContent;
      if (label) actions.push([label, "Setting", card.text, () => focusSetting(card)]);
    }
    return actions;
  }
  function paintQuickSelection(scroll = false) {
    const selected = quickList.children[quickSelected];
    [...quickList.children].forEach((el, i) => el.setAttribute("aria-selected", String(i === quickSelected)));
    if (selected) {
      quickSearch.setAttribute("aria-activedescendant", selected.id);
      if (scroll) selected.scrollIntoView({ block: "nearest" });
    } else quickSearch.removeAttribute("aria-activedescendant");
  }
  function renderQuickActions() {
    const query = quickSearch.value.trim().toLowerCase(), words = query.split(/\s+/);
    const previous = quickMatches[quickSelected];
    quickMatches = quickItems.map((entry) => {
      const [name, group, terms] = entry, title = name.toLowerCase();
      const haystack = `${title} ${group.toLowerCase()} ${terms.toLowerCase()}`;
      const score = !query ? 0 : words.every((word) => haystack.includes(word))
        ? title === query ? 4 : title.startsWith(query) ? 3 : title.includes(query) ? 2 : 1 : -1;
      return { entry, score };
    }).filter(({ score }) => score >= 0).sort((a, b) => b.score - a.score).slice(0, 20).map(({ entry }) => entry);
    quickSelected = Math.max(0, quickMatches.indexOf(previous));
    quickList.replaceChildren(...quickMatches.map(([name, group], i) => {
      const el = Object.assign(document.createElement("li"), { id: `quick-result-${i}`, textContent: name });
      el.setAttribute("role", "option");
      el.append(Object.assign(document.createElement("small"), { textContent: group }));
      el.addEventListener("mousedown", (e) => e.preventDefault());
      el.addEventListener("click", () => runQuickAction(i));
      return el;
    }));
    $("#quickEmpty").hidden = quickMatches.length > 0;
    paintQuickSelection();
  }
  function runQuickAction(i) {
    const action = quickMatches[i]?.[3];
    if (!action) return;
    quickDlg.close();
    action();
  }
  function openQuickActions() {
    if (SIDE || quickDlg.open || document.querySelector("dialog[open]")) return;
    setMenu(false);
    setStreamMenu(false);
    const generation = ++quickGeneration;
    quickItems = quickActions();
    quickMatches = [];
    quickSelected = 0;
    quickSearch.value = "";
    quickDlg.showModal();
    renderQuickActions();
    quickSearch.focus();
    engine.listScenes().then((names) => {
      if (!quickDlg.open || generation !== quickGeneration) return;
      quickItems.splice(9, 0, ...names.map((name) => [name, "Scene", "load preview scene", () => {
        $("#scenesBtn").click();
        openScenePreview(name);
      }]));
      renderQuickActions();
    }).catch(() => {});
  }
  quickSearch.addEventListener("input", () => { quickMatches = []; renderQuickActions(); });
  quickSearch.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") { e.preventDefault(); runQuickAction(quickSelected); }
    if (!quickMatches.length || !["ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    quickSelected = (quickSelected + (e.key === "ArrowDown" ? 1 : -1) + quickMatches.length) % quickMatches.length;
    paintQuickSelection(true);
  });
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || !e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || e.key.toLowerCase() !== "k") return;
    if (SIDE || document.querySelector("dialog[open]") || settings.hotkeys?.some((h) => h.keys?.toLowerCase() === "ctrl+k")) return;
    e.preventDefault();
    openQuickActions();
  });

  /* ---------- Audio Event History ---------- */
  const audioEventsDlg = $("#audioEventsDlg"), eventList = $("#audioEventList"), eventFilter = $("#audioEventFilter");
  const eventConfirm = $("#audioEventConfirm"), eventStatus = $("#audioEventStatus");
  const eventDates = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
  let audioEvents = [], eventRequest = 0;
  function showAudioEvent(e) {
    audioEventsDlg.close();
    if (e.kind === "fallback") openOutputFallback(Number(e.target));
    else if (e.kind === "plugin") {
      const ch = chans.find((c) => c.prefix === e.target && isHw(c));
      if (ch && settings.micFx?.chains?.some((c) => c.target === ch.prefix)) openInputEffects(ch);
      else openSettings("microphone");
    } else if (e.kind === "routing") {
      routeInspectTarget = e.target;
      openAppVolumes("flow");
      const inspector = $("#routeInspector");
      inspector.open = true;
      requestAnimationFrame(() => inspector.scrollIntoView({ block: "nearest" }));
    } else openHealth();
  }
  function renderAudioEvents() {
    const selected = eventFilter.value;
    const shown = audioEvents.filter((e) => !selected || e.kind === selected);
    eventList.replaceChildren(...shown.map((event) => {
      const li = document.createElement("li"), b = Object.assign(document.createElement("button"), { type: "button", className: "audio-event" });
      b.append(Object.assign(document.createElement("strong"), { textContent: event.title }),
        Object.assign(document.createElement("small"), { textContent: event.detail }),
        Object.assign(document.createElement("time"), { textContent: eventDates.format(new Date(event.at)) }));
      b.addEventListener("click", () => showAudioEvent(event));
      li.append(b);
      return li;
    }));
    $("#audioEventClear").disabled = !audioEvents.length;
    eventStatus.textContent = shown.length ? `${shown.length} ${shown.length === 1 ? "event" : "events"}` :
      selected ? "No events in this category." : "No audio events recorded yet.";
  }
  async function refreshAudioEvents() {
    if (!audioEventsDlg.open) return;
    const request = ++eventRequest;
    try {
      const latest = await engine.audioEvents();
      if (!audioEventsDlg.open || request !== eventRequest) return;
      audioEvents = latest.filter((e) => Number.isFinite(e.at) && !Number.isNaN(new Date(e.at).getTime()));
      renderAudioEvents();
    } catch (e) { if (request === eventRequest) eventStatus.textContent = String(e); }
  }
  function openAudioEvents() {
    if (audioEventsDlg.open) return;
    eventList.replaceChildren();
    eventStatus.textContent = "Reading audio events…";
    $("#audioEventClear").disabled = true;
    eventConfirm.hidden = true;
    audioEventsDlg.showModal();
    refreshAudioEvents();
  }
  $("#healthEvents").addEventListener("click", () => { healthDlg.close(); openAudioEvents(); });
  eventFilter.addEventListener("change", renderAudioEvents);
  $("#audioEventClear").addEventListener("click", () => { eventConfirm.hidden = false; $("#audioEventCancel").focus(); });
  $("#audioEventCancel").addEventListener("click", () => { eventConfirm.hidden = true; $("#audioEventClear").focus(); });
  $("#audioEventDelete").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try { await engine.clearAudioEvents(); eventConfirm.hidden = true; eventFilter.focus(); refreshAudioEvents(); }
    catch (err) { eventStatus.textContent = String(err); }
    finally { b.disabled = false; }
  });
  if (!SIDE) engine.onAudioEventsChanged(refreshAudioEvents).catch(() => {});

  /* ---------- start ---------- */
  // Pure black for OLED screens (Settings → Appearance).
  /* ---------- themes (Settings → Appearance) ---------- */
  // Each theme is a set of colour and material tokens in themes.css, keyed by data-theme.
  const THEMES = [
    // Dark first: the default desk, then deeper and more atmospheric, then retro; light and playful last.
    ["console", "Console", "Dark hardware desk with amber light"],
    ["oled", "OLED black", "Pure black with high-contrast controls"],
    ["glass", "Glass", "Iridescent glass panels, pearl faders and a drifting aurora"],
    ["hadal", "Hadal", "Deep blue panels, cyan faders and drifting sonar rings"],
    ["hyrule", "Kokiri Forest", "Dark forest panels, drifting fairies, and Hylian Shield faders"],
    ["neon", "Neon", "Dark synth night with glowing outlines"],
    ["terminal", "Terminal", "Green phosphor, monospace, square corners"],
    ["arcade", "Arcade", "8-bit cabinet with pixel corners and bright colours"],
    ["block", "Block", "Thick outlines, hard shadows and bright colour blocks"],
    ["sticker", "Sticker Bomb", "Tilted die-cut stickers on notebook paper, starburst faders"],
    ["bubblegum", "Bubblegum", "Pink, sparkly and cute, with heart faders and emoji icons"],
    ["peach", "Peaches & Cream", "Warm pastels, peach faders, heart meters and scalloped cards"],
  ];
  // Before themes there was only "Pure black for OLED" (settings.oled).
  // Retired themes fall back to Console.
  const RETIRED = {
    midnight: "console", minimal: "console", clean: "console", analog: "console", studio: "console",
    ink: "console", deco: "console", haunted: "console", cosmic: "console", rack: "console",
    titanium: "console", afterburner: "console", opal: "console", onyx: "console",
    afterhours: "console", caldera: "console", blueprint: "console",
    letterpress: "console", eventhorizon: "console", lunar: "console",
  };
  const currentTheme = () => {
    const t = RETIRED[settings.theme] || settings.theme;
    return THEMES.some((x) => x[0] === t) ? t : settings.oled ? "oled" : "console";
  };
  let autoTheme = "";
  const themeMotion = () => ["off", "subtle", "full"].includes(settings.themeMotion) ? settings.themeMotion : "full";
  $("#themeMotion").addEventListener("change", (e) => {
    settings.themeMotion = e.target.value;
    document.body.dataset.themeMotion = themeMotion();
    saveSettings();
  });
  function applyTheme() {
    document.body.dataset.theme = RETIRED[autoTheme] || autoTheme || currentTheme();
    document.body.dataset.themeMotion = themeMotion();
    // Fonts and spacing change with the theme, so strips must be re-sized to their names.
    lastSizes = "";
    requestAnimationFrame(() => sizeToNames());
  }
  function renderThemes() {
    $("#themeMotion").value = themeMotion();
    const grid = $("#themePicker");
    if (!grid.childElementCount) {
      for (const [id, name, about] of THEMES) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "theme-card"; b.dataset.theme = id; b.dataset.color = "amber";
        b.setAttribute("role", "radio");
        b.title = about;
        // A tiny desk in the theme's own colours: two modules with keys, meters and caps.
        const mod = (lit) => `<span class="tc-mod"><span class="tc-keys"><i class="${lit ? "on a" : ""}"></i><i class="${lit ? "" : "on b"}"></i></span>`
          + `<span class="tc-fader"><span class="tc-well"><b style="height:${lit ? 62 : 44}%"></b></span><span class="tc-slot"><span class="tc-cap" style="bottom:${lit ? 52 : 34}%"></span></span></span>`
          + `<span class="tc-mute${lit ? "" : " on"}"></span></span>`;
        b.innerHTML = `<span class="tc-desk">${mod(true)}${mod(false)}</span><span class="tc-name">${name}</span><span class="tc-about">${about}</span>`;
        b.addEventListener("click", () => {
          settings.theme = id;
          settings.oled = id === "oled"; // older versions read this
          applyTheme();
          renderThemes();
          saveSettings();
        });
        grid.appendChild(b);
      }
    }
    const cur = currentTheme();
    const cards = [...grid.querySelectorAll(".theme-card")];
    cards.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.theme === cur)));
    // Closed: show three (the one in use plus the first others); the button shows the rest.
    const keep = new Set([cur]);
    for (const b of cards) if (keep.size < 3) keep.add(b.dataset.theme);
    cards.forEach((b) => { b.hidden = !themesOpen && !keep.has(b.dataset.theme); });
    const more = $("#themeMore");
    more.setAttribute("aria-expanded", String(themesOpen));
    $("#themeMoreText").textContent = themesOpen ? "Show fewer themes" : `Show all ${cards.length} themes (${cards.length - 3} more)`;
    if (!more.dataset.bound) {
      more.dataset.bound = "1";
      more.addEventListener("click", () => { themesOpen = !themesOpen; renderThemes(); });
    }
  }
  let themesOpen = false;

  /* ---------- the app's own title bar buttons (the window has no Windows frame) ---------- */
  function setupWindowChrome() {
    const api = window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow
      ? window.__TAURI__.window.getCurrentWindow() : null;
    const preview = /[?&]chrome\b/.test(location.search); // the browser preview can show them too
    if (PANEL || !((api && api.label === "main") || preview)) return;
    document.body.classList.add("custom-chrome");
    $("#winctl").hidden = false;
    const run = (name) => { if (api) Promise.resolve(api[name]()).catch(() => {}); };
    $("#wcMin").addEventListener("click", () => run("minimize"));
    $("#wcMax").addEventListener("click", () => run("toggleMaximize"));
    $("#wcClose").addEventListener("click", () => run("close"));
    // Drag the window by the top bar; double-click it to maximise or restore.
    $(".bar").addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest("button, input, select, a, .menu, label")) return;
      if (e.detail === 2) { if (!settings.mini) run("toggleMaximize"); return; }
      run("startDragging");
    });
    if (api && api.onResized) {
      let t = 0;
      const sync = () => Promise.resolve(api.isMaximized()).then((m) => {
        document.body.classList.toggle("maxed", !!m);
        $("#wcMax").title = $("#wcMax").ariaLabel = m ? "Restore" : "Maximise";
      }).catch(() => {});
      api.onResized(() => { clearTimeout(t); t = setTimeout(sync, 120); }).catch(() => {});
      sync();
    }
  }

  async function init() {
    await loadSettings();
    setupWindowChrome();
    applyTheme();
    buildChannels(settings.edition || 2);
    applyTray();
    pinBtn.setAttribute("aria-pressed", String(!!settings.alwaysOnTop));
    if (PANEL) {
      // Pinned, fixed panel: mini rows only. Looks and hidden channels come from the mixer's settings.
      document.body.classList.add("is-mini", "is-panel");
      $("#desk").hidden = true;
      $("#miniView").hidden = false;
      engine.onPanelShown(async () => {
        await loadSettings();
        applyTheme();
        applyPanelDock();
        chans.forEach(paintLook);
        applyPanelOptions();
        applyVisibility();
      }).catch(() => {});
      applyPanelDock();
      applyPanelOptions();
      // Saved in the mixer (theme, colours, panel options): follow at once, even while open.
      engine.onSettingsChanged((s) => {
        if (!s) return;
        settings = Object.assign(clone(DEFAULT_SETTINGS), s);
        delete settings.autoTheme;
        applyTheme();
        applyPanelDock();
        chans.forEach(paintLook);
        applyPanelOptions();
        applyVisibility();
      }).catch(() => {});
    } else if (MIXWIN) {
      setupMixWindow();
      // Looks, names and theme are changed in the main window: follow at once.
      engine.onSettingsChanged((s) => {
        if (!s) return;
        settings = Object.assign(clone(DEFAULT_SETTINGS), s);
        delete settings.autoTheme;
        applyTheme();
        if (lastState) applyMixFor(lastState);
      }).catch(() => {});
    } else {
      setMini(!!settings.mini, false);
      // Know when the popped-out window opens or closes, so Mix brings it forward.
      engine.onSettingsChanged((s) => {
        if (!s) return;
        for (const key of ["mixWinOpen", "mixViewMode", "personalBus", "audienceBus"]) if (key in s) settings[key] = s[key];
      }).catch(() => {});
    }
    wakeMeters();
    engine.onThemeAuto((e) => { autoTheme = (e && e.theme) || ""; applyTheme(); }).catch(() => {});
    if (!SIDE) {
      pollInputEffects();
      setInterval(pollInputEffects, 2500);
      engine.obsStatus().then(applyObs).catch(() => {});
      engine.onObsStatus(applyObs).catch(() => {});
      engine.twitchStatus().then(applyTwitch).catch(() => {});
      engine.onTwitchStatus(applyTwitch).catch(() => {});
      engine.onAlert(onAlert).catch(() => {});
      engine.onGoLive(onGoLive).catch(() => {});
    }
    engine.onSceneAuto((e) => {
      setScene(e.scene);
      if (!SIDE) toast(`Loaded “${e.scene}” for ${e.app}`);
    }).catch(() => {});
    if (!SIDE) {
      engine.windowsOutput().then(paintWindowsOutput).catch(() => {});
      engine.onWindowsOutput(paintWindowsOutput).catch(() => {});
      engine.onEngineRestart((e) => toast(`${e.device} is back, so Sleekmeeter restarted the audio engine`)).catch(() => {});
      engine.onOutputFallback((e) => toast(`A${e.bus + 1} switched to ${e.name}`)).catch(() => {});
      // A shortcut turned ducking on or off.
      engine.onSettingsChanged((s) => {
        if (s && s.ducking) settings.ducking = s.ducking;
        if (s && "panelDocked" in s) { settings.panelDocked = s.panelDocked; if (settingsDlg.open) syncChecks(); }
        if (settingsDlg.open) syncFadeDuck();
      }).catch(() => {});
      engine.onFileDrop(onFilesDropped).catch(() => {});
    }
    checkForUpdate();
    offerWhatsNew().then(offerStreamDeck).then(offerUsage);
    // Show the window once the first frame with the real layout is drawn.
    requestAnimationFrame(() => requestAnimationFrame(() => engine.uiReady().catch(() => {})));
    // Names are measured with the real font once it has loaded.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { lastSizes = ""; sizeToNames(); });
    await engine.start(applyState, applyLevels);
  }
  init().catch(fail);
})();
