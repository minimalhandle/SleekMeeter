//! VST3 plugins on the mic: a small VST3 host for the mic clean-up insert (micfx.rs).
//!
//! Plugins run after NVIDIA's clean-up, in the order the user put them, on micfx's worker thread
//! (never on Voicemeeter's audio thread). Everything else a plugin does (loading, its editor
//! window, saving its settings) happens on one "plugin UI" thread with its own Windows message
//! loop, because plugins expect their controller and editor on a single UI thread.
//!
//! Plugins get the mic as mono (or the same signal on both sides of a stereo bus); a stereo
//! plugin's two output channels are averaged back to mono. Their settings are saved in
//! settings.json under "vstState" (Rust-owned, like the window position).
//!
//! VST3 only (the VST3 SDK is MIT-licensed); plugins are never bundled or downloaded. A plugin
//! that crashes takes Sleekmeeter with it, so plugins load only once added in Settings.

use base64::Engine as _;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use vst3::Steinberg as sb;
use vst3::Steinberg::Vst as vs;
use vst3::Steinberg::Vst::{
    IAttributeListTrait, IAudioProcessorTrait, IComponentHandlerTrait, IComponentTrait,
    IConnectionPointTrait, IEditControllerTrait, IHostApplicationTrait, IMessageTrait,
    IParamValueQueueTrait, IParameterChangesTrait,
};
use vst3::Steinberg::{
    IBStreamTrait, IPlugFrameTrait, IPlugViewTrait, IPluginBaseTrait, IPluginFactory2Trait,
    IPluginFactoryTrait,
};
use vst3::{Class, ComPtr, ComWrapper, Interface};

const OK: sb::tresult = sb::kResultOk;

/* ---------- small helpers ---------- */

