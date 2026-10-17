'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Model = require('../src/shared/project.js');

function asset(project, id, kind = 'video', duration = 12) {
  return Model.addAsset(project, {
    id, name: id + '.mp4', path: '/fixtures/' + id, kind, duration,
    width: kind === 'audio' ? 0 : 1920, height: kind === 'audio' ? 0 : 1080,
    hasAudio: kind !== 'image'
  });
}
function base() { return asset(Model.createProject('中文项目'), 'movie'); }
function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  return value;
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }

test('UMD exposes the same project API without Node globals', () => {
  const context = vm.createContext({ window: {} });
  for (const file of ['time-map.js','advanced-color.js','audio-model.js','text-style.js','visual-effects.js','project.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/shared', file), 'utf8'), context);
  }
  assert.equal(typeof context.window.EditorModel.splitClip, 'function');
  assert.equal(context.window.EditorModel.createProject('浏览器').schemaVersion, 1);
});

test('project mutations accept frozen inputs and leave nested data untouched', () => {
  let project = Model.addClip(base(), 'movie');
  project = Model.addSubtitle(project, { start: 0, end: 2, text: '你好' });
  const snapshot = copy(project);
  deepFreeze(project);
  const next = Model.updateClip(project, project.clips[0].id, { volume: 0.4, duration: 8 });
  assert.deepEqual(project, snapshot);
  assert.notEqual(next.assets, project.assets);
  assert.notEqual(next.clips[0], project.clips[0]);
  assert.equal(next.clips[0].volume, 0.4);
  assert.equal(Model.validateProject(next), next);
});

test('splitting uses absolute timeline time and respects source in point and speed', () => {
  let project = asset(base(), 'intro', 'image');
  project = Model.addClip(project, 'intro');
  project = Model.addClip(project, 'movie');
  const id = project.clips[1].id;
  project = Model.updateClip(project, id, { sourceIn: 2, duration: 4, speed: 2 });
  const result = Model.splitClip(project, id, 6.5);
  assert.equal(result.clips.length, 3);
  assert.deepEqual(result.clips.map(c => [c.start, c.duration, c.sourceIn]), [[0, 5, 0], [5, 1.5, 2], [6.5, 2.5, 5]]);
  assert.notEqual(result.clips[1].id, result.clips[2].id);
  assert.equal(Model.projectDuration(result), Model.projectDuration(project));
  assert.throws(() => Model.splitClip(project, id, 5), /内部/);
  assert.throws(() => Model.splitClip(project, id, 9), /内部/);
});

test('speed-only edits preserve source span and ripple following video clips', () => {
  let project = Model.addClip(base(), 'movie');
  project = Model.addClip(project, 'movie');
  const first = project.clips[0].id;
  project = Model.updateClip(project, first, { speed: 2 });
  assert.equal(project.clips[0].duration, 6);
  assert.equal(project.clips[1].start, 6);
  project = Model.updateClip(project, first, { speed: 0.25 });
  assert.equal(project.clips[0].duration, 48);
  assert.equal(project.clips[1].start, 48);
  assert.equal(project.clips[0].duration * project.clips[0].speed, 12);
});

test('video insertion, reorder, removal and trim ripple in video array order', () => {
  let project = asset(asset(base(), 'second', 'image'), 'third', 'image');
  project = Model.addClip(project, 'movie');
  project = Model.addClip(project, 'second');
  project = Model.addClip(project, 'third', 2);
  assert.deepEqual(project.clips.map(c => c.assetId), ['movie', 'third', 'second']);
  assert.deepEqual(project.clips.map(c => c.start), [0, 12, 17]);
  project = Model.reorderClip(project, project.clips[2].id, -1);
  assert.deepEqual(project.clips.map(c => c.assetId), ['movie', 'second', 'third']);
  project = Model.removeClip(project, project.clips[0].id);
  assert.deepEqual(project.clips.map(c => c.start), [0, 5]);
  project = Model.updateClip(project, project.clips[0].id, { duration: 30 });
  assert.deepEqual(project.clips.map(c => c.start), [0, 30]);
  assert.equal(Model.projectDuration(project), 35);
});

