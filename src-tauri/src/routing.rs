//! Per-app routing: choose which output device each app plays to (for example Discord into a
//! Voicemeeter virtual input), the same setting as Windows' "App volume and device preferences".
//!
//! Windows has no public API for this, so it uses the same internal call the Settings page does.
//! That call runs in a small separate helper (PowerShell), so if it ever misbehaves on some
//! Windows version it can't take Sleekmeeter down with it.

use crate::policy;
use crate::LockExt;

use serde_json::{json, Value};

/// Playback devices Windows has, as `{ id, name }`; Voicemeeter's virtual inputs first.
#[cfg(windows)]
pub fn devices() -> Vec<Value> {
    endpoints("Render", 0)
}

#[cfg(windows)]
pub fn capture_devices() -> Vec<Value> {
    endpoints("Capture", 1)
}

#[cfg(windows)]
fn endpoints(kind: &str, flow: u8) -> Vec<Value> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let path = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\{kind}");
    let Ok(render) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(path) else {
        return Vec::new();
    };
    let mut list: Vec<(String, String)> = Vec::new();
    for guid in render.enum_keys().flatten() {
        let Ok(dev) = render.open_subkey(&guid) else {
            continue;
        };
        // 1 = plugged in and enabled.
        if dev.get_value::<u32, _>("DeviceState").unwrap_or(0) != 1 {
            continue;
        }
        let Ok(props) = dev.open_subkey("Properties") else {
            continue;
        };
        let short: String = props
            .get_value("{a45c254e-df1c-4efd-8020-67d146a850e0},2")
            .unwrap_or_default();
        let adapter: String = props
            .get_value("{b3f8fa53-0004-438e-9003-51a46e139bfc},6")
            .unwrap_or_default();
        let name = match (short.is_empty(), adapter.is_empty()) {
            (true, true) => continue,
            (false, true) => short,
            (true, false) => adapter,
            (false, false) => format!("{short} ({adapter})"),
        };
        list.push((format!("{{0.0.{flow}.00000000}}.{guid}"), name));
    }
    list.sort_by(|a, b| {
        let va = a.1.to_lowercase().contains("voicemeeter");
        let vb = b.1.to_lowercase().contains("voicemeeter");
        vb.cmp(&va).then(a.1.cmp(&b.1))
    });
    list.into_iter()
        .map(|(id, name)| json!({ "id": id, "name": name }))
        .collect()
}

#[cfg(not(windows))]
pub fn devices() -> Vec<Value> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn capture_devices() -> Vec<Value> {
    Vec::new()
}

