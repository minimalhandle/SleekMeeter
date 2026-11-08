//! Bring audio back when a device comes back.
//!
//! Voicemeeter often doesn't pick a device up again after it was unplugged or switched off
//! (USB or Bluetooth headphones, a dock), and the fix is "Restart audio engine". Sleekmeeter
//! watches the devices Voicemeeter is set to use; when one of them returns to Windows, it
//! waits a moment for Windows to finish setting it up and restarts the engine for you.

use crate::{outputs, settings, Settings, Vm};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Time between checks.
const EVERY: Duration = Duration::from_millis(1500);
/// Give Windows this long to finish setting up a device that just arrived.
const SETTLE: Duration = Duration::from_millis(2500);
/// Never restart more often than this.
const COOLDOWN: Duration = Duration::from_secs(10);

#[derive(Default)]
struct FallbackWatch {
    candidate: Option<(String, String, Instant)>,
    attempted: Option<Instant>,
}

fn effective_fallbacks(s: &Value) -> Value {
    let mut chains = s["outputFallbacks"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    if let Some(links) = s["outputFallbackLinks"].as_object() {
        for (target, source) in links {
            let Some(source) = source.as_str() else {
                continue;
            };
            // Share from the original output, ignoring imported loops.
            if source == target || links.contains_key(source) {
                continue;
            }
            let chain = chains.get(source).cloned().unwrap_or_else(|| json!([]));
            chains.insert(target.clone(), chain);
        }
    }
    Value::Object(chains)
}

pub fn fallback_status(app: &AppHandle, bus: usize) -> Result<String, String> {
    let config = effective_fallbacks(&app.state::<Settings>().0.lock().unwrap());
    let Some(chain) = config[bus.to_string()].as_array().filter(|c| !c.is_empty()) else {
        return Ok("No fallback policy is configured for this output.".into());
    };
    let vm = app.state::<Vm>();
    let api = crate::api(&vm)?;
    let current = api
        .get_string(&format!("Bus[{bus}].device.name"))
        .ok_or("Output unavailable")?;
    if !current.is_empty()
        && !chain
            .iter()
            .any(|d| d["name"].as_str().is_some_and(|n| same_device(n, &current)))
    {
        return Ok(format!(
            "{current} was selected outside the policy. Automatic switching is paused."
        ));
    }
    let system = system_devices();
    if system.is_empty() {
        return Ok("Windows playback device availability is unknown.".into());
    }
    let devices = api.devices();
    let outputs = devices["outputs"]
        .as_array()
        .ok_or("Playback devices unavailable")?;
    let Some((name, _)) = fallback_choice(chain, &current, &system, outputs) else {
        return Ok(
            "No device in this policy is currently available in Windows and Voicemeeter.".into(),
        );
    };
    let priority = chain.iter().position(|d| d["name"] == name).unwrap_or(0) + 1;
    Ok(if same_device(name, &current) {
        format!("{name} is in use. It is the first available device (priority {priority}).")
    } else {
        format!("{name} is the first available device (priority {priority}). Waiting for automatic switching.")
    })
}

fn fallback_choice<'a>(
    chain: &'a [Value],
    current: &str,
    system: &[String],
    vm_devices: &[Value],
) -> Option<(&'a str, &'a str)> {
    if !current.is_empty()
        && !chain
            .iter()
            .any(|d| d["name"].as_str().is_some_and(|n| same_device(n, current)))
    {
        return None;
    }
    chain.iter().find_map(|d| {
        let name = d["name"].as_str()?;
        let kind = d["type"].as_str()?;
        if !matches!(kind, "wdm" | "ks" | "mme")
            || !system.iter().any(|n| same_device(name, n))
            || !vm_devices.iter().any(|d| {
                d["type"] == kind && d["name"].as_str().is_some_and(|n| same_device(name, n))
            })
        {
            return None;
        }
        Some((name, kind))
    })
}

