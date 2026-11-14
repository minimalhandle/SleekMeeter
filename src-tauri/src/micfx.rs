//! Mic clean-up: NVIDIA's AI (noise, room echo and speaker echo removal) and VST3 plugins on
//! Voicemeeter's hardware inputs, one chain per mic.
//!
//! Sleekmeeter registers for Voicemeeter's audio callback as an input insert, so it sees each
//! hardware input's audio before the fader, gate and compressor, and can replace it. Each chosen
//! input's two channels are mixed to mono, cleaned, and written back to both channels. Every other
//! channel passes straight through. For speaker echo removal it also joins the output insert, to
//! hear what the speakers play (the reference NVIDIA's echo model needs).
//!
//! The NVIDIA runtime is never bundled: people install NVIDIA's "Audio Effects SDK" redistributable
//! themselves (it sets NVAFX_SDK_DIR), and Sleekmeeter loads NVAudioEffects.dll from there only
//! while it's in use. It needs an NVIDIA RTX GPU, and Voicemeeter running at 48 kHz.
//!
//! Voicemeeter's audio thread must never wait, and GPU work can take a few milliseconds, so the
//! callback only moves samples through lock-free queues. A worker thread per mic runs the chain in
//! 10 ms frames: echo removal, NVIDIA's clean-up, then the plugins (in the plugin host process,
//! pluginhost.rs). That costs a little latency (shown in Settings), about 25 ms at a 512 buffer.
//!
//! Shortcuts, the Stream Deck, the phone, Twitch and scenes switch a mic's chain off and on, and
//! scenes can set NVIDIA's strength: that lives in "micFxLive" (Rust-owned, kept by settings_set).

use crate::{show_osd_text, Settings, SettingsDirty, Vm};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// NVIDIA's effects, as Settings offers them: (selector, name shown).
pub const EFFECTS: &[(&str, &str)] = &[
    ("denoiser", "Noise removal"),
    ("dereverb", "Room echo removal"),
    ("dereverb_denoiser", "Noise and room echo removal"),
];

const RATE: u32 = 48_000;
/// Samples per frame NVIDIA's 48 kHz models use (10 ms), unless the effect says otherwise.
const DEFAULT_FRAME: usize = 480;
/// One chain per mic, at most.
const LANES: usize = crate::pluginhost::LANES;

/* ---------- single-producer, single-consumer sample queue ---------- */

/// A fixed-size queue of f32 samples: one thread pushes, one other thread pops. No locks, no
/// allocation after creation, so Voicemeeter's audio thread can use it.
struct Queue {
    buf: Box<[AtomicU32]>,
    mask: usize,
    /// Samples ever written (producer) and read (consumer).
    head: AtomicUsize,
    tail: AtomicUsize,
}

impl Queue {
    fn new(capacity_pow2: usize) -> Queue {
        Queue {
            buf: (0..capacity_pow2).map(|_| AtomicU32::new(0)).collect(),
            mask: capacity_pow2 - 1,
            head: AtomicUsize::new(0),
            tail: AtomicUsize::new(0),
        }
    }
    fn len(&self) -> usize {
        self.head
            .load(Ordering::Acquire)
            .wrapping_sub(self.tail.load(Ordering::Acquire))
    }
    /// Producer: add all of `data`, or nothing if it doesn't fit.
    fn push(&self, data: &[f32]) -> bool {
        let head = self.head.load(Ordering::Relaxed);
        let tail = self.tail.load(Ordering::Acquire);
        if head.wrapping_sub(tail) + data.len() > self.buf.len() {
            return false;
        }
        for (k, v) in data.iter().enumerate() {
            self.buf[(head + k) & self.mask].store(v.to_bits(), Ordering::Relaxed);
        }
        self.head
            .store(head.wrapping_add(data.len()), Ordering::Release);
        true
    }
    /// Consumer: fill all of `out`, or take nothing if there isn't enough.
    fn pop(&self, out: &mut [f32]) -> bool {
        let tail = self.tail.load(Ordering::Relaxed);
        let head = self.head.load(Ordering::Acquire);
        if head.wrapping_sub(tail) < out.len() {
            return false;
        }
        for (k, v) in out.iter_mut().enumerate() {
            *v = f32::from_bits(self.buf[(tail + k) & self.mask].load(Ordering::Relaxed));
        }
        self.tail
            .store(tail.wrapping_add(out.len()), Ordering::Release);
        true
    }
    /// Consumer: throw away everything queued.
    fn clear(&self) {
        self.tail
            .store(self.head.load(Ordering::Acquire), Ordering::Release);
    }
}

/* ---------- state shared with Voicemeeter's audio thread ---------- */

/// One mic's chain, as the audio thread and its worker see it.
struct LaneShared {
    /// Interleaved input audio: audio thread → worker.
    inq: Queue,
    /// Interleaved processed audio: worker → audio thread.
    outq: Queue,
    /// What the speakers play (echo removal): audio thread → worker.
    refq: Queue,
    /// The worker is running. Off: the input passes through untouched.
    active: AtomicBool,
    /// First channel of the input (2 per hardware input), usize::MAX for none.
    channel: AtomicUsize,
    frame: AtomicUsize,
    /// The rate the worker was set up for; audio at another rate passes through.
    worker_rate: AtomicU32,
    stereo: AtomicBool,
    underruns: AtomicU64,
    /// Extra samples held back to absorb the worker's timing; grows after an underrun.
    cushion: AtomicUsize,
    /// Voicemeeter's stream restarted: the worker drops what it had queued.
    flush: AtomicBool,
    reset_output: AtomicBool,
    /// Compare: the raw mic, through the same delay, so the switch is seamless.
    bypass: AtomicBool,
    /// Echo removal is on: the audio thread sends this lane what the speakers play.
    want_ref: AtomicBool,
    /// On an output (Voicemeeter's output insert) rather than an input.
    output: AtomicBool,
    /// Wakes the worker when audio arrives (Windows event handle).
    wake: AtomicUsize,
}

impl LaneShared {
    fn new() -> LaneShared {
        LaneShared {
            inq: Queue::new(1 << 14),
            outq: Queue::new(1 << 14),
            refq: Queue::new(1 << 14),
            active: AtomicBool::new(false),
            channel: AtomicUsize::new(usize::MAX),
            frame: AtomicUsize::new(DEFAULT_FRAME),
            worker_rate: AtomicU32::new(0),
            stereo: AtomicBool::new(false),
            underruns: AtomicU64::new(0),
            cushion: AtomicUsize::new(START_CUSHION),
            flush: AtomicBool::new(false),
            reset_output: AtomicBool::new(false),
            bypass: AtomicBool::new(false),
            want_ref: AtomicBool::new(false),
            output: AtomicBool::new(false),
            wake: AtomicUsize::new(sys::new_event()),
        }
    }
}

struct Shared {
    lanes: Vec<LaneShared>,
    sample_rate: AtomicU32,
    block: AtomicUsize,
    /// Buffers seen, so the manager notices when Voicemeeter stops calling.
    buffers: AtomicU64,
    /// Voicemeeter asked for the callback to be restarted (sample rate or buffer changed).
    restart: AtomicBool,
    /// First output-insert channel of the speakers' bus (8 per bus), usize::MAX for none.
    ref_channel: AtomicUsize,
}

fn shared() -> &'static Shared {
    static S: OnceLock<Shared> = OnceLock::new();
    S.get_or_init(|| Shared {
        lanes: (0..LANES).map(|_| LaneShared::new()).collect(),
        sample_rate: AtomicU32::new(0),
        block: AtomicUsize::new(0),
        buffers: AtomicU64::new(0),
        restart: AtomicBool::new(false),
        ref_channel: AtomicUsize::new(usize::MAX),
    })
}

const START_CUSHION: usize = 288; // 6 ms
const MAX_CUSHION: usize = 960; // 20 ms

/// Owned by the audio thread only (the mutexes are never contended; try_lock keeps it safe).
struct AudioLocal {
    input: Vec<f32>,
    out: Vec<f32>,
    /// Enough cleaned audio was queued to start playing it.
    primed: bool,
}

impl AudioLocal {
    fn new(n: usize) -> AudioLocal {
        AudioLocal {
            input: vec![0.0; n * 2],
            out: vec![0.0; n * 2],
            primed: false,
        }
    }
}

static AUDIO: [Mutex<Option<AudioLocal>>; LANES] = [const { Mutex::new(None) }; LANES];
static REF_SCRATCH: Mutex<Vec<f32>> = Mutex::new(Vec::new());

#[repr(C)]
struct AudioInfo {
    samplerate: i32,
    samples_per_frame: i32,
}

#[repr(C)]
struct AudioBuffer {
    sr: i32,
    nbs: i32,
    nbi: i32,
    nbo: i32,
    r: [*mut f32; 128],
    w: [*mut f32; 128],
}

const CB_STARTING: i32 = 1;
const CB_ENDING: i32 = 2;
const CB_CHANGE: i32 = 3;
const CB_BUFFER_IN: i32 = 10;
const CB_BUFFER_OUT: i32 = 11;

