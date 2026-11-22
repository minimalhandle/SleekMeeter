//! Windows' internal audio policy calls, made directly (no PowerShell helper):
//! - per-app output device, the same setting as Settings → Sound → Volume mixer
//!   (`IAudioPolicyConfigFactory`, Windows 10 21H2 and later);
//! - the default playback device (`IPolicyConfig`, what the Sound control panel uses).
//!
//! Neither has a public API, so both are called through their COM tables by slot number. The
//! interface ids are version-specific: on a Windows that changed them, activation fails with an
//! error instead of calling into the wrong place.

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use windows::core::GUID;

    const FACTORY_CLASS: &str = "Windows.Media.Internal.AudioPolicyConfig";
    const FACTORY_IID: GUID = GUID::from_u128(0xab3d4648_e242_459f_b02f_541c70306324);
    /// IUnknown (3) + IInspectable (3) + 19 others, then Set, then Get.
    const SLOT_SET_PERSISTED: usize = 25;
    const SLOT_GET_PERSISTED: usize = 26;

    const POLICY_CLSID: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
    const POLICY_IID: GUID = GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);
    /// IUnknown (3) + 10 others, then SetDefaultEndpoint.
    const SLOT_SET_DEFAULT: usize = 13;

    const E_INVALIDARG: i32 = 0x8007_0057_u32 as i32;

    #[link(name = "combase", kind = "raw-dylib")]
    extern "system" {
        fn RoGetActivationFactory(
            class: *mut c_void,
            iid: *const GUID,
            out: *mut *mut c_void,
        ) -> i32;
        fn WindowsCreateString(src: *const u16, len: u32, out: *mut *mut c_void) -> i32;
        fn WindowsDeleteString(s: *mut c_void) -> i32;
        fn WindowsGetStringRawBuffer(s: *mut c_void, len: *mut u32) -> *const u16;
    }

    /// An owned COM pointer, released on drop.
    struct Com(*mut c_void);

    impl Com {
        unsafe fn slot(&self, n: usize) -> *const c_void {
            let vtable = *(self.0 as *const *const *const c_void);
            *vtable.add(n)
        }
    }

    impl Drop for Com {
        fn drop(&mut self) {
            unsafe {
                let release: extern "system" fn(*mut c_void) -> u32 =
                    std::mem::transmute(self.slot(2));
                release(self.0);
            }
        }
    }

    /// An HSTRING, deleted on drop. Null is the empty string.
    struct HString(*mut c_void);

    impl HString {
        fn new(s: &str) -> Result<Self, String> {
            if s.is_empty() {
                return Ok(HString(std::ptr::null_mut()));
            }
            let wide: Vec<u16> = s.encode_utf16().collect();
            let mut h = std::ptr::null_mut();
            let hr = unsafe { WindowsCreateString(wide.as_ptr(), wide.len() as u32, &mut h) };
            if hr != 0 {
                return Err(hresult("Couldn't prepare the change", hr));
            }
            Ok(HString(h))
        }

        fn to_string(&self) -> String {
            if self.0.is_null() {
                return String::new();
            }
            unsafe {
                let mut len = 0u32;
                let buf = WindowsGetStringRawBuffer(self.0, &mut len);
                if buf.is_null() {
                    return String::new();
                }
                String::from_utf16_lossy(std::slice::from_raw_parts(buf, len as usize))
            }
        }
    }

    impl Drop for HString {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { WindowsDeleteString(self.0) };
            }
        }
    }

    fn hresult(what: &str, hr: i32) -> String {
        format!("{what} (HR=0x{:08X})", hr as u32)
    }

    /// Runs `f` with COM started on this thread (multithreaded), stopping it again if we started it.
    fn with_com<T>(f: impl FnOnce() -> T) -> T {
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
        let started = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() };
        let out = f();
        if started {
            unsafe { CoUninitialize() };
        }
        out
    }

    fn factory() -> Result<Com, String> {
        let class = HString::new(FACTORY_CLASS)?;
        let mut out = std::ptr::null_mut();
        let hr = unsafe { RoGetActivationFactory(class.0, &FACTORY_IID, &mut out) };
        if hr != 0 || out.is_null() {
            return Err(hresult(
                "Windows didn't accept the change on this version",
                hr,
            ));
        }
        Ok(Com(out))
    }

    /// `{0.0.0.00000000}.{guid}` → the device interface path the per-app calls use.
    fn interface_path(endpoint: &str) -> String {
        if endpoint.is_empty() {
            String::new()
        } else {
            format!(r"\\?\SWD#MMDEVAPI#{endpoint}#{{e6327cad-dcec-4949-ae8a-991e976a79d2}}")
        }
    }

    /// The device interface path back to `{0.0.0.00000000}.{guid}` ("" stays "").
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn endpoint_of(path: &str) -> String {
        let p = path.trim();
        let Some(rest) = p.strip_prefix(r"\\?\SWD#MMDEVAPI#") else {
            return p.to_string();
        };
        rest.split('#').next().unwrap_or("").to_string()
    }

    fn get_persisted(f: &Com, pid: u32, role: i32) -> Result<String, i32> {
        unsafe {
            let get: extern "system" fn(*mut c_void, u32, i32, i32, *mut *mut c_void) -> i32 =
                std::mem::transmute(f.slot(SLOT_GET_PERSISTED));
            let mut h = std::ptr::null_mut();
            let hr = get(f.0, pid, 0, role, &mut h);
            let s = HString(h);
            if hr != 0 {
                return Err(hr);
            }
            Ok(s.to_string())
        }
    }

    /// The output Windows keeps for this process ("" = the Windows default), or None when the
    /// process has no sound open (Windows won't say then).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn app_device(pid: u32) -> Option<String> {
        with_com(|| {
            let f = factory().ok()?;
            get_persisted(&f, pid, 1).ok().map(|p| endpoint_of(&p))
        })
    }

    /// What happened to one process.
    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub enum Moved {
        Moved,
        /// Already on that device: left alone, since moving it anyway restarts its sound.
        Already,
        /// The process has no sound open right now.
        NoSound,
    }

    pub fn set_app_device(pid: u32, endpoint: &str) -> Result<Moved, String> {
        with_com(|| {
            let f = factory()?;
            let want = interface_path(endpoint);
            let same = |role| get_persisted(&f, pid, role).map(|c| c.eq_ignore_ascii_case(&want));
            match (same(0), same(1)) {
                (Ok(true), Ok(true)) => return Ok(Moved::Already),
                (Err(E_INVALIDARG), _) | (_, Err(E_INVALIDARG)) => return Ok(Moved::NoSound),
                _ => {}
            }
            let id = HString::new(&want)?;
            unsafe {
                let set: extern "system" fn(*mut c_void, u32, i32, i32, *mut c_void) -> i32 =
                    std::mem::transmute(f.slot(SLOT_SET_PERSISTED));
                for role in [0, 1] {
                    let hr = set(f.0, pid, 0, role, id.0);
                    if hr == E_INVALIDARG {
                        return Ok(Moved::NoSound);
                    }
                    if hr != 0 {
                        return Err(hresult(
                            "Windows didn't accept the change on this version",
                            hr,
                        ));
                    }
                }
            }
            Ok(Moved::Moved)
        })
    }

    /// Make `endpoint` Windows' default playback device for everything, media and calls.
    pub fn set_default_device(endpoint: &str) -> Result<(), String> {
        use windows_sys::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
        with_com(|| unsafe {
            let mut out = std::ptr::null_mut();
            let hr = CoCreateInstance(
                (&POLICY_CLSID as *const GUID).cast(),
                std::ptr::null_mut(),
                CLSCTX_ALL,
                (&POLICY_IID as *const GUID).cast(),
                &mut out,
            );
            if hr != 0 || out.is_null() {
                return Err(hresult("Windows didn't accept the change", hr));
            }
            let config = Com(out);
            let set: extern "system" fn(*mut c_void, *const u16, i32) -> i32 =
                std::mem::transmute(config.slot(SLOT_SET_DEFAULT));
            let wide: Vec<u16> = endpoint.encode_utf16().chain(std::iter::once(0)).collect();
            for role in 0..3 {
                let hr = set(config.0, wide.as_ptr(), role);
                if hr != 0 {
                    return Err(hresult("Windows didn't accept the change", hr));
                }
            }
            Ok(())
        })
    }
}

