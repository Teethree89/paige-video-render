// Real browser editor module + real Cloudflare Worker with an in-memory Gemini stub.
// This test does not contact 50webs, Cloudflare or the model provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setupAiSceneEditor} from '../ai-scene-editor.js';
import sceneWorker from '../worker/scene-worker.mjs';
import {validatePrimitiveDocument} from '../primitive-schema.js';

class Element {
  constructor() {
    this.handlers=new Map();this.value='';this.hidden=false;this.disabled=false;
    this.checked=true;this.textContent='';
  }
  addEventListener(type,fn){this.handlers.set(type,fn);}
  async fire(type) {
    const fn=this.handlers.get(type);
    assert.ok(fn,'Expected '+type+' listener');
    return fn({target:this});
  }
}
class FakeVideo extends Element {
  constructor() {
    super();this.readyState=1;this.duration=8;
    this.videoWidth=640;this.videoHeight=360;
    this.muted=false;this.preload='';this.playsInline=false;
  }
  set currentTime(seconds) {
    this.seekedAt=seconds;
    queueMicrotask(()=>this.handlers.get('seeked')?.());
  }
  removeAttribute(){}
  load(){}
}

test('three sampled video frames become previewable and accepted without altering another chapter', async()=>{
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch;
  const ids=new Map(),videos=[],sampled=[];
  const fakeDocument={
    getElementById(id) {
      if(!ids.has(id))ids.set(id,new Element());
      return ids.get(id);
    },
    createElement(tag) {
      if(tag==='video'){const video=new FakeVideo();videos.push(video);return video;}
      if(tag==='canvas')return {
        width:0,height:0,
        getContext:()=>({drawImage:()=>{}}),
        toDataURL:()=> 'data:image/jpeg;base64,'+
          Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64')
      };
      return new Element();
    }
  };
  globalThis.document=fakeDocument;
  const untouched={shotId:'shot_b',objects:[{
    id:'old_sphere',name:'Existing object',primitive:'sphere',
    position:[3,2,1],rotation:[0,0,0],scale:[2,2,2],
    material:{color:'#ffbb00',metalness:0,roughness:.8}
  }]};
  const generated={schemaVersion:1,scenes:[{shotId:'shot_a',objects:[{
    id:'gemini_box',name:'Editable blockout',primitive:'box',
    position:[0,1,0],rotation:[0,0,0],scale:[2,2,2],
    material:{color:'#5588bb',metalness:0,roughness:.5}
  }]}]};
  const sequence={duration:20,shots:[
    {id:'shot_a',name:'Chapter A',start:0,end:6},
    {id:'shot_b',name:'Chapter B',start:6,end:12}
  ],camera:[{at:0,pos:[0,1,2]}],primitiveScenes:{schemaVersion:1,scenes:[untouched]}};
  const preservedOriginal=structuredClone(sequence);
  const env={GEMINI_API_KEY:'mock-only-provider-key',SCENE_ACCESS_TOKEN:'mock-only-scene-token-12345678901234567890'};
  let preview=null,generatedCalls=0,acceptedCalls=0,discardCalls=0;
  globalThis.fetch=async (url,opts={})=>{
    if(String(url).includes('generativelanguage.googleapis.com/')){
      const body=JSON.parse(opts.body);
      const frames=body.contents[0].parts.filter(x=>x.inlineData);
      assert.equal(frames.length,3,'Gemini must receive all 3 sampled frames');
      return new Response(JSON.stringify({
        candidates:[{content:{parts:[{text:JSON.stringify(generated)}]}}]
      }),{status:200});
    }
    assert.equal(url,'./scene-proxy.php');
    if(!opts.method)return new Response(JSON.stringify({
      ok:true,authenticated:false,csrf:'temporary-test-csrf'
    }),{status:200});
    assert.equal(opts.credentials,'same-origin');
    assert.equal(opts.headers['X-Paige-Client'],'SceneStudio');
    const payload=JSON.parse(opts.body);
    if(payload.action==='login'){
      assert.equal(payload.passphrase,'mock passphrase 12345');
      return new Response(JSON.stringify({
        ok:true,authenticated:true,csrf:'logged-in-test-csrf'
      }),{status:200});
    }
    assert.equal(payload.action,'generate');
    assert.equal(payload.csrf,'logged-in-test-csrf');
    assert.equal(payload.shotId,'shot_a');
    assert.equal(payload.frames.length,3);
    sampled.push(payload.frames.map(x=>x.at));
    generatedCalls++;
    const result=await sceneWorker.fetch(new Request('https://mock.workers.dev/api/scene',{
      method:'POST',
      headers:{Authorization:'Bearer '+env.SCENE_ACCESS_TOKEN,'Content-Type':'application/json'},
      body:JSON.stringify({shotId:payload.shotId,frames:payload.frames})
    }),env);
    assert.equal(result.status,200);
    return new Response(JSON.stringify({ok:true,proposal:await result.json()}),{status:200});
  };
  try{
    setupAiSceneEditor({
      getSequence:()=>sequence,getActiveShot:()=>sequence.shots[0],
      getReferenceVideo:()=>({src:'blob:synthetic-video'}),
      onPreview:entry=>{preview=entry;},
      onDiscard:()=>{discardCalls++;preview=null;},
      onAccept:entry=>{
        acceptedCalls++;
        const doc=validatePrimitiveDocument(sequence.primitiveScenes,sequence.shots.map(x=>x.id));
        doc.scenes=doc.scenes.filter(x=>x.shotId!==entry.shotId);
        doc.scenes.push(entry);
        sequence.primitiveScenes=validatePrimitiveDocument(doc,sequence.shots.map(x=>x.id));
      }
    });
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(ids.get('aiSceneControls').hidden,true);
    ids.get('aiScenePassphrase').value='mock passphrase 12345';
    await ids.get('aiSceneSignIn').fire('click');
    assert.equal(ids.get('aiSceneControls').hidden,false);
    assert.equal(ids.get('aiScenePassphrase').value,'');
    await ids.get('aiSceneGenerate').fire('click');
    assert.equal(preview.objects[0].id,'gemini_box');
    assert.deepEqual(sequence,preservedOriginal,'Preview must not save or edit the timeline');
    await ids.get('aiSceneDiscard').fire('click');
    assert.equal(preview,null);
    assert.deepEqual(sequence,preservedOriginal,'Discard must preserve the original timeline');
    await ids.get('aiSceneGenerate').fire('click');
    await ids.get('aiSceneAccept').fire('click');
    assert.equal(acceptedCalls,1);
    assert.equal(generatedCalls,2);
    assert.equal(discardCalls,1);
    assert.deepEqual(sampled,[[1.5,3,4.5],[1.5,3,4.5]]);
    assert.equal(videos.length,2);
    assert.deepEqual(sequence.primitiveScenes.scenes.find(x=>x.shotId==='shot_b'),untouched);
    assert.deepEqual(sequence.primitiveScenes.scenes.find(x=>x.shotId==='shot_a'),generated.scenes[0]);
    assert.deepEqual(sequence.camera,preservedOriginal.camera);
    assert.deepEqual(sequence.shots,preservedOriginal.shots);
    assert.match(ids.get('aiSceneStatus').textContent,/Accepted/);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;
    else globalThis.document=oldDocument;
    globalThis.fetch=oldFetch;
  }
});
