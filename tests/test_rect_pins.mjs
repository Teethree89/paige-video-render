import test from 'node:test';
import assert from 'node:assert/strict';
import {faceQuad,rankQuadOrders,quadProblem,QUAD_ORDERS} from '../rect-pins.js';
import {rectLabel} from '../camera-track-wizard.js';
import {resectCamera,projectPoint} from '../camera-resection.js';
import {lookAtPose} from '../camera-track-solver.js';

// Every vertex of a box (Three.js BoxGeometry lists each face's 4 corners separately).
function boxVertices(center,size){
 const out=[];
 for(const sx of [-1,1])for(const sy of [-1,1])for(const sz of [-1,1])
   for(let k=0;k<3;k++)out.push([center[0]+sx*size[0]/2,center[1]+sy*size[1]/2,center[2]+sz*size[2]/2]);
 return out;
}
const sameSet=(a,b)=>a.length===b.length&&a.every(p=>b.some(q=>p.every((v,i)=>Math.abs(v-q[i])<1e-9)));

test('faceQuad finds the 4 corners of the clicked box face',()=>{
 const quad=faceQuad(boxVertices([0,4,0],[16,8,10]),[0,0,1],[2,3,5]);
 assert.ok(sameSet(quad,[[-8,0,5],[8,0,5],[8,8,5],[-8,8,5]]),JSON.stringify(quad));
 const top=faceQuad(boxVertices([0,4,0],[16,8,10]),[0,1,0],[1,8,1]);
 assert.ok(sameSet(top,[[-8,8,-5],[8,8,-5],[8,8,5],[-8,8,5]]));
});

test('faceQuad ignores extra vertices inside a subdivided face and works on rotated faces',()=>{
 const grid=[];for(let i=0;i<=4;i++)for(let j=0;j<=4;j++)grid.push([i,j,0]);
 assert.ok(sameSet(faceQuad(grid,[0,0,1],[1,1,0]),[[0,0,0],[4,0,0],[4,4,0],[0,4,0]]));
 const a=Math.PI/6,rot=([x,y,z])=>[x*Math.cos(a)+z*Math.sin(a),y,-x*Math.sin(a)+z*Math.cos(a)];
 const q=faceQuad(grid.map(rot),rot([0,0,1]),rot([2,2,0]));
 assert.ok(sameSet(q,[[0,0,0],[4,0,0],[4,4,0],[0,4,0]].map(rot)));
});

test('faceQuad refuses discs and triangles',()=>{
 const disc=Array.from({length:32},(_,i)=>[Math.cos(i/32*2*Math.PI),Math.sin(i/32*2*Math.PI),0]);
 assert.equal(faceQuad(disc,[0,0,1],[0,0,0]),null);
 assert.equal(faceQuad([[0,0,0],[1,0,0],[0,1,0],[.2,.2,0]],[0,0,1],[.1,.1,0]),null);
});

test('rankQuadOrders lines up the corners from the 3D view, whichever corner was clicked first',()=>{
 const pose=lookAtPose([20,12,30],[0,4,0]),W=480,H=270;
 const model=[[-8,0,5],[8,0,5],[8,8,5],[-8,8,5]];
 const video=[2,3,0,1].map(i=>projectPoint(pose,50,W,H,model[i])); // started at the top right
 // The 3D view is near, but not at, the video camera, and the canvas is a different size.
 const view=lookAtPose([16,10,34],[0,3,0]);
 const screen=model.map(X=>{const p=projectPoint(view,45,1000,700,X);return {x:p.x,y:p.y};});
 assert.deepEqual(rankQuadOrders(video,screen)[0].order,[2,3,0,1]);
 // Clicked the other way around.
 const back=[1,0,3,2].map(i=>projectPoint(pose,50,W,H,model[i]));
 assert.deepEqual(rankQuadOrders(back,screen)[0].order,[1,0,3,2]);
 assert.equal(rankQuadOrders(video,screen).length,8);
 assert.equal(new Set(QUAD_ORDERS.map(String)).size,8);
});

test('four corners of one rectangle are enough to place the camera',()=>{
 const pose=lookAtPose([20,12,30],[0,4,0]),W=480,H=270;
 const model=[[-8,0,5],[8,0,5],[8,8,5],[-8,8,5]];
 const pts=model.map(X=>{const p=projectPoint(pose,50,W,H,X);return {x:p.x,y:p.y,X};});
 const r=resectCamera(pts,{width:W,height:H,fov:50});
 assert.ok(r.ok&&r.rmsPx<.5,JSON.stringify({ok:r.ok,rms:r.rmsPx}));
 assert.ok(Math.hypot(r.center[0]-20,r.center[1]-12,r.center[2]-30)<.5,'camera at '+r.center);
});

test('quadProblem flags crossed and sliver rectangles',()=>{
 assert.equal(quadProblem([{x:0,y:0},{x:10,y:0},{x:10,y:8},{x:0,y:8}]),null);
 assert.equal(quadProblem([{x:0,y:0},{x:10,y:8},{x:10,y:0},{x:0,y:8}]),'crossed');
 assert.equal(quadProblem([{x:0,y:0},{x:100,y:0},{x:100,y:.5},{x:0,y:.5}]),'thin');
});

test('rectangles are lettered in the order they were marked',()=>{
 const pins=[{id:'a'},{id:'b',rect:'rect3'},{id:'c',rect:'rect3'},{id:'d',rect:'rect7'}];
 assert.equal(rectLabel(pins,'rect3'),'A');assert.equal(rectLabel(pins,'rect7'),'B');
});
