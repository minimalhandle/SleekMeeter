// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod vm;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use vm::{Api, Layout};

/// Shared between the poll thread and the command handlers.
struct Vm {
    api: Option<Arc<Api>>,
    last: Mutex<Value>,
}

fn offline_state(installed: bool) -> Value {
    json!({ "installed": installed, "connected": false })
}

/* ---------------- commands called from the UI ---------------- */

#[tauri::command]
fn vm_snapshot(vm: State<'_, Vm>) -> Value {
    vm.last.lock().unwrap().clone()
}

fn api<'a>(vm: &'a State<'_, Vm>) -> Result<&'a Arc<Api>, String> {
    vm.api
        .as_ref()
        .ok_or_else(|| "Voicemeeter isn't installed".to_string())
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

/* ---------------- scenes: Voicemeeter XML configs in a folder next to the exe ---------------- */

fn scenes_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .ok_or("Couldn't find Sleekmeeter's folder")?
        .join("scenes");
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

        loop {
            let started = Instant::now();
            let dirty = api.is_dirty();

            if dirty < 0 {
                if connected {
                    connected = false;
                    publish(&app, offline_state(true));
                }
            } else {
                if !connected {
                    connected = true;
                    edition = api.edition().unwrap_or(2);
                    // Right after Voicemeeter starts its parameters settle over a second or two.
                    reread_until = Instant::now() + Duration::from_secs(3);
                }
                let periodic = last_full.elapsed() > Duration::from_secs(1);
                if dirty == 1 || periodic || Instant::now() < reread_until {
                    last_full = Instant::now();
                    publish(&app, api.snapshot(edition));
                }
                if window_visible(&app) {
                    let _ = app.emit("vm-levels", api.levels(&Layout::for_edition(edition)));
                }
            }

            if let Some(rest) = tick.checked_sub(started.elapsed()) {
                std::thread::sleep(rest);
            }
        }
    });
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
    let api = Api::load().map(Arc::new);
    if let Some(a) = &api {
        a.login();
    }
    let initial = offline_state(api.is_some());
    let api_for_setup = api.clone();

    let app = tauri::Builder::default()
        .manage(Vm {
            api: api.clone(),
            last: Mutex::new(initial),
        })
        .invoke_handler(tauri::generate_handler![
            vm_snapshot,
            vm_set_float,
            vm_set_string,
            vm_launch,
            scene_list,
            scene_save,
            scene_load,
            scene_delete
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

            if let Some(api) = api_for_setup.clone() {
                spawn_poller(app.handle().clone(), api);
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
