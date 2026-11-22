/* Sleekmeeter mixer UI, part 3 of 14: Output mix, live monitor, Potato output select, Game / Chat balance and the offline overlay.
   The parts load in order from index.html as plain scripts sharing one global scope (see
   src/app/README.md), so anything declared at the top of one part is visible in the others. */
"use strict";

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
function setMixHelp(help) {
  mixViewDlg.classList.toggle("help-mode", help);
  $("#mixHelp").hidden = !help;
  for (const id of ["mixView", "mixViewControls", "mixViewHint"]) $("#" + id).hidden = help;
  $("#mixPopBtn").hidden = help;
  $("#mixViewTitle").textContent = help ? "Your mix and your stream" : "Output mix";
}
mixViewBtn.addEventListener("click", () => {
  if (!layout || layout.edition !== 3) { setMixHelp(true); mixViewDlg.showModal(); return; }
  setMixHelp(false);
  // Already popped out: bring that window forward instead of opening a second copy.
  if (settings.mixWinOpen) { engine.mixWindow(true).catch(() => {}); return; }
  mixViewDlg.showModal(); buildMixView();
});
$("#mixHelpMute").addEventListener("click", () => {
  mixViewDlg.close();
  const first = chans.find((c) => c.kind === "strip" && !look(c).hidden);
  if (first) openDrawer(first, "routing");
});
$("#mixHelpMusic").addEventListener("click", () => { mixViewDlg.close(); openSettings("streaming"); });
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
  // Banana and Standard: the button opens help for keeping your mix and your stream apart.
  mixViewBtn.hidden = SIDE || !st.edition;
  mixViewBtn.title = on ? "Every input's level on every output at once, like Voicemeeter's Streamer View"
    : "Your mix and your stream's mix: what you can keep apart on this Voicemeeter";
  if (MIXWIN) {
    $("#mixViewNote").hidden = on;
    $("#mixView").hidden = !on;
    $("#mixViewControls").hidden = !on;
  } else if (!on && mixViewDlg.open && !mixViewDlg.classList.contains("help-mode")) mixViewDlg.close();
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
