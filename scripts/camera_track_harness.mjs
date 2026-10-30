#!/usr/bin/env node
// Synthetic camera-track harness: projects known 3D scenes through known
// camera paths (with noise, outliers, moving objects and short tracks),
// solves them with camera-track-solver.js and reports gauge-free errors.
// Offline only: no video, network, provider or model call.
//   node scripts/camera_track_harness.mjs            # table, exit 1 on any miss
//   node scripts/camera_track_harness.mjs --json     # machine-readable report
//   node scripts/camera_track_harness.mjs orbit pan  # only names containing these
//   node scripts/camera_track_harness.mjs --video    # rendered frames -> feature tracker -> solver
import {SCENARIOS,VIDEO_SCENARIOS,runScenario,renderSyntheticVideo,evaluateTrackedVideo} from '../tests/camera-track-fixtures.mjs';
import {solveCameraTracks,trackSolveToVideoMotion} from '../camera-track-solver.js';
import {createTrackSession} from '../camera-track-pipeline.js';

const args=process.argv.slice(2),json=args.includes('--json'),video=args.includes('--video'),filters=args.filter(a=>!a.startsWith('--'));
// Video limits: the tracker adds ~1 px of localisation error and estimates the lens.
const VIDEO_LIMITS={rotationDeg:3,positionPct:2};
function runVideoScenario(s){
 const started=performance.now(),clip=renderSyntheticVideo({path:s.path});
 const session=createTrackSession({width:clip.width,height:clip.height,start:0,end:4,maxKeyframes:24});
 clip.frames.forEach((g,i)=>session.addFrame(g,i/(clip.frames.length-1)*4));
 const {motion,summary,solve}=session.finish();
 const keyframes=Array.from({length:summary.keyframes},(_,i)=>Math.round(i*(clip.frames.length-1)/(summary.keyframes-1)));
 const m=evaluateTrackedVideo(solve,clip.truth.poses,keyframes),failures=[];
 if(m.posed!==summary.keyframes)failures.push(`posed ${m.posed}/${summary.keyframes}`);
 if(!(m.rotationDeg<=VIDEO_LIMITS.rotationDeg))failures.push(`rotation ${m.rotationDeg.toFixed(3)}°`);
 if(m.positionPct!==null&&!(m.positionPct<=VIDEO_LIMITS.positionPct))failures.push(`position ${m.positionPct.toFixed(2)}%`);
 if(motion.type!==s.type)failures.push(`type ${motion.type} (want ${s.type})`);
 return {name:s.name,metrics:{...m,frames:summary.keyframes,fovError:Math.abs(solve.fov-clip.truth.fov),points:summary.points},
   motion,failures,ms:performance.now()-started};
}
const pool=video?VIDEO_SCENARIOS:SCENARIOS;
const chosen=pool.filter(s=>!filters.length||filters.some(f=>s.name.includes(f)));
const results=chosen.map(s=>video?runVideoScenario(s):runScenario(s,{solve:solveCameraTracks,toMotion:trackSolveToVideoMotion}));
if(json){
 console.log(JSON.stringify(results.map(r=>({name:r.name,ms:Math.round(r.ms),failures:r.failures,
   metrics:r.metrics,motion:{type:r.motion.type,confidence:r.motion.confidence,keys:r.motion.keys.length}})),null,2));
}else{
 const cell=(v,w)=>String(v).padEnd(w);
 console.log(cell('scenario',40)+cell('mode',10)+cell('posed',7)+cell('rot°',8)+cell('pos%',8)+
   cell('fov±°',7)+cell('rms px',8)+cell('type',10)+cell('conf',6)+cell('keys',6)+'result');
 for(const {name,metrics:m,motion,failures,ms} of results)
   console.log(cell(name,40)+cell(m.mode,10)+cell(m.posed+'/'+m.frames,7)+cell(m.rotationDeg.toFixed(3),8)+
     cell(m.positionPct===null?'—':m.positionPct.toFixed(2),8)+cell(m.fovError.toFixed(2),7)+cell(m.rmsPx.toFixed(2),8)+
     cell(motion.type,10)+cell(motion.confidence,6)+cell(motion.keys.length,6)+
     (failures.length?'FAIL · '+failures.join('; '):'ok')+` (${Math.round(ms)} ms)`);
}
const failed=results.filter(r=>r.failures.length);
if(!json)console.log(`\n${results.length-failed.length}/${results.length} scenarios within limits.`);
process.exitCode=failed.length?1:0;
