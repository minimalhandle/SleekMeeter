//! Windows' default sound output. Apps play to it, so when plugging in a device makes Windows
//! switch to that device, sound skips Voicemeeter and the mixer goes quiet. Sleekmeeter spots
//! that and can put Windows back on Voicemeeter's input.
//!
//! Reading the default uses Windows' public audio API. Changing it has no public API, so it
//! uses the internal call Windows' own sound settings use (see policy.rs).

use crate::LockExt;

use crate::{routing, settings, Settings, Vm};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Time between checks without Windows' device notifications.
const EVERY: Duration = Duration::from_secs(2);
/// With them: a check this often anyway, for Voicemeeter connecting or settings changing.
const IDLE: Duration = Duration::from_secs(15);
/// Windows may still be settling on a device that just arrived.
const SETTLE: Duration = Duration::from_millis(2500);
/// Automatic fixes allowed in [`WINDOW`]; past that, someone is choosing the device on purpose.
const MAX_AUTO: usize = 3;
const WINDOW: Duration = Duration::from_secs(300);

/// The Voicemeeter device Windows last used, so a fix puts back that one rather than any.
static LAST_GOOD: Mutex<Option<String>> = Mutex::new(None);

/// Voicemeeter's virtual inputs ("Voicemeeter Input (VB-Audio Voicemeeter VAIO)", AUX, In 3…).
fn is_voicemeeter(name: &str) -> bool {
    name.to_lowercase().contains("voicemeeter")
}

/// The ids of Windows' default playback device for everything and for calls.
#[cfg(windows)]
pub fn default_ids() -> Option<(String, String)> {
    use windows::Win32::Media::Audio::{
        eCommunications, eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED,
    };
    unsafe {
        // Fails harmlessly if the thread already runs COM in another mode.
        let started = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let read = || -> windows::core::Result<(String, String)> {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let id = |role| -> windows::core::Result<String> {
                let raw = enumerator.GetDefaultAudioEndpoint(eRender, role)?.GetId()?;
                let text = raw.to_string().unwrap_or_default();
                CoTaskMemFree(Some(raw.0 as *const _));
                Ok(text)
            };
            Ok((id(eConsole)?, id(eCommunications)?))
        };
        let out = read().ok();
        if started {
            CoUninitialize();
        }
        out
    }
}

#[cfg(not(windows))]
pub fn default_ids() -> Option<(String, String)> {
    None
}

fn name_of(devices: &[Value], id: &str) -> String {
    devices
        .iter()
        .find(|d| d["id"].as_str().is_some_and(|d| d.eq_ignore_ascii_case(id)))
        .and_then(|d| d["name"].as_str())
        .unwrap_or("an unknown device")
        .to_string()
}

/// The Voicemeeter input to put Windows back on: the one it last used, else the main
/// "Voicemeeter Input", else any Voicemeeter input.
fn target(devices: &[Value]) -> Option<(String, String)> {
    let pair = |d: &Value| {
        Some((
            d["id"].as_str()?.to_string(),
            d["name"].as_str()?.to_string(),
        ))
    };
    let last = LAST_GOOD.locked().clone();
    let named = |test: &dyn Fn(&str, &str) -> bool| {
        devices
            .iter()
            .find_map(|d| pair(d).filter(|(id, name)| test(id, name)))
    };
    last.and_then(|last| named(&|id, name| id.eq_ignore_ascii_case(&last) && is_voicemeeter(name)))
        .or_else(|| named(&|_, name| name.to_lowercase().starts_with("voicemeeter input")))
        .or_else(|| named(&|_, name| is_voicemeeter(name)))
}

fn connected(app: &AppHandle) -> bool {
    app.state::<Vm>().last.locked()["connected"]
        .as_bool()
        .unwrap_or(false)
}

/// `{ state, output, calls, target }`. `state` is "ok", "wrong" (a default isn't one of
/// Voicemeeter's inputs) or "unknown" (Voicemeeter isn't running, or Windows didn't answer).
pub fn status(app: &AppHandle) -> Value {
    let Some((main, calls)) = default_ids().filter(|_| connected(app)) else {
        return json!({ "state": "unknown" });
    };
    describe(&routing::devices(), &main, &calls)
}

fn describe(devices: &[Value], main: &str, calls: &str) -> Value {
    let (output, calls) = (name_of(devices, main), name_of(devices, calls));
    if is_voicemeeter(&output) {
        *LAST_GOOD.locked() = Some(main.to_string());
    }
    // Calls count too: everything should go through the mixer, Discord included.
    let wrong = !is_voicemeeter(&output) || !is_voicemeeter(&calls);
    json!({
        "state": if wrong { "wrong" } else { "ok" },
        "output": output,
        "calls": calls,
        "target": target(devices).map(|(_, name)| name),
    })
}

fn set_default(id: &str) -> Result<(), String> {
    if !routing::valid_device(id) {
        return Err("That isn't a playback device".into());
    }
    crate::policy::set_default_device(id).map_err(|e| {
        log_warn!("Sound output: {e}");
        "Windows didn't accept the change. Pick Voicemeeter Input in Windows' sound settings instead".to_string()
    })
}

/// Put Windows' sound output back on Voicemeeter if it has moved. Returns the device it chose,
/// or None when nothing needed changing.
pub fn fix() -> Result<Option<String>, String> {
    let (main, calls) = default_ids().ok_or("Couldn't read Windows' sound output")?;
    let devices = routing::devices();
    let st = describe(&devices, &main, &calls);
    if st["state"] == "ok" {
        return Ok(None);
    }
    let (id, name) = target(&devices)
        .ok_or("Windows doesn't list any Voicemeeter input. Is Voicemeeter installed?")?;
    set_default(&id)?;
    *LAST_GOOD.locked() = Some(id);
    log_info!(
        "Set Windows' sound output back to {name} (was {})",
        st["output"].as_str().unwrap_or("")
    );
    Ok(Some(name))
}

