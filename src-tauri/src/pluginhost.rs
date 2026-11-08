//! VST3 plugins run in a second Sleekmeeter process (`sleekmeeter.exe --plugin-host <pid>`), so
//! a plugin that crashes takes only that process down: the mic carries on (NVIDIA's clean-up
//! included), Settings says what happened, and the host starts again.
//!
//! Control goes over the child's stdin/stdout as JSON lines: requests {"id","cmd",...} answered
//! with {"id","ok"} or {"id","err"}, and events like {"event":"state","id","c","e"} when a
//! plugin's settings change. Audio goes through shared memory, one block per mic (lane): the
//! worker writes a frame, signals "req", and waits a few milliseconds for "done".
//!
//! The child is the same exe; main() hands over to `child_main` before Tauri starts.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Most mics with their own chain (Potato has 5 hardware inputs).
pub const LANES: usize = 5;
const MAX: usize = 4096;
/// How long the worker waits for the plugins on one frame before carrying on without them.
const WAIT_MS: u32 = 6;

/* ---------- shared memory and events, one set per lane ---------- */

#[repr(C)]
struct Shm {
    /// Frames asked for and done; the data is handed over with Release/Acquire on these.
    req: AtomicU32,
    done: AtomicU32,
    n: AtomicU32,
    stereo: AtomicBool,
    processing: AtomicU32,
    data: [f32; MAX],
}

struct Lane {
    shm: *mut Shm,
    req: isize,
    done: isize,
}

unsafe impl Send for Lane {}
unsafe impl Sync for Lane {}

fn open_lanes(parent: u32) -> Option<Vec<Lane>> {
    (0..LANES).map(|i| sys::lane(parent, i)).collect()
}

/* ---------- Sleekmeeter's side ---------- */

struct Host {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, Sender<Result<Value, String>>>>,
    next: AtomicU64,
    stopping: AtomicBool,
}

static HOST: Mutex<Option<Arc<Host>>> = Mutex::new(None);
/// The host is up and its lanes can be used (read every frame, so not behind a lock).
static ALIVE: AtomicBool = AtomicBool::new(false);
static QUITTING: AtomicBool = AtomicBool::new(false);
static CRASHES: Mutex<Vec<Instant>> = Mutex::new(Vec::new());
static LAST_ERROR: Mutex<String> = Mutex::new(String::new());
static BYPASSED: Mutex<Vec<String>> = Mutex::new(Vec::new());
static CANDIDATES: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
static RECOVERY_MESSAGE: Mutex<String> = Mutex::new(String::new());
/// What the host was last told: (plugins without their saved settings, rate). Reset on restart.
static SENT: Mutex<Option<(Vec<crate::vst::Want>, u32)>> = Mutex::new(None);
static SENT_AT: Mutex<Option<Instant>> = Mutex::new(None);
static STATUS: Mutex<Value> = Mutex::new(Value::Null);

type Events = Box<dyn Fn(Value) + Send + Sync>;
static EVENTS: OnceLock<Events> = OnceLock::new();

fn lanes() -> &'static [Lane] {
    static L: OnceLock<Vec<Lane>> = OnceLock::new();
    L.get_or_init(|| open_lanes(std::process::id()).unwrap_or_default())
}

/// Where plugin events go (micfx saves plugin settings from them).
pub fn on_event(f: Events) {
    let _ = EVENTS.set(f);
}

pub fn restore_quarantine(saved: &Value) {
    *BYPASSED.lock().unwrap() = saved
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    if !BYPASSED.lock().unwrap().is_empty() {
        *RECOVERY_MESSAGE.lock().unwrap() =
            "Previously bypassed plugins are still isolated. Select a plugin to retry it.".into();
    }
}

fn save_quarantine(ids: &[String]) {
    if let Some(emit) = EVENTS.get() {
        emit(json!({ "event": "quarantine", "ids": ids }));
    }
}

