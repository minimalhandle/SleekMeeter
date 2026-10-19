/* Volume overlay: shows which channel changed and its level. */
(function () {
  "use strict";
  // Same taper as the mixer faders so the bar matches fader position.
  const TAPER = [[-60, 0], [-40, 0.17], [-20, 0.44], [-10, 0.64], [0, 0.84], [12, 1]];
  function dbToPos(db) {
    if (!(db > -60)) return 0;
    if (db >= 12) return 1;
    for (let i = 1; i < TAPER.length; i++) {
      const [d1, p1] = TAPER[i], [d0, p0] = TAPER[i - 1];
      if (db <= d1) return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
    }
    return 1;
  }
  const fmt = (db) => (db <= -60 ? "−∞ dB" : (db > 0.04 ? "+" : db < -0.04 ? "−" : "") + Math.abs(db).toFixed(1) + " dB");
  function show(p) {
    const card = document.getElementById("card");
    card.dataset.color = p.color || "slate";
    card.classList.toggle("muted", !!p.mute);
    document.getElementById("chip").innerHTML = window.SleekIcons.svg(p.icon || "wave", 22);
    document.getElementById("name").textContent = p.name || "";
    document.getElementById("value").textContent = p.mute ? "Muted" : fmt(+p.gain || 0);
    document.getElementById("fill").style.transform = `scaleX(${dbToPos(+p.gain || 0).toFixed(3)})`;
    document.body.classList.toggle("oled", !!p.oled);
    card.style.animation = "none"; void card.offsetWidth; card.style.animation = "";
  }
  window.showOsd = show;
  if (window.__TAURI__) window.__TAURI__.event.listen("osd", (e) => show(e.payload));
  else show({ name: "Mic", gain: -4.5, mute: false, color: "amber", icon: "mic" });
})();
