/* Sleekmeeter mixer UI, part 2 of 14: The channel drawer: a channel's settings, sound and devices.
   The parts load in order from index.html as plain scripts sharing one global scope (see
   src/app/README.md), so anything declared at the top of one part is visible in the others. */
"use strict";

/* ---------- channel drawer ---------- */
let drawerCh = null;
let deviceCache = null;
const drawer = $("#drawer"), drawerBody = $("#drawerBody");
const drawerPanels = { routing: $("#drawerRouting"), sound: $("#drawerSound"), apps: $("#drawerApps"), look: $("#drawerLook") };
let drawerTab = "routing";
const selectDrawerTab = bindTabs($("#drawerTabs"), (tab) => {
  drawerTab = tab;
  drawerBody.scrollTop = 0;
  if (tab === "apps") paintDrawerApps();
});

function openDrawer(ch, tab = "routing") {
  drawerCh = ch;
  drawerTab = tab;
  drawer.hidden = false;
  renderDrawerHead();
  buildDrawerBody();
  selectDrawerTab(drawerTab, true);
  engine.devices().then((d) => { deviceCache = d; if (drawerCh === ch) fillDevices(); }).catch(() => {});
}
function closeDrawer() {
  const ch = drawerCh;
  drawerCh = null;
  drawer.hidden = true;
  if (ch && ch.chips[0]) ch.chips[0].focus();
}
$("#drawerClose").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && drawerCh && !document.querySelector("dialog[open]")) closeDrawer();
});

function renderDrawerHead() {
  const ch = drawerCh, lk = look(ch);
  const chip = $("#drawerChip");
  chip.dataset.color = lk.color;
  chip.innerHTML = svg(lk.icon, 22);
  $("#drawerTitle").textContent = displayName(ch);
  const sub = subText(ch);
  $("#drawerSub").textContent = Array.isArray(sub) ? sub.join(" ") : sub;
  drawer.dataset.color = lk.color;
  drawerBody.querySelectorAll(".swatch").forEach((s) => s.setAttribute("aria-pressed", String(s.dataset.value === lk.color)));
  drawerBody.querySelectorAll(".icon-pick").forEach((s) => s.setAttribute("aria-pressed", String(s.dataset.value === lk.icon)));
  const hide = $("#lookHidden");
  if (hide) hide.checked = lk.hidden;
  const inOsd = $("#lookOsd"), inPanel = $("#lookPanel");
  if (inOsd) inOsd.checked = lk.osd;
  if (inPanel) inPanel.checked = lk.panel;
  const inMix = $("#lookMix");
  if (inMix) inMix.checked = lk.mix;
}

function section(title, tab = "sound") {
  const s = document.createElement("section");
  if (title) s.appendChild(Object.assign(document.createElement("h3"), { textContent: title }));
  drawerPanels[tab].appendChild(s);
  return s;
}

// A labelled slider bound to one Voicemeeter parameter.
function rangeField(parent, { id, label, param, min, max, step, center, format, reset }) {
  const row = document.createElement("div");
  row.className = "field";
  row.innerHTML = `<label for="${id}">${label}</label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}"><output for="${id}"></output>`;
  const input = $("input", row), out = $("output", row);
  input.dataset.param = param;
  const paint = () => {
    const v = +input.value;
    out.textContent = format(v);
    const p = ((v - min) / (max - min)) * 100;
    const c = center === undefined ? 0 : ((center - min) / (max - min)) * 100;
    const [a, b] = p < c ? [p, c] : [c, p];
    input.style.setProperty("--track-bg",
      `linear-gradient(to right, var(--track) ${a}%, var(--acc) ${a}%, var(--acc) ${b}%, var(--track) ${b}%)`);
  };
  input.addEventListener("input", () => { paint(); sendFloat(`${drawerCh.prefix}.${param}`, +input.value); });
  input.addEventListener("dblclick", () => { input.value = reset; paint(); sendFloat(`${drawerCh.prefix}.${param}`, reset); });
  input._paint = paint;
  parent.appendChild(row);
  return input;
}

