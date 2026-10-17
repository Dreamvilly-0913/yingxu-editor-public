"use strict";
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const Model = require('../shared/project.js');
const ENGINE = 'whisper.cpp 1.9.4 (b5130)';
const MODEL = 'Whisper base · 多语言';

function abortError() { const e = new Error('自动字幕已取消'); e.name = 'AbortError'; return e; }
function assertActive(signal) { if (signal?.aborted) throw abortError(); }
function paths(options = {}) {
  const root = options.root || path.resolve(__dirname, '../..');
  const asrDir = path.resolve(options.asrDir || path.join(root, 'tools', 'asr'));
  return { asrDir, executable: path.join(asrDir, 'whisper-cli.exe'), model: path.join(asrDir, 'ggml-base.bin'), vad: path.join(asrDir, 'ggml-silero-v6.2.0.bin') };
}
function getStatus(options = {}) {
  const files = paths(options);
  const required = [[files.executable, 100000], [files.model, 147951465], [files.vad, 885098], [path.join(files.asrDir, 'whisper.dll'), 100000], [path.join(files.asrDir, 'ggml.dll'), 10000]];
  const available = required.every(([file, size]) => { try { return fs.statSync(file).size >= size; } catch { return false; } });
  return { available, engine: ENGINE, model: MODEL, languages: ['auto', 'zh', 'en'], offline: true,
    ...(available ? {} : { reason: '未找到完整的本地语音模型或引擎，请使用包含 tools/asr 的完整程序目录。' }) };
}

