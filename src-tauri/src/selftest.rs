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

#[cfg(windows)]
mod imp {
    use rodio::buffer::SamplesBuffer;
    use rodio::cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use rodio::cpal::SampleFormat;
    use rodio::{OutputStream, Sink};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    pub fn inputs() -> Vec<String> {
        rodio::cpal::default_host()
            .input_devices()
            .map(|l| {
                l.filter_map(|d| d.name().ok())
                    .filter(|n| n.to_lowercase().contains("voicemeeter out"))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn run(input: &str, output: &str, secs: u64) -> Result<(), String> {
        let host = rodio::cpal::default_host();
        let dev = host
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().ok().as_deref() == Some(input))
            .ok_or_else(|| format!("Couldn't find the input {input:?}"))?;
        let cfg = dev.default_input_config().map_err(|e| e.to_string())?;
        let (rate, channels) = (cfg.sample_rate().0, cfg.channels());
        let data: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let err = |e: rodio::cpal::StreamError| log_warn!("Hear-yourself test: {e}");
        let sink = data.clone();
        let stream = match cfg.sample_format() {
            SampleFormat::F32 => dev.build_input_stream(
                &cfg.clone().into(),
                move |d: &[f32], _| sink.lock().unwrap().extend_from_slice(d),
                err,
                None,
            ),
            SampleFormat::I16 => dev.build_input_stream(
                &cfg.clone().into(),
                move |d: &[i16], _| {
                    sink.lock()
                        .unwrap()
                        .extend(d.iter().map(|s| *s as f32 / 32768.0))
                },
                err,
                None,
            ),
            SampleFormat::U16 => dev.build_input_stream(
                &cfg.clone().into(),
                move |d: &[u16], _| {
                    sink.lock()
                        .unwrap()
                        .extend(d.iter().map(|s| (*s as f32 - 32768.0) / 32768.0))
                },
                err,
                None,
            ),
            other => return Err(format!("Unsupported audio format {other:?}")),
        }
        .map_err(|e| format!("Couldn't listen to {input}: {e}"))?;
        stream.play().map_err(|e| e.to_string())?;
        std::thread::sleep(Duration::from_secs(secs));
        drop(stream);
        let samples = std::mem::take(&mut *data.lock().unwrap());
        if samples.is_empty() {
            return Err("Nothing was recorded. Is Voicemeeter running?".into());
        }
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
}
