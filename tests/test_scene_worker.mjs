import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker,{validateInput,validateOutput,secretMatches,argonProviderDiagnostic,ArgonJob} from '../worker/scene-worker.mjs';

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
const analysisResult=(value=visualAnalysis)=>({candidates:[{content:{parts:[
  {text:JSON.stringify(value)}
]}}],usageMetadata:{privateData:'DO_NOT_FORWARD'}});
test('health endpoint reports true readiness without exposing secret details',async()=>{
  const healthy=await worker.fetch(new Request('https://example.workers.dev/health'),env);
  assert.equal(healthy.status,200);
  assert.deepEqual(await healthy.json(),{ok:true,service:'paige-scene',ready:true,model:'gemini-3.5-flash-lite',generationProfile:'layered-environment-v1',workerRevision:'argon-direct-quality-v1',supportedModels:['gemini-3.5-flash-lite','gemini-3.8-flash'],supportedProfiles:['lite_default','g38_low','g38_medium','argon_previs','argon_direct'],argonDirectJobs:false});
  const unavailable=await worker.fetch(new Request('https://example.workers.dev/health'),{});
  assert.equal(unavailable.status,503);
  const body=await unavailable.text();
  assert.deepEqual(JSON.parse(body),{ok:false,service:'paige-scene',ready:false,model:'gemini-3.5-flash-lite',generationProfile:'layered-environment-v1',workerRevision:'argon-direct-quality-v1',supportedModels:['gemini-3.5-flash-lite','gemini-3.8-flash'],supportedProfiles:['lite_default','g38_low','g38_medium','argon_previs','argon_direct'],argonDirectJobs:false});
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
test('Fast Flash-Lite image analysis feeds text-only Argon background without client-media persistence',async()=>{
  const prior=globalThis.fetch;let calls=0,outputBudget=0;
  const frames=[{at:1.5,imageDataUrl:image},{at:0,imageDataUrl:image},{at:3,imageDataUrl:image}];
  const id='v1_C1234567890opaque';
  const provider={id,status:'completed',steps:[
    {type:'user_input',content:[{type:'text',text:'SECRET_INPUT'}]},
    {type:'model_output',content:[{type:'text',text:JSON.stringify(scene)}]}
  ]};
  globalThis.fetch=async (url,opts)=>{
    calls++;
    if(calls===1){
      assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
      assert.equal(opts.method,'POST');
      assert.equal(opts.headers['x-goog-api-key'],env.GEMINI_API_KEY);
      assert.equal(opts.headers['Api-Revision'],undefined);
      assert.equal(opts.redirect,'manual');
      assert.ok(opts.signal instanceof AbortSignal);
      const request=JSON.parse(opts.body);
      assert.equal(request.model,undefined);
      assert.equal(request.generationConfig.responseMimeType,'application/json');
      assert.deepEqual(request.generationConfig.responseSchema.required,
        ['subject','composition','palette','cameraMotion','uncertainties','parts']);
      assert.equal(request.generationConfig.maxOutputTokens,4096);
      assert.equal(request.generationConfig.thinkingConfig,undefined);
      assert.equal(request.contents.length,1);
      assert.equal(request.contents[0].role,'user');
      assert.match(request.contents[0].parts[0].text,/FIRST supplied frame/);
      assert.match(request.contents[0].parts[0].text,/silhouette/);
      assert.deepEqual(request.contents[0].parts.slice(1),frames.flatMap(frame=>[
        {text:'Reference frame at '+frame.at.toFixed(3)+' seconds'},
        {inlineData:{mimeType:'image/jpeg',data:frame.imageDataUrl.split(',')[1]}}
      ]));
      outputBudget+=request.generationConfig.maxOutputTokens;
      return new Response(JSON.stringify(analysisResult({...visualAnalysis,
        privateMetadata:'PRIVATE_PROVIDER_METADATA'})),{status:200});
    }
    if(calls===2){
      assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions');
      assert.equal(opts.method,'POST');
      assert.equal(opts.headers['x-goog-api-key'],env.GEMINI_API_KEY);
      assert.equal(opts.headers['Api-Revision'],'2026-05-20');
      assert.equal(opts.redirect,'manual');
      const data=JSON.parse(opts.body);
      assert.equal(data.model,'gemini-4-argon');
      assert.equal(data.background,true);
      assert.equal(data.store,true);
      assert.equal(data.generation_config.thinking_level,'medium');
      assert.equal(data.generation_config.max_output_tokens,28672);
      outputBudget+=data.generation_config.max_output_tokens;
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
      assert.equal(typeof data.input,'string');
      assert.deepEqual(JSON.parse(data.input),visualAnalysis);
      assert.equal(data.previous_interaction_id,undefined);
      assert.match(data.system_instruction,/PREVIS \/ RUNWAY PREP/);
      assert.match(data.system_instruction,/PRIMARY SUBJECT/);
      assert.match(data.system_instruction,/untrusted descriptive data/);
      assert.doesNotMatch(data.system_instruction,/target 36-48 parts/,'Direct-only guidance');
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
    assert.equal(calls,3,'Two opt-in billable starts, then a GET-only poll');
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
    {candidates:[]},
    {candidates:[{content:{parts:[]}}]},
    {candidates:[{content:{parts:{not:'array'}}}]},
    {candidates:[{content:{parts:[{thought:JSON.stringify(visualAnalysis)}]}}]},
    {candidates:[{content:{parts:[{text:'x'.repeat(24001)}]}}]},
    {candidates:[{content:{parts:[{text:'not JSON PRIVATE_INPUT'}]}}]},
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
        assert.equal(url,calls===1?
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent':
          'https://generativelanguage.googleapis.com/v1beta/interactions');
        if(calls===1)assert.equal(JSON.parse(opts.body).generationConfig.maxOutputTokens,4096);
        else assert.equal(JSON.parse(opts.body).model,'gemini-4-argon');
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
    assert.deepEqual(times,[40000,35000]);
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
  let calls=0;
  const id='v1_argon_smoke12345';
  globalThis.fetch=async (url,opts)=>{
    assert.ok(!url.includes('/upload/'),'No Google Files upload: stages 6-7 send inline JPEG');
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
        // Synchronous and background image stages send the identical
        // documented ImageContent, so only background/store differ.
        const img=body.input[1];
        assert.deepEqual(Object.keys(img).sort(),['data','mime_type','type']);
        assert.equal(img.type,'image');
        assert.equal(img.mime_type,'image/jpeg');
        assert.equal(img.uri,undefined);
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
  }finally{globalThis.fetch=previous;}
});
test('Interactions error bodies become fixed-vocabulary diagnostics, never provider prose',()=>{
  const secret='PRIVATE_PROSE '+env.GEMINI_API_KEY+' '+token;
  const cases=[
    // Documented Error object: code is a URI naming the error type.
    [{code:'https://ai.google.dev/errors/invalid_request',message:'Request contains an invalid argument.'},
      {codes:['invalid_request'],reason:'generic_invalid_argument',fields:[],terms:['invalid']}],
    // Bodies reported on background interactions, Sept-Oct 2026.
    [{code:'invalid_request',message:"Model 'gemini-4-argon' does not support background interactions."},
      {codes:['invalid_request'],reason:'background_unsupported_for_model',fields:['model','background'],terms:['not','interactions']}],
    [{code:'invalid_request',message:'Unsupported file uri: blobstore:///genai-api/blobref/global::PRIVATE_REF'},
      {codes:['invalid_request'],reason:'file_uri_unsupported',fields:['uri'],terms:['file','unsupported']}],
    [{code:'invalid_request',message:'Multiple authentication credentials received. Please pass only one.'},
      {codes:['invalid_request'],reason:'auth_credentials',fields:[],terms:['only','one','multiple']}],
    // Documented: background with store=false is a 400.
    [{code:'invalid_request',message:'store=false is incompatible with background execution'},
      {codes:['invalid_request'],reason:'background_requires_store',fields:['background','store'],terms:[]}],
    [{code:'invalid_request',message:'The model cannot process this image in a background request '+secret},
      {codes:['invalid_request'],reason:'media_input_rejected',fields:['model','background'],terms:['image','not','cannot','token']}],
    [{code:'invalid_request',message:'Invalid input[1].mime_type '+secret},
      {codes:['invalid_request'],reason:'mime_type',fields:['input','mime_type'],terms:['invalid','not','token']}],
    [{code:'invalid_request',message:'responseFormat.schema too complex: maxItems'},
      {codes:['invalid_request'],reason:'output_schema',fields:['response_format','schema'],terms:['too']}],
    [{code:'invalid_request',message:'Inline data is too large for this request'},
      {codes:['invalid_request'],reason:'payload_too_large',fields:['data'],terms:['inline','too','large']}],
    [{code:'invalid_request',message:'model_interaction failed '+secret},
      {codes:['invalid_request'],reason:'unrecognized_message',fields:[],terms:['not','token']}],
    // google.rpc.Status fallback: enum status, ErrorInfo reason and field paths.
    [{code:400,status:'INVALID_ARGUMENT',message:'Uninformative '+secret,details:[
      {'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'FIELD_INVALID',
        metadata:{consumer:'projects/PRIVATE_PROJECT'}},
      {'@type':'type.googleapis.com/google.rpc.BadRequest',
        fieldViolations:[{field:'model_interaction.input[1].data',description:secret}]}]},
      {codes:['INVALID_ARGUMENT','FIELD_INVALID'],reason:'unrecognized_message',fields:['input','data'],terms:['not','token']}],
    // Key-like, numeric, dotted or prose codes are dropped, never truncated.
    [{code:env.GEMINI_API_KEY},{codes:[],reason:'no_error_body',fields:[],terms:[]}],
    [{code:'AIzaSyPRIVATEkey_0123456789abcdefghijk',status:'123456789'},
      {codes:[],reason:'no_error_body',fields:[],terms:[]}],
    [{code:'AQ.Ab8PRIVATE',message:''},{codes:[],reason:'no_error_body',fields:[],terms:[]}],
    [{code:'Invalid request PRIVATE text'},{codes:[],reason:'no_error_body',fields:[],terms:[]}],
    [{code:'https://attacker.example/PRIVATE.key'},{codes:[],reason:'no_error_body',fields:[],terms:[]}]
  ];
  for(const [error,expected] of cases){
    const result=argonProviderDiagnostic(error,'create',400);
    assert.deepEqual(result,{phase:'create',http:400,status:null,...expected},JSON.stringify(error).slice(0,60));
    const text=JSON.stringify(result);
    assert.ok(!text.includes('PRIVATE')&&!text.includes(env.GEMINI_API_KEY)&&!text.includes(token));
  }
  for(const empty of [null,undefined,'PRIVATE string',42,[]])
    assert.deepEqual(argonProviderDiagnostic(empty,'poll',400),
      {phase:'poll',http:400,status:null,codes:[],reason:'no_error_body',fields:[],terms:[]});
  // The live 2026-10-22 direct-image create 400 named only "input" with an
  // unrecognized phrase. Terms separate the candidate explanations.
  for(const [message,terms] of [
    ['Only one image is supported per input.',['image','only','one','supported']],
    ["Invalid value at 'input' (oneof), expected string",['string','oneof','value','invalid','expected']],
    ['input contains too many parts',['parts','too','many']],
    ['Unable to process input image: decode failed',['image','decode']],
    ['Input steps must not mix content types',['content','steps','not','must']]
  ]){
    const result=argonProviderDiagnostic({code:'invalid_request',message},'create',400);
    assert.deepEqual(result.fields,['input'],message);
    assert.deepEqual([...result.terms].sort(),[...terms].sort(),message);
  }
  // A later recognized message wins over an earlier unrecognized one.
  assert.equal(argonProviderDiagnostic([{message:'PRIVATE noise'},
    {message:'Unsupported file uri: x'}],'job').reason,'file_uri_unsupported');
  assert.equal(argonProviderDiagnostic(Array(9).fill({code:'invalid_request'}),'job').codes.length,1);
});
test('Status rejections and failed jobs report their phase without claiming no job exists',async()=>{
  const prior=globalThis.fetch,priorWarn=console.warn;const logs=[];let calls=0;
  console.warn=(...args)=>logs.push(args);
  const id='v1_phase_job_123';
  const post=(path,body)=>worker.fetch(new Request('https://example.workers.dev'+path,{
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify(body)}),env);
  const respond=(status,body)=>{globalThis.fetch=async(url,opts)=>{
    calls++;
    assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions/'+id);
    assert.equal(opts.method,undefined,'Polling stays GET only');
    assert.equal(opts.body,undefined);
    return new Response(JSON.stringify(body),{status});
  };};
  try{
    const rejected={error:{code:'invalid_request',
      message:'Unsupported file uri: blobstore:///genai-api/blobref/global::PRIVATE_REF'}};
    const pollDiagnostic={phase:'poll',http:400,status:null,codes:['invalid_request'],
      reason:'file_uri_unsupported',fields:['uri'],terms:['file','unsupported']};
    for(const [path,body] of [['/api/scene/argon/diagnostic-status',{id,stage:'background_image'}],
      ['/api/scene/argon/status',{jobId:id,shotId:'draft_001'}]]){
      respond(400,rejected);
      const response=await post(path,body);
      assert.equal(response.status,502);
      assert.deepEqual(await response.json(),{ok:false,
        error:'Argon rejected interaction status request',diagnostic:pollDiagnostic});
    }
    // Async failure reported inside the interaction resource itself.
    respond(200,{id,status:'failed',errors:[{code:'INVALID_ARGUMENT',
      message:'There was a problem processing your request. You will not be charged. PRIVATE'}],
      steps:[{type:'user_input',content:[{type:'image',data:'PRIVATE_FRAME'}]}]});
    const jobDiagnostic={phase:'job',http:null,status:'failed',codes:['INVALID_ARGUMENT'],
      reason:'unrecognized_message',fields:[],terms:['not']};
    assert.deepEqual(await (await post('/api/scene/argon/status',{jobId:id,shotId:'draft_001'})).json(),
      {ok:true,status:'failed',diagnostic:jobDiagnostic});
    assert.deepEqual(await (await post('/api/scene/argon/diagnostic-status',
      {id,stage:'background_combo'})).json(),
      {ok:true,status:'failed',passed:false,diagnostic:jobDiagnostic});
    // Documented "incomplete" (e.g. max tokens) is terminal, not unreadable.
    respond(200,{id,status:'incomplete'});
    assert.deepEqual(await (await post('/api/scene/argon/status',{jobId:id,shotId:'draft_001'})).json(),
      {ok:true,status:'failed',diagnostic:{phase:'job',http:null,status:'incomplete',codes:[],
        reason:'incomplete_output',fields:[],terms:[]}});
    assert.equal(calls,5,'Exactly one GET per poll; nothing is retried or resubmitted');
    assert.ok(logs.some(line=>line[0]==='argon-provider-diagnostic'));
    assert.ok(!JSON.stringify(logs).includes('PRIVATE'));
  }finally{globalThis.fetch=prior;console.warn=priorWarn;}
});
// In-memory stand-in for a SQLite-backed Durable Object namespace. The real
// runtime path (workerd, SQLite storage, alarms) is exercised separately.
function fakeArgonJobs(jobEnv){
  const objects=new Map();let counter=0;
  class Storage{
    constructor(){this.data=new Map();this.alarm=null;this.failPut=null;}
    async get(key){return structuredClone(this.data.get(key));}
    async put(key,value){
      if(this.failPut&&this.failPut(key,value))throw Error('PRIVATE storage failure');
      this.data.set(key,structuredClone(value));
    }
    async delete(key){return this.data.delete(key);}
    async deleteAll(){this.data.clear();this.alarm=null;}
    async setAlarm(time){this.alarm=time;}
  }
  const object=hex=>{
    if(!objects.has(hex))objects.set(hex,new ArgonJob({storage:new Storage()},jobEnv));
    return objects.get(hex);
  };
  const id=hex=>({toString:()=>hex});
  return {objects,namespace:{
    newUniqueId:()=>id((++counter).toString(16).padStart(64,'a')),
    idFromString(hex){if(!/^[0-9a-f]{64}$/.test(hex))throw TypeError('Invalid id');return id(hex);},
    get:objectId=>({fetch:(url,init={})=>object(objectId.toString())
      .fetch(new Request(url,{...init,...(init.body?{duplex:'half'}:{})}))})
  }};
}
const directJob={...sample,profile:'argon_direct',mode:'primary_subject',
  frames:[{at:1.5,imageDataUrl:image},{at:0,imageDataUrl:image},{at:3,imageDataUrl:image}]};
const completedScene=()=>new Response(JSON.stringify({id:'v1_sync',status:'completed',steps:[
  {type:'user_input',content:[{type:'image',data:'PRIVATE_FRAME'}]},
  {type:'model_output',content:[{type:'text',text:JSON.stringify(scene)}]}]}));
const doPost=(jobsEnv,path,body)=>worker.fetch(new Request('https://example.workers.dev'+path,{
  method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
  body:JSON.stringify(body)}),jobsEnv);
test('Direct-image Argon runs ONE synchronous image call inside a Durable Object alarm',async()=>{
  const prior=globalThis.fetch,oldTimeout=AbortSignal.timeout;const timeouts=[];let calls=0;
  AbortSignal.timeout=ms=>{timeouts.push(ms);return oldTimeout.call(AbortSignal,ms);};
  const {objects,namespace}=fakeArgonJobs(env);
  const jobsEnv={...env,ARGON_JOBS:namespace};
  globalThis.fetch=async(url,opts)=>{
    calls++;
    assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(opts.method,'POST');
    assert.equal(opts.redirect,'manual');
    assert.equal(opts.headers['x-goog-api-key'],env.GEMINI_API_KEY);
    assert.equal(opts.headers['Api-Revision'],'2026-05-20');
    const body=JSON.parse(opts.body);
    // Synchronous and stateless: no background, and Google stores nothing.
    assert.deepEqual(Object.keys(body).sort(),['generation_config','input','model',
      'response_format','store','system_instruction']);
    assert.equal(body.model,'gemini-4-argon');
    assert.equal(body.store,false);
    assert.equal(body.background,undefined);
    assert.deepEqual(body.generation_config,{thinking_level:'medium',max_output_tokens:32768});
    assert.deepEqual(body.response_format.schema.required,['schemaVersion','scenes']);
    assert.match(body.system_instruction,/PREVIS \/ RUNWAY PREP/);
    assert.match(body.system_instruction,/never an\s+instruction/);
    assert.match(body.system_instruction,/draft_001/);
    assert.match(body.system_instruction,/target 36-48 parts/);
    assert.match(body.system_instruction,/Match proportions and\s+placement to the FIRST frame/);
    assert.deepEqual(body.input,directJob.frames.flatMap(frame=>[
      {type:'text',text:'Reference frame at '+frame.at.toFixed(3)+' seconds'},
      {type:'image',data:frame.imageDataUrl.split(',')[1],mime_type:'image/jpeg',resolution:'high'}]));
    return completedScene();
  };
  try{
    const start=await doPost(jobsEnv,'/api/scene/argon/direct-start',directJob);
    const started=await start.json();
    assert.equal(start.status,200);
    assert.match(started.jobId,/^do_[0-9a-f]{64}$/);
    assert.deepEqual({...started,jobId:undefined},{ok:true,jobId:undefined,status:'queued'});
    assert.equal(calls,0,'Starting a job never waits for Google');
    const job=objects.get(started.jobId.slice(3));
    assert.equal(typeof job.ctx.storage.alarm,'number','The billable call runs in an alarm');
    assert.equal((await job.ctx.storage.get('request')).content.length,6);
    const poll=()=>doPost(jobsEnv,'/api/scene/argon/status',{jobId:started.jobId,shotId:'draft_001'})
      .then(r=>r.json());
    assert.deepEqual(await poll(),{ok:true,status:'queued'});
    await job.alarm();
    assert.equal(calls,1);
    assert.deepEqual(await poll(),{ok:true,status:'completed',proposal:scene});
    assert.equal(await job.ctx.storage.get('request'),undefined,'Frames deleted after the call');
    assert.ok(job.ctx.storage.alarm>Date.now()+23*3600*1000,'Result kept for the 24h job window');
    // At-least-once alarms: a repeated delivery never calls Google again.
    await job.alarm();
    assert.equal(calls,1);
    assert.deepEqual(timeouts.filter(ms=>ms>40000),[12*60*1000],'12-minute provider deadline');
    // The job is bound to its chapter; unknown and malformed IDs are refused.
    assert.equal((await doPost(jobsEnv,'/api/scene/argon/status',
      {jobId:started.jobId,shotId:'other_shot'})).status,400);
    assert.equal((await doPost(jobsEnv,'/api/scene/argon/status',
      {jobId:'do_'+'b'.repeat(64),shotId:'draft_001'})).status,404);
    // The synchronous scene route never accepts the job-only profile.
    assert.equal((await doPost(jobsEnv,'/api/scene',directJob)).status,400);
  }finally{globalThis.fetch=prior;AbortSignal.timeout=oldTimeout;}
});
test('Direct-image jobs validate input in the object and fail closed without a binding',async()=>{
  const prior=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('must not reach Google');};
  const {objects,namespace}=fakeArgonJobs(env);
  const jobsEnv={...env,ARGON_JOBS:namespace};
  try{
    for(const bad of [{...directJob,profile:'argon_previs'},{...directJob,mode:'environment'},
      {...directJob,layer:'structures'},{...directJob,model:'gemini-4-argon'},
      {...directJob,frames:[{at:1,imageDataUrl:'https://untrusted.test/a.jpg'}]},
      {...directJob,frames:Array(4).fill(sample.frames[0])}])
      assert.equal((await doPost(jobsEnv,'/api/scene/argon/direct-start',bad)).status,400);
    const huge=await worker.fetch(new Request('https://example.workers.dev/api/scene/argon/direct-start',{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Length':'1600001'},body:'{}'}),jobsEnv);
    assert.equal(huge.status,413);
    assert.ok([...objects.values()].every(job=>job.ctx.storage.data.size===0&&job.ctx.storage.alarm===null),
      'Rejected input stores nothing and schedules nothing');
    const missing=await doPost(env,'/api/scene/argon/direct-start',directJob);
    assert.deepEqual([missing.status,await missing.json()],
      [503,{ok:false,error:'Argon direct job storage is not configured'}]);
    assert.equal((await doPost(env,'/api/scene/argon/status',
      {jobId:'do_'+'c'.repeat(64),shotId:'draft_001'})).status,503);
    assert.equal(calls,0);
  }finally{globalThis.fetch=prior;}
});
test('Direct-image alarms never retry, resubmit or leak, whatever fails',async()=>{
  const prior=globalThis.fetch,oldWarn=console.warn;const logs=[];
  console.warn=(...args)=>logs.push(args);
  const run=async(respond,{failPut,once}={})=>{
    const {objects,namespace}=fakeArgonJobs(env);
    const jobsEnv={...env,ARGON_JOBS:namespace};let calls=0;
    globalThis.fetch=async(url)=>{calls++;
      assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions');
      return respond();};
    const started=await (await doPost(jobsEnv,'/api/scene/argon/direct-start',directJob)).json();
    const job=objects.get(started.jobId.slice(3));
    if(failPut)job.ctx.storage.failPut=failPut;
    await job.alarm(); // must never throw: Cloudflare would retry it
    if(!once)await job.alarm(); // a duplicate at-least-once delivery
    job.ctx.storage.failPut=null;
    const status=await (await doPost(jobsEnv,'/api/scene/argon/status',
      {jobId:started.jobId,shotId:'draft_001'})).json();
    return {status,calls,job};
  };
  const reason=async(respond,expected,extra)=>{
    const {status,calls,job}=await run(respond,extra);
    assert.equal(calls,1,'exactly one provider call: '+expected);
    assert.equal(status.status,'failed',expected);
    assert.equal(status.diagnostic.reason,expected);
    assert.equal(await job.ctx.storage.get('request'),undefined,'frames deleted: '+expected);
    assert.ok(!JSON.stringify(status).includes('PRIVATE'));
    return status;
  };
  try{
    const rejected=await reason(()=>new Response(JSON.stringify({error:{code:'invalid_request',
      message:'The agent does not support image input modality. PRIVATE'}}),{status:400}),'unrecognized_message');
    assert.deepEqual(rejected.diagnostic,{phase:'create',http:400,status:null,codes:['invalid_request'],
      reason:'unrecognized_message',fields:['input'],terms:['image','modality','not','agent']});
    await reason(()=>new Response('{"error":{"message":"PRIVATE"}}',{status:429}),'provider_rate_limited');
    await reason(()=>new Response('PRIVATE',{status:503}),'provider_capacity');
    await reason(()=>new Response('PRIVATE',{status:500}),'provider_unavailable');
    await reason(()=>new Response('PRIVATE',{status:403}),'provider_permission');
    await reason(()=>new Response(null,{status:302,headers:{Location:'https://attacker.example/PRIVATE'}}),
      'provider_redirect_blocked');
    await reason(()=>{throw new DOMException('PRIVATE '+env.GEMINI_API_KEY,'TimeoutError');},'provider_timeout');
    await reason(()=>{throw new TypeError('PRIVATE network');},'provider_network');
    await reason(()=>new Response('not json PRIVATE'),'invalid_provider_response');
    await reason(()=>new Response(JSON.stringify({status:'incomplete'})),'incomplete_output');
    await reason(()=>new Response(JSON.stringify({status:'completed',steps:[
      {type:'model_output',content:[{type:'text',text:'{"PRIVATE":1}'}]}]})),'scene_schema_mismatch');
    // A storage failure after the submitted marker: no throw, no second call,
    // frames removed, and the job is reported once its window has passed.
    const broken=await run(completedScene,{once:true,
      failPut:(key,value)=>key==='job'&&value.state==='completed'});
    assert.equal(broken.calls,1);
    assert.equal(broken.status.status,'in_progress');
    assert.equal(await broken.job.ctx.storage.get('request'),undefined);
    const stuck=await broken.job.ctx.storage.get('job');
    await broken.job.ctx.storage.put('job',{...stuck,submitted:Date.now()-17*60*1000});
    const later=await (await broken.job.fetch(new Request('https://argon-job/status?shot=draft_001'))).json();
    assert.deepEqual([later.status,later.diagnostic.reason],['failed','job_interrupted']);
    assert.ok(!JSON.stringify(logs).includes('PRIVATE'));
    assert.ok(!JSON.stringify(logs).includes(env.GEMINI_API_KEY));
  }finally{globalThis.fetch=prior;console.warn=oldWarn;}
});
test('An interrupted direct-image run is reported once and never resubmitted',async()=>{
  const prior=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return completedScene();};
  const {objects,namespace}=fakeArgonJobs(env);
  const jobsEnv={...env,ARGON_JOBS:namespace};
  try{
    const started=await (await doPost(jobsEnv,'/api/scene/argon/direct-start',directJob)).json();
    const job=objects.get(started.jobId.slice(3));
    // Simulate a deploy resetting the object mid-call: state is already
    // "submitted", then Cloudflare re-delivers the alarm.
    const queued=await job.ctx.storage.get('job');
    await job.ctx.storage.put('job',{...queued,state:'submitted',submitted:Date.now()});
    assert.deepEqual(await (await doPost(jobsEnv,'/api/scene/argon/status',
      {jobId:started.jobId,shotId:'draft_001'})).json(),{ok:true,status:'in_progress'});
    await job.alarm();
    assert.equal(calls,0,'A submitted job is never sent to Google again');
    const result=await (await doPost(jobsEnv,'/api/scene/argon/status',
      {jobId:started.jobId,shotId:'draft_001'})).json();
    assert.deepEqual([result.status,result.diagnostic.reason],['failed','job_interrupted']);
    assert.equal(await job.ctx.storage.get('request'),undefined);
    // A queued job whose alarm never ran is reported after the window, and a
    // late alarm then finds nothing to send.
    const second=await (await doPost(jobsEnv,'/api/scene/argon/direct-start',directJob)).json();
    const late=objects.get(second.jobId.slice(3));
    const pending=await late.ctx.storage.get('job');
    await late.ctx.storage.put('job',{...pending,created:Date.now()-17*60*1000});
    const expired=await (await doPost(jobsEnv,'/api/scene/argon/status',
      {jobId:second.jobId,shotId:'draft_001'})).json();
    assert.deepEqual([expired.status,expired.diagnostic.reason],['failed','job_not_started']);
    await late.alarm();
    assert.equal(calls,0);
    // Retention: the cleanup alarm removes everything after 24 hours.
    const done=await late.ctx.storage.get('job');
    await late.alarm();
    assert.ok(late.ctx.storage.data.size>0,'Kept within the 24h window');
    await late.ctx.storage.put('job',{...done,finished:Date.now()-24*3600*1000-1});
    await late.alarm();
    assert.equal(late.ctx.storage.data.size,0);
  }finally{globalThis.fetch=prior;}
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
      expected:'Argon rejected output format configuration',category:'output_format',reason:'output_schema'
    },
    {
      message:'Invalid generation_config.thinking_level PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected generation configuration',category:'generation_config',reason:'generation_config'
    },
    {
      message:'Invalid input[2].mime_type PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected image input configuration',category:'image_input',reason:'mime_type'
    },
    // Both incoming images and outgoing structured JSON have mime_type.
    // A bare mention of it must NEVER be falsely labeled an image problem.
    {
      message:'Unsupported mime_type PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected Interactions request',category:'unknown',reason:'mime_type'
    },
    {
      message:'Image request cannot be processed PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected Interactions request',category:'unknown',reason:'media_input_rejected'
    },
    {
      message:'Invalid responseFormat.mimeType PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected output format configuration',category:'output_format',reason:'output_schema'
    },
    {
      message:'Invalid background PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected background execution configuration',category:'background',reason:'unrecognized_message'
    },
    {
      message:'Unsupported model PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected model configuration',category:'model',reason:'unrecognized_message'
    },
    {
      message:'The model cannot process this image in a background request PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected Interactions request',category:'unknown',reason:'media_input_rejected'
    },
    {
      message:'model_interaction request is invalid PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected Interactions request',category:'unknown',reason:'unrecognized_message'
    },
    {
      message:'Unsupported model-specific option PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected Interactions request',category:'unknown',reason:'unrecognized_message'
    },
    {
      message:'Invalid response_format.schema PRIVATE_KEY_DO_NOT_LOG',
      details:[{fieldViolations:[{field:'model_interaction.input[1].mime_type'}]}],
      expected:'Argon rejected image input configuration',category:'image_input',reason:'output_schema'
    },
    {
      message:'Request contains an invalid argument PRIVATE_KEY_DO_NOT_LOG',
      expected:'Argon rejected Interactions request',category:'unknown',reason:'unrecognized_message'
    },
    {
      message:'Uninformative provider text PRIVATE_KEY_DO_NOT_LOG',
      details:[{'@type':'type.googleapis.com/google.rpc.BadRequest',
        fieldViolations:[{field:'model_interaction.input[1].mime_type',
          description:'PRIVATE_FRAME_DATA'}]}],
      expected:'Argon rejected image input configuration',category:'image_input',reason:'unrecognized_message'
    },
    {
      message:'Uninformative provider text PRIVATE_KEY_DO_NOT_LOG',
      details:[{'@type':'type.googleapis.com/google.rpc.BadRequest',
        field_violations:[{field:'response_format.mime_type',
          description:'PRIVATE_FRAME_DATA'}]}],
      expected:'Argon rejected output format configuration',category:'output_format',reason:'unrecognized_message'
    }
  ];
  let calls=0;const logs=[];
  console.warn=(...args)=>logs.push(args);
  try{
    for(const {message,expected,category,reason,details} of samples){
      globalThis.fetch=async(url)=>{
        if(url.includes(':generateContent')){calls++;return new Response(JSON.stringify(analysisResult()));}

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
      const result=JSON.parse(raw);
      assert.deepEqual(Object.keys(result).sort(),['diagnostic','error','ok']);
      assert.equal(result.error,expected,message);
      // The documented error-type code and a recognized message class reach
      // the developer; the provider's own words never do.
      assert.deepEqual({...result.diagnostic,fields:undefined,terms:undefined},
        {phase:'create',http:400,status:null,codes:['invalid_request'],reason,
          fields:undefined,terms:undefined},message);
      assert.ok(!raw.includes('PRIVATE_KEY_DO_NOT_LOG'));
      assert.ok(!raw.includes('PRIVATE_FRAME_DATA'));
      assert.deepEqual(logs.at(-2),['argon-request-400-category',category]);
      assert.deepEqual(logs.at(-1),['argon-provider-diagnostic',JSON.stringify(result.diagnostic)]);
    }
    assert.equal(calls,samples.length*2,'one vision call then one Argon error per test; no retries');
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
