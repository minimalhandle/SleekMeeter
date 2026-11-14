// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// The default settings are one large json! literal.
#![recursion_limit = "256"]

// First, so its log_info!/log_warn!/log_error! macros work in every module below.
#[macro_use]
mod logs;
mod actions;
mod apps;
mod appvol;
mod audio_events;
mod backups;
mod brb;
mod btwatch;
mod chat_balance;
mod coach;
mod crackle;
mod devwatch;
mod endpoints;
mod fades;
mod files;
mod gain;
mod golive;
mod health;
mod history;
mod hold;
mod layers;
mod loudness;
mod mic_tune;
mod micfx;
mod soundfx;
mod micpreset;
mod midi;
mod notes;
mod obs;
mod outputs;
mod partmute;
mod pluginhost;
mod recorder;
mod recover;
mod remote;
mod replay;
mod routing;
mod selftest;
mod settings;
mod sounds;
mod streamdeck;
mod twitch;
mod update;
mod usage;
mod vm;
#[cfg_attr(not(windows), path = "vst_off.rs")]
mod vst;
mod watch;
mod win;
mod winout;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, RunEvent, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use vm::{Api, Layout};

/// Shared between the poll thread and the command handlers.
struct Vm {
    api: Option<Arc<Api>>,
    last: Mutex<Value>,
    /// Keep hiding Voicemeeter's window until this moment (it reappears while starting up).
    hide_vm_until: Mutex<Option<Instant>>,
    /// Hide the volume overlay at this moment.
    osd_until: Mutex<Option<Instant>>,
    /// Fades, fading mute and ducking (see gain.rs and fades.rs).
    smooth: Mutex<gain::Smooth>,
    /// The channels ducking lowered last time.
    duck_targets: Mutex<Vec<String>>,
    /// Voicemeeter's recorder: what it's doing and its clock.
    rec: Mutex<recorder::RecState>,
    /// Push-to-talk and push-to-mute shortcuts that are being held (see hold.rs).
    holds: Mutex<hold::Holds>,
    /// Be right back: what to put back when it ends (see brb.rs).
    brb: Mutex<brb::Brb>,
}

struct Settings(Mutex<Value>);
/// The theme an app rule asked for right now ("" = the one you chose). Not saved.
static AUTO_THEME: Mutex<String> = Mutex::new(String::new());
struct Hotkeys(Mutex<Vec<(Shortcut, Value)>>);
struct NormalSize(Mutex<Option<LogicalSize<f64>>>);
/// Last size the tray panel asked for (logical px), so it reopens at the right size.
struct PanelSize(Mutex<Option<(f64, f64)>>);
/// Show the main window once the page has drawn (avoids a blank or see-through flash).
struct ShowOnReady(std::sync::atomic::AtomicBool);
/// Release notes waiting to be shown once, after an update.
struct WhatsNew(Mutex<Vec<Value>>);

/// "What's new": the notes waiting since an update (handed out once), or with `all`, the
/// latest versions' notes for the button in Settings.
#[tauri::command]
fn whats_new(state: State<'_, WhatsNew>, all: bool) -> Value {
    if all {
        return json!({ "version": update::CURRENT, "sections": notes::recent() });
    }
    let sections = std::mem::take(&mut *state.0.lock().unwrap());
    json!({ "version": update::CURRENT, "sections": sections })
}
/// Window size/position changed and settings.json needs saving (written at most once a second).
struct SettingsDirty(std::sync::atomic::AtomicBool);
/// No window size was saved when Sleekmeeter started: fit the window to the mixer once.
struct FirstLaunch(std::sync::atomic::AtomicBool);
/// Tells a single tray click apart from a double-click.
struct TrayClicks {
    gen: AtomicU64,
    last_double: Mutex<Option<Instant>>,
}

const FLYOUT: &str = "flyout";
/// The Output mix popped out into its own window.
const MIXWIN: &str = "mixwin";
const MIXWIN_MIN: (f64, f64) = (480.0, 300.0);

fn offline_state(installed: bool) -> Value {
    json!({ "installed": installed, "connected": false })
}

fn api<'a>(vm: &'a State<'_, Vm>) -> Result<&'a Arc<Api>, String> {
    vm.api
        .as_ref()
        .ok_or_else(|| "Voicemeeter isn't installed".to_string())
}

/* ---------------- mixer commands ---------------- */

#[tauri::command]
fn vm_snapshot(vm: State<'_, Vm>) -> Value {
    vm.last.lock().unwrap().clone()
}

#[tauri::command]
fn vm_set_float(app: AppHandle, vm: State<'_, Vm>, name: String, value: f32) -> Result<(), String> {
    if name.starts_with("Command.") {
        log_info!("{name} = {value}");
    }
    fades::set_float(&app, api(&vm)?, &name, value)
        .inspect_err(|e| log_warn!("Setting {name} = {value} failed: {e}"))
}

/// Read mic-chain parameters (compressor, gate, denoiser) for the Mic chain panel. A parameter
/// this edition doesn't have comes back as null, which is how the panel knows what to show.
#[tauri::command]
fn mic_tune_meter(vm: State<'_, Vm>, strip: Option<usize>) -> Result<(), String> {
    if strip.is_none() {
        mic_tune::stop_meter();
        return Ok(());
    }
    mic_tune::meter(api(&vm)?, strip)
}

#[tauri::command]
fn mic_tune_change(
    app: AppHandle,
    strip: usize,
    expected: mic_tune::Tune,
    next: mic_tune::Tune,
    preview: bool,
) -> Result<(), String> {
    mic_tune::change(&app, strip, expected, next, preview)
}

#[tauri::command]
fn mic_tune_finish(app: AppHandle, keep: bool) -> Result<bool, String> {
    mic_tune::finish(&app, keep, false)
}

/// Crackle doctor: the usual reasons for crackles and dropouts, checked on this PC.
#[tauri::command]
async fn crackle_check(app: AppHandle) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || crackle::run(&app))
        .await
        .map_err(|e| e.to_string())
}

/// Open a Windows page a crackle doctor button names ("playback", "recording", "power", "bluetooth").
#[tauri::command]
fn open_windows_page(page: String) -> Result<(), String> {
    crackle::open_page(&page)
}

/// Who has a Bluetooth headset in call mode: { users: [{ device, app }] }.
#[tauri::command]
fn bt_status() -> Value {
    btwatch::status()
}

/// Mic coach: start listening to an input ("Strip[0]").
#[tauri::command]
fn coach_start(app: AppHandle, target: String) -> Result<(), String> {
    let edition = app.state::<Vm>().last.lock().unwrap()["edition"]
        .as_i64()
        .unwrap_or(2) as i32;
    coach::start(&Layout::for_edition(edition), &target)
}

#[tauri::command]
fn coach_stop() {
    coach::stop();
}

#[tauri::command]
fn coach_status() -> Value {
    coach::status()
}

#[tauri::command]
async fn audio_events_list() -> Result<Vec<audio_events::Event>, String> {
    tauri::async_runtime::spawn_blocking(audio_events::list)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn audio_events_clear(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || audio_events::clear(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn vm_get_floats(vm: State<'_, Vm>, names: Vec<String>) -> Result<Vec<Option<f32>>, String> {
    let a = api(&vm)?;
    Ok(names
        .iter()
        .map(|n| {
            if readable_param(n) {
                a.get_float(n)
            } else {
                None
            }
        })
        .collect())
}

/// Parameters the panels may read: the mic chain ("Strip[2].Comp", "Strip[0].Gate.Threshold",
/// "Strip[1].Denoiser") and Voicemeeter's own options ("Option.sr", "Option.buffer.wdm").
fn readable_param(name: &str) -> bool {
    if let Some(rest) = name.strip_prefix("Option.") {
        return rest.len() < 24
            && rest
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '[' || c == ']');
    }
    chain_param(name)
        || name
            .strip_prefix("Strip[")
            .and_then(|s| s.split_once("]."))
            .is_some_and(|(strip, field)| {
                strip.parse::<u8>().is_ok_and(|i| i < 8)
                    && (field == "Gain"
                        || field
                            .strip_prefix("GainLayer[")
                            .and_then(|s| s.strip_suffix(']'))
                            .is_some_and(|bus| bus.parse::<u8>().is_ok_and(|i| i < 8)))
            })
}

fn chain_param(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("Strip[") else {
        return false;
    };
    let Some((idx, tail)) = rest.split_once("].") else {
        return false;
    };
    idx.parse::<u8>().is_ok()
        && ["Comp", "Gate", "Denoiser"]
            .iter()
            .any(|p| tail == *p || tail.strip_prefix(p).is_some_and(|t| t.starts_with('.')))
        && tail.len() < 24
        && tail.chars().all(|c| c.is_ascii_alphanumeric() || c == '.')
}

/// Mute an input on one output only ("B1"), with a fade on Potato. See fades::route_mute.
#[tauri::command]
fn vm_route_mute(
    app: AppHandle,
    vm: State<'_, Vm>,
    strip: usize,
    out: String,
    mute: bool,
) -> Result<(), String> {
    partmute::set(&app, api(&vm)?, strip, &out, mute)
        .inspect_err(|e| log_warn!("Muting Strip[{strip}] on {out} failed: {e}"))
}

/// Glide a strip or bus ("Strip[0]") to a level instead of jumping there.
#[tauri::command]
fn vm_glide(app: AppHandle, vm: State<'_, Vm>, key: String, value: f32) -> Result<(), String> {
    if !(key.starts_with("Strip[") || key.starts_with("Bus[")) {
        return Err("Only strips and buses have a level".into());
    }
    fades::glide(&app, api(&vm)?, &key, value)
}

/* ---------------- about and logs ---------------- */

/// Sleekmeeter's version and where its log is, for Settings → About.
#[tauri::command]
fn app_info() -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "logDir": logs::dir().map(|d| d.to_string_lossy().into_owned()),
    })
}

/// Open the logs folder in Explorer, with the log file selected.
#[tauri::command]
fn open_logs() -> Result<(), String> {
    let dir = logs::dir().ok_or("Logging isn't available")?;
    let file = dir.join("sleekmeeter.log");
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("explorer");
        if file.exists() {
            cmd.arg(format!("/select,{}", file.display()));
        } else {
            cmd.arg(&dir);
        }
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("Couldn't open the logs folder: {e}"))
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        Err("Only available on Windows".into())
    }
}

/// Problems the window runs into (failed actions, script errors) go in the same log.
#[tauri::command]
fn ui_log(window: WebviewWindow, level: String, message: String) {
    let message: String = message.chars().take(2000).collect();
    let from = window.label().to_string();
    match level.as_str() {
        "error" => log_error!("[{from}] {message}"),
        "warn" => log_warn!("[{from}] {message}"),
        _ => log_info!("[{from}] {message}"),
    }
}

/* ---------------- recorder ---------------- */

#[tauri::command]
fn recorder_cmd(app: AppHandle, vm: State<'_, Vm>, action: String) -> Result<Value, String> {
    recorder::command(&app, api(&vm)?, &action)
}

