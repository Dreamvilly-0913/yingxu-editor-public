'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../src/shared/project.js');
const pose=(x=0)=>({x,y:x/2,scale:1+x/2,rotation:x*90,opacity:.5+x/4});
const close=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
function fixture(){let p=M.createProject('phase7');p=M.addAsset(p,{id:'a',name:'a',path:'D:/fixtures/a.png',kind:'image',width:200,height:100,duration:8,hasAudio:false});p=M.addClip(p,'a');return M.updateClip(p,p.clips[0].id,{duration:8,transform:pose(0)});}
const curves=['linear','ease-in','ease-out','ease-in-out','hold'];
function samePose(a,b){for(const key of Object.keys(pose()))close(a[key],b[key]);}
test('quadratic easing/hold presets have known endpoints and values with immutable legacy defaults',()=>{
 const quarter={linear:.25,'ease-in':.0625,'ease-out':.4375,'ease-in-out':.125,hold:0};
 for(const curve of curves){close(M.normalizedEasingProgress(curve,0),0);close(M.normalizedEasingProgress(curve,1),1);close(M.normalizedEasingProgress(curve,.25),quarter[curve]);}
 close(M.normalizedEasingProgress('ease-in',.5,[.25,.75]),.375);
 for(const easing of ['ease-in','ease-out','ease-in-out'])for(const window of [[1e-8,1.0001e-8],[.99999998,.999999980001],[.499999999999,.500000000001]]){const mid=M.normalizedEasingProgress(easing,.5,window);assert.ok(Number.isFinite(mid)&&mid>.4999&&mid<.5001,`${easing} narrow ${window}: ${mid}`);}
 let p=fixture(),id=p.clips[0].id,original=JSON.stringify(p);p=M.setClipKeyframe(p,id,4,pose(1));samePose(M.evaluateTransform(p.clips[0],2),pose(.5));assert.equal(JSON.stringify(fixture()).includes('easing'),false);assert.notEqual(JSON.stringify(p),original);
 for(const easing of ['bezier',null,1])assert.throws(()=>M.setClipKeyframe(p,id,4,pose(1),{easing}));
 for(const easingWindow of [[1,0],[0,0],[-.1,1],[0,2],[0],[0,NaN]])assert.throws(()=>M.updateClip(p,id,{keyframes:[{time:4,...pose(1),easingWindow}]}));
});
test('nonlinear/hold split, trim, speed and inserted boundary keys preserve every sampled pose and undo snapshot',()=>{
 for(const curve of curves){let p=fixture(),id=p.clips[0].id;p=M.setClipKeyframe(p,id,3,pose(1),{easing:curve});p=M.setClipKeyframe(p,id,7,pose(-.8),{easing:curve});const original=p.clips[0],snapshot=JSON.stringify(p);
  for(const cutTime of [.73,2.61,3,5.23,7.3]){const cut=M.splitClip(p,id,cutTime);M.validateProject(JSON.parse(JSON.stringify(cut)));for(let t=0;t<=8;t+=.031){const c=t<cutTime?cut.clips[0]:cut.clips[1];samePose(M.evaluateTransform(c,t-c.start),M.evaluateTransform(original,t));}}
  const trim=M.updateClip(p,id,{duration:5.23});for(let t=0;t<=5.23;t+=.037)samePose(M.evaluateTransform(trim.clips[0],t),M.evaluateTransform(original,t));
  const speed=M.updateClip(trim,id,{speed:2});for(let t=0;t<=2.615;t+=.027)samePose(M.evaluateTransform(speed.clips[0],t),M.evaluateTransform(original,t*2));
  let inserted=p;for(const t of [.73,2.61,4.12,5.23])inserted=M.setClipKeyframe(inserted,id,t,M.evaluateTransform(original,t));for(let t=0;t<=8;t+=.017)samePose(M.evaluateTransform(inserted.clips[0],t),M.evaluateTransform(original,t));
  let restored=inserted;for(const t of [2.61,.73,5.23,4.12])restored=M.removeClipKeyframe(restored,id,t);for(let t=0;t<=8;t+=.017)samePose(M.evaluateTransform(restored.clips[0],t),M.evaluateTransform(original,t));
  assert.equal(JSON.stringify(p),snapshot,'undo input is unchanged');assert.equal(M.validateProject(JSON.parse(JSON.stringify(inserted))).schemaVersion,1);
 }
});
test('dense 128-key tracks remain splittable without introducing excess boundary nodes',()=>{
 let p=fixture(),id=p.clips[0].id;const keys=Array.from({length:128},(_,i)=>({time:(i+1)/20,...pose(Math.sin(i)),easing:'ease-in-out'}));p=M.updateClip(p,id,{keyframes:keys});for(const t of [.01,6.37,6.5]){const cut=M.splitClip(p,id,t);assert.ok(cut.clips.every(c=>c.keyframes.length<=128));}
});
test('source-domain masks support exact full rectangles, alpha complement, rotation, feather and immutable schema validation',()=>{
 const rect={type:'rectangle',centerX:.5,centerY:.5,width:1,height:1,rotation:0,feather:0,invert:false};for(let y=.5;y<100;y+=7)for(let x=.5;x<200;x+=7){close(M.evaluateMaskAlpha(rect,x,y,200,100),1);close(M.evaluateMaskAlpha({...rect,invert:true},x,y,200,100),0);}
 close(M.evaluateMaskAlpha({...rect,width:.5,height:.5,feather:.2},50,50,200,100),.5);
 close(M.evaluateMaskAlpha({...rect,width:.5,height:.5,feather:.2},40,50,200,100),0);close(M.evaluateMaskAlpha({...rect,width:.5,height:.5,feather:.2},60,50,200,100),1);
 close(M.evaluateMaskAlpha({...rect,type:'ellipse',width:.5,height:.5},100,50,200,100),1);close(M.evaluateMaskAlpha({...rect,type:'ellipse',width:.5,height:.5},140,70,200,100),0);
 for(const type of ['rectangle','ellipse'])for(const rotation of [0,37,90])for(let y=.5;y<100;y+=13)for(let x=.5;x<200;x+=11){const m={...rect,type,rotation,width:.6,height:.3,feather:.25};close(M.evaluateMaskAlpha(m,x,y,200,100)+M.evaluateMaskAlpha({...m,invert:true},x,y,200,100),1);}
 const p=fixture(),id=p.clips[0].id,copy=JSON.stringify(p),input={...rect,feather:.3};const next=M.updateClip(p,id,{mask:input});input.feather=.8;close(next.clips[0].mask.feather,.3);assert.equal(JSON.stringify(p),copy);assert.equal(M.updateClip(next,id,{mask:null}).clips[0].mask,undefined);M.validateProject(JSON.parse(JSON.stringify(next)));
 for(const mask of [{type:'polygon'},{centerX:NaN},{width:0},{height:5},{feather:1.1},{invert:'yes'},{foo:1}])assert.throws(()=>M.updateClip(p,id,{mask}));
});
