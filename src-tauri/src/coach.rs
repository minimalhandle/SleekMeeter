//! Mic coach: listens to your mic while you talk normally for half a minute and tells you, in
//! plain words, what would make it sound better: popping p's and b's, harsh s's, sitting too
//! close (boomy) or too far (quiet, roomy), a noisy room, or a mic so hot it clips. Each tip
//! comes with a fix where Sleekmeeter has one (an EQ preset, the mic tune-up, mic clean-up).
//!
//! It hears the mic as it arrives in Voicemeeter, before the fader and any clean-up, through
//! Voicemeeter's input insert (micfx.rs joins it while the coach listens and calls `tap`).
//! Nothing is recorded: each 10 ms only leaves five numbers (its level in a few frequency
//! bands), and those are gone when the coach closes.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

/// Longest listen; the analysis stops collecting after this.
const MAX_SECS: usize = 60;
/// Speech needed before the coach gives its verdict.
const ENOUGH_SPEECH: f32 = 12.0;

static WANT: AtomicBool = AtomicBool::new(false);
static COACH: Mutex<Option<Session>> = Mutex::new(None);

/// Is the coach listening (so micfx.rs should join the input insert)?
pub fn want_insert() -> bool {
    WANT.load(Ordering::Relaxed)
}

struct Session {
    target: String,
    c0: usize,
    started: Instant,
    analyzer: Option<Analyzer>,
}

/* ---------- filters ---------- */

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
    /// RBJ cookbook low-pass (`high` false) or high-pass, Butterworth Q.
    fn new(high: bool, f: f32, rate: f32) -> Biquad {
        let w = 2.0 * std::f32::consts::PI * (f / rate).min(0.45);
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
        let a0 = 1.0 + alpha;
        let (b0, b1) = if high {
            ((1.0 + c) / 2.0, -(1.0 + c))
        } else {
            ((1.0 - c) / 2.0, 1.0 - c)
        };
        Biquad {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b0 / a0,
            a1: -2.0 * c / a0,
            a2: (1.0 - alpha) / a0,
            ..Default::default()
        }
    }

    fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/* ---------- analysis ---------- */

/// One 10 ms frame, in dBFS: whole signal, below 100 Hz (plosives), below 250 Hz (boom),
/// 300 Hz to 3 kHz (the body of the voice), 5 to 9 kHz (s sounds), and the peak sample.
#[derive(Clone, Copy, Debug, Default)]
struct Frame {
    total: f32,
    sub: f32,
    low: f32,
    mid: f32,
    high: f32,
    peak: f32,
}

struct Analyzer {
    rate: u32,
    len: usize,
    n: usize,
    sum: [f32; 5],
    peak: f32,
    sub: Biquad,
    low: Biquad,
    mid_hp: Biquad,
    mid_lp: Biquad,
    high_hp: Biquad,
    high_lp: Biquad,
    frames: Vec<Frame>,
    power: [f32; 2],
}

fn db(power: f32) -> f32 {
    if power <= 1e-12 {
        -120.0
    } else {
        10.0 * power.log10()
    }
}

impl Analyzer {
    fn new(rate: u32) -> Analyzer {
        let r = rate as f32;
        Analyzer {
            rate,
            len: (rate / 100).max(1) as usize,
            n: 0,
            sum: [0.0; 5],
            peak: 0.0,
            sub: Biquad::new(false, 100.0, r),
            low: Biquad::new(false, 250.0, r),
            mid_hp: Biquad::new(true, 300.0, r),
            mid_lp: Biquad::new(false, 3000.0, r),
            high_hp: Biquad::new(true, 5000.0, r),
            high_lp: Biquad::new(false, 9000.0, r),
            frames: Vec::with_capacity(MAX_SECS * 100),
            power: [0.0; 2],
        }
    }

    fn full(&self) -> bool {
        self.frames.len() >= MAX_SECS * 100
    }

