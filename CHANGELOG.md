# Changelog

## 0.20.0

- **Game / Chat** can assign and verify separate Windows app routes, pin a live slider to the mixer, and move or centre from global shortcuts. Potato verifies the listening gain layers after every change and shows the resulting levels. It warns about Composite outputs and keeps the other mixes intact.
- **Mute destinations** let each input’s main Mute button target Everyone, Headphones, Audience, or a chosen Voice chat bus.
- **Private cue and mix switching** let you audition a source in headphones and switch between Personal and Stream in Listen to a mix.
- **OBS audio tracks** reports live, VOD and recording track assignments, source mute states, and possible duplicate capture.
- Added **Hadal**, a dark animated theme with deep ocean blue, moving currents and sonar rings. It includes matching mini, tray, and volume overlay styling.
- Retired **Lunar**, **Onyx**, **After Hours**, **Caldera**, and **Blueprint**. Sleekmeeter switches those selections to Console.
- Console has a brushed hardware finish and a warm lamp glow, OLED black has clearer edges and a soft bloom on lit keys, and Glass has sharper translucent edges that catch the light under the pointer.
- Neon has richer synth lighting, Terminal has softer scanlines, Block has colour-coded edges, and Arcade has brighter cabinet panels. Bubblegum, Peaches & Cream, and Sticker Bomb now show distinct emoji for the newer channel icons.
- Kokiri Forest has richer forest greens with sapphire near the base, gold trim, drifting fairies, and shield faders.
- Neon and Arcade join Glass and Kokiri Forest in supporting ambient theme motion. Choose Off, Subtle, or Full in Appearance. Windows reduced motion takes priority.
- Fixed the muted Sleepy label in Peaches & Cream, strengthened mute contrast across themes, and matched square Settings switch knobs to their tracks in Block, Arcade, and Terminal.
- Reordered the 12 themes in Appearance from dark to light: Console, OLED black, Glass, Hadal, Kokiri Forest, Neon, Terminal, Arcade, Block, Sticker Bomb, Bubblegum, and Peaches & Cream. Their controls, previews, and volume overlays are refined, and animated backgrounds blend into the window edges, with separate Off, Subtle, and Full settings.
- Buttons, chips, fader caps and channel strips now ease between states in every theme. Hadal's caps glow cyan, Kokiri Forest's lit keys glow like lanterns, Neon's sign flickers now and then, Terminal has phosphor glow, Arcade moves in 8-bit steps, Block has a halftone backdrop, Sticker Bomb's stickers straighten when you point at them, and Mute bounces in Bubblegum, Peaches & Cream, and Sticker Bomb.

## 0.19.0
Everything since 0.18.1. The Stream Deck plugin moves to 0.19.0.1 with a Mic clean-up key and an editable Stream Deck + profile.

- **Glass refresh:** Glass is the theme’s name again. The refreshed design brings translucent panels with brighter edges, pearl faders, and a drifting aurora. Choose Off, Subtle, or Full under **Theme motion**. Windows reduced-motion settings take priority. Translucent gradients reduce the rendering cost of the mixer strips, and meter updates are limited to the visible mixer view.
- **Quick Actions:** press **Ctrl+K** to search for channels, scenes, output profiles, tools and settings. Use the arrow keys and Enter to open a result.
- **Audio Event History:** see when Windows changed its playback device, a hardware output switched to a fallback, an app route was reapplied, or a VST3 plugin was quarantined. Open an event to jump to its controls. Sleekmeeter keeps up to 200 entries locally.
- **Mic Chain and guided tune-up:** use Mic Chain for manual processing or measure room tone, normal speech and a loud phrase to get a fader suggestion and, where appropriate, a gentle noise gate. Preview selected changes for eight seconds on the input’s existing routes or apply them directly.
- **Mixer appearance:** the top buttons sit directly on the toolbar across themes. Channel Look offers eight more icons and eight more colours. The **⋯** menu groups tools by purpose.
- **Glass polish:** brighter aurora colours, a sweeping reflection in Full motion, and glossy mute buttons with a pink glow while muted.
- **Stream toolbar** groups streaming tools and lets you pin individual controls. Live, recording, and BRB indicators provide shortcuts to their controls.
- **Apps workspace** has Volumes, Saved assignments, and Audio Flow tabs. Audio Flow includes the route inspector and guided tests.
- **Focused mixer** shows active sends and expands the full routing grid per input.
- **Channel drawer** groups Routing, Sound, Apps, and Appearance, with a shortcut to the selected hardware input’s effects chain.
- **Status shortcuts** open setup checks from the header, affected plugin chains from their inputs, and fallback policies from the current devices list in Outputs.

