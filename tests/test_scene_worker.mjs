import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{validateInput,validateOutput,secretMatches} from '../worker/scene-worker.mjs';

const token='test-token-should-be-at-least-thirty-two-chars-private';
const image='data:image/jpeg;base64,'+Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');
const sample={shotId:'draft_001',frames:[{at:1.5,imageDataUrl:image}]};
const env={GEMINI_API_KEY:'do-not-print-secret',SCENE_ACCESS_TOKEN:token};
const scene={schemaVersion:1,scenes:[{shotId:'draft_001',objects:[{
  id:'box_1',name:'Rack',primitive:'box',position:[0,1,0],rotation:[0,0,0],scale:[2,2,2],
  material:{color:'#123456',metalness:.2,roughness:.5}
}]}]};
test('health endpoint reports true readiness without exposing secret details',async()=>{
  const healthy=await worker.fetch(new Request('https://example.workers.dev/health'),env);
  assert.equal(healthy.status,200);
  assert.deepEqual(await healthy.json(),{ok:true,service:'paige-scene',ready:true,model:'gemini-3.5-flash-lite',generationProfile:'layered-environment-v1',workerRevision:'argon-json-schema-validation-v1',supportedModels:['gemini-3.5-flash-lite','gemini-3.8-flash'],supportedProfiles:['lite_default','g38_low','g38_medium','argon_previs']});
  const unavailable=await worker.fetch(new Request('https://example.workers.dev/health'),{});
  assert.equal(unavailable.status,503);
  const body=await unavailable.text();
  assert.deepEqual(JSON.parse(body),{ok:false,service:'paige-scene',ready:false,model:'gemini-3.5-flash-lite',generationProfile:'layered-environment-v1',workerRevision:'argon-json-schema-validation-v1',supportedModels:['gemini-3.5-flash-lite','gemini-3.8-flash'],supportedProfiles:['lite_default','g38_low','g38_medium','argon_previs']});
  assert.ok(!body.includes('GEMINI_API_KEY')&&!body.includes('SCENE_ACCESS_TOKEN'));
});
test('worker rejects incorrect secrets and unrelated paths',async()=>{
  const missing=await worker.fetch(new Request('https://example.workers.dev/api/scene',{method:'POST',body:JSON.stringify(sample)}),env);
  assert.equal(missing.status,401);
  const other=await worker.fetch(new Request('https://example.workers.dev/private'),env);
  assert.equal(other.status,404);
  assert.equal(secretMatches(token,token),true);
  assert.equal(secretMatches(token,token+'x'),false);
});
test('worker accepts only limited JPEG data and the correct shot ID',()=>{
  assert.equal(validateInput(sample).shotId,'draft_001');
  assert.equal(validateInput(sample).mode,'environment');
  assert.equal(validateInput(sample).model,'gemini-3.5-flash-lite');
  assert.equal(validateInput(sample).profile,'lite_default');
  assert.equal(validateInput({...sample,profile:'lite_default'}).model,'gemini-3.5-flash-lite');
  assert.equal(validateInput({...sample,profile:'g38_low'}).model,'gemini-3.8-flash');
  assert.equal(validateInput({...sample,profile:'g38_medium',mode:'primary_subject'}).model,'gemini-3.8-flash');
  assert.equal(validateInput({...sample,model:'gemini-3.8-flash'}).profile,'g38_low');
  assert.throws(()=>validateInput({...sample,profile:'g38_medium'}),/primary-subject/);
  assert.throws(()=>validateInput({...sample,profile:'g38_medium',mode:'primary_subject',layer:'structures'}),/mode|primary-subject/);
  assert.throws(()=>validateInput({...sample,profile:'g38_medium',mode:'primary_subject',model:'gemini-3.8-flash'}),/profile/);
  assert.throws(()=>validateInput({...sample,profile:'gemini-4-argon'}),/profile/);
  assert.throws(()=>validateInput({...sample,profile:123}),/profile/);
  assert.equal(validateInput({...sample,model:'gemini-3.8-flash'}).model,'gemini-3.8-flash');
  assert.throws(()=>validateInput({...sample,model:'gemini-4-argon'}),/model/);
  assert.throws(()=>validateInput({...sample,model:'https://example.com/'}),/model/);
  assert.throws(()=>validateInput({...sample,model:14}),/model/);
  assert.equal(validateInput({...sample,mode:'primary_subject'}).mode,'primary_subject');
  assert.throws(()=>validateInput({...sample,mode:'untrusted-model'}),/mode/);
  assert.throws(()=>validateInput({...sample,mode:'primary_subject',layer:'structures'}),/mode/);
  assert.throws(()=>validateInput({...sample,shotId:'../x'}),/Invalid shot/);
  assert.throws(()=>validateInput({...sample,frames:Array(4).fill(sample.frames[0])}),/Invalid frame count/);
  assert.throws(()=>validateInput({...sample,frames:[{at:1,imageDataUrl:'https://evil.test/a.jpg'}]}),/JPEG/);
});
test('Argon Previs background accepts bounded primary frames and polls validated JSON',async()=>{
  const prior=globalThis.fetch;let calls=0;
  const id='v1_C1234567890opaque';
  const provider={
    id,status:'completed',steps:[{type:'user_input',content:[{type:'text',text:'SECRET_INPUT'}]},
      {type:'model_output',content:[{type:'text',text:JSON.stringify(scene)}]}]
  };
  globalThis.fetch=async (url,opts)=>{
    calls++;
    if(calls===1){
      assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions');
      assert.equal(opts.method,'POST');
      assert.equal(opts.headers['x-goog-api-key'],env.GEMINI_API_KEY);
      assert.equal(opts.headers['Api-Revision'],'2026-05-20');
      const data=JSON.parse(opts.body);
      assert.equal(data.model,'gemini-4-argon');
      assert.equal(data.background,true);
      assert.equal(data.store,true);
      assert.equal(data.generation_config.max_output_tokens,32768);
      assert.equal(data.generation_config.thinking_level,'medium');
      assert.equal(data.response_format.type,'text');
      assert.equal(data.response_format.mime_type,'application/json');
      const schema=data.response_format.schema;
      assert.deepEqual(schema.required,['schemaVersion','scenes']);
      assert.equal(schema.properties.schemaVersion.type,'integer');
      const sceneShape=schema.properties.scenes.items;
      assert.deepEqual(sceneShape.required,['shotId','objects']);
      const primitive=sceneShape.properties.objects.items;
      assert.ok(primitive.required.includes('material'));
      assert.deepEqual(primitive.properties.primitive.enum,
        ['box','sphere','cylinder','plane','torus']);
      assert.ok(primitive.required.includes('scale'));
      assert.ok(!JSON.stringify(schema).includes('maxItems'),
        'Do not impose nested array limits in provider schema; local validator enforces 48 objects');
      assert.ok(data.input.some(p=>p.type==='image'&&p.mime_type==='image/jpeg'));
      assert.match(data.input[0].text,/PREVIS \/ RUNWAY PREP/);
      assert.match(data.input[0].text,/PRIMARY SUBJECT/);
      assert.ok(!data.input[0].text.includes('SECRET_INPUT'));
      return new Response(JSON.stringify({id,status:'queued'}),{status:200});
    }
    assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions/'+id);
    assert.equal(opts.headers['x-goog-api-key'],env.GEMINI_API_KEY);
    return new Response(JSON.stringify(provider),{status:200});
  };
  try{
    const post=(path,body)=>worker.fetch(new Request('https://example.workers.dev'+path,{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify(body)
    }),env);
    const start=await post('/api/scene/argon/start',{
      ...sample,profile:'argon_previs',mode:'primary_subject'
    });
    assert.equal(start.status,200);
    assert.deepEqual(await start.json(),{ok:true,jobId:id,status:'queued'});
    const poll=await post('/api/scene/argon/status',{jobId:id,shotId:'draft_001'});
    assert.equal(poll.status,200);
    assert.deepEqual(await poll.json(),{ok:true,status:'completed',proposal:scene});
    assert.equal(calls,2);
  }finally{globalThis.fetch=prior;}
});
test('Argon 400 diagnostics classify only allowlisted field names and never expose provider body',async()=>{
  const priorFetch=globalThis.fetch,priorWarn=console.warn;
  const samples=[
    ['Invalid response_format JSON schema', 'Argon rejected output format configuration','output_format'],
    ['Invalid generation_config.thinking_level', 'Argon rejected generation configuration','generation_config'],
    ['Unsupported image mime_type', 'Argon rejected image input configuration','image_input'],
    ['background not supported', 'Argon rejected background execution configuration','background'],
    ['Unsupported model setting', 'Argon rejected model configuration','model'],
    ['Request contains an invalid argument.', 'Argon rejected Interactions request','unknown']
  ];
  let calls=0;const logs=[];
  console.warn=(...args)=>logs.push(args);
  try{
    for(const [message,expected,category] of samples){
      globalThis.fetch=async()=>{
        calls++;
        return new Response(JSON.stringify({
          error:{code:'invalid_request',message:message+' PRIVATE_KEY_DO_NOT_LOG'},
          extra:{input:'PRIVATE_FRAME_DATA'}
        }),{status:400});
      };
      const response=await worker.fetch(new Request('https://example.workers.dev/api/scene/argon/start',{
        method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify({...sample,profile:'argon_previs',mode:'primary_subject'})
      }),env);
      assert.equal(response.status,502);
      const raw=await response.text();
      assert.deepEqual(JSON.parse(raw),{ok:false,error:expected});
      assert.ok(!raw.includes('PRIVATE_KEY_DO_NOT_LOG'));
      assert.ok(!raw.includes('PRIVATE_FRAME_DATA'));
      assert.deepEqual(logs.at(-1),['argon-request-400-category',category]);
    }
    assert.equal(calls,samples.length,'400 must never trigger another paid generation attempt');
    assert.ok(!JSON.stringify(logs).includes('PRIVATE_KEY_DO_NOT_LOG'));
    assert.ok(!JSON.stringify(logs).includes('PRIVATE_FRAME_DATA'));
    assert.ok(!JSON.stringify(logs).includes(env.GEMINI_API_KEY));
  }finally{globalThis.fetch=priorFetch;console.warn=priorWarn;}
});
test('Argon stays strictly primary-only, with safe failures and no arbitrary job URL',async()=>{
  const before=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({
    id:'v1_12345678',status:'in_progress'}),{status:200});};
  try{
    const post=async(path,body,authorized=true)=>worker.fetch(new Request(
      'https://example.workers.dev'+path,{method:'POST',
      headers:{'Authorization':'Bearer '+(authorized?token:'invalid'),
        'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
    for(const body of [
      {...sample,mode:'environment',profile:'argon_previs'},
      {...sample,mode:'primary_subject',profile:'argon_previs',layer:'structures'},
      {...sample,mode:'primary_subject',profile:'g38_medium'},
      {...sample,mode:'primary_subject',profile:'argon_previs',model:'gemini-4-argon'}
    ]){
      const result=await post('/api/scene/argon/start',body);
      assert.equal(result.status,400);
    }
    assert.equal((await post('/api/scene/argon/start',
      {...sample,mode:'primary_subject',profile:'argon_previs'},false)).status,401);
    const forged=await post('/api/scene/argon/status',{jobId:'https://evil.com/a',shotId:'draft_001'});
    assert.equal(forged.status,400);
    assert.equal(calls,0);
  }finally{globalThis.fetch=before;}
});
test('Argon polling does not leak provider thoughts or malformed output',async()=>{
  const prior=globalThis.fetch;const id='v1_123456789';
  globalThis.fetch=async()=>new Response(JSON.stringify({
    id,status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'<bad>'}]},
      {type:'thinking',content:[{type:'text',text:'SENSITIVE_PRIVATE_THOUGHT'}]}]
  }),{status:200});
  try{
    const result=await worker.fetch(new Request('https://example.workers.dev/api/scene/argon/status',{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify({jobId:id,shotId:'draft_001'})
    }),env);
    assert.equal(result.status,502);
    const raw=await result.text();
    assert.ok(!raw.includes('SENSITIVE_PRIVATE_THOUGHT'));
    assert.deepEqual(JSON.parse(raw),{ok:false,error:'Provider scene did not match the editor schema'});
  }finally{globalThis.fetch=prior;}
});

