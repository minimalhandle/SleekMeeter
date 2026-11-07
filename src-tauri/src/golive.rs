//! Go-live check: a short list to look at before (or right as) you start streaming. Is the mic
//! on and sent to the stream, does the stream output have sound, is OBS linked, and so on.
//!
//! The Go live button in the header runs it, and with Settings → Going live → "Run the go-live
//! check when I start streaming" it runs by itself a few seconds after OBS goes live: anything
//! wrong shows on the overlay and the list opens in the mixer.

use crate::vm::Layout;
use crate::watch::{bus_param, name_of, since_sound, stream_bus, strip_index};
use crate::{brb, obs, replay, show_osd_alert, twitch, watch, winout, Settings, Vm};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

fn item(state: &str, label: &str, detail: &str) -> Value {
    json!({ "state": state, "label": label, "detail": detail })
}

/// An item with a button that sets one Voicemeeter parameter (like "Strip[0].Mute" = 0).
fn fixable(state: &str, label: &str, detail: &str, button: &str, param: &str, value: f32) -> Value {
    json!({ "state": state, "label": label, "detail": detail,
            "action": "set", "button": button, "param": param, "value": value })
}

fn on(v: &Value) -> bool {
    v.as_bool()
        .unwrap_or_else(|| v.as_f64().map(|x| x != 0.0).unwrap_or(false))
}

fn ago(secs: f64) -> String {
    let s = secs.round() as u64;
    if s < 120 {
        format!("{s} seconds")
    } else if s < 7200 {
        format!("{} minutes", s / 60)
    } else {
        format!("{} hours", s / 3600)
    }
}

