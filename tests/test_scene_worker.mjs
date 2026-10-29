import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {captureArgonRequest,inspectArgonPrompt} from '../scripts/inspect_argon_prompts.mjs';
import worker,{validateInput,validateOutput,validateArgonOutput,secretMatches,argonProviderDiagnostic,ArgonJob,closeTruncatedJson} from '../worker/scene-worker.mjs';

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
  assert.deepEqual(await healthy.json(),{ok:true,service:'paige-scene',ready:true,model:'gemini-3.5-flash-lite',generationProfile:'layered-environment-v1',workerRevision:'video-camera-motion-v1',supportedModels:['gemini-3.5-flash-lite','gemini-3.8-flash'],supportedProfiles:['lite_default','g38_low','g38_medium','argon_previs','argon_direct'],argonDirectJobs:false});
  const unavailable=await worker.fetch(new Request('https://example.workers.dev/health'),{});
  assert.equal(unavailable.status,503);
  const body=await unavailable.text();
  assert.deepEqual(JSON.parse(body),{ok:false,service:'paige-scene',ready:false,model:'gemini-3.5-flash-lite',generationProfile:'layered-environment-v1',workerRevision:'video-camera-motion-v1',supportedModels:['gemini-3.5-flash-lite','gemini-3.8-flash'],supportedProfiles:['lite_default','g38_low','g38_medium','argon_previs','argon_direct'],argonDirectJobs:false});
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
        ['box','sphere','cylinder','plane','torus','cone','wedge','gable','extrude']);
      // Rich fields are optional and carry no length limits (provider 400 risk).
      assert.deepEqual(Object.keys(primitive.properties.repeat.properties),['count','spacing']);
      assert.deepEqual(primitive.properties.points,{type:'array',items:{type:'array',items:{type:'number'}}});
      assert.ok(['emissive','emissiveIntensity','opacity'].every(key=>key in primitive.properties.material.properties));
      assert.ok(!primitive.required.includes('repeat')&&!sceneShape.required.includes('camera'));
      assert.ok(!/minItems|maxItems|minimum|maximum/.test(JSON.stringify(schema)));
      assert.ok(primitive.required.includes('scale'));
      assert.equal(typeof data.input,'string');
      assert.deepEqual(JSON.parse(data.input),visualAnalysis);
      assert.equal(data.previous_interaction_id,undefined);
      assert.match(data.system_instruction,/PREVIS \/ RUNWAY PREP/);
      assert.match(data.system_instruction,/at most 120 objects/);
      assert.match(data.system_instruction,/"repeat":\{"count"/);
      assert.match(data.system_instruction,/untrusted descriptive data/);
      assert.doesNotMatch(data.system_instruction,/You can see the frames directly/,'Direct-only guidance');
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
    idFromName:name=>id(createHash('sha256').update(name).digest('hex')),
    get:objectId=>({fetch:(url,init={})=>object(objectId.toString())
      .fetch(new Request(url,{...init,...(init.body?{duplex:'half'}:{})}))})
  }};
}
const directJob={...sample,profile:'argon_direct',mode:'primary_subject',
  frames:[{at:1.5,imageDataUrl:image},{at:0,imageDataUrl:image},{at:3,imageDataUrl:image}]};
const completedScene=()=>new Response(JSON.stringify({id:'v1_sync',status:'completed',steps:[
  {type:'user_input',content:[{type:'image',data:'PRIVATE_FRAME'}]},
  {type:'model_output',content:[{type:'text',text:JSON.stringify(scene)}]}]}));
const doPost=(jobsEnv,path,body,headers={})=>worker.fetch(new Request('https://example.workers.dev'+path,{
  method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},
  body:JSON.stringify(body)}),jobsEnv);
