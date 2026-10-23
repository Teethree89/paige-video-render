import test from 'node:test';
import assert from 'node:assert/strict';
import {syncChapterCameraMotion,clipPlanesForScene} from '../camera-motion-sync.js';
import {shotAnchorMap} from '../primitive-preview.js';
import {evaluateCamera} from '../animation-curves.js';
const round=n=>Math.round(n*1e4)/1e4;
const project=()=>({
 duration:12,fps:30,
 shots:[
  {id:'a',start:0,end:5,name:'Exterior'},
  {id:'b',start:5,end:12,name:'Interior'}
 ],
 camera:[
  {id:'a0',at:0,p:[0,4,14],t:[0,0,0],fov:50,cut:true},
  {id:'a1',at:2.5,p:[4,4,10],t:[2,0,0],fov:50,curve:{mode:'bezier',handles:[.2,.1,.8,.9]}},
  {id:'a2',at:4.9,p:[6,4,7],t:[4,0,0],fov:55},
  {id:'b0',at:5,p:[100,6,22],t:[100,0,0],fov:55,cut:true},
  {id:'b1',at:12,p:[99,5,12],t:[100,0,0],fov:52}
 ],text:[],primitiveScenes:{schemaVersion:1,scenes:[]}
});
const old={center:[2,0,0],radius:4},large={center:[102,0,0],radius:12},
  anchor=[100,0,0];
test('regeneration maps all authored motion keys to new geometry, preserving timing and curves',()=>{
 const seq=project(),serialized=JSON.stringify(seq);
 const {sequence:next,report}=syncChapterCameraMotion(seq,'a',{
   oldBounds:old,newBounds:large,anchor
 });
 assert.equal(report.source,'previous-geometry');
 assert.equal(report.scale,3);
 assert.equal(report.updatedKeys,4); // created end key at end-1 frame
 assert.equal(report.addedKeys,1);
 assert.deepEqual(next.shots[0].sceneAnchor,anchor);
 assert.equal(next.camera.find(k=>k.id==='a0').p[2],42);
 assert.equal(next.camera.find(k=>k.id==='a0').t[0],96);
 assert.equal(next.camera.find(k=>k.id==='a1').curve.mode,'bezier');
 assert.equal(next.camera.find(k=>k.id==='a1').at,2.5);
 assert.deepEqual(next.camera.filter(k=>k.id.startsWith('b')),seq.camera.filter(k=>k.id.startsWith('b')));
 assert.equal(JSON.stringify(seq),serialized,'Source timeline must be immutable');
});
test('anchored generated primitives stay fixed when synced camera targets change',()=>{
 const source=project(),initial=shotAnchorMap(source,t=>evaluateCamera(source.camera,t)).a;
 const {sequence:next}=syncChapterCameraMotion(source,'a',{oldBounds:old,newBounds:large,anchor:initial});
 const after=shotAnchorMap(next,t=>evaluateCamera(next.camera,t)).a;
 assert.deepEqual(after,initial);
 assert.notDeepEqual(next.camera.find(k=>k.id==='a0').t,source.camera.find(k=>k.id==='a0').t);
});
test('fallback uses authored camera movement when original scene has no accepted bounds',()=>{
 const src=project(),{sequence:next,report}=syncChapterCameraMotion(src,'a',{
   newBounds:{center:[45,3,-30],radius:6},anchor:[0,0,0]
 });
 assert.equal(report.source,'authored-camera');
 assert.ok(report.scale>0);
 assert.ok(report.updatedKeys>=3);
 assert.deepEqual(next.camera.find(x=>x.id==='b0'),src.camera.find(x=>x.id==='b0'));
});
test('full fit moves the camera far enough to encompass regenerated bounds',()=>{
 const src=project(),opts={oldBounds:old,newBounds:large,anchor,aspect:16/9};
 const motion=syncChapterCameraMotion(src,'a',{...opts,mode:'motion'});
 const wide=syncChapterCameraMotion(src,'a',{...opts,mode:'fit'});
 assert.ok(wide.report.scale>=motion.report.scale);
 assert.ok(wide.report.syncDistance>=motion.report.syncDistance);
});
test('model view rotates original movement toward suggested first camera',()=>{
 const source=project();
 const {sequence:next,report}=syncChapterCameraMotion(source,'a',{
   oldBounds:old,newBounds:large,anchor,mode:'model-view',
   modelCamera:{position:[120,8,0],target:[100,0,0],fov:50}
 });
 assert.equal(report.estimatedOrientationUsed,true);
 assert.ok(next.camera.find(k=>k.id==='a0').p[0]>105);
 assert.throws(()=>syncChapterCameraMotion(source,'a',{
   oldBounds:old,newBounds:large,anchor,mode:'model-view'}),/estimated camera/);
});
test('reject missing geometry, invalid anchors and nonfinite bounds without altering project',()=>{
 const seq=project(),before=JSON.stringify(seq);
 assert.throws(()=>syncChapterCameraMotion(seq,'a',{newBounds:null,anchor}),/bounds/);
 assert.throws(()=>syncChapterCameraMotion(seq,'a',{newBounds:large,anchor:[NaN,0,0]}),/anchor/);
 assert.throws(()=>syncChapterCameraMotion(seq,'missing',{newBounds:large,anchor}),/chapter/);
 assert.throws(()=>syncChapterCameraMotion(seq,'a',{
   newBounds:{center:[0,0,0],radius:Infinity},anchor}),/bounds/);
 assert.equal(JSON.stringify(seq),before);
});
test('resync remains stable when regenerated bounds and anchor do not change',()=>{
 const first=syncChapterCameraMotion(project(),'a',{
   oldBounds:old,newBounds:large,anchor
 });
 const second=syncChapterCameraMotion(first.sequence,'a',{
   oldBounds:large,newBounds:large,anchor
 });
 for(const id of ['a0','a1','a2']){
   const current=first.sequence.camera.find(k=>k.id===id);
   const next=second.sequence.camera.find(k=>k.id===id);
   assert.ok(Math.hypot(...current.p.map((n,i)=>n-next.p[i]))<.01);
   assert.ok(Math.hypot(...current.t.map((n,i)=>n-next.t[i]))<.01);
 }
});

test('cinematic clip planes expand for gigantic regenerated geometry without reusing 500m far limit',()=>{
 const result=clipPlanesForScene([80,30,800],[0,0,0],
   {center:[0,0,0],radius:1300});
 assert.ok(result.far>4000);
 assert.ok(result.near>=.05&&result.near<=.35);
 assert.equal(clipPlanesForScene([0,0,10],[0,0,0],
   {center:[0,0,0],radius:3}).far,500);
 assert.deepEqual(clipPlanesForScene(null,null,null),{near:.35,far:500});
});
