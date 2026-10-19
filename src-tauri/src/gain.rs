//! Smooth level changes: fades, fading mute and talk-over ducking.
//!
//! This only works out what to tell Voicemeeter, as script lines for VBVMR_SetParameters
//! (Voicemeeter does the fading itself with `FadeTo`). It never calls Voicemeeter, so it
//! has no dependencies and is tested on its own (`rustc --test src/gain.rs`).
//!
//! A channel is "managed" while ducking lowers it or a mute fades it. Then `base` is the
//! level the person chose (that is what the mixer shows) and Voicemeeter's real level is
//! `base + duck`. Everything else is left alone.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

pub const FLOOR: f32 = -60.0;
pub const CEIL: f32 = 12.0;

fn clamp(db: f32) -> f32 {
    db.clamp(FLOOR, CEIL)
}

/// `Strip[3].FadeTo = (-12.0, 300);`
pub fn fade_line(key: &str, db: f32, ms: u64) -> String {
    format!("{key}.FadeTo = ({:.1}, {ms});", clamp(db))
}

fn set_line(key: &str, param: &str, v: f32) -> String {
    format!("{key}.{param} = {v:.2};")
}

#[derive(Debug, Clone)]
struct Chan {
    /// The level the person chose.
    base: f32,
    /// Ducking offset in dB (0 or negative).
    duck: f32,
    /// Mute state to show while a mute fade runs.
    shown_mute: Option<bool>,
    /// A mute is fading out: press Voicemeeter's mute at this moment.
    mute_at: Option<Instant>,
    /// Fades sent for this channel are finished by this moment.
    settle: Instant,
    /// The level Voicemeeter should end up at.
    expect: f32,
}

impl Chan {
    fn eff(&self) -> f32 {
        clamp(self.base + self.duck)
    }
}

/// What the mixer should show for a managed channel.
#[derive(Debug, Clone, PartialEq)]
pub struct View {
    pub gain: f32,
    pub mute: Option<bool>,
    pub ducked: bool,
}

pub struct Smooth {
    chans: BTreeMap<String, Chan>,
    /// Where plain glides are heading, so quick repeated hotkey presses add up.
    aims: BTreeMap<String, (f32, Instant)>,
    /// Ducking is lowering the target channels right now.
    pub ducked: bool,
    loud_at: Option<Instant>,
    /// No ducking until this moment (a scene is loading).
    hold_off: Option<Instant>,
}

impl Default for Smooth {
    fn default() -> Self {
        Self::new()
    }
}

impl Smooth {
    pub fn new() -> Smooth {
        Smooth {
            chans: BTreeMap::new(),
            aims: BTreeMap::new(),
            ducked: false,
            loud_at: None,
            hold_off: None,
        }
    }

    /// The level a channel is at or heading to.
    pub fn current(&self, key: &str, actual: f32, now: Instant) -> f32 {
        if let Some(c) = self.chans.get(key) {
            return c.base;
        }
        match self.aims.get(key) {
            Some((target, until)) if now < *until => *target,
            _ => actual,
        }
    }

    fn chan(&mut self, key: &str, actual: f32, now: Instant) -> &mut Chan {
        let base = self.current(key, actual, now);
        self.aims.remove(key);
        self.chans.entry(key.to_string()).or_insert(Chan {
            base,
            duck: 0.0,
            shown_mute: None,
            mute_at: None,
            settle: now,
            expect: base,
        })
    }

    /// Glide to a new level over `ms` (typed values, shortcuts).
    pub fn glide(&mut self, key: &str, target: f32, ms: u64, now: Instant) -> Vec<String> {
        let target = clamp(target);
        let d = Duration::from_millis(ms);
        if let Some(c) = self.chans.get_mut(key) {
            c.base = target;
            if c.mute_at.is_some() {
                return Vec::new(); // fading into mute: the new level is applied when the mute lands
            }
            let e = c.eff();
            c.expect = e;
            c.settle = now + d;
            return vec![fade_line(key, e, ms)];
        }
        self.aims.insert(
            key.to_string(),
            (target, now + d + Duration::from_millis(60)),
        );
        vec![fade_line(key, target, ms)]
    }

    /// A level set directly, e.g. while dragging a fader. `None` = not managed, write it as usual.
    pub fn set_direct(&mut self, key: &str, value: f32, now: Instant) -> Option<Vec<String>> {
        self.aims.remove(key);
        let c = self.chans.get_mut(key)?;
        c.base = clamp(value);
        if c.mute_at.is_some() {
            return Some(Vec::new());
        }
        let e = c.eff();
        c.expect = e;
        c.settle = now + Duration::from_millis(80);
        Some(vec![set_line(key, "Gain", e)])
    }