function buildDrawerBody() {
  const ch = drawerCh;
  for (const panel of Object.values(drawerPanels)) panel.replaceChildren();
  $("#drawerAppsTab").hidden = ch.kind !== "strip";
  if (ch.kind === "strip") {
    const dest = section("Mute button destination", "routing");
    const mode = Object.assign(document.createElement("select"), { ariaLabel: "Mute button destination" });
    const chat = Object.assign(document.createElement("select"), { ariaLabel: "Voice chat output" });
    mode.append(new Option("Everyone", "all"), new Option("Audience", "audience"),
      new Option("Headphones", "personal"), new Option("Voice chat", "chat"));
    chat.append(new Option("Choose voice chat output", ""), ...busOptions(chans.filter((c) => c.kind === "bus" && !isHw(c))));
    const cfg = settings.muteDestinations?.[ch.key] || {};
    mode.value = cfg.mode || "all";
    chat.value = cfg.bus || "";
    chat.hidden = mode.value !== "chat";
    const update = () => {
      settings.muteDestinations = { ...settings.muteDestinations, [ch.key]: { mode: mode.value, bus: chat.value } };
      chat.hidden = mode.value !== "chat";
      paintPartMute(ch); saveSettings();
    };
    mode.addEventListener("change", update); chat.addEventListener("change", update);
    dest.append(mode, chat, Object.assign(document.createElement("p"), {
      className: "hint", textContent: "Applies to the main Mute button in the mixer and tray. Right-click to choose other outputs."
    }));
    const monitor = section("Private monitoring");
    const cue = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: "Cue in headphones…" });
    cue.addEventListener("click", () => openMonitor(ch));
    monitor.append(cue);
  }

  const lookSec = section("Look", "look");
  const sw = document.createElement("div");
  sw.className = "swatches"; sw.setAttribute("role", "group"); sw.setAttribute("aria-label", "Color");
  for (const [key, label] of Object.entries(COLORS)) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "swatch"; b.dataset.color = key; b.dataset.value = key;
    b.title = label; b.setAttribute("aria-label", label);
    b.addEventListener("click", () => setLook(ch, { color: key }));
    sw.appendChild(b);
  }
  const grid = document.createElement("div");
  grid.className = "icon-grid"; grid.setAttribute("role", "group"); grid.setAttribute("aria-label", "Icon");
  for (const [key, [label]] of Object.entries(ICONS)) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "icon-pick"; b.dataset.value = key; b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = svg(key, 18);
    b.addEventListener("click", () => setLook(ch, { icon: key }));
    grid.appendChild(b);
  }
  const hide = document.createElement("label");
  hide.className = "check";
  hide.innerHTML = `<input type="checkbox" id="lookHidden"><span>Hide this ${ch.kind === "strip" ? "input" : "output"} from the mixer</span>`;
  $("input", hide).addEventListener("change", (e) => setLook(ch, { hidden: e.target.checked }));
  const inOsd = document.createElement("label");
  inOsd.className = "check";
  inOsd.innerHTML = `<input type="checkbox" id="lookOsd"><span>Show in the volume overlay when its level changes</span>`;
  $("input", inOsd).addEventListener("change", (e) => setLook(ch, { osd: e.target.checked }));
  const inPanel = document.createElement("label");
  inPanel.className = "check";
  inPanel.innerHTML = `<input type="checkbox" id="lookPanel"><span>Show in the tray volume panel</span>`;
  $("input", inPanel).addEventListener("change", (e) => setLook(ch, { panel: e.target.checked }));
  lookSec.append(sw, grid, hide, inOsd, inPanel);
  // Potato's output mix: leave an unused output out of Mix without hiding its fader here.
  if (ch.kind === "bus" && layout && layout.edition === 3) {
    const inMix = document.createElement("label");
    inMix.className = "check";
    inMix.innerHTML = `<input type="checkbox" id="lookMix"><span>Show in Mix (the output mix)</span>`;
    $("input", inMix).addEventListener("change", (e) => setLook(ch, { mix: e.target.checked }));
    lookSec.appendChild(inMix);
  }

  if (isHw(ch)) {
    const devSec = section(ch.kind === "strip" ? "Input device" : "Output device", "routing");
    const sel = document.createElement("select");
    sel.id = "deviceSelect";
    sel.setAttribute("aria-label", "Device");
    sel.innerHTML = `<option>Loading devices…</option>`;
    sel.addEventListener("change", () => {
      const [type, ...rest] = sel.value.split("|");
      const name = rest.join("|");
      engine.setString(`${ch.prefix}.device.${type || "wdm"}`, name)
        .then(() => toast(name ? `Switched to ${name}` : "Device removed"))
        .catch(fail);
    });
    devSec.appendChild(sel);
    if (ch.kind === "bus") {
      const fallback = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: "Open output fallbacks…" });
      fallback.addEventListener("click", () => { closeDrawer(); openOutputFallback(ch.i); });
      devSec.append(fallback);
    }
    if (deviceCache) fillDevices();
  }

  if (ch.kind === "strip") {
    const sends = section("Send to", "routing");
    const routeRow = Object.assign(document.createElement("div"), { className: "routes drawer-routes" });
    routeRow.setAttribute("role", "group");
    routeRow.setAttribute("aria-label", "Send to");
    for (const t of ch.toggles.filter(({ param }) => /^[AB]\d$/.test(param))) {
      const b = t.btn.cloneNode(true);
      b.removeAttribute("id");
      b.dataset.param = t.param;
      b.addEventListener("click", () => { t.btn.click(); renderDrawerValues(); });
      routeRow.appendChild(b);
    }
    sends.appendChild(routeRow);
    const effects = section(isHw(ch) ? "Input effects" : "Voice clean-up and plugins");
    const open = Object.assign(document.createElement("button"), { type: "button", className: "btn",
      textContent: isHw(ch) ? "Open this input’s effects chain…" : "Clean up voices or add plugins…" });
    open.addEventListener("click", () => openInputEffects(ch));
    effects.append(open);
    const pos = section("Position");
    rangeField(pos, { id: "fPan", label: "Pan", param: "Pan_x", min: -0.5, max: 0.5, step: 0.01, center: 0, reset: 0,
      format: (v) => (Math.abs(v) < 0.005 ? "C" : (v < 0 ? "L " : "R ") + Math.round(Math.abs(v) * 200)) });
    const dyn = section("Dynamics");
    rangeField(dyn, { id: "fComp", label: "Compressor", param: "Comp", min: 0, max: 10, step: 0.1, reset: 0, format: (v) => v.toFixed(1) });
    rangeField(dyn, { id: "fGate", label: "Gate", param: "Gate", min: 0, max: 10, step: 0.1, reset: 0, format: (v) => v.toFixed(1) });
    // Voicemeeter's input limiter (Banana and Potato): at +12 dB it's off.
    if (ch.data && ch.data.limit != null) {
      rangeField(dyn, { id: "fLimit", label: "Limiter", param: "Limit", min: -40, max: 12, step: 0.5, reset: 12,
        format: (v) => (v >= 12 ? "Off" : fmtDb(v) + " dB") });
    }
    // Potato's gain layers: this input's own level on each output.
    if (ch.data && (ch.data.layers || []).length) {
      const lay = section("Level on each output", "routing");
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = "Give one output its own level, like less game on your stream than in your headphones. The main fader moves them all together and keeps the differences.";
      lay.appendChild(note);
      chans.filter((b) => b.kind === "bus").forEach((b) => {
        const tag = (b.info && b.info.id) || "";
        rangeField(lay, { id: `fLayer${b.i}`, label: tag ? `${tag} ${displayName(b)}` : displayName(b), param: `GainLayer[${b.i}]`,
          min: -60, max: 12, step: 0.5, center: 0, reset: ch.gain || 0, format: (v) => fmtDb(v) });
      });
    }
    if (!isHw(ch)) {
      const eq = section("EQ");
      const f = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1);
      rangeField(eq, { id: "fEq1", label: "Bass", param: "EQGain1", min: -12, max: 12, step: 0.5, center: 0, reset: 0, format: f });
      rangeField(eq, { id: "fEq2", label: "Mid", param: "EQGain2", min: -12, max: 12, step: 0.5, center: 0, reset: 0, format: f });
      rangeField(eq, { id: "fEq3", label: "Treble", param: "EQGain3", min: -12, max: 12, step: 0.5, center: 0, reset: 0, format: f });
    }
  } else {
    const sources = section("Inputs sent to this output", "routing");
    const list = Object.assign(document.createElement("div"), { className: "drawer-sources" });
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", `Inputs sent to ${ch.info.id}`);
    for (const input of chans.filter((c) => c.kind === "strip")) {
      const send = input.toggles.find((t) => t.param === ch.info.param);
      if (!send) continue;
      const b = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: displayName(input) });
      b.dataset.source = input.prefix;
      b.addEventListener("click", () => { send.btn.click(); renderDrawerValues(); });
      list.append(b);
    }
    sources.append(list);
    const modeSec = section("Bus mode");
    const sel = document.createElement("select");
    sel.id = "busMode"; sel.setAttribute("aria-label", "Bus mode");
    for (const [v, label] of BUS_MODES) sel.appendChild(new Option(label, v));
    sel.addEventListener("change", () => sendFloat(`${ch.prefix}.mode.${sel.value}`, 1));
    modeSec.appendChild(sel);
    const plug = section("Plugins");
    const open = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: "Add VST3 plugins to this output…" });
    open.addEventListener("click", () => openInputEffects(ch));
    plug.append(open);
  }
  soundFxSection(ch);
  // With Solo, Mono and EQ hidden from the mixer, they're still here.
  if (settings.hideSoloMono || settings.simpleMode) {
    const btnSec = section("Buttons");
    const row = document.createElement("div");
    row.className = "routes modes drawer-togs";
    const keys = ch.kind === "strip"
      ? [["Solo", "solo", "Solo"], isHw(ch) ? ["Mono", "mono", "Mono"] : ["MC", "mono", "M.C."]]
      : [["Mono", "mono", "Mono"], ["EQ.on", "eq", "EQ"]];
    for (const [param, cls, label] of keys) {
      const b = document.createElement("button");
      b.type = "button"; b.className = `tog ${cls}`; b.dataset.param = param; b.textContent = label;
      b.addEventListener("click", () => {
        const t = ch.toggles.find((x) => x.param === param);
        if (t) { t.btn.click(); renderDrawerValues(); }
      });
      row.appendChild(b);
    }
    btnSec.appendChild(row);
  }
  renderDrawerHead();
  renderDrawerValues();
  selectDrawerTab(drawerTab);
}

