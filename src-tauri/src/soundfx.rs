//! Listening EQ presets and Steadier volume (a leveller), on any of Voicemeeter's inputs or
//! outputs, with no added delay.
//!
//! Unlike mic clean-up (micfx.rs), which hands audio to a worker thread, these are a few filters
//! and a compressor: cheap enough to run right inside Voicemeeter's audio callback. They run on
//! the channel's buffer after mic clean-up and plugins, so they shape what finally plays. Inputs go
//! through Voicemeeter's input insert and outputs through its output insert; micfx.rs joins those
//! inserts and calls `process` for each buffer.
//!
//! Settings: `soundFx: { "Bus[0]": { eq: "footsteps", level: "night" }, "Strip[3]": { … } }`.
//! Like mic clean-up, it only runs while Sleekmeeter is open; without it Voicemeeter plays the
//! channel untouched.

use serde_json::Value;
use std::sync::Mutex;

/// EQ presets Settings offers: (id, name).
pub const EQ_PRESETS: &[(&str, &str)] = &[
    ("off", "Off"),
    ("footsteps", "Footsteps"),
    ("bass", "Bass boost"),
    ("voice", "Voice clarity"),
    ("bright", "Brighter"),
    ("warm", "Warmer"),
    ("night", "Late night (less bass)"),
];
/// Leveller settings: (id, name).
pub const LEVELS: &[(&str, &str)] = &[
    ("off", "Off"),
    ("gentle", "Gentle"),
    ("night", "Night mode"),
];

/// Most channels one target can have: virtual strips and buses are 8 (7.1).
const MAX_CH: usize = 8;

#[derive(Clone, Copy)]
enum Kind {
    Peak,
    LowShelf,
    HighShelf,
    HighPass,
}

/// One filter of a preset: kind, frequency (Hz), gain (dB), Q.
type Band = (Kind, f32, f32, f32);

fn bands(preset: &str) -> &'static [Band] {
    use Kind::*;
    match preset {
        // Less rumble from explosions, more of the 2-5 kHz range footsteps and reloads live in.
        "footsteps" => &[
            (LowShelf, 160.0, -5.0, 0.7),
            (Peak, 2200.0, 3.5, 1.0),
            (Peak, 4500.0, 4.0, 1.2),
        ],
        "bass" => &[(LowShelf, 110.0, 6.0, 0.7), (Peak, 2500.0, -1.0, 0.8)],
        "voice" => &[
            (HighPass, 90.0, 0.0, 0.7),
            (Peak, 300.0, -2.5, 1.0),
            (Peak, 3000.0, 4.0, 0.9),
        ],
        "bright" => &[(HighShelf, 6000.0, 4.0, 0.7)],
        "warm" => &[(LowShelf, 220.0, 3.0, 0.7), (HighShelf, 7000.0, -3.0, 0.7)],
        "night" => &[(HighPass, 70.0, 0.0, 0.7), (LowShelf, 200.0, -6.0, 0.7)],
        _ => &[],
    }
}

/// A biquad (RBJ's cookbook), transposed direct form II.
#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn new((kind, f, gain_db, q): Band, rate: f32) -> Biquad {
        let w = 2.0 * std::f32::consts::PI * (f / rate).min(0.49);
        let (sin, cos) = w.sin_cos();
        let alpha = sin / (2.0 * q);
        let a = 10f32.powf(gain_db / 40.0);
        let (b0, b1, b2, a0, a1, a2) = match kind {
            Kind::Peak => (
                1.0 + alpha * a,
                -2.0 * cos,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cos,
                1.0 - alpha / a,
            ),
            Kind::LowShelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * cos + s),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                    a * ((a + 1.0) - (a - 1.0) * cos - s),
                    (a + 1.0) + (a - 1.0) * cos + s,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                    (a + 1.0) + (a - 1.0) * cos - s,
                )
            }
            Kind::HighShelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * cos + s),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                    a * ((a + 1.0) + (a - 1.0) * cos - s),
                    (a + 1.0) - (a - 1.0) * cos + s,
                    2.0 * ((a - 1.0) - (a + 1.0) * cos),
                    (a + 1.0) - (a - 1.0) * cos - s,
                )
            }
            Kind::HighPass => (
                (1.0 + cos) / 2.0,
                -(1.0 + cos),
                (1.0 + cos) / 2.0,
                1.0 + alpha,
                -2.0 * cos,
                1.0 - alpha,
            ),
        };
        Biquad {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }
    #[inline]
    fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// The leveller: a stereo-linked compressor that brings loud parts down and quiet parts up, with
/// a safety limiter at the end. Very quiet audio (silence, hiss) isn't lifted.
struct Leveller {
    threshold: f32,
    ratio: f32,
    makeup: f32,
    attack: f32,
    release: f32,
    /// Smoothed level, dB.
    env: f32,
    /// Limiter gain (linear), recovering slowly after a peak.
    lim: f32,
    lim_release: f32,
}

const CEILING: f32 = 0.89; // -1 dBFS

