import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIMITIVE_TYPES,LIMITS,blankPrimitiveDocument,
  validatePrimitiveDocument,makePrimitive,makeExampleBlockout
} from '../primitive-schema.js';

const doc=(shotId='draft_001')=>({schemaVersion:1,scenes:[{
  shotId,objects:[makePrimitive('box','rack_1')]
}]});
test('an empty scene document is valid and backward compatible',()=>{
  assert.deepEqual(validatePrimitiveDocument(undefined),blankPrimitiveDocument());
  assert.deepEqual(validatePrimitiveDocument(null),blankPrimitiveDocument());
  assert.deepEqual(validatePrimitiveDocument(blankPrimitiveDocument()),blankPrimitiveDocument());
});
test('each allowed shape produces a validated editable object',()=>{
  for(const type of PRIMITIVE_TYPES){
    const item=makePrimitive(type,type+'_1');
    assert.equal(item.primitive,type);
    assert.equal(item.scale.length,3);
    const result=validatePrimitiveDocument({schemaVersion:1,scenes:[{
      shotId:'draft_001',objects:[item]
    }]},['draft_001']);
    assert.equal(result.scenes[0].objects[0].id,type+'_1');
  }
});
test('example room is a scene of actual primitive geometry',()=>{
  const scene=makeExampleBlockout('draft_005');
  assert.equal(scene.objects.length,7);
  assert.equal(scene.objects.filter(x=>x.primitive==='box').length,6);
  assert.equal(scene.objects[0].primitive,'plane');
  assert.equal(validatePrimitiveDocument({schemaVersion:1,scenes:[scene]},['draft_005']).scenes[0].objects.length,7);
});
test('input validation rejects unsafe, non-finite, duplicate, or unknown data',()=>{
  assert.throws(()=>validatePrimitiveDocument({schemaVersion:3,scenes:[]}),/schemaVersion/);
  assert.throws(()=>validatePrimitiveDocument(doc('fake'),['draft_001']),/unknown shotId/);
  const unsupported=doc();unsupported.scenes[0].objects[0].primitive='script';
  assert.throws(()=>validatePrimitiveDocument(unsupported),/unsupported primitive/);
  const inf=doc();inf.scenes[0].objects[0].position=[Infinity,0,0];
  assert.throws(()=>validatePrimitiveDocument(inf),/finite/);
  const huge=doc();huge.scenes[0].objects[0].scale=[1,99999,1];
  assert.throws(()=>validatePrimitiveDocument(huge),/finite/);
  const badMaterial=doc();badMaterial.scenes[0].objects[0].material.color='red';
  assert.throws(()=>validatePrimitiveDocument(badMaterial),/color/);
  const badId=doc();badId.scenes[0].objects[0].id='../path';
  assert.throws(()=>validatePrimitiveDocument(badId),/identifier/);
  const duplicate=doc();duplicate.scenes[0].objects.push(structuredClone(duplicate.scenes[0].objects[0]));
  assert.throws(()=>validatePrimitiveDocument(duplicate),/duplicate object/);
});
test('limit object count to prevent runaway model responses',()=>{
  const invalid=doc();
  invalid.scenes[0].objects=Array.from({length:LIMITS.objectsPerScene+1},(_,i)=>makePrimitive('box','b'+i));
  assert.throws(()=>validatePrimitiveDocument(invalid),/objects array/);
});
test('canonicalization removes unknown metadata without modifying source',()=>{
  const input=doc();
  input.script='alert("unexpected")';
  input.scenes[0].objects[0].inject='untrusted';
  const output=validatePrimitiveDocument(input);
  assert.equal(output.script,undefined);
  assert.equal(output.scenes[0].objects[0].inject,undefined);
  assert.equal(input.script,'alert("unexpected")');
});
test('primitive scene document can be stored alongside a timeline and exported as JSON',()=>{
  const original=doc();
  const roundTrip=JSON.parse(JSON.stringify({shots:[{id:'draft_001'}],primitiveScenes:original}));
  const normalized=validatePrimitiveDocument(roundTrip.primitiveScenes,roundTrip.shots.map(s=>s.id));
  assert.deepEqual(normalized,original);
});
