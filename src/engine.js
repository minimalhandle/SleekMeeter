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
 *   streamDeckStatus() -> {app, device, installedVersion, bundledVersion, offer} / streamDeckInstall() / streamDeckGetApp()
 *   updateInstall() downloads and installs the newest version, then restarts (the app exits)
 *   onUpdateProgress(cb)   cb({percent}) while it downloads
 *   runningApps() / onSceneAuto(cb)   automatic scene switching
 *   glide(key, db)             fade a strip or bus ("Strip[0]") to a level
 *   recorder(action) -> {state, elapsed, since}   record, play, replay, pause, stop, rew, ff
 *   recorderOpen() -> file name | null / recorderLoad(path)   a file for the recorder to play
 *   onEngineRestart(cb) / onSettingsChanged(cb) / onFileDrop(cb)
 *   appInfo() -> {version, logDir} / openLogs() / log(level, message)   Settings → About, the log file
 *   whatsNew(all) -> {version, sections:[{title, blocks:[{kind: "h"|"p"|"li", text}]}]}   release notes once after an update (all: the latest ones)
 *   panelDock(docked)   snap the tray panel to the screen corner, or let it be moved
 *   mixWindow(open)   open (or bring forward) the Output mix in its own window, or close it
 *   outputsCapture() -> [{bus, type, name}] / outputsApply(name)   output profiles (settings.outputProfiles)
 *   appVolumes() -> [{exe, name, volume, mute, active}] / appVolumeSet(exe, volume, mute)   per-app volume
 *   selftestInputs() -> {devices} / selftestRun(input, output, secs)   hear-yourself test
 *   soundDevices() -> {devices, auto} / soundPick() -> [paths] / soundPickFolder() -> [paths] / soundPickPack() -> {folder,count}|null (copied into the data folder) / soundImport(paths) -> [copied paths] / soundPlay(name) / soundStop()   soundboard
 *   twitchStatus() / onTwitchStatus(cb)   {connected, message, last, reward: {id, user, text, at}|null} of the Twitch chat link
 *   remoteStatus() -> {running, message, urls}   Sleekmeeter Remote
 *   historyGet(minutes) -> {keys, series, stats, ...} / historyClear()   level history
 *   appRouteDevices() -> [{id, name}] / appRouteSet(pids, deviceId)   send an app to another output
 *   brbToggle() -> bool   Be right back on or off (state.brb tells which)
 *   obsStatus() / onObsStatus(cb)   {connected, live, scene, scenes, message} of the OBS link
 *   onThemeAuto(cb)   an app rule wants a theme ({theme}, "" = back to the chosen one)
 *   healthCheck() -> [{state: ok|warn|bad, label, detail, action?}]   "Check my setup"
 *   goLiveCheck() -> same shape (action "set" adds {button, param, value}) / onGoLive(cb) cb({items}) when OBS went live and something's wrong
 *   onAlert(cb)   cb({kind: mutedTalk|silent|clip, name, text}): talking while muted, a silent or clipping stream
 *   musicGuardToggle() -> bool   Music off stream on or off by hand (state.musicGuard tells which)
 *   replaySave() -> path / replayStatus() -> {running, message, device} / replayDevices() -> [names] / replayOpenFolder()   instant replay
 *   micFxStatus() -> {available, message, chains: {id: {running, off, message, latencyMs, underruns}}, plugins: {id: {loaded, error, editor}}, soundFx: {target: {running, message}}}   clean-up, plugins, listening EQ and leveller
 *   vstScan() / vstBrowse() -> [{name, vendor, path, cid}] / vstEditor(id)   VST3 plugins on the mic
 *   micFxToggle(target) -> on / micFxCompare(id, on) / micFxListen(id, on) -> on   switch, compare, hear a mic
 *   vstPresetSave(id, name) / vstPresetDelete(cid, name) -> presets / vstPresetApply(id, name)   plugin presets
 *   screens() -> [{name, label}]   for Settings → Volume overlay
 *   backupsList() -> [{file, label}] / backupRestore(file) / backupBefore(why)   Voicemeeter backups
 *   windowsOutput() -> {state: ok|wrong|unknown, output, calls, target} / fixAudio() -> {moved, restarted} / onWindowsOutput(cb)
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
    startWithWindows: false, startInTray: false, launchVoicemeeter: false, hideVoicemeeter: false,
    overlay: true, alwaysOnTop: false, mini: false, hideSoloMono: true, streamerMode: true, lockArrangement: false,
    sceneRules: [], checkUpdates: true, betaUpdates: false, skippedVersion: "", streamDeckOffered: "", usagePing: null, oled: false,
    fades: { on: true, muteMs: 250, sceneMs: 1200 },
    ducking: { on: false, trigger: "Strip[0]", targets: [], amount: 12, threshold: -40, attackMs: 150, releaseMs: 800, holdMs: 700 },
    autoRestart: true, keepWindowsOutput: false, overlayScreen: "",
    panelLayout: "rows", panelScale: 100, panelOpacity: 100, panelIcons: true, panelMute: true, panelMeters: true,
    outputProfiles: [],
    outputFallbacks: {}, outputFallbackLinks: {}, themeMotion: "subtle",
    faderGroups: [],
    panelDocked: true, panelPos: null,
    hold: { releaseMs: 250 },
    brb: { mute: [], lower: [], amount: 30, play: "", playDb: -8, overlay: true },
    obs: { on: false, host: "127.0.0.1", port: 4455, password: "", rules: [], liveDo: "", liveScene: "", offDo: "", offScene: "" },
    clipWarn: { on: false, target: "Strip[0]" },
    soundboard: { device: "", volume: 100, sounds: [] },
    twitch: { on: false, channel: "", who: "mods", cooldown: 3, commands: [], rewards: [] },
    remote: { on: false, port: 8787, key: "" },
    history: { on: false },
    streamBus: "",
    mutedTalk: { on: false, target: "Strip[0]", threshold: -35, ptt: false },
    streamWatch: { on: false, silentSecs: 15, clip: true, onlyLive: true },
    goLive: { onLive: true },
    musicGuard: { on: false, strip: "", when: "either" },
    replay: { on: false, device: "", secs: 60 },
    micFx: { aecRef: "Bus[0]", chains: [{ id: "c1", target: "Strip[0]", on: false, effect: "denoiser", strength: 100, aec: false, plugins: [] }] },
    vstPresets: [],
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
    audioEvents() { return this.invoke("audio_events_list"); }
    clearAudioEvents() { return this.invoke("audio_events_clear"); }
    onAudioEventsChanged(cb) { return this.listen("audio-events-changed", cb); }
    micTuneMeter(strip) { return this.invoke("mic_tune_meter", { strip }); }
    micTuneChange(strip, expected, next, preview) { return this.invoke("mic_tune_change", { strip, expected, next, preview }); }
    micTuneFinish(keep) { return this.invoke("mic_tune_finish", { keep }); }
    onMicTuneEnded(cb) { return this.listen("mic-tune-ended", (e) => cb(e.payload)); }
    launch() { return this.invoke("vm_launch"); }
    showWindow() { return this.invoke("vm_show_window"); }
    devices() { return this.invoke("vm_devices"); }
    listScenes() { return this.invoke("scene_list"); }
    saveScene(name) { return this.invoke("scene_save", { name }); }
    loadScene(name) { return this.invoke("scene_load", { name }); }
    scenePreview(name) { return this.invoke("scene_preview", { name }); }
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
    streamDeckStatus() { return this.invoke("streamdeck_status"); }
    streamDeckInstall() { return this.invoke("streamdeck_install"); }
    streamDeckProfileSave() { return this.invoke("streamdeck_profile_save"); }
    streamDeckGetApp() { return this.invoke("streamdeck_get_app"); }
    updateInstall() { return this.invoke("update_install"); }
    onUpdateProgress(cb) { return this.listen("update-progress", (e) => cb(e.payload)); }
    runningApps() { return this.invoke("running_apps"); }
    onSceneAuto(cb) { return this.listen("scene-auto", (e) => cb(e.payload)); }
    glide(key, value) { return this.invoke("vm_glide", { key, value }); }
    routeMute(strip, out, mute) { return this.invoke("vm_route_mute", { strip, out, mute }); }
    appInfo() { return this.invoke("app_info"); }
    whatsNew(all) { return this.invoke("whats_new", { all: !!all }); }
    openLogs() { return this.invoke("open_logs"); }
    log(level, message) { return this.invoke("ui_log", { level, message: String(message) }); }
    recorder(action) { return this.invoke("recorder_cmd", { action }); }
    recorderOpen() { return this.invoke("recorder_open"); }
    recorderLoad(path) { return this.invoke("recorder_load", { path }); }
    panelDock(docked) { return this.invoke("panel_dock", { docked }); }
    mixWindow(open) { return this.invoke("mix_window", { open }); }
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
    mixMonitorStart(input, output, cue = null) { return this.invoke("mix_monitor_start", { input, output, cue }); }
    mixMonitorStop() { return this.invoke("mix_monitor_stop"); }
    onMixMonitorEnded(cb) { return this.listen("mix-monitor-ended", (e) => cb(e.payload)); }
    onAppRouteReset(cb) { return this.listen("app-route-reset", (e) => cb(e.payload)); }
    fallbackStatus(bus) { return this.invoke("output_fallback_status", { bus }); }
    mixPreferenceSet(key, value) { return this.invoke("mix_preference_set", { key, value }); }
    guidedTest(source, stream, monitor, kind) { return this.invoke("guided_audio_test", { source, stream, monitor, kind }); }
    micTakeRecord(id) { return this.invoke("mic_take_record", { id }); }
    micTakePlay(output, processed) { return this.invoke("mic_take_play", { output, processed }); }
    micTakeClear() { return this.invoke("mic_take_clear"); }
    micPresetExport(id) { return this.invoke("mic_preset_export", { id }); }
    micPresetPreview(id) { return this.invoke("mic_preset_preview", { id }); }
    micPresetApply(id) { return this.invoke("mic_preset_apply", { id }); }
    micPresetClear() { return this.invoke("mic_preset_clear"); }
    selftestRun(input, output, secs) { return this.invoke("selftest_run", { input, output, secs }); }
    soundPlay(name) { return this.invoke("sound_play", { name }); }
    soundStop() { return this.invoke("sound_stop"); }
    twitchStatus() { return this.invoke("twitch_status"); }
    onTwitchStatus(cb) { return this.listen("twitch-status", (e) => cb(e.payload)); }
    remoteStatus() { return this.invoke("remote_status"); }
    historyGet(minutes) { return this.invoke("history_get", { minutes }); }
    historyClear() { return this.invoke("history_clear"); }
    appRouteDevices() { return this.invoke("app_route_devices"); }
    appRouteDefaults() { return this.invoke("app_route_defaults"); }
    appRouteSet(pids, device) { return this.invoke("app_route_set", { pids, device }); }
    brbToggle() { return this.invoke("brb_toggle"); }
    obsStatus() { return this.invoke("obs_status"); }
    obsAudioCheck() { return this.invoke("obs_audio_check"); }
    chatBalanceSet(selection, position, useMain = false) { return this.invoke("chat_balance_set", { selection, position, useMain }); }
    chatBalanceStatus() { return this.invoke("chat_balance_status"); }
    onChatBalance(cb) { return this.listen("chat-balance", (e) => cb(e.payload)); }
    onObsStatus(cb) { return this.listen("obs-status", (e) => cb(e.payload)); }
    onThemeAuto(cb) { return this.listen("theme-auto", (e) => cb(e.payload)); }
    healthCheck() { return this.invoke("health_check"); }
    goLiveCheck() { return this.invoke("golive_check"); }
    onGoLive(cb) { return this.listen("golive", (e) => cb(e.payload)); }
    onAlert(cb) { return this.listen("watch-alert", (e) => cb(e.payload)); }
    musicGuardToggle() { return this.invoke("music_guard_toggle"); }
    replaySave() { return this.invoke("replay_save"); }
    replayStatus() { return this.invoke("replay_status"); }
    micFxStatus() { return this.invoke("micfx_status"); }
    vstScan() { return this.invoke("vst_scan"); }
    vstBrowse() { return this.invoke("vst_browse"); }
    vstEditor(id) { return this.invoke("vst_editor", { id }); }
    vstRecover(id, bypass) { return this.invoke("vst_recover", { id, bypass }); }
    micFxToggle(target) { return this.invoke("micfx_toggle", { target }); }
    micFxCompare(id, on) { return this.invoke("micfx_compare", { id, on }); }
    micFxListen(id, on) { return this.invoke("micfx_listen", { id, on }); }
    vstPresetSave(id, name) { return this.invoke("vst_preset_save", { id, name }); }
    vstPresetApply(id, name) { return this.invoke("vst_preset_apply", { id, name }); }
    vstPresetDelete(cid, name) { return this.invoke("vst_preset_delete", { cid, name }); }
    replayDevices() { return this.invoke("replay_devices"); }
    replayOpenFolder() { return this.invoke("replay_open_folder"); }
    screens() { return this.invoke("screens"); }
    backupsList() { return this.invoke("backups_list"); }
    backupRestore(file) { return this.invoke("backup_restore", { file }); }
    backupBefore(why) { return this.invoke("backup_before", { why }); }
    windowsOutput() { return this.invoke("windows_output"); }
    fixAudio() { return this.invoke("fix_audio"); }
    onWindowsOutput(cb) { return this.listen("windows-output", (e) => cb(e.payload)); }
    settingsExport() { return this.invoke("settings_export"); }
    settingsImport() { return this.invoke("settings_import"); }
    resetLayout() { return this.invoke("reset_layout"); }
    onEngineRestart(cb) { return this.listen("engine-restarted", (e) => cb(e.payload)); }
    onOutputFallback(cb) { return this.listen("output-fallback", (e) => cb(e.payload)); }
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
        { label: "Guitar", device: "CABLE-A Output (VB-Audio Cable A)", gain: -8, pan: -0.15 },
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
        pan: 0, comp: 0, gate: 0, eq: [], limit: L.edition === 1 ? null : 12,
      }, base);
      const sampleBuses = [
        { label: "Headphones", device: "Realtek Audio", gain: -3 },
        { label: "Speakers", device: "LG UltraGear", gain: -12, mute: true, eq: true },
        { label: "", device: "" }, { label: "", device: "" }, { label: "", device: "" },
      ];
      const sampleVBuses = [{ label: "Stream mic" }, { label: "Stream mix", gain: -1.5 }, { label: "Recording" }];
      const bus = (base) => Object.assign({ label: "", device: "", gain: 0, mute: false, mono: false, eq: false, mode: "normal", sel: false }, base);
      this.state = {
        installed: true,
        connected: !offline,
        edition: L.edition,
        version: { 1: "1.1.1.9", 2: "2.1.1.9", 3: "3.1.1.9" }[L.edition],
        strips: L.strips.map((x, i) => strip(x.kind === "hw" ? sampleStrips[i] : sampleVirt[i - hs], i))
          .map((st) => Object.assign(st, { layers: L.edition === 3 ? L.buses.map(() => st.gain) : [] })),
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
      this.sceneMixes = new Map();
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
        if (saved) this.settings = Object.assign(this.settings, {
          startInTray: true, launchVoicemeeter: true, themeMotion: "full", history: { on: true },
          mutedTalk: { ...DEFAULT_SETTINGS.mutedTalk, on: true },
        }, JSON.parse(saved));
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
        const strip = m && this.state.strips[+m[1]];
        if (!strip) return null;
        if (m[2] === "Gain") return strip.gain;
        const layer = /^GainLayer\[(\d+)\]$/.exec(m[2]);
        if (layer) return strip.layers?.[+layer[1]] ?? null;
        if (+m[1] > 1) return null;
        if (n in this._chain) return this._chain[n];
        const d = { Comp: 0, Gate: 0, Denoiser: 0, "Comp.Threshold": -30, "Comp.Ratio": 2, "Gate.Threshold": -60 };
        if (!(m[2] in d)) return null;
        if (this.layout.edition < 3 && m[2].includes(".")) return null;
        if (this.layout.edition < 3 && m[2] === "Denoiser") return null;
        return d[m[2]];
      }));
    }
    audioEvents() {
      const now = Date.now();
      this._audioEvents ??= [
        { at: now - 40_000, kind: "fallback", title: "Preview · A1 switched by fallback policy", detail: "Realtek Audio", target: "0" },
        { at: now - 70_000, kind: "device", title: "Preview · Audio engine restarted after reconnect", detail: "Headphones", target: "" },
      ];
      return Promise.resolve(this._audioEvents);
    }
    clearAudioEvents() { this._audioEvents = []; this._audioEventsChanged?.(); return Promise.resolve(); }
    onAudioEventsChanged(cb) { this._audioEventsChanged = cb; return Promise.resolve(); }
    micTuneMeter(strip, phase) { this._micTuneMeter = strip == null ? null : { strip, phase }; return Promise.resolve(); }
    async micTuneChange(strip, expected, next, preview) {
      if (this._micTunePreview) throw new Error("Stop the current preview first.");
      const names = { gain: "Gain", gate: "Gate", threshold: "Gate.Threshold" };
      const changes = Object.entries(next).filter(([, v]) => Number.isFinite(v)).map(([key, after]) => ({
        name: `Strip[${strip}].${names[key]}`, before: expected[key], after,
      }));
      const values = await this.getFloats(changes.map((c) => c.name));
      if (values.some((v, i) => !Number.isFinite(v) || Math.abs(v - changes[i].before) > 0.15)) throw new Error("Input settings changed after measurement. Run the tune-up again.");
      for (const c of changes) await this.setFloat(c.name, c.after);
      if (preview) this._micTunePreview = { changes, timer: setTimeout(async () => {
        await this.micTuneFinish(false);
        this._micTuneEnded?.(null);
      }, 8000) };
    }
    async micTuneFinish(keep) {
      const p = this._micTunePreview;
      if (!p) return false;
      this._micTunePreview = null;
      clearTimeout(p.timer);
      const values = await this.getFloats(p.changes.map((c) => c.name));
      const owns = (i) => Number.isFinite(values[i]) && Math.abs(values[i] - p.changes[i].after) <= .15;
      if (keep && p.changes.every((_, i) => owns(i))) return true;
      for (const [i, c] of p.changes.entries()) if (owns(i)) await this.setFloat(c.name, c.before);
      return false;
    }
    onMicTuneEnded(cb) { this._micTuneEnded = cb; return Promise.resolve(); }
    // No fades in the simulator: the send just switches.
    routeMute(strip, out, mute) { return this.setFloat(`Strip[${strip}].${out}`, mute ? 0 : 1); }
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
      const m = /^(Strip|Bus)\[(\d)\]\.([\w.]+(?:\[\d\])?)$/.exec(name);
      if (m) {
        const obj = (m[1] === "Strip" ? this.state.strips : this.state.buses)[+m[2]];
        const key = m[3];
        const rm = /^([AB])(\d)$/.exec(key);
        const routes = rm ? { [key]: [rm[1].toLowerCase(), +rm[2] - 1] } : {};
        const simple = { Gain: "gain", Mute: "mute", Solo: "solo", Mono: "mono", MC: "mc", Pan_x: "pan", Comp: "comp", Gate: "gate", "EQ.on": "eq", Limit: "limit", Sel: "sel" };
        // Potato: a main level sets every gain layer, or only the selected output's.
        const layer = /^GainLayer\[(\d)\]$/.exec(key);
        if (layer && obj.layers) obj.layers[+layer[1]] = value;
        if (key === "Gain" && obj.layers && obj.layers.length) {
          const sel = this.state.buses.findIndex((b) => b.sel);
          if (sel >= 0) obj.layers[sel] = value; else obj.layers.fill(value);
        }
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
    sceneMics() {
      return Object.fromEntries((this.settings.micFx?.chains || []).map((c) => [
        c.target, { off: !!this._micLive?.[c.id]?.off, strength: this._micLive?.[c.id]?.strength ?? c.strength }
      ]));
    }
    saveScene(name) {
      if (!this.scenes.includes(name)) this.scenes.push(name);
      const channels = {};
      for (const [list, prefix] of [["strips", "Strip"], ["buses", "Bus"]]) {
        this.state[list].forEach((ch, i) => {
          channels[`${prefix}[${i}]`] = structuredClone({ gain: ch.gain, mute: ch.mute, a: ch.a, b: ch.b, layers: ch.layers });
        });
      }
      this.sceneMixes.set(name, { channels, mics: this.sceneMics() });
      return Promise.resolve();
    }
    loadScene(name) {
      const { channels, mics } = this.sceneMixes.get(name) || {};
      if (channels) {
        for (const [list, prefix] of [["strips", "Strip"], ["buses", "Bus"]]) {
          this.state[list].forEach((ch, i) => Object.assign(ch, structuredClone(channels[`${prefix}[${i}]`])));
        }
        this._micLive ||= {};
        for (const c of this.settings.micFx?.chains || []) if (mics[c.target]) this._micLive[c.id] = { ...mics[c.target] };
        this.emit();
      }
      return Promise.resolve();
    }
    scenePreview(name) {
      return Promise.resolve({ ...structuredClone(this.sceneMixes.get(name)), currentMics: this.sceneMics() });
    }
    deleteScene(name) { this.sceneMixes.delete(name); this.scenes = this.scenes.filter((s) => s !== name); return Promise.resolve(); }
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
    // Preview the offer with ?streamdeck=install, update or getApp in the address.
    streamDeckStatus() {
      const offer = (location.search.match(/[?&]streamdeck=(\w+)/) || [])[1] || "";
      return Promise.resolve({ app: offer !== "getApp" && offer !== "", device: offer !== "",
        installedVersion: offer === "update" ? "0.19.0.0" : null, bundledVersion: "0.19.0.1", offer });
    }
    streamDeckInstall() { return Promise.resolve(); }
    streamDeckProfileSave() { return Promise.resolve(false); }
    streamDeckGetApp() { return Promise.resolve(); }
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
    // The preview opens the popped-out Output mix as a browser window.
    mixWindow(open) {
      if (!open) { window.close(); return Promise.resolve(); }
      const q = new URLSearchParams(location.search); q.delete("panel"); q.set("mixwin", "");
      window.open(`index.html?${q.toString()}`, "sleekmeeter-mix", "width=1180,height=520");
      return Promise.resolve();
    }
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
      return Promise.resolve({ devices: ["Realtek Audio", "Speakers (Realtek USB Audio)", "Voicemeeter Input (VB-Audio Voicemeeter VAIO)", "Voicemeeter Aux Input (VB-Audio Voicemeeter AUX)"], auto: "Voicemeeter Aux Input (VB-Audio Voicemeeter AUX)" });
    }
    soundPick() { this._n = (this._n || 0) + 1; return Promise.resolve([["C:\\Sounds\\airhorn.mp3", "C:\\Sounds\\sad-trombone.wav", "C:\\Sounds\\vine-boom.ogg", "C:\\Sounds\\bruh.mp3"][(this._n - 1) % 4]]); }
    selftestInputs() { return Promise.resolve({ devices: this.layout.buses.map((b) => `Voicemeeter Out ${b.param} (VB-Audio Voicemeeter VAIO)`) }); }
    mixMonitorStart(input, output, cue = null) { this.monitor = { input, output, cue }; return Promise.resolve(); }
    mixMonitorStop() { this.monitor = null; return Promise.resolve(); }
    onMixMonitorEnded() { return Promise.resolve(); }
    chatBalanceStatus() { return Promise.resolve(this.balance || { position: 0 }); }
    onChatBalance(cb) { this.balanceListener = cb; return Promise.resolve(); }
    async chatBalanceSet(selection, position, useMain = false) {
      const suffix = this.layout.edition === 3 ? `GainLayer[${selection.bus.slice(4, -1)}]` : "Gain";
      const names = [selection.game, selection.chat].map((ch) => `${ch}.${suffix}`);
      const current = await this.getFloats(names);
      if (!current.every(Number.isFinite)) throw new Error("Voicemeeter did not report both input levels.");
      const centre = current.map((v, i) => this.balance?.position && Math.abs(v - this.balance.levels[i]) <= .15 ? this.balance.centre[i] : v);
      const levels = useMain ? await this.getFloats([selection.game, selection.chat].map((ch) => `${ch}.Gain`)) : centre.map((v, i) => {
        const amount = Math.max(0, i === 0 ? position : -position);
        return amount === 100 ? -60 : Math.max(-60, v - amount * .3);
      });
      await Promise.all(names.map((name, i) => this.setFloat(name, levels[i])));
      this.balance = { position, levels, centre };
      this.balanceListener?.(this.balance);
      return this.balance;
    }
    onAppRouteReset() { return Promise.resolve(); }
    fallbackStatus(bus) {
      const key = this.settings.outputFallbackLinks?.[bus] ?? bus;
      const chain = this.settings.outputFallbacks?.[key] || [];
      const device = this.state.buses[bus]?.device;
      const index = chain.findIndex((item) => item.name === device);
      return Promise.resolve(!chain.length ? "No fallback policy is configured for this output." : index < 0
        ? "Preview: the current device is outside this policy."
        : `Preview: ${device} is in use (priority ${index + 1}).`);
    }
    mixPreferenceSet(key, value) { return this.saveSettings({ ...this.settings, [key]: value }); }
    guidedTest(source, stream, monitor, kind) {
      return Promise.resolve(`Preview: ${kind} test selected ${source}${stream ? ` → ${stream}` : ""}. Audio plays in the Windows app.`);
    }
    micTakeRecord() { return Promise.resolve(); }
    micTakePlay() { return Promise.resolve(); }
    micTakeClear() { return Promise.resolve(); }
    async micPresetExport(id) {
      const chain = this.settings.micFx?.chains?.find((c) => c.id === id);
      if (!chain) throw new Error("That mic chain no longer exists.");
      const { on, aec, effect, strength, stereo } = chain;
      const plugins = (chain.plugins || []).map((p) => ({ cid: p.cid, name: p.name, on: p.on !== false, c: "", e: "" }));
      const url = URL.createObjectURL(new Blob([JSON.stringify({ format: "sleekmeeter-mic-chain", version: 1, on, aec, effect, strength, stereo, plugins }, null, 2)], { type: "application/json" }));
      Object.assign(document.createElement("a"), { href: url, download: "Sleekmeeter-mic-chain.json" }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    }
    async micPresetPreview(id) {
      const file = await new Promise((resolve) => {
        const input = Object.assign(document.createElement("input"), { type: "file", accept: ".json,application/json" });
        input.addEventListener("change", () => resolve(input.files[0]), { once: true });
        input.addEventListener("cancel", () => resolve(null), { once: true });
        input.click();
      });
      if (!file) return null;
      if (file.size > 16 * 1024 * 1024) throw new Error("This mic preset exceeds the 16 MB limit.");
      const data = JSON.parse(await file.text());
      const effects = { denoiser: "Noise removal", dereverb: "Room echo removal", dereverb_denoiser: "Noise and room echo removal" };
      if (data.format !== "sleekmeeter-mic-chain" || data.version !== 1 || !Object.hasOwn(effects, data.effect) ||
          !(Number.isFinite(data.strength) && data.strength >= 0 && data.strength <= 100) || !Array.isArray(data.plugins) || data.plugins.length > 32) {
        throw new Error("Choose a valid version 1 Sleekmeeter mic-chain preset.");
      }
      const installed = await this.vstScan(), chain = this.settings.micFx?.chains?.find((c) => c.id === id);
      if (!chain) throw new Error("That mic chain no longer exists.");
      const replacement = { ...chain, on: data.on === true, aec: data.aec === true, stereo: data.stereo === true, effect: data.effect, strength: data.strength, plugins: [] };
      const plugins = data.plugins.map((p) => {
        const found = installed.find((f) => f.cid === p.cid);
        if (!found) return { name: p.name || "Unnamed VST3", status: "Missing · skipped" };
        replacement.plugins.push({ ...found, id: "p" + crypto.randomUUID(), on: p.on !== false });
        return { name: found.name, status: p.on !== false ? "Installed · enabled" : "Installed · disabled" };
      });
      this._micPreset = { id, replacement };
      return { effect: effects[data.effect], on: replacement.on, aec: replacement.aec, stereo: replacement.stereo, strength: data.strength, plugins, notes: ["Preview uses simulated NVIDIA and VST3 availability."] };
    }
    async micPresetApply(id) {
      const pending = this._micPreset;
      if (pending?.id !== id) throw new Error("Preview a preset first.");
      const micFx = this.settings.micFx;
      micFx.chains = micFx.chains.map((c) => c.id === id ? pending.replacement : c);
      await this.saveSettings(this.settings);
      this._micPreset = null;
      return JSON.parse(JSON.stringify(micFx));
    }
    micPresetClear() { this._micPreset = null; return Promise.resolve(); }
    selftestRun(input, output, secs) { return new Promise((r) => setTimeout(r, Math.min(secs, 2) * 1000)); }
    soundImport(paths) { return Promise.resolve(paths); }
    soundPickPack() { return Promise.resolve({ folder: "C:\\Sounds\\Cheers", count: 6 }); }
    soundPickFolder() { return Promise.resolve(["rimshot.wav", "wilhelm-scream.mp3", "oof.ogg", "bell_ding.flac", "applause.wav"].map((f) => "C:\\Sounds\\Memes\\" + f)); }
    soundPlay(name) { this.played = name; return Promise.resolve(); }
    soundStop() { return Promise.resolve(); }
    // With chat on, a viewer seems to redeem a channel point reward every few seconds (for adding rewards).
    twitchStatus() {
      const t = this.settings.twitch || {};
      if (!t.on) return Promise.resolve({ connected: false, message: "Off", last: "", reward: null });
      if (!t.channel) return Promise.resolve({ connected: false, message: "Enter your channel name", last: "", reward: null });
      const at = Math.floor(Date.now() / 3000) * 3000;
      return Promise.resolve({ connected: true, message: `In #${t.channel} chat`, last: "", reward: { id: "27c8e486-a386-40cc-9a4b-dbb5cf01e439", user: "Viewer", text: "airhorn", at } });
    }
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
    appRouteDefaults() { return Promise.resolve(["{0.0.0.00000000}.{aaaa}", "{0.0.0.00000000}.{bbbb}"]); }
    appRouteDevices() {
      const endpoints = [{ id: "{0.0.0.00000000}.{aaaa}", name: "Voicemeeter Input (VB-Audio Voicemeeter VAIO)" },
        { id: "{0.0.0.00000000}.{bbbb}", name: "Voicemeeter Aux Input (VB-Audio Voicemeeter AUX)" },
        { id: "{0.0.0.00000000}.{cccc}", name: "Speakers (Realtek USB Audio)" },
        { id: "{0.0.0.00000000}.{dddd}", name: "CABLE-A Input (VB-Audio Cable A)" }];
      if (this.layout.edition === 3) endpoints.push({ id: "{0.0.0.00000000}.{eeee}", name: "Voicemeeter VAIO3 Input (VB-Audio Voicemeeter VAIO3)" });
      return Promise.resolve(endpoints);
    }
    appRouteSet(pids, device) {
      this.routed = { pids, device };
      for (const app of this.apps) if (app.pids.some((pid) => pids.includes(pid))) app.endpoints = device ? [device] : [];
      return Promise.resolve();
    }
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
    obsAudioCheck() {
      return Promise.resolve({live: 1, vod: 2, recording: [1, 3, 4], sources: [
        {name: "Stream Mix", kind: "wasapi_input_capture", deviceName: "Voicemeeter Out B2", device: "b2", tracks: [1, 2], mute: false, active: true},
        {name: "Desktop Audio", kind: "wasapi_output_capture", deviceName: "Headphones", device: "desktop", tracks: [1], mute: false, active: true},
        {name: "Microphone", kind: "wasapi_input_capture", deviceName: "Shure MV7", device: "mic", tracks: [3], mute: false, active: true},
        {name: "Game", kind: "wasapi_process_output_capture", tracks: [4], mute: false, active: true},
      ]});
    }
    onObsStatus() { return Promise.resolve(); }
    onThemeAuto() { return Promise.resolve(); }
    // Preview the wrong-output warning with ?audio=wrong in the address.
    windowsOutput() {
      const wrong = /[?&]audio=wrong\b/.test(location.search) && !this._audioFixed;
      return Promise.resolve(wrong ? { state: "wrong", output: "Headphones (Arctis Nova Pro Wireless)", calls: "Headset Earphone (BTD 700)", target: "Voicemeeter Input (VB-Audio Voicemeeter VAIO)" }
        : { state: "ok", output: "Voicemeeter Input (VB-Audio Voicemeeter VAIO)", calls: "Voicemeeter Input (VB-Audio Voicemeeter VAIO)", target: "Voicemeeter Input (VB-Audio Voicemeeter VAIO)" });
    }
    fixAudio() {
      const moved = /[?&]audio=wrong\b/.test(location.search) && !this._audioFixed ? "Voicemeeter Input (VB-Audio Voicemeeter VAIO)" : null;
      this._audioFixed = true;
      return Promise.resolve({ moved, restarted: true });
    }
    onWindowsOutput() { return Promise.resolve(); }
    backupsList() { return Promise.resolve([{ file: "daily 2026-11-06.xml", label: "6 Nov 2026 (daily)" }, { file: "before 2026-11-05 21.14 loading a scene.xml", label: "5 Nov 2026, 21:14, before loading a scene" }, { file: "daily 2026-11-05.xml", label: "5 Nov 2026 (daily)" }]); }
    backupRestore() { return Promise.resolve(); }
    backupBefore() { return Promise.resolve(); }
    screens() { return Promise.resolve([{ name: "\\\\.\\DISPLAY1", label: "Screen 1 (2560×1440, main)" }, { name: "\\\\.\\DISPLAY2", label: "Screen 2 (1920×1080)" }]); }
    healthCheck() {
      return new Promise(async (r) => {
        const out = await this.windowsOutput();
        setTimeout(() => r([
        out.state === "wrong" ? { state: "bad", label: "Windows sound output", detail: `Windows sends sound to ${out.output}, not Voicemeeter, so apps skip the mixer and its channels stay quiet. This often happens after plugging devices in.`, action: "fixAudio" }
          : { state: "ok", label: "Windows sound output", detail: `Windows sends sound to ${out.output}.` },
        { state: "ok", label: "Voicemeeter", detail: "Running and connected." },
        { state: "warn", label: "Audio devices", detail: "Windows doesn't list: Headphones (Arctis Nova Pro Wireless). Plug it in or switch it on; Sleekmeeter restarts the audio engine when it returns." },
        { state: "ok", label: "Shortcuts", detail: "4 shortcuts working." },
        { state: "ok", label: "Saving settings", detail: "Settings, scenes and logs can be saved." },
      ]), 500);
      });
    }
    /* Going live, simulated the way watch.rs and golive.rs do it in the app. */
    streamBus() {
      const L = this.layout, hb = L.buses.filter((x) => x.kind === "hw").length, vb = L.buses.length - hb;
      const m = /^Bus\[(\d)\]$/.exec(this.settings.streamBus || "");
      if (m && +m[1] < L.buses.length) return +m[1];
      const j = hb + (vb >= 2 ? 1 : 0);
      return j < L.buses.length ? j : -1;
    }
    // The route from strip i to bus j: ["b", 1] for B2.
    routeOf(j) {
      const hb = this.layout.buses.filter((x) => x.kind === "hw").length;
      return j < hb ? ["a", j] : ["b", j - hb];
    }
    goLiveCheck() {
      const st = this.state, s = this.settings, out = [];
      const item = (state, label, detail, extra) => out.push(Object.assign({ state, label, detail }, extra || {}));
      if (!st.connected) { item("bad", "Voicemeeter", "Voicemeeter isn't running, so nothing reaches your stream."); return Promise.resolve(out); }
      const mm = /^Strip\[(\d)\]$/.exec((s.mutedTalk || {}).target || "");
      const mi = mm && +mm[1] < st.strips.length ? +mm[1] : 0;
      const mic = st.strips[mi], micName = mic.label || "Your mic";
      const j = this.streamBus(), bus = st.buses[j], p = this.layout.buses[j] ? this.layout.buses[j].param : "";
      const busName = bus ? (bus.label ? `${bus.label} (${p})` : p) : "the stream output";
      if (st.brb) item("warn", "Mic", "Be right back is on, so your mic is muted. Press Back live when you're ready.");
      else if (mic.mute) item("bad", "Mic", `${micName} is muted.`, { action: "set", button: "Unmute", param: `Strip[${mi}].Mute`, value: 0 });
      else item("ok", "Mic", `${micName} is on.`);
      if (bus) {
        const [k, n] = this.routeOf(j);
        if (mic[k][n]) item("ok", "Mic on stream", `${micName} goes to ${busName}.`);
        else item("bad", "Mic on stream", `${micName} isn't sent to ${busName}, so viewers won't hear you.`, { action: "set", button: `Send it to ${p}`, param: `Strip[${mi}].${p}`, value: 1 });
        if (bus.mute) item("bad", "Stream output", `${busName} is muted, so your stream gets no sound.`, { action: "set", button: "Unmute", param: `Bus[${j}].Mute`, value: 0 });
        else if (bus.gain <= -20) item("warn", "Stream output", `${busName} is turned down to ${Math.round(bus.gain)} dB, so your stream will be quiet.`);
        else item("ok", "Stream output", `${busName} is on.`);
        const ago = this._soundAt ? (performance.now() - this._soundAt) / 1000 : null;
        if (ago !== null && ago < 10) item("ok", "Sound on stream", `Sound is reaching ${busName}.`);
        else item("warn", "Sound on stream", ago === null ? `${busName} hasn't had any sound since Sleekmeeter started.` : `${busName} has been silent for ${Math.round(ago)} seconds. Say something, or check that your game and music are sent to ${p}.`);
      }
      const g = s.musicGuard || {};
      if (g.on) {
        const gm = /^Strip\[(\d)\]$/.exec(g.strip || "");
        const when = { recording: "while OBS records", live: "while you're live", manual: "when you press its key" }[g.when] || "while you're live or recording";
        if (gm && st.strips[+gm[1]]) item("ok", "Music off stream", `${st.strips[+gm[1]].label || "Music"} is kept off the stream ${when}.${st.musicGuard ? " It's off the stream now." : ""}`);
        else item("warn", "Music off stream", "Choose your music channel in Settings → Going live.");
      }
      if ((s.obs || {}).on) item("ok", "OBS", /[?&]live\b/.test(location.search) ? "Connected, and you're live." : "Connected.");
      else item("warn", "OBS", "Not linked, so Sleekmeeter can't tell when you go live. Turn it on in Settings → OBS Studio.");
      if (/[?&]audio=wrong\b/.test(location.search) && !this._audioFixed) item("bad", "Windows sound output", "Windows sends sound to Headphones (Arctis Nova Pro Wireless), not Voicemeeter, so those apps skip the mixer.", { action: "fixAudio" });
      else item("ok", "Windows sound output", "Windows plays through Voicemeeter.");
      if ((s.twitch || {}).on) item((s.twitch.channel ? "ok" : "warn"), "Twitch chat", s.twitch.channel ? `In #${s.twitch.channel} chat` : "Not connected: enter your channel name. Chat commands and channel point sounds won't work.");
      if ((s.replay || {}).on) item("ok", "Instant replay", `Keeping the last ${s.replay.secs || 60} seconds of Voicemeeter Out B2 (VB-Audio Voicemeeter AUX VAIO).`);
      return new Promise((r) => setTimeout(() => r(out), 400));
    }
    onGoLive() { return Promise.resolve(); }
    onAlert(cb) { this._alert = cb; return Promise.resolve(); }
    // Music off stream: switch the music channel's route to the stream output off, or back on.
    guard(on) {
      const st = this.state;
      if (on && !this._guardRoute) {
        const gm = /^Strip\[(\d)\]$/.exec((this.settings.musicGuard || {}).strip || ""), j = this.streamBus();
        if (!gm || j < 0 || !st.strips[+gm[1]]) return;
        const [k, n] = this.routeOf(j), strip = st.strips[+gm[1]];
        if (!strip[k][n]) return;
        strip[k][n] = 0; this._guardRoute = [strip, k, n]; st.musicGuard = true;
      } else if (!on && this._guardRoute) {
        const [strip, k, n] = this._guardRoute;
        strip[k][n] = 1; this._guardRoute = null; st.musicGuard = false;
      } else return;
      this.emit();
    }
    musicGuardToggle() {
      const g = this.settings.musicGuard || {};
      if (!g.on || !/^Strip\[\d\]$/.test(g.strip || "")) return Promise.reject(new Error("Choose your music channel in Settings → Going live first"));
      this._guardManual = !this.state.musicGuard;
      this.guard(this._guardManual);
      return Promise.resolve(!!this.state.musicGuard);
    }
    // Called with every meter reading: talking while muted, a silent or clipping stream, Music off stream.
    watch(t, raw, outputs) {
      const s = this.settings, st = this.state, now = performance.now();
      const say = (kind, name, text) => { if (this._alert) this._alert({ kind, name, text }); };
      const mt = s.mutedTalk || {}, mm = /^Strip\[(\d)\]$/.exec(mt.target || "");
      const ptt = (s.hotkeys || []).some((h) => h.action === "ptt" && h.target === mt.target) && !mt.ptt;
      const mic = mm ? st.strips[+mm[1]] : null;
      this._talk = this._talk || [];
      if (mt.on !== false && mic && mic.mute && !st.brb && !ptt) {
        this._talk.push(raw[+mm[1]] > (mt.threshold ?? -35));
        if (this._talk.length > 36) this._talk.shift();
        if (this._talk.filter(Boolean).length >= 21 && !(now - (this._talkAt || -1e9) < 8000)) { this._talkAt = now; say("mutedTalk", mic.label || "Your mic", "You're muted"); }
      } else this._talk = [];
      const j = this.streamBus(), live = /[?&]live\b/.test(location.search);
      if (j >= 0) {
        const lv = Math.max(...outputs[j]);
        if (lv > -60) { this._soundAt = now; this._quietAt = null; this._silentAt = null; } else if (!this._quietAt) this._quietAt = now;
        const w = s.streamWatch || {};
        if (w.on && (!w.onlyLive || live)) {
          const bus = st.buses[j], name = bus.label || this.layout.buses[j].param;
          if (this._quietAt && now - this._quietAt >= (w.silentSecs || 15) * 1000 && !(now - (this._silentAt || -1e9) < 60000)) { this._silentAt = now; say("silent", name, "Your stream is silent"); }
          this._clipRun = w.clip !== false && lv >= -0.3 ? (this._clipRun || 0) + 1 : 0;
          if (this._clipRun >= 6 && !(now - (this._clipAt || -1e9) < 15000)) { this._clipAt = now; say("clip", name, "Your stream is clipping"); }
        }
      }
      const g = s.musicGuard || {};
      const auto = g.when === "manual" ? false : live && g.when !== "recording";
      if (this._guardAuto !== auto) { this._guardAuto = auto; this._guardManual = undefined; }
      const want = !!g.on && (this._guardManual ?? auto);
      if (want !== !!st.musicGuard) this.guard(want);
    }
    micFxStatus() {
      const m = this.settings.micFx || {};
      const names = { denoiser: "noise removal", dereverb: "room echo removal", dereverb_denoiser: "noise and room echo removal" };
      const live = this._micLive || {};
      const chains = {}, plugins = {};
      for (const c of Array.isArray(m.chains) ? m.chains : []) {
        const i = +((/\d+/.exec(c.target || "") || [0])[0]);
        const ps = Array.isArray(c.plugins) ? c.plugins : [];
        for (const p of ps) plugins[p.id] = { loaded: true, error: "", editor: true };
        const on = ps.filter((p) => p.on !== false).length;
        const nv = [];
        if (c.aec) nv.push("speaker echo removal");
        if (c.on) nv.push(names[c.effect] || names.denoiser);
        const what = [];
        if (nv.length) what.push(`${nv.join(" and ")} on your NVIDIA GPU`);
        if (on) what.push(on === 1 ? "1 plugin" : `${on} plugins`);
        const bus = /^Bus/.test(c.target || "");
        const label = bus ? (["Headphones", "Speakers", "Output A3", "Stream mic", "Stream mix"][i] || "Output " + (i + 1))
          : (["Mic", "Line in", "Hardware input 3", "Desktop", "Discord"][i] || "Input " + (i + 1));
        const off = !!(live[c.id] || {}).off;
        chains[c.id] = what.length && !off
          ? { running: true, off, latencyMs: 26.7, underruns: 0, message: `${bus ? "Running on" : "Cleaning up"} ${label}: ${what.join(" and ")}.` }
          : { running: false, off, latencyMs: 0, underruns: 0, message: off ? "Switched off." : "" };
      }
      const soundFx = {};
      for (const [target, v] of Object.entries(this.settings.soundFx || {})) {
        if ((v.eq && v.eq !== "off") || (v.level && v.level !== "off")) soundFx[target] = { running: true, message: "" };
      }
      return Promise.resolve({ available: true, message: "", chains, plugins, soundFx });
    }
    micFxToggle(target) {
      const m = this.settings.micFx || {};
      this._micLive = this._micLive || {};
      const hit = (m.chains || []).filter((c) => !target || c.target === target);
      const turnOn = hit.every((c) => (this._micLive[c.id] || {}).off);
      for (const c of hit) this._micLive[c.id] = { off: !turnOn };
      return Promise.resolve(turnOn);
    }
    micFxCompare() { return Promise.resolve(); }
    micFxListen(id, on) { return Promise.resolve(!!on); }
    vstPresetSave(id, name) {
      const m = this.settings.micFx || {};
      const p = (m.chains || []).flatMap((c) => c.plugins || []).find((x) => x.id === id);
      const list = (this.settings.vstPresets || []).filter((x) => !(x.cid === p.cid && x.name === name));
      list.push({ name, cid: p.cid, c: "", e: "" });
      this.settings.vstPresets = list;
      return Promise.resolve(list);
    }
    vstPresetApply() { return Promise.resolve(); }
    vstPresetDelete(cid, name) {
      this.settings.vstPresets = (this.settings.vstPresets || []).filter((x) => !(x.cid === cid && x.name === name));
      return Promise.resolve(this.settings.vstPresets);
    }
    vstScan() {
      return new Promise((r) => setTimeout(() => r([
        { name: "Pro-Q 3", vendor: "FabFilter", path: "C:\\Program Files\\Common Files\\VST3\\FabFilter Pro-Q 3.vst3", cid: "72C4DB717A4D459AB97E51745D84B39D" },
        { name: "ReaComp", vendor: "Cockos", path: "C:\\Program Files\\Common Files\\VST3\\reacomp.vst3", cid: "565354726A6370726561636F6D700000" },
        { name: "TDR Nova", vendor: "Tokyo Dawn Labs", path: "C:\\Program Files\\Common Files\\VST3\\TDR Nova.vst3", cid: "56535454644E6F746472206E6F766100" },
      ]), 400));
    }
    vstBrowse() { return Promise.resolve([]); }
    vstEditor() { return Promise.reject(new Error("Plugin windows open in the Sleekmeeter app, not the browser preview")); }
    vstRecover() { return Promise.resolve(); }
    replayStatus() {
      const r = this.settings.replay || {};
      return Promise.resolve(r.on ? { running: true, device: "Voicemeeter Out B2 (VB-Audio Voicemeeter AUX VAIO)", message: `Keeping the last ${r.secs || 60} seconds of Voicemeeter Out B2 (VB-Audio Voicemeeter AUX VAIO).` } : { running: false, device: "", message: "Off" });
    }
    replayDevices() { return Promise.resolve(["Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)", "Voicemeeter Out B2 (VB-Audio Voicemeeter AUX VAIO)", "Voicemeeter Out B3 (VB-Audio Voicemeeter VAIO3)"]); }
    replaySave() {
      const r = this.settings.replay || {};
      if (!r.on) return Promise.reject(new Error("Turn on Instant replay in Settings → Instant replay first"));
      const d = new Date(), p = (n) => String(n).padStart(2, "0");
      return Promise.resolve(`C:\\Users\\you\\Music\\Sleekmeeter replays\\Replay ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.wav`);
    }
    replayOpenFolder() { return Promise.resolve(); }
    settingsExport() { return Promise.resolve("Sleekmeeter settings.json"); }
    settingsImport() { return Promise.resolve(null); }
    resetLayout() { return Promise.resolve(); }
    appInfo() { return Promise.resolve({ version: "preview", logDir: null }); }
    // ?whatsnew shows sample notes at start, as after an update; the Settings button always does.
    whatsNew(all) {
      if (!all && !/[?&]whatsnew\b/.test(location.search)) return Promise.resolve({ version: "preview", sections: [] });
      return Promise.resolve({ version: "preview", sections: [
        { title: "0.17.0", blocks: [
          { kind: "p", text: "Everything since 0.15.3." },
          { kind: "h", text: "Output mix (Voicemeeter Potato)" },
          { kind: "li", text: "**In its own window:** pop it out onto a second screen" },
          { kind: "h", text: "Stream Deck (plugin 0.17.0.0)" },
          { kind: "li", text: "**Swap route:** like a Voicemeeter macro with `Strip(0).B2 = 1`" },
          { kind: "li", text: "Fixed: **Now Playing** works with Windows' default PowerShell setting" },
        ] },
      ] });
    }
    openLogs() { return Promise.reject(new Error("The log is only kept by the Windows app")); }
    log(level, message) { (level === "error" ? console.error : console.log)("[log]", message); return Promise.resolve(); }
    recorderLoad(path) { return Promise.resolve(path.split(/[\\/]/).pop()); }
    onEngineRestart() { return Promise.resolve(); }
    onOutputFallback() { return Promise.resolve(); }
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
          if (isA ? s.a[k] : s.b[k]) {
            const layerOffset = (s.layers?.[j] ?? s.gain) - s.gain;
            pw += Math.pow(10, (post[i] + layerOffset) / 10);
          }
        });
        if (bus.mute || pw === 0) return [-200, -200];
        const db = 10 * Math.log10(pw) + bus.gain;
        return [db + 0.6 * Math.sin(t * 7 + j), db - 0.6 * Math.sin(t * 7 + j)];
      });
      this.watch(t, raw, outputs);
      const m = this._micTuneMeter;
      const pre = m ? [-57, -27, -15][m.phase] + Math.sin(t * 12) * 3 : undefined;
      const micTune = m ? { strip: m.strip, pre, post: pre + st.strips[m.strip].gain } : undefined;
      return { inputs, outputs, micTune };
    }
  }

  window.Sleekmeeter = {
    layoutFor, BUS_MODES, DEFAULT_SETTINGS,
    createEngine: () => (window.__TAURI__ ? new TauriEngine() : new MockEngine()),
  };
})();
