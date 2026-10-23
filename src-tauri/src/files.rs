//! Windows "Open" and "Save as" dialogs for a settings backup. Call off the main thread.

#[cfg(windows)]
fn dialog(save: bool, title: &str, name: &str, filter: &str, ext: &str) -> Option<String> {
    use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows_sys::Win32::UI::Controls::Dialogs::{
        GetOpenFileNameW, GetSaveFileNameW, OFN_EXPLORER, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR,
        OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let filter: Vec<u16> = filter.encode_utf16().collect();
    let title = wide(title);
    let ext = wide(ext);
    let mut file = vec![0u16; 4096];
    for (i, c) in name.encode_utf16().take(260).enumerate() {
        file[i] = c;
    }
    unsafe {
        CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as _);
        let mut ofn: OPENFILENAMEW = std::mem::zeroed();
        ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
        ofn.lpstrFilter = filter.as_ptr();
        ofn.lpstrFile = file.as_mut_ptr();
        ofn.nMaxFile = file.len() as u32;
        ofn.lpstrTitle = title.as_ptr();
        ofn.lpstrDefExt = ext.as_ptr();
        let ok = if save {
            ofn.Flags = OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
            GetSaveFileNameW(&mut ofn)
        } else {
            ofn.Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
            GetOpenFileNameW(&mut ofn)
        };
        if ok == 0 {
            return None;
        }
    }
    let end = file.iter().position(|&c| c == 0).unwrap_or(0);
    (end > 0).then(|| String::from_utf16_lossy(&file[..end]))
}

#[cfg(not(windows))]
fn dialog(_save: bool, _title: &str, _name: &str, _filter: &str, _ext: &str) -> Option<String> {
    None
}

/// Ask where to save the backup.
pub fn pick_save(name: &str) -> Option<String> {
    dialog(
        true,
        "Save a backup of your Sleekmeeter settings",
        name,
        JSON,
        "json",
    )
}

/// Ask which backup to restore.
pub fn pick_open() -> Option<String> {
    dialog(
        false,
        "Restore Sleekmeeter settings from a backup",
        "",
        JSON,
        "json",
    )
}

/// Ask for one or more sound files for the soundboard (Ctrl or Shift to pick several).
pub fn pick_audio_many() -> Vec<String> {
    open_many("Choose sounds", AUDIO)
}

/// Ask for a folder, then list the sound files in it and its subfolders.
pub fn pick_audio_folder() -> Vec<String> {
    match pick_folder("Choose a folder of sounds") {
        Some(dir) => audio_in(std::path::Path::new(&dir)),
        None => Vec::new(),
    }
}

/// Ask for a folder to use as a random pack: returns the folder and how many sounds it holds.
pub fn pick_audio_pack() -> Option<(String, usize)> {
    let dir = pick_folder("Choose a folder for a random sound pack")?;
    let n = audio_in(std::path::Path::new(&dir)).len();
    Some((dir, n))
}

const AUDIO_EXT: [&str; 4] = ["wav", "mp3", "ogg", "flac"];

/// Sound files in a folder and the folders inside it (a few levels deep), sorted by name.
pub fn audio_in(dir: &std::path::Path) -> Vec<String> {
    fn walk(dir: &std::path::Path, depth: u32, out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = rd.flatten().map(|e| e.path()).collect();
        entries.sort_by_key(|p| p.to_string_lossy().to_lowercase());
        for p in entries {
            if out.len() >= 300 {
                return;
            }
            if p.is_dir() {
                if depth < 3 {
                    walk(&p, depth + 1, out);
                }
            } else if p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| AUDIO_EXT.contains(&e.to_lowercase().as_str()))
                .unwrap_or(false)
            {
                out.push(p.to_string_lossy().into_owned());
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, 0, &mut out);
    out
}

/// The standard Windows folder picker, through PowerShell (no extra Windows API needed).
#[cfg(windows)]
fn pick_folder(title: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    let script = format!(
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n\
         Add-Type -AssemblyName System.Windows.Forms\n\
         $f = New-Object System.Windows.Forms.Form -Property @{{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }}\n\
         $d = New-Object System.Windows.Forms.FolderBrowserDialog\n\
         $d.Description = '{}'\n\
         $d.ShowNewFolderButton = $false\n\
         if ($d.ShowDialog($f) -eq 'OK') {{ [Console]::Out.Write($d.SelectedPath) }}",
        title.replace('\'', "''")
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command"])
        .arg(script)
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

#[cfg(not(windows))]
fn pick_folder(_title: &str) -> Option<String> {
    None
}

/// "Open" dialog that allows several files. Windows returns either one full path, or a
/// folder followed by the file names, separated by NULs.
#[cfg(windows)]
fn open_many(title: &str, filter: &str) -> Vec<String> {
    use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows_sys::Win32::UI::Controls::Dialogs::{
        GetOpenFileNameW, OFN_ALLOWMULTISELECT, OFN_EXPLORER, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR,
        OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };
    let filter: Vec<u16> = filter.encode_utf16().collect();
    let title: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let mut file = vec![0u16; 32768];
    unsafe {
        CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as _);
        let mut ofn: OPENFILENAMEW = std::mem::zeroed();
        ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
        ofn.lpstrFilter = filter.as_ptr();
        ofn.lpstrFile = file.as_mut_ptr();
        ofn.nMaxFile = file.len() as u32;
        ofn.lpstrTitle = title.as_ptr();
        ofn.Flags = OFN_EXPLORER
            | OFN_ALLOWMULTISELECT
            | OFN_FILEMUSTEXIST
            | OFN_PATHMUSTEXIST
            | OFN_NOCHANGEDIR;
        if GetOpenFileNameW(&mut ofn) == 0 {
            return Vec::new();
        }
    }
    let parts: Vec<String> = file
        .split(|&c| c == 0)
        .take_while(|p| !p.is_empty())
        .map(String::from_utf16_lossy)
        .collect();
    match parts.len() {
        0 => Vec::new(),
        1 => parts,
        _ => {
            let dir = std::path::PathBuf::from(&parts[0]);
            parts[1..]
                .iter()
                .map(|name| dir.join(name).to_string_lossy().into_owned())
                .collect()
        }
    }
}

#[cfg(not(windows))]
fn open_many(_title: &str, _filter: &str) -> Vec<String> {
    Vec::new()
}

const JSON: &str = "Sleekmeeter settings (*.json)\0*.json\0All files\0*.*\0\0";
const AUDIO: &str =
    "Sound files (*.wav, *.mp3, *.ogg, *.flac)\0*.wav;*.mp3;*.ogg;*.flac\0All files\0*.*\0\0";