test('worker rejects script primitives and unsupported transforms',()=>{
  assert.equal(validateOutput(scene,'draft_001').scenes[0].objects.length,1);
  assert.throws(()=>validateOutput(scene,'draft_002'),/shot/);
  const malicious=structuredClone(scene);
  malicious.scenes[0].objects[0].primitive='javascript';
  assert.throws(()=>validateOutput(malicious,'draft_001'),/Unsupported/);
  const bad=structuredClone(scene);
  bad.scenes[0].objects[0].position[1]=Infinity;
  assert.throws(()=>validateOutput(bad,'draft_001'),/transform/);
});
test('detailed 36-object geometry is accepted, 37th is rejected, and source is never mutated',()=>{
  const dense=structuredClone(scene);
  dense.scenes[0].objects=Array.from({length:36},(_,i)=>({
    ...structuredClone(scene.scenes[0].objects[0]),
    id:'detail_'+i,name:'Architectural part '+i,
    position:[i%6,1,Math.floor(i/6)]
  }));
  const before=structuredClone(dense);
  const parsed=validateOutput(dense,'draft_001');
  assert.equal(parsed.scenes[0].objects.length,36);
  assert.deepEqual(dense,before);
  const tooMany=structuredClone(dense);
  tooMany.scenes[0].objects.push({...structuredClone(dense.scenes[0].objects[0]),id:'detail_36'});
  assert.throws(()=>validateOutput(tooMany,'draft_001'),/object budget/);
});
test('authorized request returns valid primitive JSON and keeps API key out of output',async()=>{
  const previous=globalThis.fetch;
  let providerInvoked=false;
  globalThis.fetch=async (_url,opts)=>{
    assert.equal(_url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    assert.equal(opts.method,'POST');
    assert.equal(JSON.parse(opts.body).generationConfig.responseMimeType,'application/json');
    assert.equal('temperature' in JSON.parse(opts.body).generationConfig,false,'Gemini 3.x ignores deprecated temperature');
    providerInvoked=true;
    assert.ok(opts.headers['x-goog-api-key']===env.GEMINI_API_KEY);
    assert.ok(opts.body.includes('inlineData'));
    assert.equal(JSON.parse(opts.body).generationConfig.maxOutputTokens,7500);
    assert.equal(JSON.parse(opts.body).generationConfig.thinkingConfig,undefined,'Lite retains its original reasoning defaults');
    const prompt=JSON.parse(opts.body).contents[0].parts[0].text;
    assert.match(prompt,/architectural and environment blockout artist/);
    assert.match(prompt,/observed footprint/);
    assert.match(prompt,/recognizable silhouette/);
    assert.match(prompt,/three chronological video frames/);

    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(scene)}]}}]}),{
      status:200,headers:{'content-type':'application/json'}
    });
  };
  try {
    const res=await worker.fetch(new Request('https://example.workers.dev/api/scene',{
      method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify(sample)
    }),env);
    assert.equal(res.status,200);
    const body=await res.text();
    assert.ok(providerInvoked);
    assert.deepEqual(JSON.parse(body),scene);
    assert.ok(!body.includes(env.GEMINI_API_KEY));
    assert.ok(!body.includes(token));
  }finally{globalThis.fetch=previous;}
});

