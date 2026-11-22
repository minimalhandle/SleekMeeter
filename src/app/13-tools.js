/* Sleekmeeter mixer UI, part 13 of 14: Check my setup, Windows sound output, the crackle doctor, mic coach, backups, Quick Actions and Audio Event History.
   The parts load in order from index.html as plain scripts sharing one global scope (see
   src/app/README.md), so anything declared at the top of one part is visible in the others. */
"use strict";

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
    if (it.action === "crackle") {
      const open = Object.assign(document.createElement("button"), { className: "btn", type: "button", textContent: "Open the crackle doctor" });
      open.addEventListener("click", () => { healthDlg.close(); openCrackle(); });
      body.appendChild(open);
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

/* ---------- crackle doctor ---------- */
const crackleDlg = $("#crackleDlg");
async function runCrackle() {
  const list = $("#crackleList");
  list.replaceChildren(Object.assign(document.createElement("li"), { className: "busy", textContent: "Checking…" }));
  let items;
  try { items = await engine.crackleCheck(); } catch (e) { items = [{ state: "bad", label: "Crackle doctor", detail: String(e && e.message ? e.message : e) }]; }
  list.textContent = "";
  for (const it of items) {
    const li = document.createElement("li");
    li.dataset.state = it.state;
    const mark = Object.assign(document.createElement("span"), { className: "mark", textContent: it.state === "ok" ? "✓" : it.state === "warn" ? "!" : "×" });
    const body = document.createElement("div");
    body.append(Object.assign(document.createElement("b"), { textContent: it.label }), Object.assign(document.createElement("span"), { className: "detail", textContent: it.detail }));
    if ((it.action === "set" && it.param) || (it.action === "page" && it.page)) {
      const btn = Object.assign(document.createElement("button"), { className: it.action === "set" ? "btn primary" : "btn", type: "button", textContent: it.button || "Fix it" });
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          if (it.action === "page") await engine.openWindowsPage(it.page);
          else {
            await engine.setFloat(it.param, it.value);
            toast(`${it.label}: changed. Voicemeeter restarts its audio for a moment.`);
            setTimeout(runCrackle, 2500);
          }
        } catch (err) { fail(err); }
        btn.disabled = false;
      });
      body.appendChild(btn);
    }
    li.append(mark, body);
    list.appendChild(li);
  }
}
function openCrackle() { if (!crackleDlg.open) crackleDlg.showModal(); runCrackle(); }
$("#crackleAgain").addEventListener("click", runCrackle);
crackleDlg.addEventListener("click", (e) => { if (e.target === crackleDlg) crackleDlg.close(); });

/* ---------- Bluetooth headset in call mode ---------- */
let btUsers = [];
if (!SIDE) engine.onBtCallMode((s) => {
  const now = s?.users || [];
  const fresh = now.filter((u) => !btUsers.some((b) => b.device === u.device && b.app === u.app));
  btUsers = now;
  if (fresh.length && settings.btWarn !== false) {
    const u = fresh[0];
    toast(`${u.app} is using the mic of ${u.device}, so Windows switched it to call quality. The crackle doctor says how to fix it.`);
  }
  if (crackleDlg.open) runCrackle();
}).catch(() => {});