fn text(b: &[c_char]) -> String {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    let bytes: Vec<u8> = b[..end].iter().map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn hex(t: &sb::TUID) -> String {
    t.iter().map(|b| format!("{:02X}", *b as u8)).collect()
}

fn unhex(s: &str) -> Option<sb::TUID> {
    if s.len() != 32 {
        return None;
    }
    let mut t: sb::TUID = [0; 16];
    for (i, v) in t.iter_mut().enumerate() {
        *v = u8::from_str_radix(s.get(2 * i..2 * i + 2)?, 16).ok()? as sb::int8;
    }
    Some(t)
}

fn copy_wide(src: &str, dst: &mut [u16]) {
    let mut n = 0;
    for (d, s) in dst.iter_mut().zip(src.encode_utf16()) {
        *d = s;
        n += 1;
    }
    if let Some(end) = dst.get_mut(n.min(dst.len().saturating_sub(1))) {
        *end = 0;
    }
}

fn b64(v: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(v)
}

/* ---------- COM objects the host gives plugins ---------- */

struct HostApp;

impl Class for HostApp {
    type Interfaces = (vs::IHostApplication,);
}

impl IHostApplicationTrait for HostApp {
    unsafe fn getName(&self, name: *mut vs::String128) -> sb::tresult {
        copy_wide("Sleekmeeter", &mut *name);
        OK
    }

    unsafe fn createInstance(
        &self,
        cid: *mut sb::TUID,
        _iid: *mut sb::TUID,
        obj: *mut *mut c_void,
    ) -> sb::tresult {
        *obj = std::ptr::null_mut();
        let cid = &*(cid as *const [u8; 16]);
        if *cid == vs::IMessage::IID {
            let m = ComWrapper::new(Message {
                id: Mutex::new(CString::default()),
                attrs: ComWrapper::new(Attrs::default()),
            });
            if let Some(p) = m.to_com_ptr::<vs::IMessage>() {
                *obj = p.into_raw() as *mut c_void;
                return OK;
            }
        }
        if *cid == vs::IAttributeList::IID {
            let a = ComWrapper::new(Attrs::default());
            if let Some(p) = a.to_com_ptr::<vs::IAttributeList>() {
                *obj = p.into_raw() as *mut c_void;
                return OK;
            }
        }
        sb::kResultFalse
    }
}

/// Messages a plugin's processor and editor send each other (JUCE plugins rely on these).
struct Message {
    id: Mutex<CString>,
    attrs: ComWrapper<Attrs>,
}

impl Class for Message {
    type Interfaces = (vs::IMessage,);
}

impl IMessageTrait for Message {
    unsafe fn getMessageID(&self) -> sb::FIDString {
        self.id.lock().unwrap().as_ptr()
    }
    unsafe fn setMessageID(&self, id: sb::FIDString) {
        *self.id.lock().unwrap() = if id.is_null() {
            CString::default()
        } else {
            CStr::from_ptr(id).to_owned()
        };
    }
    unsafe fn getAttributes(&self) -> *mut vs::IAttributeList {
        self.attrs
            .as_com_ref::<vs::IAttributeList>()
            .map_or(std::ptr::null_mut(), |r| r.as_ptr())
    }
}

enum Attr {
    Int(i64),
    Float(f64),
    Str(Vec<u16>),
    Bin(Vec<u8>),
}

#[derive(Default)]
struct Attrs {
    map: Mutex<HashMap<Vec<u8>, Attr>>,
}

impl Class for Attrs {
    type Interfaces = (vs::IAttributeList,);
}

unsafe fn key(id: vs::IAttributeList_::AttrID) -> Vec<u8> {
    if id.is_null() {
        Vec::new()
    } else {
        CStr::from_ptr(id).to_bytes().to_vec()
    }
}

impl IAttributeListTrait for Attrs {
    unsafe fn setInt(&self, id: vs::IAttributeList_::AttrID, value: i64) -> sb::tresult {
        self.map.lock().unwrap().insert(key(id), Attr::Int(value));
        OK
    }
    unsafe fn getInt(&self, id: vs::IAttributeList_::AttrID, value: *mut i64) -> sb::tresult {
        match self.map.lock().unwrap().get(&key(id)) {
            Some(Attr::Int(v)) => {
                *value = *v;
                OK
            }
            _ => sb::kResultFalse,
        }
    }
    unsafe fn setFloat(&self, id: vs::IAttributeList_::AttrID, value: f64) -> sb::tresult {
        self.map.lock().unwrap().insert(key(id), Attr::Float(value));
        OK
    }
    unsafe fn getFloat(&self, id: vs::IAttributeList_::AttrID, value: *mut f64) -> sb::tresult {
        match self.map.lock().unwrap().get(&key(id)) {
            Some(Attr::Float(v)) => {
                *value = *v;
                OK
            }
            _ => sb::kResultFalse,
        }
    }
    unsafe fn setString(
        &self,
        id: vs::IAttributeList_::AttrID,
        string: *const vs::TChar,
    ) -> sb::tresult {
        let mut v = Vec::new();
        if !string.is_null() {
            let mut k = 0;
            while *string.add(k) != 0 {
                v.push(*string.add(k) as u16);
                k += 1;
            }
        }
        self.map.lock().unwrap().insert(key(id), Attr::Str(v));
        OK
    }
    unsafe fn getString(
        &self,
        id: vs::IAttributeList_::AttrID,
        string: *mut vs::TChar,
        size_in_bytes: u32,
    ) -> sb::tresult {
        match self.map.lock().unwrap().get(&key(id)) {
            Some(Attr::Str(v)) if !string.is_null() && size_in_bytes >= 2 => {
                let room = size_in_bytes as usize / 2 - 1;
                let n = v.len().min(room);
                for (k, c) in v[..n].iter().enumerate() {
                    *string.add(k) = *c as vs::TChar;
                }
                *string.add(n) = 0;
                OK
            }
            _ => sb::kResultFalse,
        }
    }
    unsafe fn setBinary(
        &self,
        id: vs::IAttributeList_::AttrID,
        data: *const c_void,
        size_in_bytes: u32,
    ) -> sb::tresult {
        let v = if data.is_null() {
            Vec::new()
        } else {
            std::slice::from_raw_parts(data as *const u8, size_in_bytes as usize).to_vec()
        };
        self.map.lock().unwrap().insert(key(id), Attr::Bin(v));
        OK
    }
    unsafe fn getBinary(
        &self,
        id: vs::IAttributeList_::AttrID,
        data: *mut *const c_void,
        size_in_bytes: *mut u32,
    ) -> sb::tresult {
        match self.map.lock().unwrap().get(&key(id)) {
            Some(Attr::Bin(v)) => {
                // Points into the list, which lives as long as the message (as in the SDK).
                *data = v.as_ptr() as *const c_void;
                *size_in_bytes = v.len() as u32;
                OK
            }
            _ => sb::kResultFalse,
        }
    }
}

/// A plugin's saved settings, in memory.
#[derive(Default)]
struct Stream {
    data: Mutex<(Vec<u8>, usize)>,
}

impl Class for Stream {
    type Interfaces = (sb::IBStream,);
}

impl IBStreamTrait for Stream {
    unsafe fn read(&self, buffer: *mut c_void, num: i32, read: *mut i32) -> sb::tresult {
        let mut d = self.data.lock().unwrap();
        let (data, pos) = &mut *d;
        let n = (num.max(0) as usize).min(data.len().saturating_sub(*pos));
        if n > 0 && !buffer.is_null() {
            std::ptr::copy_nonoverlapping(data.as_ptr().add(*pos), buffer as *mut u8, n);
        }
        *pos += n;
        if !read.is_null() {
            *read = n as i32;
        }
        OK
    }
    unsafe fn write(&self, buffer: *mut c_void, num: i32, written: *mut i32) -> sb::tresult {
        let mut d = self.data.lock().unwrap();
        let (data, pos) = &mut *d;
        let n = num.max(0) as usize;
        if buffer.is_null() {
            return sb::kInvalidArgument;
        }
        if data.len() < *pos + n {
            data.resize(*pos + n, 0);
        }
        std::ptr::copy_nonoverlapping(buffer as *const u8, data.as_mut_ptr().add(*pos), n);
        *pos += n;
        if !written.is_null() {
            *written = n as i32;
        }
        OK
    }
    unsafe fn seek(&self, pos: i64, mode: i32, result: *mut i64) -> sb::tresult {
        let mut d = self.data.lock().unwrap();
        let (data, at) = &mut *d;
        let base = match mode {
            m if m == sb::IBStream_::IStreamSeekMode_::kIBSeekCur as i32 => *at as i64,
            m if m == sb::IBStream_::IStreamSeekMode_::kIBSeekEnd as i32 => data.len() as i64,
            _ => 0,
        };
        *at = (base + pos).clamp(0, data.len() as i64) as usize;
        if !result.is_null() {
            *result = *at as i64;
        }
        OK
    }
    unsafe fn tell(&self, pos: *mut i64) -> sb::tresult {
        if !pos.is_null() {
            *pos = self.data.lock().unwrap().1 as i64;
        }
        OK
    }
}

fn stream(bytes: Vec<u8>) -> ComWrapper<Stream> {
    ComWrapper::new(Stream {
        data: Mutex::new((bytes, 0)),
    })
}

fn stream_ptr(s: &ComWrapper<Stream>) -> *mut sb::IBStream {
    s.as_com_ref::<sb::IBStream>()
        .map_or(std::ptr::null_mut(), |r| r.as_ptr())
}

/// Knob moves in a plugin's editor: queued for the audio side, and marks the settings to save.
struct Handler {
    pending: Arc<Mutex<Vec<(u32, f64)>>>,
    dirty: Arc<AtomicBool>,
}

impl Class for Handler {
    type Interfaces = (vs::IComponentHandler,);
}

impl IComponentHandlerTrait for Handler {
    unsafe fn beginEdit(&self, _id: vs::ParamID) -> sb::tresult {
        OK
    }
    unsafe fn performEdit(&self, id: vs::ParamID, value: vs::ParamValue) -> sb::tresult {
        let mut p = self.pending.lock().unwrap();
        match p.iter_mut().find(|(k, _)| *k == id) {
            Some(e) => e.1 = value,
            None => p.push((id, value)),
        }
        self.dirty.store(true, Ordering::Relaxed);
        OK
    }
    unsafe fn endEdit(&self, _id: vs::ParamID) -> sb::tresult {
        self.dirty.store(true, Ordering::Relaxed);
        OK
    }
    unsafe fn restartComponent(&self, _flags: i32) -> sb::tresult {
        self.dirty.store(true, Ordering::Relaxed);
        OK
    }
}

/// One block's parameter changes, one point each at the start of the block.
struct ParamQueue {
    id: u32,
    value: f64,
}

impl Class for ParamQueue {
    type Interfaces = (vs::IParamValueQueue,);
}

impl IParamValueQueueTrait for ParamQueue {
    unsafe fn getParameterId(&self) -> vs::ParamID {
        self.id
    }
    unsafe fn getPointCount(&self) -> i32 {
        1
    }
    unsafe fn getPoint(&self, index: i32, offset: *mut i32, value: *mut f64) -> sb::tresult {
        if index != 0 {
            return sb::kResultFalse;
        }
        *offset = 0;
        *value = self.value;
        OK
    }
    unsafe fn addPoint(&self, _offset: i32, _value: f64, _index: *mut i32) -> sb::tresult {
        sb::kResultFalse
    }
}

struct Changes {
    queues: Vec<ComWrapper<ParamQueue>>,
}

impl Class for Changes {
    type Interfaces = (vs::IParameterChanges,);
}

impl IParameterChangesTrait for Changes {
    unsafe fn getParameterCount(&self) -> i32 {
        self.queues.len() as i32
    }
    unsafe fn getParameterData(&self, index: i32) -> *mut vs::IParamValueQueue {
        self.queues
            .get(index.max(0) as usize)
            .and_then(|q| q.as_com_ref::<vs::IParamValueQueue>())
            .map_or(std::ptr::null_mut(), |r| r.as_ptr())
    }
    unsafe fn addParameterData(
        &self,
        _id: *const vs::ParamID,
        _index: *mut i32,
    ) -> *mut vs::IParamValueQueue {
        std::ptr::null_mut()
    }
}

/// The window around a plugin's editor; the plugin asks it to resize.
struct Frame {
    hwnd: isize,
}

impl Class for Frame {
    type Interfaces = (sb::IPlugFrame,);
}

impl IPlugFrameTrait for Frame {
    unsafe fn resizeView(&self, view: *mut sb::IPlugView, size: *mut sb::ViewRect) -> sb::tresult {
        if view.is_null() || size.is_null() {
            return sb::kInvalidArgument;
        }
        win::resize(self.hwnd, &*size);
        if let Some(v) = vst3::ComRef::from_raw(view) {
            v.onSize(size);
        }
        OK
    }
}

/* ---------- plugin files ---------- */

struct Module {
    factory: ComPtr<sb::IPluginFactory>,
    _lib: libloading::Library,
}

/// The DLL inside a .vst3 bundle folder, or the .vst3 file itself.
fn binary(path: &Path) -> PathBuf {
    if path.is_dir() {
        let name = path.file_name().unwrap_or_default();
        path.join("Contents").join("x86_64-win").join(name)
    } else {
        path.to_path_buf()
    }
}

fn open_module(path: &Path) -> Result<Module, String> {
    use libloading::os::windows::{Library, LOAD_WITH_ALTERED_SEARCH_PATH};
    let bin = binary(path);
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    unsafe {
        let lib = Library::load_with_flags(&bin, LOAD_WITH_ALTERED_SEARCH_PATH)
            .map_err(|e| format!("Couldn't load {name}: {e}"))?;
        let lib: libloading::Library = lib.into();
        if let Ok(init) = lib.get::<unsafe extern "system" fn() -> bool>(b"InitDll\0") {
            init();
        }
        let get = lib
            .get::<unsafe extern "system" fn() -> *mut sb::IPluginFactory>(b"GetPluginFactory\0")
            .map_err(|_| format!("{name} isn't a VST3 plugin"))?;
        let factory = ComPtr::from_raw(get()).ok_or_else(|| format!("{name} didn't start"))?;
        Ok(Module { factory, _lib: lib })
    }
}

/// Where VST3 plugins are installed: for everyone, and for this user only.
fn folders() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(c) = std::env::var_os("CommonProgramFiles") {
        v.push(PathBuf::from(c).join("VST3"));
    }
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        v.push(
            PathBuf::from(l)
                .join("Programs")
                .join("Common")
                .join("VST3"),
        );
    }
    v
}

