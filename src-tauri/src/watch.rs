//! Things Sleekmeeter keeps an eye on while you stream (Settings → Going live):
//! - talking into a muted mic: "You're muted" on the overlay;
//! - the stream output going silent, or clipping, while you're live;
//! - Music off stream: while OBS records or streams, the music channel's send to the stream
//!   output is switched off (your headphones still hear it), and put back afterwards.
//!
//! It also remembers when the stream output last had sound, for the go-live check.
//! Runs on the poll thread (it reads meters), ten times a second.

use crate::vm::{Api, Layout};
use crate::{brb, fades, obs, settings, show_osd_alert, show_osd_text, Settings, Vm};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const EVERY: Duration = Duration::from_millis(100);
/// Quieter than this counts as silence on the stream output.
const SILENT_DB: f32 = -60.0;
/// Louder than this counts as clipping.
const CLIP_DB: f32 = -0.3;
/// Muted talk: how many of the last `TALK_WINDOW` readings (100 ms each) must be loud.
const TALK_WINDOW: usize = 12;
const TALK_LOUD: usize = 7;
/// Don't repeat the same warning more often than this.
const TALK_AGAIN: Duration = Duration::from_secs(8);
const SILENT_AGAIN: Duration = Duration::from_secs(60);
const CLIP_AGAIN: Duration = Duration::from_secs(15);
/// After switching music off the stream, give a fade time to finish before reading it back.
const GUARD_SETTLE: Duration = Duration::from_secs(3);

#[derive(Default)]
struct Watch {
    last_run: Option<Instant>,
    /// Muted talk: the latest readings, true = loud.
    talk: VecDeque<bool>,
    talk_alert: Option<Instant>,
    /// The stream output: last time it had sound, since when it's been quiet.
    sound_at: Option<Instant>,
    quiet_since: Option<Instant>,
    live_since: Option<Instant>,
    silent_alert: Option<Instant>,
    clip_run: u32,
    clip_alert: Option<Instant>,
    /// Music off stream: the last automatic decision, a key press that overrides it until
    /// the next change, and when Sleekmeeter last switched the route.
    guard_auto: Option<bool>,
    manual: Option<bool>,
    guard_at: Option<Instant>,
}

static W: Mutex<Option<Watch>> = Mutex::new(None);

fn index(key: &str, prefix: &str) -> Option<usize> {
    key.strip_prefix(prefix)?.strip_suffix(']')?.parse().ok()
}

pub fn strip_index(key: &str) -> Option<usize> {
    index(key, "Strip[")
}

/// "A1" … "B3" for bus number `j`, as Voicemeeter names an input's route to it.
pub fn bus_param(layout: &Layout, j: usize) -> String {
    if j < layout.hw_buses {
        format!("A{}", j + 1)
    } else {
        format!("B{}", j - layout.hw_buses + 1)
    }
}

/// The output the stream gets: Settings → `streamBus`, else B2 (B on Voicemeeter Standard).
pub fn stream_bus(s: &Value, layout: &Layout) -> Option<usize> {
    if let Some(j) = s["streamBus"].as_str().and_then(|k| index(k, "Bus[")) {
        if j < layout.buses() {
            return Some(j);
        }
    }
    let j = layout.hw_buses + usize::from(layout.virt_buses >= 2);
    (j < layout.buses()).then_some(j)
}

/// What a channel is called in the mixer (its label), or `fallback`.
pub fn name_of(snap: &Value, list: &str, i: usize, fallback: &str) -> String {
    snap[list][i]["label"]
        .as_str()
        .filter(|l| !l.trim().is_empty())
        .map(String::from)
        .unwrap_or_else(|| fallback.to_string())
}

/// Seconds since the stream output last had sound (None: not since Sleekmeeter started).
pub fn since_sound() -> Option<f64> {
    W.lock()
        .unwrap()
        .as_ref()
        .and_then(|w| w.sound_at)
        .map(|t| t.elapsed().as_secs_f64())
}

