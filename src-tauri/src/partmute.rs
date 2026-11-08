//! Mute on one output: an input muted on some outputs only (B1, B2 …), from right-clicking
//! Mute in the mixer or the tray panel, a Stream Deck key or Sleekmeeter Remote.
//!
//! Muting switches the input's send to that output off (fades.rs route_mute, with a fade on
//! Potato) and remembers which sends it switched off, in settings.json under `partMute`
//! (`{ "strip-0": ["B1", "B2"] }`), so unmuting turns back on exactly those, also after a restart.
//! Sending the input to that output again any other way ends the mute for that output.

use crate::vm::Api;
use crate::{fades, settings, Settings};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Right after Sleekmeeter switches a send, Voicemeeter can still report the old state (and on
/// Potato the send only switches off after the fade), so don't read it back for a moment.
const SETTLE: Duration = Duration::from_millis(2500);

static CHANGED: Mutex<Option<HashMap<usize, Instant>>> = Mutex::new(None);

fn touch(i: usize) {
    CHANGED
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(i, Instant::now());
}

fn settled(i: usize) -> bool {
    CHANGED
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.get(&i))
        .map(|t| t.elapsed() >= SETTLE)
        .unwrap_or(true)
}

/// "A1" … "A5", "B1" … "B3".
pub fn is_output(out: &str) -> bool {
    let mut c = out.chars();
    matches!(c.next(), Some('A') | Some('B'))
        && matches!(c.next(), Some('1'..='5'))
        && c.next().is_none()
}

/// The outputs input `i` is muted on.
pub fn list(s: &Value, i: usize) -> Vec<String> {
    s["partMute"][format!("strip-{i}")]
        .as_array()
        .map(|l| {
            l.iter()
                .filter_map(|x| x.as_str())
                .filter(|x| is_output(x))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Save input `i`'s list and tell the windows.
fn store(app: &AppHandle, i: usize, outs: &[String]) {
    let map = {
        let state = app.state::<Settings>();
        let mut s = state.0.lock().unwrap();
        if !s["partMute"].is_object() {
            s["partMute"] = json!({});
        }
        let key = format!("strip-{i}");
        if outs.is_empty() {
            if let Some(m) = s["partMute"].as_object_mut() {
                m.remove(&key);
            }
        } else {
            s["partMute"][key] = json!(outs);
        }
        let _ = settings::save(&s);
        s["partMute"].clone()
    };
    let _ = app.emit("part-mute", map);
}

/// Mute input `i` on one output, or unmute it there.
pub fn set(
    app: &AppHandle,
    api: &Arc<Api>,
    i: usize,
    out: &str,
    mute: bool,
) -> Result<(), String> {
    if !is_output(out) {
        return Err(format!("{out:?} isn't an output"));
    }
    fades::route_mute(app, api, i, out, mute)?;
    touch(i);
    let mut outs = list(&app.state::<Settings>().0.lock().unwrap(), i);
    outs.retain(|o| o != out);
    if mute {
        outs.push(out.to_string());
    }
    store(app, i, &outs);
    Ok(())
}

/// One press of a "Mute on outputs" key: if the input is muted on any of `outs`, unmute it
/// there; otherwise mute it on each of `outs` it's sent to. Returns whether it's muted now.
pub fn toggle(app: &AppHandle, api: &Arc<Api>, i: usize, outs: &[String]) -> Result<bool, String> {
    let outs: Vec<&String> = outs.iter().filter(|o| is_output(o)).collect();
    if outs.is_empty() {
        return Err("Choose at least one output".into());
    }
    let now = list(&app.state::<Settings>().0.lock().unwrap(), i);
    let muted: Vec<&&String> = outs.iter().filter(|o| now.contains(o)).collect();
    if !muted.is_empty() {
        for o in muted {
            set(app, api, i, o, false)?;
        }
        log_info!("Unmuted Strip[{i}] on {}", join(&outs));
        return Ok(false);
    }
    let sent: Vec<&&String> = outs
        .iter()
        .filter(|o| api.get_bool(&format!("Strip[{i}].{o}")))
        .collect();
    if sent.is_empty() {
        return Err(format!("This input isn't sent to {}", join(&outs)));
    }
    for o in &sent {
        set(app, api, i, o, true)?;
    }
    log_info!("Muted Strip[{i}] on {}", join(&outs));
    Ok(true)
}

fn join(outs: &[&String]) -> String {
    outs.iter()
        .map(|o| o.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// "Strip[0]:B1,B2,B3" → (0, ["B1", "B2", "B3"]), for shortcuts, the remote and the Stream Deck.
pub fn parse_target(target: &str) -> Option<(usize, Vec<String>)> {
    let (strip, outs) = target.split_once(':')?;
    let i = strip.strip_prefix("Strip[")?.strip_suffix(']')?.parse().ok()?;
    let outs: Vec<String> = outs
        .split(',')
        .map(|o| o.trim().to_uppercase())
        .filter(|o| is_output(o))
        .collect();
    (!outs.is_empty()).then_some((i, outs))
}

/// Add each input's `partMute` list to a mixer snapshot, and forget outputs the input has been
/// sent to again in the meantime (Voicemeeter, a scene, the A/B button).
pub fn dress(app: &AppHandle, snap: &mut Value) {
    let Some(strips) = snap["strips"].as_array_mut() else {
        return;
    };
    let s = app.state::<Settings>().0.lock().unwrap().clone();
    for (i, ch) in strips.iter_mut().enumerate() {
        let outs = list(&s, i);
        let kept: Vec<String> = if settled(i) {
            outs.iter()
                .filter(|o| {
                    let n: usize = o[1..].parse().unwrap_or(0);
                    let on = &ch[if o.starts_with('A') { "a" } else { "b" }][n.wrapping_sub(1)];
                    !(on.as_u64() == Some(1) || on.as_bool() == Some(true))
                })
                .cloned()
                .collect()
        } else {
            outs.clone()
        };
        if kept.len() != outs.len() {
            log_info!("Strip[{i}] was sent to an output again; its mute there ended");
            store(app, i, &kept);
        }
        ch["partMute"] = json!(kept);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_name_an_input_and_its_outputs() {
        assert_eq!(
            parse_target("Strip[2]:B1,b2, B3"),
            Some((2, vec!["B1".into(), "B2".into(), "B3".into()]))
        );
        assert_eq!(parse_target("Strip[0]:A1"), Some((0, vec!["A1".into()])));
        assert_eq!(parse_target("Strip[0]:"), None);
        assert_eq!(parse_target("Bus[0]:B1"), None);
        assert_eq!(parse_target("Strip[0]:Gain"), None);
    }

    #[test]
    fn lists_only_hold_outputs() {
        let s = json!({ "partMute": { "strip-1": ["B1", "Mute", "A9", "B3"] } });
        assert_eq!(list(&s, 1), vec!["B1".to_string(), "B3".to_string()]);
        assert!(list(&s, 0).is_empty());
    }
}
