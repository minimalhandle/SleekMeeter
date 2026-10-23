//! Volume and mute for each app, the same controls as Windows' own volume mixer.
//!
//! Every program that plays sound has an "audio session" on the device it plays to. Windows
//! lets other programs read and change a session's volume and mute. Apps that play into
//! Voicemeeter's virtual inputs have their session on those devices, so this works for them too:
//! it turns the app down before Voicemeeter ever hears it, on top of the strip's own fader.

use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Programs that are part of the audio setup itself; turning them down would only confuse.
const HIDDEN: &[&str] = &[
    "sleekmeeter.exe",
    "voicemeeter.exe",
    "voicemeeter_x64.exe",
    "voicemeeterpro.exe",
    "voicemeeterpro_x64.exe",
    "voicemeeter8.exe",
    "voicemeeter8x64.exe",
    "audiodg.exe",
];

/// "discord.exe" → "Discord"
fn nice_name(exe: &str) -> String {
    let stem = exe.strip_suffix(".exe").unwrap_or(exe);
    let mut chars = stem.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// One line per program, merged from its sessions on every device.
#[derive(Default, Debug)]
struct Row {
    volume: f32,
    muted: bool,
    active: bool,
    seen: bool,
}

/// Fold one session into its program's row: loudest volume, muted only if all are, active if any is.
fn merge(row: &mut Row, volume: f32, muted: bool, active: bool) {
    if !row.seen {
        *row = Row {
            volume,
            muted,
            active,
            seen: true,
        };
        return;
    }
    row.volume = row.volume.max(volume);
    row.muted = row.muted && muted;
    row.active = row.active || active;
}

fn rows_to_json(rows: BTreeMap<String, Row>) -> Vec<Value> {
    let mut list: Vec<(String, Row)> = rows.into_iter().collect();
    // Playing now first, then by name.
    list.sort_by(|a, b| b.1.active.cmp(&a.1.active).then(a.0.cmp(&b.0)));
    list.into_iter()
        .map(|(exe, r)| {
            let name = if exe == "system sounds" {
                "System sounds".to_string()
            } else {
                nice_name(&exe)
            };
            json!({
                "exe": exe,
                "name": name,
                "volume": (r.volume * 100.0).round(),
                "mute": r.muted,
                "active": r.active,
            })
        })
        .collect()
}

#[cfg(windows)]
mod sessions {
    use windows::core::Interface;
    use windows::Win32::Foundation::BOOL;
    use windows::Win32::Media::Audio::{
        eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
        IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    /// Keeps COM initialised on this thread while it lives.
    struct Com(bool);
    impl Com {
        fn start() -> Com {
            // Fails harmlessly if the thread already runs COM in another mode.
            Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
        }
    }
    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    /// Calls `f(process id, volume control, playing)` for every audio session on every active
    /// playback device.
    pub fn each(mut f: impl FnMut(u32, &ISimpleAudioVolume, bool)) -> Result<(), String> {
        let _com = Com::start();
        let mut go = || -> windows::core::Result<()> {
            unsafe {
                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
                let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
                for d in 0..devices.GetCount()? {
                    let Ok(device) = devices.Item(d) else {
                        continue;
                    };
                    let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None)
                    else {
                        continue;
                    };
                    let Ok(list) = manager.GetSessionEnumerator() else {
                        continue;
                    };
                    for s in 0..list.GetCount().unwrap_or(0) {
                        let Ok(control) = list.GetSession(s) else {
                            continue;
                        };
                        let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                            continue;
                        };
                        let Ok(volume) = control.cast::<ISimpleAudioVolume>() else {
                            continue;
                        };
                        let pid = control2.GetProcessId().unwrap_or(0);
                        let active = control
                            .GetState()
                            .map(|st| st == AudioSessionStateActive)
                            .unwrap_or(false);
                        f(pid, &volume, active);
                    }
                }
                Ok(())
            }
        };
        go().map_err(|e| format!("Couldn't read the apps' volumes from Windows: {e}"))
    }

    pub fn read(v: &ISimpleAudioVolume) -> (f32, bool) {
        unsafe {
            (
                v.GetMasterVolume().unwrap_or(1.0),
                v.GetMute().map(|m| m.as_bool()).unwrap_or(false),
            )
        }
    }

    pub fn set_volume(v: &ISimpleAudioVolume, level: f32) {
        unsafe {
            let _ = v.SetMasterVolume(level.clamp(0.0, 1.0), std::ptr::null());
        }
    }

    pub fn set_mute(v: &ISimpleAudioVolume, mute: bool) {
        unsafe {
            let _ = v.SetMute(BOOL::from(mute), std::ptr::null());
        }
    }
}

