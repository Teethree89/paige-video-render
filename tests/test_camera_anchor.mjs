import test from 'node:test';
import assert from 'node:assert/strict';
import {anchorPath,pathToKeys,buildAnchoredCameraProposal,DENSITY} from '../camera-anchor.js';
import {resectCamera,projectPoint} from '../camera-resection.js';
import {solveCameraTracks,cameraCenter,cameraForward,lookAtPose} from '../camera-track-solver.js';
import {SCENARIOS,scenarioShot} from './camera-track-fixtures.mjs';
import {createDraftTimeline} from '../shot-analysis.js';

const W=1280,H=720;
const len=v=>Math.hypot(...v);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
// A different camera frame (the model world is NOT the tracker's world): move the whole scene by a rotation, scale and shift.
function modelFrame(X){const c=Math.cos(.7),s=Math.sin(.7);return [3.5*(c*X[0]+s*X[2])+120,3.5*X[1]+9,3.5*(-s*X[0]+c*X[2])-40];}
function setup(name,{seedCount=8,noise=0}={}){
 const scenario=SCENARIOS.find(x=>x.name===name),shot=scenarioShot({...scenario,noisePx:noise||scenario.noisePx});
 const solve=solveCameraTracks(shot.input);
 // Pinned points: tracks that exist at frame 0 and last long; their true model-frame positions are known.
 const seedIds=shot.input.tracks.filter(t=>t.obs[0][0]===0&&t.obs.length>=shot.input.frameCount*.8&&shot.truth.points.has(t.source)).map(t=>t.id);
 const step=Math.max(1,Math.floor(seedIds.length/seedCount)),ids=seedIds.filter((_,i)=>i%step===0).slice(0,seedCount);
 const seeds=ids.map(id=>({id,X:modelFrame(shot.truth.points.get(shot.input.tracks.find(t=>t.id===id).source))}));
 const seedObs=new Map(ids.map(id=>[id,new Map(shot.input.tracks.find(t=>t.id===id).obs.map(o=>[o[0],[o[1],o[2]]]))]));
 // Truth camera path in the model frame.
 const truthCenters=shot.truth.poses.map(p=>modelFrame(cameraCenter(p)));
 const truthFwd=shot.truth.poses.map(p=>{const f=cameraForward(p),a=modelFrame(cameraCenter(p)),b=modelFrame(cameraCenter(p).map((v,i)=>v+f[i]));return sub(b,a).map(v=>v/len(sub(b,a)));});
 return {shot,solve,seeds,seedObs,truthCenters,truthFwd};
}
// Absolute pose at the reference frame, the way the wizard gets it: from pins.
function refFromPins(seeds,seedObs,fov){
 const points=seeds.map(s=>{const px=seedObs.get(s.id).get(0);return {x:px[0],y:px[1],X:s.X};});
 return resectCamera(points,{width:W,height:H,fov});
}

test('a tracked relative path lands on the true camera path in the model (push, exact)',()=>{
 const {shot,solve,seeds,seedObs,truthCenters,truthFwd}=setup('push');
 const res=refFromPins(seeds,seedObs,50);assert.ok(res.ok);
 const a=anchorPath({solve,seeds,refPose:res.pose,fov:50,width:W,height:H,seedObs});
 assert.ok(a.ok,a.reason);
 // The tracker's own units are arbitrary, so only the agreement between pinned points matters.
 assert.ok(a.scaleSpread<.05&&a.seedsUsed>=6,`scale estimates agree: spread ${a.scaleSpread}, used ${a.seedsUsed}`);
 const total=len(sub(truthCenters.at(-1),truthCenters[0]));
 const worst=Math.max(...a.frames.map(f=>len(sub(f.center,truthCenters[f.frame]))))/total*100;
 assert.ok(worst<3,`worst camera position error ${worst.toFixed(2)}% of the path length`);
 const angle=Math.max(...a.frames.map(f=>Math.acos(Math.min(1,f.forward.reduce((s,v,i)=>s+v*truthFwd[f.frame][i],0)))*180/Math.PI));
 assert.ok(angle<.6,'view direction error '+angle.toFixed(3));
 assert.ok(a.anchorRmsPx<1.5,'pinned points reproject onto their tracks: '+a.anchorRmsPx);
});

test('noisy pins and tracks (1 px) still anchor within a few percent (orbit)',()=>{
 const {solve,seeds,seedObs,truthCenters}=setup('orbit',{noise:1});
 const res=refFromPins(seeds,seedObs,50);assert.ok(res.ok);
 const a=anchorPath({solve,seeds,refPose:res.pose,fov:50,width:W,height:H,seedObs});
 assert.ok(a.ok,a.reason);
 const total=Math.max(...truthCenters.map(c=>len(sub(c,truthCenters[0]))));
 const worst=Math.max(...a.frames.map(f=>len(sub(f.center,truthCenters[f.frame]))))/total*100;
 assert.ok(worst<10,`worst error ${worst.toFixed(2)}% of the path extent`);
});