/// Pick an audio file and load it into the recorder. Returns the file name, or null if cancelled.
#[tauri::command]
async fn recorder_open(app: AppHandle) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(recorder::pick_file)
        .await
        .map_err(|e| e.to_string())?;
    let Some(path) = picked else { return Ok(None) };
    recorder_load(app, path).map(Some)
}

/// Load a file into the recorder (also used when a file is dropped on the window).
#[tauri::command]
fn recorder_load(app: AppHandle, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("That file can't be found".into());
    }
    let vm = app.state::<Vm>();
    api(&vm)?
        .set_string("Recorder.load", &path)
        .inspect_err(|e| log_warn!("Loading a file into the recorder failed: {e}"))?;
    log_info!(
        "Recorder: loaded a file ({})",
        p.extension()
            .map(|x| x.to_string_lossy().into_owned())
            .unwrap_or_default()
    );
    Ok(p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or(path))
}

/* ---------------- output profiles ---------------- */

/// The outputs' devices as they are now, for saving as a profile.
#[tauri::command]
fn outputs_capture(vm: State<'_, Vm>, s: State<'_, Settings>) -> Result<Vec<Value>, String> {
    let edition = last_edition(&s.0.lock().unwrap());
    Ok(outputs::capture(api(&vm)?, edition))
}

/// Switch the outputs to a saved profile.
#[tauri::command]
fn outputs_apply(app: AppHandle, name: String) -> Result<usize, String> {
    outputs::apply_named(&app, &name, "from the window")
}

/* ---------------- volume per app ---------------- */

#[tauri::command]
async fn app_volumes() -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(appvol::snapshot)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn app_volume_set(
    exe: String,
    volume: Option<f32>,
    mute: Option<bool>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = appvol::set(&exe, volume, mute);
        appvol::invalidate_snapshot();
        result
    })
    .await
    .map_err(|e| e.to_string())?
    .inspect_err(|e| log_warn!("Per-app volume: {e}"))
}

/// Playback devices an app can be sent to.
#[tauri::command]
async fn app_route_devices() -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(routing::devices)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn app_route_defaults() -> Result<Option<(String, String)>, String> {
    tauri::async_runtime::spawn_blocking(winout::default_ids)
        .await
        .map_err(|e| e.to_string())
}

/// Send apps (by process id) to a playback device; an empty device puts them back on the default.
#[tauri::command]
async fn app_route_set(pids: Vec<u32>, device: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = routing::set(&pids, &device);
        appvol::invalidate_snapshot();
        result
    })
    .await
    .map_err(|e| e.to_string())?
    .inspect_err(|e| log_warn!("App routing: {e}"))
}

#[tauri::command]
fn vm_set_string(vm: State<'_, Vm>, name: String, value: String) -> Result<(), String> {
    if name.contains(".device.") {
        log_info!("{name} = {value:?}");
    }
    api(&vm)?
        .set_string(&name, &value)
        .inspect_err(|e| log_warn!("Setting {name} failed: {e}"))
}

#[tauri::command]
fn vm_launch(vm: State<'_, Vm>, s: State<'_, Settings>) -> Result<(), String> {
    let edition = last_edition(&s.0.lock().unwrap());
    api(&vm)?.run(edition)
}

/// The edition last seen running (Standard 1, Banana 2, Potato 3); Banana until we know.
fn last_edition(s: &Value) -> i32 {
    match s["edition"].as_i64() {
        Some(e @ 1..=3) => e as i32,
        _ => 2,
    }
}

#[tauri::command]
fn vm_devices(vm: State<'_, Vm>) -> Result<Value, String> {
    Ok(api(&vm)?.devices())
}

#[tauri::command]
fn vm_show_window(vm: State<'_, Vm>) -> Result<(), String> {
    *vm.hide_vm_until.lock().unwrap() = None;
    win::show_voicemeeter();
    api(&vm)?.set_float("Command.Show", 1.0)
}

/* ---------------- scenes: Voicemeeter XML configs in a folder next to the exe ---------------- */

fn scenes_dir() -> Result<PathBuf, String> {
    let dir = settings::app_dir().join("scenes");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the scenes folder: {e}"))?;
    Ok(dir)
}

fn scene_path(name: &str) -> Result<PathBuf, String> {
    let clean: String = name
        .chars()
        .filter(|c| {
            !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control()
        })
        .collect();
    let clean = clean.trim();
    if clean.is_empty() || clean.starts_with('.') {
        return Err("Give the scene a name".into());
    }
    Ok(scenes_dir()?.join(format!("{clean}.xml")))
}

#[tauri::command]
fn scene_list() -> Result<Vec<String>, String> {
    let mut names: Vec<String> = std::fs::read_dir(scenes_dir()?)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .map(|x| x.eq_ignore_ascii_case("xml"))
                .unwrap_or(false)
        })
        .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    Ok(names)
}

#[tauri::command]
fn scene_save(app: AppHandle, vm: State<'_, Vm>, name: String) -> Result<(), String> {
    let path = scene_path(&name)?;
    api(&vm)?
        .set_string("Command.Save", &path.to_string_lossy())
        .inspect_err(|e| log_error!("Saving scene {name:?} failed: {e}"))?;
    log_info!("Saved scene {name:?}");
    fades::save_levels(&app, &path);
    // Each mic's clean-up on or off, and NVIDIA's strength (Voicemeeter's file can't hold them).
    let _ = std::fs::write(
        path.with_extension("micfx.json"),
        micfx::scene_snapshot(&app).to_string(),
    );
    Ok(())
}

#[tauri::command]
fn scene_preview(app: AppHandle, name: String) -> Result<Value, String> {
    let path = scene_path(&name)?;
    if !path.is_file() {
        return Err(format!("The scene “{name}” no longer exists"));
    }
    let read = |p: std::path::PathBuf| -> Option<Value> {
        serde_json::from_slice(&std::fs::read(p).ok()?).ok()
    };
    Ok(json!({
        "channels": read(fades::levels_path(&path)),
        "mics": read(path.with_extension("micfx.json")),
        "currentMics": micfx::scene_snapshot(&app),
    }))
}

#[tauri::command]
fn scene_load(app: AppHandle, name: String) -> Result<(), String> {
    let path = scene_path(&name)?;
    if !path.exists() {
        return Err(format!("The scene “{name}” no longer exists"));
    }
    log_info!("Loading scene {name:?}");
    fades::load_scene(&app, path, None)
        .inspect_err(|e| log_error!("Loading scene {name:?} failed: {e}"))
}

#[tauri::command]
fn scene_delete(name: String) -> Result<(), String> {
    let path = scene_path(&name)?;
    std::fs::remove_file(&path).map_err(|e| format!("Couldn't delete the scene: {e}"))?;
    fades::delete_levels(&path);
    log_info!("Deleted scene {name:?}");
    Ok(())
}

/* ---------------- settings ---------------- */

#[tauri::command]
fn settings_get(s: State<'_, Settings>) -> Value {
    let mut v = s.0.lock().unwrap().clone();
    v["startWithWindows"] = json!(win::autostart_enabled());
    v["autoTheme"] = json!(AUTO_THEME.lock().unwrap().clone());
    v
}

/// Save settings and apply the parts that live outside the window. Returns problems to show.
#[tauri::command]
fn settings_set(app: AppHandle, value: Value) -> Result<Value, String> {
    let mut problems: Vec<String> = Vec::new();
    let want_autostart = settings::flag(&value, "startWithWindows");
    if want_autostart != win::autostart_enabled() {
        if let Err(e) = win::set_autostart(want_autostart) {
            problems.push(e);
        }
    }
    problems.extend(apply_hotkeys(&app, &value["hotkeys"]));
    for p in &problems {
        log_warn!("Settings: {p}");
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(settings::flag(&value, "alwaysOnTop"));
    }
    // The edition is recorded by the poller; keep it even if the window's copy is older.
    let mut value = value;
    if let Value::Object(m) = &mut value {
        m.remove("autoTheme"); // transient, set by app rules
    }
    let state = app.state::<Settings>();
    let mut current = state.0.lock().unwrap();
    if !current["edition"].is_null() {
        value["edition"] = current["edition"].clone();
    }
    // Window size and position are recorded here in Rust; the page never edits them.
    if !current["window"].is_null() {
        value["window"] = current["window"].clone();
    }
    // The tray panel's position and the output mix window are recorded in Rust too.
    // So are what Music off stream switched off (watch.rs) and the inputs muted on some
    // outputs only (partmute.rs), which a Stream Deck key can change while the window is open.
    for k in [
        "panelPos",
        "mixWin",
        "mixWinOpen",
        "seenVersion",
        "musicGuardEngaged",
        "partMute",
        "vstState",
        "vstPresets",
        "vstQuarantine",
        "micFxLive",
        "chatBalanceLive",
    ] {
        value[k] = current[k].clone();
    }
    let usage_changed = current["usagePing"] != value["usagePing"];
    *current = value.clone();
    drop(current);
    settings::save(&value)?;
    let _ = app.emit_to(FLYOUT, "settings-changed", &value);
    let _ = app.emit_to(MIXWIN, "settings-changed", &value);
    if let Some(w) = app.get_webview_window(FLYOUT) {
        flyout_shadow(&app, &w);
    }
    if usage_changed {
        usage::nudge();
    }
    Ok(json!({ "problems": problems }))
}

/// Mix can be open in a second window. Update only the selected view or bus.
#[tauri::command]
fn mix_preference_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let valid = match key.as_str() {
        "mixViewMode" => matches!(value.as_str(), "all" | "pair"),
        "personalBus" | "audienceBus" => value
            .strip_prefix("Bus[")
            .and_then(|s| s.strip_suffix(']'))
            .and_then(|s| s.parse::<u8>().ok())
            .is_some_and(|i| {
                if key == "personalBus" {
                    i < 5
                } else {
                    (5..8).contains(&i)
                }
            }),
        _ => false,
    };
    if !valid {
        return Err("Invalid output mix preference.".into());
    }
    let state = app.state::<Settings>();
    let mut current = state.0.lock().unwrap();
    let mut next = current.clone();
    next[&key] = json!(value);
    settings::save(&next)?;
    *current = next.clone();
    drop(current);
    let _ = app.emit_to("main", "settings-changed", &next);
    let _ = app.emit_to(MIXWIN, "settings-changed", &next);
    Ok(())
}

/* ---------------- window: mini mode ---------------- */

