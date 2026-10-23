//! Smooth fades and talk-over ducking, wired to Voicemeeter. The timing logic is in gain.rs.
//!
//! - Mute fades out and then mutes; unmute fades back in.
//! - Typed levels, double-click to 0 dB and volume shortcuts glide instead of jumping.
//! - Scenes fade to their levels before the rest of the scene loads.
//! - Ducking: while the chosen input (usually the mic) is above the threshold, the chosen
//!   channels fade down by a set amount, and fade back after a short quiet spell.

use crate::gain::{fade_line, CEIL, FLOOR};
use crate::vm::{Api, Layout};
use crate::{Settings, Vm};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Glide time for typed levels and double-click to 0 dB.
const GLIDE_MS: u64 = 300;
/// Glide time for each press of a volume shortcut.
const NUDGE_MS: u64 = 120;

pub struct Fades {
    pub on: bool,
    pub mute_ms: u64,
    pub scene_ms: u64,
}

pub fn fades(s: &Value) -> Fades {
    let f = &s["fades"];
    Fades {
        on: f["on"].as_bool().unwrap_or(true),
        mute_ms: f["muteMs"].as_u64().unwrap_or(250).clamp(20, 3000),
        scene_ms: f["sceneMs"].as_u64().unwrap_or(1200).clamp(100, 10_000),
    }
}

pub struct Ducking {
    pub on: bool,
    pub trigger: usize,
    pub targets: Vec<String>,
    pub amount: f32,
    pub threshold: f32,
    pub attack_ms: u64,
    pub release_ms: u64,
    pub hold_ms: u64,
}

/// "Strip[3]" → 3
fn strip_index(key: &str) -> Option<usize> {
    key.strip_prefix("Strip[")?.strip_suffix(']')?.parse().ok()
}

pub fn ducking(s: &Value) -> Ducking {
    let d = &s["ducking"];
    let trigger = d["trigger"].as_str().and_then(strip_index).unwrap_or(0);
    let targets = d["targets"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|t| t.as_str())
                .filter(|t| strip_index(t).map(|i| i != trigger).unwrap_or(false))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    Ducking {
        on: d["on"].as_bool().unwrap_or(false),
        trigger,
        targets,
        amount: d["amount"].as_f64().unwrap_or(12.0).clamp(1.0, 60.0) as f32,
        threshold: d["threshold"].as_f64().unwrap_or(-40.0).clamp(-80.0, 0.0) as f32,
        attack_ms: d["attackMs"].as_u64().unwrap_or(150).clamp(10, 3000),
        release_ms: d["releaseMs"].as_u64().unwrap_or(800).clamp(50, 5000),
        hold_ms: d["holdMs"].as_u64().unwrap_or(700).clamp(0, 5000),
    }
}

/// "Strip[3].Gain" → ("Strip[3]", "Gain"), only for strips and buses.
fn split(name: &str) -> Option<(&str, &str)> {
    if !(name.starts_with("Strip[") || name.starts_with("Bus[")) {
        return None;
    }
    let i = name.find("].")?;
    Some((&name[..=i], &name[i + 2..]))
}

fn current_fades(app: &AppHandle) -> Fades {
    fades(&app.state::<Settings>().0.lock().unwrap())
}

fn gain_of(api: &Api, key: &str) -> f32 {
    api.get_float(&format!("{key}.Gain")).unwrap_or(0.0)
}

/// Every write from the mixer goes through here: mutes fade, and a ducked fader keeps
/// ducking while you move it.
pub fn set_float(app: &AppHandle, api: &Api, name: &str, value: f32) -> Result<(), String> {
    if let Some((key, param)) = split(name) {
        match param {
            "Mute" => return mute(app, api, key, value != 0.0),
            "Gain" => {
                let lines =
                    app.state::<Vm>()
                        .smooth
                        .lock()
                        .unwrap()
                        .set_direct(key, value, Instant::now());
                if let Some(lines) = lines {
                    return api.script(&lines);
                }
            }
            _ => {}
        }
    }
    api.set_float(name, value)
}

/// Mute or unmute, fading when fades are on.
pub fn mute(app: &AppHandle, api: &Api, key: &str, want: bool) -> Result<(), String> {
    let f = current_fades(app);
    let vm = app.state::<Vm>();
    if !f.on {
        // A fade may still be running from before fades were turned off.
        if vm.smooth.lock().unwrap().is_managed(key) {
            let lines = vm.smooth.lock().unwrap().mute(
                key,
                gain_of(api, key),
                api.get_bool(&format!("{key}.Mute")),
                want,
                20,
                Instant::now(),
            );
            return api.script(&lines);
        }
        return api.set_float(&format!("{key}.Mute"), if want { 1.0 } else { 0.0 });
    }
    let gain = gain_of(api, key);
    let muted = api.get_bool(&format!("{key}.Mute"));
    let lines = vm
        .smooth
        .lock()
        .unwrap()
        .mute(key, gain, muted, want, f.mute_ms, Instant::now());
    api.script(&lines)
}

