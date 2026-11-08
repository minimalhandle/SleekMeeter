//! Hear-yourself test: records a few seconds of one of Voicemeeter's virtual outputs (the mix
//! your stream or friends get) and plays it back on your headphones, so you can hear what they hear.

use serde_json::{json, Value};

/// Voicemeeter's virtual outputs as Windows lists them ("Voicemeeter Out B1" and so on).
pub fn inputs() -> Value {
    #[cfg(windows)]
    {
        json!({ "devices": imp::inputs() })
    }
    #[cfg(not(windows))]
    {
        json!({ "devices": [] })
    }
}

/// Record `secs` seconds from the input device named `input`, then play it on `output`
/// (empty = the Windows default). Blocks until the playback has finished.
pub fn run(input: &str, output: &str, secs: u64) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::run(input, output, secs.clamp(2, 15))
    }
    #[cfg(not(windows))]
    {
        let _ = (input, output, secs);
        Err("Only available on Windows".into())
    }
}

pub fn guided(source: &str, stream: &str, monitor: &str, kind: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        imp::guided(source, stream, monitor, kind)
    }
    #[cfg(not(windows))]
    {
        let _ = (source, stream, monitor, kind);
        Err("Only available on Windows".into())
    }
}

pub fn play_mic(output: &str, channels: u16, rate: u32, samples: Vec<f32>) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::monitor(output, channels, rate, samples)
    }
    #[cfg(not(windows))]
    {
        let _ = (output, channels, rate, samples);
        Err("Only available on Windows".into())
    }
}

pub fn live_start(
    app: tauri::AppHandle,
    owner: String,
    input: String,
    output: String,
    cue: Option<bool>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::live_start(app, owner, input, output, cue)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, owner, input, output, cue);
        Err("Only available on Windows".into())
    }
}

pub fn live_stop(owner: Option<&str>) {
    #[cfg(windows)]
    imp::live_stop(owner);
    #[cfg(not(windows))]
    let _ = owner;
}

#[cfg(windows)]
mod imp {
    use rodio::buffer::SamplesBuffer;
    use rodio::cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use rodio::cpal::SampleFormat;
    use rodio::{OutputStream, Sink};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;
    use tauri::Emitter;

