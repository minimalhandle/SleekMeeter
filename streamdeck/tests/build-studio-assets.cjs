'use strict';
const fs=require('fs'),path=require('path'),sharp=require('sharp');
const root=path.resolve(__dirname,'../com.minimalhandle.sleekmeeter.sdPlugin');
const studio=require(path.join(root,'bin/studio')),glyphs=require(path.join(root,'bin/symbols.json'));
async function main(){
 const dir=path.join(root,'imgs/keys');fs.mkdirSync(dir,{recursive:true});
 const ch={name:'CHANNEL',gain:0,mute:false};
 const e={status:'ok',st:{brbSet:true,outputNow:'Headphones'},chan:()=>ch,gainOf:c=>c.gain,muteOf:c=>c.mute,routeOf:()=>true,breath:()=>.5};
 for(const action of ['channel','mute','mic','route','level','scene','sound','soundstop','brb','record','duck','output','nowplaying']){
  const svg=action==='channel'?studio.renderKey({action:'level',settings:{mode:'set',amount:0}},e):action==='nowplaying'?studio.renderKey({action:'sound',settings:{sound:'NOW PLAYING'}},e):studio.renderKey({action,settings:{bus:'B1'}},e);
  const raw=Buffer.from(decodeURIComponent(svg.slice(svg.indexOf(',')+1)));
  for(const [suffix,size]of [['',72],['@2x',144]])await sharp(raw).resize(size,size).png().toFile(path.join(dir,action+suffix+'.png'));
 }
 for(const [suffix,size]of [['',20],['@2x',40]]){
  const svg=`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${glyphs.music.replace(/currentColor/g,'white')}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(root,'imgs/actions/nowplaying'+suffix+'.png'));
 }
 console.log('Generated Studio fallback images and Now Playing action icon');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

