'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {MediaSession}=require('../com.minimalhandle.sleekmeeter.sdPlugin/bin/media-session');
const studio=require('../com.minimalhandle.sleekmeeter.sdPlugin/bin/studio');
const decode=uri=>decodeURIComponent(uri.slice(uri.indexOf(',')+1));
test('starter profile resolves named roles and respects explicit assignments', () => {
  const state = {
    strips: [{ key: 'Strip[0]', name: 'Shure' }, { key: 'Strip[4]', name: 'Discord' }, { key: 'Strip[6]', name: 'Music' }],
    scenes: ['Recording', 'Streaming'],
  };
  assert.equal(studio.profileSettings({ channelRole: 'mic' }, state).channel, 'Strip[0]');
  assert.equal(studio.profileSettings({ channelRole: 'chat' }, state).channel, 'Strip[4]');
  assert.equal(studio.profileSettings({ channelRole: 'game' }, state).channel, undefined);
  assert.equal(studio.profileSettings({ channelRole: 'chat', channel: 'Strip[6]' }, state).channel, 'Strip[6]');
  assert.equal(studio.profileSettings({ sceneRole: 'streaming' }, state).scene, 'Streaming');
});
function environment(){const ch={key:'Strip[1]',name:'Music & games',gain:-14,mute:false,a:[true],b:[false]};return{st:{},status:'ok',chan:key=>key===ch.key?ch:null,gainOf:c=>c.gain,muteOf:c=>c.mute,routeOf:()=>true,breath:()=>.5,ch};}
test('Now Playing composes cover, escaped metadata, timeline and independently selected channel gain',()=>{
 const e=environment(),settings={channel:'Strip[1]'},media={available:true,title:'Track <one>',artist:'A & B',position:45,duration:222,playing:true,art:'data:image/png;base64,aGVsbG8='};
 const svg=decode(studio.renderNowPlaying({settings},e,media));
 for(const expected of [/width="200" height="100"/,/Track &lt;one&gt;/,/A &amp; B/,/0:45/,/3:42/,/−14\.0 dB/,/<image /])assert.match(svg,expected);
 e.ch.mute=true;assert.match(decode(studio.renderNowPlaying({settings},e,media)),/MUTED/);
 assert.doesNotMatch(decode(studio.renderNowPlaying({settings},e,{...media,art:'https://example.com/image.png'})),/<image /);
 const noMedia=decode(studio.renderNowPlaying({settings},e,{available:false}));assert.match(noMedia,/Open Spotify/);assert.match(noMedia,/−14\.0 dB/);
});
test('Studio keys preserve optional labels, microphone states, route animation and level values',()=>{
 const e=environment(),c={action:'mic',settings:{channel:'Strip[1]',showText:false}};
 const active=decode(studio.renderKey(c,e));assert.doesNotMatch(active,/<text/);e.ch.mute=true;assert.notEqual(decode(studio.renderKey(c,e)),active);
 const route={action:'route',settings:{channel:'Strip[1]',bus:'A1'}};
 assert.notEqual(studio.renderKey(route,e),studio.renderKey(route,{...e,breath:()=>1}));
 assert.match(decode(studio.renderDial({settings:{channel:'Strip[1]',showText:false}},e)),/−14\.0/);
});
test('media timeline interpolation pauses, clamps to duration, expires and rejects remote artwork',()=>{
 const client=new MediaSession(()=>{}),now=100000;
 client.lastUpdate=now;client.players.spotify={available:true,title:'Song',position:10,duration:12,playing:true,capturedAt:now,art:'https://example.com/art'};
 assert.equal(client.snapshot('spotify',now+1000).position,11);
 assert.equal(client.snapshot('spotify',now+4000).position,12);
 client.players.spotify.playing=false;assert.equal(client.snapshot('spotify',now+4000).position,10);
 assert.equal(client.snapshot('spotify',now).art,'');
 assert.equal(client.snapshot('spotify',now+9000).available,false);
});
test('media worker handles fragmented frames, command allowlist and lifecycle without extra workers',()=>{
 let launches=0,updates=0,written=[];
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.writable=true;child.stdin.write=s=>written.push(JSON.parse(s));child.stdin.end=()=>{};child.exitCode=0;
 const client=new MediaSession(()=>updates++,()=>{launches++;return child;});
 client.start();client.start();assert.equal(launches,1);
 child.stdout.emit('data','{"players":{"spotify":{"available":true,');child.stdout.emit('data','"title":"Example"}}}\n');assert.equal(updates,1);
 assert.equal(client.snapshot().title,'Example');assert.equal(client.command('delete'),false);assert.equal(client.command('playpause','spotify'),true);assert.deepEqual(written,[{command:'playpause',source:'spotify'}]);
 client.stop();assert.equal(client.snapshot().available,false);child.emit('close');assert.equal(client.child,null);
});
test('a starting worker never claims the player is missing',()=>{
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>{};child.exitCode=0;
 const client=new MediaSession(()=>{},()=>child),send=()=>child.stdout.emit('data','{"players":{"spotify":{"available":true,"title":"Example"}}}\n');
 client.start();const first=client.snapshot();assert.equal(first.loading,true);
 for(const draw of [studio.renderTrackDial({settings:{}},first),studio.renderNowPlayingKey({settings:{}},first)])assert.doesNotMatch(decode(draw),/Open Spotify|Waiting for media/);
 send();client.stop();assert.equal(client.snapshot().available,false);
 client.retryAfter=0;client.start();assert.equal(client.snapshot().title,'Example');
 assert.equal(client.snapshot('spotify',Date.now()+11*60*1000).loading,true);
 send();assert.equal(client.snapshot().title,'Example');
 child.emit('close');assert.equal(client.snapshot().loading,undefined);
});
test('a pressed pause shows at once and reverts only if the player never agrees',()=>{
 let updates=0;const child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.writable=true;child.stdin.write=()=>{};child.stdin.end=()=>{};child.exitCode=0;
 const client=new MediaSession(()=>updates++,()=>child),send=playing=>child.stdout.emit('data',JSON.stringify({players:{spotify:{available:true,title:'Example',source:'Spotify',playing,capturedAt:Date.now()}}})+'\n');
 client.start();send(true);assert.equal(client.snapshot().playing,true);updates=0;
 assert.equal(client.command('playpause'),true);assert.equal(updates,1);assert.equal(client.snapshot().playing,false);
 send(true);assert.equal(client.snapshot().playing,false,'a report from before the player reacted changes nothing');
 assert.equal(client.snapshot('spotify',Date.now()+2000).playing,true,'reverts when the player never agrees');
 client.command('playpause');assert.equal(client.snapshot().playing,false);send(false);assert.equal(client.snapshot().playing,false);assert.equal(client.expected,null);
 client.command('next');assert.equal(client.snapshot().playing,false);
});
test('dials draw a live meter only when levels exist and it is switched on',()=>{
 const e=environment(),settings={channel:'Strip[1]'};
 const plain=decode(studio.renderDial({settings},e));
 const loud=decode(studio.renderDial({settings},{...e,levelOf:()=>-2}));
 assert.notEqual(loud,plain);assert.match(loud,/#ff7b83/);
 assert.match(decode(studio.renderDial({settings},{...e,levelOf:()=>-30})),/#8fdfb0/);
 assert.equal(decode(studio.renderDial({settings:{...settings,showMeter:false}},{...e,levelOf:()=>-2})),plain);
 assert.equal(decode(studio.renderDial({settings},{...e,levelOf:()=>null})),plain);
});
test('Now Playing key and track dial show artwork, text and idle states',()=>{
 const media={available:true,title:'Track <one>',artist:'A & B',position:30,duration:120,playing:false,art:'data:image/png;base64,aGVsbG8='};
 const key=decode(studio.renderNowPlayingKey({settings:{}},media));
 for(const expected of [/width="144" height="144"/,/<image /,/Track &lt;one&gt;/,/A &amp; B/,/width="20\.5"/])assert.match(key,expected);
 assert.doesNotMatch(decode(studio.renderNowPlayingKey({settings:{showText:false}},media)),/<text/);
 assert.match(decode(studio.renderNowPlayingKey({settings:{mediaSource:'auto'}},{available:false})),/Nothing playing/);
 assert.doesNotMatch(decode(studio.renderNowPlayingKey({settings:{}},{...media,art:'https://example.com/a.png'})),/<image /);
 const dial=decode(studio.renderTrackDial({settings:{}},media));
 for(const expected of [/width="200" height="100"/,/<image /,/0:30/,/2:00/])assert.match(dial,expected);
 assert.match(decode(studio.renderTrackDial({settings:{}},{available:false})),/Open Spotify/);
});
test('app dial covers volume, mute and every problem state',()=>{
 const c={settings:{exe:'discord.exe',appName:'Discord'}};
 const on=decode(studio.renderAppDial(c,{status:'ok',app:{name:'Discord',volume:64,mute:false}}));
 assert.match(on,/DISCORD/);assert.match(on,/>64</);
 assert.match(decode(studio.renderAppDial(c,{status:'ok',app:{name:'Discord',volume:64,mute:true}})),/#ff7b83/);
 assert.match(decode(studio.renderAppDial(c,{status:'ok',app:null})),/Not playing audio/);
 assert.match(decode(studio.renderAppDial({settings:{}},{status:'ok',app:null})),/CHOOSE AN APP/);
 assert.match(decode(studio.renderAppDial(c,{status:'old'})),/UPDATE SLEEKMEETER/);
 assert.match(decode(studio.renderAppDial(c,{status:'key'})),/WRONG KEY/);
 assert.match(decode(studio.renderAppDial(c,{status:'offline'})),/OFFLINE/);
});

test('swap route key shows which of its two routes is live', () => {
  const strips = { 'Strip[0]': { key: 'Strip[0]', name: 'Headset', b: [0, 1, 0], a: [] }, 'Strip[3]': { key: 'Strip[3]', name: 'Main mic', b: [0, 0, 0], a: [] } };
  const on = (ch, bus) => { const l = bus[0] === 'A' ? ch.a : ch.b; const n = +bus[1] - 1; return n < l.length ? !!l[n] : null; };
  const e = { status: 'ok', st: {}, chan: (k) => strips[k], gainOf: () => 0, muteOf: () => false, routeOf: on, breath: () => 1 };
  const text = (svg) => decodeURIComponent(svg.slice(svg.indexOf(',') + 1));
  const key = (extra) => text(studio.renderKey({ action: 'swap', settings: { channel: 'Strip[0]', bus: 'B2', channel2: 'Strip[3]', bus2: 'B2', ...extra } }, e));
  assert.match(key({}), /HEADSET/); assert.match(key({}), /1 OF 2/);
  assert.match(key({ channel: undefined }), /HEADSET/, 'an unsaved first input is input 1, as the settings show');
  assert.match(key({ label: 'Headset mic' }), /HEADSET MIC/);
  strips['Strip[0]'].b = [0, 0, 0]; strips['Strip[3]'].b = [0, 1, 0];
  assert.match(key({}), /MAIN MIC/); assert.match(key({}), /2 OF 2/);
  strips['Strip[0]'].b = [0, 1, 0];
  assert.match(key({}), /PRESS TO SET/, 'both on: neither is live');
  assert.match(key({ bus2: 'B5' }), /Only B1/, 'a bus this edition lacks says so');
  assert.match(text(studio.renderKey({ action: 'swap', settings: {} }, e)), /Choose 2 routes/);
});

test('the media worker starts on PCs with Windows\' default script policy', () => {
  let args = null;
  const fake = (_exe, a) => { args = a; const e = new EventEmitter(); e.stdout = new EventEmitter(); e.stdout.setEncoding = () => {}; e.stderr = new EventEmitter(); e.stdin = new EventEmitter(); return e; };
  new MediaSession(() => {}, fake).start();
  const i = args.indexOf('-ExecutionPolicy');
  assert.ok(i >= 0 && args[i + 1] === 'Bypass' && i < args.indexOf('-File'));
  const studio = require('../com.minimalhandle.sleekmeeter.sdPlugin/bin/studio');
  const text = (svg) => decodeURIComponent(svg.slice(svg.indexOf(',') + 1));
  assert.match(text(studio.renderNowPlayingKey({ settings: { mediaSource: 'auto' } }, { available: false, reason: 'Waiting for media' })), /Media unavailable/);
  assert.match(text(studio.renderNowPlayingKey({ settings: { mediaSource: 'auto' } }, { available: false, reason: 'No media session' })), /Nothing playing/);
});
test('Mic clean-up key shows on, off, every mic and setup states',()=>{
 const e=environment(),one={action:'micfx',settings:{channel:'Strip[1]'}},all={action:'micfx',settings:{}};
 assert.match(decode(studio.renderKey(one,e)),/Update Sleekmeeter/);
 e.st.micFx={};assert.match(decode(studio.renderKey(all,e)),/Set up in/);
 e.st.micFx={'Strip[1]':{on:true}};
 const on=decode(studio.renderKey(one,e));assert.match(on,/CLEAN-UP ON/);assert.match(on,/MUSIC &amp; GAMES/);
 assert.match(decode(studio.renderKey(all,e)),/ALL MICS/);
 e.st.micFx['Strip[1]'].on=false;assert.match(decode(studio.renderKey(one,e)),/CLEAN-UP OFF/);
 assert.match(decode(studio.renderKey({action:'micfx',settings:{channel:'Strip[0]'}},e)),/Set up in/);
});