struct Cfg {
    talk_on: bool,
    talk_strip: Option<usize>,
    talk_db: f32,
    /// The mic is closed by a push-to-talk shortcut and `ptt` isn't ticked: don't warn.
    talk_skip_ptt: bool,
    bus: Option<usize>,
    watch_on: bool,
    silent: Duration,
    clip: bool,
    only_live: bool,
    guard_on: bool,
    guard_strip: Option<usize>,
    guard_when: String,
}

fn cfg(app: &AppHandle, layout: &Layout) -> Cfg {
    let state = app.state::<Settings>();
    let s = state.0.lock().unwrap();
    let t = &s["mutedTalk"];
    let target = t["target"].as_str().unwrap_or("Strip[0]");
    let under_ptt = s["hotkeys"]
        .as_array()
        .map(|l| {
            l.iter()
                .any(|h| h["action"] == json!("ptt") && h["target"].as_str() == Some(target))
        })
        .unwrap_or(false);
    let w = &s["streamWatch"];
    let g = &s["musicGuard"];
    let c = Cfg {
        talk_on: t["on"].as_bool().unwrap_or(true),
        talk_strip: strip_index(target),
        talk_db: t["threshold"].as_f64().unwrap_or(-35.0).clamp(-70.0, 0.0) as f32,
        talk_skip_ptt: under_ptt && !t["ptt"].as_bool().unwrap_or(false),
        bus: stream_bus(&s, layout),
        watch_on: w["on"].as_bool().unwrap_or(false),
        silent: Duration::from_secs(w["silentSecs"].as_u64().unwrap_or(15).clamp(3, 600)),
        clip: w["clip"].as_bool().unwrap_or(true),
        only_live: w["onlyLive"].as_bool().unwrap_or(true),
        guard_on: g["on"].as_bool().unwrap_or(false),
        guard_strip: g["strip"].as_str().and_then(strip_index),
        guard_when: g["when"].as_str().unwrap_or("either").to_string(),
    };
    c
}

/// Show a warning on the overlay and in the mixer, and note it in the log.
fn alert(app: &AppHandle, kind: &str, name: &str, text: &str, icon: &str) {
    log_info!("Warning: {name}: {text}");
    show_osd_alert(app, name, text, icon);
    let _ = app.emit(
        "watch-alert",
        json!({ "kind": kind, "name": name, "text": text }),
    );
}

/// Called on every poll tick while Voicemeeter is connected (poll thread only).
pub fn tick(app: &AppHandle, api: &Arc<Api>, layout: &Layout) {
    let now = Instant::now();
    let mut guard = W.lock().unwrap();
    let w = guard.get_or_insert_with(Watch::default);
    if w.last_run.map(|t| now - t < EVERY).unwrap_or(false) {
        return;
    }
    w.last_run = Some(now);
    let c = cfg(app, layout);
    let snap = app.state::<Vm>().last.lock().unwrap().clone();
    let o = obs::status();
    let (live, recording) = (
        o["live"].as_bool().unwrap_or(false),
        o["recording"].as_bool().unwrap_or(false),
    );
    muted_talk(app, api, layout, &c, &snap, w, now);
    stream_output(app, api, &c, &snap, w, live, now);
    music_guard(app, api, layout, &c, &snap, w, live, recording, now);
}

fn muted_talk(
    app: &AppHandle,
    api: &Api,
    layout: &Layout,
    c: &Cfg,
    snap: &Value,
    w: &mut Watch,
    now: Instant,
) {
    let Some(i) = c.talk_strip.filter(|i| c.talk_on && *i < layout.strips()) else {
        w.talk.clear();
        return;
    };
    let muted = snap["strips"][i]["mute"].as_bool().unwrap_or(false);
    // Be right back mutes the mic on purpose; so does push to talk while the key is up.
    if !muted || c.talk_skip_ptt || brb::is_on(app) {
        w.talk.clear();
        return;
    }
    w.talk.push_back(api.strip_level_pre(layout, i) > c.talk_db);
    while w.talk.len() > TALK_WINDOW {
        w.talk.pop_front();
    }
    let loud = w.talk.iter().filter(|x| **x).count();
    let due = w.talk_alert.map(|t| now - t >= TALK_AGAIN).unwrap_or(true);
    if loud >= TALK_LOUD && due {
        w.talk_alert = Some(now);
        let name = name_of(snap, "strips", i, "Your mic");
        alert(app, "mutedTalk", &name, "You're muted", "mic");
    }
}