unsafe extern "system" fn audio_callback(
    _user: *mut std::ffi::c_void,
    command: i32,
    data: *mut std::ffi::c_void,
    _nnn: i32,
) -> i32 {
    // A panic must never unwind into Voicemeeter.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        on_audio(command, data)
    }));
    0
}

unsafe fn on_audio(command: i32, data: *mut std::ffi::c_void) {
    let sh = shared();
    match command {
        CB_STARTING if !data.is_null() => {
            let info = unsafe { &*(data as *const AudioInfo) };
            let n = info.samples_per_frame.max(0) as usize;
            sh.sample_rate
                .store(info.samplerate.max(0) as u32, Ordering::Relaxed);
            sh.block.store(n, Ordering::Relaxed);
            for (i, l) in sh.lanes.iter().enumerate() {
                l.outq.clear();
                l.flush.store(true, Ordering::Release);
                if let Ok(mut a) = AUDIO[i].try_lock() {
                    *a = Some(AudioLocal::new(n.max(4096)));
                }
            }
            if let Ok(mut r) = REF_SCRATCH.try_lock() {
                *r = vec![0.0; n.max(4096)];
            }
        }
        CB_ENDING => sh.sample_rate.store(0, Ordering::Relaxed),
        CB_CHANGE => sh.restart.store(true, Ordering::Release),
        CB_BUFFER_IN if !data.is_null() => {
            let b = unsafe { &*(data as *const AudioBuffer) };
            sh.buffers.fetch_add(1, Ordering::Relaxed);
            process_in(sh, b);
        }
        CB_BUFFER_OUT if !data.is_null() => {
            let b = unsafe { &*(data as *const AudioBuffer) };
            process_out(sh, b);
        }
        _ => {}
    }
}

fn pass_through(b: &AudioBuffer, chans: usize, n: usize, skip: impl Fn(usize) -> bool) {
    for ch in 0..chans {
        if skip(ch) {
            continue;
        }
        let (r, w) = (b.r[ch], b.w[ch]);
        if !r.is_null() && !w.is_null() && r != w {
            unsafe { std::ptr::copy_nonoverlapping(r, w, n) };
        }
    }
}

/// Mono from a stereo pair. A mono mic on a two-channel interface is often on one side only;
/// averaging would halve it, so the quiet side is left out.
fn to_mono(left: &[f32], right: &[f32], power: &mut [f32; 2], out: &mut [f32]) {
    let n = left.len();
    let block_power = |s: &[f32]| s.iter().map(|v| v * v).sum::<f32>() / n.max(1) as f32;
    power[0] = power[0] * 0.95 + block_power(left) * 0.05;
    power[1] = power[1] * 0.95 + block_power(right) * 0.05;
    let (pl, pr) = (power[0], power[1]);
    for k in 0..n {
        out[k] = if pl > pr * 100.0 {
            left[k]
        } else if pr > pl * 100.0 {
            right[k]
        } else {
            (left[k] + right[k]) * 0.5
        };
    }
}

fn process_in(sh: &Shared, b: &AudioBuffer) {
    {
        // Mic coach: the mic as it arrives, before clean-up and plugins.
        let n = b.nbs.max(0) as usize;
        let chans = (b.nbi.max(0) as usize).min(128);
        unsafe { crate::coach::tap(&b.r, chans, n, sh.sample_rate.load(Ordering::Relaxed)) };
    }
    run_lanes(sh, b, false);
    let n = b.nbs.max(0) as usize;
    let chans = (b.nbi.min(b.nbo).max(0) as usize).min(128);
    unsafe { crate::soundfx::process(&b.w, chans, n, false) };
    // Instant replay's separate tracks: each input as the mixer gets it (after clean-up and EQ).
    unsafe { crate::replay::tap(&b.w, chans, n, sh.sample_rate.load(Ordering::Relaxed)) };
}

/// Is Sleekmeeter in Voicemeeter's input insert right now (and getting audio)?
pub fn input_insert_on() -> bool {
    REG_MODE.load(Ordering::Acquire) & crate::vm::AUDIOCALLBACK_IN != 0
        && shared().sample_rate.load(Ordering::Relaxed) > 0
}

/// The input insert's sample rate (0 until Voicemeeter starts sending audio).
pub fn insert_rate() -> u32 {
    shared().sample_rate.load(Ordering::Relaxed)
}

/// The lanes on this insert (inputs or outputs): hand their audio to the workers and play back
/// what they made. Every other channel passes straight through.
fn run_lanes(sh: &Shared, b: &AudioBuffer, output: bool) {
    let n = b.nbs.max(0) as usize;
    let chans = (b.nbi.min(b.nbo).max(0) as usize).min(128);
    let rate = sh.sample_rate.load(Ordering::Relaxed);
    let mut locals: Vec<_> = AUDIO.iter().map(|m| m.try_lock().ok()).collect();
    let mut ready = [usize::MAX; LANES];
    for (i, l) in sh.lanes.iter().enumerate() {
        if l.output.load(Ordering::Relaxed) != output {
            continue;
        }
        let c0 = l.channel.load(Ordering::Relaxed);
        let ok = l.active.load(Ordering::Acquire)
            && c0.checked_add(1).is_some_and(|c1| c1 < chans)
            && rate != 0
            && rate == l.worker_rate.load(Ordering::Relaxed)
            && locals[i]
                .as_ref()
                .and_then(|g| (**g).as_ref())
                .is_some_and(|a| a.input.len() >= n * 2)
            && !b.r[c0].is_null()
            && !b.r[c0 + 1].is_null()
            && !b.w[c0].is_null()
            && !b.w[c0 + 1].is_null();
        if ok {
            ready[i] = c0;
        }
    }
    // Everything we don't clean goes through as it came.
    pass_through(b, chans, n, |ch| {
        ready
            .iter()
            .any(|&c0| c0 != usize::MAX && (ch == c0 || ch == c0 + 1))
    });
    for (i, l) in sh.lanes.iter().enumerate() {
        if l.output.load(Ordering::Relaxed) != output {
            continue;
        }
        let c0 = ready[i];
        let Some(Some(a)) = locals[i].as_deref_mut() else {
            continue;
        };
        if c0 == usize::MAX {
            // Not running: anything left over is stale by the time it starts again.
            l.outq.clear();
            a.primed = false;
            continue;
        }
        if l.reset_output.swap(false, Ordering::AcqRel) {
            l.outq.clear();
            a.primed = false;
        }
        let left = unsafe { std::slice::from_raw_parts(b.r[c0], n) };
        let right = unsafe { std::slice::from_raw_parts(b.r[c0 + 1], n) };
        for ((pair, left), right) in a.input[..n * 2].chunks_exact_mut(2).zip(left).zip(right) {
            pair.copy_from_slice(&[*left, *right]);
        }
        l.inq.push(&a.input[..n * 2]);
        sys::signal(l.wake.load(Ordering::Relaxed));

        let frame = l.frame.load(Ordering::Relaxed);
        if !a.primed && l.outq.len() >= 2 * (n + frame + l.cushion.load(Ordering::Relaxed)) {
            a.primed = true;
        }
        let ok = a.primed && l.outq.pop(&mut a.out[..n * 2]);
        if !ok {
            if a.primed {
                // The worker fell behind: wait a little longer before playing next time.
                a.primed = false;
                l.underruns.fetch_add(1, Ordering::Relaxed);
                let c = l.cushion.load(Ordering::Relaxed);
                l.cushion
                    .store((c + 96).min(MAX_CUSHION), Ordering::Relaxed);
            }
            if l.stereo.load(Ordering::Relaxed) {
                a.out[..n * 2].copy_from_slice(&a.input[..n * 2]);
            } else {
                a.out[..n * 2].fill(0.0);
            }
        }
        for (side, c) in [c0, c0 + 1].into_iter().enumerate() {
            let w = unsafe { std::slice::from_raw_parts_mut(b.w[c], n) };
            for (sample, pair) in w.iter_mut().zip(a.out[..n * 2].chunks_exact(2)) {
                *sample = pair[side];
            }
        }
    }
}

/// The output insert (joined for speaker echo removal, plugins on outputs, and listening EQ or
/// the leveller): run the output lanes, send what the speakers' bus plays to each mic that removes
/// speaker echo, then shape the outputs that have an EQ preset or leveller.
fn process_out(sh: &Shared, b: &AudioBuffer) {
    let n = b.nbs.max(0) as usize;
    let chans = (b.nbi.min(b.nbo).max(0) as usize).min(128);
    run_lanes(sh, b, true);
    send_reference(sh, b, n, chans);
    unsafe { crate::soundfx::process(&b.w, chans, n, true) };
}

