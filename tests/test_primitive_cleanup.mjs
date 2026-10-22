import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanupPrimitiveDocument,cleanupSummary} from '../primitive-cleanup.js';

const obj=(id,primitive,position,scale,rotation=[0,0,0],material={color:'#557799',metalness:0,roughness:.6})=>
  ({id,name:id,primitive,position,scale,rotation,material});
const documentFor=(...objects)=>({schemaVersion:1,scenes:[{shotId:'shot_a',objects}]});
const clean=(...objects)=>cleanupPrimitiveDocument(documentFor(...objects),['shot_a']);

test('cleanup removes only exact geometric/material duplicates and preserves original inputs',()=>{
  const a=obj('ground_a','box',[0,-.2,0],[20,.4,20]);
  const b={...structuredClone(a),id:'ground_b',name:'duplicate floor with new name'};
  const diffColor=obj('ground_other','box',[0,-.2,0],[20,.4,20],[0,0,0],
    {color:'#000000',metalness:0,roughness:.6});
  const original=documentFor(a,b,diffColor);
  const {document,report}=cleanupPrimitiveDocument(original,['shot_a']);
  assert.equal(report.removedDuplicates,1);
  assert.deepEqual(document.scenes[0].objects.map(x=>x.id),['ground_a','ground_other']);
  assert.equal(original.scenes[0].objects.length,3,'no mutation of original payload');
  assert.match(cleanupSummary(report),/1 duplicates removed/);
});

test('overlapping walkway plane lifts above box ground face exactly once',()=>{
  const ground=obj('ground','box',[0,-.2,0],[20,.4,20]);
  const path=obj('path','plane',[0,0,1],[6,8,1],[-Math.PI/2,0,0]);
  const first=clean(ground,path);
  assert.equal(first.report.nudgedOverlaps,1);
  const pathOne=first.document.scenes[0].objects.find(o=>o.id==='path');
  assert.ok(pathOne.position[1]>.012&&pathOne.position[1]<.03);
  const second=cleanupPrimitiveDocument(first.document,['shot_a']);
  assert.equal(second.report.nudgedOverlaps,0,'repeat must be idempotent');
  assert.deepEqual(second.document,first.document);
});

test('thin glowing facade strip lifts off building face and retains material/id',()=>{
  const wall=obj('wall','box',[0,2,0],[10,4,1]);
  const strip=obj('glow_strip','box',[0,2,.5],[7,.07,.07]);
  const {document,report}=clean(wall,strip);
  const moved=document.scenes[0].objects.find(o=>o.id==='glow_strip');
  assert.equal(report.nudgedOverlaps,1);
  assert.ok(moved.position[2]>.53&&moved.position[2]<.62);
  assert.equal(moved.material.color,'#557799');
  assert.equal(cleanupPrimitiveDocument(document,['shot_a']).report.nudgedOverlaps,0);
});

test('coplanar smaller plane lifts off a larger plane, angled surfaces unaffected',()=>{
  const base=obj('base','plane',[0,0,0],[20,20,1],[-Math.PI/2,0,0]);
  const overlay=obj('overlay','plane',[3,0,2],[4,4,1],[-Math.PI/2,0,0]);
  const tilted=obj('tilted','plane',[0,0,1],[2,2,1],[-Math.PI/3,0,0]);
  const {document,report}=clean(base,overlay,tilted);
  assert.equal(report.nudgedOverlaps,1);
  assert.ok(document.scenes[0].objects.find(o=>o.id==='overlay').position[1]>.01);
  assert.deepEqual(document.scenes[0].objects.find(o=>o.id==='tilted').position,[0,0,1]);
});

test('non-coplanar, structural, rotated, or non-planar objects are left alone',()=>{
  const wall=obj('wall','box',[0,2,0],[12,4,1]);
  const remote=obj('remote','box',[0,2,2],[7,.07,.07]);
  const sphere=obj('sphere','sphere',[0,2,.5],[2,2,2]);
  const slanted=obj('slanted','plane',[0,2,.5],[5,2,1],[0,.35,0]);
  const before=documentFor(wall,remote,sphere,slanted);
  const {document,report}=cleanupPrimitiveDocument(before,['shot_a']);
  assert.equal(report.nudgedOverlaps,0);
  assert.deepEqual(document,before);
});

test('cleanup cannot move geometry across shots or break validator',()=>{
  const a=obj('a','box',[0,-.2,0],[10,.4,10]);
  const p=obj('p','plane',[0,0,0],[4,4,1],[-Math.PI/2,0,0]);
  const other=obj('other','box',[0,1,0],[2,2,2]);
  const value={schemaVersion:1,scenes:[
    {shotId:'shot_a',objects:[a,p]},
    {shotId:'shot_b',objects:[other]}
  ]};
  const {document,report}=cleanupPrimitiveDocument(value,['shot_a','shot_b']);
  assert.equal(report.nudgedOverlaps,1);
  assert.deepEqual(document.scenes[1].objects,[other]);
  assert.throws(()=>cleanupPrimitiveDocument(value,['shot_b']),/unknown shotId/);
});
