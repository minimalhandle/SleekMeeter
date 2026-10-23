//! "Check my setup": a list of things that commonly go wrong, each with a plain explanation.

use crate::{devwatch, obs, Hotkeys, Settings, Vm};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn item(state: &str, label: &str, detail: &str) -> Value {
    json!({ "state": state, "label": label, "detail": detail })
}

/// Run every check. `ok`, `warn` or `bad` for each.
pub fn run(app: &AppHandle) -> Vec<Value> {
    let mut out = Vec::new();
    let vm = app.state::<Vm>();
    let snap = vm.last.lock().unwrap().clone();
    let settings = app.state::<Settings>().0.lock().unwrap().clone();

    // Voicemeeter's remote library and the program itself
    if vm.api.is_none() {
        out.push(item(
            "bad",
            "Voicemeeter's remote library",
            "Sleekmeeter couldn't load Voicemeeter's remote library (VoicemeeterRemote64.dll). Voicemeeter Banana or Potato needs to be installed, then restart Sleekmeeter.",
        ));
    } else if snap["connected"].as_bool().unwrap_or(false) {
        out.push(item("ok", "Voicemeeter", "Running and connected."));
    } else if snap["installed"].as_bool() == Some(false) {
        out.push(item(
            "bad",
            "Voicemeeter",
            "Voicemeeter doesn't seem to be installed. Install Voicemeeter Banana or Potato from vb-audio.com.",
        ));
    } else {
        out.push(item(
            "warn",
            "Voicemeeter",
            "Voicemeeter isn't running. Start it, or turn on \"Start Voicemeeter if it isn't running\" in Settings → Startup.",
        ));
    }

    // Devices Voicemeeter uses that Windows doesn't see
    let assigned = devwatch::assigned_devices(app);
    if assigned.is_empty() {
        out.push(item(
            "ok",
            "Audio devices",
            "Nothing to check until Voicemeeter is running with devices chosen.",
        ));
    } else {
        let system = devwatch::system_devices();
        if system.is_empty() {
            out.push(item(
                "warn",
                "Audio devices",
                "Couldn't read Windows' device list.",
            ));
        } else {
            let missing: Vec<&String> = assigned
                .iter()
                .filter(|d| !system.iter().any(|s| devwatch::same_device(d, s)))
                .collect();
            if missing.is_empty() {
                out.push(item(
                    "ok",
                    "Audio devices",
                    &format!(
                        "All {} devices Voicemeeter uses are connected.",
                        assigned.len()
                    ),
                ));
            } else {
                let names: Vec<String> = missing.iter().map(|d| d.to_string()).collect();
                out.push(item(
                    "warn",
                    "Audio devices",
                    &format!(
                        "Windows doesn't list: {}. Plug it in or switch it on; Sleekmeeter restarts the audio engine when it returns.",
                        names.join(", ")
                    ),
                ));
            }
        }
    }

    // Shortcuts that couldn't be registered
    let wanted = settings["hotkeys"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|h| {
                    h["keys"]
                        .as_str()
                        .map(|k| !k.trim().is_empty())
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0);
    let working = app.state::<Hotkeys>().0.lock().unwrap().len();
    if wanted == working {
        out.push(item(
            "ok",
            "Shortcuts",
            &format!(
                "{working} shortcut{} working.",
                if working == 1 { "" } else { "s" }
            ),
        ));
    } else {
        out.push(item(
            "warn",
            "Shortcuts",
            &format!(
                "{} of {wanted} shortcuts couldn't be registered, usually because another app uses the same keys. Settings → Shortcuts lists them.",
                wanted - working.min(wanted)
            ),
        ));
    }

    // OBS
    if settings["obs"]["on"].as_bool().unwrap_or(false) {
        let st = obs::status();
        if st["connected"].as_bool().unwrap_or(false) {
            out.push(item("ok", "OBS link", "Connected to OBS."));
        } else {
            out.push(item(
                "warn",
                "OBS link",
                st["message"].as_str().unwrap_or("Not connected"),
            ));
        }
    }

    // Can settings, scenes and logs be saved next to the program?
    let dir = crate::settings::app_dir();
    let probe = dir.join(".sleekmeeter-write-test");
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            out.push(item("ok", "Saving settings", "Settings, scenes and logs can be saved."));
        }
        Err(e) => out.push(item(
            "bad",
            "Saving settings",
            &format!(
                "Sleekmeeter can't write to its own folder ({}): {e}. Move it somewhere you can write, like Documents or the desktop, instead of Program Files.",
                dir.display()
            ),
        )),
    }
    out
}