/// What the speakers' bus plays (before anything here changes it), for speaker echo removal.
fn send_reference(sh: &Shared, b: &AudioBuffer, n: usize, chans: usize) {
    let c0 = sh.ref_channel.load(Ordering::Relaxed);
    if c0.checked_add(1).is_none_or(|c1| c1 >= chans) || b.r[c0].is_null() || b.r[c0 + 1].is_null()
    {
        return;
    }
    if !sh.lanes.iter().any(|l| l.want_ref.load(Ordering::Relaxed)) {
        return;
    }
    let Ok(mut scratch) = REF_SCRATCH.try_lock() else {
        return;
    };
    if scratch.len() < n {
        return;
    }
    let left = unsafe { std::slice::from_raw_parts(b.r[c0], n) };
    let right = unsafe { std::slice::from_raw_parts(b.r[c0 + 1], n) };
    for k in 0..n {
        scratch[k] = (left[k] + right[k]) * 0.5;
    }
    for l in &sh.lanes {
        if l.want_ref.load(Ordering::Relaxed) {
            l.refq.push(&scratch[..n]);
        }
    }
}

/// Latency a mic's chain adds, in ms (what's queued ahead of playback).
fn latency_ms(sh: &Shared, l: &LaneShared) -> f32 {
    let n = sh.block.load(Ordering::Relaxed);
    let frame = l.frame.load(Ordering::Relaxed);
    let held = n + frame + l.cushion.load(Ordering::Relaxed);
    held as f32 * 1000.0 / l.worker_rate.load(Ordering::Relaxed).max(1) as f32
}

/* ---------- NVIDIA Audio Effects SDK ---------- */

/// Where NVIDIA's installer put the runtime.
fn sdk_dir() -> std::path::PathBuf {
    std::env::var_os("NVAFX_SDK_DIR")
        .map(std::path::PathBuf::from)
        .filter(|p| p.join("NVAudioEffects.dll").is_file())
        .unwrap_or_else(|| {
            std::path::PathBuf::from(
                r"C:\Program Files\NVIDIA Corporation\NVIDIA Audio Effects SDK",
            )
        })
}

/// NVIDIA's runtime is installed.
pub fn available() -> bool {
    sdk_dir().join("NVAudioEffects.dll").is_file()
}

fn nv_error(code: i32) -> String {
    match code {
        3 => "NVIDIA's effect didn't accept a setting (error 3)".into(),
        6 => "This NVIDIA effect isn't available on this PC (error 6)".into(),
        8 => "NVIDIA's AI model couldn't be loaded. Your GPU may not be supported: it needs an NVIDIA RTX card (error 8)".into(),
        n => format!("NVIDIA's effect reported error {n}. It needs an NVIDIA RTX card and an up-to-date driver"),
    }
}

#[cfg(windows)]
mod nv {
    use super::nv_error;
    use libloading::os::windows::{Library, LOAD_WITH_ALTERED_SEARCH_PATH};
    use std::ffi::{c_char, c_void, CString};

    type Handle = *mut c_void;
    type FnCreate = unsafe extern "C" fn(*const c_char, *mut Handle) -> i32;
    type FnDestroy = unsafe extern "C" fn(Handle) -> i32;
    type FnSetU32 = unsafe extern "C" fn(Handle, *const c_char, u32) -> i32;
    type FnSetString = unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> i32;
    type FnSetFloat = unsafe extern "C" fn(Handle, *const c_char, f32) -> i32;
    type FnGetU32 = unsafe extern "C" fn(Handle, *const c_char, *mut u32) -> i32;
    type FnLoad = unsafe extern "C" fn(Handle) -> i32;
    type FnRun = unsafe extern "C" fn(Handle, *const *const f32, *mut *mut f32, u32, u32) -> i32;
    /// The channel count NvAFX_Run takes for echo cancellation (mic and speakers).
    pub const AEC_CHANNELS: u32 = 2;

    struct Fns {
        _lib: Library,
        create: FnCreate,
        destroy: FnDestroy,
        set_u32: FnSetU32,
        set_string: FnSetString,
        set_float: FnSetFloat,
        get_u32: FnGetU32,
        load: FnLoad,
        run: FnRun,
    }

    /// Loaded once, the first time mic clean-up starts (it pulls in CUDA and TensorRT).
    fn fns() -> Result<&'static Fns, String> {
        static F: std::sync::OnceLock<Result<Fns, String>> = std::sync::OnceLock::new();
        F.get_or_init(|| unsafe {
            let path = super::sdk_dir().join("NVAudioEffects.dll");
            // Its CUDA and TensorRT DLLs sit next to it.
            let lib = Library::load_with_flags(&path, LOAD_WITH_ALTERED_SEARCH_PATH)
                .map_err(|e| format!("Couldn't load NVIDIA's Audio Effects runtime: {e}"))?;
            macro_rules! sym {
                ($name:literal, $t:ty) => {
                    *lib.get::<$t>(concat!($name, "\0").as_bytes())
                        .map_err(|e| format!("NVIDIA's runtime is missing {}: {e}", $name))?
                };
            }
            Ok(Fns {
                create: sym!("NvAFX_CreateEffect", FnCreate),
                destroy: sym!("NvAFX_DestroyEffect", FnDestroy),
                set_u32: sym!("NvAFX_SetU32", FnSetU32),
                set_string: sym!("NvAFX_SetString", FnSetString),
                set_float: sym!("NvAFX_SetFloat", FnSetFloat),
                get_u32: sym!("NvAFX_GetU32", FnGetU32),
                load: sym!("NvAFX_Load", FnLoad),
                run: sym!("NvAFX_Run", FnRun),
                _lib: lib,
            })
        })
        .as_ref()
        .map_err(Clone::clone)
    }

    fn c(s: &str) -> CString {
        CString::new(s).unwrap_or_default()
    }

    pub struct Effect {
        f: &'static Fns,
        h: Handle,
        pub frame: usize,
    }

    // The handle is only used from the worker thread that owns the Effect.
    unsafe impl Send for Effect {}

    impl Effect {
        pub fn new(selector: &str, rate: u32, frame: usize) -> Result<Effect, String> {
            let f = fns()?;
            let mut h: Handle = std::ptr::null_mut();
            let r = unsafe { (f.create)(c(selector).as_ptr(), &mut h) };
            if r != 0 || h.is_null() {
                return Err(nv_error(r));
            }
            let mut e = Effect { f, h, frame };
            let k = if rate == 16_000 { "16k" } else { "48k" };
            let model = super::sdk_dir()
                .join("models")
                .join(format!("{selector}_{k}.trtpkg"));
            if !model.is_file() {
                return Err(format!(
                    "NVIDIA's model file is missing ({}). Reinstall NVIDIA's Audio Effects SDK",
                    model.display()
                ));
            }
            let model = c(&model.to_string_lossy());
            unsafe {
                let r = (f.set_string)(h, c("model_path").as_ptr(), model.as_ptr());
                if r != 0 {
                    return Err(nv_error(r));
                }
                // Newer SDKs split the rate into input and output; older ones have one.
                if (f.set_u32)(h, c("input_sample_rate").as_ptr(), rate) != 0 {
                    let r = (f.set_u32)(h, c("sample_rate").as_ptr(), rate);
                    if r != 0 {
                        return Err(nv_error(r));
                    }
                }
                let _ = (f.set_u32)(h, c("output_sample_rate").as_ptr(), rate);
                let _ = (f.set_u32)(h, c("num_input_samples_per_frame").as_ptr(), frame as u32);
                let _ = (f.set_u32)(h, c("num_streams").as_ptr(), 1);
                let r = (f.load)(h);
                if r != 0 {
                    return Err(nv_error(r));
                }
                let mut got = 0u32;
                if (f.get_u32)(h, c("num_input_samples_per_frame").as_ptr(), &mut got) != 0 {
                    let _ = (f.get_u32)(h, c("num_samples_per_frame").as_ptr(), &mut got);
                }
                if got > 0 {
                    e.frame = got as usize;
                }
            }
            Ok(e)
        }

        /// 0..1: how hard to clean. Not every effect has it; ignored then.
        pub fn set_strength(&mut self, v: f32) {
            unsafe {
                let _ = (self.f.set_float)(self.h, c("intensity_ratio").as_ptr(), v);
            }
        }

        pub fn run(&mut self, input: &[f32], output: &mut [f32]) -> Result<(), String> {
            let i = input.as_ptr();
            let mut o = output.as_mut_ptr();
            let r = unsafe { (self.f.run)(self.h, &i, &mut o, input.len() as u32, 1) };
            if r == 0 {
                Ok(())
            } else {
                Err(nv_error(r))
            }
        }

        /// A number the effect reports, like "num_input_channels".
        #[allow(dead_code)]
        pub fn get(&self, name: &str) -> Option<u32> {
            let mut v = 0u32;
            (unsafe { (self.f.get_u32)(self.h, c(name).as_ptr(), &mut v) } == 0).then_some(v)
        }

        /// Echo cancellation: the mic (`near`) and what the speakers play (`far`).
        pub fn run_aec(
            &mut self,
            near: &[f32],
            far: &[f32],
            output: &mut [f32],
        ) -> Result<(), String> {
            self.run_aec_n(near, far, output, AEC_CHANNELS)
        }

        pub fn run_aec_n(
            &mut self,
            near: &[f32],
            far: &[f32],
            output: &mut [f32],
            channels: u32,
        ) -> Result<(), String> {
            let ins = [near.as_ptr(), far.as_ptr()];
            let mut o = output.as_mut_ptr();
            let r =
                unsafe { (self.f.run)(self.h, ins.as_ptr(), &mut o, near.len() as u32, channels) };
            if r == 0 {
                Ok(())
            } else {
                Err(nv_error(r))
            }
        }
    }

    impl Drop for Effect {
        fn drop(&mut self) {
            unsafe {
                (self.f.destroy)(self.h);
            }
        }
    }
}

