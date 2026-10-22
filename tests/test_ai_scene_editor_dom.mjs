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
  removeEventListener(type,fn){if(this.handlers.get(type)===fn)this.handlers.delete(type);}
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
  const requestedLayers=[];
  const inspected=[];
  let phpAuthenticated=false;
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
    if(!opts.method){
      assert.equal(opts.credentials,'same-origin');
      assert.equal(opts.cache,'no-store');
      return new Response(JSON.stringify({
        ok:true,authenticated:phpAuthenticated,
        csrf:phpAuthenticated?'logged-in-test-csrf':'temporary-test-csrf'
      }),{status:200});
    }
    assert.equal(opts.credentials,'same-origin');
    assert.equal(opts.headers['X-Paige-Client'],'SceneStudio');
    const payload=JSON.parse(opts.body);
    if(payload.action==='login'){
      assert.equal(payload.passphrase,'mock passphrase 12345');
      phpAuthenticated=true;
      return new Response(JSON.stringify({
        ok:true,authenticated:true,csrf:'logged-in-test-csrf'
      }),{status:200});
    }
    assert.equal(payload.action,'generate');
    assert.equal(payload.csrf,'logged-in-test-csrf');
    assert.equal(payload.shotId,'shot_a');
    assert.equal(payload.frames.length,3);
    assert.equal(payload.profile,'lite_default','defaults to known-working Lite');
    const expectedLayers=['structures','ground','vegetation','details'];
    const index=generatedCalls%4;
    assert.equal(payload.layer,expectedLayers[index]);
    assert.equal(payload.existing.length,index);
    requestedLayers.push(payload.layer);
    sampled.push(payload.frames.map(x=>x.at));
    generatedCalls++;
    const result=await sceneWorker.fetch(new Request('https://mock.workers.dev/api/scene',{
      method:'POST',
      headers:{Authorization:'Bearer '+env.SCENE_ACCESS_TOKEN,'Content-Type':'application/json'},
      body:JSON.stringify({shotId:payload.shotId,frames:payload.frames,
        profile:payload.profile,layer:payload.layer,existing:payload.existing})
    }),env);
    assert.equal(result.status,200);
    return new Response(JSON.stringify({ok:true,proposal:await result.json()}),{status:200});
  };
  try{
    setupAiSceneEditor({
      getSequence:()=>sequence,getActiveShot:()=>sequence.shots[0],
      getPlayheadTime:()=>2.8,
      getReferenceVideo:()=>({src:'blob:synthetic-video'}),
      onPreview:entry=>{preview=entry;},
      onInspect:shotId=>{inspected.push(shotId);},
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
    assert.equal(preview.objects[0].id,'structures_1');
    assert.deepEqual(preview.objects.map(x=>x.layer),
      ['structures','ground','vegetation','details']);
    assert.equal(ids.get('aiSceneInspect').hidden,false);
    assert.equal(ids.get('aiSceneCleanup').hidden,false);
    assert.match(ids.get('aiSceneLog').textContent,/pass 1\/4 —/);
    assert.match(ids.get('aiSceneLog').textContent,/Z-fighting cleanup/);
    const beforeCleanup=structuredClone(preview);
    await ids.get('aiSceneCleanup').fire('click');
    assert.deepEqual(preview,beforeCleanup,'manual pass must be safe to repeat');
    assert.match(ids.get('aiSceneLog').textContent,/Manual cleanup/);
    await ids.get('aiSceneInspect').fire('click');
    assert.deepEqual(inspected,['shot_a']);

    assert.deepEqual(sequence,preservedOriginal,'Preview must not save or edit the timeline');
    await ids.get('aiSceneDiscard').fire('click');
    assert.equal(preview,null);
    assert.equal(ids.get('aiSceneInspect').hidden,true);
    assert.equal(ids.get('aiSceneCleanup').hidden,true);
    assert.deepEqual(sequence,preservedOriginal,'Discard must preserve the original timeline');
    await ids.get('aiSceneGenerate').fire('click');
    await ids.get('aiSceneAccept').fire('click');
    assert.equal(acceptedCalls,1);
    assert.equal(generatedCalls,8);
    assert.deepEqual(requestedLayers,Array(2).fill(['structures','ground','vegetation','details']).flat());
    assert.equal(discardCalls,1);
    assert.deepEqual(sampled,Array(8).fill([2.8,1.32,4.68]));
    assert.equal(videos.length,2);
    assert.deepEqual(sequence.primitiveScenes.scenes.find(x=>x.shotId==='shot_b'),untouched);
    assert.deepEqual(sequence.primitiveScenes.scenes.find(x=>x.shotId==='shot_a'),{
      shotId:'shot_a',objects:['structures','ground','vegetation','details'].map(
        layer=>({...generated.scenes[0].objects[0],id:layer+'_1',layer}))
    });
    assert.deepEqual(sequence.camera,preservedOriginal.camera);
    assert.deepEqual(sequence.shots,preservedOriginal.shots);
    assert.match(ids.get('aiSceneStatus').textContent,/Accepted/);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;
    else globalThis.document=oldDocument;
    globalThis.fetch=oldFetch;
  }
});

