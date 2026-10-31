'use strict';
const glyphs = require('./symbols.json');
const C = { cyan: '#83d9ef', green: '#8fdfb0', red: '#ff7b83', amber: '#efbb72', blue: '#8cbfff', muted: '#536074', ink: '#f0f4fa', subtle: '#929eaf' };
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const fit = (s, n) => String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s);
const uri = svg => 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg);
const db = n => n <= -60 ? '−∞' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function text(value, x, y, size = 12, fill = C.ink, anchor = 'start', weight = 600) {
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${esc(value)}</text>`;
}
function base(width, height, body, accent = C.cyan) {
  return uri(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="surface" x2="0" y2="1"><stop stop-color="#141920"/><stop offset="1" stop-color="#07090d"/></linearGradient><linearGradient id="accent"><stop stop-color="${accent}" stop-opacity=".5"/><stop offset="1" stop-color="${accent}"/></linearGradient></defs><rect width="${width}" height="${height}" fill="#05070a"/><rect x="1" y="1" width="${width-2}" height="${height-2}" rx="10" fill="url(#surface)" stroke="#252d38" stroke-width="1"/><path d="M12 2h${width-24}" stroke="#39414b" stroke-opacity=".45"/>${body}</svg>`);
}
function glyph(name, x, y, scale, color, slash = false) {
  return `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="${color}" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${(glyphs[name] || glyphs.faders).replace(/currentColor/g,color)}</g>${slash ? `<path d="M${x+3} ${y+3}l${scale*21} ${scale*21}" stroke="#0a0d12" stroke-width="9" stroke-linecap="round"/><path d="M${x+3} ${y+3}l${scale*21} ${scale*21}" stroke="${C.red}" stroke-width="3.5" stroke-linecap="round"/>` : ''}`;
}
function bar(value, x, y, width, color, opacity = 1) {
  return `<rect x="${x}" y="${y}" width="${width}" height="4" rx="2" fill="#28303c"/><rect x="${x}" y="${y}" width="${(width*clamp(value,0,1)).toFixed(2)}" height="4" rx="2" fill="${color}" opacity="${opacity}"/>`;
}
function tile({name='',caption='',icon='faders',color=C.cyan,slash=false,value='',bus='',active=false,pulse=1,showText=true}) {
  // Optical hierarchy at physical key size: quiet heading, one hero, one status rail.
  const heading=showText&&name;
  let body=heading?text(fit(name.toUpperCase(),18),72,30,9,'#b4b7bd','middle',650):'';
  if(bus) {
    body+=text(bus,72,79,43,active?color:'#656a73','middle',400);
    // State remains explicit when channel labels are hidden; colour is supplemental.
    body+=text(active?'ON':'OFF',78,101,10,active?color:'#8a8e96','middle',650);
    body+=active?`<path d="M51 97l3 3 6-7" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`:`<path d="M51 94l7 7m0-7l-7 7" stroke="#8a8e96" stroke-width="1.5" stroke-linecap="round"/>`;
  } else if(value) {
    const number=value.replace(/ dB$/,'');
    body+=text(number,72,87,number.length>6?30:38,C.ink,'middle',350);
    body+=text('dB',72,104,9,C.subtle,'middle',500);
    // A small directional mark carries the action without competing with the value.
    body+=glyph(icon,111,19,.65,color,slash);
  } else {
    const size=showText&&caption?1.85:2.25;
    body+=glyph(icon,72-12*size,heading?45:36,size,icon==='mic'||slash?color:C.ink,slash);
    if(showText&&caption)body+=text(fit(caption,19),72,108,10,'#cdd0d5','middle',500);
  }
  if(active)body+=`<circle cx="118" cy="28" r="2" fill="${color}"/>`;
  body+=`<rect x="31" y="119" width="82" height="5" rx="2.5" fill="#24262b"/><rect x="31" y="119" width="${bus?(active?82:0):active||icon==='mic'||value?64:43}" height="5" rx="2.5" fill="url(#rail)" opacity="${pulse}"/>`;
  return uri(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><defs><linearGradient id="key-surface" x2="0" y2="1"><stop stop-color="#101113"/><stop offset=".55" stop-color="#070708"/><stop offset="1" stop-color="#030304"/></linearGradient><linearGradient id="rail"><stop stop-color="${color}" stop-opacity=".65"/><stop offset="1" stop-color="${color}"/></linearGradient></defs><rect width="144" height="144" rx="12" fill="#030304"/><rect x="2.5" y="2.5" width="139" height="139" rx="13" fill="url(#key-surface)" stroke="#202124" stroke-width=".8"/><path d="M20 3h104" stroke="#666970" stroke-opacity=".17" stroke-width=".8"/>${body}</svg>`);
}
// Says why a route key can't work, and which buses this input does have.
function routeProblem(ch,bus) {
  const have=bus[0]==='A'?ch.a:ch.b;
  if(String(ch.key).startsWith('Bus['))return 'Inputs only';
  if(!Array.isArray(have))return 'Update Sleekmeeter';
  return have.length?`Only ${bus[0]}1–${bus[0]}${have.length}`:`No ${bus[0]} buses`;
}
function outputIcon(name, settings) {
  const choices={speakers:'speaker',headphones:'headphones',wireless:'wireless-headphones'};
  if(choices[(settings.outputIcons||{})[name]])return choices[settings.outputIcons[name]];
  return /wireless|bluetooth|airpods|\bbt\b/i.test(name)?choices.wireless:/headphone|headset|earbud/i.test(name)?choices.headphones:choices.speakers;
}
function renderKey(c,e) {
  const s=c.settings||{},showText=s.showText!==false;
  if(c.action==='soundstop')return tile({showText,icon:'stop',caption:'STOP SOUNDS'});
  if(e.status!=='ok'||!e.st){const note=e.status==='key'?'Check the key':e.status==='novm'?'Start Voicemeeter':'Open Sleekmeeter';return tile({name:'CONNECTION',icon:'connection',caption:note,color:C.amber});}
  const st=e.st,ch=e.chan(s.channel||(['mic','route'].includes(c.action)?'Strip[0]':''));
  const draw=options=>tile({showText,...options});
  if(['mic','mute','route','level'].includes(c.action)&&!ch)return tile({name:c.action,icon:'settings',caption:'Choose channel',color:C.amber});
  switch(c.action){
    case 'mic':{const m=e.muteOf(ch);return draw({name:ch.name,icon:'mic',color:m?C.red:C.green,slash:m,active:!m});}
    case 'mute':{const m=e.muteOf(ch);return draw({name:ch.name,icon:'speaker',caption:m?'MUTED':'',value:m?'':db(e.gainOf(ch))+' dB',color:m?C.red:C.cyan,slash:m});}
    case 'route':{const bus=s.bus||'B1',on=e.routeOf(ch,bus);if(on===null)return tile({name:bus,icon:'route',caption:routeProblem(ch,bus),color:C.muted});return draw({name:ch.name,bus,color:on?(bus[0]==='A'?C.amber:C.blue):C.muted,active:!!on,pulse:on?.45+.55*e.breath():.25});}
    case 'level':{const mode=s.mode||'up',amount=Number.isFinite(Number(s.amount))?Number(s.amount):2;return draw({name:ch.name,icon:mode==='set'?'faders':mode==='down'?'down':'up',value:(mode==='set'?db(amount):(mode==='down'?'−':'+')+Math.abs(amount))+' dB'});}
    case 'scene':return draw({name:'SCENE',icon:'scene',caption:s.scene||'Choose scene'});
    case 'sound':return draw({name:'SOUNDBOARD',icon:'play',caption:s.sound||'Choose sound'});
    case 'soundstop':return draw({icon:'stop',caption:'STOP SOUNDS'});
    case 'brb':return draw({name:'STREAM MODE',icon:'coffee',caption:st.brb?'BACK LIVE':st.brbSet?'GO BRB':'Not set up',color:st.brb?C.amber:C.cyan,active:!!st.brb});
    case 'record':return draw({name:'RECORDER',icon:'record',caption:st.recording?'RECORDING':'START RECORD',color:st.recording?C.red:C.cyan,active:!!st.recording});
    case 'duck':return draw({name:'TALK OVER',icon:'duck',caption:st.duck?'DUCKING ON':'DUCKING OFF',color:st.duck?C.green:C.muted,active:!!st.duck});
    case 'output':{const name=s.output||st.outputNow||'',active=!!name&&name===st.outputNow;return draw({name:'OUTPUT',icon:outputIcon(name,s),caption:name||'Next output',active,color:active?C.cyan:C.muted});}
    default:return null;
  }
}
// A thin live meter, -60 to 0 dB; nothing is drawn when the app doesn't report levels.
function meter(level,x,y,width,muted) {
  if(!Number.isFinite(level))return '';
  const color=muted?C.muted:level>=-3?C.red:level>=-12?C.amber:C.green;
  return `<rect x="${x}" y="${y}" width="${width}" height="2" rx="1" fill="#1b2029"/><rect x="${x}" y="${y}" width="${(width*clamp((level+60)/60,0,1)).toFixed(1)}" height="2" rx="1" fill="${color}"/>`;
}
const levelFor=(s,e,ch)=>s.showMeter===false||!e.levelOf?null:e.levelOf(ch);
function renderDial(c,e) {
  const s=c.settings||{},ch=e.chan(s.channel),show=s.showText!==false;
  if(e.status!=='ok'||!e.st)return base(200,100,text('SLEEKMEETER OFFLINE',12,37,12,C.amber)+text('Check the connection',12,58,11,C.subtle),C.amber);
  if(!ch)return base(200,100,text('CHOOSE A CHANNEL',12,43,12,C.amber)+text('Open action settings',12,64,11,C.subtle),C.amber);
  const muted=e.muteOf(ch),color=muted?C.red:C.cyan,gain=e.gainOf(ch);
  const heading=show?text(fit(ch.name.toUpperCase(),23),12,22,10,C.subtle):'';
  const value=text(db(gain),12,66,35,muted?C.subtle:C.ink,'start',500)+text('dB',178,65,12,C.subtle);
  const icon=glyph(muted?'speaker':'faders',159,29,1.1,color,muted);
  const track=bar((gain+60)/72,12,81,176,color)+`<path d="M158.7 78v8" stroke="#b6c1d0" stroke-width="1"/>`+meter(levelFor(s,e,ch),12,89,176,muted);
  return base(200,100,heading+value+icon+track,color);
}
function time(seconds){const n=Math.max(0,Math.floor(Number(seconds)||0));return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;}
const safeArt=media=>media.available&&media.art&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(media.art)&&media.art.length<=100000?media.art:'';
const idleTitle=(s,media)=>media.loading?'':s.mediaSource==='auto'?'Nothing playing':'Open Spotify';
const idleArtist=media=>media.loading?'':'Waiting for media';
function renderNowPlaying(c,e,media={}) {
  const s=c.settings||{},ch=e.chan(s.channel),online=e.status==='ok'&&e.st&&ch;
  const muted=online&&e.muteOf(ch),color=muted?C.red:C.cyan;
  const art=safeArt(media)?`<image x="9" y="10" width="57" height="57" href="${media.art}" clip-path="url(#cover)"/>`:`<rect x="9" y="10" width="57" height="57" rx="5" fill="#202936"/>${glyph('music',20,20,1.4,C.subtle)}`;
  const title=media.available?media.title:idleTitle(s,media);
  const artist=media.available?media.artist:idleArtist(media);
  const labels=text(fit(title,18),76,24,12,C.ink)+text(fit(artist,21),76,41,10,C.subtle);
  const transport=media.available?text(media.playing?'Ⅱ':'▶',132,60,10,C.cyan,'middle'):'';
  const timeline=text(media.available?time(media.position):'—:—',76,60,9,C.subtle)+text(media.available&&media.duration>0?time(media.duration):'—:—',190,60,9,C.subtle,'end')+transport+bar(media.duration>0?media.position/media.duration:0,76,69,114,C.cyan);
  const channel=online?text(s.showText!==false?fit(ch.name,18):'',10,86,10,C.subtle)+text((muted?'MUTED · ':'')+db(e.gainOf(ch))+' dB',190,86,10,color,'end'):text('Choose channel / check connection',10,86,10,C.amber);
  const gainBar=(online?bar((e.gainOf(ch)+60)/72,10,90,180,color):bar(0,10,90,180,C.muted))+(online?meter(levelFor(s,e,ch),10,96,180,muted):'');
  const clip='<defs><clipPath id="cover"><rect x="9" y="10" width="57" height="57" rx="5"/></clipPath></defs>';
  return base(200,100,clip+art+labels+timeline+channel+gainBar,color);
}
function renderNowPlayingKey(c,media={}) {
  const s=c.settings||{},show=s.showText!==false,on=!!media.available,cover=safeArt(media);
  const art=cover?`<image width="144" height="144" href="${cover}" preserveAspectRatio="xMidYMid slice" clip-path="url(#key-cover)"/>`:glyph('music',72-22,show?30:44,1.85,C.subtle);
  const veil=cover?'<rect y="58" width="144" height="86" fill="url(#veil)" clip-path="url(#key-cover)"/>':'';
  const title=on?media.title:idleTitle(s,media);
  const words=show?text(fit(title,17),72,on&&media.artist?95:104,13,C.ink,'middle')+(on&&media.artist?text(fit(media.artist,20),72,110,10,'#cdd0d5','middle',500):''):'';
  const paused=on&&!media.playing?`<circle cx="121" cy="23" r="14" fill="#030304" fill-opacity=".72"/><rect x="115" y="16" width="4" height="14" rx="1" fill="${C.ink}"/><rect x="123" y="16" width="4" height="14" rx="1" fill="${C.ink}"/>`:'';
  const progress=on&&media.duration>0?clamp(media.position/media.duration,0,1):0;
  const rail=`<rect x="31" y="119" width="82" height="5" rx="2.5" fill="#24262b"/><rect x="31" y="119" width="${(82*progress).toFixed(1)}" height="5" rx="2.5" fill="${C.cyan}"/>`;
  return uri(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><defs><clipPath id="key-cover"><rect width="144" height="144" rx="12"/></clipPath><linearGradient id="veil" x2="0" y2="1"><stop stop-color="#030304" stop-opacity="0"/><stop offset=".55" stop-color="#030304" stop-opacity=".82"/><stop offset="1" stop-color="#030304" stop-opacity=".94"/></linearGradient></defs><rect width="144" height="144" rx="12" fill="#07090d"/>${art}${veil}${paused}${words}${rail}</svg>`);
}
function renderTrackDial(c,media={}) {
  const s=c.settings||{},on=!!media.available,cover=safeArt(media);
  const clip='<defs><clipPath id="track-cover"><rect x="9" y="10" width="80" height="80" rx="6"/></clipPath></defs>';
  const art=cover?`<image x="9" y="10" width="80" height="80" href="${cover}" clip-path="url(#track-cover)"/>`:`<rect x="9" y="10" width="80" height="80" rx="6" fill="#202936"/>${glyph('music',31,32,1.5,C.subtle)}`;
  const words=text(fit(on?media.title:idleTitle(s,media),14),98,28,13,C.ink)+text(fit(on?media.artist:idleArtist(media),17),98,46,10,C.subtle);
  const timeline=text(on?time(media.position):'—:—',98,70,9,C.subtle)+text(on&&media.duration>0?time(media.duration):'—:—',190,70,9,C.subtle,'end')+(on?text(media.playing?'Ⅱ':'▶',144,70,10,C.cyan,'middle'):'')+bar(on&&media.duration>0?media.position/media.duration:0,98,79,92,C.cyan);
  return base(200,100,clip+art+words+timeline,C.cyan);
}
function renderAppDial(c,a) {
  const s=c.settings||{},name=(a.app&&a.app.name)||s.appName||'';
  const note=(line1,line2,color=C.amber)=>base(200,100,text(line1,12,43,12,color)+text(line2,12,64,11,C.subtle),color);
  if(a.status==='old')return note('UPDATE SLEEKMEETER','App volume needs a newer app');
  if(a.status==='key')return note('WRONG KEY','Check the connection');
  if(a.status!=='ok')return note('SLEEKMEETER OFFLINE','Check the connection');
  if(!s.exe)return note('CHOOSE AN APP','Open action settings');
  if(!a.app)return note(fit(name.toUpperCase(),23),'Not playing audio',C.muted);
  const muted=a.app.mute,color=muted?C.red:C.cyan;
  const heading=s.showText!==false?text(fit(name.toUpperCase(),23),12,22,10,C.subtle):'';
  const value=text(String(Math.round(a.app.volume)),12,66,35,muted?C.subtle:C.ink,'start',500)+text('%',178,65,12,C.subtle);
  return base(200,100,heading+value+glyph(muted?'speaker':'faders',159,29,1.1,color,muted)+bar(a.app.volume/100,12,83,176,color),color);
}
module.exports={renderKey,renderDial,renderNowPlaying,renderNowPlayingKey,renderTrackDial,renderAppDial,time};
