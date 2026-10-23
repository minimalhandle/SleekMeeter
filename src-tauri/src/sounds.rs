//! Soundboard: play short clips into your stream mix.
//!
//! Clips are played to one output device. Point it at one of Voicemeeter's virtual inputs
//! (like "Voicemeeter Aux Input") and the clip shows up as a channel in the mixer, so it goes
//! wherever you route that channel and you control its level with its fader.

use crate::Settings;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
mod player {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};
    use std::fs::File;
    use std::io::BufReader;
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::{Mutex, OnceLock};

    enum Cmd {
        Play {
            path: String,
            volume: f32,
            device: String,
        },
        Stop,
    }

    static TX: OnceLock<Mutex<Sender<Cmd>>> = OnceLock::new();

    fn send(cmd: Cmd) {
        let tx = TX.get_or_init(|| {
            let (tx, rx) = channel();
            std::thread::spawn(move || worker(rx));
            Mutex::new(tx)
        });
        let _ = tx.lock().unwrap().send(cmd);
    }

    /// Names of all output devices Windows has.
    pub fn devices() -> Vec<String> {
        rodio::cpal::default_host()
            .output_devices()
            .map(|list| list.filter_map(|d| d.name().ok()).collect())
            .unwrap_or_default()
    }

    /// The device used when none is chosen: a Voicemeeter virtual input if there is one.
    pub fn auto_device() -> String {
        let all = devices();
        for want in ["voicemeeter aux input", "voicemeeter input"] {
            if let Some(d) = all.iter().find(|d| d.to_lowercase().contains(want)) {
                return d.clone();
            }
        }
        String::new()
    }

    pub fn play(path: &str, volume: f32, device: &str) {
        send(Cmd::Play {
            path: path.to_string(),
            volume,
            device: device.to_string(),
        });
    }

    pub fn stop() {
        send(Cmd::Stop);
    }

    fn open(name: &str) -> Result<(OutputStream, OutputStreamHandle), String> {
        let wanted = if name.is_empty() {
            auto_device()
        } else {
            name.to_string()
        };
        if !wanted.is_empty() {
            let found = rodio::cpal::default_host()
                .output_devices()
                .ok()
                .and_then(|mut list| {
                    list.find(|d| d.name().ok().as_deref() == Some(wanted.as_str()))
                });
            if let Some(device) = found {
                return OutputStream::try_from_device(&device).map_err(|e| e.to_string());
            }
        }
        OutputStream::try_default().map_err(|e| e.to_string())
    }

    fn worker(rx: Receiver<Cmd>) {
        let mut stream: Option<(String, OutputStream, OutputStreamHandle)> = None;
        let mut sinks: Vec<Sink> = Vec::new();
        while let Ok(cmd) = rx.recv() {
            sinks.retain(|s| !s.empty());
            match cmd {
                Cmd::Stop => sinks.clear(),
                Cmd::Play {
                    path,
                    volume,
                    device,
                } => {
                    if stream.as_ref().map(|s| s.0 != device).unwrap_or(true) {
                        sinks.clear();
                        stream = None;
                        match open(&device) {
                            Ok((s, h)) => stream = Some((device.clone(), s, h)),
                            Err(e) => {
                                log_warn!("Soundboard: couldn't open the output device: {e}");
                                continue;
                            }
                        }
                    }
                    let Some((_, _, handle)) = stream.as_ref() else {
                        continue;
                    };
                    let file = match File::open(&path) {
                        Ok(f) => f,
                        Err(e) => {
                            log_warn!("Soundboard: couldn't open {path}: {e}");
                            continue;
                        }
                    };
                    let source = match Decoder::new(BufReader::new(file)) {
                        Ok(s) => s,
                        Err(e) => {
                            log_warn!("Soundboard: couldn't play {path}: {e}");
                            continue;
                        }
                    };
                    match Sink::try_new(handle) {
                        Ok(sink) => {
                            sink.set_volume(volume);
                            sink.append(source);
                            sinks.push(sink);
                        }
                        Err(e) => log_warn!("Soundboard: couldn't start playback: {e}"),
                    }
                }
            }
        }
    }
}

/// { devices: [names], auto: name used when none is chosen }
pub fn devices() -> Value {
    #[cfg(windows)]
    {
        json!({ "devices": player::devices(), "auto": player::auto_device() })
    }
    #[cfg(not(windows))]
    {
        json!({ "devices": [], "auto": "" })
    }
}

/// Play the sound called `name` (not case sensitive) from the soundboard.
pub fn play(app: &AppHandle, name: &str) -> Result<(), String> {
    let found = {
        let state = app.state::<Settings>();
        let s = state.0.lock().unwrap();
        let sb = &s["soundboard"];
        let master = sb["volume"].as_f64().unwrap_or(100.0).clamp(0.0, 100.0) as f32 / 100.0;
        let device = sb["device"].as_str().unwrap_or("").to_string();
        let hit = sb["sounds"].as_array().and_then(|list| {
            list.iter()
                .find(|x| {
                    x["name"]
                        .as_str()
                        .map(|n| n.trim().eq_ignore_ascii_case(name.trim()))
                        .unwrap_or(false)
                })
                .cloned()
        });
        hit.map(|x| {
            let own = x["volume"].as_f64().unwrap_or(100.0).clamp(0.0, 100.0) as f32 / 100.0;
            (
                x["path"].as_str().unwrap_or("").to_string(),
                master * own,
                device,
            )
        })
    };
    let Some((path, volume, device)) = found else {
        return Err(format!("No sound called {name:?}"));
    };
    if path.is_empty() || !std::path::Path::new(&path).exists() {
        return Err(format!("The file for {name:?} is missing: {path}"));
    }
    #[cfg(windows)]
    {
        player::play(&path, volume, &device);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (volume, device);
        Err("Only available on Windows".into())
    }
}

pub fn stop_all() {
    #[cfg(windows)]
    player::stop();
}