/// Every program that has an audio session, with its volume and mute.
#[cfg(windows)]
pub fn list() -> Result<Vec<Value>, String> {
    let names = crate::apps::process_names();
    let mut rows: BTreeMap<String, Row> = BTreeMap::new();
    sessions::each(|pid, volume, active| {
        let exe = if pid == 0 {
            "system sounds".to_string()
        } else {
            match names.get(&pid) {
                Some(n) => n.clone(),
                None => return,
            }
        };
        if HIDDEN.contains(&exe.as_str()) {
            return;
        }
        let (level, muted) = sessions::read(volume);
        merge(rows.entry(exe).or_default(), level, muted, active);
    })?;
    Ok(rows_to_json(rows))
}

/// Set the volume (0–100) and/or mute of every session of one program.
#[cfg(windows)]
pub fn set(exe: &str, volume: Option<f32>, mute: Option<bool>) -> Result<(), String> {
    let wanted = exe.to_lowercase();
    let names = crate::apps::process_names();
    let mut found = false;
    sessions::each(|pid, control, _| {
        let name = if pid == 0 {
            "system sounds"
        } else {
            match names.get(&pid) {
                Some(n) => n.as_str(),
                None => return,
            }
        };
        if name != wanted {
            return;
        }
        found = true;
        if let Some(v) = volume {
            sessions::set_volume(control, v / 100.0);
        }
        if let Some(m) = mute {
            sessions::set_mute(control, m);
        }
    })?;
    if found {
        Ok(())
    } else {
        Err(format!(
            "{} isn't playing audio any more",
            nice_name(&wanted)
        ))
    }
}

#[cfg(not(windows))]
pub fn list() -> Result<Vec<Value>, String> {
    Err("Per-app volume is only available on Windows".into())
}

#[cfg(not(windows))]
pub fn set(_exe: &str, _volume: Option<f32>, _mute: Option<bool>) -> Result<(), String> {
    Err("Per-app volume is only available on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_readable() {
        assert_eq!(nice_name("discord.exe"), "Discord");
        assert_eq!(nice_name("obs64.exe"), "Obs64");
        assert_eq!(nice_name(""), "");
    }

    #[test]
    fn one_row_per_program() {
        let mut rows: BTreeMap<String, Row> = BTreeMap::new();
        // Chrome plays on two devices: loudest volume, muted only if every session is.
        merge(
            rows.entry("chrome.exe".into()).or_default(),
            0.4,
            true,
            false,
        );
        merge(
            rows.entry("chrome.exe".into()).or_default(),
            0.8,
            false,
            true,
        );
        merge(
            rows.entry("discord.exe".into()).or_default(),
            1.0,
            false,
            false,
        );
        merge(
            rows.entry("spotify.exe".into()).or_default(),
            0.5,
            false,
            true,
        );
        let list = rows_to_json(rows);
        let names: Vec<&str> = list.iter().map(|r| r["exe"].as_str().unwrap()).collect();
        assert_eq!(names, ["chrome.exe", "spotify.exe", "discord.exe"]); // playing first
        assert_eq!(list[0]["volume"], 80.0);
        assert_eq!(list[0]["mute"], false);
        assert_eq!(list[0]["active"], true);
        assert_eq!(list[2]["volume"], 100.0);
    }
}
