'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const M = require('../src/shared/project.js');
const Media = require('../src/main/media.cjs');
function image(p,id) { return M.addAsset(p,{id,name:id,path:'D:/fixture/'+id+'.png',kind:'image',duration:5,width:320,height:180,hasAudio:false}); }
function base() { let p=M.createProject('advanced'); for(const id of ['red','blue','green'])p=image(p,id);return p; }
function clip(p,id,duration,layer=0,start) { p=M.addClip(p,id,start,{layer});return M.updateClip(p,p.clips.at(-1).id,{duration}); }
const pose=(patch={})=>({x:0,y:0,scale:1,rotation:0,opacity:1,...patch});
test('overlay timing, saved empty tracks, and main ripple are independent',()=>{
 let p=clip(base(),'red',2);p=clip(p,'green',3,2,1);p=clip(p,'blue',2);
 assert.equal(p.videoTrackCount,3);assert.deepEqual(p.clips.map(c=>c.start),[0,1,2]);
 p=M.updateClip(p,p.clips[0].id,{duration:1});assert.deepEqual(p.clips.map(c=>c.start),[0,1,1]);
 assert.equal(M.projectDuration(p),4);assert.deepEqual(M.getActiveVisualClips(p,1.2).map(c=>c.assetId),['blue','green']);
 p=M.removeClip(p,p.clips[1].id);assert.equal(p.videoTrackCount,3);
 const legacy=JSON.parse(JSON.stringify(p));delete legacy.videoTrackCount;for(const c of legacy.clips)delete c.layer;assert.equal(M.validateProject(legacy),legacy);
});
test('moving clips between free overlay tracks and the main sequence preserves source/keyframes and undo input',()=>{
 let p=clip(clip(base(),'red',2),'blue',2);p=clip(p,'green',1,2,5);
 const id=p.clips.at(-1).id;p=M.updateClip(p,id,{sourceIn:0.75,speed:1.5,duration:1,volume:0.4});
 p=M.setClipKeyframe(p,id,0,pose({x:-0.2,scale:0.3}));p=M.setClipKeyframe(p,id,1,pose({x:0.2,scale:0.8}));
 const original=JSON.parse(JSON.stringify(p)),source=p.clips.at(-1);
 function freeze(value){Object.freeze(value);for(const child of Object.values(value))if(child&&typeof child==='object'&&!Object.isFrozen(child))freeze(child);return value;}freeze(p);
 const moved=M.updateClip(p,id,{layer:0,start:0.5});
 assert.deepEqual(moved.clips.filter(c=>c.track==='video'&&M.clipLayer(c)===0).map(c=>[c.assetId,c.start]),[['red',0],['green',2],['blue',3]]);
 const inserted=moved.clips.find(c=>c.id===id);for(const field of ['assetId','duration','sourceIn','speed','volume','keyframes'])assert.deepEqual(inserted[field],source[field]);
 assert.deepEqual(p,original,'the original undo snapshot remains untouched');assert.notEqual(inserted.keyframes,source.keyframes);
 const overlay=M.updateClip(moved,id,{layer:1,start:0.25});
 assert.deepEqual(overlay.clips.filter(c=>M.clipLayer(c)===0).map(c=>[c.assetId,c.start]),[['red',0],['blue',2]]);
 const free=overlay.clips.find(c=>c.id===id);assert.equal(free.start,0.25);assert.equal(M.clipLayer(free),1);assert.deepEqual(free.keyframes,source.keyframes);assert.equal(free.sourceIn,0.75);
 const atBeginning=M.updateClip(overlay,id,{layer:0,start:0});assert.equal(atBeginning.clips[0].id,id);assert.equal(atBeginning.clips[0].start,0);
 const atEnd=M.updateClip(p,id,{layer:0});assert.equal(atEnd.clips.at(-1).id,id);assert.equal(atEnd.clips.at(-1).start,4,'dropdown without start uses existing absolute time for insertion');
 assert.throws(()=>M.updateClip(moved,id,{start:0.5}),/连续排列/);assert.throws(()=>M.updateClip(p,id,{layer:0,start:NaN}),/有限数值/);
});
test('transition overlap, layer order and opacity match ordinary crossfade / fade-to-black',()=>{
 let p=clip(clip(base(),'red',2),'blue',2),a=p.clips[0].id,b=p.clips[1].id;
 p=M.setClipTransition(p,b,{type:'crossfade',duration:0.6});assert.equal(p.clips[1].start,1.4);assert.equal(M.projectDuration(p),3.4);
 assert.equal(M.visualOpacity(p,p.clips[0],1.7),1);assert.ok(Math.abs(M.visualOpacity(p,p.clips[1],1.7)-0.5)<1e-9);
 assert.ok(Math.abs(M.audioGain(p,p.clips[0],1.7)-0.5)<1e-9);
 p=M.setClipTransition(p,b,{type:'fadeblack',duration:0.6});assert.ok(M.visualOpacity(p,p.clips[0],1.7)<1e-9);assert.ok(M.visualOpacity(p,p.clips[1],1.7)<1e-9);
 p=M.updateClip(p,a,{duration:0.4});assert.equal(p.clips[1].transition.duration,0.2);
 assert.throws(()=>M.setClipTransition(p,a,{type:'crossfade',duration:0.1}),/第二个/);
});
test('keyframes interpolate all pose fields; split preserves both boundary and subsequent poses',()=>{
 let p=clip(base(),'red',4);const id=p.clips[0].id;
 p=M.setClipKeyframe(p,id,0,pose({x:-0.5,scale:0.5}));p=M.setClipKeyframe(p,id,4,pose({x:0.5,scale:1.5,rotation:180,opacity:0.4}));
 const original=p.clips[0],frozen=JSON.stringify(p);const middle=M.evaluateTransform(original,2);assert.equal(middle.x,0);assert.equal(middle.rotation,90);assert.equal(middle.opacity,0.7);
 const cut=M.splitClip(p,id,1.5);assert.equal(JSON.stringify(p),frozen);
 for(const time of [0,0.25,1,2.49]) { const actual=M.evaluateTransform(cut.clips[1],time),expected=M.evaluateTransform(original,time+1.5);for(const key of Object.keys(expected))assert.ok(Math.abs(actual[key]-expected[key])<1e-9,key); }
 p=M.updateClip(p,id,{speed:2});assert.equal(p.clips[0].keyframes[1].time,2);assert.equal(M.evaluateTransform(p.clips[0],1).rotation,90);
 p=M.updateClip(p,id,{duration:1.25});assert.equal(p.clips[0].keyframes.at(-1).time,1.25);assert.equal(M.evaluateTransform(p.clips[0],1.25).rotation,112.5);
});
test('invalid advanced project data is rejected before media processing',()=>{
 const p=clip(base(),'red',2),id=p.clips[0].id;
 for(const patch of [{layer:9},{layer:0.5},{transform:{scale:0}},{transform:{opacity:2}},{transform:{x:Infinity}},{keyframes:[{time:3,...pose()}]},{keyframes:[{time:1,...pose()},{time:1,...pose()}]}])assert.throws(()=>M.updateClip(p,id,patch));
 assert.throws(()=>M.updateClip(p,id,{duration:undefined}),/有限数值/);
});

