/* Independent SDR chroma key, straight-alpha blend and signed-distance mask animation. */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.EditorVisualEffects=api;})(typeof window!=='undefined'?window:globalThis,function(){
'use strict';
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x)),copy=x=>JSON.parse(JSON.stringify(x));
const BLEND_MODES=Object.freeze(['normal','multiply','screen','overlay','darken','lighten','difference','exclusion','hard-light','soft-light','color-dodge','color-burn']);
const MASK_KEYS=Object.freeze(['centerX','centerY','width','height','rotation','feather','expansion','roundness']);
const EASINGS=Object.freeze(['linear','ease-in','ease-out','ease-in-out','hold']);
function object(v,label){if(!v||typeof v!=='object'||Array.isArray(v))throw new Error(label+'必须是对象');}
function allowed(v,keys,label){for(const key of Object.keys(v))if(!keys.includes(key))throw new Error(label+'包含未知字段：'+key);}
function num(v,lo,hi,label){if(typeof v!=='number'||!Number.isFinite(v)||v<lo||v>hi)throw new Error(label+'超出范围');}
function keyDefaults(){return {color:[0,1,0],threshold:.18,softness:.12,spill:.6,edgeSoftness:0};}
function validateKey(input){object(input,'色度抠像');allowed(input,['color','threshold','softness','spill','edgeSoftness'],'色度抠像');if(input.color!==undefined){if(!Array.isArray(input.color)||input.color.length!==3)throw new Error('抠像颜色必须是 RGB');input.color.forEach(v=>num(v,0,1,'抠像颜色'));}for(const key of ['threshold','softness','spill'])if(input[key]!==undefined)num(input[key],0,1,key);if(input.edgeSoftness!==undefined){num(input.edgeSoftness,0,4,'抠像边缘柔化');if(!Number.isInteger(input.edgeSoftness))throw new Error('抠像边缘柔化必须是 0 至 4 的整数像素');}return true;}
function validate(input){if(input===undefined)return true;object(input,'视觉效果');allowed(input,['chromaKey','blendMode'],'视觉效果');if(input.chromaKey!==undefined)validateKey(input.chromaKey);if(input.blendMode!==undefined&&!BLEND_MODES.includes(input.blendMode))throw new Error('不支持的混合模式');return true;}
function normalize(input){validate(input);const out={blendMode:input?.blendMode||'normal'};if(input?.chromaKey)out.chromaKey=Object.assign(keyDefaults(),copy(input.chromaKey));return out;}
// Chroma distance is normalized Euclidean distance in encoded display RGB. No source color tags are ignored here.
function keyAlpha(rgb,key){const k=Object.assign(keyDefaults(),key),d=Math.hypot(rgb[0]-k.color[0],rgb[1]-k.color[1],rgb[2]-k.color[2])/Math.sqrt(3);return k.softness>0?clamp((d-k.threshold)/k.softness):(d>k.threshold?1:0);}
function keyPixel(rgba,input,coverage){if(!input)return rgba.slice();const k=Object.assign(keyDefaults(),input),alpha=coverage===undefined?keyAlpha(rgba,k):coverage,rgb=rgba.slice(0,3),channel=k.color.indexOf(Math.max(...k.color));
  // Neutral keys have no dominant colored spill. De-spill is limited to the removed/partly removed edge.
  const other=[0,1,2].filter(i=>i!==channel),excess=Math.max(0,rgb[channel]-Math.max(rgb[other[0]],rgb[other[1]]));
  if(k.color[channel]-Math.max(k.color[other[0]],k.color[other[1]])>.05)rgb[channel]-=excess*k.spill*(1-alpha);
  return rgb.concat(clamp((rgba[3]===undefined?1:rgba[3])*alpha));
}
function processRgba(input,width,height,key){validateKey(key);if(input.length!==width*height*4)throw new Error('抠像像素尺寸不一致');const k=Object.assign(keyDefaults(),key),out=new Uint8ClampedArray(input.length),alpha=new Float32Array(width*height);
  for(let i=0;i<alpha.length;i++)alpha[i]=keyAlpha([input[i*4]/255,input[i*4+1]/255,input[i*4+2]/255],k);
  const sample=(x,y)=>alpha[clamp(Math.round(y),0,height-1)*width+clamp(Math.round(x),0,width-1)];
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*width+x;let a=alpha[i];if(k.edgeSoftness>0){a=0;const radius=k.edgeSoftness;for(let j=-1;j<=1;j++)for(let l=-1;l<=1;l++)a+=sample(x+l*radius,y+j*radius)*(j===0?2:1)*(l===0?2:1)/16;}
    const rgba=keyPixel([input[i*4]/255,input[i*4+1]/255,input[i*4+2]/255,input[i*4+3]/255],k,a);for(let c=0;c<4;c++)out[i*4+c]=Math.round(clamp(rgba[c])*255);}
  return out;
}
function blendChannel(back,front,mode){switch(mode){case 'normal':return front;case 'multiply':return back*front;case 'screen':return back+front-back*front;case 'overlay':return back<=.5?2*back*front:1-2*(1-back)*(1-front);case 'darken':return Math.min(back,front);case 'lighten':return Math.max(back,front);case 'difference':return Math.abs(back-front);case 'exclusion':return back+front-2*back*front;case 'hard-light':return front<=.5?2*back*front:1-2*(1-back)*(1-front);case 'soft-light':{const d=back<=.25?((16*back-12)*back+4)*back:Math.sqrt(back);return front<=.5?back-(1-2*front)*back*(1-back):back+(2*front-1)*(d-back);}case 'color-dodge':return back===0?0:front>=1?1:Math.min(1,back/(1-front));case 'color-burn':return back===1?1:front<=0?0:1-Math.min(1,(1-back)/front);default:throw new Error('不支持的混合模式');}}
// W3C source-over: inputs/outputs are straight RGBA. Convert once to premultiplied energy, divide only at the end.
function blendRgba(back,front,mode='normal',opacity=1){if(!BLEND_MODES.includes(mode))throw new Error('不支持的混合模式');const ba=clamp(back[3]===undefined?1:back[3]),fa=clamp((front[3]===undefined?1:front[3])*opacity),a=fa+ba*(1-fa);if(a===0)return [0,0,0,0];return [0,1,2].map(k=>clamp(((1-fa)*ba*back[k]+(1-ba)*fa*front[k]+ba*fa*blendChannel(back[k],front[k],mode))/a)).concat(a);}
function canvasBlend(mode){if(!BLEND_MODES.includes(mode))throw new Error('不支持的混合模式');return mode==='normal'?'source-over':mode;}
function validateMaskExtension(mask){if(!mask)return true;if(mask.expansion!==undefined)num(mask.expansion,-2,2,'蒙版扩张');if(mask.roundness!==undefined)num(mask.roundness,0,1,'蒙版圆角');return true;}
function validateAnimation(animation,duration=86400){if(animation===undefined)return true;object(animation,'蒙版动画');allowed(animation,['keyframes'],'蒙版动画');if(!Array.isArray(animation.keyframes)||animation.keyframes.length<1||animation.keyframes.length>128)throw new Error('蒙版动画需要 1 至 128 个关键帧');let last=-1;for(const f of animation.keyframes){object(f,'蒙版关键帧');allowed(f,['time','easing','easingWindow'].concat(MASK_KEYS),'蒙版关键帧');num(f.time,0,duration,'蒙版关键帧时间');if(f.time<=last)throw new Error('蒙版关键帧时间必须严格递增');last=f.time;for(const key of MASK_KEYS){if(f[key]===undefined)throw new Error('蒙版关键帧缺少 '+key);const range=key==='rotation'?[-3600,3600]:key==='width'||key==='height'?[.01,4]:key==='centerX'||key==='centerY'?[-2,3]:key==='expansion'?[-2,2]:[0,1];num(f[key],...range,'蒙版 '+key);}if(f.easing!==undefined&&!EASINGS.includes(f.easing))throw new Error('不支持的蒙版缓动');if(f.easingWindow!==undefined){if(!Array.isArray(f.easingWindow)||f.easingWindow.length!==2)throw new Error('蒙版缓动窗口无效');f.easingWindow.forEach(v=>num(v,0,1,'蒙版缓动窗口'));if(f.easingWindow[0]>=f.easingWindow[1])throw new Error('蒙版缓动窗口必须递增');}}return true;}
function eased(type,t){if(type==='hold')return t===1?1:0;if(type==='ease-in')return t*t;if(type==='ease-out')return 1-(1-t)*(1-t);if(type==='ease-in-out')return t<.5?2*t*t:1-2*(1-t)*(1-t);return t;}
function progress(frame,t){if(frame.easing==='hold')return t===1?1:0;const [a,b]=frame.easingWindow||[0,1],fa=eased(frame.easing,a),fb=eased(frame.easing,b);return Math.abs(fb-fa)>1e-14?(eased(frame.easing,a+(b-a)*t)-fa)/(fb-fa):t;}
function maskDefaults(base){return Object.assign({type:'rectangle',centerX:.5,centerY:.5,width:1,height:1,rotation:0,feather:0,invert:false,expansion:0,roundness:0},base);}
function evaluateMask(base,animation,time){if(!base)return undefined;const out=maskDefaults(base),frames=animation?.keyframes;if(!frames?.length)return out;if(time<=frames[0].time)return Object.assign(out,...[Object.fromEntries(MASK_KEYS.map(k=>[k,frames[0][k]]))]);let i=1;while(i<frames.length&&time>frames[i].time)i++;if(i>=frames.length)return Object.assign(out,Object.fromEntries(MASK_KEYS.map(k=>[k,frames.at(-1)[k]])));const a=frames[i-1],b=frames[i],t=progress(b,clamp((time-a.time)/(b.time-a.time)));for(const key of MASK_KEYS)out[key]=a[key]+(b[key]-a[key])*t;return out;}
function maskAlpha(input,x,y,width,height){if(!input)return 1;const m=maskDefaults(input),angle=m.rotation*Math.PI/180,dx=x-m.centerX*width,dy=y-m.centerY*height,px=dx*Math.cos(angle)+dy*Math.sin(angle),py=-dx*Math.sin(angle)+dy*Math.cos(angle),rx=m.width*width/2,ry=m.height*height/2,radius=m.roundness*Math.min(rx,ry);let distance;
  if(m.type==='ellipse')distance=(Math.hypot(px/rx,py/ry)-1)*Math.min(rx,ry);
  else{const qx=Math.abs(px)-(rx-radius),qy=Math.abs(py)-(ry-radius);distance=Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-radius;}
  distance-=m.expansion*Math.min(width,height);const band=m.feather*Math.min(width,height),t=band>0?clamp(.5+distance/band):(distance<=0?0:1),alpha=1-t*t*(3-2*t);return m.invert?1-alpha:alpha;
}
// Crops preserve the original easing interval; extension holds the endpoint mask.
function sliceAnimation(base,animation,start,end){if(!animation)return undefined;const frames=animation.keyframes,at=t=>Object.assign({time:t-start},Object.fromEntries(MASK_KEYS.map(k=>[k,evaluateMask(base,animation,t)[k]]))),out=[at(start)];for(const frame of frames)if(frame.time>start&&frame.time<end)out.push(Object.assign(copy(frame),{time:frame.time-start}));out.push(at(end));
  for(let i=1;i<out.length;i++){const x=start+out[i-1].time,y=start+out[i].time;let j=1;while(j<frames.length&&frames[j].time<x+1e-9)j++;if(j>=frames.length||y<=frames[0].time||x>=frames.at(-1).time)continue;const a=frames[j-1],b=frames[j],lo=clamp((x-a.time)/(b.time-a.time)),hi=clamp((y-a.time)/(b.time-a.time)),window=b.easingWindow||[0,1];if(hi>lo){out[i].easing=b.easing||'linear';out[i].easingWindow=[window[0]+lo*(window[1]-window[0]),window[0]+hi*(window[1]-window[0])];}}
  return {keyframes:out};
}
const keyGlslSource=`
  uniform float visualKeyEnabled;uniform vec3 visualKeyColor;uniform vec4 visualKeyParameters;uniform vec2 visualSourceSize;
  float visualAlpha(vec3 rgb){float d=distance(rgb,visualKeyColor)/1.7320508075688772;return visualKeyParameters.y>0.?clamp((d-visualKeyParameters.x)/visualKeyParameters.y,0.,1.):(d>visualKeyParameters.x?1.:0.);}
  vec4 visualKey(vec4 rgba,vec2 at){if(visualKeyEnabled<.5)return rgba;float a=visualAlpha(rgba.rgb),r=visualKeyParameters.w;
    if(r>0.){vec2 d=vec2(r)/visualSourceSize;a=visualAlpha(texture2D(source,at-d).rgb)+2.*visualAlpha(texture2D(source,at+vec2(0.,-d.y)).rgb)+visualAlpha(texture2D(source,at+vec2(d.x,-d.y)).rgb)+2.*visualAlpha(texture2D(source,at+vec2(-d.x,0.)).rgb)+4.*a+2.*visualAlpha(texture2D(source,at+vec2(d.x,0.)).rgb)+visualAlpha(texture2D(source,at+vec2(-d.x,d.y)).rgb)+2.*visualAlpha(texture2D(source,at+vec2(0.,d.y)).rgb)+visualAlpha(texture2D(source,at+d).rgb);a/=16.;}
    float amount=visualKeyParameters.z*(1.-a);vec3 k=visualKeyColor;
    if(k.r>=k.g&&k.r>=k.b&&k.r-max(k.g,k.b)>.05)rgba.r-=max(0.,rgba.r-max(rgba.g,rgba.b))*amount;
    else if(k.g>=k.r&&k.g>=k.b&&k.g-max(k.r,k.b)>.05)rgba.g-=max(0.,rgba.g-max(rgba.r,rgba.b))*amount;
    else if(k.b-max(k.r,k.g)>.05)rgba.b-=max(0.,rgba.b-max(rgba.r,rgba.g))*amount;
    return vec4(rgba.rgb,rgba.a*a);}
`;
const locations=new WeakMap();function setKeyUniforms(gl,program,input,width,height){let loc=locations.get(program);if(!loc){loc={};for(const key of ['visualKeyEnabled','visualKeyColor','visualKeyParameters','visualSourceSize'])loc[key]=gl.getUniformLocation(program,key);locations.set(program,loc);}const key=input?.chromaKey;gl.uniform1f(loc.visualKeyEnabled,key?1:0);if(!key)return;const k=Object.assign(keyDefaults(),key);gl.uniform3fv(loc.visualKeyColor,new Float32Array(k.color));gl.uniform4f(loc.visualKeyParameters,k.threshold,k.softness,k.spill,k.edgeSoftness);gl.uniform2f(loc.visualSourceSize,width,height);}
return Object.freeze({validate,normalize,keyDefaults,validateKey,keyAlpha,keyPixel,processRgba,blendChannel,blendRgba,canvasBlend,blendModes:BLEND_MODES,maskKeys:MASK_KEYS,maskDefaults,validateMaskExtension,validateAnimation,evaluateMask,maskAlpha,sliceAnimation,keyGlslSource,setKeyUniforms,version:'independent-visual-v1'});
});
