//! Windows tells us when an audio device is plugged in, unplugged, enabled, disabled or made
//! the default. The device watchers (devwatch, winout, btwatch) sleep until that happens
//! instead of reading every device list every second or two.

use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

struct Changes {
    count: Mutex<u64>,
    bell: Condvar,
}

fn changes() -> &'static Changes {
    static C: OnceLock<Changes> = OnceLock::new();
    C.get_or_init(|| Changes {
        count: Mutex::new(0),
        bell: Condvar::new(),
    })
}

/// Set once Windows accepted the listener. Without it the watchers keep their old timers.
static LISTENING: OnceLock<bool> = OnceLock::new();

fn ring() {
    let c = changes();
    if let Ok(mut n) = c.count.lock() {
        *n += 1;
    }
    c.bell.notify_all();
}

/// Waits until a device changes after `seen`, or `timeout` passes. Returns true when something
/// may have changed, and updates `seen`. Without Windows' notifications it just waits
/// `fallback` (the watcher's old interval) and says yes, so nothing is missed.
pub fn wait(seen: &mut u64, timeout: Duration, fallback: Duration) -> bool {
    if LISTENING.get() != Some(&true) {
        std::thread::sleep(fallback);
        return true;
    }
    let c = changes();
    let Ok(mut n) = c.count.lock() else {
        std::thread::sleep(fallback);
        return true;
    };
    let until = Instant::now() + timeout;
    while *n == *seen {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        n = match c.bell.wait_timeout(n, left) {
            Ok((guard, _)) => guard,
            Err(_) => return true,
        };
    }
    *seen = *n;
    true
}

/// The current change count, to start waiting from.
pub fn now() -> u64 {
    changes().count.lock().map(|n| *n).unwrap_or(0)
}

#[cfg(windows)]
mod sys {
    use windows::core::{implement, Result, PCWSTR};
    use windows::Win32::Media::Audio::{
        EDataFlow, ERole, IMMDeviceEnumerator, IMMNotificationClient, IMMNotificationClient_Impl,
        MMDeviceEnumerator, DEVICE_STATE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

    #[implement(IMMNotificationClient)]
    struct Client;

    #[allow(non_snake_case)]
    impl IMMNotificationClient_Impl for Client_Impl {
        fn OnDeviceStateChanged(&self, _: &PCWSTR, _: DEVICE_STATE) -> Result<()> {
            super::ring();
            Ok(())
        }
        fn OnDeviceAdded(&self, _: &PCWSTR) -> Result<()> {
            super::ring();
            Ok(())
        }
        fn OnDeviceRemoved(&self, _: &PCWSTR) -> Result<()> {
            super::ring();
            Ok(())
        }
        fn OnDefaultDeviceChanged(&self, _: EDataFlow, _: ERole, _: &PCWSTR) -> Result<()> {
            super::ring();
            Ok(())
        }
        // Property changes (names, formats) come often and mean nothing to the watchers.
        fn OnPropertyValueChanged(&self, _: &PCWSTR, _: &PROPERTYKEY) -> Result<()> {
            Ok(())
        }
    }

    /// Registers the listener and keeps it alive for the life of the app.
    pub fn listen() -> bool {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let ok = (|| -> Result<(IMMDeviceEnumerator, IMMNotificationClient)> {
                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
                let client: IMMNotificationClient = Client.into();
                enumerator.RegisterEndpointNotificationCallback(&client)?;
                Ok((enumerator, client))
            })();
            match ok {
                Ok(keep) => {
                    let _ = tx.send(true);
                    // Windows calls the client on its own threads; this one only keeps it alive.
                    loop {
                        std::thread::park();
                        let _ = &keep;
                    }
                }
                Err(e) => {
                    log_warn!("Device change notifications unavailable: {e}");
                    let _ = tx.send(false);
                }
            }
        });
        rx.recv().unwrap_or(false)
    }
}

/// Starts listening. Call once, before the watchers start.
pub fn start() {
    #[cfg(windows)]
    let ok = sys::listen();
    #[cfg(not(windows))]
    let ok = false;
    let _ = LISTENING.set(ok);
}