fn find(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        let is_vst3 = p
            .extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("vst3"));
        if is_vst3 {
            out.push(p);
        } else if p.is_dir() && depth > 0 {
            find(&p, depth - 1, out);
        }
    }
}

/// The effects (not instruments) a plugin file holds.
fn effects_in(ui: &mut Ui, path: &Path) -> Result<Vec<Value>, String> {
    let m = ui.module(path)?;
    let f = &m.factory;
    let f2 = f.cast::<sb::IPluginFactory2>();
    let mut vendor = String::new();
    unsafe {
        let mut info: sb::PFactoryInfo = std::mem::zeroed();
        if f.getFactoryInfo(&mut info) == OK {
            vendor = text(&info.vendor);
        }
    }
    let mut out = Vec::new();
    for i in 0..unsafe { f.countClasses() } {
        let (cid, category, name, sub, v) = unsafe {
            if let Some(f2) = &f2 {
                let mut c: sb::PClassInfo2 = std::mem::zeroed();
                if f2.getClassInfo2(i, &mut c) != OK {
                    continue;
                }
                (
                    c.cid,
                    text(&c.category),
                    text(&c.name),
                    text(&c.subCategories),
                    text(&c.vendor),
                )
            } else {
                let mut c: sb::PClassInfo = std::mem::zeroed();
                if f.getClassInfo(i, &mut c) != OK {
                    continue;
                }
                (
                    c.cid,
                    text(&c.category),
                    text(&c.name),
                    String::new(),
                    String::new(),
                )
            }
        };
        if category != "Audio Module Class" {
            continue;
        }
        if sub.contains("Instrument") && !sub.contains("Fx") {
            continue;
        }
        out.push(json!({
            "name": name,
            "vendor": if v.is_empty() { vendor.clone() } else { v },
            "path": path.to_string_lossy(),
            "cid": hex(&cid),
        }));
    }
    Ok(out)
}

/* ---------- loaded plugins ---------- */

/// What Settings asks for: a plugin on one mic's chain (`lane`), with its saved settings.
#[derive(Clone, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
pub struct Want {
    pub id: String,
    pub lane: usize,
    pub path: String,
    pub cid: String,
    pub name: String,
    pub on: bool,
    #[serde(default)]
    pub stereo: bool,
    /// Saved settings (base64): the processor's (`c`) and the editor's (`e`). Used when loading.
    #[serde(default)]
    pub c: String,
    #[serde(default)]
    pub e: String,
}

impl Want {
    fn key(&self, rate: u32) -> String {
        format!(
            "{}|{}|{}|{}|{rate}",
            self.lane, self.path, self.cid, self.stereo
        )
    }
}

fn unb64s(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .unwrap_or_default()
}

/// The audio side of a plugin, owned by the chain the worker runs.
pub struct Proc {
    id: String,
    token: u32,
    lane: usize,
    on: bool,
    stereo: bool,
    processor: ComPtr<vs::IAudioProcessor>,
    rate: f64,
    pending: Arc<Mutex<Vec<(u32, f64)>>>,
    started: bool,
    bin: Vec<Vec<Vec<f32>>>,
    bout: Vec<Vec<Vec<f32>>>,
}

// The processor is meant to be called from an audio thread; only one thread uses a Proc at once.
unsafe impl Send for Proc {}

static CHAIN: Mutex<Vec<Proc>> = Mutex::new(Vec::new());

