//! Instant replay: Sleekmeeter keeps listening to one of Voicemeeter's outputs (the stream
//! output by default) and holds the last 15 to 120 seconds in memory. A shortcut, the header
//! button, a Twitch command or Sleekmeeter Remote saves them as a WAV file in
//! Music\Sleekmeeter replays, for clipping a funny moment without OBS's replay buffer.
//!
//! It listens through Windows ("Voicemeeter Out B2"), the same way the hear-yourself test
//! does; nothing is recorded to disk until you save, and nothing leaves the PC.
//!
//! Separate tracks: up to four inputs (mic, game, chat...) can be kept too, each as the stream
//! hears it: after its fader (its layer for the stream output on Potato), and silent while it's
//! muted or not sent to the stream. They come from Voicemeeter's input insert, which mic
//! clean-up also uses (micfx.rs calls `tap`). A save then makes a folder with the stream mix
//! and one WAV per input, all the same length, ready to drop into a video editor.

use crate::{settings, show_osd_text, Settings, Vm};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The last seconds of audio, interleaved 16-bit samples, oldest overwritten first.
struct Ring {
    data: Vec<i16>,
    pos: usize,
    filled: bool,
    rate: u32,
    channels: u16,
}

impl Ring {
    fn push(&mut self, s: i16) {
        self.data[self.pos] = s;
        self.pos += 1;
        if self.pos == self.data.len() {
            self.pos = 0;
            self.filled = true;
        }
    }

    /// Everything held, oldest first.
    fn ordered(&self) -> Vec<i16> {
        if self.filled {
            let mut v = Vec::with_capacity(self.data.len());
            v.extend_from_slice(&self.data[self.pos..]);
            v.extend_from_slice(&self.data[..self.pos]);
            v
        } else {
            self.data[..self.pos].to_vec()
        }
    }
}

static RING: Mutex<Option<Ring>> = Mutex::new(None);

/// One input kept as its own track.
struct Track {
    name: String,
    /// The first of its two channels in Voicemeeter's input insert.
    c0: usize,
    ring: Ring,
    /// Its level on the stream as a factor (0 while muted or not sent), and the factor the
    /// last buffer ended on, so changes ramp instead of clicking.
    gain: f32,
    applied: f32,
}

struct Tracks {
    rate: u32,
    list: Vec<Track>,
}

static TRACKS: Mutex<Option<Tracks>> = Mutex::new(None);
/// Separate tracks are on: micfx.rs joins Voicemeeter's input insert for them.
static WANT_TRACKS: AtomicBool = AtomicBool::new(false);
static TRACKS_MESSAGE: Mutex<String> = Mutex::new(String::new());

pub fn tracks_want_insert() -> bool {
    WANT_TRACKS.load(Ordering::Relaxed)
}

/// From the input insert's audio callback (micfx.rs): copy each track's two channels.
/// Never waits: if the tracks are being changed, this buffer is skipped.
///
/// # Safety
/// `w` holds Voicemeeter's channel pointers, each valid for `n` samples, for `chans` channels.
pub unsafe fn tap(w: &[*mut f32; 128], chans: usize, n: usize, rate: u32) {
    let Ok(mut g) = TRACKS.try_lock() else { return };
    let Some(t) = g.as_mut() else { return };
    if t.rate != rate || n == 0 {
        return;
    }
    for tr in &mut t.list {
        if tr.c0 + 1 >= chans {
            continue;
        }
        let (l, r) = (w[tr.c0], w[tr.c0 + 1]);
        if l.is_null() || r.is_null() {
            continue;
        }
        let (g0, g1) = (tr.applied, tr.gain);
        for k in 0..n {
            let g = g0 + (g1 - g0) * (k as f32 / n as f32);
            let to16 = |s: f32| ((s * g).clamp(-1.0, 1.0) * 32767.0) as i16;
            let (ls, rs) = unsafe { (*l.add(k), *r.add(k)) };
            tr.ring.push(to16(ls));
            tr.ring.push(to16(rs));
        }
        tr.applied = g1;
    }
}
static STATUS: Mutex<Value> = Mutex::new(Value::Null);
/// The audio device reported an error: listen again.
static BROKEN: AtomicBool = AtomicBool::new(false);

fn idle(message: &str) -> Value {
    json!({ "running": false, "message": message, "device": "" })
}

