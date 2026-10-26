import test from 'node:test';
import assert from 'node:assert/strict';
import {GENERATION_SOUND_PATHS,createGenerationSounds} from '../generation-sounds.js';
import {airyParticleOffset,createArgonOverlay} from '../ai-generation-overlay.js';

test('PAIGE particles float slowly without drifting out of readable letter positions',()=>{
  const seed=37,letter=2;
  const a=airyParticleOffset(0,seed,letter);
  const b=airyParticleOffset(2000,seed,letter);
  const c=airyParticleOffset(10000,seed,letter);
  assert.notDeepEqual(a,b);
  assert.notDeepEqual(b,c);
  for(const sample of [a,b,c]){
    assert.ok(Math.abs(sample.x)<=4.1);
    assert.ok(Math.abs(sample.y)<=4.3);
    assert.ok(Math.abs(sample.z)<=7.6);
  }
  assert.deepEqual(airyParticleOffset(7500,seed,letter,true),{x:0,y:0,z:0});
  assert.deepEqual(airyParticleOffset(7500,seed,letter),airyParticleOffset(7500,seed,letter),
    'no random jitter between animation frames');
});

test('user gesture arms and decodes exactly the two checked-in MP3 cues before async work',async()=>{
  const requests=[],played=[],resumes=[];
  let instance;
  class MockAudioContext {
    constructor(){instance=this;this.state='suspended';this.destination={};}
    resume(){resumes.push('resume');this.state='running';return Promise.resolve();}
    decodeAudioData(bytes){return Promise.resolve({length:bytes.byteLength});}
    createBufferSource(){
      const source={buffer:null,connect:()=>{},start:()=>played.push(source.buffer)};
      return source;
    }
  }
  const sound=createGenerationSounds({
    AudioContextClass:MockAudioContext,
    fetchSound:async(uri,options)=>{
      requests.push({uri,options});
      return {ok:true,arrayBuffer:async()=>new Uint8Array([1,2,3,4]).buffer};
    },
    AudioClass:null
  });
  sound.arm();
  assert.equal(resumes.length,1,'resume must run in the user gesture, not at completion');
  assert.equal(await sound.play('success'),true);
  assert.equal(await sound.play('failed'),true);
  assert.deepEqual(requests.map(x=>x.uri).sort(),
    [GENERATION_SOUND_PATHS.failed,GENERATION_SOUND_PATHS.success].sort());
  assert.equal(requests.every(x=>x.options.credentials==='same-origin'),true);
  assert.equal(played.length,2);
  assert.equal(played[0].length,4);
  assert.equal(instance.state,'running');
  sound.arm();
  assert.equal(await sound.play('unknown'),false);
  assert.equal(requests.length,2,'do not fetch more than once during each session');
});

test('missing, blocked or unsupported completion audio never rejects or fails a generation',async()=>{
  const missing=createGenerationSounds({
    AudioContextClass:class{resume(){return Promise.reject(Error('blocked'));}
      decodeAudioData(){return Promise.reject(Error('bad file'));}createBufferSource(){throw Error('bad audio');}},
    fetchSound:async()=>({ok:false}),
    AudioClass:null
  });
  assert.doesNotThrow(()=>missing.arm());
  assert.equal(await missing.play('success'),false);
  assert.equal(await missing.play('failed'),false);
  const plays=[];
  const fallback=createGenerationSounds({AudioContextClass:null,
    AudioClass:class {
      constructor(src){this.src=src;}
      async play(){plays.push(this.src);}
    },fetchSound:null});
  fallback.arm();
  assert.equal(await fallback.play('failed'),true);
  assert.deepEqual(plays,[GENERATION_SOUND_PATHS.failed]);
  const blocked=createGenerationSounds({AudioContextClass:null,
    AudioClass:class{play(){return Promise.reject(Error('autoplay blocked'));}},
    fetchSound:null});
  blocked.arm();
  assert.equal(await blocked.play('success'),false);
});


