/* Local export settings and actual encoder capability checks. */
'use strict';
const {spawn}=require('node:child_process');
const cache=new Map();
const number=(x,min,max,label)=>{if(typeof x!=='number'||!Number.isFinite(x)||x<min||x>max)throw new Error(label+'超出范围');return x;};
function normalize(input={},duration){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('导出设置无效');
 const mode=input.mode===undefined?'mp4':input.mode;if(!['mp4','wav'].includes(mode))throw new Error('请选择MP4或WAV导出');
 const quality=input.quality||'high';if(!['high','standard','compact','bitrate'].includes(quality))throw new Error('导出质量无效');
 const encoder=input.encoder||'software';if(!['software','auto','nvenc'].includes(encoder))throw new Error('编码器无效');
 const rangeStart=input.rangeStart===undefined?0:number(input.rangeStart,0,duration,'区间开始');
 const rangeEnd=input.rangeEnd===undefined?duration:number(input.rangeEnd,0,duration,'区间结束');
 if(rangeEnd-rangeStart<.001)throw new Error('导出结束时间必须晚于开始时间');
 const bitrateMbps=input.bitrateMbps===undefined?12:number(input.bitrateMbps,.5,100,'视频码率');
 return {mode,quality,encoder,rangeStart,rangeEnd,bitrateMbps,duration:rangeEnd-rangeStart};
}
function videoArgs(settings,encoder='libx264'){
 const crf={high:18,standard:23,compact:28}[settings.quality];
 if(encoder==='h264_nvenc')return ['-c:v',encoder,'-preset','p4',...(settings.quality==='bitrate'?['-b:v',settings.bitrateMbps+'M']:['-rc','vbr','-cq',String(crf),'-b:v','0'])];
 return ['-c:v','libx264','-preset','veryfast',...(settings.quality==='bitrate'?['-b:v',settings.bitrateMbps+'M']:['-crf',String(crf)])];
}
async function probeEncoders(ffmpeg,{signal}={}){
 if(cache.has(ffmpeg))return cache.get(ffmpeg);
 if(signal?.aborted)throw Object.assign(new Error('已取消'),{name:'AbortError'});
 const result=await new Promise((resolve,reject)=>{
  let diagnostic='';const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i','color=black:s=64x64:r=1:d=1','-frames:v','1','-an','-c:v','h264_nvenc','-pix_fmt','yuv420p','-f','null','-'],{windowsHide:true});
  const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>child.kill(),12000);
  const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
  child.stderr.on('data',d=>{diagnostic=(diagnostic+d).slice(-1500);});child.on('error',e=>{done();resolve({nvenc:false,reason:e.message});});child.on('close',code=>{done();if(signal?.aborted)return reject(Object.assign(new Error('已取消'),{name:'AbortError'}));resolve({nvenc:code===0,reason:code===0?'实际编码探测通过':diagnostic.trim()||'当前机器无法使用NVIDIA硬件编码'});});
 });
 const capabilities={software:true,...result,checkedAt:new Date().toISOString()};cache.set(ffmpeg,capabilities);return capabilities;
}
module.exports={normalize,videoArgs,probeEncoders};
