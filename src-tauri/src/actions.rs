//! Things Sleekmeeter can do on request, shared by shortcuts, Twitch chat commands and the
//! Sleekmeeter Remote: "mute the mic", "be right back", "load a scene", "play a sound".

use crate::{
    brb, fades, outputs, partmute, recorder, replay, settings, show_osd_text, sounds, watch,
    Settings, Vm,
};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

fn is_channel(target: &str) -> bool {
    target.starts_with("Strip[") || target.starts_with("Bus[")
}

/// "Strip[0].B3": one input's route to one A or B bus.
fn is_route(target: &str) -> bool {
    let Some((strip, bus)) = target.rsplit_once('.') else {
        return false;
    };
    let mut chars = bus.chars();
    let (kind_ch, num_ch) = (chars.next(), chars.next());
    strip.starts_with("Strip[")
        && is_channel(strip)
        && chars.next().is_none()
        && matches!(kind_ch, Some('A') | Some('B'))
        && matches!(num_ch, Some('1'..='9'))
}

/// "Strip[0].B2|Strip[3].B2": two different routes to swap between.
fn swap_pair(target: &str) -> Result<(&str, &str), String> {
    match target.split_once('|') {
        Some((a, b)) if is_route(a) && is_route(b) && a != b => Ok((a, b)),
        _ => Err("Pick two different routes to swap between".to_string()),
    }
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
            if !is_route(target) {
                return Err("Not a bus route".to_string());
            }
            let on = api.get_bool(target);
            fades::set_float(app, &api, target, if on { 0.0 } else { 1.0 })?;
        }
        "routeswap" => {
            // target looks like "Strip[0].B2|Strip[3].B2": one press turns the first on and
            // the second off, the next press the other way round, for example which mic goes
            // to B2. Read from Voicemeeter, so changes made elsewhere are followed.
            let api = need_api()?;
            let (first, second) = swap_pair(target)?;
            let to_second = api.get_bool(first) && !api.get_bool(second);
            let (on, off) = if to_second {
                (second, first)
            } else {
                (first, second)
            };
            // Off first: never both on for a moment (no doubled mic or echo).
            fades::set_float(app, &api, off, 0.0)?;
            fades::set_float(app, &api, on, 1.0)?;
            log_info!("Command: route swap to {on}");
        }
        "partmute" => {
            // target looks like "Strip[0]:B1,B2,B3": mute that input on those outputs only,
            // or unmute it there if it's muted on any of them.
            let api = need_api()?;
            let (i, outs) =
                partmute::parse_target(target).ok_or("Choose an input and its outputs")?;
            partmute::toggle(app, &api, i, &outs)?;
        }
        "chatgame" | "chatchat" | "chatcentre" => {
            let (amount, relative) = match kind {
                "chatgame" => (-10, true),
                "chatchat" => (10, true),
                _ => (0, false),
            };
            crate::chat_balance::change(app, None, amount, relative, false)?;
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
        // Save the last seconds of the stream output (instant replay).
        "replay" => {
            if !replay::status()["running"].as_bool().unwrap_or(false) {
                show_osd_text(app, "Instant replay", "Not on", false, "record");
                return Err("Instant replay isn't running (Settings → Instant replay)".into());
            }
            let app = app.clone();
            // Writing a minute of audio takes a moment: don't hold up the shortcut or chat.
            std::thread::spawn(move || {
                if let Err(e) = replay::save(&app) {
                    log_warn!("Instant replay: {e}");
                }
            });
        }
        // Music off stream, now, until OBS next starts or stops.
        "musicguard" => {
            watch::toggle_guard(app)?;
        }
        // A mic's clean-up and plugins off or back on ("Strip[0]"; "" = every mic).
        "micfx" => {
            crate::micfx::toggle(app, target)?;
        }
        _ => return Err(format!("Unknown action {kind:?}")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_swaps_need_two_different_routes() {
        assert_eq!(
            swap_pair("Strip[0].B2|Strip[3].B2"),
            Ok(("Strip[0].B2", "Strip[3].B2"))
        );
        assert!(swap_pair("Strip[2].A1|Strip[2].A2").is_ok());
        assert!(swap_pair("Strip[0].B2|Strip[0].B2").is_err());
        assert!(swap_pair("Strip[0].B2").is_err());
        assert!(swap_pair("Bus[0].B2|Strip[0].B2").is_err());
        assert!(swap_pair("Strip[0].Gain|Strip[1].B1").is_err());
    }
}
