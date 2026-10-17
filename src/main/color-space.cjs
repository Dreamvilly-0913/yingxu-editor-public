'use strict';
// A single, explicit SDR working space is shared by preview and video export.
// The original file is never changed. See outputs/phase6-color-root-cause.md.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const VERSION = 'sdr-display-full709-v4';
const WORKING = Object.freeze({ primaries:'bt709', transfer:'iec61966-2-1', matrix:'bt709', range:'pc' });
const SET_WORKING = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=iec61966-2-1:range=full';
const MATRIX = new Set(['bt709','bt470bg','smpte170m','fcc','smpte240m']);
const PRIMARIES = new Set(['bt709','bt470bg','smpte170m','smpte240m','bt470m']);
const TRANSFER = new Set(['bt709','smpte170m','smpte240m','iec61966-2-1','gamma22','gamma28','bt470m','bt470bg']);
const unknown = value => !value || ['unknown','unspecified','reserved','2'].includes(String(value).toLowerCase());
function unsupported(message) { return Object.assign(new Error(`暂不支持此素材的色彩格式：${message}。请先转换为 SDR sRGB／BT.709。`), { code:'COLOR_UNSUPPORTED' }); }
function abortCheck(signal) { if (signal?.aborted) throw Object.assign(new Error('媒体处理已取消'), {name:'AbortError',code:'ABORT_ERR'}); }
function policy(info) {
  if (info.kind === 'audio') return null;
  const source = info.sourceColor || {}, assumptions = [];
  if (['smpte2084','arib-std-b67'].includes(source.transfer) || String(source.primaries).includes('2020') || String(source.matrix).includes('2020')) throw unsupported('HDR／BT.2020 尚未完成色调映射验证');
  if (info.kind === 'image') {
    if (!unknown(source.primaries) && source.primaries !== 'bt709') throw unsupported(`图片原色 ${source.primaries}`);
    if (!unknown(source.transfer) && !['iec61966-2-1','bt709'].includes(source.transfer)) throw unsupported(`图片传递函数 ${source.transfer}`);
    if (unknown(source.primaries) || unknown(source.transfer)) assumptions.push('图片按 sRGB 解释；未声明的 ICC／广色域信息不作推测恢复。');
    return { status:'srgb-image', assumptions, source:{ matrix:source.matrix, primaries:'bt709', transfer:'iec61966-2-1', range:'pc' }, working:WORKING };
  }
  let matrix = source.matrix, primaries = source.primaries, transfer = source.transfer, range = source.range;
  if (unknown(matrix)) { matrix = 'smpte170m'; assumptions.push('未声明 YUV 矩阵，采用 BT.601（SMPTE170M）确定默认。'); }
  if (!MATRIX.has(matrix)) throw unsupported(`矩阵 ${matrix}`);
  const family = matrix === 'bt709' ? 'bt709' : matrix === 'bt470bg' ? 'bt470bg' : matrix === 'smpte240m' ? 'smpte240m' : 'smpte170m';
  if (unknown(primaries)) { primaries = family; assumptions.push(`未声明原色，按 ${primaries} 解释。`); }
  if (unknown(transfer)) { transfer = family === 'bt470bg' ? 'bt709' : family; assumptions.push(`未声明传递函数，按 ${transfer} 解释。`); }
  if (!PRIMARIES.has(primaries)) throw unsupported(`原色 ${primaries}`);
  if (!TRANSFER.has(transfer)) throw unsupported(`传递函数 ${transfer}`);
  if (unknown(range)) { range = String(source.pixelFormat).startsWith('yuvj') ? 'pc' : 'tv'; assumptions.push(`未声明范围，按${range === 'pc' ? '全' : '限'}范围解释。`); }
  if (range === 'jpeg') range = 'pc'; if (range === 'mpeg') range = 'tv';
  if (!['pc','tv'].includes(range)) throw unsupported(`范围 ${range}`);
  // Jianying's verified default SDR path preserves encoded RGB curves. Use the same
  // display-referred interpretation explicitly, rather than falsely claiming a strict
  // BT.709 OETF -> sRGB transform. The verified 601 path also preserves RGB numbers;
  // matrix/range are converted, while SDR primaries are interpreted as the working gamut.
  const declared={matrix,primaries,transfer,range};
  return { status:assumptions.length ? 'assumed' : 'managed', assumptions, declared,
    source:{matrix,primaries:'bt709',transfer:'iec61966-2-1',range}, working:WORKING,
    interpretation:{id:'sdr-display-compatibility',declaredTransfer:source.transfer || 'unknown',resolvedTransfer:transfer,interpretedTransfer:'iec61966-2-1',
      declaredPrimaries:source.primaries || 'unknown',resolvedPrimaries:primaries,interpretedPrimaries:'bt709',primaries:'display-reinterpret-as-bt709',
      description:'SDR 显示兼容：保留已编码 RGB，显式处理 YUV 矩阵与范围。'} };
}
function publicFacts(info, plan = policy(info)) {
  return plan ? { colorStatus:plan.status, colorAssumptions:plan.assumptions, workingColor:{...WORKING}, workingPolicy:plan.interpretation || {id:'srgb-image',description:'图片按 sRGB 工作空间处理。'} } : {};
}
function normalizationFilter(plan, format = 'yuv420p') {
  const s = plan.source;
  // FFmpeg 7's colorspace passthrough rejects an identity yuvj420p -> yuv420p frame.
  // Already-normalized samples need no color transform; retain their YUV numbers.
  if (s.matrix===WORKING.matrix && s.primaries===WORKING.primaries && s.transfer===WORKING.transfer && s.range===WORKING.range) return SET_WORKING;
  return `colorspace=ispace=${s.matrix}:iprimaries=${s.primaries}:itrc=${s.transfer}:irange=${s.range}:space=bt709:primaries=bt709:trc=iec61966-2-1:range=pc:format=${format},${SET_WORKING}`;
}
function inputRgbFilter(kind) {
  return kind === 'image' ? 'format=rgba' : 'scale=in_color_matrix=bt709:in_range=pc:out_range=pc,format=rgba';
}
function outputFilter() {
  return `format=rgb24,scale=in_range=pc:out_range=pc:out_color_matrix=bt709,format=yuvj420p,${SET_WORKING}`;
}
function outputArgs() {
  return ['-pix_fmt','yuvj420p','-color_range','pc','-colorspace','bt709','-color_primaries','bt709','-color_trc','iec61966-2-1',
    '-bsf:v','h264_metadata=colour_primaries=1:transfer_characteristics=13:matrix_coefficients=1:video_full_range_flag=1'];
}
function verifyWorking(video) {
  if (!video || video.color_space !== 'bt709' || video.color_primaries !== 'bt709' || video.color_transfer !== 'iec61966-2-1' || video.color_range !== 'pc') {
    throw new Error('色彩校验失败：工作视频缺少完整的 BT.709 原色、sRGB 传递函数或全范围标签。');
  }
}
async function ensureProxy(info, { ffmpeg, ffprobe, cacheDir, run, readProbe, signal, onProgress, proxyHeight = 0 }) {
  if (info.kind !== 'video') return info.path;
  const plan = policy(info); abortCheck(signal);
  if(info.hasAlpha){if(info.video?.codec_name!=='vp9')throw unsupported('带透明通道的视频目前只支持VP9 WebM；其它格式请保留透明度转换后再导入');verifyWorking(info.video);return info.path;}
  const resolved = await fs.realpath(info.path), stat = await fs.stat(resolved);
  const sourceIdentity = {path:resolved,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs};
  if(![0,540,720,1080].includes(proxyHeight))throw new Error('预览代理分辨率无效');
  const scaled=proxyHeight>0&&info.height>proxyHeight,targetHeight=scaled?proxyHeight:info.height,targetWidth=scaled?Math.max(2,Math.round(info.width*targetHeight/info.height/2)*2):info.width;
  const recipe = {version:VERSION,sourceIdentity,sourceColor:info.sourceColor,plan,width:info.width,height:info.height,ffmpeg,...(scaled?{proxyWidth:targetWidth,proxyHeight:targetHeight}:{})};
  const key = createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
  const directory = path.join(cacheDir, 'color-work'); await fs.mkdir(directory,{recursive:true});
  const output = path.join(directory,key+'.mp4'), manifest = path.join(directory,key+'.json');
  try {
    const saved = JSON.parse(await fs.readFile(manifest,'utf8')), outputStat = await fs.stat(output);
    if (saved.key === key && saved.outputSize === outputStat.size && outputStat.size > 0) {
      abortCheck(signal); try { onProgress?.({ratio:1,message:'已复用色彩预览缓存'}); } catch {} return output;
    }
  } catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
  const temporary = path.join(directory,`${key}-${randomUUID()}.partial.mp4`), tempManifest = temporary+'.json';
  const odd = info.width % 2 || info.height % 2, format = odd ? 'yuv444p' : 'yuv420p';
  let filter=normalizationFilter(plan,format);
  // colorspace requires even dimensions even with 4:4:4; pad only while transforming,
  // then restore exact source geometry before the browser-compatible 4:4:4 encode.
  if (odd && filter !== SET_WORKING) filter=`pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=black,${filter},crop=${info.width}:${info.height}:0:0:exact=1,${SET_WORKING}`;
  try {
    if(scaled)filter+=`,scale=${targetWidth}:${targetHeight}:flags=lanczos,${SET_WORKING}`;
    try { onProgress?.({ratio:0,message:scaled?'正在准备低分辨率色彩代理':'正在统一视频色彩空间'}); } catch {}
    await run(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-filter_threads','2','-progress','pipe:1','-nostats',
      '-protocol_whitelist','file,pipe','-i',resolved,'-map',`0:${info.video?.index ?? 'v:0'}`,'-an','-sn','-dn',
      '-vf',`setpts=PTS-STARTPTS,${filter}`,'-fps_mode','passthrough','-c:v','libx264','-preset','veryfast','-crf','0','-threads','2',
      ...outputArgs(), ...(odd ? ['-pix_fmt','yuvj444p'] : []), '-movflags','+faststart+write_colr','-map_metadata','-1',temporary],
      {signal,onProgress:time=>{try{onProgress?.({ratio:Math.min(.99,time/info.duration),message:'正在统一视频色彩空间'});}catch{}}});
    abortCheck(signal);
    const now = await fs.stat(resolved);
    if (now.size !== stat.size || now.mtimeMs !== stat.mtimeMs || now.ctimeMs !== stat.ctimeMs) throw new Error('素材在处理过程中发生变化，请重新导入。');
    const probe = await readProbe(temporary,ffprobe,signal); verifyWorking(probe.video);
    if (probe.video.width !== targetWidth || probe.video.height !== targetHeight) throw new Error('色彩预览校验失败：画幅发生变化。');
    const outputStat = await fs.stat(temporary);
    await fs.writeFile(tempManifest,JSON.stringify({key,...recipe,outputSize:outputStat.size,createdAt:new Date().toISOString()},null,2));
    abortCheck(signal);
    await fs.rename(temporary,output); await fs.rename(tempManifest,manifest);
    try { onProgress?.({ratio:1,message:'色彩预览已就绪'}); } catch {}
    return output;
  } finally {
    await fs.rm(temporary,{force:true}).catch(()=>{}); await fs.rm(tempManifest,{force:true}).catch(()=>{});
  }
}
module.exports = { VERSION, WORKING, SET_WORKING, policy, publicFacts, normalizationFilter, inputRgbFilter, outputFilter, outputArgs, verifyWorking, ensureProxy };