/* ---------- mic coach ---------- */
const coachDlg = $("#coachDlg"), coachInput = $("#coachInput"), coachGo = $("#coachGo");
const COACH_ENOUGH = 12;
let coachOn = false, coachTimer = 0, coachLast = null;
const eqName = (id) => (SOUND_EQ.find(([v]) => v === id) || [id, id])[1].replace(/^Mic: (.)/, (_, c) => c.toUpperCase());
function coachTarget() { return chans.find((c) => c.prefix === coachInput.value); }
function paintCoachTips(s) {
  const list = $("#coachTips");
  list.textContent = "";
  if (!s?.enough) return;
  const tips = s.tips || [];
  if (!tips.length) {
    const li = document.createElement("li");
    li.dataset.state = "ok";
    const body = document.createElement("div");
    body.append(Object.assign(document.createElement("b"), { textContent: "Your mic sounds good" }),
      Object.assign(document.createElement("span"), { className: "detail", textContent: "No popping, harsh s's, boom, clipping or room noise worth fixing." }));
    li.append(Object.assign(document.createElement("span"), { className: "mark", textContent: "✓" }), body);
    list.appendChild(li);
    return;
  }
  for (const t of tips) {
    const li = document.createElement("li");
    li.dataset.state = t.id === "clip" ? "bad" : "warn";
    const body = document.createElement("div");
    body.append(Object.assign(document.createElement("b"), { textContent: t.title }), Object.assign(document.createElement("span"), { className: "detail", textContent: t.detail }));
    const button = (label, fn) => {
      const b = Object.assign(document.createElement("button"), { className: "btn", type: "button", textContent: label });
      b.addEventListener("click", fn);
      body.appendChild(b);
    };
    const target = s.target;
    if (t.fix && t.fix.eq) {
      const on = (settings.soundFx || {})[target]?.eq === t.fix.eq;
      button(on ? `${eqName(t.fix.eq)} EQ is on` : `Use the ${eqName(t.fix.eq)} EQ`, (e) => {
        settings.soundFx = { ...(settings.soundFx || {}), [target]: { ...((settings.soundFx || {})[target] || {}), eq: t.fix.eq } };
        saveSettings();
        e.target.textContent = `${eqName(t.fix.eq)} EQ is on`;
        const ch = chans.find((c) => c.prefix === target);
        toast(`${eqName(t.fix.eq)} EQ is on for ${ch ? displayName(ch) : "this mic"}. Change it in the input's Sound tab.`);
      });
    } else if (t.fix === "tune") button("Open Mic tune-up", () => { stopCoach(); coachDlg.close(); openMicTune(target); });
    else if (t.fix === "cleanup") button("Open mic clean-up", () => { stopCoach(); coachDlg.close(); openSettings("microphone"); });
    li.append(Object.assign(document.createElement("span"), { className: "mark", textContent: li.dataset.state === "bad" ? "×" : "!" }), body);
    list.appendChild(li);
  }
}
function paintCoach(s) {
  const heard = Math.min(1, (s?.speechSecs || 0) / COACH_ENOUGH);
  $("#coachFill").style.transform = `scaleX(${coachOn ? heard : s?.enough ? 1 : 0})`;
  let text;
  if (coachOn) {
    text = s?.message || (s?.enough
      ? "Keep talking if you like: the tips below get more accurate the longer the coach listens."
      : `Talk normally, like you do on stream. Heard ${Math.round(s?.speechSecs || 0)} of ${COACH_ENOUGH} seconds of talking.`);
  } else if (s?.enough) text = "Here's what the coach heard.";
  else text = s?.message || "Pick your mic, press Start listening, then talk normally for half a minute.";
  const status = $("#coachStatus");
  if (status.textContent !== text) status.textContent = text;
  coachGo.textContent = coachOn ? (s?.enough ? "Done" : "Stop") : s?.enough ? "Listen again" : "Start listening";
  coachInput.disabled = coachOn;
  paintCoachTips(s);
}
async function pollCoach() {
  const s = await engine.coachStatus().catch(() => null);
  if (!coachOn) return;
  if (s && s.running) coachLast = s;
  if (!s || !s.running) { stopCoach(s && s.enough !== undefined ? s : coachLast); return; }
  paintCoach(s);
  coachTimer = setTimeout(pollCoach, 300);
}
function stopCoach(final = coachLast) {
  clearTimeout(coachTimer);
  if (coachOn) engine.coachStop().catch(() => {});
  coachOn = false;
  coachLast = final;
  paintCoach(final);
}
async function startCoach() {
  if (!coachTarget()) return toast("Pick a microphone first");
  try { await engine.coachStart(coachInput.value); } catch (err) { return fail(err); }
  coachOn = true;
  coachLast = null;
  paintCoach(null);
  coachTimer = setTimeout(pollCoach, 300);
}
function openCoach(preferred) {
  if (!connected) return toast("Start Voicemeeter to use the Mic coach");
  if (coachDlg.open) return;
  const inputs = hwInputs();
  coachInput.replaceChildren(...inputs.map((ch) => new Option(displayName(ch), ch.prefix)));
  const target = preferred || settings.ducking?.trigger;
  if (inputs.some((ch) => ch.prefix === target)) coachInput.value = target;
  coachLast = null;
  paintCoach(null);
  coachDlg.showModal();
  coachGo.focus();
}
coachGo.addEventListener("click", () => { if (coachOn) stopCoach(); else startCoach(); });
coachInput.addEventListener("change", () => { coachLast = null; paintCoach(null); });
coachDlg.addEventListener("close", () => { if (coachOn) stopCoach(); });

