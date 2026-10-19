//! Settings live in settings.json next to the exe, so Sleekmeeter stays portable.

use serde_json::{json, Value};
use std::path::PathBuf;

pub fn app_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn path() -> PathBuf {
    app_dir().join("settings.json")
}

pub fn defaults() -> Value {
    json!({
        // Per strip/bus look: { "strip-0": { "color": "amber", "icon": "mic", "hidden": false }, "bus-3": {...} }
        "appearance": {},
        "hotkeys": [
            { "keys": "Ctrl+Alt+M", "action": "mute", "target": "Strip[0]" },
            { "keys": "Ctrl+Alt+Up", "action": "volup", "target": "Bus[0]" },
            { "keys": "Ctrl+Alt+Down", "action": "voldown", "target": "Bus[0]" },
            { "keys": "Ctrl+Alt+S", "action": "window", "target": "" }
        ],
        "startWithWindows": false,
        "startInTray": true,
        "launchVoicemeeter": true,
        "hideVoicemeeter": false,
        "overlay": true,
        "alwaysOnTop": false,
        "mini": false,
        // Load a scene when an app starts: [{ "app": "obs64.exe", "scene": "Streaming", "restore": "Default" }]
        "sceneRules": [],
        "checkUpdates": true,
        "oled": false,
        "skippedVersion": "",
        // Mutes fade out and in; typed levels, shortcuts and scenes glide.
        "fades": { "on": true, "muteMs": 250, "sceneMs": 1200 },
        // Talk-over ducking: while `trigger` is above `threshold` dB, lower `targets` by `amount` dB.
        "ducking": {
            "on": false, "trigger": "Strip[0]", "targets": [], "amount": 12, "threshold": -40,
            "attackMs": 150, "releaseMs": 800, "holdMs": 700
        },
        // Restart Voicemeeter's audio engine when a device it uses comes back.
        "autoRestart": true
    })
}

/// Saved settings laid over the defaults, so new options get sensible values.
pub fn load() -> Value {
    let mut s = defaults();
    if let Ok(text) = std::fs::read_to_string(path()) {
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(saved)) => {
                if let Value::Object(base) = &mut s {
                    for (k, v) in saved {
                        base.insert(k, v);
                    }
                }
            }
            Ok(_) => log_warn!("settings.json isn't a settings object; using the defaults"),
            Err(e) => log_warn!("settings.json couldn't be read ({e}); using the defaults"),
        }
    }
    s
}

pub fn save(s: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(path(), text).map_err(|e| {
        log_error!("Couldn't save settings to {}: {e}", path().display());
        format!("Couldn't save settings: {e}")
    })
}

pub fn flag(s: &Value, key: &str) -> bool {
    flag_or(s, key, false)
}

pub fn flag_or(s: &Value, key: &str, default: bool) -> bool {
    s.get(key).and_then(Value::as_bool).unwrap_or(default)
}
