/* Sleekmeeter mixer UI, part 7 of 14: Output profiles and output fallbacks.
   The parts load in order from index.html as plain scripts sharing one global scope (see
   src/app/README.md), so anything declared at the top of one part is visible in the others. */
"use strict";

/* ---------- output profiles ---------- */
// A profile is a saved set of output devices ("Headphones", "Speakers"). The app applies it
// and, with "Auto", applies it when one of its devices connects.
const outputsDlg = $("#outputsDlg"), outputsBtn = $("#outputsBtn"), profileUl = $("#profileList");
let activeProfile = null;
const profiles = () => (settings.outputProfiles || (settings.outputProfiles = []));
function fallbackChains() {
  if (!settings.outputFallbacks || typeof settings.outputFallbacks !== "object" || Array.isArray(settings.outputFallbacks)) settings.outputFallbacks = {};
  return settings.outputFallbacks;
}
function fallbackLinks() {
  if (!settings.outputFallbackLinks || typeof settings.outputFallbackLinks !== "object" || Array.isArray(settings.outputFallbackLinks)) settings.outputFallbackLinks = {};
  return settings.outputFallbackLinks;
}
let fallbackDevices = [], fallbackStatusRequest = 0;
const outputReasons = new Map(), outputDeviceRows = new Map(), fallbackRequests = new Map();
const hasFallback = (i) => !!fallbackChains()[fallbackLinks()[i] ?? i]?.length;
function readFallbackReason(i) {
  if (!hasFallback(i)) return Promise.resolve("No fallback policy configured");
  if (fallbackRequests.has(i)) return fallbackRequests.get(i);
  const request = engine.fallbackStatus(i).catch((e) => String(e)).finally(() => fallbackRequests.delete(i));
  fallbackRequests.set(i, request);
  return request;
}
function paintOutputDevices() {
  if (!outputsDlg.open) return;
  const list = $("#outputDevices"), hardware = chans.filter((c) => c.kind === "bus" && isHw(c));
  for (const [i, row] of outputDeviceRows) if (!hardware.some((c) => c.i === i)) { row.el.remove(); outputDeviceRows.delete(i); }
  for (const bus of hardware) {
    if (!outputDeviceRows.has(bus.i)) {
      const el = document.createElement("li"), content = document.createElement("div");
      const device = document.createElement("strong"), reason = document.createElement("span");
      const edit = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: "Fallbacks…" });
      edit.setAttribute("aria-label", `Manage fallbacks for ${bus.info.id}`);
      edit.addEventListener("click", () => openOutputFallback(bus.i));
      content.append(device, reason);
      el.append(content, edit);
      list.append(el);
      outputDeviceRows.set(bus.i, { el, device, reason });
    }
    const row = outputDeviceRows.get(bus.i);
    const device = `${bus.info.id} · ${!connected ? "Voicemeeter disconnected" : bus.data?.device || "No playback device"}`;
    const reason = !connected ? "" : hasFallback(bus.i) ? outputReasons.get(bus.i) || "Checking fallback policy…" : "No fallback policy configured";
    if (row.device.textContent !== device) row.device.textContent = device;
    if (row.reason.textContent !== reason) row.reason.textContent = reason;
  }
}
async function refreshOutputReasons() {
  if (!outputsDlg.open || !connected) return;
  const current = chans.filter((c) => c.kind === "bus" && isHw(c) && hasFallback(c.i));
  await Promise.all(current.map(async (c) => outputReasons.set(c.i, await readFallbackReason(c.i))));
  paintOutputDevices();
}
async function refreshFallbackStatus() {
  const bus = $("#fallbackBus").value;
  if (!outputsDlg.open || !$("#fallbackFold").open || bus === "") return;
  const request = ++fallbackStatusRequest;
  const result = await readFallbackReason(+bus);
  if (request === fallbackStatusRequest) $("#fallbackStatus").textContent = result;
}
function renderFallbackList() {
  const bus = $("#fallbackBus").value;
  const links = fallbackLinks(), linked = links[bus];
  const entries = fallbackChains()[linked ?? bus] || [];
  const source = $("#fallbackSource"), previous = source.value;
  const sources = [...$("#fallbackBus").options].filter((o) => o.value !== bus && links[o.value] == null && fallbackChains()[o.value]?.length);
  source.replaceChildren(new Option(linked == null ? "Use a policy from…" : `Linked to ${$("#fallbackBus").options[+linked]?.textContent || `A${+linked + 1}`}`, ""),
    ...sources.map((o) => new Option(o.textContent, o.value)));
  if (sources.some((o) => o.value === previous) && linked == null) source.value = previous;
  source.disabled = linked != null || !sources.length;
  $("#fallbackDevice").disabled = linked != null;
  $("#fallbackAdd").disabled = linked != null || bus === "" || !fallbackDevices.length;
  $("#fallbackUnlink").hidden = linked == null;
  paintFallbackActions();
  const list = $("#fallbackList");
  list.replaceChildren();
  entries.forEach((device, i) => {
    const item = Object.assign(document.createElement("li"), { textContent: `${device.name} (${device.type.toUpperCase()}) ` });
    const action = (label, disabled, change) => {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: label, disabled });
      b.setAttribute("aria-label", `${label} ${device.name}`);
      b.addEventListener("click", () => { change(); saveFallback(); });
      return b;
    };
    const move = (j) => { [entries[i], entries[j]] = [entries[j], entries[i]]; };
    if (linked == null) item.append(action("↑", !i, () => move(i - 1)), action("↓", i === entries.length - 1, () => move(i + 1)), action("Remove", false, () => {
      entries.splice(i, 1);
      if (!entries.length) delete fallbackChains()[bus];
    }));
    list.append(item);
  });
}
function paintFallbackActions() {
  const bus = $("#fallbackBus").value, source = $("#fallbackSource").value;
  const blocked = bus === "" || source === "" || fallbackLinks()[bus] != null;
  $("#fallbackCopy").disabled = blocked;
  const hasDependants = Object.values(fallbackLinks()).includes(bus);
  $("#fallbackLink").disabled = blocked || hasDependants;
  $("#fallbackLink").title = hasDependants ? "Other outputs already share this output’s policy" : "";
}
async function saveFallback() {
  renderFallbackList();
  await saveNow();
  outputReasons.clear();
  paintOutputDevices();
  refreshOutputReasons();
  refreshFallbackStatus();
}
async function loadFallbackEditor() {
  const bus = $("#fallbackBus"), device = $("#fallbackDevice");
  const previous = bus.value;
  bus.replaceChildren(...chans.filter((c) => c.kind === "bus" && c.info.kind === "hw")
    .map((c) => new Option(`${c.info.id} · ${displayName(c)}`, String(c.i))));
  if ([...bus.options].some((o) => o.value === previous)) bus.value = previous;
  fallbackDevices = [];
  renderFallbackList();
  refreshFallbackStatus();
  $("#fallbackAdd").disabled = true;
  device.replaceChildren(new Option("Loading playback devices…", ""));
  try {
    const found = await engine.devices();
    fallbackDevices = (found.outputs || []).filter((d) => ["wdm", "ks", "mme"].includes(d.type));
    device.replaceChildren(new Option("Choose a playback device", ""), ...fallbackDevices.map((d, i) => new Option(`${d.name} (${d.type.toUpperCase()})`, String(i))));
    renderFallbackList();
  } catch (e) { device.replaceChildren(new Option("Playback devices unavailable", "")); fail(e); }
}
$("#fallbackBus").addEventListener("change", () => { renderFallbackList(); refreshFallbackStatus(); });
$("#fallbackSource").addEventListener("change", paintFallbackActions);
$("#fallbackFold").addEventListener("toggle", refreshFallbackStatus);
for (const [id, link] of [["fallbackCopy", false], ["fallbackLink", true]]) {
  $(`#${id}`).addEventListener("click", () => {
    const bus = $("#fallbackBus").value, source = $("#fallbackSource").value;
    if (bus === "" || !fallbackChains()[source]?.length || fallbackLinks()[bus] != null) return;
    if (fallbackChains()[bus]?.length && !window.confirm("Replace this output’s current fallback policy?")) return;
    if (link) {
      if (Object.values(fallbackLinks()).includes(bus)) return;
      fallbackLinks()[bus] = source;
      delete fallbackChains()[bus];
    } else fallbackChains()[bus] = clone(fallbackChains()[source]);
    saveFallback();
  });
}
$("#fallbackUnlink").addEventListener("click", () => {
  const bus = $("#fallbackBus").value, source = fallbackLinks()[bus];
  if (source == null) return;
  fallbackChains()[bus] = clone(fallbackChains()[source] || []);
  delete fallbackLinks()[bus];
  saveFallback();
});
$("#fallbackAdd").addEventListener("click", () => {
  const bus = $("#fallbackBus").value, selected = $("#fallbackDevice").value;
  const device = selected === "" ? null : fallbackDevices[Number(selected)];
  if (bus === "" || !device || fallbackLinks()[bus] != null) return;
  const entries = fallbackChains()[bus] || (fallbackChains()[bus] = []);
  if (entries.some((d) => d.name === device.name)) return;
  entries.push({ name: device.name, type: device.type });
  saveFallback();
});
function profileSummary(p) {
  return p.buses.map((e) => {
    const b = layout && layout.buses[e.bus];
    return `${b ? b.id : "A" + (e.bus + 1)} ${e.name || "none"}`;
  }).join("   ·   ");
}
function applyOutputs(st) {
  activeProfile = st.outputProfile || null;
  outputsBtn.dataset.live = activeProfile ? "1" : "";
  outputsBtn.title = activeProfile ? `Outputs: ${activeProfile}` : "Switch between saved output devices";
  if (outputsDlg.open) { markProfiles(); paintOutputDevices(); }
}
function markProfiles() {
  profileUl.querySelectorAll("li[data-name]").forEach((li) => li.classList.toggle("live", li.dataset.name === activeProfile));
}
async function applyProfile(name) {
  try {
    await saveNow();
    await engine.outputsApply(name);
    toast(`Switched outputs to “${name}”`);
  } catch (e) { fail(e); }
}
function renderProfiles() {
  profileUl.textContent = "";
  const list = profiles();
  $("#profileNote").hidden = !list.length;
  $("#profileNote").textContent = "Switching only changes the devices on your outputs. Levels, routing and everything else stay as they are. “Auto” switches to a setup by itself when one of its devices connects, like turning on your headset.";
  if (!list.length) {
    profileUl.appendChild(Object.assign(document.createElement("li"), { className: "empty", textContent: "Nothing saved yet. Pick the devices for your outputs, then name this setup below to save it." }));
    return;
  }
  for (const p of list) {
    const li = document.createElement("li");
    li.dataset.name = p.name;
    const load = document.createElement("button");
    load.type = "button"; load.className = "load";
    const nm = Object.assign(document.createElement("span"), { className: "pf-name", textContent: p.name });
    const dev = Object.assign(document.createElement("span"), { className: "pf-devices", textContent: profileSummary(p) });
    dev.title = profileSummary(p);
    const live = Object.assign(document.createElement("span"), { className: "pf-live", textContent: "In use" });
    load.append(nm, dev, live);
    load.addEventListener("click", () => applyProfile(p.name));
    const auto = document.createElement("button");
    auto.type = "button"; auto.className = "tog auto-pf"; auto.textContent = "Auto";
    auto.title = "Switch to this setup automatically when one of its devices connects";
    auto.setAttribute("aria-pressed", String(!!p.auto));
    auto.addEventListener("click", () => {
      p.auto = !p.auto;
      auto.setAttribute("aria-pressed", String(p.auto));
      saveSettings();
    });
    const del = Object.assign(document.createElement("button"), { type: "button", className: "btn del", textContent: "Delete" });
    del.setAttribute("aria-label", `Delete ${p.name}`);
    let armed = false;
    del.addEventListener("click", () => {
      if (!armed) { armed = true; del.textContent = "Confirm"; setTimeout(() => { armed = false; del.textContent = "Delete"; }, 3000); return; }
      const at = profiles().indexOf(p);
      if (at >= 0) profiles().splice(at, 1);
      saveSettings();
      renderProfiles();
      toast(`Deleted “${p.name}”`);
    });
    li.append(load, auto, del);
    profileUl.appendChild(li);
  }
  markProfiles();
}
$("#profileSave").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#profileName").value.trim().slice(0, 40);
  if (!name) return;
  try {
    const buses = await engine.outputsCapture();
    if (!buses.some((b) => b.name)) { toast("None of your outputs has a device yet"); return; }
    const list = profiles();
    const at = list.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    const entry = { name: at >= 0 ? list[at].name : name, auto: at >= 0 ? !!list[at].auto : false, buses };
    if (at >= 0) list[at] = entry; else list.push(entry);
    $("#profileName").value = "";
    await saveNow();
    renderProfiles();
    toast(at >= 0 ? `Updated “${entry.name}”` : `Saved “${entry.name}”`);
  } catch (err) { fail(err); }
});
let fallbackTimer;
outputsBtn.addEventListener("click", () => {
  renderProfiles(); outputsDlg.showModal(); loadFallbackEditor();
  paintOutputDevices(); refreshOutputReasons();
  clearInterval(fallbackTimer);
  fallbackTimer = setInterval(() => { refreshOutputReasons(); refreshFallbackStatus(); }, 3000);
});
outputsDlg.addEventListener("close", () => clearInterval(fallbackTimer));
function openOutputFallback(i) {
  if (!outputsDlg.open) outputsBtn.click();
  const select = $("#fallbackBus");
  if (i != null && [...select.options].some((o) => o.value === String(i))) select.value = String(i);
  const fold = $("#fallbackFold");
  fold.open = true;
  renderFallbackList();
  refreshFallbackStatus();
  $("summary", fold).focus();
  fold.scrollIntoView({ block: "nearest" });
}
$("#settingsFallback").addEventListener("click", () => {
  settingsDlg.close(); openOutputFallback();
});
outputsDlg.addEventListener("click", (e) => { if (e.target === outputsDlg) outputsDlg.close(); });
