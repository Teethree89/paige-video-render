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


test('new editor lights visibly illuminate shot geometry, with non-cube edit-only handles',async()=>{
 const THREE=await import('three');
 const {createPrimitiveWorld}=await import('../primitive-world.js');
 let doc=insertCreatedAsset(empty(),'a','primitives','box',[0,0,0]).document;
 doc=insertCreatedAsset(doc,'a','lights','point-red',[0,0,0]).document;
 doc=insertCreatedAsset(doc,'a','lights','spot-cool',[0,0,0]).document;
 const scene=new THREE.Scene(),world=createPrimitiveWorld(scene);
 try{
   world.setDocument(doc,['a','b']);
   world.showShot('a');
   const exported=world.getSceneForExport('a');
   const point=[],spot=[],meshes=[];
   exported.traverse(node=>{
     if(node.isPointLight)point.push(node);
     if(node.isSpotLight)spot.push(node);
     if(node.isMesh)meshes.push(node);
     assert.equal(node.userData.primitiveLightId,undefined,'no editor gizmos in GLB');
   });
   assert.equal(point.length,1);
   assert.equal(spot.length,1);
   assert.equal(point[0].intensity,180,'point illumination must compete with global fill');
   assert.equal(spot[0].intensity,240,'spot illumination must compete with global fill');
   assert.equal(spot[0].castShadow,true);
   assert.equal(spot[0].shadow.mapSize.x,512);
   assert.equal(point[0].castShadow,false,'avoid six shadow passes per point light');
   assert.ok(meshes.length>0);
   assert.ok(meshes.every(mesh=>mesh.isMesh&&mesh.castShadow&&mesh.receiveShadow));
   const lightId=doc.scenes[0].lights[0].id;
   const marker=world.getLightMarker('a',lightId);
   assert.ok(marker.isMesh);
   assert.equal(marker.geometry.type,'SphereGeometry','bulb gizmo, not a cube or octahedron');
   assert.ok(marker.children.some(child=>child.isLineSegments),'light-ray icon spokes');
   assert.equal(marker.visible,true,'hidden parent controls edit-only visibility');
   assert.equal(marker.parent.visible,false);
   world.setLightMarkersVisible(true);
   assert.equal(marker.parent.visible,true);
   world.showShot('b');
   assert.equal(marker.parent.visible,false,'lights and their gizmos are shot-scoped');
   world.showShot('a');
   assert.equal(marker.parent.visible,true);
   const saved=world.getDocument();
   assert.equal(saved.scenes[0].objects.length,doc.scenes[0].objects.length);
   assert.equal(saved.scenes[0].lights[0].intensity,180);
 }finally{world.dispose();}
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
