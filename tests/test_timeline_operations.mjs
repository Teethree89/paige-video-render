import test from 'node:test';
import assert from 'node:assert/strict';
import {checkTimeline,copyChapter,pasteChapter,moveChapter,resizeChapter,
  resizeText,moveTimelineKey,deleteChapter,createTimelineHistory} from '../timeline-operations.js';
function fixture(){
 return {title:'Mixed reference',duration:12,fps:30,shots:[
  {id:'a',start:0,end:4,name:'A'},
  {id:'b',start:4,end:9,name:'B'},
  {id:'c',start:9,end:12,name:'C'}],
 camera:[
  {id:'ca',at:0,p:[0,0,1],t:[0,0,0],fov:50,cut:true},
  {id:'cb',at:4,p:[1,0,1],t:[0,0,0],fov:50,cut:true},
  {id:'cc',at:9,p:[2,0,1],t:[0,0,0],fov:50,cut:true},
  {id:'ce',at:12,p:[3,0,1],t:[0,0,0],fov:50}],
 text:[
  {id:'tb',start:5,end:7,value:'B'},
  {id:'tc',start:10,end:11,value:'C'}],
 primitiveScenes:{schemaVersion:1,scenes:[
  {shotId:'b',objects:[{id:'obj1',name:'box',primitive:'box',
   position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],
   material:{color:'#ffffff',metalness:0,roughness:.5}}]}]},
 referenceSequence:{version:1,items:[
  {id:'a',kind:'image',mediaId:'img-a',duration:4,sourceIn:0,sourceOut:0},
  {id:'b',kind:'video',mediaId:'vid-b',duration:5,sourceIn:3,sourceOut:8},
  {id:'c',kind:'image',mediaId:'img-c',duration:3,sourceIn:0,sourceOut:0}
 ]}};
}
test('chapter paste includes independent copied scene, geometry and keys',()=>{
 const source=fixture(),clip=copyChapter(source,'b');
 const next=pasteChapter(source,clip,'b','bcopy');
 assert.deepEqual(next.shots.map(x=>[x.id,x.start,x.end]),
  [['a',0,4],['b',4,9],['bcopy',9,14],['c',14,17]]);
 assert.equal(next.duration,17);
 assert.equal(next.camera.find(x=>x.id==='cc').at,14);
 assert.equal(next.text.find(x=>x.id==='tc').start,15);
 const pasted=next.primitiveScenes.scenes.find(x=>x.shotId==='bcopy');
 assert.notEqual(pasted.objects[0].id,'obj1');
 assert.equal(pasted.objects.length,1);
 assert.equal(next.referenceSequence.items[2].mediaId,'vid-b');
 assert.equal(source.duration,12);
 checkTimeline(next);
});
test('ripple resize maps owned keys, captions and downstream keys',()=>{
 const source=fixture();
 const next=resizeChapter(source,'b',6,{ripple:true,sourceDuration:12});
 assert.equal(next.duration,13);
 assert.equal(next.shots[1].end,10);
 assert.equal(next.shots[2].start,10);
 assert.equal(next.camera.find(x=>x.id==='cc').at,10);
 assert.equal(next.text.find(x=>x.id==='tb').start,5.2);
 assert.equal(next.text.find(x=>x.id==='tc').start,11);
 assert.equal(next.referenceSequence.items[1].sourceOut,9);
 assert.throws(()=>resizeChapter(source,'b',7,{sourceDuration:9}),/enough frames/);
});
test('non-ripple boundary trim keeps total duration and adjusts adjacent clip',()=>{
 const next=resizeChapter(fixture(),'a',5,{ripple:false});
 assert.equal(next.duration,12);
 assert.equal(next.shots[0].end,5);
 assert.equal(next.shots[1].start,5);
 assert.equal(next.referenceSequence.items[1].sourceIn,4);
 assert.equal(next.referenceSequence.items[1].duration,4);
});
test('reordering keeps scene-linked text and geometry by stable ID',()=>{
 const next=moveChapter(fixture(),'b',2);
 assert.deepEqual(next.shots.map(x=>x.id),['a','c','b']);
 assert.equal(next.text.find(x=>x.id==='tb').start,8);
 assert.equal(next.text.find(x=>x.id==='tc').start,5);
 assert.equal(next.referenceSequence.items[2].id,'b');
 assert.equal(next.primitiveScenes.scenes[0].shotId,'b');
});
test('move camera and captions with frame snapping; resize captions',()=>{
 const source=fixture();
 const moved=moveTimelineKey(source,'camera','cb',4.29);
 assert.equal(moved.camera.find(x=>x.id==='cb').at,4.3);
 const text=moveTimelineKey(source,'text','tb',6.31);
 assert.equal(text.text.find(x=>x.id==='tb').start,6.3);
 assert.equal(text.text.find(x=>x.id==='tb').end,8.3);
 assert.equal(resizeText(source,'tb',8).text.find(x=>x.id==='tb').end,8);
});
test('delete chapter shifts subsequent keys, text and reference assets',()=>{
 const next=deleteChapter(fixture(),'b');
 assert.equal(next.duration,7);
 assert.deepEqual(next.shots.map(x=>x.id),['a','c']);
 assert.equal(next.camera.find(x=>x.id==='cc').at,4);
 assert.equal(next.text.find(x=>x.id==='tc').start,5);
 assert.equal(next.primitiveScenes.scenes.length,0);
});
test('history commits, undo/redo and branch invalidation',()=>{
 const base=fixture(),history=createTimelineHistory(base);
 const changed=moveTimelineKey(base,'camera','cb',5);
 history.record(changed);
 assert.equal(history.canUndo,true);
 assert.equal(history.undo().camera.find(x=>x.id==='cb').at,4);
 assert.equal(history.redo().camera.find(x=>x.id==='cb').at,5);
 history.undo();
 history.record(moveTimelineKey(base,'camera','cb',6));
 assert.equal(history.canRedo,false);
});
test('reject crossing chapter captions before destructive rearrangements',()=>{
 const base=fixture();base.text.push({id:'cross',start:3,end:5,value:'Crossing'});
 assert.throws(()=>moveChapter(base,'b',0),/spans chapter boundaries/);
 assert.throws(()=>deleteChapter(base,'b'),/spans chapter boundaries/);
});
