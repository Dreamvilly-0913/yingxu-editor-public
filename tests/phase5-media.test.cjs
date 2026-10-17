'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const M = require('../src/shared/project.js');
const Media = require('../src/main/media.cjs');
function fixture(kind='image',duration=4) {
 let p=M.createProject('phase5');p.width=320;p.height=180;
 p=M.addAsset(p,{id:'source',name:'source',path:'D:/fixtures/source.'+(kind==='audio'?'wav':'png'),kind,duration,width:kind==='audio'?0:320,height:kind==='audio'?0:180,hasAudio:kind==='audio'});
 p=M.addClip(p,'source');return M.updateClip(p,p.clips[0].id,{duration});
}
function close(actual,expected,epsilon=1e-8){assert.ok(Math.abs(actual-expected)<epsilon,`${actual} != ${expected}`);}
test('crop, flip, color remain immutable, normalized and backward compatible',()=>{
 const legacy=fixture(),id=legacy.clips[0].id,input={crop:{left:.25,top:0,right:0,bottom:.25},flipX:true,flipY:true,color:{brightness:.2,contrast:-.3,saturation:.4}};
 const updated=M.updateClip(legacy,id,input);assert.equal(legacy.clips[0].crop,undefined);assert.deepEqual(M.cropRect(updated.assets[0],updated.clips[0]),{x:80,y:0,width:240,height:135});
 input.crop.left=.9;input.color.brightness=1;assert.equal(updated.clips[0].crop.left,.25);assert.equal(updated.clips[0].color.brightness,.2);
 assert.equal(M.validateProject(JSON.parse(JSON.stringify(legacy))).schemaVersion,1);
 for(const patch of [{crop:{left:.8,right:.2}},{crop:{top:-1}},{crop:{left:NaN}},{crop:{foo:0}},{flipX:'yes'},{color:{brightness:1.01}},{color:{temperature:1}}])assert.throws(()=>M.updateClip(legacy,id,patch));
 const tiny=M.updateClip(legacy,id,{crop:{left:.49,right:.49,top:.49,bottom:.49}});assert.ok(M.cropRect(tiny.assets[0],tiny.clips[0]).width>=1);
 const audio=fixture('audio');assert.throws(()=>M.updateClip(audio,audio.clips[0].id,{crop:{left:.1}}));
});
test('clip audio fades apply equally on video, free audio and existing transition envelope',()=>{
 let p=fixture('audio'),id=p.clips[0].id;p=M.updateClip(p,id,{volume:.8,audioFade:{in:1,out:1}});const c=p.clips[0];
 for(const [time,gain] of [[0,0],[.25,.2],[1,.8],[2,.8],[3.5,.4],[4,0]])close(M.audioGain(p,c,time),gain);
 assert.throws(()=>M.updateClip(p,id,{audioFade:{in:3,out:2}}));
 let v=fixture();v=M.addClip(v,'source');v=M.updateClip(v,v.clips[1].id,{duration:4,audioFade:{in:1,out:.5}});v=M.setClipTransition(v,v.clips[1].id,{type:'crossfade',duration:1});
 close(M.audioGain(v,v.clips[1],3.5),.25);
});
test('splitting inside either fade retains every gain and does not add a cut-boundary fade',()=>{
 let p=fixture('audio'),id=p.clips[0].id;p=M.updateClip(p,id,{audioFade:{in:1.2,out:1.4}});const original=p.clips[0];
 for(const split of [.3,2,3.5]) {
  const cut=M.splitClip(p,id,split);assert.ok(cut.clips.every(c=>c.audioEnvelope));
  for(let t=0;t<4;t+=.007){const active=cut.clips.find(c=>t>=c.start&&t<c.start+c.duration);close(M.audioGain(cut,active,t),M.audioGain(p,original,t));}
  close(M.audioEnvelopePoints(cut.clips[0]).at(-1).gain,M.audioEnvelopePoints(cut.clips[1])[0].gain);
  assert.deepEqual(M.validateProject(JSON.parse(JSON.stringify(cut))),cut);
 }
 assert.equal(p.clips[0].audioEnvelope,undefined);
});
test('speed/trim preserve split-envelope timing and explicit fade edits reset custom envelopes',()=>{
 let p=fixture('audio'),id=p.clips[0].id;p=M.updateClip(p,id,{audioFade:{in:1,out:1}});p=M.splitClip(p,id,.4);const right=p.clips[1],old=JSON.parse(JSON.stringify(p));
 p=M.updateClip(p,right.id,{speed:2});const faster=p.clips[1];
 for(const local of [0,.1,.4,.9,1.5])close(M.audioGain(p,faster,faster.start+local),M.audioGain(old,right,right.start+local*2));
 const before=p;p=M.updateClip(p,right.id,{duration:1});close(M.audioEnvelopePoints(p.clips[1]).at(-1).gain,M.audioGain(before,before.clips[1],before.clips[1].start+1));
 p=M.updateClip(p,right.id,{audioFade:{in:.2,out:.3}});assert.equal(p.clips[1].audioEnvelope,undefined);close(M.audioGain(p,p.clips[1],p.clips[1].start),0);
 let plain=fixture('audio');plain=M.updateClip(plain,plain.clips[0].id,{audioFade:{in:1,out:1}});plain=M.updateClip(plain,plain.clips[0].id,{speed:2});assert.deepEqual(plain.clips[0].audioFade,{in:.5,out:.5});
 plain=M.updateClip(plain,plain.clips[0].id,{duration:.4});close(plain.clips[0].audioFade.in,.2);close(plain.clips[0].audioFade.out,.2);
});
test('independent color implementation has neutral identity, weighted grayscale and finite boundary behavior',()=>{
 for(const rgb of [[0,0,0],[1,1,1],[.2,.4,.8]])for(let i=0;i<3;i++)close(M.adjustRgb(rgb,{})[i],rgb[i]);
 const gray=M.adjustRgb([1,0,0],{saturation:-1});gray.forEach(v=>close(v,.208540));
 M.adjustRgb([0,0,0],{contrast:-1}).forEach(v=>close(v,.174));
 for(const brightness of [-1,0,.7,.7001,1])for(const contrast of [-1,0,1])for(const saturation of [-1,0,1])for(const rgb of [[0,0,0],[1,1,1],[1,0,1],[.001,.435,.999]])assert.ok(M.adjustRgb(rgb,{brightness,contrast,saturation}).every(v=>Number.isFinite(v)&&v>=0&&v<=1));
});

