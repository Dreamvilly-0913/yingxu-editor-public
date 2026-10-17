/* Standalone adapters for the shared visual algorithms. No ffmpeg process is started by this module. */
'use strict';
const V=require('../shared/visual-effects.js');
const n=x=>Number(x).toFixed(12).replace(/\.?0+$/,'')||'0';
function chromaFilter(effects){V.validate(effects);if(!effects?.chromaKey)return '';const k=Object.assign(V.keyDefaults(),effects.chromaKey);
  const alphaAt=(x='X',y='Y')=>{const rgb=['r','g','b'].map(c=>`${c}(${x},${y})/255`),d=`sqrt(${rgb.map((v,i)=>`pow(${v}-${n(k.color[i])},2)`).join('+')})/sqrt(3)`;return k.softness?`clip((${d}-${n(k.threshold)})/${n(k.softness)},0,1)`:`gt(${d},${n(k.threshold)})`;};
  let alpha=alphaAt();if(k.edgeSoftness>0){const r=n(k.edgeSoftness),terms=[];for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const x=dx?`clip(X${dx<0?'-':'+'}${r},0,W-1)`:'X',y=dy?`clip(Y${dy<0?'-':'+'}${r},0,H-1)`:'Y';terms.push(`${(dx===0?2:1)*(dy===0?2:1)}*(${alphaAt(x,y)})`);}alpha=`(${terms.join('+')})/16`;}
  const dominant=k.color.indexOf(Math.max(...k.color)),other=[0,1,2].filter(i=>i!==dominant),spill=k.color[dominant]-Math.max(k.color[other[0]],k.color[other[1]])>.05;
  const rgb=['r','g','b'].map((c,i)=>`${c}='${i===dominant&&spill?`${c}(X,Y)-max(0,${c}(X,Y)-max(${['r','g','b'][other[0]]}(X,Y),${['r','g','b'][other[1]]}(X,Y)))*${n(k.spill)}*(1-(${alpha}))`:`${c}(X,Y)`}'`).join(':');
  return `,format=gbrap,geq=${rgb}:a='alpha(X,Y)*(${alpha})':interpolation=bilinear`;
}
function easingExpression(type,x){if(type==='hold')return `gte(${x},1)`;if(type==='ease-in')return `pow(${x},2)`;if(type==='ease-out')return `(1-pow(1-(${x}),2))`;if(type==='ease-in-out')return `if(lt(${x},0.5),2*pow(${x},2),1-2*pow(1-(${x}),2))`;return `(${x})`;}
function maskValueExpression(base,animation,key,time='T'){
  const frames=animation?.keyframes;if(!frames?.length)return n(V.maskDefaults(base)[key]);let result=n(frames.at(-1)[key]);
  for(let i=frames.length-1;i>=1;i--){const a=frames[i-1],b=frames[i],raw=`clip(((${time})-${n(a.time)})/${n(b.time-a.time)},0,1)`,window=b.easingWindow||[0,1];let t=raw;
    if(b.easing==='hold')t=`gte(${raw},1)`;else if(b.easing&&b.easing!=='linear'){const fa=easingExpression(b.easing,n(window[0])),fb=easingExpression(b.easing,n(window[1])),mapped=`(${n(window[0])}+${n(window[1]-window[0])}*(${raw}))`;t=`((${easingExpression(b.easing,mapped)})-(${fa}))/((${fb})-(${fa}))`;}
    result=`if(lte(${time},${n(b.time)}),${n(a[key])}+${n(b[key]-a[key])}*(${t}),${result})`;
  }return `if(lte(${time},${n(frames[0].time)}),${n(frames[0][key])},${result})`;
}
function maskFilter(clip,{timeOffset=0,timeExpression='T'}={}){if(!clip.mask)return '';const m=V.maskDefaults(clip.mask),time=`(${timeExpression}+${n(timeOffset)})`,value=k=>maskValueExpression(m,clip.maskAnimation,k,time),angle=`(${value('rotation')}*PI/180)`;
  const setup=`st(0,X+0.5-(${value('centerX')})*W);st(1,Y+0.5-(${value('centerY')})*H);st(2,ld(0)*cos(${angle})+ld(1)*sin(${angle}));st(3,-ld(0)*sin(${angle})+ld(1)*cos(${angle}));st(4,(${value('width')})*W/2);st(5,(${value('height')})*H/2);`;
  const radius=`(${value('roundness')})*min(ld(4),ld(5))`,distance=m.type==='ellipse'?`(hypot(ld(2)/ld(4),ld(3)/ld(5))-1)*min(ld(4),ld(5))`:`st(6,abs(ld(2))-(ld(4)-(${radius})));st(7,abs(ld(3))-(ld(5)-(${radius})));hypot(max(ld(6),0),max(ld(7),0))+min(max(ld(6),ld(7)),0)-(${radius})`;
  const feather=value('feather'),expansion=value('expansion'),edge=`if(gt(${feather},0),st(9,clip(0.5+ld(8)/((${feather})*min(W,H)),0,1));1-ld(9)*ld(9)*(3-2*ld(9)),lte(ld(8),0))`,alpha=`${setup}st(8,(${distance})-(${expansion})*min(W,H));st(9,${edge});alpha(X,Y)*(${m.invert?'1-':''}ld(9))`;
  return `,format=gbrap,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}':interpolation=bilinear`;
}
// A bounded cache keeps static/high-resolution mask coverage out of the per-frame hot path.
function createMaskRasterCache({maxBytes=64*1024*1024}={}){const entries=new Map();let bytes=0,hits=0,misses=0;return {raster(mask,width,height){if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>67108864)throw new Error('蒙版尺寸无效');const key=JSON.stringify([width,height,V.maskDefaults(mask)]);if(entries.has(key)){hits++;const data=entries.get(key);entries.delete(key);entries.set(key,data);return data;}misses++;const data=Buffer.allocUnsafe(width*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++)data[y*width+x]=Math.round(V.maskAlpha(mask,x+.5,y+.5,width,height)*255);if(data.length<=maxBytes){while(bytes+data.length>maxBytes&&entries.size){const oldest=entries.keys().next().value;bytes-=entries.get(oldest).length;entries.delete(oldest);}entries.set(key,data);bytes+=data.length;}return data;},stats(){return {bytes,entries:entries.size,hits,misses};},clear(){entries.clear();bytes=0;}};}