impl Proc {
    fn process(&mut self, buf: &mut [f32]) {
        let n = buf.len() / if self.stereo { 2 } else { 1 };
        if !self.started {
            unsafe { self.processor.setProcessing(1) };
            self.started = true;
        }
        for (b, bus) in self.bin.iter_mut().enumerate() {
            for (side, ch) in bus.iter_mut().enumerate() {
                ch.resize(n, 0.0);
                if b == 0 && self.stereo {
                    for (sample, pair) in ch.iter_mut().zip(buf.chunks_exact(2)) {
                        *sample = pair[side];
                    }
                } else if b == 0 {
                    ch.copy_from_slice(buf);
                } else {
                    ch.fill(0.0);
                }
            }
        }
        for bus in self.bout.iter_mut() {
            for ch in bus.iter_mut() {
                ch.resize(n, 0.0);
                ch.fill(0.0);
            }
        }
        let mut pin: Vec<Vec<*mut f32>> = self
            .bin
            .iter_mut()
            .map(|b| b.iter_mut().map(|c| c.as_mut_ptr()).collect())
            .collect();
        let mut pout: Vec<Vec<*mut f32>> = self
            .bout
            .iter_mut()
            .map(|b| b.iter_mut().map(|c| c.as_mut_ptr()).collect())
            .collect();
        let bus = |p: &mut Vec<*mut f32>| vs::AudioBusBuffers {
            numChannels: p.len() as i32,
            silenceFlags: 0,
            __field0: vs::AudioBusBuffers__type0 {
                channelBuffers32: p.as_mut_ptr(),
            },
        };
        let mut ins: Vec<vs::AudioBusBuffers> = pin.iter_mut().map(bus).collect();
        let mut outs: Vec<vs::AudioBusBuffers> = pout.iter_mut().map(bus).collect();

        // Knob moves from the editor since the last block.
        let moved: Vec<(u32, f64)> = match self.pending.try_lock() {
            Ok(mut p) => std::mem::take(&mut *p),
            Err(_) => Vec::new(),
        };
        let changes = (!moved.is_empty()).then(|| {
            ComWrapper::new(Changes {
                queues: moved
                    .iter()
                    .map(|&(id, value)| ComWrapper::new(ParamQueue { id, value }))
                    .collect(),
            })
        });
        let changes_ptr = changes
            .as_ref()
            .and_then(|c| c.as_com_ref::<vs::IParameterChanges>())
            .map_or(std::ptr::null_mut(), |r| r.as_ptr());

        let mut ctx: vs::ProcessContext = unsafe { std::mem::zeroed() };
        ctx.sampleRate = self.rate;
        ctx.tempo = 120.0;
        ctx.timeSigNumerator = 4;
        ctx.timeSigDenominator = 4;
        ctx.state = (vs::ProcessContext_::StatesAndFlags_::kTempoValid
            | vs::ProcessContext_::StatesAndFlags_::kTimeSigValid) as u32;
        let mut data = vs::ProcessData {
            processMode: vs::ProcessModes_::kRealtime as i32,
            symbolicSampleSize: vs::SymbolicSampleSizes_::kSample32 as i32,
            numSamples: n as i32,
            numInputs: ins.len() as i32,
            numOutputs: outs.len() as i32,
            inputs: ins.as_mut_ptr(),
            outputs: outs.as_mut_ptr(),
            inputParameterChanges: changes_ptr,
            outputParameterChanges: std::ptr::null_mut(),
            inputEvents: std::ptr::null_mut(),
            outputEvents: std::ptr::null_mut(),
            processContext: &mut ctx,
        };
        if unsafe { self.processor.process(&mut data) } != OK {
            return;
        }
        let main = &self.bout[0];
        if self.stereo {
            for (pair, (&left, &right)) in buf.chunks_exact_mut(2).zip(main[0].iter().zip(&main[1]))
            {
                pair.copy_from_slice(&[left, right]);
            }
            return;
        }
        match main.len() {
            0 => {}
            1 => buf.copy_from_slice(&main[0][..n]),
            _ => {
                for (k, v) in buf.iter_mut().enumerate() {
                    *v = (main[0][k] + main[1][k]) * 0.5;
                }
            }
        }
    }
}

/// Run the plugins that are on, in order, over one frame of mono mic audio (worker thread).
pub fn process(
    lane: usize,
    buf: &mut [f32],
    stereo: bool,
    processing: &std::sync::atomic::AtomicU32,
) {
    if let Ok(mut chain) = CHAIN.lock() {
        for p in chain
            .iter_mut()
            .filter(|p| p.on && p.lane == lane && p.stereo == stereo)
        {
            processing.store(p.token, Ordering::Release);
            p.process(buf);
            processing.store(0, Ordering::Release);
        }
    }
}

/// The UI side of a plugin, owned by the plugin UI thread.
struct Instance {
    key: String,
    name: String,
    component: ComPtr<vs::IComponent>,
    processor: ComPtr<vs::IAudioProcessor>,
    controller: Option<ComPtr<vs::IEditController>>,
    separate: bool,
    points: Option<(ComPtr<vs::IConnectionPoint>, ComPtr<vs::IConnectionPoint>)>,
    _handler: ComWrapper<Handler>,
    dirty: Arc<AtomicBool>,
    saved_at: Instant,
    editor: Option<isize>,
}

struct Ui {
    host: ComWrapper<HostApp>,
    modules: HashMap<PathBuf, Arc<Module>>,
    plugins: HashMap<String, Instance>,
    /// Plugins that didn't load, and why: id → (key, message). Not retried until the key changes.
    failed: HashMap<String, (String, String)>,
    frames: HashMap<isize, ComWrapper<Frame>>,
}

impl Ui {
    fn module(&mut self, path: &Path) -> Result<Arc<Module>, String> {
        if let Some(m) = self.modules.get(path) {
            return Ok(m.clone());
        }
        let m = Arc::new(open_module(path)?);
        // Plugin DLLs stay loaded until Sleekmeeter quits; unloading them is a common crash.
        self.modules.insert(path.to_path_buf(), m.clone());
        Ok(m)
    }

    fn host(&self) -> *mut sb::FUnknown {
        self.host
            .as_com_ref::<vs::IHostApplication>()
            .map_or(std::ptr::null_mut(), |r| r.as_ptr() as *mut sb::FUnknown)
    }
}

fn create<I: Interface>(f: &ComPtr<sb::IPluginFactory>, cid: &sb::TUID) -> Option<ComPtr<I>> {
    let mut obj: *mut c_void = std::ptr::null_mut();
    unsafe {
        let r = f.createInstance(
            cid.as_ptr() as sb::FIDString,
            I::IID.as_ptr() as sb::FIDString,
            &mut obj,
        );
        if r != OK {
            return None;
        }
        ComPtr::from_raw(obj as *mut I)
    }
}

