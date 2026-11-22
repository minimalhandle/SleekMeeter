/* Sleekmeeter mixer UI, part 8 of 14: Per-app volume and routing, the apps tray, saved assignments, signal paths and guided tests.
   The parts load in order from index.html as plain scripts sharing one global scope (see
   src/app/README.md), so anything declared at the top of one part is visible in the others. */
"use strict";

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
    const playing = row?.pids.length ? row.session.endpoints || [] : [];
    const onIt = playing.some((ep) => ep.toLowerCase() === id.toLowerCase());
    // Windows has the app somewhere else: say where, and offer to put it back.
    const elsewhere = id && dest && playing.length && !onIt ? playing[0] : "";
    const elsewhereName = elsewhere && (displayNameSafe(channelForDevice(elsewhere)) || routeDevices.find((d) => d.id.toLowerCase() === elsewhere.toLowerCase())?.name || "another device");
    const state = !id ? "Waiting to reset to Windows default" : !dest ? "Destination unavailable" : !row?.pids.length ? "Waiting for audio session"
      : onIt ? "Routed" : elsewhere ? `Windows is playing it on ${elsewhereName}` : "Saved · awaiting confirmation";
    const item = document.createElement("li");
    item.append(document.createTextNode(`${exe} → ${dest ? displayName(dest) : id ? "saved device" : "Windows default"} · ${state}`));
    if (elsewhere) {
      item.dataset.warn = "1";
      const fix = Object.assign(document.createElement("button"), { className: "btn", type: "button", textContent: "Put it back" });
      fix.setAttribute("aria-label", `Move ${exe} back to ${displayName(dest)}`);
      fix.addEventListener("click", () => saveAssignment(exe, dest));
      item.append(fix);
    }
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
