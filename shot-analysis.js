// Pure, deterministic shot-cut analysis. No AI, network, or browser API required.
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const rnd = n => Math.round(n * 1000) / 1000;

export function frameSignature(imageData) {
  const { data, width, height } = imageData;
  if (!width || !height || !data || data.length < width * height * 4)
    throw Error('Invalid decoded video frame');
  const histogram = Array(16).fill(0);
  const grid = [];
  const cols = 12, rows = 7;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      let r = 0, g = 0, b = 0, count = 0;
      const left = Math.floor(gx * width / cols);
      const right = Math.max(left + 1, Math.floor((gx + 1) * width / cols));
      const top = Math.floor(gy * height / rows);
      const bottom = Math.max(top + 1, Math.floor((gy + 1) * height / rows));
      for (let y = top; y < Math.min(height, bottom); y++) {
        for (let x = left; x < Math.min(width, right); x++) {
          const i = (y * width + x) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
          const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          histogram[Math.min(15, Math.floor(luma / 16))]++;
        }
      }
      grid.push(r / count / 255, g / count / 255, b / count / 255);
    }
  }
  const total = histogram.reduce((a,b) => a + b, 0);
  return { histogram: histogram.map(n => n / total), grid };
}

export function changeScore(a, b) {
  if (!a || !b || a.grid.length !== b.grid.length || a.histogram.length !== b.histogram.length)
    throw Error('Frame signatures do not match');
  let spatial = 0, hist = 0;
  for (let i = 0; i < a.grid.length; i++) spatial += Math.abs(a.grid[i] - b.grid[i]);
  for (let i = 0; i < a.histogram.length; i++) hist += Math.abs(a.histogram[i] - b.histogram[i]);
  return clamp(0.64 * (spatial / a.grid.length) + 0.36 * (hist / 2), 0, 1);
}

export function detectShotCuts(samples, { threshold = 0.20, minShotDuration = 1.5, maxShots = 80 } = {}) {
  if (!Array.isArray(samples) || samples.length < 2) return [];
  const scores = samples.slice(1).map((f, i) => ({ at: f.at, score: changeScore(samples[i].signature, f.signature) }));
  const candidate = scores.filter((c, i) => {
    const prev = scores[i-1]?.score ?? -1;
    const next = scores[i+1]?.score ?? -1;
    return c.score >= threshold && c.score >= prev && c.score >= next;
  }).sort((a, b) => b.score - a.score);
  const cuts = [];
  const duration = samples.at(-1).at;
  for (const c of candidate) {
    if (cuts.length >= maxShots - 1) break;
    if (c.at < minShotDuration || duration - c.at < minShotDuration) continue;
    if (cuts.some(k => Math.abs(k.at - c.at) < minShotDuration)) continue;
    cuts.push({ at: rnd(c.at), score: rnd(c.score), automatic: true });
  }
  return cuts.sort((a,b) => a.at - b.at);
}

export function normalizeCuts(cuts, duration, minShotDuration = 0.15) {
  const sorted = cuts.map(c => typeof c === 'number' ? { at: c, automatic: false } : c)
    .filter(c => Number.isFinite(c.at) && c.at > 0 && c.at < duration)
    .sort((a,b) => a.at - b.at);
  const cleaned = [];
  for (const cut of sorted) {
    if (cut.at - (cleaned.at(-1)?.at ?? 0) < minShotDuration) continue;
    if (duration - cut.at < minShotDuration) continue;
    cleaned.push({ at: rnd(cut.at), score: cut.score ?? 0, automatic: cut.automatic === true });
  }
  return cleaned;
}

export function createDraftTimeline({ duration, fps = 30, cuts = [], title = 'Imported video' }) {
  if (!Number.isFinite(duration) || duration <= 0) throw Error('Video duration must be finite and positive');
  const bounds = [0, ...normalizeCuts(cuts, duration).map(c => c.at), duration];
  const shots = [], camera = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = rnd(bounds[i]), end = i === bounds.length-2 ? duration : rnd(bounds[i+1]);
    const shotId = 'draft_' + String(i + 1).padStart(3, '0');
    const span = end-start, drift = (i % 3 - 1) * 1.5;
    shots.push({
      id: shotId, start, end, name: 'Shot ' + String(i+1).padStart(2, '0') + ' · blockout pending',
      title: 'VIDEO SHOT ' + String(i+1).padStart(2, '0'),
      tone: ['teal', 'amber', 'purple'][i%3], draft: true,
      sourceFrameTime: rnd(start + span * 0.5),
      endFrameTime: rnd(Math.max(start, end - Math.min(0.5, span * 0.12)))
    });
    camera.push({ id:'video_cam_'+(i+1)+'_start', at:start, p:[drift,5,22], t:[0,3,0], fov:55, cut:i!==0, generated:'placeholder' });
    if (span > 0.12) camera.push({
      id:'video_cam_'+(i+1)+'_end', at:rnd(end - Math.min(0.04, span * .2)),
      p:[drift*.5,4.5,17], t:[0,3,0], fov:53, generated:'placeholder'
    });
  }
  return {
    title, duration, fps, shots, camera, text: [],
    videoIntake: { version:1, mode:'cut-detection-only', referenceVideo:title,
      note:'Shots are estimated from pixel changes. Geometry is a generic placeholder, and cameras are NOT recovered from footage. Manually review every cut.' }
  };
}