async function runSessionCase(mode) {
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch;
  const ids=new Map();
  let phpAuthenticated=false,videoCount=0,generated=0;
  globalThis.document={
    getElementById(id){
      if(!ids.has(id))ids.set(id,new Element());
      return ids.get(id);
    },
    createElement(tag){
      if(tag==='video'){videoCount++;return new FakeVideo();}
      if(tag==='canvas')return{
        width:0,height:0,
        getContext:()=>({drawImage:()=>{}}),
        toDataURL:()=> 'data:image/jpeg;base64,'+
          Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64')
      };
      return new Element();
    }
  };
  globalThis.fetch=async (url,opts={})=>{
    assert.equal(url,'./scene-proxy.php');
    if(!opts.method){
      assert.equal(opts.credentials,'same-origin');
      assert.equal(opts.cache,'no-store');
      return new Response(JSON.stringify({
        ok:true,authenticated:phpAuthenticated,csrf:'mock-csrf-value'
      }),{status:200});
    }
    const input=JSON.parse(opts.body);
    if(input.action==='login'){
      // PHP accepted the passphrase; only some cases retain a cookie/session.
      phpAuthenticated=mode!=='cookie-not-retained';
      return new Response(JSON.stringify({
        ok:true,authenticated:true,csrf:'mock-csrf-value'
      }),{status:200});
    }
    assert.equal(input.action,'generate');
    generated++;
    assert.equal(input.frames.length,3);
    return new Response(JSON.stringify({
      ok:false,error:'Sign in before generating a scene'
    }),{status:401});
  };
  try{
    setupAiSceneEditor({
      getSequence:()=>({shots:[{id:'shot_a',start:0,end:6}]}),
      getActiveShot:()=>({id:'shot_a',start:0,end:6}),
      getReferenceVideo:()=>({src:'blob:synthetic-reference'}),
      onPreview:()=>assert.fail('No proposal expected'),
      onDiscard:()=>{},
      onAccept:()=>assert.fail('No acceptance expected'),
    });
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(ids.get('aiSceneControls').hidden,true);
    ids.get('aiScenePassphrase').value='example passphrase not real';
    await ids.get('aiSceneSignIn').fire('click');
    assert.equal(ids.get('aiScenePassphrase').value,'');
    if(mode==='cookie-not-retained'){
      assert.equal(ids.get('aiSceneLogin').hidden,false);
      assert.equal(ids.get('aiSceneControls').hidden,true);
      assert.match(ids.get('aiSceneStatus').textContent,/did not retain your session/);
    }else {
      assert.equal(ids.get('aiSceneControls').hidden,false);
      if(mode==='session-ended-before-preflight')phpAuthenticated=false;
      await ids.get('aiSceneGenerate').fire('click');
      assert.equal(ids.get('aiSceneLogin').hidden,false);
      assert.equal(ids.get('aiSceneControls').hidden,true);
      assert.equal(ids.get('aiSceneGenerate').disabled,true);
      assert.match(ids.get('aiSceneStatus').textContent,/Sign in again/);
    }
    assert.equal(generated,mode==='session-ended-after-preflight'?1:0);
    assert.equal(videoCount,mode==='session-ended-after-preflight'?1:0,
      'Lost sessions should be detected before unnecessary video frame sampling');
  }finally{
    if(oldDocument===undefined)delete globalThis.document;
    else globalThis.document=oldDocument;
    globalThis.fetch=oldFetch;
  }
}

