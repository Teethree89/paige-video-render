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
    assert.match(ids.get('aiSceneStatus').textContent,/require Primary subject only/);
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
    assert.match(ids.get('aiSceneLog').textContent,/Argon background status: completed/);
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
test('Experimental direct-image Argon discloses stored images, submits once and previews',async()=>{
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch,oldConfirm=globalThis.confirm;
  const ids=new Map(),actions=[];
  const jpeg='data:image/jpeg;base64,'+Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');
  let preview=null,saved=0;
  globalThis.confirm=message=>{
    assert.match(message,/EXPERIMENTAL/);
    assert.match(message,/ONE potentially billable call/);
    assert.match(message,/INCLUDING THE REFERENCE IMAGES/);
    assert.match(message,/one request slot/);
    assert.match(message,/nothing falls back automatically/);
    return true;
  };
  globalThis.document=argonDomHarness(ids,jpeg);
  const scene={schemaVersion:1,scenes:[{shotId:'shot_a',objects:[{
    id:'direct_facade',name:'Facade observed directly',primitive:'box',
    position:[0,2,0],rotation:[0,0,0],scale:[8,4,1],
    material:{color:'#334455',metalness:0,roughness:.6}
  }]}]};
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
    assert.equal(saved,0);
    assert.match(ids.get('aiSceneLog').textContent,/directly to Gemini 4 Argon as one background job/);
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
        codes:['invalid_request'],fields:['model','background']}}),{status:502}));
    assert.deepEqual(rejected.actions,['argon_start'],'No retry, Previs or Flash-Lite fallback');
    assert.match(rejected.log,/Provider diagnostic: create · HTTP 400 · reason media_input_rejected · code invalid_request · fields model, background/);
    const failed=await run('argon_previs',payload=>new Response(JSON.stringify(
      payload.action==='argon_start'?{ok:true,status:'in_progress',shotId:'shot_a'}:
      {ok:true,status:'failed',shotId:'shot_a',diagnostic:{phase:'job',http:null,
        status:'incomplete',reason:'incomplete_output',codes:[],fields:[]}}),{status:200}));
    assert.deepEqual(failed.actions,['argon_start','argon_status']);
    assert.match(failed.log,/Argon job failed on the provider/);
    assert.match(failed.log,/Provider diagnostic: job · incomplete · reason incomplete_output/);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    if(oldConfirm===undefined)delete globalThis.confirm;else globalThis.confirm=oldConfirm;
    globalThis.fetch=oldFetch;
  }
});
test('Paid Argon disallows layered environment before spending or sampling video',async()=>{
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
    assert.match(ids.get('aiSceneStatus').textContent,/require Primary subject only/);
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