- **Live Audio Flow** maps Windows apps, Voicemeeter inputs and outputs. Select a node to highlight its signal paths.
- **Listen to a mix** plays a virtual Voicemeeter output live on a selected physical playback device without changing the mixer routes.
- **Saved app assignments** let you set up routes before an app has a Windows audio session.
- **Stream Deck + profile** provides four dials and eight keys. Save the profile from Settings and import it into Stream Deck.
- **Stereo VST3** preserves left and right on hardware inputs when you select Stereo hardware input for a chain.

- **Settings** now has six searchable categories. Fresh installs open in the foreground, start Voicemeeter on request, use Subtle theme motion, and leave level history and talking-while-muted alerts off. Existing users keep their settings.
- Settings category labels wrap inside their buttons across themes. Compact Settings uses a grid for navigation and keeps long fader-group names inside their cards.
- **Game / Chat balance** lets you choose two input strips, favour either side and restore the original levels. On Potato it adjusts only the chosen listening output.
- **Personal / Stream mix** shows listening and audience routes and faders side by side in Potato's Output Mix.
- **Guided audio tests** send test tones down the game, chat and stream paths. Record a four-second mic take once, then listen to it raw and processed at matched levels.
- **Shared fallback policies** can be copied or linked across hardware outputs. Outputs explains the active device, the preferred available device, or why automatic switching is paused.
- **Portable mic-chain presets** move NVIDIA settings and VST3 state between PCs. Preview plugin and runtime compatibility before applying a preset to the selected mic.

- The Apps tray and App Volumes share a recent Windows audio session scan. The route inspector updates while open and highlights the first likely blockage.
- **Theme motion** also offers Off, Subtle, and Full for Kokiri Forest. Compact layouts have clearer labels, active routing indicators, and keyboard focus outlines.
- Hold **Alt** while moving a linked fader to adjust only that channel.

- **Apps on channels:** a small stack icon shows which inputs have routed apps. Hover anywhere on an input to see its apps beside the strip, or click the icon to keep the list open. Kokiri Forest uses a green rupee and a sapphire inventory panel.
- Fixed the app list opening away from its channel on Glass and other themes with filtered or transformed panels.
- **Audio route inspector:** in **Apps → Volumes…**, trace an app's Windows playback sessions into Voicemeeter and through its enabled outputs. The inspector flags common blocks such as a muted input or missing output device.
- **Scene preview:** select a scene to review its level, mute, routing, and mic-chain changes before applying it. Scenes saved with this version include routing in the preview.
- **VST3 crash recovery:** when the helper stops during a tracked plugin load or audio call, Sleekmeeter bypasses the plugin involved and can restart the rest of the chain. **Settings → Mic clean-up and plugins** lets you bypass or retry individual plugins.
- **Theme polish:** Kokiri Forest has darker forest panels with drifting fairy lights and supports reduced motion.
- **Mixer undo and linked faders:** use the undo button or Ctrl+Z for a mixer fader, mute, or route change. Link main faders in Settings to move them together while keeping their dB offsets.
- **Device fallback chains:** in Outputs, rank devices for each hardware output. Sleekmeeter switches to the first available device and returns to a preferred device when it reconnects.
- **Persistent plugin quarantine:** bypassed VST3 plugins stay isolated across app restarts until you retry them.
- Kokiri Forest’s mini faders use a smaller shield with a clear face.

- Retired Titanium, Afterburner, and Opal. Saved selections and scene rules using them fall back to Console.
- **Two new mixer themes:** Kokiri Forest pairs forest green, gold, and sapphire with Hylian Shield faders, Triforce emblems, Cinzel headings, and “Hey!” / “Listen!” mute controls. After Hours pairs blackberry lacquer with soft pink lighting.

- **Speaker echo removal:** for people who use speakers instead of headphones. In **Settings → Mic clean-up and plugins**, tick **Remove my speakers from this mic** and NVIDIA's AI takes what your speakers play (A1, or the output you pick) out of the mic, so your game and friends don't echo onto your stream or Discord. Needs an NVIDIA RTX card, like the noise removal
- **More than one mic:** **+ Add a mic** gives another hardware input, like a guest mic, its own clean-up and plugins. Each mic has a tab with a green dot while it's running
- **Hear the difference:** **Listen to this mic** sends the mic to A1 while you set it up (and switches A1 back off after), and **Hold to hear it without** plays the raw mic, at the same delay, for as long as you hold it
- **Switch clean-up from anywhere:** a shortcut, the new **Mic clean-up** Stream Deck key, the phone remote and Twitch commands can switch one mic's clean-up and plugins off and back on, or every mic at once. Settings shows when a mic was switched off this way, with a button to switch it back on
- **Scenes remember mic clean-up:** saving a scene keeps which mics have clean-up on and how strong NVIDIA's clean-up is, and loading it puts that back, so a podcast scene can use a lighter touch than a loud game. Scenes saved before keep the mic as it is
- **Plugin presets:** each plugin's **Presets** menu saves its current settings under a name, and loads them again on any mic with the same plugin
- **Crash-safe plugins:** VST3 plugins now run in a separate helper process. A plugin that crashes no longer closes Sleekmeeter: your mic carries on without plugins, Settings says what happened, and they start again (they stay off for a while after three crashes in two minutes). A plugin that stops answering is skipped instead of holding up your mic