test('3.8 Flash uses existing key and schema without model fallback in both generation modes',async()=>{
  const previous=globalThis.fetch;
  const seen=[];
  globalThis.fetch=async(url,options)=>{
    seen.push({url,body:JSON.parse(options.body)});
    assert.equal(options.headers['x-goog-api-key'],env.GEMINI_API_KEY);
    return new Response(JSON.stringify({
      candidates:[{content:{parts:[{text:JSON.stringify(scene)}]}}]
    }),{status:200,headers:{'content-type':'application/json'}});
  };
  try{
    for(const input of [
      {...sample,mode:'primary_subject',model:'gemini-3.8-flash'},
      {...sample,layer:'structures',existing:[],model:'gemini-3.8-flash'}
    ]){
      const response=await worker.fetch(new Request('https://example.workers.dev/api/scene',{
        method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify(input)
      }),env);
      assert.equal(response.status,200);
      const data=await response.json();
      assert.equal(data.scenes[0].shotId,'draft_001');
    }
    assert.equal(seen.length,2);
    assert.ok(seen.every(x=>x.url.endsWith('/gemini-3.8-flash:generateContent')));
    assert.equal(seen[0].body.generationConfig.maxOutputTokens,9500);
    assert.equal(seen[1].body.generationConfig.maxOutputTokens,6500);
    assert.deepEqual(seen[0].body.generationConfig.thinkingConfig,{thinkingLevel:'low'});
    assert.deepEqual(seen[1].body.generationConfig.thinkingConfig,{thinkingLevel:'low'});
    assert.ok(seen.every(x=>x.body.generationConfig.responseMimeType==='application/json'));
    assert.ok(seen.every(x=>!('temperature' in x.body.generationConfig)));
    assert.match(seen[0].body.contents[0].parts[0].text,/PRIMARY SUBJECT — HIGH-DETAIL/);
    assert.match(seen[1].body.contents[0].parts[0].text,/LAYERED FULL-ENVIRONMENT/);
    assert.ok(!JSON.stringify(seen).includes(env.GEMINI_API_KEY));
  }finally{globalThis.fetch=previous;}
});

