'use strict';
const {app,BrowserWindow,ipcMain,dialog,protocol,shell,Menu}=require('electron');
const fs=require('node:fs');const fsp=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');const {pathToFileURL}=require('node:url');
const {mediaResponse}=require('./media-protocol.cjs');
const Model=require('../shared/project.js');const Media=require('./media.cjs');const Transcription=require('./transcription.cjs');const ProjectFiles=require('./project-files.cjs');
const Services=require('./editor-services.cjs'),ExportOptions=require('./export-options.cjs');
const ROOT=path.resolve(__dirname,'../..');
const PAGE=pathToFileURL(path.join(ROOT,'src/renderer/index.html')).href;
const allowedSourcePaths=new Set(),allowedOfflineSourcePaths=new Set(),importJobs=new Set();
const mediaPaths=new Map(),projectPaths=new Map(),jobs=new Map(),asrJobs=new Map(),reveals=new Set();
let win,allowClose=false,closingExports=false,pendingMediaStart=false;
let recoveryQueue=Promise.resolve();
protocol.registerSchemesAsPrivileged([{scheme:'yingxu-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}]);
app.setName('映序剪辑');
if(process.env.YINGXU_TEST==='1')app.setPath('userData',process.env.YINGXU_TEST_PROFILE||path.join(ROOT,'work','desktop-test-profile'));
const ownsInstance=app.requestSingleInstanceLock();
if(!ownsInstance)app.quit();
else app.on('second-instance',()=>{if(win&&!win.isDestroyed()&&process.env.YINGXU_TEST!=='1'){if(win.isMinimized())win.restore();win.show();win.focus();}});
const exts=['mp4','mov','mkv','webm','avi','m4v','mp3','wav','m4a','aac','ogg','flac','png','jpg','jpeg','webp','bmp'];
function tools(){
 const ffmpegName=process.platform==='win32'?'ffmpeg.exe':'ffmpeg';
 const ffmpeg=[process.env.YINGXU_FFMPEG,path.join(ROOT,'tools',ffmpegName),...(process.env.PATH||'').split(path.delimiter).filter(Boolean).map(dir=>path.join(dir,ffmpegName))].filter(Boolean).find(p=>fs.existsSync(p));
 let ffprobe=[process.env.YINGXU_FFPROBE,path.join(ROOT,'tools','ffprobe.exe')].filter(Boolean).find(p=>fs.existsSync(p));
 if(!ffprobe){try{ffprobe=require('ffprobe-static').path;}catch{}}
 return {ffmpeg,ffprobe};
}
function dirs(){const base=app.getPath('userData');return {cacheDir:path.join(base,'media-cache'),workDir:path.join(base,'export-work')};}
function requireTools(){const t=tools();if(!t.ffmpeg||!t.ffprobe||!fs.existsSync(t.ffprobe))throw new Error('媒体工具不完整，请使用完整的映序剪辑目录启动。');return t;}
function trust(event){if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url.split('#')[0]!==PAGE)throw new Error('拒绝来自非编辑器窗口的请求');}
function handle(channel,fn){ipcMain.handle(channel,async(event,...args)=>{trust(event);return fn(...args);});}
function checkedPath(file){if(typeof file!=='string'||!path.isAbsolute(file)||!exts.includes(path.extname(file).slice(1).toLowerCase()))throw new Error('请选择支持的视频、音频或图片文件');const p=fs.realpathSync(file);if(!fs.statSync(p).isFile())throw new Error('素材不是有效文件');return p;}
function register(asset){const p=checkedPath(asset.path),{previewPath,...publicAsset}=asset;const token=crypto.randomBytes(20).toString('hex');mediaPaths.set(token,previewPath?checkedPath(previewPath):p);allowedSourcePaths.add(p);let previewAudioUrl;if(previewPath&&asset.kind==='video'&&asset.hasAudio){const audioToken=crypto.randomBytes(20).toString('hex');mediaPaths.set(audioToken,p);previewAudioUrl=`yingxu-media://asset/${audioToken}`;}return {...publicAsset,path:p,previewUrl:`yingxu-media://asset/${token}`,previewAudioUrl};}
async function sourceTask(operation){
 const controller=new AbortController();controller.done=new Promise(resolve=>{controller.finish=resolve;});importJobs.add(controller);
 const progress=data=>{if(win&&!win.isDestroyed())win.webContents.send('import-progress',data);};
 const probe=async(p,index=0,total=1)=>{
  ProjectFiles.abort(controller.signal);const file=checkedPath(p),t=requireTools();await fsp.mkdir(dirs().cacheDir,{recursive:true});progress({active:true,index:index+1,total,name:path.basename(file),ratio:0,message:'正在准备素材'});
  const asset=await Media.probeMedia(file,{...t,...dirs(),proxyHeight:Services.prefs(app).proxyHeight,signal:controller.signal,onProgress:info=>progress({active:true,index:index+1,total,name:path.basename(file),...info})});
  ProjectFiles.abort(controller.signal);return register({...asset,id:asset.id||crypto.randomUUID(),path:file,name:asset.name||path.basename(file)});
 };
 try{return await operation({signal:controller.signal,probe,progress});}finally{importJobs.delete(controller);controller.finish();if(!importJobs.size)progress({active:false});}
}
async function importPaths(paths){
 if(!Array.isArray(paths)||paths.length>100)throw new Error('一次最多导入 100 个素材');
 return sourceTask(async({probe})=>{const assets=[];for(const [index,p]of paths.entries())assets.push(await probe(p,index,paths.length));return assets;});
}
// Clipboard pastes may regenerate project and asset IDs. Only paths actually seen in an opened
// offline project are reusable; a renderer-provided offline flag grants no new filesystem access.
function rememberOffline(_projectId,asset){allowedOfflineSourcePaths.add(canonical(asset.path));}

function validate(p){Model.validateProject(p);if(p.assets.length>1000||p.clips.length>5000||p.subtitles.length>10000)throw new Error('工程超过当前版本的处理范围');return p;}
function exportSnapshot(p){const clone=JSON.parse(JSON.stringify(validate(p))),used=new Set(clone.clips.map(c=>c.assetId));const missing=clone.assets.filter(a=>used.has(a.id)&&a.offline);if(missing.length)throw new Error('时间线包含离线素材，请先重链接：'+missing.map(a=>a.name).join('、'));for(const a of clone.assets)if(used.has(a.id)){a.path=checkedPath(a.path);if(!allowedSourcePaths.has(a.path))throw new Error(`请先导入素材：${a.name}`);}return clone;}
function persistSnapshot(p){const clone=JSON.parse(JSON.stringify(validate(p)));for(const a of clone.assets){const offlineAllowed=a.offline&&allowedOfflineSourcePaths.has(canonical(a.path));if(!offlineAllowed&&!allowedSourcePaths.has(a.path))throw new Error(`请先导入或重链接素材：${a.name}`);if(a.offline&&!offlineAllowed)throw new Error(`离线素材未经工程授权：${a.name}`);}return clone;}

async function atomicSave(file,data,{backup=true}={}){const temp=file+'.writing-'+crypto.randomBytes(5).toString('hex');try{const h=await fsp.open(temp,'wx');try{await h.writeFile(data,'utf8');await h.sync();}finally{await h.close();}if(backup&&fs.existsSync(file))await fsp.copyFile(file,file+'.bak');await fsp.rename(temp,file);}finally{if(fs.existsSync(temp))await fsp.unlink(temp);}}
function storedProject(p,file){return ProjectFiles.storedProject(p,file);}
function validateStoredProject(p){return validate(ProjectFiles.validateStored(p));}
async function hydrateProject(p,file){validateStoredProject(p);return sourceTask(({probe,signal})=>ProjectFiles.hydrateProject(p,file,{probe,signal,onOffline:a=>rememberOffline(p.id,a)}));}
async function saveProject(p,forceDialog=false){
 p=persistSnapshot(p);let file=forceDialog?undefined:projectPaths.get(p.id);
 if(!file){const previous=projectPaths.get(p.id),result=await dialog.showSaveDialog(win,{title:forceDialog?'工程另存为':'保存映序工程',defaultPath:previous||path.join(app.getPath('documents'),`${safeName(p.name)}.yxproj`),filters:[{name:'映序工程',extensions:['yxproj']}],properties:['createDirectory','showOverwriteConfirmation']});if(result.canceled||!result.filePath)return {canceled:true};file=result.filePath.toLowerCase().endsWith('.yxproj')?result.filePath:result.filePath+'.yxproj';}
 if([...allowedSourcePaths].some(source=>canonical(source)===canonical(file)))throw new Error('工程不能覆盖源素材，请选择另一个文件名');
 await atomicSave(file,JSON.stringify(storedProject(p,file),null,2));projectPaths.set(p.id,file);reveals.add(file);return {canceled:false,path:file};
}

async function openProjectFile(file){
 const info=await fsp.stat(file);if(info.size>25*1024*1024)throw new Error('工程文件过大');
 const p=await hydrateProject(JSON.parse(await fsp.readFile(file,'utf8')),file);projectPaths.set(p.id,file);return p;
}
function recoveryFile(){return path.join(app.getPath('userData'),'recovery.yxproj.json');}
function serializeRecovery(operation){const result=recoveryQueue.then(operation);recoveryQueue=result.catch(()=>{});return result;}
async function readRecovery(){
 const file=recoveryFile();let info;try{info=await fsp.stat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(info.size>25*1024*1024)throw new Error('自动恢复记录过大，请忽略该记录后重新保存工程。');
 let data;try{data=JSON.parse(await fsp.readFile(file,'utf8'));}catch{throw new Error('自动恢复记录损坏；原工程文件未受影响。');}
 if(data.recoveryVersion!==1||typeof data.savedAt!=='string'||!Number.isFinite(Date.parse(data.savedAt)))throw new Error('自动恢复记录版本无效');
 validateStoredProject(data.project);return data;
}

function emit(data){if(win&&!win.isDestroyed())win.webContents.send('export-progress',data);}
function emitTranscription(data){if(win&&!win.isDestroyed())win.webContents.send('transcription-progress',data);}
function pendingJobs(){return [...jobs.values(),...asrJobs.values(),...importJobs];}
async function exclusiveMediaStart(operation){
 if(pendingMediaStart||jobs.size||asrJobs.size)throw new Error('已有媒体任务，请等待完成或取消');
 pendingMediaStart=true;try{return await operation();}finally{pendingMediaStart=false;}
}
function setupHandlers(){
 Services.install({handle,app,dialog,getWindow:()=>win,dirs,requireTools,sourceTask,persistSnapshot,exportSnapshot,checkedPath,allowedSourcePaths,mediaPaths,atomicSave,pendingJobs});
 handle('environment',()=>({ffmpegAvailable:!!tools().ffmpeg&&!!tools().ffprobe,version:app.getVersion(),platform:process.platform}));
 handle('import-media',async()=>{const result=await dialog.showOpenDialog(win,{title:'导入素材',properties:['openFile','multiSelections'],filters:[{name:'媒体素材',extensions:exts}]});return result.canceled?[]:importPaths(result.filePaths);});
 handle('import-paths',importPaths);
 handle('cancel-import',async()=>{const active=[...importJobs];for(const job of active)job.abort();await Promise.all(active.map(job=>job.done));return true;});
 handle('save-project',p=>saveProject(p));
 handle('save-project-as',p=>saveProject(p,true));
 handle('relink-assets',async(project,assetIds)=>{
  const p=persistSnapshot(project),ids=ProjectFiles.selectedAssetIds(p,assetIds);if(!ids.length)return {canceled:false,project:p,linked:[],unresolved:[]};
  const single=ids.length===1,result=await dialog.showOpenDialog(win,{title:single?'重新链接素材':'选择重链接素材文件夹',properties:single?['openFile']:['openDirectory'],...(single?{filters:[{name:'媒体素材',extensions:exts}]}:{})});if(result.canceled||!result.filePaths?.[0])return {canceled:true};
  const selection=single?{file:result.filePaths[0]}:{directory:result.filePaths[0]};const linked=await sourceTask(({probe,signal})=>ProjectFiles.relinkProject(p,ids,{...selection,probe,signal}));return {canceled:false,...linked};
 });
 handle('archive-project',async project=>{
  const p=persistSnapshot(project);if(p.assets.some(a=>a.offline))throw new Error('工程仍有离线素材，请全部重链接后再归档');
  const result=await dialog.showOpenDialog(win,{title:'选择工程归档位置（将在其中新建独立文件夹）',properties:['openDirectory','createDirectory']});if(result.canceled||!result.filePaths?.[0])return {canceled:true};
  const archive=await sourceTask(({signal,progress})=>ProjectFiles.archiveProject(p,result.filePaths[0],{signal,onProgress:info=>progress({active:true,...info,message:'正在归档原素材'})}));reveals.add(archive.path);return {canceled:false,...archive};
 });
 handle('open-project',async()=>{const result=await dialog.showOpenDialog(win,{title:'打开映序工程',properties:['openFile'],filters:[{name:'映序工程',extensions:['yxproj']}]});if(result.canceled)return {canceled:true};const file=result.filePaths[0];return {canceled:false,path:file,project:await openProjectFile(file)};});
 handle('recovery-status',()=>serializeRecovery(async()=>{const data=await readRecovery();return data?{available:true,name:data.project.name,savedAt:data.savedAt,projectId:data.project.id}:{available:false};}));
 handle('save-recovery',p=>{const snapshot=persistSnapshot(p);return serializeRecovery(async()=>{
  const file=recoveryFile(),savedAt=new Date().toISOString(),data=JSON.stringify({recoveryVersion:1,savedAt,project:storedProject(snapshot,file)});
  if(Buffer.byteLength(data,'utf8')>25*1024*1024)throw new Error('工程过大，无法自动暂存，请手动保存。');
  await fsp.mkdir(path.dirname(file),{recursive:true});await atomicSave(file,data,{backup:false});return {savedAt,projectId:snapshot.id};
 });});
 handle('clear-recovery',()=>serializeRecovery(async()=>{await fsp.rm(recoveryFile(),{force:true});return true;}));
 handle('restore-recovery',()=>serializeRecovery(async()=>{const data=await readRecovery();if(!data)throw new Error('没有可恢复的工程');const p=await hydrateProject(data.project,recoveryFile());projectPaths.delete(p.id);return {canceled:false,project:p};}));
 handle('export-subtitles',async p=>{
  p=validate(JSON.parse(JSON.stringify(p)));if(!p.subtitles.length)throw new Error('还没有可导出的字幕');if(p.subtitles.some(c=>/\n[ \t]*\n/.test(c.text.replace(/\r\n?/g,'\n'))))throw new Error('字幕包含空白段落，请删除同一条字幕中的空行后导出 SRT。工程文字未修改。');const content=Model.toSrt(p.subtitles);
  const result=await dialog.showSaveDialog(win,{title:'导出 SRT 字幕',defaultPath:path.join(app.getPath('documents'),safeName(p.name)+'.srt'),filters:[{name:'UTF-8 SRT 字幕',extensions:['srt']}],properties:['createDirectory','showOverwriteConfirmation']});
  if(result.canceled)return {canceled:true};const file=result.filePath.toLowerCase().endsWith('.srt')?result.filePath:result.filePath+'.srt';
  if([...allowedSourcePaths,...projectPaths.values()].some(source=>canonical(source)===canonical(file)))throw new Error('字幕不能覆盖工程或源素材，请选择另一个文件名');
  await atomicSave(file,content);reveals.add(file);return {canceled:false,path:file};
 });
 handle('import-subtitles',async()=>{const result=await dialog.showOpenDialog(win,{title:'导入 SRT 字幕',properties:['openFile'],filters:[{name:'UTF-8 SRT 字幕',extensions:['srt']}]});if(result.canceled)return {canceled:true};const file=result.filePaths[0];if((await fsp.stat(file)).size>2*1024*1024)throw new Error('字幕文件过大');return {canceled:false,text:(await fsp.readFile(file,'utf8')).replace(/^\uFEFF/,'')};});
 handle('export-project',async(project,settings={})=>exclusiveMediaStart(async()=>{
  if(jobs.size||asrJobs.size)throw new Error('已有媒体任务，请等待完成或取消');
  const p=exportSnapshot(project);const originalHeight=p.height;for(const k of ['width','height','fps'])if(settings[k]!==undefined)p[k]=Number(settings[k]);if(p.height!==originalHeight){const scale=p.height/originalHeight,oldCanvas={...p,height:originalHeight};if(require('../shared/text-style.js').usesCanvas(p))for(const [kind,cues] of [['subtitle',p.subtitles],['text',p.texts||[]]])for(const cue of cues){const style=require('../shared/text-style.js').normalizeStyle(cue.style||{},oldCanvas,kind);for(const key of ['fontSize','letterSpacing','padding','outlineWidth','shadowBlur','shadowX','shadowY'])if(typeof style[key]==='number')style[key]*=scale;cue.style=style;}p.subtitleStyle.fontSize*=scale;}validate(p);const t=requireTools(),exportSettings=ExportOptions.normalize(settings,Model.projectDuration(p)),extension=exportSettings.mode==='wav'?'wav':'mp4';
  const result=await dialog.showSaveDialog(win,{title:'导出视频',defaultPath:path.join(app.getPath('videos'),safeName(p.name)+'.'+extension),filters:[{name:extension==='wav'?'无损PCM音频':'H.264 视频',extensions:[extension]}],properties:['createDirectory','showOverwriteConfirmation']});if(result.canceled)return {canceled:true};if(!win||win.isDestroyed())throw new Error('编辑器窗口已关闭');
  const output=result.filePath.toLowerCase().endsWith('.'+extension)?result.filePath:result.filePath+'.'+extension;if(p.assets.some(a=>canonical(a.path)===canonical(output)))throw new Error('导出位置不能覆盖源素材，请选择另一个文件名');
  const jobId=crypto.randomUUID(),controller=new AbortController();const staging=path.join(path.dirname(output),`.yingxu-${jobId}.${extension}`);controller.done=new Promise(resolve=>{controller.finish=resolve;});jobs.set(jobId,controller);
  setTimeout(async()=>{try{const result=await (extension==='wav'?Media.exportProjectAudio:Media.exportProject)(p,staging,{...t,...dirs(),settings:exportSettings,...(extension==='wav'?{sampleRate:48000,channels:2}:{}),signal:controller.signal,onProgress:info=>emit({jobId,progress:Math.max(0,Math.min(.999,info.ratio||0)),status:'running',message:info.message})});if(controller.signal.aborted)throw Object.assign(new Error('已取消'),{name:'AbortError'});await fsp.rename(staging,output);reveals.add(output);emit({jobId,progress:1,status:'completed',path:output,encoder:result.encoder,fallbackReason:result.fallbackReason});}catch(e){emit({jobId,progress:0,status:e.name==='AbortError'?'canceled':'error',error:e.message});}finally{if(fs.existsSync(staging))await fsp.unlink(staging).catch(()=>{});jobs.delete(jobId);controller.finish();}},25);
  return {jobId,canceled:false,path:output};
 }));
 handle('cancel-export',jobId=>{const job=jobs.get(jobId);if(job)job.abort();return {canceled:!!job};});
 handle('asr-status',()=>Transcription.getStatus({root:ROOT}));
 handle('start-transcription',async(project,settings={})=>exclusiveMediaStart(async()=>{
  if(jobs.size||asrJobs.size)throw new Error('已有媒体任务，请等待完成或取消');
  const language=settings.language===undefined?'auto':settings.language;
  if(!['auto','zh','en'].includes(language))throw new Error('请选择支持的识别语言');
  const p=exportSnapshot(project),t=requireTools();
  const available=await Transcription.getStatus({root:ROOT});if(!win||win.isDestroyed())throw new Error('编辑器窗口已关闭');
  if(!available.available)throw new Error(available.reason||'本地语音识别工具不完整，请使用完整的映序剪辑目录启动。');
  if(!p.clips.some(c=>p.assets.find(a=>a.id===c.assetId)?.hasAudio&&c.volume>0))throw new Error('时间线没有可识别的声音，请添加带语音的视频或音频。');
  const jobId=crypto.randomUUID(),controller=new AbortController();
  controller.done=new Promise(resolve=>{controller.finish=resolve;});asrJobs.set(jobId,controller);
  setTimeout(async()=>{
   try{
    const result=await Transcription.transcribeProject(p,{...t,...dirs(),asrDir:path.join(ROOT,'tools','asr'),language,signal:controller.signal,onProgress:info=>emitTranscription({jobId,status:'running',progress:Math.max(0,Math.min(.999,info.ratio||0)),stage:info.stage,message:info.message})});
    if(controller.signal.aborted)throw Object.assign(new Error('识别已取消'),{name:'AbortError'});
    emitTranscription({jobId,status:'completed',progress:1,cues:result.cues,engine:result.engine,model:result.model,language:result.language,duration:result.duration});
   }catch(e){emitTranscription({jobId,status:e.name==='AbortError'?'canceled':'error',progress:0,error:e.message});}
   finally{asrJobs.delete(jobId);controller.finish();}
  },25);
  return {jobId,canceled:false};
 }));
 handle('cancel-transcription',jobId=>{const job=asrJobs.get(jobId);if(job)job.abort();return {canceled:!!job};});

 handle('reveal-file',file=>{if(!reveals.has(file))throw new Error('该文件尚未由本编辑器保存');shell.showItemInFolder(file);return true;});
 handle('open-demo',async()=>{let p=Model.createProject('片刻 · 剪辑练习');const demo=path.join(ROOT,'assets','demo');const files=['light.mp4','texture.png','tone.wav'].map(n=>path.join(demo,n));const assets=await importPaths(files);for(const a of assets)p=Model.addAsset(p,a);p=Model.addClip(p,assets[0].id);p=Model.addClip(p,assets[1].id);p=Model.addClip(p,assets[2].id,0);const audio=p.clips.find(c=>c.track==='audio');p=Model.updateClip(p,audio.id,{duration:Math.min(8,audio.duration),volume:.25});p=Model.addSubtitle(p,{start:.4,end:3.8,text:'把平凡的片刻，剪成故事。'});p=Model.addSubtitle(p,{start:4.3,end:7.8,text:'导入 · 分割 · 字幕 · 导出'});return p;});
}
function canonical(file){let resolved;try{resolved=fs.existsSync(file)?fs.realpathSync(file):path.join(fs.realpathSync(path.dirname(file)),path.basename(file));}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;resolved=path.resolve(file);}return process.platform==='win32'?resolved.toLowerCase():resolved;}
function safeName(s){return String(s||'未命名工程').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,80)||'未命名工程';}
if(ownsInstance)app.whenReady().then(()=>{
 protocol.handle('yingxu-media',async req=>{const u=new URL(req.url);const p=u.hostname==='asset'?mediaPaths.get(u.pathname.slice(1)):undefined;if(!p)return new Response('Not found',{status:404});return mediaResponse(req,p);});
 Menu.setApplicationMenu(null);
 win=new BrowserWindow({width:1500,height:970,minWidth:1050,minHeight:720,backgroundColor:'#101315',title:'映序剪辑',show:process.env.YINGXU_TEST!=='1',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(event,url)=>{if(url!==PAGE)event.preventDefault();});
 win.webContents.session.setPermissionRequestHandler((wc,permission,cb,details)=>cb(wc===win.webContents&&win.webContents.getURL().split('#')[0]===PAGE&&permission==='media'&&details.isMainFrame===true&&details.requestingUrl.split('#')[0]===PAGE&&Array.isArray(details.mediaTypes)&&details.mediaTypes.length>0&&details.mediaTypes.every(type=>type==='audio')));
 win.webContents.session.setPermissionCheckHandler((wc,permission,_origin,details)=>wc===win.webContents&&win.webContents.getURL().split('#')[0]===PAGE&&permission==='media'&&details.isMainFrame===true&&details.mediaType==='audio');
 win.webContents.on('will-prevent-unload',event=>{if(allowClose)return event.preventDefault();const choice=dialog.showMessageBoxSync(win,{type:'question',buttons:['继续编辑','放弃更改并退出'],defaultId:0,cancelId:0,message:'工程还有未保存的更改。',detail:'可以返回编辑器保存工程，再退出。'});if(choice===1){allowClose=true;event.preventDefault();}});
 win.on('close',event=>{if(pendingMediaStart&&!jobs.size&&!asrJobs.size){event.preventDefault();return;}if(closingExports){event.preventDefault();return;}if((jobs.size||asrJobs.size||importJobs.size)&&!allowClose){event.preventDefault();const recognition=asrJobs.size>0,importing=importJobs.size>0;const choice=dialog.showMessageBoxSync(win,{type:'question',buttons:[importing?'继续准备素材':recognition?'继续识别':'继续导出',importing?'取消准备并退出':recognition?'取消识别并退出':'取消导出并退出'],defaultId:0,cancelId:0,message:importing?'正在为素材准备统一的预览颜色。':recognition?'正在生成自动字幕。':'视频正在导出。'});if(choice===0)return;closingExports=true;const pending=pendingJobs();for(const job of pending)job.abort();Promise.all(pending.map(job=>job.done)).finally(()=>{closingExports=false;if(win&&!win.isDestroyed())win.close();});}});
 setupHandlers();win.loadURL(PAGE);
});
app.on('window-all-closed',()=>app.quit());app.on('before-quit',()=>{for(const job of pendingJobs())job.abort();});
