//! Settings live in settings.json next to the exe, so Sleekmeeter stays portable
//! (or in %APPDATA%\Sleekmeeter when the exe sits in a read-only folder, like after an MSI install).

use serde_json::{json, Value};
use std::path::PathBuf;

/// Where settings, scenes and logs live. Portable: the exe's own folder. If that folder can't be
/// written to (installed under Program Files by the MSI), %APPDATA%\Sleekmeeter instead.
pub fn app_dir() -> PathBuf {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."));
        if writable(&exe_dir) {
            return exe_dir;
        }
        match std::env::var_os("APPDATA") {
            Some(appdata) => {
                let dir = PathBuf::from(appdata).join("Sleekmeeter");
                let _ = std::fs::create_dir_all(&dir);
                dir
            }
            None => exe_dir,
        }
    })
    .clone()
}

fn writable(dir: &std::path::Path) -> bool {
    let probe = dir.join(".sleekmeeter-write-test");
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
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
        "autoRestart": true,
        // Saved sets of output devices: [{ "name": "Headphones", "auto": false,
        //   "buses": [{ "bus": 0, "type": "wdm", "name": "Headphones (Arctis)" }] }]
        "outputProfiles": [],
        // The tray panel snaps to the screen corner by the clock. Undocked, it can be moved and
        // remembers where you left it: "panelPos": { "x": 1500, "y": 700 } (physical pixels).
        "panelDocked": true,
        "panelPos": null,
        // Push to talk: how long the mic stays open after the keys are let go.
        "hold": { "releaseMs": 250 },
        // Be right back: channels to mute, channels to turn down by `amount` dB, a channel to play.
        "brb": { "mute": [], "lower": [], "amount": 30, "play": "", "playDb": -8, "overlay": true },
        // OBS Studio link: scene rules [{ "obs": "BRB", "do": "brb-on" | "brb-off" | "scene", "scene": "" }],
        // plus what to do when the stream starts (liveDo, liveScene) and ends (offDo, offScene).
        "obs": { "on": false, "host": "127.0.0.1", "port": 4455, "password": "", "rules": [],
                 "liveDo": "", "liveScene": "", "offDo": "", "offScene": "" },
        // Warn when this channel's level goes over 0 dB.
        "clipWarn": { "on": false, "target": "Strip[0]" }
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

/// The chosen theme. Before themes there was only "Pure black for OLED" (`oled`).
pub fn theme(s: &Value) -> String {
    match s["theme"].as_str() {
        Some(t) if !t.is_empty() => t.to_string(),
        _ if flag(s, "oled") => "oled".into(),
        _ => "console".into(),
    }
}

pub fn flag(s: &Value, key: &str) -> bool {
    flag_or(s, key, false)
}

pub fn flag_or(s: &Value, key: &str, default: bool) -> bool {
    s.get(key).and_then(Value::as_bool).unwrap_or(default)
}