#[cfg(not(windows))]
mod nv {
    pub struct Effect {
        pub frame: usize,
    }
    impl Effect {
        pub fn new(_: &str, _: u32, _: usize) -> Result<Effect, String> {
            Err("NVIDIA's effects only run on Windows".into())
        }
        pub fn set_strength(&mut self, _: f32) {}
        pub fn run(&mut self, _: &[f32], _: &mut [f32]) -> Result<(), String> {
            Ok(())
        }
        pub fn run_aec(&mut self, _: &[f32], _: &[f32], _: &mut [f32]) -> Result<(), String> {
            Ok(())
        }
    }
}

/* ---------- worker thread per mic: echo removal, NVIDIA's clean-up, then the plugins ---------- */

/// What a worker was built for.
#[derive(Clone, PartialEq, Debug)]
struct WorkerKey {
    /// NVIDIA's noise or room echo effect.
    effect: Option<String>,
    /// NVIDIA's speaker echo removal.
    aec: bool,
    rate: u32,
    stereo: bool,
    channel: usize,
    /// On an output (Voicemeeter's output insert).
    output: bool,
}

struct Worker {
    lane: usize,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    key: WorkerKey,
}

fn warm(e: &mut nv::Effect, aec: bool) -> Result<(), String> {
    // The first runs are slow while the GPU warms up; get them out of the way.
    let (zeros, mut out) = (vec![0f32; e.frame], vec![0f32; e.frame]);
    for _ in 0..5 {
        if aec {
            e.run_aec(&zeros, &zeros, &mut out)?;
        } else {
            e.run(&zeros, &mut out)?;
        }
    }
    Ok(())
}

impl Worker {
    /// Load NVIDIA's models if asked (a few seconds the first time) and start running.
    fn start(lane: usize, key: WorkerKey, strength: Arc<AtomicU32>) -> Result<Worker, String> {
        // 10 ms frames: what NVIDIA's models use, and fine for plugins.
        let mut frame = (key.rate as usize / 100).max(1);
        let mut aec = None;
        if key.aec {
            let mut e = nv::Effect::new("aec", RATE, DEFAULT_FRAME)?;
            warm(&mut e, true)?;
            frame = e.frame;
            aec = Some(e);
        }
        let mut nvfx = None;
        if let Some(effect) = &key.effect {
            let mut e = nv::Effect::new(effect, RATE, DEFAULT_FRAME)?;
            e.set_strength(f32::from_bits(strength.load(Ordering::Relaxed)));
            warm(&mut e, false)?;
            frame = e.frame;
            nvfx = Some(e);
        }
        let l = &shared().lanes[lane];
        l.frame.store(frame, Ordering::Relaxed);
        l.worker_rate.store(key.rate, Ordering::Relaxed);
        l.stereo.store(key.stereo, Ordering::Relaxed);
        l.output.store(key.output, Ordering::Relaxed);
        l.channel.store(key.channel, Ordering::Relaxed);
        l.reset_output.store(true, Ordering::Release);
        l.cushion.store(START_CUSHION, Ordering::Relaxed);
        l.want_ref.store(key.aec, Ordering::Relaxed);
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let stereo = key.stereo;
        let thread = std::thread::Builder::new()
            .name(format!("mic-clean-up-{lane}"))
            .spawn(move || work(lane, nvfx, aec, frame, stereo, strength, stop2))
            .map_err(|e| e.to_string())?;
        Ok(Worker {
            lane,
            stop,
            thread: Some(thread),
            key,
        })
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let l = &shared().lanes[self.lane];
        l.active.store(false, Ordering::Release);
        l.want_ref.store(false, Ordering::Relaxed);
        self.stop.store(true, Ordering::Release);
        sys::signal(l.wake.load(Ordering::Relaxed));
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn work(
    lane: usize,
    mut nvfx: Option<nv::Effect>,
    mut aec: Option<nv::Effect>,
    frame: usize,
    stereo: bool,
    strength: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
) {
    sys::raise_priority();
    let l = &shared().lanes[lane];
    let (mut inb, mut refb) = (vec![0f32; frame], vec![0f32; frame]);
    let (mut mid, mut outb) = (vec![0f32; frame], vec![0f32; frame]);
    let (mut input, mut stereo_out) = (vec![0f32; frame * 2], vec![0f32; frame * 2]);
    let (mut left, mut right) = (vec![0f32; frame], vec![0f32; frame]);
    let mut power = [0.0; 2];
    let mut applied = strength.load(Ordering::Relaxed);
    let mut last_error = String::new();
    let mut report = |err: String| {
        if err != last_error {
            log_warn!("Mic clean-up: {err}");
            last_error = err;
        }
    };
    l.inq.clear();
    l.refq.clear();
    while !stop.load(Ordering::Acquire) {
        if l.flush.swap(false, Ordering::AcqRel) {
            l.inq.clear();
            l.refq.clear();
        }
        let s = strength.load(Ordering::Relaxed);
        if s != applied {
            applied = s;
            if let Some(e) = &mut nvfx {
                e.set_strength(f32::from_bits(s));
            }
        }
        if !l.inq.pop(&mut input) {
            sys::wait(l.wake.load(Ordering::Relaxed), 20);
            continue;
        }
        let bypass = l.bypass.load(Ordering::Relaxed);
        if stereo {
            stereo_out.copy_from_slice(&input);
            crate::pluginhost::process(lane, &mut stereo_out, true);
            if CAPTURE_LANE.load(Ordering::Relaxed) == lane {
                capture_frame(lane, 2, &input, &stereo_out);
            }
            l.outq.push(if bypass { &input } else { &stereo_out });
            continue;
        }
        for ((pair, left), right) in input.chunks_exact(2).zip(&mut left).zip(&mut right) {
            *left = pair[0];
            *right = pair[1];
        }
        to_mono(&left, &right, &mut power, &mut inb);
        mid.copy_from_slice(&inb);
        if let Some(a) = &mut aec {
            // Keep the speakers' sound roughly in step with the mic: drop what piled up.
            while l.refq.len() > 4 * frame {
                l.refq.pop(&mut refb);
            }
            if !l.refq.pop(&mut refb) {
                refb.fill(0.0);
            }
            match a.run_aec(&mid, &refb, &mut outb) {
                Ok(()) => mid.copy_from_slice(&outb),
                Err(e) => report(e),
            }
        }
        if let Some(e) = &mut nvfx {
            match e.run(&mid, &mut outb) {
                Ok(()) => mid.copy_from_slice(&outb),
                Err(e) => report(e),
            }
        }
        crate::pluginhost::process(lane, &mut mid, false);
        if CAPTURE_LANE.load(Ordering::Relaxed) == lane {
            capture_frame(lane, 1, &inb, &mid);
        }
        // Compare: the raw mic, just as late, so switching back and forth doesn't jump.
        for (pair, &sample) in stereo_out
            .chunks_exact_mut(2)
            .zip(if bypass { &inb } else { &mid })
        {
            pair.fill(sample);
        }
        l.outq.push(&stereo_out);
    }
}

/* ---------- local raw/processed comparison ---------- */

struct MicTake {
    started: Instant,
    lane: usize,
    channel: usize,
    rate: u32,
    channels: u16,
    frames: usize,
    raw: Vec<f32>,
    processed: Vec<f32>,
}

static CAPTURE_LANE: AtomicUsize = AtomicUsize::new(usize::MAX);
static MIC_TAKE: Mutex<Option<MicTake>> = Mutex::new(None);

fn capture_frame(lane: usize, channels: u16, raw: &[f32], processed: &[f32]) {
    let Ok(mut guard) = MIC_TAKE.try_lock() else {
        return;
    };
    let Some(take) = guard
        .as_mut()
        .filter(|t| t.lane == lane && t.channels == channels)
    else {
        return;
    };
    let count = raw.len().min(take.frames - take.raw.len());
    take.raw.extend_from_slice(&raw[..count]);
    take.processed.extend_from_slice(&processed[..count]);
    if take.raw.len() == take.frames {
        CAPTURE_LANE.store(usize::MAX, Ordering::Relaxed);
    }
}

pub fn clear_take() {
    let mut take = MIC_TAKE.lock().unwrap();
    CAPTURE_LANE.store(usize::MAX, Ordering::Relaxed);
    *take = None;
}

pub fn record_take(app: &AppHandle, id: &str) -> Result<(), String> {
    let c = cfg(app);
    let lane = c
        .chains
        .iter()
        .take(LANES)
        .position(|ch| ch.id == id)
        .ok_or("That mic isn't set up.")?;
    let state = &shared().lanes[lane];
    let rate = state.worker_rate.load(Ordering::Relaxed);
    let channel = state.channel.load(Ordering::Relaxed);
    if !state.active.load(Ordering::Acquire) || rate == 0 || channel == usize::MAX {
        return Err(
            "Start an effect or VST3 plugin on this mic before recording a comparison.".into(),
        );
    }
    let started = Instant::now();
    let channels = if state.stereo.load(Ordering::Relaxed) {
        2
    } else {
        1
    };
    let frames = rate as usize * 4 * channels as usize;
    {
        let mut take = MIC_TAKE.lock().unwrap();
        if CAPTURE_LANE.load(Ordering::Relaxed) != usize::MAX {
            return Err("A mic comparison is already recording.".into());
        }
        *take = Some(MicTake {
            started,
            lane,
            channel,
            rate,
            channels,
            frames,
            raw: Vec::with_capacity(frames),
            processed: Vec::with_capacity(frames),
        });
        CAPTURE_LANE.store(lane, Ordering::Release);
    }
    loop {
        std::thread::sleep(Duration::from_millis(50));
        let mut guard = MIC_TAKE.lock().unwrap();
        let take = guard
            .as_mut()
            .filter(|t| t.started == started)
            .ok_or("Recording was cleared.")?;
        if !state.active.load(Ordering::Acquire)
            || state.worker_rate.load(Ordering::Relaxed) != take.rate
            || state.channel.load(Ordering::Relaxed) != take.channel
            || state.stereo.load(Ordering::Relaxed) != (take.channels == 2)
            || started.elapsed() > Duration::from_secs(6)
        {
            CAPTURE_LANE.store(usize::MAX, Ordering::Relaxed);
            *guard = None;
            return Err(
                "The mic chain stopped delivering audio. Check the input and try again.".into(),
            );
        }
        if take.raw.len() == frames {
            level_match_take(take);
            return Ok(());
        }
    }
}

fn level_match_take(take: &mut MicTake) {
    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }
    for sample in take.raw.iter_mut().chain(take.processed.iter_mut()) {
        *sample = if sample.is_finite() {
            sample.clamp(-1.0, 1.0)
        } else {
            0.0
        };
    }
    let (raw, processed) = (rms(&take.raw), rms(&take.processed));
    // Only turn down the louder take. Leave silence audible as silence.
    if raw.min(processed) > 0.0001 {
        let (samples, factor) = if raw > processed {
            (&mut take.raw, processed / raw)
        } else {
            (&mut take.processed, raw / processed)
        };
        for sample in samples {
            *sample *= factor;
        }
    }
}

pub fn play_take(output: &str, processed: bool) -> Result<(), String> {
    let (channels, rate, samples) = {
        let take = MIC_TAKE.lock().unwrap();
        let take = take
            .as_ref()
            .filter(|t| t.raw.len() == t.frames)
            .ok_or("Record a mic comparison first.")?;
        (
            take.channels,
            take.rate,
            if processed {
                take.processed.clone()
            } else {
                take.raw.clone()
            },
        )
    };
    crate::selftest::play_mic(output, channels, rate, samples)
}

/* ---------- Windows event and thread priority ---------- */

#[cfg(windows)]
mod sys {
    use windows_sys::Win32::System::Threading::{
        CreateEventW, GetCurrentThread, SetEvent, SetThreadPriority, WaitForSingleObject,
        THREAD_PRIORITY_HIGHEST,
    };
    pub fn new_event() -> usize {
        unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) as usize }
    }
    pub fn signal(h: usize) {
        if h != 0 {
            unsafe { SetEvent(h as _) };
        }
    }
    pub fn wait(h: usize, ms: u32) {
        if h == 0 {
            std::thread::sleep(std::time::Duration::from_millis(1));
        } else {
            unsafe { WaitForSingleObject(h as _, ms) };
        }
    }
    pub fn raise_priority() {
        unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST) };
    }
}

