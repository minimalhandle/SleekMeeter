//! Stream loudness: how loud the stream output is, in LUFS, the way YouTube, Twitch and
//! broadcasters measure it (ITU-R BS.1770-4 / EBU R 128). Momentary (400 ms), short-term (3 s)
//! and integrated (since you reset it, with the standard gates), plus the sample peak.
//!
//! It listens through Windows to the stream output ("Voicemeeter Out B2"), the same way
//! Instant replay does; nothing is recorded and nothing leaves the PC.

use crate::Settings;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// Below this a block counts as silence (BS.1770's absolute gate).
const ABS_GATE: f64 = -70.0;
/// Keep up to four hours of 400 ms blocks for the integrated value (100 ms apart).
const MAX_BLOCKS: usize = 4 * 3600 * 10;

/// One biquad filter (direct form I) for one channel.
#[derive(Clone, Copy, Default)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    x: [f64; 2],
    y: [f64; 2],
}

impl Biquad {
    fn run(&mut self, x0: f64) -> f64 {
        let y0 = self.b[0] * x0 + self.b[1] * self.x[0] + self.b[2] * self.x[1]
            - self.a[0] * self.y[0]
            - self.a[1] * self.y[1];
        self.x = [x0, self.x[0]];
        self.y = [y0, self.y[0]];
        y0
    }
}

/// BS.1770's K-weighting for sample rate `fs`: a high shelf (the head) then a high pass.
/// Coefficients for any rate, as libebur128 derives them.
fn k_weighting(fs: f64) -> [Biquad; 2] {
    use std::f64::consts::PI;
    let (f0, g, q) = (1681.974450955533, 3.999843853973347, 0.7071752369554196);
    let k = (PI * f0 / fs).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad {
        b: [
            (vh + vb * k / q + k * k) / a0,
            2.0 * (k * k - vh) / a0,
            (vh - vb * k / q + k * k) / a0,
        ],
        a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
        ..Default::default()
    };
    let (f0, q) = (38.13547087602444, 0.5003270373238773);
    let k = (PI * f0 / fs).tan();
    let a0 = 1.0 + k / q + k * k;
    let high_pass = Biquad {
        b: [1.0, -2.0, 1.0],
        a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
        ..Default::default()
    };
    [shelf, high_pass]
}

fn lufs(mean_square: f64) -> f64 {
    if mean_square <= 0.0 {
        f64::NEG_INFINITY
    } else {
        -0.691 + 10.0 * mean_square.log10()
    }
}

/// The meter: feed it interleaved samples, read LUFS values.
pub struct Meter {
    filters: Vec<[Biquad; 2]>,
    /// Samples per 100 ms sub-block (per channel).
    hop: usize,
    /// Weighted energy and sample count of the sub-block being filled.
    acc: f64,
    filled: usize,
    peak_now: f32,
    /// The last 30 sub-blocks (3 s): energy summed over channels, and their peaks.
    subs: std::collections::VecDeque<(f64, f32)>,
    /// Mean square of every 400 ms block since the reset, for the integrated value.
    blocks: Vec<f64>,
    started: Instant,
}

impl Meter {
    pub fn new(rate: u32, channels: usize) -> Meter {
        Meter {
            filters: vec![k_weighting(rate as f64); channels.clamp(1, 2)],
            hop: (rate as usize / 10).max(1),
            acc: 0.0,
            filled: 0,
            peak_now: 0.0,
            subs: std::collections::VecDeque::with_capacity(31),
            blocks: Vec::new(),
            started: Instant::now(),
        }
    }

    /// Interleaved samples with `channels` per frame; only the first two are measured.
    pub fn push(&mut self, data: &[f32], channels: usize) {
        let channels = channels.max(1);
        let used = self.filters.len().min(channels);
        for frame in data.chunks_exact(channels) {
            for (c, f) in self.filters.iter_mut().take(used).enumerate() {
                let s = frame[c];
                self.peak_now = self.peak_now.max(s.abs());
                let shelved = f[0].run(s as f64);
                let y = f[1].run(shelved);
                self.acc += y * y;
            }
            self.filled += 1;
            if self.filled == self.hop {
                self.end_sub_block();
            }
        }
    }

    fn end_sub_block(&mut self) {
        let energy = self.acc / self.hop as f64;
        if self.subs.len() == 30 {
            self.subs.pop_front();
        }
        self.subs.push_back((energy, self.peak_now));
        self.acc = 0.0;
        self.filled = 0;
        self.peak_now = 0.0;
        // A 400 ms block every 100 ms (75 % overlap), once there are four sub-blocks.
        if self.subs.len() >= 4 {
            let ms = self.mean(4);
            if self.blocks.len() == MAX_BLOCKS {
                self.blocks.remove(0);
            }
            self.blocks.push(ms);
        }
    }

