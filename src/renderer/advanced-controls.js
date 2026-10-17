/* Curve speed and advanced grade controls. Graph edits commit one undo step. */
(() => {
'use strict';
const M=window.EditorModel,A=window.EditorAdvancedColor;
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x)),round=x=>Math.round(x*10000)/10000,copy=x=>JSON.parse(JSON.stringify(x));
const view={channel:'master',band:'red',panels:{tone:true,curves:false,hsl:false}};
const presets={
 custom:{name:'自定义',points:[{position:0,speed:1},{position:1,speed:1}]},
 accelerate:{name:'渐快',points:[{position:0,speed:.5},{position:1,speed:2}]},
 decelerate:{name:'渐慢',points:[{position:0,speed:2},{position:1,speed:.5}]},
 mountain:{name:'先快后慢',points:[{position:0,speed:.5},{position:.25,speed:1.5},{position:.5,speed:3},{position:.75,speed:1.5},{position:1,speed:.5}]},
 valley:{name:'中段慢放',points:[{position:0,speed:2},{position:.35,speed:.5},{position:.65,speed:.5},{position:1,speed:2}]},
 bullet:{name:'瞬间慢放',points:[{position:0,speed:1.8},{position:.3,speed:1.8},{position:.45,speed:.3},{position:.6,speed:.3},{position:.75,speed:1.8},{position:1,speed:1.8}]}
};
const channels={master:'主曲线',red:'红',green:'绿',blue:'蓝'},bands={red:'红',orange:'橙',yellow:'黄',green:'绿',cyan:'青',blue:'蓝',purple:'紫',magenta:'洋红'};
const names={exposureEV:'曝光 / EV',temperature:'色温',tint:'色调',highlights:'高光',shadows:'阴影',whites:'白色色阶',blacks:'黑色色阶'};
function speedAt(points,x){let i=1;while(i<points.length-1&&points[i].position<x)i++;const a=points[i-1],b=points[i];return a.speed+(b.speed-a.speed)*(x-a.position)/(b.position-a.position);}
const xy=(x,y)=>`${12+196*x},${138-126*y}`;
function graph(points,type){
 const speed=type==='speed',values=speed?Array.from({length:97},(_,i)=>{const x=i/96;return [x,(Math.log2(speedAt(points,x))+2)/4];}):points;
 const path=values.map(([x,y],i)=>(i?'L':'M')+xy(x,y)).join(' ');
 const circles=points.map((p,i)=>{const x=speed?p.position:p[0],y=speed?(Math.log2(p.speed)+2)/4:p[1];return `<circle cx="${12+196*x}" cy="${138-126*y}" r="4.5" data-graph-point="${i}"/><title>${round(x*100)}% · ${speed?round(p.speed)+'×':round(y*100)+'%'}</title>`;}).join('');
 return `<svg class="edit-graph ${speed?'speed-graph':'grade-graph channel-'+view.channel}" data-edit-graph="${type}" viewBox="0 0 220 156" role="img" aria-label="${speed?'源素材进度与播放速度曲线':'输入与输出亮度曲线'}"><path class="graph-grid" d="M12 12V138H208M12 75H208M110 12V138M12 12H208"/><path class="graph-identity" d="${speed?'M12 75H208':'M12 138L208 12'}"/><path class="graph-value" d="${path}"/>${circles}<text x="12" y="153">0%</text><text x="181" y="153">100%</text><text x="13" y="10">${speed?'4×':'输出'}</text><text x="14" y="135">${speed?'0.25×':''}</text></svg>`;
}
function speedPreset(points){return Object.keys(presets).find(k=>JSON.stringify(points)===JSON.stringify(presets[k].points))||'custom';}
function speedEditor(c){const points=c.speedCurve;if(!points)return '<p class="field-help">选择预设启用曲线变速；控制点按源素材进度排列。</p>';
 return graph(points,'speed')+`<div class="curve-axis-note"><span>横轴：源素材进度</span><span>源 ${round(M.clipSourceDuration(c))}s → 成片 ${round(c.duration)}s</span></div><div class="point-table"><div class="point-table-heading"><span>源进度 / %</span><span>速度 / 倍</span><span></span></div>${points.map((p,i)=>`<div class="point-row"><input type="number" data-speed-point="${i}" data-point-field="position" value="${round(p.position*100)}" min="0" max="100" step="1" aria-label="速度点${i+1}源进度" ${i===0||i===points.length-1?'disabled':''}><input type="number" data-speed-point="${i}" data-point-field="speed" value="${round(p.speed)}" min=".25" max="4" step=".05" aria-label="速度点${i+1}倍速"><button class="quiet compact" data-speed-remove="${i}" aria-label="删除速度点${i+1}" ${i===0||i===points.length-1?'disabled':''}>×</button></div>`).join('')}</div><button class="quiet compact" data-speed-add ${points.length>=32?'disabled':''}>＋ 添加速度点</button><p class="field-help">拖动圆点或输入数值。速度在源进度上逐段平滑变化；保持原素材区间，自动计算成片时长。关键帧按新片长重定时。</p>`;
}
function renderSpeed(c,a){if(a.kind==='image')return '';return `<section class="inspector-section speed-editor"><h3>曲线变速</h3><label class="field full">速度方式<select data-speed-preset aria-label="曲线变速预设"><option value="none" ${!c.speedCurve?'selected':''}>恒定速度</option>${Object.entries(presets).map(([k,p])=>`<option value="${k}" ${c.speedCurve&&speedPreset(c.speedCurve)===k?'selected':''}>${p.name}</option>`).join('')}</select></label><div data-speed-editor>${speedEditor(c)}</div></section>`;}
function scalar(key,a){const ev=key==='exposureEV',scale=ev?1:100,value=round(a[key]*scale),min=ev?-4:-100,max=ev?4:100,step=ev?.05:1;return `<label class="grade-scalar" data-grade-row="${key}"><span>${names[key]}</span><input type="number" data-grade-scalar="${key}" value="${value}" min="${min}" max="${max}" step="${step}" aria-label="${names[key]}"><input type="range" data-grade-scalar="${key}" value="${value}" min="${min}" max="${max}" step="${step}" aria-label="${names[key]}滑块"></label>`;}
function curveEditor(c){const points=A.normalize(c.advancedColor).curves[view.channel];return `<label class="field full">通道<select data-grade-channel aria-label="调色曲线通道">${Object.entries(channels).map(([k,v])=>`<option value="${k}" ${view.channel===k?'selected':''}>${v}</option>`).join('')}</select></label>${graph(points,'grade')}<div class="curve-axis-note"><span>输入亮度 → 输出亮度</span><button class="quiet compact" data-grade-reset-curve>还原此曲线</button></div><div class="point-table"><div class="point-table-heading"><span>输入 / %</span><span>输出 / %</span><span></span></div>${points.map((p,i)=>`<div class="point-row"><input type="number" data-grade-point="${i}" data-point-field="0" value="${round(p[0]*100)}" min="0" max="100" step="1" aria-label="曲线点${i+1}输入" ${i===0||i===points.length-1?'disabled':''}><input type="number" data-grade-point="${i}" data-point-field="1" value="${round(p[1]*100)}" min="0" max="100" step="1" aria-label="曲线点${i+1}输出"><button class="quiet compact" data-grade-remove="${i}" aria-label="删除调色点${i+1}" ${i===0||i===points.length-1?'disabled':''}>×</button></div>`).join('')}</div><button class="quiet compact" data-grade-add ${points.length>=16?'disabled':''}>＋ 添加曲线点</button><p class="field-help">拖动控制点调整亮度映射，也可在下方输入数值。</p>`;}
function hslEditor(c){const h=A.normalize(c.advancedColor).hsl[view.band];return `<div class="hsl-band-selector" role="group" aria-label="HSL颜色范围">${Object.entries(bands).map(([k,n])=>`<button class="hsl-band ${view.band===k?'active':''}" data-grade-band="${k}" title="${n}" aria-label="${n}色HSL"><span style="background:var(--band-${k})"></span>${n}</button>`).join('')}</div><div class="form-grid">${[['hue','色相 / °',30,.5],['saturation','饱和度',100,1],['luminance','明度',100,1]].map(([k,label,scale,step])=>`<label class="field">${label}<input type="number" data-grade-hsl="${k}" value="${round(h[k]*scale)}" min="${-scale}" max="${scale}" step="${step}" aria-label="${bands[view.band]}色${label}"></label>`).join('')}</div><button class="quiet compact" data-grade-reset-band>还原此色段</button><p class="field-help">选择颜色范围，再调整色相、饱和度和明度。</p>`;}
function renderColor(c){return `<section class="inspector-section advanced-grade"><h3>高级调色<button class="quiet compact" data-grade-reset>全部还原</button></h3><details data-advanced-panel="tone" ${view.panels.tone?'open':''}><summary>曝光、白平衡与光影</summary><div class="grade-tones">${Object.keys(names).map(k=>scalar(k,A.normalize(c.advancedColor))).join('')}</div></details><details data-advanced-panel="curves" ${view.panels.curves?'open':''}><summary>RGB 曲线</summary><div data-grade-curve-editor>${curveEditor(c)}</div></details><details data-advanced-panel="hsl" ${view.panels.hsl?'open':''}><summary>分色 HSL</summary><div data-grade-hsl-editor>${hslEditor(c)}</div></details></section>`;}
function install(host,{getClip,updateClip,reportError}){
 const commit=(patch,message)=>{try{updateClip(patch,message);}catch(e){reportError(e);}},grade=()=>A.normalize(getClip()?.advancedColor);
 host.addEventListener('toggle',e=>{if(e.target.isConnected&&e.target.matches('details[data-advanced-panel]'))view.panels[e.target.dataset.advancedPanel]=e.target.open;},true);
 host.addEventListener('input',e=>{const key=e.target.dataset.gradeScalar;if(key){const row=e.target.closest('[data-grade-row]');row.querySelectorAll('input').forEach(input=>{if(input!==e.target)input.value=e.target.value;});}});
 host.addEventListener('change',e=>{const c=getClip();if(!c)return;const d=e.target.dataset;let handled=true;
  try{
   if(d.speedPreset!==undefined)commit({speedCurve:e.target.value==='none'?null:copy(presets[e.target.value].points)},'已更新曲线变速');
   else if(d.speedPoint!==undefined){const points=copy(c.speedCurve),i=Number(d.speedPoint),field=d.pointField;points[i][field]=Number(e.target.value)/(field==='position'?100:1);commit({speedCurve:points});}
   else if(d.gradeScalar){const a=grade();a[d.gradeScalar]=Number(e.target.value)/(d.gradeScalar==='exposureEV'?1:100);commit({advancedColor:a});}
   else if(d.gradeChannel!==undefined){view.channel=e.target.value;host.querySelector('[data-grade-curve-editor]').innerHTML=curveEditor(c);}
   else if(d.gradePoint!==undefined){const a=grade();a.curves[view.channel][Number(d.gradePoint)][Number(d.pointField)]=Number(e.target.value)/100;commit({advancedColor:a});}
   else if(d.gradeHsl){const a=grade();a.hsl[view.band][d.gradeHsl]=Number(e.target.value)/(d.gradeHsl==='hue'?30:100);commit({advancedColor:a});}
   else handled=false;
  }catch(error){reportError(error);}if(handled)e.stopImmediatePropagation();
 });
 function insert(points,speed){const xof=p=>speed?p.position:p[0];let i=0;for(let j=1;j<points.length-1;j++)if(xof(points[j+1])-xof(points[j])>xof(points[i+1])-xof(points[i]))i=j;const x=(xof(points[i])+xof(points[i+1]))/2;points.splice(i+1,0,speed?{position:x,speed:(points[i].speed+points[i+1].speed)/2}:[x,(points[i][1]+points[i+1][1])/2]);}
 host.addEventListener('click',e=>{const c=getClip(),b=e.target.closest('button');if(!c||!b)return;const d=b.dataset;let handled=true;
  try{
   if(d.speedAdd!==undefined){const points=copy(c.speedCurve);if(points.length<32){insert(points,true);commit({speedCurve:points});}}
   else if(d.speedRemove!==undefined){const points=copy(c.speedCurve),i=Number(d.speedRemove);if(i>0&&i<points.length-1){points.splice(i,1);commit({speedCurve:points});}}
   else if(d.gradeReset!==undefined)commit({advancedColor:A.defaults()},'已还原高级调色');
   else if(d.gradeResetCurve!==undefined){const a=grade();a.curves[view.channel]=[[0,0],[1,1]];commit({advancedColor:a});}
   else if(d.gradeAdd!==undefined){const a=grade(),points=a.curves[view.channel];if(points.length<16){insert(points,false);commit({advancedColor:a});}}
   else if(d.gradeRemove!==undefined){const a=grade(),points=a.curves[view.channel],i=Number(d.gradeRemove);if(i>0&&i<points.length-1){points.splice(i,1);commit({advancedColor:a});}}
   else if(d.gradeBand){view.band=d.gradeBand;host.querySelector('[data-grade-hsl-editor]').innerHTML=hslEditor(c);}
   else if(d.gradeResetBand!==undefined){const a=grade();a.hsl[view.band]={hue:0,saturation:0,luminance:0};commit({advancedColor:a});}
   else handled=false;
  }catch(error){reportError(error);}if(handled)e.stopImmediatePropagation();
 });
 let drag=null;
 host.addEventListener('pointerdown',e=>{const svg=e.target.closest('svg[data-edit-graph]'),point=e.target.closest('[data-graph-point]'),c=getClip();if(!svg||!point||!c||e.button!==0)return;const speed=svg.dataset.editGraph==='speed';drag={svg,speed,id:c.id,index:Number(point.dataset.graphPoint),points:copy(speed?c.speedCurve:grade().curves[view.channel]),pointer:e.pointerId};svg.setPointerCapture(e.pointerId);e.preventDefault();});
 host.addEventListener('pointermove',e=>{if(!drag||e.pointerId!==drag.pointer)return;const {svg,points,index:i,speed}=drag,rect=svg.getBoundingClientRect(),x=clamp(((e.clientX-rect.left)/rect.width*220-12)/196,0,1),y=clamp((138-(e.clientY-rect.top)/rect.height*156)/126,0,1),xof=p=>speed?p.position:p[0];const px=i===0?0:i===points.length-1?1:clamp(x,xof(points[i-1])+.0001,xof(points[i+1])-.0001);if(speed)points[i]={position:round(px),speed:round(2**(y*4-2))};else points[i]=[round(px),round(y)];const holder=document.createElement('div');holder.innerHTML=graph(points,speed?'speed':'grade');svg.innerHTML=holder.firstElementChild.innerHTML;e.preventDefault();});
 host.addEventListener('pointerup',e=>{if(!drag||e.pointerId!==drag.pointer)return;const done=drag;drag=null;done.svg.releasePointerCapture(e.pointerId);if(getClip()?.id!==done.id)return;if(done.speed)commit({speedCurve:done.points});else{const a=grade();a.curves[view.channel]=done.points;commit({advancedColor:a});}});
 host.addEventListener('pointercancel',()=>{drag=null;});
}
window.EditorAdvancedControls=Object.freeze({renderSpeed,renderColor,install,presets});
})();