#[tauri::command]
fn window_mini(
    app: AppHandle,
    mini: bool,
    rows: u32,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("No main window")?;
    // Mark mini mode first, so the resize below isn't remembered as the normal window size.
    app.state::<Settings>().0.lock().unwrap()["mini"] = json!(mini);
    let saved = app.state::<NormalSize>();
    if mini {
        let scale = w.scale_factor().unwrap_or(1.0);
        if let Ok(size) = w.inner_size() {
            let logical = size.to_logical::<f64>(scale);
            // Only remember the full-size window, not an earlier mini size.
            if logical.height > 400.0 {
                *saved.0.lock().unwrap() = Some(logical);
            }
        }
        // The page measures the height its channels need; the row count is only a fallback.
        let mut h = match height {
            Some(h) if h >= 100.0 => h,
            _ => 64.0 + 44.0 * rows.max(1) as f64,
        };
        // Never taller than the screen (the list scrolls if there are very many channels).
        if let Ok(Some(m)) = w.current_monitor() {
            h = h.min(m.size().to_logical::<f64>(m.scale_factor()).height * 0.94);
        }
        let width = width.unwrap_or(400.0).clamp(300.0, 900.0);
        let _ = w.set_min_size(Some(LogicalSize::new(300.0, 120.0)));
        w.set_size(LogicalSize::new(width, h))
            .map_err(|e| e.to_string())?;
    } else {
        // Back to the full size: the one from before mini mode, else the remembered one.
        let remembered = {
            let st = app.state::<Settings>();
            let guard = st.0.lock().unwrap();
            let g = &guard["window"];
            match (g["width"].as_f64(), g["height"].as_f64()) {
                (Some(wd), Some(ht)) => LogicalSize::new(wd, ht),
                _ => LogicalSize::new(1400.0, 800.0),
            }
        };
        let size = saved.0.lock().unwrap().unwrap_or(remembered);
        let _ = w.set_min_size(Some(LogicalSize::new(760.0, 520.0)));
        w.set_size(size).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* ---------------- global hotkeys ---------------- */

/// (Re)register every shortcut. Returns one message per shortcut that couldn't be used.
fn apply_hotkeys(app: &AppHandle, list: &Value) -> Vec<String> {
    let gs = app.global_shortcut();
    // A key held down while the shortcuts are re-registered would never report its release.
    hold::release_all(app);
    let _ = gs.unregister_all();
    let mut map = Vec::new();
    let mut problems = Vec::new();
    for hk in list.as_array().cloned().unwrap_or_default() {
        let keys = hk["keys"].as_str().unwrap_or("").trim().to_string();
        if keys.is_empty() {
            continue;
        }
        match keys.parse::<Shortcut>() {
            Ok(sc) => match gs.register(sc.clone()) {
                Ok(()) => map.push((sc, hk.clone())),
                Err(_) => problems.push(format!("{keys} is already used by another app")),
            },
            Err(_) => problems.push(format!("{keys} isn't a shortcut Windows can register")),
        }
    }
    *app.state::<Hotkeys>().0.lock().unwrap() = map;
    hold::arm(app, list);
    problems
}

fn run_hotkey(app: &AppHandle, shortcut: &Shortcut, pressed: bool) {
    let action = app
        .state::<Hotkeys>()
        .0
        .lock()
        .unwrap()
        .iter()
        .find(|(s, _)| s == shortcut)
        .map(|(_, a)| a.clone());
    let Some(action) = action else { return };
    let target = action["target"].as_str().unwrap_or("").to_string();
    let kind = action["action"].as_str().unwrap_or("");
    // Push to talk / push to mute act on both the press and the release.
    if kind == "ptt" || kind == "ptm" {
        let id = action["keys"].as_str().unwrap_or("").to_string();
        if pressed {
            hold::press(app, &id, kind == "ptt", &target);
        } else {
            hold::release(app, &id);
        }
        return;
    }
    if !pressed {
        return;
    }
    if matches!(kind, "chatgame" | "chatchat" | "chatcentre") {
        let app = app.clone();
        let kind = kind.to_owned();
        std::thread::spawn(move || {
            if let Err(e) = actions::perform(&app, &kind, &target) {
                show_osd_text(&app, "Game / Chat", &e, false, "chat");
            }
        });
        return;
    }
    if let Err(e) = actions::perform(app, kind, &target) {
        log_warn!("Shortcut {kind}: {e}");
    }
}

/* ---------------- volume overlay ---------------- */

/// Move the overlay to the bottom centre of the chosen screen: the mixer's (the default), the
/// main one, or a named one (Settings → Volume overlay).
fn place_osd(app: &AppHandle, osd: &WebviewWindow) {
    let wanted = app.state::<Settings>().0.lock().unwrap()["overlayScreen"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let named = || {
        osd.available_monitors()
            .unwrap_or_default()
            .into_iter()
            .find(|m| m.name().map(|n| n == &wanted).unwrap_or(false))
    };
    let mixer = || {
        app.get_webview_window("main")
            .and_then(|w| w.current_monitor().ok().flatten())
    };
    let primary = || osd.primary_monitor().ok().flatten();
    let monitor = match wanted.as_str() {
        "" => mixer().or_else(primary),
        "primary" => primary(),
        _ => named().or_else(mixer).or_else(primary),
    };
    if let Some(m) = monitor {
        let s = m.scale_factor();
        let (w, h) = (340.0 * s, 76.0 * s);
        let x = m.position().x as f64 + (m.size().width as f64 - w) / 2.0;
        let y = m.position().y as f64 + m.size().height as f64 - h - 110.0 * s;
        let _ = osd.set_position(PhysicalPosition::new(x as i32, y as i32));
    }
}

/// The overlay with words instead of a level (shortcuts for ducking and recording).
fn show_osd_text(app: &AppHandle, name: &str, text: &str, on: bool, icon: &str) {
    let color = if icon == "record" { "rose" } else { "amber" };
    osd_words(app, name, text, on, icon, color, 1600);
}

/// A warning on the overlay (watch.rs: talking while muted, a silent stream), shown longer
/// and in red, even when levels on the overlay are switched off (but not with the overlay off).
pub fn show_osd_alert(app: &AppHandle, name: &str, text: &str, icon: &str) {
    osd_words(app, name, text, false, icon, "rose", 3000);
}

/// Is the volume overlay switched on at all (Settings → Appearance → Volume overlay)?
fn osd_on(app: &AppHandle) -> bool {
    settings::flag_or(&app.state::<Settings>().0.lock().unwrap(), "osdOn", true)
}

fn osd_words(app: &AppHandle, name: &str, text: &str, on: bool, icon: &str, color: &str, ms: u64) {
    if !osd_on(app) {
        return;
    }
    let Some(osd) = app.get_webview_window("osd") else {
        return;
    };
    place_osd(app, &osd);
    let theme = settings::theme(&app.state::<Settings>().0.lock().unwrap());
    let fresh = app.state::<Vm>().osd_until.lock().unwrap().is_none();
    let _ = app.emit_to(
        "osd",
        "osd",
        json!({ "theme": theme, "name": name, "text": text, "on": on, "icon": icon, "fresh": fresh,
                "color": color }),
    );
    let _ = osd.show();
    *app.state::<Vm>().osd_until.lock().unwrap() = Some(Instant::now() + Duration::from_millis(ms));
}

/// What changed between two snapshots: ("strip" | "bus", index) for gain or mute changes.
fn changed_channels(prev: &Value, next: &Value) -> Vec<(&'static str, usize)> {
    let mut out = Vec::new();
    for (key, kind) in [("strips", "strip"), ("buses", "bus")] {
        let (Some(a), Some(b)) = (prev[key].as_array(), next[key].as_array()) else {
            continue;
        };
        for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
            let gain_moved =
                (x["gain"].as_f64().unwrap_or(0.0) - y["gain"].as_f64().unwrap_or(0.0)).abs()
                    > 0.05;
            if gain_moved || x["mute"] != y["mute"] {
                out.push((kind, i));
            }
        }
    }
    out
}

fn show_osd(app: &AppHandle, snap: &Value, kind: &str, i: usize) {
    let Some(osd) = app.get_webview_window("osd") else {
        return;
    };
    let ch = if kind == "strip" {
        &snap["strips"][i]
    } else {
        &snap["buses"][i]
    };
    let look =
        app.state::<Settings>().0.lock().unwrap()["appearance"][format!("{kind}-{i}")].clone();
    let edition = snap["edition"].as_i64().unwrap_or(2) as i32;
    let l = Layout::for_edition(edition);
    let fallback = if kind == "strip" {
        if i < l.hw_strips {
            format!("Hardware input {}", i + 1)
        } else {
            ["Voicemeeter Input", "Voicemeeter AUX", "Voicemeeter VAIO3"]
                .get(i - l.hw_strips)
                .unwrap_or(&"Virtual input")
                .to_string()
        }
    } else if i < l.hw_buses {
        format!("A{}", i + 1)
    } else {
        format!("B{}", i - l.hw_buses + 1)
    };
    let label = ch["label"].as_str().unwrap_or("");
    let device = ch["device"].as_str().unwrap_or("");
    let name = if !label.is_empty() {
        label.to_string()
    } else if !device.is_empty() {
        device.to_string()
    } else {
        fallback
    };

    place_osd(app, &osd);
    let theme = settings::theme(&app.state::<Settings>().0.lock().unwrap());
    // Only a newly shown overlay fades in; updates while it's up don't replay the fade.
    let fresh = app.state::<Vm>().osd_until.lock().unwrap().is_none();
    let _ = app.emit_to(
        "osd",
        "osd",
        json!({
            "theme": theme,
            "fresh": fresh,
            "name": name,
            "gain": ch["gain"],
            "mute": ch["mute"],
            "color": look["color"],
            "icon": look["icon"],
        }),
    );
    let _ = osd.show();
    *app.state::<Vm>().osd_until.lock().unwrap() =
        Some(Instant::now() + Duration::from_millis(1600));
}

/* ---------------- poll thread ---------------- */

/// Polls Voicemeeter ~30 times a second, as the SDK recommends:
/// IsParametersDirty() for changes (and connection state), GetLevel() for meters.
/// Whether the level history is being recorded (Settings).
fn keep_history(app: &AppHandle) -> bool {
    let state = app.state::<Settings>();
    let s = state.0.lock().unwrap();
    let on = s["history"]["on"].as_bool().unwrap_or(true);
    on
}

fn spawn_poller(app: AppHandle, api: Arc<Api>) {
    std::thread::spawn(move || {
        let tick = Duration::from_millis(33);
        let mut connected = false;
        let mut edition = 2;
        let mut last_full = Instant::now();
        let mut reread_until = Instant::now();
        let mut prev: Option<Value> = None;
        // Push-to-talk channels start out muted, once the connection has settled.
        let mut arm_pending = false;
        let mut levels_log = history::Recorder::new();

        loop {
            let started = Instant::now();
            let dirty = api.is_dirty();

            if dirty < 0 {
                if connected {
                    connected = false;
                    log_info!("Voicemeeter disconnected (code {dirty})");
                    prev = None;
                    arm_pending = false;
                    fades::release(&app, None);
                    publish(&app, offline_state(true));
                }
            } else {
                if !connected {
                    connected = true;
                    edition = api.edition().unwrap_or(2);
                    log_info!(
                        "Connected to Voicemeeter {} (edition {edition})",
                        api.version().unwrap_or_default()
                    );
                    remember_edition(&app, edition);
                    // Right after Voicemeeter starts its parameters settle over a second or two.
                    reread_until = Instant::now() + Duration::from_secs(3);
                    arm_pending = true;
                    hold::forget_armed(&app);
                    let s = app.state::<Settings>().0.lock().unwrap().clone();
                    if settings::flag(&s, "hideVoicemeeter") {
                        *app.state::<Vm>().hide_vm_until.lock().unwrap() =
                            Some(Instant::now() + Duration::from_secs(10));
                    }
                }
                let layout = Layout::for_edition(edition);
                fades::tick(&app, &api, &layout);
                mic_tune::tick(&app, &api);
                let settling = Instant::now() < reread_until;
                if !settling {
                    watch::tick(&app, &api, &layout);
                }
                let periodic = last_full.elapsed() > Duration::from_secs(1);
                if dirty == 1 || periodic || settling {
                    last_full = Instant::now();
                    let mut snap = api.snapshot(edition);
                    fades::dress(&app, &mut snap);
                    outputs::dress(&app, &mut snap);
                    brb::dress(&app, &mut snap);
                    watch::dress(&app, &mut snap);
                    partmute::dress(&app, &mut snap);
                    if edition >= 2 {
                        recorder::dress(&app, &mut snap, api.recorder(&layout));
                    }
                    if let Some(p) = &prev {
                        maybe_osd(&app, p, &snap, settling);
                    }
                    prev = Some(snap.clone());
                    publish(&app, snap);
                }
                if arm_pending && !settling {
                    arm_pending = false;
                    let hotkeys = app.state::<Settings>().0.lock().unwrap()["hotkeys"].clone();
                    hold::arm(&app, &hotkeys);
                }
                if window_visible(&app, "main")
                    || window_visible(&app, FLYOUT)
                    || remote::meters_wanted()
                {
                    let mut levels = api.levels(&layout);
                    remote::set_levels(&levels);
                    if keep_history(&app) {
                        levels_log.feed(&levels);
                    }
                    mic_tune::sample(&api, &layout, &mut levels);
                    let _ = app.emit("vm-levels", levels);
                } else if levels_log.due() && keep_history(&app) {
                    // Hidden in the tray: read the meters once a second, just for the history.
                    levels_log.feed(&api.levels(&layout));
                }
            }

            housekeeping(&app);

            if let Some(rest) = tick.checked_sub(started.elapsed()) {
                std::thread::sleep(rest);
            }
        }
    });
}

/// Show the overlay when one or two channels change while the mixer isn't in front.
/// Bigger jumps (scene loads, startup) are skipped.
fn maybe_osd(app: &AppHandle, prev: &Value, next: &Value, settling: bool) {
    if settling || !osd_on(app) || !settings::flag(&app.state::<Settings>().0.lock().unwrap(), "overlay") {
        return;
    }
    let focused = ["main", FLYOUT].iter().any(|label| {
        app.get_webview_window(label)
            .map(|w| w.is_focused().unwrap_or(false) && w.is_visible().unwrap_or(false))
            .unwrap_or(false)
    });
    if focused {
        return;
    }
    let changes = changed_channels(prev, next);
    if !(1..=2).contains(&changes.len()) {
        return;
    }
    // Channels switched off for the overlay in their settings are skipped.
    let shown = {
        let st = app.state::<Settings>();
        let s = st.0.lock().unwrap();
        changes
            .into_iter()
            .find(|(kind, i)| s["appearance"][format!("{kind}-{i}")]["osd"] != json!(false))
    };
    if let Some((kind, i)) = shown {
        show_osd(app, next, kind, i);
    }
}

/// Timed jobs: hide the overlay, keep Voicemeeter's window hidden while it starts.
fn housekeeping(app: &AppHandle) {
    let vm = app.state::<Vm>();
    let now = Instant::now();
    let mut osd = vm.osd_until.lock().unwrap();
    if osd.map(|t| now >= t).unwrap_or(false) {
        *osd = None;
        if let Some(w) = app.get_webview_window("osd") {
            let _ = w.hide();
        }
    }
    drop(osd);
    let mut hide = vm.hide_vm_until.lock().unwrap();
    if let Some(t) = *hide {
        if now >= t {
            *hide = None;
        } else {
            win::hide_voicemeeter();
        }
    }
}

/// Emit state only when it changed, and keep it for vm_snapshot.
fn publish(app: &AppHandle, state: Value) {
    let vm = app.state::<Vm>();
    let mut last = vm.last.lock().unwrap();
    if *last != state {
        *last = state.clone();
        drop(last);
        let _ = app.emit("vm-state", state);
    }
}

fn window_visible(app: &AppHandle, label: &str) -> bool {
    app.get_webview_window(label)
        .map(|w| w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false))
        .unwrap_or(false)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        recover::check_main_draws(app);
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_main(app);
        }
    }
}