fn load(
    ui: &mut Ui,
    w: &Want,
    rate: u32,
    state: (Vec<u8>, Vec<u8>),
) -> Result<(Instance, Proc), String> {
    let path = PathBuf::from(&w.path);
    if !binary(&path).exists() {
        return Err(format!("{} isn't installed any more ({})", w.name, w.path));
    }
    let m = ui.module(&path)?;
    let cid = unhex(&w.cid).ok_or("Unknown plugin id")?;
    let host = ui.host();
    let component: ComPtr<vs::IComponent> =
        create(&m.factory, &cid).ok_or_else(|| format!("{} couldn't be created", w.name))?;
    unsafe {
        if component.initialize(host) != OK {
            return Err(format!("{} didn't start", w.name));
        }
    }
    let processor = component
        .cast::<vs::IAudioProcessor>()
        .ok_or_else(|| format!("{} isn't an audio effect", w.name))?;

    // The editor side: the same object, or a second one we create and connect.
    let (controller, separate) = match component.cast::<vs::IEditController>() {
        Some(c) => (Some(c), false),
        None => unsafe {
            let mut ccid: sb::TUID = [0; 16];
            match (component.getControllerClassId(&mut ccid) == OK)
                .then(|| create::<vs::IEditController>(&m.factory, &ccid))
                .flatten()
            {
                Some(c) if c.initialize(host) == OK => (Some(c), true),
                _ => (None, false),
            }
        },
    };
    let mut points = None;
    if separate {
        if let (Some(a), Some(b)) = (
            component.cast::<vs::IConnectionPoint>(),
            controller
                .as_ref()
                .and_then(|c| c.cast::<vs::IConnectionPoint>()),
        ) {
            unsafe {
                a.connect(b.as_ptr());
                b.connect(a.as_ptr());
            }
            points = Some((a, b));
        }
    }
    let pending = Arc::new(Mutex::new(Vec::new()));
    let dirty = Arc::new(AtomicBool::new(false));
    let handler = ComWrapper::new(Handler {
        pending: pending.clone(),
        dirty: dirty.clone(),
    });
    unsafe {
        if let Some(c) = &controller {
            if let Some(h) = handler.as_com_ref::<vs::IComponentHandler>() {
                c.setComponentHandler(h.as_ptr());
            }
        }
    }
    restore(&component, &controller, state);

    // Buses: mono in and out if the plugin takes it, else stereo, else what it has.
    let audio = vs::MediaTypes_::kAudio as vs::MediaType;
    let (din, dout) = (
        vs::BusDirections_::kInput as vs::BusDirection,
        vs::BusDirections_::kOutput as vs::BusDirection,
    );
    let (nin, nout) = unsafe {
        (
            component.getBusCount(audio, din),
            component.getBusCount(audio, dout),
        )
    };
    if nin < 1 || nout < 1 {
        return Err(format!("{} isn't an effect: it has no audio input", w.name));
    }
    let arrangement = |dir, i| {
        let mut a: vs::SpeakerArrangement = 0;
        unsafe { processor.getBusArrangement(dir, i, &mut a) };
        a
    };
    let mut ain: Vec<vs::SpeakerArrangement> = (0..nin).map(|i| arrangement(din, i)).collect();
    let mut aout: Vec<vs::SpeakerArrangement> = (0..nout).map(|i| arrangement(dout, i)).collect();
    let arrangements: &[_] = if w.stereo {
        &[vs::SpeakerArr::kStereo]
    } else {
        &[vs::SpeakerArr::kMono, vs::SpeakerArr::kStereo]
    };
    for &want in arrangements {
        ain[0] = want;
        aout[0] = want;
        let r =
            unsafe { processor.setBusArrangements(ain.as_mut_ptr(), nin, aout.as_mut_ptr(), nout) };
        if r == OK {
            break;
        }
    }
    let channels = |dir, i| unsafe {
        let mut info: vs::BusInfo = std::mem::zeroed();
        component.getBusInfo(audio, dir, i, &mut info);
        info.channelCount.max(0)
    };
    let ins: Vec<i32> = (0..nin).map(|i| channels(din, i)).collect();
    let outs: Vec<i32> = (0..nout).map(|i| channels(dout, i)).collect();
    if w.stereo && (ins[0] != 2 || outs[0] != 2) {
        return Err(format!(
            "{} needs a stereo input and output for this chain",
            w.name
        ));
    }
    unsafe {
        for i in 0..nin {
            component.activateBus(audio, din, i, (i == 0) as u8);
        }
        for i in 0..nout {
            component.activateBus(audio, dout, i, (i == 0) as u8);
        }
        if processor.canProcessSampleSize(vs::SymbolicSampleSizes_::kSample32 as i32) != OK {
            return Err(format!(
                "{} needs 64-bit audio, which Sleekmeeter doesn't send",
                w.name
            ));
        }
        let mut setup = vs::ProcessSetup {
            processMode: vs::ProcessModes_::kRealtime as i32,
            symbolicSampleSize: vs::SymbolicSampleSizes_::kSample32 as i32,
            maxSamplesPerBlock: 2048,
            sampleRate: rate as f64,
        };
        if processor.setupProcessing(&mut setup) != OK {
            return Err(format!("{} doesn't work at {} Hz", w.name, rate));
        }
        if component.setActive(1) != OK {
            return Err(format!("{} didn't switch on", w.name));
        }
    }
    let lanes = |v: &[i32]| -> Vec<Vec<Vec<f32>>> {
        v.iter()
            .map(|&c| (0..c).map(|_| vec![0f32; 1024]).collect())
            .collect()
    };
    let proc = Proc {
        token: crate::pluginhost::plugin_token(&w.id),
        id: w.id.clone(),
        lane: w.lane,
        on: w.on,
        stereo: w.stereo,
        processor: processor.clone(),
        rate: rate as f64,
        bin: lanes(&ins),
        bout: lanes(&outs),
        pending,
        started: false,
    };
    let inst = Instance {
        key: w.key(rate),
        name: w.name.clone(),
        component,
        processor,
        controller,
        separate,
        points,
        _handler: handler,
        dirty,
        saved_at: Instant::now(),
        editor: None,
    };
    Ok((inst, proc))
}

/// The plugin's settings now: (processor, editor).
fn capture(inst: &Instance) -> (Vec<u8>, Vec<u8>) {
    let take = |s: &ComWrapper<Stream>| std::mem::take(&mut s.data.lock().unwrap().0);
    unsafe {
        let c = stream(Vec::new());
        let cs = if inst.component.getState(stream_ptr(&c)) == OK {
            take(&c)
        } else {
            Vec::new()
        };
        let mut es = Vec::new();
        if let Some(ctrl) = &inst.controller {
            let e = stream(Vec::new());
            if ctrl.getState(stream_ptr(&e)) == OK {
                es = take(&e);
            }
        }
        (cs, es)
    }
}

/// Where a plugin's changed settings go: {"event":"state","id","c","e"} (base64). In the plugin
/// host process this writes to Sleekmeeter, which keeps them in settings.json.
type Sink = Box<dyn Fn(Value) + Send + Sync>;
static SINK: OnceLock<Sink> = OnceLock::new();

pub fn set_sink(f: Sink) {
    let _ = SINK.set(f);
}

fn save_state(id: &str, inst: &Instance) {
    let (c, e) = capture(inst);
    if let Some(sink) = SINK.get() {
        sink(json!({ "event": "state", "id": id, "c": b64(&c), "e": b64(&e) }));
    }
}

/// Give a plugin settings: the processor's, shared with its editor, then the editor's own.
fn restore(
    component: &ComPtr<vs::IComponent>,
    controller: &Option<ComPtr<vs::IEditController>>,
    (cs, es): (Vec<u8>, Vec<u8>),
) {
    unsafe {
        if !cs.is_empty() {
            let s = stream(cs.clone());
            component.setState(stream_ptr(&s));
            if let Some(c) = controller {
                let s = stream(cs);
                c.setComponentState(stream_ptr(&s));
            }
        } else if let Some(c) = controller {
            // No saved settings: the editor starts from the plugin's own defaults.
            let s = stream(Vec::new());
            if component.getState(stream_ptr(&s)) == OK {
                s.data.lock().unwrap().1 = 0;
                c.setComponentState(stream_ptr(&s));
            }
        }
        if !es.is_empty() {
            if let Some(c) = controller {
                let s = stream(es);
                c.setState(stream_ptr(&s));
            }
        }
    }
}