fn check_fallbacks(
    app: &AppHandle,
    config: &Value,
    system: &[String],
    watches: &mut BTreeMap<usize, FallbackWatch>,
) {
    let Some(chains) = config.as_object().filter(|m| !m.is_empty()) else {
        watches.clear();
        return;
    };
    let vm = app.state::<Vm>();
    let Some(api) = &vm.api else { return };
    let Some(edition) = api.edition() else {
        watches.clear();
        return;
    };
    let devices = api.devices();
    let Some(outputs) = devices["outputs"].as_array() else {
        return;
    };
    let hw = crate::vm::Layout::for_edition(edition).hw_buses;
    watches.retain(|bus, _| *bus < hw && chains.contains_key(&bus.to_string()));
    for (key, chain) in chains {
        let Ok(bus) = key.parse::<usize>() else {
            continue;
        };
        let Some(chain) = chain.as_array().filter(|c| bus < hw && !c.is_empty()) else {
            continue;
        };
        let Some(current) = api.get_string(&format!("Bus[{bus}].device.name")) else {
            continue;
        };
        let watch = watches.entry(bus).or_default();
        let Some((name, kind)) = fallback_choice(chain, &current, system, outputs)
            .filter(|(name, _)| !same_device(name, &current))
        else {
            watch.candidate = None;
            continue;
        };
        let now = Instant::now();
        let stable = watch.candidate.as_ref().is_some_and(|(n, k, since)| {
            n == name && k == kind && now.duration_since(*since) >= SETTLE
        });
        if !watch
            .candidate
            .as_ref()
            .is_some_and(|(n, k, _)| n == name && k == kind)
        {
            watch.candidate = Some((name.to_owned(), kind.to_owned(), now));
        }
        if !stable
            || watch
                .attempted
                .is_some_and(|t| now.duration_since(t) < COOLDOWN)
        {
            continue;
        }
        watch.attempted = Some(now);
        match api.set_string(&format!("Bus[{bus}].device.{kind}"), name) {
            Ok(()) => {
                log_info!("Output A{} fallback selected {name:?}", bus + 1);
                let _ = app.emit("output-fallback", json!({ "bus": bus, "name": name }));
                crate::audio_events::record(
                    app,
                    "fallback",
                    &format!("A{} switched by fallback policy", bus + 1),
                    name,
                    &bus.to_string(),
                );
            }
            Err(e) => log_warn!("Couldn't switch output A{} to {name:?}: {e}", bus + 1),
        }
    }
}

fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

/// Is the device Voicemeeter names `assigned` the one Windows lists as `listed`?
/// Windows' older audio API cuts names at 31 characters, and Voicemeeter's kernel-streaming
/// names are the hardware's own name, which Windows shows in brackets.
pub fn same_device(assigned: &str, listed: &str) -> bool {
    let (a, l) = (norm(assigned), norm(listed));
    if a.is_empty() || l.is_empty() {
        return false;
    }
    if a == l || (l.chars().count() >= 31 && a.starts_with(&l)) {
        return true;
    }
    // "Headphones (Arctis Nova Pro Wireless)": compare the part in brackets as well.
    let inner = |s: &str| -> Option<String> {
        let open = s.find('(')?;
        let close = s.rfind(')')?;
        (close > open + 1).then(|| s[open + 1..close].trim().to_string())
    };
    let long_enough = |s: &str| s.chars().count() >= 8;
    if let Some(i) = inner(&l) {
        if long_enough(&i) && (a == i || a.contains(&i)) {
            return true;
        }
    }
    if let Some(i) = inner(&a) {
        if long_enough(&i) && (l == i || l.contains(&i)) {
            return true;
        }
    }
    false
}

/// Names of the audio devices Windows has working right now (playback and recording).
#[cfg(windows)]
pub fn system_devices() -> Vec<String> {
    let mut names = Vec::new();
    names.extend(mme_devices());
    names.extend(endpoint_devices());
    names
}

#[cfg(not(windows))]
pub fn system_devices() -> Vec<String> {
    Vec::new()
}

/// From Windows' classic audio API (names cut at 31 characters).
#[cfg(windows)]
fn mme_devices() -> Vec<String> {
    use windows_sys::Win32::Media::Audio::{
        waveInGetDevCapsW, waveInGetNumDevs, waveOutGetDevCapsW, waveOutGetNumDevs, WAVEINCAPSW,
        WAVEOUTCAPSW,
    };
    let text = |raw: [u16; 32]| {
        let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
        String::from_utf16_lossy(&raw[..end])
    };
    let mut out = Vec::new();
    unsafe {
        for i in 0..waveOutGetNumDevs() {
            let mut caps: WAVEOUTCAPSW = std::mem::zeroed();
            if waveOutGetDevCapsW(
                i as usize,
                &mut caps,
                std::mem::size_of::<WAVEOUTCAPSW>() as u32,
            ) == 0
            {
                let name = caps.szPname; // copy out of the packed struct
                out.push(text(name));
            }
        }
        for i in 0..waveInGetNumDevs() {
            let mut caps: WAVEINCAPSW = std::mem::zeroed();
            if waveInGetDevCapsW(
                i as usize,
                &mut caps,
                std::mem::size_of::<WAVEINCAPSW>() as u32,
            ) == 0
            {
                let name = caps.szPname;
                out.push(text(name));
            }
        }
    }
    out
}