/// `{ running, message, device, tracks }` for Settings and the go-live check. `tracks` says
/// how separate tracks are doing ("" when they're off or fine).
pub fn status() -> Value {
    let mut s = STATUS.lock().unwrap().clone();
    if s.is_null() {
        s = idle("Off");
    }
    s["tracks"] = json!(TRACKS_MESSAGE.lock().unwrap().clone());
    s
}

fn set_status(v: Value) {
    *STATUS.lock().unwrap() = v;
}

#[derive(PartialEq, Clone)]
struct Cfg {
    on: bool,
    device: String,
    secs: u64,
    /// "B2": the stream output, for picking the device when none is chosen.
    stream: String,
    /// Separate tracks: (input like "Strip[0]", its first channel in the input insert).
    tracks: Vec<(String, usize)>,
    /// Potato: an input's level on the stream is its gain layer for the stream output (this index).
    layer: Option<usize>,
}

fn cfg(app: &AppHandle) -> Cfg {
    let state = app.state::<Settings>();
    let s = state.0.lock().unwrap();
    let r = &s["replay"];
    let layout = crate::vm::Layout::for_edition(s["edition"].as_i64().unwrap_or(2) as i32);
    let stream_j = crate::watch::stream_bus(&s, &layout);
    let stream = stream_j
        .map(|j| crate::watch::bus_param(&layout, j))
        .unwrap_or_default();
    let tracks = r["tracks"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .filter_map(|p| match crate::micfx::insert_slot(p, &layout) {
                    Some((c0, false)) => Some((p.to_string(), c0)),
                    _ => None,
                })
                .take(4)
                .collect()
        })
        .unwrap_or_default();
    let potato = s["edition"].as_i64() == Some(3);
    Cfg {
        on: r["on"].as_bool().unwrap_or(false),
        device: r["device"].as_str().unwrap_or("").to_string(),
        secs: r["secs"].as_u64().unwrap_or(60).clamp(10, 180),
        stream,
        tracks,
        layer: if potato { stream_j } else { None },
    }
}

/// Voicemeeter's outputs as Windows lists them for recording ("Voicemeeter Out B2 (…)").
pub fn devices() -> Vec<String> {
    #[cfg(windows)]
    {
        imp::devices()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// The device for an output like "B2": "Voicemeeter Out B2", or the older names Voicemeeter
/// used ("Voicemeeter Output" for B1, "Voicemeeter Aux Output" for B2, "VAIO3 Output" for B3).
pub(crate) fn auto_device(all: &[String], out: &str) -> Option<String> {
    let lower: Vec<String> = all.iter().map(|d| d.to_lowercase()).collect();
    let find = |want: &str| lower.iter().position(|d| d.contains(want));
    let older = match out {
        "B1" => "voicemeeter output",
        "B2" => "voicemeeter aux output",
        "B3" => "vaio3 output",
        _ => "voicemeeter output",
    };
    find(&format!("voicemeeter out {}", out.to_lowercase()))
        .or_else(|| find(older))
        .or_else(|| find("voicemeeter out"))
        .map(|i| all[i].clone())
}

/// Where replays go: Music\Sleekmeeter replays (the settings folder if there's no Music).
pub fn folder() -> PathBuf {
    let music = std::env::var_os("USERPROFILE")
        .map(|p| PathBuf::from(p).join("Music"))
        .filter(|p| p.is_dir());
    match music {
        Some(m) => m.join("Sleekmeeter replays"),
        None => settings::app_dir().join("replays"),
    }
}

/// Local date and time for the file name: 2026-11-07 21.14.05.
fn stamp() -> String {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::GetLocalTime;
        let t = unsafe {
            let mut t = std::mem::zeroed();
            GetLocalTime(&mut t);
            t
        };
        let t: windows_sys::Win32::Foundation::SYSTEMTIME = t;
        format!(
            "{:04}-{:02}-{:02} {:02}.{:02}.{:02}",
            t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
        )
    }
    #[cfg(not(windows))]
    {
        let s = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        s.to_string()
    }
}

/// A 16-bit PCM WAV file.
fn wav(samples: &[i16], rate: u32, channels: u16) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut v = Vec::with_capacity(44 + data_len as usize);
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&(36 + data_len).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes()); // PCM
    v.extend_from_slice(&channels.to_le_bytes());
    v.extend_from_slice(&rate.to_le_bytes());
    v.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
    v.extend_from_slice(&(channels * 2).to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        v.extend_from_slice(&s.to_le_bytes());
    }
    v
}

