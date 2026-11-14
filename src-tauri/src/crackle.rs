//! Crackle doctor: the usual reasons Voicemeeter crackles, pops or drops out, each checked on
//! this PC and explained, most with a button that fixes it or opens the right Windows page.
//!
//! - a device Windows runs at another sample rate than Voicemeeter (44.1 vs 48 kHz), so
//!   Voicemeeter converts its sound on the fly;
//! - Voicemeeter's audio buffer set very small;
//! - Windows' Power saver plan, which slows the processor down between bursts of work;
//! - Bluetooth outputs, and a Bluetooth headset dropped to call quality (btwatch.rs);
//! - mic clean-up or plugins falling behind.
//!
//! Nothing here changes anything until you press a button.

use crate::endpoints::{self, Endpoint};
use crate::{btwatch, micfx, Vm};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn item(state: &str, label: &str, detail: &str) -> Value {
    json!({ "state": state, "label": label, "detail": detail })
}

/// An item whose button opens a Windows page: "playback", "recording", "power" or "bluetooth".
fn with_page(mut it: Value, button: &str, page: &str) -> Value {
    it["action"] = json!("page");
    it["button"] = json!(button);
    it["page"] = json!(page);
    it
}

fn khz(rate: u32) -> String {
    let k = rate as f64 / 1000.0;
    if k.fract() == 0.0 {
        format!("{k:.0} kHz")
    } else {
        format!("{k:.1} kHz")
    }
}

/// A device Voicemeeter uses: where it sits ("A1", "Input 1") and Windows' entry for it.
struct Used {
    place: String,
    endpoint: Endpoint,
}

fn used_devices(snap: &Value, list: &[Endpoint]) -> Vec<Used> {
    let mut out = Vec::new();
    for (key, capture) in [("strips", true), ("buses", false)] {
        for (i, ch) in snap[key].as_array().into_iter().flatten().enumerate() {
            let Some(name) = ch["device"].as_str().filter(|d| !d.trim().is_empty()) else {
                continue;
            };
            let Some(e) = endpoints::find(list, name, capture) else {
                continue; // ASIO, or a device Windows doesn't list right now
            };
            let place = if capture {
                crate::watch::name_of(snap, "strips", i, &format!("Input {}", i + 1))
            } else {
                format!("A{}", i + 1)
            };
            out.push(Used {
                place,
                endpoint: e.clone(),
            });
        }
    }
    out
}

/// The rate most devices run at, for when Voicemeeter's own isn't known yet.
fn usual_rate(used: &[Used]) -> Option<u32> {
    let mut counts: Vec<(u32, usize)> = Vec::new();
    for u in used {
        if let Some(r) = u.endpoint.rate {
            match counts.iter_mut().find(|c| c.0 == r) {
                Some(c) => c.1 += 1,
                None => counts.push((r, 1)),
            }
        }
    }
    counts.into_iter().max_by_key(|c| (c.1, c.0)).map(|c| c.0)
}

/// Devices whose Windows rate differs from Voicemeeter's, as "A2: Speakers (Realtek) at 44.1 kHz".
fn rate_mismatches(used: &[Used], vm_rate: u32) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for u in used {
        let Some(r) = u.endpoint.rate.filter(|&r| r != vm_rate) else {
            continue;
        };
        let line = format!("{} ({}) at {}", u.endpoint.full, u.place, khz(r));
        if !out.contains(&line) {
            out.push(line);
        }
    }
    out
}

/// A buffer setting that's on the small side: (driver, option, samples, suggested).
fn small_buffers(get: impl Fn(&str) -> Option<f32>) -> Vec<(&'static str, &'static str, u32, u32)> {
    let mut out = Vec::new();
    for (driver, param, low, suggest) in [
        ("WDM", "Option.buffer.wdm", 256, 512),
        ("KS", "Option.buffer.ks", 256, 512),
        ("MME", "Option.buffer.mme", 512, 1024),
    ] {
        // 0 = Voicemeeter's default, which is fine.
        let Some(v) = get(param).map(|v| v.round() as i64).filter(|&v| v > 0) else {
            continue;
        };
        if (v as u32) < low {
            out.push((driver, param, v as u32, suggest));
        }
    }
    out
}

const POWER_SAVER: &str = "a1841308-3541-4fab-bc81-f71556f20b4a";

/// Windows' active power plan GUID, from `powercfg /getactivescheme`.
#[cfg(windows)]
fn power_plan() -> Option<String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("powercfg")
        .arg("/getactivescheme")
        .creation_flags(0x0800_0000) // no console window
        .output()
        .ok()?;
    parse_plan(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(windows))]