test('A PHP-named direct job is found after a lost start reply, and a sealed one never starts',async()=>{
  const prior=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return completedScene();};
  const {objects,namespace}=fakeArgonJobs(env),jobsEnv={...env,ARGON_JOBS:namespace};
  const key='ab'.repeat(32),jobId='dk_'+key,status=body=>doPost(jobsEnv,'/api/scene/argon/status',
    {jobId,shotId:'draft_001',...body}).then(async r=>[r.status,await r.json()]);
  try{
    // Before the start arrives the job is simply missing; an unsealed poll creates nothing.
    assert.deepEqual(await status(),[404,{ok:false,error:'No resumable Argon job'}]);
    assert.ok([...objects.values()].every(job=>job.ctx.storage.data.size===0));
    const started=await (await doPost(jobsEnv,'/api/scene/argon/direct-start',directJob,
      {'X-Argon-Job-Key':key})).json();
    assert.deepEqual(started,{ok:true,jobId,status:'queued'},'PHP already knows this id');
    // The same start again (a retried upload) is refused before any paid call.
    assert.equal((await doPost(jobsEnv,'/api/scene/argon/direct-start',directJob,
      {'X-Argon-Job-Key':key})).status,409);
    const job=[...objects.values()].find(item=>item.ctx.storage.data.has('job'));
    await job.alarm();
    assert.equal(calls,1);
    assert.deepEqual((await status({seal:true}))[1],{ok:true,status:'completed',proposal:scene},
      'a seal never touches a job that exists');
    assert.deepEqual(await (await doPost(jobsEnv,'/api/scene/argon/output',{jobId,shotId:'draft_001'})).json(),
      {ok:true,output:JSON.stringify(scene),partial:false});
    // A start that never arrived: the 90-second seal leaves a tombstone, and a
    // late copy of the start is then a 409 that reaches nobody.
    const lostKey='cd'.repeat(32),lost=body=>doPost(jobsEnv,'/api/scene/argon/status',
      {jobId:'dk_'+lostKey,shotId:'draft_001',...body}).then(r=>r.json());
    const sealed=await lost({seal:true});
    assert.deepEqual([sealed.status,sealed.diagnostic.reason],['failed','start_not_received']);
    assert.equal((await doPost(jobsEnv,'/api/scene/argon/direct-start',directJob,
      {'X-Argon-Job-Key':lostKey})).status,409);
    assert.equal((await lost()).diagnostic.reason,'start_not_received');
    assert.equal(calls,1,'nothing more reached Google');
    // Only PHP-named status polls may seal; keys must be 64 hex characters.
    for(const body of [{jobId:'do_'+'b'.repeat(64),shotId:'draft_001',seal:true},
      {jobId,shotId:'draft_001',seal:1},{jobId,shotId:'draft_001',seal:false}])
      assert.equal((await doPost(jobsEnv,'/api/scene/argon/status',body)).status,400);
    assert.equal((await doPost(jobsEnv,'/api/scene/argon/output',{jobId,shotId:'draft_001',seal:true})).status,400);
    for(const bad of ['AB'.repeat(32),'ab'.repeat(31),'zz'.repeat(32)])
      assert.equal((await doPost(jobsEnv,'/api/scene/argon/direct-start',directJob,
        {'X-Argon-Job-Key':bad})).status,400);
    assert.equal(calls,1);
  }finally{globalThis.fetch=prior;}
});
test('Argon repairs unsupported materials without relaxing geometry validation or mutating the original',()=>{
  const materials=['custom shader',null,{color:'#abc',metalness:5,roughness:null,
    emissive:'#f80',emissiveIntensity:99,opacity:-1},
    {...scene.scenes[0].objects[0].material,emissive:'red'}];
  const value={schemaVersion:1,scenes:[{shotId:sample.shotId,objects:materials.map((material,i)=>({
    ...scene.scenes[0].objects[0],id:'part_'+i,material}))}]};
  const original=structuredClone(value),result=validateArgonOutput(value,sample.shotId);
  assert.deepEqual(value,original);
  assert.equal(result.document.scenes[0].objects.length,4);
  assert.deepEqual(result.repairs,{material:4});
  assert.deepEqual(result.document.scenes[0].objects[0].material,
    {color:'#8899aa',metalness:.1,roughness:.7});
  assert.deepEqual(result.document.scenes[0].objects[2].material,
    {color:'#aabbcc',metalness:1,roughness:.7,emissive:'#ff8800',emissiveIntensity:10,opacity:.05});
  assert.deepEqual(result.document.scenes[0].objects[3].material,scene.scenes[0].objects[0].material);
  for(const change of [{primitive:'javascript'},{scale:[-1,2,3]}])
    assert.throws(()=>validateArgonOutput({schemaVersion:1,scenes:[{shotId:sample.shotId,
      objects:[{...value.scenes[0].objects[0],...change}]}]},sample.shotId),/Unusable Argon scene/);
});
test('original output survives validation failure privately and downloads without another paid call',async()=>{
  const oldFetch=globalThis.fetch,oldWarn=console.warn,oldLog=console.log,logs=[];
  console.warn=console.log=(...args)=>logs.push(args);
  const {objects,namespace}=fakeArgonJobs(env),jobsEnv={...env,ARGON_JOBS:namespace};let calls=0;
  const raw=JSON.stringify({schemaVersion:1,scenes:[{shotId:sample.shotId,objects:[{
    ...scene.scenes[0].objects[0],name:'PRIVATE_OUTPUT',primitive:'javascript',material:'custom shader'}]}]});
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({status:'completed',steps:[
    {type:'thought',content:[{type:'text',text:'PRIVATE_THOUGHT'}]},
    {type:'user_input',content:[{type:'text',text:'PRIVATE_FRAME'}]},
    {type:'model_output',content:[{type:'text',text:raw}]}]}));};
  try{
    const started=await (await doPost(jobsEnv,'/api/scene/argon/direct-start',directJob)).json();
    const body={jobId:started.jobId,shotId:sample.shotId},job=objects.get(started.jobId.slice(3));
    await job.alarm();await job.alarm();
    const poll=await (await doPost(jobsEnv,'/api/scene/argon/status',body)).json();
    assert.equal(poll.status,'failed');assert.equal(poll.diagnostic.reason,'scene_schema_mismatch');
    assert.ok(!JSON.stringify(poll).includes('PRIVATE'));
    const saved=await (await doPost(jobsEnv,'/api/scene/argon/output',body)).json();
    assert.deepEqual(saved,{ok:true,output:raw,partial:false});
    assert.ok(!JSON.stringify(saved).includes('PRIVATE_THOUGHT')&&!JSON.stringify(saved).includes('PRIVATE_FRAME'));
    assert.equal(calls,1);assert.equal(await job.ctx.storage.get('request'),undefined);
    assert.ok(!JSON.stringify(logs).includes('PRIVATE'));
    assert.equal((await doPost(jobsEnv,'/api/scene/argon/output',{...body,shotId:'other'})).status,400);
    assert.equal((await doPost(jobsEnv,'/api/scene/argon/output',{...body,url:'https://evil.test'})).status,400);
    assert.equal((await worker.fetch(new Request('https://worker.test/api/scene/argon/output',
      {method:'POST',body:JSON.stringify(body)}),jobsEnv)).status,401);
    const stored=await job.ctx.storage.get('job');
    await job.ctx.storage.put('job',{...stored,finished:Date.now()-25*3600000});
    assert.equal((await doPost(jobsEnv,'/api/scene/argon/output',body)).status,404);
    await job.alarm();assert.equal(await job.ctx.storage.get('output'),undefined);
  }finally{globalThis.fetch=oldFetch;console.warn=oldWarn;console.log=oldLog;}
});
const sse=event=>'data: '+JSON.stringify(event)+'\r\n\r\n';
function streamed(events,{drop=false}={}){
  const bytes=new TextEncoder().encode(': keep-alive\r\n\r\n'+events.map(sse).join(''));
  let at=0;
  return new Response(new ReadableStream({pull(controller){
    if(at>=bytes.length){
      if(drop)controller.error(new TypeError('PRIVATE connection refused'));
      else controller.close();
      return;
    }
    // Deliberately split SSE fields, CRLFs and multibyte UTF-8 characters.
    const end=Math.min(at+7,bytes.length);
    controller.enqueue(bytes.slice(at,end));at=end;
  }}),{headers:{'Content-Type':'text/event-stream; charset=utf-8'}});
}
test('direct-image streaming keeps only model output, terminal status and numeric usage, without replay',async()=>{
  const oldFetch=globalThis.fetch,oldWarn=console.warn,oldLog=console.log,logs=[];
  console.warn=console.log=(...args)=>logs.push(args);
  const run=async respond=>{
    const {objects,namespace}=fakeArgonJobs(env),jobsEnv={...env,ARGON_JOBS:namespace};let calls=0;
    globalThis.fetch=async(_url,opts)=>{
      calls++;assert.equal(JSON.parse(opts.body).stream,true);
      assert.equal(opts.headers.Accept,'text/event-stream');return respond();
    };
    const started=await (await doPost(jobsEnv,'/api/scene/argon/direct-start',directJob)).json();
    const job=objects.get(started.jobId.slice(3));
    await job.alarm();await job.alarm();
    const status=await (await doPost(jobsEnv,'/api/scene/argon/status',
      {jobId:started.jobId,shotId:'draft_001'})).json();
    assert.equal(calls,1);assert.equal(await job.ctx.storage.get('request'),undefined);
    assert.ok(!JSON.stringify(status).includes('PRIVATE'));
    if(await job.ctx.storage.get('output')){
      const original=await (await doPost(jobsEnv,'/api/scene/argon/output',
        {jobId:started.jobId,shotId:'draft_001'})).json();
      assert.equal(original.ok,true);
      assert.equal(original.partial,status.diagnostic?.reason==='provider_stream_interrupted'||
        status.diagnostic?.reason==='provider_stream_error'||!!status.repairs?.truncated);
      assert.ok(!original.output.includes('PRIVATE'));
      assert.equal(calls,1,'Downloading interrupted output never replays generation');
    }
    return status;
  };
  const usage={total_input_tokens:1800,total_output_tokens:400,total_thought_tokens:123,
    total_tokens:2323,private_metadata:'PRIVATE'};
  const start={event_type:'step.start',index:2,step:{type:'model_output'}};
  const delta=text=>({event_type:'step.delta',index:2,delta:{type:'text',text}});
  const end=status=>({event_type:'interaction.completed',interaction:{id:'PRIVATE_ID',status}});
  try{
    const unicode=structuredClone(scene);unicode.scenes[0].objects[0].name='Café 🏠';
    const output=JSON.stringify(unicode),split=output.indexOf('Café')+4;
    const result=await run(()=>streamed([
      {event_type:'interaction.created',interaction:{id:'PRIVATE_ID',status:'in_progress'}},
      {event_type:'step.start',index:0,step:{type:'thought'}},
      {event_type:'step.delta',index:0,delta:{type:'text',text:'PRIVATE thoughts'}},
      {event_type:'step.start',index:1,step:{type:'user_input',content:[{type:'text',text:'PRIVATE_FRAME'}]}},
      start,delta(output.slice(0,split)),{...delta(output.slice(split)),metadata:{total_usage:usage}},
      {event_type:'step.stop',index:2,usage},end('completed')
    ]));
    assert.equal(result.status,'completed');assert.deepEqual(result.proposal,unicode);
    assert.deepEqual(result.usage,{input:1800,thinking:123,output:400,total:2323,cap:32768});
    // The optional final snapshot is authoritative; never append it twice.
    const snapshot=await run(()=>streamed([start,delta(output),
      {...end('completed'),interaction:{status:'completed',steps:[{type:'model_output',
        content:[{type:'text',text:JSON.stringify(scene)}]}]}}]));
    assert.deepEqual(snapshot.proposal,scene);
    const cut=JSON.stringify(scene).slice(0,-3)+',{"id":"unfinished';
    const incomplete=await run(()=>streamed([start,delta(cut),end('incomplete')]));
    assert.equal(incomplete.status,'completed');assert.equal(incomplete.repairs.truncated,1);
    assert.equal(incomplete.proposal.scenes[0].objects[0].id,'box_1');
    // EOF or a network error never masquerades as a completed paid result.
    for(const drop of [false,true]){
      const broken=await run(()=>streamed([start,{...delta(output),metadata:{total_usage:usage}}],{drop}));
      assert.equal(broken.status,'failed');
      assert.equal(broken.diagnostic.reason,'provider_stream_interrupted');
      assert.equal(broken.usage.output,400);
    }
    const error=await run(()=>streamed([start,{...delta(output),metadata:{total_usage:usage}},
      {event_type:'error',error:{code:'deadline_exceeded',message:'PRIVATE server deadline'}}]));
    assert.equal(error.diagnostic.reason,'provider_stream_error');
    assert.deepEqual(error.diagnostic.codes,['deadline_exceeded']);
    assert.equal(error.usage.thinking,123);
    const large=await run(()=>streamed([start,delta(output.padEnd(280000,' ')),end('completed')]));
    assert.equal(large.status,'completed','valid output at the expanded bound survives');
    const huge=await run(()=>streamed([start,delta('x'.repeat(280001)),end('completed')]));
    assert.equal(huge.diagnostic.reason,'no_usable_scene');
    assert.ok(!JSON.stringify(logs).includes('PRIVATE'));
  }finally{globalThis.fetch=oldFetch;console.warn=oldWarn;console.log=oldLog;}
});
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
    // Ask Google for a deadline just under our own 12-minute abort (as the official SDK does).
    assert.equal(opts.headers['X-Server-Timeout'],'690');
    const body=JSON.parse(opts.body);
    // Synchronous and stateless: no background, and Google stores nothing.
    assert.deepEqual(Object.keys(body).sort(),['generation_config','input','model',
      'response_format','store','stream','system_instruction']);
    assert.equal(body.model,'gemini-4-argon');
    assert.equal(body.store,false);
    assert.equal(body.stream,true);
    assert.equal(body.background,undefined);
    assert.deepEqual(body.generation_config,{thinking_level:'medium',max_output_tokens:32768});
    assert.deepEqual(body.response_format.schema.required,['schemaVersion','scenes']);
    assert.match(body.system_instruction,/PREVIS \/ RUNWAY PREP/);
    assert.match(body.system_instruction,/never an\s+instruction/);
    assert.match(body.system_instruction,/draft_001/);
    assert.match(body.system_instruction,/You can see the frames directly/);
    assert.match(body.system_instruction,/window grids \(with repeat\)/);
    assert.match(body.system_instruction,/at most 120 objects/);
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
    await reason(()=>new Response('PRIVATE',{status:500}),'provider_internal');
    const gateway=await reason(()=>new Response('PRIVATE',{status:502}),'provider_gateway');
    assert.equal(gateway.diagnostic.http,502);
    await reason(()=>new Response('PRIVATE',{status:501}),'provider_unavailable');
    // A server error keeps only its fixed codes and terms from the body.
    const late=await reason(()=>new Response(JSON.stringify({error:{code:504,status:'DEADLINE_EXCEEDED',
      message:'Deadline expired before operation could complete. PRIVATE'}}),{status:504}),'provider_deadline');
    assert.deepEqual(late.diagnostic,{phase:'job',http:504,status:'failed',codes:['DEADLINE_EXCEEDED'],
      reason:'provider_deadline',fields:[],terms:[]});
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
    const retained=await (await broken.job.fetch(new Request('https://argon-job/output?shot=draft_001'))).json();
    assert.deepEqual(JSON.parse(retained.output),scene,'original saved before final job persistence failed');
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
      {jobId:started.jobId,shotId:'draft_001'})).json(),{ok:true,status:'in_progress',phase:'waiting',elapsedSeconds:0});
    await job.alarm();
    assert.equal(calls,0,'A submitted job is never sent to Google again');
    const result=await (await doPost(jobsEnv,'/api/scene/argon/status',
      {jobId:started.jobId,shotId:'draft_001'})).json();
    assert.deepEqual([result.status,result.diagnostic.reason],['failed','job_interrupted']);
    assert.equal(await job.ctx.storage.get('request'),undefined);
    // A deploy restarts the object on a new Worker version: the job records
    // the version it was submitted on, so the interruption names the deploy.
    const before=fakeArgonJobs({...env,CF_VERSION_METADATA:{id:'0a1b2c3d-0000-4000-8000-000000000001'}});
    const firstId=(await (await doPost({...env,ARGON_JOBS:before.namespace},'/api/scene/argon/direct-start',
      directJob)).json()).jobId.slice(3);
    const submitting=before.objects.get(firstId);
    let atReset=null,resetCalls=0;
    globalThis.fetch=async()=>{resetCalls++;
      atReset=structuredClone(submitting.ctx.storage.data); // what a reset mid-call leaves behind
      throw Error('stands in for the reset');};
    await submitting.alarm();
    assert.equal(resetCalls,1);
    assert.deepEqual([atReset.get('job').state,atReset.get('job').version],
      ['submitted','0a1b2c3d-0000-4000-8000-000000000001'],'version stored with the marker, before the paid call');
    submitting.ctx.storage.data=atReset;
    submitting.env={...env,CF_VERSION_METADATA:{id:'0a1b2c3d-0000-4000-8000-000000000002'}};
    await submitting.alarm();
    assert.equal(resetCalls,1,'The new version never calls Google again');
    assert.equal((await submitting.ctx.storage.get('job')).diagnostic.reason,'job_interrupted_deploy');
    // Same version (no deploy), or no binding: the generic reason stays.
    for(const [stored,current] of [['0a1b2c3d-0000-4000-8000-000000000001','0a1b2c3d-0000-4000-8000-000000000001'],
      [undefined,'0a1b2c3d-0000-4000-8000-000000000002'],['0a1b2c3d-0000-4000-8000-000000000001',undefined]]){
      const other=fakeArgonJobs(env);
      const otherId=(await (await doPost({...env,ARGON_JOBS:other.namespace},'/api/scene/argon/direct-start',
        directJob)).json()).jobId.slice(3);
      const object=other.objects.get(otherId),queuedJob=await object.ctx.storage.get('job');
      await object.ctx.storage.put('job',{...queuedJob,state:'submitted',submitted:Date.now(),
        ...(stored?{version:stored}:{})});
      object.env={...env,...(current?{CF_VERSION_METADATA:{id:current}}:{})};
      await object.alarm();
      assert.equal((await object.ctx.storage.get('job')).diagnostic.reason,'job_interrupted');
    }
    // The 16-minute status check uses the same comparison.
    const polled=fakeArgonJobs(env);
    const polledId=(await (await doPost({...env,ARGON_JOBS:polled.namespace},'/api/scene/argon/direct-start',
      directJob)).json()).jobId.slice(3);
    const polledJob=polled.objects.get(polledId),open=await polledJob.ctx.storage.get('job');
    await polledJob.ctx.storage.put('job',{...open,state:'submitted',submitted:Date.now()-17*60*1000,
      version:'0a1b2c3d-0000-4000-8000-000000000001'});
    polledJob.env={...env,CF_VERSION_METADATA:{id:'0a1b2c3d-0000-4000-8000-000000000002'}};
    const late16=await (await polledJob.fetch(new Request('https://argon-job/status?shot=draft_001'))).json();
    assert.deepEqual([late16.status,late16.diagnostic.reason],['failed','job_interrupted_deploy']);
    globalThis.fetch=async()=>{calls++;return completedScene();};
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
    // A finished job is final: unreadable output is a failed job, not a retryable error.
    assert.equal(result.status,200);
    const raw=await result.text();
    assert.ok(!raw.includes('SENSITIVE_PRIVATE_THOUGHT'));
    assert.deepEqual(JSON.parse(raw),{ok:true,status:'failed',diagnostic:{phase:'job',http:null,
      status:'failed',codes:['json'],reason:'scene_schema_mismatch',fields:[],terms:[]}});
  }finally{globalThis.fetch=prior;}
});

