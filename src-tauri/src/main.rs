// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod settings;
mod vm;
mod win;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, RunEvent, State, WindowEvent,
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
}

struct Settings(Mutex<Value>);
struct Hotkeys(Mutex<Vec<(Shortcut, Value)>>);
struct NormalSize(Mutex<Option<LogicalSize<f64>>>);

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
fn vm_set_float(vm: State<'_, Vm>, name: String, value: f32) -> Result<(), String> {
    api(&vm)?.set_float(&name, value)
}

#[tauri::command]
fn vm_set_string(vm: State<'_, Vm>, name: String, value: String) -> Result<(), String> {
    api(&vm)?.set_string(&name, &value)
}

#[tauri::command]
fn vm_launch(vm: State<'_, Vm>) -> Result<(), String> {
    api(&vm)?.run(2) // Voicemeeter Banana
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
fn scene_save(vm: State<'_, Vm>, name: String) -> Result<(), String> {
    let path = scene_path(&name)?;
    api(&vm)?.set_string("Command.Save", &path.to_string_lossy())
}

#[tauri::command]
fn scene_load(vm: State<'_, Vm>, name: String) -> Result<(), String> {
    let path = scene_path(&name)?;
    if !path.exists() {
        return Err(format!("The scene “{name}” no longer exists"));
    }
    api(&vm)?.set_string("Command.Load", &path.to_string_lossy())
}

#[tauri::command]
fn scene_delete(name: String) -> Result<(), String> {
    std::fs::remove_file(scene_path(&name)?).map_err(|e| format!("Couldn't delete the scene: {e}"))
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
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(settings::flag(&value, "alwaysOnTop"));
    }
    *app.state::<Settings>().0.lock().unwrap() = value.clone();
    settings::save(&value)?;
    Ok(json!({ "problems": problems }))
}

/* ---------------- window: mini mode ---------------- */

#[tauri::command]
fn window_mini(app: AppHandle, mini: bool, rows: u32) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("No main window")?;
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
        let _ = w.set_min_size(Some(LogicalSize::new(300.0, 120.0)));
        w.set_size(LogicalSize::new(400.0, h))
            .map_err(|e| e.to_string())?;
    } else {
        let size = saved
            .0
            .lock()
            .unwrap()
            .unwrap_or(LogicalSize::new(1280.0, 760.0));
        let _ = w.set_min_size(Some(LogicalSize::new(760.0, 520.0)));
        w.set_size(size).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* ---------------- global hotkeys ---------------- */

/// (Re)register every shortcut. Returns one message per shortcut that couldn't be used.
fn apply_hotkeys(app: &AppHandle, list: &Value) -> Vec<String> {
    let gs = app.global_shortcut();
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
    problems
}

fn run_hotkey(app: &AppHandle, shortcut: &Shortcut) {
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
    match action["action"].as_str().unwrap_or("") {
        "mute" => {
            let _ = api.toggle(&format!("{target}.Mute"));
        }
        "volup" => {
            let _ = api.nudge(&format!("{target}.Gain"), 2.0, -60.0, 12.0);
        }
        "voldown" => {
            let _ = api.nudge(&format!("{target}.Gain"), -2.0, -60.0, 12.0);
        }
        "window" => toggle_main(app),
        _ => {}
    }
}

/* ---------------- volume overlay ---------------- */

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
        } else if i == l.hw_strips {
            "Voicemeeter Input".into()
        } else {
            "Voicemeeter AUX".into()
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

    // Bottom centre of the screen the mixer window is on.
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
    let _ = app.emit_to(
        "osd",
        "osd",
        json!({
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

        loop {
            let started = Instant::now();
            let dirty = api.is_dirty();

            if dirty < 0 {
                if connected {
                    connected = false;
                    prev = None;
                    publish(&app, offline_state(true));
                }
            } else {
                if !connected {
                    connected = true;
                    edition = api.edition().unwrap_or(2);
                    // Right after Voicemeeter starts its parameters settle over a second or two.
                    reread_until = Instant::now() + Duration::from_secs(3);
                    let s = app.state::<Settings>().0.lock().unwrap().clone();
                    if settings::flag(&s, "hideVoicemeeter") {
                        *app.state::<Vm>().hide_vm_until.lock().unwrap() =
                            Some(Instant::now() + Duration::from_secs(10));
                    }
                }
                let settling = Instant::now() < reread_until;
                let periodic = last_full.elapsed() > Duration::from_secs(1);
                if dirty == 1 || periodic || settling {
                    last_full = Instant::now();
                    let snap = api.snapshot(edition);
                    if let Some(p) = &prev {
                        maybe_osd(&app, p, &snap, settling);
                    }
                    prev = Some(snap.clone());
                    publish(&app, snap);
                }
                if window_visible(&app) {
                    let _ = app.emit_to(
                        "main",
                        "vm-levels",
                        api.levels(&Layout::for_edition(edition)),
                    );
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
    let focused = app
        .get_webview_window("main")
        .map(|w| w.is_focused().unwrap_or(false) && w.is_visible().unwrap_or(false))
        .unwrap_or(false);
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
        let _ = app.emit_to("main", "vm-state", state);
    }
}

fn window_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main")
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

fn main() {
    let settings = settings::load();
    let api = Api::load().map(Arc::new);
    if let Some(a) = &api {
        // Login returns 1 when Voicemeeter isn't running yet.
        if a.login() == 1 && settings::flag(&settings, "launchVoicemeeter") {
            let _ = a.run(2);
        }
    }
    let initial = offline_state(api.is_some());
    let api_for_setup = api.clone();
    let autostarted = std::env::args().any(|a| a == "--autostart");

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        run_hotkey(app, shortcut);
                    }
                })
                .build(),
        )
        .manage(Vm {
            api: api.clone(),
            last: Mutex::new(initial),
            hide_vm_until: Mutex::new(None),
            osd_until: Mutex::new(None),
        })
        .manage(Settings(Mutex::new(settings.clone())))
        .manage(Hotkeys(Mutex::new(Vec::new())))
        .manage(NormalSize(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            vm_snapshot,
            vm_set_float,
            vm_set_string,
            vm_launch,
            vm_devices,
            vm_show_window,
            scene_list,
            scene_save,
            scene_load,
            scene_delete,
            settings_get,
            settings_set,
            window_mini
        ])
        .setup(move |app| {
            // Tray icon: left-click shows/hides the mixer, right-click for the menu.
            let show = MenuItem::with_id(app, "show", "Show Sleekmeeter", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Sleekmeeter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("sleekmeeter")
                .tooltip("Sleekmeeter")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            let handle = app.handle().clone();
            for p in apply_hotkeys(&handle, &settings["hotkeys"]) {
                eprintln!("hotkey: {p}");
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_always_on_top(settings::flag(&settings, "alwaysOnTop"));
                // Started with Windows and asked to stay in the tray: don't show the window.
                if !(autostarted && settings::flag(&settings, "startInTray")) {
                    let _ = w.show();
                }
            }

            if let Some(api) = api_for_setup.clone() {
                spawn_poller(handle, api);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Sleekmeeter in the tray; quit from the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start Sleekmeeter");

    app.run(move |_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(a) = &api {
                a.logout();
            }
        }
    });
}
