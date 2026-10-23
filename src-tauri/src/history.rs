//! Level history: how loud each channel was over the last few hours, one reading a second.
//! Kept in memory only (it starts fresh each time Sleekmeeter starts).

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Three hours of one-second readings.
const KEEP: usize = 3 * 60 * 60;
/// Below this a channel counts as silent.
const QUIET_DB: f32 = -60.0;
/// At or above this a channel is clipping.
const CLIP_DB: f32 = 0.0;

struct Sample {
    t: u64,
    /// Peak level in dB for each input strip, then each output bus.
    db: Vec<f32>,
}

struct Store {
    samples: VecDeque<Sample>,
    inputs: usize,
}

static STORE: Mutex<Store> = Mutex::new(Store {
    samples: VecDeque::new(),
    inputs: 0,
});

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Collects the poller's meter readings and stores the loudest of each second.
pub struct Recorder {
    since: Instant,
    peak: Vec<f32>,
    inputs: usize,
}

impl Recorder {
    pub fn new() -> Recorder {
        Recorder {
            since: Instant::now(),
            peak: Vec::new(),
            inputs: 0,
        }
    }

    /// True when it's time for a new reading (so the poller needn't read meters more often).
    pub fn due(&self) -> bool {
        self.since.elapsed() >= Duration::from_secs(1)
    }

    /// Take a reading: `levels` is `{ inputs: [[l, r], ...], outputs: [[l, r], ...] }` in dB.
    pub fn feed(&mut self, levels: &Value) {
        let read = |list: &Value| -> Vec<f32> {
            list.as_array()
                .into_iter()
                .flatten()
                .map(|p| {
                    let l = p[0].as_f64().unwrap_or(-200.0) as f32;
                    let r = p[1].as_f64().unwrap_or(-200.0) as f32;
                    l.max(r)
                })
                .collect()
        };
        let mut all = read(&levels["inputs"]);
        let inputs = all.len();
        all.extend(read(&levels["outputs"]));
        if self.peak.len() != all.len() {
            self.peak = vec![-200.0; all.len()];
        }
        self.inputs = inputs;
        for (p, v) in self.peak.iter_mut().zip(all) {
            if v > *p {
                *p = v;
            }
        }
        if self.due() {
            self.since = Instant::now();
            let db = std::mem::take(&mut self.peak);
            let mut store = STORE.lock().unwrap();
            if store.inputs != inputs {
                store.samples.clear(); // a different Voicemeeter edition: channels no longer match
                store.inputs = inputs;
            }
            if store.samples.len() >= KEEP {
                store.samples.pop_front();
            }
            store.samples.push_back(Sample { t: now_secs(), db });
        }
    }
}

pub fn clear() {
    STORE.lock().unwrap().samples.clear();
}

/// The last `minutes` minutes, thinned to about 360 points per channel (the loudest in each
/// stretch), plus a summary per channel.
pub fn get(minutes: u64) -> Value {
    let minutes = minutes.clamp(1, 180);
    let now = now_secs();
    let from = now.saturating_sub(minutes * 60);
    let store = STORE.lock().unwrap();
    let inputs = store.inputs;
    let channels = store.samples.back().map(|s| s.db.len()).unwrap_or(0);
    let keys: Vec<String> = (0..channels)
        .map(|i| {
            if i < inputs {
                format!("Strip[{i}]")
            } else {
                format!("Bus[{}]", i - inputs)
            }
        })
        .collect();
    let bucket = ((minutes * 60) as f64 / 360.0).ceil().max(1.0) as u64;
    let points = ((minutes * 60) / bucket + 1) as usize;
    let mut series: Vec<Vec<Option<f32>>> = vec![vec![None; points]; channels];
    let (mut peak, mut clip, mut active) = (
        vec![f32::NEG_INFINITY; channels],
        vec![0u64; channels],
        vec![0u64; channels],
    );
    for s in store.samples.iter().filter(|s| s.t >= from) {
        let slot = ((s.t - from) / bucket) as usize;
        for (c, &v) in s.db.iter().enumerate().take(channels) {
            if let Some(cell) = series[c].get_mut(slot) {
                if cell.map(|old| v > old).unwrap_or(true) {
                    *cell = Some(v);
                }
            }
            if v > peak[c] {
                peak[c] = v;
            }
            if v >= CLIP_DB {
                clip[c] += 1;
            }
            if v > QUIET_DB {
                active[c] += 1;
            }
        }
    }
    let stats: Vec<Value> = (0..channels)
        .map(|c| {
            json!({
                "key": keys[c],
                "peak": if peak[c].is_finite() && peak[c] > -150.0 { json!(peak[c]) } else { Value::Null },
                "clipSeconds": clip[c],
                "activeSeconds": active[c],
            })
        })
        .collect();
    json!({
        "from": from, "now": now, "bucket": bucket,
        "keys": keys, "series": series, "stats": stats,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_loudest_reading_of_each_second() {
        let mut r = Recorder::new();
        r.feed(&json!({ "inputs": [[-30.0, -20.0]], "outputs": [[-10.0, -12.0]] }));
        r.feed(&json!({ "inputs": [[-25.0, -40.0]], "outputs": [[-50.0, -60.0]] }));
        assert_eq!(r.peak, vec![-20.0, -10.0]);
        assert_eq!(r.inputs, 1);
    }
}
