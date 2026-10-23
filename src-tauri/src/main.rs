// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// First, so its log_info!/log_warn!/log_error! macros work in every module below.
#[macro_use]
mod logs;
mod apps;
mod appvol;
mod devwatch;
mod fades;
mod gain;
mod hold;
mod outputs;
mod recorder;
mod settings;
mod update;
mod vm;
mod win;

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
}

struct Settings(Mutex<Value>);
struct Hotkeys(Mutex<Vec<(Shortcut, Value)>>);
struct NormalSize(Mutex<Option<LogicalSize<f64>>>);
/// Last size the tray panel asked for (logical px), so it reopens at the right size.
struct PanelSize(Mutex<Option<(f64, f64)>>);
/// Show the main window once the page has drawn (avoids a blank or see-through flash).
struct ShowOnReady(std::sync::atomic::AtomicBool);
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
    tauri::async_runtime::spawn_blocking(appvol::list)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn app_volume_set(
    exe: String,
    volume: Option<f32>,
    mute: Option<bool>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || appvol::set(&exe, volume, mute))
        .await
        .map_err(|e| e.to_string())?
        .inspect_err(|e| log_warn!("Per-app volume: {e}"))
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
    Ok(())
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
    let state = app.state::<Settings>();
    let mut current = state.0.lock().unwrap();
    if !current["edition"].is_null() {
        value["edition"] = current["edition"].clone();
    }
    // Window size and position are recorded here in Rust; the page never edits them.
    if !current["window"].is_null() {
        value["window"] = current["window"].clone();
    }
    *current = value.clone();
    drop(current);
    settings::save(&value)?;
    Ok(json!({ "problems": problems }))
}

/* ---------------- window: mini mode ---------------- */

#[tauri::command]
fn window_mini(app: AppHandle, mini: bool, rows: u32, width: Option<f64>) -> Result<(), String> {
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
        let h = 64.0 + 44.0 * rows.max(1) as f64;
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
    let vm = app.state::<Vm>();
    let Some(api) = vm.api.clone() else { return };
    let channel = target.starts_with("Strip[") || target.starts_with("Bus[");
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
    match kind {
        "mute" if channel => {
            let _ = fades::toggle_mute(app, &api, &target);
        }
        "volup" if channel => {
            let _ = fades::nudge(app, &api, &target, 2.0);
        }
        "voldown" if channel => {
            let _ = fades::nudge(app, &api, &target, -2.0);
        }
        "window" => toggle_main(app),
        "output" if !target.is_empty() => outputs::switch_with_osd(app, &target, "shortcut"),
        "outputnext" => outputs::cycle(app),
        "duck" => {
            let on = {
                let st = app.state::<Settings>();
                let mut s = st.0.lock().unwrap();
                let on = !s["ducking"]["on"].as_bool().unwrap_or(false);
                if !s["ducking"].is_object() {
                    s["ducking"] = settings::defaults()["ducking"].clone();
                }
                s["ducking"]["on"] = json!(on);
                log_info!(
                    "Shortcut: talk-over ducking {}",
                    if on { "on" } else { "off" }
                );
                let _ = settings::save(&s);
                let _ = app.emit("settings-changed", s.clone());
                on
            };
            show_osd_text(
                app,
                "Talk-over ducking",
                if on { "On" } else { "Off" },
                on,
                "mic",
            );
        }
        "record" => {
            if let Ok(rec) = recorder::toggle_record(app, &api) {
                let text = if rec { "Recording" } else { "Stopped" };
                show_osd_text(app, "Recorder", text, rec, "record");
            }
        }
        _ => {}
    }
}

/* ---------------- volume overlay ---------------- */