test('Argon results keep every valid part, report what was repaired, and fail only when nothing is usable',async()=>{
  const prior=globalThis.fetch;const id='v1_validation_12345';
  const object=scene.scenes[0].objects[0];
  let proposal;
  globalThis.fetch=async(url,opts)=>{
    assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions/'+id);
    assert.equal(opts.body,undefined,'Polling must not submit paid generation');
    return new Response(JSON.stringify({id,status:'completed',steps:[
      {type:'model_output',content:[{type:'text',text:JSON.stringify(proposal)}]}]}));
  };
  const poll=async value=>{
    proposal=value;
    const response=await worker.fetch(new Request('https://example.workers.dev/api/scene/argon/status',{
      method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({jobId:id,shotId:sample.shotId})}),env);
    assert.equal(response.status,200);
    return response.json();
  };
  const only=objects=>({schemaVersion:1,scenes:[{shotId:sample.shotId,objects}]});
  try{
    // Nothing usable: a failed job whose codes name the rule, never model text.
    for(const [value,codes] of [
      [only([{...object,primitive:'javascript'}]),['primitive']],
      [only([{...object,scale:[-1,2,3]}]),['scale']],
      [only([{...object,primitive:'extrude'}]),['footprint']],
      [only([{...object,repeat:{count:[50,50,1],spacing:[1,1,0]}}]),['repeat']],
      [only(['PRIVATE text',[1,2]]),['object']],
      [only([]),['empty']], // live 2026-10-23: high thinking, Maximum detail
      [{schemaVersion:1,scenes:[{shotId:sample.shotId}]},['empty']],
      [{schemaVersion:1,scenes:[]},['scene']],
      [{schemaVersion:1},['scene']]
    ]){
      const result=await poll(value);
      assert.equal(result.status,'failed');
      assert.deepEqual(result.diagnostic,{phase:'job',http:null,status:'failed',codes,
        reason:'scene_schema_mismatch',fields:[],terms:[]});
      assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    }
    // Bad parts are dropped, the rest kept, and each repair is counted.
    const parts=await poll({schemaVersion:2,scenes:[{shotId:'wrong_shot',objects:[
      object,{...object},{...object,id:'js',primitive:'javascript'},{...object,id:'neg',scale:[-1,2,3]},
      {...object,id:'ext',primitive:'extrude'},{...object,id:'grid',repeat:{count:[50,50,1],spacing:[1,1,0]}},
      {...object,id:'red',material:{...object.material,emissive:'red'}},'PRIVATE text',
      {...object,id:'bad id!'},{...object,id:'long',name:'x'.repeat(101)},{...object,id:'far',position:[0,null,0]},
      // An id that reads like a rule never picks the code.
      {...object,id:'repeat',material:{...object.material,color:'blue'}}]}]});
    assert.equal(parts.status,'completed');
    assert.deepEqual(parts.proposal.scenes[0].objects.map(item=>item.id),['box_1','box_1_2','red','repeat']);
    assert.equal(parts.proposal.scenes[0].shotId,sample.shotId,'filed under the job\'s shot');
    assert.deepEqual(parts.repairs,{shot_id:1,duplicate_id:1,primitive:1,scale:1,footprint:1,repeat:1,
      material:2,object:1,id:1,name:1,transform:1});
    // Merged scenes within the 240-object cap, then the 2000-copy budget (largest arrays first).
    const grid=i=>({...object,id:'grid_'+i,repeat:{count:[20,20,1],spacing:[1,1,0]}});
    const part=i=>({...object,id:'part_'+i});
    const capped=await poll({schemaVersion:1,scenes:[
      {shotId:sample.shotId,objects:[...Array.from({length:6},(_,i)=>grid(i)),...Array.from({length:100},(_,i)=>part(i))]},
      {shotId:sample.shotId,objects:Array.from({length:100},(_,i)=>part(100+i))}]});
    assert.equal(capped.proposal.scenes[0].objects.length,204);
    assert.equal(capped.proposal.scenes[0].objects.filter(item=>item.repeat).length,4);
    assert.deepEqual(capped.repairs,{scenes_merged:1,scene_copies:2});
    // Lights and camera: invalid ones dropped, at most 8 kept, names keep their place.
    const point=(extra={})=>({type:'point',color:'#ffcc88',intensity:20,position:[0,4,0],...extra});
    const lit=await poll({schemaVersion:1,scenes:[{shotId:sample.shotId,
      camera:{position:[0,1,0],target:[0,1,0],fov:40},objects:[object],
      lights:[point(),point({type:'ambient'}),point(),...Array.from({length:31},(_,i)=>point({name:'Lamp '+i}))]}]});
    assert.deepEqual(lit.proposal.scenes[0].lights.map(light=>light.name),
      ['point light 1','point light 2',...Array.from({length:30},(_,i)=>'Lamp '+i)]);
    assert.equal(lit.proposal.scenes[0].lights.length,32);
    assert.equal(lit.proposal.scenes[0].camera,undefined);
    assert.deepEqual(lit.repairs,{light:1,light_cap:1,camera:1});
    // A clean scene reports no repairs at all.
    assert.equal((await poll(only([object]))).repairs,undefined);
    globalThis.fetch=async()=>new Response(JSON.stringify({id,status:'completed',steps:{private:'SECRET'}}));
    const response=await worker.fetch(new Request('https://example.workers.dev/api/scene/argon/status',{
      method:'POST',headers:{Authorization:'Bearer '+token},
      body:JSON.stringify({jobId:id,shotId:sample.shotId})
    }),env);
    assert.equal(response.status,502);
    assert.deepEqual(await response.json(),{ok:false,error:'Provider produced no usable scene'});
  }finally{globalThis.fetch=prior;}
});