test('real FFmpeg verifies crop/flip pixels, LUT color, independent fade RMS and split continuity', {timeout:180000},async()=>{
 const ffmpeg=process.env.FFMPEG_PATH||require('../scripts/test-env.cjs').ffmpeg(),ffprobe=process.env.FFPROBE_PATH||require('ffprobe-static').path;
 const work=path.resolve(__dirname,'../work');await fs.mkdir(work,{recursive:true});const dir=await fs.mkdtemp(path.join(work,'phase5-test-'));
 const options={ffmpeg,ffprobe,workDir:dir,cacheDir:path.join(dir,'thumbs')};
 function run(args){const r=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{windowsHide:true,shell:false,timeout:60000,maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr?.toString()||r.error?.message);return r.stdout;}
 const frame=(file,time=.2)=>run(['-ss',String(time),'-i',file,'-frames:v','1','-an','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
 const pixel=(bytes,x,y)=>[...bytes.subarray((y*320+x)*3,(y*320+x)*3+3)];
 const colorNear=(actual,expected,tolerance=12)=>actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<tolerance,`${actual} vs ${expected}`));
 function samples(file){return run(['-i',file,'-vn','-ar','16000','-ac','1','-f','f32le','pipe:1']);}
 function rms(bytes,start,end){let sum=0,n=0;for(let i=Math.round(start*16000);i<Math.round(end*16000);i++){sum+=bytes.readFloatLE(i*4)**2;n++;}return Math.sqrt(sum/n);}
 try {
  const raw=Buffer.alloc(320*180*3);for(let y=0;y<180;y++)for(let x=0;x<320;x++){const color=y<90?(x<160?[255,0,0]:[0,255,0]):(x<160?[0,0,255]:[255,255,0]);for(let c=0;c<3;c++)raw[(y*320+x)*3+c]=color[c];}
  const ppm=path.join(dir,'quadrants.ppm'),png=path.join(dir,'quadrants.png');await fs.writeFile(ppm,Buffer.concat([Buffer.from('P6\n320 180\n255\n'),raw]));run(['-i',ppm,png]);
  const image=await Media.probeMedia(png,options);let p=M.createProject('裁剪翻转验收');p.width=320;p.height=180;p=M.addAsset(p,image);p=M.addClip(p,image.id);p=M.updateClip(p,p.clips[0].id,{duration:1,crop:{left:.25,top:0,right:0,bottom:.25},flipX:true,flipY:true});
  const geometry=path.join(dir,'geometry.mp4');await Media.exportProject(p,geometry,options);const bytes=frame(geometry);
  colorNear(pixel(bytes,20,20),[255,255,0]);colorNear(pixel(bytes,300,20),[0,0,255]);colorNear(pixel(bytes,20,160),[0,255,0]);colorNear(pixel(bytes,300,160),[255,0,0]);
  p=M.updateClip(p,p.clips[0].id,{color:{brightness:0,contrast:0,saturation:-1}});const gray=path.join(dir,'gray.mp4');await Media.exportProject(p,gray,options);const g=frame(gray);
  colorNear(pixel(g,300,160),[53,53,53],5);colorNear(pixel(g,20,160),[179,179,179],5);colorNear(pixel(g,300,20),[23,23,23],5);colorNear(pixel(g,20,20),[232,232,232],5);
  // A color-graded portrait crop on a free track must preserve transparent letterboxing.
  let layered=M.createProject('调色叠层透明区域');layered.width=320;layered.height=180;layered=M.addAsset(layered,image);layered=M.addClip(layered,image.id);layered=M.updateClip(layered,layered.clips[0].id,{duration:1});
  layered=M.addClip(layered,image.id,0,{layer:1});layered=M.updateClip(layered,layered.clips[1].id,{duration:1,crop:{left:.5,right:0,top:0,bottom:0},color:{saturation:-1}});
  const layers=path.join(dir,'color-layers.mp4');await Media.exportProject(layered,layers,options);const lf=frame(layers);
  colorNear(pixel(lf,20,20),[255,0,0]);colorNear(pixel(lf,300,160),[255,255,0]);colorNear(pixel(lf,160,20),[179,179,179],5);
  const wav=path.join(dir,'tone.wav');run(['-f','lavfi','-i','sine=frequency=1000:sample_rate=48000:duration=4','-c:a','pcm_s16le',wav]);const audio=await Media.probeMedia(wav,options);
  let a=M.createProject('淡入出验收');a.width=320;a.height=180;a=M.addAsset(a,audio);a=M.addClip(a,audio.id);a=M.updateClip(a,a.clips[0].id,{audioFade:{in:1,out:1},volume:.8});
  const whole=path.join(dir,'whole.wav');await Media.exportProjectAudio(a,whole,options);const all=samples(whole),steady=rms(all,1.4,1.8);
  // For a unit linear ramp, RMS over [u,v] equals sqrt((u²+uv+v²)/3) times steady RMS.
  const expected=Math.sqrt((.45*.45+.45*.55+.55*.55)/3);
  close(rms(all,.45,.55)/steady,expected,.008);close(rms(all,3.45,3.55)/steady,expected,.008);assert.ok(rms(all,.005,.025)<steady*.025);
  const split=M.splitClip(a,a.clips[0].id,.3),cut=path.join(dir,'split.wav');await Media.exportProjectAudio(split,cut,options);const cutSamples=samples(cut);
  close(rms(cutSamples,.28,.32)/rms(all,.28,.32),1,.02);close(rms(cutSamples,.32,.42)/rms(all,.32,.42),1,.02);close(rms(cutSamples,3.45,3.55)/rms(all,3.45,3.55),1,.02);
  // Also exercise the simple MP4 path and advanced MP4 path, beyond the ASR WAV path.
  const simple=path.join(dir,'audio-simple.mp4');await Media.exportProject(a,simple,options);const simpleSamples=samples(simple);close(rms(simpleSamples,.45,.55)/rms(simpleSamples,1.4,1.8),expected,.025);
  p=M.addAsset(p,audio);p=M.addClip(p,audio.id);p=M.updateClip(p,p.clips.at(-1).id,{duration:1,audioFade:{in:.4,out:.4},volume:.8});const advanced=path.join(dir,'color-audio.mp4');await Media.exportProject(p,advanced,options);
  const advancedSamples=samples(advanced);assert.ok(rms(advancedSamples,.01,.03)<rms(advancedSamples,.45,.55)*.07);assert.ok(rms(advancedSamples,.45,.55)>0.05);
  assert.ok(!(await fs.readdir(dir)).some(name=>name.startsWith('advanced-export-')||name.startsWith('export-')||name.startsWith('audio-export-')||name.includes('.partial.')),'all owned export scratch is removed');
  const out=path.resolve(__dirname,'../outputs');await fs.copyFile(advanced,path.join(out,'映序_裁剪翻转调色淡入出验收.mp4'));
  await fs.writeFile(path.join(out,'phase5-media-acceptance.json'),JSON.stringify({success:true,checkedAt:new Date().toISOString(),reference:'Independent analytical expected geometry and linear envelope; original Jianying shader differential is a separate report.',checks:['crop and two flips exact quadrant positions','65-grid LUT weighted grayscale RGB','color-graded cropped overlay keeps transparent letterbox','audio fade sample envelope RMS analytic expectation','split inside fade preserves original amplitude','ASR WAV/simple MP4/advanced MP4 share fades','owned scratch cleaned'],duration:1},null,2));
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