## 0.18.1
- **VST3 plugins on your mic:** **Settings → Mic clean-up and plugins** can put your own VST3 effects on the mic, like an EQ, a de-esser or a compressor. **Add a plugin…** lists the effects installed in the usual VST3 folders, and **Browse for a .vst3 file…** picks one from anywhere. They run in the order listed, after NVIDIA's clean-up if that's on. **Edit** opens the plugin's own window, and its settings are saved and come back after a restart. Each one can be switched off, moved up or down, or removed. Like the NVIDIA clean-up, they work inside Voicemeeter before its fader, so every output hears them, and only while Sleekmeeter is open. VST3 only (not the older VST2 .dll plugins); a plugin that crashes can close Sleekmeeter
- **Mic clean-up with NVIDIA's AI:** on a PC with an NVIDIA RTX graphics card, **Settings → Mic clean-up and plugins** removes background noise (keyboard, fans, the dog), room echo, or both from your mic, using NVIDIA's free Audio Effects SDK on the graphics card. Pick the mic and how strong it should be. It works inside Voicemeeter before the fader, gate and compressor, so every output gets the clean voice, and adds about 25 ms of delay. It runs while Sleekmeeter is open (your mic carries on without it if Sleekmeeter closes), and needs NVIDIA's Audio Effects SDK runtime installed and Voicemeeter at 48 kHz. Sleekmeeter doesn't include or download NVIDIA's files

## 0.18.0
Everything since 0.17.1. The Stream Deck plugin moves to 0.18.0.0 with it.

- **Mute on one output:** right-click an input's **Mute** (in the mixer or the tray panel) to mute it on just B1, B2 or any other output it's sent to, for example your mic in Discord while your stream still hears you. The Mute button gets a red outline listing those outputs, and unmuting turns back on exactly those. On Potato it fades out and back in like a normal mute, and the input's own level on that output is kept. Sleekmeeter remembers it after a restart, and turning that output's button back on yourself ends it too
- **Stream Deck: Mute on outputs (plugin 0.18.0.0):** a key that does the same: mute an input on the outputs you tick (B1 to B3 unless you change them) while your headphones still hear it, and press again to unmute exactly those. It turns red while muted and follows mutes made in the mixer
- **"You're muted":** talk into a muted mic and the overlay says so, even with Sleekmeeter in the tray, and the mic's strip flashes red. Not while Be right back is on, or while a push-to-talk key is up (unless you want it then too). On by default; set the mic and how loud counts as talking in **Settings → Going live**
- **Go-live check:** the new **Go live** button checks that your mic is on and sent to the stream, the stream output isn't muted and has sound, OBS is linked, Windows plays through Voicemeeter, and Twitch chat and Instant replay are running. Anything wrong comes first, most with a button that fixes it. With the OBS link, it also runs a few seconds after you start streaming and opens if something's wrong
- **Silent stream warning:** in **Settings → Going live**, Sleekmeeter can warn you when your stream output has had no sound for a while (5 to 60 seconds), or when it clips. By default only while OBS says you're live
- **Music off stream:** keep your music out of the stream and your VODs while you still hear it. Choose the channel your music plays on and when: while you're live, while OBS records, either, or only when you press its key. Sleekmeeter switches that channel's button for the stream output off (with a fade on Potato) and back on afterwards. The music key in the header, a shortcut, a Twitch command or the phone remote switches it by hand
- **Instant replay:** keep the last 15 to 120 seconds of your stream in memory, and save them as a WAV file in **Music\Sleekmeeter replays** with the replay button in the header, a shortcut, a Twitch command or the phone remote. Nothing is written to disk until you save
- **Channel point rewards:** in **Settings → Twitch chat commands**, a channel point reward can play a sound or run any other command action. Press **Add a reward…** and redeem it once in your chat. Only rewards that ask the viewer to type something show up in chat, and what they type can pick the sound
- **Stream output setting:** **Settings → Going live → Stream gets** says which output OBS listens to (B2 unless you change it). The go-live check, the silent stream warning, Music off stream and Instant replay all use it
- Shortcuts, Twitch commands and the phone remote can also **save an instant replay** and switch **Music off stream**
- Fixed: **Check for updates** said "Couldn't reach GitHub" when GitHub's hourly limit for your internet connection was used up (60 checks an hour, shared with everything on that connection). Sleekmeeter now reads GitHub's release pages instead, which that limit doesn't cover, so update checks and in-app updates keep working. If those can't be reached either, it says what went wrong and when to try again

