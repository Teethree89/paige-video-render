import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReferenceTimeline,referenceAt,validateReferenceItems} from '../reference-sequence.js';

const items=[
 {id:'factory',mediaId:'clip1',kind:'video',name:'Exterior',fileName:'factory.mp4',
  duration:4,sourceIn:2,sourceOut:6,fit:'cover'},
 {id:'solder',mediaId:'image1',kind:'image',name:'Solder paste',fileName:'paste.png',
  duration:5,fit:'contain'},
 {id:'server',mediaId:'clip2',kind:'video',name:'Server room',fileName:'hall.mp4',
  duration:3,sourceIn:10,sourceOut:13,fit:'cover'}
];
test('video and stills create stable source-linked scenes and placeholder keys',()=>{
 const timeline=buildReferenceTimeline(items,{title:'My reference'});
 assert.equal(timeline.duration,12);
 assert.deepEqual(timeline.shots.map(x=>[x.id,x.start,x.end]),
  [['factory',0,4],['solder',4,9],['server',9,12]]);
 assert.equal(timeline.camera.length,6);
 assert.equal(timeline.title,'My reference');
 assert.deepEqual(timeline.referenceSequence.items.map(x=>x.kind),['video','image','video']);
 assert.equal(timeline.videoIntake,undefined);
 assert.equal(referenceAt(timeline,2).sourceTime,4);
 assert.equal(referenceAt(timeline,6).sourceTime,0);
 assert.equal(referenceAt(timeline,10).sourceTime,11);
 assert.equal(referenceAt(timeline,12).shot.id,'server');
});
test('reject malformed or ambiguous reference sequence data before applying',()=>{
 assert.throws(()=>validateReferenceItems([]),/between 1 and 80/);
 assert.throws(()=>validateReferenceItems([...items,items[0]]),/Duplicate/);
 assert.throws(()=>validateReferenceItems([{...items[0],sourceOut:9}]),/match its duration/);
 assert.throws(()=>validateReferenceItems([{...items[1],duration:.1}]),/duration/);
 assert.deepEqual(validateReferenceItems([items[1]])[0].sourceOut,0);
});