/// Save what's held right now. Returns the file's path.
pub fn save(app: &AppHandle) -> Result<String, String> {
    let (samples, rate, channels) = {
        let ring = RING.lock().unwrap();
        let r = ring.as_ref().ok_or_else(|| {
            show_osd_text(app, "Instant replay", "Not on", false, "record");
            "Turn on Instant replay in Settings → Instant replay first".to_string()
        })?;
        (r.ordered(), r.rate, r.channels)
    };
    if samples.len() < (rate as usize * channels as usize) / 2 {
        return Err("Nothing to save yet: the replay has only just started listening".into());
    }
    let mut secs = samples.len() / (rate as usize * channels as usize).max(1);
    let dir = folder();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
    // Separate tracks, cut to the same length as each other and the stream mix.
    let tracks: Vec<(String, Vec<i16>, u32)> = TRACKS
        .lock()
        .unwrap()
        .as_ref()
        .map(|t| {
            t.list
                .iter()
                .map(|tr| (tr.name.clone(), tr.ring.ordered(), t.rate))
                .collect()
        })
        .unwrap_or_default();
    let tracks: Vec<_> = tracks
        .into_iter()
        .filter(|(_, s, r)| s.len() >= *r as usize)
        .collect();
    let path = if tracks.is_empty() {
        let path = dir.join(format!("Replay {}.wav", stamp()));
        std::fs::write(&path, wav(&samples, rate, channels))
            .map_err(|e| format!("Couldn't save the replay: {e}"))?;
        path
    } else {
        for (_, s, r) in &tracks {
            secs = secs.min(s.len() / (*r as usize * 2));
        }
        let path = dir.join(format!("Replay {}", stamp()));
        std::fs::create_dir_all(&path)
            .map_err(|e| format!("Couldn't make {}: {e}", path.display()))?;
        let mix = last_secs(samples, rate, channels, secs);
        std::fs::write(path.join("Stream mix.wav"), wav(&mix, rate, channels))
            .map_err(|e| format!("Couldn't save the replay: {e}"))?;
        let mut used: Vec<String> = vec!["stream mix".into()];
        for (name, s, r) in tracks {
            let mut file = file_name(&name);
            while used.contains(&file.to_lowercase()) {
                file.push_str(" 2");
            }
            used.push(file.to_lowercase());
            std::fs::write(
                path.join(format!("{file}.wav")),
                wav(&last_secs(s, r, 2, secs), r, 2),
            )
            .map_err(|e| format!("Couldn't save the {name} track: {e}"))?;
        }
        path
    };
    log_info!("Saved a {secs} s replay to {}", path.display());
    show_osd_text(
        app,
        "Instant replay",
        &format!("Saved {secs} s"),
        true,
        "record",
    );
    Ok(path.display().to_string())
}

/// Open the replays folder in Explorer.
pub fn open_folder() -> Result<(), String> {
    let dir = folder();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open the replays folder: {e}"))
}

/// Keep listening while Instant replay is on; follow changes to its settings.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_error = String::new();
        loop {
            let c = cfg(&app);
            if !c.on {
                *RING.lock().unwrap() = None;
                set_status(idle("Off"));
                last_error.clear();
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
            let all = devices();
            let device = if c.device.is_empty() {
                auto_device(&all, &c.stream)
            } else {
                all.iter().find(|d| **d == c.device).cloned()
            };
            let Some(device) = device else {
                *RING.lock().unwrap() = None;
                let msg = if c.device.is_empty() {
                    "Couldn't find Voicemeeter's outputs in Windows. Is Voicemeeter installed?"
                        .to_string()
                } else {
                    format!("{} isn't connected", c.device)
                };
                set_status(idle(&msg));
                std::thread::sleep(Duration::from_secs(3));
                continue;
            };
            BROKEN.store(false, Ordering::Relaxed);
            match listen(&app, &c, &device) {
                Ok(()) => last_error.clear(),
                Err(e) => {
                    if e != last_error {
                        log_warn!("Instant replay: {e}");
                        last_error = e.clone();
                    }
                    *RING.lock().unwrap() = None;
                    set_status(idle(&e));
                    std::thread::sleep(Duration::from_secs(3));
                }
            }
        }
    });
}

