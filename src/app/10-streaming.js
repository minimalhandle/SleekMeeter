/* Sleekmeeter mixer UI, part 10 of 14: Be right back, OBS, the soundboard, Twitch, going live, loudness and Sleekmeeter Remote.
   The parts load in order from index.html as plain scripts sharing one global scope (see
   src/app/README.md), so anything declared at the top of one part is visible in the others. */
"use strict";

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
  const ld = LD();
  $("#loudOn").checked = !!ld.on;
  $('[data-needs="loud"]').hidden = !ld.on;
  $("#loudTarget").value = String(ld.target);
  if ($("#loudTarget").selectedIndex < 0) $("#loudTarget").value = "-14";
  for (const r of liveRanges) r._sync();
  scheduleLoud();
}
const onCheck = (id, set) => $("#" + id).addEventListener("change", (e) => { set(e.target.checked); saveSettings(); syncLive(); applyStreamButtons(lastState); });
onCheck("mutedTalkOn", (v) => { MT().on = v; });
onCheck("mutedTalkPtt", (v) => { MT().ptt = v; });
onCheck("watchOn", (v) => { SW().on = v; });
onCheck("watchClip", (v) => { SW().clip = v; });
onCheck("watchLive", (v) => { SW().onlyLive = v; });
onCheck("goLiveOnLive", (v) => { GL().onLive = v; });
onCheck("guardOn", (v) => { MG().on = v; });
onCheck("loudOn", (v) => { LD().on = v; });
const onPick = (id, set) => $("#" + id).addEventListener("change", (e) => { set(e.target.value); saveSettings(); syncLive(); applyStreamButtons(lastState); });
onPick("streamBus", (v) => { settings.streamBus = v; });
onPick("mutedTalkTarget", (v) => { MT().target = v; });
onPick("guardStrip", (v) => { MG().strip = v; });
onPick("guardWhen", (v) => { MG().when = v; });
onPick("loudTarget", (v) => { LD().target = +v; });

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

/* ---------- stream loudness (loudness.rs) ---------- */
// A LUFS badge next to the Live tag, and a dialog with the detail, a fix for the stream
// output's fader, and how your voice sits against the game.
const LD = () => (settings.loudness = Object.assign({}, DEFAULT_SETTINGS.loudness, settings.loudness));
const loudDlg = $("#loudDlg");
const LOUD_TARGETS = { "-14": "YouTube, Twitch and most streaming", "-16": "podcasts and quieter streams", "-18": "voice-only streams", "-23": "TV broadcast" };
let loudTimer = null, loudLast = null;
const fmtLufs = (v) => (v == null ? "–" : v.toFixed(1));
// Within 1.5 LU of the target is on target, within 4 is close.
function loudState(v) {
  if (v == null) return "quiet";
  const d = Math.abs(v - LD().target);
  return d <= 1.5 ? "ok" : d <= 4 ? "warn" : "bad";
}
const loudStreamCh = () => {
  const def = defaultStreamBus();
  return chans.find((c) => c.prefix === settings.streamBus) || (def >= 0 ? chans.find((c) => c.prefix === `Bus[${def}]`) : null);
};

// Voice vs game: each input's level after its fader, averaged over the last few seconds it
// was making sound. Only inputs that go to the stream and aren't muted count.
const voiceGame = { mic: { db: null, secs: 0 }, game: { db: null, secs: 0 }, t: 0 };
function loudLevels(lv) {
  if (SIDE || !LD().on) return;
  const now = performance.now(), dt = voiceGame.t ? Math.min(0.5, (now - voiceGame.t) / 1000) : 0;
  voiceGame.t = now;
  const stream = loudStreamCh();
  const track = (slot, prefix) => {
    const ch = chans.find((c) => c.prefix === prefix);
    const sends = ch && stream && ch.data && !ch.data.mute && (ch.data.b?.[stream.i - layout.buses.filter((b) => b.kind === "hw").length] || ch.data.a?.[stream.i]);
    const pre = levelOf(lv, prefix);
    if (!ch || !sends || pre < -50) return;
    const post = pre + (ch.gain || 0);
    const a = 1 - Math.exp(-dt / 6);
    const s = voiceGame[slot];
    s.db = s.db == null ? post : 10 * Math.log10((1 - a) * 10 ** (s.db / 10) + a * 10 ** (post / 10));
    s.secs += dt;
  };
  track("mic", MT().target);
  track("game", (settings.chatBalance || {}).game);
}
function voiceGameText() {
  const game = (settings.chatBalance || {}).game;
  if (!game) return "Choose your game input in Game / Chat balance to compare it with your voice.";
  const { mic, game: g } = voiceGame;
  if (mic.secs < 3 || g.secs < 3) return "Talk while the game plays for a few seconds to compare them.";
  const d = Math.round(mic.db - g.db);
  if (d < 0) return `The game is ${-d} dB louder than your voice. Viewers may not hear you.`;
  if (d < 3) return `Your voice is only ${d} dB above the game. Most streamers keep it 3 to 10 dB above.`;
  if (d <= 12) return `Good: your voice sits ${d} dB above the game.`;
  return `Your voice is ${d} dB above the game, so the game may sound very quiet.`;
}

