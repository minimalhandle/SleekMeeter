(function () {
  "use strict";
  const { layoutFor, BUS_MODES, DEFAULT_SETTINGS, createEngine } = window.Sleekmeeter;
  const { ICONS, COLORS, svg } = window.SleekIcons;
  const engine = createEngine();
  const $ = (s, el = document) => el.querySelector(s);
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // The tray volume panel loads this same page with SLEEK_FLYOUT set (or ?panel in a browser).
  const PANEL = !!window.SLEEK_FLYOUT || /[?&]panel\b/.test(location.search);
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
    } catch (e) { fail(e); }
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
    return { color: saved.color || "slate", icon: saved.icon || ch.info.icon, hidden: !!saved.hidden };
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
    for (const r of ch.rows) r.dataset.color = lk.color;
  }

  /* ---------- fader component (vertical in the mixer, horizontal in mini mode) ---------- */
  function setGain(ch, v) {
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
  function glideGain(ch, v) {
    if (!fadesOn()) return setGain(ch, v);
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
    ch.meterEls.push({ lit: meters.map((m) => $(".lit", m)), led: meters.map((m) => $(".lit b", m)), pk: meters.map((m) => $(".pk", m)), h: horizontal });

    let start = 0, startPos = 0, span = 1;
    const posAt = (e, r) => horizontal ? (e.clientX - r.left) / span : (r.bottom - e.clientY) / span;
    const coord = (e) => (horizontal ? e.clientX : -e.clientY);
    track.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const r = travel.getBoundingClientRect();
      span = Math.max(1, horizontal ? r.width : r.height);
      const onThumb = !!e.target.closest(".thumb");
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
    const end = () => { ch.dragging = false; el.classList.remove("dragging"); ch.lockUntil = performance.now() + 500; };
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);
    track.addEventListener("dblclick", () => glideGain(ch, 0));
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const dir = (horizontal ? (e.deltaY || e.deltaX) : e.deltaY) < 0 ? 1 : -1;
      setGain(ch, ch.gain + dir * (e.altKey ? 0.1 : 1));
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
      if (v !== null) { e.preventDefault(); setGain(ch, v); }
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openGainEdit(ch, e.clientX, e.clientY, el);
    });
    el.setAttribute("aria-label", `${displayName(ch)} level`);
  }

  function makeToggle(btn, ch, param) {
    btn.setAttribute("aria-pressed", "false");
    ch.toggles.push({ btn, param });
    btn.addEventListener("click", () => {
      const on = btn.getAttribute("aria-pressed") !== "true";
      for (const t of ch.toggles) if (t.param === param) t.btn.setAttribute("aria-pressed", String(on));
      if (param === "Mute") markMuted(ch, on);
      sendFloat(`${ch.prefix}.${param}`, on ? 1 : 0);
    });
  }
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
    btn.addEventListener("dblclick", open);
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

  function buildMixerStrip(ch) {
    const tpl = ch.kind === "strip" ? "#inputTpl" : "#outputTpl";
    const el = $(tpl).content.firstElementChild.cloneNode(true);
    el.dataset.kind = ch.info.kind;
    ch.mixerEl = el;
    ch.rows.push(el);
    const chip = $(".chip", el);
    ch.chips.push(chip);
    chip.addEventListener("click", () => openDrawer(ch));
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
    showOffline(!st.installed ? "missing" : !st.connected ? "stopped" : null);
    connected = !!st.connected;
    if (!st.connected || !st.strips) return;
    if (st.edition && st.edition !== layout.edition) buildChannels(st.edition);

    for (const ch of chans) {
      const d = (ch.kind === "strip" ? st.strips : st.buses)[ch.i];
      if (!d) continue;
      ch.data = d;
      const name = displayName(ch);
      for (const n of ch.names) { n.textContent = name; n.title = `${name}\nDouble-click to rename`; }
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
      markMuted(ch, !!d.mute);
      for (const r of ch.rows) r.classList.toggle("ducked", !!d.ducked);
    }
    applyRecorder(st.recorder);
    applyOutputs(st);
    applyBrb(st);
    sizeToNames();
    if (drawerCh) renderDrawerValues();
    if (!fitted) { fitted = true; requestAnimationFrame(fitWindowToMixer); }
  }

  // First launch only (Rust ignores it once a size is saved): make the window as wide as the mixer.
  let fitted = false;
  function fitWindowToMixer() {
    if (PANEL || settings.mini) return;
    const desk = $("#desk"), cs = getComputedStyle(desk);
    const groups = [...desk.querySelectorAll(".group")].filter((g) => g.offsetWidth > 0);
    const width = groups.reduce((w, g) => w + g.offsetWidth, 0)
      + Math.max(0, groups.length - 1) * parseFloat(cs.columnGap || cs.gap || 0)
      + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 4;
    engine.fitWindow(Math.ceil(width)).catch(() => {});
  }

  /* ---------- visibility (hidden strips) ---------- */
  function applyVisibility() {
    const hiddenCount = { strip: 0, bus: 0 };
    for (const ch of chans) {
      const h = look(ch).hidden;
      if (h) hiddenCount[ch.kind]++;
      ch.mixerEl.hidden = h && !reveal[ch.kind];
      ch.mixerEl.classList.toggle("is-hidden", h);
      ch.miniEl.hidden = h;
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
    if (chainDlg.open) chainLevels(lv);
  }
  // Meters move with `transform` only (scale for the bar, translate for the peak line), so they
  // are composited on the GPU without repainting. The loop stops when every meter is at rest
  // and starts again when new levels arrive.
  let lastT = performance.now(), running = false, lastLevels = 0;
  const writeMeter = (ch, c, p, pk) => {
    for (const v of ch.meterEls) {
      const off = ((1 - p) * 100).toFixed(2);
      v.lit[c].style.transform = v.h ? `translateX(-${off}%)` : `translateY(${off}%)`;
      v.led[c].style.transform = v.h ? `translateX(${off}%)` : `translateY(-${off}%)`;
      v.pk[c].style.transform = v.h ? `translateX(${(pk * 100).toFixed(2)}%)` : `translateY(${((1 - pk) * 100).toFixed(2)}%)`;
      v.pk[c].style.opacity = pk > 0.01 ? "1" : "0";
    }
  };
  function wakeMeters() {
    lastLevels = performance.now();
    if (!running) { running = true; lastT = performance.now(); requestAnimationFrame(frame); }
  }
  function frame(t) {
    const dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
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
        if (changed) {
          busy = true;
          const p = dbToPos(M.shown[c]), pk = dbToPos(M.peak[c]);
          if (Math.abs(p - (M.drawn ? M.drawn[c] : -1)) > 0.0015 || Math.abs(pk - (M.drawnPk ? M.drawnPk[c] : -1)) > 0.0015) {
            M.drawn = M.drawn || [0, 0]; M.drawnPk = M.drawnPk || [0, 0];
            M.drawn[c] = p; M.drawnPk[c] = pk;
            writeMeter(ch, c, p, pk);
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

  function openDrawer(ch) {
    drawerCh = ch;
    drawer.hidden = false;
    renderDrawerHead();
    buildDrawerBody();
    $("#drawerClose").focus();
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
  }

  function section(title) {
    const s = document.createElement("section");
    if (title) s.appendChild(Object.assign(document.createElement("h3"), { textContent: title }));
    drawerBody.appendChild(s);
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
    drawerBody.textContent = "";

    const lookSec = section("Look");
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
    lookSec.append(sw, grid, hide);

    if (isHw(ch)) {
      const devSec = section(ch.kind === "strip" ? "Input device" : "Output device");
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
      if (deviceCache) fillDevices();
    }

    if (ch.kind === "strip") {
      const pos = section("Position");
      rangeField(pos, { id: "fPan", label: "Pan", param: "Pan_x", min: -0.5, max: 0.5, step: 0.01, center: 0, reset: 0,
        format: (v) => (Math.abs(v) < 0.005 ? "C" : (v < 0 ? "L " : "R ") + Math.round(Math.abs(v) * 200)) });
      const dyn = section("Dynamics");
      rangeField(dyn, { id: "fComp", label: "Compressor", param: "Comp", min: 0, max: 10, step: 0.1, reset: 0, format: (v) => v.toFixed(1) });
      rangeField(dyn, { id: "fGate", label: "Gate", param: "Gate", min: 0, max: 10, step: 0.1, reset: 0, format: (v) => v.toFixed(1) });
      if (!isHw(ch)) {
        const eq = section("EQ");
        const f = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1);
        rangeField(eq, { id: "fEq1", label: "Bass", param: "EQGain1", min: -12, max: 12, step: 0.5, center: 0, reset: 0, format: f });
        rangeField(eq, { id: "fEq2", label: "Mid", param: "EQGain2", min: -12, max: 12, step: 0.5, center: 0, reset: 0, format: f });
        rangeField(eq, { id: "fEq3", label: "Treble", param: "EQGain3", min: -12, max: 12, step: 0.5, center: 0, reset: 0, format: f });
      }
    } else {
      const modeSec = section("Bus mode");
      const sel = document.createElement("select");
      sel.id = "busMode"; sel.setAttribute("aria-label", "Bus mode");
      for (const [v, label] of BUS_MODES) sel.appendChild(new Option(label, v));
      sel.addEventListener("change", () => sendFloat(`${ch.prefix}.mode.${sel.value}`, 1));
      modeSec.appendChild(sel);
    }
    renderDrawerHead();
    renderDrawerValues();
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
    const map = { Pan_x: d.pan, Comp: d.comp, Gate: d.gate, EQGain1: (d.eq || [])[0], EQGain2: (d.eq || [])[1], EQGain3: (d.eq || [])[2] };
    drawerBody.querySelectorAll("input[type=range]").forEach((inp) => {
      const v = map[inp.dataset.param];
      if (v === undefined || document.activeElement === inp) return;
      inp.value = v;
      inp._paint();
    });
    const mode = $("#busMode");
    if (mode && document.activeElement !== mode) mode.value = d.mode || "normal";
  }

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
    miniBtn.setAttribute("aria-pressed", String(on));
    miniBtn.title = miniBtn.ariaLabel = on ? "Full mixer" : "Mini mode";
    if (on && drawerCh) closeDrawer();
    syncMiniWindow(on);
    if (save) saveSettings();
  }
  miniBtn.addEventListener("click", () => setMini(!settings.mini, true));

  const moreBtn = $("#moreBtn"), moreMenu = $("#moreMenu");
  const setMenu = (open) => { moreMenu.hidden = !open; moreBtn.setAttribute("aria-expanded", String(open)); if (open) moreMenu.querySelector("button").focus(); };
  moreBtn.addEventListener("click", () => setMenu(moreMenu.hidden));
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !moreMenu.hidden) { setMenu(false); moreBtn.focus(); } });
  moreMenu.addEventListener("click", (e) => {
    const a = e.target.closest("button")?.dataset.action;
    if (!a) return;
    setMenu(false);
    if (a === "show") engine.showWindow().catch(fail);
    if (a === "restart") engine.setFloat("Command.Restart", 1).then(() => toast("Restarting audio engine")).catch(fail);
    if (a === "options") openOptions();
    if (a === "setup") openSetup();
    if (a === "hear") openHear();
    if (a === "chain") openChain();
    if (a === "history") openHistory();
    if (a === "unsolo") chans.forEach((ch) => { if (ch.kind === "strip" && ch.data && ch.data.solo) sendFloat(`${ch.prefix}.Solo`, 0); });
  });

  /* ---------- settings dialog ---------- */
  const settingsDlg = $("#settingsDlg");
  const CHECKS = {
    setStartWithWindows: "startWithWindows", setStartInTray: "startInTray",
    setLaunchVoicemeeter: "launchVoicemeeter", setHideVoicemeeter: "hideVoicemeeter", setOverlay: "overlay",
    setCheckUpdates: "checkUpdates", setAutoRestart: "autoRestart", setPanelDocked: "panelDocked", setExtraBuses: "showExtraBuses",
  };
  for (const [id, key] of Object.entries(CHECKS)) {
    $("#" + id).addEventListener("change", (e) => {
      settings[key] = e.target.checked;
      syncChecks();
      saveSettings();
      if (key === "showExtraBuses") applyExtraBuses();
      if (key === "checkUpdates") { if (e.target.checked) checkForUpdate(); else $("#updateWrap").hidden = true; }
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
  $("#settingsBtn").addEventListener("click", () => {
    syncChecks();
    renderThemes();
    renderAbout();
    syncFadeDuck();
    syncBrb();
    syncObs();
    syncClip();
    syncTwitch();
    syncRemote();
    $("#historyOn").checked = HI().on !== false;
    renderHotkeys();
    settingsDlg.showModal();
  });
  settingsDlg.addEventListener("click", (e) => { if (e.target === settingsDlg) settingsDlg.close(); });

  const H = () => (settings.hold = Object.assign({}, DEFAULT_SETTINGS.hold, settings.hold));
  const ACTIONS = [["mute", "Mute or unmute"], ["ptt", "Push to talk (hold)"], ["ptm", "Push to mute (hold)"],
    ["volup", "Turn up 2 dB"], ["voldown", "Turn down 2 dB"],
    ["output", "Switch to an output profile"], ["outputnext", "Next output profile"],
    ["window", "Show or hide Sleekmeeter"], ["duck", "Talk-over ducking on or off"], ["record", "Start or stop recording"],
    ["brb", "Be right back on or off"], ["scene", "Load a scene"], ["sound", "Play a sound"], ["soundstop", "Stop all sounds"]];
  // Actions that aren't about one channel.
  const NO_TARGET = new Set(["window", "duck", "record", "outputnext", "brb", "soundstop"]);
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
      load.addEventListener("click", async () => {
        try { await engine.loadScene(n); setScene(n); toast(`Loaded “${n}”`); dlg.close(); } catch (e) { fail(e); }
      });
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
  async function checkForUpdate() {
    if (PANEL || !settings.checkUpdates) return;
    try {
      const u = await engine.checkUpdate();
      if (!u || !u.newer || u.latest === settings.skippedVersion) return;
      update = u;
      updateBtn.textContent = `Update to ${u.latest}`;
      $("#updateText").textContent = `Sleekmeeter ${u.latest} is out. You have ${u.current}.`;
      updateNow.hidden = u.canInstall === false;
      $("#updateWrap").hidden = false;
    } catch (e) { /* offline or GitHub unreachable: try again next start */ }
  }
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
    if (outputsDlg.open) markProfiles();
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
  outputsBtn.addEventListener("click", () => { renderProfiles(); outputsDlg.showModal(); });
  outputsDlg.addEventListener("click", (e) => { if (e.target === outputsDlg) outputsDlg.close(); });

  /* ---------- volume per app ---------- */
  // Windows' own per-app volume (the volume mixer), read once a second while this window is open.
  const appsDlg = $("#appsDlg"), appsBtn = $("#appsBtn"), appListEl = $("#appVolList");
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
    } catch (e) {
      if (!appsFailed) fail(e);
      appsFailed = true;
    } finally { appsBusy = false; }
  }
  function openAppVolumes() {
    appRows.clear();
    appListEl.textContent = "";
    $("#appVolEmpty").hidden = true;
    appsFailed = false;
    appsDlg.showModal();
    refreshApps();
    engine.appRouteDevices().then((d) => { routeDevices = d || []; for (const [, row] of appRows) fillRoute(row, { exe: row.name.title, pids: row.pids }); }).catch(() => {});
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
  const trayApplied = new Map(); // exe → process ids already pointed at their device this session
  let routeQueue = Promise.resolve();

  const virtualStrips = () => chans.filter((c) => c.kind === "strip" && !isHw(c));
  // Voicemeeter's virtual inputs, in order: VAIO, AUX, then VAIO3 (Potato).
  function deviceForChannel(ch) {
    const at = virtualStrips().indexOf(ch);
    if (at < 0) return null;
    const vm = routeDevices.filter((d) => /voicemeeter/i.test(d.name));
    if (at === 0) return vm.find((d) => !/aux|vaio3/i.test(d.name)) || null;
    if (at === 1) return vm.find((d) => /aux/i.test(d.name)) || null;
    return vm.find((d) => /vaio3/i.test(d.name)) || null;
  }
  const channelForDevice = (id) => virtualStrips().find((c) => { const d = deviceForChannel(c); return d && d.id === id; }) || null;
  const exeName = (exe) => { const t = exe.replace(/\.exe$/i, ""); return exe === "system sounds" ? "System sounds" : t.charAt(0).toUpperCase() + t.slice(1); };
  const hueOf = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const initialOf = (name) => (name.trim().charAt(0) || "?").toUpperCase();
  const pidsOf = (exe) => { const a = trayRunning.find((x) => x.exe === exe); return a ? a.pids || [] : []; };

  async function routeApp(a, ch) {
    const dev = ch ? deviceForChannel(ch) : null;
    if (ch && !dev) { toast("Windows doesn't list that channel's input. Is Voicemeeter running?"); return; }
    const name = a.name || exeName(a.exe);
    const pids = a.pids || [];
    try {
      if (pids.length) await engine.appRouteSet(pids, dev ? dev.id : "");
    } catch (e) { fail(e); return; }
    settings.appRoutes = settings.appRoutes || {};
    if (dev) settings.appRoutes[a.exe] = dev.id; else delete settings.appRoutes[a.exe];
    trayApplied.set(a.exe, new Set(pids));
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
    b.title = a.exe === "system sounds" ? "Windows system sounds can't be moved" : `${a.name}: drag onto an input channel`;
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

  // Small chips on a channel strip for the apps that play through it.
  function paintStripApps() {
    const routes = settings.appRoutes || {};
    const running = new Set(trayRunning.filter((a) => a.pids && a.pids.length).map((a) => a.exe));
    for (const ch of virtualStrips()) {
      let box = $(".app-chips", ch.mixerEl);
      if (!box) {
        box = document.createElement("div");
        box.className = "app-chips";
        box.hidden = true;
        $(".head", ch.mixerEl).after(box);
      }
      const mine = Object.keys(routes).filter((exe) => { const c = channelForDevice(routes[exe]); return c === ch; });
      const sig = mine.map((e) => e + (running.has(e) ? "+" : "-")).join(",");
      if (box.dataset.sig === sig) continue;
      box.dataset.sig = sig;
      box.textContent = "";
      for (const exe of mine) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "sa-chip" + (running.has(exe) ? "" : " idle");
        b.style.setProperty("--hue", hueOf(exe));
        b.title = `${exeName(exe)} plays through this channel. Click to put it back on the Windows default.`;
        b.innerHTML = `<span class="av"></span><span class="t"></span>`;
        $(".av", b).textContent = initialOf(exeName(exe));
        $(".t", b).textContent = exeName(exe);
        b.addEventListener("click", () => routeApp({ exe, name: exeName(exe), pids: pidsOf(exe) }, null));
        box.appendChild(b);
      }
      box.hidden = mine.length === 0;
    }
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
        if (target.kind === "strip" && !isHw(target)) { mode = "channel"; strip.classList.add("drop-ok"); }
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
      else if (mode === "bad") toast("Apps can only go onto input channels that come from Voicemeeter's virtual inputs, not onto hardware or outputs");
    };
    const esc = (ev) => { if (ev.key === "Escape") { mode = "none"; end({ type: "pointercancel" }); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", esc);
  }

  // Put remembered routes back on programs that have started since (Windows keeps its own copy,
  // so this mostly confirms it).
  function applyRemembered() {
    const routes = settings.appRoutes || {};
    for (const a of trayRunning) {
      const id = routes[a.exe];
      if (!id || !a.pids || !a.pids.length || !routeDevices.some((d) => d.id === id)) continue;
      const done = trayApplied.get(a.exe) || new Set();
      const fresh = a.pids.filter((p) => !done.has(p));
      if (!fresh.length) continue;
      trayApplied.set(a.exe, new Set([...done, ...fresh]));
      routeQueue = routeQueue.then(() => engine.appRouteSet(fresh, id)).catch(() => {});
    }
  }

  async function pollTray() {
    if (trayBusy || PANEL || settings.mini || document.hidden) return;
    trayBusy = true;
    try {
      if (!routeDevices.length || trayPolls++ % 20 === 0) routeDevices = (await engine.appRouteDevices().catch(() => routeDevices)) || routeDevices;
      trayRunning = (await engine.appVolumes()) || [];
      applyRemembered();
      paintStripApps();
      paintTray();
    } catch (_) { /* Windows audio unavailable; the tray just stays as it was */ } finally { trayBusy = false; }
  }
  function startTray() {
    if (PANEL || trayTimer) return;
    pollTray();
    trayTimer = setInterval(() => { if (settings.appTray || Object.keys(settings.appRoutes || {}).length) pollTray(); }, settings.appTray ? 1500 : 3000);
  }
  function applyTray() {
    const on = !PANEL && !!settings.appTray;
    trayEl.hidden = !on;
    appsBtn.setAttribute("aria-pressed", String(on));
    clearInterval(trayTimer); trayTimer = null;
    lastTraySig = "";
    startTray();
    if (on) paintTray();
  }
  appsBtn.addEventListener("click", () => { settings.appTray = !settings.appTray; saveSettings(); applyTray(); });
  $("#trayClose").addEventListener("click", () => { settings.appTray = false; saveSettings(); applyTray(); });
  $("#trayVolumes").addEventListener("click", openAppVolumes);

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
  const recRunning = () => rec && (rec.state === "recording" || rec.state === "playing");
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
    const state = rec.state || "stopped";
    recBtn.dataset.state = state;
    $("#recLabel").textContent = state === "stopped" ? "Rec" : state === "paused" ? "Paused" : recClock();
    recBtn.title = state === "stopped" ? "Recorder" : `Recorder: ${REC_STATES[state].toLowerCase()}`;
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
    if (!rec || PANEL) return;
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
    const content = lists.reduce((h, el) => h + el.offsetHeight, 0)
      + Math.max(0, lists.length - 1) * parseFloat(cs.rowGap || cs.gap || 0)
      + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const border = parseFloat(getComputedStyle(document.body).borderTopWidth) * 2;
    return { h: Math.ceil($(".bar").offsetHeight + content + border), border };
  }
  function fitPanel() {
    const { h, border } = miniHeight();
    engine.fitPanel(h, miniWidth() + border).catch(() => {});
  }
  // Mini mode in the main window: size it to the channels, so it never needs a scroll bar and
  // switching to and from the full mixer is seamless. Redone whenever the channels change.
  function syncMiniWindow(on) {
    if (PANEL) return;
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
    brbBtn.textContent = on ? "Back live" : "BRB";
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
    ["duck", "Talk-over ducking on or off"], ["record", "Start or stop recording"]];
  const TW_NO_TARGET = new Set(["brb", "soundstop", "outputnext", "duck", "record"]);
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
  function twTarget(sel, cmd) {
    sel.textContent = "";
    const none = TW_NO_TARGET.has(cmd.action);
    sel.style.visibility = none ? "hidden" : "visible";
    if (none) { cmd.target = ""; return; }
    sel.setAttribute("aria-label", "On");
    if (cmd.action === "scene" || cmd.action === "sound") sel.appendChild(new Option("What's typed after it", ""));
    const names = cmd.action === "mute" ? chans.map((ch) => [displayName(ch), ch.prefix]) : namesFor(cmd.action).map((n) => [n, n]);
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
  function syncTwitch() {
    engine.listScenes().then((n) => { knownScenes = n; renderTwitchCmds(); }).catch(() => renderTwitchCmds());
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
    remoteTimer = setInterval(() => { if (!settingsDlg.open) { clearInterval(remoteTimer); remoteTimer = null; } else refreshRemote(); }, 2000);
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
  const levelOf = (lv, prefix) => {
    const m = /^(Strip|Bus)\[(\d)\]$/.exec(prefix || "");
    const pair = m ? ((m[1] === "Strip" ? lv.inputs : lv.outputs) || [])[+m[2]] : null;
    return pair ? Math.max(pair[0], pair[1]) : -200;
  };
  let clipRun = 0, clipAt = 0;
  function checkClip(lv) {
    const c = settings.clipWarn;
    if (PANEL || !c || !c.on) return;
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
  $("#setupApply").addEventListener("click", () => {
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
    ["Comp.Threshold", "Comp threshold", -40, 0, 1, " dB"],
    ["Comp.Ratio", "Comp ratio", 1, 8, 0.1, ":1"],
    ["Gate.Threshold", "Gate threshold", -70, -20, 1, " dB"],
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
    const sel = $("#chainWhich");
    sel.textContent = "";
    for (const ch of chans) if (ch.kind === "strip") sel.appendChild(new Option(displayName(ch), ch.prefix));
    sel.value = (settings.ducking && settings.ducking.trigger) || "Strip[0]";
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
    buildChain();
    chainDlg.showModal();
  }
  $("#chainWhich").addEventListener("change", buildChain);
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

  /* ---------- check my setup ---------- */
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
      li.append(mark, body);
      list.appendChild(li);
    }
  }
  const openHealth = () => { if (!healthDlg.open) healthDlg.showModal(); runHealth(); };
  $("#openHealth").addEventListener("click", openHealth);
  $("#healthAgain").addEventListener("click", runHealth);
  $("#offlineHealth").addEventListener("click", openHealth);
  healthDlg.addEventListener("click", (e) => { if (e.target === healthDlg) healthDlg.close(); });

  /* ---------- backup and layout ---------- */
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

  /* ---------- start ---------- */
  // Pure black for OLED screens (Settings → Appearance).
  /* ---------- themes (Settings → Appearance) ---------- */
  // Each theme is a set of colour and material tokens in styles.css, keyed by data-theme.
  const THEMES = [
    ["console", "Console", "Dark hardware desk with amber light"],
    ["oled", "OLED black", "Pure black for OLED screens"],
    ["glass", "Glass", "Frosted cards over a soft glow, capsule faders"],
    ["neon", "Neon", "Dark synth night with glowing outlines"],
    ["terminal", "Terminal", "Green phosphor, monospace, square corners"],
    ["bubblegum", "Bubblegum", "Pink, sparkly and cute, with heart faders and emoji icons"],
    ["blueprint", "Blueprint", "Drafting paper: white lines on blue, monospace, tick-mark faders"],
    ["block", "Block", "Bold and flat: thick outlines, hard shadows, bright colour blocks"],
    ["rack", "Rack", "Brushed steel studio gear, black fader caps, amber LCDs"],
    ["arcade", "Arcade", "8-bit cabinet: pixel corners, chunky blocks, hot colours"],
    ["peach", "Peaches & Cream", "Girly pink: peach faders, heart meters, scalloped cards"],
    ["sticker", "Sticker Bomb", "Tilted die-cut stickers on notebook paper, starburst faders"],
  ];
  // Before themes there was only "Pure black for OLED" (settings.oled).
  // Themes that were retired map to their closest remaining one.
  const RETIRED = { midnight: "console", minimal: "console", clean: "console", analog: "console", studio: "console", ink: "console", deco: "console", haunted: "console", cosmic: "console" };
  const currentTheme = () => {
    const t = RETIRED[settings.theme] || settings.theme;
    return THEMES.some((x) => x[0] === t) ? t : settings.oled ? "oled" : "console";
  };
  let autoTheme = "";
  function applyTheme() {
    document.body.dataset.theme = RETIRED[autoTheme] || autoTheme || currentTheme();
    // Fonts and spacing change with the theme, so strips must be re-sized to their names.
    lastSizes = "";
    requestAnimationFrame(() => sizeToNames());
  }
  function renderThemes() {
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
        applyVisibility();
      }).catch(() => {});
      applyPanelDock();
      engine.onSettingsChanged((s) => {
        if (s && "panelDocked" in s) { settings.panelDocked = s.panelDocked; applyPanelDock(); }
      }).catch(() => {});
    } else {
      setMini(!!settings.mini, false);
    }
    wakeMeters();
    engine.onThemeAuto((e) => { autoTheme = (e && e.theme) || ""; applyTheme(); }).catch(() => {});
    if (!PANEL) {
      engine.obsStatus().then(applyObs).catch(() => {});
      engine.onObsStatus(applyObs).catch(() => {});
      engine.twitchStatus().then(applyTwitch).catch(() => {});
      engine.onTwitchStatus(applyTwitch).catch(() => {});
    }
    engine.onSceneAuto((e) => {
      setScene(e.scene);
      if (!PANEL) toast(`Loaded “${e.scene}” for ${e.app}`);
    }).catch(() => {});
    if (!PANEL) {
      engine.onEngineRestart((e) => toast(`${e.device} is back, so Sleekmeeter restarted the audio engine`)).catch(() => {});
      // A shortcut turned ducking on or off.
      engine.onSettingsChanged((s) => {
        if (s && s.ducking) settings.ducking = s.ducking;
        if (s && "panelDocked" in s) { settings.panelDocked = s.panelDocked; if (settingsDlg.open) syncChecks(); }
        if (settingsDlg.open) syncFadeDuck();
      }).catch(() => {});
      engine.onFileDrop(onFilesDropped).catch(() => {});
    }
    checkForUpdate();
    // Show the window once the first frame with the real layout is drawn.
    requestAnimationFrame(() => requestAnimationFrame(() => engine.uiReady().catch(() => {})));
    // Names are measured with the real font once it has loaded.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { lastSizes = ""; sizeToNames(); });
    await engine.start(applyState, applyLevels);
  }
  init().catch(fail);
})();
