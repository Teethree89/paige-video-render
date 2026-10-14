import test from 'node:test';
import assert from 'node:assert/strict';
import {frameSignature,changeScore,detectShotCuts,normalizeCuts,createDraftTimeline} from '../shot-analysis.js';

function solidFrame(r,g,b) {
  const width=24,height=14,data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<data.length;i+=4){data[i]=r;data[i+1]=g;data[i+2]=b;data[i+3]=255;}
  return frameSignature({width,height,data});
}

test('frame signatures and change score are deterministic and bounded',()=>{
  const red=solidFrame(255,0,0),blue=solidFrame(0,0,255),same=solidFrame(255,0,0);
  assert.equal(changeScore(red,same),0);
  assert.ok(changeScore(red,blue)>0.4);
  assert.ok(changeScore(red,blue)<=1);
  assert.ok(Math.abs(red.histogram.reduce((a,b)=>a+b,0)-1)<1e-9);
});
test('cut detector finds abrupt color changes and respects shot length',()=>{
  const a=solidFrame(255,0,0),b=solidFrame(0,0,255),c=solidFrame(0,255,0);
  const samples=[0.1,.6,1.1,1.6,2.1,2.6,3.1,3.6,4.1,4.6,5.1,5.6,6.1,6.6].map((at,i)=>({
    at,signature:i<4?a:i<9?b:c
  }));
  const cuts=detectShotCuts(samples,{threshold:.2,minShotDuration:1.0});
  assert.deepEqual(cuts.map(x=>x.at),[2.1,4.6]);
  assert.equal(detectShotCuts(samples,{threshold:1.01}).length,0);
});
test('timeline builds editable shot spans and flagged placeholder camera keys',()=>{
  const cuts=normalizeCuts([1.25,1.26,4.2],7);
  assert.deepEqual(cuts.map(x=>x.at),[1.25,4.2]);
  const seq=createDraftTimeline({duration:7,fps:30,cuts,title:'My reference'});
  assert.equal(seq.shots.length,3);
  assert.equal(seq.shots[0].start,0);
  assert.equal(seq.shots.at(-1).end,7);
  assert.equal(seq.shots[1].id,'draft_002');
  assert.equal(seq.shots[1].draft,true);
  assert.equal(seq.text.length,0);
  assert.equal(seq.camera.filter(x=>x.cut).length,2);
  assert.ok(seq.camera.every(x=>x.generated==='placeholder'));
  assert.ok(seq.camera.every(x=>x.at>=0&&x.at<=seq.duration));
  assert.equal(seq.videoIntake.mode,'cut-detection-only');
});
test('invalid or vanishing videos are rejected',()=>{
  assert.throws(()=>createDraftTimeline({duration:0}),/duration/);
  assert.deepEqual(normalizeCuts([-1,10,4],6).map(x=>x.at),[4]);
});