/* ---------- backup and layout ---------- */
let migrationMappings = [];
$("#exportSetup").addEventListener("click", async () => {
  const button = $("#exportSetup"); button.disabled = true;
  try { const p = await engine.setupExport(); if (p) toast("Saved your complete setup package"); } catch (e) { fail(e); } finally { button.disabled = false; }
});
$("#previewSetup").addEventListener("click", async () => {
  const button = $("#previewSetup"); button.disabled = true; $("#setupMigrationPreview").hidden = true;
  try {
    const p = await engine.setupPreview(); if (!p) return;
    $("#applySetup").disabled = false; $("#cancelSetup").textContent = "Cancel";
    $("#setupEnableControls").checked = false;
    $("#setupMigrationSummary").textContent = `${p.files} files ready to import. Plugins remain off until you review them. Missing devices can be mapped below; leaving one unmapped clears that device in imported settings.`;
    const warnings = $("#setupMigrationWarnings"); warnings.replaceChildren();
    for (const text of [...p.warnings, ...p.missingPlugins.map(x => `Plugin unavailable locally: ${x}`), ...p.missingApps.map(x => `App not detected: ${x}`)]) warnings.appendChild(Object.assign(document.createElement("li"), { textContent: text }));
    const devices = $("#setupMigrationDevices"); devices.replaceChildren(); migrationMappings = [];
    for (const name of p.devices) {
      const row = document.createElement("label"); row.className = "row";
      row.appendChild(Object.assign(document.createElement("span"), { textContent: name }));
      const select = document.createElement("select"); select.appendChild(Object.assign(document.createElement("option"), { value: "", textContent: "Unmapped / no device" }));
      for (const local of p.localDevices) select.appendChild(Object.assign(document.createElement("option"), { value: local, textContent: local }));
      if (p.localDevices.includes(name)) select.value = name;
      row.appendChild(select); devices.appendChild(row); migrationMappings.push([name, select]);
    }
    for (const endpoint of p.appEndpoints || []) {
      const row = document.createElement("label"); row.className = "row";
      row.appendChild(Object.assign(document.createElement("span"), { textContent: `Saved app output: ${endpoint.name}` }));
      const select = document.createElement("select"); select.appendChild(Object.assign(document.createElement("option"), { value: "", textContent: "Unmapped / clear saved assignments" }));
      for (const local of p.localEndpoints || []) select.appendChild(Object.assign(document.createElement("option"), { value: local.id, textContent: local.name }));
      if ((p.localEndpoints || []).some(local => local.id === endpoint.id)) select.value = endpoint.id;
      else {
        const matches = (p.localEndpoints || []).filter(local => local.name === endpoint.name);
        if (matches.length === 1) select.value = matches[0].id;
      }
      row.appendChild(select); devices.appendChild(row); migrationMappings.push([`endpoint:${endpoint.id}`, select]);
    }
    $("#setupMigrationPreview").hidden = false;
  } catch (e) { fail(e); } finally { button.disabled = false; }
});
$("#cancelSetup").addEventListener("click", () => { $("#setupMigrationPreview").hidden = true; migrationMappings = []; });
$("#applySetup").addEventListener("click", async () => {
  const button = $("#applySetup"); button.disabled = true;
  migrationApplying = true; clearTimeout(saveTimer);
  try {
    const backup = await engine.setupApply(Object.fromEntries(migrationMappings.map(([name, select]) => [name, select.value])), $("#setupEnableControls").checked);
    reloadImportedSetup({ settings: await engine.getSettings(), backup });
  } catch (e) { migrationApplying = false; fail(e); button.disabled = false; }
});
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
    ["Crackle doctor", "Tools", "crackles pops dropouts stutter glitch sample rate buffer bluetooth power", openCrackle],
    ["Mic coach", "Tools", "microphone pops plosives sibilance esses boomy distance clipping noise", () => openCoach()],
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
  } else if (e.target === "crackle") openCrackle();
  else openHealth();
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

