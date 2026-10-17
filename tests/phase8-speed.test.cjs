const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../src/shared/project.js');
const T = require('../src/shared/time-map.js');
const close = (actual, expected, tolerance = 2e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const CURVE = [{position:0,speed:.4},{position:.18,speed:2.8},{position:.52,speed:.25},{position:.8,speed:4},{position:1,speed:.7}];
function fixture(kind='video') {
 let p=M.createProject('曲线速度');p=M.addAsset(p,{id:'source',name:'source',path:'D:/fixture/source.'+(kind==='audio'?'wav':'mp4'),kind,width:kind==='audio'?0:640,height:kind==='audio'?0:360,duration:30,hasAudio:true});
 p=M.addClip(p,'source',kind==='audio'?1.3:0);p=M.updateClip(p,p.clips[0].id,{sourceIn:2,duration:12});return p;
}
function sourceSpeed(curve, position) {
 for(let i=1;i<curve.length;i++)if(position<=curve[i].position){const a=curve[i-1],b=curve[i];return a.speed+(b.speed-a.speed)*(position-a.position)/(b.position-a.position);}
 return curve.at(-1).speed;
}
// Composite Simpson quadrature is independent of the implementation's logarithm.
function integral(curve, end=1) {
 let result=0;
 for(let i=1;i<curve.length;i++){
  const a=curve[i-1].position,b=Math.min(end,curve[i].position);if(b<=a)break;
  const count=4096,step=(b-a)/count;
  let sum=1/sourceSpeed(curve,a)+1/sourceSpeed(curve,b);
  for(let j=1;j<count;j++)sum+=(j%2?4:2)/sourceSpeed(curve,a+j*step);
  result+=sum*step/3;if(b===end)break;
 }
 return result;
}
function samePose(a,b){for(const key of ['x','y','scale','rotation','opacity'])close(a[key],b[key]);}

test('source-domain linear speeds integrate independently, invert exactly and keep legacy constant speed unchanged',()=>{
 const curves=[CURVE,[{position:0,speed:.25},{position:1,speed:4}],[{position:0,speed:4},{position:1,speed:.25}],[{position:0,speed:1},{position:1,speed:1+1e-12}]];
 for(const curve of curves){let p=fixture(),id=p.clips[0].id,original=JSON.stringify(p);const curved=M.updateClip(p,id,{speedCurve:curve}),clip=curved.clips[0];assert.equal(JSON.stringify(p),original);assert.equal(clip.sourceDuration,12);assert.equal(clip.speed,1);close(clip.duration,12*integral(curve));
  for(let n=0;n<=160;n++){const progress=n/160,source=clip.sourceIn+12*progress,local=M.clipLocalTimeForSource(clip,source);close(local,12*integral(curve,progress));close(M.clipSourceTime(clip,local),source);close(M.clipPlaybackRate(clip,local),sourceSpeed(curve,progress));}
  assert.equal(M.clipSourceTime(clip,-1),2);assert.equal(M.clipSourceTime(clip,Infinity),14);assert.equal(M.clipLocalTimeForSource(clip,-10),0);assert.equal(M.clipLocalTimeForSource(clip,100),clip.duration);
 }
 let p=fixture(),id=p.clips[0].id;p=M.updateClip(p,id,{speed:2});const c=p.clips[0];assert.equal(c.duration,6);assert.equal(c.speedCurve,undefined);assert.equal(c.sourceDuration,undefined);for(let t=0;t<=6;t+=.013){close(M.clipSourceTime(c,t),2+2*t);close(M.clipLocalTimeForSource(c,2+2*t),t);assert.equal(M.clipPlaybackRate(c,t),2);}
});

test('curve edits preserve source span and scale output animation and audio automation by duration',()=>{
 let p=fixture(),id=p.clips[0].id;p=M.updateClip(p,id,{audioFade:{in:2,out:3},transform:{x:-.4,opacity:.2}});p=M.setClipKeyframe(p,id,9,{x:.6,y:.2,scale:1.2,rotation:80,opacity:.9},{easing:'ease-in-out'});const before=p.clips[0];
 p=M.updateClip(p,id,{speedCurve:CURVE});const c=p.clips[0],ratio=c.duration/before.duration;close(c.audioFade.in,2*ratio);close(c.audioFade.out,3*ratio);close(c.keyframes[0].time,9*ratio);
 for(let n=0;n<100;n++){const t=before.duration*n/100;samePose(M.evaluateTransform(c,t*ratio),M.evaluateTransform(before,t));close(M.audioGain(p,c,c.start+t*ratio),M.audioGain({clips:[before]},before,before.start+t));}
 const second=[{position:0,speed:4},{position:.3,speed:.5},{position:1,speed:2}];const changed=M.updateClip(p,id,{speedCurve:second}).clips[0];assert.equal(changed.sourceDuration,12);close(M.clipSourceTime(changed,changed.duration),14);
 const normal=M.updateClip(p,id,{speed:2}).clips[0];assert.equal(normal.duration,6);assert.equal(normal.speedCurve,undefined);assert.equal(normal.sourceDuration,undefined);close(normal.keyframes[0].time,4.5);
 const reset=M.updateClip(p,id,{speedCurve:null}).clips[0];assert.equal(reset.duration,12);assert.equal(reset.speed,1);
});

test('splitting curved video and audio retains exact source samples, easing and envelopes at arbitrary cuts',()=>{
 for(const kind of ['video','audio']){let p=fixture(kind),id=p.clips[0].id;p=M.updateClip(p,id,{speedCurve:CURVE,audioFade:{in:2,out:3},transform:{x:-.2,opacity:.15}});if(kind==='video')p=M.setClipKeyframe(p,id,p.clips[0].duration*.87,{x:.3,y:.2,scale:1.6,rotation:130,opacity:.9},{easing:'ease-in-out'});
  const original=p.clips[0],snapshot=JSON.stringify(p);
  for(const fraction of [.031,.18,.49,.83,.997]){const cut=original.duration*fraction,split=M.splitClip(p,id,original.start+cut),[left,right]=split.clips;assert.equal(JSON.stringify(p),snapshot);close(left.sourceDuration+right.sourceDuration,12);close(right.sourceIn,M.clipSourceTime(original,cut));close(M.clipSourceTime(left,left.duration),right.sourceIn);
   for(let n=0;n<=100;n++){const t=original.duration*n/100,part=t<cut?left:right,local=t<cut?t:t-cut;close(M.clipSourceTime(part,local),M.clipSourceTime(original,t));close(M.clipPlaybackRate(part,local),M.clipPlaybackRate(original,t));samePose(M.evaluateTransform(part,local),M.evaluateTransform(original,t));if(n<100)close(M.audioGain(split,part,part.start+local),M.audioGain(p,original,original.start+t));}
  }
 }
});

test('curve trims preserve existing source/pose/audio trajectory and extensions continue final speed',()=>{
 let p=fixture(),id=p.clips[0].id;p=M.updateClip(p,id,{speedCurve:CURVE,audioFade:{in:2,out:3},transform:{opacity:.1}});p=M.setClipKeyframe(p,id,p.clips[0].duration*.9,{opacity:.8},{easing:'ease-out'});const original=p.clips[0],cut=original.duration*.61;
 const trimmed=M.updateClip(p,id,{duration:cut}),clip=trimmed.clips[0];close(clip.sourceDuration,M.clipSourceTime(original,cut)-original.sourceIn);for(let t=0;t<cut;t+=.017){close(M.clipSourceTime(clip,t),M.clipSourceTime(original,t));samePose(M.evaluateTransform(clip,t),M.evaluateTransform(original,t));close(M.audioGain(trimmed,clip,t),M.audioGain(p,original,t));}
 const extension=M.updateClip(trimmed,id,{duration:cut+1.3}).clips[0];for(let t=0;t<=cut;t+=.027)close(M.clipSourceTime(extension,t),M.clipSourceTime(clip,t));close(M.clipSourceTime(extension,extension.duration),M.clipSourceTime(clip,clip.duration)+M.clipPlaybackRate(clip,clip.duration)*1.3);
 const shifted=M.updateClip(trimmed,id,{sourceIn:3}).clips[0];for(let t=0;t<cut;t+=.031)close(M.clipSourceTime(shifted,t),M.clipSourceTime(clip,t)+1);
 const rescaled=M.updateClip(trimmed,id,{sourceDuration:clip.sourceDuration*.8}).clips[0];close(rescaled.duration,clip.duration*.8);
});

test('export segment plans retain exact boundaries and bound variable audio approximation error',()=>{
 let p=fixture();p=M.updateClip(p,p.clips[0].id,{speedCurve:CURVE});const c=p.clips[0],segments=M.curveSegmentPlan(c,{maxOutputStep:.04});assert.ok(segments.length>100);assert.equal(segments[0].sourceStart,c.sourceIn);close(segments.at(-1).sourceEnd,c.sourceIn+12);assert.equal(segments.at(-1).localEnd,c.duration);
 for(let i=0;i<segments.length;i++){const s=segments[i];assert.ok(s.localEnd-s.localStart<=.040000001);if(i){close(s.sourceStart,segments[i-1].sourceEnd);close(s.localStart,segments[i-1].localEnd);}close(s.sourceStart,M.clipSourceTime(c,s.localStart));close(s.sourceEnd,M.clipSourceTime(c,s.localEnd));for(let n=0;n<=8;n++){const t=(s.localEnd-s.localStart)*n/8,approx=s.sourceStart+s.rate*t,exact=M.clipSourceTime(c,s.localStart+t);assert.ok(Math.abs(approx-exact)<=s.maxSourceError+2e-11,`source error ${Math.abs(approx-exact)} > ${s.maxSourceError}`);}}
 assert.equal(M.curveSegmentPlan(c).length,CURVE.length-1);assert.throws(()=>M.curveSegmentPlan(c,{maxOutputStep:0}));
});

test('curve project JSON/browser roundtrips are immutable and validation rejects inconsistent maps and advanced color',()=>{
 let p=fixture(),id=p.clips[0].id;const curve=JSON.parse(JSON.stringify(CURVE)),advanced={exposureEV:.4,curves:{master:[[0,.02],[.5,.55],[1,.98]]}};p=M.updateClip(p,id,{speedCurve:curve,advancedColor:advanced});curve[0].speed=4;advanced.curves.master[0][1]=.9;assert.equal(p.clips[0].speedCurve[0].speed,.4);assert.equal(p.clips[0].advancedColor.curves.master[0][1],.02);const copy=JSON.parse(JSON.stringify(p));assert.deepEqual(M.validateProject(copy),p);
 const context=vm.createContext({});for(const file of ['time-map.js','advanced-color.js','audio-model.js','text-style.js','visual-effects.js','project.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/shared',file),'utf8'),context);close(context.EditorModel.clipSourceTime(copy.clips[0],1.12),M.clipSourceTime(copy.clips[0],1.12));context.serializedProject=JSON.stringify(copy);assert.equal(vm.runInContext('EditorModel.validateProject(JSON.parse(serializedProject)).id',context),p.id);
 for(const speedCurve of [[],[{position:0,speed:0},{position:1,speed:1}],[{position:.1,speed:1},{position:1,speed:1}],[{position:0,speed:1},{position:0,speed:2},{position:1,speed:1}],[{position:0,speed:NaN},{position:1,speed:1}],[{position:0,speed:1,bogus:1},{position:1,speed:1}]])assert.throws(()=>M.updateClip(p,id,{speedCurve}));
 const bad=JSON.parse(JSON.stringify(p));bad.clips[0].duration+=.1;assert.throws(()=>M.validateProject(bad),/时长不一致/);assert.throws(()=>M.updateClip(p,id,{advancedColor:{nonsense:1}}));assert.throws(()=>M.updateClip(p,id,{sourceDuration:40}),/源区间/);
 const rgb=[.123,.435,.926];assert.deepEqual(M.adjustRgb(rgb,{brightness:.2}),M.adjustRgb(rgb,{brightness:.2},{}));
});
