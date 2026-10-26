import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {CREATE_CATEGORIES,CREATE_DEFAULTS,insertCreatedAsset,validateCreateChoice} from '../scene-asset-catalog.js';
import {validatePrimitiveDocument,validateSceneEffects,LIMITS} from '../primitive-schema.js';
import {editLightTransform,deleteLightObject} from '../scene-object-operations.js';
const empty=()=>({schemaVersion:1,scenes:[]});
test('every radial Create submenu item creates validated scene geometry or a punctual light',()=>{
 for(const category of CREATE_CATEGORIES)for(const [preset] of category.items){
  const result=insertCreatedAsset(empty(),'shot_a',category.id,preset,[2,0,-3]);
  const scene=result.document.scenes[0];
  assert.ok(scene.objects.length+(scene.lights?.length||0)>0,category.id+'/'+preset);
  assert.ok(result.selected.id);
  validatePrimitiveDocument(result.document,['shot_a']);
 }
 assert.equal(Object.keys(CREATE_DEFAULTS).length,CREATE_CATEGORIES.length);
});
test('quick repeat and per-category remembered choice names stay allowlisted',()=>{
 assert.equal(validateCreateChoice('lights','point-warm').id,'lights');
 assert.throws(()=>validateCreateChoice('lights','remote-script'),/Unrecognized/);
 assert.throws(()=>insertCreatedAsset(empty(),'chapter','vehicles','../etc/passwd'),/Unrecognized/);
});
test('lights get editable stable IDs, can coexist with no geometry, and respect caps',()=>{
 let doc=empty();
 for(let n=0;n<LIMITS.lightsPerScene;n++)doc=insertCreatedAsset(
  doc,'shot_a','lights',n%2?'spot-cool':'point-blue',[0,1,0]).document;
 const lights=doc.scenes[0].lights;
 assert.equal(new Set(lights.map(x=>x.id)).size,LIMITS.lightsPerScene);
 assert.equal(doc.scenes[0].objects.length,0);
 assert.equal(lights[0].color,'#80bcff');
 assert.equal(lights[1].type,'spot');
 assert.throws(()=>insertCreatedAsset(doc,'shot_a','lights','sun'),/at most 8/);
 const legacy={schemaVersion:1,scenes:[{shotId:'shot_a',objects:[],
  lights:[{type:'point',name:'Old',color:'#ffffff',intensity:5,position:[0,3,0]}]}]};
 assert.equal(validatePrimitiveDocument(legacy).scenes[0].lights[0].id,undefined);
});
test('complex vehicle preset remains editable and emission survives JSON round-trip',()=>{
 const doc=insertCreatedAsset(empty(),'chapter','vehicles','truck').document;
 assert.ok(doc.scenes[0].objects.length>=5);
 const first=doc.scenes[0].objects[0];
 first.material.emissive='#ffaa00';first.material.emissiveIntensity=2.2;
 first.material.opacity=.75;
 const validated=validatePrimitiveDocument(doc);
 assert.equal(validated.scenes[0].objects[0].material.emissiveIntensity,2.2);
 assert.equal(validated.scenes[0].objects[0].material.opacity,.75);
});
test('per-chapter fog, bloom, exposure and vignette normalize with strict safe bounds',()=>{
 const fx=validateSceneEffects({fog:{mode:'custom',color:'#8AAABB',density:.012},
  bloom:{enabled:true,strength:1.5,radius:.3,threshold:.75},exposure:2.1,vignette:.62});
 assert.equal(fx.fog.color,'#8aaabb');
 const source={schemaVersion:1,scenes:[{shotId:'a',objects:[],effects:fx}]};
 const doc=validatePrimitiveDocument(source);
 assert.deepEqual(doc.scenes[0].effects,fx);
 assert.throws(()=>validateSceneEffects({...fx,exposure:Infinity}),/exposure/);
 assert.throws(()=>validateSceneEffects({...fx,bloom:{enabled:true,strength:50}}),/bloom strength/);
 assert.throws(()=>validateSceneEffects({...fx,fog:{mode:'bad'}}),/fog mode/);
});
test('Create menu and scene effect render paths ship in both editor and video',async()=>{
 const root=new URL('../',import.meta.url);
 const [radial,app,render,markup,world,editor]=await Promise.all(
 ['radial-create.js','app.js','render.js','index.html','primitive-world.js','primitive-editor.js']
 .map(p=>readFile(new URL(p,root),'utf8')));
 assert.match(radial,/CREATE_HOLD_MS=380,CREATE_HOVER_MS=500/);
 assert.match(radial,/perCategory\[category\]=item/);
 assert.match(app,/setupRadialCreate\(/);
 assert.match(app,/studioPost\.render\(\)/);
 assert.match(app,/applyShotEffects\(scene,renderer/);
 assert.match(render,/post\.configure\(profile\);post\.render\(\)/);
 assert.match(render,/paintVignette\(ctx,out\.width,out\.height,profile\)/);
 assert.match(markup,/id="primitiveLightColor"/);
 assert.match(markup,/id="primitiveEmissiveIntensity"/);
 assert.match(markup,/id="sceneBloomEnabled"/);
 assert.match(world,/if\(!entry\.objects\.length&&/);
 assert.match(editor,/createAsset\(category,preset,origin=/);
});

test('light gizmo move/delete preserves unrelated accepted shapes and never exports markers',async()=>{
 const base=insertCreatedAsset(empty(),'a','primitives','sphere',[0,0,0]).document;
 const created=insertCreatedAsset(base,'a','lights','spot-warm',[0,0,0]);
 const light=created.document.scenes[0].lights[0],before=JSON.stringify(created.document.scenes[0].objects);
 const moved=editLightTransform(created.document,['a'],'a',light.id,[9,6,-3]);
 assert.deepEqual(moved.scenes[0].lights[0].position,[9,6,-3]);
 assert.equal(JSON.stringify(moved.scenes[0].objects),before);
 const deleted=deleteLightObject(moved,['a'],'a',light.id);
 assert.equal(deleted.scenes[0].lights?.length||0,0);
 assert.equal(JSON.stringify(deleted.scenes[0].objects),before);
 const world=await readFile(new URL('../primitive-world.js',import.meta.url),'utf8');
 const editor=await readFile(new URL('../scene-object-edit.js',import.meta.url),'utf8');
 assert.match(world,/Editor_light_markers_/);
 assert.match(world,/markerRoot\.visible=false/);
 assert.match(world,/setLightMarkersVisible/);
 assert.match(world,/return copy;/);
 assert.match(editor,/onLightTransform/);
 assert.match(editor,/primitiveLightId/);
 assert.throws(()=>editLightTransform(deleted,['a'],'a',light.id,[0,0,0]),/no longer exists/);
});


test('new light presets produce shot-local punctual lights and recognizable editor-only bulb gizmos',async()=>{
 const source=new URL('../primitive-world.js',import.meta.url);
 const world=await readFile(source,'utf8');
 let doc=insertCreatedAsset(empty(),'a','primitives','box',[0,0,0]).document;
 doc=insertCreatedAsset(doc,'a','lights','point-red',[0,0,0]).document;
 doc=insertCreatedAsset(doc,'a','lights','spot-cool',[0,0,0]).document;
 const entry=doc.scenes[0];
 assert.equal(entry.objects.length,1);
 assert.equal(entry.lights.length,2);
 assert.deepEqual(entry.lights.map(l=>l.type),['point','spot']);
 assert.equal(entry.lights[0].intensity,180);
 assert.equal(entry.lights[1].intensity,240);
 assert.notEqual(entry.lights[0].id,entry.lights[1].id);
 assert.deepEqual(entry.lights[0].position,entry.lights[1].position);
 assert.match(world,/new THREE\.PointLight\(color,spec\.intensity,spec\.distance\)/);
 assert.match(world,/new THREE\.SpotLight\(color,spec\.intensity,spec\.distance,spec\.angle,spec\.penumbra\)/);
 assert.match(world,/for\(const spec of entry\.lights\|\|\[\]\)root\.add\(light\(spec\)\)/);
 assert.match(world,/mesh\.castShadow=true/);
 assert.match(world,/mesh\.receiveShadow=true/);
 assert.match(world,/node\.shadow\.mapSize\.set\(512,512\)/);
 assert.match(world,/new THREE\.SphereGeometry\(\.2,12,8\)/);
 assert.match(world,/new THREE\.LineSegments\(rayGeometry/);
 assert.match(world,/marker\.userData\.primitiveLightId=id/);
 assert.match(world,/markerRoot\.visible=false/);
 assert.match(world,/markerRoot\.add\(marker\)/);
 assert.match(world,/root\.visible=false/);
 assert.match(world,/const copy=root\.clone\(true\)/);
 assert.match(world,/return copy;/);
 assert.doesNotMatch(world,/new THREE\.OctahedronGeometry\(\.48,0\)/);
});

test('editor and video agree on shadow rendering; editing suppresses temporary studio fill',async()=>{
 const root=new URL('../',import.meta.url);
 const [app,render,world,assets]=await Promise.all(
  ['app.js','render.js','primitive-world.js','scene-asset-catalog.js']
    .map(path=>readFile(new URL(path,root),'utf8')));
 assert.match(app,/renderer\.shadowMap\.enabled=true/);
 assert.match(render,/renderer\.shadowMap\.enabled=true/);
 assert.match(app,/reviewLights\.visible=!editMode/);
 assert.match(app,/showGeneratedGeometry\(shot\.id,false,\{editMode:true\}\)/);
 assert.match(world,/node\.castShadow=spec\.type!=='point'/);
 assert.match(world,/mesh\.receiveShadow=true/);
 assert.match(assets,/id\.startsWith\('spot'\)\?240:180/);
});
