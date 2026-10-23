//! Stream mode: "Be right back".
//!
//! One press (the BRB button, a shortcut, or an OBS scene) does what you set up in Settings:
//! mutes the channels you choose (your mic), turns others down (the game), and brings up a
//! channel to play (music). Press again and everything goes back exactly how it was. All of it
//! fades, so nothing cuts off.

use crate::{fades, show_osd_text, Settings, Vm};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// A channel as it was before Be right back changed it.
struct Saved {
    key: String,
    gain: f32,
    mute: bool,
}

#[derive(Default)]
pub struct Brb {
    /// Some while Be right back is on: what to put back.
    saved: Option<Vec<Saved>>,
}

struct Config {
    mute: Vec<String>,
    lower: Vec<String>,
    amount: f32,
    play: String,
    play_db: f32,
    overlay: bool,
}

fn names(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str())
        .filter(|k| k.starts_with("Strip[") || k.starts_with("Bus["))
        .map(String::from)
        .collect()
}

fn config(s: &Value) -> Config {
    let b = &s["brb"];
    Config {
        mute: names(&b["mute"]),
        lower: names(&b["lower"]),
        amount: b["amount"].as_f64().unwrap_or(30.0).clamp(3.0, 60.0) as f32,
        play: b["play"].as_str().unwrap_or("").to_string(),
        play_db: b["playDb"].as_f64().unwrap_or(-8.0).clamp(-60.0, 12.0) as f32,
        overlay: b["overlay"].as_bool().unwrap_or(true),
    }
}

/// (gain, muted) of "Strip[2]" or "Bus[0]" in a mixer snapshot.
fn state_of(snap: &Value, key: &str) -> Option<(f32, bool)> {
    let (list, rest) = if let Some(r) = key.strip_prefix("Strip[") {
        ("strips", r)
    } else if let Some(r) = key.strip_prefix("Bus[") {
        ("buses", r)
    } else {
        return None;
    };
    let i: usize = rest.strip_suffix(']')?.parse().ok()?;
    let ch = snap[list].as_array()?.get(i)?;
    Some((
        ch["gain"].as_f64()? as f32,
        ch["mute"].as_bool().unwrap_or(false),
    ))
}

pub fn is_on(app: &AppHandle) -> bool {
    app.state::<Vm>().brb.lock().unwrap().saved.is_some()
}

/// Add "brb": true to a mixer snapshot while Be right back is on.
pub fn dress(app: &AppHandle, snap: &mut Value) {
    snap["brb"] = json!(is_on(app));
}

/// Turn Be right back on or off. Returns whether it is on now.
pub fn toggle(app: &AppHandle) -> Result<bool, String> {
    let vm = app.state::<Vm>();
    let api = vm.api.clone().ok_or("Voicemeeter isn't running")?;
    let saved = vm.brb.lock().unwrap().saved.take();
    if let Some(list) = saved {
        for s in &list {
            if let Err(e) = fades::glide(app, &api, &s.key, s.gain) {
                log_warn!("Be right back: couldn't restore {}: {e}", s.key);
            }
            if let Err(e) = fades::mute(app, &api, &s.key, s.mute) {
                log_warn!("Be right back: couldn't restore mute on {}: {e}", s.key);
            }
        }
        log_info!("Be right back: off");
        let overlay = config(&app.state::<Settings>().0.lock().unwrap()).overlay;
        if overlay {
            show_osd_text(app, "Stream mode", "Back live", false, "mic");
        }
        let _ = app.emit("brb-changed", json!({ "active": false }));
        return Ok(false);
    }

    let cfg = config(&app.state::<Settings>().0.lock().unwrap());
    let snap = vm.last.lock().unwrap().clone();
    if !snap["connected"].as_bool().unwrap_or(false) {
        return Err("Voicemeeter isn't connected".into());
    }
    let mut keys: Vec<String> = Vec::new();
    for k in cfg
        .mute
        .iter()
        .chain(cfg.lower.iter())
        .chain(std::iter::once(&cfg.play))
    {
        if !k.is_empty() && !keys.contains(k) {
            keys.push(k.clone());
        }
    }
    if keys.is_empty() {
        return Err("Choose what Be right back does in Settings → Stream mode".into());
    }
    let saved: Vec<Saved> = keys
        .iter()
        .filter_map(|k| {
            state_of(&snap, k).map(|(gain, mute)| Saved {
                key: k.clone(),
                gain,
                mute,
            })
        })
        .collect();

    for k in &cfg.lower {
        if let Some((gain, _)) = state_of(&snap, k) {
            if let Err(e) = fades::glide(app, &api, k, (gain - cfg.amount).max(-60.0)) {
                log_warn!("Be right back: couldn't turn {k} down: {e}");
            }
        }
    }
    if !cfg.play.is_empty() {
        let _ = fades::mute(app, &api, &cfg.play, false);
        if let Err(e) = fades::glide(app, &api, &cfg.play, cfg.play_db) {
            log_warn!("Be right back: couldn't bring up {}: {e}", cfg.play);
        }
    }
    for k in &cfg.mute {
        if let Err(e) = fades::mute(app, &api, k, true) {
            log_warn!("Be right back: couldn't mute {k}: {e}");
        }
    }
    vm.brb.lock().unwrap().saved = Some(saved);
    log_info!("Be right back: on");
    if cfg.overlay {
        show_osd_text(app, "Stream mode", "Be right back", true, "mic");
    }
    let _ = app.emit("brb-changed", json!({ "active": true }));
    Ok(true)
}

/// Turn it on or off only if it isn't already (used by OBS scene rules).
pub fn set(app: &AppHandle, want: bool) {
    if is_on(app) != want {
        if let Err(e) = toggle(app) {
            log_warn!("Be right back: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_channel_state_from_a_snapshot() {
        let snap = json!({
            "strips": [{ "gain": -3.5, "mute": false }, { "gain": 0.0, "mute": true }],
            "buses": [{ "gain": -12.0 }]
        });
        assert_eq!(state_of(&snap, "Strip[1]"), Some((0.0, true)));
        assert_eq!(state_of(&snap, "Bus[0]"), Some((-12.0, false)));
        assert_eq!(state_of(&snap, "Strip[7]"), None);
        assert_eq!(state_of(&snap, "Nonsense"), None);
    }

    #[test]
    fn config_ignores_things_that_arent_channels() {
        let s = json!({ "brb": { "mute": ["Strip[0]", "x"], "lower": ["Bus[1]"], "amount": 500 } });
        let c = config(&s);
        assert_eq!(c.mute, vec!["Strip[0]".to_string()]);
        assert_eq!(c.lower, vec!["Bus[1]".to_string()]);
        assert_eq!(c.amount, 60.0);
        assert!(c.overlay);
    }
}
