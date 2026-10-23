import test from 'node:test';
import assert from 'node:assert/strict';
import {GENERATION_SOUND_PATHS,createGenerationSounds} from '../generation-sounds.js';
import {airyParticleOffset} from '../ai-generation-overlay.js';

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