#[cfg(not(windows))]
mod sys {
    pub fn new_event() -> usize {
        0
    }
    pub fn signal(_: usize) {}
    pub fn wait(_: usize, _: u32) {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    pub fn raise_priority() {}
}

/* ---------- settings ---------- */

/// One mic's chain, as Settings has it.
#[derive(Clone, Debug)]
struct Chain {
    id: String,
    /// "Strip[0]"
    target: String,
    strip: Option<usize>,
    /// NVIDIA's noise or room echo removal on.
    on: bool,
    effect: String,
    /// 0..1
    strength: f32,
    /// NVIDIA's speaker echo removal on.
    aec: bool,
    stereo: bool,
    plugins: Vec<Value>,
}

fn strip_index(target: &str) -> Option<usize> {
    target
        .strip_prefix("Strip[")
        .and_then(|t| t.strip_suffix(']'))
        .and_then(|t| t.parse().ok())
}

fn bus_index(target: &str) -> Option<usize> {
    target
        .strip_prefix("Bus[")
        .and_then(|t| t.strip_suffix(']'))
        .and_then(|t| t.parse().ok())
}

/// Where a chain's target is in Voicemeeter's inserts: (first channel, on the output insert).
/// Hardware inputs have 2 channels each, then virtual inputs 8 each; every bus has 8. Virtual
/// inputs and buses are cleaned on their front left and right (where voices and stereo are).
pub(crate) fn insert_slot(target: &str, layout: &crate::vm::Layout) -> Option<(usize, bool)> {
    if let Some(i) = strip_index(target) {
        if i < layout.hw_strips {
            return Some((i * 2, false));
        }
        if i < layout.strips() {
            return Some((layout.hw_strips * 2 + (i - layout.hw_strips) * 8, false));
        }
        return None;
    }
    bus_index(target)
        .filter(|&j| j < layout.buses())
        .map(|j| (j * 8, true))
}

/// The chains in `micFx`. Before several mics there was one, in micFx itself: that becomes the
/// first chain (id "c1"), so old settings keep working.
pub fn chains_json(m: &Value) -> Vec<Value> {
    if let Some(a) = m["chains"].as_array() {
        return a.clone();
    }
    if m.get("target").is_some() || m.get("on").is_some() || m.get("plugins").is_some() {
        return vec![json!({
            "id": "c1",
            "target": m["target"].as_str().unwrap_or("Strip[0]"),
            "on": m["on"].as_bool().unwrap_or(false),
            "effect": m["effect"].as_str().unwrap_or("denoiser"),
            "strength": m["strength"].as_f64().unwrap_or(100.0),
            "aec": false,
            "plugins": m["plugins"].as_array().cloned().unwrap_or_default(),
        })];
    }
    vec![
        json!({ "id": "c1", "target": "Strip[0]", "on": false, "effect": "denoiser",
                 "strength": 100, "aec": false, "plugins": [] }),
    ]
}

fn chains(m: &Value) -> Vec<Chain> {
    chains_json(m)
        .iter()
        .map(|c| {
            let target = c["target"].as_str().unwrap_or("Strip[0]").to_string();
            let effect = c["effect"].as_str().unwrap_or("denoiser");
            Chain {
                id: c["id"].as_str().unwrap_or("c1").to_string(),
                strip: strip_index(&target),
                target,
                on: c["on"].as_bool().unwrap_or(false),
                effect: if EFFECTS.iter().any(|(k, _)| *k == effect) {
                    effect.to_string()
                } else {
                    "denoiser".into()
                },
                strength: (c["strength"].as_f64().unwrap_or(100.0) as f32 / 100.0).clamp(0.0, 1.0),
                aec: c["aec"].as_bool().unwrap_or(false),
                stereo: c["stereo"].as_bool().unwrap_or(false),
                plugins: c["plugins"].as_array().cloned().unwrap_or_default(),
            }
        })
        .collect()
}

struct Cfg {
    chains: Vec<Chain>,
    /// The bus the speakers are on, for speaker echo removal ("Bus[0]" = A1).
    aec_bus: usize,
    /// Switched off / strength set by shortcuts, scenes and so on: { id: { off, strength } }.
    live: Value,
    states: Value,
    /// Listening EQ and leveller per channel (soundfx.rs).
    sound: Value,
}

fn cfg(app: &AppHandle) -> Cfg {
    let state = app.state::<Settings>();
    let s = state.0.lock().unwrap();
    let m = &s["micFx"];
    let aec_bus = m["aecRef"]
        .as_str()
        .and_then(|b| b.strip_prefix("Bus[")?.strip_suffix(']')?.parse().ok())
        .unwrap_or(0);
    Cfg {
        chains: chains(m),
        aec_bus,
        live: s["micFxLive"].clone(),
        states: s["vstState"].clone(),
        sound: s["soundFx"].clone(),
    }
}

/// Is this chain switched off right now (shortcut, scene, Stream Deck…)?
fn is_off(live: &Value, id: &str) -> bool {
    live[id]["off"].as_bool().unwrap_or(false)
}

/* ---------- status ---------- */

static STATUS: Mutex<Value> = Mutex::new(Value::Null);
/// Registered with Voicemeeter's audio callback, and for which inserts (0 = not).
static REG_MODE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// `{ available, message, chains: { id: { running, off, message, latencyMs, underruns } },
/// plugins }` for Settings.
pub fn status() -> Value {
    let mut s = STATUS.lock().unwrap().clone();
    if s.is_null() {
        s = json!({ "available": available(), "message": "", "chains": {} });
    }
    s["plugins"] = crate::pluginhost::status();
    s["recovery"] = crate::pluginhost::recovery();
    s
}

/// For the Stream Deck and phone: each mic that has a chain set up, and whether it's on.
pub fn api_state(app: &AppHandle) -> Value {
    let c = cfg(app);
    let mut out = serde_json::Map::new();
    for ch in &c.chains {
        let set = ch.on || ch.aec || !ch.plugins.is_empty();
        if set {
            out.insert(ch.target.clone(), json!({ "on": !is_off(&c.live, &ch.id) }));
        }
    }
    Value::Object(out)
}

/* ---------- switching chains off and on (shortcuts, Stream Deck, phone, Twitch, scenes) ---------- */

fn save_live(app: &AppHandle, live: Value) {
    {
        let st = app.state::<Settings>();
        st.0.lock().unwrap()["micFxLive"] = live;
    }
    app.state::<SettingsDirty>().0.store(true, Ordering::SeqCst);
    let _ = app.emit("micfx-live", ());
}

/// Switch the chain on `target` ("Strip[0]"; "" = every mic) off, or back on. Returns whether
/// it's on now.
pub fn toggle(app: &AppHandle, target: &str) -> Result<bool, String> {
    let c = cfg(app);
    let hit: Vec<&Chain> = c
        .chains
        .iter()
        .filter(|ch| target.is_empty() || ch.target == target)
        .filter(|ch| ch.on || ch.aec || !ch.plugins.is_empty())
        .collect();
    if hit.is_empty() {
        show_osd_text(app, "Mic clean-up", "Not set up", false, "mic");
        return Err("Set up mic clean-up or plugins for that mic first (Settings → Mic clean-up and plugins)".into());
    }
    // Any on: switch them all off. All off: back on.
    let turn_on = hit.iter().all(|ch| is_off(&c.live, &ch.id));
    let mut live = if c.live.is_object() {
        c.live.clone()
    } else {
        json!({})
    };
    for ch in &hit {
        live[&ch.id]["off"] = json!(!turn_on);
    }
    save_live(app, live);
    show_osd_text(
        app,
        "Mic clean-up",
        if turn_on { "On" } else { "Off" },
        turn_on,
        "mic",
    );
    log_info!(
        "Mic clean-up: {} by request",
        if turn_on { "on" } else { "off" }
    );
    Ok(turn_on)
}

/// What scenes save: each mic's chain off or on, and NVIDIA's strength. Keyed by input.
pub fn scene_snapshot(app: &AppHandle) -> Value {
    let c = cfg(app);
    let mut out = serde_json::Map::new();
    for ch in &c.chains {
        let strength = c.live[&ch.id]["strength"]
            .as_f64()
            .unwrap_or((ch.strength * 100.0).round() as f64);
        out.insert(
            ch.target.clone(),
            json!({ "off": is_off(&c.live, &ch.id), "strength": strength }),
        );
    }
    Value::Object(out)
}

/// A scene loaded: put back what it saved (mics it doesn't mention stay as they are).
pub fn scene_apply(app: &AppHandle, saved: &Value) {
    let Some(map) = saved.as_object() else { return };
    let c = cfg(app);
    let mut live = if c.live.is_object() {
        c.live.clone()
    } else {
        json!({})
    };
    for ch in &c.chains {
        if let Some(v) = map.get(&ch.target) {
            live[&ch.id]["off"] = json!(v["off"].as_bool().unwrap_or(false));
            let base = (ch.strength * 100.0).round() as f64;
            live[&ch.id]["strength"] = match v["strength"].as_f64() {
                Some(s) if (s - base).abs() > 0.5 => json!(s),
                _ => Value::Null,
            };
        }
    }
    save_live(app, live);
}

/// Compare: while held, a mic's chain is bypassed (the raw mic, at the same delay).
pub fn compare(app: &AppHandle, id: &str, on: bool) {
    let c = cfg(app);
    if let Some(lane) = c.chains.iter().take(LANES).position(|ch| ch.id == id) {
        shared().lanes[lane].bypass.store(on, Ordering::Relaxed);
    }
}

/// The input Sleekmeeter switched A1 on for (so you hear yourself), to switch off again.
static LISTEN: Mutex<Option<String>> = Mutex::new(None);

/// Listen: send a mic to A1 (usually your headphones) while comparing; off puts it back.
pub fn listen(app: &AppHandle, id: &str, on: bool) -> Result<bool, String> {
    let api = app
        .state::<Vm>()
        .api
        .clone()
        .ok_or("Voicemeeter isn't running")?;
    let mut held = LISTEN.lock().unwrap();
    // Whatever was on before goes back first.
    if let Some(t) = held.take() {
        let _ = api.set_float(&format!("{t}.A1"), 0.0);
    }
    if !on {
        return Ok(false);
    }
    let c = cfg(app);
    let ch = c
        .chains
        .iter()
        .find(|ch| ch.id == id)
        .ok_or("That mic isn't set up")?;
    if ch.target.starts_with("Bus[") {
        return Err("Plugins on an output already play on it.".into());
    }
    let param = format!("{}.A1", ch.target);
    if api.get_float(&param).unwrap_or(0.0) == 0.0 {
        api.set_float(&param, 1.0)?;
        *held = Some(ch.target.clone());
    }
    Ok(true)
}

fn stop_listening(app: &AppHandle) {
    let _ = listen(app, "", false);
}

/* ---------- running ---------- */

fn unregister(api: &crate::vm::Api) {
    for l in &shared().lanes {
        l.active.store(false, Ordering::Release);
    }
    if REG_MODE.swap(0, Ordering::AcqRel) != 0 {
        api.audio_stop();
        api.audio_unregister();
        log_info!("Mic clean-up: left Voicemeeter's audio insert");
    }
}

/// Quitting: give Voicemeeter's insert back before the DLL goes, then close the plugins.
pub fn shutdown(app: &AppHandle, api: Option<&crate::vm::Api>) {
    stop_listening(app);
    if let Some(api) = api {
        unregister(api);
    }
    crate::pluginhost::shutdown();
}

/// Save plugin settings the plugin host reports, and forget those of plugins no longer listed.
fn keep_state(app: &AppHandle, ev: &Value) {
    if ev["event"] == "quarantine" {
        let additions = {
            let settings = app.state::<Settings>();
            let mut s = settings.0.lock().unwrap();
            let ids = ev["ids"].as_array().cloned().unwrap_or_default();
            let old = s["vstQuarantine"].as_array().cloned().unwrap_or_default();
            let mut additions = Vec::new();
            for c in chains_json(&s["micFx"]) {
                for p in c["plugins"].as_array().into_iter().flatten() {
                    if ids.contains(&p["id"]) && !old.contains(&p["id"]) {
                        additions.push((
                            c["target"].as_str().unwrap_or("").to_owned(),
                            p["name"].as_str().unwrap_or("VST3 plugin").to_owned(),
                        ));
                    }
                }
            }
            s["vstQuarantine"] = ev["ids"].clone();
            additions
        };
        app.state::<SettingsDirty>().0.store(true, Ordering::SeqCst);
        for (target, plugin) in additions {
            crate::audio_events::record(app, "plugin", "VST3 plugin quarantined", &plugin, &target);
        }
        return;
    }
    if ev["event"] != "state" {
        return;
    }
    let Some(id) = ev["id"].as_str() else { return };
    let st = app.state::<Settings>();
    let mut s = st.0.lock().unwrap();
    if !s["vstState"].is_object() {
        s["vstState"] = json!({});
    }
    s["vstState"][id] = json!({ "c": ev["c"], "e": ev["e"] });
    app.state::<SettingsDirty>().0.store(true, Ordering::SeqCst);
}

fn prune_states(app: &AppHandle) {
    let st = app.state::<Settings>();
    let mut s = st.0.lock().unwrap();
    let ids: std::collections::HashSet<String> = chains_json(&s["micFx"])
        .iter()
        .flat_map(|c| c["plugins"].as_array().into_iter().flatten())
        .filter_map(|p| p["id"].as_str().map(str::to_owned))
        .collect();
    if let Some(m) = s["vstState"].as_object_mut() {
        let before = m.len();
        m.retain(|id, _| ids.contains(id));
        if m.len() != before {
            app.state::<SettingsDirty>().0.store(true, Ordering::SeqCst);
        }
    }
}

pub fn spawn(app: AppHandle) {
    let Some(api) = app.state::<Vm>().api.clone() else {
        return;
    };
    let quarantine = app.state::<Settings>().0.lock().unwrap()["vstQuarantine"].clone();
    crate::pluginhost::restore_quarantine(&quarantine);
    {
        let app = app.clone();
        crate::pluginhost::on_event(Box::new(move |ev| keep_state(&app, &ev)));
    }
    std::thread::spawn(move || {
        let sh = shared();
        let strengths: Vec<Arc<AtomicU32>> = (0..LANES)
            .map(|_| Arc::new(AtomicU32::new(1f32.to_bits())))
            .collect();
        let mut workers: Vec<Option<Worker>> = (0..LANES).map(|_| None).collect();
        // NVIDIA models that failed to load, per lane: not retried for a minute.
        let mut failed: Vec<Option<(WorkerKey, String, Instant)>> = vec![None; LANES];
        // Another app holds Voicemeeter's output insert: no speaker echo removal for a while.
        let mut out_blocked: Option<(String, Instant)> = None;
        let mut seen = (0u64, Instant::now());
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let c = cfg(&app);
            let edition = api.edition();
            let layout = crate::vm::Layout::for_edition(edition.unwrap_or(2));
            // Voicemeeter's rate once it has told us; 48 kHz until then.
            let vm_rate = sh.sample_rate.load(Ordering::Relaxed);
            let rate = if REG_MODE.load(Ordering::Acquire) != 0 && vm_rate != 0 {
                vm_rate
            } else {
                RATE
            };
            let chains: Vec<&Chain> = c.chains.iter().take(LANES).collect();

            // Plugins, on every mic (they load whenever listed, so their editors open).
            let mut wants = Vec::new();
            for (lane, ch) in chains.iter().enumerate() {
                let off = is_off(&c.live, &ch.id);
                for p in &ch.plugins {
                    let s = |k: &str| p[k].as_str().unwrap_or("").to_string();
                    if s("id").is_empty() || s("path").is_empty() {
                        continue;
                    }
                    wants.push(crate::vst::Want {
                        id: s("id"),
                        lane,
                        path: s("path"),
                        cid: s("cid"),
                        name: s("name"),
                        on: p["on"].as_bool().unwrap_or(true) && !off,
                        // Outputs are always stereo.
                        stereo: ch.stereo || bus_index(&ch.target).is_some(),
                        c: c.states[&s("id")]["c"].as_str().unwrap_or("").to_string(),
                        e: c.states[&s("id")]["e"].as_str().unwrap_or("").to_string(),
                    });
                }
            }
            crate::pluginhost::sync(wants.clone(), rate);
            prune_states(&app);

            let callback_ok = api.has_audio_callback();
            let vm_up = edition.is_some();
            let out_free = out_blocked
                .as_ref()
                .is_none_or(|(_, t)| t.elapsed() > Duration::from_secs(30));
            let ref_ok = c.aec_bus < layout.buses();
            sh.ref_channel.store(
                if ref_ok { c.aec_bus * 8 } else { usize::MAX },
                Ordering::Relaxed,
            );

            // Listening EQ and leveller: built for Voicemeeter's rate, run in the callback.
            let fx = crate::soundfx::wants(&c.sound, &layout);
            crate::soundfx::sync(&fx, rate);
            let (fx_in, fx_out) = crate::soundfx::needs(&fx);

            // Each mic (or chat input, or output): what can run, and why not.
            let mut chain_status = serde_json::Map::new();
            let mut used: Vec<String> = Vec::new();
            let mut any_in = false;
            let mut any_out = false;
            let mut any_aec = false;
            for lane in 0..LANES {
                let Some(ch) = chains.get(lane) else {
                    workers[lane] = None;
                    sh.lanes[lane].channel.store(usize::MAX, Ordering::Relaxed);
                    continue;
                };
                let l = &sh.lanes[lane];
                let off = is_off(&c.live, &ch.id);
                let strength = c.live[&ch.id]["strength"]
                    .as_f64()
                    .map(|v| (v as f32 / 100.0).clamp(0.0, 1.0))
                    .unwrap_or(ch.strength);
                strengths[lane].store(strength.to_bits(), Ordering::Relaxed);
                let plugins_on = wants.iter().filter(|w| w.lane == lane && w.on).count();
                let mut notes: Vec<String> = Vec::new();
                let slot = insert_slot(&ch.target, &layout);
                let output = slot.is_some_and(|(_, o)| o);
                // Outputs carry music and games: always stereo, plugins only.
                let stereo = ch.stereo || output;
                let channel = match slot {
                    Some((c0, _)) if !used.contains(&ch.target) => {
                        used.push(ch.target.clone());
                        c0
                    }
                    Some(_) => {
                        notes.push("Another tab above already uses this channel.".into());
                        usize::MAX
                    }
                    None => {
                        notes.push("Pick one of Voicemeeter's inputs or outputs.".into());
                        usize::MAX
                    }
                };
                let channel = if output && !out_free && channel != usize::MAX {
                    if let Some((who, _)) = &out_blocked {
                        notes.push(format!("{who} is using Voicemeeter's output insert, so plugins on outputs are off."));
                    }
                    usize::MAX
                } else {
                    channel
                };
                let nv_wanted = !stereo && (ch.on || ch.aec);
                if nv_wanted && !available() {
                    notes.push("NVIDIA's Audio Effects runtime isn't installed (it needs an NVIDIA RTX graphics card).".into());
                } else if nv_wanted && rate != RATE {
                    notes.push(format!("NVIDIA's effects need 48 kHz, and Voicemeeter runs at {} kHz: in Voicemeeter, open Menu → System Settings and set Preferred Main SampleRate to 48000.", rate as f32 / 1000.0));
                }
                let nv_can = !stereo && available() && rate == RATE;
                let mut nv_ok = ch.on && nv_can;
                let mut aec_ok = ch.aec && nv_can;
                if aec_ok && !ref_ok {
                    aec_ok = false;
                    notes.push("Pick the output your speakers are on.".into());
                }
                if aec_ok && !out_free {
                    aec_ok = false;
                    if let Some((who, _)) = &out_blocked {
                        notes.push(format!("{who} is using Voicemeeter's output insert, so speaker echo removal is off."));
                    }
                }
                if let Some((k, why, at)) = &failed[lane] {
                    if at.elapsed() < Duration::from_secs(60) {
                        if k.effect.is_some() && nv_ok {
                            nv_ok = false;
                        }
                        if k.aec && aec_ok {
                            aec_ok = false;
                        }
                        notes.push(why.clone());
                    }
                }
                let need = !off
                    && channel != usize::MAX
                    && callback_ok
                    && vm_up
                    && (nv_ok || aec_ok || plugins_on > 0);

                // (Re)start the worker for this chain.
                let key = WorkerKey {
                    effect: nv_ok.then(|| ch.effect.clone()),
                    aec: aec_ok,
                    rate,
                    stereo,
                    channel,
                    output,
                };
                if !need {
                    workers[lane] = None;
                } else if workers[lane].as_ref().map(|w| &w.key) != Some(&key) {
                    workers[lane] = None;
                    match Worker::start(lane, key.clone(), strengths[lane].clone()) {
                        Ok(w) => {
                            log_info!(
                                "Mic clean-up: {} running (NVIDIA {:?}, echo {}, {} Hz, frame {})",
                                ch.target,
                                key.effect,
                                key.aec,
                                rate,
                                l.frame.load(Ordering::Relaxed)
                            );
                            workers[lane] = Some(w);
                        }
                        Err(e) => {
                            log_warn!("Mic clean-up: {e}");
                            failed[lane] = Some((key.clone(), e, Instant::now()));
                        }
                    }
                }
                let running = need && workers[lane].is_some();
                l.active.store(running, Ordering::Release);
                if output {
                    any_out |= running;
                } else {
                    any_in |= running;
                }
                any_aec |= running && key.aec;

                // What Settings says about this mic, chat input or output.
                let label = api
                    .get_string(&format!("{}.Label", ch.target))
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| match (ch.strip, bus_index(&ch.target)) {
                        (Some(i), _) => format!("Input {}", i + 1),
                        (_, Some(j)) => format!("Output {}", j + 1),
                        _ => "this channel".into(),
                    });
                let mut what: Vec<String> = Vec::new();
                if key.aec {
                    what.push("speaker echo removal".into());
                }
                if let Some(e) = &key.effect {
                    let name = EFFECTS
                        .iter()
                        .find(|(k, _)| k == e)
                        .map_or("", |(_, n)| *n)
                        .to_lowercase();
                    what.push(name);
                }
                if !what.is_empty() {
                    let last = what.pop().unwrap_or_default();
                    let mut joined = what.join(", ");
                    if !joined.is_empty() {
                        joined.push_str(" and ");
                    }
                    joined.push_str(&last);
                    what = vec![format!("{joined} on your NVIDIA GPU")];
                }
                if plugins_on > 0 {
                    what.push(if plugins_on == 1 {
                        "1 plugin".to_string()
                    } else {
                        format!("{plugins_on} plugins")
                    });
                }
                let message = if off {
                    "Switched off (by a shortcut, the Stream Deck, the phone, chat or a scene)."
                        .to_string()
                } else if running {
                    let mut m = if output {
                        format!("Running on {label}: {}.", what.join(" and "))
                    } else {
                        format!("Cleaning up {label}: {}.", what.join(" and "))
                    };
                    if !notes.is_empty() {
                        m = format!("{m} {}", notes.join(" "));
                    }
                    m
                } else {
                    notes.join(" ")
                };
                chain_status.insert(
                    ch.id.clone(),
                    json!({
                        "running": running,
                        "off": off,
                        "message": message,
                        "latencyMs": if running { (latency_ms(sh, l) * 10.0).round() / 10.0 } else { 0.0 },
                        "underruns": l.underruns.load(Ordering::Relaxed),
                    }),
                );
            }

            // Join (or leave) Voicemeeter's inserts: inputs for anything on an input, outputs for
            // echo removal, plugins on outputs, and EQ or levelling on an output.
            let mut global = String::new();
            let need_in =
                (any_in
                    || any_aec
                    || fx_in
                    || crate::replay::tracks_want_insert()
                    || crate::coach::want_insert())
                    && vm_up;
            let need_out = (any_out || any_aec || (fx_out && out_free)) && vm_up;
            let want_mode = (if need_in {
                crate::vm::AUDIOCALLBACK_IN
            } else {
                0
            }) | (if need_out {
                crate::vm::AUDIOCALLBACK_OUT
            } else {
                0
            });
            if !callback_ok {
                global = "This Voicemeeter is too old for mic clean-up. Update Voicemeeter.".into();
            } else if !vm_up {
                global = "Waiting for Voicemeeter".into();
            }
            if want_mode == 0 {
                unregister(&api);
            } else {
                if REG_MODE.load(Ordering::Acquire) != want_mode {
                    unregister(&api);
                    match api.audio_register(want_mode, audio_callback) {
                        Ok(()) => {
                            REG_MODE.store(want_mode, Ordering::Release);
                            let r = api.audio_start();
                            log_info!("Mic clean-up: joined Voicemeeter's audio insert (mode {want_mode}, start {r})");
                            seen = (sh.buffers.load(Ordering::Relaxed), Instant::now());
                        }
                        Err(Some(other)) if want_mode & crate::vm::AUDIOCALLBACK_OUT != 0 => {
                            // Probably the output insert is taken: echo removal waits, the rest runs.
                            log_warn!("Mic clean-up: {other} holds Voicemeeter's insert; trying without echo removal");
                            out_blocked = Some((other, Instant::now()));
                        }
                        Err(Some(other)) => {
                            global = format!("{other} is already using Voicemeeter's audio insert. Close it to use mic clean-up.");
                            for l in &sh.lanes {
                                l.active.store(false, Ordering::Release);
                            }
                        }
                        Err(None) => {
                            global =
                                "Voicemeeter didn't let Sleekmeeter into its audio insert".into();
                        }
                    }
                }
                if sh.restart.swap(false, Ordering::AcqRel) {
                    api.audio_stop();
                    api.audio_start();
                    log_info!("Mic clean-up: Voicemeeter's audio changed; restarted the insert");
                }
                // Voicemeeter stopped calling (restarted, engine reset): join again.
                let n = sh.buffers.load(Ordering::Relaxed);
                if n != seen.0 {
                    seen = (n, Instant::now());
                } else if REG_MODE.load(Ordering::Acquire) != 0
                    && seen.1.elapsed() > Duration::from_secs(3)
                {
                    log_info!("Mic clean-up: Voicemeeter stopped sending audio; joining again");
                    unregister(&api);
                    seen = (n, Instant::now());
                }
            }
            if !global.is_empty() {
                for v in chain_status.values_mut() {
                    v["running"] = json!(false);
                    if !v["off"].as_bool().unwrap_or(false) {
                        v["message"] = json!(global);
                    }
                }
            }
            // Listening EQ and leveller: running once Sleekmeeter is in the right insert.
            let mode = REG_MODE.load(Ordering::Acquire);
            let mut fx_status = serde_json::Map::new();
            for w in &fx {
                let bit = if w.output {
                    crate::vm::AUDIOCALLBACK_OUT
                } else {
                    crate::vm::AUDIOCALLBACK_IN
                };
                let running = global.is_empty() && mode & bit != 0;
                let message = if running {
                    String::new()
                } else if !global.is_empty() {
                    global.clone()
                } else if w.output && !out_free {
                    out_blocked.as_ref().map_or_else(String::new, |(who, _)| {
                        format!(
                            "{who} is using Voicemeeter's output insert, so this is off for now."
                        )
                    })
                } else {
                    "Starting…".into()
                };
                fx_status.insert(
                    w.target.clone(),
                    json!({ "running": running, "message": message }),
                );
            }
            *STATUS.lock().unwrap() = json!({
                "available": available(),
                "message": global,
                "chains": Value::Object(chain_status),
                "soundFx": Value::Object(fx_status),
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_keeps_order_and_refuses_overflow() {
        let q = Queue::new(8);
        assert!(q.push(&[1.0, 2.0, 3.0]));
        assert!(!q.push(&[0.0; 6]));
        let mut out = [0f32; 2];
        assert!(q.pop(&mut out));
        assert_eq!(out, [1.0, 2.0]);
        assert!(q.push(&[4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]));
        let mut out = [0f32; 8];
        assert!(q.pop(&mut out));
        assert_eq!(out, [3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]);
        assert!(!q.pop(&mut [0f32; 1]));
    }

    #[test]
    fn insert_slots_for_mics_chat_inputs_and_outputs() {
        let banana = crate::vm::Layout::for_edition(2); // 3 hardware inputs, 2 virtual, 5 buses
        assert_eq!(insert_slot("Strip[0]", &banana), Some((0, false)));
        assert_eq!(insert_slot("Strip[2]", &banana), Some((4, false)));
        // Virtual inputs start after the hardware inputs' pairs, 8 channels each.
        assert_eq!(insert_slot("Strip[3]", &banana), Some((6, false)));
        assert_eq!(insert_slot("Strip[4]", &banana), Some((14, false)));
        assert_eq!(insert_slot("Strip[5]", &banana), None);
        assert_eq!(insert_slot("Bus[0]", &banana), Some((0, true)));
        assert_eq!(insert_slot("Bus[4]", &banana), Some((32, true)));
        assert_eq!(insert_slot("Bus[5]", &banana), None);
    }

    /// Needs NVIDIA's runtime and an RTX GPU: `cargo test nvidia -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn nvidia_denoiser_removes_noise() {
        let mut e = nv::Effect::new("denoiser", RATE, DEFAULT_FRAME).expect("load");
        let frame = e.frame;
        println!("frame {frame}");
        // Two seconds of white noise (a simple LCG), nothing else: it should mostly go.
        let mut seed = 12345u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
        };
        let (mut pin, mut pout) = (0f64, 0f64);
        let mut out = vec![0f32; frame];
        let t = Instant::now();
        let frames = 2 * RATE as usize / frame;
        for k in 0..frames {
            let inp: Vec<f32> = (0..frame).map(|_| rnd() * 0.1).collect();
            e.run(&inp, &mut out).expect("run");
            if k > frames / 2 {
                pin += inp.iter().map(|v| (v * v) as f64).sum::<f64>();
                pout += out.iter().map(|v| (v * v) as f64).sum::<f64>();
            }
        }
        let per = t.elapsed().as_secs_f64() * 1000.0 / frames as f64;
        let db = 10.0 * (pout / pin).log10();
        println!("noise change {db:.1} dB, {per:.2} ms per 10 ms frame");
        assert!(db < -10.0, "noise only changed by {db:.1} dB");
        assert!(per < 10.0, "too slow for real time: {per:.2} ms");
    }

    #[test]
    #[ignore]
    fn nvidia_effects_all_load() {
        for (sel, _) in EFFECTS {
            let mut e = nv::Effect::new(sel, RATE, DEFAULT_FRAME).expect(sel);
            e.set_strength(0.5);
            let mut out = vec![0f32; e.frame];
            e.run(&vec![0.01f32; e.frame], &mut out).expect(sel);
            println!("{sel}: frame {}", e.frame);
        }
    }
}

#[cfg(test)]
mod aec_probe {
    use super::*;

    /// Needs NVIDIA's runtime: speaker sound that leaks into the mic should mostly go.
    #[test]
    #[ignore]
    fn nvidia_aec_removes_speaker_echo() {
        let mut e = nv::Effect::new("aec", RATE, DEFAULT_FRAME).expect("load aec");
        let frame = e.frame;
        let mut seed = 777u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
        };
        // Speaker: music-like noise. Mic: the same, 15 ms later and quieter (the room).
        let total = 6 * RATE as usize;
        let far: Vec<f32> = (0..total).map(|_| rnd() * 0.2).collect();
        let delay = 720;
        let near: Vec<f32> = (0..total)
            .map(|k| {
                if k >= delay {
                    far[k - delay] * 0.5
                } else {
                    0.0
                }
            })
            .collect();
        let (mut pin, mut pout) = (0f64, 0f64);
        let mut out = vec![0f32; frame];
        for (k, (n, f)) in near.chunks(frame).zip(far.chunks(frame)).enumerate() {
            if n.len() < frame {
                break;
            }
            e.run_aec(n, f, &mut out).expect("run");
            if k * frame > total / 2 {
                pin += n.iter().map(|v| (v * v) as f64).sum::<f64>();
                pout += out.iter().map(|v| (v * v) as f64).sum::<f64>();
            }
        }
        let db = 10.0 * (pout / pin).log10();
        println!("frame {frame}, echo change {db:.1} dB");
        assert!(db < -10.0, "echo only changed by {db:.1} dB");
    }
}
