/* Render one transparent text layer with the exact renderer Canvas layout. */
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const TextStyle=require('../shared/text-style.js');
function abortError(){const e=new Error('文字渲染已取消');e.name='AbortError';return e;}
function check(signal){if(signal?.aborted)throw abortError();}
function eventsFor(project){
 const cues=[...(project.subtitles||[]),...(project.texts||[])];
 const duration=Math.max(0,...(project.clips||[]).map(c=>c.start+c.duration),...cues.map(c=>c.end));
 const frameCount=Math.max(1,Math.ceil(duration*project.fps-1e-9)), points=new Set([0,frameCount]);
 for(const c of cues){points.add(Math.min(frameCount,Math.max(0,Math.ceil(c.start*project.fps-1e-9))));points.add(Math.min(frameCount,Math.max(0,Math.ceil(c.end*project.fps-1e-9))));}
 const sorted=[...points].sort((a,b)=>a-b);return {frameCount,duration,events:sorted.slice(0,-1).map((frame,i)=>({frame,frames:sorted[i+1]-frame,time:frame/project.fps+1e-10}))};
}
function run(command,args,{cwd,signal}={}){return new Promise((resolve,reject)=>{check(signal);const child=spawn(command,args,{cwd,windowsHide:true,stdio:['ignore','ignore','pipe']});let log='',settled=false;const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});const done=(error)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);error?reject(error):resolve();};child.stderr.on('data',b=>{log=(log+b.toString()).slice(-5000);});child.on('error',done);child.on('close',code=>{if(signal?.aborted)return done(abortError());done(code===0?null:new Error('文字图层编码失败：'+log));});});}
async function renderTextOverlay(project,{scratch,ffmpeg='ffmpeg',signal,onProgress}={}){
 TextStyle.validateProjectText(project);if(!TextStyle.usesCanvas(project))return null;if(!scratch)throw new Error('文字渲染缺少临时目录');check(signal);
 if(project.width*project.height>67108864)throw new Error('当前文字栅格化最多支持 67108864 个画布像素');
 const electron=require('electron');if(!electron.BrowserWindow||!electron.app)throw new Error('完整文字样式导出需要桌面 Electron Canvas 渲染器');await electron.app.whenReady();check(signal);
 const {frameCount,events}=eventsFor(project),directory=path.join(scratch,'text-overlay');await fs.mkdir(directory,{recursive:true});
 let window=new electron.BrowserWindow({show:false,width:32,height:32,backgroundColor:'#00000000',transparent:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}});
 const cancelWindow=()=>{if(window&&!window.isDestroyed())window.destroy();};signal?.addEventListener('abort',cancelWindow,{once:true});
 const output=path.join(directory,'text-overlay.mkv');
 try{
  await window.loadFile(path.join(__dirname,'text-raster.html'));check(signal);
  const serialized=JSON.stringify(project).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  await window.webContents.executeJavaScript('window.textProject='+serialized+';document.fonts.ready.then(()=>true)');
  const concat=['ffconcat version 1.0'];
  for(let i=0;i<events.length;i++){
   check(signal);const event=events[i],name='text-'+String(i).padStart(6,'0')+'.png';
   const png=await window.webContents.executeJavaScript('(()=>{const c=document.getElementById("textCanvas");EditorTextStyle.paintCanvas(c,window.textProject,'+JSON.stringify(event.time)+');return c.toDataURL("image/png");})()');check(signal);
   if(typeof png!=='string'||!png.startsWith('data:image/png;base64,'))throw new Error('文字画布没有返回有效 PNG');
   await fs.writeFile(path.join(directory,name),Buffer.from(png.slice(22),'base64'));
   concat.push("file '"+name+"'",'option framerate '+project.fps,'duration '+(event.frames/project.fps).toPrecision(17));
   try{onProgress?.({index:i+1,total:events.length,phase:'text',ratio:(i+1)/events.length});}catch{}
  }
  check(signal);const finalName='text-'+String(events.length-1).padStart(6,'0')+'.png';concat.push("file '"+finalName+"'",'option framerate '+project.fps,'');await fs.writeFile(path.join(directory,'text.ffconcat'),concat.join('\n'),'utf8');
  cancelWindow();window=null;check(signal);
  await run(ffmpeg,['-hide_banner','-nostdin','-loglevel','error','-y','-f','concat','-safe','0','-i','text.ffconcat','-vf','fps='+project.fps+':start_time=0:round=near,format=bgra','-frames:v',String(frameCount),'-an','-c:v','ffv1','-level','3','-threads','2','-pix_fmt','bgra',output],{cwd:directory,signal});check(signal);
  return {path:output,frameCount,events:events.length,renderer:'shared-canvas',width:project.width,height:project.height};
 }catch(error){if(signal?.aborted)throw abortError();throw error;}finally{signal?.removeEventListener('abort',cancelWindow);cancelWindow();}
}
module.exports={renderTextOverlay,eventsFor};