test('Argon may return 120 rich objects: new shapes, repeat arrays, glow, glass and a camera',async()=>{
  const prior=globalThis.fetch;const id='v1_rich_scene_12345';
  const material={color:'#AABBCC',metalness:.2,roughness:.5};
  const objects=Array.from({length:116},(_,i)=>({id:'part_'+i,name:'Part '+i,primitive:'box',
    position:[i%10,0.5,-Math.floor(i/10)],rotation:[0,0,0],scale:[.8,1,.8],material}));
  objects.push(
    {id:'roof',name:'Gable roof',primitive:'gable',position:[0,8,0],rotation:[0,0,0],scale:[10,2,14],material},
    {id:'podium',name:'L podium',primitive:'extrude',position:[0,.5,0],rotation:[0,0,0],scale:[20,1,20],
      points:[[-.5,-.5],[.5,-.5],[.5,0],[0,0],[0,.5],[-.5,.5]],material},
    {id:'windows',name:'Window grid',primitive:'box',position:[0,4,7.1],rotation:[0,0,0],scale:[1.2,1.6,.08],
      repeat:{count:[8,3,1],spacing:[1.6,2.4,0]},material:{...material,emissive:'#FFDD99',emissiveIntensity:1.5,opacity:.7}},
    // A stray environment layer is dropped instead of failing a paid result.
    {id:'lamp',name:'Lamp post',primitive:'cone',position:[6,1.5,9],rotation:[0,0,0],scale:[.4,3,.4],layer:'street',material});
  const proposal={schemaVersion:1,scenes:[{shotId:sample.shotId,
    camera:{position:[4,6,30],target:[0,3,0],fov:38},objects}]};
  globalThis.fetch=async(url,opts)=>{
    assert.equal(opts.body,undefined,'Polling must not submit paid generation');
    return new Response(JSON.stringify({id,status:'completed',steps:[
      {type:'model_output',content:[{type:'text',text:JSON.stringify(proposal)}]}]}));
  };
  try{
    const response=await worker.fetch(new Request('https://example.workers.dev/api/scene/argon/status',{
      method:'POST',headers:{Authorization:'Bearer '+token},
      body:JSON.stringify({jobId:id,shotId:sample.shotId})}),env);
    assert.equal(response.status,200);
    const scene=(await response.json()).proposal.scenes[0];
    assert.equal(scene.objects.length,120);
    assert.deepEqual(scene.camera,{position:[4,6,30],target:[0,3,0],fov:38});
    const byId=Object.fromEntries(scene.objects.map(item=>[item.id,item]));
    assert.equal(byId.roof.primitive,'gable');
    assert.equal(byId.podium.points.length,6);
    assert.deepEqual(byId.windows.repeat,{count:[8,3,1],spacing:[1.6,2.4,0]});
    assert.deepEqual(byId.windows.material,{color:'#aabbcc',metalness:.2,roughness:.5,
      emissive:'#ffdd99',emissiveIntensity:1.5,opacity:.7});
    assert.equal(byId.lamp.layer,undefined);
  }finally{globalThis.fetch=prior;}
  // Flash keeps its own five-primitive contract and budgets.
  assert.throws(()=>validateOutput(proposal,sample.shotId,48),/budget/);
  assert.throws(()=>validateOutput({schemaVersion:1,scenes:[{shotId:sample.shotId,objects:objects.slice(116,117)}]},
    sample.shotId),/Unsupported/);
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

// Token usage: only fixed numeric fields leave the Worker, on every finished
// job (completed, failed or unusable), and each is logged as argon-usage.
const argonPost=(jobsEnv,path,body)=>worker.fetch(new Request('https://example.workers.dev'+path,{
  method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
  body:JSON.stringify(body)}),jobsEnv);
const interactionUsage={total_input_tokens:1800,total_output_tokens:11204,total_thought_tokens:9120,
  total_tokens:22124,input_tokens_by_modality:[{modality:'text',tokens:1800}],
  total_cached_tokens:'12',total_tool_use_tokens:-1,grounding_tool_count:[{type:'PRIVATE_TOOL'}],
  private_metadata:'PRIVATE_USAGE'};
const geometryCounts={input:1800,thinking:9120,output:11204,total:22124};
function captureUsageLogs(){
  const priorLog=console.log,priorWarn=console.warn,lines=[],all=[];
  console.log=(...args)=>{all.push(args.join(' '));if(args[0]==='argon-usage')lines.push(JSON.parse(args[1]));};
  console.warn=(...args)=>all.push(args.join(' '));
  return {lines,all,restore:()=>{console.log=priorLog;console.warn=priorWarn;}};
}
test('Argon Previs reports Flash-Lite and Argon token counts, never other usage data',async()=>{
  const prior=globalThis.fetch,logs=captureUsageLogs(),id='v1_usage_previs_1';
  let interaction={id,status:'completed',usage:interactionUsage,steps:[
    {type:'model_output',content:[{type:'text',text:JSON.stringify(scene)}]}]};
  let createStatus=200;
  globalThis.fetch=async(url,opts)=>{
    if(url.endsWith(':generateContent'))return new Response(JSON.stringify({...analysisResult(),
      usageMetadata:{promptTokenCount:5210,candidatesTokenCount:812,thoughtsTokenCount:0,totalTokenCount:6022,
        promptTokensDetails:[{modality:'TEXT',tokenCount:566},{modality:'IMAGE',tokenCount:4644}],
        cachedContentTokenCount:-5,trafficType:'PRIVATE_TRAFFIC'}}));
    if(opts.method==='POST')return createStatus===200?new Response(JSON.stringify({id,status:'queued'}))
      :new Response(JSON.stringify({error:{code:'invalid_request',message:'response_format schema PRIVATE'}}),{status:400});
    return new Response(JSON.stringify(interaction));
  };
  const analysis={input:5210,inputImage:4644,thinking:0,output:812,total:6022,cap:4096};
  const body={...sample,profile:'argon_previs',mode:'primary_subject'};
  const poll=()=>argonPost(env,'/api/scene/argon/status',{jobId:id,shotId:'draft_001'});
  try{
    assert.deepEqual(await (await argonPost(env,'/api/scene/argon/start',body)).json(),
      {ok:true,jobId:id,status:'queued',usage:analysis});
    // Argon rejecting the job keeps the (billed) analysis count and diagnostic.
    createStatus=400;
    const rejected=await argonPost(env,'/api/scene/argon/start',body);
    assert.equal(rejected.status,502);
    const rejection=await rejected.json();
    assert.deepEqual(rejection.usage,analysis);assert.equal(rejection.diagnostic.reason,'output_schema');
    const geometry={...geometryCounts,cap:28672};
    assert.deepEqual(await (await poll()).json(),{ok:true,status:'completed',proposal:scene,usage:geometry});
    // Cut off with nothing complete to keep: still a failed job.
    interaction={...interaction,status:'incomplete',steps:[{type:'model_output',content:[{type:'text',text:'{"schemaVersion":1,"sce'}]}]};
    const failed=await (await poll()).json();
    assert.equal(failed.status,'failed');assert.equal(failed.diagnostic.reason,'incomplete_output');
    assert.deepEqual(failed.usage,geometry);
    interaction={...interaction,status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'{"schemaVersion":1}'}]}]};
    const unusable=await (await poll()).json();
    assert.equal(unusable.status,'failed');assert.deepEqual(unusable.diagnostic.codes,['scene']);
    assert.deepEqual(unusable.usage,geometry);
    // No usage object: no usage field, exactly as before.
    interaction={id,status:'in_progress',usage:interactionUsage};
    assert.deepEqual(await (await poll()).json(),{ok:true,status:'in_progress'});
    assert.deepEqual(logs.lines.map(line=>line.stage),['analysis','analysis','geometry','geometry','geometry']);
    assert.deepEqual(logs.lines[0],{profile:'argon_previs',stage:'analysis',...analysis});
    assert.deepEqual(logs.lines[2],{profile:'argon_previs',stage:'geometry',...geometry});
    assert.ok(logs.all.every(line=>!line.includes('PRIVATE')),'Only counts are logged');
  }finally{globalThis.fetch=prior;logs.restore();}
});
test('Direct-image Argon stores its token counts once and returns them with the result',async()=>{
  const prior=globalThis.fetch,logs=captureUsageLogs();
  // A cut-off answer that still holds complete objects is kept (see the truncation test).
  for(const [outcome,status] of [['completed','completed'],['incomplete','completed'],['no_usage','completed']]){
    const {objects,namespace}=fakeArgonJobs(env);
    const jobsEnv={...env,ARGON_JOBS:namespace};
    globalThis.fetch=async()=>new Response(JSON.stringify({id:'v1_sync',
      status:outcome==='incomplete'?'incomplete':'completed',
      ...(outcome==='no_usage'?{}:{usage:interactionUsage}),
      steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify(scene)}]}]}));
    const started=await (await argonPost(jobsEnv,'/api/scene/argon/direct-start',directJob)).json();
    const job=objects.get(started.jobId.slice(3));
    await job.alarm();await job.alarm(); // at-least-once delivery
    const result=await (await argonPost(jobsEnv,'/api/scene/argon/status',
      {jobId:started.jobId,shotId:'draft_001'})).json();
    assert.equal(result.status,status);
    if(outcome==='no_usage')assert.equal(result.usage,undefined);
    else assert.deepEqual(result.usage,{...geometryCounts,cap:32768});
    if(status==='failed')assert.equal(result.diagnostic.reason,'incomplete_output');
  }
  try{
    assert.equal(logs.lines.length,2,'One log line per paid call, despite repeated alarms');
    assert.deepEqual(logs.lines[0],{profile:'argon_direct',stage:'geometry',...geometryCounts,cap:32768});
    assert.ok(logs.all.every(line=>!line.includes('PRIVATE')));
  }finally{globalThis.fetch=prior;logs.restore();}
});