    fn push(&mut self, x: f32) {
        if self.full() {
            return;
        }
        let x = if x.is_finite() { x } else { 0.0 };
        let sub = self.sub.run(x);
        let low = self.low.run(x);
        let mid = self.mid_lp.run(self.mid_hp.run(x));
        let high = self.high_lp.run(self.high_hp.run(x));
        for (s, v) in self.sum.iter_mut().zip([x, sub, low, mid, high]) {
            *s += v * v;
        }
        self.peak = self.peak.max(x.abs());
        self.n += 1;
        if self.n == self.len {
            let m = |i: usize| db(self.sum[i] / self.len as f32);
            self.frames.push(Frame {
                total: m(0),
                sub: m(1),
                low: m(2),
                mid: m(3),
                high: m(4),
                peak: 20.0 * self.peak.max(1e-6).log10(),
            });
            self.n = 0;
            self.sum = [0.0; 5];
            self.peak = 0.0;
        }
    }

    /// One buffer of the mic's two channels. A mono mic on one side of a stereo input is
    /// often on one side only; averaging would halve it, so the quiet side is left out.
    fn push_pair(&mut self, l: &[f32], r: &[f32]) {
        let n = l.len().min(r.len());
        let block = |s: &[f32]| s.iter().map(|v| v * v).sum::<f32>() / n.max(1) as f32;
        self.power[0] = self.power[0] * 0.9 + block(&l[..n]) * 0.1;
        self.power[1] = self.power[1] * 0.9 + block(&r[..n]) * 0.1;
        let (pl, pr) = (self.power[0], self.power[1]);
        for k in 0..n {
            let x = if pl > pr * 100.0 {
                l[k]
            } else if pr > pl * 100.0 {
                r[k]
            } else {
                (l[k] + r[k]) * 0.5
            };
            self.push(x);
        }
    }
}

fn percentile(values: &[f32], p: f32) -> f32 {
    if values.is_empty() {
        return -120.0;
    }
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    v[((v.len() - 1) as f32 * p).round() as usize]
}

/// What the coach heard.
#[derive(Debug, Default, PartialEq)]
struct Report {
    speech_secs: f32,
    /// Typical speaking level and the room between phrases (dBFS, before the fader).
    level: f32,
    noise: f32,
    /// The loudest peaks while talking (dBFS).
    loud: f32,
    clips: usize,
    pops: usize,
    /// How much louder s sounds are than the vowels around them (dB, 90th percentile).
    ess: f32,
    esses: usize,
    /// Low end against the body of the voice (dB).
    boom: f32,
}

/// Count runs of `hit` frames as events, at least `gap` frames apart.
fn events(frames: &[Frame], gap: usize, mut hit: impl FnMut(usize) -> bool) -> usize {
    let (mut count, mut last) = (0, None::<usize>);
    for i in 0..frames.len() {
        if hit(i) && last.is_none_or(|l| i > l + gap) {
            count += 1;
            last = Some(i);
        } else if hit(i) {
            last = Some(i);
        }
    }
    count
}

