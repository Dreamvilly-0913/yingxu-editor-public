"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/shared/project.js');
const clone = x => JSON.parse(JSON.stringify(x));
const close = (a,b,tolerance=4e-8) => assert.ok(Math.abs(a-b)<=tolerance, `${a} != ${b}`);
function freeze(o){Object.freeze(o);for(const v of Object.values(o))if(v&&typeof v==='object'&&!Object.isFrozen(v))freeze(v);return o;}
function fixture(magnetic=true){
 let p=M.createProject('时间线编辑');
 p=M.addAsset(p,{id:'v',name:'source.mp4',path:'D:/fixture/source.mp4',kind:'video',duration:30,width:640,height:360,hasAudio:true});
 p=M.addAsset(p,{id:'a',name:'source.wav',path:'D:/fixture/source.wav',kind:'audio',duration:30,width:0,height:0,hasAudio:true});
 if(!magnetic)p=M.setMagneticMain(p,false);
 return p;
}
function add(p,id='v',start,layer){p=M.addClip(p,id,start,layer===undefined?{}:{layer});return p;}
function short(p,id='v',start,layer,duration=4){p=add(p,id,start,layer);return M.updateClip(p,p.clips.findLast(c=>c.assetId===id).id,{duration});}
function poses(a,b){for(const k of ['x','y','scale','rotation','opacity'])close(a[k],b[k]);}
function gain(c,t){return M.audioGain({clips:[c]},c,c.start+Math.min(c.duration-1e-8,Math.max(0,t)));}
const CURVE=[{position:0,speed:.5},{position:.3,speed:2.7},{position:.65,speed:.7},{position:1,speed:2}];

test('legacy projects remain magnetic; disabling preserves starts and enabling closes ordered gaps',()=>{
 let p=fixture();p=short(p);p=short(p);assert.equal(p.magneticMain,undefined);assert.equal(M.isMagneticMain(p),true);
 const original=clone(p);freeze(p);let q=M.setMagneticMain(p,false);assert.deepEqual(p,original);assert.equal(q.magneticMain,false);
 q=M.moveClips(q,[q.clips[1].id],2);assert.deepEqual(q.clips.map(c=>c.start),[0,6]);q=short(q,'v');assert.equal(q.clips[2].start,10);
 q=M.setMagneticMain(q,true);assert.deepEqual(q.clips.map(c=>c.start),[0,4,8]);
 assert.throws(()=>M.setMagneticMain(q,0),/布尔/);const bad=clone(q);bad.magneticMain='false';assert.throws(()=>M.validateProject(bad),/布尔/);
});

test('nonmagnetic main permits gaps and only explicit adjacent transition overlaps',()=>{
 let p=short(fixture());p=short(p);p=M.setClipTransition(p,p.clips[1].id,{type:'crossfade',duration:1});p=M.setMagneticMain(p,false);
 assert.deepEqual(p.clips.map(c=>c.start),[0,3]);const bad=clone(p);bad.clips[1].transition.duration=.5;assert.throws(()=>M.validateProject(bad),/指定时长/);
 assert.throws(()=>M.updateClip(p,p.clips[1].id,{start:2.9}),/指定时长/);
 let q=M.moveClips(p,[p.clips[1].id],3);assert.equal(q.clips[1].start,6);assert.equal(q.clips[1].transition,undefined);
 assert.throws(()=>M.moveClips(q,[q.clips[1].id],-3),/不能重叠/);
 q=M.trimClip(p,p.clips[0].id,{edge:'end',time:3.6});close(q.clips[1].transition.duration,.6);
 q=M.trimClip(p,p.clips[0].id,{edge:'end',time:2.5});assert.equal(q.clips[1].transition,undefined);
});