/* ---------------- tray volume panel ("flyout") ---------------- */

/// Panel height in logical pixels, matching the mini-row layout in styles.css.
fn flyout_size(app: &AppHandle) -> (f64, f64) {
    if let Some(size) = *app.state::<PanelSize>().0.lock().unwrap() {
        return size;
    }
    let s = app.state::<Settings>().0.lock().unwrap().clone();
    let shown = |key: &str, n: usize| {
        (0..n)
            .filter(|i| {
                !s["appearance"][format!("{key}-{i}")]["hidden"]
                    .as_bool()
                    .unwrap_or(false)
            })
            .count() as f64
    };
    let edition = app.state::<Vm>().last.lock().unwrap()["edition"]
        .as_i64()
        .unwrap_or(2) as i32;
    let l = Layout::for_edition(edition);
    let (ins, outs) = (shown("strip", l.strips()), shown("bus", l.buses()));
    let list = |n: f64| if n == 0.0 { 0.0 } else { 10.0 + 42.0 * n - 2.0 };
    let gap = if ins > 0.0 && outs > 0.0 { 8.0 } else { 0.0 };
    (400.0, 50.0 + list(ins) + gap + list(outs) + 14.0)
}

/// The usable screen (without the taskbar) and the whole screen of the monitor holding this
/// point, each as (left, top, right, bottom) in physical pixels.
#[cfg(windows)]
fn monitor_areas(x: i32, y: i32) -> Option<((i32, i32, i32, i32), (i32, i32, i32, i32))> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    unsafe {
        let m = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(m, &mut info) == 0 {
            return None;
        }
        let (w, f) = (info.rcWork, info.rcMonitor);
        Some((
            (w.left, w.top, w.right, w.bottom),
            (f.left, f.top, f.right, f.bottom),
        ))
    }
}

#[cfg(not(windows))]
fn monitor_areas(_x: i32, _y: i32) -> Option<((i32, i32, i32, i32), (i32, i32, i32, i32))> {
    None
}

/// Where a panel of this size sits when docked: in the corner by the clock, touching the
/// taskbar, whichever edge the taskbar is on. `(x, y)` is any point on the right monitor.
fn dock_spot(x: i32, y: i32, pw: i32, ph: i32) -> Option<(i32, i32)> {
    let (work, full) = monitor_areas(x, y)?;
    let px = if work.0 > full.0 { work.0 } else { work.2 - pw }; // taskbar on the left?
    let py = if work.1 > full.1 { work.1 } else { work.3 - ph }; // taskbar on top?
    Some((px, py))
}

/// Windows' window shadow keeps the panel opaque, so it only has one while it's solid.
fn flyout_shadow(app: &AppHandle, w: &WebviewWindow) {
    let opacity = app.state::<Settings>().0.lock().unwrap()["panelOpacity"]
        .as_f64()
        .unwrap_or(100.0);
    let _ = w.set_shadow(opacity >= 100.0);
}

/// Size the panel and put it next to the tray icon (or bottom-right when opened another way).
fn place_flyout(app: &AppHandle, w: &WebviewWindow, anchor: Option<PhysicalPosition<f64>>) {
    flyout_shadow(app, w);
    let (lw, lh) = flyout_size(app);
    let _ = w.set_size(LogicalSize::new(lw, lh));
    let monitors = w.available_monitors().unwrap_or_default();
    let monitor = anchor
        .and_then(|a| {
            monitors.iter().find(|m| {
                let (p, z) = (m.position(), m.size());
                a.x >= p.x as f64
                    && a.x < (p.x + z.width as i32) as f64
                    && a.y >= p.y as f64
                    && a.y < (p.y + z.height as i32) as f64
            })
        })
        .cloned()
        .or_else(|| w.primary_monitor().ok().flatten());
    let Some(m) = monitor else { return };
    let s = m.scale_factor();
    let (mx, my) = (m.position().x as f64, m.position().y as f64);
    let (mw, mh) = (m.size().width as f64, m.size().height as f64);
    let (pw, ph) = (lw * s, lh * s);
    let a = anchor.unwrap_or(PhysicalPosition::new(
        mx + mw - 40.0 * s,
        my + mh - 24.0 * s,
    ));
    let (docked, saved) = {
        let st = app.state::<Settings>();
        let g = st.0.lock().unwrap();
        (
            settings::flag_or(&g, "panelDocked", true),
            (
                g["panelPos"]["x"].as_i64().map(|v| v as i32),
                g["panelPos"]["y"].as_i64().map(|v| v as i32),
            ),
        )
    };
    // Docked: snug in the corner next to the clock, flush with the taskbar.
    if docked {
        if let Some((x, y)) = dock_spot(a.x as i32, a.y as i32, pw as i32, ph as i32) {
            let _ = w.set_position(PhysicalPosition::new(x, y));
            return;
        }
    } else if let (Some(x), Some(y)) = saved {
        // Undocked: where you left it, if that spot is still on a screen.
        let on_screen = monitors.iter().any(|m| {
            let (p, z) = (m.position(), m.size());
            x + 40 >= p.x
                && x + 40 < p.x + z.width as i32
                && y + 20 >= p.y
                && y + 20 < p.y + z.height as i32
        });
        if on_screen {
            let _ = w.set_position(PhysicalPosition::new(x, y));
            return;
        }
    }
    // max/min rather than clamp: never panics when the panel is taller than the screen.
    let x = (a.x - pw / 2.0)
        .min(mx + mw - pw - 8.0 * s)
        .max(mx + 8.0 * s);
    // Taskbar at the bottom (usual): open above the icon; otherwise below it.
    let y = if a.y > my + mh / 2.0 {
        a.y - ph - 28.0 * s
    } else {
        a.y + 28.0 * s
    };
    let y = y.min(my + mh - ph - 8.0 * s).max(my + 8.0 * s);
    let _ = w.set_position(PhysicalPosition::new(x as i32, y as i32));
}

