import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaFrameTimes,sampleReferenceMedia} from '../reference-frames.js';

const shot={id:'s1',start:10,end:14};
test('trimmed video samples map from global timeline into source clip range',()=>{
 const source={kind:'video',sourceIn:20,sourceOut:24};
 const frames=mediaFrameTimes(source,shot,11);
 assert.equal(frames.length,3);
 assert.equal(frames[0].at,11);
 assert.equal(frames[0].sourceAt,21);
 assert.ok(frames.every(f=>f.sourceAt>=20&&f.sourceAt<24));
});
test('stills produce the three JPEG reference positions expected by PHP',()=>{
 const positions=mediaFrameTimes({kind:'image'},shot,12);
 assert.equal(positions.length,3);
 assert.ok(positions.every(point=>point.sourceAt===0));
 assert.throws(()=>mediaFrameTimes(null,shot,12),/Relink/);
});
test('single still frame uses three identical local JPEG samples without a network request',async()=>{
 const before=globalThis.document;
 let renders=0,requests=0;
 const origFetch=globalThis.fetch;
 globalThis.fetch=()=>{requests++;throw Error('No network expected');};
 class FakeImage {
  constructor(){this.naturalWidth=800;this.naturalHeight=450;this.listeners={};}
  addEventListener(name,fn){this.listeners[name]=fn;}
  removeEventListener(name){delete this.listeners[name];}
  set src(value){this.source=value;queueMicrotask(()=>this.listeners.load?.());}
  removeAttribute(){}
 }
 const canvas={width:0,height:0,getContext:()=>({
  fillRect(){},drawImage(){renders++;},set fillStyle(_v){}
 }),toDataURL:()=> 'data:image/jpeg;base64,'+'a'.repeat(200)};
 globalThis.document={createElement:tag=>tag==='img'?new FakeImage():canvas};
 try{
  const frames=await sampleReferenceMedia({url:'blob:local',kind:'image',fit:'contain'},shot,12,'primary');
  assert.equal(frames.length,3);
  assert.equal(renders,3);
  assert.equal(requests,0);
  assert.ok(frames.every(f=>f.imageDataUrl===frames[0].imageDataUrl));
 }finally{globalThis.document=before;globalThis.fetch=origFetch;}
});