test('group move preserves relative positions across free tracks, rejects collisions atomically and cleans orphan transitions',()=>{
 let p=short(fixture(false),'v',2);p=short(p,'v',8);p=short(p,'v',3,1);p=short(p,'a',3.5);
 const ids=[p.clips[0].id,p.clips[2].id,p.clips[3].id],snapshot=clone(p);freeze(p);
 const moved=M.moveClips(p,ids,1);assert.deepEqual(p,snapshot);assert.deepEqual(moved.clips.filter(c=>ids.includes(c.id)).map(c=>c.start),[3,4,4.5]);
 assert.throws(()=>M.moveClips(p,ids,5),/不能重叠/);assert.deepEqual(p,snapshot);
 assert.throws(()=>M.moveClips(p,ids,-3),/起点/);assert.throws(()=>M.moveClips(p,[p.clips[0].id,p.clips[2].id],1,{layer:2}),/多层/);
 const layered=M.moveClips(p,[p.clips[2].id],0,{layer:8});assert.equal(M.clipLayer(layered.clips[2]),8);assert.equal(layered.videoTrackCount,9);
 const removed=M.removeClips(p,[p.clips[0].id,p.clips[3].id]);assert.equal(removed.clips.length,2);assert.equal(removed.clips.find(c=>c.id===p.clips[1].id).start,8);
 assert.throws(()=>M.removeClips(p,[p.clips[0].id,'missing']),/不存在/);assert.deepEqual(p,snapshot);
});

test('magnetic block movement preserves internal transition and refuses cross track relative-time distortion',()=>{
 let p=short(fixture());p=short(p);p=short(p);p=short(p);const ids=p.clips.map(c=>c.id);
 p=M.setClipTransition(p,ids[2],{type:'crossfade',duration:.6});
 let q=M.moveClips(p,[ids[1],ids[2]],100);assert.deepEqual(q.clips.map(c=>c.id),[ids[0],ids[3],ids[1],ids[2]]);close(q.clips[3].transition.duration,.6);
 assert.equal(q.clips[2].transition,undefined);
 q=short(p,'a',1);assert.throws(()=>M.moveClips(q,[ids[0],q.clips.at(-1).id],2),/关闭主轨磁吸/);
 assert.throws(()=>M.moveClips(p,[ids[0],ids[2]],5),/关闭主轨磁吸/);
 const removed=M.removeClips(p,[ids[1]]);assert.equal(removed.clips.find(c=>c.id===ids[2]).transition,undefined);assert.deepEqual(removed.clips.map(c=>c.start),[0,4,8]);
});

test('trim both edges retains curved source, pose easing and audio automation throughout original domain',()=>{
 for(const kind of ['v','a']){
  let p=short(fixture(false),kind,3,undefined,10),id=p.clips[0].id;
  p=M.updateClip(p,id,{sourceIn:3,speedCurve:CURVE,audioFade:{in:1.2,out:2},transform:{x:-.3,opacity:.2}});
  p=M.setClipKeyframe(p,id,p.clips[0].duration*.8,{x:.5,y:.2,scale:1.5,rotation:60,opacity:.9},{easing:'ease-in-out'});
  const original=p.clips[0],cut=original.duration*.18,end=original.duration*.76,snapshot=clone(p);freeze(p);
  let q=M.trimClip(p,id,{edge:'start',time:original.start+cut});q=M.trimClip(q,id,{edge:'end',time:original.start+end});const c=q.clips[0];
  close(c.start,original.start+cut);close(c.duration,end-cut);assert.deepEqual(p,snapshot);
  for(let n=0;n<=100;n++){const t=c.duration*n/100;close(M.clipSourceTime(c,t),M.clipSourceTime(original,cut+t));poses(M.evaluateTransform(c,t),M.evaluateTransform(original,cut+t));if(n<100)close(gain(c,t),gain(original,cut+t));}
  // Reopen source handles: endpoints continue at their retained values; the old domain is exact.
  let extended=M.trimClip(q,id,{edge:'start',time:c.start-.7});extended=M.trimClip(extended,id,{edge:'end',time:c.start+c.duration+.8});const e=extended.clips[0],prefix=c.start-e.start;
  assert.ok(prefix>.69);for(let n=0;n<=100;n++){const t=c.duration*n/100;close(M.clipSourceTime(e,prefix+t),M.clipSourceTime(c,t));poses(M.evaluateTransform(e,prefix+t),M.evaluateTransform(c,t));if(n<100)close(gain(e,prefix+t),gain(c,t));}
  close(M.clipSourceTime(e,0),c.sourceIn-prefix*M.clipPlaybackRate(c,0));poses(M.evaluateTransform(e,0),M.evaluateTransform(c,0));close(gain(e,0),gain(c,0));poses(M.evaluateTransform(e,e.duration),M.evaluateTransform(c,c.duration));close(gain(e,e.duration),gain(c,c.duration));
 }
});