    fn mean(&self, n: usize) -> f64 {
        let n = n.min(self.subs.len()).max(1);
        self.subs.iter().rev().take(n).map(|(e, _)| e).sum::<f64>() / n as f64
    }

    pub fn momentary(&self) -> f64 {
        if self.subs.len() < 4 {
            f64::NEG_INFINITY
        } else {
            lufs(self.mean(4))
        }
    }

    pub fn short_term(&self) -> f64 {
        if self.subs.len() < 30 {
            lufs(self.mean(self.subs.len()))
        } else {
            lufs(self.mean(30))
        }
    }

    /// Gated: blocks under -70 LUFS are dropped, then blocks more than 10 LU under the mean
    /// of the rest.
    pub fn integrated(&self) -> f64 {
        let loud: Vec<f64> = self
            .blocks
            .iter()
            .copied()
            .filter(|&b| lufs(b) > ABS_GATE)
            .collect();
        if loud.is_empty() {
            return f64::NEG_INFINITY;
        }
        let relative = lufs(loud.iter().sum::<f64>() / loud.len() as f64) - 10.0;
        let kept: Vec<f64> = loud.into_iter().filter(|&b| lufs(b) > relative).collect();
        if kept.is_empty() {
            return f64::NEG_INFINITY;
        }
        lufs(kept.iter().sum::<f64>() / kept.len() as f64)
    }

    /// The highest sample in the last 3 seconds, in dBFS.
    pub fn peak(&self) -> f64 {
        let p = self
            .subs
            .iter()
            .map(|(_, p)| *p)
            .fold(self.peak_now, f32::max);
        if p <= 0.0 {
            f64::NEG_INFINITY
        } else {
            20.0 * (p as f64).log10()
        }
    }

    pub fn reset_integrated(&mut self) {
        // The sub-blocks go too, so audio from before the reset can't reach the new blocks.
        self.subs.clear();
        self.acc = 0.0;
        self.filled = 0;
        self.blocks.clear();
        self.started = Instant::now();
    }
}

static METER: Mutex<Option<Meter>> = Mutex::new(None);
static STATUS: Mutex<Value> = Mutex::new(Value::Null);
static BROKEN: AtomicBool = AtomicBool::new(false);
/// When samples last arrived, to tell "no sound" from "not listening".
static LAST_AUDIO: Mutex<Option<Instant>> = Mutex::new(None);

/// A reading for the UI: null when there's nothing to show (silence, or not enough audio yet).
fn val(v: f64) -> Value {
    if v.is_finite() && v > ABS_GATE {
        json!((v * 10.0).round() / 10.0)
    } else {
        Value::Null
    }
}

/// `{ running, message, device, momentary, shortTerm, integrated, peak, since }` in LUFS / dBFS.
pub fn status() -> Value {
    let mut s = STATUS.lock().unwrap().clone();
    if s.is_null() {
        return json!({ "running": false, "message": "Off", "device": "" });
    }
    if let Some(m) = METER.lock().unwrap().as_ref() {
        s["momentary"] = val(m.momentary());
        s["shortTerm"] = val(m.short_term());
        s["integrated"] = val(m.integrated());
        s["peak"] = if m.peak().is_finite() {
            json!((m.peak() * 10.0).round() / 10.0)
        } else {
            Value::Null
        };
        s["since"] = json!(m.started.elapsed().as_secs());
        let quiet = LAST_AUDIO
            .lock()
            .unwrap()
            .map_or(true, |t| t.elapsed() > Duration::from_secs(2));
        s["receiving"] = json!(!quiet);
    }
    s
}

/// Start the integrated measurement again (for example at the start of a stream).
pub fn reset() {
    if let Some(m) = METER.lock().unwrap().as_mut() {
        m.reset_integrated();
    }
}

#[derive(PartialEq, Clone)]
struct Cfg {
    on: bool,
    stream: String,
}

fn cfg(app: &AppHandle) -> Cfg {
    let state = app.state::<Settings>();
    let s = state.0.lock().unwrap();
    let layout = crate::vm::Layout::for_edition(s["edition"].as_i64().unwrap_or(2) as i32);
    let stream = crate::watch::stream_bus(&s, &layout)
        .map(|j| crate::watch::bus_param(&layout, j))
        .unwrap_or_default();
    Cfg {
        on: s["loudness"]["on"].as_bool().unwrap_or(false),
        stream,
    }
}

fn set_status(running: bool, device: &str, message: &str) {
    *STATUS.lock().unwrap() = json!({ "running": running, "device": device, "message": message });
}

