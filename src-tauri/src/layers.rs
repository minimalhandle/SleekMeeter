//! Potato's gain layers: each input has its own level for each of the 8 outputs (A1–A5, B1–B3),
//! so a streamer can, for example, send less game to the stream than to their headphones.
//!
//! Voicemeeter's catch: with no output selected, setting an input's main level (`Gain`, or a
//! `FadeTo`) sets all 8 layers to that value, which wipes those differences. Sleekmeeter moves
//! levels a lot (fades, mute fades, ducking, scenes, Be right back), so on Potato, while an
//! input's layers differ, its level changes move every layer by the same amount instead and
//! keep the differences. Sleekmeeter remembers the main level itself, because Voicemeeter's
//! `Gain` is no longer written.

pub const LAYERS: usize = 8;
const FLOOR: f32 = -60.0;
const CEIL: f32 = 12.0;
const SAME: f32 = 0.05;

/// One input whose layers differ: its main level and each layer's difference from it.
#[derive(Clone, Debug, PartialEq)]
pub struct Strip {
    pub main: f32,
    offsets: [f32; LAYERS],
    /// Voicemeeter's `Gain` when this started. If it changes, someone moved the main level in
    /// Voicemeeter itself, which set every layer, so this is stale.
    gain_seen: f32,
}

impl Strip {
    /// The state for layers just set to `layers` with `main` as the main level, while
    /// Voicemeeter's own Gain reads `gain`.
    pub fn adopt(main: f32, layers: &[f32; LAYERS], gain: f32) -> Strip {
        Strip {
            main,
            offsets: layers.map(|v| v - main),
            gain_seen: gain,
        }
    }

    /// The main level to show, while Voicemeeter's Gain is still the one this started from.
    pub fn shown(&self, gain: f32) -> Option<f32> {
        ((gain - self.gain_seen).abs() < SAME).then_some(self.main)
    }
}

fn clamp(v: f32) -> f32 {
    v.clamp(FLOOR, CEIL)
}

/// Where each layer should go when the main level moves to `target`, or None when the layers
/// are all the same (then the normal main-level write is fine).
/// `trusted`: this input was already changed earlier in the same batch, so the live values
/// are from before that change and must not be read as edits.
pub fn plan(
    state: Option<&Strip>,
    gain: f32,
    live: &[f32; LAYERS],
    target: f32,
    trusted: bool,
) -> Option<(Strip, [f32; LAYERS])> {
    let mut s = match state {
        Some(s) if trusted || (gain - s.gain_seen).abs() < SAME => s.clone(),
        _ => {
            let (lo, hi) = live
                .iter()
                .fold((f32::MAX, f32::MIN), |(a, b), &v| (a.min(v), b.max(v)));
            if hi - lo < SAME {
                return None;
            }
            Strip {
                main: gain,
                offsets: live.map(|v| v - gain),
                gain_seen: gain,
            }
        }
    };
    if !trusted {
        // A layer changed since Sleekmeeter last set it (in Voicemeeter, or with a layer
        // slider): that's the new difference. A layer held at the floor or ceiling keeps the
        // difference it had, so muting and unmuting doesn't flatten the mix.
        for (j, v) in live.iter().enumerate() {
            if (v - clamp(s.offsets[j] + s.main)).abs() >= SAME {
                s.offsets[j] = v - s.main;
            }
        }
    }
    s.main = target;
    let to = s.offsets.map(|o| clamp(o + target));
    Some((s, to))
}