fn power_plan() -> Option<String> {
    None
}

/// "Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)" → the GUID.
fn parse_plan(text: &str) -> Option<String> {
    text.split(|c: char| !(c.is_ascii_hexdigit() || c == '-'))
        .find(|w| w.len() == 36 && w.matches('-').count() == 4)
        .map(|w| w.to_lowercase())
}

/// Run every check. Each item is `{ state: ok | warn | bad, label, detail }`, plus a button
/// (`action: "set"` with a Voicemeeter parameter, or `action: "page"` with a Windows page).
pub fn run(app: &AppHandle) -> Vec<Value> {
    let mut out = Vec::new();
    let vm = app.state::<Vm>();
    let snap = vm.last.lock().unwrap().clone();
    let api = vm.api.clone();
    if !snap["connected"].as_bool().unwrap_or(false) {
        out.push(item(
            "warn",
            "Voicemeeter",
            "Start Voicemeeter so the crackle doctor can look at the devices it uses.",
        ));
    }
    let list = endpoints::list();
    let used = used_devices(&snap, &list);

    // Sample rates
    let insert = micfx::insert_rate();
    let option = api
        .as_ref()
        .and_then(|a| a.get_float("Option.sr"))
        .map(|v| v.round() as u32)
        .filter(|&v| v >= 8000);
    let vm_rate = (insert > 0).then_some(insert).or(option);
    if let Some(rate) = vm_rate
        .or_else(|| usual_rate(&used))
        .filter(|_| !used.is_empty())
    {
        let wrong = rate_mismatches(&used, rate);
        if wrong.is_empty() {
            out.push(item(
                "ok",
                "Sample rates",
                &format!(
                    "Every device Voicemeeter uses runs at {}{}.",
                    khz(rate),
                    if vm_rate.is_some() {
                        ", the same as Voicemeeter"
                    } else {
                        ""
                    }
                ),
            ));
        } else {
            let recording = used
                .iter()
                .any(|u| u.endpoint.capture && u.endpoint.rate.is_some_and(|r| r != rate));
            out.push(with_page(
                item(
                    "warn",
                    "Sample rates",
                    &format!(
                        "Voicemeeter runs at {}, but Windows runs {}. Voicemeeter then converts that sound on the fly, a common cause of crackles. In Windows' Sound settings, open the device's Properties → Advanced and pick a {} format.",
                        khz(rate),
                        wrong.join(", "),
                        khz(rate)
                    ),
                ),
                "Open Sound settings",
                if recording { "recording" } else { "playback" },
            ));
        }
    }

    // Voicemeeter's buffer
    if let Some(a) = api.as_ref() {
        let small = small_buffers(|p| a.get_float(p));
        match small.first() {
            None if snap["connected"].as_bool().unwrap_or(false) => out.push(item(
                "ok",
                "Audio buffer",
                "Voicemeeter's buffers are at a safe size.",
            )),
            None => {}
            Some(&(driver, param, now, suggest)) => {
                let ms = |n: u32| n as f64 * 1000.0 / vm_rate.unwrap_or(48000) as f64;
                out.push(json!({
                    "state": "warn",
                    "label": "Audio buffer",
                    "detail": format!(
                        "Voicemeeter's {driver} buffer is {now} samples ({:.1} ms). That's quick, but the PC has to keep up every few milliseconds, and when it can't you hear a crackle. {suggest} samples adds about {:.0} ms of delay and is much safer. Voicemeeter restarts its audio when this changes.",
                        ms(now), ms(suggest - now)
                    ),
                    "action": "set", "button": format!("Use {suggest} samples"),
                    "param": param, "value": suggest,
                }));
            }
        }
    }

    // Power plan
    match power_plan().as_deref() {
        Some(POWER_SAVER) => out.push(with_page(
            item(
                "warn",
                "Power plan",
                "Windows is on Power saver, which slows the processor down between bursts of work, so audio can miss its deadline and crackle. Balanced or High performance avoids that.",
            ),
            "Open Power options",
            "power",
        )),
        Some(_) => out.push(item("ok", "Power plan", "Windows isn't on Power saver.")),
        None => {}
    }

    // Bluetooth
    let calls = btwatch::status();
    for u in calls["users"].as_array().into_iter().flatten() {
        out.push(with_page(
            item(
                "bad",
                "Bluetooth headset in call mode",
                &btwatch::advice(
                    u["device"].as_str().unwrap_or("Your headset"),
                    u["app"].as_str().unwrap_or("An app"),
                ),
            ),
            "Bluetooth settings",
            "bluetooth",
        ));
    }
    let bt_outputs: Vec<String> = used
        .iter()
        .filter(|u| !u.endpoint.capture && u.endpoint.is_bluetooth())
        .map(|u| format!("{} ({})", u.endpoint.full, u.place))
        .collect();
    if !bt_outputs.is_empty() {
        out.push(item(
            "warn",
            "Bluetooth output",
            &format!(
                "Voicemeeter plays to {} over Bluetooth. Bluetooth adds delay and can break up when Wi-Fi is busy or the headset is a room away. If it crackles, try a cable or the headset's own USB dongle.",
                bt_outputs.join(", ")
            ),
        ));
    }

    // Mic clean-up and plugins keeping up
    let fx = micfx::status();
    let behind: u64 = fx["chains"]
        .as_object()
        .map(|m| m.values().filter_map(|c| c["underruns"].as_u64()).sum())
        .unwrap_or(0);
    if behind >= 10 {
        out.push(item(
            "warn",
            "Mic clean-up and plugins",
            &format!(
                "Mic clean-up or a plugin fell behind {behind} times since Sleekmeeter started, and each time the mic skips. A lighter clean-up strength, fewer plugins, or a bigger Voicemeeter buffer helps."
            ),
        ));
    }
    out
}