test('minimized Argon UI remains a live viewport PiP and can expand without restarting work',async()=>{
 const {readFile}=await import('node:fs/promises');
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 const css=await readFile(new URL('../styles.css',import.meta.url),'utf8');
 const viewport=html.indexOf('<section class="viewport" id="viewport">');
 const transport=html.indexOf('<section class="transport">',viewport);
 const pip=html.indexOf('id="argonParticleReopen"',viewport);
 assert.ok(viewport>=0&&pip>viewport&&pip<transport,'mini-panel belongs to the viewport');
 for(const id of ['argonMiniStage','argonMiniDetail','argonMiniElapsed'])
   assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(css,/\.argon-particle-reopen\{position:absolute/);
 const ids=['argonParticleOverlay','argonParticleCanvas','argonParticleStage',
   'argonParticleDetail','argonParticleElapsed','argonParticleMeter',
   'argonParticleMinimize','argonParticleReopen','argonMiniStage',
   'argonMiniDetail','argonMiniElapsed'];
 const nodes=Object.fromEntries(ids.map(id=>[id,{
   id,hidden:id==='argonParticleOverlay'||id==='argonParticleReopen',
   style:{},textContent:'',listeners:{},attrs:{},
   addEventListener(type,fn){this.listeners[type]=fn;},
   setAttribute(name,value){this.attrs[name]=value;},
   click(){this.listeners.click?.();}
 }]));
 const ctx={
   setTransform(){},fillText(){},
   getImageData(){return {data:new Uint8ClampedArray(820*200*4)};}
 };
 nodes.argonParticleCanvas.getContext=()=>ctx;
 const root={
   getElementById:id=>nodes[id]||null,
   createElement:name=>name==='canvas'?{getContext:()=>ctx}:null
 };
 const keys=['requestAnimationFrame','cancelAnimationFrame','setInterval','clearInterval'];
 const descriptors=Object.fromEntries(keys.map(key=>[key,
   Object.getOwnPropertyDescriptor(globalThis,key)]));
 let nextTick=null,cleared=0,cancelled=0;
 try{
   Object.defineProperties(globalThis,{
     requestAnimationFrame:{value:()=>17,configurable:true,writable:true},
     cancelAnimationFrame:{value:()=>{cancelled++;},configurable:true,writable:true},
     setInterval:{value:callback=>{nextTick=callback;return 19;},configurable:true,writable:true},
     clearInterval:{value:id=>{assert.equal(id,19);cleared++;},configurable:true,writable:true}
   });
   const overlay=createArgonOverlay(root);
   overlay.show({totalStages:3});
   assert.equal(nodes.argonParticleOverlay.hidden,false);
   assert.equal(nodes.argonParticleReopen.hidden,true);
   nodes.argonParticleMinimize.click();
   assert.equal(nodes.argonParticleOverlay.hidden,true);
   assert.equal(nodes.argonParticleReopen.hidden,false);
   assert.equal(cancelled,1,'expensive canvas animation pauses while minimized');
   overlay.step(2);overlay.phase('geometry');
   assert.match(nodes.argonMiniStage.textContent,/pass 1 of 2/);
   assert.equal(nodes.argonMiniDetail.textContent,'Receiving editable geometry');
   assert.match(nodes.argonParticleReopen.attrs['aria-label'],/step 2 of 3/);
   const before=nodes.argonMiniElapsed.textContent;
   assert.equal(typeof nextTick,'function');
   nextTick();
   assert.equal(nodes.argonMiniElapsed.textContent,nodes.argonParticleElapsed.textContent);
   assert.equal(nodes.argonMiniElapsed.textContent,before.slice(0,4)+' elapsed · finish time unknown');
   nodes.argonParticleReopen.click();
   assert.equal(nodes.argonParticleOverlay.hidden,false);
   assert.equal(nodes.argonParticleReopen.hidden,true);
   overlay.hide();
   assert.equal(nodes.argonParticleOverlay.hidden,true);
   assert.equal(nodes.argonParticleReopen.hidden,true);
   assert.equal(cleared,1,'elapsed timer cleaned up on completion/failure');
 }finally{
   for(const key of keys){
     const descriptor=descriptors[key];
     if(descriptor)Object.defineProperty(globalThis,key,descriptor);
     else delete globalThis[key];
   }
 }
});
