/* Sleekmeeter mixer UI, part 12 of 14: Mic clean-up and plugins, Voicemeeter options, hear yourself, the setup guide, mic chain and mic tune-up.
   The parts load in order from index.html as plain scripts sharing one global scope (see
   src/app/README.md), so anything declared at the top of one part is visible in the others. */
"use strict";

/* ---------- mic clean-up: NVIDIA's AI and VST3 plugins, one chain per mic (micfx.rs, pluginhost.rs) ---------- */
const MICFX_EFFECTS = [["denoiser", "Background noise"], ["dereverb", "Room echo"], ["dereverb_denoiser", "Noise and room echo"]];
const newChain = (target) => ({ id: "c" + Date.now().toString(36), target: target || "", on: false, engine: "cpu", effect: "denoiser", strength: 100, aec: false, plugins: [] });
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
const RIDER = () => (CH().rider ||= { on: false, targetDb: -20, maxBoostDb: 9, maxCutDb: 12, speedDb: 3 });
const riderRanges = [
  bindRange("micRiderTarget", () => RIDER().targetDb ?? -20, (v) => { RIDER().targetDb = v; }, (v) => `${v} dB RMS`),
  bindRange("micRiderBoost", () => RIDER().maxBoostDb ?? 9, (v) => { RIDER().maxBoostDb = v; }, (v) => `+${v} dB`),
  bindRange("micRiderCut", () => RIDER().maxCutDb ?? 12, (v) => { RIDER().maxCutDb = v; }, (v) => `−${v} dB`),
  bindRange("micRiderSpeed", () => RIDER().speedDb ?? 3, (v) => { RIDER().speedDb = v; }, (v) => `${v} dB/s`),
];
const PLUGINS = () => (CH().plugins = Array.isArray(CH().plugins) ? CH().plugins : []);
const micFxRange = bindRange("micFxStrength", () => CH().strength ?? 100, (v) => { CH().strength = v; }, (v) => `${v}%`);
const hwInputs = () => {
  const hw = layout.strips.filter((s) => s.kind === "hw").length;
  return chans.filter((ch) => { const m = /^Strip\[(\d+)\]$/.exec(ch.prefix); return m && +m[1] < hw; });
};
// A chain can run on a mic (hardware input), a chat or app input (virtual input), or an output.
const fxKind = (target) => {
  const ch = chans.find((c) => c.prefix === target);
  if (!ch) return /^Bus/.test(target || "") ? "bus" : "hw";
  return ch.kind === "bus" ? "bus" : isHw(ch) ? "hw" : "virt";
};
const fxChannels = (kind) => chans.filter((ch) => fxKind(ch.prefix) === kind);
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
    else if (chain && !chain.off && !chain.running && !c.stereo && (c.on || c.aec || c.rider?.on) && chain.message) {
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
    paintDuckSpeechStatus(st);
    return st;
  }).catch(() => micFxLast).finally(() => { micFxRequest = null; });
  return micFxRequest;
}
function pollInputEffects() {
  const m = settings.micFx;
  const configured = m?.on || m?.aec || m?.plugins?.length
    || m?.chains?.some((c) => c.on || c.aec || c.rider?.on || c.plugins?.length)
    || Object.keys(settings.soundFx || {}).length
    || (settings.ducking?.on && settings.ducking?.voiceAware);
  if (configured && connected) {
    if (m && !Array.isArray(m.chains)) MF();
    fetchMicFxStatus().then(() => { if (drawerCh) paintSoundFx(); });
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
  const set = (x) => (!x.stereo && (x.on || x.aec || x.rider?.on)) || (x.plugins || []).some((p) => p.on !== false);
  const runningCount = Object.values(st.chains || {}).filter((x) => x.running).length;
  const wanted = MF().chains.some(set);
  $("#micFxMissing").hidden = !!c.stereo || !!st.available || !((c.on && c.engine !== "cpu") || c.aec);
  $("#micRiderStatus").textContent = c.rider?.on ? (cs.running && !cs.off ? `Current correction: ${Number(cs.riderGainDb || 0).toFixed(1)} dB` : cs.message || st.message || "Waiting for microphone processing…") : "";
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
  const freeOf = (kind) => fxChannels(kind).filter((ch) => !cs.some((c) => c.target === ch.prefix));
  const adds = [
    ["hw", "+ Add a mic", "Clean up another of Voicemeeter's hardware inputs too, like a guest mic"],
    ["virt", "+ Chat or app input", "Clean up voices on a virtual input, like the one Discord plays into, or add plugins to it"],
    ["bus", "+ An output", "Run VST3 plugins on an output, like your headphones"],
  ];
  let anyFree = false;
  for (const [kind, label, title] of adds) {
    const free = freeOf(kind);
    if (!free.length || cs.length >= 5) continue;
    anyFree = true;
    const add = document.createElement("button");
    add.type = "button"; add.className = "btn";
    add.textContent = label;
    add.title = title;
    add.addEventListener("click", () => {
      stopListening();
      // Chat: prefer the input named for it.
      const pick = kind === "virt" ? free.find((ch) => /chat|discord|voice|aux/i.test(displayName(ch))) || free[0] : free[0];
      cs.push(Object.assign(newChain(pick.prefix), kind === "bus" ? { stereo: true } : {}));
      micSel = cs.length - 1;
      saveSettings();
      syncMicFx();
    });
    tabs.appendChild(add);
  }
  tabs.hidden = cs.length < 2 && !anyFree;
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
        `${preview.on ? `${preview.effect}, ${preview.strength}%` : "Noise removal off"} · Level riding ${preview.rider?.on ? "on" : "off"} · Speaker echo removal ${preview.aec ? "on" : "off"}`;
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
  $("#micFxListen").textContent = fxKind(CH().target) === "hw" ? "Listen to this mic" : "Listen to this input";
  engine.micFxListen("", false).catch(() => {});
}
$("#micFxListen").addEventListener("click", async () => {
  try {
    listening = await engine.micFxListen(CH().id, !listening);
    $("#micFxListen").setAttribute("aria-pressed", listening ? "true" : "false");
    $("#micFxListen").textContent = listening ? "Stop listening" : fxKind(CH().target) === "hw" ? "Listen to this mic" : "Listen to this input";
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
    setTimeout(() => { delete btn.dataset.sure; btn.textContent = fxKind(CH().target) === "hw" ? "Remove this mic" : "Remove this tab"; }, 4000);
    return;
  }
  delete btn.dataset.sure;
  stopListening();
  cs.splice(micSel, 1);
  micSel = Math.max(0, micSel - 1);
  saveSettings();
  syncMicFx();
});

function syncMicFx() {
  const m = MF(), c = CH();
  renderMicTabs();
  // Mics, chat and app inputs, and outputs, each in their own group.
  const sel = $("#micFxTarget");
  sel.textContent = "";
  for (const [kind, label] of [["hw", "Mics (hardware inputs)"], ["virt", "Chat and app inputs (virtual)"], ["bus", "Outputs"]]) {
    const list = fxChannels(kind);
    if (!list.length) continue;
    const group = Object.assign(document.createElement("optgroup"), { label });
    for (const ch of list) {
      const taken = m.chains.some((x) => x !== c && x.target === ch.prefix);
      const tag = kind === "bus" ? `${ch.info.id} · ` : "";
      const o = new Option(tag + displayName(ch) + (taken ? " (another tab)" : ""), ch.prefix);
      o.disabled = taken;
      group.appendChild(o);
    }
    sel.appendChild(group);
  }
  sel.value = c.target;
  if (sel.selectedIndex < 0 || sel.options[sel.selectedIndex].disabled) {
    const first = [...sel.options].find((o) => !o.disabled);
    if (first) { sel.value = first.value; c.target = first.value; }
  }
  const kind = fxKind(c.target);
  // Outputs carry music and games: always stereo, plugins only.
  if (kind === "bus" && !c.stereo) { c.stereo = true; saveSettings(); }
  const modeSel = $("#micFxMode");
  modeSel.options[0].textContent = kind === "virt" ? "Voices (like a voice chat app)" : "Mono microphone";
  modeSel.options[1].textContent = kind === "virt" ? "Stereo (music, games)" : "Stereo hardware input";
  modeSel.closest(".field").hidden = kind === "bus";
  $("#micFxTargetLabel").textContent = kind === "hw" ? "Mic" : kind === "virt" ? "Input" : "Output";
  $("#micFxOn").checked = !!c.on;
  const cpu = c.engine === "cpu";
  $("#micFxEngine").value = cpu ? "cpu" : "nvidia";
  $("#micFxEngineRow").hidden = !!c.stereo;
  $("#micFxOnText").textContent = cpu ? "Remove background noise with CPU RNNoise (48 kHz, no GPU required)" : "Remove background noise with NVIDIA RTX";
  $("#micFxEffect").closest(".field").hidden = cpu;
  $("#micRiderSection").hidden = !!c.stereo || kind !== "hw";
  $("#micRiderOn").checked = !!RIDER().on;
  $("#micRiderOptions").hidden = !RIDER().on;
  riderRanges.forEach((r) => r._sync());
  modeSel.value = c.stereo ? "stereo" : "mic";
  $("#micFxStereoHint").hidden = !c.stereo || kind === "bus";
  $("#micFxOutHint").hidden = kind !== "bus";
  $("#micFxVirtHint").hidden = kind !== "virt" || !!c.stereo;
  $("#micFxOn").closest("label").hidden = !!c.stereo;
  // Speaker echo only matters on a mic.
  $("#micFxAec").closest("label").hidden = !!c.stereo || kind !== "hw";
  $('[data-needs="micfx"]').hidden = !!c.stereo || !c.on;
  $("#micFxAec").checked = !!c.aec;
  $('[data-needs="micaec"]').hidden = !!c.stereo || !c.aec || kind !== "hw";
  $("#micFxListen").hidden = kind === "bus";
  $("#micFxListen").textContent = listening ? "Stop listening" : kind === "hw" ? "Listen to this mic" : "Listen to this input";
  $("#micFxRemoveMic").textContent = kind === "hw" ? "Remove this mic" : "Remove this tab";
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
$("#micFxEngine").addEventListener("change", (e) => { CH().engine = e.target.value; saveSettings(); syncMicFx(); });
$("#micRiderOn").addEventListener("change", (e) => { RIDER().on = e.target.checked; saveSettings(); syncMicFx(); });
$("#micFxMode").addEventListener("change", (e) => {
  stopListening();
  CH().stereo = e.target.value === "stereo";
  saveSettings();
  syncMicFx();
});
$("#micFxAec").addEventListener("change", (e) => { CH().aec = e.target.checked; saveSettings(); syncMicFx(); });
$("#micFxAecRef").addEventListener("change", (e) => { MF().aecRef = e.target.value; saveSettings(); });
$("#micFxTarget").addEventListener("change", (e) => {
  stopListening();
  const c = CH(), wasBus = fxKind(c.target) === "bus";
  c.target = e.target.value;
  // Leaving an output: back to the usual mono voice mode.
  if (wasBus && fxKind(c.target) !== "bus") c.stereo = false;
  saveSettings(); syncMicFx(); setTimeout(refreshMicFx, 800);
});
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

/* ---------- setup guide ---------- */
// Five short steps: start, headphones (A1's device), mic (a hardware input's device), how you
// use it (routing for chat or streaming), then a review. Nothing changes before Apply. It opens
// by itself once on a fresh install (settings.setupGuide is "pending") and from the ⋯ menu.
const setupDlg = $("#setupDlg");
const SETUP_LAST = 4;
const setup = { step: 0, devices: { inputs: [], outputs: [] }, winWrong: false, applied: false };
const setupKind = () => setupDlg.querySelector("input[name=setupKind]:checked").value;
const strips = () => chans.filter((c) => c.kind === "strip");
const virtBuses = () => layout.buses.filter((b) => b.kind === "virt");
const busPrefix = (b) => `Bus[${layout.buses.indexOf(b)}]`;
const headphoneBus = () => chans.find((c) => c.kind === "bus" && isHw(c));
// The stream mix can't be B1 when B1 is what friends hear in chat.
const streamChoices = () => virtBuses().slice(1);
// The names Windows gives Voicemeeter's virtual inputs, in strip order.
const VIRT_INPUT_NAMES = ["Voicemeeter Input", "Voicemeeter AUX Input", "Voicemeeter VAIO3 Input"];
const virtInputName = (ch) => VIRT_INPUT_NAMES[strips().filter((c) => !isHw(c)).indexOf(ch)] || displayName(ch);

// What each strip should send to, per scenario. A = headphones/speakers, B = virtual outputs.
function setupRoutes(kind, micI, streamParam) {
  const chat = virtBuses()[0];
  const ears = layout.buses.find((b) => b.kind === "hw");
  const plan = [];
  for (const ch of strips()) {
    const on = {};
    for (const b of layout.buses) on[b.param] = false;
    const isMic = ch.i === micI;
    if (chat) on[chat.param] = isMic;                       // B1: what friends hear
    if (!isMic && ears) on[ears.param] = true;              // A1: your ears
    if (kind === "stream" && streamParam) on[streamParam] = true; // the stream mix
    plan.push({ ch, on, isMic });
  }
  return plan;
}
// A device menu like the drawer's, with "keep what's there" first.
function fillSetupDevices(sel, list, current, skipVirtual) {
  sel.textContent = "";
  sel.appendChild(new Option(current ? `${current} (current)` : "No device (current)", ""));
  for (const [type, label] of [["wdm", "WDM (recommended)"], ["ks", "Kernel streaming"], ["mme", "MME"]]) {
    const items = list.filter((d) => d.type === type && !(skipVirtual && /voicemeeter|vb-audio/i.test(d.name)));
    if (!items.length) continue;
    const og = document.createElement("optgroup");
    og.label = label;
    for (const d of items) og.appendChild(new Option(d.name, `${type}|${d.name}`));
    sel.appendChild(og);
  }
  sel.value = "";
}
const setupMicStrip = () => strips().find((c) => c.i === +$("#setupMic").value);
function fillSetupMic() {
  const ch = setupMicStrip();
  fillSetupDevices($("#setupMicDev"), setup.devices.inputs || [], (ch && ch.data && ch.data.device) || "", true);
}
const pickedDevice = (sel) => { const [type, ...rest] = sel.value.split("|"); return sel.value ? { type, name: rest.join("|") } : null; };

// Everything Apply will do, as [label, detail] pairs for the review list.
function setupChanges() {
  const out = [];
  const hp = pickedDevice($("#setupHp")), mic = pickedDevice($("#setupMicDev"));
  const hpBus = headphoneBus(), micCh = setupMicStrip();
  if (hp && hpBus) out.push([`${hpBus.info.id || "A1"} plays on`, hp.name]);
  if (mic && micCh) out.push([`${displayName(micCh)} listens to`, mic.name]);
  const kind = setupKind(), stream = kind === "stream" ? $("#setupStream").value : "";
  for (const p of setupRoutes(kind, micCh ? micCh.i : 0, stream)) {
    const sends = layout.buses.filter((b) => p.on[b.param]).map((b) => b.id);
    out.push([displayName(p.ch), sends.length ? `sends to ${sends.join(" ")}` : "sends to nothing"]);
  }
  if (kind === "stream" && stream) out.push(["Stream output", `${stream}, for the go-live check, Music off stream and Instant replay`]);
  if (setup.winWrong && $("#setupWin").checked) out.push(["Windows sound", "plays through Voicemeeter"]);
  return out;
}
function paintSetupStart() {
  const ok = !!connected;
  $("#setupVmState").textContent = ok ? "Voicemeeter is running, so you're ready to start."
    : vmInstalled ? "Voicemeeter isn't running yet. Start it to continue." : "Voicemeeter isn't installed. Install it from vb-audio.com, then start it.";
  $("#setupVmRow").hidden = ok || !vmInstalled;
  if (setup.step === 0) $("#setupNext").disabled = !ok;
}
function paintSetupStep() {
  const s = setup.step;
  setupDlg.querySelectorAll(".setup-page").forEach((p) => { p.hidden = +p.dataset.page !== s; });
  setupDlg.querySelectorAll("#setupSteps li").forEach((li, i) => { li.className = i < s ? "done" : i === s ? "now" : ""; if (i === s) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current"); });
  $("#setupBack").hidden = s === 0 || setup.applied;
  $("#setupSkip").hidden = setup.applied;
  const next = $("#setupNext");
  next.disabled = false;
  next.textContent = s === 0 ? "Start" : s < SETUP_LAST ? "Next" : setup.applied ? "Done" : "Apply";
  if (s === 0) paintSetupStart();
  if (s === 3) {
    const stream = setupKind() === "stream";
    $("#setupDiscordRow").hidden = !stream;
    $("#setupStreamRow").hidden = !stream || !streamChoices().length;
    $("#setupWinRow").hidden = !setup.winWrong;
  }
  if (s === SETUP_LAST) {
    $("#setupReview").hidden = setup.applied;
    $("#setupDone").hidden = !setup.applied;
    if (!setup.applied) {
      const ul = $("#setupPlan");
      ul.textContent = "";
      for (const [label, detail] of setupChanges()) {
        const li = document.createElement("li");
        li.append(Object.assign(document.createElement("b"), { textContent: label }), ` ${detail}`);
        ul.appendChild(li);
      }
      if (setupKind() === "stream" && !streamChoices().length) {
        const li = Object.assign(document.createElement("li"), { className: "warn", textContent: "This Voicemeeter has only one virtual output (B1), so it can't make a separate stream mix. Banana and Potato have more." });
        ul.appendChild(li);
      }
    }
  }
}
function setupLevels(lv) {
  if (setup.step !== 2) return;
  const ch = setupMicStrip();
  if (!ch) return;
  const db = levelOf(lv, ch.prefix);
  setup.shown = db > (setup.shown ?? -60) ? db : Math.max(db, (setup.shown ?? -60) - 2);
  $("#setupMicFill").style.transform = `scaleX(${Math.max(0, Math.min(1, (setup.shown + 60) / 60)).toFixed(3)})`;
}
function openSetup() {
  setup.step = 0; setup.applied = false; setup.shown = -60;
  paintSetupStep();
  if (!setupDlg.open) setupDlg.showModal();
}
// Read devices and fill the menus once Voicemeeter is running (on Start).
async function prepareSetup() {
  try { setup.devices = await engine.devices(); } catch (_) { setup.devices = { inputs: [], outputs: [] }; }
  try { const w = await engine.windowsOutput(); setup.winWrong = !!w && w.state === "wrong"; } catch (_) { setup.winWrong = false; }
  const hpBus = headphoneBus();
  $("#setupHpBus").textContent = (hpBus && hpBus.info.id) || "A1";
  fillSetupDevices($("#setupHp"), setup.devices.outputs || [], (hpBus && hpBus.data && hpBus.data.device) || "", true);
  const mic = $("#setupMic");
  mic.textContent = "";
  for (const ch of strips().filter(isHw)) mic.appendChild(new Option(displayName(ch), ch.i));
  mic.value = "0";
  fillSetupMic();
  const disc = $("#setupDiscord");
  disc.textContent = "";
  const virtIns = strips().filter((c) => !isHw(c));
  for (const ch of virtIns) disc.appendChild(new Option(`${displayName(ch)} (${virtInputName(ch)})`, ch.i));
  // A strip already named for chat, else the second virtual input (the first plays Windows sound).
  const chatIn = virtIns.find((c) => /discord|chat|voice|teamspeak|skype/i.test(displayName(c))) || virtIns[1] || virtIns[0];
  if (chatIn) disc.value = String(chatIn.i);
  const st = $("#setupStream");
  st.textContent = "";
  for (const b of streamChoices()) st.appendChild(new Option(`${b.id} (Voicemeeter Out ${b.param})`, b.param));
  const saved = layout.buses[+((/^Bus\[(\d+)\]$/.exec(settings.streamBus || "") || [])[1] ?? -1)];
  st.value = saved && streamChoices().includes(saved) ? saved.param : (streamChoices()[0] || {}).param || "";
  $("#setupWin").checked = true;
}
async function applySetup() {
  const next = $("#setupNext");
  next.disabled = true;
  const kind = setupKind(), micCh = setupMicStrip(), hpBus = headphoneBus();
  const stream = kind === "stream" ? $("#setupStream").value : "";
  await engine.backupBefore("the setup guide").catch(() => {});
  try {
    const hp = pickedDevice($("#setupHp")), mic = pickedDevice($("#setupMicDev"));
    if (hp && hpBus) await engine.setString(`${hpBus.prefix}.device.${hp.type || "wdm"}`, hp.name);
    if (mic && micCh) await engine.setString(`${micCh.prefix}.device.${mic.type || "wdm"}`, mic.name);
  } catch (e) { fail(e); next.disabled = false; return; }
  for (const p of setupRoutes(kind, micCh ? micCh.i : 0, stream)) {
    for (const [param, v] of Object.entries(p.on)) sendFloat(`${p.ch.prefix}.${param}`, v ? 1 : 0);
  }
  const streamBusDef = layout.buses.find((b) => b.param === stream);
  if (streamBusDef) settings.streamBus = busPrefix(streamBusDef);
  settings.setupGuide = "done";
  saveSettings();
  if (setup.winWrong && $("#setupWin").checked) await fixAudio();
  // What to change in the other apps.
  const todo = $("#setupTodo");
  todo.textContent = "";
  const add = (html) => { const li = document.createElement("li"); li.innerHTML = html; todo.appendChild(li); };
  const chat = virtBuses()[0];
  if (chat) add(`In Discord or your voice chat app, set <b>Input Device</b> to <b>Voicemeeter Out ${chat.param}</b>.`);
  if (kind === "stream") {
    const discCh = strips().find((c) => c.i === +$("#setupDiscord").value);
    if (discCh) add(`Set Discord's <b>Output Device</b> to <b>${virtInputName(discCh)}</b>, so it gets its own fader.`);
    if (stream) add(`In OBS, add an <b>Audio Input Capture</b> of <b>Voicemeeter Out ${stream}</b>, and turn off OBS's own Desktop Audio and Mic so nothing plays twice.`);
  }
  $("#setupGoLive").hidden = kind !== "stream";
  setup.applied = true;
  paintSetupStep();
  toast("Sound set up");
}
setupDlg.addEventListener("change", (e) => {
  if (e.target.id === "setupMic") fillSetupMic();
  if (setup.step === 3) paintSetupStep();
});
$("#setupNext").addEventListener("click", async () => {
  if (setup.step === SETUP_LAST) { if (setup.applied) setupDlg.close(); else applySetup(); return; }
  if (setup.step === 0) {
    if (!connected || !layout) return;
    $("#setupNext").disabled = true;
    await prepareSetup();
  }
  setup.step++;
  paintSetupStep();
});
$("#setupBack").addEventListener("click", () => { setup.step = Math.max(0, setup.step - 1); paintSetupStep(); });
// Skipping answers the first-start question too (the close event does as well, for the X).
$("#setupSkip").addEventListener("click", () => { markSetupAnswered(); setupDlg.close(); });
$("#setupLaunchVm").addEventListener("click", () => engine.launch().catch(fail));
$("#setupHear").addEventListener("click", () => { setupDlg.close(); openHear(); });
$("#setupGoLive").addEventListener("click", () => { setupDlg.close(); $("#goLiveBtn").click(); });
function markSetupAnswered() {
  if (settings.setupGuide === "pending") { settings.setupGuide = "skipped"; saveSettings(); }
}
setupDlg.addEventListener("close", markSetupAnswered);
// On a fresh install, once What's new (if any) has been read.
async function offerSetup() {
  if (SIDE || settings.setupGuide !== "pending" || document.querySelector("dialog[open]")) return;
  openSetup();
  await new Promise((done) => setupDlg.addEventListener("close", done, { once: true }));
}

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