test('Argon sorts objects into editor layers, may add lights, and direct image can rebuild the full scene',async()=>{
  const prior=globalThis.fetch,bodies=[];
  const material={color:'#334455',metalness:.1,roughness:.6};
  const lights=[{type:'directional',name:'Moon',color:'#AABBFF',intensity:1,position:[30,60,40],target:[0,0,0]},
    {type:'point',name:'Lamp',color:'#ffcc88',intensity:25,position:[6,5,8],distance:30}];
  const proposal={schemaVersion:1,scenes:[{shotId:'draft_001',lights,objects:[
    {id:'hall',name:'Hall',layer:'structures',primitive:'box',position:[0,3,0],rotation:[0,0,0],scale:[20,6,12],material},
    {id:'road',name:'Road',layer:'ground',primitive:'plane',position:[0,.01,12],rotation:[-1.571,0,0],scale:[40,6,1],material},
    {id:'odd',name:'Odd',layer:'PRIVATE_layer',primitive:'box',position:[5,1,5],rotation:[0,0,0],scale:[1,1,1],material}]}]};
  globalThis.fetch=async(url,opts)=>{
    bodies.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({id:'v1_sync',status:'completed',
      steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify(proposal)}]}]}));
  };
  try{
    const results={};
    for(const mode of ['primary_subject','full_scene']){
      const {objects,namespace}=fakeArgonJobs(env);
      const jobsEnv={...env,ARGON_JOBS:namespace};
      const started=await (await argonPost(jobsEnv,'/api/scene/argon/direct-start',{...directJob,mode})).json();
      assert.equal(started.status,'queued');
      const job=objects.get(started.jobId.slice(3));
      assert.equal((await job.ctx.storage.get('request')).mode,mode);
      await job.alarm();
      results[mode]=await (await argonPost(jobsEnv,'/api/scene/argon/status',
        {jobId:started.jobId,shotId:'draft_001'})).json();
    }
    const [primary,full]=bodies;
    assert.match(primary.system_instruction,/SCOPE: PRIMARY SUBJECT/);
    assert.doesNotMatch(primary.system_instruction,/FULL SCENE/);
    assert.match(full.system_instruction,/SCOPE: FULL SCENE\. Rebuild the whole visible environment/);
    assert.match(full.system_instruction,/Target 80 to 120 objects/);
    assert.doesNotMatch(full.system_instruction,/PRIMARY SUBJECT/);
    for(const body of bodies){
      // Same single synchronous call and frames; only the scope text differs.
      assert.equal(body.store,false);
    assert.equal(body.stream,true);assert.equal(body.background,undefined);
      assert.equal(body.input.length,6);
      assert.match(body.system_instruction,/layer: "structures"/);
      assert.match(body.system_instruction,/scene "lights": up to 32 lights/);
      const objectShape=body.response_format.schema.properties.scenes.items.properties.objects.items;
      assert.deepEqual(objectShape.properties.layer,{type:'string',enum:['structures','ground','vegetation','details']});
      assert.ok(objectShape.required.includes('layer'));
      const lightShape=body.response_format.schema.properties.scenes.items.properties.lights.items;
      assert.deepEqual(lightShape.properties.type.enum,['directional','point','spot']);
      assert.deepEqual(lightShape.required,['type','color','intensity','position']);
    }
    for(const result of Object.values(results)){
      const scene=result.proposal.scenes[0];
      assert.deepEqual(scene.objects.map(item=>item.layer),['structures','ground',undefined]);
      assert.deepEqual(scene.lights.map(light=>[light.type,light.color]),[['directional','#aabbff'],['point','#ffcc88']]);
    }
    // Every other scope is refused before anything is stored or sent.
    const {namespace}=fakeArgonJobs(env);
    for(const mode of ['environment',undefined,'FULL_SCENE'])
      assert.equal((await argonPost({...env,ARGON_JOBS:namespace},'/api/scene/argon/direct-start',
        {...directJob,mode})).status,400);
    assert.equal(bodies.length,2);
    // Previs stays primary-subject only.
    assert.equal((await argonPost(env,'/api/scene/argon/start',
      {...sample,profile:'argon_previs',mode:'full_scene'})).status,400);
    // A job stored before scopes existed runs as primary subject.
    const legacy=fakeArgonJobs(env);
    const started=await (await argonPost({...env,ARGON_JOBS:legacy.namespace},'/api/scene/argon/direct-start',directJob)).json();
    const job=legacy.objects.get(started.jobId.slice(3));
    const stored=await job.ctx.storage.get('request');delete stored.mode;
    await job.ctx.storage.put('request',stored);await job.alarm();
    assert.match(bodies[2].system_instruction,/SCOPE: PRIMARY SUBJECT/);
  }finally{globalThis.fetch=prior;}
});

