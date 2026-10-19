//! Windows-only helpers: start with Windows, and hiding/showing Voicemeeter's own window.

/// Voicemeeter's main window class, as used by the SDK's vmr_osd example.
#[cfg(windows)]
const VM_WINDOW_CLASS: &str = "VBCABLE0Voicemeeter0MainWindow0";
#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const RUN_VALUE: &str = "Sleekmeeter";

#[cfg(windows)]
fn vm_window() -> Option<windows_sys::Win32::Foundation::HWND> {
    use windows_sys::Win32::UI::WindowsAndMessaging::FindWindowW;
    let class: Vec<u16> = VM_WINDOW_CLASS
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let hwnd = unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) };
    if hwnd as usize == 0 {
        None
    } else {
        Some(hwnd)
    }
}

/// Hide Voicemeeter's window. Returns true when the window was found.
#[cfg(windows)]
pub fn hide_voicemeeter() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsWindowVisible, ShowWindow, SW_HIDE};
    match vm_window() {
        Some(h) => {
            unsafe {
                if IsWindowVisible(h) != 0 {
                    ShowWindow(h, SW_HIDE);
                }
            }
            true
        }
        None => false,
    }
}

/// Bring Voicemeeter's window back, even if Sleekmeeter hid it.
#[cfg(windows)]
pub fn show_voicemeeter() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetForegroundWindow, ShowWindow, SW_RESTORE, SW_SHOW,
    };
    if let Some(h) = vm_window() {
        unsafe {
            ShowWindow(h, SW_SHOW);
            ShowWindow(h, SW_RESTORE);
            SetForegroundWindow(h);
        }
    }
}

/// Register or remove Sleekmeeter in HKCU\...\Run (no admin rights needed).
#[cfg(windows)]
pub fn set_autostart(on: bool) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;
    let run = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)
        .map_err(|e| format!("Couldn't change startup apps: {e}"))?;
    if on {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        run.set_value(RUN_VALUE, &format!("\"{}\" --autostart", exe.display()))
            .map_err(|e| format!("Couldn't add Sleekmeeter to startup apps: {e}"))
    } else {
        match run.delete_value(RUN_VALUE) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!(
                "Couldn't remove Sleekmeeter from startup apps: {e}"
            )),
        }
    }
}

#[cfg(windows)]
pub fn autostart_enabled() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(RUN_KEY)
        .and_then(|k| k.get_value::<String, _>(RUN_VALUE))
        .is_ok()
}

#[cfg(not(windows))]
pub fn hide_voicemeeter() -> bool {
    false
}
#[cfg(not(windows))]
pub fn show_voicemeeter() {}
#[cfg(not(windows))]
pub fn set_autostart(_on: bool) -> Result<(), String> {
    Err("Only available on Windows".into())
}
#[cfg(not(windows))]
pub fn autostart_enabled() -> bool {
    false
}
