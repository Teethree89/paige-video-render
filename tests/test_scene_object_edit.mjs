import test from 'node:test';
import assert from 'node:assert/strict';
import {makePrimitive} from '../primitive-schema.js';
import {editPrimitiveTransform,deletePrimitiveObject} from '../scene-object-operations.js';

const original=()=>{
  const base=makePrimitive('box','base'),row=makePrimitive('box','windows');
  row.position=[8,4,2];row.rotation=[0,.4,0];
  row.repeat={count:[5,2,1],spacing:[1,2,0]};
  row.material.emissive='#ffcc77';row.material.emissiveIntensity=1;
  const camera={position:[0,8,40],target:[0,3,0],fov:55};
  const lights=[{type:'point',name:'point light 1',color:'#ffffff',intensity:10,position:[0,8,0],distance:0}];
  return {schemaVersion:1,scenes:[
    {shotId:'exterior',objects:[base,row],camera,lights},
    {shotId:'second',objects:[makePrimitive('cylinder','cyl')]}
  ]};
};
test('saved primitive drag applies shot-local XYZ, keeping repeated parts and all camera/lighting',()=>{
  const input=original(),before=structuredClone(input);
  const moved=editPrimitiveTransform(input,['exterior','second'],'exterior','windows','translate',[4.5,6,-12.25]);
  assert.deepEqual(input,before,'do not mutate input before validation and save');
  const [building,row]=moved.scenes[0].objects;
  assert.deepEqual(building,before.scenes[0].objects[0]);
  assert.deepEqual(row.position,[4.5,6,-12.25]);
  assert.deepEqual(row.rotation,[0,.4,0]);
  assert.deepEqual(row.repeat,{count:[5,2,1],spacing:[1,2,0]});
  assert.equal(row.material.emissive,'#ffcc77');
  assert.deepEqual(moved.scenes[0].camera,before.scenes[0].camera);
  assert.deepEqual(moved.scenes[0].lights,before.scenes[0].lights);
  assert.deepEqual(moved.scenes[1],before.scenes[1]);
});
test('rotation edits preserve position and use radians, not degrees',()=>{
  const input=original();
  const rotated=editPrimitiveTransform(input,['exterior','second'],'exterior','base','rotate',[0,Math.PI/2,0]);
  assert.deepEqual(rotated.scenes[0].objects[0].rotation,[0,Math.PI/2,0]);
  assert.deepEqual(rotated.scenes[0].objects[0].position,[0,1,0]);
});
test('delete removes only the named object of the selected shot',()=>{
  const input=original(),after=deletePrimitiveObject(input,['exterior','second'],'exterior','base');
  assert.deepEqual(after.scenes[0].objects.map(o=>o.id),['windows']);
  assert.deepEqual(after.scenes[1],input.scenes[1]);
  assert.equal(input.scenes[0].objects.length,2);
  assert.deepEqual(after.scenes[0].lights,input.scenes[0].lights);
});
test('invalid edits and cross-shot IDs are blocked by primitive schema',()=>{
  const source=original();
  for(const v of [[NaN,0,0],[Infinity,0,0],['0',0,0],[0,0],[0,0,10001]]){
    assert.throws(()=>editPrimitiveTransform(source,['exterior','second'],'exterior','base','translate',v));
  }
  assert.throws(()=>editPrimitiveTransform(source,['exterior','second'],'exterior','cyl','translate',[0,0,0]));
  assert.throws(()=>editPrimitiveTransform(source,['exterior','second'],'exterior','base','scale',[1,1,1]));
  assert.throws(()=>deletePrimitiveObject(source,['exterior','second'],'exterior','cyl'));
});
