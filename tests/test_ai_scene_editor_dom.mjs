// Real browser editor module + real Cloudflare Worker with an in-memory Gemini stub.
// This test does not contact 50webs, Cloudflare or the model provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setupAiSceneEditor,describeRepairs} from '../ai-scene-editor.js';
import sceneWorker,{ARGON_REPAIR_CODES} from '../worker/scene-worker.mjs';
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
    assert.match(ids.get('aiSceneStatus').textContent,/requires Primary subject only/);
  }finally{
    if(priorDocument===undefined)delete globalThis.document;
    else globalThis.document=priorDocument;
    globalThis.fetch=priorFetch;
  }
});

test('Paid Argon Previs submits once, polls privately, and previews without accepting',async()=>{
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch,oldConfirm=globalThis.confirm;
  const ids=new Map();
  const jpeg='data:image/jpeg;base64,'+Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');
  let startCount=0,pollCount=0,preview=null,saved=0;
  globalThis.confirm=message=>{
    assert.match(message,/two potentially billable calls/);
    assert.match(message,/Gemini 3\.5 Flash-Lite/);
    assert.match(message,/Gemini 4 Argon/);
    assert.match(message,/two request slots/);
    assert.match(message,/stores the visual description/);
    return true;
  };
  globalThis.document={
    getElementById(id){if(!ids.has(id))ids.set(id,new Element());return ids.get(id);},
    createElement(tag){
      if(tag==='video')return new FakeVideo();
      if(tag==='canvas')return {width:0,height:0,getContext:()=>({drawImage:()=>{}}),
        toDataURL:()=>jpeg};
      return new Element();
    }
  };
  const scene={schemaVersion:1,scenes:[{shotId:'shot_a',objects:[{
    id:'client_building',name:'Client composite hero building',primitive:'box',
    position:[0,2,0],rotation:[0,0,0],scale:[8,4,4],
    material:{color:'#123456',metalness:0,roughness:.6}
  }]}]};
  globalThis.fetch=async(url,options={})=>{
    assert.equal(url,'./scene-proxy.php');
    if(!options.method)return new Response(JSON.stringify({ok:true,authenticated:true,csrf:'test-csrf',
      argonJob:null}),{status:200});
    const payload=JSON.parse(options.body);
    assert.equal(payload.csrf,'test-csrf');
    if(payload.action==='argon_start'){
      startCount++;
      assert.equal(payload.profile,'argon_previs');
      assert.equal(payload.mode,'primary_subject');
      assert.equal(payload.frames.length,3);
      assert.equal(payload.layer,undefined);
      return new Response(JSON.stringify({ok:true,status:'in_progress',shotId:'shot_a'}),{status:200});
    }
    assert.equal(payload.action,'argon_status');
    assert.equal(payload.jobId,undefined,'job ID stays server-side');
    pollCount++;
    return new Response(JSON.stringify({ok:true,status:'completed',shotId:'shot_a',
      proposal:scene}),{status:200});
  };
  try{
    const shot={id:'shot_a',start:0,end:6};
    setupAiSceneEditor({getSequence:()=>({shots:[shot]}),getActiveShot:()=>shot,
      getReferenceVideo:()=>({src:'blob:reference'}),getPlayheadTime:()=>2,
      onPreview:entry=>{preview=entry;},onDiscard:()=>{preview=null;},
      onAccept:()=>{saved++;}});
    await new Promise(resolve=>setImmediate(resolve));
    ids.get('aiSceneScope').value='subject';
    ids.get('aiSceneModel').value='argon_previs';
    await ids.get('aiSceneGenerate').fire('click');
    assert.equal(startCount,1);
    assert.equal(pollCount,1);
    assert.equal(preview?.objects[0]?.id,'client_building');
    assert.equal(saved,0);
    assert.match(ids.get('aiSceneLog').textContent,/Argon job status: completed/);
    assert.match(ids.get('aiSceneLog').textContent,/Z-fighting cleanup/);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    if(oldConfirm===undefined)delete globalThis.confirm;else globalThis.confirm=oldConfirm;
    globalThis.fetch=oldFetch;
  }
});