/// The worst state in a list, for the summary line in Check my setup.
pub fn worst(items: &[Value]) -> &'static str {
    let has = |s: &str| items.iter().any(|i| i["state"] == s);
    if has("bad") {
        "bad"
    } else if has("warn") {
        "warn"
    } else {
        "ok"
    }
}

/// Open one of the Windows pages the crackle doctor's buttons name.
#[cfg(windows)]
pub fn open_page(page: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let (exe, arg) = match page {
        "playback" => ("control", "mmsys.cpl,,0"),
        "recording" => ("control", "mmsys.cpl,,1"),
        "power" => ("control", "powercfg.cpl"),
        "bluetooth" => ("explorer", "ms-settings:bluetooth"),
        _ => return Err("Unknown page".into()),
    };
    std::process::Command::new(exe)
        .arg(arg)
        .creation_flags(0x0800_0000)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open Windows settings: {e}"))
}

#[cfg(not(windows))]
pub fn open_page(_: &str) -> Result<(), String> {
    Err("Windows settings open on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn used(place: &str, full: &str, rate: u32, capture: bool) -> Used {
        Used {
            place: place.into(),
            endpoint: Endpoint {
                capture,
                full: full.into(),
                rate: Some(rate),
                active: true,
                ..Default::default()
            },
        }
    }

    #[test]
    fn finds_devices_at_another_rate() {
        let list = vec![
            used("A1", "Headphones (FiiO K11)", 48000, false),
            used("A2", "Speakers (Realtek USB Audio)", 44100, false),
            used("Mic", "Microphone (Shure MV7+)", 48000, true),
        ];
        assert_eq!(
            rate_mismatches(&list, 48000),
            vec!["Speakers (Realtek USB Audio) (A2) at 44.1 kHz".to_string()]
        );
        assert!(rate_mismatches(&list[..1], 48000).is_empty());
        assert_eq!(usual_rate(&list), Some(48000));
        assert_eq!(khz(48000), "48 kHz");
        assert_eq!(khz(44100), "44.1 kHz");
    }

    #[test]
    fn flags_only_small_buffers() {
        let get = |p: &str| match p {
            "Option.buffer.wdm" => Some(128.0),
            "Option.buffer.ks" => Some(0.0),
            "Option.buffer.mme" => Some(1024.0),
            _ => None,
        };
        assert_eq!(
            small_buffers(get),
            vec![("WDM", "Option.buffer.wdm", 128, 512)]
        );
        assert!(small_buffers(|_| Some(512.0)).is_empty());
        assert!(small_buffers(|_| None).is_empty());
    }

    #[test]
    fn reads_the_power_plan() {
        let text = "Power Scheme GUID: a1841308-3541-4fab-bc81-f71556f20b4a  (Power saver)\r\n";
        assert_eq!(parse_plan(text).as_deref(), Some(POWER_SAVER));
        assert_eq!(parse_plan("nothing here"), None);
    }

    #[test]
    fn worst_state_wins() {
        let ok = item("ok", "a", "");
        let warn = item("warn", "b", "");
        assert_eq!(worst(&[ok.clone()]), "ok");
        assert_eq!(worst(&[ok.clone(), warn.clone()]), "warn");
        assert_eq!(worst(&[warn, item("bad", "c", "")]), "bad");
    }
}

#[cfg(test)]
pub fn power_plan_for_test() -> Option<String> {
    power_plan()
}
