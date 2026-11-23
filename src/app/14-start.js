/* Sleekmeeter mixer UI, part 14 of 14: Themes, the title bar, and starting the app.
   The parts load in order from index.html as plain scripts sharing one global scope (see
   src/app/README.md), so anything declared at the top of one part is visible in the others. */
"use strict";

/* ---------- start ---------- */
// Pure black for OLED screens (Settings → Appearance).
/* ---------- themes (Settings → Appearance) ---------- */
// Each theme is a set of colour and material tokens in themes.css, keyed by data-theme.
const THEMES = [
  // Dark first: the default desk, then deeper and more atmospheric, then retro; light and playful last.
  ["graphite", "Graphite", "Machined dark aluminium with brushed caps, backlit keys and glowing LED meters"],
  ["oled", "OLED black", "Pure black with hairline outlines, and meters and faders lit in each channel’s colour"],
  ["halo", "Halo", "An eclipse ring over near-black, smoked-glass cards and fader caps that are rings of light"],
  ["abyss", "Abyss", "The deep sea at night: bioluminescent rims, plankton meters and glowing lure faders"],
  ["glass", "Glass", "Clear panes with prism rims over a bright, ever-moving spectrum of light"],
  ["overclock", "Overclock", "Carbon-fibre gaming rig with RGB light pipes, RGB meters and angled faders"],
  ["groovy", "Groovy", "70s lounge: walnut TV cabinets, rainbow stripes and lava-lamp faders"],
  ["neon", "Neon", "Neon signs on a brick wall: glass-tube outlines, tube-capsule faders and synth-coloured meters"],
  ["terminal", "Terminal", "Green phosphor, monospace, square corners"],
  ["arcade", "Arcade", "8-bit cabinet with pixel corners and bright colours"],
  ["block", "Block", "Thick outlines, hard shadows and bright colour blocks"],
  ["transit", "Transit", "Station signage: line-coloured channels, interchange faders and a little train"],
  ["nordic", "Nordic", "Sage wool felt, linen keys, oak knobs and an oak shelf under each group"],
  ["watercolour", "Watercolour", "Pigment washes on cold-press paper, ink-line channels, wet-paint meters and paint-blot faders"],
  ["bubblegum", "Bubblegum", "Pink, sparkly and cute, with heart faders and emoji icons"],
];
// Before themes there was only "Pure black for OLED" (settings.oled).
// Retired themes fall back to Graphite, the default.
const RETIRED = {
  midnight: "graphite", minimal: "graphite", clean: "graphite", analog: "graphite", studio: "graphite",
  ink: "graphite", deco: "graphite", haunted: "graphite", cosmic: "graphite", rack: "graphite",
  titanium: "graphite", afterburner: "graphite", opal: "graphite", onyx: "graphite",
  afterhours: "graphite", caldera: "graphite", blueprint: "graphite",
  letterpress: "graphite", eventhorizon: "graphite", lunar: "graphite",
  observatory: "graphite", mission: "graphite", sumi: "graphite",
  hyrule: "overclock", hadal: "glass", sticker: "block",
  // Retired in 0.22: each moves to the closest theme that stays.
  peach: "bubblegum", greenhouse: "nordic", cassette: "groovy", console: "graphite",
  darkroom: "watercolour",
};
const currentTheme = () => {
  const t = RETIRED[settings.theme] || settings.theme;
  return THEMES.some((x) => x[0] === t) ? t : settings.oled ? "oled" : "graphite";
};
let autoTheme = "";
// Theme effects are opt-in: performance comes first, so motion is off until it is chosen.
const themeMotion = () => ["off", "subtle", "full"].includes(settings.themeMotion) ? settings.themeMotion : "off";
// While the window is not in front, looping theme effects pause (themes.css, body.is-idle).
const syncIdle = () => document.body.classList.toggle("is-idle", document.hidden || !document.hasFocus());
window.addEventListener("focus", syncIdle);
window.addEventListener("blur", syncIdle);
document.addEventListener("visibilitychange", syncIdle);
syncIdle();
$("#themeMotion").addEventListener("change", (e) => {
  settings.themeMotion = e.target.value;
  document.body.dataset.themeMotion = themeMotion();
  saveSettings();
});