test('Medium 3.8 profile keeps detailed primary prompt but uses 70s deadline',async()=>{
  const previousFetch=globalThis.fetch;
  const originalTimeout=AbortSignal.timeout;
  const deadlines=[];
  AbortSignal.timeout=(milliseconds)=>{
    deadlines.push(milliseconds);
    return originalTimeout(milliseconds);
  };
  let called=0;
  globalThis.fetch=async(url,options)=>{
    called++;
    assert.ok(url.endsWith('/gemini-3.8-flash:generateContent'));
    const request=JSON.parse(options.body);
    assert.equal(request.generationConfig.maxOutputTokens,9500);
    assert.deepEqual(request.generationConfig.thinkingConfig,{thinkingLevel:'medium'});
    assert.match(request.contents[0].parts[0].text,/PRIMARY SUBJECT — HIGH-DETAIL/);
    return new Response(JSON.stringify({
      candidates:[{content:{parts:[{text:JSON.stringify(scene)}]}}]
    }),{status:200});
  };
  try{
    const response=await worker.fetch(new Request('https://example.workers.dev/api/scene',{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify({...sample,mode:'primary_subject',profile:'g38_medium'})
    }),env);
    assert.equal(response.status,200);
    assert.equal((await response.json()).scenes[0].objects.length,1);
    assert.deepEqual(deadlines,[70000]);
    assert.equal(called,1);
  }finally{
    globalThis.fetch=previousFetch;
    AbortSignal.timeout=originalTimeout;
  }
});

