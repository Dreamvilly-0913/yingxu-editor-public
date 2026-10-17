"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const M = require('../src/shared/project.js');
const { probeMedia } = require('../src/main/media.cjs');
const ASR = require('../src/main/transcription.cjs');
const root = path.resolve(__dirname, '..');
const workDir = path.join(root, 'work', 'asr-tests');
const ffmpeg = process.env.FFMPEG_PATH || require('../scripts/test-env.cjs').ffmpeg();
const ffprobe = process.env.FFPROBE_PATH || require('ffprobe-static').path;
const opts = { root, ffmpeg, ffprobe, workDir, cacheDir: path.join(workDir, 'cache') };
const records = [];
async function fixtureProject(file, start = 0, speed = 1) {
  const asset = await probeMedia(file, opts);
  let project = M.addAsset(M.createProject('自动字幕验收'), asset);
  project = M.addClip(project, asset.id, start);
  if (speed !== 1) project = M.updateClip(project, project.clips[0].id, { speed });
  return project;
}
function remember(name, data = {}) { records.push({ name, success: true, ...data }); }
async function assertClean() {
  const children = await fsp.readdir(workDir);
  assert.deepEqual(children.filter(name => /^asr-/.test(name)), [], 'every ASR job must remove only its own temporary files');
}
test('Whisper JSON uses millisecond offsets, clamps duration, filters markers and rejects bad shapes', () => {
  const cues = ASR.parseWhisperJSON({ transcription: [
    { offsets: { from: 1200, to: 4800 }, text: ' hello  world ' },
    { offsets: { from: 1200, to: 4800 }, text: ' hello world ' },
    { timestamps: { from: '00:00:04,800', to: '00:00:08,000' }, text: '再见' },
    { offsets: { from: 0, to: 1000 }, text: '[Music]' },
    { offsets: { from: 8000, to: 9000 }, text: 'outside' },
    { offsets: { from: 5000, to: 4000 }, text: 'inverted' }
  ] }, 6);
  assert.deepEqual(cues, [{ start: 1.2, end: 4.8, text: 'hello world' }, { start: 4.8, end: 6, text: '再见' }]);
  assert.throws(() => ASR.parseWhisperJSON({}), /格式/);
  remember('JSON timestamps, marker suppression, validation');
});
test('runtime status is explicit when complete or missing', () => {
  assert.equal(ASR.getStatus({ root }).available, true);
  const missing = ASR.getStatus({ asrDir: path.join(root, 'work', 'missing-asr') });
  assert.equal(missing.available, false); assert.ok(missing.reason);
  remember('portable runtime and missing dependency status');
});
test('real English recognition honors a timeline delay and preserves source/project', { timeout: 120000 }, async () => {
  await fsp.mkdir(workDir, { recursive: true });
  const file = path.join(root, 'assets/asr-test/speech-en.wav');
  const project = await fixtureProject(file, 1.2);
  const before = JSON.stringify(project), sourceBytes = await fsp.readFile(file), progress = [];
  const result = await ASR.transcribeProject(project, { ...opts, language: 'en', onProgress: p => progress.push(p) });
  const text = result.cues.map(c => c.text).join(' ').toLowerCase();
  assert.match(text, /video editor/); assert.match(text, /subtitles/);
  assert.ok(result.cues[0].start >= 1.2 && result.cues[0].start < 2.2, JSON.stringify(result.cues));
  assert.ok(result.cues.every(c => c.end <= M.projectDuration(project)));
  assert.equal(JSON.stringify(project), before); assert.deepEqual(await fsp.readFile(file), sourceBytes);
  assert.equal(progress.at(-1).ratio, 1);
  assert.ok(progress.some(p => p.stage === 'preparing') && progress.some(p => p.stage === 'recognizing'));
  await assertClean(); remember('real English + timeline delay + Unicode path', result);
});
test('real Chinese recognition produces editable Chinese cues', { timeout: 120000 }, async () => {
  const project = await fixtureProject(path.join(root, 'assets/asr-test/speech-zh.wav'));
  const result = await ASR.transcribeProject(project, { ...opts, language: 'zh' });
  const text = result.cues.map(c => c.text).join(' ');
  assert.match(text, /欢迎|歡迎/); assert.match(text, /视频|視頻|编辑|編輯/);
  await assertClean(); remember('real Chinese speech', result);
});
test('silence and original tonal music produce no hallucinated dialogue', { timeout: 120000 }, async () => {
  const silent = path.join(workDir, 'silent.wav');
  const generated = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', '-c:a', 'pcm_s16le', silent], { windowsHide: true });
  assert.equal(generated.status, 0);
  for (const file of [silent, path.join(root, 'assets/demo/tone.wav')]) {
    const project = await fixtureProject(file);
    const result = await ASR.transcribeProject(project, { ...opts, language: 'auto' });
    assert.deepEqual(result.cues, [], `unexpected non-speech transcript for ${path.basename(file)}`);
  }
  await assertClean(); remember('silence and music VAD suppression');
});
test('cancel during engine work stops the owned job and cleans temporary models/audio', { timeout: 120000 }, async () => {
  const project = await fixtureProject(path.join(root, 'assets/asr-test/speech-zh.wav'));
  const controller = new AbortController(); let timer;
  await assert.rejects(ASR.transcribeProject(project, { ...opts, language: 'zh', signal: controller.signal,
    onProgress: p => { if (p.stage === 'recognizing' && !timer) timer = setTimeout(() => controller.abort(), 150); }
  }), error => error.name === 'AbortError');
  clearTimeout(timer); await assertClean(); remember('active ASR cancellation and cleanup');
});
test('automatic language detection works after speed editing with a cross-volume Chinese job directory', { timeout: 120000 }, async () => {
  const temporaryRoot = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'yingxu-asr-中文-'));
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(require('node:os').tmpdir()));
  try {
    const project = await fixtureProject(path.join(root, 'assets/asr-test/speech-en.wav'), 0.8, 1.25);
    const result = await ASR.transcribeProject(project, { ...opts, workDir: temporaryRoot, language: 'auto' });
    assert.equal(result.language, 'en');
    assert.match(result.cues.map(c => c.text).join(' ').toLowerCase(), /video editor/);
    assert.ok(result.cues[0].start >= 0.8 && result.cues[0].start < 1.8);
    assert.ok(result.cues.every(c => c.end <= M.projectDuration(project)));
    assert.deepEqual(await fsp.readdir(temporaryRoot), []);
    remember('auto language + speed + cross-volume Unicode job directory', result);
  } finally { await fsp.rm(temporaryRoot, { recursive: true, force: true }); }
});
test('pre-aborted and unsupported-language jobs fail before work', async () => {
  const project = await fixtureProject(path.join(root, 'assets/asr-test/speech-en.wav'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(ASR.transcribeProject(project, { ...opts, signal: controller.signal }), e => e.name === 'AbortError');
  await assert.rejects(ASR.transcribeProject(project, { ...opts, language: '../bad' }), /语言/);
  await assertClean(); remember('early cancellation and language validation');
});
test.after(async () => {
  await fsp.mkdir(path.join(root, 'outputs'), { recursive: true });
  await fsp.writeFile(path.join(root, 'outputs/asr-acceptance.json'), JSON.stringify({ success: records.length === 8, engine: ASR.getStatus({ root }), records }, null, 2));
});
