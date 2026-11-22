/* Sleekmeeter mixer UI, part 4 of 14: The header (pin, mini mode, more menu) and the settings dialog.
   The parts load in order from index.html as plain scripts sharing one global scope (see
   src/app/README.md), so anything declared at the top of one part is visible in the others. */
"use strict";

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
  if (a === "coach") openCoach();
  if (a === "crackle") openCrackle();
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
  // Only the text: at narrow widths the badge folds to its dot, and the label still names it.
  const recText = obsRecording ? "OBS Rec" : "Recording";
  badge.querySelector(".badge-text").textContent = recText;
  badge.setAttribute("aria-label", recText);
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
  setLaunchVoicemeeter: "launchVoicemeeter", setHideVoicemeeter: "hideVoicemeeter", setOsdOn: "osdOn", setOverlay: "overlay",
  setCheckUpdates: "checkUpdates", setBetaUpdates: "betaUpdates", setAutoRestart: "autoRestart", setBtWarn: "btWarn", setKeepWindowsOutput: "keepWindowsOutput", setUsagePing: "usagePing", setPanelDocked: "panelDocked", setPanelIcons: "panelIcons", setPanelMeters: "panelMeters", setPanelMute: "panelMute", setExtraBuses: "showExtraBuses",
  setHideSoloMono: "hideSoloMono", setStreamerMode: "streamerMode", setLockArrangement: "lockArrangement",
  setRouteNames: "routeNames",
};
for (const [id, key] of Object.entries(CHECKS)) {
  $("#" + id).addEventListener("change", (e) => {
    settings[key] = e.target.checked;
    syncChecks();
    saveSettings();
    if (key === "showExtraBuses") applyExtraBuses();
    if (key === "hideSoloMono") applySoloMono();
    if (key === "routeNames") applyRouteNames();
    if (key === "streamerMode") applyStreamer();
    if (key === "lockArrangement") applyArrangementLock();
    if (key === "checkUpdates") { if (e.target.checked) checkForUpdate(); else $("#updateWrap").hidden = true; }
    if (key === "betaUpdates") { $("#updateWrap").hidden = true; checkForUpdate(); }
  });
}
function syncChecks() {
  for (const [id, key] of Object.entries(CHECKS)) $("#" + id).checked = key === "osdOn" ? settings[key] !== false : !!settings[key];
  const tray = $("#setStartInTray");
  tray.disabled = !settings.startWithWindows;
  tray.closest(".check").classList.toggle("disabled", tray.disabled);
  // With the overlay off, where it shows and whether levels show don't apply.
  const osdOff = settings.osdOn === false;
  $("#setOverlayScreen").disabled = osdOff;
  $("#setOverlay").disabled = osdOff;
  $("#setOverlay").closest(".check").classList.toggle("disabled", osdOff);
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
// Output names on the routing buttons ("Headphones" instead of "A1"), for people new to Voicemeeter.
// A name that starts the same as another output's keeps its full name; long ones end in "…".
let routeNamesKey = "", routeNamesQueued = false;
function queueRouteNames() {
  if (routeNamesQueued) return;
  routeNamesQueued = true;
  // A timer rather than an animation frame, so it still runs while the window is in the background.
  setTimeout(() => { routeNamesQueued = false; applyRouteNames(); }, 0);
}
function routeName(param) {
  const j = layout.buses.findIndex((b) => b.param === param);
  const bus = chans.find((c) => c.kind === "bus" && c.i === j);
  return bus ? displayName(bus) : param;
}
function applyRouteNames() {
  if (!layout) return;
  const on = !!settings.routeNames;
  const full = layout.buses.map((b) => routeName(b.param));
  const key = on + "|" + full.join("|");
  if (key === routeNamesKey) return;
  routeNamesKey = key;
  document.body.classList.toggle("route-names", on);
  const words = full.map((n) => n.split(/\s+/));
  const short = full.map((n, k) => {
    const id = layout.buses[k].id;
    if (n.endsWith(id)) return id; // an output nobody named ("Output A3")
    const [head, ...rest] = words[k];
    const clash = words.filter((w) => w[0].toLowerCase() === head.toLowerCase()).length > 1;
    // "Stream mic" and "Stream mix" keep their whole names, so they can be told apart.
    return !clash || !rest.length ? head : n;
  });
  for (const ch of chans) {
    if (ch.kind !== "strip") continue;
    for (const t of ch.toggles) {
      const k = layout.buses.findIndex((b) => b.param === t.param);
      if (k < 0) continue;
      t.btn.textContent = on ? short[k] : t.param;
      t.btn.title = `Send to ${t.param} · ${full[k]}`;
    }
  }
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
  ["appearance", "Appearance & layout", "Themes, animation, the tray panel, channel buttons and the volume overlay."],
  ["mixer", "Mixer & devices", "Mixing tools, fader behaviour, audio devices and output recovery."],
  ["microphone", "Microphone", "Mic levels, noise clean-up and VST3 processing."],
  ["streaming", "Streaming", "Stream mode, going live and loudness, instant replay, OBS and Twitch."],
  ["controls", "Controls & remote", "Shortcuts, MIDI controllers, Stream Deck and Sleekmeeter Remote."],
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
  syncMidi();
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