fn stream_output(
    app: &AppHandle,
    api: &Api,
    c: &Cfg,
    snap: &Value,
    w: &mut Watch,
    live: bool,
    now: Instant,
) {
    if live && w.live_since.is_none() {
        w.live_since = Some(now);
    } else if !live {
        w.live_since = None;
    }
    let Some(j) = c.bus else { return };
    let level = api.bus_level(j);
    if level > SILENT_DB {
        w.sound_at = Some(now);
        w.quiet_since = None;
        w.silent_alert = None;
    } else if w.quiet_since.is_none() {
        w.quiet_since = Some(now);
    }
    if !c.watch_on || (c.only_live && !live) {
        w.clip_run = 0;
        return;
    }
    let name = name_of(snap, "buses", j, "Stream");
    // Quiet since before going live counts from when you went live.
    if let Some(q) = w.quiet_since {
        let from = match w.live_since {
            Some(l) if c.only_live && l > q => l,
            _ => q,
        };
        let due = w
            .silent_alert
            .map(|t| now - t >= SILENT_AGAIN)
            .unwrap_or(true);
        if now - from >= c.silent && due {
            w.silent_alert = Some(now);
            alert(app, "silent", &name, "Your stream is silent", "stream");
        }
    }
    if c.clip {
        w.clip_run = if level >= CLIP_DB { w.clip_run + 1 } else { 0 };
        let due = w.clip_alert.map(|t| now - t >= CLIP_AGAIN).unwrap_or(true);
        if w.clip_run >= 3 && due {
            w.clip_alert = Some(now);
            alert(app, "clip", &name, "Your stream is clipping", "stream");
        }
    }
}

/* ---------------- Music off stream ---------------- */

