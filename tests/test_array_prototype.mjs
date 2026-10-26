import test from 'node:test';
import assert from 'node:assert/strict';
import {makePrimitive,validatePrimitiveDocument} from '../primitive-schema.js';
import {findMatchingArrays,findArrayCompanions,saveArrayPrototype} from '../array-prototype.js';
import {insertCreatedAsset} from '../scene-asset-catalog.js';

const row=(id,name,position,rotation=[0,0,0])=>({
 ...makePrimitive('cylinder',id,position),name,
 scale:[.24,6,.24],rotation,
 repeat:{count:[3,1,1],spacing:[8,0,0]}
});
const fixtures=()=>({schemaVersion:1,scenes:[{shotId:'street',objects:[
 row('streetlights_north','Streetlight',[0,3,10]),
 row('streetlights_south','Streetlight',[0,3,-10],[0,Math.PI,0]),
 row('separate_posts','Parking bollard',[0,3,24])
]}]});
const lamp=()=>({id:'lamp_head',name:'Emissive lamp head',primitive:'box',
 position:[0,3,.4],rotation:[0,0,0],scale:[1,.3,.7],
 material:{color:'#f2e9c7',metalness:.1,roughness:.4,
  emissive:'#ffe3b0',emissiveIntensity:3}});
const light=()=>({id:'beam',name:'Streetlight beam',type:'spot',
 position:[0,3,.4],target:[0,-2,.4],color:'#fff5d4',intensity:240,
 distance:35,angle:.6,penumbra:.4});

test('matching streetlight arrays update together while unrelated repeats are untouched',()=>{
 const before=fixtures(),snapshot=structuredClone(before);
 const matches=findMatchingArrays(before,'street','streetlights_north');
 assert.deepEqual(matches,['streetlights_north','streetlights_south']);
 const changed=saveArrayPrototype(before,['street'],'street','streetlights_north',{
   name:'Lit streetlight',scale:[.24,6,.24],
   material:{color:'#526477',metalness:.25,roughness:.65},
   parts:{objects:[lamp()],lights:[light()]}
 });
 assert.deepEqual(before,snapshot,'all changes stay in the draft until Save');
 for(const item of changed.scenes[0].objects.slice(0,2)){
   assert.equal(item.name,'Lit streetlight');
   assert.deepEqual(item.arrayParts.objects,[lamp()]);
   assert.deepEqual(item.arrayParts.lights,[light()]);
   assert.equal(item.repeat.count[0],3);
 }
 assert.deepEqual(changed.scenes[0].objects[1].rotation,[0,Math.PI,0]);
 assert.deepEqual(changed.scenes[0].objects[2],snapshot.scenes[0].objects[2]);
 const stage=insertCreatedAsset(changed,'street','lights','point-blue',[4,7,0]);
 assert.equal(stage.document.scenes[0].lights.length,1,
   'normal top-level lights can coexist with prototype lights');
});

test('prototype save is atomic and refuses invalid nested lights or copy overflow',()=>{
 const before=fixtures(),snapshot=structuredClone(before);
 assert.throws(()=>saveArrayPrototype(before,['street'],'street','streetlights_north',{
   name:'Streetlight',scale:[.24,6,.24],material:before.scenes[0].objects[0].material,
   parts:{objects:[lamp()],lights:[{...light(),target:[0,3,.4]}]}
 }),/distinct target/);
 assert.deepEqual(before,snapshot);
 const many=Array.from({length:20},(_,i)=>({...lamp(),id:'head_'+i}));
 const large=saveArrayPrototype(before,['street'],'street','streetlights_north',{
   name:'Streetlight',scale:[.24,6,.24],material:before.scenes[0].objects[0].material,
   parts:{objects:many,lights:[]}
 });
 assert.equal(large.scenes[0].objects[0].arrayParts.objects.length,20);
 assert.throws(()=>saveArrayPrototype(before,['street'],'street','streetlights_north',{
   name:'Streetlight',scale:[.24,6,.24],material:before.scenes[0].objects[0].material,
   parts:{objects:[{...lamp(),repeat:{count:[2,1,1],spacing:[1,0,0]}}],lights:[]}
 }),/cannot contain nested arrays/);
 assert.equal(findMatchingArrays(before,'street','separate_posts').length,1);
 assert.deepEqual(validatePrimitiveDocument(before),snapshot);
});

test('prototype local component transforms do not replace shot-wide lights or scene cameras',()=>{
 const doc=fixtures();
 const shot=doc.scenes[0];
 shot.lights=[{id:'moon',name:'Moon',type:'directional',
   position:[0,25,0],target:[0,0,0],intensity:1,color:'#ffffff'}];
 shot.camera={position:[0,6,20],target:[0,3,0],fov:42};
 const changed=saveArrayPrototype(doc,['street'],'street','streetlights_north',{
   name:'Streetlight',scale:[.24,6,.24],material:shot.objects[0].material,
   parts:{objects:[],lights:[light()]}
 });
 assert.deepEqual(changed.scenes[0].lights,shot.lights);
 assert.deepEqual(changed.scenes[0].camera,shot.camera);
 assert.equal(changed.scenes[0].objects[0].arrayParts.lights.length,1);
});