fn start() -> Result<Arc<Host>, String> {
    static START: Mutex<()> = Mutex::new(());
    let _starting = START.lock().unwrap();
    if let Some(h) = HOST.lock().unwrap().as_ref() {
        if ALIVE.load(Ordering::Acquire) {
            return Ok(h.clone());
        }
    }
    {
        let mut c = CRASHES.lock().unwrap();
        c.retain(|t| t.elapsed() < Duration::from_secs(120));
        if c.len() >= 3 {
            return Err(LAST_ERROR.lock().unwrap().clone());
        }
    }
    if lanes().len() != LANES {
        return Err("Couldn't set up audio for the plugin host".into());
    }
    for lane in lanes() {
        unsafe { (*lane.shm).processing.store(0, Ordering::Release) };
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.arg("--plugin-host")
        .arg(std::process::id().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start the plugin host: {e}"))?;
    let stdin = child.stdin.take().ok_or("No pipe to the plugin host")?;
    let stdout = child.stdout.take().ok_or("No pipe from the plugin host")?;
    let host = Arc::new(Host {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
        next: AtomicU64::new(1),
        stopping: AtomicBool::new(false),
    });
    *SENT.lock().unwrap() = None;
    *HOST.lock().unwrap() = Some(host.clone());
    ALIVE.store(true, Ordering::Release);
    log_info!("Plugins: started the plugin host");

    let reader = host.clone();
    std::thread::Builder::new()
        .name("plugin-host-reader".into())
        .spawn(move || {
            let mut loading = None;
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = v["id"].as_u64() {
                    if let Some(tx) = reader.pending.lock().unwrap().remove(&id) {
                        let r = match v.get("err").and_then(Value::as_str) {
                            Some(e) => Err(e.to_string()),
                            None => Ok(v["ok"].clone()),
                        };
                        let _ = tx.send(r);
                    }
                } else if v["event"] == "loading" {
                    loading = v["plugin"].as_str().map(str::to_owned);
                } else if v.get("event").is_some() {
                    if let Some(f) = EVENTS.get() {
                        f(v);
                    }
                }
            }
            // The pipe closed: the host quit or crashed.
            let code = reader
                .child
                .lock()
                .unwrap()
                .wait()
                .ok()
                .and_then(|s| s.code());
            if !reader.stopping.load(Ordering::Acquire) && !QUITTING.load(Ordering::Acquire) {
                record_crash(loading);
                let msg = "The plugin host stopped, probably because a plugin crashed. Your mic carries on without plugins; Sleekmeeter tries them again.".to_string();
                log_warn!("Plugins: the plugin host stopped (exit code {code:?})");
                CRASHES.lock().unwrap().push(Instant::now());
                *LAST_ERROR.lock().unwrap() = "The plugin host stopped 3 times in 2 minutes, so plugins are off for now. Switch off or remove the plugin that crashes; they start again 2 minutes after the last crash.".to_string();
                set_error(&msg);
            }
            if HOST.lock().unwrap().as_ref().is_some_and(|h| Arc::ptr_eq(h, &reader)) {
                ALIVE.store(false, Ordering::Release);
            }
            for (_, tx) in reader.pending.lock().unwrap().drain() {
                let _ = tx.send(Err("The plugin host stopped".into()));
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(host)
}

fn set_error(msg: &str) {
    let mut s = STATUS.lock().unwrap();
    if let Some(m) = s.as_object_mut() {
        for v in m.values_mut() {
            *v = json!({ "loaded": false, "error": msg, "editor": false });
        }
    }
}

fn request(cmd: Value, timeout: Duration) -> Result<Value, String> {
    let host = start()?;
    request_on(&host, cmd, timeout)
}

fn request_on(host: &Host, cmd: Value, timeout: Duration) -> Result<Value, String> {
    let id = host.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = channel();
    host.pending.lock().unwrap().insert(id, tx);
    let mut msg = cmd;
    msg["id"] = json!(id);
    {
        let mut w = host.stdin.lock().unwrap();
        if writeln!(w, "{msg}").and_then(|_| w.flush()).is_err() {
            host.pending.lock().unwrap().remove(&id);
            return Err("The plugin host stopped".into());
        }
    }
    match rx.recv_timeout(timeout) {
        Ok(r) => r,
        Err(_) => {
            host.pending.lock().unwrap().remove(&id);
            Err("The plugin host took too long to answer".into())
        }
    }
}

/// Load, unload and order plugins on every mic to match Settings, at `rate` Hz.
/// Called twice a second; only sends the list (with saved settings) when it changed.
pub fn sync(mut want: Vec<crate::vst::Want>, rate: u32) {
    *CANDIDATES.lock().unwrap() = want
        .iter()
        .map(|w| (w.id.clone(), w.name.clone()))
        .collect();
    {
        let mut bypassed = BYPASSED.lock().unwrap();
        let before = bypassed.len();
        bypassed.retain(|id| want.iter().any(|w| &w.id == id));
        if bypassed.len() != before {
            save_quarantine(&bypassed);
        }
        want.retain(|w| !bypassed.contains(&w.id));
    }
    let running = HOST.lock().unwrap().is_some() && ALIVE.load(Ordering::Acquire);
    if want.is_empty() && !running {
        *STATUS.lock().unwrap() = json!({});
        return;
    }
    // (Re)start first: a new host has nothing loaded, so it must get the whole list.
    let host = match start() {
        Ok(host) => host,
        Err(e) => {
            let mut st = serde_json::Map::new();
            for w in &want {
                st.insert(
                    w.id.clone(),
                    json!({ "loaded": false, "error": e, "editor": false }),
                );
            }
            *STATUS.lock().unwrap() = Value::Object(st);
            return;
        }
    };
    let bare: Vec<crate::vst::Want> = want
        .iter()
        .map(|w| crate::vst::Want {
            c: String::new(),
            e: String::new(),
            ..w.clone()
        })
        .collect();
    let changed = SENT.lock().unwrap().as_ref() != Some(&(bare.clone(), rate));
    let due = SENT_AT
        .lock()
        .unwrap()
        .is_none_or(|t| t.elapsed() > Duration::from_secs(2));
    if !changed && !due {
        return;
    }
    let cmd = if changed {
        json!({ "cmd": "sync", "want": want, "rate": rate })
    } else {
        json!({ "cmd": "tick" })
    };
    match request_on(&host, cmd, Duration::from_secs(90)) {
        Ok(st) => {
            *STATUS.lock().unwrap() = st;
            *SENT.lock().unwrap() = Some((bare, rate));
            *SENT_AT.lock().unwrap() = Some(Instant::now());
        }
        Err(e) => {
            let mut st = serde_json::Map::new();
            for w in &want {
                st.insert(
                    w.id.clone(),
                    json!({ "loaded": false, "error": e, "editor": false }),
                );
            }
            *STATUS.lock().unwrap() = Value::Object(st);
        }
    }
    if want.is_empty() {
        stop();
    }
}

/// `{ id: { loaded, error, editor } }` for Settings.
pub fn status() -> Value {
    let mut s = STATUS.lock().unwrap().clone();
    if s.is_null() {
        s = json!({});
    }
    for id in BYPASSED.lock().unwrap().iter() {
        s[id] = json!({ "loaded": false, "error": "Bypassed for recovery", "editor": false, "bypassed": true });
    }
    s
}

pub fn recovery() -> Value {
    json!({ "message": RECOVERY_MESSAGE.lock().unwrap().clone() })
}

pub fn recover_plugin(id: &str, bypass: bool) -> Result<(), String> {
    if !CANDIDATES.lock().unwrap().iter().any(|(key, _)| key == id) {
        return Err("This plugin is no longer in the mic chain".into());
    }
    let mut list = BYPASSED.lock().unwrap();
    list.retain(|key| key != id);
    if bypass {
        list.push(id.to_owned());
    }
    save_quarantine(&list);
    drop(list);
    CRASHES.lock().unwrap().clear();
    Ok(())
}

pub(crate) fn plugin_token(id: &str) -> u32 {
    id.bytes()
        .fold(2_166_136_261u32, |hash, byte| {
            (hash ^ u32::from(byte)).wrapping_mul(16_777_619)
        })
        .max(1)
}

fn record_crash(loading: Option<String>) {
    let mut suspects: Vec<String> = loading.into_iter().collect();
    let candidates = CANDIDATES.lock().unwrap();
    for lane in lanes() {
        let token = unsafe { (*lane.shm).processing.swap(0, Ordering::AcqRel) };
        if token == 0 {
            continue;
        }
        let mut matches = candidates
            .iter()
            .filter(|(id, _)| plugin_token(id) == token);
        if let Some((id, _)) = matches.next() {
            if matches.next().is_none() && !suspects.contains(id) {
                suspects.push(id.clone());
            }
        }
    }
    let names: Vec<_> = candidates
        .iter()
        .filter(|(id, _)| suspects.contains(id))
        .map(|(_, name)| name.as_str())
        .collect();
    *RECOVERY_MESSAGE.lock().unwrap() = if names.is_empty() {
        "The host stopped outside a tracked load or audio call. You can bypass a plugin before retrying.".into()
    } else {
        format!("The host stopped while these plugins were loading or processing. Bypassed for recovery: {}.", names.join(", "))
    };
    let mut bypassed = BYPASSED.lock().unwrap();
    for id in suspects {
        if !bypassed.contains(&id) {
            bypassed.push(id);
        }
    }
    save_quarantine(&bypassed);
}

pub fn scan() -> Result<Vec<Value>, String> {
    let v = request(json!({ "cmd": "scan" }), Duration::from_secs(180))?;
    Ok(v.as_array().cloned().unwrap_or_default())
}

pub fn describe(path: String) -> Result<Vec<Value>, String> {
    let v = request(
        json!({ "cmd": "describe", "path": path }),
        Duration::from_secs(60),
    )?;
    Ok(v.as_array().cloned().unwrap_or_default())
}

pub fn open_editor(id: String) -> Result<(), String> {
    // Sleekmeeter is in front (Edit was just clicked); let the host bring its window forward,
    // which Windows otherwise stops a background process from doing.
    if let Ok(h) = start() {
        let pid = h.child.lock().unwrap().id();
        sys::allow_foreground(pid);
    }
    request(
        json!({ "cmd": "editor", "plugin": id }),
        Duration::from_secs(60),
    )
    .map(|_| ())
}

pub fn get_state(id: String) -> Result<Value, String> {
    request(
        json!({ "cmd": "getState", "plugin": id }),
        Duration::from_secs(30),
    )
}

pub fn set_state(id: String, c: String, e: String) -> Result<(), String> {
    request(
        json!({ "cmd": "setState", "plugin": id, "c": c, "e": e }),
        Duration::from_secs(30),
    )
    .map(|_| ())
}

/// Close the plugin host (plugins save their settings first).
fn stop() {
    let Some(host) = HOST.lock().unwrap().clone() else {
        return;
    };
    QUITTING.store(true, Ordering::Release);
    host.stopping.store(true, Ordering::Release);
    if ALIVE.load(Ordering::Acquire) {
        let _ = request_on(&host, json!({ "cmd": "shutdown" }), Duration::from_secs(10));
    }
    if let Some(h) = HOST.lock().unwrap().take() {
        let _ = h.child.lock().unwrap().kill();
    }
    ALIVE.store(false, Ordering::Release);
    *SENT.lock().unwrap() = None;
    QUITTING.store(false, Ordering::Release);
    log_info!("Plugins: closed the plugin host");
}

/// Quitting Sleekmeeter.
pub fn shutdown() {
    stop();
}

/// Run one mic's plugins over a frame (micfx's worker thread). Without the host, or if it
/// doesn't answer in time, the frame goes on unchanged.
pub fn process(lane: usize, buf: &mut [f32], stereo: bool) {
    if !ALIVE.load(Ordering::Acquire) || lane >= LANES || buf.len() > MAX {
        return;
    }
    let Some(l) = lanes().get(lane) else { return };
    let s = unsafe { &mut *l.shm };
    let n = buf.len();
    // Still busy with an old frame (stuck or crashed plugin): don't wait again.
    if s.done.load(Ordering::Acquire) != s.req.load(Ordering::Acquire) {
        return;
    }
    s.data[..n].copy_from_slice(&buf[..n]);
    s.n.store(n as u32, Ordering::Relaxed);
    s.stereo.store(stereo, Ordering::Relaxed);
    let seq = s.req.load(Ordering::Relaxed).wrapping_add(1);
    s.req.store(seq, Ordering::Release);
    sys::signal(l.req);
    let until = Instant::now() + Duration::from_millis(WAIT_MS as u64);
    loop {
        if s.done.load(Ordering::Acquire) == seq {
            buf[..n].copy_from_slice(&s.data[..n]);
            return;
        }
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        sys::wait(l.done, left.as_millis().max(1) as u32);
    }
}

/* ---------- the plugin host process ---------- */

/// `sleekmeeter.exe --plugin-host <pid>`: host plugins for Sleekmeeter until it goes away.
pub fn child_main(parent: u32) -> ! {
    log_info!("Plugin host started for Sleekmeeter (process {parent})");
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let send = {
        let out = out.clone();
        move |v: Value| {
            let mut o = out.lock().unwrap();
            let _ = writeln!(o, "{v}");
            let _ = o.flush();
        }
    };
    let events = send.clone();
    crate::vst::set_sink(Box::new(move |v| events(v)));

    // One audio thread per mic.
    if let Some(lanes) = open_lanes(parent) {
        for (i, l) in lanes.into_iter().enumerate() {
            std::thread::Builder::new()
                .name(format!("plugins-lane-{i}"))
                .spawn(move || {
                    let l = l; // the whole Lane (Send), not just its pointer
                    sys::raise_priority();
                    let s = unsafe { &mut *l.shm };
                    // A previous host can die before acknowledging a frame. Consume the
                    // pending sequence once so the parent can submit audio again.
                    let mut last = s.done.load(Ordering::Acquire);
                    loop {
                        let r = s.req.load(Ordering::Acquire);
                        if r == last {
                            sys::wait(l.req, 500);
                            continue;
                        }
                        last = r;
                        let n = (s.n.load(Ordering::Relaxed) as usize).min(MAX);
                        crate::vst::process(
                            i,
                            &mut s.data[..n],
                            s.stereo.load(Ordering::Relaxed),
                            &s.processing,
                        );
                        s.done.store(r, Ordering::Release);
                        sys::signal(l.done);
                    }
                })
                .ok();
        }
    } else {
        log_error!("Plugin host: couldn't open the audio lanes");
    }

    // Requests, each on its own thread (the plugin UI thread keeps them in order).
    let last_want: Arc<Mutex<(Vec<crate::vst::Want>, u32)>> =
        Arc::new(Mutex::new((Vec::new(), 48_000)));
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(req) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let send = send.clone();
        let last_want = last_want.clone();
        let quit = req["cmd"] == "shutdown";
        let work = move || {
            let id = req["id"].clone();
            let s = |k: &str| req[k].as_str().unwrap_or("").to_string();
            let r: Result<Value, String> = match req["cmd"].as_str().unwrap_or("") {
                "sync" => {
                    let want: Vec<crate::vst::Want> =
                        serde_json::from_value(req["want"].clone()).unwrap_or_default();
                    let rate = req["rate"].as_u64().unwrap_or(48_000) as u32;
                    crate::vst::sync(want.clone(), rate);
                    // Saved settings are only needed once, when a plugin loads.
                    let bare = want
                        .into_iter()
                        .map(|w| crate::vst::Want {
                            c: String::new(),
                            e: String::new(),
                            ..w
                        })
                        .collect();
                    *last_want.lock().unwrap() = (bare, rate);
                    Ok(crate::vst::status())
                }
                "tick" => {
                    let (w, rate) = last_want.lock().unwrap().clone();
                    crate::vst::sync(w, rate);
                    Ok(crate::vst::status())
                }
                "scan" => crate::vst::scan().map(Value::from),
                "describe" => crate::vst::describe(s("path")).map(Value::from),
                "editor" => crate::vst::open_editor(s("plugin")).map(|_| Value::Null),
                "getState" => crate::vst::get_state(s("plugin")),
                "setState" => {
                    crate::vst::set_state(s("plugin"), s("c"), s("e")).map(|_| Value::Null)
                }
                "shutdown" => {
                    crate::vst::shutdown();
                    Ok(Value::Null)
                }
                other => Err(format!("Unknown request {other:?}")),
            };
            send(match r {
                Ok(v) => json!({ "id": id, "ok": v }),
                Err(e) => json!({ "id": id, "err": e }),
            });
        };
        if quit {
            work();
            break;
        }
        std::thread::spawn(work);
    }
    // Sleekmeeter went away (or asked us to stop): save what we can and go.
    crate::vst::shutdown();
    log_info!("Plugin host stopped");
    std::process::exit(0);
}

/* ---------- Windows ---------- */

#[cfg(windows)]
mod sys {
    use super::{Lane, Shm, LANES};
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Memory::{
        CreateFileMappingW, MapViewOfFile, FILE_MAP_ALL_ACCESS, PAGE_READWRITE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, GetCurrentThread, SetEvent, SetThreadPriority, WaitForSingleObject,
        THREAD_PRIORITY_HIGHEST,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Create (or open, in the child) one lane's shared block and events.
    pub fn lane(parent: u32, i: usize) -> Option<Lane> {
        debug_assert!(i < LANES);
        let base = format!("Local\\Sleekmeeter-{parent}-plugins-{i}");
        let size = std::mem::size_of::<Shm>();
        unsafe {
            let map = CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                std::ptr::null(),
                PAGE_READWRITE,
                0,
                size as u32,
                wide(&base).as_ptr(),
            );
            if map.is_null() {
                return None;
            }
            let view = MapViewOfFile(map, FILE_MAP_ALL_ACCESS, 0, 0, size);
            if view.Value.is_null() {
                return None;
            }
            let req = CreateEventW(
                std::ptr::null(),
                0,
                0,
                wide(&format!("{base}-req")).as_ptr(),
            );
            let done = CreateEventW(
                std::ptr::null(),
                0,
                0,
                wide(&format!("{base}-done")).as_ptr(),
            );
            if req.is_null() || done.is_null() {
                return None;
            }
            // The mapping and events stay open for the life of the process.
            Some(Lane {
                shm: view.Value as *mut Shm,
                req: req as isize,
                done: done as isize,
            })
        }
    }

    pub fn signal(h: isize) {
        unsafe { SetEvent(h as _) };
    }

    pub fn wait(h: isize, ms: u32) {
        unsafe { WaitForSingleObject(h as _, ms) };
    }

    pub fn allow_foreground(pid: u32) {
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(pid) };
    }

    pub fn raise_priority() {
        unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST) };
    }
}

#[cfg(not(windows))]
mod sys {
    use super::Lane;
    pub fn lane(_parent: u32, _i: usize) -> Option<Lane> {
        None
    }
    pub fn signal(_h: isize) {}
    pub fn wait(_h: isize, ms: u32) {
        std::thread::sleep(std::time::Duration::from_millis(ms as u64));
    }
    pub fn raise_priority() {}
    pub fn allow_foreground(_pid: u32) {}
}
