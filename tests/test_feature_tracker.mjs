import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPyramid,detectCorners,trackPoint,createFeatureTracker,selectKeyframes,toGray} from '../feature-tracker.js';
import {createTrackSession,trackingFrameTimes,MIN_TRACK_FRAMES} from '../camera-track-pipeline.js';
import {VIDEO_SCENARIOS,renderSyntheticVideo,evaluateTrackedVideo,syntheticPoints} from './camera-track-fixtures.mjs';
import {validateVideoMotion} from '../video-camera-motion.js';

// Smooth random texture, sampled at a sub-pixel offset.
const texture=(w,h,dx=0,dy=0)=>{const img=new Float32Array(w*h);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const u=x-dx,v=y-dy;
   img[y*w+x]=128+40*Math.sin(u*.21+Math.cos(v*.13))+30*Math.cos(v*.17-u*.05)+20*Math.sin((u+v)*.09);}
 return img;};

test('grayscale conversion uses luminance weights',()=>{
 assert.deepEqual([...toGray([255,0,0,255,0,255,0,255,0,0,255,255],3,1)].map(v=>+v.toFixed(3)),[76.245,149.685,29.07]);
});

test('pyramidal Lucas-Kanade recovers sub-pixel and multi-pixel shifts',()=>{
 const w=160,h=120,base=buildPyramid(texture(w,h),w,h,3);
 for(const [dx,dy] of [[.37,-.21],[3.6,2.2],[-9.4,6.8]]){
   const moved=buildPyramid(texture(w,h,dx,dy),w,h,3);
   const corners=detectCorners(base[0],{maxCorners:30,minDistance:12,border:20});
   assert.ok(corners.length>=15,'enough corners on textured image');
   const errors=corners.map(([x,y])=>{const p=trackPoint(base,moved,x,y);return p?Math.hypot(p[0]-x-dx,p[1]-y-dy):Infinity;});
   const median=[...errors].sort((a,b)=>a-b)[errors.length>>1];
   assert.ok(median<.08,`median error ${median} for shift ${dx},${dy}`);
 }
});

test('flat regions yield no corners and untrackable points fail',()=>{
 const w=96,h=72,flat=new Float32Array(w*h).fill(90),pyr=buildPyramid(flat,w,h,2);
 assert.equal(detectCorners(pyr[0]).length,0);
 assert.equal(trackPoint(pyr,pyr,48,36),null);
});

test('forward-backward check drops features that cannot be followed',()=>{
 const w=160,h=120,tracker=createFeatureTracker({maxFeatures:60});
 tracker.addFrame(texture(w,h),w,h);
 const noise=Float32Array.from({length:w*h},(_,i)=>(Math.sin(i*12.9898)*43758.5453%1+1)%1*255);
 const step=tracker.addFrame(noise,w,h);
 assert.ok(step.lost>step.kept,`lost ${step.lost} vs kept ${step.kept} on an unrelated frame`);
 assert.throws(()=>tracker.addFrame(texture(80,60),80,60),/one size/);
});

test('keyframe selection keeps first and last frames and re-indexes tracks',()=>{
 const tracks=[{id:'a',obs:Array.from({length:10},(_,f)=>[f,f,f])},{id:'b',obs:[[1,0,0],[2,0,0]]}];
 const out=selectKeyframes(tracks,10,4);
 assert.deepEqual(out.frames,[0,3,6,9]);
 assert.deepEqual(out.tracks,[{id:'a',obs:[[0,0,0],[1,3,3],[2,6,6],[3,9,9]]}]);
});

test('tracking frame schedule is dense, bounded and inside the chapter',()=>{
 const short=trackingFrameTimes(2,3);
 assert.equal(short.length,24);assert.ok(short[0]>2&&short.at(-1)<3);
 assert.equal(trackingFrameTimes(0,60).length,150);
 assert.ok(trackingFrameTimes(0,5).every((t,i,a)=>!i||t>a[i-1]));
});