/// The routes Music off stream switched off ("Strip[4].B2"), kept in settings.json so a
/// restart in the middle still puts them back.
fn engaged(app: &AppHandle) -> Vec<String> {
    let state = app.state::<Settings>();
    let s = state.0.lock().unwrap();
    let list = s["musicGuardEngaged"]
        .as_array()
        .map(|l| {
            l.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    list
}

fn set_engaged(app: &AppHandle, routes: &[String]) {
    let state = app.state::<Settings>();
    let mut s = state.0.lock().unwrap();
    s["musicGuardEngaged"] = json!(routes);
    let _ = settings::save(&s);
}

/// Whether Music off stream has the music off the stream right now.
pub fn guard_active(app: &AppHandle) -> bool {
    !engaged(app).is_empty()
}

/// Add "musicGuard": true to a mixer snapshot while music is kept off the stream.
pub fn dress(app: &AppHandle, snap: &mut Value) {
    snap["musicGuard"] = json!(guard_active(app));
}

/// "Strip[4].B2" → (4, "B2").
fn split_route(route: &str) -> Option<(usize, String)> {
    let (strip, out) = route.rsplit_once('.')?;
    Some((strip_index(strip)?, out.to_string()))
}

fn release(app: &AppHandle, api: &Arc<Api>, routes: &[String]) {
    for r in routes {
        if let Some((i, out)) = split_route(r) {
            if let Err(e) = fades::route_mute(app, api, i, &out, false) {
                log_warn!("Music off stream: couldn't put {r} back: {e}");
            }
        }
    }
    set_engaged(app, &[]);
    log_info!("Music off stream: music is back on the stream");
    show_osd_text(app, "Music", "Back on stream", true, "music");
}

#[allow(clippy::too_many_arguments)]
fn music_guard(
    app: &AppHandle,
    api: &Arc<Api>,
    layout: &Layout,
    c: &Cfg,
    snap: &Value,
    w: &mut Watch,
    live: bool,
    recording: bool,
    now: Instant,
) {
    let auto = match c.guard_when.as_str() {
        "recording" => recording,
        "live" => live,
        "manual" => false,
        _ => recording || live,
    };
    if w.guard_auto != Some(auto) {
        w.guard_auto = Some(auto);
        w.manual = None; // a key press only lasts until OBS starts or stops
    }
    let route = match (c.guard_strip, c.bus) {
        (Some(i), Some(j)) if i < layout.strips() => Some((
            i,
            bus_param(layout, j),
            format!("Strip[{i}].{}", bus_param(layout, j)),
        )),
        _ => None,
    };
    let want = c.guard_on && route.is_some() && w.manual.unwrap_or(auto);
    let on = engaged(app);
    let settled = w.guard_at.map(|t| now - t >= GUARD_SETTLE).unwrap_or(true);
    // Switched off, or now about another channel or output: put back what was switched off.
    let stale = route.as_ref().map(|r| !on.contains(&r.2)).unwrap_or(true);
    if !on.is_empty() && (!want || stale) {
        w.guard_at = Some(now);
        release(app, api, &on);
        return;
    }
    let Some((i, out, key)) = route else { return };
    if want && on.is_empty() {
        // Already not sent to the stream: nothing to switch off.
        if !api.get_bool(&key) {
            return;
        }
        match fades::route_mute(app, api, i, &out, true) {
            Ok(()) => {
                w.guard_at = Some(now);
                set_engaged(app, std::slice::from_ref(&key));
                log_info!("Music off stream: {key} off");
                let name = name_of(snap, "strips", i, "Music");
                show_osd_text(app, &name, "Off stream", false, "music");
            }
            Err(e) => log_warn!("Music off stream: couldn't switch {key} off: {e}"),
        }
    } else if !on.is_empty() && settled && api.get_bool(&key) {
        // Someone sent it to the stream again (Voicemeeter, a scene, the A/B button): leave
        // it that way until OBS next starts or stops.
        log_info!("Music off stream: {key} was turned back on by hand");
        set_engaged(app, &[]);
        w.manual = Some(false);
    }
}

/// The Music off stream key: switch it now, until OBS next starts or stops.
/// Returns whether the music is off the stream afterwards.
pub fn toggle_guard(app: &AppHandle) -> Result<bool, String> {
    let ready = {
        let state = app.state::<Settings>();
        let s = state.0.lock().unwrap();
        let g = &s["musicGuard"];
        g["on"].as_bool().unwrap_or(false) && g["strip"].as_str().and_then(strip_index).is_some()
    };
    if !ready {
        show_osd_text(app, "Music off stream", "Not set up", false, "music");
        return Err("Choose your music channel in Settings → Going live first".into());
    }
    let want = !guard_active(app);
    let mut guard = W.lock().unwrap();
    let w = guard.get_or_insert_with(Watch::default);
    w.manual = Some(want);
    // Act on the next tick straight away.
    w.last_run = None;
    Ok(want)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stream_output_defaults_to_b2() {
        let banana = Layout::for_edition(2);
        let potato = Layout::for_edition(3);
        let standard = Layout::for_edition(1);
        let none = json!({ "streamBus": "" });
        assert_eq!(stream_bus(&none, &banana), Some(4));
        assert_eq!(bus_param(&banana, 4), "B2");
        assert_eq!(stream_bus(&none, &potato), Some(6));
        assert_eq!(bus_param(&potato, 6), "B2");
        assert_eq!(stream_bus(&none, &standard), Some(1));
        assert_eq!(bus_param(&standard, 1), "B1");
        assert_eq!(
            stream_bus(&json!({ "streamBus": "Bus[7]" }), &potato),
            Some(7)
        );
        // An output this edition doesn't have falls back to B2.
        assert_eq!(
            stream_bus(&json!({ "streamBus": "Bus[7]" }), &banana),
            Some(4)
        );
    }

    #[test]
    fn routes_split_into_input_and_output() {
        assert_eq!(split_route("Strip[4].B2"), Some((4, "B2".to_string())));
        assert_eq!(split_route("Bus[0].B2"), None);
    }
}