/// Keep measuring while it's on; follow the stream output setting.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_error = String::new();
        loop {
            let c = cfg(&app);
            if !c.on {
                *METER.lock().unwrap() = None;
                *STATUS.lock().unwrap() = Value::Null;
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }
            let all = crate::replay::devices();
            let Some(device) = crate::replay::auto_device(&all, &c.stream) else {
                *METER.lock().unwrap() = None;
                set_status(
                    false,
                    "",
                    "Couldn't find Voicemeeter's outputs in Windows. Is Voicemeeter installed?",
                );
                std::thread::sleep(Duration::from_secs(3));
                continue;
            };
            BROKEN.store(false, Ordering::Relaxed);
            match listen(&app, &c, &device) {
                Ok(()) => last_error.clear(),
                Err(e) => {
                    if e != last_error {
                        log_warn!("Stream loudness: {e}");
                        last_error = e.clone();
                    }
                    *METER.lock().unwrap() = None;
                    set_status(false, &device, &e);
                    std::thread::sleep(Duration::from_secs(3));
                }
            }
        }
    });
}

fn listen(app: &AppHandle, c: &Cfg, device: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let stream = imp::open(device)?;
        log_info!("Stream loudness: measuring {device}");
        set_status(true, device, &format!("Measuring {device}."));
        while cfg(app) == *c && !BROKEN.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(500));
        }
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
    use super::{Meter, BROKEN, LAST_AUDIO, METER};
    use rodio::cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use rodio::cpal::{SampleFormat, Stream};
    use std::sync::atomic::Ordering;

    fn feed(data: &[f32], ch: usize) {
        if let Some(m) = METER.lock().unwrap().as_mut() {
            m.push(data, ch);
        }
        if data.iter().any(|s| s.abs() > 1e-5) {
            *LAST_AUDIO.lock().unwrap() = Some(std::time::Instant::now());
        }
    }

    pub fn open(name: &str) -> Result<Stream, String> {
        let dev = rodio::cpal::default_host()
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().ok().as_deref() == Some(name))
            .ok_or_else(|| format!("Couldn't find {name}"))?;
        let cfg = dev.default_input_config().map_err(|e| e.to_string())?;
        let (rate, ch) = (cfg.sample_rate().0, cfg.channels() as usize);
        *METER.lock().unwrap() = Some(Meter::new(rate, ch));
        let err = |e: rodio::cpal::StreamError| {
            log_warn!("Stream loudness: {e}");
            BROKEN.store(true, Ordering::Relaxed);
        };
        let stream = match cfg.sample_format() {
            SampleFormat::F32 => dev.build_input_stream(
                &cfg.clone().into(),
                move |d: &[f32], _| feed(d, ch),
                err,
                None,
            ),
            SampleFormat::I16 => dev.build_input_stream(
                &cfg.clone().into(),
                move |d: &[i16], _| {
                    feed(
                        &d.iter().map(|s| *s as f32 / 32768.0).collect::<Vec<_>>(),
                        ch,
                    )
                },
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

    fn sine(db: f64, freq: f64, rate: u32, secs: f64) -> Vec<f32> {
        let amp = 10f64.powf(db / 20.0);
        let n = (rate as f64 * secs) as usize;
        let mut v = Vec::with_capacity(n * 2);
        for i in 0..n {
            let s =
                (amp * (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin()) as f32;
            v.push(s);
            v.push(s);
        }
        v
    }

    #[test]
    fn a_stereo_1khz_tone_reads_its_level_in_lufs() {
        // BS.1770: a 1 kHz sine at -20 dBFS on both channels measures -20 LUFS (within 0.1).
        for rate in [44100, 48000] {
            let mut m = Meter::new(rate, 2);
            m.push(&sine(-20.0, 1000.0, rate, 5.0), 2);
            for v in [m.momentary(), m.short_term(), m.integrated()] {
                assert!((v + 20.0).abs() < 0.1, "{rate} Hz: {v}");
            }
            assert!((m.peak() + 20.0).abs() < 0.05, "peak {}", m.peak());
        }
    }

    #[test]
    fn silence_is_gated_out_of_the_integrated_value() {
        let mut m = Meter::new(48000, 2);
        m.push(&sine(-23.0, 1000.0, 48000, 4.0), 2);
        m.push(&vec![0.0; 48000 * 2 * 4], 2);
        assert!((m.integrated() + 23.0).abs() < 0.2, "{}", m.integrated());
        assert_eq!(m.momentary(), f64::NEG_INFINITY);
    }

    #[test]
    fn reset_starts_the_integrated_value_again() {
        let mut m = Meter::new(48000, 2);
        m.push(&sine(-10.0, 1000.0, 48000, 3.0), 2);
        m.reset_integrated();
        m.push(&sine(-30.0, 1000.0, 48000, 3.0), 2);
        assert!((m.integrated() + 30.0).abs() < 0.3, "{}", m.integrated());
    }
}