test('Medium 3.8 profile uses explicit 70-second timeout error without leaking secrets',async()=>{
  const previousFetch=globalThis.fetch;
  const previousWarn=console.warn;
  const messages=[];
  console.warn=(...args)=>messages.push(args);
  globalThis.fetch=async()=>{throw Object.assign(new Error('PRIVATE '+env.GEMINI_API_KEY),{name:'TimeoutError'});};
  try{
    const response=await worker.fetch(new Request('https://example.workers.dev/api/scene',{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify({...sample,mode:'primary_subject',profile:'g38_medium'})
    }),env);
    assert.equal(response.status,504);
    assert.deepEqual(await response.json(),{ok:false,error:'AI provider extended request timed out'});
    assert.ok(!JSON.stringify(messages).includes(env.GEMINI_API_KEY));
  }finally{globalThis.fetch=previousFetch;console.warn=previousWarn;}
});

test('primary-subject mode uses the detailed prompt, 9500-token budget and validates 48 shapes',async()=>{
  const previous=globalThis.fetch;
  const dense=structuredClone(scene);
  dense.scenes[0].objects=Array.from({length:48},(_,i)=>({
    ...structuredClone(scene.scenes[0].objects[0]),
    id:'observed_part_'+i,
    name:'Observed architectural part '+i,
    position:[i%8,1,Math.floor(i/8)]
  }));
  let called=0;
  globalThis.fetch=async (_url,opts)=>{
    const request=JSON.parse(opts.body);
    assert.match(request.contents[0].parts[0].text,/PRIMARY SUBJECT — HIGH-DETAIL PRIMITIVE RECONSTRUCTION/);
    assert.match(request.contents[0].parts[0].text,/SINGLE dominant visible subject/);
    assert.equal(request.generationConfig.maxOutputTokens,9500);
    called++;
    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(dense)}]}}]}),{status:200});
  };
  try{
    const response=await worker.fetch(new Request('https://example.workers.dev/api/scene',{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify({...sample,mode:'primary_subject'})
    }),env);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),dense);
    assert.equal(called,1);
  }finally{globalThis.fetch=previous;}
});

