//! Bluetooth headset warning.
//!
//! A Bluetooth headset can't play stereo music and use its mic at the same time. As soon as any
//! app opens the headset's mic (Discord, a game's voice chat, a browser tab, even Voicemeeter
//! itself), Windows switches the headset to its hands-free "call" mode: mono, muffled, like a
//! phone line. Most people never find out why their headphones suddenly sound bad.
//!
//! Every few seconds Sleekmeeter looks at the mics of Windows' Bluetooth audio devices, and when
//! an app starts using one it says which app did it, on the overlay and in Audio Event History,
//! and the crackle doctor shows it with what to do. It only reads; it never closes the app or
//! changes the device. Settings → Mixer & devices can switch the warning off ("btWarn").

use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// One app using a Bluetooth headset's mic right now.
#[derive(Clone, Debug, PartialEq)]
pub struct User {
    pub device: String,
    pub app: String,
}

static USERS: Mutex<Vec<User>> = Mutex::new(Vec::new());

const EVERY: Duration = Duration::from_secs(3);

/// `{ users: [{ device, app }] }`: who has a Bluetooth headset in call mode right now.
pub fn status() -> Value {
    let users = USERS.lock().unwrap().clone();
    json!({ "users": users.iter().map(|u| json!({ "device": u.device, "app": u.app })).collect::<Vec<_>>() })
}

/// What to tell someone whose headset `device` was switched to call mode by `app`.
pub fn advice(device: &str, app: &str) -> String {
    if app == "Voicemeeter" {
        format!("Voicemeeter is using the mic of {device}, so Windows switched the headset to call quality (mono and muffled). Pick a different mic for that Voicemeeter input, or switch off the headset's Hands-Free service in Windows' Bluetooth settings.")
    } else {
        format!("{app} is using the mic of {device}, so Windows switched the headset to call quality (mono and muffled). In {app}, choose another mic (your real mic, or a Voicemeeter Out), or switch off the headset's Hands-Free service in Windows' Bluetooth settings.")
    }
}

/// "discord.exe" → "Discord"; Voicemeeter's programs → "Voicemeeter".
fn app_name(exe: &str) -> String {
    let lower = exe.to_lowercase();
    if lower.starts_with("voicemeeter") {
        return "Voicemeeter".into();
    }
    let stem = exe
        .strip_suffix(".exe")
        .or_else(|| exe.strip_suffix(".EXE"))
        .unwrap_or(exe);
    let mut chars = stem.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "An app".into(),
    }
}

/// "Headset (WH-1000XM4 Hands-Free AG Audio)" → "WH-1000XM4": the headset's own name, which
/// is what people know it by.
fn headset_name(full: &str) -> String {
    let inner = match (full.find('('), full.rfind(')')) {
        (Some(o), Some(c)) if c > o + 1 => full[o + 1..c].trim(),
        _ => full.trim(),
    };
    let cut = ["Hands-Free AG Audio", "Hands-Free", "Stereo"]
        .iter()
        .find_map(|s| inner.strip_suffix(s))
        .unwrap_or(inner)
        .trim();
    if cut.is_empty() {
        full.to_string()
    } else {
        cut.to_string()
    }
}

/// Users that weren't there last time.
fn arrived(before: &[User], now: &[User]) -> Vec<User> {
    now.iter()
        .filter(|u| !before.contains(u))
        .cloned()
        .collect()
}

#[cfg(windows)]
mod sessions {
    use windows::core::Interface;
    use windows::core::HSTRING;
    use windows::Win32::Media::Audio::{
        AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    struct Com(bool);
    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    /// Process ids with an active (recording) session on the endpoint with this id.
    pub fn active_pids(ids: &[String]) -> Vec<(String, u32)> {
        let _com = Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok());
        let mut out = Vec::new();
        let Ok(enumerator) = (unsafe {
            CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
        }) else {
            return out;
        };
        for id in ids {
            unsafe {
                let Ok(device) = enumerator.GetDevice(&HSTRING::from(id.as_str())) else {
                    continue;
                };
                let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                    continue;
                };
                let Ok(list) = manager.GetSessionEnumerator() else {
                    continue;
                };
                for s in 0..list.GetCount().unwrap_or(0) {
                    let Ok(control) = list.GetSession(s) else {
                        continue;
                    };
                    if control
                        .GetState()
                        .map(|st| st != AudioSessionStateActive)
                        .unwrap_or(true)
                    {
                        continue;
                    }
                    let Ok(c2) = control.cast::<IAudioSessionControl2>() else {
                        continue;
                    };
                    let pid = c2.GetProcessId().unwrap_or(0);
                    if pid != 0 {
                        out.push((id.clone(), pid));
                    }
                }
            }
        }
        out
    }
}