// Keep the header on one row: when it would wrap (narrow window, many pins and badges), compact
// it a step at a time (styles.css: .bar.tight-1, .tight-2). It still wraps if even that isn't enough.
function fitHeader() {
  const bar = $(".bar");
  if (!bar || typeof ResizeObserver !== "function") return;
  // Wrapped when one item starts below another's bottom (items in a row are centred, so their tops differ).
  const wraps = () => {
    const boxes = [...bar.children].filter((el) => el.offsetParent).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    return boxes.length > 1 && Math.max(...boxes.map((r) => r.top)) >= Math.min(...boxes.map((r) => r.bottom)) - 1;
  };
  let queued = false;
  const fit = () => {
    queued = false;
    bar.classList.remove("tight-1", "tight-2");
    if (document.body.classList.contains("is-mini")) return;
    for (const step of ["tight-1", "tight-2"]) { if (!wraps()) break; bar.classList.add(step); }
  };
  // A timer, not a frame: frames don't run while the window is hidden in the tray.
  const later = () => { if (!queued) { queued = true; setTimeout(fit, 0); } };
  let lastWidth = 0;
  new ResizeObserver(() => { if (bar.clientWidth !== lastWidth) { lastWidth = bar.clientWidth; later(); } }).observe(bar);
  window.addEventListener("resize", later);
  // Badges and pins appear and disappear as you go live, record or pin tools.
  new MutationObserver(later).observe(bar, { subtree: true, attributes: true, attributeFilter: ["hidden", "data-unpinned", "aria-pressed"], childList: true, characterData: true });
  later();
}