fn analyze(frames: &[Frame]) -> Report {
    let totals: Vec<f32> = frames.iter().map(|f| f.total).collect();
    let noise = percentile(&totals, 0.1);
    let speaking = |f: &Frame| f.total > (noise + 10.0).max(-65.0);
    let speech: Vec<&Frame> = frames.iter().filter(|f| speaking(f)).collect();
    let speech_totals: Vec<f32> = speech.iter().map(|f| f.total).collect();
    let level = percentile(&speech_totals, 0.5);
    let loud = percentile(&speech.iter().map(|f| f.peak).collect::<Vec<_>>(), 0.99);
    // Voiced frames: the body of the voice carries most of the sound.
    let voiced: Vec<&&Frame> = speech
        .iter()
        .filter(|f| f.mid > f.high && f.mid > f.total - 6.0)
        .collect();
    let boom = percentile(
        &voiced.iter().map(|f| f.low - f.mid).collect::<Vec<_>>(),
        0.5,
    );
    let vowel = percentile(&voiced.iter().map(|f| f.total).collect::<Vec<_>>(), 0.5);
    // S sounds: the 5-9 kHz band louder than the body of the voice.
    let sibilant: Vec<f32> = speech
        .iter()
        .filter(|f| f.high > f.mid + 3.0)
        .map(|f| f.high - vowel)
        .collect();
    let ess = if sibilant.len() >= 10 {
        percentile(&sibilant, 0.9)
    } else {
        -30.0
    };
    let esses = events(frames, 12, |i| {
        let f = &frames[i];
        speaking(f) && f.high > f.mid + 3.0 && f.high - vowel > 2.0
    });
    // Plosives: a sudden burst below 100 Hz that carries most of the sound.
    let pops = events(frames, 15, |i| {
        let f = &frames[i];
        if i < 4 || !speaking(f) || f.sub < f.total - 2.5 || f.total < noise + 18.0 {
            return false;
        }
        let before = frames[i - 4..i]
            .iter()
            .map(|p| p.sub)
            .fold(-120.0f32, f32::max);
        f.sub > before + 9.0
    });
    let clips = events(frames, 5, |i| frames[i].peak > -0.3);
    Report {
        speech_secs: speech.len() as f32 / 100.0,
        level,
        noise,
        loud,
        clips,
        pops,
        ess,
        esses,
        boom,
    }
}

/// The tips, most important first: `{ id, title, detail, fix? }`. `fix` is `{ eq: preset }`,
/// `"tune"` (mic tune-up) or `"cleanup"` (Settings → Microphone).
fn tips(r: &Report) -> Vec<Value> {
    let mut out = Vec::new();
    let tip = |id: &str, title: &str, detail: String, fix: Value| json!({ "id": id, "title": title, "detail": detail, "fix": fix });
    if r.clips > 0 || r.loud > -1.0 {
        out.push(tip(
            "clip",
            "Your mic is too hot",
            format!(
                "Your loudest peaks reach {:.0} dBFS{}, so they distort before Voicemeeter can do anything about it. Turn the gain down on the mic or interface (or in Windows' Sound settings → Recording) until shouting stays below -6.",
                r.loud,
                if r.clips > 0 { format!(" and clipped {} time{}", r.clips, if r.clips == 1 { "" } else { "s" }) } else { String::new() }
            ),
            Value::Null,
        ));
    }
    let snr = r.level - r.noise;
    if r.level < -42.0 {
        out.push(tip(
            "quiet",
            "You're quiet, or far from the mic",
            format!("You talk at about {:.0} dBFS before the fader. Move the mic closer (a hand's width for most mics) or turn up its gain, then run Mic tune-up to set the fader.", r.level),
            json!("tune"),
        ));
    }
    if snr < 25.0 {
        out.push(tip(
            "noisy",
            "The room is loud next to your voice",
            format!("Between phrases the mic hears the room at {:.0} dBFS, only {:.0} dB under your voice. Getting closer to the mic helps most; mic clean-up or a noise gate takes care of the rest.", r.noise, snr.max(0.0)),
            json!("cleanup"),
        ));
    }
    let pops_per_min = r.pops as f32 * 60.0 / r.speech_secs.max(1.0);
    let harsh = r.ess > 2.0 && r.esses >= 3;
    let popping = r.pops >= 2 && pops_per_min >= 4.0;
    if popping {
        out.push(tip(
            "pops",
            "P's and B's pop",
            format!("{} pops while you talked. Aim the mic slightly past your mouth instead of straight at it, or use a pop filter. The Fewer pops EQ takes out the rumble they leave.", r.pops),
            json!({ "eq": if harsh { "speech" } else { "pops" } }),
        ));
    }
    if harsh {
        out.push(tip(
            "esses",
            "S sounds are harsh",
            format!("Your s sounds come out about {:.0} dB louder than your vowels. Turning the mic a little off-axis helps, and the Softer S EQ tames them.", r.ess),
            json!({ "eq": if popping { "speech" } else { "esses" } }),
        ));
    }
    if r.boom > 0.0 && !popping {
        out.push(tip(
            "boom",
            "Your voice is boomy",
            "There's more low end than the body of your voice, which usually means you're very close to the mic. Back off a little, or use the Fewer pops EQ, which also trims the boom.".into(),
            json!({ "eq": "pops" }),
        ));
    }
    out
}

