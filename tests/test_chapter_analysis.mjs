import test from 'node:test';
import assert from 'node:assert/strict';
import {frameSignature,createDraftTimeline} from '../shot-analysis.js';
import {detectVisualChapters} from '../chapter-analysis.js';

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
