import test from 'node:test';
import assert from 'node:assert/strict';
import {ENVIRONMENT_PASSES,referenceFrameTimes,appendEnvironmentPass}
  from '../environment-generation.js';
import {validatePrimitiveDocument} from '../primitive-schema.js';
import worker,{validateLayerRequest,validateOutput} from '../worker/scene-worker.mjs';

const shotId='shot_a';
const obj=(id,layer)=>({
  id,name:'Visible '+id,primitive:'box',position:[0,1,0],rotation:[0,0,0],
  scale:[2,2,2],...(layer?{layer}:{}),
  material:{color:'#345678',metalness:0,roughness:.7}
});
const proposal=(layer,objects)=>({schemaVersion:1,scenes:[{shotId,objects:objects.map(
  (id)=>obj(id,layer))}]});

test('playhead is sampled first, context is within the selected chapter',()=>{
  assert.deepEqual(referenceFrameTimes({start:0,end:6},2.8,8),[2.8,1.32,4.68]);
  assert.deepEqual(referenceFrameTimes({start:5,end:9},5,12),[5,5.88,8.12]);
  assert.deepEqual(referenceFrameTimes({start:5,end:9},9,12),[8.999,5.88,8.12]);
  assert.throws(()=>referenceFrameTimes({start:2,end:2.05},2,10),/Invalid/);
});

test('layer schema roundtrips while legacy manual objects remain unchanged',()=>{
  const first=validatePrimitiveDocument({schemaVersion:1,
    scenes:[{shotId,objects:[obj('tree','vegetation'),obj('legacy')]}]},[shotId]);
  assert.equal(first.scenes[0].objects[0].layer,'vegetation');
  assert.equal(first.scenes[0].objects[1].layer,undefined);
  assert.throws(()=>validatePrimitiveDocument({schemaVersion:1,
    scenes:[{shotId,objects:[obj('bad','untrusted')]}]}),/unsupported environment layer/);
});

test('atomic scene assembly enforces order, exact chapter, IDs and per-pass caps',()=>{
  let assembled=[];
  for(const p of ENVIRONMENT_PASSES){
    const next=appendEnvironmentPass(shotId,assembled,proposal(p.id,[p.id+'_1']),p.id);
    assert.equal(assembled.length,ENVIRONMENT_PASSES.indexOf(p));
    assembled=next;
  }
  assert.equal(assembled.length,4);
  assert.throws(()=>appendEnvironmentPass(shotId,assembled,
    proposal('details',['details_1']),'details'),/Duplicate/);
  assert.throws(()=>appendEnvironmentPass(shotId,assembled,
    proposal('vegetation',['another']),'details'),/invalid environment layer/);
  assert.throws(()=>appendEnvironmentPass(shotId,assembled,{
    schemaVersion:1,scenes:[{shotId:'shot_b',objects:[]}]
  },'ground'),/unknown shotId/);
  assert.equal(appendEnvironmentPass(shotId,assembled,proposal('details',[]),'details').length,4);
  assert.throws(()=>appendEnvironmentPass(shotId,assembled,
    proposal('details',Array.from({length:25},(_,i)=>'n'+i)),'details'),/invalid environment layer/);
});

test('Worker layer input disallows unknown pass, invalid data, over-budget context',()=>{
  assert.equal(validateLayerRequest({frames:[]},shotId),null);
  assert.throws(()=>validateLayerRequest({layer:'delete'},shotId),/Invalid environment layer/);
  assert.throws(()=>validateLayerRequest({layer:'ground',existing:[obj('x')]},shotId),/Invalid previous layer/);
  assert.throws(()=>validateLayerRequest({layer:'ground',existing:Array(73).fill(obj('x','structures'))},shotId),/Too many prior/);
  const valid=validateLayerRequest({layer:'ground',existing:[obj('b','structures')]},shotId);
  assert.equal(valid.existing.length,1);
  assert.equal(valid.existing[0].layer,'structures');
  assert.ok(!('material' in valid.existing[0]),'only spatial context forwarded');
});

test('layer Worker outputs remain editable, bounded, and collision-free',async()=>{
  const token='test-only-shared-token-at-least-thirty-two-characters';
  const env={GEMINI_API_KEY:'mock-API-key',SCENE_ACCESS_TOKEN:token};
  const jpeg='data:image/jpeg;base64,'+Buffer.from([255,216,255,217]).toString('base64');
  const sample={shotId,layer:'structures',existing:[],
    frames:[{at:2.8,imageDataUrl:jpeg},{at:1.32,imageDataUrl:jpeg},{at:4.68,imageDataUrl:jpeg}]};
  let calls=0;
  const old=globalThis.fetch;
  globalThis.fetch=async(url,opts)=>{
    calls++;
    const data=JSON.parse(opts.body);
    assert.equal(data.contents[0].parts.filter(p=>p.inlineData).length,3);
    assert.match(data.contents[0].parts[0].text,/Current pass: structures/);
    assert.match(data.contents[0].parts[0].text,/Buildings may be more/);
    return new Response(JSON.stringify({candidates:[{content:{parts:[{
      text:JSON.stringify({schemaVersion:1,scenes:[{shotId,objects:[obj('main')] }]})
    }]}}]}),{status:200});
  };
  try {
    const result=await worker.fetch(new Request('https://example.workers.dev/api/scene',{
      method:'POST',headers:{Authorization:'Bearer '+token},
      body:JSON.stringify(sample)
    }),env);
    assert.equal(result.status,200);
    const proposal=await result.json();
    assert.equal(proposal.scenes[0].objects[0].id,'structures_1');
    assert.equal(proposal.scenes[0].objects[0].layer,'structures');
    assert.equal(calls,1);
    assert.deepEqual(validatePrimitiveDocument(proposal,[shotId]),proposal);
    assert.throws(()=>validateOutput({schemaVersion:1,scenes:[{shotId,
      objects:Array.from({length:25},(_,i)=>obj('m'+i))}]},shotId,24),
      /Incorrect shot or object budget/);
  }finally{globalThis.fetch=old;}
});