/* ---------- themed logos, particles and the Liquid Glass light (theme makeover) ---------- */
// Each theme draws the Sleekmeeter mark (a tile with three faders) its own way. [viewBox, inner SVG]
const markBars = (f1, f2, f3, track, rx = 1.1, x = [6, 11, 16], top = 5, h = 14) => {
  const fills = [[f1, 7], [f2, 11], [f3, 9]];
  return x.map((xx, k) => (track ? '<rect x="' + xx + '" y="' + top + '" width="2.2" height="' + h + '" rx="' + rx + '" fill="' + track + '"/>' : "")
    + '<rect x="' + xx + '" y="' + (top + h - fills[k][1]) + '" width="2.2" height="' + fills[k][1] + '" rx="' + rx + '" fill="' + fills[k][0] + '"/>').join("");
};
const BASE_MARK = '<rect x="1" y="1" width="22" height="22" rx="6" fill="var(--panel-hi)"/>' + markBars("var(--amber)", "var(--amber)", "var(--cyan)", "var(--track)");
const THEME_LOGOS = {
  oled: '<rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="#000" stroke="#2c2c33"/>' + markBars("#ffb000", "#ffb000", "#00d5ff", "#111116"),
  watercolour: '<defs><radialGradient id="bm-wc" cx=".42" cy=".38" r=".7"><stop stop-color="#9fbdd8"/><stop offset=".7" stop-color="#5683ae"/><stop offset="1" stop-color="#30638e"/></radialGradient></defs><rect x="1.2" y="1.2" width="21.6" height="21.6" rx="6.5" fill="#fbf8f1" stroke="#2b2833" stroke-width=".9"/><path d="M4.2 8.5c1.5-3.6 6.6-4.8 10.4-3.6 3.9 1.2 5.9 4.5 5 8.2-.9 3.9-4.6 6.6-8.8 6-4.5-.6-8.4-5-6.6-10.6z" fill="url(#bm-wc)" opacity=".55"/>' + markBars("#2b2833", "#2b2833", "#d1495b", "#2b283326"),
  glass: '<circle cx="12" cy="12" r="11" fill="#ffffff3a" stroke="#ffffffcc" stroke-width=".8"/><ellipse cx="9" cy="6" rx="6" ry="3" fill="#ffffff70"/>' + markBars("#fff", "#fff", "#cfefff", "#ffffff40"),
  overclock: '<path d="M5 1h18v17l-5 5H1V5z" fill="#12141b" stroke="#2c3240" stroke-width=".7"/><path d="M1.6 5.5v17" stroke="#00e5ff" stroke-width="1.4"/>' + markBars("#00e5ff", "#7b5cff", "#2bff9a", "#1a1d26", 0),
  transit: '<rect x="1" y="1" width="22" height="22" rx="5" fill="#1b1b1b"/><path d="M7.1 5v14M12.1 5v14M17.1 5v14" stroke="#ffffff30" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="2 2"/><path d="M7.1 19v-7M12.1 19V8M17.1 19v-5" stroke-width="2.2" stroke-linecap="round"/><circle cx="7.1" cy="12" r="2.2" fill="#fff" stroke="#e8502e" stroke-width="1.2"/><circle cx="12.1" cy="8" r="2.2" fill="#fff" stroke="#0a7ad1" stroke-width="1.2"/><circle cx="17.1" cy="14" r="2.2" fill="#fff" stroke="#00985f" stroke-width="1.2"/>',
  groovy: '<rect x="1" y="1" width="22" height="22" rx="7" fill="#2b1810"/><path d="M1 15a8 8 0 0 1 8 8" fill="none" stroke="#e0a526" stroke-width="2"/><path d="M1 11.5a11.5 11.5 0 0 1 11.5 11.5" fill="none" stroke="#e8702a" stroke-width="2"/><path d="M1 8a15 15 0 0 1 15 15" fill="none" stroke="#c4532a" stroke-width="2"/><path d="M17 5c2 0 3 1.5 3 4s-.8 6-3 6-3-3.5-3-6 1-4 3-4z" fill="#e8702a" stroke="#f6e3bf" stroke-width=".7"/><circle cx="17" cy="9" r="1.3" fill="#ffd27a"/>',
  neon: '<rect x="1.8" y="1.8" width="20.4" height="20.4" rx="6" fill="none" stroke="#ff2e97" stroke-width="1.6"/>' + markBars("#ff2e97", "#ff2e97", "#19f0ff", ""),
  terminal: '<rect x="1.5" y="1.5" width="21" height="21" fill="#021a0a" stroke="#3dff7a" stroke-width="1"/>' + markBars("#3dff7a", "#3dff7a", "#b6ff5c", "#0a3318", 0),
  arcade: '<g shape-rendering="crispEdges"><rect x="3" y="3" width="21" height="21" fill="#ff3bd0"/><rect x="0" y="0" width="21" height="21" fill="#ffe14a"/><rect x="4" y="9" width="3" height="9" fill="#2c1268"/><rect x="9" y="5" width="3" height="13" fill="#2c1268"/><rect x="14" y="8" width="3" height="10" fill="#3df0ff"/><rect x="14" y="8" width="3" height="3" fill="#2c1268"/></g>',
  block: '<rect x="4" y="4" width="19" height="19" fill="#111"/><rect x="1" y="1" width="19" height="19" fill="#ffe24a" stroke="#111" stroke-width="2"/><rect x="4.5" y="9" width="3" height="8" fill="#ff6b1a" stroke="#111"/><rect x="9" y="5.5" width="3" height="11.5" fill="#8a5cff" stroke="#111"/><rect x="13.5" y="8" width="3" height="9" fill="#2ad1ff" stroke="#111"/>',
  bubblegum: '<defs><linearGradient id="bm-bg" x2="0" y2="1"><stop stop-color="#ff9ed2"/><stop offset="1" stop-color="#ff3d9a"/></linearGradient></defs><path d="M12 22C4 16.5 1 12.5 1 8.3 1 4.8 3.6 2.4 6.7 2.4c2.1 0 3.9 1.1 5.3 2.9 1.4-1.8 3.2-2.9 5.3-2.9 3.1 0 5.7 2.4 5.7 5.9 0 4.2-3 8.2-11 13.7z" fill="url(#bm-bg)"/><ellipse cx="6.5" cy="6.4" rx="2.4" ry="1.4" fill="#ffffffaa" transform="rotate(-25 6.5 6.4)"/>' + markBars("#fff", "#fff", "#e9dcff", "#ffffff40", 1.1, [7.4, 11, 14.6], 7.5, 10),
  graphite: '<defs><linearGradient id="bm-gr" x2="0" y2="1"><stop stop-color="#3a3f47"/><stop offset="1" stop-color="#16181c"/></linearGradient><linearGradient id="bm-grc" x2="0" y2="1"><stop stop-color="#ffffffa0"/><stop offset=".5" stop-color="#ffffff10"/><stop offset="1" stop-color="#3fe0ff90"/></linearGradient></defs><rect x="1" y="1" width="22" height="22" rx="6" fill="url(#bm-gr)" stroke="url(#bm-grc)" stroke-width=".8"/>' + markBars("#3fe0ff", "#3fe0ff", "#2bff9e", "#07080a", .6),
  halo: '<defs><linearGradient id="bm-ha" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#8b6cff"/><stop offset=".55" stop-color="#2fa6ff"/><stop offset="1" stop-color="#ff4fd8"/></linearGradient></defs><rect x="1" y="1" width="22" height="22" rx="7" fill="url(#bm-ha)"/><rect x="1.6" y="1.6" width="20.8" height="20.8" rx="6.4" fill="none" stroke="#ffffff70" stroke-width=".6"/>' + markBars("#fff", "#fff", "#fff", "#ffffff40"),
  abyss: '<defs><radialGradient id="bm-ab" cx=".5" cy=".1" r="1"><stop stop-color="#0f4a66"/><stop offset=".6" stop-color="#06182a"/><stop offset="1" stop-color="#020812"/></radialGradient></defs><rect x="1" y="1" width="22" height="22" rx="7" fill="url(#bm-ab)" stroke="#3ff2d666" stroke-width=".6"/>' + markBars("#3ff2d6", "#3ff2d6", "#7fb8ff", "#7fe9ff1f") + '<circle cx="18.6" cy="4.4" r=".8" fill="#e6fffb" opacity=".8"/><circle cx="4.8" cy="7.2" r=".5" fill="#e6fffb" opacity=".5"/>',
  nordic: '<defs><radialGradient id="bm-no" cx=".5" cy="0" r="1.1"><stop stop-color="#71807a"/><stop offset="1" stop-color="#4b5853"/></radialGradient></defs><rect x="1" y="1" width="22" height="22" rx="7" fill="url(#bm-no)"/>' + markBars("#f5f2ec", "#f5f2ec", "#d9774b", "#0000003a"),
};
let markFor = "";
function paintBrandMark(theme) {
  if (theme === markFor) return;
  markFor = theme;
  const logo = THEME_LOGOS[theme];
  const [vb, inner] = Array.isArray(logo) ? logo : ["0 0 24 24", logo || BASE_MARK];
  document.querySelectorAll(".brand-mark").forEach((svg) => { svg.setAttribute("viewBox", vb); svg.innerHTML = inner; });
}
// Drifting particles: [count, shortest and longest loop in seconds]. Stars and marine snow start above the window.
const THEME_FX = { arcade: [30, 4, 9], bubblegum: [16, 2.5, 5], abyss: [40, 22, 48] };
let fxFor = "";
function fillThemeFx(theme) {
  if (theme === fxFor) return;
  fxFor = theme;
  const layer = document.querySelector(".theme-fx");
  if (!layer) return;
  layer.textContent = "";
  const fx = THEME_FX[theme];
  if (!fx || SIDE) return;
  const [n, d0, d1] = fx;
  for (let k = 0; k < n; k++) {
    const b = document.createElement("b");
    b.style.setProperty("--x", (Math.random() * 100).toFixed(1) + "%");
    b.style.setProperty("--y", theme === "abyss" ? (-2 - Math.random() * 8).toFixed(1) + "%" : theme === "arcade" ? (-10 - Math.random() * 100).toFixed(1) + "%" : theme === "bubblegum" ? (8 + Math.random() * 84).toFixed(1) + "%" : "0");
    b.style.setProperty("--d", (d0 + Math.random() * (d1 - d0)).toFixed(1) + "s");
    b.style.setProperty("--dl", (-Math.random() * d1).toFixed(1) + "s");
    layer.appendChild(b);
  }
}
function applyTheme() {
  document.body.dataset.theme = RETIRED[autoTheme] || autoTheme || currentTheme();
  document.body.dataset.themeMotion = themeMotion();
  paintBrandMark(document.body.dataset.theme);
  fillThemeFx(document.body.dataset.theme);
  // Fonts and spacing change with the theme, so strips must be re-sized to their names.
  lastSizes = "";
  requestAnimationFrame(() => sizeToNames());
}
function renderThemes() {
  $("#themeMotion").value = themeMotion();
  const grid = $("#themePicker");
  if (!grid.childElementCount) {
    for (const [id, name, about] of THEMES) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "theme-card"; b.dataset.theme = id; b.dataset.color = "amber";
      b.setAttribute("role", "radio");
      b.title = about;
      // A tiny desk in the theme's own colours: two modules with keys, meters and caps.
      const mod = (lit) => `<span class="tc-mod"><span class="tc-keys"><i class="${lit ? "on a" : ""}"></i><i class="${lit ? "" : "on b"}"></i></span>`
        + `<span class="tc-fader"><span class="tc-well"><b style="height:${lit ? 62 : 44}%"></b></span><span class="tc-slot"><span class="tc-cap" style="bottom:${lit ? 52 : 34}%"></span></span></span>`
        + `<span class="tc-mute${lit ? "" : " on"}"></span></span>`;
      b.innerHTML = `<span class="tc-desk">${mod(true)}${mod(false)}</span><span class="tc-name">${name}</span><span class="tc-about">${about}</span>`;
      b.addEventListener("click", () => {
        settings.theme = id;
        settings.oled = id === "oled"; // older versions read this
        applyTheme();
        renderThemes();
        saveSettings();
      });
      grid.appendChild(b);
    }
  }
  const cur = currentTheme();
  const cards = [...grid.querySelectorAll(".theme-card")];
  cards.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.theme === cur)));
  // Closed: show three (the one in use plus the first others); the button shows the rest.
  const keep = new Set([cur]);
  for (const b of cards) if (keep.size < 3) keep.add(b.dataset.theme);
  cards.forEach((b) => { b.hidden = !themesOpen && !keep.has(b.dataset.theme); });
  const more = $("#themeMore");
  more.setAttribute("aria-expanded", String(themesOpen));
  $("#themeMoreText").textContent = themesOpen ? "Show fewer themes" : `Show all ${cards.length} themes (${cards.length - 3} more)`;
  if (!more.dataset.bound) {
    more.dataset.bound = "1";
    more.addEventListener("click", () => { themesOpen = !themesOpen; renderThemes(); });
  }
}
let themesOpen = false;