fn unload(ui: &mut Ui, id: &str, keep_state: bool) {
    // Off the audio side first, so the worker never calls a plugin being shut down.
    let proc = {
        let mut chain = CHAIN.lock().unwrap();
        chain
            .iter()
            .position(|p| p.id == id)
            .map(|i| chain.remove(i))
    };
    let Some(inst) = ui.plugins.remove(id) else {
        return;
    };
    if let Some(h) = inst.editor {
        win::close(ui, h);
    }
    if keep_state {
        save_state(id, &inst);
    }
    unsafe {
        if proc.is_some_and(|p| p.started) {
            inst.processor.setProcessing(0);
        }
        inst.component.setActive(0);
        if let Some((a, b)) = &inst.points {
            a.disconnect(b.as_ptr());
            b.disconnect(a.as_ptr());
        }
        if let Some(c) = &inst.controller {
            c.setComponentHandler(std::ptr::null_mut());
            if inst.separate {
                c.terminate();
            }
        }
        inst.component.terminate();
    }
    log_info!("Plugins: closed {}", inst.name);
}

/* ---------- the plugin UI thread ---------- */

type Job = Box<dyn FnOnce(&mut Ui) + Send>;

struct Thread {
    tx: Mutex<Sender<Job>>,
    hwnd: isize,
}

thread_local! {
    static UI: RefCell<Option<Ui>> = const { RefCell::new(None) };
    static JOBS: RefCell<Option<Receiver<Job>>> = const { RefCell::new(None) };
}

fn thread() -> &'static Thread {
    static T: OnceLock<Thread> = OnceLock::new();
    T.get_or_init(|| {
        let (tx, rx) = channel::<Job>();
        let (ready_tx, ready_rx) = channel::<isize>();
        std::thread::Builder::new()
            .name("plugin-ui".into())
            .spawn(move || {
                UI.with(|u| {
                    *u.borrow_mut() = Some(Ui {
                        host: ComWrapper::new(HostApp),
                        modules: HashMap::new(),
                        plugins: HashMap::new(),
                        failed: HashMap::new(),
                        frames: HashMap::new(),
                    })
                });
                JOBS.with(|j| *j.borrow_mut() = Some(rx));
                let hwnd = win::start();
                let _ = ready_tx.send(hwnd);
                win::message_loop();
            })
            .expect("plugin UI thread");
        let hwnd = ready_rx.recv().unwrap_or(0);
        Thread {
            tx: Mutex::new(tx),
            hwnd,
        }
    })
}

/// Run jobs waiting for the UI thread (called on it, from its message window).
fn drain() {
    UI.with(|u| {
        let Ok(mut guard) = u.try_borrow_mut() else {
            return; // busy in an outer job; it re-posts when done
        };
        let Some(ui) = guard.as_mut() else { return };
        loop {
            let job = JOBS.with(|j| j.borrow().as_ref().and_then(|r| r.try_recv().ok()));
            let Some(job) = job else { break };
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(ui))).is_err() {
                log_error!("Plugins: a plugin job panicked");
            }
        }
    });
}

/// Run `f` on the plugin UI thread and wait for its answer.
fn run<R: Send + 'static>(f: impl FnOnce(&mut Ui) -> R + Send + 'static) -> Result<R, String> {
    let t = thread();
    let (tx, rx) = channel();
    let job: Job = Box::new(move |ui| {
        let _ = tx.send(f(ui));
    });
    t.tx.lock()
        .unwrap()
        .send(job)
        .map_err(|_| "The plugin host stopped".to_string())?;
    win::wake(t.hwnd);
    rx.recv_timeout(Duration::from_secs(60))
        .map_err(|_| "A plugin took too long to answer".to_string())
}

/* ---------- public ---------- */

static STATUS: Mutex<Value> = Mutex::new(Value::Null);

/// Load, unload and order plugins to match Settings (`want`, in order) at `rate` Hz.
pub fn sync(want: Vec<Want>, rate: u32) {
    if want.is_empty() && STATUS.lock().unwrap().is_null() {
        return; // never started: don't spin up the plugin thread for nothing
    }
    let r = run(move |ui| {
        // Close what's gone or changed (a new file, id or sample rate).
        let stale: Vec<String> = ui
            .plugins
            .iter()
            .filter(|(id, inst)| !want.iter().any(|w| &w.id == *id && w.key(rate) == inst.key))
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            unload(ui, &id, true);
        }
        ui.failed
            .retain(|id, (k, _)| want.iter().any(|w| &w.id == id && &w.key(rate) == k));
        // Open what's new.
        let mut fresh: Vec<Proc> = Vec::new();
        for w in &want {
            if ui.plugins.contains_key(&w.id) || ui.failed.contains_key(&w.id) {
                continue;
            }
            let state = (unb64s(&w.c), unb64s(&w.e));
            if let Some(sink) = SINK.get() {
                sink(json!({ "event": "loading", "plugin": w.id }));
            }
            let loaded = load(ui, w, rate, state);
            if let Some(sink) = SINK.get() {
                sink(json!({ "event": "loading", "plugin": null }));
            }
            match loaded {
                Ok((inst, proc)) => {
                    log_info!("Plugins: opened {} at {rate} Hz", w.name);
                    ui.plugins.insert(w.id.clone(), inst);
                    fresh.push(proc);
                }
                Err(e) => {
                    log_warn!("Plugins: {e}");
                    ui.failed.insert(w.id.clone(), (w.key(rate), e));
                }
            }
        }
        // Order and on/off, as Settings lists them.
        {
            let mut chain = CHAIN.lock().unwrap();
            let mut all: Vec<Proc> = chain.drain(..).chain(fresh).collect();
            for w in &want {
                if let Some(i) = all.iter().position(|p| p.id == w.id) {
                    let mut p = all.remove(i);
                    p.on = w.on;
                    chain.push(p);
                }
            }
        }
        // Save settings that changed a while ago (not on every knob move).
        for (id, inst) in ui.plugins.iter_mut() {
            if inst.dirty.load(Ordering::Relaxed)
                && inst.saved_at.elapsed() > Duration::from_secs(3)
            {
                inst.dirty.store(false, Ordering::Relaxed);
                inst.saved_at = Instant::now();
                save_state(id, inst);
            }
        }
        let mut st = serde_json::Map::new();
        for w in &want {
            let v = match (ui.plugins.get(&w.id), ui.failed.get(&w.id)) {
                (Some(i), _) => {
                    json!({ "loaded": true, "error": "", "editor": i.controller.is_some() })
                }
                (None, Some((_, e))) => json!({ "loaded": false, "error": e, "editor": false }),
                _ => json!({ "loaded": false, "error": "", "editor": false }),
            };
            st.insert(w.id.clone(), v);
        }
        Value::Object(st)
    });
    match r {
        Ok(v) => *STATUS.lock().unwrap() = v,
        Err(e) => log_warn!("Plugins: {e}"),
    }
}

