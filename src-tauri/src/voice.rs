//! CPU speech processing; floats at the boundary are normalized to +/-1.

use serde_json::Value;

pub const FRAME: usize = 480;

pub struct CpuVoice {
    model: Box<nnnoiseless::DenoiseState<'static>>,
    input: [f32; FRAME],
    clean: [f32; FRAME],
    dry: [f32; FRAME],
}

impl CpuVoice {
    pub fn new() -> Self {
        Self {
            model: nnnoiseless::DenoiseState::new(),
            input: [0.0; FRAME],
            clean: [0.0; FRAME],
            dry: [0.0; FRAME],
        }
    }

    /// RNNoise uses signed 16-bit scale and has one frame of overlap delay.
    /// Blend with the previous dry frame, never the current (unaligned) input.
    pub fn process(&mut self, input: &[f32], output: &mut [f32], strength: f32) -> f32 {
        assert_eq!(input.len(), FRAME);
        assert_eq!(output.len(), FRAME);
        for (to, &v) in self.input.iter_mut().zip(input) {
            *to = if v.is_finite() {
                v.clamp(-1.0, 1.0) * 32768.0
            } else {
                0.0
            };
        }
        let probability = self
            .model
            .process_frame(&mut self.clean, &self.input)
            .clamp(0.0, 1.0);
        let wet = if strength.is_finite() {
            strength.clamp(0.0, 1.0)
        } else {
            1.0
        };
        for (i, out) in output.iter_mut().enumerate() {
            *out = self.dry[i] * (1.0 - wet) + self.clean[i] / 32768.0 * wet;
            self.dry[i] = self.input[i] / 32768.0;
        }
        probability
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RiderConfig {
    pub on: bool,
    pub target_db: f32,
    pub max_boost_db: f32,
    pub max_cut_db: f32,
    pub speed_db: f32,
}

impl RiderConfig {
    pub fn from_json(v: &Value) -> Self {
        let num = |key: &str, default: f64, lo: f64, hi: f64| {
            v[key]
                .as_f64()
                .filter(|v| v.is_finite())
                .unwrap_or(default)
                .clamp(lo, hi) as f32
        };
        Self {
            on: v["on"] == true,
            target_db: num("targetDb", -20.0, -30.0, -12.0),
            max_boost_db: num("maxBoostDb", 9.0, 0.0, 12.0),
            max_cut_db: num("maxCutDb", 12.0, 0.0, 18.0),
            speed_db: num("speedDb", 3.0, 0.5, 6.0),
        }
    }
}

#[derive(Default)]
pub struct Rider {
    gain: f32,
}

impl Rider {
    pub fn gain_db(&self) -> f32 {
        self.gain
    }

    pub fn process(&mut self, audio: &mut [f32], speech: f32, cfg: &RiderConfig, rate: u32) {
        if !cfg.on || audio.is_empty() || rate == 0 {
            self.gain = 0.0;
            return;
        }
        let power = audio
            .iter()
            .map(|v| if v.is_finite() { v * v } else { 0.0 })
            .sum::<f32>()
            / audio.len() as f32;
        let db = 10.0 * power.max(1e-12).log10();
        // No automatic gain from room tone, quiet breaths, or an unavailable detector.
        let desired = if speech >= 0.6 && db > -50.0 {
            (cfg.target_db - db).clamp(-cfg.max_cut_db, cfg.max_boost_db)
        } else {
            0.0
        };
        let start = self.gain;
        let step = cfg.speed_db * audio.len() as f32 / rate as f32;
        self.gain += (desired - self.gain).clamp(-step, step);
        let len = audio.len() as f32;
        for (i, sample) in audio.iter_mut().enumerate() {
            let gain = start + (self.gain - start) * (i + 1) as f32 / len;
            let value = if sample.is_finite() { *sample } else { 0.0 };
            // Last-resort peak ceiling while slow gain changes catch up to a shout.
            *sample = (value * 10f32.powf(gain / 20.0)).clamp(-0.89125, 0.89125);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rider_never_lifts_silence_or_non_speech() {
        let mut r = Rider::default();
        let cfg = RiderConfig::from_json(&serde_json::json!({"on":true}));
        for _ in 0..2000 {
            r.process(&mut [0.0; 480], 1.0, &cfg, 48000);
        }
        assert_eq!(r.gain_db(), 0.0);
        for _ in 0..2000 {
            r.process(&mut [0.001; 480], 0.1, &cfg, 48000);
        }
        assert_eq!(r.gain_db(), 0.0);
    }

    #[test]
    fn rider_limits_boost_and_recovers_from_loud_speech() {
        let mut r = Rider::default();
        let cfg =
            RiderConfig::from_json(&serde_json::json!({"on":true,"maxBoostDb":6,"maxCutDb":9}));
        for _ in 0..2000 {
            r.process(&mut [0.01; 480], 0.95, &cfg, 48000);
        }
        assert!((r.gain_db() - 6.0).abs() < 0.01);
        let mut loud = [0.9; 480];
        r.process(&mut loud, 0.95, &cfg, 48000);
        assert!(loud.iter().all(|s| s.is_finite() && s.abs() <= 0.89126));
        for _ in 0..2000 {
            r.process(&mut [0.5; 480], 0.95, &cfg, 48000);
        }
        assert!((r.gain_db() + 9.0).abs() < 0.01);
    }

    #[test]
    fn cpu_silence_is_finite_and_zero_strength_is_aligned_dry() {
        let mut cpu = CpuVoice::new();
        let mut out = [0.0; 480];
        for _ in 0..20 {
            let p = cpu.process(&[0.0; 480], &mut out, 1.0);
            assert!((0.0..=1.0).contains(&p));
            assert!(out.iter().all(|s| s.is_finite() && s.abs() < 0.0001));
        }
        let mut cpu = CpuVoice::new();
        cpu.process(&[0.1; 480], &mut out, 0.0);
        assert!(out.iter().all(|s| *s == 0.0));
        cpu.process(&[0.2; 480], &mut out, 0.0);
        assert!(out.iter().all(|s| (*s - 0.1).abs() < 0.00001));
    }

    #[test]
    fn rider_config_clamps_untrusted_values() {
        let c = RiderConfig::from_json(
            &serde_json::json!({"on":true,"targetDb":12,"maxBoostDb":100,"maxCutDb":-5,"speedDb":0}),
        );
        assert_eq!(c.target_db, -12.0);
        assert_eq!(c.max_boost_db, 12.0);
        assert_eq!(c.max_cut_db, 0.0);
        assert_eq!(c.speed_db, 0.5);
    }
}