function paintLoud(st) {
  const badge = $("#loudBadge");
  const short = st && st.running && st.receiving !== false ? st.shortTerm ?? null : null;
  badge.hidden = SIDE || !LD().on || !(st && st.running);
  if (!badge.hidden) {
    $("#loudValue").textContent = fmtLufs(short);
    badge.dataset.state = loudState(short);
    badge.title = short == null ? "Stream loudness: no sound on the stream right now. Click for details"
      : `Stream loudness over the last 3 seconds, aiming for ${LD().target} LUFS. Click for details`;
  }
  if (!loudDlg.open) return;
  const target = LD().target, label = LOUD_TARGETS[String(target)] || "your target";
  const big = $(".loud-big", loudDlg);
  $("#loudBig").textContent = fmtLufs(short);
  big.dataset.state = loudState(short);
  const m = st && st.running ? st.momentary ?? null : null;
  $("#loudBar").style.clipPath = `inset(0 ${m == null ? 100 : (100 - Math.max(0, Math.min(1, (m + 40) / 40)) * 100).toFixed(1)}% 0 0)`;
  $("#loudTargetMark").style.left = `${((target + 40) / 40) * 100}%`;
  $("#loudMomentary").textContent = m == null ? "–" : `${fmtLufs(m)} LUFS`;
  $("#loudShort").textContent = short == null ? "–" : `${fmtLufs(short)} LUFS`;
  const integ = st && st.running ? st.integrated ?? null : null;
  $("#loudIntegrated").textContent = integ == null ? "–" : `${fmtLufs(integ)} LUFS`;
  const since = st && st.since ? st.since : 0;
  $("#loudSince").textContent = since >= 60 ? `(${Math.floor(since / 60)} min)` : since ? `(${since} s)` : "";
  const peak = st && st.running ? st.peak ?? null : null;
  $("#loudPeak").textContent = peak == null ? "–" : `${fmtLufs(peak)} dBFS${peak > -1 ? ": close to clipping" : ""}`;
  $("#loudVoice").textContent = voiceGameText();

  // The verdict and a one-click fix, judged on the whole stream once there's a minute of it.
  const fix = $("#loudFix");
  fix.hidden = true;
  const verdict = $("#loudVerdict");
  if (!st || !st.running) { verdict.textContent = (st && st.message && st.message !== "Off") ? st.message : "Turn on Stream loudness in Settings → Going live."; return; }
  if (short == null) { verdict.textContent = "No sound on the stream output right now."; return; }
  const judged = integ != null && since >= 60 ? integ : short;
  const diff = judged - target;
  if (Math.abs(diff) <= 1.5) { verdict.textContent = `On target for ${label} (${target} LUFS).`; return; }
  const by = Math.round(Math.abs(diff));
  verdict.textContent = diff < 0 ? `About ${by} dB too quiet for ${label} (${target} LUFS).` : `About ${by} dB too loud for ${label} (${target} LUFS).`;
  const ch = loudStreamCh();
  if (!ch || !connected) return;
  // Raising it must not push the peaks past -1 dBFS.
  let step = diff < 0 ? by : -by;
  if (step > 0 && peak != null) step = Math.min(step, Math.floor(-1 - peak));
  if (step === 0 || (step > 0 && step < 1)) {
    if (diff < 0) verdict.textContent += " The peaks are already near 0 dB, so raising it would distort. Try Gentle on the stream output's Sound tab.";
    return;
  }
  fix.hidden = false;
  fix.textContent = `Turn ${ch.info.id} ${step > 0 ? "up" : "down"} ${Math.abs(step)} dB`;
  fix.dataset.step = String(step);
}
async function pollLoud() {
  let st = null;
  if (!SIDE && LD().on) { try { st = await engine.loudnessStatus(); } catch (_) { st = null; } }
  loudLast = st;
  paintLoud(st);
}
function scheduleLoud() {
  clearTimeout(loudTimer);
  if (SIDE || !LD().on) { loudLast = null; paintLoud(null); return; }
  const wait = loudDlg.open ? 250 : document.hidden ? 3000 : 1000;
  loudTimer = setTimeout(async () => { await pollLoud(); scheduleLoud(); }, wait);
}
$("#loudBadge").addEventListener("click", async () => {
  if (!loudDlg.open) loudDlg.showModal();
  await pollLoud();
  scheduleLoud();
});
$("#loudReset").addEventListener("click", async () => {
  try { await engine.loudnessReset(); toast("Started measuring the whole stream again"); } catch (e) { fail(e); }
  pollLoud();
});
$("#loudFix").addEventListener("click", () => {
  const ch = loudStreamCh(), step = +$("#loudFix").dataset.step;
  if (!ch || !step) return;
  glideGain(ch, Math.max(MIN_DB, Math.min(MAX_DB, (ch.gain || 0) + step)));
  toast(`${ch.info.id} ${step > 0 ? "up" : "down"} ${Math.abs(step)} dB`);
  $("#loudFix").hidden = true;
});
$("#loudSettings").addEventListener("click", () => {
  loudDlg.close();
  $("#settingsBtn").click();
  selectSettingsCategory("streaming");
  const fold = $("#liveFold");
  fold.open = true;
  requestAnimationFrame(() => $("#loudOn").scrollIntoView({ block: "center" }));
});
loudDlg.addEventListener("click", (e) => { if (e.target === loudDlg) loudDlg.close(); });
loudDlg.addEventListener("close", scheduleLoud);
document.addEventListener("visibilitychange", scheduleLoud);

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
  text.textContent = RP().on ? [st.message || "", st.tracks || ""].filter(Boolean).join(" ") : "";
  text.dataset.ok = on && !st.tracks ? "1" : "";
}
// Inputs to keep as their own tracks too (replay.rs), up to four.
function renderReplayTracks() {
  const list = $("#replayTracks");
  list.textContent = "";
  const picked = RP().tracks || [];
  for (const ch of chans) {
    if (ch.kind !== "strip") continue;
    const b = Object.assign(document.createElement("button"), { type: "button", className: "tog arm", textContent: displayName(ch) });
    b.title = displayName(ch);
    b.dataset.color = look(ch).color;
    b.setAttribute("aria-pressed", String(picked.includes(ch.prefix)));
    b.addEventListener("click", () => {
      const cur = RP();
      const set = new Set(cur.tracks || []);
      if (set.has(ch.prefix)) set.delete(ch.prefix);
      else if (set.size >= 4) { toast("Up to four separate tracks"); return; }
      else set.add(ch.prefix);
      cur.tracks = chans.filter((c) => set.has(c.prefix)).map((c) => c.prefix);
      saveSettings();
      renderReplayTracks();
      setTimeout(refreshReplay, 1500);
    });
    list.appendChild(b);
  }
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
  renderReplayTracks();
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

/* ---------- Sleekmeeter Remote (phone page, Stream Deck plugin, OBS overlay) ---------- */
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
  $("#remotePublic").hidden = !(RM().on && st.publicNetwork && RM().scope !== "pc");
  text.textContent = !RM().on ? "" : !on ? st.message || ""
    : st.pcOnly ? (RM().scope === "pc" ? "Only programs on this PC can connect." : "Only programs on this PC can connect while this network is Public.")
    : "Open this address on your phone while it's on the same Wi-Fi as this PC.";
  text.dataset.ok = on ? "1" : "";
}
function syncRemote() {
  const r = RM();
  $("#remoteOn").checked = !!r.on;
  $("#remoteOpts").hidden = !r.on;
  $("#remotePort").value = r.port || 8787;
  $("#remoteScope").value = r.scope || "network";
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
$("#remoteScope").addEventListener("change", async (e) => { RM().scope = e.target.value; await remoteSaved(); });
$("#remoteNetworkPage").addEventListener("click", () => engine.openWindowsPage("network").catch(fail));
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
