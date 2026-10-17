/* Positive piecewise-linear source-speed maps, shared by preview and export. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EditorTimeMap = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MIN_SPEED = 0.25, MAX_SPEED = 4, MAX_POINTS = 32;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  function finite(value, label) { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(label + '必须是有限数值'); }
  function validateCurve(curve) {
    if (!Array.isArray(curve) || curve.length < 2 || curve.length > MAX_POINTS) throw new Error('速度曲线需包含 2–32 个锚点');
    let previous = -1;
    curve.forEach(function (point) {
      if (!point || typeof point !== 'object' || Array.isArray(point) || Object.keys(point).some(key => !['position', 'speed'].includes(key))) throw new Error('速度曲线锚点仅支持 position 和 speed');
      finite(point.position, '速度曲线源进度'); finite(point.speed, '速度曲线速度');
      if (point.position < 0 || point.position > 1 || point.position <= previous) throw new Error('速度曲线源进度必须在 0–1 严格升序');
      if (point.speed < MIN_SPEED || point.speed > MAX_SPEED) throw new Error('速度曲线速度必须在 0.25–4 之间');
      previous = point.position;
    });
    if (curve[0].position !== 0 || curve[curve.length - 1].position !== 1) throw new Error('速度曲线必须覆盖源进度 0 和 1');
    return true;
  }
  // A unit map uses source progress as its coordinate. All durations scale with
  // sourceDuration. log1p/expm1 retain precision for nearly constant slopes.
  function elapsed(sourceSpan, speed, slope) {
    return slope === 0 ? sourceSpan / speed : Math.log1p(slope * sourceSpan / speed) / slope;
  }
  function distance(localSpan, speed, slope) {
    return slope === 0 ? localSpan * speed : speed * Math.expm1(slope * localSpan) / slope;
  }
  function unitPlan(curve) {
    validateCurve(curve);
    let cursor = 0;
    const segments = [];
    for (let index = 1; index < curve.length; index++) {
      const a = curve[index - 1], b = curve[index], slope = (b.speed - a.speed) / (b.position - a.position);
      const end = cursor + elapsed(b.position - a.position, a.speed, slope);
      segments.push({ sourceStart: a.position, sourceEnd: b.position, localStart: cursor, localEnd: end, startSpeed: a.speed, endSpeed: b.speed, slope: slope });
      cursor = end;
    }
    return { segments: segments, duration: cursor };
  }
  function durationForCurve(sourceDuration, curve) {
    finite(sourceDuration, '源区间时长'); if (sourceDuration <= 0) throw new Error('源区间时长必须大于 0');
    return sourceDuration * unitPlan(curve).duration;
  }
  function sourceDuration(clip) { return clip.speedCurve ? clip.sourceDuration : clip.duration * clip.speed; }
  function sourceProgress(clip, local) {
    const time = clamp(local, 0, clip.duration);
    if (!clip.speedCurve) return time / clip.duration;
    const map = unitPlan(clip.speedCurve), target = time / clip.sourceDuration;
    if (time === clip.duration) return 1;
    const segment = map.segments.find(entry => target <= entry.localEnd) || map.segments[map.segments.length - 1];
    return clamp(segment.sourceStart + distance(target - segment.localStart, segment.startSpeed, segment.slope), 0, 1);
  }
  function localAtProgress(clip, position) {
    const progress = clamp(position, 0, 1);
    if (!clip.speedCurve) return progress * clip.duration;
    if (progress === 1) return clip.duration;
    const map = unitPlan(clip.speedCurve), segment = map.segments.find(entry => progress <= entry.sourceEnd) || map.segments[map.segments.length - 1];
    return clip.sourceDuration * (segment.localStart + elapsed(progress - segment.sourceStart, segment.startSpeed, segment.slope));
  }
  function clipSourceTime(clip, local) { return clip.sourceIn + sourceDuration(clip) * sourceProgress(clip, local); }
  function clipLocalTimeForSource(clip, absoluteSource) { return localAtProgress(clip, (absoluteSource - clip.sourceIn) / sourceDuration(clip)); }
  function speedAtProgress(curve, position) {
    const p = clamp(position, 0, 1);
    for (let i = 1; i < curve.length; i++) if (p <= curve[i].position) {
      const a = curve[i - 1], b = curve[i]; return a.speed + (b.speed - a.speed) * (p - a.position) / (b.position - a.position);
    }
    return curve[curve.length - 1].speed;
  }
  function clipPlaybackRate(clip, local) { return clip.speedCurve ? speedAtProgress(clip.speedCurve, sourceProgress(clip, local)) : clip.speed; }
  function sliceCurve(curve, start, end) {
    validateCurve(curve); finite(start, '源曲线裁剪起点'); finite(end, '源曲线裁剪终点');
    if (start < 0 || end > 1 || end <= start) throw new Error('源曲线裁剪区间无效');
    const points = [{ position: 0, speed: speedAtProgress(curve, start) }];
    for (const point of curve) if (point.position > start && point.position < end) points.push({ position: (point.position - start) / (end - start), speed: point.speed });
    points.push({ position: 1, speed: speedAtProgress(curve, end) });
    return points;
  }
  function curveSegmentPlan(clip, options) {
    options = options || {};
    if (options.maxOutputStep !== undefined) { finite(options.maxOutputStep, '变速分段时长'); if (options.maxOutputStep <= 0) throw new Error('变速分段时长必须大于 0'); }
    const span = sourceDuration(clip);
    const base = clip.speedCurve ? unitPlan(clip.speedCurve).segments.map(function (segment) {
      return { sourceStart: clip.sourceIn + segment.sourceStart * span, sourceEnd: clip.sourceIn + segment.sourceEnd * span,
        localStart: segment.localStart * span, localEnd: segment.localEnd * span, startSpeed: segment.startSpeed, endSpeed: segment.endSpeed, slope: segment.slope / span };
    }) : [{ sourceStart: clip.sourceIn, sourceEnd: clip.sourceIn + span, localStart: 0, localEnd: clip.duration, startSpeed: clip.speed, endSpeed: clip.speed, slope: 0 }];
    const output = [];
    for (const segment of base) {
      const count = options.maxOutputStep ? Math.max(1, Math.ceil((segment.localEnd - segment.localStart) / options.maxOutputStep)) : 1;
      if (!Number.isSafeInteger(count) || count > 1000000 || output.length + count > 1000000) throw new Error('变速分段过多，请增大分段时长');
      for (let index = 0; index < count; index++) {
        const t0 = (segment.localEnd - segment.localStart) * index / count, t1 = (segment.localEnd - segment.localStart) * (index + 1) / count;
        const s0 = index === 0 ? segment.sourceStart : segment.sourceStart + distance(t0, segment.startSpeed, segment.slope);
        const s1 = index === count - 1 ? segment.sourceEnd : segment.sourceStart + distance(t1, segment.startSpeed, segment.slope);
        const localStart = segment.localStart + t0, localEnd = segment.localStart + t1;
        const startSpeed = segment.startSpeed + segment.slope * (s0 - segment.sourceStart), endSpeed = segment.startSpeed + segment.slope * (s1 - segment.sourceStart);
        // Constant-rate approximation error bound in source seconds for audio.
        const maxSourceError = Math.abs(segment.slope) * Math.max(startSpeed, endSpeed) * Math.pow(localEnd - localStart, 2) / 8;
        output.push({ sourceStart: s0, sourceEnd: s1, localStart: localStart, localEnd: localEnd,
          startSpeed: startSpeed, endSpeed: endSpeed, slope: segment.slope, rate: (s1 - s0) / (localEnd - localStart), maxSourceError: maxSourceError });
      }
    }
    if (output.length) { output[0].localStart = 0; output[output.length - 1].localEnd = clip.duration; }
    return output;
  }
  return Object.freeze({ MIN_SPEED: MIN_SPEED, MAX_SPEED: MAX_SPEED, MAX_POINTS: MAX_POINTS,
    validateCurve: validateCurve, durationForCurve: durationForCurve, sourceDuration: sourceDuration,
    clipSourceTime: clipSourceTime, clipLocalTimeForSource: clipLocalTimeForSource, clipPlaybackRate: clipPlaybackRate,
    curveSegmentPlan: curveSegmentPlan, sliceCurve: sliceCurve, speedAtProgress: speedAtProgress });
});
