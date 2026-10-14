// Heuristic longer-range visual chapter proposals (not semantic AI recognition).
// These compare the visual appearance before and after each timestamp rather than
// only checking adjacent frames for hard cuts.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const round=n=>Math.round(n*1000)/1000;

function distance(a,b){
  if(a.grid.length!==b.grid.length||a.histogram.length!==b.histogram.length)
    throw Error('Mismatched frame signatures');
  let color=0,luma=0;
  for(let i=0;i<a.grid.length;i++) color+=Math.abs(a.grid[i]-b.grid[i]);
  for(let i=0;i<a.histogram.length;i++) luma+=Math.abs(a.histogram[i]-b.histogram[i]);
  return clamp(.72*color/a.grid.length + .28*luma/2,0,1);
}

function meanSignature(samples,start,end){
  const grid=Array(samples[0].signature.grid.length).fill(0);
  const histogram=Array(samples[0].signature.histogram.length).fill(0);
  const n=end-start;
  for(let i=start;i<end;i++){
    const s=samples[i].signature;
    for(let k=0;k<grid.length;k++)grid[k]+=s.grid[k]/n;
    for(let k=0;k<histogram.length;k++)histogram[k]+=s.histogram[k]/n;
  }
  return {grid,histogram};
}


/**
 * Give a distinct late transition a chance when global strongest-peak ranking
 * has filled the scene budget. A brief brightness flash alone is insufficient:
 * the frames on both sides must also differ over a longer time window.
 * This is video-independent and never assumes a fixed outro timestamp.
 */
export function recoverTailChapter(samples, selected, {
  minShotDuration = 1.5, maxChapters = 80, windowSeconds = 1.5
} = {}) {
  if (!Array.isArray(samples) || samples.length < 10) return selected;
  const duration = samples.at(-1).at;
  const ordered = [...selected].sort((a,b)=>a.at-b.at);
  const last = ordered.at(-1)?.at ?? 0;
  // No recovery needed when the ending already has a properly separated shot.
  if (duration - last < Math.max(5, duration * 0.11)) return ordered;

  const sampleStep = (duration - samples[0].at) / (samples.length-1);
  if (!Number.isFinite(sampleStep) || sampleStep <= 0) return ordered;
  const n = Math.max(2,Math.round(windowSeconds/sampleStep));
  const candidates = [];
  const from = Math.max(last + minShotDuration - 0.001, duration * 0.7);
  const to = duration - Math.max(2, minShotDuration);
  for (let i = n; i < samples.length-n; i++) {
    const at = samples[i].at;
    if (at < from || at > to) continue;
    if (ordered.some(k => Math.abs(k.at-at) < minShotDuration - 0.001)) continue;
    const current = distance(samples[i].signature, samples[i-1].signature);
    const prev = i>1?distance(samples[i-1].signature,samples[i-2].signature):0;
    const next = i<samples.length-1?distance(samples[i+1].signature,samples[i].signature):0;
    if (current < 0.075 || current < prev || current < next) continue;
    const before=meanSignature(samples,i-n,i);
    const after=meanSignature(samples,i+1,i+n+1);
    const sustained=distance(before,after);
    if (sustained < 0.045) continue; // Reject isolated flashes.
    candidates.push({at:round(at),score:round(current+0.5*sustained),
      automatic:true,method:'tail-visual-chapter'});
  }
  if (!candidates.length) return ordered;
  candidates.sort((a,b)=>b.score-a.score || b.at-a.at);
  const candidate=candidates[0];
  const total = Math.max(2,Math.floor(maxChapters));
  if (ordered.length >= total-1) {
    // Trade the lowest-confidence global peak for a strongly evidenced ending.
    let weakest=0;
    for(let i=1;i<ordered.length;i++)if(ordered[i].score<ordered[weakest].score)weakest=i;
    if(candidate.score < Math.max(.075,(ordered[weakest].score || 0)*.65))return ordered;
    ordered.splice(weakest,1);
  }
  ordered.push(candidate);
  return ordered.sort((a,b)=>a.at-b.at);
}

export function detectVisualChapters(samples,{
  sensitivity='balanced',minShotDuration=1.5,
  windowSeconds=1.5,maxChapters=null
}={}){
  if(!Array.isArray(samples)||samples.length<6)return [];
  const step=(samples.at(-1).at-samples[0].at)/(samples.length-1);
  if(!Number.isFinite(step)||step<=0)return [];
  const n=Math.max(2,Math.round(windowSeconds/step));
  if(samples.length<2*n+2)return [];
  const duration=samples.at(-1).at;
  const scores=[];
  for(let i=n;i<samples.length-n;i++){
    const before=meanSignature(samples,i-n,i);
    const after=meanSignature(samples,i+1,i+n+1);
    scores.push({at:samples[i].at,score:distance(before,after)});
  }
  const peaks=scores.filter((s,i)=>s.score>0.005
      && s.score>=(scores[i-1]?.score??-1)
      && s.score>=(scores[i+1]?.score??-1));
  if(!peaks.length)return [];
  const strengths=peaks.map(p=>p.score).sort((a,b)=>a-b);
  const quantile=q=>strengths[Math.min(strengths.length-1,Math.floor(q*(strengths.length-1)))];
  const q={high:.15,balanced:.35,low:.55,verylow:.75}[sensitivity]??.35;
  const cutoff=Math.max(.014,quantile(q));
  const desired=maxChapters===null
      ?Math.max(2,Math.ceil(duration/({high:3.5,balanced:5,low:7,verylow:10}[sensitivity]??5)))
      :Math.max(2,Math.floor(maxChapters));
  const result=[];
  for(const p of peaks.sort((a,b)=>b.score-a.score)){
    if(result.length>=desired-1)break;
    if(p.score<cutoff||p.at<minShotDuration||duration-p.at<minShotDuration)continue;
    if(result.some(c=>Math.abs(c.at-p.at)<minShotDuration))continue;
    result.push({at:round(p.at),score:round(p.score),automatic:true,method:'visual-chapter'});
  }
  return recoverTailChapter(samples,result,{minShotDuration,maxChapters:desired,windowSeconds});
}
