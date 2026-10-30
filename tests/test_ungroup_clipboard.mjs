import test from 'node:test';
import assert from 'node:assert/strict';
import {makePrimitive} from '../primitive-schema.js';
import {groupSceneSelection} from '../scene-group-selection.js';
import {ungroupSceneSelection,copySceneSelection,pasteSceneClipboard} from '../scene-ungroup-clipboard.js';

const shots=['a','b'];
const doc=()=>{
 const left=makePrimitive('box','left',[-2,1,0]),right=makePrimitive('sphere','right',[2,3,0]);
 const beam={id:'light_1',name:'Spot',type:'spot',position:[4,6,0],target:[4,0,0],
   color:'#ffffff',intensity:100,distance:20,angle:.6};
 return {schemaVersion:1,scenes:[{shotId:'a',objects:[left,right],lights:[beam]},
   {shotId:'b',objects:[makePrimitive('cylinder','right',[0,0,0])]}]};
};
test('ungroup restores original world poses of group parts and lights',()=>{
 const input=doc(),grouped=groupSceneSelection(input,shots,'a',['left','right','light::light_1']);
 const snap=structuredClone(grouped.document);
 const out=ungroupSceneSelection(grouped.document,shots,'a',[grouped.selectedId]);
 assert.deepEqual(grouped.document,snap);
 const c=out.document.scenes[0];
 assert.deepEqual(c.objects.map(o=>o.id).sort(),['left','right']);
 assert.ok(c.objects.find(o=>o.id==='left').position.every((n,i)=>Math.abs(n-[-2,1,0][i])<1e-9));
 assert.ok(c.lights[0].target.every((n,i)=>Math.abs(n-[4,0,0][i])<1e-9));
 assert.equal(out.selectedIds.length,3);
});
test('ungroup applies group move/rotation and rejects non-groups',()=>{
 const g=groupSceneSelection(doc(),shots,'a',['left','right']).document;
 const grp=g.scenes[0].objects.find(o=>o.primitive==='group');
 grp.position=[10,0,0];grp.rotation=[0,Math.PI/2,0];
 const out=ungroupSceneSelection(g,shots,'a',[grp.id]).document.scenes[0];
 const left=out.objects.find(o=>o.id==='left');
 assert.ok(Math.abs(left.position[0]-10)<1e-6);
 assert.throws(()=>ungroupSceneSelection(doc(),shots,'a',['left']),/ungroup/i);
});
test('copy then paste into another chapter keeps poses and makes unique ids',()=>{
 const input=doc(),snap=structuredClone(input);
 const clip=copySceneSelection(input,shots,'a',['right','light::light_1']);
 const out=pasteSceneClipboard(input,shots,'b',clip);
 assert.deepEqual(input,snap);
 const b=out.document.scenes[1];
 assert.deepEqual(b.objects.map(o=>o.id),['right','right_2']);
 assert.deepEqual(b.objects[1].position,[2,3,0]);
 assert.equal(b.lights[0].id,'light_1');
 assert.deepEqual(out.selectedIds,['right_2','light::light_1']);
 clip.objects[0].position[0]=99;
 assert.equal(b.objects[1].position[0],2,'clipboard is independent');
});
test('same-chapter paste is nudged and repeatable',()=>{
 const clip=copySceneSelection(doc(),shots,'a',['left']);
 const one=pasteSceneClipboard(doc(),shots,'a',clip);
 const two=pasteSceneClipboard(one.document,shots,'a',clip);
 assert.deepEqual(one.document.scenes[0].objects.at(-1).position,[-.5,1,0]);
 assert.equal(new Set(two.document.scenes[0].objects.map(o=>o.id)).size,4);
 assert.throws(()=>pasteSceneClipboard(doc(),shots,'a',null),/nothing copied/i);
});
