//! Output profiles: a saved set of output devices ("Headphones", "Speakers") you switch between
//! with one click or a shortcut, instead of picking the device for each output by hand.
//!
//! A profile is stored in settings.json as
//! `{ "name": "Headphones", "auto": false, "buses": [{ "bus": 0, "type": "wdm", "name": "Headphones (Arctis)" }] }`.
//! An empty name means "no device on this output". With `auto` on, the profile is applied when
//! one of its devices shows up in Windows (see devwatch.rs).

use crate::devwatch::same_device;
use crate::vm::{Api, Layout};
use crate::{show_osd_text, Settings, Vm};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const TYPES: [&str; 4] = ["wdm", "ks", "mme", "asio"];

/// The profiles in the settings.
pub fn profiles(settings: &Value) -> Vec<Value> {
    settings["outputProfiles"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn entries(profile: &Value) -> Vec<(usize, String, String)> {
    profile["buses"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let bus = e["bus"].as_u64()? as usize;
            let ty = e["type"].as_str().unwrap_or("wdm").to_string();
            let name = e["name"].as_str().unwrap_or("").to_string();
            Some((bus, ty, name))
        })
        .collect()
}

/// Which kind of device (WDM, KS, MME, ASIO) Voicemeeter lists under this name. WDM is preferred.
fn kind_of(devices: &Value, name: &str) -> String {
    let list: Vec<(&str, &str)> = devices["outputs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| Some((d["type"].as_str()?, d["name"].as_str()?)))
        .collect();
    for want in TYPES {
        let exact = list
            .iter()
            .any(|(t, n)| *t == want && n.eq_ignore_ascii_case(name));
        if exact {
            return want.to_string();
        }
    }
    for want in TYPES {
        if list.iter().any(|(t, n)| *t == want && same_device(name, n)) {
            return want.to_string();
        }
    }
    "wdm".to_string()
}

/// The hardware outputs (A1, A2…) as they are right now, ready to save as a profile.
pub fn capture(api: &Api, edition: i32) -> Vec<Value> {
    let layout = Layout::for_edition(edition);
    let devices = api.devices();
    (0..layout.hw_buses)
        .map(|j| {
            let name = api
                .get_string(&format!("Bus[{j}].device.name"))
                .unwrap_or_default();
            let ty = if name.is_empty() {
                "wdm".to_string()
            } else {
                kind_of(&devices, &name)
            };
            json!({ "bus": j, "type": ty, "name": name })
        })
        .collect()
}

/// Put the profile's devices on the outputs. Returns how many outputs changed.
pub fn apply(app: &AppHandle, api: &Api, profile: &Value, because: &str) -> Result<usize, String> {
    let name = profile["name"].as_str().unwrap_or("?");
    let edition = app.state::<Vm>().last.lock().unwrap()["edition"]
        .as_i64()
        .unwrap_or(2) as i32;
    let hw_buses = Layout::for_edition(edition).hw_buses;
    let mut changed = 0;
    let mut failed = Vec::new();
    for (bus, ty, device) in entries(profile) {
        if bus >= hw_buses || !TYPES.contains(&ty.as_str()) {
            continue;
        }
        let current = api
            .get_string(&format!("Bus[{bus}].device.name"))
            .unwrap_or_default();
        // Setting the device it already has would restart that output for nothing.
        let same = if device.is_empty() {
            current.is_empty()
        } else {
            same_device(&device, &current)
        };
        if same {
            continue;
        }
        match api.set_string(&format!("Bus[{bus}].device.{ty}"), &device) {
            Ok(()) => changed += 1,
            Err(e) => failed.push(format!("output {}: {e}", bus + 1)),
        }
    }
    if failed.is_empty() {
        log_info!("Output profile {name:?} applied ({because}); {changed} output(s) changed");
        Ok(changed)
    } else {
        let msg = failed.join("; ");
        log_warn!("Output profile {name:?} ({because}): {msg}");
        Err(format!("Couldn't switch every output: {msg}"))
    }
}

fn find(app: &AppHandle, name: &str) -> Option<Value> {
    let settings = app.state::<Settings>().0.lock().unwrap().clone();
    profiles(&settings)
        .into_iter()
        .find(|p| p["name"].as_str() == Some(name))
}

/// Apply the profile with this name (from the window or a shortcut).
pub fn apply_named(app: &AppHandle, name: &str, because: &str) -> Result<usize, String> {
    let profile = find(app, name).ok_or_else(|| format!("There's no output profile “{name}”"))?;
    let api = app
        .state::<Vm>()
        .api
        .clone()
        .ok_or("Voicemeeter isn't installed")?;
    apply(app, &api, &profile, because)
}

/// Does the snapshot's output devices match the profile?
fn matches(profile: &Value, snap: &Value) -> bool {
    let list = entries(profile);
    !list.is_empty()
        && list.iter().all(|(bus, _, device)| {
            let Some(b) = snap["buses"].get(*bus) else {
                return true; // this edition doesn't have that output
            };
            let current = b["device"].as_str().unwrap_or("");
            if device.is_empty() {
                current.is_empty()
            } else {
                same_device(device, current)
            }
        })
}

/// The profile that matches the outputs right now, if any.
pub fn current(settings: &Value, snap: &Value) -> Option<String> {
    profiles(settings)
        .iter()
        .find(|p| matches(p, snap))
        .and_then(|p| p["name"].as_str().map(String::from))
}

/// Add the active profile's name to a mixer snapshot.
pub fn dress(app: &AppHandle, snap: &mut Value) {
    let active = current(&app.state::<Settings>().0.lock().unwrap(), snap);
    snap["outputProfile"] = json!(active);
}

/// Switch to the next profile (shortcut).
pub fn cycle(app: &AppHandle) {
    let (list, snap) = {
        let s = app.state::<Settings>().0.lock().unwrap().clone();
        (profiles(&s), app.state::<Vm>().last.lock().unwrap().clone())
    };
    if list.is_empty() {
        show_osd_text(app, "Outputs", "No profiles", false, "headphones");
        return;
    }
    let at = list.iter().position(|p| matches(p, &snap));
    let next = &list[at.map(|i| (i + 1) % list.len()).unwrap_or(0)];
    let name = next["name"].as_str().unwrap_or("").to_string();
    switch_with_osd(app, &name, "shortcut");
}

/// Apply a profile and show its name on screen (shortcuts and automatic switching).
pub fn switch_with_osd(app: &AppHandle, name: &str, because: &str) {
    match apply_named(app, name, because) {
        Ok(_) => show_osd_text(app, "Outputs", name, true, "headphones"),
        Err(e) => {
            show_osd_text(app, "Outputs", "Couldn't switch", false, "headphones");
            log_warn!("Switching outputs to {name:?} failed: {e}");
        }
    }
}

/// Devices that profiles with "switch automatically" are waiting for: (profile, device name).
pub fn auto_devices(settings: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for p in profiles(settings) {
        if !p["auto"].as_bool().unwrap_or(false) {
            continue;
        }
        let Some(pname) = p["name"].as_str() else {
            continue;
        };
        for (_, _, device) in entries(&p) {
            if !device.is_empty() {
                out.push((pname.to_string(), device));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> Value {
        json!({ "name": "Headphones", "auto": true, "buses": [
            { "bus": 0, "type": "wdm", "name": "Headphones (Arctis Nova Pro Wireless)" },
            { "bus": 1, "type": "wdm", "name": "" } ] })
    }

    #[test]
    fn matches_the_devices_in_use() {
        let snap = json!({ "buses": [
            { "device": "Headphones (Arctis Nova Pro Wireless)" }, { "device": "" }, { "device": "x" } ] });
        assert!(matches(&profile(), &snap));
        let other = json!({ "buses": [
            { "device": "Speakers (Realtek)" }, { "device": "" } ] });
        assert!(!matches(&profile(), &other));
        let extra = json!({ "buses": [
            { "device": "Headphones (Arctis Nova Pro Wireless)" }, { "device": "Speakers" } ] });
        assert!(
            !matches(&profile(), &extra),
            "an empty output must be empty"
        );
    }

    #[test]
    fn picks_the_active_profile_and_the_auto_devices() {
        let settings = json!({ "outputProfiles": [
            { "name": "Speakers", "buses": [{ "bus": 0, "type": "wdm", "name": "Speakers (Realtek)" }] },
            profile() ] });
        let snap = json!({ "buses": [
            { "device": "Headphones (Arctis Nova Pro Wireless)" }, { "device": "" } ] });
        assert_eq!(current(&settings, &snap).as_deref(), Some("Headphones"));
        assert_eq!(
            auto_devices(&settings),
            vec![(
                "Headphones".to_string(),
                "Headphones (Arctis Nova Pro Wireless)".to_string()
            )]
        );
    }

    #[test]
    fn finds_the_kind_of_device() {
        let devices = json!({ "outputs": [
            { "type": "mme", "name": "Headphones (Arctis Nova Pro Wir" },
            { "type": "ks", "name": "Arctis Nova Pro Wireless" },
            { "type": "wdm", "name": "Headphones (Arctis Nova Pro Wireless)" } ] });
        assert_eq!(
            kind_of(&devices, "Headphones (Arctis Nova Pro Wireless)"),
            "wdm"
        );
        assert_eq!(kind_of(&devices, "Arctis Nova Pro Wireless"), "ks");
        assert_eq!(kind_of(&devices, "Something else"), "wdm");
    }
}
