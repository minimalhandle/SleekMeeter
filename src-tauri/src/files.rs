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

pub fn mic_preset_dialog(save: bool) -> Option<String> {
    dialog(
        save,
        if save {
            "Export Sleekmeeter mic chain"
        } else {
            "Import Sleekmeeter mic chain"
        },
        if save {
            "Sleekmeeter-mic-chain.json"
        } else {
            ""
        },
        "Sleekmeeter mic presets (*.json)\0*.json\0\0",
        "json",
    )
}

pub fn stream_deck_profile_dialog() -> Option<String> {
    dialog(
        true,
        "Save the Sleekmeeter Stream Deck + profile",
        "Sleekmeeter Studio Plus.streamDeckProfile",
        "Stream Deck profiles (*.streamDeckProfile)\0*.streamDeckProfile\0\0",
        "streamDeckProfile",
    )
}

/// Ask for a VST3 plugin that isn't in the usual folders.
pub fn pick_vst3() -> Option<String> {
    dialog(
        false,
        "Pick a VST3 plugin",
        "",
        "VST3 plugins (*.vst3)\0*.vst3\0\0",
        "vst3",
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
    // An empty folder reports a count of 0 so the app can say so.
    Some(import_pack(&dir).unwrap_or((dir, 0)))
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

/// The standard Windows folder picker, in front of whatever window is active.
#[cfg(windows)]
fn pick_folder(title: &str) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS,
        SIGDN_FILESYSPATH,
    };
    unsafe {
        let started = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let pick = || -> windows::core::Result<String> {
            let d: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            d.SetOptions(
                d.GetOptions()? | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST,
            )?;
            d.SetTitle(&HSTRING::from(title))?;
            let owner = windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
            d.Show(HWND(owner as _))?; // an error when cancelled
            let raw = d.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
            let path = raw.to_string().unwrap_or_default();
            CoTaskMemFree(Some(raw.0.cast()));
            Ok(path)
        };
        let path = pick().ok();
        if started {
            CoUninitialize();
        }
        path.filter(|p| !p.is_empty())
    }
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

/// Copy `src` into `dir` (created if needed) and return the copy's path. A file with the same
/// name and size already there is reused, so adding the same sound twice doesn't pile up copies.
fn copy_into(src: &std::path::Path, dir: &std::path::Path) -> Option<String> {
    std::fs::create_dir_all(dir).ok()?;
    if src.parent() == Some(dir) {
        return Some(src.to_string_lossy().into_owned());
    }
    let stem = src.file_stem()?.to_string_lossy().into_owned();
    let ext = src
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let size = std::fs::metadata(src).ok()?.len();
    for n in 1..1000 {
        let name = if n == 1 {
            format!("{stem}{ext}")
        } else {
            format!("{stem} ({n}){ext}")
        };
        let dest = dir.join(name);
        match std::fs::metadata(&dest) {
            Ok(m) if m.len() == size => return Some(dest.to_string_lossy().into_owned()),
            Ok(_) => continue,
            Err(_) => {
                std::fs::copy(src, &dest).ok()?;
                return Some(dest.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// Sounds live in Sleekmeeter's own `sounds` folder, so the originals can be moved or deleted.
pub fn import_sounds(paths: &[String]) -> Vec<String> {
    let dir = crate::settings::app_dir().join("sounds");
    paths
        .iter()
        .filter_map(|p| copy_into(std::path::Path::new(p), &dir))
        .collect()
}

/// Copy a folder's sounds into `sounds/<folder name>` and return that folder and the count.
pub fn import_pack(folder: &str) -> Option<(String, usize)> {
    let src = std::path::Path::new(folder);
    let name = src.file_name()?.to_string_lossy().into_owned();
    let root = crate::settings::app_dir().join("sounds");
    let mut dir = root.join(&name);
    let mut n = 2;
    while dir.exists() {
        dir = root.join(format!("{name} {n}"));
        n += 1;
    }
    let mut count = 0;
    for f in audio_in(src) {
        if copy_into(std::path::Path::new(&f), &dir).is_some() {
            count += 1;
        }
    }
    (count > 0).then(|| (dir.to_string_lossy().into_owned(), count))
}
