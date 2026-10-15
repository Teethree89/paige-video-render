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
  assert.deepEqual(await healthy.json(),{ok:true,service:'paige-scene',ready:true});
  const unavailable=await worker.fetch(new Request('https://example.workers.dev/health'),{});
  assert.equal(unavailable.status,503);
  const body=await unavailable.text();
  assert.deepEqual(JSON.parse(body),{ok:false,service:'paige-scene',ready:false});
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
  assert.throws(()=>validateInput({...sample,shotId:'../x'}),/Invalid shot/);
  assert.throws(()=>validateInput({...sample,frames:Array(4).fill(sample.frames[0])}),/Invalid frame count/);
  assert.throws(()=>validateInput({...sample,frames:[{at:1,imageDataUrl:'https://evil.test/a.jpg'}]}),/JPEG/);
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
test('authorized request returns valid primitive JSON and keeps API key out of output',async()=>{
  const previous=globalThis.fetch;
  let providerInvoked=false;
  globalThis.fetch=async (_url,opts)=>{
    providerInvoked=true;
    assert.ok(opts.headers['x-goog-api-key']===env.GEMINI_API_KEY);
    assert.ok(opts.body.includes('inlineData'));
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

test('Gemini failure statuses are classified without relaying raw provider errors',async()=>{
  const cases=[
    [400,502,'AI provider rejected request format'],
    [401,502,'AI provider authentication or permission failed'],
    [403,502,'AI provider authentication or permission failed'],
    [404,502,'Requested AI model is unavailable'],
    [422,502,'AI provider rejected request format'],
    [429,429,'Provider rate limit reached'],
    [500,502,'AI provider temporarily unavailable'],
    [503,502,'AI provider temporarily unavailable'],
    [418,502,'AI provider refused the request']
  ];
  const previous=globalThis.fetch;
  try{
    for(const [providerStatus,workerStatus,workerError] of cases){
      globalThis.fetch=async()=>new Response(
        JSON.stringify({error:'PRIVATE_PROVIDER_ACCOUNT_DETAILS_DO_NOT_RELAY'}),
        {status:providerStatus,headers:{'content-type':'application/json'}}
      );
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
