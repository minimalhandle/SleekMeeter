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

/// Ask for a sound file for the soundboard.
pub fn pick_audio() -> Option<String> {
    dialog(false, "Choose a sound", "", AUDIO, "wav")
}

const JSON: &str = "Sleekmeeter settings (*.json)\0*.json\0All files\0*.*\0\0";
const AUDIO: &str =
    "Sound files (*.wav, *.mp3, *.ogg, *.flac)\0*.wav;*.mp3;*.ogg;*.flac\0All files\0*.*\0\0";
