'use strict';
// Filesystem operations for portable projects. Electron dialogs and authorizations live in main.cjs.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {Transform}=require('node:stream');
const Model=require('../shared/project.js');
const clone=value=>JSON.parse(JSON.stringify(value));
function abort(signal){if(signal?.aborted)throw Object.assign(new Error('素材操作已取消'),{name:'AbortError'});}
function canceled(error,signal){return signal?.aborted||error?.name==='AbortError';}
function safeName(value){const clean=String(value||'未命名工程').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100).replace(/[. ]+$/,'')||'未命名工程';return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)?'_'+clean:clean;}
function stripPreview(asset){const {thumbnail,previewUrl,previewAudioUrl,previewPath,...keep}=asset;return keep;}
function validateStored(project){if(project?.schemaVersion!==1)throw new Error('不支持此工程版本，请选择 .yxproj 工程');if(!Array.isArray(project.assets)||project.assets.length>1000)throw new Error('工程素材列表无效或超过 1000 个');const p=clone(project);p.assets=p.assets.map(a=>({...a,thumbnail:'',previewUrl:''}));Model.validateProject(p);return p;}
function storedProject(project,file){const p=clone(project);p.assets=p.assets.map(a=>({...stripPreview(a),path:path.relative(path.dirname(file),a.path),pathMode:'relative'}));return p;}
function requiredSourceEnd(project,assetId){return project.clips.filter(c=>c.assetId===assetId).reduce((end,c)=>Math.max(end,c.sourceIn+Model.clipSourceDuration(c)),0);}
function checkReplacement(project,original,replacement){if(replacement.kind!==original.kind)throw new Error(`素材类型不符：需要${{video:'视频',audio:'音频',image:'图片'}[original.kind]}`);const end=requiredSourceEnd(project,original.id);if(original.kind!=='image'&&replacement.duration+1e-7<end)throw new Error(`素材时长不足：至少需要 ${end.toFixed(3)} 秒，所选素材为 ${replacement.duration.toFixed(3)} 秒`);}
function onlineAsset(original,replacement){const asset={...original,...replacement,id:original.id,name:original.name||replacement.name};delete asset.offline;delete asset.offlineReason;delete asset.pathMode;return asset;}
async function hydrateProject(project,file,{probe,signal,onOffline=()=>{}}={}){
 const p=validateStored(project),refreshed=[];
 for(let index=0;index<p.assets.length;index++){
  abort(signal);const a=p.assets[index],absolute=a.pathMode==='relative'?path.resolve(path.dirname(file),a.path):path.resolve(a.path);
  try{const replacement=await probe(absolute,index,p.assets.length);abort(signal);checkReplacement(p,a,replacement);refreshed.push(onlineAsset(a,replacement));}
  catch(error){if(canceled(error,signal))throw Object.assign(new Error('素材操作已取消'),{name:'AbortError'});const missing={...stripPreview(a),path:absolute,offline:true,offlineReason:String(error.message||error).slice(0,2000),thumbnail:'',previewUrl:''};delete missing.pathMode;refreshed.push(missing);onOffline(missing);}
 }
 p.assets=refreshed;Model.validateProject(p);return p;
}
function selectedAssetIds(project,assetIds){const ids=assetIds===undefined?project.assets.filter(a=>a.offline).map(a=>a.id):assetIds;if(!Array.isArray(ids)||ids.length>1000||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!project.assets.some(a=>a.id===id)))throw new Error('重链接素材列表无效');return ids;}
async function findCandidates(directory,names,{signal,maxEntries=50000,maxDepth=32}={}){
 const base=await fsp.realpath(directory);if(!(await fsp.stat(base)).isDirectory())throw new Error('请选择素材文件夹');const wanted=new Set(names.map(n=>n.toLowerCase())),found=new Map();let entries=0;
 async function walk(dir,depth){abort(signal);if(depth>maxDepth)throw new Error('素材文件夹层级超过 32 层，请选择更具体的文件夹');for(const entry of await fsp.readdir(dir,{withFileTypes:true})){abort(signal);if(++entries>maxEntries)throw new Error('素材文件夹超过 50000 个条目，请选择更具体的文件夹');const file=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())await walk(file,depth+1);else if(entry.isFile()&&wanted.has(entry.name.toLowerCase())){const key=entry.name.toLowerCase(),list=found.get(key)||[];list.push(file);found.set(key,list);}}}
 await walk(base,0);return found;
}
async function relinkProject(project,assetIds,{file,directory,probe,signal}={}){
 Model.validateProject(project);const ids=selectedAssetIds(project,assetIds),p=clone(project),linked=[],unresolved=[];
 if(!ids.length)return {project:p,linked,unresolved};
 if(ids.length===1&&!file)throw new Error('请选择替换素材');if(ids.length>1&&!directory)throw new Error('请选择素材所在文件夹');
 const candidates=ids.length>1?await findCandidates(directory,ids.map(id=>path.basename(p.assets.find(a=>a.id===id).path)),{signal}):null;
 for(let index=0;index<ids.length;index++){
  abort(signal);const id=ids[index],position=p.assets.findIndex(a=>a.id===id),a=p.assets[position];let selected;
  try{if(ids.length===1)selected=file;else{const list=candidates.get(path.basename(a.path).toLowerCase())||[];if(!list.length)throw new Error('所选文件夹中未找到同名素材');if(list.length!==1)throw new Error(`发现 ${list.length} 个同名文件，请单独选择以免误链接`);selected=list[0];}
   const replacement=await probe(selected,index,ids.length);abort(signal);checkReplacement(p,a,replacement);p.assets[position]=onlineAsset(a,replacement);linked.push({assetId:id,path:p.assets[position].path});
  }catch(error){if(canceled(error,signal))throw Object.assign(new Error('素材操作已取消'),{name:'AbortError'});unresolved.push({assetId:id,name:a.name,path:a.path,reason:String(error.message||error).slice(0,2000)});}
 }
 if(linked.length)p.updatedAt=new Date().toISOString();Model.validateProject(p);return {project:p,linked,unresolved};
}
async function copyOriginal(source,destination,{signal,onBytes=()=>{}}={}){
 abort(signal);const original=await fsp.realpath(source),before=await fsp.stat(original);if(!before.isFile())throw new Error('素材不是有效文件');const hash=crypto.createHash('sha256');let bytes=0;
 const meter=new Transform({transform(chunk,_encoding,callback){hash.update(chunk);bytes+=chunk.length;onBytes(bytes,before.size);callback(null,chunk);}});
 await pipeline(fs.createReadStream(original,{highWaterMark:1024*1024}),meter,fs.createWriteStream(destination,{flags:'wx'}),{signal});abort(signal);const after=await fsp.stat(original);
 if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes!==before.size)throw new Error(`复制期间源素材发生变化：${path.basename(source)}`);
 return {bytes,sha256:hash.digest('hex')};
}
function inside(parent,target){const rel=path.relative(parent,target);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);}
async function archiveProject(project,parent,{signal,onProgress=()=>{},copy=copyOriginal}={}){
 Model.validateProject(project);if(project.assets.some(a=>a.offline))throw new Error('工程仍有离线素材，请全部重链接后再归档');abort(signal);
 const base=await fsp.realpath(parent);if(!(await fsp.stat(base)).isDirectory())throw new Error('请选择归档目标文件夹');
 const name=safeName(project.name),stage=await fsp.mkdtemp(path.join(base,'.yingxu-archive-'));let published,ownsPublished=false;
 try{
  const mediaDir=path.join(stage,'media');await fsp.mkdir(mediaDir);const p=clone(project),copied=new Map(),records=[];
  for(let index=0;index<p.assets.length;index++){
   abort(signal);const a=p.assets[index],real=await fsp.realpath(a.path),key=process.platform==='win32'?real.toLowerCase():real;let entry=copied.get(key);
   if(!entry){const extension=path.extname(real),stem=path.basename(real,extension),mediaName=String(copied.size+1).padStart(4,'0')+'_'+safeName(stem)+extension,destination=path.join(mediaDir,mediaName);if(!inside(mediaDir,destination))throw new Error('归档素材路径无效');const digest=await copy(real,destination,{signal,onBytes:(bytes,total)=>onProgress({index:index+1,total:p.assets.length,name:a.name,ratio:total?bytes/total:1})});entry={relative:path.join('media',mediaName),...digest};copied.set(key,entry);}
   a.path=path.join(stage,entry.relative);records.push({assetId:a.id,originalPath:real,path:entry.relative,...entry});onProgress({index:index+1,total:p.assets.length,name:a.name,ratio:1});
  }
  abort(signal);const projectName=name+'.yxproj',saved=storedProject(p,path.join(stage,projectName));await fsp.writeFile(path.join(stage,projectName),JSON.stringify(saved,null,2),{flag:'wx'});
  await fsp.writeFile(path.join(stage,'archive-report.json'),JSON.stringify({archiveVersion:1,createdAt:new Date().toISOString(),projectFile:projectName,originalUnchanged:true,mediaCount:copied.size,assets:records},null,2),{flag:'wx'});
  // Reserve a brand-new directory exclusively. Every cleanup below is limited to paths we created.
  const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\..*$/,'').replace('T','-');for(let n=0;n<1000;n++){published=path.join(base,`${name}-归档-${stamp}${n?'-'+n:''}`);if(!inside(base,published))throw new Error('归档目标路径无效');try{await fsp.mkdir(published);ownsPublished=true;break;}catch(error){if(error.code!=='EEXIST')throw error;}}
  if(!ownsPublished)throw new Error('归档目标重名过多，请选择其他位置');abort(signal);
  for(const entry of ['media','archive-report.json',projectName]){abort(signal);await fsp.rename(path.join(stage,entry),path.join(published,entry));}
  abort(signal);await fsp.rmdir(stage);return {path:path.join(published,projectName),directory:published,mediaCount:copied.size,originalUnchanged:true};
 }catch(error){if(ownsPublished&&inside(base,published))await fsp.rm(published,{recursive:true,force:true});if(inside(base,stage))await fsp.rm(stage,{recursive:true,force:true});throw error;}
}
module.exports={abort,canceled,safeName,stripPreview,validateStored,storedProject,requiredSourceEnd,checkReplacement,hydrateProject,selectedAssetIds,findCandidates,relinkProject,copyOriginal,archiveProject};
