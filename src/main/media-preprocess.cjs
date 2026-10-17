/* Explicit local preprocessing. Every successful job creates a new independent video. */
'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const Color=require('./color-space.cjs');
const MODES=new Set(['optical-flow','stabilize','hdr-to-sdr']);
function aborted(){return Object.assign(new Error('素材预处理已取消'),{name:'AbortError',code:'ABORT_ERR'});}
function check(signal){if(signal?.aborted)throw aborted();}
function finite(n,min,max,label){if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max)throw new Error(label+'必须为 '+min+'–'+max+' 的数值');}
function run(command,args,{cwd,signal,onTime,timeout=0}={}){
 check(signal);return new Promise((resolve,reject)=>{let stdout='',stderr='',pending='',timer,done=false;const child=spawn(command,args,{cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  const abort=()=>child.kill('SIGKILL'),finish=(error)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve({stdout,stderr});};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  if(timeout)timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
  child.stdout.on('data',b=>{stdout=(stdout+b.toString()).slice(-16*1024*1024);if(onTime){pending+=b.toString();let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n).trim();pending=pending.slice(n+1);if(line.startsWith('out_time_us=')){const time=Number(line.slice(12))/1e6;if(Number.isFinite(time)){try{onTime(Math.max(0,time));}catch{}}}}}});
  child.stderr.on('data',b=>stderr=(stderr+b.toString()).slice(-24000));child.on('error',e=>finish(signal?.aborted?aborted():e));child.on('close',code=>finish(signal?.aborted?aborted():code===0?null:new Error('素材预处理失败：'+stderr.slice(-5000))));
 });
}
async function probeCapabilities({ffmpeg='ffmpeg',signal}={}){
 try{const result=await run(ffmpeg,['-hide_banner','-filters'],{signal,timeout:30000}),filters=[];for(const line of (result.stdout+'\n'+result.stderr).split(/\r?\n/)){const match=line.match(/^\s*[TSC.]{3}\s+(\w+)\s/);if(match)filters.push(match[1]);}const set=new Set(filters);return{available:true,opticalFlow:set.has('minterpolate'),stabilize:set.has('vidstabdetect')&&set.has('vidstabtransform'),hdrToSdr:set.has('zscale')&&set.has('tonemap'),filters:filters.filter(f=>['minterpolate','vidstabdetect','vidstabtransform','zscale','tonemap'].includes(f))};}
 catch(e){if(e.name==='AbortError')throw e;return{available:false,opticalFlow:false,stabilize:false,hdrToSdr:false,filters:[],reason:e.message};}
}
async function probe(file,ffprobe,signal){const result=await run(ffprobe,['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',file],{signal,timeout:30000});let data;try{data=JSON.parse(result.stdout);}catch{throw new Error('无法读取待转换视频的信息');}const video=data.streams?.find(s=>s.codec_type==='video'&&!s.disposition?.attached_pic),audio=data.streams?.find(s=>s.codec_type==='audio');if(!video)throw new Error('只能预处理含有视频画面的本地素材');return{data,video,audio};}
const rate=s=>{if(typeof s!=='string')return 0;const[n,d=1]=s.split('/').map(Number);return d&&Number.isFinite(n/d)?n/d:0;};
function infoFor(source){const v=source.video,duration=Number(v.duration)||Number(source.data.format?.duration);if(!Number.isFinite(duration)||duration<=0)throw new Error('待转换视频时长无效');const fps=rate(v.avg_frame_rate)||rate(v.r_frame_rate);if(!(fps>0&&fps<=240))throw new Error('源素材帧率不在当前 0–240 fps 处理范围');let width=Number(v.width),height=Number(v.height);const rotation=Number(v.side_data_list?.find(s=>Number.isFinite(Number(s.rotation)))?.rotation??v.tags?.rotate??0);if(Math.abs(rotation)%180===90)[width,height]=[height,width];if(!(width>=16&&height>=16&&width<=8192&&height<=8192))throw new Error('待转换视频画幅需为 16–8192 像素');return{duration,fps,width,height,rotation,hasAudio:Boolean(source.audio),sourceColor:{matrix:v.color_space||'unknown',primaries:v.color_primaries||'unknown',transfer:v.color_transfer||'unknown',range:v.color_range||'unknown',pixelFormat:v.pix_fmt||'unknown'}};}
function normalizeSettings(options={}){const mode=options.mode;if(!MODES.has(mode))throw new Error('不支持的素材预处理方式');const settings={mode};if(mode==='optical-flow'){settings.fps=options.fps===undefined?60:options.fps;finite(settings.fps,1,120,'补帧目标帧率');}if(mode==='stabilize'){settings.strength=options.strength===undefined?15:options.strength;finite(settings.strength,1,100,'防抖平滑强度');if(!Number.isInteger(settings.strength))throw new Error('防抖强度必须为整数');}if(mode==='hdr-to-sdr'){settings.peakNits=options.peakNits===undefined?1000:options.peakNits;finite(settings.peakNits,100,10000,'HDR 信号峰值亮度');}return settings;}
function makeFilter(info,settings){
 const odd=info.width%2||info.height%2,format=odd?'yuv444p':'yuv420p',outFormat=odd?'yuvj444p':'yuvj420p';let filter='setpts=PTS-STARTPTS';let assumptions=[];
 if(settings.mode==='hdr-to-sdr'){
  const c=info.sourceColor;if(!['smpte2084','arib-std-b67'].includes(c.transfer)||c.primaries!=='bt2020'||!['bt2020nc','bt2020c'].includes(c.matrix))throw new Error('HDR 转 SDR 只接受明确标记 BT.2020 原色、BT.2020 矩阵和 PQ／HLG 传递函数的视频');
  let range=c.range;if(['unknown','unspecified'].includes(range)){range='tv';assumptions.push('未声明 HDR 编码范围，明确按限范围解释。');}if(!['tv','pc','mpeg','jpeg'].includes(range))throw new Error('HDR 编码范围无效');const rin=['pc','jpeg'].includes(range)?'full':'limited';
  if(odd)filter+=',pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0';
  filter+=',zscale=matrixin='+c.matrix+':primariesin=bt2020:transferin='+c.transfer+':rangein='+rin+':transfer=linear:npl=100,format=gbrpf32le,zscale=primaries=bt709,tonemap=tonemap=hable:desat=2:peak='+(settings.peakNits/100)+',zscale=transfer=iec61966-2-1:matrix=bt709:range=full,format='+outFormat;
  if(odd)filter+=',crop='+info.width+':'+info.height+':0:0:exact=1';filter+=','+Color.SET_WORKING;
  assumptions.push('明确转换为 SDR；Hable 色调映射以 100 nit 为工作参考白，信号峰值 '+settings.peakNits+' nit。');if(c.transfer==='arib-std-b67')assumptions.push('HLG 转换使用 zscale 的标准 HLG 解释，不复现特定设备动态映射。');
 }else{
  const plan=Color.policy({kind:'video',sourceColor:info.sourceColor});assumptions=plan.assumptions.slice();let normalization=Color.normalizationFilter(plan,format);if(odd&&normalization!==Color.SET_WORKING)normalization='pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0,'+normalization+',crop='+info.width+':'+info.height+':0:0:exact=1,'+Color.SET_WORKING;filter+=','+normalization;
  if(settings.mode==='optical-flow')filter+=',tpad=stop_mode=clone:stop_duration='+(4/info.fps)+',minterpolate=fps='+settings.fps+':mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff,tpad=stop_mode=clone:stop_duration=2';
  else filter+=',vidstabtransform=input=transforms.trf:smoothing='+settings.strength+':optalgo=gauss:crop=black:optzoom=1:interpol=bicubic';
  filter+=',format='+outFormat+','+Color.SET_WORKING;
 }return{filter,assumptions,outFormat};
}
async function convert(input,options={}){
 const settings=normalizeSettings(options),{ffmpeg='ffmpeg',ffprobe='ffprobe',cacheDir,signal,onProgress}=options;check(signal);if(typeof input!=='string'||!path.isAbsolute(input)||input.includes('\0'))throw new Error('预处理输入必须是本地绝对文件路径');if(typeof cacheDir!=='string'||!path.isAbsolute(cacheDir))throw new Error('预处理需要明确的独立素材输出目录');
 const sourcePath=await fs.realpath(input),sourceStat=await fs.stat(sourcePath);if(!sourceStat.isFile())throw new Error('待转换素材不是文件');const capabilities=await probeCapabilities({ffmpeg,signal});const supported=settings.mode==='optical-flow'?capabilities.opticalFlow:settings.mode==='stabilize'?capabilities.stabilize:capabilities.hdrToSdr;if(!supported)throw new Error('当前 FFmpeg 没有可用的'+({'optical-flow':'运动补偿补帧','stabilize':'两遍视频防抖','hdr-to-sdr':'HDR 色调映射'}[settings.mode])+'滤镜');
 const source=await probe(sourcePath,ffprobe,signal),info=infoFor(source);
 if(source.video.side_data_list?.some(s=>/dovi|dolby vision/i.test(s.side_data_type||''))||/^dv[ah]/i.test(source.video.codec_tag_string||''))throw new Error('暂不接受含 Dolby Vision 动态元数据的素材，请先得到明确的 PQ／HLG 中间文件');
 const recipe=makeFilter(info,settings);if(settings.mode==='optical-flow'&&info.duration*info.fps<3)throw new Error('运动补偿补帧至少需要 3 个源视频帧');
 const parent=path.resolve(cacheDir,'preprocessed'),directory=path.join(parent,settings.mode+'-'+randomUUID());await fs.mkdir(directory,{recursive:true});const output=path.join(directory,'converted.mp4'),partial=path.join(directory,'converted.partial.mp4');let complete=false;
 const emit=(ratio,phase)=>{try{onProgress?.({ratio:Math.max(0,Math.min(1,ratio)),phase,mode:settings.mode,name:path.basename(sourcePath)});}catch{}};
 try{
  check(signal);const base=['-hide_banner','-loglevel','error','-nostdin','-y','-threads','2','-filter_threads','2','-progress','pipe:1','-nostats','-protocol_whitelist','file,pipe','-i',sourcePath];
  if(settings.mode==='stabilize'){
   emit(0,'detecting');await run(ffmpeg,[...base,'-map','0:v:0','-an','-sn','-dn','-vf','setpts=PTS-STARTPTS,vidstabdetect=shakiness=5:accuracy=15:result=transforms.trf','-f','null','-'],{cwd:directory,signal,onTime:t=>emit(.4*Math.min(1,t/info.duration),'detecting')});check(signal);
   if((await fs.stat(path.join(directory,'transforms.trf'))).size<20)throw new Error('视频防抖未得到有效运动分析记录');
  }
  emit(settings.mode==='stabilize'?.4:0,'converting');const targetFps=settings.mode==='optical-flow'?settings.fps:info.fps;
  await run(ffmpeg,[...base,'-map','0:v:0','-map','0:a:0?','-sn','-dn','-vf',recipe.filter,'-frames:v',String(Math.ceil(info.duration*targetFps-1e-9)),...(info.hasAudio?['-af','atrim=duration='+info.duration+',asetpts=PTS-STARTPTS']:[]),'-r',String(targetFps),'-c:v','libx264','-preset','veryfast','-crf','16','-threads','2',...Color.outputArgs(),'-pix_fmt',recipe.outFormat,'-c:a','aac','-b:a','192k','-ar','48000','-map_metadata','-1','-movflags','+faststart+write_colr',partial],{cwd:directory,signal,onTime:t=>emit((settings.mode==='stabilize'?.4:0)+(settings.mode==='stabilize'?.59:.99)*Math.min(1,t/info.duration),'converting')});
  check(signal);const rendered=await probe(partial,ffprobe,signal);Color.verifyWorking(rendered.video);const actual=infoFor(rendered),tolerance=Math.max(.12,2/targetFps);if(actual.width!==info.width||actual.height!==info.height||Math.abs(actual.duration-info.duration)>tolerance||Math.abs(actual.fps-targetFps)>Math.max(.001,targetFps*.001)||Boolean(rendered.audio)!==info.hasAudio)throw new Error('转换后视频的画幅、帧率、音轨或时长校验失败：'+JSON.stringify({expected:{width:info.width,height:info.height,duration:info.duration,fps:targetFps,audio:info.hasAudio},actual:{width:actual.width,height:actual.height,duration:actual.duration,fps:actual.fps,audio:Boolean(rendered.audio)}}));
  const now=await fs.stat(sourcePath);if(now.size!==sourceStat.size||now.mtimeMs!==sourceStat.mtimeMs||now.ctimeMs!==sourceStat.ctimeMs)throw new Error('源素材在转换期间发生变化，请重新处理');
  await fs.rename(partial,output);const metadata={version:1,createdAt:new Date().toISOString(),mode:settings.mode,settings,source:{path:sourcePath,size:sourceStat.size,mtimeMs:sourceStat.mtimeMs,...info},output:{path:output,...actual,workingColor:Color.WORKING},filter:recipe.filter,assumptions:recipe.assumptions,originalUnchanged:true};await fs.writeFile(path.join(directory,'conversion.json'),JSON.stringify(metadata,null,2));check(signal);complete=true;emit(1,'complete');return{path:output,mode:settings.mode,metadata,originalUnchanged:true};
 }finally{if(!complete){const resolved=path.resolve(directory);if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith(settings.mode+'-'))throw new Error('拒绝清理越界预处理目录');await fs.rm(resolved,{recursive:true,force:true}).catch(()=>{});}}
}
module.exports={probeCapabilities,convert,normalizeSettings,makeFilter};
