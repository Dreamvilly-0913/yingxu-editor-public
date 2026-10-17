'use strict';
const sourceMaskCache=require('./visual-tools.cjs').createMaskRasterCache();
const AudioModel=require('../shared/audio-model.js'),TextStyle=require('../shared/text-style.js'),VisualTools=require('./visual-tools.cjs'),ExportOptions=require('./export-options.cjs');

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const Model = require('../shared/project.js');
const Color = require('./color-space.cjs');
const AdvancedColor = require('../shared/advanced-color.js');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.avif']);
const SAMPLE_RATE = 48000;
const number = value => Number(value).toFixed(9).replace(/0+$/, '').replace(/\.$/, '') || '0';
const abortError = () => Object.assign(new Error('导出已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }

// No shell is involved. FFmpeg is the only child; abort waits for its close event.
function run(executable, args, { cwd, signal, timeout = 0, onProgress } = {}) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let child;
    let stdout = '';
    let stderr = '';
    let pending = '';
    let record = {};
    let aborted = false;
    let timedOut = false;
    let timer;
    let settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => { aborted = true; child?.kill('SIGKILL'); };
    try {
      child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { finish(error); return; }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (timeout > 0) timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (!onProgress) stdout = (stdout + chunk).slice(-16 * 1024 * 1024);
      if (!onProgress) return;
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        record[line.slice(0, eq)] = line.slice(eq + 1);
        if (line.startsWith('progress=')) {
          const micros = Number(record.out_time_us ?? record.out_time_ms);
          if (Number.isFinite(micros)) onProgress(Math.max(0, micros / 1e6));
          record = {};
        }
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-24000); });
    child.on('error', error => finish(aborted ? abortError() : error));
    child.on('close', code => {
      if (aborted || signal?.aborted) return finish(abortError());
      if (timedOut) return finish(new Error('媒体处理超时，请检查文件是否可读取。'));
      if (code !== 0) {
        const error = new Error(`媒体处理失败（退出码 ${code}）：${stderr.trim().slice(-6000)}`);
        error.code = 'MEDIA_PROCESS_FAILED';
        error.stderr = stderr;
        return finish(error);
      }
      finish(null, { stdout, stderr });
    });
  });
}

async function localFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw new Error('素材必须使用本地文件的绝对路径。');
  const resolved = await fs.realpath(file);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error('素材路径不是文件。');
  return { resolved, stat };
}

async function readProbe(file, ffprobe, signal) {
  const { stdout } = await run(ffprobe || 'ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', file
  ], { signal, timeout: 30000 });
  let data;
  try { data = JSON.parse(stdout); } catch { throw new Error('无法读取媒体信息。'); }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = streams.find(stream => stream.codec_type === 'audio');
  return { data, video, audio };
}

function sourceBitDepth(video) {
  for (const value of [video?.bits_per_raw_sample, video?.bits_per_sample]) { const bits=Number(value); if (Number.isFinite(bits) && bits>0) return bits; }
  const format=video?.pix_fmt || '';
  const planar=format.match(/(?:p|gray)(9|10|12|14|16|32)(?:le|be)$/) || format.match(/^p0?(10|12|16)(?:le|be)$/) || format.match(/pf(16|32)(?:le|be)$/);
  if (planar) return Number(planar[1]);
  if (/^(rgb48|bgr48|rgba64|bgra64)/.test(format)) return 16;
  if (/^(yuvj?\d+p|yuva\d+p|nv12|nv21|rgb24|bgr24|rgba|bgra|argb|abgr|gray|gray8|pal8|gbrp|gbrap)$/.test(format)) return 8;
  return null;
}
function describe(file, probe) {
  const { data, video, audio } = probe;
  const kind = video ? (IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()) ? 'image' : 'video') : 'audio';
  if (!video && !audio) throw new Error('文件中没有可用的视频、图片或音频。');
  const durations = [data.format?.duration, video?.duration, audio?.duration].map(Number).filter(value => Number.isFinite(value) && value > 0);
  const duration = kind === 'image' ? 5 : Math.max(0, ...durations);
  if (!(duration > 0)) throw new Error('无法确定素材时长，暂不支持此媒体文件。');
  let width = Number(video?.width) || 0;
  let height = Number(video?.height) || 0;
  const rotation = Number(video?.side_data_list?.find(item => Number.isFinite(Number(item.rotation)))?.rotation ?? video?.tags?.rotate ?? 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  return { hasAlpha:Boolean(kind==='video'&&video&&(Object.entries(video.tags||{}).some(([k,v])=>k.toLowerCase()==='alpha_mode'&&String(v)==='1')||/yuva|rgba|bgra|gbrap|argb|abgr/.test(video.pix_fmt||''))),name: path.basename(file), path: file, kind, duration, width, height, hasAudio: !!audio,
    thumbnail: '', videoCodec: video?.codec_name || null, audioCodec: audio?.codec_name || null,
    sourceColor: video ? { matrix: video.color_space || 'unknown', primaries: video.color_primaries || 'unknown',
      transfer: video.color_transfer || 'unknown', range: video.color_range || 'unknown',
      pixelFormat: video.pix_fmt || 'unknown', bitDepth: sourceBitDepth(video) } : null };
}

