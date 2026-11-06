//! Per-app routing: choose which output device each app plays to (for example Discord into a
//! Voicemeeter virtual input), the same setting as Windows' "App volume and device preferences".
//!
//! Windows has no public API for this, so it uses the same internal call the Settings page does.
//! That call runs in a small separate helper (PowerShell), so if it ever misbehaves on some
//! Windows version it can't take Sleekmeeter down with it.

use serde_json::{json, Value};

/// Playback devices Windows has, as `{ id, name }`; Voicemeeter's virtual inputs first.
#[cfg(windows)]
pub fn devices() -> Vec<Value> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    const BASE: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render";
    let Ok(render) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(BASE) else {
        return Vec::new();
    };
    let mut list: Vec<(String, String)> = Vec::new();
    for guid in render.enum_keys().flatten() {
        let Ok(dev) = render.open_subkey(&guid) else {
            continue;
        };
        // 1 = plugged in and enabled.
        if dev.get_value::<u32, _>("DeviceState").unwrap_or(0) != 1 {
            continue;
        }
        let Ok(props) = dev.open_subkey("Properties") else {
            continue;
        };
        let short: String = props
            .get_value("{a45c254e-df1c-4efd-8020-67d146a850e0},2")
            .unwrap_or_default();
        let adapter: String = props
            .get_value("{b3f8fa53-0004-438e-9003-51a46e139bfc},6")
            .unwrap_or_default();
        let name = match (short.is_empty(), adapter.is_empty()) {
            (true, true) => continue,
            (false, true) => short,
            (true, false) => adapter,
            (false, false) => format!("{short} ({adapter})"),
        };
        list.push((format!("{{0.0.0.00000000}}.{guid}"), name));
    }
    list.sort_by(|a, b| {
        let va = a.1.to_lowercase().contains("voicemeeter");
        let vb = b.1.to_lowercase().contains("voicemeeter");
        vb.cmp(&va).then(a.1.cmp(&b.1))
    });
    list.into_iter()
        .map(|(id, name)| json!({ "id": id, "name": name }))
        .collect()
}

#[cfg(not(windows))]
pub fn devices() -> Vec<Value> {
    Vec::new()
}