test('constant/image trim clamps to source and neighbors with one-frame minimum while source remains reversible',()=>{
 let p=short(fixture(false),'v',4,undefined,8),id=p.clips[0].id;p=M.updateClip(p,id,{sourceIn:2,speed:2,duration:5});const c=p.clips[0];
 let q=M.trimClip(p,id,{edge:'start',time:-100});close(q.clips[0].start,3);close(q.clips[0].sourceIn,0);close(q.clips[0].duration,6);
 q=M.trimClip(p,id,{edge:'start',time:100});close(q.clips[0].duration,1/30);q=M.trimClip(p,id,{edge:'end',time:-100});close(q.clips[0].duration,1/30);
 q=M.trimClip(p,id,{edge:'end',time:100});close(q.clips[0].sourceIn+M.clipSourceDuration(q.clips[0]),30);
 let gap=short(fixture(false),'v',1);gap=short(gap,'v',8);gap=M.updateClip(gap,gap.clips[1].id,{sourceIn:3});const last=gap.clips[1];q=M.trimClip(gap,last.id,{edge:'start',time:0});assert.equal(q.clips[1].start,5);q=M.trimClip(gap,gap.clips[0].id,{edge:'end',time:50});assert.equal(q.clips[0].duration,7);
 let image=M.addAsset(fixture(false),{id:'i',name:'still.png',path:'D:/fixture/still.png',kind:'image',duration:0,width:100,height:100,hasAudio:false});image=add(image,'i',2);q=M.trimClip(image,image.clips[0].id,{edge:'end',time:50});assert.equal(q.clips[0].duration,48);
});

test('copy/paste uses independent snapshots, regenerated ids and retains internal transition only',()=>{
 let p=short(fixture());p=short(p);p=short(p);const ids=p.clips.map(c=>c.id);p=M.setClipTransition(p,ids[1],{type:'crossfade',duration:.5});p=M.setClipTransition(p,ids[2],{type:'fadeblack',duration:.6});
 p=M.updateClip(p,ids[1],{mask:{type:'ellipse',feather:.2},advancedColor:{exposureEV:.4}});
 const payload=M.copyItems(p,[{type:'clip',id:ids[1]},{type:'clip',id:ids[2]}]);assert.equal(payload.clips[0].transition,undefined);assert.equal(payload.clips[1].transition.type,'fadeblack');
 const snapshot=clone(payload);freeze(payload);const result=M.pasteItems(p,payload,0);assert.deepEqual(payload,snapshot);assert.equal(result.selection.length,2);assert.ok(result.selection.every(s=>!ids.includes(s.id)));
 assert.equal(result.project.assets.length,p.assets.length);assert.equal(result.project.clips[1].transition.type,'fadeblack');assert.equal(result.project.clips[0].mask.feather,.2);
 result.project.clips[0].mask.feather=.9;assert.equal(payload.clips[0].mask.feather,.2);assert.equal(p.clips[1].mask.feather,.2);
 const foreign=M.pasteItems(M.createProject('跨工程'),payload,3);assert.equal(foreign.project.assets.length,1);assert.notEqual(foreign.project.assets[0].id,'v');assert.equal(foreign.project.clips[0].assetId,foreign.project.assets[0].id);assert.equal(foreign.project.clips[0].start,0);
});

test('mixed clip/subtitle paste preserves relative timing in free mode and blocks magnetic main ambiguity',()=>{
 let p=short(fixture(false),'v',2);p=short(p,'v',2.5,1);p=short(p,'a',3);p=M.addSubtitle(p,{start:3.5,end:4.5,text:'独立字幕'});
 const selections=[...p.clips.map(c=>({type:'clip',id:c.id})),{type:'subtitle',id:p.subtitles[0].id}];const payload=M.copyItems(p,selections),snapshot=clone(p);
 assert.throws(()=>M.pasteItems(M.setMagneticMain(p,true),payload,10),/关闭主轨磁吸/);
 const copied=M.pasteItems(p,payload,12);assert.deepEqual(p,snapshot);const pasted=copied.selection.map(s=>s.type==='clip'?copied.project.clips.find(c=>c.id===s.id):copied.project.subtitles.find(c=>c.id===s.id));assert.deepEqual(pasted.map(c=>c.start),[12,12.5,13,13.5]);assert.equal(pasted[3].end,14.5);
 const subtitle=M.copyItems(p,[{type:'subtitle',id:p.subtitles[0].id}]);const q=M.pasteItems(p,subtitle,1);assert.equal(q.project.subtitles.at(-1).start,1);assert.equal(q.project.subtitles.at(-1).end,2);
 const collisionSnapshot=clone(p);assert.throws(()=>M.pasteItems(p,payload,3),/不能重叠/);assert.deepEqual(p,collisionSnapshot);
});

