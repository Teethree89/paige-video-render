import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chapterGeometryStats,createRenderCallCounter} from '../render-diagnostics.js';
import {validateSceneEffects,validatePrimitiveDocument} from '../primitive-schema.js';
const sceneDoc={schemaVersion:1,scenes:[{shotId:'a',objects:[
 {primitive:'box',repeat:{count:[4,2,1]},arrayParts:{objects:[{},{}],lights:[{}]}},
 {primitive:'group',arrayParts:{objects:[{}],lights:[]}}
 ],lights:[{},{}]}]};
test('chapter counts distinguish editable roots, repeated copies, and rendered mesh copies',()=>{
 assert.deepEqual(chapterGeometryStats(sceneDoc,'a'),{objects:2,arrayCopies:8,meshCopies:25,lights:10});
 assert.equal(chapterGeometryStats(sceneDoc,'missing').objects,0);
});
test('per-chapter shadow master defaults on, persists off, and validates strictly',()=>{
 const legacy=validateSceneEffects({bloom:{enabled:false}});
 assert.equal(legacy.shadows.enabled,true);
 const doc=validatePrimitiveDocument({schemaVersion:1,scenes:[{
 shotId:'a',objects:[],effects:{shadows:{enabled:false}}
 }]},['a']);
 assert.equal(doc.scenes[0].effects.shadows.enabled,false);
 assert.equal(validatePrimitiveDocument(doc,['a']).scenes[0].effects.shadows.enabled,false);
 assert.throws(()=>validateSceneEffects({shadows:{enabled:'false'}}),/shadows enabled/);
 assert.throws(()=>validateSceneEffects({shadows:{enabled:0}}),/shadows enabled/);
});
test('draw-call counter attributes actual shadow draws, scene draws and bloom/output draws',()=>{
 const scene={},fullscreen={};
 const info={autoReset:true,render:{calls:0,triangles:0},reset(){this.render.calls=0;this.render.triangles=0;}};
 const renderer={info,shadowMap:{render(){info.render.calls+=3;info.render.triangles+=30;}},
   render(next){if(next===scene)this.shadowMap.render();info.render.calls+=next===scene?5:2;}};
 const originalRender=renderer.render,originalShadow=renderer.shadowMap.render;
 const stats=createRenderCallCounter(renderer,scene);
 try{
   stats.beginFrame();renderer.render(scene);renderer.render(fullscreen);
   assert.deepEqual(stats.endFrame(),{draws:10,scene:5,shadows:3,bloom:2,triangles:30});
   stats.beginFrame();renderer.render(scene);
   assert.equal(stats.endFrame().draws,8,'reset once before each displayed frame');
 }finally{stats.dispose();}
 assert.equal(renderer.render,originalRender);
 assert.equal(renderer.shadowMap.render,originalShadow);
 assert.equal(info.autoReset,true);
});
test('editor and MP4 share shadow override; idle FPS does not trigger rendering',async()=>{
 const root=new URL('../',import.meta.url);
 const files=await Promise.all(['app.js','render.js','scene-effects.js','scene-effects-panel.js','index.html']
   .map(file=>readFile(new URL(file,root),'utf8')));
 const [app,render,effects,panel,html]=files;
 assert.match(effects,/renderer\.shadowMap\.enabled=profile\.shadows\.enabled/);
 assert.match(app,/if\(profile\.shadows\.enabled&&!lastShadowEnabled\)primitiveWorld\.invalidateShadows/);
 assert.match(render,/applyShotEffects\(scene,renderer,effectsForShot\(seq,currentShot\.id\)\)/);
 assert.match(panel,/shadowsEnabled:\['sceneShadowsEnabled'/);
 assert.match(html,/id="sceneShadowsEnabled"/);
 assert.match(html,/id="renderDiagnostics"/);
 assert.match(app,/renderStats\.noteIdle\(now\)/);
 assert.match(app,/renderStats\.beginFrame\(\)/);
});
