 'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const M=require('../src/shared/project.js'),Media=require('../src/main/media.cjs');
const work=path.resolve(__dirname,'../work/phase9-engine');
function placeholder(name,kind='video') { return {id:'asset-'+name,name,path:path.resolve(work,name+'.missing'),kind,duration:3,width:kind==='audio'?0:64,height:kind==='audio'?0:64,hasAudio:true,thumbnail:'',previewUrl:'',offline:true,offlineReason:'测试占位：素材已移动'}; }
function projectWithMissing() {let p=M.createProject('offline preflight');for(const asset of [placeholder('主摄像机'),placeholder('旁白','audio')]){p=M.addAsset(p,asset);p=M.addClip(p,asset.id);}return p;}
for(const [kind,exporter,extension]of [['MP4',Media.exportProject,'.mp4'],['ASR WAV',Media.exportProjectAudio,'.wav']])test(kind+' rejects every referenced offline name before any source probe or destination mutation',async()=>{
 await fs.mkdir(work,{recursive:true});const dir=await fs.mkdtemp(path.join(work,'offline-'));
 try{const p=projectWithMissing(),existing=path.join(dir,'existing'+extension),sentinel=Buffer.from('keep my previous output');await fs.writeFile(existing,sentinel);const options={ffmpeg:path.join(dir,'must-not-start-ffmpeg.exe'),ffprobe:path.join(dir,'must-not-start-ffprobe.exe'),workDir:path.join(dir,'must-not-create-job')};
 const expected=error=>{assert.match(error.message,/离线素材/);assert.match(error.message,/主摄像机/);assert.match(error.message,/旁白/);assert.match(error.message,/重新链接/);return true;};
 await assert.rejects(exporter(p,existing,options),expected);assert.deepEqual(await fs.readFile(existing),sentinel);
 const fresh=path.join(dir,'must-not-create-parent','new'+extension);await assert.rejects(exporter(p,fresh,options),expected);
 assert.deepEqual((await fs.readdir(dir)).sort(),[path.basename(existing)],'offline preflight must leave no job, parent directory or partial output');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