/* ---------- control ---------- */

/// Start listening to the input `target` ("Strip[0]").
pub fn start(layout: &crate::vm::Layout, target: &str) -> Result<(), String> {
    let (c0, output) =
        crate::micfx::insert_slot(target, layout).ok_or("Pick one of Voicemeeter's inputs.")?;
    if output {
        return Err("Pick one of Voicemeeter's inputs.".into());
    }
    let rate = crate::micfx::insert_rate();
    *COACH.lock().unwrap() = Some(Session {
        target: target.to_string(),
        c0,
        started: Instant::now(),
        analyzer: (rate > 0).then(|| Analyzer::new(rate)),
    });
    WANT.store(true, Ordering::Relaxed);
    Ok(())
}

pub fn stop() {
    WANT.store(false, Ordering::Relaxed);
    *COACH.lock().unwrap() = None;
}

/// `{ running, target, secs, speechSecs, enough, level, noise, message, tips }`.
pub fn status() -> Value {
    let g = COACH.lock().unwrap();
    let Some(s) = g.as_ref() else {
        return json!({ "running": false });
    };
    let secs = s.started.elapsed().as_secs_f32();
    let Some(a) = s.analyzer.as_ref().filter(|a| !a.frames.is_empty()) else {
        let message = if secs > 4.0 {
            "Sleekmeeter isn't getting audio from Voicemeeter's input insert yet. If another app uses it, close that app, and check Voicemeeter is running."
        } else {
            "Starting to listen…"
        };
        return json!({ "running": true, "target": s.target, "secs": secs, "speechSecs": 0, "enough": false, "message": message, "tips": [] });
    };
    let r = analyze(&a.frames);
    let enough = r.speech_secs >= ENOUGH_SPEECH;
    let done = a.full();
    json!({
        "running": !done,
        "target": s.target,
        "secs": secs,
        "speechSecs": r.speech_secs,
        "enough": enough,
        "level": r.level,
        "noise": r.noise,
        "message": if !enough && done { "Not enough talking to judge. Try again and keep talking." } else { "" },
        "tips": if enough { tips(&r) } else { Vec::new() },
    })
}

