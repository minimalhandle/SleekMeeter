//! Things Sleekmeeter can do on request, shared by shortcuts, Twitch chat commands and the
//! phone remote: "mute the mic", "be right back", "load a scene", "play a sound".

use crate::{brb, fades, outputs, recorder, settings, show_osd_text, sounds, Settings, Vm};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

fn is_channel(target: &str) -> bool {
    target.starts_with("Strip[") || target.starts_with("Bus[")
}

/// Run one action. `kind` is the same word shortcuts use ("mute", "volup", "brb", ...).
pub fn perform(app: &AppHandle, kind: &str, target: &str) -> Result<(), String> {
    let vm = app.state::<Vm>();
    let api = vm.api.clone();
    let need_api = || {
        api.clone()
            .ok_or_else(|| "Voicemeeter isn't running".to_string())
    };
    match kind {
        "mute" if is_channel(target) => {
            let api = need_api()?;
            fades::toggle_mute(app, &api, target)?;
        }
        "volup" if is_channel(target) => {
            let api = need_api()?;
            fades::nudge(app, &api, target, 2.0)?;
        }
        "voldown" if is_channel(target) => {
            let api = need_api()?;
            fades::nudge(app, &api, target, -2.0)?;
        }
        "route" => {
            // target looks like "Strip[0].B3": switch that input's A or B bus on or off.
            let api = need_api()?;
            let bus = target.rsplit('.').next().unwrap_or("").to_string();
            let mut chars = bus.chars();
            let (kind_ch, num_ch) = (chars.next(), chars.next());
            let valid = target.starts_with("Strip[")
                && chars.next().is_none()
                && matches!(kind_ch, Some('A') | Some('B'))
                && matches!(num_ch, Some('1'..='9'));
            if !valid {
                return Err("Not a bus route".to_string());
            }
            let on = api.get_bool(target);
            fades::set_float(app, &api, target, if on { 0.0 } else { 1.0 })?;
        }
        "window" => crate::toggle_main(app),
        "output" if !target.is_empty() => outputs::switch_with_osd(app, target, "shortcut"),
        "outputnext" => outputs::cycle(app),
        "brb" => {
            if let Err(e) = brb::toggle(app) {
                show_osd_text(app, "Stream mode", "Not set up", false, "mic");
                return Err(e);
            }
        }
        "scene" if !target.is_empty() => crate::load_scene_auto(app, target, "a command"),
        "sound" if !target.is_empty() => sounds::play(app, target)?,
        "soundstop" => sounds::stop_all(),
        "duck" => {
            let on = {
                let st = app.state::<Settings>();
                let mut s = st.0.lock().unwrap();
                let on = !s["ducking"]["on"].as_bool().unwrap_or(false);
                if !s["ducking"].is_object() {
                    s["ducking"] = settings::defaults()["ducking"].clone();
                }
                s["ducking"]["on"] = json!(on);
                log_info!(
                    "Command: talk-over ducking {}",
                    if on { "on" } else { "off" }
                );
                let _ = settings::save(&s);
                let _ = app.emit("settings-changed", s.clone());
                on
            };
            show_osd_text(
                app,
                "Talk-over ducking",
                if on { "On" } else { "Off" },
                on,
                "mic",
            );
        }
        "record" => {
            let api = need_api()?;
            if let Ok(rec) = recorder::toggle_record(app, &api) {
                let text = if rec { "Recording" } else { "Stopped" };
                show_osd_text(app, "Recorder", text, rec, "record");
            }
        }
        _ => return Err(format!("Unknown action {kind:?}")),
    }
    Ok(())
}
