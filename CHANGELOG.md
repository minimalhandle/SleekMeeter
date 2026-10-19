# Changelog

## 0.6.1
- Only one Sleekmeeter runs at a time: starting it again (for example from a pinned taskbar icon after closing the window to the tray) brings the running one back instead of opening a second copy
- The recorder shows how loud the recording is, and warns when it goes over 0 dB (which distorts the file) or when nothing is selected to record

## 0.6.0
- **Talk-over ducking:** other audio turns down while you talk and comes back when you stop. Pick the channel that talks, the channels to turn down, how much, and the level it starts at; the slider lights up with your voice so you can set it by eye. Ducked channels show **Ducking**, and their faders still move freely
- **Smooth fades:** mute fades out and unmute fades in; typed levels, double-click to 0 dB, volume shortcuts and scene changes glide instead of jumping. Fade times are in Settings, and fades can be turned off
- **Recorder** (Banana and Potato): record and play with Voicemeeter's built-in recorder from a new **Rec** button. Pick inputs or outputs to record, the format, a file to play (open or drop it on the window), where it plays and how loud. The clock runs in the header while recording
- **Devices that come back:** when headphones or another device Voicemeeter uses comes back after being unplugged or disconnected, Sleekmeeter restarts the audio engine for you (Settings → Audio devices)
- New shortcut actions: turn talk-over ducking on or off, and start or stop recording, with the on-screen overlay confirming each

## 0.5.2
- Remembers the window's size, position and maximized state between launches (if that spot's monitor is gone, it opens centred instead)
- First launch opens the window just wide enough for your mixer, centred, instead of a fixed size with empty space
- Leaving mini mode goes back to your remembered size
- Update notifications also find releases marked as pre-release

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