    /// The mute state the person sees (a fade may still be running).
    pub fn is_muted(&self, key: &str, actual_mute: bool) -> bool {
        self.chans
            .get(key)
            .and_then(|c| c.shown_mute)
            .unwrap_or(actual_mute)
    }

    /// Fade out and then mute, or unmute and fade back in.
    pub fn mute(
        &mut self,
        key: &str,
        actual_gain: f32,
        actual_mute: bool,
        want: bool,
        ms: u64,
        now: Instant,
    ) -> Vec<String> {
        if self.is_muted(key, actual_mute) == want {
            return Vec::new();
        }
        let d = Duration::from_millis(ms);
        let c = self.chan(key, actual_gain, now);
        if want {
            c.shown_mute = Some(true);
            c.mute_at = Some(now + d);
            c.expect = FLOOR;
            c.settle = now + d;
            return vec![fade_line(key, FLOOR, ms)];
        }
        let e = c.eff();
        c.shown_mute = Some(false);
        c.expect = e;
        c.settle = now + d;
        if c.mute_at.take().is_some() {
            // Still fading out, not muted yet: just turn around.
            return vec![fade_line(key, e, ms)];
        }
        vec![
            set_line(key, "Gain", FLOOR),
            format!("{key}.Mute = 0;"),
            fade_line(key, e, ms),
        ]
    }

    /// Lower the target channels by `amount` dB.
    pub fn duck(
        &mut self,
        targets: &[(String, f32)],
        amount: f32,
        ms: u64,
        now: Instant,
    ) -> Vec<String> {
        self.ducked = true;
        let d = Duration::from_millis(ms);
        let mut lines = Vec::new();
        for (key, actual) in targets {
            let c = self.chan(key, *actual, now);
            c.duck = -amount.abs();
            if c.mute_at.is_none() {
                let e = c.eff();
                c.expect = e;
                c.settle = now + d;
                lines.push(fade_line(key, e, ms));
            }
        }
        lines
    }

    /// Bring ducked channels back to their own level.
    pub fn unduck(&mut self, ms: u64, now: Instant) -> Vec<String> {
        self.ducked = false;
        let d = Duration::from_millis(ms);
        let mut lines = Vec::new();
        for (key, c) in self.chans.iter_mut() {
            if c.duck == 0.0 {
                continue;
            }
            c.duck = 0.0;
            if c.mute_at.is_none() {
                let e = c.eff();
                c.expect = e;
                c.settle = now + d;
                lines.push(fade_line(key, e, ms));
            }
        }
        lines
    }

    /// Talk-over detection. Some(true) = start ducking, Some(false) = stop.
    pub fn sense(
        &mut self,
        level_db: f32,
        threshold: f32,
        hold_ms: u64,
        now: Instant,
    ) -> Option<bool> {
        if let Some(t) = self.hold_off {
            if now < t {
                return None;
            }
            self.hold_off = None;
        }
        if level_db >= threshold {
            self.loud_at = Some(now);
            return (!self.ducked).then_some(true);
        }
        let quiet_long_enough = self
            .loud_at
            .map(|t| now.duration_since(t) >= Duration::from_millis(hold_ms))
            .unwrap_or(true);
        (self.ducked && quiet_long_enough).then_some(false)
    }

    /// Timed work: press mute when a mute fade ends, forget channels that are back to normal.
    pub fn tick(&mut self, now: Instant) -> Vec<String> {
        let mut lines = Vec::new();
        for (key, c) in self.chans.iter_mut() {
            if c.mute_at.map(|t| now >= t).unwrap_or(false) {
                c.mute_at = None;
                let e = c.eff();
                // Muted first, then the level goes back where it was (silently).
                lines.push(format!("{key}.Mute = 1;"));
                lines.push(set_line(key, "Gain", e));
                c.expect = e;
                c.settle = now + Duration::from_millis(150);
            }
            if c.shown_mute.is_some() && c.mute_at.is_none() && now >= c.settle {
                c.shown_mute = None;
            }
        }
        self.chans.retain(|_, c| {
            c.duck != 0.0 || c.mute_at.is_some() || c.shown_mute.is_some() || now < c.settle
        });
        self.aims.retain(|_, (_, until)| now < *until);
        lines
    }

    /// Someone else moved a managed channel (Voicemeeter's window, a MIDI controller, a scene):
    /// their level wins, so stop managing it. Returns true when that happened.
    pub fn reconcile(&mut self, key: &str, actual: f32, now: Instant) -> bool {
        let moved = match self.chans.get(key) {
            Some(c) => {
                c.mute_at.is_none()
                    && now >= c.settle + Duration::from_millis(250)
                    && (actual - c.expect).abs() > 0.3
            }
            None => false,
        };
        if moved {
            self.chans.remove(key);
        }
        moved
    }