/// Run every check: `ok`, `warn` or `bad` for each.
pub fn run(app: &AppHandle) -> Vec<Value> {
    let snap = app.state::<Vm>().last.lock().unwrap().clone();
    let s = app.state::<Settings>().0.lock().unwrap().clone();
    let mut out = Vec::new();
    if !snap["connected"].as_bool().unwrap_or(false) {
        out.push(item(
            "bad",
            "Voicemeeter",
            "Voicemeeter isn't running, so nothing reaches your stream.",
        ));
        return out;
    }
    let layout = Layout::for_edition(snap["edition"].as_i64().unwrap_or(2) as i32);
    let mic_key = s["mutedTalk"]["target"].as_str().unwrap_or("Strip[0]");
    let mic = strip_index(mic_key)
        .filter(|i| *i < layout.strips())
        .unwrap_or(0);
    let mic_name = name_of(&snap, "strips", mic, "Your mic");
    let strip = &snap["strips"][mic];
    let bus = stream_bus(&s, &layout);
    let bus_name = bus
        .map(|j| {
            let p = bus_param(&layout, j);
            let label = name_of(&snap, "buses", j, "");
            if label.is_empty() {
                p
            } else {
                format!("{label} ({p})")
            }
        })
        .unwrap_or_else(|| "the stream output".into());

    // The mic
    if brb::is_on(app) {
        out.push(item(
            "warn",
            "Mic",
            "Be right back is on, so your mic is muted. Press Back live when you're ready.",
        ));
    } else if on(&strip["mute"]) {
        out.push(fixable(
            "bad",
            "Mic",
            &format!("{mic_name} is muted."),
            "Unmute",
            &format!("Strip[{mic}].Mute"),
            0.0,
        ));
    } else {
        out.push(item("ok", "Mic", &format!("{mic_name} is on.")));
    }

    // The mic reaches the stream, and the stream output isn't muted or turned right down
    if let Some(j) = bus {
        let p = bus_param(&layout, j);
        let k = if j < layout.hw_buses {
            j
        } else {
            j - layout.hw_buses
        };
        let sent = on(&strip[if j < layout.hw_buses { "a" } else { "b" }][k]);
        if sent {
            out.push(item(
                "ok",
                "Mic on stream",
                &format!("{mic_name} goes to {bus_name}."),
            ));
        } else {
            out.push(fixable(
                "bad",
                "Mic on stream",
                &format!("{mic_name} isn't sent to {bus_name}, so viewers won't hear you."),
                &format!("Send it to {p}"),
                &format!("Strip[{mic}].{p}"),
                1.0,
            ));
        }
        let b = &snap["buses"][j];
        let gain = b["gain"].as_f64().unwrap_or(0.0);
        if on(&b["mute"]) {
            out.push(fixable(
                "bad",
                "Stream output",
                &format!("{bus_name} is muted, so your stream gets no sound."),
                "Unmute",
                &format!("Bus[{j}].Mute"),
                0.0,
            ));
        } else if gain <= -20.0 {
            out.push(item(
                "warn",
                "Stream output",
                &format!(
                    "{bus_name} is turned down to {gain:.0} dB, so your stream will be quiet."
                ),
            ));
        } else {
            out.push(item("ok", "Stream output", &format!("{bus_name} is on.")));
        }
        match since_sound() {
            Some(t) if t < 10.0 => out.push(item(
                "ok",
                "Sound on stream",
                &format!("Sound is reaching {bus_name}."),
            )),
            Some(t) => out.push(item(
                "warn",
                "Sound on stream",
                &format!(
                    "{bus_name} has been silent for {}. Say something, or check that your game and music are sent to {p}.",
                    ago(t)
                ),
            )),
            None => out.push(item(
                "warn",
                "Sound on stream",
                &format!("{bus_name} hasn't had any sound since Sleekmeeter started."),
            )),
        }
    } else {
        out.push(item(
            "warn",
            "Stream output",
            "Choose which output your stream gets in Settings → Going live.",
        ));
    }

    // Music off stream
    let g = &s["musicGuard"];
    if g["on"].as_bool().unwrap_or(false) {
        match g["strip"].as_str().and_then(strip_index) {
            Some(i) if i < layout.strips() => {
                let when = match g["when"].as_str().unwrap_or("either") {
                    "recording" => "while OBS records",
                    "live" => "while you're live",
                    "manual" => "when you press its key",
                    _ => "while you're live or recording",
                };
                let now = if watch::guard_active(app) {
                    " It's off the stream now."
                } else {
                    ""
                };
                out.push(item(
                    "ok",
                    "Music off stream",
                    &format!(
                        "{} is kept off the stream {when}.{now}",
                        name_of(&snap, "strips", i, "Music")
                    ),
                ));
            }
            _ => out.push(item(
                "warn",
                "Music off stream",
                "Choose your music channel in Settings → Going live.",
            )),
        }
    }

    // OBS
    let o = obs::status();
    if s["obs"]["on"].as_bool().unwrap_or(false) {
        if o["connected"].as_bool().unwrap_or(false) {
            let what = if o["live"].as_bool().unwrap_or(false) {
                "Connected, and you're live."
            } else {
                "Connected."
            };
            out.push(item("ok", "OBS", what));
        } else {
            out.push(item(
                "bad",
                "OBS",
                &format!(
                    "Not connected: {}.",
                    o["message"]
                        .as_str()
                        .unwrap_or("OBS isn't answering")
                        .trim_end_matches('.')
                ),
            ));
        }
    } else {
        out.push(item(
            "warn",
            "OBS",
            "Not linked, so Sleekmeeter can't tell when you go live. Turn it on in Settings → OBS Studio.",
        ));
    }

    // Windows' sound output
    let w = winout::status(app);
    match w["state"].as_str() {
        Some("wrong") => out.push(json!({
            "state": "bad", "label": "Windows sound output",
            "detail": format!(
                "Windows sends sound to {}, not Voicemeeter, so those apps skip the mixer.",
                w["output"].as_str().unwrap_or("another device")
            ),
            "action": "fixAudio",
        })),
        Some("ok") => out.push(item(
            "ok",
            "Windows sound output",
            "Windows plays through Voicemeeter.",
        )),
        _ => {}
    }

    // Twitch chat and the instant replay, when they're used
    if s["twitch"]["on"].as_bool().unwrap_or(false) {
        let t = twitch::status();
        if t["connected"].as_bool().unwrap_or(false) {
            out.push(item(
                "ok",
                "Twitch chat",
                t["message"].as_str().unwrap_or("Connected"),
            ));
        } else {
            out.push(item(
                "warn",
                "Twitch chat",
                &format!(
                    "Not connected: {}. Chat commands and channel point sounds won't work.",
                    t["message"]
                        .as_str()
                        .unwrap_or("not connected")
                        .trim_end_matches('.')
                ),
            ));
        }
    }
    if s["replay"]["on"].as_bool().unwrap_or(false) {
        let r = replay::status();
        let state = if r["running"].as_bool().unwrap_or(false) {
            "ok"
        } else {
            "warn"
        };
        out.push(item(
            state,
            "Instant replay",
            r["message"].as_str().unwrap_or(""),
        ));
    }
    out
}

/// OBS just went live: run the check a few seconds later (so the stream output has had time to
/// get sound) and speak up if something's wrong.
pub fn on_live(app: &AppHandle) {
    let wanted = app.state::<Settings>().0.lock().unwrap()["goLive"]["onLive"]
        .as_bool()
        .unwrap_or(true);
    if !wanted {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        let items = run(&app);
        let problems = items.iter().filter(|i| i["state"] != json!("ok")).count();
        log_info!("Go-live check: {problems} thing(s) to look at");
        if problems == 0 {
            return;
        }
        let text = if problems == 1 {
            "1 thing to check".to_string()
        } else {
            format!("{problems} things to check")
        };
        show_osd_alert(&app, "Go-live check", &text, "stream");
        let _ = app.emit_to("main", "golive", json!({ "items": items }));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_read_naturally() {
        assert_eq!(ago(42.0), "42 seconds");
        assert_eq!(ago(600.0), "10 minutes");
        assert_eq!(ago(10800.0), "3 hours");
    }

    #[test]
    fn routes_read_as_on_or_off() {
        assert!(on(&json!(1)));
        assert!(on(&json!(true)));
        assert!(!on(&json!(0)));
        assert!(!on(&Value::Null));
    }
}