/* ---------- the app's own title bar buttons (the window has no Windows frame) ---------- */
function setupWindowChrome() {
  const api = window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow
    ? window.__TAURI__.window.getCurrentWindow() : null;
  const preview = /[?&]chrome\b/.test(location.search); // the browser preview can show them too
  if (PANEL || !((api && api.label === "main") || preview)) return;
  document.body.classList.add("custom-chrome");
  $("#winctl").hidden = false;
  const run = (name) => { if (api) Promise.resolve(api[name]()).catch(() => {}); };
  $("#wcMin").addEventListener("click", () => run("minimize"));
  $("#wcMax").addEventListener("click", () => run("toggleMaximize"));
  $("#wcClose").addEventListener("click", () => run("close"));
  // Drag the window by the top bar; double-click it to maximise or restore.
  $(".bar").addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("button, input, select, a, .menu, label")) return;
    if (e.detail === 2) { if (!settings.mini) run("toggleMaximize"); return; }
    run("startDragging");
  });
  if (api && api.onResized) {
    let t = 0;
    const sync = () => Promise.resolve(api.isMaximized()).then((m) => {
      document.body.classList.toggle("maxed", !!m);
      $("#wcMax").title = $("#wcMax").ariaLabel = m ? "Restore" : "Maximise";
    }).catch(() => {});
    api.onResized(() => { clearTimeout(t); t = setTimeout(sync, 120); }).catch(() => {});
    sync();
  }
}