// Listening EQ presets and Steadier volume (soundfx.rs): inside Voicemeeter's audio, with no delay.
const SOUND_EQ = [["off", "Off"], ["footsteps", "Footsteps"], ["bass", "Bass boost"], ["voice", "Voice clarity"],
  ["bright", "Brighter"], ["warm", "Warmer"], ["night", "Late night (less bass)"],
  ["pops", "Mic: fewer pops"], ["esses", "Mic: softer S"], ["speech", "Mic: fewer pops, softer S"]];
const SOUND_LEVEL = [["off", "Off"], ["gentle", "Gentle"], ["night", "Night mode"]];
const SOUND_EQ_HINT = {
  footsteps: "Less rumble from explosions, more of the range footsteps and reloads are in.",
  bass: "More low end for music and films.", voice: "Clearer speech: less boom, more presence.",
  bright: "More sparkle in the top end.", warm: "A fuller, softer sound.",
  night: "Takes the bass out, so it doesn't carry through walls.",
  pops: "Takes out the rumble popping p's and b's leave on a mic.",
  esses: "Tames harsh s sounds on a mic.", speech: "Both: less popping and softer s sounds on a mic.",
};
const soundFxOf = (ch) => (settings.soundFx || {})[ch.prefix] || {};
function soundFxSection(ch) {
  const sec = section(ch.kind === "bus" ? "Listening EQ and volume" : "EQ preset and volume");
  const field = (id, label, list, key) => {
    const row = Object.assign(document.createElement("div"), { className: "field wide" });
    const sel = Object.assign(document.createElement("select"), { id });
    for (const [v, n] of list) sel.appendChild(new Option(n, v));
    sel.value = soundFxOf(ch)[key] || "off";
    sel.addEventListener("change", () => {
      const next = { ...soundFxOf(ch), [key]: sel.value };
      settings.soundFx = { ...(settings.soundFx || {}), [ch.prefix]: next };
      if ((next.eq || "off") === "off" && (next.level || "off") === "off") delete settings.soundFx[ch.prefix];
      saveSettings();
      paintSoundFx();
      setTimeout(() => fetchMicFxStatus().then(paintSoundFx), 900);
    });
    row.append(Object.assign(document.createElement("label"), { htmlFor: id, textContent: label }), sel);
    sec.appendChild(row);
  };
  field("sfxEq", "EQ preset", SOUND_EQ, "eq");
  field("sfxLevel", "Steadier volume", SOUND_LEVEL, "level");
  sec.append(Object.assign(document.createElement("p"), { className: "hint", id: "sfxAbout" }),
    Object.assign(document.createElement("p"), { className: "hint obs-status", id: "sfxStatus", role: "status" }));
  paintSoundFx();
  fetchMicFxStatus().then(paintSoundFx);
}
function paintSoundFx() {
  const about = $("#sfxAbout"), status = $("#sfxStatus");
  if (!about || !drawerCh) return;
  const v = soundFxOf(drawerCh), eq = v.eq || "off", level = v.level || "off";
  const parts = [];
  if (eq !== "off") parts.push(SOUND_EQ_HINT[eq] || "");
  if (level === "gentle") parts.push("Gentle evens out big jumps in volume.");
  if (level === "night") parts.push("Night mode brings loud explosions down and quiet dialogue up, so you can keep the volume low.");
  about.textContent = parts.length ? parts.join(" ")
    : `Shape how ${drawerCh.kind === "bus" ? "this output sounds" : "this input sounds everywhere it goes"}. Runs inside Voicemeeter with no added delay while Sleekmeeter is open.`;
  const st = (micFxLast.soundFx || {})[drawerCh.prefix];
  const on = eq !== "off" || level !== "off";
  status.textContent = !on ? "" : st ? (st.running ? "On" : st.message || "Starting…") : connected ? "Starting…" : "Waiting for Voicemeeter";
  status.dataset.ok = st && st.running ? "1" : "";
}