async function probeMedia(file, { ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', cacheDir, signal, onProgress, proxyHeight = 0 } = {}) {
  const { resolved, stat } = await localFile(file);
  checkAbort(signal);
  const sourceProbe = await readProbe(resolved, ffprobe, signal);
  const result = describe(resolved, sourceProbe);
  Object.assign(result, Color.publicFacts(result));
  if (result.kind === 'video' && cacheDir) result.previewPath = await Color.ensureProxy({...result,video:sourceProbe.video}, { ffmpeg, ffprobe, cacheDir, run, readProbe, signal, onProgress, proxyHeight });
  if (result.kind !== 'audio') {
    const key = createHash('sha256').update(`${Color.VERSION}\0${resolved}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`).digest('hex');
    let buffer;
    let thumbnailPath;
    if (cacheDir) {
      await fs.mkdir(cacheDir, { recursive: true });
      thumbnailPath = path.join(cacheDir, `${key}.jpg`);
      try { buffer = await fs.readFile(thumbnailPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!buffer) {
      // Use a file for thumbnail output so binary bytes never pass through UTF-8 decoding.
      const directory = cacheDir || path.join(os.tmpdir(), 'yingxu-thumbnails');
      await fs.mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `${key}-${randomUUID()}.jpg`);
      try {
        const seek = result.kind === 'video' ? ['-ss', number(Math.min(0.1, result.duration / 4))] : [];
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe',
          ...seek,...(result.hasAlpha?['-c:v','libvpx-vp9']:[]), '-i', result.previewPath || resolved, '-frames:v', '1', '-vf', `${result.previewPath ? Color.inputRgbFilter('video') + ',' : ''}scale=320:180:force_original_aspect_ratio=decrease`, '-q:v', '3', temporary], { signal, timeout: 45000 });
        buffer = await fs.readFile(temporary);
        if (thumbnailPath) await fs.rename(temporary, thumbnailPath);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    }
    result.thumbnail = `data:image/jpeg;base64,${buffer.toString('base64')}`;
  }
  checkAbort(signal);
  return { id: randomUUID(), ...result };
}

function tempo(speed) {
  const filters = [];
  let remaining = speed;
  // Chained factors in [0.5, 2] preserve samples better than one >2 factor.
  while (remaining > 2 + 1e-10) { filters.push('atempo=2'); remaining /= 2; }
  while (remaining < 0.5 - 1e-10) { filters.push('atempo=0.5'); remaining /= 0.5; }
  filters.push(`atempo=${number(remaining)}`);
  return filters.join(',');
}
function audioEnvelopeFilter(clip) {
  const points = Model.audioEnvelopePoints(clip);
  if (points.every(point => point.gain === 1)) return '';
  let expression = number(points.at(-1).gain);
  for (let index = points.length - 2; index >= 0; index--) {
    const a = points[index], b = points[index + 1];
    const section = Math.abs(a.gain - b.gain) < 1e-12 ? number(a.gain)
      : `(${number(a.gain)}+(${number(b.gain - a.gain)})*clip((t-${number(a.time)})/${number(b.time - a.time)},0,1))`;
    expression = `if(lt(t,${number(b.time)}),${section},${expression})`;
  }
  // aeval evaluates every sample, preserving cut-boundary gain instead of stepping by audio frames.
  return `,aeval=exprs='val(0)*(${expression})|val(1)*(${expression})'`;
}
function audioFilter(clip) {
  return `asetpts=PTS-STARTPTS,${AudioModel.processingFilter(clip)?AudioModel.processingFilter(clip)+',':''}${tempo(clip.speed)},volume=${number(clip.volume)},aresample=${SAMPLE_RATE},` +
    `aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${number(clip.duration)},asetpts=PTS-STARTPTS` + audioEnvelopeFilter(clip);
}
function videoTimeFilter(clip, phase = 0) {
  if (!clip.speedCurve) return `setpts=(PTS-STARTPTS)/${number(clip.speed)}`;
  const n=value=>Number(value).toString(), source='(PTS*TB)';
  const plan=Model.curveSegmentPlan(clip);let expression=`(${n(clip.duration)}+(${source}-${n(plan.at(-1).sourceEnd)})/${n(plan.at(-1).endSpeed)})`;
  for(let index=plan.length-1;index>=0;index--){
    const segment=plan[index],elapsed=`(${source}-${n(segment.sourceStart)})`;
    let local;
    if(segment.slope===0) local=`(${elapsed}/${n(segment.startSpeed)})`;
    else {
      const u=`(${n(segment.slope)}*${elapsed}/${n(segment.startSpeed)})`;
      // av_expr has log but not log1p. Use its convergent expansion for tiny
      // slopes so nearly-flat curves do not lose time to cancellation.
      local=Math.abs(segment.slope*(segment.sourceEnd-segment.sourceStart)/segment.startSpeed)<1e-5
        ? `(${u}*(1-${u}/2+${u}*${u}/3-${u}*${u}*${u}/4+${u}*${u}*${u}*${u}/5)/${n(segment.slope)})`
        : `(log(1+${u})/${n(segment.slope)})`;
    }
    const value=`(${n(segment.localStart)}+${local})`;
    expression=`if(lt(${source},${n(segment.sourceEnd)}),${value},${expression})`;
  }
  expression=`if(lt(${source},${n(clip.sourceIn)}),(${source}-${n(clip.sourceIn)})/${n(plan[0].startSpeed)},${expression})`;
  return `settb=expr=1/1000000000,setpts='((${expression})-${Number(phase).toString()})/TB'`;
}

// Render short constant-tempo centres with source context, then place them on
// the exact analytic clock. Continuous WSOLA needs more than a 20ms isolated
// input. Context plus complementary 10ms joins preserves pitch without the
// accumulated internal drift of changing one stretcher's tempo in real time.
async function renderCurveClipAudio(clip, info, scratch, index, {ffmpeg,signal,onProgress}) {
  const rate=SAMPLE_RATE,channels=2,bytesPerSample=channels*4,lastSample=Math.round(clip.duration*rate),context=.2;
  const plan=Model.curveSegmentPlan(clip,{maxOutputStep:.04}).filter(segment=>Math.round(segment.localEnd*rate)>Math.round(segment.localStart*rate));
  const boundaries=[0];
  for(let i=1;i<plan.length;i++) boundaries.push(Math.max(0,Math.min(240,Math.floor((Math.round(plan[i-1].localEnd*rate)-Math.round(plan[i-1].localStart*rate))/2),Math.floor((Math.round(plan[i].localEnd*rate)-Math.round(plan[i].localStart*rate))/2))));
  boundaries.push(0);
  const output=path.join(scratch,`curve-${index}.f32`),handle=await fs.open(output,'w+');let written=0;
  try {
    // Bound graph size, delay buffers and resident audio to at most 64 centres.
    // Chunks keep their edge fades; their overlap is added sample-for-sample.
    for(let begin=0;begin<plan.length;begin+=64){
      checkAbort(signal);const end=Math.min(plan.length,begin+64),segments=[];
      for(let i=begin;i<end;i++){
        const first=Math.max(0,Math.round(plan[i].localStart*rate)-boundaries[i]),last=Math.min(lastSample,Math.round(plan[i].localEnd*rate)+boundaries[i+1]);
        const s0=Model.clipSourceTime(clip,first/rate),s1=Model.clipSourceTime(clip,last/rate),speed=(s1-s0)/((last-first)/rate);
        segments.push({first,last,s0,s1,speed,left:Math.max(0,s0-context),right:Math.min(info.duration,s1+context),fadeIn:boundaries[i]*2,fadeOut:boundaries[i+1]*2});
      }
      const first=segments[0].first,last=segments.at(-1).last,readStart=Math.min(...segments.map(s=>s.left)),readEnd=Math.max(...segments.map(s=>s.right));
      const filters=[`[0:${info.audio.index}]aresample=${rate},aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=${segments.length}${segments.map((_,i)=>`[in${i}]`).join('')}`];
      for(let i=0;i<segments.length;i++){
        const segment=segments[i],length=segment.last-segment.first,crop=Math.round((segment.s0-segment.left)/segment.speed*rate);
        filters.push(`[in${i}]atrim=start=${number(segment.left-readStart)}:end=${number(segment.right-readStart)},asetpts=PTS-STARTPTS,apad=pad_dur=0.25,${tempo(segment.speed)},apad,atrim=start_sample=${crop}:end_sample=${crop+length},asetpts=PTS-STARTPTS`+
          (segment.fadeIn?`,afade=t=in:st=0:d=${number(segment.fadeIn/rate)}:curve=tri`:'')+
          (segment.fadeOut?`,afade=t=out:st=${number((length-segment.fadeOut)/rate)}:d=${number(segment.fadeOut/rate)}:curve=tri`:'')+
          `,adelay=${segment.first-first}S:all=1[s${i}]`);
      }
      filters.push(segments.map((_,i)=>`[s${i}]`).join('')+`amix=inputs=${segments.length}:duration=longest:dropout_transition=0:normalize=0,apad,atrim=end_sample=${last-first}[aout]`);
      const graph=`curve-${index}-${begin}.txt`,chunk=`curve-${index}-${begin}.f32`;await fs.writeFile(path.join(scratch,graph),filters.join(';\n'));
      await run(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-filter_complex_threads','2','-ss',number(readStart),'-t',number(readEnd-readStart),'-protocol_whitelist','file,pipe','-i',info.path,
        '-filter_complex_script',graph,'-map','[aout]','-ar',String(rate),'-ac',String(channels),'-c:a','pcm_f32le','-f','f32le',chunk],{cwd:scratch,signal});
      checkAbort(signal);const bytes=await fs.readFile(path.join(scratch,chunk));
      if(bytes.length!==(last-first)*bytesPerSample) throw new Error('曲线音轨分段采样数校验失败。');
      const overlap=Math.max(0,written-first);
      if(overlap){const previous=Buffer.alloc(overlap*bytesPerSample);await handle.read(previous,0,previous.length,first*bytesPerSample);for(let sample=0;sample<previous.length;sample+=4)bytes.writeFloatLE(bytes.readFloatLE(sample)+previous.readFloatLE(sample),sample);}
      await handle.write(bytes,0,bytes.length,first*bytesPerSample);written=last;
      await fs.rm(path.join(scratch,chunk),{force:true});onProgress?.(Math.min(clip.duration,last/rate));
    }
    await handle.truncate(lastSample*bytesPerSample);
  } finally { await handle.close(); }
  return output;
}

