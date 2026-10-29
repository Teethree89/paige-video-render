import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIMITIVE_TYPES,LIMITS,blankPrimitiveDocument,
  validatePrimitiveDocument,validateGeneratedPrimitiveDocument,makePrimitive,makeExampleBlockout,repeatOffsets,lightCastsShadow,applySpotlightSettingsGlobally,GLOBAL_SPOTLIGHT_KEYS
} from '../primitive-schema.js';

const doc=(shotId='draft_001')=>({schemaVersion:1,scenes:[{
  shotId,objects:[makePrimitive('box','rack_1')]
}]});
test('per-light shadow choice is optional, strict, and survives JSON for every light type',()=>{
 for(const type of ['point','spot','directional']){
   const light={id:'lamp',type,color:'#ffffff',intensity:2,position:[0,5,0]};
   const source={schemaVersion:1,scenes:[{shotId:'shot',objects:[],lights:[light]}]};
   const legacy=validatePrimitiveDocument(source).scenes[0].lights[0];
   assert.equal('castShadow' in legacy,false,'older scenes are not rewritten');
   assert.equal(lightCastsShadow(legacy),type!=='point');
   for(const enabled of [false,true]){
     light.castShadow=enabled;
     const result=validatePrimitiveDocument(JSON.parse(JSON.stringify(source))).scenes[0].lights[0];
     assert.equal(result.castShadow,enabled);
     assert.equal(lightCastsShadow(result),enabled);
     assert.equal(result.intensity,legacy.intensity,'shadow toggle does not dim the light');
   }
   for(const invalid of [null,'false',0,1]){
     light.castShadow=invalid;
     assert.throws(()=>validatePrimitiveDocument(source),/castShadow must be boolean/);
   }
 }
});
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
test('manual edits can exceed AI object and project budgets, but generated proposals cannot',async()=>{
  const manual=doc();
  manual.scenes[0].objects=Array.from({length:LIMITS.objectsPerScene+1},
    (_,i)=>makePrimitive('box','b'+i));
  assert.equal(validatePrimitiveDocument(manual).scenes[0].objects.length,241);
  assert.throws(()=>validateGeneratedPrimitiveDocument(manual),/240 generated objects/);
  // A full imported timeline may exceed the former 2,000-object ceiling.
  const large={schemaVersion:1,scenes:Array.from({length:9},(_,index)=>({
    shotId:'shot_'+index,
    objects:Array.from({length:230},(_,i)=>makePrimitive('box','obj_'+i))
  }))};
  const normalized=validatePrimitiveDocument(large);
  assert.equal(normalized.scenes.reduce((n,scene)=>n+scene.objects.length,0),2070);
  assert.throws(()=>validateGeneratedPrimitiveDocument(large),/generated objects/);
  assert.deepEqual(validatePrimitiveDocument(JSON.parse(JSON.stringify(normalized))),normalized);
  assert.throws(()=>validatePrimitiveDocument({schemaVersion:1,scenes:[
    {shotId:'bad',objects:null}]}),/objects array/);
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
test('legacy manual layer aliases keep saved objects and normalize to unlayered v1 data',()=>{
  const original=doc();
  for(const layer of [null,'','manual']){
    const saved=structuredClone(original);
    saved.scenes[0].objects[0].layer=layer;
    assert.deepEqual(validatePrimitiveDocument(saved,['draft_001']),original);
    assert.equal(saved.scenes[0].objects[0].layer,layer,'loading never rewrites the saved source');
    saved.scenes[0].objects[0].position[0]=Infinity;
    assert.throws(()=>validatePrimitiveDocument(saved,['draft_001']),/finite/,
      'legacy metadata never bypasses geometry validation');
  }
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
  // Aggregate instance limits are AI-only; manual array editing stays valid.
  const arrays=n=>Array.from({length:n},(_,i)=>base('a'+i,'box',{repeat:{count:[20,20,1],spacing:[1,1,0]}}));
  assert.equal(validatePrimitiveDocument(richDoc(arrays(5))).scenes[0].objects.length,5);
  const expanded=richDoc(arrays(5).concat([base('one_more','box')]));
  assert.equal(validatePrimitiveDocument(expanded).scenes[0].objects.length,6);
  assert.throws(()=>validateGeneratedPrimitiveDocument(expanded),/more than 2000 rendered copies/);
});

test('scene light types and values remain bounded but light count is unlimited',()=>{
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
  assert.equal(lit(Array(40).fill(point)).length,40,
    'the shared validator must allow any number of human-authored lights');
  for(const [lights,pattern] of [
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



test('degree-only editor controls round-trip exact quarter turns without rewriting legacy saved rotations',async()=>{
 const {radiansToDegrees,degreesToRadians}=await import('../primitive-schema.js');
 assert.equal(radiansToDegrees(Math.PI/2),90);
 assert.equal(radiansToDegrees(-Math.PI/4),-45);
 assert.ok(Math.abs(degreesToRadians(90)-Math.PI/2)<1e-12);
 const legacy=makePrimitive('box','legacy');
 legacy.rotation=[0,1.5708,0];
 legacy.repeat={count:[3,1,1],spacing:[3,0,0]};
 const saved=validatePrimitiveDocument({schemaVersion:1,scenes:[
   {shotId:'draft_001',objects:[legacy]}
 ]});
 assert.equal(saved.scenes[0].objects[0].rotation[1],1.5708);
 assert.equal(saved.scenes[0].objects[0].instanceRotation,undefined);
 const rotated=structuredClone(saved);
 rotated.scenes[0].objects[0].instanceRotation=[0,degreesToRadians(90),0];
 const after=validatePrimitiveDocument(rotated,['draft_001']).scenes[0].objects[0];
 assert.equal(after.rotation[1],1.5708);
 assert.equal(radiansToDegrees(after.instanceRotation[1]),90);
 const {readFile}=await import('node:fs/promises');
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 const inspector=await readFile(new URL('../primitive-editor.js',import.meta.url),'utf8');
 const mini=await readFile(new URL('../array-prototype-editor.js',import.meta.url),'utf8');
 assert.match(html,/Rotation \(degrees °\)/);
 assert.match(html,/Cone angle \(degrees °\)/);
 assert.match(inspector,/item\.repeat\?'instanceRotation'/);
 assert.match(inspector,/degreesToRadians\(Number\(event\.target\.value\)\)/);
 assert.match(mini,/Rotation of each copy \(°\)/);
 assert.match(mini,/Local rotation \(°\)/);
});

test('render-space units standardize a meter and millimeter conversions',async()=>{
 const {METERS_PER_SCENE_UNIT,MILLIMETERS_PER_METER,millimetersToSceneUnits,
  FAKE_SPOTLIGHT_DECAL_LIFT_MM,FAKE_SPOTLIGHT_OCCLUDED_LIFT_MM}=await import('../scene-units.js');
 assert.equal(METERS_PER_SCENE_UNIT,1);
 assert.equal(MILLIMETERS_PER_METER,1000);
 assert.equal(millimetersToSceneUnits(1000),1);
 assert.equal(millimetersToSceneUnits(10),.01);
 assert.equal(millimetersToSceneUnits(8),.008);
 assert.equal(millimetersToSceneUnits(1),.001);
 assert.equal(FAKE_SPOTLIGHT_DECAL_LIFT_MM,10);
 assert.equal(FAKE_SPOTLIGHT_OCCLUDED_LIFT_MM,8);
 assert.throws(()=>millimetersToSceneUnits(-1),/millimeters/);
 assert.throws(()=>millimetersToSceneUnits(Infinity),/millimeters/);
 assert.throws(()=>millimetersToSceneUnits('10'),/millimeters/);
 const original=doc();
 const result=validatePrimitiveDocument(original);
 assert.deepEqual(result.scenes[0].objects[0].position,original.scenes[0].objects[0].position);
 assert.deepEqual(result.scenes[0].objects[0].scale,original.scenes[0].objects[0].scale);
});

test('apply globally changes all chapter spotlights but not point lights or light transforms',()=>{
 const source={id:'s',type:'spot',name:'Source',color:'#abc123',intensity:245,
   distance:27,angle:.42,penumbra:.65,fakeConeOpacity:.28,castShadow:false,
   position:[3,8,7],target:[1,1,1]};
 const other={...source,id:'other',name:'Other',position:[42,19,8],
   target:[5,0,3],color:'#ffffff',fakeConeOpacity:1,castShadow:true};
 const child={...source,id:'child',name:'Child',position:[0,3,0],
   target:[0,0,0],angle:.8,penumbra:.15};
 const point={id:'point',type:'point',name:'Point',color:'#ffffff',intensity:12,
   position:[0,3,0],distance:14};
 const chapter={objects:[{id:'array',arrayParts:{objects:[],lights:[child,point]}}],
   lights:[source,other]};
 const old={position:[...other.position],target:[...other.target],name:other.name,id:other.id};
 assert.equal(applySpotlightSettingsGlobally(chapter,source),3);
 for(const key of GLOBAL_SPOTLIGHT_KEYS){
   assert.deepEqual(other[key],source[key]);
   assert.deepEqual(child[key],source[key]);
 }
 assert.deepEqual(other.position,old.position);
 assert.deepEqual(other.target,old.target);
 assert.equal(other.id,old.id);
 assert.equal(other.name,old.name);
 assert.equal(point.intensity,12);
 assert.equal(point.fakeConeOpacity,undefined);
});

test('spotlight fake cone opacity defaults to full, is bounded and round-trips in array lights',()=>{
 const source={id:'beam',type:'spot',name:'Beam',color:'#ffeecc',intensity:100,
   position:[0,6,0],target:[0,0,0],distance:32,angle:.5,penumbra:.35};
 const document={schemaVersion:1,scenes:[{shotId:'shot',objects:[
   {...makePrimitive('box','lamp'),arrayParts:{objects:[],lights:[source]}}
 ],lights:[source]}]};
 const existing=validatePrimitiveDocument(document,['shot']).scenes[0];
 assert.equal('fakeConeOpacity' in existing.lights[0],false,
   'legacy punctual spots keep their original JSON');
 assert.equal('fakeConeOpacity' in existing.objects[0].arrayParts.lights[0],false,
   'legacy array lights keep their original JSON');
 for(const value of [0,.13,1]){
   document.scenes[0].lights[0].fakeConeOpacity=value;
   document.scenes[0].objects[0].arrayParts.lights[0].fakeConeOpacity=value;
   const result=validatePrimitiveDocument(document,['shot']).scenes[0];
   assert.equal(result.lights[0].fakeConeOpacity,value);
   assert.equal(result.objects[0].arrayParts.lights[0].fakeConeOpacity,value);
 }
 for(const value of [-.1,1.01,'0.5',NaN,Infinity]){
   document.scenes[0].lights[0].fakeConeOpacity=value;
   assert.throws(()=>validatePrimitiveDocument(document,['shot']),/fake cone opacity/);
 }
});