/// From the registry Windows keeps of its audio endpoints: full names of the active ones.
#[cfg(windows)]
fn endpoint_devices() -> Vec<String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;
    const ROOT: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio";
    const DESC: &str = "{a45c254e-df1c-4efd-8020-67d146a850e0},2"; // "Headphones"
    const ADAPTER: &str = "{b3f8fa53-0004-438e-9003-51a46e139bfc},6"; // "Arctis Nova Pro"
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut out = Vec::new();
    for flow in ["Render", "Capture"] {
        let Ok(list) = hklm.open_subkey_with_flags(format!(r"{ROOT}\{flow}"), KEY_READ) else {
            continue;
        };
        for id in list.enum_keys().flatten() {
            let Ok(dev) = list.open_subkey_with_flags(&id, KEY_READ) else {
                continue;
            };
            // 1 = active; 2 disabled, 4 not present, 8 unplugged
            if dev.get_value::<u32, _>("DeviceState").unwrap_or(0) != 1 {
                continue;
            }
            let Ok(props) = dev.open_subkey_with_flags("Properties", KEY_READ) else {
                continue;
            };
            let desc: String = props.get_value(DESC).unwrap_or_default();
            let adapter: String = props.get_value(ADAPTER).unwrap_or_default();
            match (desc.is_empty(), adapter.is_empty()) {
                (false, false) => out.push(format!("{desc} ({adapter})")),
                (true, false) => out.push(adapter),
                (false, true) => out.push(desc),
                _ => {}
            }
        }
    }
    out
}

