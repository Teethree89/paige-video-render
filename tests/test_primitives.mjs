import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIMITIVE_TYPES,LIMITS,blankPrimitiveDocument,
  validatePrimitiveDocument,makePrimitive,makeExampleBlockout,repeatOffsets
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
const richDoc=(objects,camera)=>({schemaVersion:1,scenes:[{shotId:'shot_a',objects,
  ...(camera===undefined?{}:{camera})}]});
const base=(id,primitive,extra={})=>({id,name:id,primitive,position:[0,1,0],rotation:[0,0,0],
  scale:[2,2,2],material:{color:'#334455',metalness:.1,roughness:.6},...extra});
test('richer vocabulary: new shapes, footprints, repeat arrays, glow, glass and camera',()=>{
  const doc=validatePrimitiveDocument(richDoc([
    base('spire','cone'),base('ramp','wedge'),base('roof','gable'),
    base('hall','extrude',{points:[[-.5,-.5],[.5,-.5],[.5,0],[0,0],[0,.5],[-.5,.5]]}),
    base('windows','box',{repeat:{count:[12,3,1],spacing:[1.5,2,0]},
      material:{color:'#223344',metalness:.2,roughness:.3,emissive:'#FFCC88',emissiveIntensity:2.5,opacity:.6}}),
    base('lamp','sphere',{material:{color:'#ffffff',metalness:0,roughness:.5,emissive:'#ffeecc'}})
  ],{position:[18,6,30],target:[0,3,0],fov:42}),['shot_a']);
  const [spire,ramp,roof,hall,windows,lamp]=doc.scenes[0].objects;
  assert.deepEqual([spire.primitive,ramp.primitive,roof.primitive,hall.primitive],['cone','wedge','gable','extrude']);
  assert.equal(hall.points.length,6);
  assert.deepEqual(windows.repeat,{count:[12,3,1],spacing:[1.5,2,0]});
  assert.deepEqual(windows.material,{color:'#223344',metalness:.2,roughness:.3,
    emissive:'#ffcc88',emissiveIntensity:2.5,opacity:.6});
  assert.equal(lamp.material.emissiveIntensity,1,'Glow defaults to intensity 1');
  assert.deepEqual(doc.scenes[0].camera,{position:[18,6,30],target:[0,3,0],fov:42});
  // Copies are centered on the object's position along its own axes.
  assert.deepEqual(repeatOffsets({count:[3,1,2],spacing:[2,0,4]}),
    [[-2,0,-2],[-2,0,2],[0,0,-2],[0,0,2],[2,0,-2],[2,0,2]]);
  assert.deepEqual(repeatOffsets(undefined),[[0,0,0]]);
});
test('v1 objects validate to exactly the original output, and empty extras are dropped',()=>{
  const v1=base('plain','box');
  assert.deepEqual(validatePrimitiveDocument(richDoc([v1])).scenes[0],
    {shotId:'shot_a',objects:[{id:'plain',name:'plain',primitive:'box',position:[0,1,0],
      rotation:[0,0,0],scale:[2,2,2],material:{color:'#334455',metalness:.1,roughness:.6}}]});
  // null extras and a 1x1x1 repeat mean "not set"; points only belong to extrude.
  const cleaned=validatePrimitiveDocument(richDoc([base('plain','box',{repeat:{count:[1,1,1],spacing:[5,5,5]},
    points:[[0,0],[1,0],[0,1]],material:{color:'#334455',metalness:.1,roughness:.6,emissive:null,opacity:null}})],
    null)).scenes[0];
  assert.deepEqual(Object.keys(cleaned),['shotId','objects']);
  assert.deepEqual(Object.keys(cleaned.objects[0]).sort(),['id','material','name','position','primitive','rotation','scale']);
  assert.deepEqual(cleaned.objects[0].material,{color:'#334455',metalness:.1,roughness:.6});
});
test('richer vocabulary is still strictly bounded data',()=>{
  const bad=(objects,camera,pattern)=>assert.throws(()=>validatePrimitiveDocument(richDoc(objects,camera)),pattern);
  bad([base('x','pyramid')],undefined,/unsupported primitive/);
  bad([base('x','extrude')],undefined,/footprint points/);
  bad([base('x','extrude',{points:[[0,0],[1,0]]})],undefined,/footprint points/);
  bad([base('x','extrude',{points:Array(33).fill([0,0])})],undefined,/footprint points/);
  bad([base('x','extrude',{points:[[0,0],[.5,0],[1,0]]})],undefined,/no area/);
  bad([base('x','extrude',{points:[[0,0],[1.5,0],[0,1]]})],undefined,/between -1 and 1/);
  bad([base('x','extrude',{points:[[0,0],['1',0],[0,1]]})],undefined,/finite/);
  bad([base('x','box',{repeat:{count:[2,2],spacing:[1,1,1]}})],undefined,/3 integers/);
  bad([base('x','box',{repeat:{count:[2.5,1,1],spacing:[1,1,1]}})],undefined,/integer/);
  bad([base('x','box',{repeat:{count:[101,1,1],spacing:[1,1,1]}})],undefined,/integer from 1 to 100/);
  // A long row may use 100 along one axis, within 400 copies per object.
  assert.deepEqual(validatePrimitiveDocument({schemaVersion:1,scenes:[{shotId:'draft_001',
    objects:[base('row','box',{repeat:{count:[100,4,1],spacing:[1,1,0]}})]}]}).scenes[0].objects[0].repeat.count,[100,4,1]);
  bad([base('x','box',{repeat:{count:[100,5,1],spacing:[1,1,0]}})],undefined,/more than 400 copies/);
  // Scale reaches 2 km, for a full scene's ground, and no further.
  assert.equal(validatePrimitiveDocument({schemaVersion:1,scenes:[{shotId:'draft_001',
    objects:[base('ground','plane',{scale:[2000,1500,1]})]}]}).scenes[0].objects[0].scale[0],2000);
  bad([base('x','plane',{scale:[2001,10,1]})],undefined,/scale\[0\] must be finite between 0.01 and 2000/);
  bad([base('x','box',{repeat:{count:[20,21,1],spacing:[1,1,1]}})],undefined,/more than 400 copies/);
  bad([base('x','box',{repeat:{count:[2,1,1],spacing:[1,NaN,1]}})],undefined,/finite/);
  bad([base('x','box',{repeat:'12 windows'})],undefined,/repeat must be/);
  bad([base('x','box',{material:{color:'#334455',metalness:.1,roughness:.6,emissive:'orange'}})],undefined,/emissive/);
  bad([base('x','box',{material:{color:'#334455',metalness:.1,roughness:.6,emissive:'#ffffff',emissiveIntensity:11}})],undefined,/emissiveIntensity/);
  bad([base('x','box',{material:{color:'#334455',metalness:.1,roughness:.6,opacity:0}})],undefined,/opacity/);
  bad([base('x','box')],{position:[0,0,0],target:[0,0,0],fov:40},/distinct target/);
  bad([base('x','box')],{position:[0,0,5],target:[0,0,0],fov:5},/fov/);
  bad([base('x','box')],{position:[0,0,5],fov:40},/camera target/);
  bad([base('x','box')],'front',/camera must be/);
  // 2000 rendered copies per scene, however they are split across objects.
  const arrays=n=>Array.from({length:n},(_,i)=>base('a'+i,'box',{repeat:{count:[20,20,1],spacing:[1,1,0]}}));
  assert.equal(validatePrimitiveDocument(richDoc(arrays(5))).scenes[0].objects.length,5);
  bad(arrays(5).concat([base('one_more','box')]),undefined,/more than 2000 rendered copies/);
});

