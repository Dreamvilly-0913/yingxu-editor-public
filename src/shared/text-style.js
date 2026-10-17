/* Shared Canvas text layout. New styled captions and independent titles use this path in preview and export. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.EditorTextStyle=api;})(typeof window!=='undefined'?window:globalThis,function(){
'use strict';
const clone=v=>JSON.parse(JSON.stringify(v));
const DEFAULTS=Object.freeze({fontFamily:'Microsoft YaHei, Arial, sans-serif',fontSize:48,fontWeight:'normal',italic:false,color:'#ffffff',align:'center',verticalAlign:'bottom',x:.5,y:.95,maxWidth:.88,letterSpacing:0,lineHeight:1.2,backgroundColor:'#000000',backgroundOpacity:0,padding:12,outlineColor:'#000000',outlineWidth:3,shadowColor:'#000000',shadowOpacity:0,shadowBlur:8,shadowX:2,shadowY:3,rotation:0,opacity:1,scale:1});
const ranges={fontSize:[4,2000],x:[-2,3],y:[-2,3],maxWidth:[.01,2],letterSpacing:[-100,300],lineHeight:[.4,5],backgroundOpacity:[0,1],padding:[0,500],outlineWidth:[0,100],shadowOpacity:[0,1],shadowBlur:[0,300],shadowX:[-1000,1000],shadowY:[-1000,1000],rotation:[-3600,3600],opacity:[0,1],scale:[.01,20]};
function fail(s){throw new Error(s);}
function object(v,label){if(!v||typeof v!=='object'||Array.isArray(v))fail(label+'必须是对象');}
function finite(v,label,min,max){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail(label+'超出有效范围 '+min+'–'+max);}
function validateStyle(s,label='文字样式'){
 object(s,label);for(const [k,v]of Object.entries(s)){if(!Object.prototype.hasOwnProperty.call(DEFAULTS,k))fail(label+'不支持字段：'+k);if(ranges[k])finite(v,label+k,...ranges[k]);else if(['color','backgroundColor','outlineColor','shadowColor'].includes(k)){if(typeof v!=='string'||!/^#[0-9a-f]{6}$/i.test(v))fail(label+k+'必须为 #RRGGBB');}else if(k==='fontFamily'){if(typeof v!=='string'||!v.trim()||v.length>200||/[\u0000-\u001f;{}<>]/.test(v))fail('字体名称无效');}else if(k==='fontWeight'){if(!['normal','bold'].includes(v))fail('字重必须为 normal 或 bold');}else if(k==='italic'){if(typeof v!=='boolean')fail('斜体必须为布尔值');}else if(k==='align'){if(!['left','center','right'].includes(v))fail('文字对齐无效');}else if(k==='verticalAlign'){if(!['top','middle','bottom'].includes(v))fail('文字垂直对齐无效');}}
 return s;
}
function normalizeStyle(style={},project={},kind='subtitle'){
 validateStyle(style);const legacy=project.subtitleStyle||{};return Object.assign({},DEFAULTS,{fontSize:legacy.fontSize||48,color:legacy.color||'#ffffff',outlineWidth:(legacy.fontSize||48)/16},kind==='text'?{y:.5,verticalAlign:'middle',fontSize:72,outlineWidth:0}:null,style);
}
function validateCue(cue,label='文字'){
 object(cue,label);if(typeof cue.id!=='string'||!cue.id)fail(label+' ID 无效');finite(cue.start,label+'开始时间',0,8640000);finite(cue.end,label+'结束时间',0,8640000);if(cue.end<=cue.start)fail(label+'结束时间必须晚于开始时间');if(typeof cue.text!=='string'||!cue.text.trim()||cue.text.length>10000||/[\u0000\u000b\u000c]/.test(cue.text))fail(label+'内容为空、过长或包含无效控制字符');if(cue.style!==undefined)validateStyle(cue.style,label+'样式');return cue;
}
function validateProjectText(project,existingIds){
 const ids=existingIds||new Set([project.id,...(project.assets||[]).map(a=>a.id),...(project.clips||[]).map(a=>a.id),...(project.subtitles||[]).map(a=>a.id)]);
 if(project.texts!==undefined&&!Array.isArray(project.texts))fail('独立文字必须是数组');if((project.texts||[]).length>10000)fail('独立文字超过 10000 条');
 for(const c of project.subtitles||[]){if(c.style!==undefined)validateStyle(c.style,'字幕样式');}
 for(const c of project.texts||[]){validateCue(c,'独立文字');if(ids.has(c.id))fail('重复 ID：'+c.id);ids.add(c.id);}return project;
}
function usesCanvas(project){return Boolean((project.texts||[]).length||(project.subtitles||[]).some(c=>c.style!==undefined));}
function active(project,time){return [...(project.subtitles||[]).filter(c=>time>=c.start&&time<c.end).map(c=>({cue:c,kind:'subtitle'})),...(project.texts||[]).filter(c=>time>=c.start&&time<c.end).map(c=>({cue:c,kind:'text'}))];}
const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'grapheme'}):null;
const graphemes=s=>segmenter?Array.from(segmenter.segment(s),v=>v.segment):Array.from(s);
function applyFont(ctx,s){ctx.font=(s.italic?'italic ':'')+s.fontWeight+' '+s.fontSize+'px '+s.fontFamily;ctx.textAlign='left';ctx.textBaseline='alphabetic';if('letterSpacing'in ctx)ctx.letterSpacing=s.letterSpacing+'px';if('fontKerning'in ctx)ctx.fontKerning='normal';}
function measure(ctx,text,s){const width=ctx.measureText(text).width;return width+('letterSpacing'in ctx?0:Math.max(0,graphemes(text).length-1)*s.letterSpacing);}
function layout(ctx,project,cue,kind='subtitle'){
 const s=normalizeStyle(cue.style||{},project,kind);applyFont(ctx,s);const width=project.width*s.maxWidth/s.scale;const lines=[];
 for(const raw of cue.text.replace(/\r\n?/g,'\n').replace(/\t/g,'    ').split('\n')){let line='';for(const g of graphemes(raw)){if(line&&measure(ctx,line+g,s)>width){lines.push(line);line=g;}else line+=g;}lines.push(line);}
 const widths=lines.map(l=>measure(ctx,l,s)),height=lines.length*s.fontSize*s.lineHeight,m=ctx.measureText('国Mg'),ascent=m.fontBoundingBoxAscent||m.actualBoundingBoxAscent||s.fontSize*.8,descent=m.fontBoundingBoxDescent||m.actualBoundingBoxDescent||s.fontSize*.2;
 const top=s.verticalAlign==='top'?0:s.verticalAlign==='middle'?-height/2:-height;
 return {style:s,lines,widths,width:Math.max(0,...widths),height,top,baseline:top+(s.fontSize*s.lineHeight-ascent-descent)/2+ascent};
}
function rgba(hex,a){return 'rgba('+[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16),a].join(',')+')';}
function drawString(ctx,text,x,y,s,stroke){if('letterSpacing'in ctx||s.letterSpacing===0){ctx[stroke?'strokeText':'fillText'](text,x,y);return;}for(const g of graphemes(text)){ctx[stroke?'strokeText':'fillText'](g,x,y);x+=ctx.measureText(g).width+s.letterSpacing;}}
function paintCue(ctx,project,cue,kind='subtitle'){
 ctx.save();try{const l=layout(ctx,project,cue,kind),s=l.style;ctx.translate(s.x*project.width,s.y*project.height);ctx.rotate(s.rotation*Math.PI/180);ctx.scale(s.scale,s.scale);ctx.globalAlpha*=s.opacity;
  const left=s.align==='left'?0:s.align==='right'?-l.width:-l.width/2;
  if(s.backgroundOpacity>0){ctx.fillStyle=rgba(s.backgroundColor,s.backgroundOpacity);ctx.fillRect(left-s.padding,l.top-s.padding,l.width+s.padding*2,l.height+s.padding*2);}
  ctx.lineJoin='round';ctx.miterLimit=2;ctx.lineWidth=s.outlineWidth*2;
  for(let i=0;i<l.lines.length;i++){const text=l.lines[i],x=s.align==='left'?0:s.align==='right'?-l.widths[i]:-l.widths[i]/2,y=l.baseline+i*s.fontSize*s.lineHeight;ctx.shadowColor=rgba(s.shadowColor,s.shadowOpacity);ctx.shadowBlur=s.shadowBlur;ctx.shadowOffsetX=s.shadowX;ctx.shadowOffsetY=s.shadowY;
   if(s.outlineWidth>0){ctx.strokeStyle=s.outlineColor;drawString(ctx,text,x,y,s,true);ctx.shadowColor='transparent';}
   ctx.fillStyle=s.color;drawString(ctx,text,x,y,s,false);
  }return l;
 }finally{ctx.restore();}
}
function paint(ctx,project,time,{clear=true,scale=1}={}){ctx.save();try{ctx.setTransform(1,0,0,1,0,0);if(clear)ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);ctx.scale(scale,scale);for(const entry of active(project,time))paintCue(ctx,project,entry.cue,entry.kind);}finally{ctx.restore();}return ctx.canvas;}
function paintCanvas(canvas,project,time){if(canvas.width!==project.width)canvas.width=project.width;if(canvas.height!==project.height)canvas.height=project.height;return paint(canvas.getContext('2d',{alpha:true,colorSpace:'srgb'}),project,time);}
function mutate(project,fn){const next=clone(project);fn(next);validateProjectText(next);next.updatedAt=new Date().toISOString();return next;}
function addText(project,input){object(input,'独立文字');return mutate(project,p=>{p.texts=p.texts||[];p.texts.push(Object.assign({id:'text-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)},clone(input)));});}
function updateText(project,id,patch){object(patch,'文字更新');for(const k of Object.keys(patch))if(!['start','end','text','style'].includes(k))fail('文字更新不支持字段：'+k);return mutate(project,p=>{const c=(p.texts||[]).find(c=>c.id===id);if(!c)fail('找不到独立文字');Object.assign(c,clone(patch));});}
function removeText(project,id){return mutate(project,p=>{const i=(p.texts||[]).findIndex(c=>c.id===id);if(i<0)fail('找不到独立文字');p.texts.splice(i,1);});}
function applyStyle(project,selection,patch,{replace=false}={}){validateStyle(patch);if(!Array.isArray(selection)||!selection.length)fail('先选择需要套用样式的文字');return mutate(project,p=>{for(const selected of selection){if(!['text','subtitle'].includes(selected.type))fail('样式只能应用于字幕或独立文字');const cue=(selected.type==='text'?p.texts||[]:p.subtitles).find(c=>c.id===selected.id);if(!cue)fail('找不到选中文字');cue.style=Object.assign({},replace?null:cue.style,clone(patch));}});}
function applyProofread(project,rows,kind='subtitle'){if(!['subtitle','text'].includes(kind)||!Array.isArray(rows))fail('校对内容无效');const seen=new Set();return mutate(project,p=>{const target=kind==='text'?p.texts||[]:p.subtitles;for(const row of rows){if(!row||seen.has(row.id))fail('重复或无效的校对 ID');seen.add(row.id);const cue=target.find(c=>c.id===row.id);if(!cue)fail('校对对象已被删除');Object.assign(cue,{start:row.start,end:row.end,text:row.text});validateCue(cue,kind==='text'?'独立文字':'字幕');}});}
function findReplace(project,selection,search,replacement){if(typeof search!=='string'||!search||typeof replacement!=='string')fail('查找内容不能为空');return mutate(project,p=>{for(const selected of selection){const c=(selected.type==='text'?p.texts||[]:p.subtitles).find(c=>c.id===selected.id);if(!c)fail('找不到替换对象');c.text=c.text.split(search).join(replacement);validateCue(c,'文字');}});}
return Object.freeze({DEFAULTS,validateStyle,normalizeStyle,validateCue,validateProjectText,usesCanvas,active,layout,paintCue,paint,paintCanvas,addText,updateText,removeText,applyStyle,applyProofread,findReplace});
});