## 0.17.1
- **Show in Mix** (Potato): untick it in an output's settings to leave that output out of **Mix**, for example A3 to A5 when you don't use them, while its fader stays in the mixer. Outputs hidden from the mixer stay out of Mix too. Mix updates straight away, also when popped out
- Fixed: in **Mix** (Potato), the A/B buttons under the sliders never lit up when on, so a route turned on from the Stream Deck, Voicemeeter or a strip only showed as a brighter slider. They now light up like the strips' buttons, and a button you clicked earlier keeps following changes made elsewhere

## 0.17.0
Everything since 0.15.3. The Stream Deck plugin is now numbered with the app: plugin 0.17.0.0 goes with Sleekmeeter 0.17.

**Output mix (Voicemeeter Potato)**
- **Mix view:** **Mix** in the header shows every input's level on every output at once, like Voicemeeter's Streamer View, with each output's on/off button under its slider. Drag or scroll a slider, or double-click it to match the input's main fader
- **In its own window:** the button next to Mix's close button pops the output mix out into a window of its own, for example on a second screen. It remembers its size and place, and opens again at the next start if you left it open

**Stream Deck (plugin 0.17.0.0)**
- **Swap route:** one key switches between two routes, for example which mic goes to B2, or whether your game plays on A1 or A2. One turns off as the other turns on, and the key shows which one is live. Banana and Potato
- **Level step on one output (Potato):** a Level step key can change an input's level on one output only, for example game +5 dB in your headphones without changing your stream, like a Voicemeeter macro with `Strip(2).GainLayer(0) += 5.0`
- **Hold to repeat:** holding a Level step key keeps stepping until you let go
- Fixed: **Now Playing** showed "Open Spotify" or "Nothing playing" on most PCs, because Windows' default PowerShell setting stopped it from reading what's playing. It now works everywhere, and **Current Windows media app** also finds players such as Apple Music
- Fixed: **Swap route** and **Faders set** keys left on the input or output their settings showed didn't use it

**Updates**
- **What's new:** after an update, Sleekmeeter shows what changed, once. **Settings → Updates → What's new** shows it again any time
- **Check for updates:** a button in **Settings → Updates** checks straight away, and Sleekmeeter looks again every 6 hours while it runs
- **Test versions:** with **Also offer test versions** on, they now come from a separate beta page, so only people who opted in get them
- Fixed: installing an update turned off **Start Sleekmeeter with Windows**. Updates now keep it, and Sleekmeeter puts it back if a manual install removed it. If it's off for you, tick it again once in **Settings → Startup**

## 0.15.7 (test version)
- Fixed (Stream Deck plugin 0.16.3.1): Now Playing showed "Open Spotify" or "Nothing playing" on most PCs, because Windows' default PowerShell setting stopped the plugin's media reader from starting. It now starts everywhere, without changing that setting
- Now Playing set to **Current Windows media app** also finds players that Windows doesn't mark as current, such as Apple Music, and says **Media unavailable** if it can't read Windows' media controls at all
- Fixed (Stream Deck plugin 0.16.3.1): a **Swap route** key whose first input was left on the input its settings showed (input 1) said "Choose 2 routes" and did nothing
- Fixed (Stream Deck plugin 0.16.3.1): a **Faders set** key left on the output its settings showed (B3) set every output instead

## 0.15.6 (test version)
- **Stream Deck: Swap route (plugin 0.16.3.0):** a key that switches between two routes with one press, for example which mic goes to B2, or whether your game plays on A1 or A2. One route turns off as the other turns on, and the key shows which one is live. Works on Banana and Potato
- **Output mix in its own window (Potato):** the new button next to the close button in **Mix** pops the output mix out into a window of its own, for example to keep it open on a second screen. Its sliders grow with the window, it remembers its size and place, and it opens again at the next start if you left it open. **Reset the layout** (Settings → Backup and layout) puts it back to its normal size

## 0.15.5 (test version)
- **Stream Deck: Level step on one output (plugin 0.16.2.0):** on Voicemeeter Potato, a Level step key can change an input's level on one output only, for example game +5 dB in your headphones (A1) without changing your stream. It does the same job as a Voicemeeter macro like `Strip(2).GainLayer(0) += 5.0`, without a second plugin
- **Stream Deck: hold to repeat:** holding a Level step key keeps stepping until you let go. Turn it off in the key's settings
- Fixed: installing an update turned off **Start Sleekmeeter with Windows**. Updates now keep it, and if a manual install removes it, Sleekmeeter adds it back the next time it starts. If it's already off for you, tick it again once in **Settings → Startup**