test('a 200 login without a persisted PHP session never unlocks Generate',async()=>{
  await runSessionCase('cookie-not-retained');
});
test('expired PHP session returns to sign-in without sampling video',async()=>{
  await runSessionCase('session-ended-before-preflight');
});
test('401 after video sampling also returns to sign-in instead of leaving controls unlocked',async()=>{
  await runSessionCase('session-ended-after-preflight');
});


test('Primary-only mode samples detailed frames and forwards bounded mode to Gemini',async()=>{
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch;
  const ids=new Map(),encodes=[];
  let preview=null,sent=0,accepted=0;
  const jpeg='data:image/jpeg;base64,'+
    Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');
  globalThis.document={
    getElementById(id){
      if(!ids.has(id))ids.set(id,new Element());
      return ids.get(id);
    },
    createElement(tag){
      if(tag==='video')return new FakeVideo();
      if(tag==='canvas'){
        const canvas={
          width:0,height:0,
          getContext:()=>({drawImage:()=>{}}),
          toDataURL:(_mime,q)=>{
            encodes.push({width:canvas.width,quality:q});
            // Force a large JPEG for the first frame to exercise fallback.
            if(canvas.width===768&&encodes.filter(x=>x.width===768).length===1)
              return 'data:image/jpeg;base64,'+'A'.repeat(460001);
            return jpeg;
          }
        };
        return canvas;
      }
      return new Element();
    }
  };
  const scene={schemaVersion:1,scenes:[{shotId:'shot_a',objects:[{
    id:'entry_frame',name:'Detailed entrance frame',primitive:'box',
    position:[0,1,0],rotation:[0,0,0],scale:[2,2,2],
    material:{color:'#123456',metalness:0,roughness:.6}
  }]}]};
  // Gemini returns two visually identical primitives; the browser's
  // automatic cleanup must remove the duplicate before preview/accept.
  scene.scenes[0].objects.push({
    ...structuredClone(scene.scenes[0].objects[0]),
    id:'entry_frame_duplicate',name:'Duplicate generated detail'
  });
  const env={GEMINI_API_KEY:'mock',SCENE_ACCESS_TOKEN:'private-test-token-12345678901234567890'};
  globalThis.fetch=async (url,options={})=>{
    if(String(url).includes('generativelanguage.googleapis.com')){
      assert.ok(String(url).endsWith('/gemini-3.8-flash:generateContent'));
      const body=JSON.parse(options.body);
      assert.match(body.contents[0].parts[0].text,/PRIMARY SUBJECT — HIGH-DETAIL/);
      assert.equal(body.generationConfig.maxOutputTokens,9500);
      assert.deepEqual(body.generationConfig.thinkingConfig,{thinkingLevel:'medium'});
      return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(scene)}]}}]}),{status:200});
    }
    assert.equal(url,'./scene-proxy.php');
    if(!options.method)return new Response(JSON.stringify({ok:true,authenticated:true,csrf:'fixed-csrf'}),{status:200});
    const input=JSON.parse(options.body);
    assert.equal(input.action,'generate');
    assert.equal(input.mode,'primary_subject');
    assert.equal(input.profile,'g38_medium');
    assert.equal(input.layer,undefined);
    assert.equal(input.frames.length,3);
    sent++;
    const response=await sceneWorker.fetch(new Request('https://example.workers.dev/api/scene',{
      method:'POST',
      headers:{Authorization:'Bearer '+env.SCENE_ACCESS_TOKEN,'Content-Type':'application/json'},
      body:JSON.stringify({shotId:input.shotId,frames:input.frames,mode:input.mode,profile:input.profile})
    }),env);
    assert.equal(response.status,200);
    return new Response(JSON.stringify({ok:true,proposal:await response.json()}),{status:200});
  };
  try{
    const shot={id:'shot_a',start:0,end:6};
    setupAiSceneEditor({
      getSequence:()=>({shots:[shot]}),getActiveShot:()=>shot,
      getPlayheadTime:()=>2.8,
      getReferenceVideo:()=>({src:'blob:mock-reference'}),
      onPreview:s=>{preview=s;},onDiscard:()=>{preview=null;},
      onAccept:()=>{accepted++;}
    });
    await new Promise(resolve=>setImmediate(resolve));
    ids.get('aiSceneScope').value='subject';
    ids.get('aiSceneModel').value='g38_medium';
    await ids.get('aiSceneGenerate').fire('click');
    assert.equal(sent,1,'primary mode uses only one authenticated request');
    assert.equal(preview?.objects[0]?.name,'Detailed entrance frame');
    assert.equal(preview?.objects.length,1,'auto cleanup removes duplicate model objects');
    assert.match(ids.get('aiSceneLog').textContent,/Z-fighting cleanup: 1 duplicates removed/);
    assert.equal(ids.get('aiSceneCleanup').hidden,false);
    assert.match(ids.get('aiSceneLog').textContent,/Gemini processing primary subject/);
    assert.match(ids.get('aiSceneLog').textContent,/reasoning\/geometry are not streamed/);
    assert.match(ids.get('aiSceneLog').textContent,/Preview ready: 1 editable objects/);
    const prior=structuredClone(preview);
    await ids.get('aiSceneCleanup').fire('click');
    assert.deepEqual(preview,prior,'cleanup of already-clean scene is idempotent');
    assert.match(ids.get('aiSceneStatus').textContent,/0 overlapping surfaces adjusted/);
    assert.equal(accepted,0,'preview must not change the timeline');
    assert.ok(encodes.some(x=>x.width===768&&x.quality===.78));
    assert.ok(encodes.some(x=>x.width===768&&x.quality<.78),'oversized JPEG must reduce quality');
    assert.ok(encodes.filter(x=>x.width===768&&x.quality===.78).length>=3,
      'each sampled reference frame starts in detailed mode');
    assert.match(ids.get('aiSceneLog').textContent,/Preview ready: 1 editable objects/);
    assert.match(ids.get('aiSceneStatus').textContent,/Preview updated; nothing saved until accepted/);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;
    else globalThis.document=oldDocument;
    globalThis.fetch=oldFetch;
  }
});