/// "Fix my audio": Windows' output back on Voicemeeter, then restart the audio engine, which
/// also brings back a device Voicemeeter lost while things were plugged in.
pub fn fix_all(app: &AppHandle) -> Result<Value, String> {
    let moved = fix()?;
    let restarted = match app.state::<Vm>().api.clone() {
        Some(api) => api.set_float("Command.Restart", 1.0).is_ok(),
        None => false,
    };
    if restarted {
        log_info!("Restarted the audio engine (Fix my audio)");
    }
    let _ = app.emit("windows-output", status(app));
    Ok(json!({ "moved": moved, "restarted": restarted }))
}

/// Watches the default output, tells the window when it moves, and puts it back when
/// "Keep Windows sound on Voicemeeter" is on.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<(String, String)> = None;
        let mut fixes: Vec<Instant> = Vec::new();
        let mut seen = crate::devnotify::now();
        let mut first_pass = true;
        loop {
            // The first check waits the usual 2 s, so Voicemeeter has time to connect.
            if first_pass {
                std::thread::sleep(EVERY);
                first_pass = false;
            } else {
                crate::devnotify::wait(&mut seen, IDLE, EVERY);
            }
            let ids = default_ids().filter(|_| connected(&app));
            if ids == last {
                continue;
            }
            let first = last.is_none();
            last = ids.clone();
            if ids.is_none() {
                let _ = app.emit("windows-output", json!({ "state": "unknown" }));
                continue;
            }
            let st = status(&app);
            let _ = app.emit("windows-output", &st);
            if !first || st["state"] == "wrong" {
                let output = st["output"].as_str().unwrap_or("Unknown");
                let calls = st["calls"].as_str().unwrap_or("Unknown");
                crate::audio_events::record(
                    &app,
                    "device",
                    if st["state"] == "wrong" {
                        "Windows playback bypassed Voicemeeter"
                    } else {
                        "Windows playback device changed"
                    },
                    &format!("Playback: {output} · Calls: {calls}"),
                    "",
                );
            }
            if st["state"] != "wrong" {
                continue;
            }
            log_info!(
                "Windows' sound output isn't Voicemeeter: {} (calls: {})",
                st["output"].as_str().unwrap_or(""),
                st["calls"].as_str().unwrap_or("")
            );
            let keep = {
                let state = app.state::<Settings>();
                let s = state.0.locked();
                settings::flag(&s, "keepWindowsOutput")
            };
            fixes.retain(|t| t.elapsed() < WINDOW);
            if !keep || fixes.len() >= MAX_AUTO {
                continue;
            }
            if !first {
                std::thread::sleep(SETTLE);
            }
            fixes.push(Instant::now());
            match fix() {
                Ok(Some(name)) => {
                    crate::audio_events::record(
                        &app,
                        "device",
                        "Windows playback restored to Voicemeeter",
                        &name,
                        "",
                    );
                    let _ = app.emit(
                        "windows-output",
                        json!({ "state": "ok", "fixed": true, "from": st["output"], "target": name }),
                    );
                }
                Ok(None) => {}
                Err(e) => log_warn!("Couldn't keep Windows' sound on Voicemeeter: {e}"),
            }
            last = None; // look again next time, whatever the fix did
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn devices() -> Vec<Value> {
        vec![
            json!({ "id": "{0.0.0.00000000}.{11111111-1111-1111-1111-111111111111}", "name": "Voicemeeter AUX Input (VB-Audio Voicemeeter VAIO)" }),
            json!({ "id": "{0.0.0.00000000}.{22222222-2222-2222-2222-222222222222}", "name": "Voicemeeter Input (VB-Audio Voicemeeter VAIO)" }),
            json!({ "id": "{0.0.0.00000000}.{33333333-3333-3333-3333-333333333333}", "name": "Headphones (Arctis Nova Pro Wireless)" }),
        ]
    }
    const AUX: &str = "{0.0.0.00000000}.{11111111-1111-1111-1111-111111111111}";
    const PHONES: &str = "{0.0.0.00000000}.{33333333-3333-3333-3333-333333333333}";

    #[test]
    fn any_voicemeeter_input_counts_and_others_dont() {
        *LAST_GOOD.locked() = None;
        let d = devices();
        assert_eq!(describe(&d, AUX, AUX)["state"], "ok");
        let st = describe(&d, PHONES, AUX);
        assert_eq!(st["state"], "wrong");
        assert_eq!(st["output"], "Headphones (Arctis Nova Pro Wireless)");
        assert_eq!(
            describe(&d, AUX, PHONES)["state"],
            "wrong",
            "calls count too"
        );
        puts_back_the_voicemeeter_input_last_used();
    }

    // Called from the test above: both share LAST_GOOD, and tests run in parallel.
    fn puts_back_the_voicemeeter_input_last_used() {
        let d = devices();
        *LAST_GOOD.locked() = None;
        assert_eq!(
            target(&d).unwrap().1,
            "Voicemeeter Input (VB-Audio Voicemeeter VAIO)"
        );
        describe(&d, &AUX.to_uppercase(), AUX);
        assert_eq!(
            target(&d).unwrap().1,
            "Voicemeeter AUX Input (VB-Audio Voicemeeter VAIO)"
        );
        assert!(target(&d[2..]).is_none());
    }
}
