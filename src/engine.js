/*
 * Engine layer. The UI only ever talks to this object:
 *   start(onState, onLevels)   onState(snapshot), onLevels({inputs:[[l,r]...], outputs:[[l,r]...]} in dBFS)
 *   setFloat(name, value) / setString(name, value)   Voicemeeter parameters, e.g. "Strip[0].Gain"
 *   launch() / showWindow()    start Voicemeeter / bring its own window back
 *   devices()                  {inputs:[{type,name}], outputs:[...]}
 *   listScenes() / saveScene(n) / loadScene(n) / deleteScene(n)
 *   getSettings() / saveSettings(s) -> {problems:[...]}
 *   windowMini(mini, rows)     resize the window for mini mode
 *   openMixer() / closePanel() / onPanelShown(cb)   the tray volume panel
 *   checkUpdate() -> {current, latest, newer, url} / openRelease(url)
 *   runningApps() / onSceneAuto(cb)   automatic scene switching
 *   glide(key, db)             fade a strip or bus ("Strip[0]") to a level
 *   recorder(action) -> {state, elapsed, since}   record, play, replay, pause, stop, rew, ff
 *   recorderOpen() -> file name | null / recorderLoad(path)   a file for the recorder to play
 *   onEngineRestart(cb) / onSettingsChanged(cb) / onFileDrop(cb)
 *
 * Inside the Tauri app this goes to the Rust bridge (VoicemeeterRemote64.dll).
 * In a plain browser it runs a simulated Voicemeeter so the UI can be previewed
 * (?edition=1 Standard, 2 Banana, 3 Potato; ?offline; ?panel; ?update).
 */