/// Open the panel, or close it when it is already open. Must run on the main thread.
fn toggle_flyout(app: &AppHandle, anchor: Option<PhysicalPosition<f64>>) {
    if let Some(w) = app.get_webview_window(FLYOUT) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            return;
        }
        place_flyout(app, &w, anchor);
        let _ = app.emit_to(FLYOUT, "flyout-shown", ());
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let (lw, lh) = flyout_size(app);
    let built = WebviewWindowBuilder::new(app, FLYOUT, WebviewUrl::App("index.html".into()))
        .title("Sleekmeeter volume")
        .initialization_script("window.SLEEK_FLYOUT = true;")
        .inner_size(lw, lh)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        // See-through, so Settings → Tray volume panel → Opacity works.
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build();
    if let Ok(w) = built {
        recover::watch(&w);
        place_flyout(app, &w, anchor);
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Dock the tray panel to the corner, or let it be moved (the panel's own button).
#[tauri::command]
fn panel_dock(app: AppHandle, docked: bool) {
    let snapshot = {
        let st = app.state::<Settings>();
        let mut s = st.0.lock().unwrap();
        s["panelDocked"] = json!(docked);
        let _ = settings::save(&s);
        s.clone()
    };
    log_info!("Tray panel {}", if docked { "docked" } else { "undocked" });
    let _ = app.emit("settings-changed", snapshot);
    if docked {
        if let Some(w) = app.get_webview_window(FLYOUT) {
            if let (Ok(p), Ok(z)) = (w.outer_position(), w.outer_size()) {
                let anchor = PhysicalPosition::new(
                    p.x as f64 + z.width as f64 / 2.0,
                    p.y as f64 + z.height as f64 / 2.0,
                );
                place_flyout(&app, &w, Some(anchor));
            }
        }
    }
}

/// The Output mix (Potato gain layers) in a window of its own, for example on a second screen.
fn open_mix_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MIXWIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let saved = app.state::<Settings>().0.lock().unwrap()["mixWin"].clone();
    let built = WebviewWindowBuilder::new(app, MIXWIN, WebviewUrl::App("index.html".into()))
        .title("Sleekmeeter output mix")
        .initialization_script("window.SLEEK_MIXWIN = true;")
        .inner_size(1180.0, 520.0)
        .min_inner_size(MIXWIN_MIN.0, MIXWIN_MIN.1)
        .decorations(false)
        .background_color(tauri::window::Color(17, 17, 20, 255))
        .visible(false)
        .build();
    match built {
        Ok(w) => {
            recover::watch(&w);
            restore_geometry(&w, &saved, MIXWIN_MIN);
            let _ = w.show();
            let _ = w.set_focus();
            set_mix_window_open(app, true);
            log_info!("Opened the output mix window");
        }
        Err(e) => log_warn!("Couldn't open the output mix window: {e}"),
    }
}

/// Remembered so the window comes back at the next start, wherever it was left.
fn set_mix_window_open(app: &AppHandle, open: bool) {
    let st = app.state::<Settings>();
    let mut s = st.0.lock().unwrap();
    if s["mixWinOpen"].as_bool() != Some(open) {
        s["mixWinOpen"] = json!(open);
        let _ = settings::save(&s);
        // The mixer's Mix button brings the window forward while it's open.
        let _ = app.emit_to("main", "settings-changed", &*s);
    }
}

/// Open the Output mix window, or close it. Async: Windows deadlocks when a window is made
/// from a command that runs on the main thread.
#[tauri::command]
async fn mix_window(app: AppHandle, open: bool) {
    if open {
        open_mix_window(&app);
    } else if let Some(w) = app.get_webview_window(MIXWIN) {
        set_mix_window_open(&app, false);
        let _ = w.destroy();
    }
}

#[tauri::command]
fn open_mixer(app: AppHandle) {
    if let Some(w) = app.get_webview_window(FLYOUT) {
        let _ = w.hide();
    }
    show_main(&app);
}

#[tauri::command]
fn flyout_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window(FLYOUT) {
        let _ = w.hide();
    }
}

/// The panel measures its own content and asks to be exactly that tall.
/// Keeps the edge nearest the taskbar where it is, so the panel stays snug against the tray.
#[tauri::command]
fn panel_fit(
    app: AppHandle,
    window: WebviewWindow,
    height: f64,
    width: Option<f64>,
) -> Result<(), String> {
    if window.label() != FLYOUT || !(60.0..=2000.0).contains(&height) {
        return Ok(());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let width = width
        .unwrap_or(inner.width as f64 / scale)
        .clamp(200.0, 1800.0);
    *app.state::<PanelSize>().0.lock().unwrap() = Some((width, height));
    let dh = (height * scale).round() as i32 - inner.height as i32;
    let dw = (width * scale).round() as i32 - inner.width as i32;
    if dh.abs() <= 1 && dw.abs() <= 1 {
        return Ok(());
    }
    let opens_upward = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| (pos.y as f64) > m.position().y as f64 + m.size().height as f64 / 3.0)
        .unwrap_or(true);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    // Docked: stay snug in the corner at the new size.
    let docked = settings::flag_or(
        &app.state::<Settings>().0.lock().unwrap(),
        "panelDocked",
        true,
    );
    if docked {
        let (nw, nh) = (
            (width * scale).round() as i32,
            (height * scale).round() as i32,
        );
        if let Some((x, y)) = dock_spot(
            pos.x + inner.width as i32 / 2,
            pos.y + inner.height as i32 / 2,
            nw,
            nh,
        ) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
            return Ok(());
        }
    }
    // Grow around the same centre, and upward when the panel sits above the taskbar.
    let y = if opens_upward { pos.y - dh } else { pos.y };
    let _ = window.set_position(PhysicalPosition::new(pos.x - dw / 2, y));
    Ok(())
}

/// The page has drawn: show the main window now unless Sleekmeeter started in the tray.
#[tauri::command]
fn ui_ready(window: WebviewWindow, show: State<'_, ShowOnReady>) {
    if window.label() == "main" {
        recover::MAIN_DREW.store(true, Ordering::SeqCst);
    }
    if window.label() == "main" && show.0.swap(false, Ordering::SeqCst) {
        let _ = window.show();
    }
}

/// Save the running edition so "Start Voicemeeter" launches the right one next time.
fn remember_edition(app: &AppHandle, edition: i32) {
    let state = app.state::<Settings>();
    let mut s = state.0.lock().unwrap();
    if s["edition"].as_i64() != Some(edition as i64) {
        s["edition"] = json!(edition);
        let _ = settings::save(&s);
    }
}

/* ---------------- updates ---------------- */

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Value, String> {
    let beta = settings::flag(&app.state::<Settings>().0.lock().unwrap(), "betaUpdates");
    let result = tauri::async_runtime::spawn_blocking(move || update::latest(beta))
        .await
        .map_err(|e| e.to_string())?;
    match &result {
        Ok(v) => log_info!(
            "Update check: running {}, latest {}",
            v["current"].as_str().unwrap_or("?"),
            v["latest"].as_str().unwrap_or("?")
        ),
        Err(e) => log_warn!("Update check: {e}"),
    }
    result
}

/// Download the newest version, install it and start Sleekmeeter again.
#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    let a = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || update::install(&a))
        .await
        .map_err(|e| e.to_string())?;
    if let Err(e) = &result {
        log_warn!("Update: {e}");
    }
    result?;
    log_info!("Update downloaded; restarting to install it");
    app.exit(0);
    Ok(())
}

/// Soundboard: output devices Windows has, and the one used when none is chosen.
#[tauri::command]
async fn sound_devices() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(sounds::devices)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn sound_play(app: AppHandle, name: String) -> Result<(), String> {
    sounds::play(&app, &name)
}