const streetAssembly=()=>{
 const stem=(id,z,orientation)=>({...row(id,'Pole',[0,3,z],[0,orientation,0]),
   material:{color:'#384550',metalness:.1,roughness:.8}});
 const bulb=(id,z,orientation)=>({...makePrimitive('sphere',id,[0,7,z]),
   name:'Lantern',scale:[.75,.4,.75],rotation:[0,orientation,0],
   repeat:{count:[3,1,1],spacing:[8,0,0]}});
 return {schemaVersion:1,scenes:[{shotId:'street',objects:[
   stem('north_pole',10,0),bulb('north_lantern',10,0),
   stem('south_pole',-10,Math.PI),bulb('south_lantern',-10,Math.PI),
   {...bulb('bad_spacing',10,0),name:'Unaligned',repeat:{count:[3,1,1],spacing:[7.6,0,0]}},
   {...stem('far_bollard',40,0),name:'Bollard'}
 ]}]};
};
test('companion discovery requires equal repeated geometry locations in both rows',()=>{
 const input=streetAssembly(),snapshot=structuredClone(input);
 const found=findArrayCompanions(input,'street','north_pole');
 assert.equal(found.length,1);
 assert.equal(found[0].id,'north_lantern');
 assert.deepEqual(found[0].ids,['north_lantern','south_lantern']);
 assert.deepEqual(found[0].part.position.map(n=>Math.round(n*100)/100),[0,4,0]);
 assert.equal(found[0].part.primitive,'sphere');
 assert.equal(findArrayCompanions(input,'street','far_bollard').length,0);
 assert.deepEqual(input,snapshot,'discovery has no side effects');
});

test('grouped save folds distinct array definitions into editable parts without changing other rows',()=>{
 const input=streetAssembly(),before=structuredClone(input);
 const grouped=findArrayCompanions(input,'street','north_pole')[0];
 const source=input.scenes[0].objects[0];
 const output=saveArrayPrototype(input,['street'],'street','north_pole',{
   name:'Streetlight assembly',scale:source.scale,material:source.material,
   parts:{objects:[{...grouped.part,id:'lantern_piece'}],lights:[light()]}
 },['north_pole','south_pole'],grouped.ids);
 assert.deepEqual(input,before,'Cancel/undo snapshot remains unchanged');
 const items=output.scenes[0].objects;
 assert.equal(items.length,before.scenes[0].objects.length-2);
 for(const pole of items.slice(0,2)){
   assert.equal(pole.name,'Streetlight assembly');
   assert.equal(pole.arrayParts.objects.length,1);
   assert.equal(pole.arrayParts.objects[0].primitive,'sphere');
   assert.deepEqual(pole.arrayParts.objects[0].position,[0,4,0]);
   assert.equal(pole.arrayParts.lights.length,1);
 }
 assert.deepEqual(items.slice(2),before.scenes[0].objects.slice(4));
 assert.ok(!items.some(x=>grouped.ids.includes(x.id)));
});

test('refuse partial companion absorption and mismatched or unrelated groups',()=>{
 const input=streetAssembly(),source=input.scenes[0].objects[0];
 const draft={name:source.name,scale:source.scale,material:source.material,
   parts:{objects:[],lights:[]}};
 assert.throws(()=>saveArrayPrototype(input,['street'],'street','north_pole',draft,
   ['north_pole','south_pole'],['north_lantern']),/complete spatially aligned/);
 assert.throws(()=>saveArrayPrototype(input,['street'],'street','north_pole',draft,
   ['north_pole','south_pole'],['far_bollard']),/complete spatially aligned/);
 assert.throws(()=>saveArrayPrototype(input,['street'],'street','north_pole',
   {...draft,position:[Infinity,0,0]},['north_pole','south_pole']),/finite XYZ/);
});

test('XYZ and rotation edits move matching array holders by deltas, not absolute placement',()=>{
 const input=streetAssembly(),stem=input.scenes[0].objects[0];
 const modified=saveArrayPrototype(input,['street'],'street','north_pole',{
   name:stem.name,scale:stem.scale,material:stem.material,
   position:[1,4,11],rotation:[0,.3,0],
   parts:{objects:[],lights:[]}
 });
 assert.deepEqual(modified.scenes[0].objects[0].position,[1,4,11]);
 assert.deepEqual(modified.scenes[0].objects[2].position,[1,4,-9]);
 assert.equal(modified.scenes[0].objects[2].rotation[1],Math.PI+.3);
});