/// The devices Voicemeeter is set to use, from the latest mixer snapshot.
pub fn assigned_devices(app: &AppHandle) -> Vec<String> {
    let snap = app.state::<Vm>().last.lock().unwrap().clone();
    if !snap["connected"].as_bool().unwrap_or(false) {
        return Vec::new();
    }
    let mut names = Vec::new();
    for list in ["strips", "buses"] {
        for ch in snap[list].as_array().into_iter().flatten() {
            if let Some(d) = ch["device"].as_str().filter(|d| !d.trim().is_empty()) {
                if !names.iter().any(|n: &String| n == d) {
                    names.push(d.to_string());
                }
            }
        }
    }
    names
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        // device name → was it working at the last check?
        let mut watch: BTreeMap<String, bool> = BTreeMap::new();
        let mut due: Option<(Instant, String)> = None;
        let mut last_restart: Option<Instant> = None;
        let mut fallback_watches = BTreeMap::new();
        loop {
            std::thread::sleep(EVERY);
            let (restart_on, auto, fallbacks) = {
                let state = app.state::<Settings>();
                let s = state.0.lock().unwrap();
                (
                    settings::flag_or(&s, "autoRestart", true),
                    outputs::auto_devices(&s),
                    effective_fallbacks(&s),
                )
            };
            let assigned = assigned_devices(&app);
            // Devices that an output profile with "switch automatically" is waiting for.
            let wanted: Vec<String> = auto.iter().map(|(_, d)| d.clone()).collect();
            let has_fallbacks = fallbacks.as_object().is_some_and(|m| {
                m.values()
                    .any(|v| v.as_array().is_some_and(|d| !d.is_empty()))
            });
            if !has_fallbacks {
                fallback_watches.clear();
            }
            let watch_reconnect = (restart_on || !wanted.is_empty())
                && !(assigned.is_empty() && wanted.is_empty() && watch.is_empty());
            if !has_fallbacks && !watch_reconnect {
                watch.clear();
                due = None;
                continue;
            }
            let system = system_devices();
            if system.is_empty() {
                continue; // couldn't read the device list this time
            }
            if has_fallbacks {
                check_fallbacks(&app, &fallbacks, &system, &mut fallback_watches);
            }
            if !watch_reconnect {
                watch.clear();
                due = None;
                continue;
            }
            let present = |name: &str| system.iter().any(|s| same_device(name, s));
            for name in assigned.iter().chain(wanted.iter()) {
                watch
                    .entry(name.clone())
                    .or_insert_with(|| present(name.as_str()));
            }
            let mut back = None;
            watch.retain(|name, was| {
                let now = present(name.as_str());
                if now && !*was {
                    log_info!("Audio device back: {name}");
                    back = Some(name.clone());
                } else if !now && *was {
                    log_info!("Audio device gone: {name}");
                }
                *was = now;
                // Keep watching a missing device even if Voicemeeter blanks its name;
                // stop watching one that's here but no longer used.
                assigned.contains(name) || wanted.contains(name) || !now
            });
            if let Some(name) = back {
                due = Some((Instant::now() + SETTLE, name));
            }
            if let Some((when, name)) = due.clone() {
                let cooled = last_restart
                    .map(|t| t.elapsed() >= COOLDOWN)
                    .unwrap_or(true);
                if Instant::now() >= when && cooled {
                    due = None;
                    let Some(api) = app.state::<Vm>().api.clone() else {
                        continue;
                    };
                    // An output profile that wants this device: switch the outputs to it first.
                    let mut switched = false;
                    if let Some((profile, _)) = auto.iter().find(|(_, d)| *d == name) {
                        let current = app.state::<Vm>().last.lock().unwrap().clone();
                        let already = {
                            let state = app.state::<Settings>();
                            let s = state.0.lock().unwrap();
                            outputs::current(&s, &current).as_deref() == Some(profile.as_str())
                        };
                        if !already {
                            outputs::switch_with_osd(&app, profile, &format!("{name} connected"));
                            switched = true;
                        }
                    }
                    if !restart_on && !switched {
                        continue;
                    }
                    match api.set_float("Command.Restart", 1.0) {
                        Ok(()) => {
                            log_info!("Restarted the audio engine because {name} came back");
                            last_restart = Some(Instant::now());
                            let _ = app.emit("engine-restarted", json!({ "device": name }));
                            crate::audio_events::record(
                                &app,
                                "device",
                                "Audio engine restarted after reconnect",
                                &name,
                                "",
                            );
                        }
                        Err(e) => log_warn!("Couldn't restart the audio engine: {e}"),
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{effective_fallbacks, fallback_choice, same_device};
    use serde_json::json;

    #[test]
    fn linked_fallbacks_use_the_latest_source_policy_and_ignore_cycles() {
        let mut settings = json!({
            "outputFallbacks": { "0": [{"name":"Headphones","type":"wdm"}], "3": [], "4": [] },
            "outputFallbackLinks": { "1": "0", "2": "1", "3": "4", "4": "3" }
        });
        let effective = effective_fallbacks(&settings);
        assert_eq!(effective["1"], effective["0"]);
        assert!(effective.get("2").is_none());
        assert_eq!(effective["3"], json!([]));
        settings["outputFallbacks"]["0"][0]["name"] = json!("Speakers");
        assert_eq!(effective_fallbacks(&settings)["1"][0]["name"], "Speakers");
    }

    #[test]
    fn fallback_prefers_the_first_available_device_and_respects_manual_selection() {
        let devices = [
            json!({"name":"Headphones","type":"wdm"}),
            json!({"name":"Speakers","type":"wdm"}),
        ];
        let both = ["Headphones".into(), "Speakers".into()];
        let speakers = ["Speakers".into()];
        assert_eq!(
            fallback_choice(&devices, "Headphones", &speakers, &devices),
            Some(("Speakers", "wdm"))
        );
        assert_eq!(
            fallback_choice(&devices, "Speakers", &both, &devices),
            Some(("Headphones", "wdm"))
        );
        assert_eq!(
            fallback_choice(&devices, "External DAC", &both, &devices),
            None
        );
        assert_eq!(fallback_choice(&devices, "Headphones", &[], &devices), None);
    }

    #[test]
    fn matching() {
        assert!(same_device(
            "Headphones (Arctis Nova Pro Wireless)",
            "Headphones (Arctis Nova Pro Wireless)"
        ));
        // MME names are cut at 31 characters
        assert!(same_device(
            "Headphones (Arctis Nova Pro Wireless)",
            "Headphones (Arctis Nova Pro Wir"
        ));
        // kernel streaming uses the hardware's own name
        assert!(same_device(
            "Arctis Nova Pro Wireless",
            "Headphones (Arctis Nova Pro Wireless)"
        ));
        assert!(!same_device(
            "Speakers (Realtek(R) Audio)",
            "Headphones (Arctis Nova Pro Wireless)"
        ));
        assert!(!same_device("Speakers (USB)", "Headphones (USB)"));
        assert!(!same_device("", "Speakers"));
    }
}
