import test from 'node:test';
import assert from 'node:assert/strict';
import {clipKeyForShot,shotsForClip,snapshotChapter,restoreIteration,clipMappingStatus,createClipHistoryStore,MAX_ITERATIONS_PER_CLIP} from '../clip-history.js';
import {createDraftTimeline} from '../shot-analysis.js';
import {buildReferenceTimeline} from '../reference-sequence.js';
import {fakeIndexedDB} from './fake-indexeddb.mjs';

const video=()=>{const seq=createDraftTimeline({duration:8,cuts:[4],title:'clip'});seq.videoIntake.sourceId='src-1';return seq;};
const box=(id,x=0)=>({id,name:'Block '+id,primitive:'box',position:[x,1,0],rotation:[0,0,0],scale:[2,2,2],material:{color:'#8899aa',metalness:.1,roughness:.7}});
const withScene=(seq,shotId,objects)=>{seq.primitiveScenes={schemaVersion:1,scenes:[...(seq.primitiveScenes?.scenes||[]).filter(s=>s.shotId!==shotId),{shotId,objects}]};return seq;};
const tracked=(seq,shot)=>{seq.camera=seq.camera.filter(k=>!(k.at>=shot.start&&k.at<shot.end));
 seq.camera.push({id:'t0',at:shot.start,p:[0,4,20],t:[0,1,0],fov:50,cut:shot.start>0,generated:'video-track'},{id:'t1',at:shot.end-.04,p:[0,4,12],t:[0,1,0],fov:50,generated:'video-track'});
 seq.camera.sort((a,b)=>a.at-b.at);return seq;};

test('chapters map to their source clip',()=>{
 const seq=video();
 assert.equal(clipKeyForShot(seq,'draft_001'),'video:src-1');
 assert.deepEqual(shotsForClip(seq,'video:src-1'),['draft_001','draft_002']);
 const ref=buildReferenceTimeline([{id:'r1',mediaId:'m1',kind:'video',name:'A',duration:2,sourceIn:0,sourceOut:2},
   {id:'r2',mediaId:'m2',kind:'image',name:'B',duration:2},{id:'r3',mediaId:'m1',kind:'video',name:'A2',duration:2,sourceIn:2,sourceOut:4}]);
 assert.deepEqual(shotsForClip(ref,'reference:m1'),['r1','r3']);
 assert.equal(clipKeyForShot(ref,'r2'),'reference:m2');
 assert.equal(clipKeyForShot({shots:[{id:'x'}]},'x'),null,'original timelines have no source clip');
});

test('a snapshot restores geometry and camera into its chapter only',()=>{
 let seq=tracked(withScene(video(),'draft_001',[box('a'),box('b',3)]),{start:0,end:4});
 const v1=snapshotChapter(seq,'draft_001','geometry',{now:1000});
 assert.equal(v1.summary.objects,2);assert.equal(v1.summary.keys,2);assert.equal(v1.summary.camera,'tracked');
 const edited=withScene(structuredClone(seq),'draft_001',[box('c')]);
 edited.camera=edited.camera.filter(k=>k.at>=4);
 edited.camera.push({id:'other',at:0,p:[1,1,9],t:[0,0,0],fov:40,cut:false});edited.camera.sort((a,b)=>a.at-b.at);
 const restored=restoreIteration(edited,v1);
 assert.deepEqual(restored.primitiveScenes.scenes.find(s=>s.shotId==='draft_001').objects.map(o=>o.id),['a','b']);
 assert.deepEqual(restored.camera.filter(k=>k.at<4).map(k=>k.generated),['video-track','video-track']);
 assert.deepEqual(restored.camera.filter(k=>k.at>=4),edited.camera.filter(k=>k.at>=4),'other chapters untouched');
 assert.equal(edited.primitiveScenes.scenes[0].objects.length,1,'restore returns a copy');
});

test('restore refuses resized or missing chapters',()=>{
 const seq=withScene(video(),'draft_001',[box('a')]),v=snapshotChapter(seq,'draft_001','geometry');
 const resized=structuredClone(seq);resized.shots[0].end=3.5;resized.shots[1].start=3.5;
 assert.throws(()=>restoreIteration(resized,v),/resized/);
 assert.throws(()=>restoreIteration(createDraftTimeline({duration:8}),{...v,shotId:'nope'}),/not in the current project/);
});

test('mapping status shows 3D and camera icons from the project or saved versions',()=>{
 const seq=tracked(withScene(video(),'draft_001',[box('a')]),{start:0,end:4});
 assert.deepEqual(clipMappingStatus(seq,'video:src-1'),{inProject:true,chapters:2,mapped3d:1,mappedCamera:1,
   has3d:true,hasCamera:true,tracked:true,versions:0});
 const away=clipMappingStatus(createDraftTimeline({duration:4}),'video:src-1',[{kind:'geometry',summary:{objects:5}},{kind:'track',summary:{}}]);
 assert.deepEqual(away,{inProject:false,chapters:0,mapped3d:0,mappedCamera:0,has3d:true,hasCamera:true,tracked:true,versions:2});
 assert.equal(clipMappingStatus(video(),'video:src-1').has3d,false);
});

test('version history keeps the newest versions per clip and prunes deleted clips',async()=>{
 const history=createClipHistoryStore(fakeIndexedDB()),seq=withScene(video(),'draft_001',[box('a')]);
 for(let i=0;i<MAX_ITERATIONS_PER_CLIP+3;i++)await history.add('video:src-1',snapshotChapter(seq,'draft_001','camera',{now:i}));
 const list=await history.list('video:src-1');
 assert.equal(list.length,MAX_ITERATIONS_PER_CLIP);assert.equal(list[0].at,MAX_ITERATIONS_PER_CLIP+2,'newest first');
 await history.add('reference:gone',snapshotChapter(seq,'draft_001','geometry'));
 assert.equal(await history.prune(['video:src-1']),1);
 assert.deepEqual([...(await history.all()).keys()],['video:src-1']);
 await history.remove('video:src-1');assert.deepEqual(await history.list('video:src-1'),[]);
 assert.throws(()=>snapshotChapter(seq,'draft_001','bogus'),/Unknown iteration kind/);
});
