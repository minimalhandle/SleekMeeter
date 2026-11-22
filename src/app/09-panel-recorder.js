/* Sleekmeeter mixer UI, part 9 of 14: About and logs, fades and ducking, the recorder, toasts and the tray volume panel.
   The parts load in order from index.html as plain scripts sharing one global scope (see
   src/app/README.md), so anything declared at the top of one part is visible in the others. */
"use strict";

/* ---------- settings: about and logs ---------- */
let appInfo = null;
// Local test builds (version ending in -dev) say so in the title bar, so they're never
// mistaken for an official release.
engine.appInfo().then((info) => {
  const v = info?.version || "";
  if (!/-dev$/.test(v)) return;
  const badge = $("#devBadge");
  badge.textContent = "DEV";
  badge.title = `Local test build ${v}`;
  badge.hidden = false;
  document.title = `Sleekmeeter ${v}`;
}).catch(() => {});
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
// fmtMs, fmtDbShort and bindRange are in 01-core.js: the settings part uses them while loading.
const F = () => (settings.fades = Object.assign({}, DEFAULT_SETTINGS.fades, settings.fades));
const D = () => (settings.ducking = Object.assign({}, DEFAULT_SETTINGS.ducking, settings.ducking));
const fadeDuckRanges = [
  bindRange("setMuteMs", () => F().muteMs, (v) => { F().muteMs = v; }, fmtMs),
  bindRange("setSceneMs", () => F().sceneMs, (v) => { F().sceneMs = v; }, fmtMs),
  bindRange("duckAmount", () => D().amount, (v) => { D().amount = v; }, (v) => fmtDbShort(-v)),
  bindRange("duckThreshold", () => D().threshold, (v) => { D().threshold = v; paintDuckLevel(true); }, fmtDbShort),
  bindRange("duckSpeechThreshold", () => D().speechThreshold, (v) => { D().speechThreshold = v; }, (v) => `${Math.round(v * 100)}%`),
  bindRange("duckAttack", () => D().attackMs, (v) => { D().attackMs = v; }, fmtMs),
  bindRange("duckHold", () => D().holdMs, (v) => { D().holdMs = v; }, fmtMs),
  bindRange("duckRelease", () => D().releaseMs, (v) => { D().releaseMs = v; }, fmtMs),
];
$("#setFades").addEventListener("change", (e) => { F().on = e.target.checked; saveSettings(); syncFadeDuck(); });
$("#duckVoiceAware").addEventListener("change", (e) => { D().voiceAware = e.target.checked; saveSettings(); syncFadeDuck(); });
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
  $("#duckVoiceAware").checked = !!d.voiceAware;
  $("#duckSpeechField").hidden = !d.voiceAware;
  $("#duckSpeechHint").hidden = !d.voiceAware;
  paintDuckSpeechStatus();
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
function paintDuckSpeechStatus(st) {
  const d = settings.ducking || {}, el = $("#duckSpeechStatus");
  if (!d.voiceAware) {
    el.textContent = "Level detection only. Enable speech detection to reject noise. Local speech detection requires 48 kHz and works with noise removal off.";
    return;
  }
  const triggers = [d.trigger, ...(d.also || [])];
  const messages = triggers.map((key) => {
    const ch = chans.find((c) => c.prefix === key), name = ch ? displayName(ch) : key;
    const s = st?.speech?.[key];
    if (!s) return `${name}: waiting for speech detection`;
    if (!s.available) return `${name}: ${s.message || "speech detection unavailable"}`;
    return `${name}: speech detection ready${Number.isFinite(s.probability) ? ` (${Math.round(s.probability * 100)}%)` : ""}`;
  });
  el.textContent = `${messages.join(" · ")}. Requires 48 kHz. Unavailable inputs cannot trigger ducking.`;
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
const recRunning = () => rec && (rec.state === "recording" || (rec.state === "playing" && !rec.external));
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
    paintStreamToolbar();
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
  // Playback started outside Sleekmeeter (a macro button's sound, Voicemeeter's window):
  // Voicemeeter keeps calling it playing after the file ends, so don't run a clock for it.
  const state = rec.state === "playing" && rec.external ? "stopped" : rec.state || "stopped";
  recBtn.dataset.state = state;
  $("#recLabel").textContent = state === "stopped" ? "" : state === "paused" ? "Paused" : recClock();
  recBtn.title = state === "stopped" ? "Recorder" : `Recorder: ${REC_STATES[state].toLowerCase()}`;
  paintStreamToolbar();
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
  if (!rec || SIDE) return;
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
  // Rows stack the inputs and outputs; the panel's column layout puts them side by side.
  const across = getComputedStyle(view).flexDirection === "row";
  const content = (across
    ? Math.max(0, ...lists.map((el) => el.offsetHeight))
    : lists.reduce((h, el) => h + el.offsetHeight, 0) + Math.max(0, lists.length - 1) * parseFloat(cs.rowGap || cs.gap || 0))
    + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const border = parseFloat(getComputedStyle(document.body).borderTopWidth) * 2;
  return { h: Math.ceil($(".bar").offsetHeight + content + border), border };
}
function fitPanel() {
  const { h, border } = miniHeight();
  const zoom = (+settings.panelScale || 100) / 100;
  const view = $("#miniView");
  const width = settings.panelLayout === "columns"
    ? Math.max(view.scrollWidth, $(".bar").scrollWidth) + border
    : miniWidth() + border;
  engine.fitPanel(Math.ceil(h * zoom), Math.ceil(width * zoom)).catch(() => {});
}
// Settings → Tray volume panel: size, opacity and what the panel shows.
let panelLayoutBuilt = null;
function applyPanelOptions() {
  if (!PANEL) return;
  const layout = settings.panelLayout === "columns" ? "columns" : "rows";
  // The faders are built for one layout, so switching layout reloads the panel.
  if (panelLayoutBuilt && panelLayoutBuilt !== layout) { location.reload(); return; }
  panelLayoutBuilt = layout;
  const b = document.body;
  b.classList.toggle("panel-columns", layout === "columns");
  b.classList.toggle("panel-no-icons", settings.panelIcons === false);
  b.classList.toggle("panel-no-mute", settings.panelMute === false);
  b.classList.toggle("panel-no-meters", settings.panelMeters === false);
  b.style.setProperty("--panel-opacity", String(Math.min(100, Math.max(30, +settings.panelOpacity || 100)) / 100));
  document.documentElement.style.zoom = String((+settings.panelScale || 100) / 100);
  requestAnimationFrame(fitPanel);
}
// Mini mode in the main window: size it to the channels, so it never needs a scroll bar and
// switching to and from the full mixer is seamless. Redone whenever the channels change.
function syncMiniWindow(on) {
  if (SIDE) return;
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
