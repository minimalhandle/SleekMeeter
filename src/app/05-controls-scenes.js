/* Sleekmeeter mixer UI, part 5 of 14: MIDI controllers, scenes and automatic scene switching.
   The parts load in order from index.html as plain scripts sharing one global scope (see
   src/app/README.md), so anything declared at the top of one part is visible in the others. */
"use strict";

/* ---------- MIDI controller (midi.rs) ---------- */
// Learned controls, each with an action like a shortcut's. "fader" moves a level.
const MI = () => (settings.midi = Object.assign({}, DEFAULT_SETTINGS.midi, settings.midi, { maps: (settings.midi && settings.midi.maps) || [] }));
const MIDI_ACTIONS = [["fader", "Move the level"], ...ACTIONS.filter(([v]) => v !== "ptt" && v !== "ptm")];
let midiLearning = false, midiLearnTimer = null, midiStatusTimer = null;
const midiName = (m) => (m.kind === "pb" ? `Pitch bend · ch ${m.ch + 1}` : `${m.kind === "cc" ? "CC" : "Note"} ${m.num} · ch ${m.ch + 1}`);
function stopMidiLearn() {
  if (!midiLearning) return;
  midiLearning = false;
  clearTimeout(midiLearnTimer);
  engine.midiLearn(false).catch(() => {});
  renderMidi();
}
function renderMidi() {
  const list = $("#midiList");
  list.textContent = "";
  MI().maps.forEach((m, idx) => {
    const row = document.createElement("div");
    row.className = "hotkey";
    const ctl = document.createElement("span");
    ctl.className = "midi-control";
    ctl.append(midiName(m));
    if (m.dev) ctl.append(Object.assign(document.createElement("small"), { textContent: ` · ${m.dev}` }));
    ctl.title = `${midiName(m)}${m.dev ? ` on ${m.dev}` : ""}`;
    const act = document.createElement("select");
    act.setAttribute("aria-label", `What ${midiName(m)} does`);
    for (const [v, l] of MIDI_ACTIONS) act.appendChild(new Option(l, v));
    act.value = m.action;
    if (act.selectedIndex < 0) { m.action = "fader"; act.value = "fader"; }
    const tgt = document.createElement("select");
    fillTarget(tgt, m);
    tgt.disabled = NO_TARGET.has(m.action);
    act.addEventListener("change", () => {
      m.action = act.value;
      tgt.disabled = NO_TARGET.has(m.action);
      if (tgt.disabled) m.target = "";
      else { if (NAMED[m.action] || !/^(Strip|Bus)\[/.test(m.target || "")) m.target = ""; fillTarget(tgt, m); }
      saveSettings();
    });
    tgt.addEventListener("change", () => { m.target = tgt.value; saveSettings(); });
    const del = document.createElement("button");
    del.type = "button"; del.className = "btn icon"; del.setAttribute("aria-label", `Remove ${midiName(m)}`);
    del.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
    del.addEventListener("click", () => { MI().maps.splice(idx, 1); saveSettings(); renderMidi(); });
    row.append(ctl, act, tgt, del);
    list.appendChild(row);
  });
  const add = $("#addMidi");
  add.textContent = midiLearning ? "Cancel" : "Add a control";
  if (midiLearning) {
    const row = document.createElement("div");
    row.className = "hotkey";
    row.append(Object.assign(document.createElement("span"), { className: "midi-control learning", textContent: "Move a fader or knob, or press a button…" }));
    list.appendChild(row);
  }
}
async function refreshMidiStatus() {
  const el = $("#midiStatus");
  if (!MI().on) { el.textContent = ""; return; }
  let st;
  try { st = await engine.midiStatus(); } catch (_) { return; }
  el.textContent = "";
  const devices = st.devices || [];
  if (!devices.length) { el.textContent = "No MIDI controllers found. Plug one in; Sleekmeeter finds it within a second."; return; }
  const open = devices.filter((d) => d.open).map((d) => d.name);
  const parts = [];
  if (open.length) parts.push(`Listening to ${open.join(", ")}.`);
  else if (!midiLearning && !MI().maps.length) parts.push(`Found ${devices.map((d) => d.name).join(", ")}. Add a control to start.`);
  el.append(parts.join(" "));
  for (const d of devices.filter((d) => d.error)) {
    el.append(" ", Object.assign(document.createElement("span"), { className: "bad", textContent: `${d.name}: ${d.error}` }));
  }
}
function syncMidi() {
  const on = !!MI().on;
  $("#midiOn").checked = on;
  $('[data-needs="midi"]').hidden = !on;
  if (!on) stopMidiLearn();
  renderMidi();
  refreshMidiStatus();
  clearInterval(midiStatusTimer);
  if (on && settingsDlg.open) midiStatusTimer = setInterval(() => { if (settingsDlg.open) refreshMidiStatus(); else clearInterval(midiStatusTimer); }, 2000);
}
$("#midiOn").addEventListener("change", (e) => { MI().on = e.target.checked; saveSettings(); syncMidi(); });
$("#addMidi").addEventListener("click", () => {
  if (midiLearning) { stopMidiLearn(); return; }
  midiLearning = true;
  engine.midiLearn(true).catch(fail);
  renderMidi();
  clearTimeout(midiLearnTimer);
  midiLearnTimer = setTimeout(() => { stopMidiLearn(); toast("Nothing heard from a MIDI controller. Is it plugged in?"); }, 20000);
});
function onMidiLearned(c) {
  if (!midiLearning || !c) return;
  midiLearning = false;
  clearTimeout(midiLearnTimer);
  // Pads and keys send notes, so they start as buttons; faders and knobs move a level.
  const m = { dev: c.dev || "", kind: c.kind, ch: c.ch, num: c.num, action: c.kind === "note" ? "mute" : "fader", target: "Strip[0]" };
  MI().maps.push(m);
  saveSettings();
  renderMidi();
  refreshMidiStatus();
  toast(`Learned ${midiName(m)}. Choose what it does.`);
}
settingsDlg.addEventListener("close", stopMidiLearn);

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
      const ch = chans.find((c) => c.prefix === key);
      const label = ch ? displayName(ch) : key;
      if (saved.partial) {
        if (!target.chain && live?.chain) add(`${label} processing · remove chain`);
        else if (target.chain && !live?.chain) add(`${label} processing · restore saved chain`);
        else if (target.chain) {
          for (const field of new Set([...Object.keys(live.chain), ...Object.keys(target.chain)])) {
            if (["id", "target"].includes(field)) continue;
            if (JSON.stringify(live.chain[field]) !== JSON.stringify(target.chain[field])) add(`${label} processing · ${field} will change`);
          }
        }
        if (JSON.stringify(live?.live) !== JSON.stringify(target.live)) add(`${label} processing · bypass or live strength will change`);
        if (JSON.stringify(live?.states) !== JSON.stringify(target.states)) add(`${label} processing · saved plugin settings will change`);
        continue;
      }
      if (!live) continue;
      compare(`${label} mic chain bypass`, live.off, target.off, on);
      compare(`${label} mic strength`, live.strength, target.strength, (x) => `${x}%`);
    }
    if (!result.childElementCount) add(saved.channels ? "No differences found in the available preview data." : "This scene has no saved preview data.");
    if (!saved.partial && !hasRoutes) add("Routing preview is unavailable for this scene. Save it again to capture routes.");
    add(saved.partial ? "Only the selected channels and controls will change. Devices stay as they are." : "Applying also restores the Voicemeeter settings stored in the scene file.");
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
  const choices = $("#sceneChannels");
  choices.textContent = "";
  for (const ch of chans) {
    const label = document.createElement("label"), input = document.createElement("input");
    label.className = "check"; input.type = "checkbox"; input.value = ch.prefix; input.checked = true;
    label.append(input, document.createTextNode(displayName(ch))); choices.append(label);
  }
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