function blendExpression(mode){switch(mode){case 'normal':return 'B';case 'multiply':return 'A*B/255';case 'screen':return '255-(255-A)*(255-B)/255';case 'overlay':return 'if(lte(A,127.5),2*A*B/255,255-2*(255-A)*(255-B)/255)';case 'darken':return 'min(A,B)';case 'lighten':return 'max(A,B)';case 'difference':return 'abs(A-B)';case 'exclusion':return 'A+B-2*A*B/255';case 'hard-light':return 'if(lte(B,127.5),2*A*B/255,255-2*(255-A)*(255-B)/255)';case 'soft-light':return 'if(lte(B,127.5),A-(1-2*B/255)*A*(1-A/255),A+(2*B/255-1)*(if(lte(A,63.75),((16*A/255-12)*A/255+4)*A,255*sqrt(A/255))-A))';case 'color-dodge':return 'if(lte(A,0),0,if(gte(B,255),255,min(255,A*255/(255-B))))';case 'color-burn':return 'if(gte(A,255),255,if(lte(B,0),0,255-min(255,(255-A)*255/B)))';default:throw new Error('不支持的混合模式');}}
// The project starts on opaque black, so every accumulated backdrop is opaque.
// Build a transparent full-duration foreground first: framesync must not delay the
// backdrop until a nonzero clip start, nor hold its last alpha past the clip end.
// Blend unassociated RGB, then mask only the blend result by the layer alpha once.
function blendCompositeFilters({index,mode,width,height,fps,duration,start,end}){
  const p=`vb${index}`,expression=blendExpression(mode),enable=`gte(t,${n(start)})*lt(t,${n(end)})`;
  return [`color=c=black@0:s=${width}x${height}:r=${n(fps)}:d=${n(duration)},format=rgba[${p}clear]`,
    `[${p}clear][layer${index}]overlay=0:0:alpha=straight:format=auto:eof_action=pass:repeatlast=0:enable='${enable}'[${p}full]`,
    `[${p}full]split=2[${p}fronta][${p}alpha]`,
    `[${p}fronta]format=gbrp[${p}front]`,
    `[${p}alpha]alphaextract[${p}mask]`,
    `[base${index}]format=gbrp,split=2[${p}back][${p}original]`,
    `[${p}back][${p}front]blend=all_expr='${expression}':shortest=1[${p}rgb]`,
    `[${p}original][${p}rgb][${p}mask]maskedmerge=planes=7[base${index+1}]`];
}
module.exports={chromaFilter,maskFilter,maskValueExpression,createMaskRasterCache,blendExpression,blendCompositeFilters};