    pub fn view(&self, key: &str) -> Option<View> {
        self.chans.get(key).map(|c| View {
            gain: c.base,
            mute: c.shown_mute,
            ducked: c.duck != 0.0,
        })
    }

    pub fn is_managed(&self, key: &str) -> bool {
        self.chans.contains_key(key)
    }

    /// Forget everything (a scene is replacing all levels). Ducking pauses for `hold`.
    pub fn forget(&mut self, now: Instant, hold: Duration) {
        self.chans.clear();
        self.aims.clear();
        self.ducked = false;
        self.loud_at = None;
        self.hold_off = Some(now + hold);
    }

    /// Put every managed channel straight back (Sleekmeeter is quitting or Voicemeeter went away).
    pub fn release_all(&mut self) -> Vec<String> {
        let mut lines = Vec::new();
        for (key, c) in self.chans.iter() {
            if c.mute_at.is_some() {
                lines.push(format!("{key}.Mute = 1;"));
            }
            if c.duck != 0.0 || c.mute_at.is_some() {
                lines.push(set_line(key, "Gain", c.base));
            }
        }
        self.chans.clear();
        self.aims.clear();
        self.ducked = false;
        self.loud_at = None;
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn fade_line_format() {
        assert_eq!(
            fade_line("Strip[3]", -12.0, 300),
            "Strip[3].FadeTo = (-12.0, 300);"
        );
        assert_eq!(
            fade_line("Bus[0]", -80.0, 10),
            "Bus[0].FadeTo = (-60.0, 10);"
        );
    }

    #[test]
    fn plain_glide_is_not_managed_but_repeats_add_up() {
        let t = Instant::now();
        let mut s = Smooth::new();
        let l = s.glide("Bus[0]", -8.0, 120, t);
        assert_eq!(l, vec!["Bus[0].FadeTo = (-8.0, 120);"]);
        assert!(!s.is_managed("Bus[0]"));
        // a second press 50 ms later starts from -8, not from where the fade has got to
        assert_eq!(s.current("Bus[0]", -9.3, t + ms(50)), -8.0);
        // long after, the real level counts again
        assert_eq!(s.current("Bus[0]", -9.3, t + ms(1000)), -9.3);
        assert_eq!(s.set_direct("Bus[0]", -3.0, t), None);
    }

    #[test]
    fn mute_fades_out_then_mutes_and_restores_level() {
        let t = Instant::now();
        let mut s = Smooth::new();
        let l = s.mute("Strip[0]", -4.0, false, true, 250, t);
        assert_eq!(l, vec!["Strip[0].FadeTo = (-60.0, 250);"]);
        // shows muted at once, at its own level
        assert_eq!(
            s.view("Strip[0]"),
            Some(View {
                gain: -4.0,
                mute: Some(true),
                ducked: false
            })
        );
        assert!(s.tick(t + ms(100)).is_empty());
        let l = s.tick(t + ms(260));
        assert_eq!(l, vec!["Strip[0].Mute = 1;", "Strip[0].Gain = -4.00;"]);
        // the real level is back at -4 while muted: no external change
        assert!(!s.reconcile("Strip[0]", -4.0, t + ms(700)));
        s.tick(t + ms(800));
        assert!(!s.is_managed("Strip[0]"));
    }

    #[test]
    fn unmute_starts_silent_and_fades_in() {
        let t = Instant::now();
        let mut s = Smooth::new();
        let l = s.mute("Strip[1]", -6.0, true, false, 200, t);
        assert_eq!(
            l,
            vec![
                "Strip[1].Gain = -60.00;",
                "Strip[1].Mute = 0;",
                "Strip[1].FadeTo = (-6.0, 200);"
            ]
        );
        assert_eq!(s.view("Strip[1]").unwrap().mute, Some(false));
        s.tick(t + ms(250));
        assert!(!s.is_managed("Strip[1]"));
    }

    #[test]
    fn unmute_during_mute_fade_turns_around() {
        let t = Instant::now();
        let mut s = Smooth::new();
        s.mute("Strip[0]", -4.0, false, true, 300, t);
        let l = s.mute("Strip[0]", -30.0, false, false, 300, t + ms(100));
        assert_eq!(l, vec!["Strip[0].FadeTo = (-4.0, 300);"]);
        // never presses mute
        assert!(s.tick(t + ms(350)).is_empty());
        // asking twice does nothing
        assert!(s
            .mute("Strip[0]", -4.0, false, false, 300, t + ms(360))
            .is_empty());
    }

    #[test]
    fn ducking_lowers_and_restores_and_shows_own_level() {
        let t = Instant::now();
        let mut s = Smooth::new();
        assert_eq!(s.sense(-50.0, -40.0, 600, t), None);
        assert_eq!(s.sense(-30.0, -40.0, 600, t), Some(true));
        let l = s.duck(
            &[("Strip[3]".into(), -4.0), ("Strip[4]".into(), -55.0)],
            12.0,
            150,
            t,
        );
        assert_eq!(
            l,
            vec![
                "Strip[3].FadeTo = (-16.0, 150);",
                "Strip[4].FadeTo = (-60.0, 150);"
            ]
        );
        assert_eq!(
            s.view("Strip[3]"),
            Some(View {
                gain: -4.0,
                mute: None,
                ducked: true
            })
        );
        // still loud: nothing new
        assert_eq!(s.sense(-20.0, -40.0, 600, t + ms(100)), None);
        // quiet, but not for long enough
        assert_eq!(s.sense(-70.0, -40.0, 600, t + ms(400)), None);
        assert_eq!(s.sense(-70.0, -40.0, 600, t + ms(800)), Some(false));
        let l = s.unduck(800, t + ms(800));
        assert_eq!(
            l,
            vec![
                "Strip[3].FadeTo = (-4.0, 800);",
                "Strip[4].FadeTo = (-55.0, 800);"
            ]
        );
        s.tick(t + ms(1700));
        assert!(!s.is_managed("Strip[3]"));
    }

    #[test]
    fn dragging_a_ducked_fader_moves_its_own_level() {
        let t = Instant::now();
        let mut s = Smooth::new();
        s.duck(&[("Strip[3]".into(), -4.0)], 10.0, 100, t);
        let l = s.set_direct("Strip[3]", -2.0, t + ms(500)).unwrap();
        assert_eq!(l, vec!["Strip[3].Gain = -12.00;"]);
        assert_eq!(s.view("Strip[3]").unwrap().gain, -2.0);
        let l = s.unduck(300, t + ms(900));
        assert_eq!(l, vec!["Strip[3].FadeTo = (-2.0, 300);"]);
    }

    #[test]
    fn someone_else_moving_a_ducked_channel_wins() {
        let t = Instant::now();
        let mut s = Smooth::new();
        s.duck(&[("Strip[3]".into(), -4.0)], 10.0, 100, t);
        // mid-fade values are expected
        assert!(!s.reconcile("Strip[3]", -9.0, t + ms(50)));
        // settled where we sent it
        assert!(!s.reconcile("Strip[3]", -14.0, t + ms(600)));
        // moved in Voicemeeter's own window
        assert!(s.reconcile("Strip[3]", 0.0, t + ms(700)));
        assert!(!s.is_managed("Strip[3]"));
        // and ducking ending doesn't drag it back
        assert!(s.unduck(300, t + ms(900)).is_empty());
    }

    #[test]
    fn mute_while_ducked_comes_back_ducked() {
        let t = Instant::now();
        let mut s = Smooth::new();
        s.duck(&[("Strip[3]".into(), -4.0)], 10.0, 100, t);
        s.mute("Strip[3]", -14.0, false, true, 200, t + ms(200));
        let l = s.tick(t + ms(450));
        assert_eq!(l, vec!["Strip[3].Mute = 1;", "Strip[3].Gain = -14.00;"]);
        s.tick(t + ms(700));
        let l = s.mute("Strip[3]", -14.0, true, false, 200, t + ms(800));
        assert_eq!(l.last().unwrap(), "Strip[3].FadeTo = (-14.0, 200);");
    }

    #[test]
    fn scene_load_pauses_ducking() {
        let t = Instant::now();
        let mut s = Smooth::new();
        s.duck(&[("Strip[3]".into(), -4.0)], 10.0, 100, t);
        s.forget(t, ms(2000));
        assert!(!s.ducked);
        assert_eq!(s.sense(-10.0, -40.0, 600, t + ms(1000)), None);
        assert_eq!(s.sense(-10.0, -40.0, 600, t + ms(2100)), Some(true));
    }

    #[test]
    fn release_all_restores_levels_at_once() {
        let t = Instant::now();
        let mut s = Smooth::new();
        s.duck(&[("Strip[3]".into(), -4.0)], 10.0, 100, t);
        s.mute("Bus[0]", -2.0, false, true, 300, t);
        let l = s.release_all();
        assert_eq!(
            l,
            vec![
                "Bus[0].Mute = 1;",
                "Bus[0].Gain = -2.00;",
                "Strip[3].Gain = -4.00;"
            ]
        );
        assert!(!s.is_managed("Strip[3]"));
    }
}