test('Direct-image jobs keep a salvaged scene with its repairs, and report an unusable one with codes',async()=>{
  const prior=globalThis.fetch,priorWarn=console.warn,warnings=[];
  console.warn=(...args)=>warnings.push(args.join(' '));
  const object=scene.scenes[0].objects[0];
  const run=async proposal=>{
    globalThis.fetch=async()=>new Response(JSON.stringify({id:'v1_sync',status:'completed',
      steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify(proposal)}]}]}));
    const {objects,namespace}=fakeArgonJobs(env);
    const jobsEnv={...env,ARGON_JOBS:namespace};
    const started=await (await argonPost(jobsEnv,'/api/scene/argon/direct-start',{...directJob,mode:'full_scene'})).json();
    await objects.get(started.jobId.slice(3)).alarm();
    return (await argonPost(jobsEnv,'/api/scene/argon/status',{jobId:started.jobId,shotId:'draft_001'})).json();
  };
  try{
    const kept=await run({schemaVersion:1,scenes:[{shotId:'draft_001',objects:[object,
      {...object,id:'huge',scale:[3000,1,3000]},{...object,id:'row',repeat:{count:[120,1,1],spacing:[1,0,0]}}]}]});
    assert.equal(kept.status,'completed');
    assert.deepEqual(kept.proposal.scenes[0].objects.map(item=>item.id),['box_1']);
    assert.deepEqual(kept.repairs,{scale:1,repeat:1});
    const lost=await run({schemaVersion:1,scenes:[{shotId:'draft_001',objects:[{...object,scale:[3000,1,3000]}]}]});
    assert.equal(lost.status,'failed');
    assert.deepEqual(lost.diagnostic.codes,['scale']);assert.equal(lost.diagnostic.reason,'scene_schema_mismatch');
    assert.equal(lost.repairs,undefined);
    // Cloudflare logs carry only the codes.
    assert.ok(warnings.some(line=>line==='argon-output-repairs {"profile":"argon_direct","scale":1,"repeat":1}'));
  }finally{globalThis.fetch=prior;console.warn=priorWarn;}
});

test('a cut-off answer closes after its last complete element, never inside a string',()=>{
  const full=JSON.stringify({schemaVersion:1,scenes:[{shotId:'draft_001',objects:[
    {id:'a',name:'Say "hi" [x]',points:[[0,0],[1,0],[0,1]]},{id:'b',name:'Brace } in text'},{id:'c',name:'cut'}]}]});
  const cutAt=marker=>full.slice(0,full.indexOf(marker));
  // Mid third object: the first two are kept whole, the partial one never.
  assert.deepEqual(closeTruncatedJson(cutAt('"cut"')).scenes[0].objects.map(o=>o.id),['a','b']);
  assert.deepEqual(closeTruncatedJson(cutAt('{"id":"c"')).scenes[0].objects.map(o=>o.id),['a','b']);
  // Brackets and escaped quotes inside strings never count as structure.
  assert.deepEqual(closeTruncatedJson(cutAt('in text')).scenes[0].objects.map(o=>o.id),['a']);
  // Inside a footprint: points that finished are kept.
  assert.deepEqual(closeTruncatedJson(cutAt('[0,1]')).scenes[0].objects[0].points,[[0,0],[1,0]]);
  for(const prefix of ['','{"schemaVersion":1,"sce','{"schemaVersion":1,"scenes":[{"shotId":"x","objects":[{"id":"a"'])
    assert.throws(()=>closeTruncatedJson(prefix),SyntaxError);
});