/// Hear-yourself test: Voicemeeter's virtual outputs that can be recorded.
#[tauri::command]
async fn output_fallback_status(app: AppHandle, bus: usize) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || devwatch::fallback_status(&app, bus))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn selftest_inputs() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(selftest::inputs)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn guided_audio_test(
    source: String,
    stream: String,
    monitor: String,
    kind: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        selftest::guided(&source, &stream, &monitor, &kind)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn mix_monitor_start(
    app: AppHandle,
    window: tauri::WebviewWindow,
    input: String,
    output: String,
    cue: Option<bool>,
) -> Result<(), String> {
    let owner = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        if cue.is_some() {
            obs::check_cue_output(&app, &output)?;
        }
        selftest::live_start(app, owner, input, output, cue)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn mix_monitor_stop(window: tauri::WebviewWindow) -> Result<(), String> {
    let owner = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || selftest::live_stop(Some(&owner)))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn mic_take_record(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || micfx::record_take(&app, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn mic_take_play(output: String, processed: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || micfx::play_take(&output, processed))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn mic_take_clear() {
    micfx::clear_take();
}

#[tauri::command]
async fn mic_preset_export(app: AppHandle, id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || micpreset::export(&app, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn mic_preset_preview(app: AppHandle, id: String) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || micpreset::preview(&app, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn mic_preset_apply(app: AppHandle, id: String) -> Result<Value, String> {
    micpreset::apply(&app, &id)
}

#[tauri::command]
fn mic_preset_clear() {
    micpreset::clear();
}

/// Record a few seconds of `input`, then play it on `output`.
#[tauri::command]
async fn selftest_run(
    app: AppHandle,
    input: String,
    output: String,
    secs: u64,
) -> Result<(), String> {
    let a = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        let _ = a.emit("selftest", json!({ "phase": "recording", "secs": secs }));
        selftest::run(&input, &output, secs)
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = app.emit("selftest", json!({ "phase": "done" }));
    r
}

#[tauri::command]
fn sound_stop() {
    sounds::stop_all();
}

/// Ask for one or more sound files. Returns their paths (empty if cancelled).
#[tauri::command]
async fn sound_pick() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(files::pick_audio_many)
        .await
        .map_err(|e| e.to_string())
}

/// Ask for a folder and return every sound file inside it.
#[tauri::command]
async fn sound_pick_folder() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(files::pick_audio_folder)
        .await
        .map_err(|e| e.to_string())
}

/// Copy sound files into Sleekmeeter's data folder; returns the copies' paths.
#[tauri::command]
async fn sound_import(paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || files::import_sounds(&paths))
        .await
        .map_err(|e| e.to_string())
}

/// Ask for a folder to use as a random pack: { folder, count }, or null if cancelled.
#[tauri::command]
async fn sound_pick_pack() -> Result<Value, String> {
    let r = tauri::async_runtime::spawn_blocking(files::pick_audio_pack)
        .await
        .map_err(|e| e.to_string())?;
    Ok(match r {
        Some((folder, count)) => json!({ "folder": folder, "count": count }),
        None => Value::Null,
    })
}

/// Levels of the last `minutes` minutes, for the history graph.
#[tauri::command]
fn history_get(minutes: u64) -> Value {
    history::get(minutes)
}

#[tauri::command]
fn history_clear() {
    history::clear();
}

#[tauri::command]
fn remote_status() -> Value {
    remote::status()
}

#[tauri::command]
fn twitch_status() -> Value {
    twitch::status()
}

#[tauri::command]
fn open_release(url: String) -> Result<(), String> {
    update::open(&url)
}

/* ---------------- Stream Deck plugin ---------------- */

/// Whether this PC has the Stream Deck app or hardware, and what to offer for the plugin.
#[tauri::command]
fn streamdeck_status() -> Value {
    streamdeck::status()
}

#[tauri::command]
fn streamdeck_install() -> Result<(), String> {
    streamdeck::install()
}

#[tauri::command]
async fn streamdeck_profile_save() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(streamdeck::save_plus_profile)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn streamdeck_get_app() -> Result<(), String> {
    streamdeck::open_app_page()
}

/* ---------------- stream mode, OBS, backups, setup check ---------------- */

/// Be right back on or off (the BRB button). Returns whether it is on now.
#[tauri::command]
fn brb_toggle(app: AppHandle) -> Result<bool, String> {
    brb::toggle(&app)
}

/// What the OBS link is doing, for the mixer's status.
#[tauri::command]
fn obs_status() -> Value {
    obs::status()
}

#[tauri::command]
async fn obs_audio_check(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || obs::audio_check(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn chat_balance_set(
    app: AppHandle,
    selection: chat_balance::Selection,
    position: i32,
    use_main: Option<bool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        chat_balance::change(
            &app,
            Some(selection),
            position,
            false,
            use_main.unwrap_or(false),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn chat_balance_status(app: AppHandle) -> Value {
    chat_balance::status(&app)
}

/// Whether Windows' default sound output is one of Voicemeeter's inputs.
/// The go-live check (golive.rs).
#[tauri::command]
async fn golive_check(app: AppHandle) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || golive::run(&app))
        .await
        .map_err(|e| e.to_string())
}

/// Instant replay: save the last seconds now. Returns the file's path.
#[tauri::command]
async fn replay_save(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || replay::save(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn micfx_status() -> Value {
    micfx::status()
}

#[tauri::command]
fn vst_recover(id: String, bypass: bool) -> Result<(), String> {
    pluginhost::recover_plugin(&id, bypass)
}

/// Hold to compare: a mic's chain bypassed (same delay) while `on`.
#[tauri::command]
fn micfx_compare(app: AppHandle, id: String, on: bool) {
    micfx::compare(&app, &id, on);
}

/// Hear a mic on A1 while setting it up; returns whether it's on now.
#[tauri::command]
fn micfx_listen(app: AppHandle, id: String, on: bool) -> Result<bool, String> {
    micfx::listen(&app, &id, on)
}

/// Switch a mic's chain off or back on, as a shortcut would ("" = every mic).
#[tauri::command]
fn micfx_toggle(app: AppHandle, target: String) -> Result<bool, String> {
    micfx::toggle(&app, &target)
}

/// Every VST3 effect in the usual folders, for Settings → Mic clean-up → Add a plugin.
#[tauri::command]
async fn vst_scan() -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(pluginhost::scan)
        .await
        .map_err(|e| e.to_string())?
}

/// Pick a .vst3 file anywhere; its effects, or nothing if the dialog was cancelled.
#[tauri::command]
async fn vst_browse() -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(|| match files::pick_vst3() {
        Some(p) => {
            let v = pluginhost::describe(p)?;
            if v.is_empty() {
                Err("That plugin has no audio effects (instruments can't go on a mic)".into())
            } else {
                Ok(v)
            }
        }
        None => Ok(Vec::new()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn vst_editor(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pluginhost::open_editor(id))
        .await
        .map_err(|e| e.to_string())?
}

/// The plugin with this id, from any mic's chain.
fn plugin_entry(s: &Value, id: &str) -> Option<Value> {
    micfx::chains_json(&s["micFx"])
        .iter()
        .flat_map(|c| c["plugins"].as_array().cloned().unwrap_or_default())
        .find(|p| p["id"] == id)
}

/// Save a plugin's current settings as a named preset (for any plugin of the same kind).
/// Returns every preset.
#[tauri::command]
async fn vst_preset_save(app: AppHandle, id: String, name: String) -> Result<Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Give the preset a name".into());
    }
    let cid = {
        let s = app.state::<Settings>();
        let s = s.0.lock().unwrap();
        plugin_entry(&s, &id)
            .and_then(|p| p["cid"].as_str().map(str::to_string))
            .ok_or("That plugin isn't on a mic any more")?
    };
    let st = tauri::async_runtime::spawn_blocking(move || pluginhost::get_state(id))
        .await
        .map_err(|e| e.to_string())??;
    let s = app.state::<Settings>();
    let mut s = s.0.lock().unwrap();
    if !s["vstPresets"].is_array() {
        s["vstPresets"] = json!([]);
    }
    let list = s["vstPresets"].as_array_mut().unwrap();
    list.retain(|p| !(p["cid"] == cid.as_str() && p["name"] == name.as_str()));
    list.push(json!({ "name": name, "cid": cid, "c": st["c"], "e": st["e"] }));
    let out = s["vstPresets"].clone();
    app.state::<SettingsDirty>().0.store(true, Ordering::SeqCst);
    log_info!("Plugins: saved a preset");
    Ok(out)
}

/// Give a plugin a saved preset.
#[tauri::command]
async fn vst_preset_apply(app: AppHandle, id: String, name: String) -> Result<(), String> {
    let (c, e) = {
        let s = app.state::<Settings>();
        let s = s.0.lock().unwrap();
        let cid = plugin_entry(&s, &id)
            .and_then(|p| p["cid"].as_str().map(str::to_string))
            .ok_or("That plugin isn't on a mic any more")?;
        let p = s["vstPresets"]
            .as_array()
            .and_then(|a| {
                a.iter()
                    .find(|p| p["cid"] == cid.as_str() && p["name"] == name.as_str())
                    .cloned()
            })
            .ok_or("That preset no longer exists")?;
        (
            p["c"].as_str().unwrap_or("").to_string(),
            p["e"].as_str().unwrap_or("").to_string(),
        )
    };
    tauri::async_runtime::spawn_blocking(move || pluginhost::set_state(id, c, e))
        .await
        .map_err(|e| e.to_string())?
}

/// Delete a preset. Returns every preset left.
#[tauri::command]
fn vst_preset_delete(app: AppHandle, cid: String, name: String) -> Value {
    let s = app.state::<Settings>();
    let mut s = s.0.lock().unwrap();
    if let Some(list) = s["vstPresets"].as_array_mut() {
        list.retain(|p| !(p["cid"] == cid.as_str() && p["name"] == name.as_str()));
    }
    app.state::<SettingsDirty>().0.store(true, Ordering::SeqCst);
    s["vstPresets"].clone()
}

#[tauri::command]
fn replay_status() -> Value {
    replay::status()
}

#[tauri::command]
fn loudness_status() -> Value {
    loudness::status()
}

#[tauri::command]
fn loudness_reset() {
    loudness::reset();
}

#[tauri::command]
fn midi_status() -> Value {
    midi::status()
}

#[tauri::command]
fn midi_learn(on: bool) {
    midi::learn(on);
}

#[tauri::command]
async fn replay_devices() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(replay::devices)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn replay_open_folder() -> Result<(), String> {
    replay::open_folder()
}

/// Music off stream on or off by hand, until OBS next starts or stops.
#[tauri::command]
fn music_guard_toggle(app: AppHandle) -> Result<bool, String> {
    watch::toggle_guard(&app)
}

#[tauri::command]
async fn windows_output(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || winout::status(&app))
        .await
        .map_err(|e| e.to_string())
}

/// "Fix my audio": Windows' sound output back on Voicemeeter, then restart the audio engine.
#[tauri::command]
async fn fix_audio(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || winout::fix_all(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// Screens for the overlay picker: { name, label }. The name is what settings store.
#[tauri::command]
fn screens(app: AppHandle) -> Vec<Value> {
    let Some(w) = app.get_webview_window("main") else {
        return Vec::new();
    };
    let primary = w
        .primary_monitor()
        .ok()
        .flatten()
        .and_then(|m| m.name().cloned());
    w.available_monitors()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .filter_map(|(i, m)| {
            let name = m.name()?.clone();
            let main = primary.as_deref() == Some(name.as_str());
            let label = format!(
                "Screen {} ({}×{}{})",
                i + 1,
                m.size().width,
                m.size().height,
                if main { ", main" } else { "" }
            );
            Some(json!({ "name": name, "label": label }))
        })
        .collect()
}

/// Voicemeeter backups (Settings → Backup and layout), newest first.
#[tauri::command]
fn backups_list() -> Vec<Value> {
    backups::list()
}

#[tauri::command]
async fn backup_restore(app: AppHandle, file: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || backups::restore(&app, &file))
        .await
        .map_err(|e| e.to_string())?
}

/// Save a copy of Voicemeeter's setup before a big change (the setup assistant).
#[tauri::command]
async fn backup_before(app: AppHandle, why: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || backups::before(&app, &why)).await;
}

/// The "Check my setup" list.
#[tauri::command]
async fn health_check(app: AppHandle) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || health::run(&app))
        .await
        .map_err(|e| e.to_string())
}

/// Save a copy of the settings (without this PC's window position or the OBS password).
/// Returns the file, or null if cancelled.
#[tauri::command]
async fn settings_export(app: AppHandle) -> Result<Option<String>, String> {
    let picked =
        tauri::async_runtime::spawn_blocking(|| files::pick_save("Sleekmeeter settings.json"))
            .await
            .map_err(|e| e.to_string())?;
    let Some(path) = picked else { return Ok(None) };
    let mut value = app.state::<Settings>().0.lock().unwrap().clone();
    if let Value::Object(m) = &mut value {
        for k in [
            "window",
            "panelPos",
            "mixWin",
            "mixWinOpen",
            "seenVersion",
            "edition",
        ] {
            m.remove(k);
        }
    }
    if value["obs"].is_object() {
        value["obs"]["password"] = json!("");
    }
    if value["remote"].is_object() {
        value["remote"]["key"] = json!("");
    }
    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Couldn't save the backup: {e}"))?;
    log_info!("Exported settings to {path}");
    Ok(Some(path))
}

/// Restore settings from a backup. Returns the file, or null if cancelled. The page reloads after.
#[tauri::command]
async fn settings_import(app: AppHandle) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(files::pick_open)
        .await
        .map_err(|e| e.to_string())?;
    let Some(path) = picked else { return Ok(None) };
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("Couldn't read that file: {e}"))?;
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|e| format!("That file isn't a Sleekmeeter backup ({e})"))?;
    let Value::Object(saved) = parsed else {
        return Err("That file isn't a Sleekmeeter backup".into());
    };
    if !["hotkeys", "theme", "appearance", "fades"]
        .iter()
        .any(|k| saved.contains_key(*k))
    {
        return Err("That file doesn't look like a Sleekmeeter backup".into());
    }
    let mut value = settings::defaults();
    if let Value::Object(base) = &mut value {
        for (k, v) in saved {
            base.insert(k, v);
        }
    }
    {
        let state = app.state::<Settings>();
        let cur = state.0.lock().unwrap();
        for k in [
            "window",
            "panelPos",
            "mixWin",
            "mixWinOpen",
            "seenVersion",
            "edition",
        ] {
            value[k] = cur[k].clone();
        }
        // Backups don't carry the OBS password: keep the one this PC has.
        let mine = cur["obs"]["password"].as_str().unwrap_or("").to_string();
        if !mine.is_empty() && value["obs"]["password"].as_str().unwrap_or("").is_empty() {
            value["obs"]["password"] = json!(mine);
        }
        let key = cur["remote"]["key"].as_str().unwrap_or("").to_string();
        if !key.is_empty() && value["remote"].is_object() {
            value["remote"]["key"] = json!(key);
        }
    }
    settings_set(app.clone(), value)?;
    log_info!("Restored settings from {path}");
    let now = app.state::<Settings>().0.lock().unwrap().clone();
    let _ = app.emit("settings-changed", now);
    Ok(Some(path))
}

/// Put the window and the tray panel back where they start: default size, centred, panel docked.
#[tauri::command]
fn reset_layout(app: AppHandle) -> Result<(), String> {
    let snapshot = {
        let st = app.state::<Settings>();
        let mut s = st.0.lock().unwrap();
        s["window"] = Value::Null;
        s["panelPos"] = Value::Null;
        s["mixWin"] = Value::Null;
        s["panelDocked"] = json!(true);
        s["mini"] = json!(false);
        settings::save(&s)?;
        s.clone()
    };
    if let Some(w) = app.get_webview_window("main") {
        if w.is_maximized().unwrap_or(false) {
            let _ = w.unmaximize();
        }
        let _ = w.set_size(LogicalSize::new(1400.0, 800.0));
        let _ = w.center();
    }
    if let Some(w) = app.get_webview_window(MIXWIN) {
        let _ = w.unmaximize();
        let _ = w.set_size(LogicalSize::new(1180.0, 520.0));
        let _ = w.center();
    }
    *app.state::<NormalSize>().0.lock().unwrap() = None;
    log_info!("Layout reset");
    let _ = app.emit("settings-changed", snapshot);
    Ok(())
}

/* ---------------- automatic scene switching ---------------- */

#[tauri::command]
fn running_apps() -> Vec<String> {
    apps::suggestions()
}

/// Load a scene file into Voicemeeter and tell the mixer which one it was.
fn load_scene_auto(app: &AppHandle, name: &str, because: &str) {
    let Ok(path) = scene_path(name) else { return };
    if !path.exists() {
        return;
    }
    log_info!("Automatic switch: {because} → scene {name:?}");
    if let Err(e) = fades::load_scene(app, path, Some(json!({ "scene": name, "app": because }))) {
        log_error!("Automatic switch to {name:?} failed: {e}");
    }
}

/// One automatic rule: when `app` starts, load `scene`, switch to the `outputs` profile and
/// use `theme` (each optional). When it closes, `restore` is loaded and the rest goes back.
#[derive(Clone)]
struct Rule {
    app: String,
    scene: String,
    restore: String,
    outputs: String,
    theme: String,
}

/// An app with a rule started (or is the latest still running after another closed).
/// `saved_outputs` remembers which output profile was in use before any rule changed it.
fn enter_rule(app: &AppHandle, r: &Rule, saved_outputs: &mut Option<Option<String>>) {
    if !r.scene.is_empty() {
        load_scene_auto(app, &r.scene, &r.app);
    }
    if !r.outputs.is_empty() {
        if saved_outputs.is_none() {
            let settings = app.state::<Settings>().0.lock().unwrap().clone();
            let snap = app.state::<Vm>().last.lock().unwrap().clone();
            *saved_outputs = Some(outputs::current(&settings, &snap));
        }
        outputs::switch_with_osd(app, &r.outputs, &format!("{} started", r.app));
    }
    *AUTO_THEME.lock().unwrap() = r.theme.clone();
    let _ = app.emit("theme-auto", json!({ "theme": r.theme }));
}

/// The last app with a rule closed: put things back.
fn leave_rules(
    app: &AppHandle,
    restore: &str,
    because: &str,
    saved_outputs: &mut Option<Option<String>>,
) {
    if !restore.is_empty() {
        load_scene_auto(app, restore, because);
    }
    if let Some(Some(name)) = saved_outputs.take() {
        outputs::switch_with_osd(app, &name, &format!("{because} closed"));
    }
    AUTO_THEME.lock().unwrap().clear();
    let _ = app.emit("theme-auto", json!({ "theme": "" }));
}

/// Every 2 s: when a rule's app starts, apply its rule; when it closes, go back to the rule of
/// the app that started before it, or to what was there before. Apps already running when
/// Sleekmeeter starts don't trigger anything.
fn spawn_scene_rules(app: AppHandle) {
    std::thread::spawn(move || {
        let mut prev: Option<std::collections::BTreeSet<String>> = None;
        let mut active: Vec<String> = Vec::new();
        let mut saved_outputs: Option<Option<String>> = None;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let rules: Vec<Rule> = app.state::<Settings>().0.lock().unwrap()["sceneRules"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|r| {
                    let text = |k: &str| r[k].as_str().unwrap_or("").to_string();
                    let rule = Rule {
                        app: text("app").trim().to_lowercase(),
                        scene: text("scene"),
                        restore: text("restore"),
                        outputs: text("outputs"),
                        theme: text("theme"),
                    };
                    let does_something = !(rule.scene.is_empty()
                        && rule.outputs.is_empty()
                        && rule.theme.is_empty());
                    (!rule.app.is_empty() && does_something).then_some(rule)
                })
                .collect();
            if rules.is_empty() {
                prev = None;
                active.clear();
                saved_outputs = None;
                continue;
            }
            let running = apps::running();
            let rule_for = |a: &str| rules.iter().find(|r| r.app == a).cloned();
            match &prev {
                None => {
                    active = rules
                        .iter()
                        .filter(|r| running.contains(&r.app))
                        .map(|r| r.app.clone())
                        .collect();
                    active.dedup();
                }
                Some(before) => {
                    let mut seen = std::collections::BTreeSet::new();
                    for rule in rules.iter() {
                        let a = &rule.app;
                        if !seen.insert(a.clone()) {
                            continue; // first rule for an app wins
                        }
                        let now_on = running.contains(a);
                        let was_on = before.contains(a);
                        if now_on && !was_on {
                            active.retain(|x| x != a);
                            active.push(a.clone());
                            enter_rule(&app, rule, &mut saved_outputs);
                        } else if !now_on && was_on {
                            active.retain(|x| x != a);
                            if let Some(top) = active.last().and_then(|t| rule_for(t.as_str())) {
                                enter_rule(&app, &top, &mut saved_outputs);
                            } else {
                                leave_rules(&app, &rule.restore, a, &mut saved_outputs);
                            }
                        }
                    }
                }
            }
            prev = Some(running);
        }
    });
}