test('legacy subject mode still rejects more than 36 objects',async()=>{
  const previous=globalThis.fetch;
  const dense=structuredClone(scene);
  dense.scenes[0].objects=Array.from({length:37},(_,i)=>({
    ...structuredClone(scene.scenes[0].objects[0]),id:'part_'+i
  }));
  globalThis.fetch=async()=>new Response(JSON.stringify({
    candidates:[{content:{parts:[{text:JSON.stringify(dense)}]}}]
  }),{status:200});
  try{
    const response=await worker.fetch(new Request('https://example.workers.dev/api/scene',{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify(sample)
    }),env);
    assert.equal(response.status,502);
    assert.deepEqual(await response.json(),{ok:false,error:'Provider scene did not match the editor schema'});
  }finally{globalThis.fetch=previous;}
});

test('Gemini fetch timeout and network failures are safely distinguished',async()=>{
  const priorFetch=globalThis.fetch;
  const priorWarn=console.warn;
  const logs=[];
  console.warn=(...args)=>logs.push(args);
  try{
    for(const [name,status,message,kind] of [
      ['TimeoutError',504,'AI provider request timed out','timeout'],
      ['TypeError',502,'AI provider network connection failed','network-failure']
    ]){
      globalThis.fetch=async()=>{throw Object.assign(new Error('SENSITIVE '+env.GEMINI_API_KEY+' '+token),{name});};
      const res=await worker.fetch(new Request('https://example.workers.dev/api/scene',{
        method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify(sample)
      }),env);
      assert.equal(res.status,status);
      const body=await res.text();
      assert.deepEqual(JSON.parse(body),{ok:false,error:message});
      assert.ok(!body.includes(env.GEMINI_API_KEY)&&!body.includes(token));
      assert.equal(logs.at(-1)[0],'gemini-upstream-fetch');
      assert.equal(logs.at(-1)[1],kind);
    }
    assert.ok(!JSON.stringify(logs).includes(env.GEMINI_API_KEY));
    assert.ok(!JSON.stringify(logs).includes(token));
  }finally{
    globalThis.fetch=priorFetch;
    console.warn=priorWarn;
  }
});

test('Transient Gemini 503 gets exactly one retry and returns accepted scene',async()=>{
  const previous=globalThis.fetch;
  const previousWarn=console.warn;
  const logs=[];
  let attempts=0;
  console.warn=(...args)=>logs.push(args);
  globalThis.fetch=async ()=>{
    attempts++;
    if(attempts===1)return new Response(
      JSON.stringify({error:'SENSITIVE_PROVIDER_DATA'}),{status:503});
    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(scene)}]}}]}),{
      status:200,headers:{'content-type':'application/json'}
    });
  };
  try{
    const response=await worker.fetch(new Request('https://example.workers.dev/api/scene',{
      method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify(sample)
    }),env);
    assert.equal(attempts,2);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),scene);
    assert.equal(logs.length,1);
    assert.deepEqual(logs[0].slice(0,3),['gemini-provider-http',503,'attempt-1']);
    assert.ok(!JSON.stringify(logs).includes('SENSITIVE_PROVIDER_DATA'));
  }finally{
    globalThis.fetch=previous;
    console.warn=previousWarn;
  }
});

