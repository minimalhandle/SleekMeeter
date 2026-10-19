# Sleekmeeter

A modern face for Voicemeeter Banana. Sleekmeeter sits on top of Voicemeeter and controls it through the official Voicemeeter Remote API — Voicemeeter keeps doing the audio, Sleekmeeter is just a nicer mixer to look at and use.

![Sleekmeeter's mixer: five input strips and three outputs, each fader doubling as a level meter](docs/screenshots/mixer.png)

<img src="docs/screenshots/volume-panel.png" width="300" align="right" alt="The tray volume panel: one slim fader and mute button per channel">

**Tray volume panel:** double-click the tray icon for a compact panel with every channel, right above the tray.

<br clear="right">

## Requirements

- Windows 10 or 11 (WebView2 comes with both)
- Voicemeeter Banana installed (Sleekmeeter loads `VoicemeeterRemote64.dll` from its install folder)

## Run it

Sleekmeeter is portable: put `Sleekmeeter.exe` in any folder and run it. Scenes are saved in a `scenes` folder next to the exe.

If Voicemeeter isn't running, Sleekmeeter offers to start it. Closing the window keeps Sleekmeeter in the tray; left-click the tray icon to bring it back, right-click → **Quit Sleekmeeter** to exit.

## Using the mixer

| Do this | To |
| --- | --- |
| Drag a fader (hold **Shift** for fine moves) | Change level |
| Double-click a fader | Reset to 0 dB |
| Right-click a fader (or press Enter on it) | Type an exact level, like `-10`, `-10db` or `+3 dB` |
| Scroll over a fader (**Alt** for 0.1 dB steps) | Nudge by 1 dB |
| Focus a fader, then ↑ ↓ / PgUp PgDn / 0 | Keyboard control |
| Click **A1–A3 / B1–B2** on an input | Route it to that output |
| Double-click a name (or F2) | Rename the strip or bus in Voicemeeter |
| Click a strip's icon | Open its panel: color, icon, hide, device, pan, compressor, gate, EQ (virtual inputs) or bus mode (outputs) |
| **Scenes** | Save or recall your whole Voicemeeter setup |
| Pin button | Keep Sleekmeeter on top of other windows |
| Mini mode button | Switch to a small window with one row per channel |
| Gear button | Settings: startup, volume overlay and global shortcuts |
| **⋯** menu | Show the Voicemeeter window, restart the audio engine, clear solos |

Meters show post-fader levels on the same scale as the fader, so you can see signal and fader position together. Everything stays in sync with Voicemeeter itself, MIDI controllers and other remote apps.

### Tray volume panel

Double-click the tray icon to open a small volume panel just above it: one fader and mute button per visible channel. It stays on top and can't be moved or resized; double-click the tray icon again or click **×** to close it, or **Open mixer** for the full window. A single click on the tray icon still shows or hides the mixer, and the tray menu has **Open volume panel** too.

### Shortcuts and the volume overlay

Global shortcuts work in any app. The defaults are **Ctrl+Alt+M** (mute input 1), **Ctrl+Alt+Up / Down** (A1 volume) and **Ctrl+Alt+S** (show or hide Sleekmeeter); change or add them in Settings. When a level changes while Sleekmeeter isn't in front — from a shortcut, a MIDI controller or a Stream Deck — a small overlay shows which channel changed and its new level.

### Startup

In Settings you can start Sleekmeeter with Windows (optionally straight to the tray), start Voicemeeter automatically, and hide Voicemeeter's own window when it starts. **⋯ → Show Voicemeeter window** always brings it back.

All of this is saved in `settings.json` next to the exe.

## Build it

### Option A: GitHub Actions (no tools needed)

Push this folder to a GitHub repository. The included workflow (`.github/workflows/build-windows.yml`) builds on a Windows runner; download **Sleekmeeter-portable** from the run's Artifacts section.

### Option B: on your PC

1. Install [Rust](https://rustup.rs) (default MSVC toolchain, with the Visual Studio C++ build tools it asks for) and [Node.js](https://nodejs.org) 20+.
2. In this folder:
   ```
   npm install
   npm run build
   ```
3. The app is at `src-tauri\target\release\sleekmeeter.exe`.

For live development with Voicemeeter running: `npm run dev`.

## Preview the UI without Windows

Open `src/index.html` in any browser. With no Voicemeeter available it runs against a simulated Voicemeeter Banana. Add `?offline` to the URL to see the "not running" screen.

## How it works

- `src-tauri/src/vm.rs` finds Voicemeeter through its uninstall registry key, loads `VoicemeeterRemote64.dll`, and wraps the `VBVMR_*` functions (login, get/set parameters, levels, run).
- `src-tauri/src/main.rs` polls `VBVMR_IsParametersDirty` and `VBVMR_GetLevel` about 30 times a second, sends `vm-state` and `vm-levels` events to the window, and exposes commands for setting parameters and managing scenes.
- `src-tauri/src/settings.rs` keeps settings in `settings.json`; `win.rs` handles start with Windows and Voicemeeter's window.
- `src/` is the interface (plain HTML, CSS and JavaScript). `engine.js` talks to the Rust side inside the app, or to the simulator in a browser. `osd.html` is the volume overlay.

Parameter names follow the Voicemeeter Remote API documentation (e.g. `Strip[0].Gain`, `Strip[3].B1`, `Bus[0].Mute`), so adding more controls is mostly a matter of adding buttons that call `engine.setFloat(...)`.

## License

Sleekmeeter is released under the MIT License (see `LICENSE`).

## Credits

Uses the [Voicemeeter Remote API](https://github.com/vburel2018/Voicemeeter-SDK) by Vincent Burel / VB-Audio, free to use in projects that interact with Voicemeeter. Voicemeeter itself is donationware from VB-Audio. Font: Barlow Semi Condensed (SIL Open Font License, see `src/fonts/OFL.txt`).

Sleekmeeter is an independent project and isn't affiliated with or endorsed by VB-Audio. Voicemeeter is a trademark of VB-Audio Software.
