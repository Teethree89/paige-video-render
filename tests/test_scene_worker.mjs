import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker,{validateInput,validateOutput,secretMatches} from '../worker/scene-worker.mjs';

const token='test-token-should-be-at-least-thirty-two-chars-private';
const image='data:image/jpeg;base64,'+Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');
const sample={shotId:'draft_001',frames:[{at:1.5,imageDataUrl:image}]};
const env={GEMINI_API_KEY:'do-not-print-secret',SCENE_ACCESS_TOKEN:token};
const scene={schemaVersion:1,scenes:[{shotId:'draft_001',objects:[{
  id:'box_1',name:'Rack',primitive:'box',position:[0,1,0],rotation:[0,0,0],scale:[2,2,2],
  material:{color:'#123456',metalness:.2,roughness:.5}
}]}]};
const visualAnalysis={
  subject:'Blue equipment rack',composition:'Primary frame: left of center, three-quarter front view',
  palette:'Blue #123456 panels with silver trim',cameraMotion:'At 1.5s the side is visible; later views confirm depth',
  uncertainties:'Back panel is hidden; absolute scale is unknown',
  parts:[{name:'Rack',shape:'Upright box',placement:'On the ground at center',
    proportions:'Width equals height and depth',appearance:'Blue #123456 metal, roughness about 0.5'}]
};
const analysisResult=(value=visualAnalysis)=>({status:'completed',steps:[
  {type:'user_input',content:[{type:'image',data:'PRIVATE_IMAGE_BYTES'}]},
  {type:'thought',content:[{type:'text',text:'PRIVATE_THOUGHT'}]},
  {type:'model_output',content:[{type:'text',text:JSON.stringify(value)}]}
]});
test('health endpoint reports true readiness without exposing secret details',async()=>{
  const healthy=await worker.fetch(new Request('https://example.workers.dev/health'),env);
  assert.equal(healthy.status,200);
  assert.deepEqual(await healthy.json(),{ok:true,service:'paige-scene',ready:true,model:'gemini-3.5-flash-lite',generationProfile:'layered-environment-v1',workerRevision:'argon-workerd-redirect-manual-v1',supportedModels:['gemini-3.5-flash-lite','gemini-3.8-flash'],supportedProfiles:['lite_default','g38_low','g38_medium','argon_previs']});
  const unavailable=await worker.fetch(new Request('https://example.workers.dev/health'),{});
  assert.equal(unavailable.status,503);
  const body=await unavailable.text();
  assert.deepEqual(JSON.parse(body),{ok:false,service:'paige-scene',ready:false,model:'gemini-3.5-flash-lite',generationProfile:'layered-environment-v1',workerRevision:'argon-workerd-redirect-manual-v1',supportedModels:['gemini-3.5-flash-lite','gemini-3.8-flash'],supportedProfiles:['lite_default','g38_low','g38_medium','argon_previs']});
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
test('Argon reconstructs via synchronous visual evidence and text-only background when background images return 400',async()=>{
  const prior=globalThis.fetch;let calls=0;
  let outputBudget=0;
  const frames=[{at:1.5,imageDataUrl:image},{at:0,imageDataUrl:image},{at:3,imageDataUrl:image}];
  const id='v1_C1234567890opaque';
  const provider={
    id,status:'completed',steps:[{type:'user_input',content:[{type:'text',text:'SECRET_INPUT'}]},
      {type:'model_output',content:[{type:'text',text:JSON.stringify(scene)}]}]
  };
  globalThis.fetch=async (url,opts)=>{
    calls++;
    if(calls<=2){
      assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions');
      assert.equal(opts.method,'POST');
      assert.equal(opts.headers['x-goog-api-key'],env.GEMINI_API_KEY);
      assert.equal(opts.headers['Api-Revision'],'2026-05-20');
      const data=JSON.parse(opts.body);
      assert.equal(data.model,'gemini-4-argon');
      assert.equal(opts.redirect,'manual','Cloudflare workerd rejects redirect:error before fetching');
      assert.equal(opts.signal instanceof AbortSignal,true);
      outputBudget+=data.generation_config.max_output_tokens;
      // Reproduce the observed provider restriction, rather than accepting
      // the very payload that previously failed in the live service.
      if(data.background&&Array.isArray(data.input)&&data.input.some(p=>p.type==='image'))
        return new Response('{"error":{"message":"Provider rejected request"}}',{status:400});
      if(calls===1){
        assert.equal(data.background,false);
        assert.equal(data.store,false);
        assert.equal(data.generation_config.thinking_level,'low');
        assert.equal(data.generation_config.max_output_tokens,4096);
        assert.equal(data.response_format.mime_type,'application/json');
        assert.ok(data.response_format.schema.required.includes('parts'));
        assert.match(data.input[0].text,/FIRST supplied frame/);
        assert.match(data.input[0].text,/silhouette/);
        assert.deepEqual(data.input.slice(1),frames.flatMap(frame=>[
          {type:'text',text:'Reference frame at '+frame.at.toFixed(3)+' seconds'},
          {type:'image',data:frame.imageDataUrl.split(',')[1],mime_type:'image/jpeg'}
        ]));
        return new Response(JSON.stringify(analysisResult({...visualAnalysis,
          privateMetadata:'PRIVATE_PROVIDER_METADATA'})),{status:200});
      }
      assert.equal(data.background,true);
      assert.equal(data.store,true);
      assert.equal(data.generation_config.max_output_tokens,28672);
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
      assert.equal(typeof data.input,'string');
      assert.deepEqual(JSON.parse(data.input),visualAnalysis,'Preserve each bounded visual detail');
      assert.equal(data.previous_interaction_id,undefined,'Do not reintroduce images through history');
      assert.match(data.system_instruction,/PREVIS \/ RUNWAY PREP/);
      assert.match(data.system_instruction,/PRIMARY SUBJECT/);
      assert.match(data.system_instruction,/untrusted descriptive data/);
      assert.match(data.system_instruction,/draft_001/);
      assert.ok(!opts.body.includes('PRIVATE_'));
      assert.ok(!opts.body.includes(image.split(',')[1]));
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
      ...sample,frames,profile:'argon_previs',mode:'primary_subject'
    });
    assert.equal(start.status,200);
    assert.deepEqual(await start.json(),{ok:true,jobId:id,status:'queued'});
    const poll=await post('/api/scene/argon/status',{jobId:id,shotId:'draft_001'});
    assert.equal(poll.status,200);
    assert.deepEqual(await poll.json(),{ok:true,status:'completed',proposal:scene});
    assert.equal(calls,3,'Two paid creates, then a GET-only poll');
    assert.equal(outputBudget,32768,'Keep the previous combined thinking/output allowance');
  }finally{globalThis.fetch=prior;}
});

test('Argon uses workerd-compatible fetch options and never follows provider redirects',async()=>{
  const previous=globalThis.fetch,previousWarn=console.warn;
  const body={...sample,profile:'argon_previs',mode:'primary_subject'};
  const request=()=>new Request('https://example.workers.dev/api/scene/argon/start',{
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  const logs=[];console.warn=(...args)=>logs.push(args);
  try{
    for(const stage of [1,2]){
      for(const redirectCode of [301,302,307,308]){
        let calls=0;
        globalThis.fetch=async(_url,opts)=>{
          calls++;
          // Simulates workerd's actual behavior, unlike Node's permissive fetch.
          if(opts.redirect==='error')throw new TypeError('Invalid redirect value PRIVATE_SECRET');
          assert.equal(opts.redirect,'manual','Never auto-follow provider redirects');
          assert.equal(opts.method,'POST');
          assert.ok(opts.signal instanceof AbortSignal);
          if(calls<stage)return new Response(JSON.stringify(analysisResult()));
          return new Response(null,{status:redirectCode,
            headers:{Location:'https://attacker.example/PRIVATE_SECRET'}});
        };
        const response=await worker.fetch(request(),env);
        assert.equal(response.status,502);
        assert.deepEqual(await response.json(),{ok:false,error:'Argon provider redirect blocked'});
        assert.equal(calls,stage,'No second paid request after a redirect');
      }
    }
    for(const [name,expected] of [
      ['TypeError','runtime-type-or-network'],
      ['TimeoutError','timeout-or-abort'],
      ['NetworkError','other-fetch-failure']
    ]){
      globalThis.fetch=async()=>{throw Object.assign(
        new Error('PRIVATE_SECRET '+env.GEMINI_API_KEY+' '+token),{name}
      );};
      const response=await worker.fetch(request(),env);
      assert.deepEqual(await response.json(),
        {ok:false,error:'Argon reference analysis unavailable'});
      assert.deepEqual(logs.at(-1),['argon-provider-fetch','visual-analysis',expected]);
    }
    assert.ok(!JSON.stringify(logs).includes('PRIVATE_SECRET'));
    assert.ok(!JSON.stringify(logs).includes(env.GEMINI_API_KEY));
    assert.ok(!JSON.stringify(logs).includes(token));
  }finally{globalThis.fetch=previous;console.warn=previousWarn;}
});
test('Argon rejects incomplete, malformed, oversized or unbounded analysis before paying for background generation',async()=>{
  const prior=globalThis.fetch;let calls=0;
  const invalid=[
    {...analysisResult(),status:'in_progress'},
    {...analysisResult(),status:'failed'},
    {status:'completed',steps:{}},
    {status:'completed',steps:[{type:'thought',content:[{type:'text',text:JSON.stringify(visualAnalysis)}]}]},
    {status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'x'.repeat(24001)}]}]},
    {status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'not JSON PRIVATE_INPUT'}]}]},
    analysisResult(null),analysisResult('OK'),analysisResult({}),
    analysisResult({...visualAnalysis,subject:' '}),
    analysisResult({...visualAnalysis,composition:'x'.repeat(2001)}),
    analysisResult({...visualAnalysis,parts:[]}),
    analysisResult({...visualAnalysis,parts:Array(33).fill(visualAnalysis.parts[0])}),
    analysisResult({...visualAnalysis,parts:[{...visualAnalysis.parts[0],placement:1}]}),
    analysisResult({...visualAnalysis,parts:[{...visualAnalysis.parts[0],appearance:'x'.repeat(601)}]})
  ];
  try{
    for(const result of invalid){
      const before=calls;
      globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify(result));};
      const response=await worker.fetch(new Request('https://example.workers.dev/api/scene/argon/start',{
        method:'POST',headers:{Authorization:'Bearer '+token},
        body:JSON.stringify({...sample,profile:'argon_previs',mode:'primary_subject'})
      }),env);
      assert.equal(response.status,502);
      assert.deepEqual(await response.json(),{ok:false,error:'Argon reference analysis invalid'});
      assert.equal(calls,before+1,'Failed analysis must not create/retry a background job');
    }
  }finally{globalThis.fetch=prior;}
});

