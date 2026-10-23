//! Running programs, for switching scenes automatically when an app starts or closes.

use std::collections::BTreeSet;

/// Lower-case executable names of every running process, e.g. "obs64.exe".
#[cfg(windows)]
pub fn running() -> BTreeSet<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut names = BTreeSet::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return names;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let raw = &entry.szExeFile;
                let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
                let name = String::from_utf16_lossy(&raw[..end]).to_lowercase();
                if !name.is_empty() {
                    names.insert(name);
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    names
}

#[cfg(not(windows))]
pub fn running() -> BTreeSet<String> {
    BTreeSet::new()
}

/// Process id → lower-case executable name, for every running process.
#[cfg(windows)]
pub fn process_names() -> std::collections::HashMap<u32, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut names = std::collections::HashMap::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return names;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let raw = &entry.szExeFile;
                let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
                let name = String::from_utf16_lossy(&raw[..end]).to_lowercase();
                if !name.is_empty() {
                    names.insert(entry.th32ProcessID, name);
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    names
}

#[cfg(not(windows))]
pub fn process_names() -> std::collections::HashMap<u32, String> {
    std::collections::HashMap::new()
}

/// Windows' own background processes, left out of the suggestions list.
const SYSTEM: &[&str] = &[
    "[system process]",
    "system",
    "registry",
    "memory compression",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "lsaiso.exe",
    "svchost.exe",
    "fontdrvhost.exe",
    "dwm.exe",
    "conhost.exe",
    "runtimebroker.exe",
    "sihost.exe",
    "taskhostw.exe",
    "ctfmon.exe",
    "searchhost.exe",
    "searchindexer.exe",
    "searchprotocolhost.exe",
    "searchfilterhost.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "textinputhost.exe",
    "dllhost.exe",
    "wmiprvse.exe",
    "audiodg.exe",
    "spoolsv.exe",
    "msedgewebview2.exe",
    "sleekmeeter.exe",
    "securityhealthservice.exe",
    "securityhealthsystray.exe",
    "smartscreen.exe",
    "sgrmbroker.exe",
    "wudfhost.exe",
    "dashost.exe",
    "lockapp.exe",
    "applicationframehost.exe",
    "systemsettings.exe",
    "useroobebroker.exe",
    "backgroundtaskhost.exe",
    "compattelrunner.exe",
    "msmpeng.exe",
    "nissrv.exe",
    "mpdefendercoreservice.exe",
];

/// Running apps worth offering as scene triggers.
pub fn suggestions() -> Vec<String> {
    running()
        .into_iter()
        .filter(|n| n.ends_with(".exe") && !SYSTEM.contains(&n.as_str()))
        .collect()
}