async function init() {
  // Register for every window before reading settings so no old snapshot survives an import.
  await engine.onSetupImported(reloadImportedSetup).catch(() => {});
  await engine.onSettingsChanged((s) => {
    if (s?.migrationEpoch && s.migrationEpoch !== settings.migrationEpoch) reloadImportedSetup({ settings: s });
  }).catch(() => {});
  await loadSettings();
  const importedBackup = sessionStorage.getItem("setupImportedBackup");
  if (importedBackup) { sessionStorage.removeItem("setupImportedBackup"); setTimeout(() => toast(`Setup imported. Backup: ${importedBackup}. Review your imported scene before loading it.`), 800); }
  setupWindowChrome();
  applyTheme();
  buildChannels(settings.edition || 2);
  applyTray();
  pinBtn.setAttribute("aria-pressed", String(!!settings.alwaysOnTop));
  if (PANEL) {
    // Pinned, fixed panel: mini rows only. Looks and hidden channels come from the mixer's settings.
    document.body.classList.add("is-mini", "is-panel");
    $("#desk").hidden = true;
    $("#miniView").hidden = false;
    engine.onPanelShown(async () => {
      await loadSettings();
      applyTheme();
      applyPanelDock();
      chans.forEach(paintLook);
      applyPanelOptions();
      applyVisibility();
    }).catch(() => {});
    applyPanelDock();
    applyPanelOptions();
    // Saved in the mixer (theme, colours, panel options): follow at once, even while open.
    engine.onSettingsChanged((s) => {
      if (!s) return;
      settings = Object.assign(clone(DEFAULT_SETTINGS), s);
      delete settings.autoTheme;
      applyTheme();
      applyPanelDock();
      chans.forEach(paintLook);
      applyPanelOptions();
      applyVisibility();
    }).catch(() => {});
  } else if (MIXWIN) {
    setupMixWindow();
    // Looks, names and theme are changed in the main window: follow at once.
    engine.onSettingsChanged((s) => {
      if (!s) return;
      settings = Object.assign(clone(DEFAULT_SETTINGS), s);
      delete settings.autoTheme;
      applyTheme();
      if (lastState) applyMixFor(lastState);
    }).catch(() => {});
  } else {
    setMini(!!settings.mini, false);
    // Know when the popped-out window opens or closes, so Mix brings it forward.
    engine.onSettingsChanged((s) => {
      if (!s) return;
      for (const key of ["mixWinOpen", "mixViewMode", "personalBus", "audienceBus"]) if (key in s) settings[key] = s[key];
    }).catch(() => {});
  }
  wakeMeters();
  engine.onThemeAuto((e) => { autoTheme = (e && e.theme) || ""; applyTheme(); }).catch(() => {});
  if (!SIDE) {
    pollInputEffects();
    setInterval(pollInputEffects, 2500);
    engine.obsStatus().then(applyObs).catch(() => {});
    engine.onObsStatus(applyObs).catch(() => {});
    engine.twitchStatus().then(applyTwitch).catch(() => {});
    engine.onTwitchStatus(applyTwitch).catch(() => {});
    engine.onAlert(onAlert).catch(() => {});
    engine.onGoLive(onGoLive).catch(() => {});
  }
  engine.onSceneAuto((e) => {
    setScene(e.scene);
    if (!SIDE) toast(`Loaded “${e.scene}” for ${e.app}`);
  }).catch(() => {});
  if (!SIDE) {
    engine.windowsOutput().then(paintWindowsOutput).catch(() => {});
    engine.onWindowsOutput(paintWindowsOutput).catch(() => {});
    engine.onEngineRestart((e) => toast(`${e.device} is back, so Sleekmeeter restarted the audio engine`)).catch(() => {});
    engine.onOutputFallback((e) => toast(`A${e.bus + 1} switched to ${e.name}`)).catch(() => {});
    // A shortcut turned ducking on or off.
    engine.onSettingsChanged((s) => {
      if (s && s.ducking) settings.ducking = s.ducking;
      if (s && "panelDocked" in s) { settings.panelDocked = s.panelDocked; if (settingsDlg.open) syncChecks(); }
      if (settingsDlg.open) syncFadeDuck();
    }).catch(() => {});
    engine.onFileDrop(onFilesDropped).catch(() => {});
    engine.onMidiLearned(onMidiLearned).catch(() => {});
  }
  fitHeader();
  checkForUpdate();
  scheduleLoud();
  offerWhatsNew().then(offerSetup).then(offerStreamDeck).then(offerUsage);
  // Show the window once the first frame with the real layout is drawn.
  requestAnimationFrame(() => requestAnimationFrame(() => engine.uiReady().catch(() => {})));
  // Names are measured with the real font once it has loaded.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { lastSizes = ""; sizeToNames(); });
  await engine.start(applyState, applyLevels);
}
init().catch(fail);
