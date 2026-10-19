# Changelog

## 0.5.1
- Smaller fader caps on the main mixer (32×38 instead of 46×54)
- No more stray horizontal scrollbar in mini mode

## 0.5.0
- New look, "Console": each channel is a hardware module with a glowing LED meter, a machined fader cap in its own slot, backlit routing and mute keys, and a big dB readout you can click to type a level
- Pure black theme for OLED screens (Settings → Appearance), also used by the tray panel and volume overlay
- Faster: meters and faders animate on the GPU without layout or repainting (in testing, repaints over 3 s of live meters dropped from about 2,500 to 4), and the meter loop idles when nothing moves
- Meter colours sit at their true levels: yellow from −9 dB, red above 0 dB, lined up with the fader scale
- Mica and Acrylic backdrops removed in favour of the new look

## 0.4.1
- Looks at home on Windows 11: Segoe UI Variable, Mica window backdrop, Acrylic tray panel, Fluent buttons, corners, focus rings and scrollbars, and toggle switches in Settings
- The connection dot pulses slowly while Voicemeeter is connected
- Each strip is as wide as its name, so names like "Speakers (Realtek(R) Audio)" show in full; mini mode and the tray panel widen their name column to match
- Input and output sections stay centred instead of stretching across a wide window
- Mute gets its own row on input strips, with Solo and Mono below
- The window appears once it's drawn, without a blank flash

## 0.4.0
- Works with Voicemeeter Standard and Potato as well as Banana; the layout adapts to the edition you run, with a denser layout for Potato's 16 channels
- **Start Voicemeeter** launches the edition you used last
- Update notifications: a header button when a newer release is on GitHub, with an option to skip a version or turn the check off
- Switch scenes automatically when an app starts or closes, set up in **Scenes → Switch automatically**

## 0.3.1
- Tray volume panel sizes itself to its content, no empty space at the bottom
- Screenshots in the README

## 0.3.0
- Right-click a fader (or press Enter on it) to type an exact level, like `-10`, `-10db` or `+3 dB`
- Double-click the tray icon for a pinned volume panel above the tray; also in the tray menu as **Open volume panel**
- Browser right-click menu removed outside text fields

## 0.2.0
- Channel colors, icons and hiding; LED-style meters
- Channel panel: device picker, pan, compressor, gate, EQ for virtual inputs, bus modes
- Mini mode and keep-on-top
- Global shortcuts with a shortcut recorder
- Volume overlay when levels change from another app, a MIDI controller or a Stream Deck
- Start with Windows, start Voicemeeter automatically, hide Voicemeeter's own window

## 0.1.0
- First version: fader-meters, routing, mute/solo/mono, renaming, scenes, tray icon