impl Leveller {
    fn new(mode: &str, rate: f32) -> Option<Leveller> {
        let (threshold, ratio, makeup, attack_ms, release_ms) = match mode {
            "gentle" => (-24.0, 2.5, 3.0, 15.0, 250.0),
            "night" => (-32.0, 5.0, 9.0, 5.0, 300.0),
            _ => return None,
        };
        let coef = |ms: f32| (-1.0 / (ms * 0.001 * rate)).exp();
        Some(Leveller {
            threshold,
            ratio,
            makeup,
            attack: coef(attack_ms),
            release: coef(release_ms),
            env: -90.0,
            lim: 1.0,
            lim_release: coef(80.0),
        })
    }
    /// Gain (linear) for a sample whose loudest channel is `peak`.
    #[inline]
    fn gain(&mut self, peak: f32) -> f32 {
        let db = 20.0 * (peak + 1e-9).log10();
        let c = if db > self.env {
            self.attack
        } else {
            self.release
        };
        self.env = db + c * (self.env - db);
        let over = self.env - self.threshold;
        let reduce = if over > 0.0 {
            over * (1.0 - 1.0 / self.ratio)
        } else {
            0.0
        };
        // Don't lift the noise floor: full make-up from -60 dB up, none below -70 dB.
        let lift = self.makeup * ((self.env + 70.0) / 10.0).clamp(0.0, 1.0);
        let g = 10f32.powf((lift - reduce) / 20.0);
        // Limiter: never louder than the ceiling, then recover gently.
        let out = peak * g * self.lim;
        if out > CEILING {
            self.lim = CEILING / (peak * g).max(1e-9);
        } else {
            self.lim = 1.0 + self.lim_release * (self.lim - 1.0);
        }
        g * self.lim
    }
}

/// One channel's processing.
struct Target {
    /// Output insert (a bus) rather than the input insert (a strip).
    output: bool,
    /// First insert channel, and how many.
    ch0: usize,
    nch: usize,
    filters: Vec<Vec<Biquad>>,
    level: Option<Leveller>,
}

struct Bank {
    rate: u32,
    key: String,
    targets: Vec<Target>,
}

static BANK: Mutex<Option<Bank>> = Mutex::new(None);

/// What one channel asks for, from settings.
#[derive(Clone, Debug, PartialEq)]
pub struct Want {
    pub target: String,
    pub output: bool,
    pub ch0: usize,
    pub nch: usize,
    pub eq: String,
    pub level: String,
}

fn valid(id: &str, list: &[(&str, &str)]) -> String {
    if list.iter().any(|(k, _)| *k == id) {
        id.to_string()
    } else {
        "off".into()
    }
}

/// The channels with an EQ preset or leveller on (`soundFx` in settings), and where they are in
/// Voicemeeter's inserts.
pub fn wants(sound_fx: &Value, layout: &crate::vm::Layout) -> Vec<Want> {
    let Some(map) = sound_fx.as_object() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (target, v) in map {
        let eq = valid(v["eq"].as_str().unwrap_or("off"), EQ_PRESETS);
        let level = valid(v["level"].as_str().unwrap_or("off"), LEVELS);
        if eq == "off" && level == "off" {
            continue;
        }
        let idx = |p: &str| -> Option<usize> {
            target
                .strip_prefix(p)?
                .strip_suffix(']')?
                .parse::<usize>()
                .ok()
        };
        let (output, ch0, nch) = if let Some(i) = idx("Strip[") {
            if i < layout.hw_strips {
                (false, i * 2, 2)
            } else if i < layout.strips() {
                (false, layout.hw_strips * 2 + (i - layout.hw_strips) * 8, 8)
            } else {
                continue;
            }
        } else if let Some(j) = idx("Bus[") {
            if j < layout.buses() {
                (true, j * 8, 8)
            } else {
                continue;
            }
        } else {
            continue;
        };
        out.push(Want {
            target: target.clone(),
            output,
            ch0,
            nch,
            eq,
            level,
        });
    }
    out.sort_by(|a, b| a.target.cmp(&b.target));
    out
}

/// Make the audio callback use `wants` at `rate`. Filter state is reset only when something changed.
pub fn sync(wants: &[Want], rate: u32) {
    let key = format!("{rate}|{wants:?}");
    if BANK
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|b| b.key == key && b.rate == rate)
    {
        return;
    }
    let r = rate.max(8000) as f32;
    let targets = wants
        .iter()
        .map(|w| Target {
            output: w.output,
            ch0: w.ch0,
            nch: w.nch.min(MAX_CH),
            filters: (0..w.nch.min(MAX_CH))
                .map(|_| bands(&w.eq).iter().map(|b| Biquad::new(*b, r)).collect())
                .collect(),
            level: Leveller::new(&w.level, r),
        })
        .collect();
    *BANK.lock().unwrap() = Some(Bank { rate, key, targets });
}

/// Is anything set up for inputs / outputs? (Which of Voicemeeter's inserts to join.)
pub fn needs(wants: &[Want]) -> (bool, bool) {
    (
        wants.iter().any(|w| !w.output),
        wants.iter().any(|w| w.output),
    )
}

