'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const plugin = path.resolve(__dirname, '../com.minimalhandle.sleekmeeter.sdPlugin');
const studio = require(path.join(plugin, 'bin/studio'));
const source = fs.readFileSync(path.join(plugin, 'bin/plugin.js'), 'utf8');
const uuid = 'com.minimalhandle.sleekmeeter';
const decode = image => decodeURIComponent(image.slice(image.indexOf(',') + 1));
function fixture(extra = {}) {
  const channel = { key: 'Strip[0]', name: 'Mic <Main> & "Friends"', gain: -8.5, mute: false, a: [1, 0, 0], b: [0, 1] };
  const st = { connected: true, strips: [channel], buses: [], brb: false, brbSet: true, duck: false, recording: false, outputNow: 'Headphones' };
  return { st, status: 'ok', chan: key => st.strips.find(c => c.key === key), gainOf: c => c.gain, muteOf: c => c.mute, routeOf: (c, bus) => { const a = bus[0] === 'A' ? c.a : c.b; return Number(bus.slice(1)) <= a.length ? !!a[Number(bus.slice(1)) - 1] : null; }, breath: () => .5, ...extra };
}
test('every manifest action produces a live key or dial', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'manifest.json')));
  assert.equal(manifest.UUID, uuid);
  assert.equal(manifest.Actions.length, 25);
  for (const action of manifest.Actions) {
    const c = { action: action.UUID.slice(uuid.length + 1), settings: { channel: 'Strip[0]', scene: 'Gaming', sound: 'Air horn', output: 'Headphones' } };
    const svg = decode(c.action === 'nowplaying' ? studio.renderNowPlaying(c, fixture()) : c.action === 'trackdial' ? studio.renderTrackDial(c) : c.action === 'appvolume' ? studio.renderAppDial(c, { status: 'ok' }) : c.action === 'nowplayingkey' ? studio.renderNowPlayingKey(c) : c.action === 'balancedial' ? studio.renderBalanceDial(c, fixture()) : ['channel', 'mixdial'].includes(c.action) ? studio.renderDial(c, fixture()) : studio.renderKey(c, fixture()));
    assert.match(svg, /<svg /, action.Name);
    assert.match(svg, action.Controllers.includes('Encoder') ? /width="200" height="100"/ : /width="144" height="144"/);
    assert.doesNotMatch(svg, /NaN|undefined/);
  }
});
test('mic feedback uses green/red without dB, LIVE text or app badges', () => {
  const e = fixture(), c = { action: 'mic', settings: {} };
  const live = decode(studio.renderKey(c, e));
  assert.doesNotMatch(live, /LIVE|dB|<image/); assert.match(live, /#8fdfb0/); assert.match(live, /&lt;MAIN&gt; &amp;/);
  e.st.strips[0].mute = true;
  const muted = decode(studio.renderKey(c, e));
  assert.doesNotMatch(muted, /LIVE|dB|<image/); assert.match(muted, /#ff7b83/); assert.notEqual(muted, live);
});
test('Show text is optional per action and preserves live state, bus IDs and errors', () => {
  const e=fixture(),mic={action:'mic',settings:{showText:false}};
  const active=decode(studio.renderKey(mic,e));assert.doesNotMatch(active,/<text/);assert.match(active,/#8fdfb0/);
  e.st.strips[0].mute=true;const muted=decode(studio.renderKey(mic,e));assert.doesNotMatch(muted,/<text/);assert.match(muted,/#ff7b83/);assert.notEqual(active,muted);
  const output=decode(studio.renderKey({action:'output',settings:{showText:false}},e));assert.doesNotMatch(output,/<text/);assert.match(output,/<circle cx="118"/);
  const route=decode(studio.renderKey({action:'route',settings:{showText:false,bus:'A1'}},e));assert.match(route,/>A1</);assert.doesNotMatch(route,/&lt;MAIN&gt;/);
  assert.match(decode(studio.renderKey(mic,fixture({status:'offline'}))),/Open Sleekmeeter/);
  assert.match(decode(studio.renderKey({action:'mic',settings:{}},e)),/&lt;MAIN&gt;/);
  const dial=decode(studio.renderDial({settings:{channel:'Strip[0]',showText:false}},e));assert.doesNotMatch(dial,/&lt;MAIN&gt;|>MUTED</);assert.match(dial,/>−8\.5</);
});
test('route feedback distinguishes on, off, unavailable and old server state; pulse changes artwork', () => {
  const e = fixture(), c = { action: 'route', settings: { channel: 'Strip[0]', bus: 'A1' } };
  const on = studio.renderKey(c, e); assert.match(decode(on), />A1</); assert.doesNotMatch(decode(on), /ROUTE ACTIVE|<image/);
  assert.notEqual(on, studio.renderKey(c, { ...e, breath: () => 1 }));
  c.settings.bus = 'A2'; assert.match(decode(studio.renderKey(c, e)), />A2</);
  assert.equal(studio.renderKey(c,e),studio.renderKey(c,{...e,breath:()=>1}));
  c.settings.bus = 'B3'; assert.match(decode(studio.renderKey(c, e)), /Only B1–B2/);
  e.st.strips[0].b = []; assert.match(decode(studio.renderKey(c, e)), /No B buses/); e.st.strips[0].b = [0, 1];
  const old = fixture({ routeOf: () => null }); delete old.st.strips[0].a; delete old.st.strips[0].b;
  assert.match(decode(studio.renderKey(c, old)), /Update Sleekmeeter/);
  old.st.strips[0].key = 'Bus[0]'; c.settings.channel = 'Bus[0]'; assert.match(decode(studio.renderKey(c, old)), /Inputs only/);
});
test('recorder, BRB, ducking, output and offline states remain distinct', () => {
  const e = fixture();
  for (const [action, field] of [['record', 'recording'], ['brb', 'brb'], ['duck', 'duck']]) {
    const c = { action, settings: {} }, off = studio.renderKey(c, e); e.st[field] = true; assert.notEqual(studio.renderKey(c, e), off);
  }
  const c = { action: 'output', settings: { output: 'Headphones' } };
  const active=studio.renderKey(c,e);assert.match(decode(active), /<circle cx="118"/); e.st.outputNow = 'Speakers'; assert.doesNotMatch(decode(studio.renderKey(c, e)), /<circle cx="118"/);
  for (const [status, expected] of [['key', /Check the key/], ['novm', /Start Voicemeeter/], ['offline', /Open Sleekmeeter/]]) assert.match(decode(studio.renderKey({ action: 'mic' }, fixture({ status }))), expected);
});
test('cycling output key follows current output, including wireless and custom icon overrides', () => {
  const e=fixture(),c={action:'output',settings:{}};
  const headphones=studio.renderKey(c,e);assert.match(decode(headphones),/Headphones/);
  e.st.outputNow='Speakers';const speakers=studio.renderKey(c,e);assert.match(decode(speakers),/Speakers/);assert.notEqual(headphones,speakers);
  e.st.outputNow='Wireless headphones';const wireless=studio.renderKey(c,e);assert.notEqual(wireless,headphones);
  c.settings.outputIcons={'Wireless headphones':'headphones'};assert.notEqual(studio.renderKey(c,e),wireless);
  e.st.outputNow='Desk <A>';c.settings.outputIcons={'Desk <A>':'wireless'};assert.match(decode(studio.renderKey(c,e)),/Desk &lt;A&gt;/);
});
test('dial keeps gain and mute feedback at both level boundaries', () => {
  const e = fixture(), c = { settings: { channel: 'Strip[0]' } };
  e.st.strips[0].gain = -60; assert.match(decode(studio.renderDial(c, e)), />−∞</);
  e.st.strips[0].gain = 12; assert.match(decode(studio.renderDial(c, e)), />\+12\.0</);
  e.st.strips[0].mute = true; assert.match(decode(studio.renderDial(c, e)), /#ff7b83/);
});
test('existing handlers still send the expected API actions and gain payloads', async () => {
  const calls = [], events = [];
  const mediaCommands=[];
  const timers=[];
  const localRequire = createRequire(path.join(plugin, 'bin/plugin.js'));
  const sandbox = {
    require: name=>name==='./media-session'?{MediaSession:class{start(){}stop(){}snapshot(){return{available:false};}command(command,source){mediaCommands.push({command,source});return true;}}}:localRequire(name), process: { argv: ['node', 'plugin.js'], exit() {} }, console: { error() {} }, URL, AbortController,
    setTimeout: (fn,ms) => {timers.push({fn,ms});return timers.length;}, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (url, options) => { calls.push({ url, body: options.body && JSON.parse(options.body) }); return { ok: true, json: async () => ({}) }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nthis.testPlugin = { onKeyDown, onMessage, levelTick, levelOf, setState(s) { st=s; status="ok"; }, setSocket(s) { ws=s; }, setApps(a) { apps=a; appsStatus="ok"; } };', sandbox);
  const p = sandbox.testPlugin;
  p.setState({ connected: true, strips: [{ key: 'Strip[0]', name: 'Mic', gain: -10, mute: false, a: [1], b: [0] }], buses: [] });
  p.setSocket({ open: true, send: value => events.push(JSON.parse(value)) });
  for (const [action, settings, expected] of [
    ['scene', { scene: 'Gaming' }, ['scene', 'Gaming']], ['sound', { sound: 'Air horn' }, ['sound', 'Air horn']],
    ['soundstop', {}, ['soundstop', '']], ['brb', {}, ['brb', '']], ['record', {}, ['record', '']], ['duck', {}, ['duck', '']],
    ['output', { output: 'Speakers' }, ['output', 'Speakers']], ['output', {}, ['outputnext', '']],
    ['mute', { channel: 'Strip[0]' }, ['mute', 'Strip[0]']], ['route', { channel: 'Strip[0]', bus: 'B1' }, ['route', 'Strip[0].B1']],
  ]) {
    await p.onKeyDown('ctx', { action, settings });
    const call = calls.at(-1); assert.equal(call.url, 'http://127.0.0.1:8787/api/action');
    assert.deepEqual(call.body, { action: expected[0], target: expected[1] });
  }
  await p.onKeyDown('ctx', { action: 'level', settings: { channel: 'Strip[0]', mode: 'set', amount: -7 } });
  assert.deepEqual(calls.at(-1).body, { key: 'Strip[0]', db: -7 });
  for(const timer of timers.filter(t=>t.ms===70))timer.fn();
  p.onMessage(JSON.stringify({ event: 'willAppear', action: uuid + '.mic', context: 'live-mic', payload: { settings: {} } }));
  assert.ok(events.some(e => e.event === 'setImage' && e.context === 'live-mic' && e.payload.image.startsWith('data:image/svg+xml')));
  p.onMessage(JSON.stringify({ event: 'willAppear', action: uuid + '.channel', context: 'live-dial', payload: { controller: 'Encoder', settings: { channel: 'Strip[0]' } } }));
  assert.ok(events.some(e => e.event === 'setFeedback' && e.context === 'live-dial' && e.payload.canvas.startsWith('data:image/svg+xml')));
  p.onMessage(JSON.stringify({event:'willAppear',action:uuid+'.nowplaying',context:'music-dial',payload:{controller:'Encoder',settings:{channel:'Strip[0]',mediaSource:'spotify'}}}));
  p.onMessage(JSON.stringify({event:'dialRotate',context:'music-dial',payload:{ticks:1}}));
  assert.equal(calls.at(-1).url,'http://127.0.0.1:8787/api/gain');assert.equal(calls.at(-1).body.key,'Strip[0]');
  p.onMessage(JSON.stringify({event:'touchTap',context:'music-dial',payload:{}}));
  assert.deepEqual(mediaCommands.at(-1),{command:'playpause',source:'spotify'});
  p.onMessage(JSON.stringify({event:'dialDown',context:'music-dial',payload:{}}));
  assert.deepEqual(calls.at(-1).body,{action:'mute',target:'Strip[0]'});
  // Track dial: a turn skips once however fast it spins, and a press plays or pauses.
  p.onMessage(JSON.stringify({event:'willAppear',action:uuid+'.trackdial',context:'track-dial',payload:{controller:'Encoder',settings:{mediaSource:'auto'}}}));
  p.onMessage(JSON.stringify({event:'dialRotate',context:'track-dial',payload:{ticks:-4}}));
  p.onMessage(JSON.stringify({event:'dialRotate',context:'track-dial',payload:{ticks:-4}}));
  assert.deepEqual(mediaCommands.at(-1),{command:'previous',source:'auto'});assert.equal(mediaCommands.filter(m=>m.source==='auto').length,1);
  p.onMessage(JSON.stringify({event:'dialDown',context:'track-dial',payload:{}}));
  assert.deepEqual(mediaCommands.at(-1),{command:'playpause',source:'auto'});
  await p.onKeyDown('np-key',{action:'nowplayingkey',settings:{press:'next'}});
  assert.equal(mediaCommands.at(-1).command,'next');
  // App dial: turning and pressing send the chosen app, clamped to 100%.
  p.setApps([{exe:'discord.exe',name:'Discord',volume:99,mute:false,active:true}]);
  p.onMessage(JSON.stringify({event:'willAppear',action:uuid+'.appvolume',context:'app-dial',payload:{controller:'Encoder',settings:{exe:'discord.exe',step:'5'}}}));
  p.setApps([{exe:'discord.exe',name:'Discord',volume:99,mute:false,active:true}]);
  p.onMessage(JSON.stringify({event:'dialRotate',context:'app-dial',payload:{ticks:1}}));
  assert.equal(calls.at(-1).url,'http://127.0.0.1:8787/api/appvolume');assert.deepEqual(calls.at(-1).body,{exe:'discord.exe',volume:100});
  await new Promise(r=>setImmediate(r));
  p.onMessage(JSON.stringify({event:'dialDown',context:'app-dial',payload:{}}));
  assert.deepEqual(calls.at(-1).body,{exe:'discord.exe',mute:true});
  // Meters: a dial reads /api/levels and maps Strip and Bus to the right lists.
  await new Promise(r=>setImmediate(r));
  sandbox.fetch=async url=>{calls.push({url});return{ok:true,json:async()=>({levels:{inputs:[[-20.4,-30]],outputs:[[-5,-4.6]]}})};};
  p.setState({ connected: true, strips: [{ key: 'Strip[0]', name: 'Mic', gain: -10, mute: false, a: [1], b: [0] }], buses: [] });
  await p.levelTick();
  assert.equal(calls.at(-1).url,'http://127.0.0.1:8787/api/levels');
  assert.equal(p.levelOf({key:'Strip[0]'}),-20);
  // Potato output mix: a dial turn sets one gain layer, and a key picks the output the faders set.
  sandbox.fetch=async (url,options)=>{calls.push({url,body:options&&options.body&&JSON.parse(options.body)});return{ok:true,json:async()=>({})};};
  p.setState({ connected: true, strips: [{ key: 'Strip[0]', name: 'Game', gain: -10, mute: false, a: [1,0,0,0,0], b: [0,0,1], layers: [-10,-10,-10,-10,-10,-10,-10,-16] }], buses: Array.from({length:8},(_,j)=>({key:'Bus['+j+']',name:'Out',gain:0,mute:false,sel:false})) });
  p.onMessage(JSON.stringify({event:'willAppear',action:uuid+'.mixdial',context:'mix-dial',payload:{controller:'Encoder',settings:{channel:'Strip[0]',bus:'B3',step:'2'}}}));
  p.onMessage(JSON.stringify({event:'dialRotate',context:'mix-dial',payload:{ticks:-1}}));
  assert.equal(calls.at(-1).url,'http://127.0.0.1:8787/api/layer');assert.deepEqual(calls.at(-1).body,{key:'Strip[0]',bus:7,db:-18});
  await p.onKeyDown('mix-key',{action:'mixfor',settings:{bus:'B3'}});
  assert.equal(calls.at(-1).url,'http://127.0.0.1:8787/api/mixfor');assert.deepEqual(calls.at(-1).body,{bus:7});
  await p.onKeyDown('mix-key',{action:'mixfor',settings:{bus:'B3'}});
  assert.deepEqual(calls.at(-1).body,{bus:-1},'pressing again goes back to all outputs');
  // Swap route: one call, which Sleekmeeter carries out in one step; the key flips at once.
  p.setState({ connected: true, strips: [{ key: 'Strip[0]', name: 'Headset', gain: 0, mute: false, a: [1,0,0], b: [0,1,0] }, { key: 'Strip[3]', name: 'Main mic', gain: 0, mute: false, a: [1,0,0], b: [0,0,0] }], buses: [] });
  await p.onKeyDown('swap-key', { action: 'swap', settings: { bus: 'B2', channel2: 'Strip[3]', bus2: 'B2' } }); // first input left on its shown default
  assert.deepEqual(calls.at(-1).body, { action: 'routeswap', target: 'Strip[0].B2|Strip[3].B2' });
  await p.onKeyDown('swap-key', { action: 'swap', settings: { channel: 'Strip[0]', bus: 'B2', channel2: 'Strip[0]', bus2: 'B2' } });
  assert.ok(events.some(e => e.event === 'showAlert' && e.context === 'swap-key'), 'the same route twice is refused');
  p.setState({ connected: true, strips: [{ key: 'Strip[0]', name: 'Game', gain: -10, mute: false, a: [1,0,0,0,0], b: [0,0,1], layers: [-10,-10,-10,-10,-10,-10,-10,-16] }], buses: Array.from({length:8},(_,j)=>({key:'Bus['+j+']',name:'Out',gain:0,mute:false,sel:false})) });
  // Level step on one output: steps that gain layer only, and holding the key keeps stepping until it's let go.
  for(const t of timers.filter(t=>t.ms===70))t.fn();timers.length=0;
  p.onMessage(JSON.stringify({event:'willAppear',action:uuid+'.level',context:'step-key',payload:{settings:{channel:'Strip[0]',bus:'A1',mode:'up',amount:5}}}));
  p.onMessage(JSON.stringify({event:'keyDown',action:uuid+'.level',context:'step-key',payload:{}}));
  assert.equal(calls.at(-1).url,'http://127.0.0.1:8787/api/layer');assert.deepEqual(calls.at(-1).body,{key:'Strip[0]',bus:0,db:-5});
  const hold=timers.find(t=>t.ms===400);assert.ok(hold,'holding starts repeating after a pause');
  for(const t of timers.filter(t=>t.ms===70))t.fn();
  hold.fn();
  assert.deepEqual(calls.at(-1).body,{key:'Strip[0]',bus:0,db:0});
  assert.ok(timers.some(t=>t.ms===150),'and keeps going while held');
  p.onMessage(JSON.stringify({event:'keyUp',action:uuid+'.level',context:'step-key',payload:{}}));
  // Main level stays the default.
  await p.onKeyDown('main-key',{action:'level',settings:{channel:'Strip[0]',mode:'down',amount:3,repeat:false}});
  for(const t of timers.filter(t=>t.ms===70))t.fn();
  assert.equal(calls.at(-1).url,'http://127.0.0.1:8787/api/gain');assert.equal(calls.at(-1).body.key,'Strip[0]');
  assert.equal(p.levelOf({key:'Bus[0]'}),-5);assert.equal(p.levelOf({key:'Strip[9]'}),null);
});
test('Mute on outputs shows its outputs and state, and needs a Sleekmeeter that reports it', () => {
  const e = fixture(), ch = e.st.strips[0];
  ch.b = [1, 1, 1]; ch.partMute = [];
  const c = { action: 'partmute', settings: { channel: 'Strip[0]' } };
  const on = decode(studio.renderKey(c, e));
  assert.match(on, /ON B1–B3/); assert.doesNotMatch(on, /#ff7b83/);
  ch.partMute = ['B2'];
  const muted = decode(studio.renderKey(c, e));
  assert.match(muted, /MUTED B1–B3/); assert.match(muted, /#ff7b83/);
  // Only the outputs this Voicemeeter has, in A-then-B order.
  ch.b = [1, 1];
  assert.deepEqual(studio.partOutputs({ outs: ['B3', 'A1', 'B1'] }, ch, e), ['A1', 'B1']);
  assert.equal(studio.outputsLabel(['A1', 'B2']), 'A1 B2');
  assert.match(decode(studio.renderKey({ action: 'partmute', settings: { channel: 'Strip[0]', outs: ['B3'] } }, e)), /Choose outputs/);
  delete ch.partMute;
  assert.match(decode(studio.renderKey(c, e)), /Update Sleekmeeter/);
});
test('Mute on outputs sends the input and its outputs, and unmutes when muted', async () => {
  const calls = [];
  const localRequire = createRequire(path.join(plugin, 'bin/plugin.js'));
  const sandbox = {
    require: name => name === './media-session' ? { MediaSession: class { start() {} stop() {} snapshot() { return { available: false }; } command() { return true; } } } : localRequire(name),
    process: { argv: ['node', 'plugin.js'], exit() {} }, console: { error() {} }, URL, AbortController,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (url, options) => { calls.push({ url, body: options.body && JSON.parse(options.body) }); return { ok: true, json: async () => ({}) }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nthis.testPlugin = { onKeyDown, setState(s) { st=s; status="ok"; }, setSocket(s) { ws=s; } };', sandbox);
  const p = sandbox.testPlugin, events = [];
  p.setSocket({ open: true, send: v => events.push(JSON.parse(v)) });
  const mic = { key: 'Strip[0]', name: 'Mic', gain: 0, mute: false, a: [1], b: [1, 1, 0], partMute: [] };
  p.setState({ connected: true, strips: [mic], buses: [] });
  await p.onKeyDown('k', { action: 'partmute', settings: { channel: 'Strip[0]' } });
  assert.deepEqual(calls.at(-1).body, { action: 'partmute', target: 'Strip[0]:B1,B2,B3' });
  // Already muted on one of them (from the mixer): the press unmutes.
  p.setState({ connected: true, strips: [{ ...mic, key: 'Strip[1]', b: [0, 0, 0], partMute: ['B1', 'B2'] }], buses: [] });
  await p.onKeyDown('k', { action: 'partmute', settings: { channel: 'Strip[1]', outs: ['B1', 'B2'] } });
  assert.deepEqual(calls.at(-1).body, { action: 'partmute', target: 'Strip[1]:B1,B2' });
  // Not sent to any of them and not muted: nothing to do, the key shows an alert.
  const before = calls.length;
  p.setState({ connected: true, strips: [{ ...mic, key: 'Strip[2]', b: [0, 0, 0], partMute: [] }], buses: [] });
  await p.onKeyDown('k2', { action: 'partmute', settings: { channel: 'Strip[2]' } });
  assert.equal(calls.length, before);
  assert.ok(events.some(e => e.event === 'showAlert' && e.context === 'k2'));
});

test('replay, music off stream and Game / Chat keys show their setup and live states', () => {
  const draw = (action, st, settings = {}, extra = {}) => decode(studio.renderKey({ action, settings }, fixture({ st: { ...fixture().st, ...st }, ...extra })));
  assert.match(draw('replay', {}), /Update Sleekmeeter/);
  assert.match(draw('replay', { replay: false }), /Turn on in app/);
  assert.match(draw('replay', { replay: true }), /SAVE REPLAY/);
  assert.match(draw('musicguard', { musicGuardSet: false }), /Set up in app/);
  assert.match(draw('musicguard', { musicGuardSet: true, musicGuard: false }), /ON STREAM/);
  assert.match(draw('musicguard', { musicGuardSet: true, musicGuard: true }), /OFF STREAM/);
  assert.match(draw('balance', {}), /Update Sleekmeeter/);
  assert.match(draw('balance', { balance: 0, balanceSet: false }), /Set up in app/);
  assert.match(draw('balance', { balance: -30, balanceSet: true }, { mode: 'game' }), /MORE GAME[\s\S]*GAME 30/);
  assert.match(draw('balance', { balance: 0, balanceSet: true }), /CENTRED/);
  assert.equal(studio.balanceLabel(20), 'CHAT 20');
  const dial = (st, extra = {}) => decode(studio.renderBalanceDial({ settings: {} }, fixture({ st: { ...fixture().st, ...st }, ...extra })));
  assert.match(dial({ balance: 40, balanceSet: true }), />Chat 40</);
  assert.match(dial({ balance: 0, balanceSet: true }), />Centre</);
  assert.match(dial({ balance: 0, balanceSet: false }), /SET UP GAME/);
  assert.match(dial({}), /UPDATE SLEEKMEETER/);
  assert.match(dial({ balance: 0, balanceSet: true }, { status: 'offline' }), /OFFLINE/);
});
test('replay, music off stream and Game / Chat send the right requests', async () => {
  const calls = [], events = [], timers = [];
  const localRequire = createRequire(path.join(plugin, 'bin/plugin.js'));
  const sandbox = {
    require: name => name === './media-session' ? { MediaSession: class { start() {} stop() {} snapshot() { return { available: false }; } command() { return true; } } } : localRequire(name),
    process: { argv: ['node', 'plugin.js'], exit() {} }, console: { error() {} }, URL, AbortController,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (url, options) => { calls.push({ url, body: options.body && JSON.parse(options.body) }); return { ok: true, json: async () => ({}) }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nthis.testPlugin = { onKeyDown, onMessage, balanceOf, setState(s) { st=s; status="ok"; }, setSocket(s) { ws=s; } };', sandbox);
  const p = sandbox.testPlugin;
  p.setSocket({ open: true, send: value => events.push(JSON.parse(value)) });
  p.setState({ connected: true, strips: [], buses: [], replay: false, musicGuardSet: false, balance: 0, balanceSet: false });
  await p.onKeyDown('r', { action: 'replay', settings: {} });
  await p.onKeyDown('g', { action: 'musicguard', settings: {} });
  await p.onKeyDown('b', { action: 'balance', settings: { mode: 'chat' } });
  assert.equal(calls.length, 0, 'nothing is sent before it is set up');
  assert.deepEqual(events.filter(e => e.event === 'showAlert').map(e => e.context), ['r', 'g', 'b']);
  p.setState({ connected: true, strips: [], buses: [], replay: true, musicGuardSet: true, musicGuard: false, balance: 10, balanceSet: true });
  await p.onKeyDown('r', { action: 'replay', settings: {} });
  assert.deepEqual(calls.at(-1).body, { action: 'replay', target: '' });
  assert.ok(events.some(e => e.event === 'showOk' && e.context === 'r'), 'a saved replay shows a tick');
  await p.onKeyDown('g', { action: 'musicguard', settings: {} });
  assert.deepEqual(calls.at(-1).body, { action: 'musicguard', target: '' });
  await p.onKeyDown('b', { action: 'balance', settings: { mode: 'game', step: '20' } });
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:8787/api/balance'); assert.deepEqual(calls.at(-1).body, { amount: -20 });
  assert.equal(p.balanceOf(), -10, 'the key shows the new position straight away');
  await new Promise(r => setImmediate(r));
  await p.onKeyDown('b', { action: 'balance', settings: {} });
  assert.deepEqual(calls.at(-1).body, { action: 'chatcentre', target: '' });
  // Dial: turns step by the chosen amount from the centred position, stop at the ends, and a press centres.
  await new Promise(r => setImmediate(r));
  p.onMessage(JSON.stringify({ event: 'willAppear', action: uuid + '.balancedial', context: 'bd', payload: { controller: 'Encoder', settings: { step: '5' } } }));
  p.onMessage(JSON.stringify({ event: 'dialRotate', context: 'bd', payload: { ticks: 3 } }));
  assert.deepEqual(calls.at(-1).body, { amount: 15 });
  await new Promise(r => setTimeout(r, 20));
  p.setState({ connected: true, strips: [], buses: [], balance: 15, balanceSet: true }); // the mocked poll answered {}
  p.onMessage(JSON.stringify({ event: 'dialRotate', context: 'bd', payload: { ticks: 30 } }));
  assert.deepEqual(calls.at(-1).body, { amount: 85 }, 'stops at 100');
  assert.ok(events.some(e => e.event === 'setFeedback' && e.context === 'bd'));
  p.onMessage(JSON.stringify({ event: 'dialDown', context: 'bd', payload: {} }));
  assert.deepEqual(calls.at(-1).body, { action: 'chatcentre', target: '' });
});