test('real FFmpeg exports layered affine animation, exact transition timing, audio transcription mix and cancellation', {timeout:180000}, async t=>{
 const ffmpeg=process.env.FFMPEG_PATH||require('../scripts/test-env.cjs').ffmpeg();let ffprobe;try{ffprobe=process.env.FFPROBE_PATH||require('ffprobe-static').path;}catch{t.skip('ffprobe missing');return;}
 const root=path.resolve(__dirname,'../work');await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'advanced-test-'));
 const opts={ffmpeg,ffprobe,workDir:dir,cacheDir:path.join(dir,'thumbs')};
 function run(args){const result=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{windowsHide:true,shell:false,timeout:60000,maxBuffer:16*1024*1024});assert.equal(result.status,0,result.stderr?.toString()||result.error?.message);return result.stdout;}
 const rgb=(data,x,y)=>[...data.subarray((y*320+x)*3,(y*320+x)*3+3)];
 function frame(file,time){return run(['-ss',String(time),'-i',file,'-frames:v','1','-an','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);}
 try {
  const assets=[];for(const name of ['red','blue','lime']){const file=path.join(dir,name+'.png');run(['-f','lavfi','-i',`color=c=${name}:s=320x180`,'-frames:v','1',file]);assets.push(await Media.probeMedia(file,opts));}
  let p=M.createProject('高级验收');p.width=320;p.height=180;for(const asset of assets)p=M.addAsset(p,asset);
  p=clip(p,assets[0].id,2);p=clip(p,assets[1].id,2);p=M.setClipTransition(p,p.clips[1].id,{type:'crossfade',duration:0.6});
  p=clip(p,assets[2].id,2,1,0.4);const overlay=p.clips.at(-1).id;
  p=M.setClipKeyframe(p,overlay,0,pose({x:-0.25,scale:0.25}));p=M.setClipKeyframe(p,overlay,2,pose({x:0.25,scale:0.25,rotation:90,opacity:0.5}));
  const file=path.join(dir,'layers.mp4'),progress=[];const result=await Media.exportProject(p,file,{...opts,onProgress:e=>progress.push(e)});
  assert.ok(Math.abs(result.duration-3.4)<1e-9);assert.equal(progress.at(-1).ratio,1);assert.ok(progress.every((e,i)=>i===0||e.ratio>=progress[i-1].ratio));
  assert.ok(rgb(frame(file,0.2),8,8)[0]>230,'before transition is red');
  const middle=rgb(frame(file,1.7),8,8);assert.ok(middle[0]>100&&middle[0]<155&&middle[2]>100&&middle[2]<155,`crossfade midpoint ${middle}`);
  assert.ok(rgb(frame(file,2.8),8,8)[2]>230,'after transition is blue');
  const first=frame(file,0.4);assert.ok(rgb(first,95,90)[1]>225,'overlay begins at requested time and x offset');assert.ok(rgb(first,80,126)[1]<30,'initial rectangle remains horizontal');
  const later=frame(file,2.2);const animated=rgb(later,224,117);assert.ok(animated[1]>85&&animated[1]<175,`rotation, translation and alpha at end ${animated}`);assert.ok(rgb(later,80,90)[1]<30,'old overlay position clears');
  assert.ok(rgb(frame(file,2.5),224,90)[1]<30,'overlay does not freeze past its end');
  let dark=M.removeClip(p,overlay);dark=M.setClipTransition(dark,dark.clips[1].id,{type:'fadeblack',duration:0.6});const blackFile=path.join(dir,'fadeblack.mp4');await Media.exportProject(dark,blackFile,opts);
  const black=rgb(frame(blackFile,1.7),100,80);assert.ok(black.every(v=>v<15),`fade-black midpoint ${black}`);
  assert.ok(rgb(frame(blackFile,1.5),100,80)[0]>100);assert.ok(rgb(frame(blackFile,1.9),100,80)[2]>100);
  // Scale and Y animation must change geometry at multiple real video timestamps.
  let zoom=M.createProject('缩放纵向动画');zoom.width=320;zoom.height=180;zoom=M.addAsset(zoom,assets[2]);zoom=clip(zoom,assets[2].id,1);
  zoom=M.setClipKeyframe(zoom,zoom.clips[0].id,0,pose({y:-0.2,scale:0.2}));zoom=M.setClipKeyframe(zoom,zoom.clips[0].id,1,pose({y:0.2,scale:0.6}));
  const zoomFile=path.join(dir,'zoom.mp4');await Media.exportProject(zoom,zoomFile,opts);
  const z0=frame(zoomFile,0),z1=frame(zoomFile,0.8);
  assert.ok(rgb(z0,160,54)[1]>220&&rgb(z0,160,110)[1]<20,'initial Y and scale');
  assert.ok(rgb(z1,225,112)[1]>220&&rgb(z1,160,40)[1]<20,'animated scale grows and center moves vertically');
  // The speech-recognition WAV must preserve timeline silence, source trim, speed, gain and total length.
  const wav=path.join(dir,'tone.wav');run(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-c:a','pcm_s16le',wav]);
  const tone=await Media.probeMedia(wav,opts);let audio=M.createProject('识别音轨');audio=M.addAsset(audio,tone);audio=M.addClip(audio,tone.id,0.4);audio=M.updateClip(audio,audio.clips[0].id,{sourceIn:0.2,duration:0.8,speed:2,volume:0.4});
  const voice=path.join(dir,'speech.wav');const audioResult=await Media.exportProjectAudio(audio,voice,opts);assert.equal(audioResult.sampleRate,16000);assert.ok(Math.abs(audioResult.duration-1.2)<1e-9);
  const samples=run(['-i',voice,'-f','f32le','pipe:1']);function rms(start,end){let total=0,count=0;for(let i=Math.round(start*16000);i<Math.round(end*16000);i++){const v=samples.readFloatLE(i*4);total+=v*v;count++;}return Math.sqrt(total/count);}
  assert.ok(rms(0.05,0.3)<0.0001);assert.ok(rms(0.5,0.9)>0.020&&rms(0.5,0.9)<0.035, `mono mix RMS ${rms(0.5,0.9)}`);
  // Actual video audio crossfades share the same transition envelope as preview/ASR.
  const avFile=path.join(dir,'av.mp4');run(['-f','lavfi','-i','color=c=red:s=320x180:r=30:d=1.2','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1.2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',avFile]);
  const av=await Media.probeMedia(avFile,opts);let mix=M.createProject('转场音频');mix=M.addAsset(mix,av);mix=clip(clip(mix,av.id,1),av.id,1);mix=M.setClipTransition(mix,mix.clips[1].id,{type:'crossfade',duration:0.4});
  const mixFile=path.join(dir,'mixed.wav');await Media.exportProjectAudio(mix,mixFile,opts);
  function windowRms(bytes,start,end){let sum=0,n=0;for(let i=Math.round(start*16000);i<Math.round(end*16000);i++){sum+=bytes.readFloatLE(i*4)**2;n++;}return Math.sqrt(sum/n);}
  const crossAudio=run(['-i',mixFile,'-f','f32le','pipe:1']),reference=windowRms(crossAudio,0.2,0.4),during=windowRms(crossAudio,0.72,0.88);
  assert.ok(during/reference>0.85&&during/reference<1.15,`linear audio crossfade stays level ${during/reference}`);
  mix=M.setClipTransition(mix,mix.clips[1].id,{type:'fadeblack',duration:0.4});await Media.exportProjectAudio(mix,mixFile,opts);
  const faded=run(['-i',mixFile,'-f','f32le','pipe:1']);assert.ok(windowRms(faded,0.79,0.81)<reference*0.08,'fade-black audio is quiet at the center');
  const marker=Buffer.from('existing output survives'),cancel=path.join(dir,'cancel.mp4');await fs.writeFile(cancel,marker);const controller=new AbortController();
  await assert.rejects(Media.exportProject(p,cancel,{...opts,signal:controller.signal,onProgress:e=>{if(e.phase==='rendering')controller.abort();}}),e=>e.name==='AbortError');assert.deepEqual(await fs.readFile(cancel),marker);
  assert.ok(!(await fs.readdir(dir)).some(n=>n.startsWith('advanced-export-')||n.startsWith('audio-export-')||n.includes('.partial.')));
  const out=path.resolve(__dirname,'../outputs');await fs.mkdir(out,{recursive:true});await fs.copyFile(file,path.join(out,'映序_多轨转场关键帧验收.mp4'));
  await fs.writeFile(path.join(out,'advanced-media-acceptance.json'),JSON.stringify({success:true,checkedAt:new Date().toISOString(),checks:['layer start/end and ordering','linear position / scale / rotation / opacity keyframes','crossfade exact overlap and midpoint','fade-black midpoint and both halves','16k mono timeline audio trim speed delay gain','video audio crossfade and fade-black envelope','progress monotonic','cancel keeps destination and cleans scratch'],duration:result.duration},null,2));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