/* ---------------- remember the window's size and position ---------------- */

/// Record the main window's size and position (not in mini mode, not while minimized).
fn remember_window(window: &tauri::Window) {
    remember_geometry(window, "window");
}

/// Record a window's size, place and maximized state under `key` in the settings.
fn remember_geometry(window: &tauri::Window, key: &str) {
    let app = window.app_handle();
    let state = app.state::<Settings>();
    let mut s = state.0.lock().unwrap();
    if (key == "window" && settings::flag(&s, "mini")) || window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let mut geo = s[key].clone();
    if !geo.is_object() {
        geo = json!({});
    }
    geo["maximized"] = json!(maximized);
    // Keep the normal size while maximized, so un-maximizing goes back to it.
    if !maximized {
        let scale = window.scale_factor().unwrap_or(1.0);
        if let (Ok(size), Ok(pos)) = (window.inner_size(), window.outer_position()) {
            let size = size.to_logical::<f64>(scale);
            if size.width >= 300.0 && size.height >= 200.0 {
                geo["width"] = json!(size.width.round());
                geo["height"] = json!(size.height.round());
                geo["x"] = json!(pos.x);
                geo["y"] = json!(pos.y);
            }
        }
    }
    if s[key] != geo {
        s[key] = geo;
        app.state::<SettingsDirty>().0.store(true, Ordering::SeqCst);
    }
}

/// Put the main window back where it was last time. Returns false when nothing was saved.
fn restore_window(w: &WebviewWindow, s: &Value) -> bool {
    restore_geometry(w, &s["window"], (760.0, 520.0))
}

/// Put a window back to a size and place saved by `remember_geometry`.
fn restore_geometry(w: &WebviewWindow, geo: &Value, min: (f64, f64)) -> bool {
    let (Some(width), Some(height)) = (geo["width"].as_f64(), geo["height"].as_f64()) else {
        return false;
    };
    let _ = w.set_size(LogicalSize::new(width.max(min.0), height.max(min.1)));
    if let (Some(x), Some(y)) = (geo["x"].as_i64(), geo["y"].as_i64()) {
        // Only if that spot is still on a connected monitor.
        let (cx, cy) = (x + 80, y + 20);
        let visible = w.available_monitors().unwrap_or_default().iter().any(|m| {
            let (p, z) = (m.position(), m.size());
            cx >= p.x as i64
                && cx < p.x as i64 + z.width as i64
                && cy >= p.y as i64
                && cy < p.y as i64 + z.height as i64
        });
        if visible {
            let _ = w.set_position(PhysicalPosition::new(x as i32, y as i32));
        } else {
            let _ = w.center();
        }
    }
    if geo["maximized"].as_bool().unwrap_or(false) {
        let _ = w.maximize();
    }
    true
}

/// First launch only: make the window just wide enough for the mixer, centred on its screen.
#[tauri::command]
fn window_fit(
    window: WebviewWindow,
    first: State<'_, FirstLaunch>,
    width: f64,
) -> Result<(), String> {
    if window.label() != "main" || !first.0.swap(false, Ordering::SeqCst) {
        return Ok(());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let max_w = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().width as f64 / m.scale_factor() - 40.0)
        .unwrap_or(1900.0);
    let width = width.clamp(760.0, max_w.max(760.0));
    window
        .set_size(LogicalSize::new(width, size.height))
        .map_err(|e| e.to_string())?;
    let _ = window.center();
    Ok(())
}

