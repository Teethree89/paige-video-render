import test from 'node:test';
import assert from 'node:assert/strict';
import {resectCamera,projectPoint,wipeFov,rollDegrees,MIN_PIN_POINTS} from '../camera-resection.js';
import {lookAtPose,cameraCenter,cameraForward,seededRandom,focalFromFov} from '../camera-track-solver.js';
import {syntheticPoints} from './camera-track-fixtures.mjs';

const W=1280,H=720;
const len=v=>Math.hypot(...v);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const gauss=r=>Math.sqrt(-2*Math.log(Math.max(1e-12,r())))*Math.cos(2*Math.PI*r());
// Pin points: pick well spread visible points of the synthetic campus, project them, add click noise.
function pins(position,target,fov,count,noisePx=0,seed=5){
 const pose=lookAtPose(position,target),random=seededRandom(seed),out=[];
 const pool=syntheticPoints(260,11);
 for(const X of pool){
   const p=projectPoint(pose,fov,W,H,X);
   if(!p||p.depth<1||p.x<20||p.y<20||p.x>W-20||p.y>H-20)continue;
   out.push({x:p.x+gauss(random)*noisePx,y:p.y+gauss(random)*noisePx,X,id:out.length});
 }
 // Spread picks the way a person would: take every k-th point.
 const step=Math.max(1,Math.floor(out.length/count));
 return {pose,points:out.filter((_,i)=>i%step===0).slice(0,count)};
}
const check=(res,truth,fov,{posPct=1,rotDeg=.5,fovTol=1})=>{
 assert.ok(res.ok,res.reason);
 const c=cameraCenter(truth),d=len(sub(c,[0,4,0]));
 assert.ok(len(sub(res.center,c))/d*100<posPct,`position error ${(len(sub(res.center,c))/d*100).toFixed(3)}%`);
 const f=cameraForward(truth),ang=Math.acos(Math.min(1,f.reduce((s,v,i)=>s+v*res.forward[i],0)))*180/Math.PI;
 assert.ok(ang<rotDeg,`direction error ${ang.toFixed(3)} deg`);
 if(fov!==undefined)assert.ok(Math.abs(res.fov-fov)<fovTol,`fov ${res.fov} vs ${fov}`);
};

test('exact pins recover the camera and lens (8 points, lens unknown)',()=>{
 const {pose,points}=pins([40,14,50],[0,4,0],50,8);
 assert.equal(points.length,8);
 const res=resectCamera(points,{width:W,height:H});
 check(res,pose,50,{posPct:.2,rotDeg:.1,fovTol:.6});
 assert.equal(res.fovEstimated,true);assert.ok(res.rmsPx<.2);
});

test('known lens, noisy clicks (1.5 px), 6 points',()=>{
 const {pose,points}=pins([-45,20,38],[2,5,0],42,6,1.5);
 const res=resectCamera(points,{width:W,height:H,fov:42});
 check(res,pose,42,{posPct:3,rotDeg:.6});
 assert.ok(res.rmsPx<4);
});

test('only four points still solve when the lens is known',()=>{
 const {pose,points}=pins([30,24,-46],[0,4,0],55,4);
 assert.equal(points.length,4);
 const res=resectCamera(points,{width:W,height:H,fov:55});
 check(res,pose,55,{posPct:3,rotDeg:.6});
});

test('a mismatched pin shows up as a large error instead of a confident answer',()=>{
 const {points}=pins([40,14,50],[0,4,0],50,8);
 const bad=points.map(p=>({...p}));
 bad[2]={...bad[2],x:bad[2].x+260,y:bad[2].y-140};
 const res=resectCamera(bad,{width:W,height:H,fov:50});
 assert.ok(!res.ok||res.rmsPx>2||Math.max(...res.errors)>40,'the outlier pin is visible in the per-point errors');
 if(res.ok)assert.equal(res.errors.indexOf(Math.max(...res.errors)),2,'the worst point is the wrong one');
});

test('too few or invalid pins are refused with a reason',()=>{
 const {points}=pins([40,14,50],[0,4,0],50,8);
 assert.equal(MIN_PIN_POINTS,4);
 assert.match(resectCamera(points.slice(0,3),{width:W,height:H}).reason,/at least 4 points/);
 assert.match(resectCamera([{...points[0],x:NaN},...points.slice(1)],{width:W,height:H}).reason,/invalid coordinates/);
 assert.throws(()=>resectCamera(points,{width:0,height:H}),/Frame size/);
});

test('deterministic for the same pins',()=>{
 const {points}=pins([40,14,50],[0,4,0],50,7,1);
 const a=resectCamera(points,{width:W,height:H}),b=resectCamera(structuredClone(points),{width:W,height:H});
 assert.deepEqual(a.center,b.center);assert.equal(a.fov,b.fov);
});

test('wipe field of view keeps a letterboxed frame aligned with the 3D view',()=>{
 assert.equal(wipeFov(50,16/9,16/9),50);
 assert.equal(wipeFov(50,16/9,21/9),50,'a wider viewport pillarboxes: same vertical fov');
 const narrow=wipeFov(50,16/9,9/16);
 assert.ok(narrow>50*2,'a portrait viewport needs a much larger vertical fov: '+narrow);
 // The video rect (contain) spans the full width; its half height maps to the original half angle.
 const videoAspect=16/9,viewAspect=1,half=Math.tan(25*Math.PI/180),videoHalfH=1/videoAspect;
 assert.ok(Math.abs(Math.tan(wipeFov(50,videoAspect,viewAspect)*Math.PI/360)*videoHalfH-half*1)<1e-9);
});

test('roll against world up is reported (keys cannot store roll)',()=>{
 const upright=lookAtPose([30,10,40],[0,4,0]);
 assert.ok(rollDegrees(upright)<1e-6);
 // Rotate the camera about its optical axis by 12 degrees.
 const a=12*Math.PI/180,c=Math.cos(a),s=Math.sin(a),R=upright.R;
 const rolled={R:[c*R[0]+s*R[3],c*R[1]+s*R[4],c*R[2]+s*R[5],-s*R[0]+c*R[3],-s*R[1]+c*R[4],-s*R[2]+c*R[5],R[6],R[7],R[8]],t:upright.t};
 assert.ok(Math.abs(rollDegrees(rolled)-12)<1e-6);
});

import {MIN_ESTIMATE_FOV,MAX_ESTIMATE_FOV} from '../camera-resection.js';
test('the automatic lens search stays inside the usual lens range',()=>{
 assert.ok(MIN_ESTIMATE_FOV>=20&&MAX_ESTIMATE_FOV<=100);
});
