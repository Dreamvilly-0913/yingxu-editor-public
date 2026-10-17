'use strict';
const fs=require('node:fs'),path=require('node:path'),M=require('../src/shared/project.js'),Media=require('../src/main/media.cjs');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'assets/demo');
(async()=>{
 let p=M.createProject('多轨 · 转场 · 动画练习');p.width=1280;p.height=720;p.fps=30;p.subtitleStyle.fontSize=34;
 const imported=[];
 for(const name of ['light.mp4','texture.png','../asr-test/speech-zh.wav']){
  const asset=await Media.probeMedia(path.resolve(dir,name),{ffmpeg:require('./test-env.cjs').ffmpeg(),ffprobe:require('ffprobe-static').path,cacheDir:path.join(root,'work/demo-cache')});imported.push(asset);p=M.addAsset(p,asset);
 }
 p=M.addClip(p,imported[0].id);p=M.updateClip(p,p.clips.at(-1).id,{volume:0.08});
 p=M.addClip(p,imported[1].id);p=M.setClipTransition(p,p.clips.at(-1).id,{type:'crossfade',duration:.8});
 p=M.addClip(p,imported[1].id,.9,{layer:1});let id=p.clips.at(-1).id;p=M.updateClip(p,id,{duration:2.5});
 p=M.setClipKeyframe(p,id,0,{x:-.25,y:-.18,scale:.28,rotation:-12,opacity:.6});
 p=M.setClipKeyframe(p,id,1.2,{x:.05,y:0,scale:.45,rotation:0,opacity:1});
 p=M.setClipKeyframe(p,id,2.5,{x:.26,y:.18,scale:.32,rotation:12,opacity:.8});
 p=M.addClip(p,imported[0].id,4.5,{layer:2});id=p.clips.at(-1).id;p=M.updateClip(p,id,{duration:2.5,volume:0,transform:{x:.2,y:-.18,scale:.34,rotation:-8,opacity:.95}});
 p=M.addClip(p,imported[2].id,0);
 p=M.addSubtitle(p,{start:.1,end:3.5,text:'多轨画面 · 关键帧动画'});p=M.addSubtitle(p,{start:3.7,end:7.8,text:'进入“字幕”可识别这段口播'});
 M.validateProject(p);
 p.assets=p.assets.map(a=>{const {previewUrl,thumbnail,...data}=a;return {...data,path:path.relative(dir,a.path),pathMode:'relative'};});
 const file=path.join(dir,'多轨与动画演示.yxproj');fs.writeFileSync(file,JSON.stringify(p,null,2));console.log(JSON.stringify({file,clips:p.clips.length,tracks:p.videoTrackCount}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