test('Medium 3.8 retries upstream 503 twice with bounded exponential backoff',async()=>{
  const previousFetch=globalThis.fetch;
  const previousWarn=console.warn;
  const logs=[];
  let attempts=0;
  console.warn=(...args)=>logs.push(args);
  globalThis.fetch=async(url,options)=>{
    attempts++;
    assert.ok(url.endsWith('/gemini-3.8-flash:generateContent'));
    assert.deepEqual(JSON.parse(options.body).generationConfig.thinkingConfig,{thinkingLevel:'medium'});
    if(attempts<=2)return new Response(
      JSON.stringify({error:'PRIVATE_PROVIDER_MESSAGE_DO_NOT_RELAY'}),{status:503});
    return new Response(JSON.stringify({
      candidates:[{content:{parts:[{text:JSON.stringify(scene)}]}}]
    }),{status:200});
  };
  try{
    const response=await worker.fetch(new Request('https://example.workers.dev/api/scene',{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify({...sample,mode:'primary_subject',profile:'g38_medium'})
    }),env);
    assert.equal(response.status,200);
    assert.equal(attempts,3);
    assert.deepEqual(await response.json(),scene);
    assert.deepEqual(logs.map(x=>x.slice(0,3)),[
      ['gemini-provider-http',503,'attempt-1'],
      ['gemini-provider-http',503,'attempt-2']
    ]);
    assert.ok(!JSON.stringify(logs).includes('PRIVATE_PROVIDER_MESSAGE_DO_NOT_RELAY'));
    assert.ok(!JSON.stringify(logs).includes(env.GEMINI_API_KEY));
  }finally{globalThis.fetch=previousFetch;console.warn=previousWarn;}
});

test('Medium persistent provider 503 returns safe overload category after 3 attempts',async()=>{
  const previousFetch=globalThis.fetch;
  const previousWarn=console.warn;
  const events=[];
  let attempts=0;
  console.warn=(...args)=>events.push(args);
  globalThis.fetch=async()=>{attempts++;return new Response(
    JSON.stringify({error:'PRIVATE_PROVIDER_MESSAGE_DO_NOT_RELAY'}),{status:503});
  };
  try{
    const response=await worker.fetch(new Request('https://example.workers.dev/api/scene',{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify({...sample,mode:'primary_subject',profile:'g38_medium'})
    }),env);
    assert.equal(response.status,502);
    assert.equal(attempts,3);
    assert.deepEqual(await response.json(),{ok:false,error:'AI provider capacity unavailable'});
    assert.equal(events.length,3);
    assert.ok(!JSON.stringify(events).includes('PRIVATE_PROVIDER_MESSAGE_DO_NOT_RELAY'));
  }finally{globalThis.fetch=previousFetch;console.warn=previousWarn;}
});

test('Gemini failure statuses are classified without relaying raw provider errors',async()=>{
  const cases=[
    [400,502,'AI provider rejected request format'],
    [401,502,'AI provider authentication or permission failed'],
    [403,502,'AI provider authentication or permission failed'],
    [404,502,'Requested AI model is unavailable'],
    [422,502,'AI provider rejected request format'],
    [429,429,'Provider rate limit reached'],
    [500,502,'AI provider temporarily unavailable'],
    [503,502,'AI provider capacity unavailable'],
    [418,502,'AI provider refused the request']
  ];
  const previous=globalThis.fetch;
  try{
    for(const [providerStatus,workerStatus,workerError] of cases){
      globalThis.fetch=async (url)=> {
        assert.equal(url,
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
        return new Response(
        JSON.stringify({error:'PRIVATE_PROVIDER_ACCOUNT_DETAILS_DO_NOT_RELAY'}),
        {status:providerStatus,headers:{'content-type':'application/json'}}
      );
      };
      const result=await worker.fetch(new Request('https://example.workers.dev/api/scene',{
        method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify(sample)
      }),env);
      assert.equal(result.status,workerStatus);
      const raw=await result.text();
      assert.deepEqual(JSON.parse(raw),{ok:false,error:workerError});
      assert.ok(!raw.includes('PRIVATE_PROVIDER_ACCOUNT_DETAILS_DO_NOT_RELAY'));
      assert.ok(!raw.includes(env.GEMINI_API_KEY));
      assert.ok(!raw.includes(token));
    }
  }finally{globalThis.fetch=previous;}
});