test('Argon never retries a failed paid call, never falls back, and keeps upstream errors private',async()=>{
  const prior=globalThis.fetch,oldWarn=console.warn;const logs=[];
  console.warn=(...args)=>logs.push(args);
  try{
    for(const stage of [1,2])for(const status of [400,401,403,404,422,429,500,503,'network','timeout','json']){
      let calls=0;
      globalThis.fetch=async(url,opts)=>{
        calls++;
        assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions');
        assert.equal(JSON.parse(opts.body).model,'gemini-4-argon');
        if(calls<stage)return new Response(JSON.stringify(analysisResult()));
        if(status==='network'||status==='timeout')throw new DOMException('PRIVATE_PROVIDER_ERROR',
          status==='timeout'?'TimeoutError':'NetworkError');
        if(status==='json')return new Response('PRIVATE_PROVIDER_ERROR');
        return new Response(JSON.stringify({error:{message:'PRIVATE_PROVIDER_ERROR'}}),{status});
      };
      const response=await worker.fetch(new Request('https://example.workers.dev/api/scene/argon/start',{
        method:'POST',headers:{Authorization:'Bearer '+token},
        body:JSON.stringify({...sample,profile:'argon_previs',mode:'primary_subject'})
      }),env);
      assert.equal(response.status,status===429?429:502);
      const raw=await response.text();
      assert.ok(!raw.includes('PRIVATE_'));
      assert.ok(!raw.includes(env.GEMINI_API_KEY));
      assert.equal(calls,stage,'No retry/probe/fallback on either paid stage');
    }
    assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
  }finally{globalThis.fetch=prior;console.warn=oldWarn;}
});