fn main() {
    logs::init(&settings::app_dir());
    // The plugin host: a second copy that runs VST3 plugins for the first (pluginhost.rs).
    // It starts no window, tray or single-instance check.
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--plugin-host") {
        let parent = args.get(i + 1).and_then(|p| p.parse().ok()).unwrap_or(0);
        pluginhost::child_main(parent);
    }
    recover::wait_for_previous();
    log_info!(
        "Sleekmeeter {} starting ({}){}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::ARCH,
        if std::env::args().any(|a| a == "--autostart") {
            ", started with Windows"
        } else {
            ""
        }
    );
    let had_settings = settings::exists();
    let mut settings = settings::load();
    // The setup guide opens by itself once, on a fresh install. People updating from an older
    // version already have their sound set up, so it waits in the ⋯ menu for them.
    if settings.get("setupGuide").map_or(true, Value::is_null) {
        settings["setupGuide"] = json!(if had_settings { "existing" } else { "pending" });
    }
    // Saves the settings (with the setupGuide answer) whenever the version changed.
    let pending_notes = notes::on_start(&mut settings, had_settings);
    // Installing a new version by hand runs the old uninstaller, which removes the startup
    // entry. Put it back when the saved setting still says to start with Windows.
    if settings::flag(&settings, "startWithWindows") && !win::autostart_enabled() {
        match win::set_autostart(true) {
            Ok(()) => log_info!("Added Sleekmeeter back to startup apps"),
            Err(e) => log_warn!("{e}"),
        }
    }
    let api = Api::load().map(Arc::new);
    match &api {
        None => log_warn!(
            "Voicemeeter's remote DLL wasn't found (install folder: {:?})",
            vm::install_dir()
        ),
        Some(a) => {
            // Login returns 1 when Voicemeeter isn't running yet.
            let login = a.login();
            log_info!("Logged in to the Voicemeeter remote API (code {login})");
            if login == 1 && settings::flag(&settings, "launchVoicemeeter") {
                let edition = last_edition(&settings);
                match a.run(edition) {
                    Ok(()) => log_info!("Started Voicemeeter (edition {edition})"),
                    Err(e) => log_warn!("Couldn't start Voicemeeter: {e}"),
                }
            }
        }
    }
    let initial = offline_state(api.is_some());
    let api_for_setup = api.clone();
    let autostarted = std::env::args().any(|a| a == "--autostart");

    let app = tauri::Builder::default()
        // Only one Sleekmeeter at a time: starting it again (pinned taskbar icon, Start menu,
        // desktop shortcut) brings the running one's window back instead of opening another.
        // Registered first, so a second copy quits before it creates any windows.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            log_info!("Sleekmeeter was started again; showing this copy instead");
            if !args.iter().any(|a| a == "--autostart") {
                show_main(app);
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    run_hotkey(app, shortcut, event.state() == ShortcutState::Pressed);
                })
                .build(),
        )
        .manage(Vm {
            api: api.clone(),
            last: Mutex::new(initial),
            hide_vm_until: Mutex::new(None),
            osd_until: Mutex::new(None),
            smooth: Mutex::new(gain::Smooth::new()),
            duck_targets: Mutex::new(Vec::new()),
            rec: Mutex::new(recorder::RecState::default()),
            holds: Mutex::new(hold::Holds::default()),
            brb: Mutex::new(brb::Brb::default()),
        })
        .manage(Settings(Mutex::new(settings.clone())))
        .manage(WhatsNew(Mutex::new(pending_notes)))
        .manage(Hotkeys(Mutex::new(Vec::new())))
        .manage(NormalSize(Mutex::new(None)))
        .manage(PanelSize(Mutex::new(None)))
        .manage(ShowOnReady(std::sync::atomic::AtomicBool::new(false)))
        .manage(SettingsDirty(std::sync::atomic::AtomicBool::new(false)))
        .manage(FirstLaunch(std::sync::atomic::AtomicBool::new(
            settings["window"].is_null() && !settings::flag(&settings, "mini"),
        )))
        .manage(TrayClicks {
            gen: AtomicU64::new(0),
            last_double: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            vm_snapshot,
            vm_set_float,
            vm_get_floats,
            audio_events_list,
            audio_events_clear,
            mic_tune_meter,
            mic_tune_change,
            mic_tune_finish,
            vm_glide,
            vm_route_mute,
            app_info,
            open_logs,
            streamdeck_status,
            streamdeck_install,
            streamdeck_profile_save,
            streamdeck_get_app,
            ui_log,
            recorder_cmd,
            recorder_open,
            recorder_load,
            vm_set_string,
            outputs_capture,
            outputs_apply,
            app_volumes,
            app_volume_set,
            app_route_devices,
            app_route_defaults,
            app_route_set,
            vm_launch,
            vm_devices,
            vm_show_window,
            scene_list,
            scene_save,
            scene_load,
            scene_preview,
            scene_delete,
            settings_get,
            settings_set,
            mix_preference_set,
            window_mini,
            open_mixer,
            mix_window,
            whats_new,
            panel_dock,
            flyout_close,
            panel_fit,
            check_update,
            update_install,
            sound_devices,
            sound_play,
            sound_stop,
            selftest_inputs,
            output_fallback_status,
            selftest_run,
            guided_audio_test,
            mix_monitor_start,
            mix_monitor_stop,
            mic_take_record,
            mic_take_play,
            mic_take_clear,
            mic_preset_export,
            mic_preset_preview,
            mic_preset_apply,
            mic_preset_clear,
            sound_pick,
            sound_pick_folder,
            sound_pick_pack,
            sound_import,
            twitch_status,
            remote_status,
            history_get,
            history_clear,
            ui_ready,
            window_fit,
            open_release,
            running_apps,
            brb_toggle,
            obs_status,
            obs_audio_check,
            chat_balance_set,
            chat_balance_status,
            health_check,
            crackle_check,
            open_windows_page,
            bt_status,
            coach_start,
            coach_stop,
            coach_status,
            golive_check,
            replay_save,
            replay_status,
            loudness_status,
            loudness_reset,
            midi_status,
            midi_learn,
            micfx_status,
            vst_recover,
            vst_scan,
            vst_browse,
            vst_editor,
            micfx_compare,
            micfx_listen,
            micfx_toggle,
            vst_preset_save,
            vst_preset_apply,
            vst_preset_delete,
            replay_devices,
            replay_open_folder,
            music_guard_toggle,
            backups_list,
            backup_restore,
            backup_before,
            screens,
            windows_output,
            fix_audio,
            settings_export,
            settings_import,
            reset_layout
        ])
        .setup(move |app| {
            // Tray icon: click shows/hides the mixer, double-click opens the volume panel,
            // right-click for the menu.
            let show = MenuItem::with_id(app, "show", "Show Sleekmeeter", true, None::<&str>)?;
            let panel = MenuItem::with_id(app, "panel", "Open volume panel", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Sleekmeeter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &panel, &quit])?;
            let mut tray = TrayIconBuilder::with_id("sleekmeeter")
                .tooltip(concat!("Sleekmeeter ", env!("CARGO_PKG_VERSION")))
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "panel" => toggle_flyout(app, None),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    let app = tray.app_handle().clone();
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => {
                            let clicks = app.state::<TrayClicks>();
                            // The second click of a double-click: already handled.
                            let recent_double = clicks
                                .last_double
                                .lock()
                                .unwrap()
                                .map(|t| t.elapsed() < Duration::from_millis(500))
                                .unwrap_or(false);
                            if recent_double {
                                return;
                            }
                            // Wait briefly so a double-click can cancel the single click.
                            let gen = clicks.gen.fetch_add(1, Ordering::SeqCst) + 1;
                            std::thread::spawn(move || {
                                std::thread::sleep(Duration::from_millis(280));
                                if app.state::<TrayClicks>().gen.load(Ordering::SeqCst) == gen {
                                    toggle_main(&app);
                                }
                            });
                        }
                        TrayIconEvent::DoubleClick {
                            button: MouseButton::Left,
                            position,
                            ..
                        } => {
                            let clicks = app.state::<TrayClicks>();
                            clicks.gen.fetch_add(1, Ordering::SeqCst);
                            *clicks.last_double.lock().unwrap() = Some(Instant::now());
                            toggle_flyout(&app, Some(position));
                        }
                        _ => {}
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            let handle = app.handle().clone();
            for p in apply_hotkeys(&handle, &settings["hotkeys"]) {
                log_warn!("Shortcut: {p}");
            }
            if let Some(w) = app.get_webview_window("osd") {
                recover::watch(&w);
            }
            if let Some(w) = app.get_webview_window("main") {
                recover::watch(&w);
                let _ = w.set_always_on_top(settings::flag(&settings, "alwaysOnTop"));
                if !settings::flag(&settings, "mini") {
                    restore_window(&w, &settings);
                }
                // Started with Windows and asked to stay in the tray: don't show the window.
                // Otherwise show it once the page has drawn (ui_ready), or after 3 s at the latest.
                // A restart after a display crash keeps the window where it was (recover.rs).
                if !(autostarted && settings::flag(&settings, "startInTray"))
                    && !recover::start_hidden()
                {
                    app.state::<ShowOnReady>().0.store(true, Ordering::SeqCst);
                    let late = handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(3));
                        if late.state::<ShowOnReady>().0.swap(false, Ordering::SeqCst) {
                            if let Some(w) = late.get_webview_window("main") {
                                let _ = w.show();
                                recover::check_main_draws(&late);
                            }
                        }
                    });
                }
            }

            // Write remembered window size/position to settings.json at most once a second.
            let saver = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                if saver
                    .state::<SettingsDirty>()
                    .0
                    .swap(false, Ordering::SeqCst)
                {
                    let s = saver.state::<Settings>().0.lock().unwrap().clone();
                    let _ = settings::save(&s);
                }
            });

            // Left open last time (for example on a second screen): open it again.
            if settings::flag(&settings, "mixWinOpen") {
                open_mix_window(&handle);
            }

            if let Some(api) = api_for_setup.clone() {
                spawn_poller(handle.clone(), api);
                spawn_scene_rules(handle.clone());
                obs::spawn(handle.clone());
                twitch::spawn(handle.clone());
                remote::spawn(handle.clone());
                replay::spawn(handle.clone());
                loudness::spawn(handle.clone());
                midi::spawn(handle.clone());
                micfx::spawn(handle.clone());
                winout::spawn(handle.clone());
                usage::spawn(handle.clone());
                routing::spawn(handle.clone());
                backups::spawn(handle.clone());
                btwatch::spawn(handle.clone());
                devwatch::spawn(handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing the window keeps Sleekmeeter in the tray; quit from the tray menu.
            // The output mix window really closes (Alt+F4 too), and stays closed next time.
            WindowEvent::CloseRequested { .. } if window.label() == MIXWIN => {
                selftest::live_stop(Some(MIXWIN));
                set_mix_window_open(window.app_handle(), false);
            }
            WindowEvent::Resized(_) | WindowEvent::Moved(_) if window.label() == MIXWIN => {
                remember_geometry(window, "mixWin");
            }
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.label() == "main" {
                    mic_tune::stop_meter();
                    let _ = mic_tune::finish(window.app_handle(), false, true);
                    selftest::live_stop(Some("main"));
                    let _ = window.emit(
                        "mix-monitor-ended",
                        "Monitoring stopped when the window closed.",
                    );
                    remember_window(window);
                }
                let _ = window.hide();
            }
            WindowEvent::Resized(_) | WindowEvent::Moved(_) if window.label() == "main" => {
                remember_window(window);
            }
            // An undocked tray panel remembers where you put it.
            WindowEvent::Moved(pos) if window.label() == FLYOUT => {
                let app = window.app_handle();
                let st = app.state::<Settings>();
                let mut s = st.0.lock().unwrap();
                if !settings::flag_or(&s, "panelDocked", true)
                    && window.is_visible().unwrap_or(false)
                {
                    s["panelPos"] = json!({ "x": pos.x, "y": pos.y });
                    app.state::<SettingsDirty>().0.store(true, Ordering::SeqCst);
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to start Sleekmeeter");

    app.run(move |_handle, event| {
        if let RunEvent::Exit = event {
            log_info!("Sleekmeeter quitting");
            let _ = mic_tune::finish(_handle, false, true);
            selftest::live_stop(None);
            // Ducked or fading channels go straight back to their own level.
            fades::release(_handle, api.as_deref());
            // Give Voicemeeter's audio insert back before logging out.
            micfx::shutdown(_handle, api.as_deref());
            if let Some(a) = &api {
                a.logout();
            }
            if _handle
                .state::<SettingsDirty>()
                .0
                .swap(false, Ordering::SeqCst)
            {
                let s = _handle.state::<Settings>().0.lock().unwrap().clone();
                let _ = settings::save(&s);
            }
        }
    });
}