test('audio placement and reorder remain independent of video ripple', () => {
  let project = asset(base(), 'music', 'audio', 30);
  project = Model.addClip(project, 'movie');
  project = Model.addClip(project, 'music', 7);
  project = Model.addClip(project, 'music', 2);
  const videoId = project.clips[0].id;
  const audioId = project.clips[2].id;
  project = Model.updateClip(project, videoId, { duration: 3 });
  project = Model.reorderClip(project, audioId, -1);
  assert.deepEqual(project.clips.filter(c => c.track === 'audio').map(c => c.start), [2, 7]);
  assert.equal(Model.projectDuration(project), 37);
  project = Model.splitClip(project, audioId, 12);
  assert.deepEqual(project.clips.filter(c => c.track === 'audio').map(c => [c.start, c.sourceIn]), [[2, 0], [12, 10], [7, 0]]);
});

test('model rejects missing refs, duplicate IDs, invalid tracks and source boundaries', () => {
  const project = Model.addClip(base(), 'movie');
  const id = project.clips[0].id;
  assert.throws(() => Model.updateClip(project, id, { duration: 12.01 }), /源区间/);
  assert.throws(() => Model.updateClip(project, id, { sourceIn: 1 }), /源区间/);
  assert.throws(() => Model.updateClip(project, id, { speed: 0 }), /播放速度/);
  assert.throws(() => Model.updateClip(project, id, { speed: 4.1 }), /播放速度/);
  assert.throws(() => Model.updateClip(project, id, { volume: 2.1 }), /音量/);
  assert.throws(() => Model.updateClip(project, id, { duration: Infinity }), /有限数值/);
  assert.throws(() => Model.updateClip(project, id, { duration: undefined }), /有限数值/);
  assert.throws(() => Model.updateClip(project, id, { start: 1 }), /连续排列/);
  assert.throws(() => Model.addClip(project, 'missing'), /不存在/);
  for (const change of [
    p => { p.clips[0].assetId = 'missing'; },
    p => { p.clips[0].track = 'audio'; },
    p => { p.clips[0].start = 1; },
    p => { p.clips[0].id = p.assets[0].id; },
    p => { p.clips[0].duration = NaN; },
    p => { p.assets[0].duration = -1; }
  ]) {
    const broken = copy(project);
    change(broken);
    assert.throws(() => Model.validateProject(broken));
  }
});

test('subtitles contribute duration and edits remain immutable', () => {
  const empty = Model.createProject('字幕');
  const project = Model.addSubtitle(empty, { start: 2, end: 4, text: '第一行\n第二行' });
  const cue = project.subtitles[0];
  const next = Model.updateSubtitle(project, cue.id, { end: 7, text: '更新' });
  assert.equal(Model.projectDuration(next), 7);
  assert.equal(cue.end, 4);
  assert.equal(Model.removeSubtitle(next, cue.id).subtitles.length, 0);
  assert.throws(() => Model.addSubtitle(empty, { start: 2, end: 2, text: '无效' }), /晚于/);
});

test('Chinese multiline SRT parses BOM and CRLF, sorts safely and roundtrips', () => {
  const input = '\uFEFF1\r\n00:00:01,250 --> 00:00:03,750\r\n你好，世界\r\n第二行\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,125\r\n结束\r\n';
  const cues = Model.parseSrt(input);
  assert.deepEqual(cues, [
    { start: 1.25, end: 3.75, text: '你好，世界\n第二行' },
    { start: 5, end: 6.125, text: '结束' }
  ]);
  const reversed = [cues[1], cues[0]];
  const result = Model.toSrt(reversed);
  assert.deepEqual(Model.parseSrt(result), cues);
  assert.equal(reversed[0], cues[1]);
  assert.equal(Model.toSrt([]), '');
  assert.deepEqual(Model.parseSrt('  '), []);
  assert.throws(() => Model.parseSrt('1\n00:61:00,000 --> 00:62:00,000\n坏时间'), /时间格式/);
  assert.throws(() => Model.parseSrt('1\n00:00:03,000 --> 00:00:02,000\n倒序'), /晚于/);
});



