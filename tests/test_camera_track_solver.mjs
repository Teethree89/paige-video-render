import test from 'node:test';
import assert from 'node:assert/strict';
import {solveCameraTracks,trackSolveToVideoMotion,svd3,symmetricEigen,rotationFromVector,rotationAngle,
 triangulate,lookAtPose,focalFromFov,seededRandom} from '../camera-track-solver.js';
import {SCENARIOS,runScenario,scenarioShot,syntheticShot,syntheticPoints} from './camera-track-fixtures.mjs';
import {validateVideoMotion,buildVideoCameraMotion} from '../video-camera-motion.js';
import {createDraftTimeline} from '../shot-analysis.js';

const solveAndConvert={solve:solveCameraTracks,toMotion:trackSolveToVideoMotion};
const close=(a,b,eps,msg)=>assert.ok(Math.abs(a-b)<=eps,`${msg}: ${a} vs ${b}`);

test('3x3 SVD reconstructs rank-deficient and full-rank matrices',()=>{
 const random=seededRandom(5);
 for(const rank of [3,2]){
   const M=Array.from({length:9},()=>random()-.5);
   if(rank===2)for(let c=0;c<3;c++)M[6+c]=M[c]*2-M[3+c];
   const {U,S,V}=svd3(M);
   for(let i=0;i<3;i++)for(let j=0;j<3;j++){
     let v=0;for(let k=0;k<3;k++)v+=U[i*3+k]*S[k]*V[j*3+k];
     close(v,M[i*3+j],1e-9,'reconstruction');
   }
   // The left null vector of a rank-2 matrix must still be a unit vector.
   close(Math.hypot(U[2],U[5],U[8]),1,1e-9,'third left singular vector length');
   assert.ok(S[0]>=S[1]&&S[1]>=S[2]);
 }
});

test('symmetric eigen solver and rotations are orthonormal',()=>{
 const {values,vectors}=symmetricEigen([4,1,0,1,3,0,0,0,1],3);
 assert.deepEqual(values.map(v=>+v.toFixed(9)),[1,+((7-Math.sqrt(5))/2).toFixed(9),+((7+Math.sqrt(5))/2).toFixed(9)]);
 close(Math.hypot(vectors[0],vectors[3],vectors[6]),1,1e-12,'unit eigenvector');
 const R=rotationFromVector([.3,-.2,.5]);
 close(rotationAngle(R),Math.hypot(.3,.2,.5),1e-12,'rotation angle');
});

test('multi-view triangulation recovers an exact point',()=>{
 const X=[1.5,2,-3],poses=[lookAtPose([0,2,10],[0,0,0]),lookAtPose([6,3,8],[0,0,0]),lookAtPose([-5,1,9],[0,1,0])];
 const obs=poses.map(({R,t})=>{const c=[0,1,2].map(r=>R[r*3]*X[0]+R[r*3+1]*X[1]+R[r*3+2]*X[2]+t[r]);return [c[0]/c[2],c[1]/c[2]];});
 triangulate(poses,obs).forEach((v,i)=>close(v,X[i],1e-8,'triangulated coordinate'));
});

for(const scenario of SCENARIOS){
 test(`synthetic scenario: ${scenario.name}`,()=>{
   const {failures,motion}=runScenario(scenario,solveAndConvert);
   assert.deepEqual(failures,[]);
   // Every solve produces the existing reviewable motion contract.
   assert.deepEqual(validateVideoMotion(motion,{start:0,end:4}),motion);
   assert.equal(motion.source,'feature-track');
   assert.ok(motion.keys.length>=2&&motion.keys.length<=11);
 });
}

test('orbit estimate uses the motion convention: Y up, subject at origin, first camera on +Z, elevation kept',()=>{
 const scenario=SCENARIOS.find(s=>s.name==='orbit'),shot=scenarioShot(scenario);
 const motion=trackSolveToVideoMotion(solveCameraTracks(shot.input),{start:0,end:4});
 const [first]=motion.keys,{p,t}=first;
 assert.ok(Math.abs(p[0])<.05*Math.hypot(...p),'first camera starts on the +Z axis');
 assert.ok(p[2]>0,'first camera sits on +Z');
 assert.ok(p[1]>0,'camera height above the subject survives (no roll assumed)');
 assert.ok(Math.hypot(...t)<Math.hypot(...p),'target lies toward the subject');
 assert.ok(motion.keys.every(k=>Math.abs(Math.hypot(...k.p)-Math.hypot(...p))<.15*Math.hypot(...p)),'orbit keeps its radius');
 assert.match(motion.uncertainty,/^Feature-track solve \(parallax\)/);
});

test('tracked motion fits to geometry through the existing builder and marks keys as tracked',()=>{
 const shot=scenarioShot(SCENARIOS.find(s=>s.name==='push'));
 const seq=createDraftTimeline({duration:12,cuts:[6]});
 seq.shots[0].videoCameraMotion=trackSolveToVideoMotion(solveCameraTracks(shot.input),{start:0,end:6});
 const {sequence,report}=buildVideoCameraMotion(seq,'draft_001',{newBounds:{center:[0,0,0],radius:10},anchor:[0,0,0]});
 assert.equal(report.source,'feature-track');
 assert.equal(report.type,'push');
 const keys=sequence.camera.filter(k=>k.at<6);
 assert.ok(keys.length>=2&&keys.every(k=>k.generated==='video-track'));
 const distance=k=>Math.hypot(...k.p);
 assert.ok(distance(keys.at(-1))<distance(keys[0])*.8,'push moves the camera toward the subject');
 assert.equal(sequence.shots[0].cameraSync.source,'feature-track');
 // The second chapter's placeholder keys are untouched.
 assert.deepEqual(sequence.camera.filter(k=>k.at>=6),seq.camera.filter(k=>k.at>=6));
});

test('solves are deterministic for the same tracks',()=>{
 const shot=scenarioShot(SCENARIOS.find(s=>s.name.startsWith('noisy push')));
 const a=trackSolveToVideoMotion(solveCameraTracks(shot.input),{start:0,end:4});
 const b=trackSolveToVideoMotion(solveCameraTracks(structuredClone(shot.input)),{start:0,end:4});
 assert.deepEqual(a,b);
});

test('too few tracks fail honestly instead of inventing motion',()=>{
 const sparse=syntheticShot({name:'sparse',points:syntheticPoints(6),
   path:u=>({position:[u*8,6,30],target:[0,4,0]})});
 const solve=solveCameraTracks(sparse.input);
 assert.equal(solve.mode,'failed');
 assert.throws(()=>trackSolveToVideoMotion(solve,{start:0,end:4}),/No usable camera track solve/);
 assert.throws(()=>solveCameraTracks({width:0,height:720,tracks:[]}),/width and height/);
});

test('motion validator keeps the source allowlist strict',()=>{
 const base={version:1,start:0,end:4,type:'static',confidence:.5,uncertainty:'x',
   keys:[{u:0,p:[0,0,3],t:[0,0,0],fov:50},{u:1,p:[0,0,3],t:[0,0,0],fov:50}]};
 assert.equal(validateVideoMotion(base).source,undefined);
 assert.equal(validateVideoMotion({...base,source:'feature-track'}).source,'feature-track');
 assert.throws(()=>validateVideoMotion({...base,source:'model prose'}),/source/);
 assert.ok(focalFromFov(50,720)>700);
});
