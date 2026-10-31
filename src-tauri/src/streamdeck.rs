//! Finds Elgato's Stream Deck app or hardware and installs the plugin that ships inside Sleekmeeter.
//! The plugin file is compiled in, so every kind of install has it and nothing is downloaded.
//! Opening the file hands it to the Stream Deck app, which does the installing.

use serde_json::{json, Value};

const PLUGIN: &[u8] = include_bytes!("../../streamdeck/Sleekmeeter-Studio.streamDeckPlugin");
const MANIFEST: &str =
    include_str!("../../streamdeck/com.minimalhandle.sleekmeeter.sdPlugin/manifest.json");
const APP_PAGE: &str = "https://www.elgato.com/downloads";
#[cfg(windows)]
const PLUGIN_FOLDER: &str = "com.minimalhandle.sleekmeeter.sdPlugin";
/// USB product IDs of Elgato's Stream Decks. Other Elgato hardware shares the vendor ID 0FD9.
#[cfg(windows)]
const DECK_PRODUCTS: [&str; 11] = [
    "0060", "0063", "006C", "006D", "0080", "0084", "0086", "008F", "0090", "009A", "00A5",
];

fn version_of(manifest: &str) -> Option<String> {
    let value: Value = serde_json::from_str(manifest.trim_start_matches('\u{feff}')).ok()?;
    value.get("Version")?.as_str().map(str::to_string)
}

fn is_older(installed: &str, bundled: &str) -> bool {
    let parts = |v: &str| -> Vec<u32> { v.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    let (a, b) = (parts(installed), parts(bundled));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x < y;
        }
    }
    false
}

/// What to suggest: "install", "update", "getApp" (hardware but no app to install into) or "".
fn offer(app: bool, device: bool, installed: Option<&str>, bundled: &str) -> &'static str {
    if !app {
        return if device { "getApp" } else { "" };
    }
    match installed {
        None => "install",
        Some(v) if is_older(v, bundled) => "update",
        Some(_) => "",
    }
}

#[cfg(windows)]
fn app_installed() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY};
    use winreg::RegKey;
    let in_folder = ["ProgramFiles", "ProgramW6432"].iter().any(|var| {
        std::env::var_os(var).is_some_and(|dir| {
            std::path::Path::new(&dir)
                .join(r"Elgato\StreamDeck\StreamDeck.exe")
                .exists()
        })
    });
    if in_folder {
        return true;
    }
    const UNINSTALL: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    let roots = [
        (HKEY_LOCAL_MACHINE, KEY_READ),
        (HKEY_LOCAL_MACHINE, KEY_READ | KEY_WOW64_32KEY),
        (HKEY_CURRENT_USER, KEY_READ),
    ];
    roots.iter().any(|(root, flags)| {
        let Ok(list) = RegKey::predef(*root).open_subkey_with_flags(UNINSTALL, *flags) else {
            return false;
        };
        list.enum_keys().flatten().any(|id| {
            list.open_subkey_with_flags(&id, *flags)
                .and_then(|app| app.get_value::<String, _>("DisplayName"))
                .is_ok_and(|name| name.to_lowercase().starts_with("elgato stream deck"))
        })
    })
}

/// Windows remembers USB devices that have been plugged in, so this also finds an unplugged deck.
#[cfg(windows)]
fn device_seen() -> bool {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;
    let Ok(usb) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"SYSTEM\CurrentControlSet\Enum\USB", KEY_READ)
    else {
        return false;
    };
    usb.enum_keys().flatten().any(|id| is_deck_id(&id))
}

#[cfg(windows)]
fn is_deck_id(id: &str) -> bool {
    let id = id.to_uppercase();
    DECK_PRODUCTS.iter().any(|product| {
        id == format!("VID_0FD9&PID_{product}")
            || id.starts_with(&format!("VID_0FD9&PID_{product}&"))
    })
}

#[cfg(windows)]
fn installed_version() -> Option<String> {
    let manifest = std::path::PathBuf::from(std::env::var_os("APPDATA")?)
        .join(r"Elgato\StreamDeck\Plugins")
        .join(PLUGIN_FOLDER)
        .join("manifest.json");
    version_of(&std::fs::read_to_string(manifest).ok()?)
}

#[cfg(not(windows))]
fn app_installed() -> bool {
    false
}
#[cfg(not(windows))]
fn device_seen() -> bool {
    false
}
#[cfg(not(windows))]
fn installed_version() -> Option<String> {
    None
}

pub fn status() -> Value {
    let bundled = version_of(MANIFEST).unwrap_or_default();
    let (app, device, installed) = (app_installed(), device_seen(), installed_version());
    json!({
        "app": app,
        "device": device,
        "installedVersion": installed,
        "bundledVersion": bundled,
        "offer": offer(app, device, installed.as_deref(), &bundled),
    })
}

fn shell_open(target: &std::ffi::OsStr) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Couldn't open it: {e}"))
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Err("The Stream Deck plugin is only for Windows".into())
    }
}

/// Writes the plugin to the temp folder and hands it to the Stream Deck app.
pub fn install() -> Result<(), String> {
    if !app_installed() {
        return Err("The Stream Deck app isn't installed".into());
    }
    let file = std::env::temp_dir().join("Sleekmeeter-Studio.streamDeckPlugin");
    std::fs::write(&file, PLUGIN).map_err(|e| format!("Couldn't prepare the plugin: {e}"))?;
    shell_open(file.as_os_str())
}

pub fn open_app_page() -> Result<(), String> {
    shell_open(std::ffi::OsStr::new(APP_PAGE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_plugin_is_a_zip_with_a_version() {
        assert!(PLUGIN.starts_with(b"PK"));
        assert!(version_of(MANIFEST).is_some());
    }

    #[test]
    fn versions_compare_by_number() {
        assert!(is_older("0.9.0.0", "0.16.0.0"));
        assert!(is_older("0.16", "0.16.0.1"));
        assert!(!is_older("0.16.0.0", "0.16.0.0"));
        assert!(!is_older("0.17.0.0", "0.16.0.0"));
    }

    #[test]
    fn offers_what_the_pc_can_use() {
        assert_eq!(offer(false, false, None, "1.0"), "");
        assert_eq!(offer(false, true, None, "1.0"), "getApp");
        assert_eq!(offer(true, false, None, "1.0"), "install");
        assert_eq!(offer(true, true, Some("0.9"), "1.0"), "update");
        assert_eq!(offer(true, true, Some("1.0"), "1.0"), "");
    }

    #[cfg(windows)]
    #[test]
    fn only_stream_decks_count_as_decks() {
        assert!(is_deck_id("VID_0FD9&PID_0084"));
        assert!(is_deck_id("vid_0fd9&pid_0084&mi_00"));
        assert!(!is_deck_id("VID_0FD9&PID_0066")); // an Elgato capture device
        assert!(!is_deck_id("VID_1234&PID_0084"));
    }
}