// Real local FFmpeg integration: generated fixtures make timeline/audio assertions reproducible.
test('FFmpeg renders letterbox, timing, audio gain, Chinese subtitles and cancellation safely', { timeout: 120000 }, async t => {
  const { spawnSync } = require('node:child_process');
  const { createHash } = require('node:crypto');
  const fsp = require('node:fs/promises');
  const media = require('../src/main/media.cjs');
  const ffmpeg = process.env.FFMPEG_PATH || (process.platform === 'win32' ? require('../scripts/test-env.cjs').ffmpeg() : 'ffmpeg');
  let ffprobe;
  try { ffprobe = process.env.FFPROBE_PATH || require('ffprobe-static').path; }
  catch { t.skip('ffprobe-static is not installed'); return; }
  if (spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status !== 0) { t.skip('FFmpeg is not installed'); return; }
  const workRoot = path.resolve(__dirname, '../work');
  await fsp.mkdir(workRoot, { recursive: true });
  const directory = await fsp.mkdtemp(path.join(workRoot, 'core-media-test-'));
  function run(args, encoding) {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args],
      { windowsHide: true, shell: false, encoding, timeout: 30000, maxBuffer: 12 * 1024 * 1024 });
    assert.equal(result.status, 0, result.error?.message || result.stderr?.toString());
    return result.stdout;
  }
  const portrait = path.join(directory, '竖屏无声.mp4');
  const still = path.join(directory, '蓝色图片.png');
  const audio = path.join(directory, '纯音.wav');
  const output = path.join(directory, '验收结果.mp4');
  const options = { ffmpeg, ffprobe, workDir: directory, cacheDir: path.join(directory, 'thumbnails') };
  try {
    run(['-f', 'lavfi', '-i', 'color=c=red:s=180x320:r=30:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '2', portrait]);
    run(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180', '-frames:v', '1', still]);
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:a', 'pcm_s16le', audio]);
    const assets = [];
    for (const file of [portrait, still, audio]) assets.push(await media.probeMedia(file, options));
    assert.deepEqual(assets.map(a => [a.kind, a.hasAudio]), [['video', false], ['image', false], ['audio', true]]);
    assert.ok(assets[0].thumbnail.startsWith('data:image/jpeg;base64,'));
    assert.equal(assets[2].thumbnail, '');
    assert.equal(assets[0].videoCodec, 'h264');
    let project = Model.createProject('生成素材验收');
    project.width = 320; project.height = 180; project.subtitleStyle.fontSize = 24;
    for (const a of assets) project = Model.addAsset(project, a);
    project = Model.addClip(project, assets[0].id);
    project = Model.updateClip(project, project.clips[0].id, { sourceIn: 0.1, speed: 2, duration: 0.4 });
    project = Model.addClip(project, assets[1].id);
    project = Model.updateClip(project, project.clips[1].id, { duration: 0.4 });
    project = Model.addClip(project, assets[2].id, 0.2);
    project = Model.updateClip(project, project.clips[2].id, { sourceIn: 0.1, speed: 0.5, duration: 1, volume: 0.5 });
    project = Model.addSubtitle(project, { start: 0.45, end: 0.75, text: '你好，映序剪辑' });
    const progress = [];
    const result = await media.exportProject(project, output, { ...options, onProgress: p => progress.push(p) });
    assert.equal(result.duration, 1.2);
    assert.ok(Math.abs(result.renderedDuration - 1.2) < 0.05);
    assert.equal(progress.at(-1).ratio, 1);
    assert.ok(progress.every((p, i) => i === 0 || p.ratio >= progress[i - 1].ratio));
    function frame(time) {
      return run(['-ss', String(time), '-i', output, '-frames:v', '1', '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    }
    const early = frame(0.1);
    assert.equal(early.length, 320 * 180 * 3);
    const pixel = (data, x, y) => [...data.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
    assert.ok(pixel(early, 5, 80).every(v => v < 12), 'portrait must be letterboxed');
    assert.ok(pixel(early, 160, 80)[0] > 180 && pixel(early, 160, 80)[1] < 60, 'center retains red source');
    const subtitled = frame(0.6);
    let whitePixels = 0;
    for (let y = 100; y < 174; y++) for (let x = 12; x < 308; x++) {
      const rgb = pixel(subtitled, x, y);
      if (rgb.every(v => v > 190)) whitePixels++;
    }
    assert.ok(whitePixels > 80, 'Chinese subtitle must be burned into blue image frames');
    const tail = frame(1.05);
    assert.ok(pixel(tail, 160, 80).every(v => v < 12), 'audio-only tail uses black, not a frozen image');
    const decoded = run(['-i', output, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
    function rms(start, end) {
      let power = 0, count = 0;
      for (let i = Math.round(start * 48000); i < Math.round(end * 48000); i++) {
        const value = decoded.readFloatLE(i * 4); power += value * value; count++;
      }
      return Math.sqrt(power / count);
    }
    assert.ok(rms(0.03, 0.13) < 0.002, 'audio clip starts at 0.2 seconds');
    const audible = rms(0.3, 0.6);
    assert.ok(audible > 0.025 && audible < 0.065, `gain and tempo preserve audible amplitude (${audible})`);
    const originalHash = createHash('sha256').update(await fsp.readFile(portrait)).digest('hex');
    await assert.rejects(media.exportProject(project, portrait, options), /覆盖原始素材/);
    assert.equal(createHash('sha256').update(await fsp.readFile(portrait)).digest('hex'), originalHash);

    // Fractional-frame cuts must use model durations, not each segment container duration.
    let fractional = Model.createProject('非整帧连续切点'); fractional.width = 320; fractional.height = 180;
    for (const a of assets.slice(0, 2)) fractional = Model.addAsset(fractional, a);
    for (let i = 0; i < 6; i++) {
      fractional = Model.addClip(fractional, assets[i % 2].id);
      fractional = Model.updateClip(fractional, fractional.clips.at(-1).id, { duration: 0.11 });
    }
    const fractionalOutput = path.join(directory, 'fractional.mp4');
    await media.exportProject(fractional, fractionalOutput, options);
    const nearFifth = run(['-ss', '0.45', '-i', fractionalOutput, '-frames:v', '1', '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    assert.ok(pixel(nearFifth, 160, 80)[0] > 180 && pixel(nearFifth, 160, 80)[2] < 60,
      'fifth clip starts at model time 0.44, without per-segment rounding drift');
    const nearSixth = run(['-ss', '0.57', '-i', fractionalOutput, '-frames:v', '1', '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    assert.ok(pixel(nearSixth, 160, 80)[2] > 180 && pixel(nearSixth, 160, 80)[0] < 60);

    let audioOnly = Model.createProject('仅音轨'); audioOnly.width = 320; audioOnly.height = 180;
    audioOnly = Model.addAsset(audioOnly, assets[2]); audioOnly = Model.addClip(audioOnly, assets[2].id);
    audioOnly = Model.updateClip(audioOnly, audioOnly.clips[0].id, { duration: 0.25, speed: 4, volume: 0 });
    const audioOnlyOutput = path.join(directory, 'audio-only.mp4');
    await media.exportProject(audioOnly, audioOnlyOutput, options);
    const silent = run(['-i', audioOnlyOutput, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
    let maximum = 0;
    for (let i = 0; i + 4 <= silent.length; i += 4) maximum = Math.max(maximum, Math.abs(silent.readFloatLE(i)));
    assert.ok(maximum < 0.00001, 'zero gain produces silence in audio-only projects');

    // Cancel after FFmpeg begins rendering; an existing destination remains intact.
    let longProject = Model.createProject('取消验收'); longProject.width = 320; longProject.height = 180;
    longProject = Model.addAsset(longProject, assets[1]); longProject = Model.addClip(longProject, assets[1].id);
    longProject = Model.updateClip(longProject, longProject.clips[0].id, { duration: 120 });
    const cancelledOutput = path.join(directory, 'cancelled.mp4');
    const marker = Buffer.from('existing destination must survive cancellation');
    await fsp.writeFile(cancelledOutput, marker);
    const controller = new AbortController();
    let sawRendering = false;
    await assert.rejects(media.exportProject(longProject, cancelledOutput, { ...options, signal: controller.signal,
      onProgress: p => { if (p.phase === 'rendering') { sawRendering = true; controller.abort(); } } }),
      error => error.name === 'AbortError');
    assert.ok(sawRendering);
    assert.deepEqual(await fsp.readFile(cancelledOutput), marker);
    assert.ok(!(await fsp.readdir(directory)).some(name => name.startsWith('export-') || name.includes('.partial.mp4')));
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});