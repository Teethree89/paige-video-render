import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const root=new URL('../',import.meta.url);
const read=path=>readFileSync(new URL(path,root),'utf8');
const planCode=read('ae-package-plan.js');
const plan=await import('data:text/javascript;base64,'+Buffer.from(planCode).toString('base64'));
const jsx=read('AfterEffects/BUILD_EDITABLE_PROJECT.jsx');
const app=read('app.js');
const html=read('index.html');

test('Menu offers JSON and an AE package with current in-browser timeline',()=>{
  assert.match(html,/id="exportJSONBtn"/);
  assert.match(html,/id="exportAEBtn"/);
  assert.match(app,/JSON\.stringify\(sequence,null,2\)/);
  assert.match(app,/buildAfterEffectsPackage\(\{/);
  assert.match(app,/await modelTools\?\.ready/);
  assert.match(app,/aiSceneEditor\?\.hasPending\?\.\(\)/);
});

test('Seven original scene origins are stable; imported shots follow their camera target',()=>{
  const timeline=JSON.parse(read('timeline.json'));
  const calls=[];
  const snapshot=plan.createAETimeline(timeline,t=>{calls.push(t);return {t:[99,5,27]};});
  assert.deepEqual(snapshot.shots.map(s=>s.aeOrigin[0]),[0,180,360,440,180,560,690,815,0]);
  assert.equal(snapshot.shots[4].aeOrigin[2],0);
  assert.equal(timeline.shots[0].aeOrigin,undefined,'must not mutate working editor timeline');
  assert.equal(calls.length,0,'legacy shots do not need inferred offsets');
  assert.equal(plan.modelIdForShot('hallreturn'),'hall');
  assert.equal(plan.modelIdForShot('finale'),'exterior');
  assert.equal(plan.modelIdForShot('new-01'),null);
  assert.deepEqual(plan.aeOriginForShot({id:'new-01',start:4,end:7},()=>({t:[22,3,-30]})),[22,0,-30]);
  assert.equal(plan.shotAssetPath(0),'assets/shots/shot-01.glb');
  assert.equal(plan.shotAssetPath(10),'assets/shots/shot-11.glb');
});

test('AE JSX consumes shot-specific GLBs and the same three-axis registration',()=>{
  assert.match(jsx,/shot\.aeOrigin/);
  assert.match(jsx,/var shotGlbs=\[\]/);
  assert.match(jsx,/shotGlbs\[i\]\|\|glbs\[sid\]/);
  assert.match(jsx,/var origin=\(shot\.aeOrigin/);
  assert.match(jsx,/a\.p\[0\]-sceneOffset\[0\]/);
  assert.match(jsx,/a\.p\[2\]-sceneOffset\[2\]/);
  assert.match(jsx,/a\.t\[2\]-sceneOffset\[2\]/);
});

function fakePackageRuntime(){
  const code=read('ae-package-export.js').replace(/^import .*;\s*$/gm,'')
    .replace('export async function buildAfterEffectsPackage','async function buildAfterEffectsPackage');
  const getBuilder=new Function('GLTFExporter','zipFiles','AE_MODEL_IDS',
    'modelIdForShot','shotAssetPath','createAETimeline','fetch',
    code+'\nreturn buildAfterEffectsPackage;');
  const sources=[];
  class GLTFExporter{
    parse(source,resolve){
      sources.push(source);
      const glb=new ArrayBuffer(12);
      new DataView(glb).setUint32(0,0x46546c67,true);
      resolve(glb);
    }
  }
  let scriptRequests=0;
  const fetch=async()=>{scriptRequests++;return {
    ok:true,text:async()=> 'function addCameraKeys(){ /* aeOrigin */ }'
  };};
  const build=getBuilder(GLTFExporter,entries=>entries,plan.AE_MODEL_IDS,
    plan.modelIdForShot,plan.shotAssetPath,plan.createAETimeline,fetch);
  return {build,sources,get requests(){return scriptRequests;}};
}

test('AE ZIP contains edited timeline, current seven models, JSX and shot override',async()=>{
  const {build,sources,requests}=fakePackageRuntime();
  const shot={id:'new-scene',start:0,end:2,name:'New scene'};
  const sequence={duration:2,shots:[shot],camera:[{at:0,p:[32,10,20],t:[25,3,-10],fov:50}],
    text:[{id:'custom',value:'Edited title'}],
    primitiveScenes:{scenes:[{shotId:'new-scene',objects:[{id:'block'}]}]}};
  let primitiveRoot={position:{x:25,y:0,z:-10}};
  const entries=await build({
    sequence,
    cameraAt:()=>({t:[25,3,-10]}),
    world:{modelForAEExport:id=>({liveId:id})},
    primitiveWorld:{hasObjects:()=>true,getSceneForExport:()=>primitiveRoot}
  });
  const names=entries.map(e=>e.name);
  assert.ok(names.includes('AfterEffects/BUILD_EDITABLE_PROJECT.jsx'));
  assert.ok(names.includes('README-AFTER-EFFECTS.txt'));
  assert.ok(names.includes('assets/models/manifest.json'));
  assert.ok(names.includes('assets/shots/shot-01.glb'));
  assert.equal(names.filter(n=>n.startsWith('assets/models/')&&n.endsWith('.glb')).length,7);
  const snapshot=JSON.parse(entries.find(e=>e.name==='timeline.json').data);
  assert.equal(snapshot.text[0].value,'Edited title');
  assert.deepEqual(snapshot.shots[0].aeOrigin,[25,0,-10]);
  assert.equal(sequence.shots[0].aeOrigin,undefined);
  assert.deepEqual(primitiveRoot.position,{x:0,y:0,z:0});
  assert.equal(sources.length,8,'seven live GLBs and one shot-specific GLB');
});

test('Default package does not create phantom custom-shot geometry',async()=>{
  const {build}=fakePackageRuntime();
  const seq=JSON.parse(read('timeline.json'));
  const entries=await build({
    sequence:seq,
    cameraAt:()=>({t:[0,0,0]}),
    world:{modelForAEExport:id=>({id})},
    primitiveWorld:{hasObjects:()=>false}
  });
  assert.equal(entries.filter(e=>e.name.startsWith('assets/shots/')).length,0);
  assert.equal(entries.length,11,'7 models + JSON + JSX + instructions + manifest');
});