function parseTimestamp(value) {
  if (typeof value !== 'string') return NaN;
  const m = value.trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : NaN;
}
function parseWhisperJSON(document, duration = Infinity) {
  if (!document || !Array.isArray(document.transcription)) throw new Error('语音引擎返回的字幕格式不正确');
  if (!(duration > 0) || Number.isNaN(duration)) throw new Error('音轨时长不正确');
  const cues = [];
  for (const item of document.transcription) {
    if (!item || typeof item.text !== 'string') continue;
    let text = item.text.replace(/\[_[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
    // Engine non-speech markers are metadata, never invented dialogue.
    if (!text || /^(?:\[[^\]]*\]|\([^)]*\)|[♪♫\s])+$/u.test(text)) continue;
    const from = typeof item.offsets?.from === 'number' ? item.offsets.from / 1000 : parseTimestamp(item.timestamps?.from);
    const to = typeof item.offsets?.to === 'number' ? item.offsets.to / 1000 : parseTimestamp(item.timestamps?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to <= 0 || from >= duration) continue;
    const start = Math.max(0, from), end = Math.min(duration, to);
    if (end - start < 0.02) continue;
    cues.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  // Remove exact duplicate timestamps/text, retaining repeated speech elsewhere.
  return cues.filter((cue, i) => i === 0 || cue.start !== cues[i-1].start || cue.end !== cues[i-1].end || cue.text !== cues[i-1].text);
}

function runWhisper(args, files, { signal, onProgress, cwd }) {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(files.executable, args, { cwd: cwd || files.asrDir, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', pending = '', finished = false, lastRatio = 0.18;
    const abort = () => { if (!finished) child.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    // Cover a signal set between the initial check and listener registration.
    if (signal?.aborted) abort();
    const consume = chunk => {
      const string = chunk.toString('utf8');
      stderr = (stderr + string).slice(-16000);
      pending = (pending + string).slice(-32000);
      const lines = pending.split(/[\r\n]/); pending = lines.pop();
      for (const line of lines) {
        const found = line.match(/(?:progress\s*=\s*|progress\s*:?\s*)(\d+)%/i);
        if (!found) continue;
        const ratio = Math.max(lastRatio, Math.min(0.97, 0.18 + Number(found[1]) / 100 * 0.79));
        lastRatio = ratio;
        onProgress?.({ stage: 'recognizing', ratio, message: '正在本机识别语音…' });
      }
    };
    child.stderr.on('data', consume); child.stdout.on('data', consume);
    child.on('error', error => {
      finished = true; signal?.removeEventListener('abort', abort);
      reject(signal?.aborted ? abortError() : new Error(`无法启动本地语音引擎：${error.message}`));
    });
    child.on('close', code => {
      finished = true; signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(abortError());
      else if (code !== 0) reject(new Error(`本地语音识别失败（${code}）：${stderr.slice(-2500)}`));
      else resolve({ stderr });
    });
  });
}

async function transcribeProject(project, options = {}) {
  assertActive(options.signal);
  Model.validateProject(project);
  const duration = Model.projectDuration(project);
  if (!(duration > 0)) throw new Error('请先将含有人声的视频或音频加入时间线');
  const language = options.language || 'auto';
  if (!['auto', 'zh', 'en'].includes(language)) throw new Error('不支持的识别语言');
  const status = getStatus(options);
  if (!status.available) throw new Error(status.reason);
  const files = paths(options);
  const workRoot = path.resolve(options.workDir || path.join(options.root || path.resolve(__dirname, '../..'), 'work'));
  await fsp.mkdir(workRoot, { recursive: true });
  const temp = await fsp.mkdtemp(path.join(workRoot, 'asr-'));
  try {
    options.onProgress?.({ stage: 'preparing', ratio: 0.01, message: '正在准备时间线音轨…' });
    const wav = path.join(temp, 'timeline.wav');
    const media = require('./media.cjs');
    await media.exportProjectAudio16kWAV(project, wav, { ffmpeg: options.ffmpeg, ffprobe: options.ffprobe, workDir: temp, signal: options.signal,
      onProgress: info => options.onProgress?.({ stage: 'preparing', ratio: Math.min(0.17, Math.max(0, Number(info?.ratio) || 0) * 0.17), message: '正在准备时间线音轨…' }) });
    assertActive(options.signal);
    options.onProgress?.({ stage: 'recognizing', ratio: 0.18, message: '正在本机检测人声并识别…' });
    // Upstream Windows CLI uses narrow argv. Keep every media/model argument ASCII,
    // while Node creates the process and cwd via Windows Unicode APIs. Hard links
    // avoid copying 148 MB on the same volume; cross-volume/unsupported volumes copy.
    for (const [source, name] of [[files.model, 'model.bin'], [files.vad, 'vad.bin']]) {
      assertActive(options.signal);
      try { await fsp.link(source, path.join(temp, name)); }
      catch (error) {
        if (!['EXDEV', 'EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
        await fsp.copyFile(source, path.join(temp, name));
      }
    }
    assertActive(options.signal);
    const prefix = path.join(temp, 'transcript');
    const args = ['-m', 'model.bin', '-f', 'timeline.wav', '-l', language, '-t', String(Math.max(1, Math.min(8, os.availableParallelism?.() || os.cpus().length))),
      '-ng', '-pp', '-sns', '-ml', '40', '-sow', '-oj', '-of', 'transcript',
      '--vad', '-vm', 'vad.bin', '--vad-threshold', '0.5'];
    await runWhisper(args, files, { ...options, cwd: temp });
    assertActive(options.signal);
    const jsonFile = `${prefix}.json`;
    if ((await fsp.stat(jsonFile)).size > 24 * 1024 * 1024) throw new Error('识别结果过大，请分段处理较长工程');
    const document = JSON.parse(await fsp.readFile(jsonFile, 'utf8'));
    const cues = parseWhisperJSON(document, duration);
    const detected = document.result?.language || (language === 'auto' ? 'unknown' : language);
    options.onProgress?.({ stage: 'completed', ratio: 1, message: cues.length ? `已识别 ${cues.length} 条字幕` : '没有检测到可识别的人声' });
    return { cues, language: detected, engine: ENGINE, model: MODEL, duration };
  } finally {
    // Only the unique directory created by this job is removed, after child exit.
    await fsp.rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}
module.exports = { getStatus, transcribeProject, parseWhisperJSON };