/// `{ id: { loaded, error, editor } }` for Settings.
pub fn status() -> Value {
    let s = STATUS.lock().unwrap().clone();
    if s.is_null() {
        json!({})
    } else {
        s
    }
}

/// Every effect in the usual VST3 folders: [{ name, vendor, path, cid }].
pub fn scan() -> Result<Vec<Value>, String> {
    run(|ui| {
        let mut files = Vec::new();
        for f in folders() {
            find(&f, 3, &mut files);
        }
        let mut out = Vec::new();
        for p in files {
            match effects_in(ui, &p) {
                Ok(v) => out.extend(v),
                Err(e) => log_warn!("Plugins: {e}"),
            }
        }
        out.sort_by_key(|v| v["name"].as_str().unwrap_or("").to_lowercase());
        out
    })
}

/// The effects in one .vst3 file or bundle the user picked.
pub fn describe(path: String) -> Result<Vec<Value>, String> {
    let p = PathBuf::from(&path);
    // A file inside a bundle: use the bundle, so Contents\Resources are found.
    let p = p
        .ancestors()
        .skip(1)
        .find(|a| {
            a.extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("vst3"))
                && a.is_dir()
        })
        .map(Path::to_path_buf)
        .unwrap_or(p);
    let v = run(move |ui| effects_in(ui, &p))??;
    if v.is_empty() {
        return Err("That plugin has no audio effects (instruments can't go on a mic)".into());
    }
    Ok(v)
}

/// A loaded plugin's settings now: {"c","e"} (base64), for saving a preset.
pub fn get_state(id: String) -> Result<Value, String> {
    run(move |ui| {
        let inst = ui.plugins.get(&id).ok_or("That plugin isn't loaded")?;
        let (c, e) = capture(inst);
        Ok(json!({ "c": b64(&c), "e": b64(&e) }))
    })?
}

/// Give a loaded plugin saved settings (a preset), and report them as its new settings.
pub fn set_state(id: String, c: String, e: String) -> Result<(), String> {
    run(move |ui| {
        let inst = ui.plugins.get(&id).ok_or("That plugin isn't loaded")?;
        restore(&inst.component, &inst.controller, (unb64s(&c), unb64s(&e)));
        save_state(&id, inst);
        Ok(())
    })?
}

/// Open a plugin's editor window (or bring it to the front).
pub fn open_editor(id: String) -> Result<(), String> {
    run(move |ui| win::open(ui, &id))?
}

/// Quitting: save every plugin's settings and switch them off.
pub fn shutdown() {
    if STATUS.lock().unwrap().is_null() {
        return;
    }
    let _ = run(|ui| {
        let ids: Vec<String> = ui.plugins.keys().cloned().collect();
        for id in ids {
            unload(ui, &id, true);
        }
    });
}

/* ---------- Windows: the message window and editor windows ---------- */

mod win {
    use super::*;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    const WM_JOBS: u32 = WM_APP + 1;

    thread_local! {
        /// Editor views by window, for resizing (kept apart from Ui so WM_SIZE can reach them).
        static VIEWS: RefCell<HashMap<isize, ComPtr<sb::IPlugView>>> = RefCell::new(HashMap::new());
        static RESIZING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    const EDITOR_CLASS: &str = "SleekmeeterPluginEditor";

    pub fn start() -> isize {
        unsafe {
            CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as _);
            let inst = GetModuleHandleW(std::ptr::null());
            let jobs = wide("SleekmeeterPluginHost");
            let mut wc: WNDCLASSW = std::mem::zeroed();
            wc.lpfnWndProc = Some(host_proc);
            wc.hInstance = inst;
            wc.lpszClassName = jobs.as_ptr();
            RegisterClassW(&wc);
            let ed = wide(EDITOR_CLASS);
            let mut wc: WNDCLASSW = std::mem::zeroed();
            wc.lpfnWndProc = Some(editor_proc);
            wc.hInstance = inst;
            wc.lpszClassName = ed.as_ptr();
            wc.hCursor = LoadCursorW(std::ptr::null_mut(), IDC_ARROW);
            // Dark behind the plugin while it draws, and no stale paint when resized.
            wc.hbrBackground = windows_sys::Win32::Graphics::Gdi::GetStockObject(
                windows_sys::Win32::Graphics::Gdi::BLACK_BRUSH,
            ) as _;
            wc.hIcon = LoadIconW(inst, 1 as _);
            RegisterClassW(&wc);
            CreateWindowExW(
                0,
                jobs.as_ptr(),
                jobs.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                inst,
                std::ptr::null(),
            ) as isize
        }
    }

