//! Live game/chat balance shared by the mixer and shortcut actions.
use crate::{api, fades, vm::Api, Layout, Settings, SettingsDirty, Vm};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Deserialize, Serialize, PartialEq)]
pub struct Selection {
    game: String,
    chat: String,
    #[serde(default)]
    bus: String,
}

#[derive(Deserialize, Serialize)]
struct Balance {
    selection: Selection,
    edition: i32,
    position: i32,
    centre: [f32; 2],
    applied: [f32; 2],
}

static LIVE: Mutex<Option<Balance>> = Mutex::new(None);

fn index(key: &str, kind: &str) -> Option<usize> {
    key.strip_prefix(kind)?
        .strip_prefix('[')?
        .strip_suffix(']')?
        .parse()
        .ok()
}

fn near(a: f32, b: f32) -> bool {
    (a - b).abs() <= 0.15
}

fn levels(api: &Api, names: &[String; 2]) -> Result<[f32; 2], String> {
    let read = |name: &str| {
        api.get_float(name)
            .filter(|v| v.is_finite())
            .ok_or_else(|| format!("Voicemeeter did not report {name}."))
    };
    Ok([read(&names[0])?, read(&names[1])?])
}

fn summary(live: &Option<Balance>) -> Value {
    match live {
        Some(b) => {
            json!({ "position": b.position, "levels": b.applied, "selection": b.selection, "edition": b.edition })
        }
        None => json!({ "position": 0 }),
    }
}

fn load(app: &AppHandle, live: &mut Option<Balance>) {
    if live.is_none() {
        *live = serde_json::from_value(
            app.state::<Settings>().0.lock().unwrap()["chatBalanceLive"].clone(),
        )
        .ok();
    }
}

fn remember(app: &AppHandle, live: &Option<Balance>) {
    app.state::<Settings>().0.lock().unwrap()["chatBalanceLive"] = json!(live);
    app.state::<SettingsDirty>().0.store(true, Ordering::SeqCst);
}

pub fn status(app: &AppHandle) -> Value {
    let mut live = LIVE.lock().unwrap();
    load(app, &mut live);
    summary(&live)
}

/// A relative request uses the saved selection and serializes with slider changes.
pub fn change(
    app: &AppHandle,
    selection: Option<Selection>,
    amount: i32,
    relative: bool,
    use_main: bool,
) -> Result<Value, String> {
    let vm = app.state::<Vm>();
    let api = api(&vm)?;
    let edition = api
        .edition()
        .ok_or("Start Voicemeeter to adjust Game / Chat.")?;
    let layout = Layout::for_edition(edition);
    let mut live = LIVE.lock().unwrap();
    load(app, &mut live);
    if live.as_ref().is_some_and(|b| b.edition != edition) {
        *live = None;
        remember(app, &live);
    }
    if use_main && edition != 3 {
        return Err("Main-level recovery is for Voicemeeter Potato.".into());
    }
    let position = if relative {
        live.as_ref().map_or(0, |b| b.position) + amount
    } else {
        amount
    }
    .clamp(-100, 100);
    if position == 0 && live.is_none() && !use_main {
        return Ok(summary(&live));
    }
    let selection = match selection {
        Some(s) => s,
        None => match live.as_ref() {
            Some(b) => b.selection.clone(),
            None => serde_json::from_value(
                app.state::<Settings>().0.lock().unwrap()["chatBalance"].clone(),
            )
            .map_err(|_| "Open Game / Chat and save your input and output assignments.")?,
        },
    };
    if live.as_ref().is_some_and(|b| b.selection != selection) {
        return Err("Restore centre before changing Game / Chat assignments.".into());
    }
    let strip = |name: &str| {
        index(name, "Strip")
            .filter(|&i| i < layout.strips())
            .ok_or("Choose a valid Voicemeeter input for both Game and Chat.")
    };
    let strips = [strip(&selection.game)?, strip(&selection.chat)?];
    if strips[0] == strips[1] {
        return Err("Choose separate Game and Chat inputs.".into());
    }
    let suffix = if edition == 3 {
        let bus = index(&selection.bus, "Bus")
            .filter(|&i| i < layout.hw_buses)
            .ok_or("Choose a hardware listening output.")?;
        if position != 0 {
            let output = format!("Bus[{bus}]");
            if api
                .get_string(&format!("{output}.device.name"))
                .unwrap_or_default()
                .is_empty()
                || api.get_bool(&format!("{output}.Mute"))
            {
                return Err(
                    "Select an active, unmuted playback device for the listening output.".into(),
                );
            }
            if api.get_bool(&format!("{output}.mode.Composite")) {
                return Err("The listening output is in Composite mode. Use Normal mode or choose another listening output.".into());
            }
            for i in strips {
                if !api.get_bool(&format!("Strip[{i}].A{}", bus + 1)) {
                    return Err(format!("Both inputs must be routed to A{}.", bus + 1));
                }
            }
        }
        format!("GainLayer[{bus}]")
    } else {
        "Gain".into()
    };
    let names = strips.map(|i| format!("Strip[{i}].{suffix}"));
    let current = levels(api, &names)?;
    let centre: [f32; 2] = std::array::from_fn(|i| match live.as_ref() {
        Some(previous) if near(current[i], previous.applied[i]) => previous.centre[i],
        _ => current[i],
    });
    let next = if use_main {
        levels(api, &strips.map(|i| format!("Strip[{i}].Gain")))?
    } else {
        target_levels(centre, position)
    };
    let write = |targets: [f32; 2]| -> Result<(), String> {
        if edition == 3 {
            api.script(
                &names
                    .iter()
                    .zip(targets)
                    .map(|(name, v)| format!("{name} = {v:.2};"))
                    .collect::<Vec<_>>(),
            )
        } else {
            for (name, target) in names.iter().zip(targets) {
                fades::set_float(app, api, name, target)?;
            }
            Ok(())
        }
    };
    write(next).inspect_err(|_| {
        let _ = write(current);
    })?;
    // The API setter acknowledges the command before its parameter cache reflects it.
    // The normal poll thread refreshes the cache. Wait for both reads before reporting success.
    for _ in 0..12 {
        if let Ok(actual) = levels(api, &names) {
            if actual.iter().zip(next).all(|(&a, b)| near(a, b)) {
                *live = (position != 0).then_some(Balance {
                    selection,
                    edition,
                    position,
                    centre,
                    applied: actual,
                });
                remember(app, &live);
                let mut value = summary(&live);
                value["levels"] = json!(actual);
                let _ = app.emit("chat-balance", &value);
                return Ok(value);
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let _ = write(current);
    Err(
        "Voicemeeter did not confirm both fader changes. Check the listening output and try again."
            .into(),
    )
}

fn target_levels(centre: [f32; 2], position: i32) -> [f32; 2] {
    // Full travel isolates one side. The centre always restores the user's original levels.
    std::array::from_fn(|i| {
        let amount = if i == 0 {
            position.max(0)
        } else {
            (-position).max(0)
        };
        if amount == 100 {
            -60.0
        } else {
            (centre[i] - amount as f32 * 0.30).max(-60.0)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn balance_only_attenuates_the_opposite_side_and_can_isolate_it() {
        assert_eq!(target_levels([-10.0, -6.0], -50), [-10.0, -21.0]);
        assert_eq!(target_levels([-10.0, -6.0], 50), [-25.0, -6.0]);
        assert_eq!(target_levels([-10.0, -6.0], 100), [-60.0, -6.0]);
        assert_eq!(target_levels([-10.0, -6.0], 0), [-10.0, -6.0]);
    }
}