/* "My sound just cut out": what changed in the last two minutes, and whether each change
   can silence sound for a moment. */
const CUT_WINDOW_MS = 2 * 60 * 1000;
function cutOutReason(e) {
  const t = (e.title || "").replace(/^Preview · /, "");
  if (t === "App route applied") return `Sleekmeeter moved ${e.detail.split(" → ")[0]} to its saved output. Windows restarts an app's sound when it moves it, which can cut it for a moment.`;
  if (t.startsWith("Bluetooth headset switched")) return `${e.detail}. Windows switched the headset to call quality, which drops the sound briefly and brings it back muffled.`;
  if (t.includes("switched by fallback policy")) return `The device on ${t.split(" ")[0]} went away, so Voicemeeter switched to ${e.detail}. Sound on that output stops while it switches.`;
  if (t.startsWith("Audio engine restarted")) return "Voicemeeter restarted its audio engine after a device came back. Everything goes quiet for about a second while it restarts.";
  if (t === "Windows playback bypassed Voicemeeter") return `Windows moved its sound output to ${e.detail}, so apps stopped playing through the mixer.`;
  if (t === "Windows playback restored to Voicemeeter") return "Windows' sound output was moved back to Voicemeeter. Apps restart their sound when that happens.";
  if (t === "VST3 plugin quarantined") return `The mic plugin ${e.detail} stopped responding and was switched off.`;
  return e.detail ? `${t}: ${e.detail}` : t;
}
async function explainCutOut() {
  const out = $("#cutOutResult");
  out.hidden = false;
  out.textContent = "Looking at the last two minutes…";
  let events = [];
  try { events = await engine.audioEvents(); } catch (e) { out.textContent = String(e); return; }
  const since = Date.now() - CUT_WINDOW_MS;
  const recent = events.filter((e) => Number.isFinite(e.at) && e.at >= since).sort((a, b) => b.at - a.at);
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });
  out.replaceChildren();
  if (!recent.length) {
    out.append(Object.assign(document.createElement("p"), { textContent: "Nothing Sleekmeeter, Voicemeeter or Windows changed in the last two minutes, so the cause is somewhere else: the app itself, or audio that can't keep up." }));
    const doctor = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: "Open the Crackle doctor" });
    doctor.addEventListener("click", () => { audioEventsDlg.close(); openCrackle(); });
    out.append(doctor);
    return;
  }
  out.append(Object.assign(document.createElement("p"), { textContent: recent.length === 1 ? "This happened just before:" : "These happened just before (newest first):" }));
  const list = document.createElement("ul");
  for (const e of recent) {
    const li = document.createElement("li");
    const b = Object.assign(document.createElement("button"), { type: "button", className: "audio-event" });
    b.append(Object.assign(document.createElement("strong"), { textContent: cutOutReason(e) }),
      Object.assign(document.createElement("time"), { textContent: time.format(new Date(e.at)) }));
    b.addEventListener("click", () => showAudioEvent(e));
    li.append(b);
    list.append(li);
  }
  out.append(list);
}
$("#cutOutBtn").addEventListener("click", explainCutOut);
$("#healthCutOut").addEventListener("click", () => { healthDlg.close(); openAudioEvents(); explainCutOut(); });
audioEventsDlg.addEventListener("close", () => { $("#cutOutResult").hidden = true; });