## 0.15.4 (test version)
- **Test versions come from a separate beta page:** with **Also offer test versions** on, Sleekmeeter also checks minimalhandle/SleekMeeter-beta, so test versions only reach people who opted in
- **Check for updates:** a button in **Settings → Updates** checks straight away, and Sleekmeeter also looks again every 6 hours while it runs, so a new version shows up without restarting
- **Output mix view (Potato):** **Mix** in the header shows every input's level on every output at once, like Voicemeeter's Streamer View, with the A/B buttons under each slider. Drag, scroll or double-click (to match the input's main fader)

## 0.15.3
- **Voicemeeter backups:** Sleekmeeter saves a copy of Voicemeeter's whole setup once a day, and before loading a scene, running the setup assistant or restoring a backup. **Settings → Backup and layout** lists them with a **Restore** button (your current setup is saved first)
- **Test versions:** **Settings → Updates → Also offer test versions** gets pre-releases as updates. Without it, Sleekmeeter now only offers full releases
- **Scenes keep each output's mix (Potato):** saving a scene also saves every input's gain layers, which Voicemeeter's scene file leaves out, and loading it puts them back
- **Stream Deck: Output mix dial and Faders set key (plugin 0.16.1.0):** turn a dial to set one input's level on one output, like Game on B3, or press a key to make the input faders set one output's mix. Potato only
- **App routing works with the window hidden:** apps you've sent to a channel are put back on it when they start again, even while Sleekmeeter sits in the tray or in mini mode
- **A different mix on each output (Potato):** Potato's gain layers give each input its own level on each output, for example less game on your stream than in your headphones, like Voicemeeter's Streamer View. Set them in an input's settings under **Level on each output**, or pick an output in **Faders set** above the inputs and the input faders set that output's mix
- **Your output mixes stay put (Potato):** with no output picked, Voicemeeter's main level resets every layer. Sleekmeeter's faders, mute fades, ducking, scenes and Be right back now move all of an input's layers together instead, so the differences are kept
- **Input limiter (Banana and Potato):** in an input's settings under Dynamics. At +12 dB it's off
- **Tray panel options:** Settings → Tray volume panel has a **Columns** layout with vertical sliders, a size from 60% to 100%, an opacity, and switches for channel icons, level meters and mute buttons. Each channel's settings can leave it out of the panel
- **Volume overlay options:** choose which screen the overlay appears on, and leave channels out of it from their settings
- Fixed: the volume overlay flickered while a level kept changing. It now fades in once and updates in place
- Fixed: the tray panel kept its old theme until it was reopened
- Fixed: the recorder clock kept running after a sound loaded by a Voicemeeter macro button (`Recorder.load`) had finished. Voicemeeter keeps reporting that playback as playing until Stop is pressed, so Sleekmeeter no longer shows a clock for playback it didn't start
- The user count is sent as soon as you say yes, instead of up to 10 minutes later. Saying no deletes the ID straight away

## 0.15.2
- **Anonymous user count, only if you say yes:** Sleekmeeter asks once whether it may send sleekmeeter.app a random ID, its version and your Voicemeeter edition once a day, so we know how many people use it. Nothing else is sent. Change it in **Settings → Privacy**; turning it off deletes the ID
- **Fix my audio:** if plugging devices in makes Windows play sound to them instead of Voicemeeter, the mixer goes quiet. Sleekmeeter now spots this, shows a **Fix my audio** button (also in **Check my setup**) that switches Windows back to Voicemeeter's input and restarts the audio engine, and can do it automatically with **Settings → Keep Windows sound on Voicemeeter**. Windows' device for calls is switched too

## 0.15.0
- **Stream Deck plugin offer:** Sleekmeeter finds the Stream Deck app or a Stream Deck that has been connected, and offers to install or update its plugin, which comes inside Sleekmeeter. It asks once per plugin version, and **Settings → Stream Deck** keeps the button. With a Stream Deck but no app, it offers Elgato's download page
- **New Stream Deck look (plugin 0.16.0.2):** Studio has dark surfaces, one clear symbol or value on each key, and short colour rails. Action IDs are unchanged, so your keys and dials carry over
- **Now Playing + channel dial:** album art, title, artist and track time from Spotify or the current Windows media app. Turn for a channel's level, tap to play or pause
- **Now Playing + tracks dial and Now Playing key:** turn the dial to change track, or put album art and progress on any key
- **App volume dial:** turn to change one app's volume, press or tap to mute it
- **Live meters:** Channel and Now Playing dials show a thin level meter that turns amber and red as a channel gets loud. Each dial has a Live meter setting
- **Faster media controls:** play, pause and track changes reach the player right after the press, and play or pause shows on the key or dial at once
- **Clearer route keys:** coloured bus, checkmark and ON when a route is on, dim bus, cross and OFF when it's off. A missing bus says which ones exist ("Only B1–B2"), and an outdated app says "Update Sleekmeeter"
- **Show text option:** each Stream Deck action can hide its names and captions for a cleaner symbol. Live states stay visible
- **Studio icon pack:** 486 matching icons for Sleekmeeter, Discord, Spotify, Twitch, OBS, Philips Hue, Revidi, Voicemod, system controls and navigation, as `Sleekmeeter-Studio-Icons.streamDeckIconPack`
- **Remote API:** new `/api/levels`, `/api/apps` and `/api/appvolume`, protected by the same key as the rest
- Fixed: Now Playing updates no longer wait for a dial press
- Fixed: opening a Stream Deck folder or page no longer flashes "Open Spotify / Waiting for media" while the current track loads
- Fixed: **Update now and restart** closed Sleekmeeter without installing the update or reopening. If an update can't start, Sleekmeeter now stays open and shows an error. Copies older than this version need this one from the download page once

## 0.14.0
- **App lists that stay open:** click a channel's app-count badge to pin its list open; click outside, click the badge again or press Escape to close it
- **Safer app removal:** each app has an explicit × button to return it to the Windows default; clicking its name no longer disconnects it
- **Tidier ⋯ menu:** grouped actions, a checkmark for Simple mode, and ↑/↓, Home/End, Enter and Escape keyboard controls
- **Lock channel arrangement:** prevent accidental header dragging in Settings while keeping all faders and buttons usable
- **Rack theme retired:** existing Rack users switch to Console. There are now fifteen themes
- Fixed: dragging a Sticker Bomb fader no longer adds a black halo around its starburst cap (including mini mode and the tray panel)
- **Four new themes:** **Afterburner** (graphite, orange LEDs and faceted metal faders), **Lunar** (satin aluminium, violet keys and circular fader pucks), **Onyx** (dark mix bays, electric blue and sculpted faders) and **Opal** (pearlescent white, mist and lilac). Each includes its own appearance card, mini mode, tray panel and matching volume overlay
- **Stream Deck: Route to bus key.** Turn an input's A1–A5 or B1–B3 route on or off from a key (say your mic to B3 for a game). It lights up and pulses slowly while the route is on. Needs the new Sleekmeeter build (the phone-remote server now reports routes) and the updated plugin
- **Stream Deck: Mute mic key.** A dedicated key that shows your microphone's state: green LIVE, or red MUTED with the mic crossed out. Optional Hold to talk mode. Update the plugin by double-clicking `streamdeck/Sleekmeeter.streamDeckPlugin`

- Fixed: mic-chain threshold sliders now match Voicemeeter's supported ranges: compressor −40 to −3 dB and gate −60 to −10 dB
- **Hide Solo, Mono and EQ:** **Settings → Channel buttons** leaves just Mute under each input and hides the Mono and EQ buttons on outputs, for a cleaner mixer. They're still in each channel's settings (click its icon), and a button that's switched on keeps showing so you can turn it off. New installs start with them hidden; if you already use Sleekmeeter nothing changes until you turn it on
- **Cleaner header:** BRB, Rec and Sounds are now small icon buttons next to the pin and mini-mode buttons. BRB still widens to **Back live** while you're away, and Rec shows its clock while it records. Don't stream? Turn off **Settings → Streamer mode** to hide all three (their shortcuts still work)
- Fixed: items in the **⋯** menu could wrap onto two lines in some themes
- **Tidier apps on channels:** apps dragged onto a channel no longer take up room under its name. A small tag in the channel's top corner shows how many apps are on it, and hovering the top of the channel lists them all by name (use × to put an app back on the Windows default). Every channel's A1/A2 buttons stay lined up however many apps it has
- **Simple mode:** **⋯ → Simple mode** hides Solo, Mono and EQ, every device name and the A4/A5 buttons in one click. Turn it off to get back exactly what you had

## 0.13.1
- **Centred channel names**, and **⋯ → Show / hide all device names** hides or shows the device line under every channel's name in one click (clicking a single name still toggles just that one)
- **Installer without administrator rights:** the installer is now a normal setup window (`Sleekmeeter-<version>-setup.exe`) that installs just for you with no Windows prompt, and in-app updates for it are silent. It no longer downloads or runs anything itself (that made antivirus programs flag the old Setup.exe): if Voicemeeter is missing it says so and offers to open VB-Audio's download page. The MSI is still published; if you used it before, uninstall that copy in Windows Settings first
- **Rearrange channels:** drag the top of a channel left or right to move it; the order is remembered and mini mode follows it. **⋯ → Reset channel order** undoes it
- **Click a channel's name** to hide or show the device line under it. Double-click still renames
- **Apps tray, like Wave Link:** **Apps** now opens a tray of the programs making sound. Drag one onto a channel (Voicemeeter's virtual inputs, or any input that listens to a virtual cable like CABLE-A) and it plays through that channel; chips on the channel show what's on it, and Sleekmeeter remembers each program's channel. The per-app volume list is under **Volumes…** in the tray
- **Stream Deck plugin:** dials for channel levels (Stream Deck +), plus keys for mute, level steps, scenes, sounds, Be right back, recording, talk-over ducking and output profiles. The keys show the live state. It's in the `streamdeck` folder; double-click the `.streamDeckPlugin` file to install. The phone-remote server also reports recording and ducking now
- Fixed: faders could wobble a little when you muted or unmuted a channel. The cap now holds still while the mute fades
- **Two more themes (twelve in all):** **Peaches & Cream** (girly pink with peach fader caps, heart meters, scalloped cards and a lavender "Sleepy" button instead of Mute) and **Sticker Bomb** (tilted die-cut stickers on notebook paper, starburst caps). Ink and Deco are gone; if you were using them you're moved to Console
- **Full recorder:** channels (mono to 7.1), sample rate, MP3 quality, one file per channel, repeat, start-on-load and jump to a time
- **Voicemeeter options:** **⋯ → Voicemeeter options…** has the engine settings: sample rate, ASIO preferred rate, MME/WDM/KS/ASIO buffers, exclusive and swift modes, monitor-on-select, slider mode and per-output delay. Only the ones your edition has are shown

## 0.13.0
- **Mic chain:** **⋯ → Mic chain…** has noise gate, compressor and denoiser sliders for your microphone, one-click presets (Streamer voice, Gentle, Noisy room, All off) and a live meter. Only the controls your Voicemeeter edition has are shown
- **Setup assistant:** **⋯ → Setup assistant…** sets the A1 and B1 routing for every channel for "Just gaming + chat" or "Streamer + Discord" (which also builds a stream mix on B2)
- **OBS overlay:** a see-through browser-source page with a MUTED or BRB badge, a mic meter and the name of the last sound played. The address is under Settings → Phone remote
- **Duck for friends too:** talk-over ducking can now start from more than one channel (your mic or Discord), under "Or when these talk"
- **Smarter soundboard:** a shortcut for each sound, groups with a tab bar, and **Random pack…** to turn a folder into one button that plays a random sound from it
- **Sounds are copied into Sleekmeeter's own `sounds` folder** when you add them, so you can move or delete the originals. Random packs copy their folder too
- **Hear yourself:** **⋯ → Hear yourself…** records 5 seconds of your stream mix and plays it back on your headphones

## 0.12.0
- **A themed title bar:** the plain Windows frame is gone. Minimise, maximise and close now sit in Sleekmeeter's own top bar and follow the theme (glowing in Neon, square in Terminal, chunky in Block, and so on). Drag the top bar to move the window and double-click it to maximise
- **New themes:** **Blueprint** (white lines on a drafting-paper grid, monospace labels, tick-mark faders) and **Block** (flat and bold, with thick outlines, hard shadows and bright colour blocks)
- **Themes that look nothing alike.** Midnight, Minimal, Clean, Analog and Studio are gone because they looked too much like Console, OLED black and Ink. If you were using one, you're moved to the closest remaining theme (Console, or Ink for Clean and Studio), including in automatic per-app rules
- **Three more new themes:** **Rack** (brushed-steel studio gear, black fader caps, amber LCD readouts), **Deco** (Art Deco black and brass gold, serif capitals, diamond fader caps) and **Arcade** (an 8-bit cabinet with pixel-stepped corners and chunky blocks)
- **Every channel strip is the same width, in every theme.** Strips no longer grow to fit long channel names: long names are cut short with "…" and show in full when you hover over them
- **Soundboard imports in bulk:** **Add sounds…** now lets you pick several files at once, and the new **Add a folder…** adds every wav, mp3, ogg and flac inside a folder and its subfolders. Sounds already on the board are skipped
- **Mini mode fits its channels:** the mini window is sized from the real height of the channel list in your theme, so it never needs a scroll bar (unless the list is taller than your screen) and switching between mini and the full mixer is seamless. It resizes itself when you hide or show channels or change theme
- Fixed: header buttons (like Outputs with its live dot) could wrap onto two lines in the wider themes, and strips could end up wider than their names needed. Header buttons now never wrap, Arcade, Block and Deco no longer add extra spacing around strips and keys, and strips are re-measured whenever you switch theme
- Fixed: the OLED black preview in the theme picker was unreadable while a light theme was active

## 0.11.1
- Fixed: the packaged Setup.exe and MSI could contain an older Sleekmeeter (the build script picked the first MSI it found). It now uses this version's MSI and checks its version
- **Setup.exe has no console window:** questions are normal Windows message boxes, it asks for permission once, and it can open Sleekmeeter when it's done
- Fixed: updating from an installed copy could leave Windows still reporting the old version. The updater now removes the old install and installs the new one in a single step
- **Cleaner Potato mixer:** the A4 and A5 buttons are hidden on each input by default. Turn them on in Settings → Extra outputs (only shown on Potato). A button still appears if that input already sends to it
- Fixed: the talk-over ducking "turn down" choices didn't always stick (they could reset when you closed Settings)
- **Setup.exe upgrades in place:** running Sleekmeeter-Setup.exe over an existing install now removes the old copy first (settings are kept) and installs the new one, instead of stopping at Windows' Change/Repair/Remove screen

## 0.11.0
- **Soundboard:** play wav, mp3, ogg and flac clips into your mix from buttons, shortcuts or chat, to any output device (like a Voicemeeter virtual input, so each sound is a channel you can route and fade)
- **Twitch chat commands:** `!brb`, `!scene`, `!sound` and more, from you, your mods or everyone. Joins chat anonymously; nothing is ever posted
- **Phone remote:** faders, mutes, Be right back, scenes, sounds and outputs from a phone on the same Wi-Fi, protected by a secret key in the address
- **Level history:** a graph of how loud each channel was over the last 3 hours, with clipping highlighted
- **Per-app routing:** choose which output each app plays to, from the Apps window
- New shortcut actions: load a scene, play a sound, stop all sounds

## 0.10.2
- Fixed: faders wobbled when turning Be right back off. Levels and mutes are now put back in an order that doesn't make Voicemeeter's fades fight each other

## 0.10.1
- **Update in one click:** **Update now and restart** downloads the new version, verifies it, installs it and reopens Sleekmeeter. MSI installs get one Windows permission prompt; the portable exe replaces itself

## 0.10.0
- **Installer:** a Windows MSI and a **Sleekmeeter-Setup.exe** that installs Voicemeeter first (downloaded from VB-Audio) if it's missing. The portable exe stays. Installed copies keep settings and scenes in `%APPDATA%\Sleekmeeter`
- **Be right back:** a **BRB** button (and shortcut) that mutes your mic, turns the game down and plays music, all with fades, then puts everything back exactly as it was. Set it up in Settings → Stream mode
- **OBS Studio link:** follow your OBS scenes (load a Voicemeeter scene, or start or end Be right back, when OBS changes scene), act when you go live or the stream ends, and show a **LIVE** tag in the header. Needs OBS 28 or newer with its WebSocket server on
- **Mic level check:** talk for 8 seconds and Sleekmeeter says whether your mic is too quiet or too loud and can set the fader for you, plus an optional warning when a channel goes over 0 dB
- **Per-game profiles:** automatic rules can also switch your outputs and theme while an app runs, and put them back when it closes
- **Backup and layout:** save and restore your settings, reset the window layout, and **Check my setup** to find out why something isn't working
- Fixed: the tray panel's remembered position could be lost when settings were saved from the mixer window

## 0.9.0
- **The tray panel is docked by default:** double-click the tray icon and it snaps flush against the taskbar and clock, in exactly the same spot every time, whichever edge the taskbar is on. The pin button in its header (or Settings → Tray volume panel) undocks it so you can drag it by the header; it remembers where you put it
- **Four new themes that change the whole look, not just the colours:** **Glass** (frosted cards, capsule faders), **Ink** (light, minimal, big thin numbers), **Neon** (glowing synth night) and **Terminal** (green phosphor). Two more arrive too: **Bubblegum** (pink, with heart faders and cute emoji channel icons) and **Clean** (the least clutter of any theme). The theme picker in Settings is collapsed to three themes with a **Show all 12 themes** button. Everything works the same in all of them, including the tray panel, mini mode and the volume overlay

## 0.8.0
- **Output profiles** (**Outputs** in the header): save the devices your outputs are using as a named setup, like Headphones or Speakers, and switch between setups in one click. Turn on **Auto** for a setup and Sleekmeeter switches to it by itself when one of its devices connects, such as when you turn on a different headset. Shortcuts can switch to a chosen profile or step to the next one, with the on-screen overlay naming it
- **Push to talk and push to mute** shortcuts that only act while you hold the keys. With push to talk the mic starts out muted, opens when you press the keys and closes a moment after you let go (**Mic stays open** in Settings, so the end of a word isn't cut off). Push to mute does the opposite, and a channel you had already muted stays muted
- **App volumes** (**Apps** in the header): a volume slider and mute for each app that is playing sound, the same controls as Windows' volume mixer, so you can turn Discord down or mute a browser without touching the rest. Apps that are playing show a green dot
## 0.7.0
- **Themes** (Settings → Appearance): Console, Midnight, Analog, Studio (light), Minimal and OLED black. Each one previews itself in the picker, and the tray panel and volume overlay follow the theme you pick. If you used "Pure black for OLED", you start on OLED black
- **Settings → About** shows the Sleekmeeter version you're running and the Voicemeeter it's connected to; the tray icon's tooltip shows the version too
- Sleekmeeter keeps a log (`logs/sleekmeeter.log` next to the exe) of what it does and anything that goes wrong: starting up, connecting to Voicemeeter, scenes, the recorder, devices coming and going, engine restarts, failed actions and crashes. **Open log file** in Settings → About shows it, ready to attach to a bug report. It never grows past about 2 MB

## 0.6.1
- Fixed: MP3 recordings came out loud and badly distorted. Voicemeeter's MP3 encoder reads its audio as 16-bit, so MP3 now always records at 16-bit (the recorder's other formats keep the bit depth you pick, 24-bit by default)
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