test('Argon thinking and detail settings reach Google, change the prompt and are strictly allowlisted',async()=>{
  const prior=globalThis.fetch,bodies=[];
  globalThis.fetch=async(url,opts)=>{
    if(url.endsWith(':generateContent'))return new Response(JSON.stringify(analysisResult()));
    bodies.push(JSON.parse(opts.body));
    return url.endsWith('/interactions')&&!JSON.parse(opts.body).background?completedScene()
      :new Response(JSON.stringify({id:'v1_settings_1',status:'queued'}));
  };
  const direct=async extra=>{
    const {objects,namespace}=fakeArgonJobs(env);
    const response=await argonPost({...env,ARGON_JOBS:namespace},'/api/scene/argon/direct-start',{...directJob,...extra});
    if(response.status!==200)return response.status;
    const started=await response.json();
    const job=objects.get(started.jobId.slice(3));
    await job.alarm();
    return job;
  };
  try{
    // Defaults: medium thinking, standard detail (older editors send neither).
    await direct({mode:'full_scene'});
    let body=bodies.at(-1);
    assert.equal(body.generation_config.thinking_level,'medium');
    assert.match(body.system_instruction,/at most 120 objects, 32 lights/);
    assert.match(body.system_instruction,/Target 80 to 120 objects/);
    assert.doesNotMatch(body.system_instruction,/DETAIL:/);
    // Standard is the prompt of the live 69-, 71- and 85-object scenes, unchanged.
    assert.match(body.system_instruction,/and complete: an unfinished answer is discarded\./);
    assert.doesNotMatch(body.system_instruction,/BUDGET_END|two stages|Never return an empty/);
    // Chosen settings: stored with the job and sent to Google.
    const job=await direct({mode:'full_scene',thinking:'high',detail:'max'});
    body=bodies.at(-1);
    assert.equal(body.generation_config.thinking_level,'high');
    assert.equal(body.generation_config.max_output_tokens,32768,'the token budget never changes');
    assert.match(body.system_instruction,/at most 240 objects, 32 lights/);
    assert.match(body.system_instruction,/DETAIL: MAXIMUM/);
    // Live: High and Maximum answered with empty scenes, so they build on the
    // Standard scene in the same answer and rule out an empty one.
    assert.match(body.system_instruction,/every main mass, about 80 to 120 objects\. Then keep\s+adding finer attached parts, as DETAIL above asks, until about 180 to 230 objects\./);
    assert.match(body.system_instruction,/Never return an empty objects array/);
    assert.match(body.system_instruction,/cut off at the output limit keeps only the\s+objects it finished/);
    assert.doesNotMatch(body.system_instruction,/discarded|BUDGET_END/);
    assert.equal(job.ctx.storage.data.get('request'),undefined,'frames removed after the call');
    await direct({mode:'primary_subject',thinking:'minimal',detail:'high'});
    body=bodies.at(-1);
    assert.equal(body.generation_config.thinking_level,'minimal');
    assert.match(body.system_instruction,/DETAIL: HIGH/);
    assert.match(body.system_instruction,/about 48 to 96 objects\. Then keep[\s\S]*until about 80 to 130 objects\./);
    assert.match(body.system_instruction,/Never return an empty objects array/);
    // Previs uses the same settings for its background geometry call.
    const previs=await argonPost(env,'/api/scene/argon/start',{...sample,profile:'argon_previs',
      mode:'primary_subject',thinking:'low',detail:'high'});
    assert.equal(previs.status,200);
    body=bodies.at(-1);
    assert.equal(body.background,true);assert.equal(body.generation_config.thinking_level,'low');
    assert.match(body.system_instruction,/at most 150 objects/);
    const sent=bodies.length;
    for(const extra of [{thinking:'ultra'},{thinking:'HIGH'},{detail:'extreme'},{detail:'__proto__'},
      {detail:'constructor'},{thinking:7},{detail:null}]){
      assert.equal(await direct({mode:'full_scene',...extra}),400,JSON.stringify(extra));
      assert.equal((await argonPost(env,'/api/scene/argon/start',{...sample,profile:'argon_previs',
        mode:'primary_subject',...extra})).status,400);
    }
    assert.equal(bodies.length,sent,'an invalid setting never reaches Google');
  }finally{globalThis.fetch=prior;}
});

test('Standard prompts are byte-identical to the pre-detail-investigation requests in both scopes',async()=>{
  // Captured with shot exterior from fc16907 and 266c454, not regenerated by
  // the assertion. Includes the direct-image suffix and every whitespace byte.
  const hashes={
    full_scene:'191f2b600a71b933c4490b18e27a77c2738accd1320bf3a9aaa17153d84a757c',
    primary_subject:'0fc0724a899380ff81e4d4ebc2580e7983de1a77d8127b776c1c793899505eff'
  };
  for(const [mode,hash] of Object.entries(hashes)){
    const {body}=await captureArgonRequest({mode});
    // The original Standard generation prompt must remain byte-identical
    // except for the explicit AI light budget: 8 -> 32.
    const normalized=body.system_instruction
      .replace('up to 32 lights','up to 8 lights')
      .replace('32 lights and 2000','8 lights and 2000');
    assert.equal(createHash('sha256').update(normalized).digest('hex'),hash);
  }
});

test('detail changes only the system instruction, not frames, schema, streaming or generation config',async()=>{
  for(const mode of ['full_scene','primary_subject']){
    const requests=[];
    for(const detail of ['standard','high','max']){
      const {body,result,output}=await captureArgonRequest({detail,mode,thinking:'high'});
      const {system_instruction,...rest}=body;
      requests.push(rest);
      assert.equal(rest.model,'gemini-4-argon');
      assert.equal(rest.store,false);assert.equal(rest.stream,true);
      assert.deepEqual(rest.generation_config,{thinking_level:'high',max_output_tokens:32768});
      assert.equal(rest.input.filter(p=>p.type==='image'&&p.resolution==='high').length,3);
      // Parent-surface wording is shared by successful Standard too.
      assert.match(system_instruction,/Attach parts to their parent surfaces/);
      assert.match(system_instruction,/attach parts to their parent surfaces/);
      // The completed empty output is saved unchanged and fails explicitly.
      assert.equal(output.text,'{"schemaVersion":1,"scenes":[{"shotId":"exterior","objects":[]}]}');
      assert.equal(output.partial,false);
      assert.equal(result.state,'failed');
      assert.deepEqual(result.diagnostic.codes,['empty']);
    }
    assert.deepEqual(requests[1],requests[0]);assert.deepEqual(requests[2],requests[0]);
    const schema=requests[0].response_format.schema;
    assert.deepEqual(schema.properties.scenes.items.required,['shotId','objects']);
    assert.doesNotMatch(JSON.stringify(schema),/"(?:minItems|maxItems|minLength|maxLength|minimum|maximum)":/);
  }
});

test('the real Argon job accepts synthetic scenes above 90 objects at every detail level',async()=>{
  const objects=Array.from({length:241},(_,i)=>({...scene.scenes[0].objects[0],
    id:'part_'+i,layer:'structures',position:[i,1,0]}));
  for(const detail of ['standard','high','max']){
    for(const count of [91,150,180,200,201,240,241]){
      const {result}=await captureArgonRequest({detail,objects:objects.slice(0,count)});
      assert.equal(result.state,'completed');
      assert.equal(result.proposal.scenes[0].objects.length,Math.min(count,240));
      assert.deepEqual(result.repairs,count===241?{object_cap:1}:undefined);
    }
  }
  // The separate rendered-copy limit is also enforced, not just array length.
  const grids=objects.slice(0,6).map(o=>({...o,repeat:{count:[20,20,1],spacing:[1,1,0]}}));
  const {result}=await captureArgonRequest({detail:'max',objects:grids});
  assert.equal(result.state,'completed');
  assert.equal(result.proposal.scenes[0].objects.length,5);
  assert.deepEqual(result.repairs,{scene_copies:1});
});