/// Who's using a Bluetooth headset's mic right now.
#[cfg(windows)]
fn scan() -> Vec<User> {
    let mics: Vec<crate::endpoints::Endpoint> = crate::endpoints::list()
        .into_iter()
        .filter(|e| e.capture && e.active && e.is_bluetooth())
        .collect();
    if mics.is_empty() {
        return Vec::new();
    }
    let ids: Vec<String> = mics.iter().map(|e| e.id()).collect();
    let pids = sessions::active_pids(&ids);
    if pids.is_empty() {
        return Vec::new();
    }
    let names = crate::apps::process_names();
    let mut out: Vec<User> = Vec::new();
    for (id, pid) in pids {
        let Some(exe) = names.get(&pid) else { continue };
        if exe.eq_ignore_ascii_case("audiodg.exe") {
            continue;
        }
        let Some(mic) = mics.iter().find(|m| m.id() == id) else {
            continue;
        };
        let u = User {
            device: headset_name(&mic.full),
            app: app_name(exe),
        };
        if !out.contains(&u) {
            out.push(u);
        }
    }
    out
}

#[cfg(not(windows))]
fn scan() -> Vec<User> {
    Vec::new()
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        let now = scan();
        let before = std::mem::replace(&mut *USERS.lock().unwrap(), now.clone());
        let warn = crate::settings::flag_or(
            &app.state::<crate::Settings>().0.lock().unwrap(),
            "btWarn",
            true,
        );
        for u in arrived(&before, &now) {
            log_info!("{} opened the mic of Bluetooth headset {}", u.app, u.device);
            crate::audio_events::record(
                &app,
                "device",
                "Bluetooth headset switched to call quality",
                &format!("{} is using the mic of {}", u.app, u.device),
                "crackle",
            );
            if warn {
                crate::show_osd_alert(
                    &app,
                    &u.device,
                    &format!("{} switched it to call quality", u.app),
                    "headphones",
                );
            }
        }
        if before != now {
            let _ = app.emit("bt-callmode", status());
        }
        std::thread::sleep(EVERY);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_headset_people_know() {
        assert_eq!(
            headset_name("Headset (WH-1000XM4 Hands-Free AG Audio)"),
            "WH-1000XM4"
        );
        assert_eq!(
            headset_name("Headphones (Galaxy Buds2 Stereo)"),
            "Galaxy Buds2"
        );
        assert_eq!(headset_name("Headset (AirPods Pro)"), "AirPods Pro");
        assert_eq!(headset_name("Plain"), "Plain");
    }

    #[test]
    fn names_the_app() {
        assert_eq!(app_name("discord.exe"), "Discord");
        assert_eq!(app_name("voicemeeter8x64.exe"), "Voicemeeter");
        assert!(advice("X", "Discord").starts_with("Discord is using the mic of X"));
        assert!(advice("X", "Voicemeeter").contains("Voicemeeter input"));
    }

    #[test]
    fn only_new_users_are_announced() {
        let a = User {
            device: "Buds".into(),
            app: "Discord".into(),
        };
        let b = User {
            device: "Buds".into(),
            app: "Chrome".into(),
        };
        assert_eq!(arrived(&[], &[a.clone()]), vec![a.clone()]);
        assert!(arrived(&[a.clone()], &[a.clone()]).is_empty());
        assert_eq!(arrived(&[a.clone()], &[a.clone(), b.clone()]), vec![b]);
        assert!(arrived(&[a], &[]).is_empty());
    }
}

#[cfg(test)]
pub fn scan_for_test() -> Vec<User> {
    scan()
}
