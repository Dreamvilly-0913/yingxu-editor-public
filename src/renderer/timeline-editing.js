/* Pointer timeline editing. Drafts remain outside the immutable project until pointerup. */
(function(root){
'use strict';
function snapTime(value,targets,threshold){let time=value,distance=threshold+1,target=null;for(const t of targets){const d=Math.abs(t-value);if(d<=threshold&&d<distance){time=t;distance=d;target=t;}}return {time,target};}
function install(api){
 const host=document.getElementById('timelineContent'),scroll=document.getElementById('timelineScroll'),M=root.EditorModel;
 let clipboard=null,snapEnabled=true,gesture=null,ignoreClickUntil=0,frame=0;
 host.tabIndex=0;
 const expand=values=>M.expandGroups?M.expandGroups(api.getProject(),values):values;
 const current=()=>expand(api.getSelection().filter(x=>['clip','subtitle','text'].includes(x.type)));
 const allItems=p=>[...p.clips.map(c=>({type:'clip',id:c.id})),...p.subtitles.map(c=>({type:'subtitle',id:c.id})),...(p.texts||[]).map(c=>({type:'text',id:c.id}))];
 const key=x=>x.type+':'+x.id;
 const item=(p,s)=>(s.type==='clip'?p.clips:s.type==='text'?p.texts||[]:p.subtitles).find(x=>x.id===s.id);
 const layer=c=>c.layer||0;
 const locked=()=>api.isLocked()||Boolean(document.querySelector('dialog[open]'));
 const selectedFrom=element=>{for(const [type,attribute]of [['clip','clipId'],['subtitle','subtitleId'],['text','textId']]){const node=element?.closest('[data-'+type+'-id]');if(node)return{type,id:node.dataset[attribute]};}return null;};
 function refresh(){
  const selections=current(),ids=new Set(selections.map(key));
  for(const el of host.querySelectorAll('.clip')){const s=selectedFrom(el);el.classList.toggle('selected',!!s&&ids.has(key(s)));}
  const copy=document.getElementById('copyTimeline'),paste=document.getElementById('pasteTimeline'),snap=document.getElementById('toggleSnap'),magnetic=document.getElementById('toggleMagnetic'),summary=document.getElementById('selectionSummary');
  if(copy)copy.disabled=locked()||!selections.length;
  if(paste)paste.disabled=locked()||!clipboard;
  if(snap){snap.disabled=locked();snap.setAttribute('aria-pressed',String(snapEnabled));snap.title='吸附播放头与片段边缘 · 按住 Alt 暂停吸附';}
  if(magnetic){magnetic.disabled=locked();magnetic.setAttribute('aria-pressed',String(M.isMagneticMain?M.isMagneticMain(api.getProject()):api.getProject().magneticMain!==false));}
  if(summary)summary.textContent=selections.length?`已选 ${selections.length} 项`:'Shift / Ctrl 多选 · 拖空白处框选';
 }
 function copy(){if(locked()||!current().length)return;try{clipboard=M.copyItems(api.getProject(),current());api.notify(`已复制 ${current().length} 项，在播放头处粘贴`);refresh();}catch(e){api.reportError(e);}}
 function paste(){if(locked()||!clipboard)return;let selection=[];const at=Math.round(api.getTime()*api.getProject().fps)/api.getProject().fps;if(api.commit(p=>{const result=M.pasteItems(p,clipboard,at);selection=result.selection;return result.project;},'已在播放头处粘贴'))api.setSelection(selection);refresh();}
 function selectAll(){if(locked())return;const p=api.getProject();api.setSelection(allItems(p));}
 function point(event){const r=host.getBoundingClientRect();return{x:event.clientX-r.left,y:event.clientY-r.top};}
 function bounds(p,s){const x=item(p,s);return x?{start:x.start,end:s.type==='clip'?x.start+x.duration:x.end}:null;}
 function targets(p,selection){const exclude=new Set(selection.map(key)),out=[0,api.getTime()];for(const s of allItems(p))if(!exclude.has(key(s))){const b=bounds(p,s);out.push(b.start,b.end);}return out;}
 function nodeFor(s){const attribute=s.type+'Id';return [...host.querySelectorAll('[data-'+s.type+'-id]')].find(el=>el.dataset[attribute]===s.id);}
 function overlay(className){const el=document.createElement('div');el.className=className;el.setAttribute('aria-hidden','true');host.appendChild(el);return el;}
 function cleanup(){cancelAnimationFrame(frame);frame=0;for(const el of host.querySelectorAll('.timeline-draft,.timeline-snap-line,.timeline-drag-label,.timeline-marquee'))el.remove();for(const el of host.querySelectorAll('.drag-source'))el.classList.remove('drag-source');document.body.classList.remove('timeline-gesturing','timeline-trimming');}
 function cancel(restore=false){const g=gesture;gesture=null;cleanup();if(restore&&g&&api.getProject()===g.project)api.setSelection(g.previousSelection);refresh();}
 function candidate(g,event){
  const p=g.project,z=api.getZoom(),now=point(event),isMain=g.selection.some(s=>s.type==='clip'&&item(p,s).track==='video'&&!layer(item(p,s))),hasOther=g.selection.some(s=>s.type!=='clip'||item(p,s).track!=='video'||layer(item(p,s)));
  const canSnap=snapEnabled&&!event.altKey,allTargets=targets(p,g.selection);let hint=null;
  if(g.kind==='trim'){
   const c=item(p,g.selection[0]);let t=Math.max(0,Math.round((g.edgeTime+(now.x-g.start.x)/z)*p.fps)/p.fps);
   if(canSnap){const result=snapTime(t,allTargets,8/z);t=result.time;hint=result.target;}
   if(g.primary.type==='clip')return{project:M.trimClip(p,c.id,{edge:g.edge,time:t}),hint};
   const update=g.primary.type==='text'?M.updateText:M.updateSubtitle,minLength=1/p.fps;const patch=g.edge==='start'?{start:Math.min(t,c.end-minLength)}:{end:Math.max(t,c.start+minLength)};return{project:update(p,c.id,patch),hint};
  }
  if(isMain&&hasOther&&(M.isMagneticMain?M.isMagneticMain(p):p.magneticMain!==false))throw new Error('跨轨多选移动请先关闭“主轨磁吸”，以保留相对时间。');
  const starts=g.selection.map(s=>bounds(p,s).start),earliest=Math.min(...starts);
  let delta=Math.round((earliest+(now.x-g.start.x)/z)*p.fps)/p.fps-earliest;delta=Math.max(-earliest,delta);
  if(canSnap){let best=8/z+1;for(const s of g.selection){const b=bounds(p,s);for(const anchor of [b.start,b.end]){const result=snapTime(anchor+delta,allTargets,8/z);const d=Math.abs(result.time-anchor-delta);if(result.target!==null&&d<best&&delta+result.time-anchor-delta>=-earliest-1e-8){best=d;hint=result.target;g.snapDelta=result.time-anchor;}}}if(hint!==null)delta=g.snapDelta;}
  const selectionClips=g.selection.filter(s=>s.type==='clip'),primary=item(p,g.primary),track=document.elementFromPoint(event.clientX,event.clientY)?.closest('.track');let options={};
  if(!track||!host.contains(track))throw new Error('请把片段放到时间线的有效轨道内。');
  if(track&&selectionClips.length===g.selection.length&&selectionClips.every(s=>item(p,s).track==='video'&&layer(item(p,s))===layer(primary))&&track.dataset.track==='video')options.layer=Number(track.dataset.layer)||0;
  const expected=g.primary.type==='clip'?primary.track:g.primary.type;if(track.dataset.track!==expected)throw new Error('请放到对应类型的时间轨。');
   if(expected==='audio'){const defaultTrack=M.defaultAudioTrackId?.(p)||root.EditorAudioModel?.tracks(p)[0]?.id,originalTrack=c=>c.audioTrackId||defaultTrack,audioTrackId=track.dataset.audioTrackId||defaultTrack,sourceTracks=new Set(selectionClips.map(s=>item(p,s)).filter(c=>c.track==='audio').map(originalTrack));if(sourceTracks.size>1){if(audioTrackId!==originalTrack(primary))throw new Error('跨音轨编组保持原轨；请按单轨选择后移轨');}else if(audioTrackId)options.audioTrackId=audioTrackId;}
  let next=selectionClips.length?M.moveClips(p,selectionClips.map(s=>s.id),delta,options):p;
  for(const s of g.selection.filter(s=>s.type==='subtitle'||s.type==='text')){const cue=item(p,s),update=s.type==='text'?M.updateText:M.updateSubtitle;next=update(next,s.id,{start:Math.max(0,cue.start+delta),end:cue.end+delta});}
  return{project:next,hint};
 }
 function paint(g){
  if(!g.started)return;
  for(const el of host.querySelectorAll('.timeline-draft,.timeline-snap-line,.timeline-drag-label,.timeline-marquee'))el.remove();
  const now=point(g.event);
  if(g.kind==='marquee'){
   const r=overlay('timeline-marquee');Object.assign(r.style,{left:Math.min(g.start.x,now.x)+'px',top:Math.min(g.start.y,now.y)+'px',width:Math.abs(now.x-g.start.x)+'px',height:Math.abs(now.y-g.start.y)+'px'});return;
  }
  g.error=null;g.next=null;let result;try{result=candidate(g,g.event);g.next=result.project;}catch(e){g.error=e;}
  for(const s of g.selection){const el=nodeFor(s);if(!el)continue;el.classList.add('drag-source');const b=bounds(g.next||g.project,s),r=overlay('timeline-draft'+(g.error?' invalid':''));let top=el.offsetTop;const c=item(g.next||g.project,s);let targetTrack=s.type==='text'?document.getElementById('textTrack'):s.type==='subtitle'?document.getElementById('subtitleTrack'):c.track==='audio'?[...host.querySelectorAll('.track[data-track=audio]')].find(t=>t.dataset.audioTrackId===(c.audioTrackId||M.defaultAudioTrackId?.(g.next||g.project)||root.EditorAudioModel?.tracks(g.next||g.project)[0]?.id)):document.getElementById(layer(c)?'videoTrack'+layer(c):'videoTrack');if(!targetTrack)targetTrack=el.parentElement;top+=targetTrack.offsetTop;Object.assign(r.style,{left:b.start*api.getZoom()+'px',top:top+'px',width:Math.max(6,(b.end-b.start)*api.getZoom())+'px',height:el.offsetHeight+'px'});}
  if(result?.hint!==null&&result?.hint!==undefined){const line=overlay('timeline-snap-line');line.style.left=result.hint*api.getZoom()+'px';}
  const label=overlay('timeline-drag-label'),b=bounds(g.next||g.project,g.primary);label.textContent=g.error?.message||(g.kind==='trim'?`${g.edge==='start'?'入点':'出点'} ${b.start.toFixed(3)} → ${b.end.toFixed(3)}s · ${(b.end-b.start).toFixed(3)}s`:`移动至 ${b.start.toFixed(3)}s · ${g.selection.length} 项`);Object.assign(label.style,{left:Math.max(scroll.scrollLeft+8,Math.min(now.x+12,scroll.scrollLeft+scroll.clientWidth-350))+'px',top:Math.max(4,now.y-34)+'px'});
 }
 function autoScroll(){if(!gesture?.started)return;const r=scroll.getBoundingClientRect(),x=gesture.event.clientX;let change=x<r.left+26?-12:x>r.right-26?12:0;if(change){const before=scroll.scrollLeft;scroll.scrollLeft+=change;if(before!==scroll.scrollLeft)paint(gesture);}frame=requestAnimationFrame(autoScroll);}
 host.addEventListener('dragstart',event=>{if(selectedFrom(event.target))event.preventDefault();});
 host.addEventListener('pointerdown',event=>{
  if(event.button!==0||locked()||event.target.closest('#timelineRuler,#playhead'))return;
  const s=selectedFrom(event.target),track=event.target.closest('.track');if(!s&&!track)return;
  event.preventDefault();api.pause();host.focus({preventScroll:true});
  const previous=current(),additive=event.ctrlKey||event.metaKey||event.shiftKey;
  let selection=previous;
  if(s){const group=expand([s]),groupKeys=new Set(group.map(key)),exists=group.every(m=>previous.some(x=>key(x)===key(m)));selection=additive?(exists?previous.filter(x=>!groupKeys.has(key(x))):expand([...previous,...group])):exists?previous:group;api.setSelection(selection);}
  const edge=event.target.closest('[data-trim-edge]')?.dataset.trimEdge;
  if(edge&&s){selection=[s];api.setSelection(selection);}
  gesture={project:api.getProject(),previousSelection:previous,selection,primary:s,kind:s?(edge?'trim':'move'):'marquee',edge,edgeTime:edge&&s?(edge==='start'?bounds(api.getProject(),s).start:bounds(api.getProject(),s).end):null,start:point(event),clientStart:{x:event.clientX,y:event.clientY},event,additive,started:false,noDrag:!!s&&!selection.some(x=>key(x)===key(s)),collapseOnClick:!!s&&!additive};
  try{host.setPointerCapture(event.pointerId);}catch{}
 });
 window.addEventListener('pointermove',event=>{const g=gesture;if(!g||g.noDrag)return;g.event=event;if(api.getProject()!==g.project||locked()){cancel();return;}if(!g.started&&Math.hypot(event.clientX-g.clientStart.x,event.clientY-g.clientStart.y)>=4){g.started=true;document.body.classList.add('timeline-gesturing');if(g.kind==='trim')document.body.classList.add('timeline-trimming');frame=requestAnimationFrame(autoScroll);}if(g.started)paint(g);});
 window.addEventListener('pointerup',event=>{const g=gesture;if(!g)return;g.event=event;ignoreClickUntil=Date.now()+350;if(api.getProject()!==g.project||locked()){cancel();return;}if(g.started){if(g.kind==='marquee'){const a=g.clientStart,b={x:event.clientX,y:event.clientY},x1=Math.min(a.x,b.x),x2=Math.max(a.x,b.x),y1=Math.min(a.y,b.y),y2=Math.max(a.y,b.y),found=[];for(const el of host.querySelectorAll('.clip')){const r=el.getBoundingClientRect();if(r.left<x2&&r.right>x1&&r.top<y2&&r.bottom>y1){const selected=selectedFrom(el);if(selected)found.push(selected);}}const values=g.additive?[...g.previousSelection,...found]:found;api.setSelection(expand([...new Map(values.map(s=>[key(s),s])).values()]));}else{paint(g);if(g.error)api.reportError(g.error);else if(g.next)api.commit(()=>g.next,g.kind==='trim'?'已修剪片段':'已移动选中项');}}else if(g.primary){if(g.collapseOnClick)api.setSelection(expand([g.primary]));const b=bounds(g.project,g.primary);if(!g.noDrag&&(api.getTime()<b.start||api.getTime()>=b.end))api.seek(b.start);}else{if(!g.additive)api.setSelection([]);api.seek(Math.max(0,point(event).x/api.getZoom()));}gesture=null;cleanup();refresh();});
 host.addEventListener('click',event=>{if(Date.now()<ignoreClickUntil){event.preventDefault();return;}const s=selectedFrom(event.target);if(s&&!locked()){api.setSelection(expand([s]));const b=bounds(api.getProject(),s);if(api.getTime()<b.start||api.getTime()>=b.end)api.seek(b.start);}});
 window.addEventListener('pointercancel',()=>cancel(true));window.addEventListener('blur',()=>{if(gesture)cancel(true);});
 window.addEventListener('keydown',event=>{if(event.key==='Escape'&&gesture){event.preventDefault();cancel(true);}});
 document.getElementById('copyTimeline').onclick=copy;document.getElementById('pasteTimeline').onclick=paste;
 document.getElementById('toggleSnap').onclick=()=>{if(!locked()){snapEnabled=!snapEnabled;refresh();}};
 document.getElementById('toggleMagnetic').onclick=()=>{if(locked())return;const enabled=!(M.isMagneticMain?M.isMagneticMain(api.getProject()):api.getProject().magneticMain!==false);api.commit(p=>M.setMagneticMain(p,enabled),enabled?'主轨磁吸已开启':'主轨磁吸已关闭，可自由保留空隙');refresh();};
 refresh();return{refresh,copy,paste,selectAll,cancel,hasClipboard:()=>!!clipboard,get snapEnabled(){return snapEnabled;}};
}
root.EditorTimelineEditing={install,snapTime};
})(typeof window!=='undefined'?window:globalThis);
