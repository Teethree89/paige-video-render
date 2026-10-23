import test from 'node:test';
import assert from 'node:assert/strict';
import {argonDetailIndex,appendArgonDetail} from '../argon-detail.js';
const make=(id,x=0,repeat)=>({id,name:id,layer:'structures',primitive:'box',
  position:[x,1,0],rotation:[0,0,0],scale:[2,2,2],
  material:{color:'#445566',metalness:0,roughness:.7},...(repeat?{repeat}:{})});
const document=(objects,extras={})=>({schemaVersion:1,scenes:[{shotId:'shot_a',objects,...extras}]});
test('detail spatial index is bounded and contains data only',()=>{
  const base=document([make('building',0)]);
  assert.deepEqual(argonDetailIndex(base),[{id:'building',name:'building',
    layer:'structures',primitive:'box',position:[0,1,0],scale:[2,2,2]}]);
  assert.deepEqual(argonDetailIndex(document([])),[]);
  assert.deepEqual(argonDetailIndex(document(Array.from({length:240},(_,i)=>make('o'+i,i*3)))),[]);
});
test('two additive passes preserve every original object, light and camera',()=>{
  const camera={position:[0,3,18],target:[0,2,0],fov:42};
  const lights=[{type:'point',name:'Fixture',color:'#ffffff',intensity:10,
    position:[0,3,0],distance:20}];
  const base=document([make('base',0)],{camera,lights});
  const first=appendArgonDetail(base,document([make('detail1_trim',4)]),'shot_a');
  assert.equal(first.added,1);
  const second=appendArgonDetail(first.document,document([make('detail2_bollard',8)]),'shot_a');
  assert.deepEqual(second.document.scenes[0].objects.map(x=>x.id),['base','detail1_trim','detail2_bollard']);
  assert.deepEqual(second.document.scenes[0].camera,camera);
  assert.deepEqual(second.document.scenes[0].lights,lights);
});
test('detail merger skips duplicate IDs, identical geometry and exhausted copies',()=>{
  const base=document([make('original',0, {count:[400,1,1],spacing:[1,0,0]})]);
  const result=appendArgonDetail(base,document([
    make('original',10),make('different_id',0,{count:[400,1,1],spacing:[1,0,0]}),
    make('new',4)
  ]),'shot_a');
  assert.equal(result.added,1);
  assert.deepEqual(result.document.scenes[0].objects.map(o=>o.id),['original','new']);
  const repeated={count:[400,1,1],spacing:[1,0,0]};
  const nearlyFull=document(Array.from({length:5},(_,i)=>make('row'+i,i*8,repeated)));
  const overflow=appendArgonDetail(nearlyFull,document([make('overflow',60)]),'shot_a');
  assert.equal(overflow.added,0);assert.equal(overflow.rendered,2000);
});
test('detail merger never replaces another shot',()=>{
  assert.throws(()=>appendArgonDetail(document([make('base')]),
    {schemaVersion:1,scenes:[{shotId:'wrong',objects:[make('x')]}]},'shot_a'));
});
