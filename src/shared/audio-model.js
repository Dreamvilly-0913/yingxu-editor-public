/* Immutable audio track settings, shared by renderer and export. */
(function(root,factory){'use strict';const value=factory();if(typeof module==='object'&&module.exports)module.exports=value;if(root)root.EditorAudioModel=value;})(typeof window!=='undefined'?window:globalThis,function(){
'use strict';
const MAX_TRACKS=8,LEGACY_TRACK_ID='audio-1',DEFAULT_EFFECTS=Object.freeze({denoise:0,normalize:false,targetLufs:-16});
const copy=x=>JSON.parse(JSON.stringify(x)),stamp=p=>(p.updatedAt=new Date().toISOString(),p);
function fail(s){throw new Error(s);}
function finite(v,label,min,max){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail(label+'超出允许范围 '+min+'–'+max);}
function keys(value,allowed,label){if(!value||typeof value!=='object'||Array.isArray(value))fail(label+'必须是对象');for(const k of Object.keys(value))if(!allowed.includes(k))fail(label+'包含未知参数：'+k);}
function tracks(p){return p.audioTracks===undefined?[{id:LEGACY_TRACK_ID,name:'音频 1',muted:false,solo:false,locked:false,gain:1}]:p.audioTracks;}
function trackId(c){return c.audioTrackId||LEGACY_TRACK_ID;}
function getTrack(p,idOrClip){const id=typeof idOrClip==='string'?idOrClip:trackId(idOrClip);return tracks(p).find(t=>t.id===id);}
function effects(c){return Object.assign({},DEFAULT_EFFECTS,c.audioEffects);}
function validateEffects(value){keys(value,['denoise','normalize','targetLufs'],'声音处理');const f=Object.assign({},DEFAULT_EFFECTS,value);finite(f.denoise,'降噪强度',0,1);finite(f.targetLufs,'响度目标',-24,-9);if(typeof f.normalize!=='boolean')fail('响度归一必须是布尔值');return true;}
function validateProject(p){
 const list=tracks(p);if(!Array.isArray(list)||list.length<1||list.length>MAX_TRACKS)fail('音频轨数量必须为 1–'+MAX_TRACKS);
 const ids=new Set();for(const t of list){keys(t,['id','name','muted','solo','locked','gain'],'音频轨');if(typeof t.id!=='string'||!t.id.trim()||ids.has(t.id))fail('音频轨 ID 不能为空或重复');ids.add(t.id);if(typeof t.name!=='string'||!t.name.trim()||t.name.length>60)fail('音频轨名称需为 1–60 字');for(const k of ['muted','solo','locked'])if(typeof t[k]!=='boolean')fail('音轨 '+k+' 必须是布尔值');finite(t.gain,'音轨增益',0,2);}
 for(const c of p.clips||[]){if(c.audioTrackId!==undefined&&(c.track!=='audio'||typeof c.audioTrackId!=='string'))fail('独立音轨只能用于音频片段');if(c.track==='audio'&&!getTrack(p,c))fail('音频片段引用的音轨不存在');if(c.audioMuted!==undefined&&typeof c.audioMuted!=='boolean')fail('片段静音必须是布尔值');if(c.audioEffects!==undefined)validateEffects(c.audioEffects);}
 return true;
}
function effectiveGain(p,c){if(c.audioMuted)return 0;const list=tracks(p),solo=list.some(t=>t.solo);if(c.track!=='audio')return solo?0:1;const t=getTrack(p,c);return !t||t.muted||(solo&&!t.solo)?0:t.gain;}
function isLocked(p,clipOrId){const c=typeof clipOrId==='string'?(p.clips||[]).find(c=>c.id===clipOrId):clipOrId;return Boolean(c?.track==='audio'&&getTrack(p,c)?.locked);}
function assertUnlocked(p,ids){for(const id of ids){if(isLocked(p,id))fail('音轨已锁定，请先解锁再编辑片段');}}
function usesMaster(p){return p.audioTracks!==undefined||(p.clips||[]).some(c=>c.audioTrackId!==undefined||c.audioMuted!==undefined||c.audioEffects!==undefined);}
function change(p,fn){validateProject(p);const next=copy(p);fn(next);validateProject(next);return stamp(next);}
function nextTrackId(p){for(let i=1;i<=MAX_TRACKS;i++)if(!tracks(p).some(t=>t.id==='audio-'+i))return 'audio-'+i;fail('最多建立 '+MAX_TRACKS+' 条音频轨');}
function addTrack(p){return change(p,n=>{const id=nextTrackId(n);n.audioTracks=copy(tracks(n));n.audioTracks.push({id,name:'音频 '+id.split('-').at(-1),muted:false,solo:false,locked:false,gain:1});});}
function setTrack(p,id,patch){keys(patch,['name','muted','solo','locked','gain'],'音轨设置');return change(p,n=>{n.audioTracks=copy(tracks(n));const t=getTrack(n,id);if(!t)fail('音轨不存在');Object.assign(t,copy(patch));});}
function removeTrack(p,id){return change(p,n=>{const t=getTrack(n,id);if(!t)fail('音轨不存在');if(tracks(n).length===1)fail('至少保留一条音频轨');if(t.locked)fail('请先解锁音轨');if(n.clips.some(c=>c.track==='audio'&&trackId(c)===id))fail('先移动或删除轨道上的片段，再移除空轨');n.audioTracks=copy(tracks(n)).filter(t=>t.id!==id);});}
function assignTrack(p,clipIds,id){if(!Array.isArray(clipIds)||!clipIds.length)fail('请选择音频片段');return change(p,n=>{const target=getTrack(n,id);if(!target)fail('目标音轨不存在');if(target.locked)fail('目标音轨已锁定');assertUnlocked(n,clipIds);for(const clipId of clipIds){const c=n.clips.find(c=>c.id===clipId);if(!c||c.track!=='audio')fail('只能移动音频片段到音频轨');c.audioTrackId=id;}});}
function setClip(p,id,patch){keys(patch,['audioMuted','audioEffects'],'片段声音');return change(p,n=>{assertUnlocked(n,[id]);const c=n.clips.find(c=>c.id===id);if(!c)fail('片段不存在');Object.assign(c,copy(patch));});}
function detachAudio(p,clipId,asset,{track:targetId,newId}={}){
 const source=p.clips.find(c=>c.id===clipId),original=p.assets.find(a=>a.id===source?.assetId);if(!source||source.track!=='video'||!original?.hasAudio)fail('请选择包含原声的视频片段');if(!asset||asset.kind!=='audio'||!asset.id)fail('分离后的素材必须为音频');
 return change(p,n=>{const id=targetId||tracks(n).find(t=>!t.locked)?.id;if(!id||!getTrack(n,id)||getTrack(n,id).locked)fail('请先建立或解锁目标音轨');if(n.assets.some(a=>a.id===asset.id))fail('分离素材 ID 重复');n.assets.push(copy(asset));const c={id:newId||'clip-'+(globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)),assetId:asset.id,track:'audio',audioTrackId:id,start:source.start,duration:source.duration,sourceIn:source.sourceIn,speed:source.speed,volume:source.volume};for(const k of ['speedCurve','sourceDuration','audioFade','audioEnvelope','audioEffects'])if(source[k]!==undefined)c[k]=copy(source[k]);if(source.sourceIn+(source.sourceDuration??source.duration*source.speed)>asset.duration+.05)fail('分离声音长度不足以覆盖片段');n.clips.find(c=>c.id===clipId).audioMuted=true;n.clips.push(c);});
}
// Sample peaks/RMS are source measurements; they are not true-peak or LUFS meters.
function dbfs(value){return value>0?20*Math.log10(value):null;}
function processingFilter(c){const f=effects(c),filters=[];validateEffects(f);if(f.denoise>0)filters.push('afftdn=nr='+Number((f.denoise*24).toFixed(3))+':nf=-45:tn=1');if(f.normalize)filters.push('loudnorm=I='+f.targetLufs+':TP=-1.5:LRA=11:linear=false');return filters.join(',');}
return Object.freeze({MAX_TRACKS,LEGACY_TRACK_ID,DEFAULT_EFFECTS,tracks,trackId,getTrack,effects,validateProject,validateEffects,effectiveGain,isLocked,assertUnlocked,usesMaster,addTrack,setTrack,removeTrack,assignTrack,setClip,detachAudio,dbfs,processingFilter});
});
