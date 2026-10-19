(function () {
  "use strict";
  const { LAYOUT, createEngine } = window.Sleekmeeter;
  const engine = createEngine();
  const $ = (s, el = document) => el.querySelector(s);

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
  const root = document.documentElement.style;
  root.setProperty("--p-yellow", dbToPos(-9) * 100 + "%");
  root.setProperty("--p-zero", dbToPos(0) * 100 + "%");
  root.setProperty("--p-zero-f", dbToPos(0));
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

  /* ---------- build the desk ---------- */
  const strips = [];   // input strip controllers
  const buses = [];    // output strip controllers
  const SCALE_TICKS = [12, 0, -10, -20, -40, -60];

  function buildScale(el) {
    for (const db of SCALE_TICKS) {
      const s = document.createElement("span");
      s.textContent = db > 0 ? "+" + db : db === 0 ? "0" : "−" + Math.abs(db);
      if (db === 0) s.className = "zero";
      s.style.bottom = `calc(4px + (100% - 8px) * ${dbToPos(db)})`;
      el.appendChild(s);
    }
  }

  function makeFader(el, paramName, label) {
    const thumb = $(".thumb", el), dbText = $(".db", el), track = $(".track", el);
    const f = { el, value: 0, lockUntil: 0, dragging: false };
    el.setAttribute("aria-label", label);
    f.render = () => {
      el.style.setProperty("--pos", dbToPos(f.value));
      dbText.textContent = fmtDb(f.value);
      el.setAttribute("aria-valuenow", f.value.toFixed(1));
      el.setAttribute("aria-valuetext", fmtDb(f.value) + " dB");
    };
    f.setRemote = (v) => {
      if (f.dragging || performance.now() < f.lockUntil) return;
      if (Math.abs(v - f.value) > 0.001) { f.value = v; f.render(); }
    };
    f.setLocal = (v) => {
      v = Math.round(Math.max(MIN_DB, Math.min(MAX_DB, v)) * 10) / 10;
      f.lockUntil = performance.now() + 500;
      if (v === f.value) return;
      f.value = v; f.render();
      sendFloat(paramName(), v);
    };

    let startY = 0, startPos = 0, h = 1;
    track.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const r = track.getBoundingClientRect();
      h = r.height - 8;
      const clicked = (r.bottom - 4 - e.clientY) / h;
      startPos = e.target.closest(".thumb") ? dbToPos(f.value) : clicked;
      startY = e.clientY;
      if (!e.target.closest(".thumb")) f.setLocal(posToDb(clicked));
      f.dragging = true; el.classList.add("dragging");
      track.setPointerCapture(e.pointerId);
      el.focus({ preventScroll: true });
    });
    track.addEventListener("pointermove", (e) => {
      if (!f.dragging) return;
      const fine = e.shiftKey ? 0.2 : 1;
      f.setLocal(posToDb(startPos + ((startY - e.clientY) / h) * fine));
      if (e.shiftKey) { startPos = dbToPos(f.value); startY = e.clientY; }
    });
    const end = () => { f.dragging = false; el.classList.remove("dragging"); f.lockUntil = performance.now() + 500; };
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);
    track.addEventListener("dblclick", () => f.setLocal(0));
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      f.setLocal(f.value + (e.deltaY < 0 ? 1 : -1) * (e.altKey ? 0.1 : 1));
    }, { passive: false });
    el.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.1 : 0.5;
      const k = e.key;
      let v = null;
      if (k === "ArrowUp" || k === "ArrowRight") v = f.value + step;
      else if (k === "ArrowDown" || k === "ArrowLeft") v = f.value - step;
      else if (k === "PageUp") v = f.value + 3;
      else if (k === "PageDown") v = f.value - 3;
      else if (k === "Home") v = MIN_DB;
      else if (k === "End") v = MAX_DB;
      else if (k === "0") v = 0;
      if (v !== null) { e.preventDefault(); f.setLocal(v); }
    });
    f.render();
    return f;
  }

  function makeName(el, paramName) {
    const btn = $(".name", el), input = $(".name-edit", el);
    let original = "";
    const open = () => {
      original = btn.dataset.label || "";
      input.value = original;
      btn.hidden = true; input.hidden = false; input.focus(); input.select();
    };
    const close = (commit) => {
      if (input.hidden) return;
      input.hidden = true; btn.hidden = false;
      const v = input.value.trim();
      if (commit && v !== original) engine.setString(paramName(), v).catch(fail);
    };
    btn.addEventListener("dblclick", open);
    btn.addEventListener("keydown", (e) => { if (e.key === "F2" || e.key === "Enter") { e.preventDefault(); open(); } });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); close(true); btn.focus(); }
      if (e.key === "Escape") { e.preventDefault(); close(false); btn.focus(); }
    });
    input.addEventListener("blur", () => close(true));
    return btn;
  }

  function makeMeters(el) {
    const m = [$(".meter.l", el), $(".meter.r", el)];
    const p = [$(".peak.l", el), $(".peak.r", el)];
    return { m, p, shown: [-200, -200], peak: [-200, -200], peakAt: [0, 0], target: [-200, -200] };
  }

  function toggleBtn(btn, getName) {
    btn.addEventListener("click", () => {
      const on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(on));
      sendFloat(getName(), on ? 1 : 0);
    });
  }

  LAYOUT.strips.forEach((info, i) => {
    const el = $("#inputTpl").content.firstElementChild.cloneNode(true);
    el.dataset.kind = info.kind;
    const s = { el, info, meters: makeMeters(el) };
    buildScale($(".scale", el));
    s.fader = makeFader($(".fader", el), () => `Strip[${i}].Gain`, info.fallback + " level");
    s.name = makeName(el, () => `Strip[${i}].Label`);
    s.sub = $(".sub", el);
    s.routes = [...el.querySelectorAll(".route")];
    s.routes.forEach((b) => {
      b.setAttribute("aria-pressed", "false");
      toggleBtn(b, () => `Strip[${i}].${b.textContent}`);
    });
    s.mute = $(".mute", el); toggleBtn(s.mute, () => `Strip[${i}].Mute`);
    s.solo = $(".solo", el); toggleBtn(s.solo, () => `Strip[${i}].Solo`);
    s.mono = $(".mono", el);
    if (info.kind === "virt") { s.mono.textContent = "M.C."; s.mono.title = "Mute center channel"; }
    toggleBtn(s.mono, () => `Strip[${i}].${info.kind === "virt" ? "MC" : "Mono"}`);
    $("#inputs").appendChild(el);
    strips.push(s);
  });

  LAYOUT.buses.forEach((info, j) => {
    const el = $("#outputTpl").content.firstElementChild.cloneNode(true);
    el.dataset.kind = info.kind;
    const b = { el, info, meters: makeMeters(el) };
    $(".bus-id", el).textContent = info.id;
    buildScale($(".scale", el));
    b.fader = makeFader($(".fader", el), () => `Bus[${j}].Gain`, info.id + " level");
    b.name = makeName(el, () => `Bus[${j}].Label`);
    b.sub = $(".sub", el);
    b.mute = $(".mute", el); toggleBtn(b.mute, () => `Bus[${j}].Mute`);
    b.mono = $(".mono", el); toggleBtn(b.mono, () => `Bus[${j}].Mono`);
    b.eq = $(".eq", el); toggleBtn(b.eq, () => `Bus[${j}].EQ.on`);
    $("#outputs").appendChild(el);
    buses.push(b);
  });

  /* ---------- incoming state ---------- */
  const EDITIONS = { 1: "Voicemeeter", 2: "Voicemeeter Banana", 3: "Voicemeeter Potato" };
  let connected = null;
  const press = (btn, on) => btn.setAttribute("aria-pressed", String(!!on));

  function applyState(st) {
    // connection
    const status = $("#status"), text = $("#statusText");
    if (!st.installed) {
      status.dataset.state = "offline"; text.textContent = "Voicemeeter isn't installed";
    } else if (!st.connected) {
      status.dataset.state = "offline"; text.textContent = "Voicemeeter isn't running";
    } else {
      status.dataset.state = "online";
      const ed = EDITIONS[st.edition] || "Voicemeeter";
      text.textContent = engine.simulated ? `Preview with a simulated ${ed}` : `${ed} ${st.version || ""}`.trim();
      if (st.edition && st.edition !== 2 && connected !== true) toast(`Sleekmeeter is laid out for Banana — you're running ${ed}.`);
    }
    showOffline(!st.installed ? "missing" : !st.connected ? "stopped" : null);
    connected = !!st.connected;
    if (!st.connected || !st.strips) return;

    st.strips.slice(0, strips.length).forEach((d, i) => {
      const s = strips[i];
      const name = d.label || (s.info.kind === "hw" ? d.device || s.info.fallback : s.info.fallback);
      s.name.textContent = name;
      s.name.dataset.label = d.label || "";
      s.name.title = "Double-click to rename";
      s.sub.textContent = s.info.kind === "virt" ? "Virtual input" : (!d.device ? "No device" : name === d.device ? "Hardware input" : d.device);
      s.sub.title = s.sub.textContent;
      s.fader.setRemote(d.gain);
      s.routes.forEach((b) => {
        const k = +b.dataset.bus;
        press(b, k < 3 ? d.a[k] : d.b[k - 3]);
      });
      press(s.mute, d.mute); press(s.solo, d.solo);
      press(s.mono, s.info.kind === "virt" ? d.mc : d.mono);
      s.el.classList.toggle("muted", !!d.mute);
    });
    st.buses.slice(0, buses.length).forEach((d, j) => {
      const b = buses[j];
      const hw = b.info.kind === "hw";
      const name = d.label || (hw ? d.device || "No device" : "Virtual output");
      b.name.textContent = name;
      b.name.dataset.label = d.label || "";
      b.sub.textContent = hw ? (d.label ? d.device || "No device" : "Hardware output") : (d.label ? "Virtual output" : "Voicemeeter " + b.info.id);
      b.sub.title = b.sub.textContent;
      b.fader.setRemote(d.gain);
      press(b.mute, d.mute); press(b.mono, d.mono); press(b.eq, d.eq);
      b.el.classList.toggle("muted", !!d.mute);
    });
  }

  /* ---------- meters: fast attack, smooth release, 1.5 s peak hold ---------- */
  function applyLevels(lv) {
    (lv.inputs || []).forEach((pair, i) => { if (strips[i]) strips[i].meters.target = pair; });
    (lv.outputs || []).forEach((pair, j) => { if (buses[j]) buses[j].meters.target = pair; });
  }
  let lastT = performance.now();
  function frame(t) {
    const dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
    for (const c of strips.concat(buses)) {
      const M = c.meters;
      for (let ch = 0; ch < 2; ch++) {
        const target = connected ? M.target[ch] : -200;
        const cur = M.shown[ch];
        const next = target >= cur ? target : Math.max(target, cur - 26 * dt);
        if (next !== cur) {
          M.shown[ch] = next;
          M.m[ch].style.setProperty("--lvl", (dbToPos(next) * 100).toFixed(2) + "%");
        }
        if (next > M.peak[ch] || t - M.peakAt[ch] > 1500) {
          if (next > M.peak[ch]) { M.peak[ch] = next; M.peakAt[ch] = t; }
          else M.peak[ch] = Math.max(next, M.peak[ch] - 20 * dt);
          const p = dbToPos(M.peak[ch]);
          M.p[ch].style.setProperty("--pk", p.toFixed(4));
          M.p[ch].style.setProperty("--pk-o", p > 0.01 ? 0.8 : 0);
        }
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ---------- offline overlay ---------- */
  const launchBtn = $("#launchBtn");
  function showOffline(kind) {
    const ov = $("#offline");
    ov.hidden = !kind;
    if (!kind) { launchBtn.disabled = false; launchBtn.textContent = "Start Voicemeeter"; return; }
    if (kind === "missing") {
      $("#offlineTitle").textContent = "Voicemeeter isn't installed";
      $("#offlineBody").textContent = "Install Voicemeeter Banana from voicemeeter.com, then reopen Sleekmeeter.";
      launchBtn.hidden = true;
    } else {
      $("#offlineTitle").textContent = "Voicemeeter isn't running";
      $("#offlineBody").textContent = "Sleekmeeter controls Voicemeeter Banana. Start it and your mixer appears here.";
      launchBtn.hidden = false;
    }
  }
  launchBtn.addEventListener("click", () => {
    launchBtn.disabled = true; launchBtn.textContent = "Starting Voicemeeter…";
    engine.launch().catch((e) => { fail(e); });
    setTimeout(() => { launchBtn.disabled = false; launchBtn.textContent = "Start Voicemeeter"; }, 10000);
  });

  /* ---------- more menu ---------- */
  const moreBtn = $("#moreBtn"), moreMenu = $("#moreMenu");
  const setMenu = (open) => { moreMenu.hidden = !open; moreBtn.setAttribute("aria-expanded", String(open)); if (open) moreMenu.querySelector("button").focus(); };
  moreBtn.addEventListener("click", () => setMenu(moreMenu.hidden));
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !moreMenu.hidden) { setMenu(false); moreBtn.focus(); } });
  moreMenu.addEventListener("click", (e) => {
    const a = e.target.closest("button")?.dataset.action;
    if (!a) return;
    setMenu(false);
    if (a === "show") engine.setFloat("Command.Show", 1).catch(fail);
    if (a === "restart") engine.setFloat("Command.Restart", 1).then(() => toast("Restarting audio engine")).catch(fail);
    if (a === "unsolo") strips.forEach((s, i) => { if (s.solo.getAttribute("aria-pressed") === "true") sendFloat(`Strip[${i}].Solo`, 0); });
  });

  /* ---------- scenes ---------- */
  const dlg = $("#scenesDlg"), list = $("#sceneList");
  async function renderScenes() {
    const names = await engine.listScenes().catch((e) => { fail(e); return []; });
    list.textContent = "";
    if (!names.length) {
      const li = document.createElement("li");
      li.className = "empty"; li.textContent = "No scenes yet. Set up your mix, name it below and save it.";
      list.appendChild(li);
      return;
    }
    for (const n of names) {
      const li = document.createElement("li");
      const load = document.createElement("button");
      load.type = "button"; load.className = "load"; load.textContent = n;
      load.addEventListener("click", async () => {
        try { await engine.loadScene(n); setScene(n); toast(`Loaded “${n}”`); dlg.close(); } catch (e) { fail(e); }
      });
      const del = document.createElement("button");
      del.type = "button"; del.className = "btn del"; del.textContent = "Delete";
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
  $("#scenesBtn").addEventListener("click", () => { renderScenes(); dlg.showModal(); });
  $("#sceneSave").addEventListener("submit", async (e) => {
    e.preventDefault();
    const n = $("#sceneName").value.trim().replace(/[\\/:*?"<>|]/g, "");
    if (!n) return;
    try { await engine.saveScene(n); $("#sceneName").value = ""; setScene(n); toast(`Saved “${n}”`); renderScenes(); } catch (err) { fail(err); }
  });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  engine.start(applyState, applyLevels).catch(fail);
})();