test('a pure pan stays at the pinned camera position (rotation only)',()=>{
 const {solve,seeds,seedObs,truthCenters,truthFwd}=setup('pan');
 assert.equal(solve.mode,'rotation');
 const res=refFromPins(seeds,seedObs,50);assert.ok(res.ok);
 const a=anchorPath({solve,seeds,refPose:res.pose,fov:50,width:W,height:H,seedObs});
 assert.ok(a.ok,a.reason);
 for(const f of a.frames)assert.ok(len(sub(f.center,truthCenters[0]))<.02*len(sub(truthCenters[0],[120,9,-40])),'camera does not translate');
 const angle=Math.max(...a.frames.map(f=>Math.acos(Math.min(1,f.forward.reduce((s,v,i)=>s+v*truthFwd[f.frame][i],0)))*180/Math.PI));
 assert.ok(angle<.6,'pan direction error '+angle.toFixed(3));
});

test('too few pinned points visible in 3D is refused with advice',()=>{
 const {solve,seeds,seedObs}=setup('push');
 const res=refFromPins(seeds,seedObs,50);
 const a=anchorPath({solve,seeds:seeds.slice(0,2),refPose:res.pose,fov:50,width:W,height:H,seedObs});
 assert.equal(a.ok,false);assert.match(a.reason,/Only 2 pinned points could be followed in 3D/);
 assert.equal(anchorPath({solve:{mode:'failed',poses:new Map()},seeds,refPose:res.pose,fov:50,width:W,height:H}).ok,false);
});

const box=(id,x=0)=>({id,name:'Block '+id,primitive:'box',position:[x,1,0],rotation:[0,0,0],scale:[2,2,2],material:{color:'#8899aa',metalness:.1,roughness:.7}});
test('keys: density controls how many; the proposal replaces ONLY this chapter and freezes the anchor',()=>{
 const {solve,seeds,seedObs,shot}=setup('orbit');
 const res=refFromPins(seeds,seedObs,50),a=anchorPath({solve,seeds,refPose:res.pose,fov:50,width:W,height:H,seedObs});
 const times=Array.from({length:shot.input.frameCount},(_,i)=>.04+i*(5.9/(shot.input.frameCount-1)));
 const counts=Object.keys(DENSITY).map(d=>pathToKeys(a.frames,{times,fov:50,targetDistance:60,density:d}).length);
 assert.ok(counts[0]<=counts[1]&&counts[1]<=counts[2]&&counts[0]<counts[2],'few <= normal <= many: '+counts);

 const seq=createDraftTimeline({duration:12,cuts:[6]});
 seq.primitiveScenes={schemaVersion:1,scenes:[{shotId:'draft_001',objects:[box('a')]}]};
 const before=structuredClone(seq),otherKeys=seq.camera.filter(k=>k.at>=6);
 const keys=pathToKeys(a.frames,{times,fov:50,targetDistance:60,density:'normal'});
 const proposal=buildAnchoredCameraProposal(seq,'draft_001',{keys,anchor:[3,0,-2],summary:{scale:a.scale}});
 assert.deepEqual(seq,before,'the input timeline is not modified');
 const out=proposal.sequence;
 assert.deepEqual(out.camera.filter(k=>k.at>=6),otherKeys,'other chapters keep their camera');
 const mine=out.camera.filter(k=>k.at<6);
 assert.ok(mine.length>=2&&mine.every(k=>k.generated==='video-track'&&!k.id.startsWith('video_cam')),'old placeholder keys are gone');
 assert.equal(mine[0].at,0);assert.equal(mine[0].cut,true);
 assert.ok(mine.at(-1).at>=5.9&&mine.at(-1).at<6,'the last key sits just before the next chapter');
 assert.ok(mine.every((k,i)=>!i||k.at>mine[i-1].at));
 assert.deepEqual(out.shots[0].sceneAnchor,[3,0,-2]);
 assert.equal(out.shots[0].cameraSync.mode,'anchored-track');
 assert.equal(proposal.report.removedKeys,before.camera.filter(k=>k.at<6).length);
 assert.deepEqual(out.primitiveScenes,seq.primitiveScenes,'geometry is untouched');
});

test('proposal refuses chapters without a model and out-of-range cameras',()=>{
 const seq=createDraftTimeline({duration:6});
 const keys=[{at:0,p:[0,0,10],t:[0,0,0],fov:50},{at:5,p:[0,0,5],t:[0,0,0],fov:50}];
 assert.throws(()=>buildAnchoredCameraProposal(seq,'draft_001',{keys,anchor:[0,0,0]}),/No accepted 3D model/);
 seq.primitiveScenes={schemaVersion:1,scenes:[{shotId:'draft_001',objects:[box('a')]}]};
 assert.throws(()=>buildAnchoredCameraProposal(seq,'draft_001',{keys:[{...keys[0],p:[0,0,1e6]},keys[1]],anchor:[0,0,0]}),/supported scene range/);
 assert.throws(()=>buildAnchoredCameraProposal(seq,'draft_001',{keys,anchor:[NaN,0,0]}),/anchor is missing/);
});