/// `{0.0.0.00000000}.{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}` and nothing else.
pub fn valid_device(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("{0.0.0.00000000}.{") else {
        return false;
    };
    let Some(guid) = rest.strip_suffix('}') else {
        return false;
    };
    guid.len() == 36 && guid.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Make the apps with these process ids play to `device` (an id from [`devices`]), or back to
/// the Windows default when `device` is empty. Each process is handled on its own: one that
/// Windows already has on that device is left alone (moving it anyway cuts its sound for a
/// moment), and one with no sound open is skipped. Returns the outcome for each process.
pub fn set_each(
    pids: &[u32],
    device: &str,
) -> Result<Vec<(u32, Result<policy::Moved, String>)>, String> {
    static ROUTING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = ROUTING.locked();
    if pids.is_empty() {
        return Err("That app isn't playing sound right now".into());
    }
    if !device.is_empty() && !valid_device(device) {
        return Err("That isn't a playback device".into());
    }
    Ok(pids
        .iter()
        .map(|&p| (p, policy::set_app_device(p, device)))
        .collect())
}

/// [`set_each`] for the mixer: Ok with how many moved unless every process failed.
pub fn set(pids: &[u32], device: &str) -> Result<usize, String> {
    let results = set_each(pids, device)?;
    let moved = results
        .iter()
        .filter(|(_, r)| r == &Ok(policy::Moved::Moved))
        .count();
    let errors: Vec<&String> = results
        .iter()
        .filter_map(|(_, r)| r.as_ref().err())
        .collect();
    if !errors.is_empty() && errors.len() == results.len() {
        log_warn!("App routing: {}", errors[0]);
        return Err(errors[0].clone());
    }
    Ok(moved)
}

/// Wakes the routing loop early: a program just opened sound (see [`watch_sessions`]).
static WAKE: (std::sync::Mutex<bool>, std::sync::Condvar) =
    (std::sync::Mutex::new(false), std::sync::Condvar::new());

pub fn wake() {
    *WAKE.0.locked() = true;
    WAKE.1.notify_all();
}

/// Sleep until woken or `max` has passed.
fn nap(max: std::time::Duration) {
    let guard = WAKE.0.locked();
    let (mut woken, _) = WAKE
        .1
        .wait_timeout_while(guard, max, |w| !*w)
        .unwrap_or_else(|e| e.into_inner());
    *woken = false;
}

/// Put remembered routes ("appRoutes" in the settings: program → device) back on programs
/// that start later, whether or not the mixer window is open. Windows usually remembers them
/// itself; this covers the times it doesn't.
pub fn spawn(app: tauri::AppHandle) {
    use std::collections::{HashMap, HashSet};
    use tauri::{Emitter, Manager};
    std::thread::spawn(move || {
        // program → (device it was sent to, processes already sent there)
        let mut done: HashMap<String, (String, HashSet<u32>)> = HashMap::new();
        let mut devices: Vec<String> = Vec::new();
        let mut checked = std::time::Instant::now() - std::time::Duration::from_secs(600);
        loop {
            nap(std::time::Duration::from_secs(3));
            let routes = app.state::<crate::Settings>().0.locked()["appRoutes"].clone();
            let Some(routes) = routes.as_object().filter(|r| !r.is_empty()) else {
                continue;
            };
            if checked.elapsed() > std::time::Duration::from_secs(60) {
                devices = devices_ids();
                checked = std::time::Instant::now();
            }
            let Ok(running) = crate::appvol::list() else {
                continue;
            };
            done.retain(|exe, _| routes.contains_key(exe));
            for a in running {
                let exe = a["exe"].as_str().unwrap_or("").to_string();
                let Some(device) = routes.get(&exe).and_then(|d| d.as_str()) else {
                    continue;
                };
                if !device.is_empty() && !devices.iter().any(|d| d == device) {
                    continue; // that device isn't here right now
                }
                let pids: Vec<u32> = a["pids"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|p| p.as_u64().map(|p| p as u32))
                    .collect();
                let entry = done.entry(exe.clone()).or_default();
                if entry.0 != device {
                    *entry = (device.to_string(), HashSet::new());
                }
                entry.1.retain(|p| pids.contains(p));
                let fresh: Vec<u32> = pids.into_iter().filter(|p| !entry.1.contains(p)).collect();
                if fresh.is_empty() {
                    continue;
                }
                let Ok(results) = set_each(&fresh, device) else {
                    continue;
                };
                let (mut moved, before) = (0, entry.1.len());
                for (pid, r) in results {
                    match r {
                        Ok(policy::Moved::Moved) => moved += 1,
                        Ok(policy::Moved::Already) => {}
                        // No sound open yet: try again when it opens some.
                        Ok(policy::Moved::NoSound) => continue,
                        // Given up on for this process, rather than retried every few seconds.
                        Err(e) => {
                            log_warn!("Couldn't put {exe} (process {pid}) on its output: {e}")
                        }
                    }
                    entry.1.insert(pid);
                }
                if entry.1.len() == before || (moved == 0 && !device.is_empty()) {
                    continue; // Windows remembered it itself: nothing to report
                }
                let label = if device.is_empty() {
                    "Windows default"
                } else {
                    // The app's route can be opened from its executable even after it exits.
                    "Saved playback device"
                };
                crate::audio_events::record(
                    &app,
                    "routing",
                    "App route applied",
                    &format!("{exe} → {label}"),
                    &exe,
                );
                if device.is_empty() {
                    let state = app.state::<crate::Settings>();
                    let mut settings = state.0.locked();
                    if settings["appRoutes"][&exe] == "" {
                        if let Some(routes) = settings["appRoutes"].as_object_mut() {
                            routes.remove(&exe);
                            app.state::<crate::SettingsDirty>()
                                .0
                                .store(true, std::sync::atomic::Ordering::SeqCst);
                            let _ = app.emit("app-route-reset", &exe);
                        }
                    }
                }
            }
        }
    });
}

fn devices_ids() -> Vec<String> {
    devices()
        .into_iter()
        .filter_map(|d| d["id"].as_str().map(str::to_string))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_real_device_ids_pass() {
        assert!(valid_device(
            "{0.0.0.00000000}.{0a1b2c3d-1111-2222-3333-444455556666}"
        ));
        assert!(!valid_device("{0.0.0.00000000}.{x'; Remove-Item *; '}"));
        assert!(!valid_device(""));
    }
}

/// Wake the routing loop the moment any program opens sound on any playback device, so a saved
/// route is applied before the program has played much (rather than up to 3 seconds in).
#[cfg(windows)]
pub fn watch_sessions() {
    use std::collections::HashMap;
    use windows::core::implement;
    use windows::Win32::Media::Audio::{
        eRender, IAudioSessionControl, IAudioSessionManager2, IAudioSessionNotification,
        IAudioSessionNotification_Impl, IMMDeviceEnumerator, MMDeviceEnumerator,
        DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    #[implement(IAudioSessionNotification)]
    struct Opened;

    impl IAudioSessionNotification_Impl for Opened_Impl {
        fn OnSessionCreated(&self, _: Option<&IAudioSessionControl>) -> windows::core::Result<()> {
            wake();
            Ok(())
        }
    }

    std::thread::spawn(|| unsafe {
        // This thread keeps COM running for as long as Sleekmeeter does.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let notify: IAudioSessionNotification = Opened.into();
        // device id → its session manager, registered for notifications
        let mut watched: HashMap<String, IAudioSessionManager2> = HashMap::new();
        loop {
            let found = (|| -> windows::core::Result<Vec<(String, IAudioSessionManager2)>> {
                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
                let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
                let mut out = Vec::new();
                for d in 0..devices.GetCount()? {
                    let Ok(device) = devices.Item(d) else {
                        continue;
                    };
                    let Ok(raw) = device.GetId() else { continue };
                    let id = raw.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(raw.0.cast()));
                    if watched.contains_key(&id) {
                        let manager = watched[&id].clone();
                        out.push((id, manager));
                        continue;
                    }
                    let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None)
                    else {
                        continue;
                    };
                    // Windows only starts sending notifications after the sessions are listed once.
                    let _ = manager.GetSessionEnumerator();
                    if manager.RegisterSessionNotification(&notify).is_ok() {
                        out.push((id, manager));
                    }
                }
                Ok(out)
            })();
            if let Ok(found) = found {
                let keep: HashMap<String, IAudioSessionManager2> = found.into_iter().collect();
                for (id, manager) in watched.drain() {
                    if !keep.contains_key(&id) {
                        let _ = manager.UnregisterSessionNotification(&notify);
                    }
                }
                watched = keep;
            }
            // Devices come and go rarely; look for new ones now and then.
            std::thread::sleep(std::time::Duration::from_secs(20));
        }
    });
}

#[cfg(not(windows))]
pub fn watch_sessions() {}