#[cfg(windows)]
#[allow(unused_imports)]
pub use imp::{app_device, endpoint_of, set_app_device, set_default_device, Moved};

#[cfg(not(windows))]
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Moved {
    Moved,
    Already,
    NoSound,
}

#[cfg(not(windows))]
pub fn app_device(_pid: u32) -> Option<String> {
    None
}

#[cfg(not(windows))]
pub fn set_app_device(_pid: u32, _endpoint: &str) -> Result<Moved, String> {
    Err("Only available on Windows".into())
}

#[cfg(not(windows))]
pub fn set_default_device(_endpoint: &str) -> Result<(), String> {
    Err("Only available on Windows".into())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn interface_paths_turn_back_into_endpoint_ids() {
        assert_eq!(
            endpoint_of(
                r"\\?\SWD#MMDEVAPI#{0.0.0.00000000}.{3766a8f4-391c-471e-87d1-0f41626dac51}#{e6327cad-dcec-4949-ae8a-991e976a79d2}"
            ),
            "{0.0.0.00000000}.{3766a8f4-391c-471e-87d1-0f41626dac51}"
        );
        assert_eq!(endpoint_of(""), "");
    }

    #[test]
    fn a_process_without_sound_is_reported_not_failed() {
        // This test's own process has no audio session.
        assert_eq!(
            set_app_device(std::process::id(), "").unwrap(),
            Moved::NoSound
        );
        assert_eq!(app_device(std::process::id()), None);
    }

    /// Against a real app: SM_TEST_PID=<pid with sound open> cargo test live_app -- --ignored
    #[test]
    #[ignore]
    fn live_app_keeps_its_route() {
        let pid: u32 = std::env::var("SM_TEST_PID").unwrap().parse().unwrap();
        let now = app_device(pid).expect("that process has no sound open");
        println!("{pid} plays to {now:?}");
        assert_eq!(set_app_device(pid, &now).unwrap(), Moved::Already);
    }
}
