//! Getting the window back when WebView2 (the engine that draws every window) crashes.
//!
//! Right after Windows starts, the graphics driver and overlays (Discord, RTSS, Epic) are
//! still loading, and WebView2's browser process sometimes crashes. The windows then stay
//! black for good: nothing in them can draw again. Two nets catch it:
//! - WebView2 reports the crash (ProcessFailed). A crashed page is reloaded; a crashed
//!   browser process means Sleekmeeter restarts itself, cleanly, into the same state.
//! - The main window is shown but its page never says it has drawn (ui_ready): the crash
//!   happened before the report could be wired up, so restart the same way.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

/// The main window's page has drawn at least once (set by ui_ready).
pub static MAIN_DREW: AtomicBool = AtomicBool::new(false);
static RESTARTING: AtomicBool = AtomicBool::new(false);
static CHECKING: AtomicBool = AtomicBool::new(false);

/// Restarts allowed in a row, so a machine where WebView2 can't run doesn't loop forever.
const MAX_RESTARTS: u32 = 2;

fn arg_after(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).cloned()
}

/// Started as a restart of a crashed copy: wait for that copy to finish quitting first, so
/// the one-copy-only check doesn't mistake us for a second Sleekmeeter.
pub fn wait_for_previous() {
    let Some(pid) = arg_after("--relaunch").and_then(|p| p.parse::<u32>().ok()) else {
        return;
    };
    log_info!("Restarted after a display crash; waiting for the old copy to quit");
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };
        let h = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if !h.is_null() {
            WaitForSingleObject(h, 15_000);
            CloseHandle(h);
        }
    }
}

/// Started by a restart that should keep the window in the tray, as it was.
pub fn start_hidden() -> bool {
    std::env::args().any(|a| a == "--hidden")
}

/// Quit and start again. `show`: open the main window in the new copy.
pub fn restart(app: &AppHandle, show: bool, why: &str) {
    if RESTARTING.swap(true, Ordering::SeqCst) {
        return;
    }
    let count: u32 = arg_after("--relaunch-count")
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    if count >= MAX_RESTARTS {
        log_error!("{why}; already restarted {count} times, so not restarting again");
        return;
    }
    log_warn!("{why}; restarting Sleekmeeter");
    let Ok(exe) = std::env::current_exe() else {
        log_error!("Couldn't find Sleekmeeter's own program file to restart it");
        return;
    };
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--relaunch")
        .arg(std::process::id().to_string())
        .arg("--relaunch-count")
        .arg((count + 1).to_string());
    if !show {
        cmd.arg("--hidden");
    }
    match cmd.spawn() {
        // The normal quit: gives Voicemeeter's audio insert back, logs out, saves settings.
        Ok(_) => app.exit(0),
        Err(e) => log_error!("Couldn't restart Sleekmeeter: {e}"),
    }
}

fn main_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

/// Listen for WebView2 crashes in this window.
pub fn watch(w: &WebviewWindow) {
    #[cfg(windows)]
    {
        let app = w.app_handle().clone();
        let label = w.label().to_string();
        let _ = w.with_webview(move |wv| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::*;
            use webview2_com::ProcessFailedEventHandler;
            let Ok(core) = wv.controller().CoreWebView2() else {
                return;
            };
            let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                args.ProcessFailedKind(&mut kind)?;
                if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                    let show = main_visible(&app);
                    restart(&app, show, "The display engine (WebView2) crashed");
                } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                    || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
                {
                    log_warn!("The {label} window's page crashed or hung; reloading it");
                    if let Some(s) = sender {
                        let _ = s.Reload();
                    }
                } else {
                    log_warn!("A display engine helper (WebView2) stopped (kind {})", kind.0);
                }
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_ProcessFailed(&handler, &mut token);
        });
    }
}

/// The main window was just shown: if its page still hasn't drawn a few seconds later, the
/// display engine is dead and the window would stay black, so restart.
pub fn check_main_draws(app: &AppHandle) {
    if MAIN_DREW.load(Ordering::SeqCst) || CHECKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        CHECKING.store(false, Ordering::SeqCst);
        if !MAIN_DREW.load(Ordering::SeqCst) && main_visible(&app) {
            restart(&app, true, "The main window never drew (black window)");
        }
    });
}
