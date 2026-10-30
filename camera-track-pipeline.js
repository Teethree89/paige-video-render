// One local camera-track session: grayscale frames in, validated
// videoCameraMotion estimate out. Pure; used by camera-track-worker.js and
// tests. No frames, tracks or results leave this device.
import {createFeatureTracker,selectKeyframes} from './feature-tracker.js';
import {solveCameraTracks,trackSolveToVideoMotion} from './camera-track-solver.js';
import {anchorPath} from './camera-anchor.js';

export const MIN_TRACK_FRAMES=6;
export const MIN_SEGMENT_SHARE=.5;  // longest continuous stretch must cover half the chapter
export const MAX_RMS_PX=2.5;        // a fit worse than this does not describe one camera path
export const MIN_POSED_SHARE=.5;    // and at least half of its keyframes must be solved

export function createTrackSession({width,height,start,end,fov=null,maxKeyframes=30,tracker:trackerOptions={},solver:solverOptions={}}){
 if(!(width>=64&&height>=64))throw Error('Tracking frames are too small');
 if(!(Number.isFinite(start)&&Number.isFinite(end)&&end-start>=.15))throw Error('Invalid chapter range');
 const tracker=createFeatureTracker(trackerOptions),times=[];
 return {
   addFrame(gray,time){
     if(gray.length!==width*height)throw Error('Frame size changed during tracking');
     if(times.length&&!(time>times.at(-1)))throw Error('Frames must be added in time order');
     times.push(time);
     return tracker.addFrame(gray,width,height);
   },
   finish(){
     if(times.length<MIN_TRACK_FRAMES)throw Error(`Need at least ${MIN_TRACK_FRAMES} frames to track camera motion`);
     const stats=tracker.stats(),all=tracker.tracks();
     // A cut or fast transition kills most tracks at once. Solve the longest
     // continuous stretch; the rest of the chapter is held still, not invented.
     const isBreak=s=>s.frame>0&&s.kept+s.lost>=20&&s.lost/(s.kept+s.lost)>.5;
     let best={from:0,to:0},from=0;
     for(const s of stats){
       if(isBreak(s))from=s.frame;
       if(s.frame-from>best.to-best.from)best={from,to:s.frame};
     }
     const frames=best.to-best.from+1,summary={frames:times.length,tracks:all.length,
       segment:{from:best.from,to:best.to,frames,total:times.length},
       meanActive:Math.round(stats.reduce((s,x)=>s+x.active,0)/Math.max(1,stats.length))};
     if(frames<MIN_TRACK_FRAMES||frames<times.length*MIN_SEGMENT_SHARE)
       throw Object.assign(Error('The picture changes too abruptly here (a cut or fast transition). Split the chapter at the cut and track each part'),{summary});
     const segmentTracks=all.map(t=>({id:t.id,obs:t.obs.filter(o=>o[0]>=best.from&&o[0]<=best.to).map(o=>[o[0]-best.from,o[1],o[2]])}))
       .filter(t=>t.obs.length>=2);
     const keyframes=selectKeyframes(segmentTracks,frames,maxKeyframes);
     const input={width,height,frameCount:keyframes.frameCount,tracks:keyframes.tracks};
     if(Number.isFinite(fov))input.fov=fov;
     const solve=solveCameraTracks(input,solverOptions);
     Object.assign(summary,{mode:solve.mode,posed:solve.poses.size,keyframes:keyframes.frameCount,points:solve.points.size,
       rmsPx:Number.isFinite(solve.rmsPx)?+solve.rmsPx.toFixed(3):null,
       fov:Number.isFinite(solve.fov)?+solve.fov.toFixed(2):null,fovEstimated:!!solve.fovEstimated,fovAssumed:!!solve.fovAssumed});
     if(solve.mode==='failed')throw Object.assign(Error('Camera tracking failed: '+(solve.reason||'too few consistent features')),{summary});
     if(!(solve.rmsPx<=MAX_RMS_PX))
       throw Object.assign(Error(`The tracked points do not agree with one smooth camera path (${Number.isFinite(solve.rmsPx)?solve.rmsPx.toFixed(1):'?'} px error)`),{summary});
     // Few posed keyframes would be a mostly invented path: refuse rather than guess.
     if(solve.poses.size<keyframes.frameCount*MIN_POSED_SHARE)
       throw Object.assign(Error(`Only ${solve.poses.size} of ${keyframes.frameCount} keyframes could be solved`),{summary});
     const keyTimes=keyframes.frames.map(f=>times[best.from+f]);
     const motion=trackSolveToVideoMotion(solve,{start,end,times:keyTimes});
     return {motion,summary,solve};
   }
 };
}

/** Sample times for a chapter: dense enough for optical flow, bounded in count. */
export function trackingFrameTimes(start,end,{fps=12,maxFrames=150,minFrames=24}={}){
 const span=end-start,count=Math.max(minFrames,Math.min(maxFrames,Math.round(span*fps)+1));
 const pad=Math.min(.04,span*.02);
 return Array.from({length:count},(_,i)=>+(start+pad+(span-2*pad)*i/(count-1)).toFixed(4));
}