test('scene lights are bounded data with defaults, and only shine for their shot',()=>{
  const lit=lights=>validatePrimitiveDocument({schemaVersion:1,scenes:[{shotId:'draft_001',
    objects:[makePrimitive('box','rack_1')],lights}]}).scenes[0].lights;
  assert.deepEqual(lit([
    {type:'directional',color:'#AABBFF',intensity:1.5,position:[30,60,40]},
    {type:'point',name:'Lamp',color:'#ffcc88',intensity:30,position:[4,5,6],distance:25,target:[1,1,1],extra:'dropped'},
    {type:'spot',color:'#ffffff',intensity:120,position:[0,12,0],target:[0,0,0]}
  ]),[
    {type:'directional',name:'directional light 1',color:'#aabbff',intensity:1.5,position:[30,60,40],target:[0,0,0]},
    {type:'point',name:'Lamp',color:'#ffcc88',intensity:30,position:[4,5,6],distance:25},
    {type:'spot',name:'spot light 3',color:'#ffffff',intensity:120,position:[0,12,0],target:[0,0,0],
      distance:0,angle:.6,penumbra:.3}
  ]);
  // An empty list is dropped, so v1 documents keep their exact output.
  assert.equal(lit([]),undefined);
  const point={type:'point',color:'#ffffff',intensity:10,position:[0,3,0]};
  for(const [lights,pattern] of [
    [Array(LIMITS.lightsPerScene+1).fill(point),/at most 8/],
    [[{...point,type:'ambient'}],/unsupported light type/],
    [[{...point,color:'white'}],/#RRGGBB/],
    [[{...point,intensity:501}],/intensity/],
    [[{...point,type:'directional',intensity:11}],/intensity/],
    [[{...point,distance:-1}],/distance/],
    [[{...point,type:'spot',angle:1.6}],/angle/],
    [[{...point,type:'spot',penumbra:2}],/penumbra/],
    [[{...point,type:'directional',target:[0,3,0]}],/distinct target/],
    [[{...point,position:[0,Infinity,0]}],/position/],
    ['bright',/array/]
  ])assert.throws(()=>lit(lights),pattern);
});
