/* Shared immutable project model. Loaded in Electron renderer and Node tests. */
(function (root, factory) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const model = factory(node ? require('./time-map.js') : root.EditorTimeMap, node ? require('./advanced-color.js') : root.EditorAdvancedColor, node ? require('./audio-model.js') : root.EditorAudioModel, node ? require('./text-style.js') : root.EditorTextStyle, node ? require('./visual-effects.js') : root.EditorVisualEffects);
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (root) root.EditorModel = model;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function (TimeMap, AdvancedColor, AudioModel, TextStyle, Visual) {
  'use strict';

  if (!TimeMap || !AdvancedColor) throw new Error('时间映射和高级调色模块尚未加载');
  const EPSILON = 1e-7;
  const MIN_SPEED = 0.25;
  const MAX_SPEED = 4;
  let idCounter = 0;

  function fail(message) { throw new Error(message); }
  function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + '必须是对象');
  }
  function number(value, label, minimum, maximum) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(label + '必须是有限数值');
    if (minimum !== undefined && value < minimum) fail(label + '不能小于 ' + minimum);
    if (maximum !== undefined && value > maximum) fail(label + '不能大于 ' + maximum);
  }
  function positive(value, label) {
    number(value, label, 0);
    if (value === 0) fail(label + '必须大于 0');
  }
  function string(value, label, allowEmpty) {
    if (typeof value !== 'string' || (!allowEmpty && !value.trim())) fail(label + '必须是' + (allowEmpty ? '字符串' : '非空字符串'));
  }
  function timestamp(value, label) {
    string(value, label);
    if (!Number.isFinite(Date.parse(value))) fail(label + '不是有效日期');
  }
  function newId(prefix) {
    const cryptoApi = typeof globalThis !== 'undefined' && globalThis.crypto;
    const value = cryptoApi && typeof cryptoApi.randomUUID === 'function'
      ? cryptoApi.randomUUID()
      : Date.now().toString(36) + '-' + (++idCounter).toString(36) + '-' + Math.random().toString(36).slice(2);
    return prefix + '-' + value;
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function stamp(project) { project.updatedAt = new Date().toISOString(); return project; }
  const POSE = Object.freeze({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 });
  const CROP = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });
  const COLOR = Object.freeze({ brightness: 0, contrast: 0, saturation: 0 });
  const EASINGS = Object.freeze(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold']);
  const MASK = Object.freeze({ type: 'rectangle', centerX: 0.5, centerY: 0.5, width: 1, height: 1, rotation: 0, feather: 0, invert: false });
  // A cut keeps the original curve parameter interval. Renormalizing its values then
  // interpolates between the new boundary poses without restarting the easing curve.
  function normalizedEasingProgress(easing, progress, window) {
    const t = Math.max(0, Math.min(1, progress)), interval = window || [0, 1];
    if (t === 0 || t === 1) return t;
    const a = interval[0], b = interval[1], span = b - a;
    // Stable factored differences avoid cancellation near 0/1 and after deep cuts.
    if (easing === 'hold') return 0;
    if (easing === 'ease-in' || (easing === 'ease-in-out' && b <= 0.5)) return t * (2 * a + span * t) / (a + b);
    if (easing === 'ease-out' || (easing === 'ease-in-out' && a >= 0.5)) return t * (2 * (1 - a) - span * t) / ((1 - a) + (1 - b));
    if (easing === 'ease-in-out') {
      const u = a + span * t, left = 2 * (0.5 - a) * (0.5 + a), right = 2 * (b - 0.5) * (1.5 - b);
      return (u <= 0.5 ? 2 * span * t * (a + u) : left + 2 * (u - 0.5) * (1.5 - u)) / (left + right);
    }
    return t;
  }
  function validateEasing(frame) {
    if (frame.easing !== undefined && !EASINGS.includes(frame.easing)) fail('不支持的关键帧缓动');
    if (frame.easingWindow !== undefined) {
      if (!Array.isArray(frame.easingWindow) || frame.easingWindow.length !== 2) fail('缓动区间必须包含两个数值');
      number(frame.easingWindow[0], '缓动区间起点', 0, 1); number(frame.easingWindow[1], '缓动区间终点', 0, 1);
      if (frame.easingWindow[0] >= frame.easingWindow[1]) fail('缓动区间终点必须大于起点');
    }
  }
  // Coordinates are pixel centres in the cropped source, before flip and pose.
  // Rectangle uses an exact signed-distance field. Ellipse uses radial distance
  // scaled by its smaller radius. Feather spans min(width,height)*feather pixels.
  function evaluateMaskAlpha(input, x, y, width, height) {
    if (!input) return 1;
    const mask = Object.assign({}, MASK, input), angle = mask.rotation * Math.PI / 180;
    const dx = x - mask.centerX * width, dy = y - mask.centerY * height;
    const px = dx * Math.cos(angle) + dy * Math.sin(angle), py = -dx * Math.sin(angle) + dy * Math.cos(angle);
    const rx = mask.width * width / 2, ry = mask.height * height / 2;
    let distance;
    if (mask.type === 'ellipse') distance = (Math.hypot(px / rx, py / ry) - 1) * Math.min(rx, ry);
    else {
      const qx = Math.abs(px) - rx, qy = Math.abs(py) - ry;
      distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
    }
    const band = mask.feather * Math.min(width, height);
    const t = band > 0 ? Math.max(0, Math.min(1, 0.5 + distance / band)) : distance <= 0 ? 0 : 1;
    const alpha = 1 - t * t * (3 - 2 * t);
    return mask.invert ? 1 - alpha : alpha;
  }

  function cropRect(asset, clip) {
    const crop = Object.assign({}, CROP, clip.crop || {});
    const x = Math.floor(asset.width * crop.left), y = Math.floor(asset.height * crop.top);
    return { x: x, y: y, width: Math.max(1, Math.floor(asset.width * (1 - crop.right)) - x),
      height: Math.max(1, Math.floor(asset.height * (1 - crop.bottom)) - y) };
  }
  // Independently implemented from the shipped FC adjustColor Lua parameter mapping and GLSL.
  // Components are normalized RGB values. Clamp once, matching the shader's RGBA8 destination.
  function adjustRgb(rgb, input, advanced) {
    const color = Object.assign({}, COLOR, input || {}), intensity = color.brightness;
    const brightness = intensity <= 0 ? intensity : intensity <= 0.7 ? intensity * 0.3 : intensity * 0.6333 - 0.2333;
    const contrast = color.contrast <= 0 ? 1 + 0.4 * color.contrast : 1 + 1.1 * color.contrast + Math.pow(color.contrast, 5.27);
    let result = rgb.map(function (channel) {
      let value = channel;
      if (brightness > 0) {
        const exponent = 1 + 5 * brightness, edge = Math.pow(0.001, 1 / exponent);
        value = value > 1 - edge ? value + edge : 1 - Math.pow(1 - value, exponent);
      } else if (brightness < 0) {
        const exponent = 1 / (1 - 2.5 * brightness);
        value = value > 1 ? value - Math.pow(-0.01 * brightness, exponent)
          : 1 - Math.pow(1 - value * (1 + 0.01 * brightness), exponent);
      }
      const pivot = 0.435;
      if (contrast <= 1) value = contrast * (value - pivot) + pivot;
      else if (value < pivot) {
        const edge = pivot * Math.pow(0.001 / pivot, 1 / contrast);
        value = value < edge ? value - edge : pivot * Math.pow(value / pivot, contrast);
      } else {
        const edge = 1 - (1 - pivot) * Math.pow(0.001 / (1 - pivot), 1 / contrast);
        value = value > edge ? value + 1 - edge : 1 - (1 - pivot) * Math.pow((1 - value) / (1 - pivot), contrast);
      }
      return value;
    });
    const saturation = 1 + color.saturation, luma = result[0] * 0.208540 + result[1] * 0.702086 + result[2] * 0.089374;
    const adjusted = result.map(value => Math.max(0, Math.min(1, luma * (1 - saturation) + value * saturation)));
    return advanced === undefined ? adjusted : AdvancedColor.adjustRgb(adjusted, advanced);
  }
  function audioEnvelopePoints(clip) {
    if (clip.audioEnvelope) return clone(clip.audioEnvelope);
    const fade = Object.assign({ in: 0, out: 0 }, clip.audioFade || {}), points = [{ time: 0, gain: fade.in > 0 ? 0 : 1 }];
    if (fade.in > 0) points.push({ time: fade.in, gain: 1 });
    const startOut = clip.duration - fade.out;
    if (startOut > points[points.length - 1].time + EPSILON) points.push({ time: startOut, gain: 1 });
    if (clip.duration > points[points.length - 1].time + EPSILON) points.push({ time: clip.duration, gain: fade.out > 0 ? 0 : 1 });
    return points;
  }
  function envelopeGain(points, time) {
    let previous = points[0];
    if (time <= previous.time) return previous.gain;
    for (let index = 1; index < points.length; index++) {
      const point = points[index];
      if (time < point.time) return previous.gain + (point.gain - previous.gain) * (time - previous.time) / (point.time - previous.time);
      previous = point;
    }
    return previous.gain;
  }
  function sliceEnvelope(points, start, end) {
    return [{ time: 0, gain: envelopeGain(points, start) }]
      .concat(points.filter(point => point.time > start + EPSILON && point.time < end - EPSILON)
        .map(point => ({ time: point.time - start, gain: point.gain })))
      .concat([{ time: end - start, gain: envelopeGain(points, end) }]);
  }
  function summarizeEnvelope(points) {
    const peak = Math.max(...points.map(point => point.gain));
    const peaks = points.filter(point => Math.abs(point.gain - peak) < EPSILON);
    return { in: points[0].gain < peak - EPSILON ? peaks[0].time : 0,
      out: points[points.length - 1].gain < peak - EPSILON ? points[points.length - 1].time - peaks[peaks.length - 1].time : 0 };
  }
  function clampFade(clip) {
    if (!clip.audioFade) return;
    const total = clip.audioFade.in + clip.audioFade.out;
    if (total > clip.duration && total > 0) {
      clip.audioFade.in *= clip.duration / total; clip.audioFade.out *= clip.duration / total;
    }
  }
  function clipLayer(clip) { return clip.layer === undefined ? 0 : clip.layer; }
  function pose(input) { return Object.assign({}, POSE, input || {}); }
  function validatePose(input, label) {
    object(input, label);
    for (const key of Object.keys(input)) if (!Object.prototype.hasOwnProperty.call(POSE, key)) fail(label + '不支持字段：' + key);
    const value = pose(input);
    number(value.x, label + ' X', -2, 2); number(value.y, label + ' Y', -2, 2);
    number(value.scale, label + '缩放', 0.1, 4); number(value.rotation, label + '旋转', -3600, 3600);
    number(value.opacity, label + '不透明度', 0, 1);
  }
  function evaluateTransform(clip, time) {
    const base = pose(clip.transform);
    const keys = clip.keyframes || [];
    if (!keys.length) return base;
    let previous = Object.assign({ time: 0 }, base);
    for (const key of keys) {
      if (time < key.time) {
        const ratio = normalizedEasingProgress(key.easing, (time - previous.time) / (key.time - previous.time), key.easingWindow);
        const result = {};
        for (const field of Object.keys(POSE)) result[field] = previous[field] + (key[field] - previous[field]) * ratio;
        return result;
      }
      previous = key;
    }
    const result = {}; for (const field of Object.keys(POSE)) result[field] = previous[field]; return result;
  }
  function animationKeys(clip) {
    const keys = [Object.assign({ time: 0 }, pose(clip.transform))];
    for (const key of clip.keyframes || []) { if (key.time === 0) keys[0] = clone(key); else keys.push(clone(key)); }
    return keys;
  }
  function curvePart(key, startRatio, endRatio) {
    const window = key.easingWindow || [0, 1], span = window[1] - window[0];
    const left = window[0] + span * startRatio, right = window[0] + span * endRatio;
    return right > left ? { easing: key.easing || 'linear', easingWindow: [left, right] }
      : { easing: key.easing === 'hold' ? 'hold' : 'linear', easingWindow: [0, 1] };
  }
  function sliceAnimation(clip, start, end) {
    const transform = evaluateTransform(clip, start), keys = animationKeys(clip);
    const frames = [];
    for (let index = 1; index < keys.length; index++) {
      const a = keys[index - 1], b = keys[index], left = Math.max(start, a.time), right = Math.min(end, b.time);
      if (right <= left) continue;
      frames.push(Object.assign({ time: right - start }, evaluateTransform(clip, right),
        curvePart(b, (left - a.time) / (b.time - a.time), (right - a.time) / (b.time - a.time))));
    }
    return { transform: transform, keyframes: frames };
  }
  function mainClips(project) { return project.clips.filter(c => c.track === 'video' && clipLayer(c) === 0); }
  function visualOpacity(project, clip, time) {
    if (time < clip.start || time >= clip.start + clip.duration) return 0;
    let opacity = evaluateTransform(clip, time - clip.start).opacity;
    if (clip.track !== 'video' || clipLayer(clip) !== 0) return opacity;
    const relative = time - clip.start, transition = clip.transition;
    if (transition && relative < transition.duration) {
      const fraction = relative / transition.duration;
      opacity *= transition.type === 'crossfade' ? fraction : Math.max(0, fraction * 2 - 1);
    }
    const clips = mainClips(project), following = clips[clips.findIndex(c => c.id === clip.id) + 1];
    if (following && following.transition && following.transition.type === 'fadeblack' && time >= following.start) {
      opacity *= Math.max(0, 1 - (time - following.start) * 2 / following.transition.duration);
    }
    return opacity;
  }
  function audioGain(project, clip, time) {
    if (time < clip.start || time >= clip.start + clip.duration) return 0;
    let gain = clip.volume * AudioModel.effectiveGain(project, clip) * envelopeGain(audioEnvelopePoints(clip), time - clip.start);
    if (clip.track !== 'video' || clipLayer(clip) !== 0) return gain;
    const relative = time - clip.start, transition = clip.transition;
    if (transition && relative < transition.duration) gain *= transition.type === 'crossfade'
      ? relative / transition.duration : Math.max(0, relative * 2 / transition.duration - 1);
    const clips = mainClips(project), following = clips[clips.findIndex(c => c.id === clip.id) + 1];
    if (following && following.transition && time >= following.start) {
      gain *= Math.max(0, 1 - (time - following.start) / following.transition.duration * (following.transition.type === 'fadeblack' ? 2 : 1));
    }
    return gain;
  }
  function getActiveVisualClips(project, time) {
    return project.clips.filter(c => c.track === 'video' && time >= c.start && time < c.start + c.duration)
      .sort((a, b) => clipLayer(a) - clipLayer(b));
  }
  function isMagneticMain(project) { return project.magneticMain !== false; }
  function sortMainClips(project) {
    const ordered = mainClips(project).sort((a, b) => a.start - b.start);
    let index = 0;
    project.clips = project.clips.map(clip => clip.track === 'video' && clipLayer(clip) === 0 ? ordered[index++] : clip);
  }
  function ripple(project) {
    project.videoTrackCount = Math.max(project.videoTrackCount || 1, ...project.clips.filter(c => c.track === 'video').map(c => clipLayer(c) + 1));
    if (!isMagneticMain(project)) {
      for (const clip of project.clips) if (clip.track !== 'video' || clipLayer(clip) !== 0) delete clip.transition;
      sortMainClips(project); return project;
    }
    let cursor = 0, previous;
    for (const clip of project.clips) {
      if (clip.track !== 'video' || clipLayer(clip) !== 0) { delete clip.transition; continue; }
      if (!previous) delete clip.transition;
      else if (clip.transition) clip.transition.duration = Math.min(clip.transition.duration, previous.duration / 2, clip.duration / 2);
      clip.start = cursor - (clip.transition ? clip.transition.duration : 0);
      cursor = clip.start + clip.duration; previous = clip;
    }
    return project;
  }
  function edit(project, operation) {
    validateProject(project);
    const next = clone(project);
    operation(next);
    if (next.groups) { const alive=new Set([...next.clips,...next.subtitles,...(next.texts||[])].map(x=>x.id)); next.groups=next.groups.map(g=>Object.assign({},g,{members:g.members.filter(m=>alive.has(m.id))})).filter(g=>g.members.length>1); }
    ripple(next);
    stamp(next);
    return validateProject(next);
  }
  function item(items, id, label) {
    const result = items.find(function (entry) { return entry.id === id; });
    if (!result) fail(label + '不存在：' + id);
    return result;
  }
  function patchKeys(patch, allowed, label) {
    object(patch, label);
    for (const key of Object.keys(patch)) if (!allowed.includes(key)) fail(label + '不支持修改字段：' + key);
  }
  function validateSubtitle(cue, label) {
    object(cue, label);
    number(cue.start, label + '开始时间', 0);
    number(cue.end, label + '结束时间', 0);
    if (cue.end <= cue.start) fail(label + '结束时间必须晚于开始时间');
    string(cue.text, label + '文字');
  }

  function createProject(name) {
    const now = new Date().toISOString();
    return validateProject({
      schemaVersion: 1, id: newId('project'), name: name === undefined ? '未命名项目' : name,
      width: 1920, height: 1080, fps: 30, videoTrackCount: 1,
      assets: [], clips: [], subtitles: [],
      subtitleStyle: { fontSize: 48, color: '#ffffff' },
      createdAt: now, updatedAt: now
    });
  }

  function validateProject(project) {
    object(project, '项目');
    if (project.schemaVersion !== 1) fail('不支持的项目版本，必须为 schemaVersion 1');
    string(project.id, '项目 ID');
    string(project.name, '项目名称');
    for (const key of ['width', 'height']) {
      positive(project[key], '项目 ' + key);
      if (!Number.isInteger(project[key])) fail('项目 ' + key + '必须是整数');
    }
    positive(project.fps, '项目帧率');
    if (project.magneticMain !== undefined && typeof project.magneticMain !== 'boolean') fail('主轨磁吸必须是布尔值');
    if (project.videoTrackCount !== undefined) { number(project.videoTrackCount, '视频轨数量', 1, 9); if (!Number.isInteger(project.videoTrackCount)) fail('视频轨数量必须是整数'); }
    timestamp(project.createdAt, '创建时间');
    timestamp(project.updatedAt, '更新时间');
    for (const key of ['assets', 'clips', 'subtitles']) if (!Array.isArray(project[key])) fail(key + '必须是数组');
    object(project.subtitleStyle, '字幕样式');
    positive(project.subtitleStyle.fontSize, '字幕字号');
    if (typeof project.subtitleStyle.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(project.subtitleStyle.color)) fail('字幕颜色必须为 #RRGGBB');

    const ids = new Set([project.id]);
    function uniqueId(entry, label) {
      string(entry.id, label + ' ID');
      if (ids.has(entry.id)) fail('重复 ID：' + entry.id);
      ids.add(entry.id);
    }
    const assets = new Map();
    for (const asset of project.assets) {
      object(asset, '素材');
      uniqueId(asset, '素材');
      string(asset.name, '素材名称');
      string(asset.path, '素材路径');
      if (!['video', 'audio', 'image'].includes(asset.kind)) fail('素材类型必须为 video、audio 或 image');
      number(asset.duration, '素材时长', 0);
      if (asset.kind !== 'image' && asset.duration === 0) fail('视频或音频素材时长必须大于 0');
      number(asset.width, '素材宽度', 0);
      number(asset.height, '素材高度', 0);
      if (!Number.isInteger(asset.width) || !Number.isInteger(asset.height)) fail('素材宽高必须是整数');
      if (typeof asset.hasAudio !== 'boolean') fail('素材 hasAudio 必须是布尔值');
      string(asset.thumbnail, '素材缩略图', true);
      string(asset.previewUrl, '素材预览地址', true);
      if (asset.offline !== undefined && typeof asset.offline !== 'boolean') fail('素材 offline 必须是布尔值');
      if (asset.offlineReason !== undefined) string(asset.offlineReason, '素材离线原因');
      if (asset.sourceRange !== undefined) { object(asset.sourceRange,'素材入出点'); number(asset.sourceRange.start,'素材入点',0,asset.duration);number(asset.sourceRange.end,'素材出点',0,asset.duration);if(asset.kind==='image'||asset.sourceRange.end<=asset.sourceRange.start)fail('素材入出点无效'); }
      assets.set(asset.id, asset);
    }
    let videoCursor = 0, previousVideo;
    for (const clip of project.clips) {
      object(clip, '片段');
      uniqueId(clip, '片段');
      const asset = assets.get(clip.assetId);
      if (!asset) fail('片段引用的素材不存在：' + clip.assetId);
      if (!['video', 'audio'].includes(clip.track)) fail('片段轨道必须为 video 或 audio');
      if ((asset.kind === 'audio') !== (clip.track === 'audio')) fail('片段轨道与素材类型不匹配');
      number(clip.start, '片段开始时间', 0);
      positive(clip.duration, '片段时长');
      number(clip.sourceIn, '源素材入点', 0);
      number(clip.speed, '播放速度', MIN_SPEED, MAX_SPEED);
      number(clip.volume, '音量', 0, 2);
      if (clip.speedCurve !== undefined) {
        TimeMap.validateCurve(clip.speedCurve); positive(clip.sourceDuration, '曲线源区间时长');
        if (clip.speed !== 1) fail('曲线变速片段的恒定速度必须为 1');
        if (asset.kind === 'image') fail('图片不支持曲线变速');
        const expected = TimeMap.durationForCurve(clip.sourceDuration, clip.speedCurve);
        if (!Number.isFinite(expected) || Math.abs(clip.duration - expected) > EPSILON * Math.max(1, expected)) fail('曲线源区间与输出时长不一致');
      } else if (clip.sourceDuration !== undefined) fail('源区间时长仅用于曲线变速片段');
      const sourceEnd = clip.sourceIn + TimeMap.sourceDuration(clip);
      if (!Number.isFinite(sourceEnd) || !Number.isFinite(clip.start + clip.duration)) fail('片段时间范围溢出');
      if (asset.kind !== 'image' && sourceEnd > asset.duration + EPSILON) fail('片段源区间超出素材时长：' + asset.name);
      if (clip.crop !== undefined) {
        patchKeys(clip.crop, Object.keys(CROP), '画面裁剪');
        const crop = Object.assign({}, CROP, clip.crop);
        for (const key of Object.keys(CROP)) number(crop[key], '裁剪 ' + key, 0, 0.98);
        if (crop.left + crop.right > 0.98 + EPSILON || crop.top + crop.bottom > 0.98 + EPSILON) fail('裁剪后至少保留 2% 的画面');
        if (clip.track !== 'video') fail('音频片段不支持画面裁剪');
      }
      for (const field of ['flipX', 'flipY']) if (clip[field] !== undefined) {
        if (typeof clip[field] !== 'boolean') fail('画面翻转必须是布尔值');
        if (clip.track !== 'video') fail('音频片段不支持画面翻转');
      }
      if (clip.color !== undefined) {
        patchKeys(clip.color, Object.keys(COLOR), '调色');
        for (const key of Object.keys(clip.color)) number(clip.color[key], '调色 ' + key, -1, 1);
        if (clip.track !== 'video') fail('音频片段不支持调色');
      }
      if (clip.advancedColor !== undefined) {
        AdvancedColor.validate(clip.advancedColor);
        if (clip.track !== 'video') fail('音频片段不支持高级调色');
      }
      if (clip.mask !== undefined) {
        patchKeys(clip.mask, [...Object.keys(MASK),'expansion','roundness'], '蒙版');
        Visual.validateMaskExtension(clip.mask);
        const mask = Object.assign({}, MASK, clip.mask);
        if (!['rectangle', 'ellipse'].includes(mask.type)) fail('不支持的蒙版类型');
        number(mask.centerX, '蒙版中心 X', -2, 3); number(mask.centerY, '蒙版中心 Y', -2, 3);
        number(mask.width, '蒙版宽度', 0.01, 4); number(mask.height, '蒙版高度', 0.01, 4);
        number(mask.rotation, '蒙版旋转', -3600, 3600); number(mask.feather, '蒙版羽化', 0, 1);
        if (typeof mask.invert !== 'boolean') fail('蒙版反转必须是布尔值');
        if (clip.track !== 'video') fail('音频片段不支持蒙版');
      }
      if (clip.visualEffects !== undefined) { if(clip.track!=='video')fail('音频不支持画面效果');Visual.validate(clip.visualEffects); }
      if (clip.maskAnimation !== undefined) { if(clip.track!=='video'||!clip.mask)fail('蒙版动画需要视频蒙版');Visual.validateAnimation(clip.maskAnimation,clip.duration); }
      if (clip.audioFade !== undefined) {
        patchKeys(clip.audioFade, ['in', 'out'], '音频淡入淡出');
        number(clip.audioFade.in, '淡入时长', 0); number(clip.audioFade.out, '淡出时长', 0);
        if (clip.audioFade.in + clip.audioFade.out > clip.duration + EPSILON) fail('淡入淡出总时长不能超过片段时长');
      }
      if (clip.audioEnvelope !== undefined) {
        if (!Array.isArray(clip.audioEnvelope) || clip.audioEnvelope.length < 2 || clip.audioEnvelope.length > 256) fail('音量包络需包含 2–256 个节点');
        let last = -1;
        for (const point of clip.audioEnvelope) {
          patchKeys(point, ['time', 'gain'], '音量包络节点');
          number(point.time, '音量包络时间', 0, clip.duration); number(point.gain, '音量包络增益', 0, 1);
          if (point.time <= last) fail('音量包络时间必须严格升序'); last = point.time;
        }
        if (clip.audioEnvelope[0].time !== 0 || Math.abs(clip.audioEnvelope[clip.audioEnvelope.length - 1].time - clip.duration) > EPSILON) fail('音量包络必须覆盖整个片段');
      }
      const layer = clipLayer(clip);
      if (project.videoTrackCount !== undefined && clip.track === 'video' && layer >= project.videoTrackCount) fail('片段超出已建立的视频轨');
      number(layer, '视频层级', 0, 8); if (!Number.isInteger(layer)) fail('视频层级必须是整数');
      if (clip.track === 'audio' && layer !== 0) fail('音频片段不支持视频层级');
      if (clip.transform !== undefined) validatePose(clip.transform, '画面变换');
      if (clip.keyframes !== undefined) {
        if (!Array.isArray(clip.keyframes) || clip.keyframes.length > 128) fail('关键帧必须是数组，最多 128 个');
        let lastTime = -1;
        for (const frame of clip.keyframes) {
          object(frame, '关键帧'); number(frame.time, '关键帧时间', 0, clip.duration);
          if (frame.time <= lastTime) fail('关键帧时间必须升序且不能重复');
          const value = Object.assign({}, frame); delete value.time; delete value.easing; delete value.easingWindow; validatePose(value, '关键帧'); validateEasing(frame);
          for (const key of Object.keys(POSE)) if (!Object.prototype.hasOwnProperty.call(frame, key)) fail('关键帧必须包含完整画面参数');
          lastTime = frame.time;
        }
      }
      if (clip.transition) {
        object(clip.transition, '转场');
        if (clip.track !== 'video' || layer !== 0 || !previousVideo) fail('转场只能用于主轨第二个及后续片段');
        if (!['crossfade', 'fadeblack'].includes(clip.transition.type)) fail('不支持的转场类型');
        positive(clip.transition.duration, '转场时长');
        if (clip.transition.duration > Math.min(clip.duration, previousVideo.duration) / 2 + EPSILON) fail('转场不能超过相邻片段较短时长的一半');
      }
      if (clip.track === 'video' && layer === 0) {
        const expected = videoCursor - (clip.transition ? clip.transition.duration : 0);
        if (isMagneticMain(project)) {
          if (Math.abs(clip.start - expected) > EPSILON) fail('视频片段必须按数组顺序连续排列');
        } else {
          if (previousVideo && clip.start < previousVideo.start - EPSILON) fail('非磁吸主轨必须按开始时间升序排列');
          if (clip.transition) {
            if (Math.abs(clip.start - expected) > EPSILON) fail('非磁吸转场必须与前一片段形成指定时长的重叠');
          } else if (previousVideo && clip.start < videoCursor - EPSILON) fail('主轨片段不能重叠，请添加合法转场或移到其它视频轨');
        }
        videoCursor = clip.start + clip.duration; previousVideo = clip;
      }
    }
    for (const cue of project.subtitles) {
      validateSubtitle(cue, '字幕'); uniqueId(cue, '字幕');
    }
    AudioModel.validateProject(project); TextStyle.validateProjectText(project,ids);
    if(project.groups!==undefined){if(!Array.isArray(project.groups)||project.groups.length>1000)fail('编组无效');const members=new Set();for(const g of project.groups){object(g,'编组');uniqueId(g,'编组');string(g.name,'编组名称');if(!Array.isArray(g.members)||g.members.length<2)fail('编组至少需要两个对象');for(const m of g.members){if(!['clip','subtitle','text'].includes(m.type)||!ids.has(m.id)||members.has(m.id))fail('编组成员无效或重复');const list=m.type==='clip'?project.clips:m.type==='subtitle'?project.subtitles:project.texts||[];if(!list.some(x=>x.id===m.id))fail('编组成员类型不匹配');members.add(m.id);}}}
    return project;
  }

  function projectDuration(project) {
    validateProject(project);
    let duration = 0;
    for (const clip of project.clips) duration = Math.max(duration, clip.start + clip.duration);
    for (const cue of [...project.subtitles,...(project.texts||[])]) duration = Math.max(duration, cue.end);
    return duration;
  }

  function addAsset(project, input) {
    object(input, '素材');
    const asset = Object.assign({
      id: newId('asset'), name: '', path: '', kind: 'video',
      duration: input.kind === 'image' ? 5 : 0,
      width: 0, height: 0, hasAudio: input.kind === 'audio',
      thumbnail: '', previewUrl: ''
    }, clone(input));
    return edit(project, function (next) { next.assets.push(asset); });
  }

  function addClip(project, assetId, start, options) {
    options = options || {}; patchKeys(options, ['layer','audioTrackId'], '片段选项');
    if (start !== undefined) number(start, '插入时间', 0);
    return edit(project, function (next) {
      const asset = item(next.assets, assetId, '素材');
      const clip = {
        id: newId('clip'), assetId: asset.id, track: asset.kind === 'audio' ? 'audio' : 'video',
        start: start === undefined ? (!isMagneticMain(next) && asset.kind !== 'audio' && (options.layer || 0) === 0 ? Math.max(0, ...mainClips(next).map(c => c.start + c.duration)) : 0) : start,
        duration: asset.kind === 'image' ? 5 : asset.sourceRange ? asset.sourceRange.end-asset.sourceRange.start : asset.duration,
        sourceIn: asset.sourceRange?.start || 0, speed: 1, volume: 1
      };
      if(asset.kind==='audio'){const target=AudioModel.tracks(next).find(t=>t.id===(options.audioTrackId||AudioModel.tracks(next)[0].id));if(!target||target.locked)fail('目标音轨不存在或已锁定');if(options.audioTrackId!==undefined||next.audioTracks!==undefined)clip.audioTrackId=target.id;}else if(options.audioTrackId!==undefined)fail('只有音频片段可以指定音轨');
      if (options.layer !== undefined) clip.layer = options.layer;
      const index = clip.track === 'video' && clipLayer(clip) === 0 && start !== undefined
        ? next.clips.findIndex(function (existing) { return existing.track === 'video' && clipLayer(existing) === 0 && existing.start >= start; })
        : -1;
      if (index < 0) next.clips.push(clip);
      else next.clips.splice(index, 0, clip);
    });
  }

  function updateClip(project, clipId, patch) {
    AudioModel.assertUnlocked(project,[clipId]);
    if(patch?.audioTrackId!==undefined){const target=AudioModel.tracks(project).find(t=>t.id===patch.audioTrackId);if(!target||target.locked)fail('目标音轨不存在或已锁定');}
    patchKeys(patch, ['start', 'duration', 'sourceIn', 'sourceDuration', 'speed', 'speedCurve', 'volume', 'layer', 'transform', 'keyframes', 'transition', 'crop', 'flipX', 'flipY', 'audioFade', 'audioEnvelope', 'color', 'advancedColor', 'mask', 'maskAnimation', 'visualEffects', 'audioTrackId', 'audioMuted', 'audioEffects'], '片段更新');
    return edit(project, function (next) {
      const clip = item(next.clips, clipId, '片段'), original = clone(clip);
      const owns = field => Object.prototype.hasOwnProperty.call(patch, field);
      const enteringMain = clip.track === 'video' && clipLayer(clip) !== 0 && patch.layer === 0;
      if (owns('start')) {
        number(patch.start, '片段开始时间', 0);
        if (isMagneticMain(next) && !enteringMain && clip.track === 'video' && (patch.layer === undefined ? clipLayer(clip) : patch.layer) === 0 && patch.start !== clip.start) {
          fail('视频片段位置由连续排列决定，请使用 reorderClip 调整顺序');
        }
      }
      if (owns('duration')) positive(patch.duration, '片段时长');
      if (owns('speed')) number(patch.speed, '播放速度', MIN_SPEED, MAX_SPEED);
      if (owns('sourceDuration')) positive(patch.sourceDuration, '曲线源区间时长');
      const insertionTime = owns('start') ? patch.start : clip.start, oldDuration = clip.duration;
      const oldSpan = TimeMap.sourceDuration(original), timePatch = {};
      let removeCurve = false, retime = false;
      if (owns('speedCurve')) {
        if (patch.speedCurve === null) {
          removeCurve = true;
          const speed = owns('speed') ? patch.speed : clip.speed;
          timePatch.speed = speed; timePatch.duration = owns('duration') ? patch.duration : oldSpan / speed;
        } else {
          TimeMap.validateCurve(patch.speedCurve);
          if (owns('speed') && patch.speed !== 1) fail('曲线变速片段的恒定速度必须为 1');
          timePatch.sourceDuration = owns('sourceDuration') ? patch.sourceDuration : oldSpan;
          timePatch.speed = 1;
          timePatch.duration = TimeMap.durationForCurve(timePatch.sourceDuration, patch.speedCurve);
          if (owns('duration') && Math.abs(patch.duration - timePatch.duration) > EPSILON * Math.max(1, timePatch.duration)) fail('曲线源区间与输出时长不一致');
        }
        retime = true;
      } else if (owns('speed')) {
        // A constant-speed edit explicitly leaves curve mode, preserving its source span.
        removeCurve = true; timePatch.duration = owns('duration') ? patch.duration : oldSpan / patch.speed;
        retime = !owns('duration');
      } else if (clip.speedCurve) {
        if (owns('sourceDuration')) {
          timePatch.duration = TimeMap.durationForCurve(patch.sourceDuration, clip.speedCurve); retime = true;
          if (owns('duration') && Math.abs(patch.duration - timePatch.duration) > EPSILON * Math.max(1, timePatch.duration)) fail('曲线源区间与输出时长不一致');
        } else if (owns('duration') && patch.duration !== oldDuration) {
          if (patch.duration < oldDuration) {
            const fraction = (TimeMap.clipSourceTime(original, patch.duration) - original.sourceIn) / oldSpan;
            timePatch.sourceDuration = oldSpan * fraction;
            timePatch.speedCurve = TimeMap.sliceCurve(original.speedCurve, 0, fraction);
          } else {
            // Extending a curved clip continues its final speed into later source frames.
            const lastSpeed = original.speedCurve[original.speedCurve.length - 1].speed;
            const span = oldSpan + (patch.duration - oldDuration) * lastSpeed;
            const points = original.speedCurve.map(point => ({ position: point.position * oldSpan / span, speed: point.speed }));
            if (points.length > 2 && points[points.length - 2].speed === lastSpeed) points.pop();
            points.push({ position: 1, speed: lastSpeed }); TimeMap.validateCurve(points);
            timePatch.sourceDuration = span; timePatch.speedCurve = points;
          }
        }
      } else if (owns('sourceDuration')) fail('源区间时长仅用于曲线变速片段');
      Object.assign(clip, patch, timePatch);
      for (const field of ['transform', 'keyframes', 'transition', 'crop', 'audioFade', 'audioEnvelope', 'color', 'advancedColor', 'mask', 'speedCurve','maskAnimation','visualEffects','audioEffects']) {
        if (clip[field] && typeof clip[field] === 'object' && (owns(field) || Object.prototype.hasOwnProperty.call(timePatch, field))) clip[field] = clone(clip[field]);
      }
      if (removeCurve) { delete clip.speedCurve; delete clip.sourceDuration; }
      if (clip.transition === null) delete clip.transition;
      if (clip.mask === null){ delete clip.mask;delete clip.maskAnimation; }
      for(const key of ['maskAnimation','visualEffects','audioEffects'])if(clip[key]===null)delete clip[key];
      if (clip.advancedColor === null) delete clip.advancedColor;
      if (owns('audioFade')) delete clip.audioEnvelope;
      if (clip.duration !== oldDuration && !owns('audioFade')) {
        if (clip.audioFade && retime) {
          clip.audioFade.in *= clip.duration / oldDuration; clip.audioFade.out *= clip.duration / oldDuration;
        }
        clampFade(clip);
        if (clip.audioEnvelope && !owns('audioEnvelope')) {
          if (retime) clip.audioEnvelope.forEach(point => { point.time *= clip.duration / oldDuration; });
          else clip.audioEnvelope = sliceEnvelope(clip.audioEnvelope, 0, clip.duration);
          clip.audioFade = summarizeEnvelope(clip.audioEnvelope);
        } else if (original.speedCurve && !retime && clip.duration < oldDuration && original.audioFade && !owns('audioEnvelope')) {
          clip.audioEnvelope = sliceEnvelope(audioEnvelopePoints(original), 0, clip.duration);
          clip.audioFade = summarizeEnvelope(clip.audioEnvelope);
        }
      }
      if (enteringMain) {
        next.clips.splice(next.clips.indexOf(clip), 1);
        const insertionIndex = next.clips.findIndex(existing => existing.track === 'video' && clipLayer(existing) === 0 && existing.start >= insertionTime);
        if (insertionIndex < 0) next.clips.push(clip); else next.clips.splice(insertionIndex, 0, clip);
      }
      if(original.maskAnimation&&!owns('maskAnimation')&&clip.mask&&clip.duration!==oldDuration){if(retime){clip.maskAnimation=clone(original.maskAnimation);clip.maskAnimation.keyframes.forEach(f=>f.time*=clip.duration/oldDuration);}else clip.maskAnimation=Visual.sliceAnimation(original.mask,original.maskAnimation,0,clip.duration);}
      if (!owns('keyframes') && clip.keyframes && clip.duration !== oldDuration) {
        // Changing the speed shape keeps animation at the same fraction of output
        // duration. A cut/trim instead retains the evaluated original trajectory.
        if (retime) clip.keyframes.forEach(frame => { frame.time *= clip.duration / oldDuration; });
        else if (clip.duration < oldDuration) Object.assign(clip, sliceAnimation(original, 0, clip.duration));
      }
    });
  }

  function splitClip(project, clipId, absoluteTime) {
    AudioModel.assertUnlocked(project,[clipId]);
    number(absoluteTime, '分割时间', 0);
    return edit(project, function (next) {
      const clip = item(next.clips, clipId, '片段');
      const leftDuration = absoluteTime - clip.start;
      if (leftDuration <= EPSILON || leftDuration >= clip.duration - EPSILON) fail('分割时间必须位于片段内部');
      const following = mainClips(next)[mainClips(next).findIndex(c => c.id === clip.id) + 1];
      if ((clip.transition && leftDuration < clip.transition.duration * 2 - EPSILON) ||
        (clip.track === 'video' && clipLayer(clip) === 0 && following && following.transition && clip.duration - leftDuration < following.transition.duration * 2 - EPSILON)) {
        fail('分割点过于靠近转场，请先缩短或移除相邻转场');
      }
      const originalMaskAnimation=clip.maskAnimation?clone(clip):null;
      const originalEnvelope = clip.audioFade || clip.audioEnvelope ? audioEnvelopePoints(clip) : null;
      const originalAnimation = clip.keyframes && clip.keyframes.length ? clone(clip) : null;
      const right = Object.assign({}, clone(clip), {
        id: newId('clip'), start: absoluteTime, duration: clip.duration - leftDuration,
        sourceIn: TimeMap.clipSourceTime(clip, leftDuration)
      });
      delete right.transition;
      if (clip.speedCurve) {
        const sourceSpan = clip.sourceDuration, fraction = (right.sourceIn - clip.sourceIn) / sourceSpan;
        right.speedCurve = TimeMap.sliceCurve(clip.speedCurve, fraction, 1); right.sourceDuration = sourceSpan * (1 - fraction);
        clip.speedCurve = TimeMap.sliceCurve(clip.speedCurve, 0, fraction); clip.sourceDuration = sourceSpan * fraction;
      }
      if (originalAnimation) {
        Object.assign(clip, sliceAnimation(originalAnimation, 0, leftDuration));
        Object.assign(right, sliceAnimation(originalAnimation, leftDuration, clip.duration));
      }
      if (originalEnvelope) {
        clip.audioEnvelope = sliceEnvelope(originalEnvelope, 0, leftDuration);
        right.audioEnvelope = sliceEnvelope(originalEnvelope, leftDuration, clip.duration);
        clip.audioFade = summarizeEnvelope(clip.audioEnvelope); right.audioFade = summarizeEnvelope(right.audioEnvelope);
      }
      if(originalMaskAnimation){clip.maskAnimation=Visual.sliceAnimation(originalMaskAnimation.mask,originalMaskAnimation.maskAnimation,0,leftDuration);right.maskAnimation=Visual.sliceAnimation(originalMaskAnimation.mask,originalMaskAnimation.maskAnimation,leftDuration,clip.duration);}
      clip.duration = leftDuration;
      next.clips.splice(next.clips.indexOf(clip) + 1, 0, right);
    });
  }

  function removeClip(project, clipId) { return removeClips(project, [clipId]); }

  function reorderClip(project, clipId, direction) {
    if (!isMagneticMain(project)) fail('关闭磁吸时请拖动片段调整位置，或先开启主轨磁吸再排序');
    if (direction !== -1 && direction !== 1) fail('排序方向必须为 -1 或 1');
    return edit(project, function (next) {
      const clip = item(next.clips, clipId, '片段');
      const matching = next.clips.map(function (entry, index) { return entry.track === clip.track && clipLayer(entry) === clipLayer(clip) ? index : -1; }).filter(function (index) { return index >= 0; });
      const position = matching.indexOf(next.clips.indexOf(clip));
      const targetPosition = position + direction;
      if (targetPosition < 0 || targetPosition >= matching.length) return;
      const a = matching[position], b = matching[targetPosition];
      const other = next.clips[b];
      next.clips[b] = clip;
      next.clips[a] = other;
    });
  }

  // All editing helpers below clone once and commit only after full validation.
  // Missing/offline media remains editable; source bounds use the saved metadata.
  function setMagneticMain(project, enabled) {
    if (typeof enabled !== 'boolean') fail('主轨磁吸必须是布尔值');
    return edit(project, next => { next.magneticMain = enabled; });
  }
  function clipIds(project, ids) {
    if (!Array.isArray(ids) || !ids.length) fail('请选择至少一个片段');
    const unique = [...new Set(ids)];
    for (const id of unique) { string(id, '片段 ID'); item(project.clips, id, '片段');AudioModel.assertUnlocked(project,[id]); }
    return new Set(unique);
  }
  function previousMainPairs(project) {
    const result = new Map(); let previous;
    for (const clip of mainClips(project)) { result.set(clip.id, previous && previous.id); previous = clip; }
    return result;
  }
  function cleanChangedTransitions(project, pairs) {
    let previous;
    for (const clip of mainClips(project)) {
      if (clip.transition && (!previous || pairs.get(clip.id) !== previous.id ||
        (!isMagneticMain(project) && Math.abs(previous.start + previous.duration - clip.start - clip.transition.duration) > EPSILON))) delete clip.transition;
      previous = clip;
    }
  }
  function removeClips(project, ids) {
    const selected = clipIds(project, ids), pairs = previousMainPairs(project);
    return edit(project, next => { next.clips = next.clips.filter(clip => !selected.has(clip.id)); cleanChangedTransitions(next, pairs); });
  }
  function layerOption(clips, options) {
    options = options || {}; patchKeys(options, ['layer','audioTrackId'], '组选轨道选项');
    if (options.layer === undefined) return;
    number(options.layer, '目标视频轨', 0, 8);
    if (!Number.isInteger(options.layer)) fail('目标视频轨必须是整数');
    const visual = clips.filter(c => c.track === 'video');
    if (!visual.length) fail('没有可移动到视频轨的画面片段');
    if (new Set(visual.map(clipLayer)).size > 1) fail('多层组选不能合并到单轨，请保持原层级或分别移动');
    for (const clip of visual) clip.layer = options.layer;
  }
  function contiguousMain(clips) {
    const ordered = clips.slice().sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) {
      const a = ordered[i - 1], b = ordered[i];
      if (Math.abs(b.start - (a.start + a.duration - (b.transition ? b.transition.duration : 0))) > EPSILON) return false;
    }
    return true;
  }
  function insertMainBlock(project, block, atTime) {
    const insertion = project.clips.findIndex(c => c.track === 'video' && clipLayer(c) === 0 && c.start >= atTime - EPSILON);
    if (insertion < 0) project.clips.push(...block); else project.clips.splice(insertion, 0, ...block);
  }
  function moveClips(project, ids, delta, options) {
    number(delta, '移动时间'); const selected = clipIds(project, ids), pairs = previousMainPairs(project);
    return edit(project, next => {
      const clips = next.clips.filter(c => selected.has(c.id));
      const oldMain = clips.filter(c => c.track === 'video' && clipLayer(c) === 0);
      if(options?.audioTrackId!==undefined){if(new Set(clips.filter(c=>c.track==='audio').map(c=>AudioModel.trackId(c))).size>1)fail('跨音轨编组保持原轨，请按单轨选择后移轨');const target=AudioModel.tracks(next).find(t=>t.id===options.audioTrackId);if(!target||target.locked)fail('目标音轨不存在或已锁定');for(const c of clips)if(c.track==='audio')c.audioTrackId=target.id;}
      layerOption(clips, options);
      const newMain = clips.filter(c => c.track === 'video' && clipLayer(c) === 0);
      if (isMagneticMain(next) && (oldMain.length || newMain.length)) {
        const leavingMain = oldMain.length === clips.length && newMain.length === 0;
        if (!leavingMain && (newMain.length !== clips.length || (oldMain.length && oldMain.length !== clips.length) || !contiguousMain(clips))) fail('包含主轨的跨轨或不连续组选移动，请先关闭主轨磁吸');
        if (leavingMain) {
          for (const clip of clips) { clip.start += delta; if (clip.start < 0) fail('组选移动后不能早于时间线起点'); delete clip.transition; }
          cleanChangedTransitions(next, pairs); return;
        }
        const block = mainClips(next).filter(c => selected.has(c.id)).sort((a, b) => a.start - b.start);
        const all = mainClips(next), first = all.findIndex(c => c.id === block[0].id);
        if (oldMain.length && all.slice(first, first + block.length).some(c => !selected.has(c.id))) fail('磁吸主轨只能一起移动连续片段，请先关闭磁吸');
        const target = Math.max(0, block[0].start + delta);
        next.clips = next.clips.filter(c => !selected.has(c.id));
        delete block[0].transition;
        insertMainBlock(next, block, target);
      } else {
        for (const clip of clips) { clip.start += delta; if (clip.start < -EPSILON) fail('组选移动后不能早于时间线起点'); if (clip.start < 0) clip.start = 0; }
        if (!isMagneticMain(next)) sortMainClips(next);
      }
      cleanChangedTransitions(next, pairs);
    });
  }
  function sourceAtExtended(clip, time) {
    const first = clip.speedCurve ? clip.speedCurve[0].speed : clip.speed;
    const last = clip.speedCurve ? clip.speedCurve[clip.speedCurve.length - 1].speed : clip.speed;
    if (time < 0) return clip.sourceIn + time * first;
    if (time > clip.duration) return clip.sourceIn + TimeMap.sourceDuration(clip) + (time - clip.duration) * last;
    return TimeMap.clipSourceTime(clip, time);
  }
  function curveForRange(clip, sourceStart, sourceEnd) {
    const span = TimeMap.sourceDuration(clip), left = sourceStart - clip.sourceIn, right = sourceEnd - clip.sourceIn;
    function speedAt(offset) {
      if (offset <= 0) return clip.speedCurve[0].speed;
      if (offset >= span) return clip.speedCurve[clip.speedCurve.length - 1].speed;
      const position = offset / span;
      for (let i = 1; i < clip.speedCurve.length; i++) {
        const a = clip.speedCurve[i - 1], b = clip.speedCurve[i];
        if (position <= b.position) return a.speed + (b.speed - a.speed) * (position - a.position) / (b.position - a.position);
      }
    }
    const points = [{ position: 0, speed: speedAt(left) }];
    for (const point of clip.speedCurve) {
      const offset = point.position * span;
      if (offset > left + 1e-12 && offset < right - 1e-12) points.push({ position: (offset - left) / (right - left), speed: point.speed });
    }
    points.push({ position: 1, speed: speedAt(right) });
    for (let i = points.length - 2; i > 0; i--) if (points[i - 1].speed === points[i].speed && points[i].speed === points[i + 1].speed) points.splice(i, 1);
    TimeMap.validateCurve(points); return points;
  }
  function trimClip(project, clipId, options) {
    AudioModel.assertUnlocked(project,[clipId]);
    patchKeys(options, ['edge', 'time'], '修剪选项');
    if (!['start', 'end'].includes(options.edge)) fail('修剪边缘必须为 start 或 end');
    number(options.time, '修剪时间');
    return edit(project, next => {
      const clip = item(next.clips, clipId, '片段'), original = clone(clip), asset = item(next.assets, clip.assetId, '素材');
      const minimum = Math.min(1 / next.fps, clip.duration), sourceSpan = TimeMap.sourceDuration(clip);
      const firstRate = clip.speedCurve ? clip.speedCurve[0].speed : clip.speed;
      const lastRate = clip.speedCurve ? clip.speedCurve[clip.speedCurve.length - 1].speed : clip.speed;
      let left = 0, right = clip.duration;
      if (options.edge === 'start') {
        let earliest = Math.max(-clip.start, asset.kind === 'image' ? -clip.start : -clip.sourceIn / firstRate);
        if (!isMagneticMain(next) && clip.track === 'video' && clipLayer(clip) === 0) {
          const all = mainClips(next), previous = all[all.findIndex(c => c.id === clip.id) - 1];
          if (previous) earliest = Math.max(earliest, (clip.transition ? Math.max(previous.start + previous.duration - previous.duration / 2, 2 * (previous.start + previous.duration) - (clip.start + clip.duration)) : previous.start + previous.duration) - clip.start);
        }
        left = Math.max(earliest, Math.min(clip.duration - minimum, options.time - clip.start));
      } else {
        let latest = asset.kind === 'image' ? Infinity : clip.duration + Math.max(0, asset.duration - clip.sourceIn - sourceSpan) / lastRate;
        if (!isMagneticMain(next) && clip.track === 'video' && clipLayer(clip) === 0) {
          const all = mainClips(next), following = all[all.findIndex(c => c.id === clip.id) + 1];
          if (following) latest = Math.min(latest, (following.transition ? Math.min(following.start + following.duration / 2, 2 * following.start - clip.start) : following.start) - clip.start);
        }
        right = Math.max(minimum, Math.min(latest, options.time - clip.start));
      }
      const sourceStart = Math.max(0, sourceAtExtended(original, left)), sourceEnd = sourceAtExtended(original, right);
      clip.start = Math.max(0, original.start + left); clip.sourceIn = sourceStart; clip.duration = right - left;
      if (clip.speedCurve) { clip.speedCurve = curveForRange(original, sourceStart, sourceEnd); clip.sourceDuration = sourceEnd - sourceStart; }
      if (original.transform || original.keyframes) {
        const start = Math.max(0, left), end = Math.min(original.duration, right), animation = sliceAnimation(original, start, end), prefix = start - left;
        for (const frame of animation.keyframes) frame.time += prefix;
        if (prefix > 0) animation.keyframes.unshift(Object.assign({ time: prefix, easing: 'linear' }, evaluateTransform(original, 0)));
        Object.assign(clip, animation);
      }
      if(original.maskAnimation)clip.maskAnimation=Visual.sliceAnimation(original.mask,original.maskAnimation,left,right);
      if (original.audioFade || original.audioEnvelope) {
        const points = sliceEnvelope(audioEnvelopePoints(original), Math.max(0, left), Math.min(original.duration, right)), prefix = Math.max(0, -left);
        for (const point of points) point.time += prefix;
        if (prefix > 0) points.unshift({ time: 0, gain: points[0].gain });
        if (right > original.duration) points.push({ time: clip.duration, gain: points[points.length - 1].gain });
        clip.audioEnvelope = points; clip.audioFade = summarizeEnvelope(points);
      }
      if (!isMagneticMain(next) && clip.track === 'video' && clipLayer(clip) === 0) {
        const all = mainClips(next), index = all.findIndex(c => c.id === clip.id), previous = all[index - 1], following = all[index + 1];
        if (clip.transition) {
          const overlap = previous.start + previous.duration - clip.start;
          if (overlap > EPSILON) clip.transition.duration = overlap; else delete clip.transition;
        }
        if (following && following.transition) {
          const overlap = clip.start + clip.duration - following.start;
          if (overlap > EPSILON) following.transition.duration = overlap; else delete following.transition;
        }
      }
    });
  }
  function copyItems(project, selections) {
    validateProject(project);
    if (!Array.isArray(selections) || !selections.length) fail('请选择至少一个片段或字幕');
    const clips = [], subtitles = [], texts = [], seen = new Set();
    for (const selection of selections) {
      patchKeys(selection, ['type', 'id'], '复制选择');
      if (!['clip', 'subtitle','text'].includes(selection.type)) fail('不支持的复制类型');
      string(selection.id, '选择 ID'); const key = selection.type + ':' + selection.id;
      if (seen.has(key)) continue; seen.add(key);
      (selection.type === 'clip' ? clips : selection.type==='text'?texts:subtitles).push(clone(item(selection.type === 'clip' ? project.clips : selection.type==='text'?(project.texts||[]):project.subtitles, selection.id, '复制对象')));
    }
    const origin = Math.min(...clips.map(c => c.start), ...subtitles.map(c => c.start),...texts.map(c=>c.start));
    const selected = new Set(clips.map(c => c.id)), allMain = mainClips(project);
    for (const clip of clips) {
      if (clip.transition) {
        const index = allMain.findIndex(c => c.id === clip.id);
        if (index < 1 || !selected.has(allMain[index - 1].id)) delete clip.transition;
      }
      clip.start -= origin;
    }
    for (const cue of [...subtitles,...texts]) { cue.start -= origin; cue.end -= origin; }
    clips.sort((a, b) => a.start - b.start);
    return { schemaVersion: 1, type: 'yingxu-items', assets: clone(project.assets.filter(a => clips.some(c => c.assetId === a.id))), clips, subtitles, texts, audioTracks:clone(project.audioTracks||[]),groups:clone((project.groups||[]).filter(g=>g.members.every(m=>seen.has(m.type+':'+m.id)))) };
  }
  function pasteItems(project, payload, atTime, options) {
    validateProject(project); object(payload, '剪贴板'); number(atTime, '粘贴时间', 0);
    if (payload.schemaVersion !== 1 || payload.type !== 'yingxu-items' || !Array.isArray(payload.assets) || !Array.isArray(payload.clips) || !Array.isArray(payload.subtitles) || (!payload.clips.length && !payload.subtitles.length && !(payload.texts||[]).length)) fail('不支持的剪贴板内容');
    const snapshot = clone(payload), selection = [],idMap=new Map();snapshot.texts=snapshot.texts||[];if(!Array.isArray(snapshot.texts))fail('剪贴板文字无效');
    const result = edit(project, next => {
      const sourceAssets = new Map(snapshot.assets.map(a => [a.id, a])), resolved = new Map();
      const trackMap=new Map();for(const c of snapshot.clips.filter(x=>x.track==='audio'&&x.audioTrackId)){if(trackMap.has(c.audioTrackId))continue;const found=AudioModel.tracks(next).find(t=>t.id===c.audioTrackId);if(found){if(found.locked)fail('粘贴目标音轨已锁定');trackMap.set(c.audioTrackId,found.id);continue;}const src=(snapshot.audioTracks||[]).find(t=>t.id===c.audioTrackId);if(!src)fail('剪贴板音轨无效');next.audioTracks=clone(AudioModel.tracks(next));if(next.audioTracks.length>=8)fail('音轨数量已满');const t=Object.assign({},src,{id:newId('audio-track'),locked:false});next.audioTracks.push(t);trackMap.set(c.audioTrackId,t.id);}
      for(const c of snapshot.clips){if(trackMap.has(c.audioTrackId))c.audioTrackId=trackMap.get(c.audioTrackId);if(c.track==='audio'){const target=AudioModel.getTrack(next,c)||(!c.audioTrackId?AudioModel.tracks(next)[0]:null);if(!target||target.locked)fail('粘贴目标音轨不存在或已锁定');if(next.audioTracks!==undefined||c.audioTrackId!==undefined)c.audioTrackId=target.id;}}
      for (const clip of snapshot.clips) {
        const source = sourceAssets.get(clip.assetId); if (!source) fail('剪贴板缺少素材记录');
        if (!resolved.has(source.id)) {
          const normalizePath = value => typeof value === 'string' ? value.split(String.fromCharCode(92)).join('/').toLowerCase() : '';
          let asset = next.assets.find(a => normalizePath(a.path) === normalizePath(source.path) && a.kind === source.kind && a.duration === source.duration && a.width === source.width && a.height === source.height);
          if (!asset) { asset = clone(source); asset.id = newId('asset'); next.assets.push(asset); }
          resolved.set(source.id, asset.id);
        }
        const sourceClipId=clip.id;clip.id = newId('clip');idMap.set(sourceClipId,clip.id); clip.assetId = resolved.get(clip.assetId); number(clip.start, '剪贴板片段开始时间', 0); clip.start += atTime;
        selection.push({ type: 'clip', id: clip.id });
      }
      layerOption(snapshot.clips, options);
      for (const cue of snapshot.subtitles) {
        number(cue.start, '剪贴板字幕开始时间', 0); number(cue.end, '剪贴板字幕结束时间', 0);
        const oldId=cue.id;cue.id = newId('subtitle');idMap.set(oldId,cue.id); cue.start += atTime; cue.end += atTime; selection.push({ type: 'subtitle', id: cue.id });
      }
      for(const cue of snapshot.texts){number(cue.start,'文字开始',0);number(cue.end,'文字结束',0);const oldId=cue.id;cue.id=newId('text');idMap.set(oldId,cue.id);cue.start+=atTime;cue.end+=atTime;selection.push({type:'text',id:cue.id});}
      const block = snapshot.clips.filter(c => c.track === 'video' && clipLayer(c) === 0).sort((a, b) => a.start - b.start);
      if (isMagneticMain(next) && block.length) {
        if (block.length !== snapshot.clips.length || snapshot.subtitles.length || snapshot.texts.length || !contiguousMain(block)) fail('主轨与其它轨道、字幕或带空隙的组选粘贴，请先关闭主轨磁吸以保留相对位置');
        const pairs = previousMainPairs(next);
        delete block[0].transition; insertMainBlock(next, block, atTime);
        for (let i = 1; i < block.length; i++) pairs.set(block[i].id, block[i - 1].id);
        cleanChangedTransitions(next, pairs);
      } else next.clips.push(...snapshot.clips);
      next.subtitles.push(...snapshot.subtitles);if(snapshot.texts.length){next.texts=next.texts||[];next.texts.push(...snapshot.texts);}if(snapshot.groups?.length){next.groups=next.groups||[];for(const g of snapshot.groups){if(!g.members.every(m=>idMap.has(m.id)))fail('剪贴板编组不完整');next.groups.push({id:newId('group'),name:g.name,members:g.members.map(m=>({type:m.type,id:idMap.get(m.id)}))});}}
    });
    return { project: result, selection };
  }

  function setClipTransition(project, clipId, transition) {
    const clip = item(project.clips, clipId, '片段');
    if (transition && (clip.track !== 'video' || clipLayer(clip) !== 0 || mainClips(project)[0].id === clip.id)) fail('转场只能用于主轨第二个及后续片段');
    return updateClip(project, clipId, { transition: transition });
  }
  function setClipKeyframe(project, clipId, time, input, options) {
    const clip = item(project.clips, clipId, '片段'); number(time, '关键帧时间', 0, clip.duration);
    validatePose(input, '关键帧'); options = options || {}; patchKeys(options, ['easing'], '关键帧选项'); validateEasing(options);
    const keys = clone(clip.keyframes || []), existing = keys.find(frame => Math.abs(frame.time - time) <= EPSILON);
    const frame = Object.assign({}, existing || {}, { time: time }, pose(input));
    if (!existing) {
      const all = animationKeys(clip), index = all.findIndex(key => key.time > time);
      if (index > 0) {
        const previous = all[index - 1], following = all[index], ratio = (time - previous.time) / (following.time - previous.time);
        if (ratio > 0 && ratio < 1) {
          Object.assign(frame, curvePart(following, 0, ratio));
          Object.assign(keys.find(key => key.time === following.time), curvePart(following, ratio, 1));
        }
      }
    }
    if (options.easing !== undefined) { frame.easing = options.easing; delete frame.easingWindow; }
    const updated = keys.filter(key => Math.abs(key.time - time) > EPSILON); updated.push(frame); updated.sort((a, b) => a.time - b.time);
    return updateClip(project, clipId, { keyframes: updated });
  }
  function removeClipKeyframe(project, clipId, time) {
    const clip = item(project.clips, clipId, '片段'); number(time, '关键帧时间', 0);
    const keys = clone(clip.keyframes || []), index = keys.findIndex(frame => Math.abs(frame.time - time) <= EPSILON);
    if (index < 0) return updateClip(project, clipId, { keyframes: keys });
    const removed = keys[index], following = keys[index + 1];
    if (removed.time > 0 && following) {
      const left = removed.easingWindow || [0, 1], right = following.easingWindow || [0, 1];
      if ((removed.easing || 'linear') === (following.easing || 'linear') && Math.abs(left[1] - right[0]) <= 1e-12) {
        // Rejoin two pieces created by inserting a key on an existing curve.
        following.easingWindow = [left[0], right[1]];
      } else {
        // Deleting a junction between different curves intentionally uses the
        // following key's complete preset over its new incoming interval.
        delete following.easingWindow;
      }
    }
    keys.splice(index, 1); return updateClip(project, clipId, { keyframes: keys });
  }
  function addSubtitle(project, input) {
    object(input, '字幕');
    const cue = Object.assign({ id: newId('subtitle') }, clone(input));
    return edit(project, function (next) { next.subtitles.push(cue); });
  }

  function updateSubtitle(project, subtitleId, patch) {
    patchKeys(patch, ['start', 'end', 'text', 'style'], '字幕更新');
    return edit(project, function (next) { Object.assign(item(next.subtitles, subtitleId, '字幕'), patch); });
  }

  function removeSubtitle(project, subtitleId) {
    return edit(project, function (next) {
      const cue = item(next.subtitles, subtitleId, '字幕');
      next.subtitles.splice(next.subtitles.indexOf(cue), 1);
    });
  }

  function parseSrt(text) {
    string(text, 'SRT 内容', true);
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (!normalized) return [];
    function parseTime(value) {
      const match = /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value);
      if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) fail('SRT 时间格式无效：' + value);
      const result = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000;
      number(result, 'SRT 时间', 0);
      return result;
    }
    return normalized.split(/\n[ \t]*\n+/).map(function (block, index) {
      const lines = block.split('\n');
      if (/^\d+$/.test(lines[0].trim())) lines.shift();
      const timing = /^([0-9:,.]+)\s*-->\s*([0-9:,.]+)$/.exec((lines.shift() || '').trim());
      if (!timing) fail('第 ' + (index + 1) + ' 条 SRT 字幕缺少有效时间行');
      const cue = { start: parseTime(timing[1]), end: parseTime(timing[2]), text: lines.join('\n').trim() };
      validateSubtitle(cue, '第 ' + (index + 1) + ' 条字幕');
      return cue;
    });
  }

  function toSrt(subtitles) {
    if (!Array.isArray(subtitles)) fail('字幕必须是数组');
    const sorted = subtitles.map(function (cue, index) {
      validateSubtitle(cue, '第 ' + (index + 1) + ' 条字幕');
      return { cue: cue, index: index };
    }).sort(function (a, b) { return a.cue.start - b.cue.start || a.index - b.index; });
    function formatTime(milliseconds) {
      const hours = Math.floor(milliseconds / 3600000);
      const minutes = Math.floor(milliseconds / 60000) % 60;
      const seconds = Math.floor(milliseconds / 1000) % 60;
      const fraction = milliseconds % 1000;
      return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0') + ',' + String(fraction).padStart(3, '0');
    }
    return sorted.map(function (entry, index) {
      const start = Math.round(entry.cue.start * 1000);
      const end = Math.max(start + 1, Math.round(entry.cue.end * 1000));
      return String(index + 1) + '\r\n' + formatTime(start) + ' --> ' + formatTime(end) + '\r\n' + entry.cue.text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
    }).join('\r\n\r\n') + (sorted.length ? '\r\n' : '');
  }

  function addText(p,input){return validateProject(TextStyle.addText(p,input));}
  function updateText(p,id,patch){return validateProject(TextStyle.updateText(p,id,patch));}
  function removeText(p,id){return edit(p,next=>{next.texts=(next.texts||[]).filter(x=>x.id!==id);});}
  function expandGroups(p,selections){const by=new Map(selections.map(s=>[s.type+':'+s.id,s]));for(const g of p.groups||[])if(g.members.some(m=>by.has(m.type+':'+m.id)))for(const m of g.members)by.set(m.type+':'+m.id,clone(m));return [...by.values()];}
  function groupItems(p,selections){if(selections.length<2)fail('至少选择两个对象编组');return edit(p,next=>{const ids=new Set(selections.map(s=>s.id));next.groups=(next.groups||[]).filter(g=>!g.members.some(m=>ids.has(m.id)));next.groups.push({id:newId('group'),name:'编组',members:clone(selections)});});}
  function ungroupItems(p,selections){return edit(p,next=>{const ids=new Set(selections.map(s=>s.id));next.groups=(next.groups||[]).filter(g=>!g.members.some(m=>ids.has(m.id)));});}

  return Object.freeze({
    addText,updateText,removeText,expandGroups,groupItems,ungroupItems,defaultAudioTrackId:p=>AudioModel.tracks(p)[0].id,
    clipSourceDuration: TimeMap.sourceDuration, clipSourceTime: TimeMap.clipSourceTime, clipLocalTimeForSource: TimeMap.clipLocalTimeForSource,
    clipPlaybackRate: TimeMap.clipPlaybackRate, curveSegmentPlan: TimeMap.curveSegmentPlan,
    cropRect: cropRect, adjustRgb: adjustRgb, evaluateMaskAlpha: evaluateMaskAlpha, normalizedEasingProgress: normalizedEasingProgress, audioEnvelopePoints: audioEnvelopePoints,
    clipLayer: clipLayer, evaluateTransform: evaluateTransform, visualOpacity: visualOpacity, audioGain: audioGain,
    getActiveVisualClips: getActiveVisualClips, setClipTransition: setClipTransition,
    setClipKeyframe: setClipKeyframe, removeClipKeyframe: removeClipKeyframe,
    createProject: createProject, validateProject: validateProject, projectDuration: projectDuration,
    addAsset: addAsset, addClip: addClip, updateClip: updateClip, splitClip: splitClip,
    removeClip: removeClip, reorderClip: reorderClip, addSubtitle: addSubtitle,
    isMagneticMain: isMagneticMain, setMagneticMain: setMagneticMain, trimClip: trimClip,
    moveClips: moveClips, removeClips: removeClips, copyItems: copyItems, pasteItems: pasteItems,
    updateSubtitle: updateSubtitle, removeSubtitle: removeSubtitle, parseSrt: parseSrt, toSrt: toSrt
  });
});


