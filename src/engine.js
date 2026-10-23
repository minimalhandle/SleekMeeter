/*
 * Engine layer. The UI only ever talks to this object:
 *   start(onState, onLevels)   onState(snapshot), onLevels({inputs:[[l,r]...], outputs:[[l,r]...]} in dBFS)
 *   getFloats(names) -> [number|null]   read mic-chain parameters (null = this edition has none)
 *   setFloat(name, value) / setString(name, value)   Voicemeeter parameters, e.g. "Strip[0].Gain"
 *   launch() / showWindow()    start Voicemeeter / bring its own window back
 *   devices()                  {inputs:[{type,name}], outputs:[...]}
 *   listScenes() / saveScene(n) / loadScene(n) / deleteScene(n)
 *   getSettings() / saveSettings(s) -> {problems:[...]}
 *   windowMini(mini, rows, width, height)  resize the window for mini mode (height fits the channels)
 *   openMixer() / closePanel() / onPanelShown(cb)   the tray volume panel
 *   checkUpdate() -> {current, latest, newer, url, canInstall} / openRelease(url)
 *   updateInstall() downloads and installs the newest version, then restarts (the app exits)
 *   onUpdateProgress(cb)   cb({percent}) while it downloads
 *   runningApps() / onSceneAuto(cb)   automatic scene switching
 *   glide(key, db)             fade a strip or bus ("Strip[0]") to a level
 *   recorder(action) -> {state, elapsed, since}   record, play, replay, pause, stop, rew, ff
 *   recorderOpen() -> file name | null / recorderLoad(path)   a file for the recorder to play
 *   onEngineRestart(cb) / onSettingsChanged(cb) / onFileDrop(cb)
 *   appInfo() -> {version, logDir} / openLogs() / log(level, message)   Settings → About, the log file
 *   panelDock(docked)   snap the tray panel to the screen corner, or let it be moved
 *   outputsCapture() -> [{bus, type, name}] / outputsApply(name)   output profiles (settings.outputProfiles)
 *   appVolumes() -> [{exe, name, volume, mute, active}] / appVolumeSet(exe, volume, mute)   per-app volume
 *   selftestInputs() -> {devices} / selftestRun(input, output, secs)   hear-yourself test
 *   soundDevices() -> {devices, auto} / soundPick() -> [paths] / soundPickFolder() -> [paths] / soundPickPack() -> {folder,count}|null (copied into the data folder) / soundImport(paths) -> [copied paths] / soundPlay(name) / soundStop()   soundboard
 *   twitchStatus() / onTwitchStatus(cb)   {connected, message, last} of the Twitch chat link
 *   remoteStatus() -> {running, message, urls}   the phone remote
 *   historyGet(minutes) -> {keys, series, stats, ...} / historyClear()   level history
 *   appRouteDevices() -> [{id, name}] / appRouteSet(pids, deviceId)   send an app to another output
 *   brbToggle() -> bool   Be right back on or off (state.brb tells which)
 *   obsStatus() / onObsStatus(cb)   {connected, live, scene, scenes, message} of the OBS link
 *   onThemeAuto(cb)   an app rule wants a theme ({theme}, "" = back to the chosen one)
 *   healthCheck() -> [{state: ok|warn|bad, label, detail}]   "Check my setup"
 *   settingsExport() / settingsImport() -> file name or null   backup and restore
 *   resetLayout()   default window size and position, panel docked
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
    outputProfiles: [],
    panelDocked: true, panelPos: null,
    hold: { releaseMs: 250 },
    brb: { mute: [], lower: [], amount: 30, play: "", playDb: -8, overlay: true },
    obs: { on: false, host: "127.0.0.1", port: 4455, password: "", rules: [], liveDo: "", liveScene: "", offDo: "", offScene: "" },
    clipWarn: { on: false, target: "Strip[0]" },
    soundboard: { device: "", volume: 100, sounds: [] },
    twitch: { on: false, channel: "", who: "mods", cooldown: 3, commands: [] },
    remote: { on: false, port: 8787, key: "" },
    history: { on: true },
    appRoutes: {},
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
    getFloats(names) { return this.invoke("vm_get_floats", { names }); }
    launch() { return this.invoke("vm_launch"); }
    showWindow() { return this.invoke("vm_show_window"); }
    devices() { return this.invoke("vm_devices"); }
    listScenes() { return this.invoke("scene_list"); }
    saveScene(name) { return this.invoke("scene_save", { name }); }
    loadScene(name) { return this.invoke("scene_load", { name }); }
    deleteScene(name) { return this.invoke("scene_delete", { name }); }
    getSettings() { return this.invoke("settings_get"); }
    saveSettings(value) { return this.invoke("settings_set", { value }); }
    windowMini(mini, rows, width, height) { return this.invoke("window_mini", { mini, rows, width, height }); }
    openMixer() { return this.invoke("open_mixer"); }
    closePanel() { return this.invoke("flyout_close"); }
    onPanelShown(cb) { return this.listen("flyout-shown", cb); }
    fitPanel(height, width) { return this.invoke("panel_fit", { height, width }); }
    uiReady() { return this.invoke("ui_ready"); }
    fitWindow(width) { return this.invoke("window_fit", { width }); }
    checkUpdate() { return this.invoke("check_update"); }
    openRelease(url) { return this.invoke("open_release", { url }); }
    updateInstall() { return this.invoke("update_install"); }
    onUpdateProgress(cb) { return this.listen("update-progress", (e) => cb(e.payload)); }
    runningApps() { return this.invoke("running_apps"); }
    onSceneAuto(cb) { return this.listen("scene-auto", (e) => cb(e.payload)); }
    glide(key, value) { return this.invoke("vm_glide", { key, value }); }
    appInfo() { return this.invoke("app_info"); }
    openLogs() { return this.invoke("open_logs"); }
    log(level, message) { return this.invoke("ui_log", { level, message: String(message) }); }
    recorder(action) { return this.invoke("recorder_cmd", { action }); }
    recorderOpen() { return this.invoke("recorder_open"); }
    recorderLoad(path) { return this.invoke("recorder_load", { path }); }
    panelDock(docked) { return this.invoke("panel_dock", { docked }); }
    outputsCapture() { return this.invoke("outputs_capture"); }
    outputsApply(name) { return this.invoke("outputs_apply", { name }); }
    appVolumes() { return this.invoke("app_volumes"); }
    appVolumeSet(exe, volume, mute) { return this.invoke("app_volume_set", { exe, volume, mute }); }
    soundDevices() { return this.invoke("sound_devices"); }
    soundPick() { return this.invoke("sound_pick"); }
    soundPickFolder() { return this.invoke("sound_pick_folder"); }
    soundPickPack() { return this.invoke("sound_pick_pack"); }
    soundImport(paths) { return this.invoke("sound_import", { paths }); }
    selftestInputs() { return this.invoke("selftest_inputs"); }
    selftestRun(input, output, secs) { return this.invoke("selftest_run", { input, output, secs }); }
    soundPlay(name) { return this.invoke("sound_play", { name }); }
    soundStop() { return this.invoke("sound_stop"); }
    twitchStatus() { return this.invoke("twitch_status"); }
    onTwitchStatus(cb) { return this.listen("twitch-status", (e) => cb(e.payload)); }
    remoteStatus() { return this.invoke("remote_status"); }
    historyGet(minutes) { return this.invoke("history_get", { minutes }); }
    historyClear() { return this.invoke("history_clear"); }
    appRouteDevices() { return this.invoke("app_route_devices"); }
    appRouteSet(pids, device) { return this.invoke("app_route_set", { pids, device }); }
    brbToggle() { return this.invoke("brb_toggle"); }
    obsStatus() { return this.invoke("obs_status"); }
    onObsStatus(cb) { return this.listen("obs-status", (e) => cb(e.payload)); }
    onThemeAuto(cb) { return this.listen("theme-auto", (e) => cb(e.payload)); }
    healthCheck() { return this.invoke("health_check"); }
    settingsExport() { return this.invoke("settings_export"); }
    settingsImport() { return this.invoke("settings_import"); }
    resetLayout() { return this.invoke("reset_layout"); }
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
          fileType: 1, bits: 24, gain: 0, channel: 2, kbps: 192, sampleRate: 48000, loop: false, multiTrack: false, playOnLoad: false, playing: null, recording: null, state: "stopped", elapsed: 0, since: null,
        };
      }
      this.glides = {};
      this.apps = [
        { exe: "spotify.exe", name: "Spotify", volume: 70, mute: false, active: true, pids: [4120] },
        { exe: "discord.exe", name: "Discord", volume: 100, mute: false, active: true, pids: [5210, 5230] },
        { exe: "chrome.exe", name: "Chrome", volume: 45, mute: false, active: false, pids: [6100] },
        { exe: "valorant.exe", name: "Valorant", volume: 85, mute: false, active: true, pids: [7300] },
        { exe: "system sounds", name: "System sounds", volume: 100, mute: true, active: false, pids: [] },
      ];
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
    emit() {
      // The active output profile, like the app works it out (outputs.rs).
      const snap = JSON.parse(JSON.stringify(this.state));
      const cur = (this.settings && this.settings.outputProfiles || []).find((p) =>
        p.buses.length && p.buses.every((e) => !snap.buses[e.bus] || snap.buses[e.bus].device === e.name));
      snap.outputProfile = cur ? cur.name : null;
      this.onState(snap);
    }

    getFloats(names) {
      this._chain = this._chain || {};
      const OPT = { "Option.sr": 48000, "Option.ASIOsr": 0, "Option.buffer.mme": 512, "Option.buffer.wdm": 512, "Option.buffer.ks": 512, "Option.buffer.asio": 0,
        "Option.mode.exclusif": 0, "Option.mode.swift": 0, "Option.MonitorOnSEL": 0, "Option.SliderMode": 0,
        "Option.delay[0]": 0, "Option.delay[1]": 0, "Option.delay[2]": 0, "Option.delay[3]": 0, "Option.delay[4]": 0 };
      return Promise.resolve(names.map((n) => {
        if (n.startsWith("Option.")) {
          if (!(n in OPT)) return null;
          if (this.layout.edition < 3 && (n === "Option.MonitorOnSEL" || n === "Option.SliderMode")) return null;
          return n in (this._opts || {}) ? this._opts[n] : OPT[n];
        }
        const m = /^Strip\[(\d)\]\.(.+)$/.exec(n);
        if (!m || +m[1] > 1) return null;
        if (n in this._chain) return this._chain[n];
        const d = { Comp: 0, Gate: 0, Denoiser: 0, "Comp.Threshold": -30, "Comp.Ratio": 2, "Gate.Threshold": -60 };
        if (!(m[2] in d)) return null;
        if (this.layout.edition < 3 && m[2].includes(".")) return null;
        if (this.layout.edition < 3 && m[2] === "Denoiser") return null;
        return d[m[2]];
      }));
    }
    setFloat(name, value) {
      if (/^Strip\[\d\]\.(Comp|Gate|Denoiser)/.test(name)) { (this._chain = this._chain || {})[name] = value; }
      const rec = this.state.recorder;
      const r = /^Recorder\.(ArmStrip|ArmBus)\[(\d)\]$/.exec(name);
      if (rec && r) rec[r[1] === "ArmStrip" ? "armStrips" : "armBuses"][+r[2]] = !!value;
      const ab = /^Recorder\.([AB])(\d)$/.exec(name);
      if (rec && ab) rec[ab[1].toLowerCase()][+ab[2] - 1] = !!value;
      if (rec && name === "Recorder.mode.recbus") rec.recBus = !!value;
      if (rec && name === "Recorder.FileType") rec.fileType = value;
      if (rec && name === "Recorder.bitResolution") rec.bits = value;
      if (rec && name === "Recorder.gain") rec.gain = value;
      if (rec && name === "Recorder.Channel") rec.channel = value;
      if (rec && name === "Recorder.kbps") rec.kbps = value;
      if (rec && name === "Recorder.samplerate") rec.sampleRate = value;
      if (rec && name === "Recorder.mode.Loop") rec.loop = !!value;
      if (rec && name === "Recorder.mode.MultiTrack") rec.multiTrack = !!value;
      if (rec && name === "Recorder.mode.PlayOnLoad") rec.playOnLoad = !!value;
      if (/^Option\./.test(name)) (this._opts = this._opts || {})[name] = value;
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
      if (this.onState) this.emit();
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
        url: "https://github.com/minimalhandle/SleekMeeter/releases/tag/v0.4.1", canInstall: true });
    }
    openRelease() { return Promise.resolve(); }
    updateInstall() {
      return new Promise((resolve) => {
        let p = 0;
        const t = setInterval(() => {
          p += 20; (this._upd || (() => {}))({ percent: Math.min(p, 100) });
          if (p >= 100) { clearInterval(t); resolve(); }
        }, 250);
      });
    }
    onUpdateProgress(cb) { this._upd = cb; return Promise.resolve(); }
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
    panelDock() { return Promise.resolve(); }
    // Output profiles: capture reads the hardware outputs, apply puts a saved profile's devices back.
    outputsCapture() {
      const hb = this.layout.buses.filter((x) => x.kind === "hw").length;
      return Promise.resolve(this.state.buses.slice(0, hb).map((b, j) => ({ bus: j, type: "wdm", name: b.device })));
    }
    outputsApply(name) {
      const p = (this.settings.outputProfiles || []).find((x) => x.name === name);
      if (!p) return Promise.reject(new Error(`There's no output profile “${name}”`));
      let changed = 0;
      for (const e of p.buses) {
        const b = this.state.buses[e.bus];
        if (b && b.device !== e.name) { b.device = e.name; changed++; }
      }
      this.emit();
      return Promise.resolve(changed);
    }
    appVolumes() {
      // A little life: the active apps come and go like real ones would.
      return Promise.resolve(JSON.parse(JSON.stringify(this.apps)));
    }
    appVolumeSet(exe, volume, mute) {
      const a = this.apps.find((x) => x.exe === exe);
      if (!a) return Promise.reject(new Error("That app isn't playing audio any more"));
      if (volume !== null && volume !== undefined) a.volume = Math.round(volume);
      if (mute !== null && mute !== undefined) a.mute = !!mute;
      return Promise.resolve();
    }
    // Be right back: the simulator does what the real app does, on its own state.
    soundDevices() {
      return Promise.resolve({ devices: ["Speakers (Realtek USB Audio)", "Voicemeeter Input (VB-Audio Voicemeeter VAIO)", "Voicemeeter Aux Input (VB-Audio Voicemeeter AUX)"], auto: "Voicemeeter Aux Input (VB-Audio Voicemeeter AUX)" });
    }
    soundPick() { this._n = (this._n || 0) + 1; return Promise.resolve([["C:\\Sounds\\airhorn.mp3", "C:\\Sounds\\sad-trombone.wav", "C:\\Sounds\\vine-boom.ogg", "C:\\Sounds\\bruh.mp3"][(this._n - 1) % 4]]); }
    selftestInputs() { return Promise.resolve({ devices: ["Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)", "Voicemeeter Out B2 (VB-Audio Voicemeeter VAIO)"] }); }
    selftestRun(input, output, secs) { return new Promise((r) => setTimeout(r, Math.min(secs, 2) * 1000)); }
    soundImport(paths) { return Promise.resolve(paths); }
    soundPickPack() { return Promise.resolve({ folder: "C:\\Sounds\\Cheers", count: 6 }); }
    soundPickFolder() { return Promise.resolve(["rimshot.wav", "wilhelm-scream.mp3", "oof.ogg", "bell_ding.flac", "applause.wav"].map((f) => "C:\\Sounds\\Memes\\" + f)); }
    soundPlay(name) { this.played = name; return Promise.resolve(); }
    soundStop() { return Promise.resolve(); }
    twitchStatus() { return Promise.resolve(this._twitch || { connected: false, message: "Off", last: "" }); }
    onTwitchStatus(cb) { this._twitchCb = cb; return Promise.resolve(); }
    remoteStatus() {
      const r = this.settings && this.settings.remote;
      return Promise.resolve(r && r.on && r.key ? { running: true, message: "On", urls: [`http://192.168.1.23:${r.port}/?k=${r.key}`] } : { running: false, message: r && r.on ? "Make a key first" : "Off", urls: [] });
    }
    historyGet(minutes) {
      const n = 360, bucket = Math.ceil(minutes * 60 / n), now = Math.floor(Date.now() / 1000);
      const keys = ["Strip[0]", "Strip[1]", "Strip[2]", "Strip[3]", "Strip[4]", "Bus[0]", "Bus[1]"];
      let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const series = keys.map((k, i) => Array.from({ length: n }, (_, j) => {
        if (i === 0) { const talk = Math.sin(j / 9) + Math.sin(j / 23) > 0.2; return talk ? -20 + Math.sin(j * 1.7) * 6 + rnd() * 5 + (j === 204 ? 21 : 0) : -52 + rnd() * 3; }
        if (i === 1) return -30 + Math.sin(j / 30) * 5 + rnd() * 1.5;
        if (i === 3) return j < 60 ? null : -26 + Math.sin(j / 12) * 7 + rnd() * 2;
        if (i === 5) return -18 + Math.sin(j / 15) * 4 + rnd() * 2;
        return -44 + Math.sin(j / 40 + i) * 6 + rnd() * 2;
      }));
      const stats = series.map((s, i) => { const v = s.filter((x) => x != null); const peak = v.length ? Math.max(...v) : null;
        return { key: keys[i], peak, clipSeconds: v.filter((x) => x >= 0).length * bucket, activeSeconds: v.filter((x) => x > -60).length * bucket }; });
      return Promise.resolve({ from: now - minutes * 60, now, bucket, keys, series, stats });
    }
    historyClear() { return Promise.resolve(); }
    appRouteDevices() {
      return Promise.resolve([{ id: "{0.0.0.00000000}.{aaaa}", name: "Voicemeeter Input (VB-Audio Voicemeeter VAIO)" }, { id: "{0.0.0.00000000}.{bbbb}", name: "Voicemeeter Aux Input (VB-Audio Voicemeeter AUX)" }, { id: "{0.0.0.00000000}.{cccc}", name: "Speakers (Realtek USB Audio)" }]);
    }
    appRouteSet(pids, device) { this.routed = { pids, device }; return Promise.resolve(); }
    brbToggle() {
      const st = this.state, cfg = Object.assign({ mute: [], lower: [], amount: 30, play: "", playDb: -8 }, this.settings.brb);
      const pick = (key) => {
        const m = /^(Strip|Bus)\[(\d)\]$/.exec(key || "");
        return m ? (m[1] === "Strip" ? st.strips : st.buses)[+m[2]] : null;
      };
      if (this.brbSaved) {
        for (const [key, was] of this.brbSaved) { const c = pick(key); if (c) { c.gain = was.gain; c.mute = was.mute; } }
        this.brbSaved = null; st.brb = false;
      } else {
        const keys = [...new Set([...cfg.mute, ...cfg.lower, cfg.play].filter(Boolean))];
        if (!keys.length) return Promise.reject(new Error("Choose what Be right back does in Settings → Stream mode"));
        this.brbSaved = keys.map((k) => [k, { gain: (pick(k) || {}).gain, mute: (pick(k) || {}).mute }]);
        for (const k of cfg.lower) { const c = pick(k); if (c) c.gain = Math.max(-60, c.gain - cfg.amount); }
        if (cfg.play) { const c = pick(cfg.play); if (c) { c.mute = false; c.gain = cfg.playDb; } }
        for (const k of cfg.mute) { const c = pick(k); if (c) c.mute = true; }
        st.brb = true;
      }
      this.emit();
      return Promise.resolve(st.brb);
    }
    obsStatus() {
      const live = /[?&]live\b/.test(location.search);
      return Promise.resolve({ connected: true, live, scene: "Gameplay", scenes: ["Starting soon", "Gameplay", "Just chatting", "BRB", "Ending"], message: "Connected to OBS" });
    }
    onObsStatus() { return Promise.resolve(); }
    onThemeAuto() { return Promise.resolve(); }
    healthCheck() {
      return new Promise((r) => setTimeout(() => r([
        { state: "ok", label: "Voicemeeter", detail: "Running and connected." },
        { state: "warn", label: "Audio devices", detail: "Windows doesn't list: Headphones (Arctis Nova Pro Wireless). Plug it in or switch it on; Sleekmeeter restarts the audio engine when it returns." },
        { state: "ok", label: "Shortcuts", detail: "4 shortcuts working." },
        { state: "ok", label: "Saving settings", detail: "Settings, scenes and logs can be saved." },
      ]), 500));
    }
    settingsExport() { return Promise.resolve("Sleekmeeter settings.json"); }
    settingsImport() { return Promise.resolve(null); }
    resetLayout() { return Promise.resolve(); }
    appInfo() { return Promise.resolve({ version: "preview", logDir: null }); }
    openLogs() { return Promise.reject(new Error("The log is only kept by the Windows app")); }
    log(level, message) { (level === "error" ? console.error : console.log)("[log]", message); return Promise.resolve(); }
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