/**
 * One pass of anchored tracking. Frame 0 is the reference frame the user pinned
 * points on; `direction` says whether later frames go forward or backward in
 * time. The pinned points are tracked as seeds, the relative camera path is
 * solved with the lens from the resection, then placed in the model so frame 0
 * has exactly the resected pose.
 * @param {{width:number,height:number,seeds:{id:string,x:number,y:number,X:number[]}[],refPose:object,fov:number,
 *   maxKeyframes?:number,tracker?:object,solver?:object}} options
 */
export function createAnchoredSession({width,height,seeds,refPose,fov,maxKeyframes=30,tracker:trackerOptions={},solver:solverOptions={}}){
 if(!(width>=64&&height>=64))throw Error('Tracking frames are too small');
 if(!Array.isArray(seeds)||seeds.length<4)throw Error('At least 4 pinned points are required');
 const tracker=createFeatureTracker(trackerOptions),times=[];
 return {
   addFrame(gray,time){
     if(gray.length!==width*height)throw Error('Frame size changed during tracking');
     if(times.length&&time===times.at(-1))throw Error('Frames must have distinct times');
     times.push(time);
     return tracker.addFrame(gray,width,height,times.length===1?{seeds:seeds.map(s=>({id:s.id,x:s.x,y:s.y}))}:undefined);
   },
   finish(){
     if(times.length<MIN_TRACK_FRAMES)throw Error(`Need at least ${MIN_TRACK_FRAMES} frames after the reference frame`);
     const stats=tracker.stats(),all=tracker.tracks();
     // A cut or fast transition ends the usable stretch: it must start at the reference frame.
     const isBreak=s=>s.frame>0&&s.kept+s.lost>=20&&s.lost/(s.kept+s.lost)>.5;
     const brk=stats.find(isBreak),frames=brk?brk.frame:times.length;
     const summary={frames:times.length,usable:frames,tracks:all.length,seedsTracked:0,
       meanActive:Math.round(stats.reduce((a,x)=>a+x.active,0)/Math.max(1,stats.length))};
     if(frames<MIN_TRACK_FRAMES)
       throw Object.assign(Error('The picture changes too abruptly right after the reference frame (a cut or fast transition). Pick a reference frame inside a steady stretch'),{summary});
     const segmentTracks=all.map(t=>({id:t.id,obs:t.obs.filter(o=>o[0]<frames)})).filter(t=>t.obs.length>=2);
     const keyframes=selectKeyframes(segmentTracks,frames,maxKeyframes);
     const solve=solveCameraTracks({width,height,frameCount:keyframes.frameCount,tracks:keyframes.tracks,fov},solverOptions);
     Object.assign(summary,{mode:solve.mode,posed:solve.poses.size,keyframes:keyframes.frameCount,points:solve.points.size,
       rmsPx:Number.isFinite(solve.rmsPx)?+solve.rmsPx.toFixed(3):null});
     if(solve.mode==='failed')throw Object.assign(Error('Camera tracking failed: '+(solve.reason||'too few consistent features')),{summary});
     if(solve.poses.size<keyframes.frameCount*MIN_POSED_SHARE)
       throw Object.assign(Error(`Only ${solve.poses.size} of ${keyframes.frameCount} keyframes could be solved`),{summary});
     if(!(solve.rmsPx<=MAX_RMS_PX))
       throw Object.assign(Error(`The tracked points do not agree with one smooth camera path (${solve.rmsPx.toFixed(1)} px error)`),{summary});
     // The pinned points' own tracks, on the keyframe grid, to check the placement afterwards.
     const seedObs=new Map();
     for(const t of keyframes.tracks)if(seeds.some(s=>String(s.id)===t.id))seedObs.set(t.id,new Map(t.obs.map(o=>[o[0],[o[1],o[2]]])));
     summary.seedsTracked=seedObs.size;
     const anchored=anchorPath({solve,seeds:seeds.map(s=>({id:String(s.id),X:s.X})),refPose,fov,width,height,seedObs});
     if(!anchored.ok)throw Object.assign(Error(anchored.reason),{summary});
     const keyTimes=keyframes.frames.map(f=>times[f]);
     return {anchored:{...anchored,frames:anchored.frames.map(f=>({...f,time:keyTimes[f.frame]}))},summary,solve};
   }
 };
}

/** Merge forward and backward passes (both start at the reference frame) into one time-ordered path. */
export function mergeAnchoredPasses(forward,backward=null){
 const all=[...(backward?.anchored.frames||[]),...forward.anchored.frames];
 const byTime=new Map();
 for(const f of all)if(!byTime.has(f.time))byTime.set(f.time,f);
 return [...byTime.values()].sort((a,b)=>a.time-b.time);
}
