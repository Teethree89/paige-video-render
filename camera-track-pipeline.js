// One local camera-track session: grayscale frames in, validated
// videoCameraMotion estimate out. Pure; used by camera-track-worker.js and
// tests. No frames, tracks or results leave this device.
import {createFeatureTracker,selectKeyframes} from './feature-tracker.js';
import {solveCameraTracks,trackSolveToVideoMotion} from './camera-track-solver.js';

export const MIN_TRACK_FRAMES=6;

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
     const keyframes=selectKeyframes(all,tracker.frameCount,maxKeyframes);
     const input={width,height,frameCount:keyframes.frameCount,tracks:keyframes.tracks};
     if(Number.isFinite(fov))input.fov=fov;
     const solve=solveCameraTracks(input,solverOptions);
     const summary={mode:solve.mode,posed:solve.poses.size,keyframes:keyframes.frameCount,frames:times.length,
       tracks:all.length,points:solve.points.size,rmsPx:Number.isFinite(solve.rmsPx)?+solve.rmsPx.toFixed(3):null,
       fov:Number.isFinite(solve.fov)?+solve.fov.toFixed(2):null,fovEstimated:!!solve.fovEstimated,
       meanActive:Math.round(stats.reduce((s,x)=>s+x.active,0)/Math.max(1,stats.length))};
     if(solve.mode==='failed')throw Object.assign(Error('Camera tracking failed: '+(solve.reason||'too few consistent features')),{summary});
     // Map keyframe times onto the chapter so u runs exactly 0..1.
     const keyTimes=keyframes.frames.map(f=>times[f]);
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