    pub fn inputs() -> Vec<String> {
        rodio::cpal::default_host()
            .input_devices()
            .map(|l| {
                l.filter_map(|d| d.name().ok())
                    .filter(|n| {
                        let n = n.to_lowercase();
                        ["voicemeeter out", "voicemeeter aux output", "vaio3 output"]
                            .iter()
                            .any(|key| n.contains(key))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn capture(
        input: &str,
        during: impl FnOnce() -> Result<(), String>,
    ) -> Result<(u16, u32, Vec<f32>), String> {
        let data = Arc::new(Mutex::new(Vec::new()));
        let sink = data.clone();
        let (stream, channels, rate) = listen(
            input,
            false,
            move |d| sink.lock().unwrap().extend_from_slice(d),
            |e| log_warn!("Hear-yourself test: {e}"),
        )?;
        during()?;
        drop(stream);
        let samples = std::mem::take(&mut *data.lock().unwrap());
        if samples.is_empty() {
            return Err("Nothing was recorded. Is Voicemeeter running?".into());
        }
        Ok((channels, rate, samples))
    }

    fn listen(
        input: &str,
        loopback: bool,
        mut push: impl FnMut(&[f32]) + Send + 'static,
        err: impl FnMut(rodio::cpal::StreamError) + Send + 'static,
    ) -> Result<(rodio::cpal::Stream, u16, u32), String> {
        let host = rodio::cpal::default_host();
        let dev = if loopback {
            output_device(input)?
        } else {
            host.input_devices()
                .map_err(|e| e.to_string())?
                .find(|d| d.name().ok().as_deref() == Some(input))
                .ok_or_else(|| format!("Couldn't find the input {input:?}"))?
        };
        // CPAL's WASAPI backend opens render endpoints as loopback capture when building an input stream.
        let cfg = if loopback {
            dev.default_output_config()
        } else {
            dev.default_input_config()
        }
        .map_err(|e| e.to_string())?;
        let (rate, channels) = (cfg.sample_rate().0, cfg.channels());
        let mut converted = Vec::new();
        let stream = match cfg.sample_format() {
            SampleFormat::F32 => {
                dev.build_input_stream(&cfg.clone().into(), move |d: &[f32], _| push(d), err, None)
            }
            SampleFormat::I16 => dev.build_input_stream(
                &cfg.clone().into(),
                move |d: &[i16], _| {
                    converted.clear();
                    converted.extend(d.iter().map(|s| *s as f32 / 32768.0));
                    push(&converted);
                },
                err,
                None,
            ),
            SampleFormat::U16 => dev.build_input_stream(
                &cfg.clone().into(),
                move |d: &[u16], _| {
                    converted.clear();
                    converted.extend(d.iter().map(|s| (*s as f32 - 32768.0) / 32768.0));
                    push(&converted);
                },
                err,
                None,
            ),
            other => return Err(format!("Unsupported audio format {other:?}")),
        }
        .map_err(|e| format!("Couldn't listen to {input}: {e}"))?;
        stream.play().map_err(|e| e.to_string())?;
        Ok((stream, channels, rate))
    }

    struct LiveSource {
        blocks: mpsc::Receiver<Vec<f32>>,
        block: std::vec::IntoIter<f32>,
        channels: u16,
        rate: u32,
        silence_left: u16,
    }
    impl Iterator for LiveSource {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            if let Some(sample) = self.block.next() {
                return Some(sample);
            }
            if self.silence_left > 0 {
                self.silence_left -= 1;
                return Some(0.0);
            }
            self.block = self.blocks.try_recv().unwrap_or_default().into_iter();
            Some(self.block.next().unwrap_or_else(|| {
                self.silence_left = self.channels.saturating_sub(1);
                0.0
            }))
        }
    }
    impl rodio::Source for LiveSource {
        fn current_frame_len(&self) -> Option<usize> {
            None
        }
        fn channels(&self) -> u16 {
            self.channels
        }
        fn sample_rate(&self) -> u32 {
            self.rate
        }
        fn total_duration(&self) -> Option<Duration> {
            None
        }
    }
    struct LiveMonitor {
        owner: String,
        stop: mpsc::Sender<()>,
        thread: std::thread::JoinHandle<()>,
    }
    static LIVE: Mutex<Option<LiveMonitor>> = Mutex::new(None);
    fn stop_session(live: &mut Option<LiveMonitor>) {
        if let Some(LiveMonitor { stop, thread, .. }) = live.take() {
            let _ = stop.send(());
            let _ = thread.join();
        }
    }
    pub fn live_stop(owner: Option<&str>) {
        let mut live = LIVE.lock().unwrap();
        if owner.is_none()
            || live
                .as_ref()
                .is_some_and(|m| Some(m.owner.as_str()) == owner)
        {
            stop_session(&mut live);
        }
    }
    pub fn live_start(
        app: tauri::AppHandle,
        owner: String,
        input: String,
        output: String,
        cue: Option<bool>,
    ) -> Result<(), String> {
        let mut live = LIVE.lock().unwrap();
        if let Some(previous) = live.as_ref().filter(|m| m.owner != owner) {
            let _ = app.emit_to(
                previous.owner.as_str(),
                "mix-monitor-ended",
                "Monitoring moved to another mixer window.",
            );
        }
        stop_session(&mut live);
        let (stop, stopped) = mpsc::channel();
        let (ready, status) = mpsc::sync_channel(1);
        let event_owner = owner.clone();
        let thread = std::thread::spawn(move || {
            let lost = Arc::new(AtomicBool::new(false));
            let open = || -> Result<_, String> {
                if cue.is_none() && !inputs().iter().any(|name| name == &input) {
                    return Err("Choose an available Voicemeeter virtual output.".into());
                }
                if cue == Some(true) && input.eq_ignore_ascii_case(&output) {
                    return Err(
                        "Choose a different device for cue playback to avoid a loop.".into(),
                    );
                }
                let device = monitor_device(&output)?;
                let (playback, handle) =
                    OutputStream::try_from_device(&device).map_err(|e| e.to_string())?;
                let sink = Sink::try_new(&handle).map_err(|e| e.to_string())?;
                let (send, blocks) = mpsc::sync_channel(3);
                let on_error = lost.clone();
                let (capture, channels, rate) = listen(
                    &input,
                    cue.unwrap_or(false),
                    move |d| {
                        let _ = send.try_send(d.to_vec());
                    },
                    move |_| {
                        on_error.store(true, Ordering::Relaxed);
                    },
                )?;
                sink.set_volume(0.5);
                sink.append(LiveSource {
                    blocks,
                    block: Vec::new().into_iter(),
                    channels,
                    rate,
                    silence_left: 0,
                });
                Ok((playback, capture, sink))
            };
            match open() {
                Ok((_playback, _capture, sink)) => {
                    let _ = ready.send(Ok(()));
                    while matches!(
                        stopped.recv_timeout(Duration::from_millis(500)),
                        Err(mpsc::RecvTimeoutError::Timeout)
                    ) {
                        if lost.load(Ordering::Relaxed) || output_device(&output).is_err() {
                            let _ = app.emit_to(
                                event_owner.as_str(),
                                "mix-monitor-ended",
                                "An audio device disconnected.",
                            );
                            break;
                        }
                    }
                    sink.stop();
                }
                Err(err) => {
                    let _ = ready.send(Err(err));
                }
            }
        });
        *live = Some(LiveMonitor {
            owner,
            stop,
            thread,
        });
        let result = status
            .recv()
            .unwrap_or_else(|_| Err("Mix monitoring could not start.".into()));
        if result.is_err() {
            stop_session(&mut live);
        }
        result
    }

    pub fn run(input: &str, output: &str, secs: u64) -> Result<(), String> {
        let (channels, rate, samples) = capture(input, || {
            std::thread::sleep(Duration::from_secs(secs));
            Ok(())
        })?;
        let host = rodio::cpal::default_host();
        // Playing back on the headphones: never into a Voicemeeter input, which would loop.
        let out_dev = if output.is_empty() {
            None
        } else {
            host.output_devices()
                .ok()
                .and_then(|mut l| l.find(|d| d.name().ok().as_deref() == Some(output)))
        };
        let (_keep, handle) = match out_dev {
            Some(d) => OutputStream::try_from_device(&d),
            None => OutputStream::try_default(),
        }
        .map_err(|e| e.to_string())?;
        let sink = Sink::try_new(&handle).map_err(|e| e.to_string())?;
        sink.append(SamplesBuffer::new(channels, rate, samples));
        sink.sleep_until_end();
        Ok(())
    }

    fn output_device(name: &str) -> Result<rodio::cpal::Device, String> {
        if name.is_empty() {
            return Err("Choose a playback device first.".into());
        }
        let mut matches = rodio::cpal::default_host()
            .output_devices()
            .map_err(|e| e.to_string())?
            .filter(|d| d.name().ok().as_deref() == Some(name));
        let device = matches
            .next()
            .ok_or_else(|| format!("Playback device {name:?} is unavailable."))?;
        if matches.next().is_some() {
            return Err(format!("More than one playback device is named {name:?}."));
        }
        Ok(device)
    }

    fn monitor_device(name: &str) -> Result<rodio::cpal::Device, String> {
        let lower = name.to_ascii_lowercase();
        if [
            "voicemeeter",
            "vb-audio",
            "virtual cable",
            "cable input",
            "cable-a",
            "cable-b",
            "cable-c",
            "cable-d",
        ]
        .iter()
        .any(|word| lower.contains(word))
        {
            return Err("Choose physical headphones or speakers to avoid sending playback back into the mixer.".into());
        }
        output_device(name)
    }

    fn play(
        device: &rodio::cpal::Device,
        channels: u16,
        rate: u32,
        samples: Vec<f32>,
    ) -> Result<(), String> {
        let (_stream, handle) = OutputStream::try_from_device(device).map_err(|e| e.to_string())?;
        let sink = Sink::try_new(&handle).map_err(|e| e.to_string())?;
        sink.append(SamplesBuffer::new(channels, rate, samples));
        sink.sleep_until_end();
        Ok(())
    }

    pub fn monitor(
        output: &str,
        channels: u16,
        rate: u32,
        samples: Vec<f32>,
    ) -> Result<(), String> {
        play(&monitor_device(output)?, channels, rate, samples)
    }

    pub fn guided(source: &str, stream: &str, monitor: &str, kind: &str) -> Result<String, String> {
        let (count, pitch) = match kind {
            "game" => (2, 440.0),
            "chat" => (3, 660.0),
            "stream" => (4, 520.0),
            _ => return Err("Unknown audio test.".into()),
        };
        let device = output_device(source)?;
        let rate = 48_000;
        let samples = (0..count * rate / 4)
            .map(|i| {
                let phase = (i % (rate / 4)) as f32 / rate as f32;
                let envelope = (phase / 0.012).min(1.0) * ((0.16 - phase) / 0.020).clamp(0.0, 1.0);
                0.08 * envelope * (i as f32 / rate as f32 * pitch * std::f32::consts::TAU).sin()
            })
            .collect();
        if kind != "stream" {
            play(&device, 1, rate, samples)?;
            return Ok(format!("Played {count} test tones through {source}."));
        }
        if !inputs().iter().any(|name| name == stream) {
            return Err("Choose an available Voicemeeter stream recording endpoint.".into());
        }
        let monitor = monitor_device(monitor)?;
        let (channels, rate, captured) = capture(stream, || {
            std::thread::sleep(Duration::from_millis(180));
            play(&device, 1, rate, samples)?;
            std::thread::sleep(Duration::from_millis(300));
            Ok(())
        })?;
        let peak = captured.iter().map(|s| s.abs()).fold(0.0_f32, f32::max);
        play(&monitor, channels, rate, captured)?;
        Ok(if peak < 0.0001 {
            "Stream capture was silent. Check the input route, faders and mutes.".into()
        } else {
            format!("Played back the captured stream output. Listen for {count} test tones.")
        })
    }
}
