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
 *
 * Inside the Tauri app this goes to the Rust bridge (VoicemeeterRemote64.dll).
 * In a plain browser it runs a simulated Voicemeeter Banana so the UI can be previewed.
 */
(function () {
  "use strict";

  // Voicemeeter Banana layout (see VoicemeeterRemote.h): 3 hardware + 2 virtual strips, A1–A3 + B1–B2.
  const LAYOUT = {
    strips: [
      { kind: "hw", fallback: "Hardware input 1", icon: "mic" },
      { kind: "hw", fallback: "Hardware input 2", icon: "wave" },
      { kind: "hw", fallback: "Hardware input 3", icon: "wave" },
      { kind: "virt", fallback: "Voicemeeter Input", icon: "desktop" },
      { kind: "virt", fallback: "Voicemeeter AUX", icon: "music" },
    ],
    buses: [
      { id: "A1", kind: "hw", icon: "headphones" }, { id: "A2", kind: "hw", icon: "speaker" },
      { id: "A3", kind: "hw", icon: "speaker" },
      { id: "B1", kind: "virt", icon: "stream" }, { id: "B2", kind: "virt", icon: "stream" },
    ],
  };
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
    windowMini(mini, rows) { return this.invoke("window_mini", { mini, rows }); }
    openMixer() { return this.invoke("open_mixer"); }
    closePanel() { return this.invoke("flyout_close"); }
    onPanelShown(cb) { return this.listen("flyout-shown", cb); }
  }

  /* ---------------- Simulated Voicemeeter Banana ---------------- */
  class MockEngine {
    constructor() {
      this.simulated = true;
      const offline = /[?&]offline\b/.test(location.search);
      this.state = {
        installed: true,
        connected: !offline,
        edition: 2,
        version: "2.1.1.9",
        strips: [
          { label: "Mic", device: "Shure MV7", gain: -2.5, mute: false, solo: false, mono: true, mc: false, a: [1, 0, 0], b: [1, 0], pan: 0, comp: 3.5, gate: 2, eq: [] },
          { label: "Guitar", device: "Focusrite Scarlett 2i2", gain: -8, mute: false, solo: false, mono: false, mc: false, a: [1, 0, 0], b: [0, 0], pan: -0.15, comp: 0, gate: 0, eq: [] },
          { label: "", device: "", gain: 0, mute: true, solo: false, mono: false, mc: false, a: [0, 0, 0], b: [0, 0], pan: 0, comp: 0, gate: 0, eq: [] },
          { label: "Desktop", device: "", gain: -4, mute: false, solo: false, mono: false, mc: false, a: [1, 0, 0], b: [0, 1], pan: 0, comp: 0, gate: 0, eq: [1.5, 0, -1] },
          { label: "Discord", device: "", gain: -6, mute: false, solo: false, mono: false, mc: false, a: [1, 0, 0], b: [0, 0], pan: 0, comp: 0, gate: 0, eq: [0, 2, 0] },
        ],
        buses: [
          { label: "Headphones", device: "Realtek Audio", gain: -3, mute: false, mono: false, eq: false, mode: "normal" },
          { label: "Speakers", device: "LG UltraGear", gain: -12, mute: true, mono: false, eq: true, mode: "normal" },
          { label: "", device: "", gain: 0, mute: false, mono: false, eq: false, mode: "normal" },
          { label: "Stream mic", device: "", gain: 0, mute: false, mono: false, eq: false, mode: "normal" },
          { label: "Stream mix", device: "", gain: -1.5, mute: false, mono: false, eq: false, mode: "normal" },
        ],
      };
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
      const m = /^(Strip|Bus)\[(\d)\]\.([\w.]+)$/.exec(name);
      if (m) {
        const obj = (m[1] === "Strip" ? this.state.strips : this.state.buses)[+m[2]];
        const key = m[3];
        const routes = { A1: ["a", 0], A2: ["a", 1], A3: ["a", 2], B1: ["b", 0], B2: ["b", 1] };
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

    // Synthetic program material: speech-like mic, strummed guitar, music on desktop, chatter on Discord.
    levels(t) {
      const n = (f, ph) => 0.5 + 0.5 * Math.sin(t * f + ph);
      const speech = (n(9, 0) * n(2.3, 1) > 0.35 ? 1 : 0.15) * (0.55 + 0.45 * n(17, 2));
      const raw = [
        -20 + 22 * speech - 6,
        -18 + 10 * Math.pow(n(0.9, 0), 6) - 6 * ((t * 1.1) % 1),
        -90,
        -12 + 4 * n(3.1, 0.2) + 2 * n(11, 1),
        (n(0.7, 2) > 0.55 ? -16 + 8 * n(13, 0) : -70),
      ];
      const st = this.state;
      const post = raw.map((db, i) => db + st.strips[i].gain);
      const inputs = post.map((db, i) => {
        const w = i === 0 ? 0 : 1.4 * Math.sin(t * 5 + i);
        const p = st.strips[i].pan * 8;
        return [db + w - p, db - w + p + (st.strips[i].mono ? w * 2 : 0)];
      });
      const outputs = st.buses.map((bus, j) => {
        const isA = j < 3;
        const k = isA ? j : j - 3;
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
    LAYOUT, BUS_MODES, DEFAULT_SETTINGS,
    createEngine: () => (window.__TAURI__ ? new TauriEngine() : new MockEngine()),
  };
})();
