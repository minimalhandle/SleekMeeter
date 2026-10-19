//! Bring audio back when a device comes back.
//!
//! Voicemeeter often doesn't pick a device up again after it was unplugged or switched off
//! (USB or Bluetooth headphones, a dock), and the fix is "Restart audio engine". Sleekmeeter
//! watches the devices Voicemeeter is set to use; when one of them returns to Windows, it
//! waits a moment for Windows to finish setting it up and restarts the engine for you.

use crate::{settings, Settings, Vm};
use serde_json::json;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Time between checks.
const EVERY: Duration = Duration::from_millis(1500);
/// Give Windows this long to finish setting up a device that just arrived.
const SETTLE: Duration = Duration::from_millis(2500);
/// Never restart more often than this.
const COOLDOWN: Duration = Duration::from_secs(10);

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
fn assigned_devices(app: &AppHandle) -> Vec<String> {
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
        loop {
            std::thread::sleep(EVERY);
            let on = settings::flag_or(
                &app.state::<Settings>().0.lock().unwrap(),
                "autoRestart",
                true,
            );
            let assigned = assigned_devices(&app);
            if !on || (assigned.is_empty() && watch.is_empty()) {
                watch.clear();
                due = None;
                continue;
            }
            let system = system_devices();
            if system.is_empty() {
                continue; // couldn't read the device list this time
            }
            let present = |name: &str| system.iter().any(|s| same_device(name, s));
            for name in &assigned {
                watch.entry(name.clone()).or_insert_with(|| present(name.as_str()));
            }
            let mut back = None;
            watch.retain(|name, was| {
                let now = present(name.as_str());
                if now && !*was {
                    back = Some(name.clone());
                }
                *was = now;
                // Keep watching a missing device even if Voicemeeter blanks its name;
                // stop watching one that's here but no longer used.
                assigned.contains(name) || !now
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
                    if api.set_float("Command.Restart", 1.0).is_ok() {
                        last_restart = Some(Instant::now());
                        let _ = app.emit("engine-restarted", json!({ "device": name }));
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::same_device;

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