/// `{0.0.0.00000000}.{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}` and nothing else.
pub fn valid_device(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("{0.0.0.00000000}.{") else {
        return false;
    };
    let Some(guid) = rest.strip_suffix('}') else {
        return false;
    };
    guid.len() == 36 && guid.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

const HELPER: &str = r##"
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Route {
  [DllImport("combase.dll", PreserveSig = false)]
  static extern void RoGetActivationFactory([MarshalAs(UnmanagedType.HString)] string classId, [In] ref Guid iid, [Out, MarshalAs(UnmanagedType.IInspectable)] out object factory);
  [DllImport("combase.dll", PreserveSig = false)]
  static extern void WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string source, int length, out IntPtr hstring);
  [DllImport("combase.dll", PreserveSig = false)]
  static extern void WindowsDeleteString(IntPtr hstring);

  [ComImport, Guid("ab3d4648-e242-459f-b02f-541c70306324"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
  interface IFactory {
    [PreserveSig] int M01(); [PreserveSig] int M02(); [PreserveSig] int M03(); [PreserveSig] int M04();
    [PreserveSig] int M05(); [PreserveSig] int M06(); [PreserveSig] int M07(); [PreserveSig] int M08();
    [PreserveSig] int M09(); [PreserveSig] int M10(); [PreserveSig] int M11(); [PreserveSig] int M12();
    [PreserveSig] int M13(); [PreserveSig] int M14(); [PreserveSig] int M15(); [PreserveSig] int M16();
    [PreserveSig] int M17(); [PreserveSig] int M18(); [PreserveSig] int M19();
    [PreserveSig] int SetPersistedDefaultAudioEndpoint(uint processId, int flow, int role, IntPtr deviceId);
  }

  public static int Set(uint pid, string endpoint) {
    object f;
    Guid iid = typeof(IFactory).GUID;
    RoGetActivationFactory("Windows.Media.Internal.AudioPolicyConfig", ref iid, out f);
    IFactory factory = (IFactory)f;
    IntPtr h = IntPtr.Zero;
    if (endpoint.Length > 0) {
      string id = "\\\\?\\SWD#MMDEVAPI#" + endpoint + "#{e6327cad-dcec-4949-ae8a-991e976a79d2}";
      WindowsCreateString(id, id.Length, out h);
    }
    int hr = 0;
    try {
      hr = factory.SetPersistedDefaultAudioEndpoint(pid, 0, 0, h);
      int hr2 = factory.SetPersistedDefaultAudioEndpoint(pid, 0, 1, h);
      if (hr == 0) hr = hr2;
    } finally {
      if (h != IntPtr.Zero) WindowsDeleteString(h);
    }
    return hr;
  }
}
'@
$endpoint = '__ENDPOINT__'
$failed = 0
foreach ($p in @(__PIDS__)) {
  try { $hr = [Route]::Set([uint32]$p, $endpoint); if ($hr -ne 0) { $failed++; Write-Output ('HR=0x{0:X8}' -f $hr) } }
  catch { $failed++; Write-Output ('ERR=' + $_.Exception.Message) }
}
if ($failed -gt 0) { exit 1 }
Write-Output 'OK'
"##;

/// Make the apps with these process ids play to `device` (an id from [`devices`]), or back to
/// the Windows default when `device` is empty.
#[cfg(windows)]
pub fn set(pids: &[u32], device: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    if pids.is_empty() {
        return Err("That app isn't playing sound right now".into());
    }
    if !device.is_empty() && !valid_device(device) {
        return Err("That isn't a playback device".into());
    }
    let list = pids
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let script = HELPER
        .replace("__ENDPOINT__", device)
        .replace("__PIDS__", &list);
    let path = std::env::temp_dir().join("sleekmeeter-route.ps1");
    std::fs::write(&path, script).map_err(|e| format!("Couldn't prepare the change: {e}"))?;
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&path)
        .creation_flags(0x0800_0000) // no console window
        .output()
        .map_err(|e| format!("Couldn't run the helper: {e}"))?;
    let _ = std::fs::remove_file(&path);
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() && text.ends_with("OK") {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    log_warn!("App routing helper: {text} {err}");
    Err(format!(
        "Windows didn't accept the change on this version ({})",
        if text.is_empty() { "no details" } else { &text }
    ))
}

#[cfg(not(windows))]
pub fn set(_pids: &[u32], _device: &str) -> Result<(), String> {
    Err("Only available on Windows".into())
}

/// Put remembered routes ("appRoutes" in the settings: program → device) back on programs
/// that start later, whether or not the mixer window is open. Windows usually remembers them
/// itself; this covers the times it doesn't.
pub fn spawn(app: tauri::AppHandle) {
    use std::collections::{HashMap, HashSet};
    use tauri::Manager;
    std::thread::spawn(move || {
        // program → (device it was sent to, processes already sent there)
        let mut done: HashMap<String, (String, HashSet<u32>)> = HashMap::new();
        let mut devices: Vec<String> = Vec::new();
        let mut checked = std::time::Instant::now() - std::time::Duration::from_secs(600);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let routes = app.state::<crate::Settings>().0.lock().unwrap()["appRoutes"].clone();
            let Some(routes) = routes.as_object().filter(|r| !r.is_empty()) else {
                continue;
            };
            if checked.elapsed() > std::time::Duration::from_secs(60) {
                devices = devices_ids();
                checked = std::time::Instant::now();
            }
            let Ok(running) = crate::appvol::list() else {
                continue;
            };
            done.retain(|exe, _| routes.contains_key(exe));
            for a in running {
                let exe = a["exe"].as_str().unwrap_or("").to_string();
                let Some(device) = routes.get(&exe).and_then(|d| d.as_str()) else {
                    continue;
                };
                if !devices.iter().any(|d| d == device) {
                    continue; // that device isn't here right now
                }
                let pids: Vec<u32> = a["pids"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|p| p.as_u64().map(|p| p as u32))
                    .collect();
                let entry = done.entry(exe.clone()).or_default();
                if entry.0 != device {
                    *entry = (device.to_string(), HashSet::new());
                }
                let fresh: Vec<u32> = pids.into_iter().filter(|p| !entry.1.contains(p)).collect();
                if fresh.is_empty() {
                    continue;
                }
                entry.1.extend(fresh.iter().copied());
                if let Err(e) = set(&fresh, device) {
                    log_warn!("Couldn't put {exe} back on its output: {e}");
                }
            }
        }
    });
}

fn devices_ids() -> Vec<String> {
    devices()
        .into_iter()
        .filter_map(|d| d["id"].as_str().map(str::to_string))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_real_device_ids_pass() {
        assert!(valid_device(
            "{0.0.0.00000000}.{0a1b2c3d-1111-2222-3333-444455556666}"
        ));
        assert!(!valid_device("{0.0.0.00000000}.{x'; Remove-Item *; '}"));
        assert!(!valid_device(""));
    }
}
