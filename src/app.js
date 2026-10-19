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
  function fail(err) { toast(String(err && err.message ? err.message : err)); }

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
    sizeToNames();
  }

  /* ---------- size strips and the mini/panel name column to the names ---------- */
  const measureCtx = document.createElement("canvas").getContext("2d");
  let lastSizes = "";
  function textWidth(text, el) {
    const cs = getComputedStyle(el);
    measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const spacing = parseFloat(cs.letterSpacing) || 0;  // canvas doesn't include letter-spacing
    return measureCtx.measureText(text).width + spacing * text.length + 2;
  }
  // Each strip gets the width its own name needs (within limits), so names show in full
  // without making every strip wide. The mini rows share one name column.
  function sizeToNames() {
    if (!chans.length) return;
    const dense = document.body.classList.contains("dense");
    const [minW, maxW, chrome] = dense ? [108, 240, 16 + 26 + 6 + 4] : [132, 270, 22 + 28 + 8 + 4];
    const widths = chans.map((ch) => {
      const name = ch.names[0] ? ch.names[0].textContent : "";
      return Math.round(Math.min(maxW, Math.max(minW, chrome + textWidth(name, ch.names[0]))));
    });
    const miniNameW = Math.round(Math.min(240, Math.max(84, ...chans
      .filter((ch) => !look(ch).hidden)
      .map((ch) => textWidth(ch.miniNames[0].textContent, ch.miniNames[0]) + 2))));
    const key = widths.join(",") + "|" + miniNameW;
    if (key === lastSizes) return;
    lastSizes = key;
    chans.forEach((ch, k) => ch.mixerEl.style.setProperty("--w", widths[k] + "px"));
    document.body.style.setProperty("--mini-name", miniNameW + "px");
    if (PANEL) requestAnimationFrame(fitPanel);
    else if (settings.mini) engine.windowMini(true, miniRows(), miniWidth()).catch(() => {});
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
    for (const c of ch.chips) { c.dataset.color = lk.color; c.innerHTML = svg(lk.icon, c.classList.contains("small") ? 14 : 18); }
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

  function applyState(st) {
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
    if (settings.mini && !PANEL) engine.windowMini(true, miniRows(), miniWidth()).catch(() => {});
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
    engine.windowMini(on, miniRows(), miniWidth()).catch(() => {});
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
    if (a === "unsolo") chans.forEach((ch) => { if (ch.kind === "strip" && ch.data && ch.data.solo) sendFloat(`${ch.prefix}.Solo`, 0); });
  });

  /* ---------- settings dialog ---------- */
  const settingsDlg = $("#settingsDlg");
  const CHECKS = {
    setStartWithWindows: "startWithWindows", setStartInTray: "startInTray",
    setLaunchVoicemeeter: "launchVoicemeeter", setHideVoicemeeter: "hideVoicemeeter", setOverlay: "overlay",
    setCheckUpdates: "checkUpdates", setOled: "oled", setAutoRestart: "autoRestart",
  };
  for (const [id, key] of Object.entries(CHECKS)) {
    $("#" + id).addEventListener("change", (e) => {
      settings[key] = e.target.checked;
      syncChecks();
      saveSettings();
      if (key === "oled") applyOled();
      if (key === "checkUpdates") { if (e.target.checked) checkForUpdate(); else $("#updateWrap").hidden = true; }
    });
  }
  function syncChecks() {
    for (const [id, key] of Object.entries(CHECKS)) $("#" + id).checked = !!settings[key];
    const tray = $("#setStartInTray");
    tray.disabled = !settings.startWithWindows;
    tray.closest(".check").classList.toggle("disabled", tray.disabled);
  }
  $("#settingsBtn").addEventListener("click", () => {
    syncChecks();
    syncFadeDuck();
    renderHotkeys();
    settingsDlg.showModal();
  });
  settingsDlg.addEventListener("click", (e) => { if (e.target === settingsDlg) settingsDlg.close(); });

  const ACTIONS = [["mute", "Mute or unmute"], ["volup", "Turn up 2 dB"], ["voldown", "Turn down 2 dB"],
    ["window", "Show or hide Sleekmeeter"], ["duck", "Talk-over ducking on or off"], ["record", "Start or stop recording"]];
  // Actions that aren't about one channel.
  const NO_TARGET = new Set(["window", "duck", "record"]);
  function renderHotkeys() {
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
      tgt.setAttribute("aria-label", "Channel");
      for (const ch of chans) tgt.appendChild(new Option(displayName(ch), ch.prefix));
      tgt.value = h.target || "Strip[0]";
      tgt.disabled = NO_TARGET.has(h.action);
      act.addEventListener("change", () => {
        h.action = act.value;
        tgt.disabled = NO_TARGET.has(h.action);
        h.target = tgt.disabled ? "" : tgt.value;
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
    $("#rulesEmpty").hidden = sceneNames.length > 0;
    $("#addRule").hidden = sceneNames.length === 0;
    $("#ruleHead").hidden = rules.length === 0;
    rules.forEach((r, idx) => {
      const row = document.createElement("div");
      row.className = "rule";
      const app = document.createElement("input");
      app.type = "text"; app.value = r.app || ""; app.placeholder = "e.g. obs64.exe";
      app.setAttribute("list", "appList"); app.setAttribute("aria-label", "App");
      app.spellcheck = false; app.autocomplete = "off";
      app.addEventListener("change", () => { r.app = app.value.trim().toLowerCase(); app.value = r.app; saveSettings(); });
      const scene = document.createElement("select");
      scene.setAttribute("aria-label", "Scene to load");
      for (const n of sceneNames) scene.appendChild(new Option(n, n));
      if (r.scene && !sceneNames.includes(r.scene)) scene.appendChild(new Option(`${r.scene} (deleted)`, r.scene));
      scene.value = r.scene || sceneNames[0] || "";
      r.scene = scene.value;
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
      listEl.appendChild(row);
    });
  }
  $("#addRule").addEventListener("click", async () => {
    settings.sceneRules = settings.sceneRules || [];
    settings.sceneRules.push({ app: "", scene: sceneNames[0] || "", restore: "" });
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
      $("#updateWrap").hidden = false;
    } catch (e) { /* offline or GitHub unreachable: try again next start */ }
  }
  const setUpdateMenu = (open) => { updateMenu.hidden = !open; updateBtn.setAttribute("aria-expanded", String(open)); };
  updateBtn.addEventListener("click", () => setUpdateMenu(updateMenu.hidden));
  document.addEventListener("click", (e) => { if (!e.target.closest("#updateWrap")) setUpdateMenu(false); });
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
      input.style.setProperty("--track-bg", `linear-gradient(to right, var(--amber) ${p}%, var(--well) ${p}%)`);
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
    const list = $("#duckTargets");
    list.textContent = "";
    for (const ch of chans) {
      if (ch.kind !== "strip" || ch.prefix === d.trigger) continue;
      const b = Object.assign(document.createElement("button"), { type: "button", className: "tog arm", textContent: displayName(ch) });
      b.title = displayName(ch);
      b.dataset.color = look(ch).color;
      b.setAttribute("aria-pressed", String((d.targets || []).includes(ch.prefix)));
      b.addEventListener("click", () => {
        const on = b.getAttribute("aria-pressed") !== "true";
        b.setAttribute("aria-pressed", String(on));
        const set = new Set(d.targets || []);
        if (on) set.add(ch.prefix); else set.delete(ch.prefix);
        d.targets = chans.filter((c) => set.has(c.prefix)).map((c) => c.prefix);
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
    const m = /^Strip\[(\d)\]$/.exec(d.trigger || "");
    const pair = lv && m ? (lv.inputs || [])[+m[1]] : null;
    if (pair) { const db = Math.max(pair[0], pair[1]); duckShown = db > duckShown ? db : Math.max(db, duckShown - 3); }
    const input = $("#duckThreshold"), min = +input.min, max = +input.max;
    const p = Math.max(0, Math.min(1, (duckShown - min) / (max - min))) * 100;
    const color = duckShown >= d.threshold ? "var(--amber)" : "var(--led-g)";
    const bg = `linear-gradient(to right, ${color} ${p.toFixed(1)}%, var(--well) ${p.toFixed(1)}%)`;
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
  }
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
    g.style.setProperty("--track-bg", `linear-gradient(to right, var(--amber) ${p}%, var(--well) ${p}%)`);
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
  function fitPanel() {
    const view = $("#miniView");
    const cs = getComputedStyle(view);
    const lists = [...view.children].filter((el) => el.offsetHeight > 0);
    const content = lists.reduce((h, el) => h + el.offsetHeight, 0)
      + Math.max(0, lists.length - 1) * parseFloat(cs.rowGap || cs.gap || 0)
      + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const border = parseFloat(getComputedStyle(document.body).borderTopWidth) * 2;
    engine.fitPanel(Math.ceil($(".bar").offsetHeight + content + border), miniWidth() + border).catch(() => {});
  }
  async function loadSettings() {
    try {
      const s = await engine.getSettings();
      settings = Object.assign(clone(DEFAULT_SETTINGS), s || {});
    } catch (e) { /* keep defaults */ }
  }

  /* ---------- start ---------- */
  // Pure black for OLED screens (Settings → Appearance).
  function applyOled() { document.body.classList.toggle("oled", !!settings.oled); }

  async function init() {
    await loadSettings();
    applyOled();
    buildChannels(settings.edition || 2);
    pinBtn.setAttribute("aria-pressed", String(!!settings.alwaysOnTop));
    if (PANEL) {
      // Pinned, fixed panel: mini rows only. Looks and hidden channels come from the mixer's settings.
      document.body.classList.add("is-mini", "is-panel");
      $("#desk").hidden = true;
      $("#miniView").hidden = false;
      engine.onPanelShown(async () => {
        await loadSettings();
        applyOled();
        chans.forEach(paintLook);
        applyVisibility();
      }).catch(() => {});
    } else {
      setMini(!!settings.mini, false);
    }
    wakeMeters();
    engine.onSceneAuto((e) => {
      setScene(e.scene);
      if (!PANEL) toast(`Loaded “${e.scene}” for ${e.app}`);
    }).catch(() => {});
    if (!PANEL) {
      engine.onEngineRestart((e) => toast(`${e.device} is back, so Sleekmeeter restarted the audio engine`)).catch(() => {});
      // A shortcut turned ducking on or off.
      engine.onSettingsChanged((s) => {
        if (s && s.ducking) settings.ducking = s.ducking;
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
