import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {shotAnchorMap,fitDistance,restoreSavedPrimitiveWorld} from '../primitive-preview.js';
import {validatePrimitiveDocument,makePrimitive} from '../primitive-schema.js';

test('restoring an old unlayered timeline keeps geometry and applies its chapter anchor',()=>{
  const sequence={title:'Saved AI project',shots:[{id:'hall'}],
    camera:[{at:0,p:[180,10,20],t:[180,5,-35],fov:50}],text:[],
    primitiveScenes:{schemaVersion:1,scenes:[{shotId:'hall',objects:[makePrimitive('box','old')]}]}};
  const before=structuredClone(sequence),anchors={hall:[180,0,-35]},calls=[];
  const world={setDocument(value,allowed,placement){
    calls.push({doc:validatePrimitiveDocument(value,allowed),placement});
  }};
  assert.equal(restoreSavedPrimitiveWorld(world,sequence,anchors),null);
  assert.deepEqual(calls,[{doc:sequence.primitiveScenes,placement:anchors}]);
  assert.deepEqual(sequence,before);
});

test('failed geometry restoration clears partial meshes and retains the entire saved project for export',()=>{
  for(const failure of ['validation','build']){
    const item=makePrimitive('box','old');
    if(failure==='validation')item.layer='unsupported';
    const sequence={title:'Edited project',duration:9,shots:[{id:'hall'}],
      camera:[{at:0,p:[180,10,20],t:[180,5,-35],fov:50}],text:[{value:'Saved caption'}],
      primitiveScenes:{schemaVersion:1,scenes:[{shotId:'hall',objects:[item]}]}};
    const before=structuredClone(sequence),seen=[];let rendered;
    const world={setDocument(value,allowed){
      seen.push(value);
      rendered=validatePrimitiveDocument(value,allowed);
      if(value)throw Error('Cannot build saved geometry');
    }};
    const error=restoreSavedPrimitiveWorld(world,sequence,{hall:[180,0,-35]});
    assert.ok(error instanceof Error);
    assert.deepEqual(seen,[sequence.primitiveScenes,undefined]);
    assert.deepEqual(rendered,{schemaVersion:1,scenes:[]});
    assert.deepEqual(sequence,before,'a rendering failure cannot replace the project with defaults');
  }
});

test('generated shot-local primitives are anchored to each chapter camera target',()=>{
  const shots=[
    {id:'exterior',start:0,end:4.3},
    {id:'hall',start:4.3,end:13.1},
    {id:'pcb',start:13.1,end:17.8}
  ];
  const sequence={shots};
  const seen=[];
  const anchors=shotAnchorMap(sequence,at=>{
    seen.push(at);
    if(at>=13.1)return {t:[360,6,0]};
    if(at>=4.3)return {t:[180,5,-35]};
    return {t:[0,3,0]};
  });
  assert.deepEqual(anchors,{
    exterior:[0,0,0],hall:[180,0,-35],pcb:[360,0,0]
  });
  assert.equal(seen.length,3);
  assert.deepEqual(shots.map(s=>s.start),[0,4.3,13.1],
    'Source timeline and camera keys are never mutated');
});
test('mobile aspect ratio requires greater 3D review distance',()=>{
  const desktop=fitDistance(9,52,16/9);
  const mobile=fitDistance(9,52,9/16);
  assert.ok(mobile>desktop);
  assert.ok(fitDistance(0,52,1)>0);
  assert.ok(fitDistance(1,52,1)<fitDistance(10,52,1));
});
test('preview is wired into Three.js viewport and does not persist camera key changes',async()=>{
  const root=new URL('../',import.meta.url);
  const [app,world,primitive,html,render]=await Promise.all(
    ['app.js','world.js','primitive-world.js','index.html','render.js'].map(name=>
      readFile(new URL(name,root),'utf8')));
  assert.match(app,/shotAnchorMap\(sequence,cameraAt\)/);
  assert.match(app,/primitiveWorld\.setDocument\(doc,sequence\.shots\.map\(s=>s\.id\),primitiveAnchors\(\)\)/);
  assert.match(app,/world\.update\(playhead,shot\.id,custom\)/);
  assert.match(app,/restoreSavedPrimitiveWorld\(primitiveWorld,sequence,primitiveAnchors\(\)\)/);
  assert.doesNotMatch(app,/sequence=structuredClone\(originalSequence\);syncPrimitiveWorld\(\);\s*\}/,
    'boot must not silently reset a saved timeline after a geometry error');
  assert.match(render,/restoreSavedPrimitiveWorld\(primitiveWorld,seq,shotAnchorMap\(seq,cameraAt\)\)/);
  assert.match(render,/world\.update\(t,currentShot\.id,custom\)/);
  assert.match(world,/hasCustomPrimitives/);
  assert.match(primitive,/root\.position\.set\(\.\.\.anchor\)/);
  assert.match(primitive,/new THREE\.Box3\(\)\.setFromObject\(root\)/);
  assert.match(app,/if\(scroll\)viewport\.scrollIntoView/);
  assert.match(app,/reviewLights\.visible=true/);
  assert.match(app,/reviewLights\.visible=false;reviewStage\.visible=false/);
  assert.match(app,/reviewStage\.visible=true/);
  assert.match(app,/reviewGrid\.scale\.setScalar\(stageSize\/40\)/);
  assert.match(app,/renderer\.toneMappingExposure=1\.65/);
  assert.match(app,/renderer\.toneMappingExposure=1\.35/);
  assert.match(app,/onDiscard:\(\)=>\{\s*cameraSyncPreview=null;cameraSyncSession=null;\s*endGeometryReview\(\);syncPrimitiveWorld\(\);renderWorld\(\);/);
  assert.match(app,/onCameraSyncReset:\(\)=>\{/);
  assert.match(app,/if\(cameraSyncPreview&&cameraSyncSession\?\.shotId===shotAt\(t\)\?\.id\)/);
  assert.match(html,/id="returnTimelineCameraBtn"/);
  assert.match(html,/id="aiSceneInspect"/);
  assert.match(html,/id="aiSceneCleanup"/);
  assert.match(html,/id="aiSceneLog"/);
  assert.match(html,/id="primitiveCleanupSaved"/);
  assert.match(app,/cleanupPrimitiveDocument\(/);
  assert.match(app,/primitiveCleanupSaved/);
  assert.doesNotMatch(app,/sequence\.camera\s*=/,
    'Proposal review must never replace authored camera arrays');
});