/// Mute or unmute within `ms`, whatever the fade setting (push to talk needs to be quick).
pub fn mute_quick(
    app: &AppHandle,
    api: &Api,
    key: &str,
    want: bool,
    ms: u64,
) -> Result<(), String> {
    let gain = gain_of(api, key);
    let muted = api.get_bool(&format!("{key}.Mute"));
    let lines =
        app.state::<Vm>()
            .smooth
            .lock()
            .unwrap()
            .mute(key, gain, muted, want, ms, Instant::now());
    api.script(&lines)
}

/// Flip mute (shortcuts). Returns the new state.
pub fn toggle_mute(app: &AppHandle, api: &Api, key: &str) -> Result<bool, String> {
    let actual = api.get_bool(&format!("{key}.Mute"));
    let shown = app
        .state::<Vm>()
        .smooth
        .lock()
        .unwrap()
        .is_muted(key, actual);
    mute(app, api, key, !shown)?;
    Ok(!shown)
}

/// Glide to a level (typed values, double-click to 0 dB).
pub fn glide(app: &AppHandle, api: &Api, key: &str, target: f32) -> Result<(), String> {
    glide_ms(app, api, key, target, GLIDE_MS)
}

fn glide_ms(app: &AppHandle, api: &Api, key: &str, target: f32, ms: u64) -> Result<(), String> {
    let target = target.clamp(FLOOR, CEIL);
    if !current_fades(app).on {
        return set_float(app, api, &format!("{key}.Gain"), target);
    }
    let lines = app
        .state::<Vm>()
        .smooth
        .lock()
        .unwrap()
        .glide(key, target, ms, Instant::now());
    api.script(&lines)
}

/// Turn a channel up or down (shortcuts). Quick repeated presses add up.
pub fn nudge(app: &AppHandle, api: &Api, key: &str, delta: f32) -> Result<f32, String> {
    let actual = gain_of(api, key);
    let from = app
        .state::<Vm>()
        .smooth
        .lock()
        .unwrap()
        .current(key, actual, Instant::now());
    let target = (from + delta).clamp(FLOOR, CEIL);
    glide_ms(app, api, key, target, NUDGE_MS)?;
    Ok(target)
}

/// Runs on every poll tick while Voicemeeter is connected (poll thread only: reads levels).
pub fn tick(app: &AppHandle, api: &Api, layout: &Layout) {
    let now = Instant::now();
    let d = ducking(&app.state::<Settings>().0.lock().unwrap());
    let vm = app.state::<Vm>();
    let mut smooth = vm.smooth.lock().unwrap();
    let mut lines = smooth.tick(now);
    let mut used = vm.duck_targets.lock().unwrap();
    let usable = d.on && d.trigger < layout.strips() && !d.targets.is_empty();
    if usable {
        // The targets changed while ducking: let go, and duck the new ones next time.
        if smooth.ducked && *used != d.targets {
            lines.extend(smooth.unduck(300, now));
        }
        let level = api.strip_level(layout, d.trigger);
        match smooth.sense(level, d.threshold, d.hold_ms, now) {
            Some(true) => {
                let targets: Vec<(String, f32)> = d
                    .targets
                    .iter()
                    .filter(|k| strip_index(k).map(|i| i < layout.strips()).unwrap_or(false))
                    .map(|k| (k.clone(), gain_of(api, k)))
                    .collect();
                lines.extend(smooth.duck(&targets, d.amount, d.attack_ms, now));
                *used = d.targets.clone();
            }
            Some(false) => lines.extend(smooth.unduck(d.release_ms, now)),
            None => {}
        }
    } else if smooth.ducked {
        lines.extend(smooth.unduck(d.release_ms, now));
    }
    drop(used);
    drop(smooth);
    if !lines.is_empty() {
        if let Err(e) = api.script(&lines) {
            log_warn!("Fade/ducking command rejected: {e} ({})", lines.join(" "));
        }
    }
}