test('Argon analysis and submission deadlines stay below the PHP transport deadline',async()=>{
  const prior=globalThis.fetch,oldTimeout=AbortSignal.timeout;const times=[];
  const total=new AbortController(),analysis=new AbortController();
  AbortSignal.timeout=ms=>{times.push(ms);return ms===40000?total.signal:analysis.signal;};
  let calls=0;
  globalThis.fetch=async(url,opts)=>{
    calls++;
    if(calls===1){
      assert.equal(opts.signal.aborted,false);
      // Simulate the deadline expiring while the successful response is read.
      total.abort();
      return new Response(JSON.stringify(analysisResult()));
    }
    throw Error('Must not start another paid call after the deadline');
  };
  try{
    const response=await worker.fetch(new Request('https://example.workers.dev/api/scene/argon/start',{
      method:'POST',headers:{Authorization:'Bearer '+token},
      body:JSON.stringify({...sample,profile:'argon_previs',mode:'primary_subject'})
    }),env);
    assert.deepEqual(await response.json(),{ok:false,error:'Argon reference analysis unavailable'});
    assert.equal(calls,1);
    assert.deepEqual(times,[40000,30000]);
  }finally{globalThis.fetch=prior;AbortSignal.timeout=oldTimeout;}
});
test('Argon model check uses Google metadata GET, never submits paid content or frames',async()=>{
  const originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async (url,options)=>{
    calls++;
    assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon');
    assert.equal(options.method,'GET');
    assert.equal(options.body,undefined);
    assert.equal(options.headers['x-goog-api-key'],env.GEMINI_API_KEY);
    return new Response(JSON.stringify({name:'models/gemini-4-argon',
      displayName:'Gemini 4 Argon',supportedGenerationMethods:['generateContent']}),
      {status:200});
  };
  const send=(body,authorization=token)=>worker.fetch(
    new Request('https://example.workers.dev/api/scene/argon/check',{
      method:'POST',headers:{Authorization:'Bearer '+authorization,'Content-Type':'application/json'},
      body:JSON.stringify(body)
    }),env);
  try {
    const result=await send({});
    assert.equal(result.status,200);
    assert.deepEqual(await result.json(),{ok:true,available:true,check:'listed'});
    assert.equal(calls,1);
    // PHP previously sent "[]" because it encoded an empty PHP array.
    // The metadata endpoint requires "{}" and rejects [] before Google.
    const wrongShape=await worker.fetch(new Request(
      'https://example.workers.dev/api/scene/argon/check',{
        method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:'[]'
      }),env);
    assert.equal(wrongShape.status,400);
    assert.deepEqual(await wrongShape.json(),{ok:false,error:'Invalid Argon check request'});
    assert.equal(calls,1,'An invalid JSON shape never reaches Google');
    assert.equal((await send({frames:sample.frames})).status,400,
      'The metadata check must not accept client frames');
    assert.equal((await send({},'wrong-token')).status,401);
    assert.equal(calls,1,'Invalid/authentication failures must not contact Google');
  }finally{globalThis.fetch=originalFetch;}
});
test('Argon metadata check distinguishes not listed and unavailable without exposing provider errors',async()=>{
  const before=globalThis.fetch,oldWarn=console.warn;
  const responses=[
    {status:404,body:{error:{message:'PRIVATE_PROVIDER_ACCOUNT_DETAILS'}}},
    {status:403,body:{error:{message:'PRIVATE_PROVIDER_ACCOUNT_DETAILS'}}},
    {status:503,body:{error:{message:'PRIVATE_PROVIDER_ACCOUNT_DETAILS'}}},
    {status:200,body:{name:'models/other'}}
  ];
  let index=0;
  globalThis.fetch=async()=>{const next=responses[index++];
    return new Response(JSON.stringify(next.body),{status:next.status});};
  try{
    for(let i=0;i<responses.length;i++){
      const response=await worker.fetch(new Request('https://example.workers.dev/api/scene/argon/check',{
        method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:'{}'
      }),env);
      const json=await response.json();
      if(i<2){
        assert.equal(response.status,200);
        assert.deepEqual(json,{ok:true,available:false,check:'not_listed'});
      }else{
        assert.equal(response.status,502);
        assert.deepEqual(json,{ok:false,error:'Argon model metadata check unavailable'});
      }
      assert.ok(!JSON.stringify(json).includes('PRIVATE_PROVIDER_ACCOUNT_DETAILS'));
    }
    assert.equal(index,responses.length);
  }finally{globalThis.fetch=before;console.warn=oldWarn;}
});
test('Seven Argon stages isolate text, thinking, JPEG, JSON and background feature combinations',async()=>{
  const previous=globalThis.fetch;
  const expected=['text','thinking','image','json','background','background_image','background_combo'];
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  let calls=0,uploadsStarted=0,uploadsCompleted=0;
  const id='v1_argon_smoke12345';
  const uploadUrl='https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=test-id';
  const fileUri='https://generativelanguage.googleapis.com/v1beta/files/syntheticTest12345';
  globalThis.fetch=async (url,opts)=>{
    if(url==='https://generativelanguage.googleapis.com/upload/v1beta/files'){
      uploadsStarted++;
      assert.equal(opts.method,'POST');
      assert.equal(opts.headers['x-goog-api-key'],env.GEMINI_API_KEY);
      assert.equal(opts.headers['X-Goog-Upload-Protocol'],'resumable');
      assert.equal(opts.headers['X-Goog-Upload-Header-Content-Type'],'image/jpeg');
      assert.equal(opts.redirect,'manual');
      assert.deepEqual(JSON.parse(opts.body),{file:{display_name:'paiver-synthetic-argon-smoke'}});
      return new Response('',{status:200,headers:{'x-goog-upload-url':uploadUrl}});
    }
    if(url===uploadUrl){
      uploadsCompleted++;
      assert.equal(opts.method,'POST');
      assert.equal(opts.headers['X-Goog-Upload-Command'],'upload, finalize');
      assert.equal(opts.redirect,'manual');
      const bytes=Buffer.from(opts.body);
      assert.equal(bytes.length,686);
      assert.equal(bytes.readUInt16BE(0),0xffd8);
      assert.equal(bytes.readUInt16BE(bytes.length-2),0xffd9);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),
        'f43da1db2122208f9d6aa129f9600be94f143f0bc2afc310e272dde6c5ef464f');
      return new Response(JSON.stringify({file:{name:'files/syntheticTest12345',
        uri:fileUri,mimeType:'image/jpeg'}}),{status:200});
    }
    if(url.endsWith('/'+id)){
      assert.equal(opts.body,undefined,'Background polling is GET only');
      return new Response(JSON.stringify({id,status:'completed',
        steps:[{type:'model_output',content:[{type:'text',text:'{"ok":true}'}]}]}),{status:200});
    }
    calls++;
    assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(opts.headers['x-goog-api-key'],env.GEMINI_API_KEY);
    const body=JSON.parse(opts.body);
    assert.equal(body.model,'gemini-4-argon');
    assert.equal(body.tools,undefined);
    assert.equal(body.thinking_budget,undefined);
    assert.equal(body.reasoning_effort,undefined);
    const stage=expected[calls-1];
    if(stage==='text'){
      assert.deepEqual(Object.keys(body).sort(),['input','model']);
      assert.equal(typeof body.input,'string');
    }else{
      assert.deepEqual(body.generation_config,{thinking_level:'low',max_output_tokens:4096});
      if(['thinking','background'].includes(stage))assert.equal(typeof body.input,'string');
      if(['image','background_image','background_combo'].includes(stage)){
        const img=body.input[1];
        assert.equal(img.type,'image');
        assert.equal(img.mime_type,'image/jpeg');
        if(stage==='image'){
          assert.ok(img.data.startsWith('/9j/'));
          const jpeg=Buffer.from(img.data,'base64');
          assert.equal(jpeg.readUInt16BE(0),0xffd8);
          assert.equal(jpeg.readUInt16BE(jpeg.length-2),0xffd9);
          assert.equal(jpeg.length,686);
          assert.equal(createHash('sha256').update(jpeg).digest('hex'),
            'f43da1db2122208f9d6aa129f9600be94f143f0bc2afc310e272dde6c5ef464f');
          const frame=jpeg.indexOf(Buffer.from([0xff,0xc0]));
          assert.ok(frame>0);
          assert.equal(jpeg.readUInt16BE(frame+5),32);
          assert.equal(jpeg.readUInt16BE(frame+7),32);
        }else{
          assert.equal(img.uri,fileUri,'Background tests must send stored Google file URI');
          assert.equal(img.data,undefined,'No inline base64 in background request');
        }
        assert.ok(!JSON.stringify(img).includes('PRIVATE_CLIENT_FOOTAGE'));
      }
      if(['json','background_combo'].includes(stage)){
        assert.equal(body.response_format.mime_type,'application/json');
        assert.deepEqual(body.response_format.schema.required,['ok']);
      }
      if(stage.startsWith('background')){
        assert.equal(body.background,true);
        assert.equal(body.store,true);
      }else assert.equal(body.background,undefined);
    }
    return new Response(JSON.stringify(stage.startsWith('background')?{id,status:'queued'}:{
      id:'v1_synccheck',status:'completed',
      steps:[{type:'model_output',content:[{type:'text',text:
        stage==='json'?'{"ok":true}':'OK'}]}]}),{status:200});
  };
  try{
    for(const stage of expected){
      const response=await worker.fetch(new Request(
        'https://example.workers.dev/api/scene/argon/diagnostic',{
          method:'POST',headers,body:JSON.stringify({stage})
        }),env);
      assert.equal(response.status,200,stage);
      const result=await response.json();
      if(stage.startsWith('background')){
        assert.deepEqual(result,{ok:true,status:'in_progress',id,stage});
        const poll=await worker.fetch(new Request(
          'https://example.workers.dev/api/scene/argon/diagnostic-status',{
            method:'POST',headers,body:JSON.stringify({id,stage})
          }),env);
        assert.deepEqual(await poll.json(),{ok:true,status:'completed',passed:true});
      }else assert.deepEqual(result,{ok:true,stage,status:'completed',passed:true});
    }
    assert.equal(calls,7,'exactly one billable submission for each confirmed stage');
    assert.equal(uploadsStarted,2,'Only background JPEG tests use Google Files upload');
    assert.equal(uploadsCompleted,2);
  }finally{globalThis.fetch=previous;}
});
test('Argon Files API rejects untrusted upload destinations and file URIs without submitting paid inference',async()=>{
  const oldFetch=globalThis.fetch,auth={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  let hits=[];
  try{
    const exercise=async mock=>{
      hits=[];
      globalThis.fetch=async (url,options)=>{
        hits.push({url,options});
        return mock(url,options);
      };
      const res=await worker.fetch(new Request('https://example.workers.dev/api/scene/argon/diagnostic',{
        method:'POST',headers:auth,body:JSON.stringify({stage:'background_image'})
      }),env);
      assert.equal(res.status,502);
      const result=await res.json();
      assert.equal(result.ok,false);
      assert.ok(!JSON.stringify(result).includes('SECRET_PROVIDER_INPUT'));
      assert.ok(!hits.some(x=>x.url==='https://generativelanguage.googleapis.com/v1beta/interactions'));
      return result.error;
    };
    let error=await exercise(async url=>{
      if(url==='https://generativelanguage.googleapis.com/upload/v1beta/files')
        return new Response('',{status:200,headers:{
          'x-goog-upload-url':'https://attacker.invalid/upload/v1beta/files?token=PRIVATE'
        }});
      assert.fail('Must not fetch untrusted upload URL: '+url);
    });
    assert.equal(error,'Argon diagnostic upload URL was not trusted');
    assert.equal(hits.length,1);
    const trustedUpload='https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=testing';
    error=await exercise(async url=>{
      if(url==='https://generativelanguage.googleapis.com/upload/v1beta/files')
        return new Response('',{status:200,headers:{'x-goog-upload-url':trustedUpload}});
      if(url===trustedUpload)return new Response(JSON.stringify({file:{
        mimeType:'image/jpeg',uri:'https://attacker.invalid/files/PRIVATE'
      }}),{status:200});
      assert.fail('Unexpected URL: '+url);
    });
    assert.equal(error,'Argon diagnostic uploaded file metadata invalid');
    assert.equal(hits.length,2);
    error=await exercise(async url=>{
      if(url==='https://generativelanguage.googleapis.com/upload/v1beta/files')
        return new Response('SECRET_PROVIDER_INPUT',{status:400});
      assert.fail('Unexpected URL: '+url);
    });
    assert.equal(error,'Argon diagnostic file upload failed');
    assert.equal(hits.length,1);
  }finally{globalThis.fetch=oldFetch;}
});
test('Argon diagnostic rejects unapproved stages, custom prompts and input footage without provider calls',async()=>{
  const previous=globalThis.fetch;let upstream=0;
  globalThis.fetch=async()=>{upstream++;throw Error('diagnostic must not reach provider');};
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  try{
    for(const bad of [{stage:'previs'}, {stage:'text',prompt:'SECRET'},
      {stage:'image',frame:sample.frames[0]}, {stage:'json',max_output_tokens:900000},
      {stage:'thinking',thinking_budget:2048}, {stage:'background',input:'secret'},
      {stage:'background_image',frame:sample.frames[0]}, {stage:'background_combo',model:'another'}]){
      const res=await worker.fetch(new Request(
        'https://example.workers.dev/api/scene/argon/diagnostic',{
          method:'POST',headers,body:JSON.stringify(bad)
        }),env);
      assert.equal(res.status,400,JSON.stringify(bad).slice(0,35));
    }
    const unauthorized=await worker.fetch(new Request(
      'https://example.workers.dev/api/scene/argon/diagnostic',{
        method:'POST',headers:{...headers,Authorization:'Bearer incorrect'},
        body:JSON.stringify({stage:'text'})
      }),env);
    assert.equal(unauthorized.status,401);
    assert.equal(upstream,0);
  }finally{globalThis.fetch=previous;}
});
test('Argon 400 diagnostics use scoped field-path evidence and do not leak provider bodies',async()=>{
  const priorFetch=globalThis.fetch,priorWarn=console.warn;
  const samples=[
    {
      message:'Invalid response_format.schema: PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected output format configuration',category:'output_format'
    },
    {
      message:'Invalid generation_config.thinking_level PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected generation configuration',category:'generation_config'
    },
    {
      message:'Invalid input[2].mime_type PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected image input configuration',category:'image_input'
    },
    // Both incoming images and outgoing structured JSON have mime_type.
    // A bare mention of it must NEVER be falsely labeled an image problem.
    {
      message:'Unsupported mime_type PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected Interactions request',category:'unknown'
    },
    {
      message:'Image request cannot be processed PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected Interactions request',category:'unknown'
    },
    {
      message:'Invalid responseFormat.mimeType PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected output format configuration',category:'output_format'
    },
    {
      message:'Invalid background PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected background execution configuration',category:'background'
    },
    {
      message:'Unsupported model PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected model configuration',category:'model'
    },
    {
      message:'The model cannot process this image in a background request PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected Interactions request',category:'unknown'
    },
    {
      message:'model_interaction request is invalid PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected Interactions request',category:'unknown'
    },
    {
      message:'Unsupported model-specific option PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected Interactions request',category:'unknown'
    },
    {
      message:'Invalid response_format.schema PRIVATE_KEY_DO_NOT_LOG',
      details:[{fieldViolations:[{field:'model_interaction.input[1].mime_type'}]}],
      expected:'Argon rejected image input configuration',category:'image_input'
    },
    {
      message:'Request contains an invalid argument PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected Interactions request',category:'unknown'
    },
    {
      message:'Uninformative provider text PRIVATE_KEY_DO_NOT_LOG',
      details:[{'@type':'type.googleapis.com/google.rpc.BadRequest',
        fieldViolations:[{field:'model_interaction.input[1].mime_type',
          description:'PRIVATE_FRAME_DATA'}]}],
      expected:'Argon rejected image input configuration',category:'image_input'
    },
    {
      message:'Uninformative provider text PRIVATE_KEY_DO_NOT_LOG',
      details:[{'@type':'type.googleapis.com/google.rpc.BadRequest',
        field_violations:[{field:'response_format.mime_type',
          description:'PRIVATE_FRAME_DATA'}]}],
      expected:'Argon rejected output format configuration',category:'output_format'
    }
  ];
  let calls=0;const logs=[];
  console.warn=(...args)=>logs.push(args);
  try{
    for(const {message,expected,category,details} of samples){
      globalThis.fetch=async()=>{
        calls++;
        return new Response(JSON.stringify({
          error:{code:'invalid_request',message,details},
          extra:{input:'PRIVATE_FRAME_DATA'}
        }),{status:400});
      };
      const response=await worker.fetch(new Request('https://example.workers.dev/api/scene/argon/start',{
        method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify({...sample,profile:'argon_previs',mode:'primary_subject'})
      }),env);
      assert.equal(response.status,502);
      const raw=await response.text();
      assert.deepEqual(JSON.parse(raw),{ok:false,error:expected},message);
      assert.ok(!raw.includes('PRIVATE_KEY_DO_NOT_LOG'));
      assert.ok(!raw.includes('PRIVATE_FRAME_DATA'));
      assert.deepEqual(logs.at(-1),['argon-request-400-category',category]);
    }
    assert.equal(calls,samples.length,'400 must not automatically trigger another paid request');
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
    for(const frames of [[],Array(4).fill(sample.frames[0]),
      [{at:1,imageDataUrl:'https://untrusted.test/private.jpg'}],
      [{at:-1,imageDataUrl:image}],
      [{at:1,imageDataUrl:'data:image/jpeg;base64,'+'a'.repeat(500001)}]]){
      assert.equal((await post('/api/scene/argon/start',{
        ...sample,frames,mode:'primary_subject',profile:'argon_previs'
      })).status,400);
    }
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

test('Argon background results still enforce the editable primitive contract and shot binding',async()=>{
  const prior=globalThis.fetch;const id='v1_validation_12345';
  const object=scene.scenes[0].objects[0];
  const rejected=[
    {schemaVersion:1,scenes:[{shotId:'wrong_shot',objects:[object]}]},
    {schemaVersion:1,scenes:[{shotId:sample.shotId,objects:[{...object,primitive:'javascript'}]}]},
    {schemaVersion:1,scenes:[{shotId:sample.shotId,objects:[{...object,scale:[-1,2,3]}]}]},
    {schemaVersion:1,scenes:[{shotId:sample.shotId,objects:Array.from({length:49},
      (_,i)=>({...object,id:'part_'+i}))}]}
  ];
  try{
    for(const proposal of rejected){
      globalThis.fetch=async(url,opts)=>{
        assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions/'+id);
        assert.equal(opts.body,undefined,'Polling must not submit paid generation');
        return new Response(JSON.stringify({id,status:'completed',steps:[
          {type:'model_output',content:[{type:'text',text:JSON.stringify(proposal)}]}
        ]}));
      };
      const response=await worker.fetch(new Request('https://example.workers.dev/api/scene/argon/status',{
        method:'POST',headers:{Authorization:'Bearer '+token},
        body:JSON.stringify({jobId:id,shotId:sample.shotId})
      }),env);
      assert.equal(response.status,502);
      assert.deepEqual(await response.json(),{ok:false,error:'Provider scene did not match the editor schema'});
    }
    globalThis.fetch=async()=>new Response(JSON.stringify({id,status:'completed',steps:{private:'SECRET'}}));
    const response=await worker.fetch(new Request('https://example.workers.dev/api/scene/argon/status',{
      method:'POST',headers:{Authorization:'Bearer '+token},
      body:JSON.stringify({jobId:id,shotId:sample.shotId})
    }),env);
    assert.equal(response.status,502);
    assert.deepEqual(await response.json(),{ok:false,error:'Provider produced no usable scene'});
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
