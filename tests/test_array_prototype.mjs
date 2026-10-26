import test from 'node:test';
import assert from 'node:assert/strict';
import {makePrimitive,validatePrimitiveDocument} from '../primitive-schema.js';
import {findMatchingArrays,saveArrayPrototype} from '../array-prototype.js';
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
