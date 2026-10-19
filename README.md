# Sleekmeeter

A modern face for Voicemeeter Standard, Banana and Potato. Sleekmeeter sits on top of Voicemeeter and controls it through the official Voicemeeter Remote API — Voicemeeter keeps doing the audio, Sleekmeeter is just a nicer mixer to look at and use.

![Sleekmeeter's mixer: five input channels and two outputs, each with an LED meter, a metal fader cap and lit routing buttons](docs/screenshots/mixer.png)

**Mini mode and the tray volume panel:** one slim row per channel, with a meter, a fader and a mute button. Double-click the tray icon to open it right above the tray.

![Mini mode: one row per channel with an LED meter, a fader and a mute button](docs/screenshots/volume-panel.png)

## Requirements

- Windows 10 or 11 (WebView2 comes with both)
- Voicemeeter Standard, Banana or Potato installed (Sleekmeeter loads `VoicemeeterRemote64.dll` from its install folder and adapts its layout to the edition you run)

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
| Gear button | Settings: OLED pure black, startup, volume overlay, updates and global shortcuts |
| **⋯** menu | Show the Voicemeeter window, restart the audio engine, clear solos |

Each strip is as wide as its name, so names show in full, and the input and output sections stay centred in the window. Click the dB readout under a fader to type an exact level.

For OLED screens, turn on **Settings → Appearance → Pure black for OLED screens**. Everything that isn't information turns true black, including the tray panel and the volume overlay.

![The mixer in pure black for OLED screens](docs/screenshots/oled.png)

Meters show post-fader levels on the same scale as the fader, so you can see signal and fader position together. Everything stays in sync with Voicemeeter itself, MIDI controllers and other remote apps.

### Tray volume panel

Double-click the tray icon to open a small volume panel just above it: one fader and mute button per visible channel. It stays on top and can't be moved or resized; double-click the tray icon again or click **×** to close it, or **Open mixer** for the full window. A single click on the tray icon still shows or hides the mixer, and the tray menu has **Open volume panel** too.

### Shortcuts and the volume overlay

Global shortcuts work in any app. The defaults are **Ctrl+Alt+M** (mute input 1), **Ctrl+Alt+Up / Down** (A1 volume) and **Ctrl+Alt+S** (show or hide Sleekmeeter); change or add them in Settings. When a level changes while Sleekmeeter isn't in front — from a shortcut, a MIDI controller or a Stream Deck — a small overlay shows which channel changed and its new level.

### Switching scenes automatically

In **Scenes → Switch automatically**, add a rule such as: when `obs64.exe` starts, load **Streaming**; when it closes, load **Default**. Sleekmeeter checks running apps every couple of seconds. If several rule apps are open, closing one goes back to the scene of the one started before it. Apps that are already running when Sleekmeeter starts don't trigger a switch.

### Updates

When Sleekmeeter starts it checks this repository's latest release. If there's a newer version, an **Update to …** button appears in the header; it opens the release page, or you can skip that version. Turn the check off in Settings.

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

Open `src/index.html` in any browser. With no Voicemeeter available it runs against a simulated Voicemeeter Banana. Add `?edition=1` (Standard) or `?edition=3` (Potato) to try the other layouts, `?panel` for the tray panel, `?update` for the update button, or `?offline` for the "not running" screen.

## How it works

- `src-tauri/src/vm.rs` finds Voicemeeter through its uninstall registry key, loads `VoicemeeterRemote64.dll`, and wraps the `VBVMR_*` functions (login, get/set parameters, levels, run).
- `src-tauri/src/main.rs` polls `VBVMR_IsParametersDirty` and `VBVMR_GetLevel` about 30 times a second, sends `vm-state` and `vm-levels` events to the window, and exposes commands for setting parameters and managing scenes.
- `src-tauri/src/settings.rs` keeps settings in `settings.json`; `win.rs` handles start with Windows and Voicemeeter's window; `apps.rs` lists running apps for automatic scenes; `update.rs` checks GitHub for new releases.
- `src/` is the interface (plain HTML, CSS and JavaScript). `engine.js` talks to the Rust side inside the app, or to the simulator in a browser. `osd.html` is the volume overlay.

Parameter names follow the Voicemeeter Remote API documentation (e.g. `Strip[0].Gain`, `Strip[3].B1`, `Bus[0].Mute`), so adding more controls is mostly a matter of adding buttons that call `engine.setFloat(...)`.

## License

Sleekmeeter is released under the MIT License (see `LICENSE`).

## Credits

Uses the [Voicemeeter Remote API](https://github.com/vburel2018/Voicemeeter-SDK) by Vincent Burel / VB-Audio, free to use in projects that interact with Voicemeeter. Voicemeeter itself is donationware from VB-Audio. Font: Saira Semi Condensed (SIL Open Font License, see `src/fonts/OFL.txt`).

Sleekmeeter is an independent project and isn't affiliated with or endorsed by VB-Audio. Voicemeeter is a trademark of VB-Audio Software.
