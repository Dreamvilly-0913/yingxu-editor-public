'use strict';
// Rebuild the 0.3 example from the original 0.2 example using the public project model.
// Run: node scripts/create-color-demo.cjs [--export]
const fs = require('node:fs/promises');
const path = require('node:path');
const M = require('../src/shared/project.js');
const Media = require('../src/main/media.cjs');
const ROOT = path.resolve(__dirname, '..');
const DEMO = path.join(ROOT, 'assets', 'demo');
const ORIGINAL = path.join(DEMO, '多轨与动画演示.yxproj');
const DESTINATION = path.join(DEMO, '调色与声音演示.yxproj');
async function main() {
  const saved = JSON.parse(await fs.readFile(ORIGINAL, 'utf8'));
  let project = JSON.parse(JSON.stringify(saved));
  project.id = saved.id + '-color-v3';
  project.name = '调色 · 镜像 · 声音练习';
  project.assets = project.assets.map(asset => ({ ...asset, thumbnail: '', previewUrl: '' }));
  M.validateProject(project);
  const mainClips = project.clips.filter(clip => clip.track === 'video' && M.clipLayer(clip) === 0);
  const firstOverlay = project.clips.find(clip => clip.track === 'video' && M.clipLayer(clip) === 1);
  const secondOverlay = project.clips.find(clip => clip.track === 'video' && M.clipLayer(clip) === 2);
  const voice = project.clips.find(clip => clip.track === 'audio');
  if (mainClips.length !== 2 || !firstOverlay || !secondOverlay || !voice) throw new Error('原多轨演示结构已变化，请核对样例。');
  project = M.updateClip(project, mainClips[0].id, {
    color: { brightness: 0.18, contrast: 0.12, saturation: 0.15 }, audioFade: { in: 0.2, out: 0.6 }
  });
  project = M.updateClip(project, mainClips[1].id, { color: { brightness: -0.08, contrast: 0.15, saturation: -0.2 } });
  project = M.updateClip(project, firstOverlay.id, {
    crop: { left: 0.18, top: 0.1, right: 0.18, bottom: 0.1 }, flipX: true,
    color: { brightness: 0.05, contrast: 0.08, saturation: 0.1 }
  });
  project = M.updateClip(project, secondOverlay.id, {
    crop: { left: 0.08, top: 0.08, right: 0.08, bottom: 0.08 }, flipY: true,
    color: { brightness: 0.1, contrast: 0.05, saturation: -0.6 }
  });
  project = M.updateClip(project, voice.id, { audioFade: { in: 0.08, out: 0.25 } });
  project = M.updateSubtitle(project, project.subtitles[0].id, { text: '裁剪镜像 · 柔和调色' });
  project = M.updateSubtitle(project, project.subtitles[1].id, { text: '多轨转场 · 动画与声音淡入淡出' });
  const serializable = JSON.parse(JSON.stringify(project));
  for (const asset of serializable.assets) { delete asset.thumbnail; delete asset.previewUrl; }
  // The unchanged relative references make this example portable inside the standalone package.
  if (!serializable.assets.every((asset, index) => asset.path === saved.assets[index].path && asset.pathMode === 'relative')) throw new Error('示例素材相对路径发生意外变化。');
  await fs.writeFile(DESTINATION, JSON.stringify(serializable, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ project: DESTINATION, duration: M.projectDuration(project), width: project.width, height: project.height, clips: project.clips.length }));
  if (process.argv.includes('--export')) {
    const ffmpeg = process.env.FFMPEG_PATH || path.join(ROOT, 'tools', 'ffmpeg.exe');
    const ffmpegPath = await fs.access(ffmpeg).then(() => ffmpeg).catch(() => require('./test-env.cjs').ffmpeg());
    const ffprobe = process.env.FFPROBE_PATH || require('ffprobe-static').path;
    for (const asset of project.assets) asset.path = path.resolve(DEMO, asset.path);
    const output = path.join(ROOT, 'outputs', '映序_调色与声音演示.mp4');
    let lastPhase = '';
    const result = await Media.exportProject(project, output, {
      ffmpeg: ffmpegPath, ffprobe, workDir: path.join(ROOT, 'work'),
      onProgress: event => { if (event.phase !== lastPhase) { lastPhase = event.phase; console.log('render phase: ' + event.phase); } }
    });
    const probe = await Media.probeMedia(output, { ffmpeg: ffmpegPath, ffprobe, cacheDir: path.join(ROOT, 'work', 'demo-thumbnails') });
    if (probe.width !== project.width || probe.height !== project.height || !probe.hasAudio || probe.videoCodec !== 'h264' || probe.audioCodec !== 'aac' || Math.abs(probe.duration - result.duration) > 2 / project.fps) throw new Error('新演示视频探测校验失败。');
    console.log(JSON.stringify({ output, duration: probe.duration, width: probe.width, height: probe.height, videoCodec: probe.videoCodec, audioCodec: probe.audioCodec, verified: true }));
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