/// Set up the track buffers once Voicemeeter's input insert runs, and keep each track's level
/// in step with its fader, mute and route to the stream.
fn sync_tracks(app: &AppHandle, c: &Cfg) {
    if c.tracks.is_empty() {
        return;
    }
    let rate = crate::micfx::insert_rate();
    if !crate::micfx::input_insert_on() || rate == 0 {
        *TRACKS.lock().unwrap() = None;
        *TRACKS_MESSAGE.lock().unwrap() =
            "Separate tracks are waiting for Voicemeeter's audio insert. If another app is using it, close that app. Replays save the stream mix only until then.".into();
        return;
    }
    TRACKS_MESSAGE.lock().unwrap().clear();
    let stale = TRACKS
        .lock()
        .unwrap()
        .as_ref()
        .map_or(true, |t| t.rate != rate);
    if stale {
        let snap = app.state::<Vm>().last.lock().unwrap().clone();
        let len = rate as usize * 2 * c.secs as usize;
        let list = c
            .tracks
            .iter()
            .map(|(prefix, c0)| {
                let i: usize = prefix
                    .trim_start_matches("Strip[")
                    .trim_end_matches(']')
                    .parse()
                    .unwrap_or(0);
                Track {
                    name: crate::watch::name_of(&snap, "strips", i, &format!("Input {}", i + 1)),
                    c0: *c0,
                    ring: Ring {
                        data: vec![0; len.max(2)],
                        pos: 0,
                        filled: false,
                        rate,
                        channels: 2,
                    },
                    gain: 0.0,
                    applied: 0.0,
                }
            })
            .collect();
        *TRACKS.lock().unwrap() = Some(Tracks { rate, list });
        log_info!("Instant replay: keeping {} separate tracks", c.tracks.len());
    }
    let Some(api) = app.state::<Vm>().api.clone() else {
        return;
    };
    let gains: Vec<f32> = c
        .tracks
        .iter()
        .map(|(p, _)| {
            let muted = api.get_float(&format!("{p}.Mute")).unwrap_or(0.0) != 0.0;
            let sent = c.stream.is_empty()
                || api.get_float(&format!("{p}.{}", c.stream)).unwrap_or(0.0) != 0.0;
            if muted || !sent {
                return 0.0;
            }
            let db = match c.layer {
                Some(j) => api.get_float(&format!("{p}.GainLayer[{j}]")),
                None => api.get_float(&format!("{p}.Gain")),
            }
            .unwrap_or(0.0);
            if db <= -60.0 {
                0.0
            } else {
                10f32.powf(db / 20.0)
            }
        })
        .collect();
    if let Some(t) = TRACKS.lock().unwrap().as_mut() {
        for (tr, g) in t.list.iter_mut().zip(gains) {
            tr.gain = g;
        }
    }
}

/// A file name from a channel name: no characters Windows refuses.
fn file_name(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|ch| {
            if r#"\/:*?"<>|"#.contains(ch) || ch.is_control() {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let clean = clean.trim().trim_end_matches('.').to_string();
    if clean.is_empty() {
        "Input".to_string()
    } else {
        clean
    }
}

/// The newest `secs` seconds of interleaved samples.
fn last_secs(samples: Vec<i16>, rate: u32, channels: u16, secs: usize) -> Vec<i16> {
    let keep = secs * rate as usize * channels as usize;
    if samples.len() > keep {
        samples[samples.len() - keep..].to_vec()
    } else {
        samples
    }
}

/// Listen to `device` until the settings change or the device fails.
fn listen(app: &AppHandle, c: &Cfg, device: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let stream = imp::open(device, c.secs)?;
        log_info!("Instant replay: keeping the last {} s of {device}", c.secs);
        set_status(json!({
            "running": true,
            "device": device,
            "message": format!("Keeping the last {} seconds of {device}.", c.secs),
        }));
        WANT_TRACKS.store(!c.tracks.is_empty(), Ordering::Relaxed);
        while cfg(app) == *c && !BROKEN.load(Ordering::Relaxed) {
            sync_tracks(app, c);
            std::thread::sleep(Duration::from_millis(250));
        }
        WANT_TRACKS.store(false, Ordering::Relaxed);
        *TRACKS.lock().unwrap() = None;
        TRACKS_MESSAGE.lock().unwrap().clear();
        drop(stream);
        if BROKEN.load(Ordering::Relaxed) {
            return Err(format!("Lost {device}"));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, c, device);
        Err("Only available on Windows".into())
    }
}

#[cfg(windows)]
mod imp {
    use super::{Ring, BROKEN, RING};
    use rodio::cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use rodio::cpal::{SampleFormat, Stream};
    use std::sync::atomic::Ordering;