test('offline ablations isolate wording and count instructions without modifying the baseline',async()=>{
  const base=await inspectArgonPrompt('standard');
  const words=await inspectArgonPrompt('words-only');
  const counts=await inspectArgonPrompt('counts-only');
  const combined=await inspectArgonPrompt('combined');
  const paragraph='\nDETAIL: HIGH. Subdivide further where the frames resolve it: separate facade\n'+
    'bays, window frames and mullions, railings, steps, roof equipment, curbs,\n'+
    'signage frames and site furniture, each attached to its parent surface.';
  assert.equal(words,base.replace('\nTarget 80 to 120 objects',paragraph+'\nTarget 80 to 120 objects'));
  const raise=p=>p.replace('- at most 120 objects, 32 lights','- at most 150 objects, 32 lights')
    .replace('Target 80 to 120 objects','Target 110 to 150 objects');
  assert.equal(counts,raise(base));assert.equal(combined,raise(words));
  for(const text of [words,counts,combined]){
    assert.match(text,/and complete: an unfinished answer is discarded\./);
    assert.doesNotMatch(text,/Work in two stages|Never return an empty/);
  }
  await assert.rejects(inspectArgonPrompt('--live'));
});

test('an answer cut off at the token limit keeps its complete objects, on both profiles',async()=>{
  const prior=globalThis.fetch;
  const object=scene.scenes[0].objects[0];
  const text=JSON.stringify({schemaVersion:1,scenes:[{shotId:'draft_001',objects:[
    object,{...object,id:'second'},{...object,id:'third'}]}]});
  const cut=text.slice(0,text.indexOf('"third"')+12);
  const answer=(id,status,output)=>new Response(JSON.stringify({id,status,usage:interactionUsage,
    steps:[{type:'model_output',content:[{type:'text',text:output}]}]}));
  try{
    // Direct image.
    globalThis.fetch=async()=>answer('v1_sync','incomplete',cut);
    const {objects,namespace}=fakeArgonJobs(env);
    const jobsEnv={...env,ARGON_JOBS:namespace};
    const started=await (await argonPost(jobsEnv,'/api/scene/argon/direct-start',{...directJob,mode:'full_scene',detail:'max'})).json();
    await objects.get(started.jobId.slice(3)).alarm();
    const kept=await (await argonPost(jobsEnv,'/api/scene/argon/status',{jobId:started.jobId,shotId:'draft_001'})).json();
    assert.equal(kept.status,'completed');
    assert.deepEqual(kept.proposal.scenes[0].objects.map(o=>o.id),['box_1','second']);
    // The half-written third object is never parsed; the cut itself is reported.
    assert.deepEqual(kept.repairs,{truncated:1});
    // Previs.
    const id='v1_truncated_1';
    globalThis.fetch=async()=>answer(id,'incomplete',cut);
    const previs=await (await argonPost(env,'/api/scene/argon/status',{jobId:id,shotId:'draft_001'})).json();
    assert.equal(previs.status,'completed');assert.equal(previs.repairs.truncated,1);
    assert.equal(previs.proposal.scenes[0].objects.length,2);
    // Nothing complete to keep: the usual incomplete_output failure.
    globalThis.fetch=async()=>answer(id,'incomplete','{"schemaVersion":1,"scenes":[{"shotId":"draft_001","objects":[{"id"');
    const lost=await (await argonPost(env,'/api/scene/argon/status',{jobId:id,shotId:'draft_001'})).json();
    assert.equal(lost.status,'failed');assert.equal(lost.diagnostic.reason,'incomplete_output');
  }finally{globalThis.fetch=prior;}
});

test('65,536 is the same streamed, unstored request with only the allowance doubled',async()=>{
  for(const detail of ['standard','high','max']){
    for(const mode of ['full_scene','primary_subject']){
      const baseline=(await captureArgonRequest({detail,mode})).body;
      const large=(await captureArgonRequest({detail,mode,tokenBudget:65536})).body;
      assert.deepEqual(large,{...baseline,generation_config:{...baseline.generation_config,max_output_tokens:65536}});
      assert.deepEqual([large.store,large.stream,large.background],[false,true,undefined],
        'above 65,536 Google needs a stored background job, which rejects images');
    }
  }
});

test('a 65,536 job is one streamed call whose usage is measured against its own allowance',async()=>{
  const prior=globalThis.fetch,logs=captureUsageLogs();let calls=0;
  const output=JSON.stringify(scene);
  globalThis.fetch=async(_url,opts)=>{
    calls++;
    const body=JSON.parse(opts.body);
    assert.equal(body.generation_config.max_output_tokens,65536);assert.equal(body.stream,true);
    return streamed([{event_type:'step.start',index:0,step:{type:'model_output'}},
      {event_type:'step.delta',index:0,delta:{type:'text',text:output}},
      {event_type:'step.stop',index:0,usage:{total_input_tokens:6612,total_thought_tokens:40000,
        total_output_tokens:12000,total_tokens:58612}},
      {event_type:'interaction.completed',interaction:{status:'completed'}}]);
  };
  const {objects,namespace}=fakeArgonJobs(env),jobsEnv={...env,ARGON_JOBS:namespace};
  try{
    const start=await (await argonPost(jobsEnv,'/api/scene/argon/direct-start',{...directJob,tokenBudget:65536})).json();
    const job=objects.get(start.jobId.slice(3));await job.alarm();await job.alarm();
    assert.equal(calls,1,'a repeated alarm never resubmits');
    assert.deepEqual(await (await job.status('draft_001')).json(),{ok:true,status:'completed',proposal:scene,
      usage:{input:6612,thinking:40000,output:12000,total:58612,cap:65536}});
  }finally{globalThis.fetch=prior;logs.restore();}
});

test('the 65,536 budget is strictly allowlisted and unavailable to Previs before any paid request',async()=>{
  const prior=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('must not call');};
  try{
    for(const tokenBudget of [100000,100001,65535,0,null,'65536',true,{},[]]){
      const {namespace}=fakeArgonJobs(env);
      assert.equal((await argonPost({...env,ARGON_JOBS:namespace},'/api/scene/argon/direct-start',
        {...directJob,tokenBudget})).status,400);
    }
    for(const tokenBudget of [32768,65536])assert.equal((await argonPost(env,'/api/scene/argon/start',
      {...sample,profile:'argon_previs',mode:'primary_subject',tokenBudget})).status,400);
    assert.equal(calls,0);
  }finally{globalThis.fetch=prior;}
});

test('Add Detail uses two fixed append-only prompts and validates bounded existing geometry',async()=>{
  const prior=globalThis.fetch,bodies=[];
  const existing=[{id:'base',name:'Main building',layer:'structures',primitive:'box',
    position:[0,2,0],scale:[10,4,8]}];
  globalThis.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);bodies.push(body);
    return completedScene();
  };
  const call=async extra=>{
    const {namespace,objects}=fakeArgonJobs(env);
    const request=await argonPost({...env,ARGON_JOBS:namespace},'/api/scene/argon/direct-start',{
      ...directJob,mode:'full_scene',...extra});
    if(request.status!==200)return {status:request.status};
    const id=(await request.json()).jobId.slice(3);
    await objects.get(id).alarm();
    return {status:request.status};
  };
  try{
    for(const pass of [1,2]){
      const result=await call({detailPass:pass,existing});
      assert.equal(result.status,200);
      const b=bodies.at(-1);
      assert.equal(b.store,false);assert.equal(b.stream,true);
      assert.equal(b.background,undefined);
      assert.equal(b.input.length,6);
      assert.match(b.system_instruction,new RegExp('Pass '+pass+' of 2'));
      assert.match(b.system_instruction,/Do NOT recreate, move, modify, or duplicate/);
      assert.match(b.system_instruction,/Main building/);
      assert.doesNotMatch(b.system_instruction,/Work in two stages inside this one answer/);
    }
    const total=bodies.length;
    for(const payload of [
      {detailPass:3,existing},
      {detailPass:1,existing:[]},
      {detailPass:1,existing:[{...existing[0],id:'!!!'}]},
      {detailPass:1,existing:[existing[0],existing[0]]},
      {detailPass:1,existing:[{...existing[0],scale:[999999,1,1]}]},
      {detailPass:1,existing:Array.from({length:240},(_,i)=>({...existing[0],id:'obj'+i}))},
      {detailPass:1,existing,mode:'primary_subject'}
    ])assert.equal((await call(payload)).status,400);
    assert.equal(bodies.length,total,'invalid data never reaches paid Google calls');
  }finally{globalThis.fetch=prior;}
});