(function () {
  "use strict";

  // Strip and bus counts per edition (see VoicemeeterRemote.h):
  // Standard 2+1 inputs, A+B; Banana 3+2, A1–A3 + B1–B2; Potato 5+3, A1–A5 + B1–B3.
  const COUNTS = { 1: [2, 1, 1, 1], 2: [3, 2, 3, 2], 3: [5, 3, 5, 3] };
  const VIRTUAL_INPUTS = [["Voicemeeter Input", "desktop"], ["Voicemeeter AUX", "music"], ["Voicemeeter VAIO3", "chat"]];
  function layoutFor(edition) {
    const ed = COUNTS[edition] ? edition : 2;
    const [hs, vs, hb, vb] = COUNTS[ed];
    const single = ed === 1; // Standard names its buses just A and B
    const strips = [], buses = [];
    for (let i = 0; i < hs; i++) strips.push({ kind: "hw", fallback: `Hardware input ${i + 1}`, icon: i === 0 ? "mic" : "wave" });
    for (let j = 0; j < vs; j++) strips.push({ kind: "virt", fallback: VIRTUAL_INPUTS[j][0], icon: VIRTUAL_INPUTS[j][1] });
    for (let i = 0; i < hb; i++) buses.push({ id: single ? "A" : `A${i + 1}`, param: `A${i + 1}`, kind: "hw", icon: i === 0 ? "headphones" : "speaker" });
    for (let j = 0; j < vb; j++) buses.push({ id: single ? "B" : `B${j + 1}`, param: `B${j + 1}`, kind: "virt", icon: "stream" });
    return { edition: ed, strips, buses };
  }
  const BUS_MODES = [
    ["normal", "Normal"], ["Amix", "Mix down A"], ["Bmix", "Mix down B"], ["Repeat", "Repeat"],
    ["Composite", "Composite"], ["TVMix", "TV mix"], ["UpMix21", "Up mix 2.1"], ["UpMix41", "Up mix 4.1"],
    ["UpMix61", "Up mix 6.1"], ["CenterOnly", "Center only"], ["LFEOnly", "LFE only"], ["RearOnly", "Rear only"],
  ];
  const DEFAULT_SETTINGS = {
    appearance: {},
    hotkeys: [
      { keys: "Ctrl+Alt+M", action: "mute", target: "Strip[0]" },
      { keys: "Ctrl+Alt+Up", action: "volup", target: "Bus[0]" },
      { keys: "Ctrl+Alt+Down", action: "voldown", target: "Bus[0]" },
      { keys: "Ctrl+Alt+S", action: "window", target: "" },
    ],
    startWithWindows: false, startInTray: true, launchVoicemeeter: true, hideVoicemeeter: false,
    overlay: true, alwaysOnTop: false, mini: false,
    sceneRules: [], checkUpdates: true, skippedVersion: "", oled: false,
    fades: { on: true, muteMs: 250, sceneMs: 1200 },
    ducking: { on: false, trigger: "Strip[0]", targets: [], amount: 12, threshold: -40, attackMs: 150, releaseMs: 800, holdMs: 700 },
    autoRestart: true,
  };

  /* ---------------- Tauri (real Voicemeeter) ---------------- */
  class TauriEngine {
    constructor() {
      this.invoke = window.__TAURI__.core.invoke;
      this.listen = window.__TAURI__.event.listen;
      this.simulated = false;
    }
    async start(onState, onLevels) {
      await this.listen("vm-state", (e) => onState(e.payload));
      await this.listen("vm-levels", (e) => onLevels(e.payload));
      const snap = await this.invoke("vm_snapshot");
      if (snap) onState(snap);
    }
    setFloat(name, value) { return this.invoke("vm_set_float", { name, value }); }
    setString(name, value) { return this.invoke("vm_set_string", { name, value }); }
    launch() { return this.invoke("vm_launch"); }
    showWindow() { return this.invoke("vm_show_window"); }
    devices() { return this.invoke("vm_devices"); }
    listScenes() { return this.invoke("scene_list"); }
    saveScene(name) { return this.invoke("scene_save", { name }); }
    loadScene(name) { return this.invoke("scene_load", { name }); }
    deleteScene(name) { return this.invoke("scene_delete", { name }); }
    getSettings() { return this.invoke("settings_get"); }
    saveSettings(value) { return this.invoke("settings_set", { value }); }
    windowMini(mini, rows, width) { return this.invoke("window_mini", { mini, rows, width }); }
    openMixer() { return this.invoke("open_mixer"); }
    closePanel() { return this.invoke("flyout_close"); }
    onPanelShown(cb) { return this.listen("flyout-shown", cb); }
    fitPanel(height, width) { return this.invoke("panel_fit", { height, width }); }
    uiReady() { return this.invoke("ui_ready"); }
    fitWindow(width) { return this.invoke("window_fit", { width }); }
    checkUpdate() { return this.invoke("check_update"); }
    openRelease(url) { return this.invoke("open_release", { url }); }
    runningApps() { return this.invoke("running_apps"); }
    onSceneAuto(cb) { return this.listen("scene-auto", (e) => cb(e.payload)); }
    glide(key, value) { return this.invoke("vm_glide", { key, value }); }
    recorder(action) { return this.invoke("recorder_cmd", { action }); }
    recorderOpen() { return this.invoke("recorder_open"); }
    recorderLoad(path) { return this.invoke("recorder_load", { path }); }
    onEngineRestart(cb) { return this.listen("engine-restarted", (e) => cb(e.payload)); }
    onSettingsChanged(cb) { return this.listen("settings-changed", (e) => cb(e.payload)); }
    // Files dropped on the window (Tauri hands over their paths).
    onFileDrop(cb) { return this.listen("tauri://drag-drop", (e) => cb((e.payload && e.payload.paths) || [])); }
  }

  /* ---------------- Simulated Voicemeeter Banana ---------------- */
  class MockEngine {
    constructor() {
      this.simulated = true;
      const offline = /[?&]offline\b/.test(location.search);
      const em = /[?&]edition=(\d)/.exec(location.search);
      this.layout = layoutFor(em ? +em[1] : 2);
      const L = this.layout;
      const sampleStrips = [
        { label: "Mic", device: "Shure MV7", gain: -2.5, mono: true, comp: 3.5, gate: 2 },
        { label: "Guitar", device: "Focusrite Scarlett 2i2", gain: -8, pan: -0.15 },
        { label: "", device: "", gain: 0, mute: true },
        { label: "Synth", device: "Arturia MiniFuse", gain: -10 },
        { label: "", device: "", gain: 0, mute: true },
      ];
      const sampleVirt = [
        { label: "Desktop", gain: -4, eq: [1.5, 0, -1] },
        { label: "Discord", gain: -6, eq: [0, 2, 0] },
        { label: "Game", gain: -9, eq: [0, 0, 0] },
      ];
      const hs = L.strips.filter((x) => x.kind === "hw").length;
      const hb = L.buses.filter((x) => x.kind === "hw").length;
      const vb = L.buses.length - hb;
      const strip = (base, i) => Object.assign({
        label: "", device: "", gain: 0, mute: false, solo: false, mono: false, mc: false,
        a: Array.from({ length: hb }, (_, k) => (k === 0 && !base.mute ? 1 : 0)),
        b: Array.from({ length: vb }, (_, k) => ((i === 0 && k === 0) || (i === hs && k === vb - 1) ? 1 : 0)),
        pan: 0, comp: 0, gate: 0, eq: [],
      }, base);
      const sampleBuses = [
        { label: "Headphones", device: "Realtek Audio", gain: -3 },
        { label: "Speakers", device: "LG UltraGear", gain: -12, mute: true, eq: true },
        { label: "", device: "" }, { label: "", device: "" }, { label: "", device: "" },
      ];
      const sampleVBuses = [{ label: "Stream mic" }, { label: "Stream mix", gain: -1.5 }, { label: "Recording" }];
      const bus = (base) => Object.assign({ label: "", device: "", gain: 0, mute: false, mono: false, eq: false, mode: "normal" }, base);
      this.state = {
        installed: true,
        connected: !offline,
        edition: L.edition,
        version: { 1: "1.1.1.9", 2: "2.1.1.9", 3: "3.1.1.9" }[L.edition],
        strips: L.strips.map((x, i) => strip(x.kind === "hw" ? sampleStrips[i] : sampleVirt[i - hs], i)),
        buses: L.buses.map((x, j) => bus(x.kind === "hw" ? sampleBuses[j] : sampleVBuses[j - hb])),
      };
      if (L.edition >= 2) {
        this.state.recorder = {
          armStrips: L.strips.map(() => false), armBuses: L.buses.map((_, j) => j === hb + vb - 1),
          recBus: true, a: Array.from({ length: hb }, (_, k) => k === 0), b: Array.from({ length: vb }, () => false),
          fileType: 1, bits: 24, gain: 0, playing: null, recording: null, state: "stopped", elapsed: 0, since: null,
        };
      }
      this.glides = {};
      this.scenes = ["Streaming", "Gaming", "Late night"];
      this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      this.settings.appearance = {
        "strip-0": { color: "amber", icon: "mic" },
        "strip-1": { color: "violet", icon: "wave" },
        "strip-2": { hidden: true },
        "strip-3": { color: "blue", icon: "desktop" },
        "strip-4": { color: "green", icon: "chat" },
        "bus-0": { color: "amber", icon: "headphones" },
        "bus-1": { icon: "speaker" },
        "bus-2": { hidden: true },
        "bus-3": { color: "rose", icon: "stream" },
        "bus-4": { color: "cyan", icon: "stream" },
      };
      try {
        const saved = localStorage.getItem("sleekmeeter-preview-settings");
        if (saved) this.settings = Object.assign(this.settings, JSON.parse(saved));
      } catch (e) { /* storage unavailable: keep the defaults */ }
      this.t0 = performance.now();
    }

    async start(onState, onLevels) {
      this.onState = onState;
      this.emit();
      setInterval(() => {
        if (this.state.connected) onLevels(this.levels((performance.now() - this.t0) / 1000));
      }, 33);
    }
    emit() { this.onState(JSON.parse(JSON.stringify(this.state))); }

    setFloat(name, value) {
      const rec = this.state.recorder;
      const r = /^Recorder\.(ArmStrip|ArmBus)\[(\d)\]$/.exec(name);
      if (rec && r) rec[r[1] === "ArmStrip" ? "armStrips" : "armBuses"][+r[2]] = !!value;
      const ab = /^Recorder\.([AB])(\d)$/.exec(name);
      if (rec && ab) rec[ab[1].toLowerCase()][+ab[2] - 1] = !!value;
      if (rec && name === "Recorder.mode.recbus") rec.recBus = !!value;
      if (rec && name === "Recorder.FileType") rec.fileType = value;
      if (rec && name === "Recorder.bitResolution") rec.bits = value;
      if (rec && name === "Recorder.gain") rec.gain = value;
      const m = /^(Strip|Bus)\[(\d)\]\.([\w.]+)$/.exec(name);
      if (m) {
        const obj = (m[1] === "Strip" ? this.state.strips : this.state.buses)[+m[2]];
        const key = m[3];
        const rm = /^([AB])(\d)$/.exec(key);
        const routes = rm ? { [key]: [rm[1].toLowerCase(), +rm[2] - 1] } : {};
        const simple = { Gain: "gain", Mute: "mute", Solo: "solo", Mono: "mono", MC: "mc", Pan_x: "pan", Comp: "comp", Gate: "gate", "EQ.on": "eq" };
        if (routes[key]) obj[routes[key][0]][routes[key][1]] = value ? 1 : 0;
        else if (/^EQGain[123]$/.test(key)) obj.eq[+key.slice(-1) - 1] = value;
        else if (key.startsWith("mode.")) obj.mode = key.slice(5);
        else if (simple[key]) {
          const k = simple[key];
          obj[k] = typeof obj[k] === "boolean" ? !!value : value;
        }
      }
      this.emit();
      return Promise.resolve();
    }
    setString(name, value) {
      let m = /^(Strip|Bus)\[(\d)\]\.Label$/.exec(name);
      if (m) (m[1] === "Strip" ? this.state.strips : this.state.buses)[+m[2]].label = value;
      m = /^(Strip|Bus)\[(\d)\]\.device\.\w+$/.exec(name);
      if (m) (m[1] === "Strip" ? this.state.strips : this.state.buses)[+m[2]].device = value;
      this.emit();
      return Promise.resolve();
    }
    launch() {
      setTimeout(() => { this.state.connected = true; this.emit(); }, 900);
      return Promise.resolve();
    }
    showWindow() { return Promise.resolve(); }
    devices() {
      return Promise.resolve({
        inputs: [
          { type: "wdm", name: "Shure MV7" }, { type: "wdm", name: "Focusrite Scarlett 2i2" },
          { type: "wdm", name: "Webcam Microphone" }, { type: "ks", name: "Focusrite Scarlett 2i2" },
          { type: "mme", name: "Shure MV7" },
        ],
        outputs: [
          { type: "wdm", name: "Realtek Audio" }, { type: "wdm", name: "LG UltraGear" },
          { type: "wdm", name: "Focusrite Scarlett 2i2" }, { type: "asio", name: "Focusrite USB ASIO" },
          { type: "mme", name: "Realtek Audio" },
        ],
      });
    }
    listScenes() { return Promise.resolve([...this.scenes]); }
    saveScene(name) { if (!this.scenes.includes(name)) this.scenes.push(name); return Promise.resolve(); }
    loadScene() { return Promise.resolve(); }
    deleteScene(name) { this.scenes = this.scenes.filter((s) => s !== name); return Promise.resolve(); }
    getSettings() { return Promise.resolve(JSON.parse(JSON.stringify(this.settings))); }
    saveSettings(value) {
      this.settings = JSON.parse(JSON.stringify(value));
      try { localStorage.setItem("sleekmeeter-preview-settings", JSON.stringify(value)); } catch (e) { /* ignore */ }
      const used = {};
      const problems = [];
      for (const h of value.hotkeys || []) {
        if (!h.keys) continue;
        if (used[h.keys]) problems.push(`${h.keys} is used twice`);
        used[h.keys] = 1;
      }
      return Promise.resolve({ problems });
    }
    windowMini() { return Promise.resolve(); }
    openMixer() { location.search = ""; return Promise.resolve(); }
    closePanel() { return Promise.resolve(); }
    onPanelShown() { return Promise.resolve(); }
    fitPanel() { return Promise.resolve(); }
    uiReady() { return Promise.resolve(); }
    fitWindow() { return Promise.resolve(); }
    checkUpdate() {
      const newer = /[?&]update\b/.test(location.search);
      return Promise.resolve({ current: "0.4.0", latest: newer ? "0.4.1" : "0.4.0", newer,
        url: "https://github.com/minimalhandle/SleekMeeter/releases/tag/v0.4.1" });
    }
    openRelease() { return Promise.resolve(); }
    runningApps() {
      return Promise.resolve(["discord.exe", "explorer.exe", "obs64.exe", "spotify.exe", "steam.exe", "valorant.exe"]);
    }
    onSceneAuto() { return Promise.resolve(); }
    // Voicemeeter fades with FadeTo; the simulator steps the level the same way.
    glide(key, value) {
      const m = /^(Strip|Bus)\[(\d)\]$/.exec(key);
      if (!m) return Promise.resolve();
      const obj = (m[1] === "Strip" ? this.state.strips : this.state.buses)[+m[2]];
      const from = obj.gain, to = Math.max(-60, Math.min(12, value)), t0 = performance.now(), ms = 300;
      clearInterval(this.glides[key]);
      this.glides[key] = setInterval(() => {
        const k = Math.min(1, (performance.now() - t0) / ms);
        obj.gain = Math.round((from + (to - from) * k) * 100) / 100;
        this.emit();
        if (k >= 1) clearInterval(this.glides[key]);
      }, 33);
      return Promise.resolve();
    }
    recorder(action) {
      const rec = this.state.recorder;
      if (!rec) return Promise.reject(new Error("This Voicemeeter has no recorder"));
      const now = Date.now();
      const run = (mode) => { rec.state = mode; rec.elapsed = 0; rec.since = now; };
      if (action === "record") { if (rec.state === "paused" && rec.paused === "recording") { rec.state = "recording"; rec.since = now; } else if (rec.state !== "recording") run("recording"); }
      if (action === "play") { if (rec.state === "paused" && rec.paused === "playing") { rec.state = "playing"; rec.since = now; } else if (rec.state === "stopped") run("playing"); }
      if (action === "replay") run("playing");
      if (action === "pause") {
        if (rec.state === "paused") { rec.state = rec.paused; rec.since = now; }
        else if (rec.state !== "stopped") { rec.elapsed += now - rec.since; rec.since = null; rec.paused = rec.state; rec.state = "paused"; }
      }
      if (action === "stop") { rec.state = "stopped"; rec.elapsed = 0; rec.since = null; }
      this.emit();
      return Promise.resolve({ state: rec.state, elapsed: rec.elapsed, since: rec.since });
    }
    recorderOpen() { return Promise.resolve("Interview take 3.wav"); }
    recorderLoad(path) { return Promise.resolve(path.split(/[\\/]/).pop()); }
    onEngineRestart() { return Promise.resolve(); }
    onSettingsChanged() { return Promise.resolve(); }
    onFileDrop() { return Promise.resolve(); }

    // Synthetic program material: speech-like mic, strummed guitar, music on desktop, chatter on Discord.
    levels(t) {
      const n = (f, ph) => 0.5 + 0.5 * Math.sin(t * f + ph);
      const speech = (n(9, 0) * n(2.3, 1) > 0.35 ? 1 : 0.15) * (0.55 + 0.45 * n(17, 2));
      const st = this.state;
      const hwSignal = [
        -20 + 22 * speech - 6,
        -18 + 10 * Math.pow(n(0.9, 0), 6) - 6 * ((t * 1.1) % 1),
        -90,
        -20 + 6 * n(1.7, 0.4),
        -90,
      ];
      const virtSignal = [
        -12 + 4 * n(3.1, 0.2) + 2 * n(11, 1),
        (n(0.7, 2) > 0.55 ? -16 + 8 * n(13, 0) : -70),
        -14 + 5 * n(4.3, 1.1),
      ];
      const hs = this.layout.strips.filter((x) => x.kind === "hw").length;
      const hb = this.layout.buses.filter((x) => x.kind === "hw").length;
      const raw = st.strips.map((_, i) => (i < hs ? hwSignal[i] : virtSignal[i - hs]));
      // Talk-over ducking, simulated: the trigger's level lowers the targets while it's loud.
      const duck = this.settings.ducking || {};
      const trig = /^Strip\[(\d)\]$/.exec(duck.trigger || "");
      const ti = trig ? +trig[1] : -1;
      const talking = !!duck.on && ti >= 0 && ti < st.strips.length && !st.strips[ti].mute
        && raw[ti] + st.strips[ti].gain >= (duck.threshold ?? -40);
      if (talking) this.loudAt = t;
      const ducking = !!duck.on && this.loudAt !== undefined && t - this.loudAt < (duck.holdMs ?? 700) / 1000;
      let duckChanged = false;
      st.strips.forEach((s, i) => {
        const on = ducking && (duck.targets || []).includes(`Strip[${i}]`) && i !== ti;
        if (!!s.ducked !== on) { s.ducked = on; duckChanged = true; }
      });
      if (duckChanged) this.emit();
      const post = raw.map((db, i) => db + st.strips[i].gain - (st.strips[i].ducked ? (duck.amount ?? 12) : 0));
      const inputs = post.map((db, i) => {
        const w = i === 0 ? 0 : 1.4 * Math.sin(t * 5 + i);
        const p = st.strips[i].pan * 8;
        return [db + w - p, db - w + p + (st.strips[i].mono ? w * 2 : 0)];
      });
      const outputs = st.buses.map((bus, j) => {
        const isA = j < hb;
        const k = isA ? j : j - hb;
        let pw = 0;
        st.strips.forEach((s, i) => {
          if (s.mute) return;
          if (isA ? s.a[k] : s.b[k]) pw += Math.pow(10, post[i] / 10);
        });
        if (bus.mute || pw === 0) return [-200, -200];
        const db = 10 * Math.log10(pw) + bus.gain;
        return [db + 0.6 * Math.sin(t * 7 + j), db - 0.6 * Math.sin(t * 7 + j)];
      });
      return { inputs, outputs };
    }
  }

  window.Sleekmeeter = {
    layoutFor, BUS_MODES, DEFAULT_SETTINGS,
    createEngine: () => (window.__TAURI__ ? new TauriEngine() : new MockEngine()),
  };
})();