/// "Strip[3].Gain = -4.00;" → (3, -4.0, None); "Strip[3].FadeTo = (-4.0, 300);" →
/// (3, -4.0, Some(300)). Anything else is None.
pub fn parse(line: &str) -> Option<(usize, f32, Option<u64>)> {
    let rest = line.trim().strip_prefix("Strip[")?;
    let close = rest.find(']')?;
    let i: usize = rest[..close].parse().ok()?;
    let rest = rest[close + 1..].trim_start();
    let value = |s: &str| s.trim().trim_end_matches(';').trim().to_string();
    if let Some(v) = rest.strip_prefix(".Gain") {
        let v = value(v.trim_start().strip_prefix('=')?);
        return Some((i, v.parse().ok()?, None));
    }
    if let Some(v) = rest.strip_prefix(".FadeTo") {
        let v = value(v.trim_start().strip_prefix('=')?);
        let inner = v.strip_prefix('(')?.strip_suffix(')')?;
        let (db, ms) = inner.split_once(',')?;
        return Some((i, db.trim().parse().ok()?, Some(ms.trim().parse().ok()?)));
    }
    None
}

/// The lines that set each layer instead of the main level.
pub fn lines(i: usize, to: &[f32; LAYERS], fade: Option<u64>) -> Vec<String> {
    to.iter()
        .enumerate()
        .map(|(j, v)| match fade {
            Some(ms) => format!("Strip[{i}].GainLayer[{j}].FadeTo = ({v:.1}, {ms});"),
            None => format!("Strip[{i}].GainLayer[{j}] = {v:.2};"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIX: [f32; LAYERS] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -6.0];

    #[test]
    fn same_layers_use_the_normal_write() {
        assert!(plan(None, 0.0, &[0.0; LAYERS], -3.0, false).is_none());
    }

    #[test]
    fn moving_the_level_keeps_each_outputs_difference() {
        let (s, to) = plan(None, 0.0, &MIX, -3.0, false).unwrap();
        assert_eq!(to, [-3.0, -3.0, -3.0, -3.0, -3.0, -3.0, -3.0, -9.0]);
        assert_eq!(s.main, -3.0);
    }

    #[test]
    fn a_mute_fade_to_the_floor_and_back_keeps_the_mix() {
        let (s, down) = plan(None, 0.0, &MIX, -60.0, false).unwrap();
        assert!(down.iter().all(|&v| v == -60.0));
        // Voicemeeter now reports every layer at the floor; the mix comes back intact.
        let (_, up) = plan(Some(&s), 0.0, &down, 0.0, false).unwrap();
        assert_eq!(up, MIX);
    }

    #[test]
    fn a_layer_moved_elsewhere_becomes_the_new_difference() {
        let (s, _) = plan(None, 0.0, &MIX, 0.0, false).unwrap();
        let mut live = MIX;
        live[0] = -2.0; // A1 turned down with a layer slider
        let (_, to) = plan(Some(&s), 0.0, &live, -1.0, false).unwrap();
        assert_eq!(to[0], -3.0);
        assert_eq!(to[7], -7.0);
    }

    #[test]
    fn moving_the_main_level_in_voicemeeter_starts_over() {
        let (s, _) = plan(None, 0.0, &MIX, -3.0, false).unwrap();
        // Voicemeeter's own fader set Gain (and every layer) to -5.
        assert!(plan(Some(&s), -5.0, &[-5.0; LAYERS], -4.0, false).is_none());
    }

    #[test]
    fn several_changes_in_one_batch_build_on_each_other() {
        let (s, _) = plan(None, 0.0, &MIX, -60.0, false).unwrap();
        // Same batch: the live values are still from before the first change.
        let (_, to) = plan(Some(&s), 0.0, &MIX, -6.0, true).unwrap();
        assert_eq!(to[0], -6.0);
        assert_eq!(to[7], -12.0);
    }

    #[test]
    fn reads_the_lines_sleekmeeter_writes() {
        assert_eq!(parse("Strip[3].Gain = -4.00;"), Some((3, -4.0, None)));
        assert_eq!(
            parse("Strip[0].FadeTo = (-60.0, 250);"),
            Some((0, -60.0, Some(250)))
        );
        assert_eq!(parse("Bus[0].Gain = -4.00;"), None);
        assert_eq!(parse("Strip[3].Mute = 1;"), None);
        assert_eq!(
            lines(2, &[0.0; LAYERS], Some(100))[7],
            "Strip[2].GainLayer[7].FadeTo = (0.0, 100);"
        );
    }
}