function sourceGeometryFilter(info, clip, cropOnly = false) {
  let filter = '';
  if (clip.crop) {
    const rect = Model.cropRect(info, clip);
    filter += `format=rgba,crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}:exact=1,`;
  }
  if (!cropOnly && clip.flipX) filter += 'hflip,';
  if (!cropOnly && clip.flipY) filter += 'vflip,';
  return filter;
}
function maskFilter(clip) {
  if (!clip.mask) return '';
  const m = Object.assign({type:'rectangle',centerX:0.5,centerY:0.5,width:1,height:1,rotation:0,feather:0,invert:false}, clip.mask);
  const angle = m.rotation * Math.PI / 180;
  // Keep the cropped source's alpha and multiply by the identical SDF/smoothstep
  // used by Model.evaluateMaskAlpha. geq X/Y are indices; evaluate pixel centres.
  const setup = `st(0,X+0.5-${number(m.centerX)}*W);st(1,Y+0.5-${number(m.centerY)}*H);` +
    `st(2,ld(0)*${number(Math.cos(angle))}+ld(1)*${number(Math.sin(angle))});` +
    `st(3,-ld(0)*${number(Math.sin(angle))}+ld(1)*${number(Math.cos(angle))});` +
    `st(4,${number(m.width / 2)}*W);st(5,${number(m.height / 2)}*H);`;
  const distance = m.type === 'ellipse' ? `(hypot(ld(2)/ld(4),ld(3)/ld(5))-1)*min(ld(4),ld(5))`
    : `st(6,abs(ld(2))-ld(4));st(7,abs(ld(3))-ld(5));hypot(max(ld(6),0),max(ld(7),0))+min(max(ld(6),ld(7)),0)`;
  const edge = m.feather > 0 ? `st(9,clip(0.5+ld(8)/(${number(m.feather)}*min(W,H)),0,1));1-ld(9)*ld(9)*(3-2*ld(9))` : 'lte(ld(8),0)';
  const alpha = `${setup}st(8,${distance});st(9,${edge});alpha(X,Y)*(${m.invert ? '1-' : ''}ld(9))`;
  return `,format=gbrap,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}':interpolation=bilinear`;
}
async function colorFilter(clip, scratch, signal) {
  const color = Object.assign({ brightness: 0, contrast: 0, saturation: 0 }, clip.color || {});
  const advanced = AdvancedColor.createProcessor(clip.advancedColor);
  if (Object.values(color).every(value => value === 0) && AdvancedColor.isIdentity(clip.advancedColor)) return '';
  const key = createHash('sha256').update(JSON.stringify([color,AdvancedColor.normalize(clip.advancedColor)])).digest('hex').slice(0, 16);
  const name = `color-${key}.cube`, file = path.join(scratch, name);
  try { await fs.access(file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A 65-grid tetrahedral RGB LUT keeps the export approximation explicit and measurable.
    const size = 65, rows = ['TITLE "Yingxu independent FC adjustment"', `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
    for (let blue = 0; blue < size; blue++) {
      checkAbort(signal);
      for (let green = 0; green < size; green++) for (let red = 0; red < size; red++) {
        rows.push(advanced(Model.adjustRgb([red / (size - 1), green / (size - 1), blue / (size - 1)], color)).map(value => value.toFixed(9)).join(' '));
      }
      // Let IPC cancellation run while computing large LUTs.
      if (blue % 8 === 7) await new Promise(resolve => setImmediate(resolve));
    }
    checkAbort(signal); await fs.writeFile(file, rows.join('\n') + '\n', 'utf8');
  }
  return `,lut3d=file=${name}:interp=tetrahedral`;
}
function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}
function assText(text) {
  // Neutralize ASS override delimiters. Fullwidth braces are literal visible text,
  // not formatting instructions; a zero-width separator preserves literal backslashes.
  return text.replace(/\\/g, '\\\u200b').replace(/\{/g, '｛').replace(/\}/g, '｝')
    .replace(/\r\n?/g, '\n').replace(/\n/g, '\\N').replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
}
async function writeSubtitles(project, scratch) {
  const color = project.subtitleStyle.color.slice(1);
  const assColor = `&H00${color.slice(4, 6)}${color.slice(2, 4)}${color.slice(0, 2)}`;
  const marginX = Math.round(project.width * 0.06);
  const marginY = Math.round(project.height * 0.05);
  const outline = number(project.subtitleStyle.fontSize / 16);
  const fontsDir = path.join(scratch, 'fonts');
  await fs.mkdir(fontsDir);
  const systemFonts = process.env.WINDIR ? path.join(process.env.WINDIR, 'Fonts') : 'C:\\Windows\\Fonts';
  let copied = 0;
  for (const file of ['arial.ttf', 'msyh.ttc']) {
    try { await fs.copyFile(path.join(systemFonts, file), path.join(fontsDir, file)); copied++; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (process.platform === 'win32' && copied === 0) throw new Error('找不到可用的 Windows 字体，无法烧录字幕。');
  const header = ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${project.width}`, `PlayResY: ${project.height}`,
    'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Arial,${project.subtitleStyle.fontSize},${assColor},${assColor},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,${outline},0,2,${marginX},${marginX},${marginY},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  const events = [...project.subtitles].sort((a, b) => a.start - b.start).map(subtitle =>
    `Dialogue: 0,${assTime(subtitle.start)},${assTime(subtitle.end)},Default,,0,0,0,,${assText(subtitle.text)}`);
  await fs.writeFile(path.join(scratch, 'subtitles.ass'), '\ufeff' + [...header, ...events, ''].join('\n'), 'utf8');
}

async function exportProject(project, output, { ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', workDir, cacheDir, onProgress, signal, settings } = {}) {
  // Simple and multi-track timelines now use exactly the same RGB compositor and color policy.
  // This avoids the old concat path's extra, implicitly tagged YUV conversion.
  return exportAdvancedProject(project, output, { ffmpeg, ffprobe, workDir, cacheDir, onProgress, signal, settings });
}

// Timeline-aware audio is shared by advanced video export and local speech recognition.
async function prepareMedia(project, destination, ffprobe, signal) {
  Model.validateProject(project);
  const snapshot = JSON.parse(JSON.stringify(project));
  const duration = Model.projectDuration(snapshot);
  if (!(duration > 0)) throw new Error('时间线为空，请先添加素材或字幕。');
  if (!path.isAbsolute(destination)) throw new Error('导出必须使用绝对路径。');
  const destinationKey = (await fs.realpath(destination).catch(error => { if (error.code === 'ENOENT') return path.resolve(destination); throw error; })).toLowerCase();
  const assets = new Map(snapshot.assets.map(a => [a.id, a])), media = new Map();
  // Validate every referenced placeholder before probing any source or creating a job.
  // An unused offline asset remains editable and must not block unrelated output.
  const usedAssetIds = new Set(snapshot.clips.map(clip => clip.assetId));
  const offlineAssets = snapshot.assets.filter(asset => usedAssetIds.has(asset.id) && asset.offline === true);
  if (offlineAssets.length) {
    const names = offlineAssets.map(asset => `「${asset.name}」`).join('、');
    throw new Error(`时间线使用了离线素材：${names}。请先在素材库中重新链接，再导出或识别字幕。`);
  }
  for (const clip of snapshot.clips) {
    checkAbort(signal);
    if (!media.has(clip.assetId)) {
      const asset = assets.get(clip.assetId), { resolved } = await localFile(asset.path);
      if (resolved.toLowerCase() === destinationKey) throw new Error('导出文件不能覆盖原始素材。');
      const probe = await readProbe(resolved, ffprobe, signal), actual = describe(resolved, probe);
      if ((asset.kind === 'audio' && !probe.audio) || (asset.kind !== 'audio' && !probe.video)) throw new Error(`素材内容已变化：${asset.name}`);
      media.set(asset.id, { ...probe, ...actual, path: resolved });
    }
    const info = media.get(clip.assetId);
    if (info.kind !== 'image' && clip.sourceIn + Model.clipSourceDuration(clip) > info.duration + 0.05) throw new Error(`素材时长已变化，请重新导入：${info.name}`);
  }
  return { snapshot, duration, media };
}
function transitionAudioFilter(project, clip) {
  if (clip.track !== 'video' || Model.clipLayer(clip) !== 0) return '';
  const main = project.clips.filter(c => c.track === 'video' && Model.clipLayer(c) === 0);
  const next = main[main.findIndex(c => c.id === clip.id) + 1];
  let filter = '';
  if (clip.transition) {
    const t = clip.transition, start = t.type === 'fadeblack' ? t.duration / 2 : 0, length = t.duration - start;
    filter += `,afade=t=in:st=${number(start)}:d=${number(length)}`;
  }
  if (next?.transition) {
    const t = next.transition, start = clip.duration - t.duration, length = t.duration / (t.type === 'fadeblack' ? 2 : 1);
    filter += `,afade=t=out:st=${number(start)}:d=${number(length)}`;
  }
  return filter;
}
async function renderTimelineAudio(project, media, duration, output, { ffmpeg, signal, scratch, sampleRate = 16000, channels = 1, onProgress, rangeStart=0, rangeEnd=duration }) {
  const inputs = ['-f', 'lavfi', '-i', `anullsrc=r=${SAMPLE_RATE}:cl=stereo`];
  const filters = [`[0:a]atrim=duration=${number(duration)},asetpts=PTS-STARTPTS[a0]`], mixes = ['[a0]'];
  let index = 1;
  for (const clip of project.clips) {
    const info = media.get(clip.assetId),factor=AudioModel.effectiveGain(project,clip);
    if (!info.audio || info.kind === 'image' || clip.volume === 0 || factor===0) continue;
    const audioClip=factor===1?clip:{...clip,volume:clip.volume*factor};
    let audioIndex=info.audio.index,preparedAudio;
    if(clip.speedCurve){
      const curved=await renderCurveClipAudio(clip,info,scratch,index,{ffmpeg,signal,onProgress});
      inputs.push('-f','f32le','-ar',String(SAMPLE_RATE),'-ac','2','-protocol_whitelist','file,pipe','-i',curved);audioIndex=0;
      preparedAudio=audioFilter({...audioClip,speed:1});
    }else{
      inputs.push('-ss',number(clip.sourceIn),'-t',number(Model.clipSourceDuration(clip)),'-protocol_whitelist','file,pipe','-i',info.path);preparedAudio=audioFilter(audioClip);
    }
    filters.push(`[${index}:${audioIndex}]${preparedAudio}${transitionAudioFilter(project, clip)},adelay=${Math.round(clip.start * SAMPLE_RATE)}S:all=1[a${index}]`);
    mixes.push(`[a${index++}]`);
  }
  filters.push(`${mixes.join('')}amix=inputs=${mixes.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false:latency=true,apad,atrim=duration=${number(duration)}[aout]`);
  if(rangeStart>0||rangeEnd<duration)filters[filters.length-1]=filters[filters.length-1].replace('[aout]',`,atrim=start=${number(rangeStart)}:end=${number(rangeEnd)},asetpts=PTS-STARTPTS[aout]`);
  const graph = path.join(scratch, 'audio-filter.txt'); await fs.writeFile(graph, filters.join(';'), 'utf8');
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_complex_threads', '2', '-progress', 'pipe:1', '-nostats',
    ...inputs, '-filter_complex_script', graph, '-map', '[aout]', '-vn', '-t', number(rangeEnd-rangeStart), '-c:a', 'pcm_s16le', '-ar', String(sampleRate), '-ac', String(channels), '-map_metadata', '-1', '-f', 'wav', output],
  { signal, onProgress: time => onProgress?.(Math.min(time, duration)) });
}
async function exportProjectAudio(project, output, { ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', workDir, onProgress, signal, sampleRate=16000, channels=1, settings } = {}) {
  if(![16000,44100,48000].includes(sampleRate)||![1,2].includes(channels))throw new Error('音频输出格式无效');
  if (path.extname(output).toLowerCase() !== '.wav') throw new Error('语音识别音轨必须导出为 WAV 文件。');
  const destination = path.resolve(output), prepared = await prepareMedia(project, output, ffprobe, signal),selection=ExportOptions.normalize({...settings,mode:'wav'},Model.projectDuration(project));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const workRoot = path.resolve(workDir || path.join(path.dirname(destination), 'work')); await fs.mkdir(workRoot, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(workRoot, 'audio-export-'));
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}-${randomUUID()}.partial.wav`);
  const emit = ratio => { try { onProgress?.({ ratio, time: prepared.duration * ratio, duration: prepared.duration, phase: 'audio' }); } catch {} };
  try {
    emit(0);
    await renderTimelineAudio(prepared.snapshot, prepared.media, prepared.duration, temporary, { ffmpeg, signal, scratch, sampleRate, channels, rangeStart:selection.rangeStart,rangeEnd:selection.rangeEnd, onProgress: time => emit(Math.min(0.99, time / prepared.duration)) });
    checkAbort(signal);
    const probe = await readProbe(temporary, ffprobe, signal);
    if (!probe.audio || Number(probe.audio.sample_rate) !== sampleRate || probe.audio.channels !== channels || Math.abs(Number(probe.data.format?.duration) - selection.duration) > 0.1) throw new Error('语音识别音轨校验失败。');
    checkAbort(signal);
    await fs.rename(temporary, destination); emit(1);
    return { output: destination, duration: selection.duration, sampleRate, channels };
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}


// Expressions share evaluateTransform's implicit base pose and sliced easing interval.
function easedRatioExpression(key, progress) {
  const [a, b] = key.easingWindow || [0, 1], span = b - a, easing = key.easing;
  // Curve intervals can be far smaller than a nanosecond after repeated slicing.
  // Use round-trip precision and the model's factored differences, never round a
  // nonzero easing denominator to zero via the ordinary timeline formatter.
  const n = value => Number(value).toString(), t = `(${progress})`;
  if (easing === 'hold') return `gte(${progress},1)`;
  if (easing === 'ease-in' || (easing === 'ease-in-out' && b <= 0.5)) return `(${t}*(${n(2 * a)}+${n(span)}*${t})/${n(a + b)})`;
  if (easing === 'ease-out' || (easing === 'ease-in-out' && a >= 0.5)) return `(${t}*(${n(2 * (1 - a))}-${n(span)}*${t})/${n((1 - a) + (1 - b))})`;
  if (easing === 'ease-in-out') {
    const u = `(${n(a)}+${n(span)}*${t})`, left = 2 * (0.5 - a) * (0.5 + a), right = 2 * (b - 0.5) * (1.5 - b);
    return `(if(lte(${u},0.5),2*${n(span)}*${t}*(${n(a)}+${u}),${n(left)}+2*(${u}-0.5)*(1.5-${u}))/${n(left + right)})`;
  }
  return progress;
}
function poseExpression(clip, field) {
  const defaults = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
  const keys = [{ time: 0, [field]: clip.transform?.[field] ?? defaults[field] }];
  for (const key of clip.keyframes || []) { if (key.time === 0) keys[0] = key; else keys.push(key); }
  let expr = number(keys.at(-1)[field]);
  for (let index = keys.length - 2; index >= 0; index--) {
    const a = keys[index], b = keys[index + 1];
    const ratio = easedRatioExpression(b, `clip((T-${number(a.time)})/${number(b.time - a.time)},0,1)`);
    const interpolation = Math.abs(a[field] - b[field]) < 1e-12 ? number(a[field])
      : `(${number(a[field])}+(${number(b[field] - a[field])})*(${ratio}))`;
    expr = `if(lt(T,${number(b.time)}),${interpolation},${expr})`;
  }
  return expr;
}
function transitionOpacityExpression(project, clip) {
  let expression = '1';
  if (Model.clipLayer(clip) !== 0) return expression;
  if (clip.transition) {
    const t = clip.transition;
    expression += t.type === 'crossfade' ? `*min(1,T/${number(t.duration)})` : `*clip(T*2/${number(t.duration)}-1,0,1)`;
  }
  const main = project.clips.filter(c => c.track === 'video' && Model.clipLayer(c) === 0);
  const next = main[main.findIndex(c => c.id === clip.id) + 1];
  if (next?.transition?.type === 'fadeblack') expression += `*clip(1-(T-${number(clip.duration - next.transition.duration)})*2/${number(next.transition.duration)},0,1)`;
  return expression;
}
function transformFilter(project, clip, phase = 0) {
  const expressions = Object.fromEntries(['x', 'y', 'scale', 'rotation'].map(field => [field, phase?poseExpression(clip, field).replace(/\bT\b/g,`(T+${Number(phase).toString()})`):poseExpression(clip, field)]));
  const geometry = ['x', 'y', 'scale', 'rotation'].some(field => expressions[field] !== (field === 'scale' ? '1' : '0'));
  if (!geometry) return '';
  // Perspective evaluates the affine corner mapping once per frame. A transparent two-pixel
  // guard around the source makes its edge-clamped sampler transparent outside the artwork.
  // Crop the guard after transformation so x/y stay normalized to the actual project canvas.
  const perFrame = field => expressions[field].replace(/\bT\b/g, `((on-1)/${number(project.fps)})`);
  const common = `st(0,(${perFrame('rotation')})*PI/180);st(1,${perFrame('scale')});st(2,(${perFrame('x')})*(W-4));st(3,(${perFrame('y')})*(H-4));`;
  const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const mapping = corners.flatMap(([x, y], i) => [
    `x${i}='${common}W/2+ld(2)+ld(1)*(${x}*W/2*cos(ld(0))-${y}*H/2*sin(ld(0)))'`,
    `y${i}='${common}H/2+ld(3)+ld(1)*(${x}*W/2*sin(ld(0))+${y}*H/2*cos(ld(0)))'`
  ]).join(':');
  const geometryFilter = `,pad=iw+4:ih+4:2:2:color=black@0,format=gbrap,perspective=${mapping}:sense=destination:eval=frame:interpolation=linear,crop=iw-4:ih-4:2:2`;
  return geometryFilter;

}
// Alpha is spatially uniform after the geometry transform. Evaluate its time
// curve once per output frame, then use a 256-entry LUT instead of evaluating
// the complete easing expression for every pixel and copying all RGB channels.
async function opacityFilter(project, clip, scratch, index, signal, phase = 0) {
  const alpha = `(${poseExpression(clip, 'opacity')})*(${transitionOpacityExpression(project, clip)})`;
  if (alpha === '(1)*(1)') return '';
  if (!/\bT\b/.test(alpha)) return `,format=gbrap,lutrgb=a='val*${alpha}'`;
  const commands = [], count = Math.max(1, Math.ceil(clip.duration * project.fps - 1e-9));
  for (let frame = 0; frame < count; frame++) {
    // Preserve the legacy expression and operation order exactly. Rounding a
    // JS-evaluated scalar first can change a floor by one alpha code value.
    const expression = alpha.replace(/\bT\b/g, `(${frame}/${number(project.fps)}+${Number(phase).toString()})`);
    commands.push(`${number(Math.max(0, (frame - 0.25) / project.fps))} lutrgb@opacity a 'val*${expression}';`);
    if (frame % 4096 === 4095) { checkAbort(signal); await new Promise(resolve => setImmediate(resolve)); }
  }
  checkAbort(signal);
  const filename = `opacity-${index}.txt`; await fs.writeFile(path.join(scratch, filename), commands.join('\n') + '\n');
  return `,format=gbrap,sendcmd=f=${filename},lutrgb@opacity=a=val`;
}

// A mask is static in cropped-source space. Build its 8-bit coverage once per
// distinct mask/size and reuse it for all video frames. LUT2 multiplies coverage
// by the original source alpha (including transparent PNGs), never replaces it.
async function maskCoverageFile(info, clip, scratch, signal, ffmpeg) {
  const rect = Model.cropRect(info, clip);
  const key = createHash('sha256').update(JSON.stringify([rect.width, rect.height, clip.mask])).digest('hex').slice(0,24);
  const filename = `mask-${key}.pgm`, file = path.join(scratch, filename);
  try { await fs.access(file); return filename; } catch(error) { if(error.code!=='ENOENT') throw error; }
  // Evaluate precisely the legacy FFmpeg expression, once on opaque white.
  // This retains its 9-decimal constants and 8-bit flooring, rather than adding
  // another quantization or changing rotated/feathered boundary coverage.
  await run(ffmpeg, ['-hide_banner','-loglevel','error','-nostdin','-y','-filter_threads','2',
    '-f','lavfi','-i',`color=c=white@1:s=${rect.width}x${rect.height}:r=1,format=rgba`,
    '-vf',maskFilter(clip).slice(1)+',alphaextract','-frames:v','1','-c:v','pgm','-threads','2',filename], {cwd:scratch,signal});
  return filename;
}

function coverageGraph(source, destination) {
  return `${source}format=gbrap,split=2[maskRgb][maskSourceAlpha];[maskSourceAlpha]alphaextract[sourceAlpha];[1:v]format=gray[maskCoverage];[sourceAlpha][maskCoverage]lut2=c0='x*y/255'[maskedAlpha];[maskRgb][maskedAlpha]alphamerge${destination}`;
}

async function exportAdvancedProject(project, output, { ffmpeg, ffprobe, workDir, cacheDir, onProgress, signal, settings }) {
  if (path.extname(output).toLowerCase() !== '.mp4') throw new Error('导出路径必须是本地 MP4 文件的绝对路径。');
  const destination = path.resolve(output), { snapshot, duration, media } = await prepareMedia(project, output, ffprobe, signal);
  const selection=ExportOptions.normalize(settings,duration),capabilities=selection.encoder==='software'?{nvenc:false}:await ExportOptions.probeEncoders(ffmpeg,{signal});
  let chosenEncoder=selection.encoder!=='software'&&capabilities.nvenc?'h264_nvenc':'libx264',fallbackReason=selection.encoder==='nvenc'&&!capabilities.nvenc?capabilities.reason:null;
  if (snapshot.width % 2 || snapshot.height % 2) throw new Error('MP4 导出的画面宽高必须是偶数。');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const workRoot = path.resolve(workDir || path.join(path.dirname(destination), 'work')); await fs.mkdir(workRoot, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(workRoot, 'advanced-export-'));
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination, '.mp4')}-${randomUUID()}.partial.mp4`);
  const clips = snapshot.clips.filter(c => c.track === 'video' && (!c.speedCurve || Math.ceil((c.start+c.duration)*snapshot.fps-1e-9)>Math.ceil(c.start*snapshot.fps-1e-9))).sort((a, b) => Model.clipLayer(a) - Model.clipLayer(b));
  const clipWork = clips.reduce((sum, c) => sum + c.duration, 0), totalWork = clipWork + duration * 1.2;
  let processed = 0, lastRatio = 0;
  const emit = (amount, phase) => { const ratio = Math.max(lastRatio, Math.min(0.999, amount / totalWork)); lastRatio = ratio;
    try { onProgress?.({ ratio, time: ratio * duration, duration, phase }); } catch {} };
  const base = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_complex_threads', '2', '-progress', 'pipe:1', '-nostats'];
  try {
    emit(0, 'preparing');
    // Re-probe from approved original paths; renderer-supplied previewPath is never used.
    for (const info of media.values()) {
      checkAbort(signal);
      if (info.kind === 'image') Color.policy(info);
      if (info.kind === 'video' && clips.some(c => media.get(c.assetId) === info)) {
        info.videoPath = await Color.ensureProxy(info, { ffmpeg, ffprobe, cacheDir:cacheDir || scratch, run, readProbe, signal,
          onProgress:progress=>{try{onProgress?.({ratio:0,time:0,duration,phase:'preparing',message:progress.message});}catch{}} });
      }
    }
    const files = [];
    for (let index = 0; index < clips.length; index++) {
      checkAbort(signal);
      const clip = clips[index], info = media.get(clip.assetId), name = `layer-${index}.mkv`;
      const firstFrame=Math.ceil(clip.start*snapshot.fps-1e-9),phase=clip.speedCurve?Math.max(0,firstFrame/snapshot.fps-clip.start):0,frameCount=Math.ceil((clip.duration-phase)*snapshot.fps-1e-9);
      let inputs, vf;
      const grading = await colorFilter(clip, scratch, signal);
      const fit = `scale=${snapshot.width}:${snapshot.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,format=rgba,pad=${snapshot.width}:${snapshot.height}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1`;
      const newEffects=Boolean(clip.visualEffects?.chromaKey||clip.maskAnimation||clip.mask&&(clip.mask.expansion||clip.mask.roundness));
      if(newEffects){
        const seek=clip.speedCurve?Math.max(0,clip.sourceIn-.5):clip.sourceIn;
        inputs=info.kind==='image'?['-loop','1','-framerate',number(snapshot.fps),'-i',info.path]:[...(clip.speedCurve?['-copyts']:[]),'-ss',number(seek),'-t',number(Model.clipSourceDuration(clip)+clip.sourceIn-seek+(clip.speedCurve?.25:0)),...(info.hasAlpha?['-c:v','libvpx-vp9']:[]),'-i',info.videoPath];
        if(info.kind==='image'&&!clip.maskAnimation){
          const still='new-still-'+createHash('sha256').update(JSON.stringify([info.path,clip.crop,clip.flipX,clip.flipY,clip.mask,clip.visualEffects,clip.color,clip.advancedColor,snapshot.width,snapshot.height])).digest('hex').slice(0,24)+'.png';
          try{await fs.access(path.join(scratch,still));}catch(error){if(error.code!=='ENOENT')throw error;const staticFilter=Color.inputRgbFilter('image')+','+sourceGeometryFilter(info,clip,true)+'format=rgba'+VisualTools.chromaFilter(clip.visualEffects)+grading+VisualTools.maskFilter(clip)+','+(clip.flipX?'hflip,':'')+(clip.flipY?'vflip,':'')+fit+',format=rgba';await run(ffmpeg,[...base,'-i',info.path,'-vf',staticFilter,'-frames:v','1','-threads','2',still],{cwd:scratch,signal});}
          inputs=['-loop','1','-framerate',number(snapshot.fps),'-i',still];vf='[0:v]setpts=PTS-STARTPTS,format=rgba';
        }else{
          const first=`[0:v]${info.kind==='image'?'setpts=PTS-STARTPTS':(clip.speedCurve?'tpad=stop_mode=clone:stop_duration=0.25,':'')+videoTimeFilter(clip,phase)},${Color.inputRgbFilter(info.kind)},`;
          if(clip.mask&&!clip.maskAnimation){const crop=Model.cropRect(info,clip),maskFile=path.join(scratch,'mask-new-'+createHash('sha256').update(JSON.stringify([clip.mask,crop.width,crop.height])).digest('hex').slice(0,24)+'.pgm');try{await fs.access(maskFile);}catch(error){if(error.code!=='ENOENT')throw error;const raw=sourceMaskCache.raster(clip.mask,crop.width,crop.height);checkAbort(signal);await fs.writeFile(maskFile,Buffer.concat([Buffer.from(`P5\n${crop.width} ${crop.height}\n255\n`),raw]));}inputs.push('-i',maskFile);vf=first+sourceGeometryFilter(info,clip,true)+'format=rgba'+VisualTools.chromaFilter(clip.visualEffects)+grading+'[source];'+coverageGraph('[source]','[masked]')+';[masked]'+(clip.flipX?'hflip,':'')+(clip.flipY?'vflip,':'')+fit;}
          else vf=first+sourceGeometryFilter(info,clip,true)+'format=rgba'+VisualTools.chromaFilter(clip.visualEffects)+grading+VisualTools.maskFilter(clip,{timeOffset:phase})+','+(clip.flipX?'hflip,':'')+(clip.flipY?'vflip,':'')+fit;
        }
      } else if(info.kind==='image') {
        // A still image's crop, grade, mask and fit do not change with time.
        // Rasterize the exact old chain once, losslessly, before looping it.
        const still = `still-${index}.png`;
        const sourceEffects = clip.mask ? sourceGeometryFilter(info,clip,true)+'format=rgba'+grading+maskFilter(clip)+','+(clip.flipX?'hflip,':'')+(clip.flipY?'vflip,':'') : sourceGeometryFilter(info,clip);
        const staticFilter=Color.inputRgbFilter('image')+','+sourceEffects+fit+(clip.mask?'':grading)+',format=rgba';
        await run(ffmpeg,[...base,'-protocol_whitelist','file,pipe','-i',info.path,'-vf',staticFilter,'-frames:v','1','-threads','2',still],{cwd:scratch,signal});
        inputs=['-loop','1','-framerate',number(snapshot.fps),'-protocol_whitelist','file,pipe','-i',still];
        vf='[0:v]setpts=PTS-STARTPTS,format=rgba';
      } else {
        const seek=clip.speedCurve?Math.max(0,clip.sourceIn-.5):clip.sourceIn;
        inputs=[...(clip.speedCurve?['-copyts']:[]),'-ss',number(seek),'-t',number(Model.clipSourceDuration(clip)+clip.sourceIn-seek+(clip.speedCurve ? 0.25 : 0)),'-protocol_whitelist','file,pipe',...(info.hasAlpha?['-c:v','libvpx-vp9']:[]),'-i',info.videoPath];
        const first=`[0:v:0]${clip.speedCurve?'tpad=stop_mode=clone:stop_duration=0.25,':''}${videoTimeFilter(clip,phase)},${Color.inputRgbFilter('video')},`;
        if(clip.mask) {
          const coverage=await maskCoverageFile(info,clip,scratch,signal,ffmpeg);inputs.push('-protocol_whitelist','file,pipe','-i',coverage);
          vf=first+sourceGeometryFilter(info,clip,true)+'format=rgba'+grading+'[source];'+coverageGraph('[source]','[masked]')+';[masked]'+(clip.flipX?'hflip,':'')+(clip.flipY?'vflip,':'')+fit;
        } else vf=first+sourceGeometryFilter(info,clip)+fit+grading;
      }
      const opacity=await opacityFilter(snapshot,clip,scratch,index,signal,phase);
      vf+=`,fps=${number(snapshot.fps)}${clip.speedCurve?':round=up:start_time=0':''},tpad=stop_mode=clone:stop_duration=${number(clip.duration)},${clip.speedCurve?`trim=end_frame=${frameCount}`:`trim=duration=${number(clip.duration)}`},setpts=PTS-STARTPTS`+transformFilter(snapshot,clip,phase)+opacity+(clip.speedCurve?`,tpad=stop_mode=clone:stop_duration=${number(2/snapshot.fps)}`:'')+',format=bgra[v]';
      const graph = `layer-${index}.txt`; await fs.writeFile(path.join(scratch, graph), vf, 'utf8');
      await run(ffmpeg, [...base, ...inputs, '-filter_complex_script', graph, '-map', '[v]', '-an', ...(clip.speedCurve?['-frames:v',String(frameCount+1)]:['-t',number(clip.duration)]), '-c:v', 'ffv1', '-level', '3', '-threads', '2', '-pix_fmt', 'bgra', '-map_metadata', '-1', name],
        { cwd: scratch, signal, onProgress: time => emit(processed + Math.min(time, clip.duration), 'rendering') });
      files.push(name); processed += clip.duration; emit(processed, 'rendering');
    }
    const audioFile = path.join(scratch, 'timeline.wav');
    await renderTimelineAudio(snapshot, media, duration, audioFile, { ffmpeg, signal, scratch, sampleRate: SAMPLE_RATE, channels: 2,
      onProgress: time => emit(clipWork + time * 0.2, 'audio') });
    const inputs = ['-f', 'lavfi', '-i', `color=c=black:s=${snapshot.width}x${snapshot.height}:r=${number(snapshot.fps)}:d=${number(duration)}`];
    const filters = ['[0:v]format=rgba[base0]'];
    for (let index = 0; index < clips.length; index++) {
      const clip = clips[index]; inputs.push('-i', files[index]);
      const layerClock=clip.speedCurve?`settb=expr=1/${number(snapshot.fps*1000000)},setpts=(N+${Math.ceil(clip.start*snapshot.fps-1e-9)})*1000000`:`setpts=PTS-STARTPTS+${number(clip.start)}/TB`;
      const blendMode=clip.visualEffects?.blendMode||'normal';
      // Keep a look-ahead frame available until the explicit non-frame clip end.
      const blendTail=`tpad=stop_mode=clone:stop_duration=${number(2/snapshot.fps)},`;
      filters.push(`[${index + 1}:v]${blendTail}${layerClock}[layer${index}]`);
      if(blendMode==='normal') filters.push(`[base${index}][layer${index}]overlay=0:0:format=auto:eof_action=pass:repeatlast=0:enable='gte(t,${number(clip.start)})*lt(t,${number(clip.start + clip.duration)})'[base${index + 1}]`);
      else filters.push(...VisualTools.blendCompositeFilters({index,mode:blendMode,width:snapshot.width,height:snapshot.height,fps:snapshot.fps,duration,start:clip.start,end:clip.start+clip.duration}));
    }
    inputs.push('-i', audioFile);
    let finalVideo = `[base${clips.length}]`;
    if(TextStyle.usesCanvas(snapshot)){const textLayer=await require('./text-render.cjs').renderTextOverlay(snapshot,{scratch,ffmpeg,signal,onProgress:()=>{}});if(textLayer){inputs.push('-i',textLayer.path);filters.push(`${finalVideo}[${clips.length+2}:v]overlay=0:0:format=auto:eof_action=pass:repeatlast=0[styledtext]`);finalVideo='[styledtext]';}}
    else if (snapshot.subtitles.length) { await writeSubtitles(snapshot, scratch); filters.push(`${finalVideo}ass=filename=subtitles.ass:fontsdir=fonts[subtitled]`); finalVideo = '[subtitled]'; }
    filters.push(`${finalVideo}${Color.outputFilter()}[vout]`); finalVideo = '[vout]';
    await fs.writeFile(path.join(scratch, 'composite.txt'), filters.join(';'), 'utf8');
    const encode=encoder=>run(ffmpeg,[...base,...inputs,'-filter_complex_script','composite.txt','-map',finalVideo,'-map',`${clips.length+1}:a`,...(selection.rangeStart>0?['-ss',number(selection.rangeStart)]:[]),'-t',number(selection.duration),'-r',number(snapshot.fps),...ExportOptions.videoArgs(selection,encoder),...Color.outputArgs(),'-threads','2','-c:a','aac','-b:a','192k','-ar',String(SAMPLE_RATE),'-ac','2','-movflags','+faststart+write_colr','-map_metadata','-1','-f','mp4',temporary],{cwd:scratch,signal,onProgress:time=>emit(clipWork+duration*.2+Math.min(time,duration),'finalizing')});
    try{await encode(chosenEncoder);}catch(error){if(chosenEncoder==='libx264'||error.name==='AbortError')throw error;fallbackReason='硬件编码失败，已自动改用软件：'+error.message;chosenEncoder='libx264';try{onProgress?.({ratio:lastRatio,message:fallbackReason,phase:'finalizing'});}catch{}await encode(chosenEncoder);}
    checkAbort(signal);
    const verified = await readProbe(temporary, ffprobe, signal), renderedDuration = Number(verified.data.format?.duration);
    Color.verifyWorking(verified.video);
    if (!verified.video || !verified.audio || verified.video.width !== snapshot.width || verified.video.height !== snapshot.height || !Number.isFinite(renderedDuration) || Math.abs(renderedDuration - selection.duration) > Math.max(0.15, 2 / snapshot.fps)) throw new Error('导出校验失败：画幅、音轨或时长与时间线不一致。');
    checkAbort(signal);
    await fs.rename(temporary, destination);
    try { onProgress?.({ ratio: 1, time: duration, duration, phase: 'complete' }); } catch {}
    return { output: destination, duration:selection.duration,rangeStart:selection.rangeStart,rangeEnd:selection.rangeEnd,encoder:chosenEncoder,fallbackReason, renderedDuration, width: snapshot.width, height: snapshot.height, fps: snapshot.fps };
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { probeMedia, exportProject, exportProjectAudio, exportProjectAudio16kWAV: exportProjectAudio };