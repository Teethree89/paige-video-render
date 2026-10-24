import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {acceptedCameraSnapshot,prepareAcceptedCameraSync} from '../accepted-camera-sync.js';
import {shotAnchorMap} from '../primitive-preview.js';
import {evaluateCamera} from '../animation-curves.js';

const make=()=>({
  title:'Accepted model',duration:10,fps:30,
  shots:[{id:'first',name:'First',start:0,end:5},{id:'second',name:'Second',start:5,end:10}],
  camera:[
    {id:'a0',at:0,p:[2,2,11],t:[0,0,0],fov:50,cut:true},
    {id:'a1',at:4,p:[5,2,10],t:[3,0,0],fov:50,curve:{mode:'linear'}},
    {id:'b0',at:5,p:[100,2,14],t:[100,0,0],fov:50,cut:true},
    {id:'b1',at:10,p:[100,3,6],t:[100,0,0],fov:50}
  ],text:[{id:'cap',start:6,end:7,value:'Untouched'}],
  primitiveScenes:{schemaVersion:1,scenes:[
    {shotId:'first',objects:[{id:'shape',primitive:'box',scale:[12,8,10],position:[0,0,0],
      rotation:[0,0,0],name:'Accepted geometry',material:{color:'#ffffff',roughness:.5,metalness:0}}]},
    {shotId:'second',objects:[{id:'other',primitive:'box',scale:[1,2,3],position:[0,0,0],
      rotation:[0,0,0],name:'Unchanged',material:{color:'#ffffff',roughness:.5,metalness:0}}]}
  ]}
});
test('can sync camera *after* acceptance without touching any geometry or text',()=>{
 const original=make(),baseline=JSON.stringify(original);
 const proposal=prepareAcceptedCameraSync(original,'first',{
   bounds:{center:[40,2,18],radius:25},anchor:[0,0,0],mode:'motion'
 });
 assert.notEqual(proposal.sequence.camera.find(k=>k.id==='a0').p[2],original.camera[0].p[2]);
 assert.deepEqual(proposal.sequence.primitiveScenes,original.primitiveScenes);
 assert.deepEqual(proposal.sequence.text,original.text);
 assert.deepEqual(proposal.sequence.camera.find(k=>k.id==='b0'),original.camera[2]);
 assert.deepEqual(proposal.sequence.shots[0].sceneAnchor,[0,0,0]);
 assert.equal(proposal.report.source,'authored-camera');
 assert.equal(proposal.shotId,'first');
 assert.equal(JSON.stringify(original),baseline,'preview must not edit the saved document');
});
test('camera sync freezes geometry anchor and respects existing model-view framing',()=>{
 const original=make();
 const proposal=prepareAcceptedCameraSync(original,'first',{
   bounds:{center:[5,3,5],radius:10},anchor:[0,0,0],mode:'model-view',
   modelCamera:{position:[22,10,5],target:[5,3,5],fov:50}
 });
 assert.equal(proposal.report.estimatedOrientationUsed,true);
 assert.deepEqual(shotAnchorMap(proposal.sequence,t=>evaluateCamera(proposal.sequence.camera,t)).first,[0,0,0],
   'Exact selected anchor must be frozen even when original interpolated camera target is slightly offset');
});
test('fit option and subsequent sync do not amplify a correctly fitted model repeatedly',()=>{
 const original=make(),bounds={center:[0,0,0],radius:8};
 const first=prepareAcceptedCameraSync(original,'first',{bounds,anchor:[0,0,0],mode:'fit'});
 const second=prepareAcceptedCameraSync(first.sequence,'first',{bounds,anchor:[0,0,0],mode:'fit'});
 assert.ok(second.report.scale>0);
 assert.ok(second.report.scale<2,'second sync should not blow up camera trajectory');
});
test('snapshot detects edited accepted geometry or changed camera keys',()=>{
 const original=make(),snapshot=acceptedCameraSnapshot(original,'first');
 const changed=structuredClone(original);changed.primitiveScenes.scenes[0].objects[0].scale[0]=30;
 assert.notEqual(acceptedCameraSnapshot(changed,'first'),snapshot);
 const moved=structuredClone(original);moved.camera[0].p[0]=100;
 assert.notEqual(acceptedCameraSnapshot(moved,'first'),snapshot);
 const other=structuredClone(original);other.text[0].value='Different';
 assert.equal(acceptedCameraSnapshot(other,'first'),snapshot);
});
test('empty or missing accepted geometry cannot activate post-accept sync',()=>{
 const s=make();
 s.primitiveScenes.scenes[0].objects=[];
 assert.throws(()=>prepareAcceptedCameraSync(s,'first',{
   bounds:{center:[0,0,0],radius:5},anchor:[0,0,0]
 }),/No accepted 3D model/);
 assert.throws(()=>acceptedCameraSnapshot(s,'missing'),/valid chapter/);
});
test('post-accept camera preview is a separate, no-network UI flow with undo history',async()=>{
 const [app,markup]=await Promise.all([
  readFile(new URL('../app.js',import.meta.url),'utf8'),
  readFile(new URL('../index.html',import.meta.url),'utf8')
 ]);
 assert.match(markup,/id="acceptedCameraSyncPanel"/);
 assert.match(markup,/id="acceptedCameraSyncApply"/);
 assert.match(app,/acceptedCameraPreview=proposal/);
 assert.match(app,/return evaluateCamera\(acceptedCameraPreview.sequence.camera,t\)/);
 assert.match(app,/acceptedCameraPreview=null;\s*sequence=next;/);
 assert.match(app,/syncPrimitiveWorld\(\);\s*refreshAll\(\);seek\(at\);saveLocal\(\)/);
 assert.doesNotMatch(app,/onPreview:proposal=>\{[^}]*fetch\(/);
});