/// Move the overlay to the bottom centre of the screen the mixer is on.
fn place_osd(app: &AppHandle, osd: &WebviewWindow) {
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| osd.primary_monitor().ok().flatten());
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
    let Some(osd) = app.get_webview_window("osd") else {
        return;
    };
    place_osd(app, &osd);
    let theme = settings::theme(&app.state::<Settings>().0.lock().unwrap());
    let _ = app.emit_to(
        "osd",
        "osd",
        json!({ "theme": theme, "name": name, "text": text, "on": on, "icon": icon,
                "color": if icon == "record" { "rose" } else { "amber" } }),
    );
    let _ = osd.show();
    *app.state::<Vm>().osd_until.lock().unwrap() =
        Some(Instant::now() + Duration::from_millis(1600));
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
    let _ = app.emit_to(
        "osd",
        "osd",
        json!({
            "theme": theme,
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
                let settling = Instant::now() < reread_until;
                let periodic = last_full.elapsed() > Duration::from_secs(1);
                if dirty == 1 || periodic || settling {
                    last_full = Instant::now();
                    let mut snap = api.snapshot(edition);
                    fades::dress(&app, &mut snap);
                    outputs::dress(&app, &mut snap);
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
                if window_visible(&app, "main") || window_visible(&app, FLYOUT) {
                    let _ = app.emit("vm-levels", api.levels(&layout));
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
    if settling || !settings::flag(&app.state::<Settings>().0.lock().unwrap(), "overlay") {
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
    if (1..=2).contains(&changes.len()) {
        let (kind, i) = changes[0];
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

/// Size the panel and put it next to the tray icon (or bottom-right when opened another way).
fn place_flyout(app: &AppHandle, w: &WebviewWindow, anchor: Option<PhysicalPosition<f64>>) {
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
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build();
    if let Ok(w) = built {
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
        .clamp(300.0, 800.0);
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
async fn check_update() -> Result<Value, String> {
    let result = tauri::async_runtime::spawn_blocking(update::latest)
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

#[tauri::command]
fn open_release(url: String) -> Result<(), String> {
    update::open(&url)
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

/// Every 2 s: when a rule's app starts, load its scene; when it closes, go back to the scene
/// of the app that started before it, or to the rule's "when it closes" scene.
/// Apps already running when Sleekmeeter starts don't trigger anything.
fn spawn_scene_rules(app: AppHandle) {
    std::thread::spawn(move || {
        let mut prev: Option<std::collections::BTreeSet<String>> = None;
        let mut active: Vec<String> = Vec::new();
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let rules: Vec<(String, String, String)> = app.state::<Settings>().0.lock().unwrap()
                ["sceneRules"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|r| {
                    let a = r["app"].as_str()?.trim().to_lowercase();
                    let scene = r["scene"].as_str()?.to_string();
                    let restore = r["restore"].as_str().unwrap_or("").to_string();
                    (!a.is_empty() && !scene.is_empty()).then_some((a, scene, restore))
                })
                .collect();
            if rules.is_empty() {
                prev = None;
                active.clear();
                continue;
            }
            let running = apps::running();
            let rule_for = |a: &str| rules.iter().find(|r| r.0 == a).cloned();
            match &prev {
                None => {
                    active = rules
                        .iter()
                        .filter(|r| running.contains(&r.0))
                        .map(|r| r.0.clone())
                        .collect();
                    active.dedup();
                }
                Some(before) => {
                    let mut seen = std::collections::BTreeSet::new();
                    for (a, scene, restore) in rules.iter() {
                        if !seen.insert(a.clone()) {
                            continue; // first rule for an app wins
                        }
                        let now_on = running.contains(a);
                        let was_on = before.contains(a);
                        if now_on && !was_on {
                            active.retain(|x| x != a);
                            active.push(a.clone());
                            load_scene_auto(&app, scene, a);
                        } else if !now_on && was_on {
                            active.retain(|x| x != a);
                            if let Some(top) = active.last().and_then(|t| rule_for(t.as_str())) {
                                load_scene_auto(&app, &top.1, &top.0);
                            } else if !restore.is_empty() {
                                load_scene_auto(&app, restore, a);
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
    let app = window.app_handle();
    let state = app.state::<Settings>();
    let mut s = state.0.lock().unwrap();
    if settings::flag(&s, "mini") || window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let mut geo = s["window"].clone();
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
    if s["window"] != geo {
        s["window"] = geo;
        app.state::<SettingsDirty>().0.store(true, Ordering::SeqCst);
    }
}

/// Put the main window back where it was last time. Returns false when nothing was saved.
fn restore_window(w: &WebviewWindow, s: &Value) -> bool {
    let geo = &s["window"];
    let (Some(width), Some(height)) = (geo["width"].as_f64(), geo["height"].as_f64()) else {
        return false;
    };
    let _ = w.set_size(LogicalSize::new(width.max(760.0), height.max(520.0)));
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
    let settings = settings::load();
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
        })
        .manage(Settings(Mutex::new(settings.clone())))
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
            vm_glide,
            app_info,
            open_logs,
            ui_log,
            recorder_cmd,
            recorder_open,
            recorder_load,
            vm_set_string,
            outputs_capture,
            outputs_apply,
            app_volumes,
            app_volume_set,
            vm_launch,
            vm_devices,
            vm_show_window,
            scene_list,
            scene_save,
            scene_load,
            scene_delete,
            settings_get,
            settings_set,
            window_mini,
            open_mixer,
            panel_dock,
            flyout_close,
            panel_fit,
            check_update,
            ui_ready,
            window_fit,
            open_release,
            running_apps
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
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_always_on_top(settings::flag(&settings, "alwaysOnTop"));
                if !settings::flag(&settings, "mini") {
                    restore_window(&w, &settings);
                }
                // Started with Windows and asked to stay in the tray: don't show the window.
                // Otherwise show it once the page has drawn (ui_ready), or after 3 s at the latest.
                if !(autostarted && settings::flag(&settings, "startInTray")) {
                    app.state::<ShowOnReady>().0.store(true, Ordering::SeqCst);
                    let late = handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(3));
                        if late.state::<ShowOnReady>().0.swap(false, Ordering::SeqCst) {
                            if let Some(w) = late.get_webview_window("main") {
                                let _ = w.show();
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

            if let Some(api) = api_for_setup.clone() {
                spawn_poller(handle.clone(), api);
                spawn_scene_rules(handle.clone());
                devwatch::spawn(handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing the window keeps Sleekmeeter in the tray; quit from the tray menu.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.label() == "main" {
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
            // Ducked or fading channels go straight back to their own level.
            fades::release(_handle, api.as_deref());
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
