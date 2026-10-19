//! Voicemeeter's built-in recorder (Banana and Potato): transport buttons and a running clock.
//!
//! Voicemeeter's remote API takes the transport buttons as commands. Whether it also reports
//! "playing" / "recording" isn't documented, so Sleekmeeter keeps its own state and only
//! trusts Voicemeeter's once it has seen it report something.

use crate::vm::Api;
use crate::Vm;
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub struct RecState {
    /// "stopped" | "recording" | "playing" | "paused"
    mode: &'static str,
    /// What was paused.
    paused: &'static str,
    /// Time already on the clock, in ms.
    elapsed: u64,
    /// When the clock last started (ms since 1970), while running.
    since: Option<u64>,
    /// Voicemeeter has reported recording / playing at least once, so its "off" can be trusted.
    reports_rec: bool,
    reports_play: bool,
}

impl Default for RecState {
    fn default() -> Self {
        RecState {
            mode: "stopped",
            paused: "stopped",
            elapsed: 0,
            since: None,
            reports_rec: false,
            reports_play: false,
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl RecState {
    fn start(&mut self, mode: &'static str) {
        self.mode = mode;
        self.elapsed = 0;
        self.since = Some(now_ms());
    }
    fn pause(&mut self) {
        if let Some(t) = self.since.take() {
            self.elapsed += now_ms().saturating_sub(t);
        }
        self.paused = self.mode;
        self.mode = "paused";
    }
    fn resume(&mut self) {
        self.mode = self.paused;
        self.since = Some(now_ms());
    }
    fn stop(&mut self) {
        *self = RecState {
            reports_rec: self.reports_rec,
            reports_play: self.reports_play,
            ..RecState::default()
        };
    }

    fn apply(&mut self, action: &str) {
        match (action, self.mode) {
            ("record", "paused") if self.paused == "recording" => self.resume(),
            ("record", "recording") => {}
            ("record", _) => self.start("recording"),
            ("play", "paused") if self.paused == "playing" => self.resume(),
            ("play", "playing") | ("play", "recording") => {}
            ("play", _) => self.start("playing"),
            ("replay", _) => self.start("playing"),
            ("pause", "paused") => self.resume(),
            ("pause", "recording") | ("pause", "playing") => self.pause(),
            ("stop", _) => self.stop(),
            _ => {}
        }
    }

    /// Follow changes made in Voicemeeter's own window, when Voicemeeter reports them.
    fn follow(&mut self, recording: Option<bool>, playing: Option<bool>) {
        if recording == Some(true) {
            self.reports_rec = true;
        }
        if playing == Some(true) {
            self.reports_play = true;
        }
        if self.mode == "paused" {
            return;
        }
        if recording == Some(true) && self.mode != "recording" {
            self.start("recording");
        } else if playing == Some(true) && self.mode == "stopped" {
            self.start("playing");
        } else if self.mode == "recording" && self.reports_rec && recording == Some(false) {
            self.stop();
        } else if self.mode == "playing" && self.reports_play && playing == Some(false) {
            self.stop(); // the file ended or playback was stopped in Voicemeeter
        }
    }

    fn view(&self) -> Value {
        json!({ "state": self.mode, "elapsed": self.elapsed, "since": self.since })
    }
}

/// Press a transport button: record, play, replay (from the start), pause, stop, rew, ff.
pub fn command(app: &AppHandle, api: &Api, action: &str) -> Result<Value, String> {
    let line = match action {
        "record" => "Recorder.record = 1;",
        "play" => "Recorder.play = 1;",
        "replay" => "Recorder.replay = 1;",
        "pause" => "Recorder.pause = 1;",
        "stop" => "Recorder.stop = 1;",
        "rew" => "Recorder.rew = 1;",
        "ff" => "Recorder.ff = 1;",
        _ => return Err("Unknown recorder button".into()),
    };
    // Voicemeeter's MP3 encoder reads its audio as 16-bit: at 24 or 32-bit the file comes out
    // about 48 dB too loud and badly distorted. Make sure an MP3 recording starts at 16-bit.
    if action == "record"
        && api.get_float("Recorder.FileType").map(|t| t.round() as i32) == Some(100)
        && api
            .get_float("Recorder.bitResolution")
            .map(|b| b.round() as i32)
            != Some(16)
    {
        let _ = api.set_float("Recorder.bitResolution", 16.0);
    }
    if let Err(e) = api.script(&[line.to_string()]) {
        // Older Voicemeeter versions call the record button "rec".
        if action != "record" {
            return Err(e);
        }
        api.script(&["Recorder.rec = 1;".to_string()])?;
    }
    let vm = app.state::<Vm>();
    let mut rec = vm.rec.lock().unwrap();
    rec.apply(action);
    Ok(rec.view())
}

/// Start recording, or stop when already recording (shortcut). Returns true when recording.
pub fn toggle_record(app: &AppHandle, api: &Api) -> Result<bool, String> {
    let recording = app.state::<Vm>().rec.lock().unwrap().mode == "recording";
    command(app, api, if recording { "stop" } else { "record" })?;
    Ok(!recording)
}

/// Add the recorder's state to a mixer snapshot.
pub fn dress(app: &AppHandle, snap: &mut Value, mut rec: Value) {
    let vm = app.state::<Vm>();
    let mut state = vm.rec.lock().unwrap();
    state.follow(rec["recording"].as_bool(), rec["playing"].as_bool());
    if let (Value::Object(r), Value::Object(v)) = (&mut rec, state.view()) {
        r.extend(v);
    }
    snap["recorder"] = rec;
}

/// Ask for an audio file to play. Runs a Windows file dialog (call off the main thread).
#[cfg(windows)]
pub fn pick_file() -> Option<String> {
    use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows_sys::Win32::UI::Controls::Dialogs::{
        GetOpenFileNameW, OFN_EXPLORER, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST,
        OPENFILENAMEW,
    };
    let filter: Vec<u16> =
        "Audio files\0*.wav;*.mp3;*.aif;*.aiff;*.wma;*.m4a;*.flac;*.ogg;*.bwf\0All files\0*.*\0\0"
            .encode_utf16()
            .collect();
    let title: Vec<u16> = "Play a file with Voicemeeter's recorder\0"
        .encode_utf16()
        .collect();
    let mut file = vec![0u16; 4096];
    unsafe {
        CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as _);
        let mut ofn: OPENFILENAMEW = std::mem::zeroed();
        ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
        ofn.lpstrFilter = filter.as_ptr();
        ofn.lpstrFile = file.as_mut_ptr();
        ofn.nMaxFile = file.len() as u32;
        ofn.lpstrTitle = title.as_ptr();
        ofn.Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
        if GetOpenFileNameW(&mut ofn) == 0 {
            return None;
        }
    }
    let end = file.iter().position(|&c| c == 0).unwrap_or(0);
    (end > 0).then(|| String::from_utf16_lossy(&file[..end]))
}

#[cfg(not(windows))]
pub fn pick_file() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport() {
        let mut r = RecState::default();
        r.apply("record");
        assert_eq!(r.mode, "recording");
        r.apply("pause");
        assert_eq!(r.mode, "paused");
        assert!(r.since.is_none());
        r.apply("record");
        assert_eq!(r.mode, "recording");
        r.apply("stop");
        assert_eq!(r.mode, "stopped");
        assert_eq!(r.elapsed, 0);
    }

    #[test]
    fn follows_voicemeeter_only_once_it_reports() {
        let mut r = RecState::default();
        r.apply("record");
        // Voicemeeter answers 0 for everything: could mean it doesn't report, so keep going
        r.follow(Some(false), Some(false));
        assert_eq!(r.mode, "recording");
        // now it reports recording, then stops in Voicemeeter's window
        r.follow(Some(true), Some(false));
        r.follow(Some(false), Some(false));
        assert_eq!(r.mode, "stopped");
        // started in Voicemeeter's window
        r.follow(Some(true), None);
        assert_eq!(r.mode, "recording");
    }
}