/// Voicemeeter's audio thread: shape the channels set up for this insert, in place.
///
/// # Safety
/// `w` must hold `chans` valid pointers, each to at least `n` samples (or null).
pub unsafe fn process(w: &[*mut f32], chans: usize, n: usize, output: bool) {
    let Ok(mut guard) = BANK.try_lock() else {
        return;
    };
    let Some(bank) = guard.as_mut() else {
        return;
    };
    for t in bank.targets.iter_mut().filter(|t| t.output == output) {
        let mut bufs: [Option<&mut [f32]>; MAX_CH] = Default::default();
        let mut any = false;
        for c in 0..t.nch {
            let ch = t.ch0 + c;
            if ch < chans && ch < w.len() && !w[ch].is_null() {
                bufs[c] = Some(unsafe { std::slice::from_raw_parts_mut(w[ch], n) });
                any = true;
            }
        }
        if !any {
            continue;
        }
        for (c, buf) in bufs.iter_mut().enumerate() {
            if let (Some(buf), Some(chain)) = (buf.as_deref_mut(), t.filters.get_mut(c)) {
                for f in chain.iter_mut() {
                    for s in buf.iter_mut() {
                        *s = f.run(*s);
                    }
                }
            }
        }
        if let Some(lev) = &mut t.level {
            for k in 0..n {
                let peak = bufs.iter().flatten().fold(0f32, |m, b| m.max(b[k].abs()));
                let g = lev.gain(peak);
                for b in bufs.iter_mut().flatten() {
                    b[k] *= g;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sine(freq: f32, rate: f32, n: usize, amp: f32) -> Vec<f32> {
        (0..n)
            .map(|k| amp * (2.0 * std::f32::consts::PI * freq * k as f32 / rate).sin())
            .collect()
    }
    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn low_shelf_cuts_bass_and_leaves_treble() {
        let rate = 48_000.0;
        let mut f = Biquad::new((Kind::LowShelf, 160.0, -5.0, 0.7), rate);
        let lo: Vec<f32> = sine(50.0, rate, 48_000, 0.5)
            .iter()
            .map(|s| f.run(*s))
            .collect();
        let mut f = Biquad::new((Kind::LowShelf, 160.0, -5.0, 0.7), rate);
        let hi: Vec<f32> = sine(5000.0, rate, 48_000, 0.5)
            .iter()
            .map(|s| f.run(*s))
            .collect();
        let lo_db = 20.0 * (rms(&lo[24_000..]) / (0.5 / 2f32.sqrt())).log10();
        let hi_db = 20.0 * (rms(&hi[24_000..]) / (0.5 / 2f32.sqrt())).log10();
        assert!((lo_db + 5.0).abs() < 0.8, "bass {lo_db:.2} dB");
        assert!(hi_db.abs() < 0.3, "treble {hi_db:.2} dB");
    }

    #[test]
    fn night_mode_evens_out_loud_and_quiet() {
        let rate = 48_000.0;
        let mut lev = Leveller::new("night", rate).unwrap();
        let run = |lev: &mut Leveller, amp: f32| -> f32 {
            let x = sine(440.0, rate, 48_000, amp);
            let y: Vec<f32> = x.iter().map(|s| s * lev.gain(s.abs())).collect();
            rms(&y[24_000..])
        };
        let quiet_in = 0.02 / 2f32.sqrt();
        let loud_in = 0.8 / 2f32.sqrt();
        let quiet = run(&mut lev, 0.02);
        let loud = run(&mut lev, 0.8);
        let spread_in = 20.0 * (loud_in / quiet_in).log10();
        let spread_out = 20.0 * (loud / quiet).log10();
        assert!(
            spread_out < spread_in - 10.0,
            "in {spread_in:.1} dB, out {spread_out:.1} dB"
        );
        let peak = sine(440.0, rate, 4800, 1.0)
            .iter()
            .map(|s| (s * lev.gain(s.abs())).abs())
            .fold(0f32, f32::max);
        assert!(peak <= CEILING + 0.01, "peak {peak}");
    }

    #[test]
    fn wants_maps_channels_to_insert_positions() {
        let s = json!({
            "Bus[1]": { "eq": "footsteps", "level": "off" },
            "Strip[3]": { "eq": "off", "level": "night" },
            "Strip[0]": { "eq": "off", "level": "off" },
            "Bus[9]": { "eq": "bass" },
        });
        let layout = crate::vm::Layout::for_edition(2); // Banana: 3 hw strips, 5 buses
        let w = wants(&s, &layout);
        assert_eq!(w.len(), 2);
        assert_eq!(
            (w[0].target.as_str(), w[0].output, w[0].ch0, w[0].nch),
            ("Bus[1]", true, 8, 8)
        );
        assert_eq!(
            (w[1].target.as_str(), w[1].output, w[1].ch0, w[1].nch),
            ("Strip[3]", false, 6, 8)
        );
        assert_eq!(needs(&w), (true, true));
    }
}
