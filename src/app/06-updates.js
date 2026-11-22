/* Sleekmeeter mixer UI, part 6 of 14: Update notifications, the Stream Deck plugin offer and What's new.
   The parts load in order from index.html as plain scripts sharing one global scope (see
   src/app/README.md), so anything declared at the top of one part is visible in the others. */
"use strict";

/* ---------- update notifications ---------- */
let update = null;
const updateBtn = $("#updateBtn"), updateMenu = $("#updateMenu");
// `asked`: from the Check for updates button. Then it runs even with automatic checks off,
// offers a version that was skipped, and returns what it found.
async function checkForUpdate(asked = false) {
  if (SIDE || (!asked && !settings.checkUpdates)) return null;
  try {
    const u = await engine.checkUpdate();
    if (!u || !u.newer || (!asked && u.latest === settings.skippedVersion)) return u;
    update = u;
    updateBtn.textContent = `Update to ${u.latest}`;
    $("#updateText").textContent = `Sleekmeeter ${u.latest} is out. You have ${u.current}.`;
    updateNow.hidden = u.canInstall === false;
    $("#updateWrap").hidden = false;
    return u;
  } catch (e) {
    // Offline or GitHub unreachable: the next check tries again.
    if (asked) throw e;
    return null;
  }
}
// Sleekmeeter often runs for days, so look again every 6 hours, not only at start.
if (!SIDE) setInterval(() => checkForUpdate(), 6 * 60 * 60 * 1000);
$("#checkUpdateNow").addEventListener("click", async (e) => {
  const btn = e.currentTarget, status = $("#updateStatus");
  btn.disabled = true;
  status.textContent = "Checking…";
  try {
    const u = await checkForUpdate(true);
    status.textContent = u && u.newer
      ? `Sleekmeeter ${u.latest} is out. Use the Update button at the top of the window.`
      : `You have the newest version${u && u.current ? ` (${u.current})` : ""}.`;
  } catch (err) {
    // Rust explains what went wrong (offline, GitHub's hourly limit, ...).
    const msg = typeof err === "string" ? err : err && err.message;
    status.textContent = msg || "Couldn't reach GitHub. Check your internet connection and try again.";
  }
  btn.disabled = false;
});
const setUpdateMenu = (open) => { updateMenu.hidden = !open; updateBtn.setAttribute("aria-expanded", String(open)); };
updateBtn.addEventListener("click", () => setUpdateMenu(updateMenu.hidden));
document.addEventListener("click", (e) => { if (!e.target.closest("#updateWrap")) setUpdateMenu(false); });
let updating = false;
const updateNow = $("#updateNow");
engine.onUpdateProgress((p) => {
  if (updating) updateBtn.textContent = p.percent >= 100 ? "Restarting…" : `Downloading ${p.percent}%`;
});
updateNow.addEventListener("click", async () => {
  setUpdateMenu(false);
  if (!update || updating) return;
  updating = true;
  updateBtn.disabled = true;
  updateBtn.textContent = "Downloading 0%";
  try {
    await engine.updateInstall();
    toast("Restarting to finish the update");
  } catch (err) {
    updating = false;
    updateBtn.disabled = false;
    updateBtn.textContent = `Update to ${update.latest}`;
    fail(err);
  }
});
$("#updateGet").addEventListener("click", () => {
  setUpdateMenu(false);
  if (update) engine.openRelease(update.url).then(() => toast("Opening the download page")).catch(fail);
});
$("#updateSkip").addEventListener("click", () => {
  setUpdateMenu(false);
  if (!update) return;
  settings.skippedVersion = update.latest;
  saveSettings();
  $("#updateWrap").hidden = true;
  toast(`You won't be reminded about ${update.latest}`);
});
/* ---------- Stream Deck plugin offer ---------- */
const streamDeckDlg = $("#streamDeckDlg");
let streamDeck = null;
const streamDeckCopy = {
  install: { go: "Install plugin", title: "Add Sleekmeeter to your Stream Deck",
    text: () => "The Stream Deck app is on this PC. The Sleekmeeter plugin controls your mixer from its keys and dials. The Stream Deck app will open to finish installing." },
  update: { go: "Update plugin", title: "Update the Stream Deck plugin",
    text: (s) => `This Sleekmeeter includes plugin ${s.bundledVersion}. You have ${s.installedVersion}. The Stream Deck app will open to finish updating, and your keys and dials stay as they are.` },
  getApp: { go: "Open Elgato's download page", title: "Your Stream Deck needs its app",
    text: () => "A Stream Deck has been connected to this PC, but Elgato's Stream Deck app isn't installed. Install the app first, then Sleekmeeter can add its plugin." },
};
async function runStreamDeckOffer() {
  if (!streamDeck || !streamDeck.offer) return;
  try {
    if (streamDeck.offer === "getApp") {
      await engine.streamDeckGetApp();
      toast("Opening Elgato's download page");
    } else {
      await engine.streamDeckInstall();
      toast("Finish in the Stream Deck app, then turn on Settings → Sleekmeeter Remote");
    }
  } catch (err) { fail(err); }
}
function paintStreamDeck() {
  const s = streamDeck, action = $("#streamDeckAction");
  const copy = streamDeckCopy[s?.offer];
  $("#streamDeckNote").textContent = copy ? copy.text(s) : s?.installedVersion
    ? `Plugin ${s.installedVersion} is installed. Connect it with the address from Sleekmeeter Remote.`
    : "Use Sleekmeeter actions on a Stream Deck with the Studio plugin.";
  action.hidden = !copy;
  if (copy) action.textContent = copy.go;
}
async function refreshStreamDeck() {
  try { streamDeck = await engine.streamDeckStatus(); } catch { streamDeck = null; }
  paintStreamDeck();
}
// Asks once per plugin version. Settings keeps the same action for anyone who said not now.
async function offerStreamDeck() {
  if (SIDE) return;
  await refreshStreamDeck();
  const copy = streamDeck && streamDeckCopy[streamDeck.offer];
  if (!copy || document.querySelector("dialog[open]")) return;
  const key = `${streamDeck.offer}:${streamDeck.bundledVersion}`;
  if (settings.streamDeckOffered === key) return;
  settings.streamDeckOffered = key;
  saveSettings();
  $("#streamDeckTitle").textContent = copy.title;
  $("#streamDeckText").textContent = copy.text(streamDeck);
  $("#streamDeckGo").textContent = copy.go;
  streamDeckDlg.showModal();
}
/* ---------- What's new: the release notes, once after an update ---------- */
const whatsNewDlg = $("#whatsNewDlg");
// The changelog's own markup, kept to what it uses: **bold** and `code`. Escaped first.
function noteHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>");
}
function fillWhatsNew(info) {
  const body = $("#whatsNewBody");
  body.textContent = "";
  for (const sec of info.sections) {
    const h = document.createElement("h3");
    h.textContent = sec.title;
    body.appendChild(h);
    let ul = null;
    for (const b of sec.blocks || []) {
      if (b.kind === "li") {
        if (!ul) { ul = document.createElement("ul"); body.appendChild(ul); }
        const li = document.createElement("li"); li.innerHTML = noteHtml(b.text); ul.appendChild(li);
      } else {
        ul = null;
        const el = document.createElement(b.kind === "h" ? "h4" : "p");
        el.innerHTML = noteHtml(b.text);
        body.appendChild(el);
      }
    }
  }
  $("#whatsNewTitle").textContent = `What's new in Sleekmeeter ${info.version}`;
}
// Resolves once it's been read (or straight away when there's nothing new), so the other
// first-start questions, such as updating the Stream Deck plugin, still get their turn.
async function offerWhatsNew() {
  if (SIDE) return;
  let info = null;
  try { info = await engine.whatsNew(false); } catch (_) { return; }
  if (!info || !info.sections || !info.sections.length || document.querySelector("dialog[open]")) return;
  fillWhatsNew(info);
  whatsNewDlg.showModal();
  await new Promise((done) => whatsNewDlg.addEventListener("close", done, { once: true }));
}
$("#whatsNewOk").addEventListener("click", () => whatsNewDlg.close());
$("#whatsNewAll").addEventListener("click", () => engine.openRelease("https://github.com/minimalhandle/SleekMeeter/blob/main/CHANGELOG.md").catch(() => {}));
$("#whatsNewBtn").addEventListener("click", async () => {
  try {
    const info = await engine.whatsNew(true);
    if (!info || !info.sections.length) { toast("No release notes in this version"); return; }
    fillWhatsNew(info);
    whatsNewDlg.showModal();
  } catch (e) { toast(`Couldn't show the release notes: ${e}`); }
});
// Asked once, after any other first-run question; until then nothing is sent.
const usageDlg = $("#usageDlg");
function offerUsage() {
  if (engine.simulated || SIDE || typeof settings.usagePing === "boolean" || document.querySelector("dialog[open]")) return;
  usageDlg.showModal();
}
const answerUsage = (yes) => { settings.usagePing = yes; saveSettings(); usageDlg.close(); if (yes) toast("Thanks! You can turn this off in Settings → Privacy"); };
$("#usageYes").addEventListener("click", () => answerUsage(true));
$("#usageNo").addEventListener("click", () => answerUsage(false));
$("#streamDeckGo").addEventListener("click", () => { streamDeckDlg.close(); runStreamDeckOffer(); });
$("#streamDeckLater").addEventListener("click", () => streamDeckDlg.close());
$("#streamDeckAction").addEventListener("click", runStreamDeckOffer);
$("#streamDeckProfile").addEventListener("click", async () => {
  try { if (await engine.streamDeckProfileSave()) toast("Stream Deck + profile saved"); }
  catch (e) { fail(e); }
});
$("#scenePartial").addEventListener("change", () => { $("#sceneScope").hidden = !$("#scenePartial").checked; });
$("#sceneSave").addEventListener("submit", async (e) => {
  e.preventDefault();
  const n = $("#sceneName").value.trim().replace(/[\\/:*?"<>|]/g, "");
  if (!n) return;
  const scope = $("#scenePartial").checked ? {
    channels: [...$("#sceneChannels").querySelectorAll("input:checked")].map((c) => c.value),
    levels: $("#sceneLevels").checked, mutes: $("#sceneMutes").checked,
    routes: $("#sceneRoutes").checked, micProcessing: $("#sceneMics").checked
  } : null;
  if (scope && (!scope.channels.length || ![scope.levels, scope.mutes, scope.routes, scope.micProcessing].some(Boolean))) { toast("Select at least one channel and control."); return; }
  try { await engine.saveScene(n, scope); $("#sceneName").value = ""; setScene(n); toast(`Saved “${n}”`); renderScenes(); } catch (err) { fail(err); }
});
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