    pub fn devices() -> Vec<String> {
        rodio::cpal::default_host()
            .input_devices()
            .map(|l| {
                l.filter_map(|d| d.name().ok())
                    .filter(|n| {
                        let n = n.to_lowercase();
                        n.contains("voicemeeter") && n.contains("out")
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Keep the first two channels of each frame (an output set to 8 channels is still saved
    /// as stereo, and uses a quarter of the memory).
    fn write(data: impl Iterator<Item = i16>, channels: usize) {
        if let Some(r) = RING.lock().unwrap().as_mut() {
            for (n, s) in data.enumerate() {
                if channels <= 2 || n % channels < 2 {
                    r.push(s);
                }
            }
        }
    }

    pub fn open(name: &str, secs: u64) -> Result<Stream, String> {
        let dev = rodio::cpal::default_host()
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().ok().as_deref() == Some(name))
            .ok_or_else(|| format!("Couldn't find {name}"))?;
        let cfg = dev.default_input_config().map_err(|e| e.to_string())?;
        let (rate, ch) = (cfg.sample_rate().0, cfg.channels() as usize);
        let kept = ch.min(2);
        let len = (rate as usize) * kept * (secs as usize);
        *RING.lock().unwrap() = Some(Ring {
            data: vec![0; len.max(kept)],
            pos: 0,
            filled: false,
            rate,
            channels: kept as u16,
        });
        let err = |e: rodio::cpal::StreamError| {
            log_warn!("Instant replay: {e}");
            BROKEN.store(true, Ordering::Relaxed);
        };
        let to16 = |s: f32| (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        let stream = match cfg.sample_format() {
            SampleFormat::F32 => dev.build_input_stream(
                &cfg.clone().into(),
                move |d: &[f32], _| write(d.iter().map(|s| to16(*s)), ch),
                err,
                None,
            ),
            SampleFormat::I16 => dev.build_input_stream(
                &cfg.clone().into(),
                move |d: &[i16], _| write(d.iter().copied(), ch),
                err,
                None,
            ),
            SampleFormat::U16 => dev.build_input_stream(
                &cfg.clone().into(),
                move |d: &[u16], _| write(d.iter().map(|s| (*s as i32 - 32768) as i16), ch),
                err,
                None,
            ),
            other => return Err(format!("Unsupported audio format {other:?}")),
        }
        .map_err(|e| format!("Couldn't listen to {name}: {e}"))?;
        stream.play().map_err(|e| e.to_string())?;
        Ok(stream)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ring_keeps_the_newest_samples_in_order() {
        let mut r = Ring {
            data: vec![0; 4],
            pos: 0,
            filled: false,
            rate: 1,
            channels: 1,
        };
        for s in 1..=3 {
            r.push(s);
        }
        assert_eq!(r.ordered(), vec![1, 2, 3]);
        for s in 4..=6 {
            r.push(s);
        }
        assert_eq!(r.ordered(), vec![3, 4, 5, 6]);
    }

    #[test]
    fn the_stream_output_device_is_found_by_name() {
        let all = vec![
            "Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)".to_string(),
            "Voicemeeter Out B2 (VB-Audio Voicemeeter AUX VAIO)".to_string(),
        ];
        assert_eq!(auto_device(&all, "B2").as_deref(), Some(all[1].as_str()));
        let older = vec![
            "VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)".to_string(),
            "VoiceMeeter Aux Output (VB-Audio VoiceMeeter AUX VAIO)".to_string(),
        ];
        assert_eq!(
            auto_device(&older, "B2").as_deref(),
            Some(older[1].as_str())
        );
        assert_eq!(
            auto_device(&older, "B1").as_deref(),
            Some(older[0].as_str())
        );
    }

    #[test]
    fn track_files_get_safe_names_and_equal_lengths() {
        assert_eq!(file_name("Mic: Shure/MV7?"), "Mic_ Shure_MV7_");
        assert_eq!(file_name("  ..."), "Input");
        let s: Vec<i16> = (0..20).collect();
        // 2 channels at 2 Hz: the newest 3 seconds are the last 12 samples.
        assert_eq!(last_secs(s.clone(), 2, 2, 3), (8..20).collect::<Vec<i16>>());
        assert_eq!(last_secs(s.clone(), 2, 2, 10), s);
    }

    #[test]
    fn a_wav_header_describes_the_samples() {
        let w = wav(&[0, 1, 2, 3], 48000, 2);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(w.len(), 44 + 8);
        assert_eq!(u32::from_le_bytes([w[40], w[41], w[42], w[43]]), 8);
    }
}