test('Medium thinking cannot start a full-environment request or sample video',async()=>{
  const priorDocument=globalThis.document,priorFetch=globalThis.fetch;
  const ids=new Map();
  let upstreamRequests=0,videoObjects=0;
  globalThis.document={
    getElementById(id){
      if(!ids.has(id))ids.set(id,new Element());
      return ids.get(id);
    },
    createElement(tag){
      if(tag==='video')videoObjects++;
      return new Element();
    }
  };
  globalThis.fetch=async(_url,options={})=>{
    if(options.method){upstreamRequests++;throw Error('Medium environment must not submit');}
    return new Response(JSON.stringify({ok:true,authenticated:true,csrf:'csrf-test'}),{status:200});
  };
  try{
    const shot={id:'shot_a',start:0,end:6};
    setupAiSceneEditor({
      getSequence:()=>({shots:[shot]}),getActiveShot:()=>shot,
      getReferenceVideo:()=>({src:'blob:mock-reference'}),
      getPlayheadTime:()=>2.5,
      onPreview:()=>assert.fail('Invalid request must not preview'),
      onDiscard:()=>{},onAccept:()=>assert.fail('Invalid request must not save')
    });
    await new Promise(resolve=>setImmediate(resolve));
    ids.get('aiSceneScope').value='environment';
    ids.get('aiSceneModel').value='g38_medium';
    await ids.get('aiSceneGenerate').fire('click');
    assert.equal(upstreamRequests,0);
    assert.equal(videoObjects,0);
    assert.match(ids.get('aiSceneStatus').textContent,/only for Primary subject only/);
  }finally{
    if(priorDocument===undefined)delete globalThis.document;
    else globalThis.document=priorDocument;
    globalThis.fetch=priorFetch;
  }
});