function argonDomHarness(ids,jpeg){
  return {
    getElementById(id){if(!ids.has(id))ids.set(id,new Element());return ids.get(id);},
    createElement(tag){
      if(tag==='video')return new FakeVideo();
      if(tag==='canvas')return {width:0,height:0,getContext:()=>({drawImage:()=>{}}),
        toDataURL:()=>jpeg};
      return new Element();
    }
  };
}
test('failed Argon jobs expose a session-only original-output download without previewing or replaying',async()=>{
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch,oldCreate=URL.createObjectURL,
    oldRevoke=URL.revokeObjectURL,oldTimeout=globalThis.setTimeout;
  const ids=new Map(),actions=[],links=[];let blob,revoked=false,missing=false;
  const raw='{"material":"<script>PRIVATE_UNTRUSTED</script>"}';
  const doc=argonDomHarness(ids,'unused'),create=doc.createElement;
  doc.createElement=tag=>tag==='a'?{click(){links.push(this);}}:create(tag);
  globalThis.document=doc;
  globalThis.setTimeout=(fn,ms)=>ms===1000?(queueMicrotask(fn),0):oldTimeout(fn,ms);
  URL.createObjectURL=value=>{blob=value;return 'blob:original-output';};
  URL.revokeObjectURL=url=>{assert.equal(url,'blob:original-output');revoked=true;};
  globalThis.fetch=async(_url,options={})=>{
    if(!options.method)return new Response(JSON.stringify({ok:true,authenticated:true,csrf:'private-csrf',
      argonJob:{shotId:'shot_a',status:'in_progress'}}));
    const body=JSON.parse(options.body);actions.push(body.action);
    assert.deepEqual(Object.keys(body).sort(),['action','csrf']);
    if(body.action==='argon_status')return new Response(JSON.stringify({ok:true,shotId:'shot_a',status:'failed',
      diagnostic:{phase:'job',http:null,status:'failed',reason:'scene_schema_mismatch',codes:['primitive'],fields:[],terms:[]}}));
    assert.equal(body.action,'argon_output');
    if(missing)return new Response(JSON.stringify({ok:false,error:'This job has no saved original output.'}),{status:404});
    return new Response(JSON.stringify({ok:true,shotId:'shot_a',output:raw,partial:true}));
  };
  try{
    const shot={id:'shot_a',start:0,end:6};
    setupAiSceneEditor({getSequence:()=>({shots:[shot]}),getActiveShot:()=>shot,
      getReferenceVideo:()=>null,getPlayheadTime:()=>2,onPreview:()=>assert.fail('Raw text must not be previewed'),
      onDiscard:()=>{},onAccept:()=>assert.fail('Raw text must not be applied')});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(ids.get('aiSceneDownloadArgon').hidden,true);
    await ids.get('aiSceneResumeArgon').fire('click');
    assert.equal(ids.get('aiSceneDownloadArgon').hidden,false);
    await ids.get('aiSceneDownloadArgon').fire('click');
    assert.deepEqual(actions,['argon_status','argon_output']);
    assert.equal(await blob.text(),raw);assert.equal(revoked,true);
    assert.equal(links[0].download,'argon-output-shot_a-partial.json');
    assert.ok(!ids.get('aiSceneLog').textContent.includes('PRIVATE_UNTRUSTED'));
    missing=true;await ids.get('aiSceneDownloadArgon').fire('click');
    assert.match(ids.get('aiSceneStatus').textContent,/no saved original output/);
    assert.deepEqual(actions,['argon_status','argon_output','argon_output']);
  }finally{
    globalThis.document=oldDocument;globalThis.fetch=oldFetch;globalThis.setTimeout=oldTimeout;
    URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;
  }
});
test('Experimental direct-image Argon discloses image handling, submits once and previews',async()=>{
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch,oldConfirm=globalThis.confirm;
  const ids=new Map(),actions=[];
  const jpeg='data:image/jpeg;base64,'+Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');
  let preview=null,saved=0;
  globalThis.confirm=message=>{
    assert.match(message,/EXPERIMENTAL/);
    assert.match(message,/ONE potentially billable call/);
    assert.match(message,/Cloudflare job holds the request for up to 12 minutes/);
    assert.match(message,/THE REFERENCE IMAGES only until Argon answers/);
    assert.match(message,/Google is asked not to store/);
    assert.match(message,/one request slot/);
    assert.match(message,/Nothing falls back automatically/);
    return true;
  };
  globalThis.document=argonDomHarness(ids,jpeg);
  const scene={schemaVersion:1,scenes:[{shotId:'shot_a',camera:{position:[0,3,18],target:[0,2,0],fov:42},objects:[{
    id:'direct_facade',name:'Facade observed directly',primitive:'box',
    position:[0,2,0],rotation:[0,0,0],scale:[8,4,1],
    material:{color:'#334455',metalness:0,roughness:.6}
  },{id:'window_grid',name:'Window grid',primitive:'box',position:[0,2,.55],rotation:[0,0,0],
    scale:[1,1.2,.05],repeat:{count:[6,2,1],spacing:[1.3,1.8,0]},
    material:{color:'#112233',metalness:.4,roughness:.2,emissive:'#ffdd99',emissiveIntensity:1}}]}]};
  globalThis.fetch=async(url,options={})=>{
    if(!options.method)return new Response(JSON.stringify({ok:true,authenticated:true,csrf:'test-csrf',
      argonJob:null}),{status:200});
    const payload=JSON.parse(options.body);
    actions.push(payload.action);
    if(payload.action==='argon_start'){
      assert.equal(payload.profile,'argon_direct');
      assert.equal(payload.mode,'primary_subject');
      assert.equal(payload.frames.length,3);
      return new Response(JSON.stringify({ok:true,status:'in_progress',shotId:'shot_a'}),{status:200});
    }
    assert.equal(payload.action,'argon_status');
    return new Response(JSON.stringify({ok:true,status:'completed',shotId:'shot_a',proposal:scene}),{status:200});
  };
  try{
    const shot={id:'shot_a',start:0,end:6};
    setupAiSceneEditor({getSequence:()=>({shots:[shot]}),getActiveShot:()=>shot,
      getReferenceVideo:()=>({src:'blob:reference'}),getPlayheadTime:()=>2,
      onPreview:entry=>{preview=entry;},onDiscard:()=>{preview=null;},onAccept:()=>{saved++;}});
    await new Promise(resolve=>setImmediate(resolve));
    ids.get('aiSceneScope').value='subject';
    ids.get('aiSceneModel').value='argon_direct';
    await ids.get('aiSceneGenerate').fire('click');
    assert.deepEqual(actions,['argon_start','argon_status']);
    assert.equal(preview?.objects[0]?.id,'direct_facade');
    // The rich result survives cleanup into the preview, camera included.
    assert.deepEqual(preview.camera,{position:[0,3,18],target:[0,2,0],fov:42});
    assert.deepEqual(preview.objects[1].repeat,{count:[6,2,1],spacing:[1.3,1.8,0]});
    assert.equal(saved,0);
    assert.match(ids.get('aiSceneLog').textContent,/directly to Gemini 4 Argon through a Cloudflare job/);
    assert.match(ids.get('aiSceneLog').textContent,/Preview ready: 2 editable objects \(13 rendered parts\)/);
    assert.match(ids.get('aiSceneLog').textContent,/estimate of the reference camera; timeline cameras are unchanged/);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    if(oldConfirm===undefined)delete globalThis.confirm;else globalThis.confirm=oldConfirm;
    globalThis.fetch=oldFetch;
  }
});
test('Argon Direct image rebuilds a full scene in ONE call, with layers and lights',async()=>{
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch,oldConfirm=globalThis.confirm;
  const ids=new Map(),payloads=[],canvases=[];
  const jpeg='data:image/jpeg;base64,'+Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');
  let preview=null,confirmed='';
  globalThis.confirm=message=>{confirmed=message;return true;};
  const dom=argonDomHarness(ids,jpeg),create=dom.createElement;
  dom.createElement=tag=>{const node=create(tag);if(tag==='canvas')canvases.push(node);return node;};
  globalThis.document=dom;
  const material={color:'#334455',metalness:0,roughness:.6};
  const scene={schemaVersion:1,scenes:[{shotId:'shot_a',
    lights:[{type:'point',name:'Lamp',color:'#ffcc88',intensity:25,position:[6,5,8],distance:30}],objects:[
    {id:'hall',name:'Hall',layer:'structures',primitive:'box',position:[0,3,0],rotation:[0,0,0],scale:[20,6,12],material},
    {id:'road',name:'Road',layer:'ground',primitive:'box',position:[0,.05,14],rotation:[0,0,0],scale:[40,.1,6],material},
    {id:'trees',name:'Tree row',layer:'vegetation',primitive:'sphere',position:[0,3,20],rotation:[0,0,0],scale:[3,3,3],
      repeat:{count:[8,1,1],spacing:[5,0,0]},material}]}]};
  globalThis.fetch=async(url,options={})=>{
    if(!options.method)return new Response(JSON.stringify({ok:true,authenticated:true,csrf:'test-csrf',
      argonJob:null}),{status:200});
    const payload=JSON.parse(options.body);payloads.push(payload);
    if(payload.action==='argon_start')return new Response(JSON.stringify({ok:true,status:'in_progress',shotId:'shot_a'}),{status:200});
    return new Response(JSON.stringify({ok:true,status:'completed',shotId:'shot_a',proposal:scene,
      repairs:{scale:1,duplicate_id:2}}),{status:200});
  };
  try{
    const shot={id:'shot_a',start:0,end:6};
    setupAiSceneEditor({getSequence:()=>({shots:[shot]}),getActiveShot:()=>shot,
      getReferenceVideo:()=>({src:'blob:reference'}),getPlayheadTime:()=>2,
      onPreview:entry=>{preview=entry;},onDiscard:()=>{},onAccept:()=>{}});
    await new Promise(resolve=>setImmediate(resolve));
    ids.get('aiSceneScope').value='environment';
    // The thinking and detail selectors appear only for Argon models.
    assert.equal(ids.get('aiArgonSettings').hidden,true);
    ids.get('aiSceneModel').value='argon_direct';await ids.get('aiSceneModel').fire('change');
    assert.equal(ids.get('aiArgonSettings').hidden,false);
    ids.get('aiArgonThinking').value='high';ids.get('aiArgonDetail').value='max';
    await ids.get('aiSceneGenerate').fire('click');
    assert.equal(payloads[0].thinking,'high');assert.equal(payloads[0].detail,'max');
    assert.match(confirmed,/^Settings: high thinking, Maximum detail\. These use more of the same 32,768-token output budget/);
    assert.match(ids.get('aiSceneLog').textContent,/Argon settings: high thinking, Maximum detail\./);
    // One paid start, never the four Flash passes.
    assert.deepEqual(payloads.map(p=>p.action),['argon_start','argon_status']);
    assert.equal(payloads[0].mode,'full_scene');assert.equal(payloads[0].layer,undefined);
    assert.equal(payloads[0].frames.length,3);
    assert.ok(canvases.length>0&&canvases.every(canvas=>canvas.width===768),'Argon gets the detailed frames');
    assert.match(confirmed,/direct-image generation of the FULL SCENE\? This makes ONE potentially billable call/);
    const log=ids.get('aiSceneLog').textContent;
    assert.match(log,/directly to Gemini 4 Argon for the full scene through a Cloudflare job/);
    assert.match(log,/Preview ready: 3 editable objects \(10 rendered parts\)/);
    assert.match(log,/Worker validation kept the scene and repaired or dropped: size out of range 1 · duplicate ID \(renamed\) 2\./);
    assert.match(log,/Scene lights: 1 \(point\), shown only during this chapter/);
    assert.match(log,/Layers: Buildings and structures: 1 · Roads and terrain: 1 · Trees and landscaping: 1 · Objects and infrastructure: 0/);
    assert.deepEqual(preview.objects.map(o=>o.layer),['structures','ground','vegetation']);
    assert.equal(preview.lights[0].name,'Lamp');
  }finally{
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    if(oldConfirm===undefined)delete globalThis.confirm;else globalThis.confirm=oldConfirm;
    globalThis.fetch=oldFetch;
  }
});
test('Argon rejections and failed jobs show the sanitized provider diagnostic without fallback',async()=>{
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch,oldConfirm=globalThis.confirm;
  const jpeg='data:image/jpeg;base64,'+Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');
  globalThis.confirm=()=>true;
  const run=async(profile,respond)=>{
    const ids=new Map(),actions=[];
    globalThis.document=argonDomHarness(ids,jpeg);
    globalThis.fetch=async(url,options={})=>{
      if(!options.method)return new Response(JSON.stringify({ok:true,authenticated:true,
        csrf:'test-csrf',argonJob:null}),{status:200});
      const payload=JSON.parse(options.body);
      actions.push(payload.action);
      return respond(payload);
    };
    const shot={id:'shot_a',start:0,end:6};
    setupAiSceneEditor({getSequence:()=>({shots:[shot]}),getActiveShot:()=>shot,
      getReferenceVideo:()=>({src:'blob:reference'}),getPlayheadTime:()=>2,
      onPreview:()=>assert.fail('No preview after a rejection'),onDiscard:()=>{},onAccept:()=>{}});
    await new Promise(resolve=>setImmediate(resolve));
    ids.get('aiSceneScope').value='subject';
    ids.get('aiSceneModel').value=profile;
    await ids.get('aiSceneGenerate').fire('click');
    return {log:ids.get('aiSceneLog').textContent,actions};
  };
  try{
    const rejected=await run('argon_direct',()=>new Response(JSON.stringify({ok:false,
      error:'Google rejected the Argon request (HTTP 400). No job was created and nothing was retried; see the provider diagnostic in the activity log.',
      diagnostic:{phase:'create',http:400,status:null,reason:'media_input_rejected',
        codes:['invalid_request'],fields:['input'],terms:['image','only','one','supported']}}),{status:502}));
    assert.deepEqual(rejected.actions,['argon_start'],'No retry, Previs or Flash-Lite fallback');
    assert.match(rejected.log,/Provider diagnostic: create · HTTP 400 · reason media_input_rejected · code invalid_request · fields input · terms image, only, one, supported/);
    const failed=await run('argon_previs',payload=>new Response(JSON.stringify(
      payload.action==='argon_start'?{ok:true,status:'in_progress',shotId:'shot_a',
        usage:{input:5210,inputImage:4644,thinking:0,output:812,total:6022,cap:4096}}:
      {ok:true,status:'failed',shotId:'shot_a',diagnostic:{phase:'job',http:null,
        status:'incomplete',reason:'incomplete_output',codes:[],fields:[]},
        usage:{input:1800,thinking:20000,output:8672,total:30472,cap:28672}}),{status:200}));
    assert.deepEqual(failed.actions,['argon_start','argon_status']);
    assert.match(failed.log,/Argon job failed on the provider/);
    assert.match(failed.log,/Provider diagnostic: job · incomplete · reason incomplete_output/);
    // Token counts are logged for both paid stages, including a job cut off at its cap.
    assert.match(failed.log,/Flash-Lite analysis tokens: 5,210 input \(4,644 image\) · 0 thinking · 812 output · 6,022 total\. Thinking \+ output used 812 of 4,096 \(20%\)\./);
    assert.match(failed.log,/Argon tokens: 1,800 input · 20,000 thinking · 8,672 output · 30,472 total\. Thinking \+ output used 28,672 of 28,672 \(100%\)\./);
    // A Google server error says so, notes billing, and is never retried.
    const deadline=await run('argon_direct',payload=>new Response(JSON.stringify(
      payload.action==='argon_start'?{ok:true,status:'in_progress',shotId:'shot_a'}:
      {ok:true,status:'failed',shotId:'shot_a',diagnostic:{phase:'job',http:null,status:'failed',
        reason:'provider_deadline',codes:['DEADLINE_EXCEEDED'],fields:[],terms:[]}}),{status:200}));
    assert.deepEqual(deadline.actions,['argon_start','argon_status']);
    assert.match(deadline.log,/reason provider_deadline · code DEADLINE_EXCEEDED/);
    assert.match(deadline.log,/The provider request returned a server error\. Google's billing FAQ/);
    assert.doesNotMatch(failed.log,/billing FAQ/,'not for other failures');
    // A finished scene with no usable part names the rule that rejected it.
    const unusable=await run('argon_direct',payload=>new Response(JSON.stringify(
      payload.action==='argon_start'?{ok:true,status:'in_progress',shotId:'shot_a'}:
      {ok:true,status:'failed',shotId:'shot_a',diagnostic:{phase:'job',http:null,status:'failed',
        reason:'scene_schema_mismatch',codes:['scale','repeat'],fields:[],terms:[]}}),{status:200}));
    assert.deepEqual(unusable.actions,['argon_start','argon_status'],'No retry of a finished paid job');
    assert.match(unusable.log,/No part of the returned scene was usable\. Rule: size out of range, repeat over its limits\./);
    assert.match(unusable.log,/reason scene_schema_mismatch · code scale, repeat/);
    // A well-formed answer with no objects says so, instead of "no scene passed validation".
    const empty=await run('argon_direct',payload=>new Response(JSON.stringify(
      payload.action==='argon_start'?{ok:true,status:'in_progress',shotId:'shot_a'}:
      {ok:true,status:'failed',shotId:'shot_a',diagnostic:{phase:'job',http:null,status:'failed',
        reason:'scene_schema_mismatch',codes:['empty'],fields:[],terms:[]},
        usage:{input:6664,inputImage:3300,cached:0,thinking:6999,output:39,total:13702,cap:32768}}),{status:200}));
    assert.deepEqual(empty.actions,['argon_start','argon_status'],'No retry of a finished paid job');
    assert.match(empty.log,/Rule: no objects in the answer\./);
    assert.match(empty.log,/Argon answered with an empty scene \(0 objects\), so there is nothing to import\. Nothing was retried\./);
    assert.doesNotMatch(empty.log,/no scene passed validation/);
    // A job cut off by a Worker deploy is Cloudflare's stop, not a provider failure.
    const redeployed=await run('argon_direct',payload=>new Response(JSON.stringify(
      payload.action==='argon_start'?{ok:true,status:'in_progress',shotId:'shot_a'}:
      {ok:true,status:'failed',shotId:'shot_a',diagnostic:{phase:'job',http:null,status:'failed',
        reason:'job_interrupted_deploy',codes:[],fields:[],terms:[]}}),{status:200}));
    assert.deepEqual(redeployed.actions,['argon_start','argon_status'],'Never resubmitted');
    assert.match(redeployed.log,/Argon job stopped on Cloudflare, not at Google\. The Worker was redeployed during the paid call/);
    assert.doesNotMatch(redeployed.log,/failed on the provider/);
    assert.match(redeployed.log,/The cut-off call was not resubmitted\. Its billing is not confirmed/);
    const stopped=await run('argon_direct',payload=>new Response(JSON.stringify(
      payload.action==='argon_start'?{ok:true,status:'in_progress',shotId:'shot_a'}:
      {ok:true,status:'failed',shotId:'shot_a',diagnostic:{phase:'job',http:null,status:'failed',
        reason:'job_interrupted',codes:[],fields:[],terms:[]}}),{status:200}));
    assert.match(stopped.log,/stopped on Cloudflare, not at Google\. The job stopped during the paid call \(a Worker deploy is the usual cause\)/);
    assert.doesNotMatch(failed.log,/cut-off call/,'not for provider failures');
    // A start whose reply was lost polls the job PHP named, and never restarts it.
    const lostStart=await run('argon_direct',payload=>new Response(JSON.stringify(
      payload.action==='argon_start'?{ok:true,status:'queued',shotId:'shot_a',
        startUnconfirmed:{reason:'reset',http:null}}:
      {ok:true,status:'failed',shotId:'shot_a',diagnostic:{phase:'job',http:null,status:'failed',
        reason:'start_not_received',codes:[],fields:[],terms:[]}}),{status:200}));
    assert.deepEqual(lostStart.actions,['argon_start','argon_status'],'Never a second start');
    assert.match(lostStart.log,/Cloudflare did not confirm the start \(connection dropped\)\. Checking whether the job was created; no new paid request is sent\./);
    assert.doesNotMatch(lostStart.log,/Paid Argon job started/);
    assert.match(lostStart.log,/The start request never reached the job, so nothing was sent to Google\. You can start again\./);
    // Argon rejecting the job after the analysis still shows the billed analysis.
    const analysisBilled=await run('argon_previs',()=>new Response(JSON.stringify({ok:false,
      error:'Google rejected the Argon request (HTTP 400).',
      diagnostic:{phase:'create',http:400,status:null,reason:'output_schema',codes:['invalid_request'],fields:['response_format']},
      usage:{input:5210,output:812,total:6022,cap:4096}}),{status:502}));
    assert.deepEqual(analysisBilled.actions,['argon_start']);
    assert.match(analysisBilled.log,/Flash-Lite analysis tokens: 5,210 input · 812 output · 6,022 total/);
    assert.match(analysisBilled.log,/reason output_schema/);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    if(oldConfirm===undefined)delete globalThis.confirm;else globalThis.confirm=oldConfirm;
    globalThis.fetch=oldFetch;
  }
});
test('Argon polling survives a backgrounded phone and never resubmits the paid job',async()=>{
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch,oldTimeout=globalThis.setTimeout;
  const jpeg='data:image/jpeg;base64,'+Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');
  const scene={schemaVersion:1,scenes:[{shotId:'shot_a',objects:[{
    id:'resumed_block',name:'Resumed block',primitive:'box',position:[0,1,0],rotation:[0,0,0],
    scale:[2,2,2],material:{color:'#223344',metalness:0,roughness:.6}}]}]};
  const reply=(status,body)=>({status,body});
  const inProgress=reply(200,{ok:true,status:'in_progress',shotId:'shot_a'});
  const done=reply(200,{ok:true,status:'completed',shotId:'shot_a',proposal:scene});
  const workerDown=reply(502,{ok:false,error:'The AI Worker could not complete the request (upstream status 502).'});
  // iOS Safari reports a request cut off by locking or backgrounding as this.
  const dropped=()=>new TypeError('Load failed');
  const run=async replies=>{
    const ids=new Map(),actions=[],delays=[];let preview=null,n=0;
    globalThis.document=argonDomHarness(ids,jpeg);
    let pollDeadline;
    globalThis.setTimeout=(fn,ms)=>{
      if(ms===40000){pollDeadline=fn;return oldTimeout(fn,ms);}
      delays.push(ms);queueMicrotask(fn);return 0;
    };
    globalThis.fetch=async(url,options={})=>{
      if(!options.method)return new Response(JSON.stringify({ok:true,authenticated:true,
        csrf:'test-csrf',argonJob:{shotId:'shot_a',status:'in_progress'}}),{status:200});
      actions.push(JSON.parse(options.body).action);
      const next=replies[n++];
      if(next instanceof Error)throw next;
      if(typeof next==='function')return next(options,pollDeadline);
      return new Response(JSON.stringify(next.body),{status:next.status});
    };
    const shot={id:'shot_a',start:0,end:6};
    setupAiSceneEditor({getSequence:()=>({shots:[shot]}),getActiveShot:()=>shot,
      getReferenceVideo:()=>({src:'blob:reference'}),getPlayheadTime:()=>2,
      onPreview:entry=>{preview=entry;},onDiscard:()=>{},onAccept:()=>{}});
    await new Promise(resolve=>setImmediate(resolve));
    await ids.get('aiSceneResumeArgon').fire('click');
    return {preview,actions,delays,log:ids.get('aiSceneLog').textContent};
  };
  try{
    // Dropped and transient checks retry; the job's result still arrives.
    const recovered=await run([dropped(),workerDown,inProgress,done]);
    assert.equal(recovered.preview?.objects[0]?.id,'resumed_block');
    assert.deepEqual(recovered.actions,Array(4).fill('argon_status'),'Polling only; nothing resubmitted');
    assert.deepEqual(recovered.delays,[6500,13000,6500],'Backs off across network and HTTP errors');
    assert.equal(recovered.log.split('Status check interrupted (Connection to the editor server was interrupted)').length-1,1);
    assert.match(recovered.log,/Argon job status: in_progress/);
    assert.match(recovered.log,/Argon job status: completed/);
    // Network drops have no retry limit inside the window.
    const offline=await run([...Array(6)].map(dropped).concat([done]));
    assert.equal(offline.preview?.objects[0]?.id,'resumed_block');
    assert.equal(offline.actions.length,7);
    // Even a longer gateway outage recovers the SAME job, with capped backoff.
    const broken=await run([...Array(6)].fill(workerDown).concat([done]));
    assert.equal(broken.preview?.objects[0]?.id,'resumed_block');
    assert.equal(broken.actions.length,7);
    assert.deepEqual(broken.delays,[6500,13000,26000,30000,30000,30000]);
    assert.match(broken.log,/Argon job status: completed/);
    // A paid result the Worker could not use reports its tokens once, not per check.
    const unusable=reply(502,{ok:false,error:'Provider scene did not match the editor schema',
      usage:{input:1800,thinking:9120,output:11204,total:22124,cap:32768}});
    const wasted=await run([unusable,unusable,unusable,done]);
    assert.equal(wasted.actions.length,1,'A finished paid validation failure is terminal');
    assert.equal(wasted.log.split('Argon tokens: 1,800 input · 9,120 thinking').length-1,1);
    assert.match(wasted.log,/used 20,324 of 32,768 \(62%\)/);
    // A hanging status request times out, then a free poll recovers the job.
    const timedOut=await run([(options,expire)=>new Promise((_resolve,reject)=>{
      options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')));
      expire();
    }),done]);
    assert.equal(timedOut.preview?.objects[0]?.id,'resumed_block');
    assert.deepEqual(timedOut.actions,['argon_status','argon_status']);
    assert.match(timedOut.log,/Editor status check timed out/);
    const badBody=await run([()=>new Response('<html>gateway</html>'),done]);
    assert.equal(badBody.preview?.objects[0]?.id,'resumed_block');
    assert.match(badBody.log,/unreadable status response/);
    const refused=await run([new TypeError('net::ERR_CONNECTION_REFUSED'),done]);
    assert.equal(refused.preview?.objects[0]?.id,'resumed_block');
    assert.deepEqual(refused.actions,['argon_status','argon_status']);
    // A lost session is never retried.
    const signedOut=await run([reply(401,{ok:false,error:'Sign in before generating a scene'}),done]);
    assert.equal(signedOut.actions.length,1);
    assert.equal(signedOut.preview,null);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    globalThis.fetch=oldFetch;globalThis.setTimeout=oldTimeout;
  }
});
test('Argon Previs disallows a full environment before spending or sampling video',async()=>{
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch,oldConfirm=globalThis.confirm;
  const ids=new Map();let posts=0,sampled=0;
  globalThis.document={
    getElementById(id){if(!ids.has(id))ids.set(id,new Element());return ids.get(id);},
    createElement(tag){if(tag==='video')sampled++;return new Element();}
  };
  globalThis.confirm=()=>{throw Error('Environment selection should reject before payment confirmation');};
  globalThis.fetch=async(url,opts={})=>{
    if(!opts.method)return new Response(JSON.stringify({ok:true,authenticated:true,csrf:'test-csrf',
      argonJob:null}),{status:200});
    posts++;throw Error('Must never send paid job');
  };
  try{
    const shot={id:'shot_a',start:0,end:6};
    setupAiSceneEditor({getSequence:()=>({shots:[shot]}),getActiveShot:()=>shot,
      getReferenceVideo:()=>({src:'blob:reference'}),getPlayheadTime:()=>2,
      onPreview:()=>assert.fail('no preview'),onDiscard:()=>{},onAccept:()=>{}});
    await new Promise(resolve=>setImmediate(resolve));
    ids.get('aiSceneScope').value='environment';
    ids.get('aiSceneModel').value='argon_previs';
    await ids.get('aiSceneGenerate').fire('click');
    assert.equal(posts,0);assert.equal(sampled,0);
    assert.match(ids.get('aiSceneStatus').textContent,/requires Primary subject only\. Use Argon Direct image for a full scene/);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    if(oldConfirm===undefined)delete globalThis.confirm;else globalThis.confirm=oldConfirm;
    globalThis.fetch=oldFetch;
  }
});

test('Argon model visibility check is separate from paid generation, CSRF protected, and never samples client frames',async()=>{
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch;
  const ids=new Map();let checks=0,paid=0,videos=0;
  globalThis.document={
    getElementById(id){if(!ids.has(id))ids.set(id,new Element());return ids.get(id);},
    createElement(tag){if(tag==='video')videos++;return new Element();}
  };
  globalThis.fetch=async(url,options={})=>{
    assert.equal(url,'./scene-proxy.php');
    if(!options.method)return new Response(JSON.stringify({ok:true,authenticated:true,csrf:'test-csrf',
      argonJob:null}),{status:200});
    const body=JSON.parse(options.body);
    if(body.action==='argon_check'){
      checks++;
      assert.equal(body.csrf,'test-csrf');
      assert.deepEqual(Object.keys(body).sort(),['action','csrf']);
      return new Response(JSON.stringify({ok:true,available:true,check:'listed'}),{status:200});
    }
    paid++;throw Error('No paid generation should be sent by model-check button');
  };
  try{
    const shot={id:'shot_a',start:0,end:6};
    setupAiSceneEditor({getSequence:()=>({shots:[shot]}),getActiveShot:()=>shot,
      getReferenceVideo:()=>({src:'blob:reference'}),getPlayheadTime:()=>2,
      onPreview:()=>assert.fail('No proposal expected'),onDiscard:()=>{},onAccept:()=>{}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(ids.get('aiSceneCheckArgon').disabled,false);
    await ids.get('aiSceneCheckArgon').fire('click');
    assert.equal(checks,1);assert.equal(paid,0);assert.equal(videos,0);
    assert.match(ids.get('aiSceneStatus').textContent,/does not guarantee/);
    assert.match(ids.get('aiSceneLog').textContent,/no generation or reference frames/);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    globalThis.fetch=oldFetch;
  }
});

test('Argon smoke tests require seven separate confirmations and do not sample client video',async()=>{
  const beforeDoc=globalThis.document,beforeFetch=globalThis.fetch,
    beforeConfirm=globalThis.confirm;
  const ids=new Map();let posted=[],confirms=0,videoObjects=0;
  let state={step:0,state:'idle'};
  globalThis.document={
    getElementById(id){if(!ids.has(id))ids.set(id,new Element());return ids.get(id);},
    createElement(tag){if(tag==='video')videoObjects++;return new Element();}
  };
  globalThis.confirm=()=>{confirms++;return true;};
  globalThis.fetch=async(url,opts={})=>{
    assert.equal(url,'./scene-proxy.php');
    if(!opts.method)return new Response(JSON.stringify({ok:true,authenticated:true,csrf:'fixed-csrf',
      argonJob:null,argonSmoke:state}),{status:200});
    const req=JSON.parse(opts.body);
    assert.equal(req.csrf,'fixed-csrf');
    posted.push(req);
    if(req.action==='argon_diag_step'){
      assert.equal(req.step,state.step);
      assert.deepEqual(Object.keys(req).sort(),['action','csrf','step']);
      if(req.step>=4)state={step:req.step,state:'running'};
      else state={step:req.step+1,state:'passed'};
      return new Response(JSON.stringify({ok:true,...state,passed:true}),{status:200});
    }
    if(req.action==='argon_diag_poll'){
      assert.deepEqual(Object.keys(req).sort(),['action','csrf']);
      state={step:state.step+1,state:state.step===6?'done':'passed'};
      return new Response(JSON.stringify({ok:true,...state,passed:true}),{status:200});
    }
    throw Error('Unexpected scene generation or model call');
  };
  try{
    const shot={id:'draft_001',start:0,end:6};
    setupAiSceneEditor({getSequence:()=>({shots:[shot]}),getActiveShot:()=>shot,
      getReferenceVideo:()=>({src:'blob:private-video'}),getPlayheadTime:()=>1,
      onPreview:()=>assert.fail('No geometry should be created'),onDiscard:()=>{},
      onAccept:()=>assert.fail('No geometry to accept')});
    await new Promise(resolve=>setImmediate(resolve));
    for(let i=0;i<7;i++){
      await ids.get('aiArgonSmokeRun').fire('click');
      if(i>=4){
        assert.equal(state.state,'running');
        assert.match(ids.get('aiArgonSmokeRun').textContent,/Check running Argon diagnostic/);
        await ids.get('aiArgonSmokeRun').fire('click');
      }
    }
    assert.equal(state.state,'done');
    assert.equal(confirms,7);
    assert.equal(posted.filter(p=>p.action==='argon_diag_step').length,7);
    assert.equal(posted.filter(p=>p.action==='argon_diag_poll').length,3);
    assert.equal(videoObjects,0);
    assert.match(ids.get('aiArgonSmokeSummary').textContent,/All seven Argon API stages passed/);
    assert.equal(ids.get('aiArgonSmokeRun').hidden,true);
  }finally{
    if(beforeDoc===undefined)delete globalThis.document;else globalThis.document=beforeDoc;
    if(beforeFetch===undefined)delete globalThis.fetch;else globalThis.fetch=beforeFetch;
    if(beforeConfirm===undefined)delete globalThis.confirm;else globalThis.confirm=beforeConfirm;
  }
});

test('Failed Argon stage 3 retries directly with explicit paid confirmation, preserving earlier passes',async()=>{
  const beforeDoc=globalThis.document,beforeFetch=globalThis.fetch,beforeConfirm=globalThis.confirm;
  const ids=new Map();let confirmed=0,submitted=[],videoObjects=0;
  let state={step:2,state:'failed'};
  globalThis.document={
    getElementById(id){if(!ids.has(id))ids.set(id,new Element());return ids.get(id);},
    createElement(tag){if(tag==='video')videoObjects++;return new Element();}
  };
  globalThis.confirm=message=>{confirmed++;assert.match(message,/Retry paid Argon diagnostic 3\/7/);return true;};
  globalThis.fetch=async(url,opts={})=>{
    assert.equal(url,'./scene-proxy.php');
    if(!opts.method)return new Response(JSON.stringify({ok:true,authenticated:true,csrf:'fixed-csrf',
      argonJob:null,argonSmoke:state}),{status:200});
    const body=JSON.parse(opts.body);submitted.push(body);
    assert.deepEqual(body,{action:'argon_diag_step',csrf:'fixed-csrf',step:2,retry:true});
    state={step:3,state:'passed'};
    return new Response(JSON.stringify({ok:true,...state,passed:true}),{status:200});
  };
  try{
    const shot={id:'draft_001',start:0,end:6};
    setupAiSceneEditor({getSequence:()=>({shots:[shot]}),getActiveShot:()=>shot,
      getReferenceVideo:()=>({src:'blob:private-client-video'}),getPlayheadTime:()=>1,
      onPreview:()=>assert.fail('no scene generation'),onDiscard:()=>{},onAccept:()=>{}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(ids.get('aiArgonSmokeRun').hidden,false);
    assert.match(ids.get('aiArgonSmokeRun').textContent,/Retry stage 3 \(paid\)/);
    await ids.get('aiArgonSmokeRun').fire('click');
    assert.equal(confirmed,1);
    assert.equal(submitted.length,1);
    assert.equal(state.step,3);
    assert.equal(videoObjects,0);
    assert.match(ids.get('aiArgonSmokeRun').textContent,/Run stage 4 \(paid\)/);
    assert.match(ids.get('aiSceneLog').textContent,/Retrying one paid Argon diagnostic/);
  }finally{
    if(beforeDoc===undefined)delete globalThis.document;else globalThis.document=beforeDoc;
    if(beforeFetch===undefined)delete globalThis.fetch;else globalThis.fetch=beforeFetch;
    if(beforeConfirm===undefined)delete globalThis.confirm;else globalThis.confirm=beforeConfirm;
  }
});

test('every Worker repair code has a plain-words label in the activity log',()=>{
  for(const code of ARGON_REPAIR_CODES){
    const line=describeRepairs({[code]:1});
    assert.match(line,/^Worker validation kept the scene and repaired or dropped: .+ 1\.$/);
    if(code!=='other')assert.doesNotMatch(line,/other rule/,code+' needs a label');
  }
  assert.equal(describeRepairs(null),'');
  assert.equal(describeRepairs({scale:0,repeat:'2'}),'');
});

test('paid Argon starts ask in the page, so a background tab cannot dismiss the question',async()=>{
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch,oldConfirm=globalThis.confirm;
  const jpeg='data:image/jpeg;base64,'+Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');
  // Chrome would suppress window.confirm(); the editor must never rely on it.
  globalThis.confirm=()=>{throw Error('window.confirm must not be used when the page dialog exists');};
  class FakeDialog extends Element{
    constructor(answer){super();this.answer=answer;this.returnValue='x';this.shown=0;}
    showModal(){this.shown++;setTimeout(()=>{this.returnValue=this.answer;this.handlers.get('close')?.();},0);}
  }
  const run=async answer=>{
    const ids=new Map(),actions=[];
    globalThis.document=argonDomHarness(ids,jpeg);
    const dialog=new FakeDialog(answer);ids.set('aiConfirm',dialog);
    globalThis.fetch=async(url,options={})=>{
      if(!options.method)return new Response(JSON.stringify({ok:true,authenticated:true,csrf:'c',argonJob:null}),{status:200});
      const payload=JSON.parse(options.body);actions.push(payload.action);
      return new Response(JSON.stringify(payload.action==='argon_start'
        ?{ok:true,status:'in_progress',shotId:'shot_a'}
        :{ok:true,status:'failed',shotId:'shot_a',diagnostic:{phase:'job',http:null,status:'failed',
          reason:'provider_internal',codes:[],fields:[],terms:[]}}),{status:200});
    };
    const shot={id:'shot_a',start:0,end:6};
    setupAiSceneEditor({getSequence:()=>({shots:[shot]}),getActiveShot:()=>shot,
      getReferenceVideo:()=>({src:'blob:reference'}),getPlayheadTime:()=>2,
      onPreview:()=>{},onDiscard:()=>{},onAccept:()=>{}});
    await new Promise(resolve=>setImmediate(resolve));
    ids.get('aiSceneScope').value='environment';ids.get('aiSceneModel').value='argon_direct';
    await ids.get('aiSceneGenerate').fire('click');
    return {ids,actions,dialog};
  };
  try{
    const cancelled=await run('cancel');
    assert.equal(cancelled.dialog.shown,1);
    assert.match(cancelled.ids.get('aiConfirmText').textContent,/^Settings: medium thinking, Standard detail\. Start EXPERIMENTAL paid Gemini 4 Argon direct-image generation of the FULL SCENE\?/);
    assert.equal(cancelled.ids.get('aiConfirmOk').textContent,'Start paid Argon run');
    assert.deepEqual(cancelled.actions,[],'nothing is sent unless confirmed');
    assert.match(cancelled.ids.get('aiSceneLog').textContent,/Paid request not started: the confirmation was cancelled or dismissed\. Nothing was sent\./);
    // Escape or a dismissed dialog leaves no answer: also not started.
    assert.deepEqual((await run('')).actions,[]);
    const confirmed=await run('ok');
    assert.deepEqual(confirmed.actions,['argon_start','argon_status']);
    assert.doesNotMatch(confirmed.ids.get('aiSceneLog').textContent,/not started/);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    if(oldConfirm===undefined)delete globalThis.confirm;else globalThis.confirm=oldConfirm;
    globalThis.fetch=oldFetch;
  }
});