function fillDevices() {
  const sel = $("#deviceSelect");
  if (!sel || !drawerCh) return;
  const ch = drawerCh;
  const current = (ch.data && ch.data.device) || "";
  const list = (ch.kind === "strip" ? deviceCache.inputs : deviceCache.outputs) || [];
  const groups = [["wdm", "WDM (recommended)"], ["ks", "Kernel streaming"], ["mme", "MME"]];
  if (ch.kind === "bus" && ch.i === 0) groups.push(["asio", "ASIO"]);
  sel.textContent = "";
  sel.appendChild(new Option("No device", "wdm|"));
  let picked = !current;
  for (const [type, label] of groups) {
    const items = list.filter((d) => d.type === type);
    if (!items.length) continue;
    const og = document.createElement("optgroup");
    og.label = label;
    for (const d of items) {
      const o = new Option(d.name, `${type}|${d.name}`);
      if (!picked && d.name === current) { o.selected = true; picked = true; }
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  if (!picked) {
    const o = new Option(`${current} (current)`, `wdm|${current}`);
    o.selected = true;
    sel.insertBefore(o, sel.options[1] || null);
  }
}

function renderDrawerValues() {
  const ch = drawerCh, d = ch && ch.data;
  if (!d) return;
  renderDrawerHead();
  const map = { Pan_x: d.pan, Comp: d.comp, Gate: d.gate, EQGain1: (d.eq || [])[0], EQGain2: (d.eq || [])[1], EQGain3: (d.eq || [])[2], Limit: d.limit };
  (d.layers || []).forEach((v, j) => { map[`GainLayer[${j}]`] = v; });
  drawerBody.querySelectorAll("input[type=range]").forEach((inp) => {
    const v = map[inp.dataset.param];
    if (v === undefined || document.activeElement === inp) return;
    inp.value = v;
    inp._paint();
  });
  const mode = $("#busMode");
  if (mode && document.activeElement !== mode) mode.value = d.mode || "normal";
  drawerBody.querySelectorAll(".drawer-sources [data-source]").forEach((b) => {
    const input = chans.find((c) => c.prefix === b.dataset.source);
    const send = input?.toggles.find((t) => t.param === ch.info.param);
    if (!send) return;
    const name = displayName(input);
    if (b.textContent !== name) b.textContent = name;
    b.setAttribute("aria-label", `Send ${name} to ${ch.info.id}`);
    b.setAttribute("aria-pressed", send.btn.getAttribute("aria-pressed"));
  });
  drawerBody.querySelectorAll(".drawer-togs .tog, .drawer-routes .route").forEach((b) => {
    const t = ch.toggles.find((x) => x.param === b.dataset.param);
    if (t) b.setAttribute("aria-pressed", t.btn.getAttribute("aria-pressed"));
  });
}