    pub fn message_loop() {
        unsafe {
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    pub fn wake(hwnd: isize) {
        unsafe { PostMessageW(hwnd as HWND, WM_JOBS, 0, 0) };
    }

    unsafe extern "system" fn host_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        if msg == WM_JOBS {
            drain();
            return 0;
        }
        DefWindowProcW(hwnd, msg, wp, lp)
    }

    fn style(resizable: bool) -> u32 {
        let base = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
        if resizable {
            base | WS_THICKFRAME | WS_MAXIMIZEBOX
        } else {
            base
        }
    }

    /// The window size that gives the editor this much room.
    fn outer(hwnd: isize, w: i32, h: i32) -> (i32, i32) {
        unsafe {
            let st = GetWindowLongW(hwnd as HWND, GWL_STYLE) as u32;
            let mut r = RECT {
                left: 0,
                top: 0,
                right: w,
                bottom: h,
            };
            AdjustWindowRectEx(&mut r, st, 0, 0);
            (r.right - r.left, r.bottom - r.top)
        }
    }

    pub fn resize(hwnd: isize, size: &sb::ViewRect) {
        let (w, h) = outer(hwnd, size.right - size.left, size.bottom - size.top);
        RESIZING.with(|r| r.set(true));
        unsafe {
            SetWindowPos(
                hwnd as HWND,
                std::ptr::null_mut(),
                0,
                0,
                w,
                h,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        RESIZING.with(|r| r.set(false));
    }

    pub fn open(ui: &mut Ui, id: &str) -> Result<(), String> {
        let inst = ui
            .plugins
            .get(id)
            .ok_or("That plugin isn't loaded. Check it's switched on and installed")?;
        if let Some(h) = inst.editor {
            unsafe {
                ShowWindow(h as HWND, SW_RESTORE);
                SetForegroundWindow(h as HWND);
            }
            return Ok(());
        }
        let ctrl = inst
            .controller
            .as_ref()
            .ok_or_else(|| format!("{} has no editor", inst.name))?;
        let view = unsafe { ComPtr::from_raw(ctrl.createView(vs::ViewType::kEditor)) }
            .ok_or_else(|| format!("{} has no editor window", inst.name))?;
        unsafe {
            if view.isPlatformTypeSupported(sb::kPlatformTypeHWND) != OK {
                return Err(format!("{}'s editor doesn't run on Windows", inst.name));
            }
            let mut r: sb::ViewRect = std::mem::zeroed();
            view.getSize(&mut r);
            let (w, h) = ((r.right - r.left).max(200), (r.bottom - r.top).max(100));
            let resizable = view.canResize() == OK;
            let class = wide(EDITOR_CLASS);
            let title = wide(&format!("{} · Sleekmeeter", inst.name));
            let st = style(resizable);
            let mut rr = RECT {
                left: 0,
                top: 0,
                right: w,
                bottom: h,
            };
            AdjustWindowRectEx(&mut rr, st, 0, 0);
            let (ww, wh) = (rr.right - rr.left, rr.bottom - rr.top);
            // Over Sleekmeeter's window (it's in front: Edit was just clicked there).
            let front = GetForegroundWindow();
            let mut fr: RECT = std::mem::zeroed();
            let (x, y) = if !front.is_null() && GetWindowRect(front, &mut fr) != 0 {
                (
                    fr.left + ((fr.right - fr.left) - ww) / 2,
                    (fr.top + ((fr.bottom - fr.top) - wh) / 2).max(fr.top),
                )
            } else {
                (CW_USEDEFAULT, CW_USEDEFAULT)
            };
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                st,
                x,
                y,
                rr.right - rr.left,
                rr.bottom - rr.top,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            );
            if hwnd.is_null() {
                return Err("Couldn't open a window for the plugin".into());
            }
            let h = hwnd as isize;
            let frame = ComWrapper::new(Frame { hwnd: h });
            if let Some(f) = frame.as_com_ref::<sb::IPlugFrame>() {
                view.setFrame(f.as_ptr());
            }
            if view.attached(hwnd as *mut c_void, sb::kPlatformTypeHWND) != OK {
                view.setFrame(std::ptr::null_mut());
                DestroyWindow(hwnd);
                return Err(format!("{}'s editor didn't open", inst.name));
            }
            VIEWS.with(|v| v.borrow_mut().insert(h, view));
            ui.frames.insert(h, frame);
            if let Some(i) = ui.plugins.get_mut(id) {
                i.editor = Some(h);
            }
            ShowWindow(hwnd, SW_SHOW);
            SetForegroundWindow(hwnd);
        }
        Ok(())
    }

    /// Close an editor window, saving the plugin's settings.
    pub fn close(ui: &mut Ui, hwnd: isize) {
        let view = VIEWS.with(|v| v.borrow_mut().remove(&hwnd));
        if let Some(view) = view {
            unsafe {
                view.removed();
                view.setFrame(std::ptr::null_mut());
            }
        }
        ui.frames.remove(&hwnd);
        let id = ui
            .plugins
            .iter()
            .find(|(_, i)| i.editor == Some(hwnd))
            .map(|(id, _)| id.clone());
        if let Some(id) = id {
            if let Some(inst) = ui.plugins.get_mut(&id) {
                inst.editor = None;
                inst.dirty.store(false, Ordering::Relaxed);
                inst.saved_at = Instant::now();
            }
            if let Some(inst) = ui.plugins.get(&id) {
                save_state(&id, inst);
            }
        }
        unsafe { DestroyWindow(hwnd as HWND) };
    }

    unsafe extern "system" fn editor_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        let h = hwnd as isize;
        match msg {
            WM_CLOSE => {
                let done = UI.with(|u| match u.try_borrow_mut() {
                    Ok(mut g) => {
                        if let Some(ui) = g.as_mut() {
                            close(ui, h);
                        }
                        true
                    }
                    Err(_) => false,
                });
                if !done {
                    // Busy: try again in a moment.
                    PostMessageW(hwnd, WM_CLOSE, 0, 0);
                }
                return 0;
            }
            WM_SIZE if !RESIZING.with(|r| r.get()) => {
                let view = VIEWS.with(|v| v.try_borrow().ok().and_then(|m| m.get(&h).cloned()));
                if let Some(view) = view {
                    if view.canResize() == OK {
                        let mut c: RECT = std::mem::zeroed();
                        GetClientRect(hwnd, &mut c);
                        let mut r = sb::ViewRect {
                            left: 0,
                            top: 0,
                            right: c.right,
                            bottom: c.bottom,
                        };
                        view.checkSizeConstraint(&mut r);
                        view.onSize(&mut r);
                    }
                }
            }
            _ => {}
        }
        DefWindowProcW(hwnd, msg, wp, lp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs a VST3 effect: `SLEEK_TEST_VST3=path\to\Plugin.vst3 cargo test vst -- --ignored`.
    /// Built for vst3's example gain plugin (stereo only, separate controller, parameter 0 = gain).
    #[test]
    #[ignore]
    fn hosts_a_plugin() {
        let path = std::env::var("SLEEK_TEST_VST3").expect("SLEEK_TEST_VST3");
        let found = describe(path.clone()).expect("describe");
        println!("{found:?}");
        let p = &found[0];
        let want = Want {
            id: "t1".into(),
            lane: 0,
            c: String::new(),
            e: String::new(),
            path: p["path"].as_str().unwrap().into(),
            cid: p["cid"].as_str().unwrap().into(),
            name: p["name"].as_str().unwrap().into(),
            on: true,
            stereo: false,
        };
        *STATUS.lock().unwrap() = json!({}); // as if the thread were already in use
        sync(vec![want.clone()], 48_000);
        let st = status();
        println!("{st}");
        assert_eq!(st["t1"]["loaded"], true, "{st}");

        // Mono in, mono out through a stereo-only plugin, unity gain.
        let mut buf: Vec<f32> = (0..480).map(|k| (k as f32 * 0.05).sin() * 0.5).collect();
        let orig = buf.clone();
        process(0, &mut buf, false, &std::sync::atomic::AtomicU32::new(0));
        assert!(buf.iter().zip(&orig).all(|(a, b)| (a - b).abs() < 1e-6));

        // A knob move from the editor reaches the audio.
        CHAIN.lock().unwrap()[0]
            .pending
            .lock()
            .unwrap()
            .push((0, 0.5));
        process(0, &mut buf, false, &std::sync::atomic::AtomicU32::new(0));
        assert!(buf
            .iter()
            .zip(&orig)
            .all(|(a, b)| (a - b * 0.5).abs() < 1e-6));

        // Bypassed, and then gone.
        sync(
            vec![Want {
                on: false,
                ..want.clone()
            }],
            48_000,
        );
        let mut quiet = orig.clone();
        process(0, &mut quiet, false, &std::sync::atomic::AtomicU32::new(0));
        assert_eq!(quiet, orig);
        sync(vec![], 48_000);
        assert!(CHAIN.lock().unwrap().is_empty());
        assert!(status().as_object().unwrap().is_empty());
    }
}