test('offline metadata survives every editing operation and invalid flags/reasons are rejected',()=>{
 let p=fixture(false);const saved=clone(p);p.assets[0].offline=true;p.assets[0].offlineReason='原文件已移动';M.validateProject(p);p=short(p,'v',2);
 p=M.trimClip(p,p.clips[0].id,{edge:'start',time:3});p=M.moveClips(p,[p.clips[0].id],2);const payload=M.copyItems(p,[{type:'clip',id:p.clips[0].id}]);p=M.pasteItems(p,payload,20).project;
 assert.equal(p.assets[0].offline,true);assert.equal(p.assets[0].offlineReason,'原文件已移动');assert.equal(p.assets[0].duration,saved.assets[0].duration);assert.equal(p.assets[0].path,saved.assets[0].path);
 for(const offline of ['true',1,null]){const bad=clone(p);bad.assets[0].offline=offline;assert.throws(()=>M.validateProject(bad),/布尔/);}const bad=clone(p);bad.assets[0].offlineReason='';assert.throws(()=>M.validateProject(bad),/非空/);
});


test('source handles reopen at endpoint speed without altering retained nonlinear trajectory or exceeding 32 nodes',()=>{
 let p=short(fixture(false),'v',10,undefined,10),id=p.clips[0].id;p=M.updateClip(p,id,{sourceIn:3,speedCurve:CURVE});const original=p.clips[0];
 const q=M.trimClip(p,id,{edge:'start',time:0}),c=q.clips[0];close(c.sourceIn,0);close(c.start,4);close(c.duration,original.duration+6);
 for(let i=0;i<=100;i++){const t=original.duration*i/100;close(M.clipSourceTime(c,t+6),M.clipSourceTime(original,t));close(M.clipPlaybackRate(c,t+6),M.clipPlaybackRate(original,t));}
 const dense=Array.from({length:32},(_,i)=>({position:i/31,speed:i%2?.8:1.2}));let capped=M.updateClip(p,id,{speedCurve:dense});const snapshot=clone(capped);freeze(capped);
 assert.throws(()=>M.trimClip(capped,id,{edge:'start',time:capped.clips[0].start-.5}),/32/);assert.deepEqual(capped,snapshot);
 assert.throws(()=>M.trimClip(capped,id,{edge:'end',time:capped.clips[0].start+capped.clips[0].duration+.5}),/32/);assert.deepEqual(capped,snapshot);
});

test('magnetic moves may enter or leave main with one pure video group while ripple stays deterministic',()=>{
 let p=short(fixture());p=short(p);p=short(p,'v',1,1);const [a,b,overlay]=p.clips;
 let q=M.moveClips(p,[overlay.id],0,{layer:0});assert.deepEqual(q.clips.map(c=>c.id),[a.id,overlay.id,b.id]);assert.deepEqual(q.clips.map(c=>c.start),[0,4,8]);
 q=M.moveClips(p,[a.id],1,{layer:2});assert.equal(M.clipLayer(q.clips.find(c=>c.id===a.id)),2);assert.equal(q.clips.find(c=>c.id===a.id).start,1);assert.equal(q.clips.find(c=>c.id===b.id).start,0);
 let trimmed=M.trimClip(p,a.id,{edge:'start',time:1});assert.equal(trimmed.clips[0].start,0);assert.equal(trimmed.clips[0].sourceIn,1);assert.equal(trimmed.clips[0].duration,3);assert.equal(trimmed.clips[1].start,3);
});