test('track sessions validate frame order, size and minimum length',()=>{
 assert.throws(()=>createTrackSession({width:32,height:32,start:0,end:1}),/too small/);
 const s=createTrackSession({width:96,height:72,start:0,end:1});
 s.addFrame(texture(96,72),0);
 assert.throws(()=>s.addFrame(texture(96,72),0),/time order/);
 assert.throws(()=>s.addFrame(new Float32Array(10),1),/size changed/);
 assert.throws(()=>s.finish(),new RegExp(`at least ${MIN_TRACK_FRAMES} frames`));
});

// End to end: rendered frames -> feature tracker -> solver -> motion estimate.
for(const scenario of VIDEO_SCENARIOS){
 test(`synthetic video: ${scenario.name}`,()=>{
   const video=renderSyntheticVideo({path:scenario.path});
   const session=createTrackSession({width:video.width,height:video.height,start:0,end:4,maxKeyframes:24});
   video.frames.forEach((g,i)=>session.addFrame(g,i/(video.frames.length-1)*4));
   const {motion,summary,solve}=session.finish();
   const keyframes=Array.from({length:summary.keyframes},(_,i)=>Math.round(i*(video.frames.length-1)/(summary.keyframes-1)));
   const metrics=evaluateTrackedVideo(solve,video.truth.poses,keyframes);
   assert.equal(motion.type,scenario.type,JSON.stringify(summary));
   assert.equal(summary.posed,summary.keyframes);
   assert.ok(metrics.rotationDeg<3,`rotation error ${metrics.rotationDeg}`);
   if(metrics.positionPct!==null)assert.ok(metrics.positionPct<2,`position error ${metrics.positionPct}%`);
   assert.deepEqual(validateVideoMotion(motion,{start:0,end:4}),motion);
 });
}

// A cut or fast transition: replace the first frames with an unrelated scene.
const withInterruption=(video,from,to,other)=>{
 const frames=video.frames.slice();for(let i=from;i<to;i++)frames[i]=other.frames[i];return {...video,frames};
};
const orbit=VIDEO_SCENARIOS.find(s=>s.type==='orbit');
const trackClip=(video,start=0,end=4)=>{
 const session=createTrackSession({width:video.width,height:video.height,start,end,maxKeyframes:24});
 video.frames.forEach((g,i)=>session.addFrame(g,start+i/(video.frames.length-1)*(end-start)));
 return session.finish();
};

test('an unrelated transition at the start is held, not solved or stretched',()=>{
 const clean=renderSyntheticVideo({path:orbit.path}),other=renderSyntheticVideo({path:orbit.path,seed:77,points:syntheticPoints(300,5)});
 const {motion,summary}=trackClip(withInterruption(clean,0,8,other));
 assert.equal(motion.type,'orbit');
 assert.ok(summary.segment.from>=7&&summary.segment.frames<summary.segment.total,JSON.stringify(summary.segment));
 assert.equal(motion.keys[0].u,0);assert.equal(motion.keys.at(-1).u,1);
 assert.deepEqual(motion.keys[0].p,motion.keys[1].p,'the camera holds still over the transition');
 assert.ok(motion.keys[1].u>.1,'motion starts after the held part');
 assert.match(motion.uncertainty,/held still for the first [\d.]+ s \(cut or transition\)/);
});

test('a cut in the middle of a chapter is refused with advice to split it',()=>{
 const clean=renderSyntheticVideo({path:orbit.path}),other=renderSyntheticVideo({path:orbit.path,seed:78,points:syntheticPoints(300,6)});
 assert.throws(()=>trackClip(withInterruption(clean,10,26,other)),err=>/too abruptly/.test(err.message)&&err.summary.segment.frames<err.summary.segment.total);
});

test('a plausible-lens default replaces an implausible estimated lens when it fits as well',()=>{
 const video=renderSyntheticVideo({path:VIDEO_SCENARIOS.find(s=>s.type==='push').path,fov:50});
 const {summary}=trackClip(video);
 assert.ok(summary.fov>=25&&summary.fov<=70,'lens stays in a plausible range: '+summary.fov);
});