/// From the input insert's audio callback (micfx.rs), with the mic as it arrives. Never waits.
///
/// # Safety
/// `r` holds Voicemeeter's channel pointers, each valid for `n` samples, for `chans` channels.
pub unsafe fn tap(r: &[*mut f32; 128], chans: usize, n: usize, rate: u32) {
    if !WANT.load(Ordering::Relaxed) || n == 0 || rate == 0 {
        return;
    }
    let Ok(mut g) = COACH.try_lock() else { return };
    let Some(s) = g.as_mut() else { return };
    if s.c0 + 1 >= chans {
        return;
    }
    let (l, rr) = (r[s.c0], r[s.c0 + 1]);
    if l.is_null() || rr.is_null() {
        return;
    }
    if s.analyzer.as_ref().is_none_or(|a| a.rate != rate) {
        s.analyzer = Some(Analyzer::new(rate));
    }
    let a = s.analyzer.as_mut().unwrap();
    let (ls, rs) = unsafe {
        (
            std::slice::from_raw_parts(l, n),
            std::slice::from_raw_parts(rr, n),
        )
    };
    a.push_pair(ls, rs);
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48000;

    struct Noise(u32);
    impl Noise {
        fn next(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
            (self.0 >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
        }
    }

    /// A rough voice: a 150 Hz buzz with harmonics, in syllables of 200 ms on and 100 ms off,
    /// over a quiet room. `extra` adds to each sample (for pops and esses).
    fn voice(secs: f32, amp: f32, mut extra: impl FnMut(usize, &mut Noise) -> f32) -> Analyzer {
        let mut a = Analyzer::new(RATE);
        let mut rng = Noise(7);
        let n = (secs * RATE as f32) as usize;
        for i in 0..n {
            let t = i as f32 / RATE as f32;
            let on = (t % 0.3) < 0.2;
            let mut x = 0.0005 * rng.next();
            if on {
                for h in 1..12 {
                    let f = 150.0 * h as f32;
                    // Most energy in the 300-3000 Hz body.
                    let w = if (300.0..3000.0).contains(&f) {
                        1.0
                    } else {
                        0.25
                    };
                    x += amp * w / h as f32 * (2.0 * std::f32::consts::PI * f * t).sin();
                }
            }
            x += extra(i, &mut rng);
            a.push(x);
        }
        a
    }

    #[test]
    fn a_clean_voice_gets_no_tips() {
        let a = voice(20.0, 0.05, |_, _| 0.0);
        let r = analyze(&a.frames);
        assert!(r.speech_secs > ENOUGH_SPEECH, "{r:?}");
        assert!((-35.0..-15.0).contains(&r.level), "{r:?}");
        assert!(r.noise < -60.0, "{r:?}");
        assert_eq!(r.pops, 0, "{r:?}");
        assert_eq!(r.clips, 0);
        assert!(tips(&r).is_empty(), "{:?}", tips(&r));
    }

    #[test]
    fn hears_pops() {
        // A 40 Hz thump at the start of every third syllable.
        let a = voice(20.0, 0.05, |i, _| {
            let t = i as f32 / RATE as f32;
            let k = (t / 0.3) as usize;
            let into = t - k as f32 * 0.3;
            if k % 3 == 0 && into < 0.04 {
                0.6 * (2.0 * std::f32::consts::PI * 40.0 * into).sin()
            } else {
                0.0
            }
        });
        let r = analyze(&a.frames);
        assert!(r.pops >= 10, "{r:?}");
        assert!(tips(&r).iter().any(|t| t["id"] == "pops"));
    }

    #[test]
    fn hears_harsh_esses() {
        // Loud hiss filtered to the s range in the gaps between syllables.
        let mut hp = Biquad::new(true, 5500.0, RATE as f32);
        let a = voice(20.0, 0.05, |i, rng| {
            let t = i as f32 / RATE as f32;
            let s = (t % 0.3) >= 0.22 && (t % 0.3) < 0.29 && ((t / 0.3) as usize) % 2 == 0;
            let x = hp.run(rng.next());
            if s {
                0.5 * x
            } else {
                0.0
            }
        });
        let r = analyze(&a.frames);
        assert!(r.ess > 2.0 && r.esses >= 3, "{r:?}");
        assert!(tips(&r).iter().any(|t| t["id"] == "esses"));
    }

    #[test]
    fn notices_clipping_and_quiet() {
        let hot = analyze(&voice(15.0, 1.2, |_, _| 0.0).frames);
        assert!(tips(&hot).iter().any(|t| t["id"] == "clip"), "{hot:?}");
        let quiet = analyze(&voice(15.0, 0.002, |_, _| 0.0).frames);
        assert!(tips(&quiet).iter().any(|t| t["id"] == "quiet"), "{quiet:?}");
    }

    #[test]
    fn counts_events_with_a_gap() {
        let frames = vec![Frame::default(); 40];
        let hits = [1, 2, 3, 20, 21, 39];
        assert_eq!(events(&frames, 5, |i| hits.contains(&i)), 3);
    }

    #[test]
    fn stops_collecting_after_a_minute() {
        let mut a = Analyzer::new(1000);
        for _ in 0..(MAX_SECS * 1000 + 5000) {
            a.push(0.1);
        }
        assert_eq!(a.frames.len(), MAX_SECS * 100);
        assert!(a.full());
    }
}
