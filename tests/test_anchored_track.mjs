import test from 'node:test';
import assert from 'node:assert/strict';
import {createAnchoredSession,mergeAnchoredPasses} from '../camera-track-pipeline.js';
import {resectCamera,projectPoint} from '../camera-resection.js';
import {pathToKeys} from '../camera-anchor.js';
import {cameraCenter,cameraForward,seededRandom} from '../camera-track-solver.js';
import {VIDEO_SCENARIOS,renderSyntheticVideo,syntheticPoints} from './camera-track-fixtures.mjs';

const len=v=>Math.hypot(...v),sub=(a,b)=>a.map((v,i)=>v-b[i]);
// The model world differs from the tracker's world (rotation, scale, shift): nothing may rely on them matching.
const modelFrame=X=>{const c=Math.cos(-.5),s=Math.sin(-.5);return [2.5*(c*X[0]+s*X[2])-60,2.5*X[1]+4,2.5*(-s*X[0]+c*X[2])+30];};

function setup(type){
 const scenario=VIDEO_SCENARIOS.find(s=>s.type===type),points=syntheticPoints(320,21);
 const video=renderSyntheticVideo({path:scenario.path,points,noise:1});
 return {video,points};
}
function pinsAt(video,points,frameIndex,count=12,noisePx=.4){
 const random=seededRandom(3),pose=video.truth.poses[frameIndex],out=[];
 for(const X of points){
   const p=projectPoint(pose,video.truth.fov,video.width,video.height,X);
   if(p&&p.depth>2&&p.x>30&&p.y>30&&p.x<video.width-30&&p.y<video.height-30)out.push({X:modelFrame(X),x:p.x+(random()-.5)*2*noisePx,y:p.y+(random()-.5)*2*noisePx});
 }
 const step=Math.max(1,Math.floor(out.length/count));
 return out.filter((_,i)=>i%step===0).slice(0,count).map((p,i)=>({...p,id:'pin'+i}));
}
function runPass(video,order,pins,refPose,fov){
 const session=createAnchoredSession({width:video.width,height:video.height,seeds:pins,refPose,fov,maxKeyframes:24});
 order.forEach(i=>session.addFrame(video.frames[i],i/(video.frames.length-1)*4));
 return session.finish();
}

test('pinned points anchor the tracked camera path to the model (reference frame in the middle: forward + backward)',()=>{
 const {video,points}=setup('orbit'),ref=18;
 const pins=pinsAt(video,points,ref);
 const res=resectCamera(pins,{width:video.width,height:video.height});
 assert.ok(res.ok&&res.rmsPx<2,res.reason||'rms '+res.rmsPx);
 const n=video.frames.length;
 const forward=runPass(video,Array.from({length:n-ref},(_,i)=>ref+i),pins,res.pose,res.fov);
 const backward=runPass(video,Array.from({length:ref+1},(_,i)=>ref-i),pins,res.pose,res.fov);
 for(const pass of [forward,backward])assert.ok(pass.summary.seedsTracked>=5,'the pinned points were followed: '+JSON.stringify(pass.summary));
 const merged=mergeAnchoredPasses(forward,backward);
 const times=merged.map(f=>f.time);
 assert.ok(times.every((t,i)=>!i||t>times[i-1]),'merged path is in time order');
 assert.ok(merged.length>=30);
 // Compare with the truth camera path in the model frame at each frame's time.
 const truthAt=t=>{const i=Math.round(t/4*(n-1)),pose=video.truth.poses[i],c=cameraCenter(pose),f=cameraForward(pose);
   const a=modelFrame(c),b=modelFrame(c.map((v,k)=>v+f[k]));return {c:a,f:sub(b,a).map(v=>v/len(sub(b,a)))};};
 const extent=Math.max(...merged.map(f=>len(sub(f.center,merged[0].center))));
 const worst=Math.max(...merged.map(f=>len(sub(f.center,truthAt(f.time).c))))/extent*100;
 const angle=Math.max(...merged.map(f=>Math.acos(Math.min(1,f.forward.reduce((s,v,k)=>s+v*truthAt(f.time).f[k],0)))*180/Math.PI));
 assert.ok(worst<8,`camera position error ${worst.toFixed(2)}% of the path extent`);
 assert.ok(angle<2.5,`view direction error ${angle.toFixed(2)} deg`);
 // The reference frame itself is exactly the resected pose.
 const atRef=merged.find(f=>Math.abs(f.time-ref/(n-1)*4)<1e-6);
 assert.ok(len(sub(atRef.center,res.center))<1e-6*Math.max(1,len(res.center)),'frame 0 of each pass sits on the resected camera');
 // Keys come out in the model frame and respect density.
 const keys=pathToKeys(merged,{times:Object.fromEntries(merged.map((f,i)=>[i,f.time])),fov:res.fov,targetDistance:50});
 assert.ok(keys.length>=2);
});

test('a pan from pinned points stays put and turns (rotation only)',()=>{
 const {video,points}=setup('pan'),pins=pinsAt(video,points,0);
 const res=resectCamera(pins,{width:video.width,height:video.height});
 assert.ok(res.ok);
 const pass=runPass(video,video.frames.map((_,i)=>i),pins,res.pose,res.fov);
 assert.equal(pass.solve.mode,'rotation');
 const frames=pass.anchored.frames;
 for(const f of frames)assert.ok(len(sub(f.center,res.center))<1e-9,'a pan does not translate');
 const turned=Math.acos(Math.min(1,frames[0].forward.reduce((s,v,k)=>s+v*frames.at(-1).forward[k],0)))*180/Math.PI;
 assert.ok(turned>10,'the camera turned '+turned);
});

test('a transition right after the reference frame is refused with advice',()=>{
 const {video,points}=setup('orbit'),other=renderSyntheticVideo({path:VIDEO_SCENARIOS[0].path,seed:42,points:syntheticPoints(300,8)});
 const pins=pinsAt(video,points,0),res=resectCamera(pins,{width:video.width,height:video.height});
 const frames=video.frames.slice();for(let i=1;i<14;i++)frames[i]=other.frames[i];
 assert.throws(()=>runPass({...video,frames},frames.map((_,i)=>i),pins,res.pose,res.fov),
   err=>/changes too abruptly right after the reference frame/.test(err.message)&&err.summary.usable<6);
});

test('input checks: at least 4 pins, small frames, distinct times',()=>{
 const pin={id:'a',x:10,y:10,X:[0,0,0]};
 assert.throws(()=>createAnchoredSession({width:480,height:270,seeds:[pin],refPose:{},fov:50}),/At least 4 pinned/);
 assert.throws(()=>createAnchoredSession({width:20,height:20,seeds:[pin,pin,pin,pin],refPose:{},fov:50}),/too small/);
 const s=createAnchoredSession({width:96,height:72,seeds:[pin,pin,pin,pin],refPose:{},fov:50});
 s.addFrame(new Float32Array(96*72),0);
 assert.throws(()=>s.addFrame(new Float32Array(96*72),0),/distinct times/);
 assert.throws(()=>s.finish(),/at least 6 frames/);
});
