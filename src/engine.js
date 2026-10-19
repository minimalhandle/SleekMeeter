/*
 * Engine layer. The UI only ever talks to this object:
 *   start(onState, onLevels)   onState(snapshot), onLevels({inputs:[[l,r]...], outputs:[[l,r]...]} in dBFS)
 *   setFloat(name, value)       e.g. setFloat("Strip[0].Gain", -6)
 *   setString(name, value)      e.g. setString("Strip[0].Label", "Mic")
 *   launch()                    start Voicemeeter Banana
 *   listScenes() / saveScene(n) / loadScene(n) / deleteScene(n)
 *
 * Inside the Tauri app this goes to the Rust bridge (VoicemeeterRemote64.dll).
 * In a plain browser it runs a simulated Voicemeeter Banana so the UI can be previewed.
 */
(function () {
  "use strict";

  // Voicemeeter Banana layout (see VoicemeeterRemote.h): 3 hardware + 2 virtual strips, A1–A3 + B1–B2.
  const LAYOUT = {
    strips: [
      { kind: "hw", fallback: "Hardware input 1" },
      { kind: "hw", fallback: "Hardware input 2" },
      { kind: "hw", fallback: "Hardware input 3" },
      { kind: "virt", fallback: "Voicemeeter Input" },
      { kind: "virt", fallback: "Voicemeeter AUX" },
    ],
    buses: [
      { id: "A1", kind: "hw" }, { id: "A2", kind: "hw" }, { id: "A3", kind: "hw" },
      { id: "B1", kind: "virt" }, { id: "B2", kind: "virt" },
    ],
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
    listScenes() { return this.invoke("scene_list"); }
    saveScene(name) { return this.invoke("scene_save", { name }); }
    loadScene(name) { return this.invoke("scene_load", { name }); }
    deleteScene(name) { return this.invoke("scene_delete", { name }); }
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
          { label: "Mic", device: "Shure MV7", gain: -2.5, mute: false, solo: false, mono: true, mc: false, a: [1, 0, 0], b: [1, 0] },
          { label: "Guitar", device: "Focusrite Scarlett 2i2", gain: -8, mute: false, solo: false, mono: false, mc: false, a: [1, 0, 0], b: [0, 0] },
          { label: "", device: "", gain: 0, mute: true, solo: false, mono: false, mc: false, a: [0, 0, 0], b: [0, 0] },
          { label: "Desktop", device: "", gain: -4, mute: false, solo: false, mono: false, mc: false, a: [1, 0, 0], b: [0, 1] },
          { label: "Discord", device: "", gain: -6, mute: false, solo: false, mono: false, mc: false, a: [1, 0, 0], b: [0, 0] },
        ],
        buses: [
          { label: "Headphones", device: "Realtek Audio", gain: -3, mute: false, mono: false, eq: false },
          { label: "Speakers", device: "LG UltraGear", gain: -12, mute: true, mono: false, eq: true },
          { label: "", device: "", gain: 0, mute: false, mono: false, eq: false },
          { label: "Stream mic", device: "", gain: 0, mute: false, mono: false, eq: false },
          { label: "Stream mix", device: "", gain: -1.5, mute: false, mono: false, eq: false },
        ],
      };
      this.scenes = ["Streaming", "Gaming", "Late night"];
      this.t0 = performance.now();
    }

    async start(onState, onLevels) {
      this.onState = onState;
      this.emit();
      const tick = () => {
        if (this.state.connected) onLevels(this.levels((performance.now() - this.t0) / 1000));
      };
      setInterval(tick, 33);
    }
    emit() { this.onState(JSON.parse(JSON.stringify(this.state))); }

    setFloat(name, value) {
      const m = /^(Strip|Bus)\[(\d)\]\.(\w+)$/.exec(name);
      if (m) {
        const obj = (m[1] === "Strip" ? this.state.strips : this.state.buses)[+m[2]];
        const key = m[3];
        const routes = { A1: ["a", 0], A2: ["a", 1], A3: ["a", 2], B1: ["b", 0], B2: ["b", 1] };
        if (routes[key]) obj[routes[key][0]][routes[key][1]] = value ? 1 : 0;
        else if (key === "Gain") obj.gain = Math.max(-60, Math.min(12, value));
        else if (key === "Mute") obj.mute = !!value;
        else if (key === "Solo") obj.solo = !!value;
        else if (key === "Mono") obj.mono = !!value;
        else if (key === "MC") obj.mc = !!value;
        else if (m[1] === "Bus" && key === "on") obj.eq = !!value;
      } else if (/^Bus\[(\d)\]\.EQ\.on$/.test(name)) {
        this.state.buses[+name[4]].eq = !!value;
      }
      this.emit();
      return Promise.resolve();
    }
    setString(name, value) {
      const m = /^(Strip|Bus)\[(\d)\]\.Label$/.exec(name);
      if (m) (m[1] === "Strip" ? this.state.strips : this.state.buses)[+m[2]].label = value;
      this.emit();
      return Promise.resolve();
    }
    launch() {
      setTimeout(() => { this.state.connected = true; this.emit(); }, 900);
      return Promise.resolve();
    }
    listScenes() { return Promise.resolve([...this.scenes]); }
    saveScene(name) { if (!this.scenes.includes(name)) this.scenes.push(name); return Promise.resolve(); }
    loadScene() { return Promise.resolve(); }
    deleteScene(name) { this.scenes = this.scenes.filter((s) => s !== name); return Promise.resolve(); }

    // Synthetic program material: speech-like mic, strummed guitar, music on desktop, chatter on Discord.
    levels(t) {
      const n = (f, ph) => 0.5 + 0.5 * Math.sin(t * f + ph);
      const speech = (n(9, 0) * n(2.3, 1) > 0.35 ? 1 : 0.15) * (0.55 + 0.45 * n(17, 2));
      const raw = [
        -20 + 22 * speech - 6,                        // mic
        -18 + 10 * Math.pow(n(0.9, 0) , 6) - 6 * ((t * 1.1) % 1),  // guitar strum decay
        -90,                                          // nothing plugged in
        -12 + 4 * n(3.1, 0.2) + 2 * n(11, 1),          // music
        (n(0.7, 2) > 0.55 ? -16 + 8 * n(13, 0) : -70), // discord voices
      ];
      const st = this.state;
      const post = raw.map((db, i) => db + st.strips[i].gain);
      const inputs = post.map((db, i) => {
        const w = i === 0 ? 0 : 1.4 * Math.sin(t * 5 + i);
        return [db + w, db - w + (st.strips[i].mono ? w * 2 : 0)];
      });
      const outputs = st.buses.map((bus, j) => {
        const isA = j < 3;
        const k = isA ? j : j - 3;
        let p = 0;
        st.strips.forEach((s, i) => {
          if (s.mute) return;
          if ((isA ? s.a[k] : s.b[k])) p += Math.pow(10, post[i] / 10);
        });
        if (bus.mute || p === 0) return [-200, -200];
        const db = 10 * Math.log10(p) + bus.gain;
        return [db + 0.6 * Math.sin(t * 7 + j), db - 0.6 * Math.sin(t * 7 + j)];
      });
      return { inputs, outputs };
    }
  }

  window.Sleekmeeter = {
    LAYOUT,
    createEngine: () => (window.__TAURI__ ? new TauriEngine() : new MockEngine()),
  };
})();