/// Show each channel at the level the person chose, not the level ducking or a mute fade
/// has it at right now. Someone else moving a managed channel ends the management.
pub fn dress(app: &AppHandle, snap: &mut Value) {
    let now = Instant::now();
    let vm = app.state::<Vm>();
    let mut smooth = vm.smooth.lock().unwrap();
    for (list, prefix) in [("strips", "Strip"), ("buses", "Bus")] {
        let Some(items) = snap[list].as_array_mut() else {
            continue;
        };
        for (i, ch) in items.iter_mut().enumerate() {
            let key = format!("{prefix}[{i}]");
            let actual = ch["gain"].as_f64().unwrap_or(0.0) as f32;
            smooth.reconcile(&key, actual, now);
            if let Some(v) = smooth.view(&key) {
                ch["gain"] = json!(((v.gain as f64) * 100.0).round() / 100.0);
                if let Some(m) = v.mute {
                    ch["mute"] = json!(m);
                }
                if v.ducked {
                    ch["ducked"] = json!(true);
                }
            }
        }
    }
}

/// Voicemeeter went away or Sleekmeeter is quitting: put ducked levels straight back.
pub fn release(app: &AppHandle, api: Option<&Api>) {
    let lines = app.state::<Vm>().smooth.lock().unwrap().release_all();
    if let Some(api) = api {
        let _ = api.script(&lines);
    }
}

/* ---------------- scenes ---------------- */

/// Each scene gets a small file with its levels next to the XML, so loading it can fade.
fn levels_path(xml: &Path) -> PathBuf {
    xml.with_extension("levels.json")
}

/// Record the levels of the mix being saved as a scene (the levels the person chose).
pub fn save_levels(app: &AppHandle, xml: &Path) {
    let snap = app.state::<Vm>().last.lock().unwrap().clone();
    let mut map = Map::new();
    for (list, prefix) in [("strips", "Strip"), ("buses", "Bus")] {
        for (i, ch) in snap[list].as_array().into_iter().flatten().enumerate() {
            map.insert(
                format!("{prefix}[{i}]"),
                json!({ "gain": ch["gain"], "mute": ch["mute"] }),
            );
        }
    }
    if !map.is_empty() {
        let _ = std::fs::write(levels_path(xml), Value::Object(map).to_string());
    }
}

pub fn delete_levels(xml: &Path) {
    let _ = std::fs::remove_file(levels_path(xml));
}

/// Load a scene. With fades on, levels fade to the scene's first, then the scene loads.
/// `done` is emitted as "scene-auto" when the scene is in (automatic switching).
pub fn load_scene(app: &AppHandle, xml: PathBuf, done: Option<Value>) -> Result<(), String> {
    let api = app
        .state::<Vm>()
        .api
        .clone()
        .ok_or("Voicemeeter isn't installed")?;
    let f = current_fades(app);
    let levels: Option<Map<String, Value>> = std::fs::read_to_string(levels_path(&xml))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned());
    let app = app.clone();
    let Some(levels) = levels.filter(|_| f.on) else {
        app.state::<Vm>()
            .smooth
            .lock()
            .unwrap()
            .forget(Instant::now(), Duration::from_millis(1500));
        api.set_string("Command.Load", &xml.to_string_lossy())?;
        if let Some(e) = done {
            let _ = app.emit("scene-auto", e);
        }
        // An older scene without a levels file: record its levels so it fades next time.
        if !levels_path(&xml).exists() {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(900));
                if xml.exists() {
                    save_levels(&app, &xml);
                }
            });
        }
        return Ok(());
    };
    std::thread::spawn(move || {
        let ms = f.scene_ms;
        app.state::<Vm>()
            .smooth
            .lock()
            .unwrap()
            .forget(Instant::now(), Duration::from_millis(ms + 1500));
        let mut lines = Vec::new();
        for (key, lv) in levels.iter() {
            if api.get_float(&format!("{key}.Gain")).is_none()
                || api.get_bool(&format!("{key}.Mute"))
            {
                continue; // not in this edition, or muted now: nothing to hear
            }
            let target = if lv["mute"].as_bool().unwrap_or(false) {
                FLOOR
            } else {
                lv["gain"].as_f64().unwrap_or(0.0) as f32
            };
            lines.push(fade_line(key, target, ms));
        }
        if let Err(e) = api.script(&lines) {
            log_warn!("Scene fade rejected: {e}");
        }
        std::thread::sleep(Duration::from_millis(ms + 60));
        if let Err(e) = api.set_string("Command.Load", &xml.to_string_lossy()) {
            log_error!("Loading scene file failed: {e}");
            return;
        }
        if let Some(e) = done {
            let _ = app.emit("scene-auto", e);
        }
        // A scene saved while ducking holds the ducked level: bring those back up.
        std::thread::sleep(Duration::from_millis(500));
        let mut fix = Vec::new();
        for (key, lv) in levels.iter() {
            let want = lv["gain"].as_f64().unwrap_or(0.0) as f32;
            if let Some(now) = api.get_float(&format!("{key}.Gain")) {
                if (now - want).abs() > 0.2 {
                    fix.push(fade_line(key, want, 250));
                }
            }
        }
        let _ = api.script(&fix);
    });
    Ok(())
}
