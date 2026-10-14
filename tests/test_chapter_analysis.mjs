import test from 'node:test';
import assert from 'node:assert/strict';
import {frameSignature,createDraftTimeline} from '../shot-analysis.js';
import {detectVisualChapters, recoverTailChapter} from '../chapter-analysis.js';

function signature(r,g,b){
  const width=24,height=14,data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<data.length;i+=4){data[i]=r;data[i+1]=g;data[i+2]=b;data[i+3]=255;}
  return frameSignature({width,height,data});
}
function syntheticTimeline(){
  const colors=[signature(240,20,15),signature(20,40,240),signature(15,230,30)];
  return Array.from({length:72},(_,i)=>({
    at:+(.04+i*.5).toFixed(3),signature:colors[i<24?0:i<48?1:2]
  }));
}
test('long-window scene changes detect two obvious subject changes',()=>{
  const cuts=detectVisualChapters(syntheticTimeline(),{minShotDuration:2,windowSeconds:1.5});
  assert.equal(cuts.length,2);
  assert.ok(Math.abs(cuts[0].at-12)<1.5);
  assert.ok(Math.abs(cuts[1].at-24)<1.5);
  assert.ok(cuts.every(c=>c.method==='visual-chapter'&&c.automatic===true));
});
test('stable shot with no visual change produces no chapters',()=>{
  const same=signature(60,60,60);
  const frames=Array.from({length:50},(_,i)=>({at:.04+i*.5,signature:same}));
  assert.deepEqual(detectVisualChapters(frames),[]);
});
test('short and invalid inputs do not produce guesses',()=>{
  assert.deepEqual(detectVisualChapters([]),[]);
  assert.deepEqual(detectVisualChapters(syntheticTimeline().slice(0,3)),[]);
});
test('chapter suggestions retain a valid editable timeline schema',()=>{
  const samples=syntheticTimeline();
  const cuts=detectVisualChapters(samples,{minShotDuration:2});
  const seq=createDraftTimeline({duration:36,cuts,title:'Synthetic video'});
  assert.equal(seq.shots.length,cuts.length+1);
  assert.equal(seq.shots.at(-1).end,36);
  assert.ok(seq.camera.every(c=>c.generated==='placeholder'));
});

test('late sustained scene change receives an ending chapter even with a full chapter budget',()=>{
  const palette=[
    signature(230,40,20),signature(20,20,240),
    signature(30,235,20),signature(230,45,170),
    signature(95,115,170)
  ];
  const samples=Array.from({length:113},(_,i)=>({
    at:+(.04+i*.5).toFixed(3),
    signature:palette[i<24?0:i<48?1:i<72?2:i<96?3:4]
  }));
  const cuts=detectVisualChapters(samples,{maxChapters:4,minShotDuration:1.5});
  assert.equal(cuts.length,3);
  assert.ok(cuts.some(c=>c.at>46&&c.at<50),
    'Expected a chapter boundary for a sustained, visibly different ending');
  assert.ok(cuts.every((c,i)=>i===0||c.at-cuts[i-1].at>=1.5));
});

test('an isolated late flash must not be invented into a closing scene',()=>{
  const a=signature(30,30,35),flash=signature(255,255,255);
  const samples=Array.from({length:113},(_,i)=>({
    at:+(.04+i*.5).toFixed(3),
    signature:i===96?flash:a
  }));
  assert.deepEqual(recoverTailChapter(samples,[],{maxChapters:4}),[]);
});
