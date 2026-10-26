import test from 'node:test';
import assert from 'node:assert/strict';
import {makePrimitive,validatePrimitiveDocument} from '../primitive-schema.js';
import {findMatchingArrays,findArrayCompanions,saveArrayPrototype,arrayGroupKey} from '../array-prototype.js';
import {insertCreatedAsset} from '../scene-asset-catalog.js';

const row=(id,name,position,rotation=[0,0,0])=>({
 ...makePrimitive('cylinder',id,position),name,
 scale:[.24,6,.24],rotation,
 repeat:{count:[3,1,1],spacing:[8,0,0]}
});
const fixtures=()=>({schemaVersion:1,scenes:[{shotId:'street',objects:[
 row('streetlights_north','Streetlight',[0,3,10]),
 row('streetlights_south','Streetlight',[0,3,-10],[0,Math.PI,0]),
 row('separate_posts','Parking bollard',[0,3,24])
]}]});
const lamp=()=>({id:'lamp_head',name:'Emissive lamp head',primitive:'box',
 position:[0,3,.4],rotation:[0,0,0],scale:[1,.3,.7],
 material:{color:'#f2e9c7',metalness:.1,roughness:.4,
  emissive:'#ffe3b0',emissiveIntensity:3}});
const light=()=>({id:'beam',name:'Streetlight beam',type:'spot',
 position:[0,3,.4],target:[0,-2,.4],color:'#fff5d4',intensity:240,
 distance:35,angle:.6,penumbra:.4});

test('matching streetlight arrays update together while unrelated repeats are untouched',()=>{
 const before=fixtures(),snapshot=structuredClone(before);
 const matches=findMatchingArrays(before,'street','streetlights_north');
 assert.deepEqual(matches,['streetlights_north','streetlights_south']);
 const changed=saveArrayPrototype(before,['street'],'street','streetlights_north',{
   name:'Lit streetlight',scale:[.24,6,.24],
   material:{color:'#526477',metalness:.25,roughness:.65},
   parts:{objects:[lamp()],lights:[light()]}
 });
 assert.deepEqual(before,snapshot,'all changes stay in the draft until Save');
 for(const item of changed.scenes[0].objects.slice(0,2)){
   assert.equal(item.name,'Lit streetlight');
   assert.deepEqual(item.arrayParts.objects,[lamp()]);
   assert.deepEqual(item.arrayParts.lights,[light()]);
   assert.equal(item.repeat.count[0],3);
 }
 assert.deepEqual(changed.scenes[0].objects[1].rotation,[0,Math.PI,0]);
 assert.deepEqual(changed.scenes[0].objects[2],snapshot.scenes[0].objects[2]);
 const stage=insertCreatedAsset(changed,'street','lights','point-blue',[4,7,0]);
 assert.equal(stage.document.scenes[0].lights.length,1,
   'normal top-level lights can coexist with prototype lights');
});

test('prototype save is atomic and refuses invalid nested lights or copy overflow',()=>{
 const before=fixtures(),snapshot=structuredClone(before);
 assert.throws(()=>saveArrayPrototype(before,['street'],'street','streetlights_north',{
   name:'Streetlight',scale:[.24,6,.24],material:before.scenes[0].objects[0].material,
   parts:{objects:[lamp()],lights:[{...light(),target:[0,3,.4]}]}
 }),/distinct target/);
 assert.deepEqual(before,snapshot);
 const many=Array.from({length:20},(_,i)=>({...lamp(),id:'head_'+i}));
 const large=saveArrayPrototype(before,['street'],'street','streetlights_north',{
   name:'Streetlight',scale:[.24,6,.24],material:before.scenes[0].objects[0].material,
   parts:{objects:many,lights:[]}
 });
 assert.equal(large.scenes[0].objects[0].arrayParts.objects.length,20);
 assert.throws(()=>saveArrayPrototype(before,['street'],'street','streetlights_north',{
   name:'Streetlight',scale:[.24,6,.24],material:before.scenes[0].objects[0].material,
   parts:{objects:[{...lamp(),repeat:{count:[2,1,1],spacing:[1,0,0]}}],lights:[]}
 }),/cannot contain nested arrays/);
 assert.equal(findMatchingArrays(before,'street','separate_posts').length,1);
 assert.deepEqual(validatePrimitiveDocument(before),snapshot);
});

test('prototype local component transforms do not replace shot-wide lights or scene cameras',()=>{
 const doc=fixtures();
 const shot=doc.scenes[0];
 shot.lights=[{id:'moon',name:'Moon',type:'directional',
   position:[0,25,0],target:[0,0,0],intensity:1,color:'#ffffff'}];
 shot.camera={position:[0,6,20],target:[0,3,0],fov:42};
 const changed=saveArrayPrototype(doc,['street'],'street','streetlights_north',{
   name:'Streetlight',scale:[.24,6,.24],material:shot.objects[0].material,
   parts:{objects:[],lights:[light()]}
 });
 assert.deepEqual(changed.scenes[0].lights,shot.lights);
 assert.deepEqual(changed.scenes[0].camera,shot.camera);
 assert.equal(changed.scenes[0].objects[0].arrayParts.lights.length,1);
});

const streetAssembly=()=>{
 const stem=(id,z,orientation)=>({...row(id,'Pole',[0,3,z],[0,orientation,0]),
   material:{color:'#384550',metalness:.1,roughness:.8}});
 const bulb=(id,z,orientation)=>({...makePrimitive('sphere',id,[0,7,z]),
   name:'Lantern',scale:[.75,.4,.75],rotation:[0,orientation,0],
   repeat:{count:[3,1,1],spacing:[8,0,0]}});
 return {schemaVersion:1,scenes:[{shotId:'street',objects:[
   stem('north_pole',10,0),bulb('north_lantern',10,0),
   stem('south_pole',-10,Math.PI),bulb('south_lantern',-10,Math.PI),
   {...bulb('bad_spacing',10,0),name:'Unaligned',repeat:{count:[3,1,1],spacing:[7.6,0,0]}},
   {...stem('far_bollard',40,0),name:'Bollard'}
 ]}]};
};
test('companion discovery requires equal repeated geometry locations in both rows',()=>{
 const input=streetAssembly(),snapshot=structuredClone(input);
 const found=findArrayCompanions(input,'street','north_pole');
 assert.equal(found.length,1);
 assert.equal(found[0].id,'north_lantern');
 assert.deepEqual(found[0].ids,['north_lantern','south_lantern']);
 assert.deepEqual(found[0].part.position.map(n=>Math.round(n*100)/100),[0,4,0]);
 assert.equal(found[0].part.primitive,'sphere');
 assert.equal(findArrayCompanions(input,'street','far_bollard').length,0);
 assert.deepEqual(input,snapshot,'discovery has no side effects');
});

test('grouped save folds distinct array definitions into editable parts without changing other rows',()=>{
 const input=streetAssembly(),before=structuredClone(input);
 const grouped=findArrayCompanions(input,'street','north_pole')[0];
 const source=input.scenes[0].objects[0];
 const output=saveArrayPrototype(input,['street'],'street','north_pole',{
   name:'Streetlight assembly',scale:source.scale,material:source.material,
   parts:{objects:[{...grouped.part,id:'lantern_piece'}],lights:[light()]}
 },['north_pole','south_pole'],grouped.ids);
 assert.deepEqual(input,before,'Cancel/undo snapshot remains unchanged');
 const items=output.scenes[0].objects;
 assert.equal(items.length,before.scenes[0].objects.length-2);
 for(const pole of items.slice(0,2)){
   assert.equal(pole.name,'Streetlight assembly');
   assert.equal(pole.arrayParts.objects.length,1);
   assert.equal(pole.arrayParts.objects[0].primitive,'sphere');
   assert.deepEqual(pole.arrayParts.objects[0].position,[0,4,0]);
   assert.equal(pole.arrayParts.lights.length,1);
 }
 assert.deepEqual(items.slice(2),before.scenes[0].objects.slice(4));
 assert.ok(!items.some(x=>grouped.ids.includes(x.id)));
});

test('refuse partial companion absorption and mismatched or unrelated groups',()=>{
 const input=streetAssembly(),source=input.scenes[0].objects[0];
 const draft={name:source.name,scale:source.scale,material:source.material,
   parts:{objects:[],lights:[]}};
 assert.throws(()=>saveArrayPrototype(input,['street'],'street','north_pole',draft,
   ['north_pole','south_pole'],['north_lantern']),/complete spatially aligned/);
 assert.throws(()=>saveArrayPrototype(input,['street'],'street','north_pole',draft,
   ['north_pole','south_pole'],['far_bollard']),/complete spatially aligned/);
 assert.throws(()=>saveArrayPrototype(input,['street'],'street','north_pole',
   {...draft,position:[Infinity,0,0]},['north_pole','south_pole']),/finite XYZ/);
});

test('XYZ and rotation edits move matching array holders by deltas, not absolute placement',()=>{
 const input=streetAssembly(),stem=input.scenes[0].objects[0];
 const modified=saveArrayPrototype(input,['street'],'street','north_pole',{
   name:stem.name,scale:stem.scale,material:stem.material,
   position:[1,4,11],rotation:[0,.3,0],
   parts:{objects:[],lights:[]}
 });
 assert.deepEqual(modified.scenes[0].objects[0].position,[1,4,11]);
 assert.deepEqual(modified.scenes[0].objects[2].position,[1,4,-9]);
 assert.equal(modified.scenes[0].objects[2].rotation[1],Math.PI+.3);
});

// Representative small fixtures grounded in the imported Atoms-to-AI scene.
// The imported project is NOT copied into repository tests.
const namedRow=(name,id,primitive,position,count,spacing)=>{
 const obj=makePrimitive(primitive,id,position);
 obj.name=name;obj.repeat={count,spacing};
 return obj;
};
const realWorldPairs=()=>({schemaVersion:1,scenes:[{shotId:'exterior',objects:[
 namedRow('Right Ave Trunks','right_ave_trunks','cylinder',[70.5,1.6,-5],[1,1,14],[0,0,10.5]),
 namedRow('Right Ave Crowns','right_ave_crowns','sphere',[70.5,4.2,-5],[1,1,14],[0,0,10.5]),
 namedRow('Right Street Poles','right_street_poles','cylinder',[72.5,4.2,-10],[1,1,11],[0,0,14]),
 namedRow('Right Street Lamps','right_street_lamps','box',[73.3,8.4,-10],[1,1,11],[0,0,14]),
 namedRow('Front Ave Trunks','front_ave_trunks','cylinder',[-10,1.6,69.5],[16,1,1],[10.5,0,0]),
 namedRow('Front Ave Crowns','front_ave_crowns','sphere',[-10,4.2,69.5],[16,1,1],[10.5,0,0]),
 namedRow('Front Street Poles','front_street_poles','cylinder',[-12,4.2,70.2],[12,1,1],[14,0,0]),
 namedRow('Front Street Lamps','front_street_lamps','box',[-12,8.4,71],[12,1,1],[14,0,0]),
 namedRow('Side Bay Doors','side_bay_doors','box',[48.08,2.4,-16],[1,1,5],[0,0,7.5]),
 namedRow('Side Bay Downlights','side_bay_downlights','box',[48.3,4.8,-16],[1,1,5],[0,0,7.5]),
 namedRow('East Chiller Banks','east_banks','box',[22,14.6,-64],[8,1,2],[5.6,0,13]),
 namedRow('East Chiller Fans','east_fans','cylinder',[22,15.55,-64],[8,1,2],[5.6,0,13]),
 namedRow('East Chiller Plant Roof Beams','east_beams','box',[22,13.9,-64],[12,1,1],[4,0,0])
 ]}]});
test('two-word grouping matches named layouts from real exterior and ignores other nearby arrays',()=>{
 const doc=realWorldPairs();
 for(const [root,expected] of [
  ['right_ave_crowns','right_ave_trunks'],
  ['right_street_lamps','right_street_poles'],
  ['front_ave_trunks','front_ave_crowns'],
  ['front_street_poles','front_street_lamps'],
  ['side_bay_downlights','side_bay_doors'],
  ['east_banks','east_fans']
 ]){
  const named=findArrayCompanions(doc,'exterior',root).filter(x=>x.nameMatch);
  assert.deepEqual(named.map(x=>x.id),[expected],root+' must detect only its companion');
 }
 assert.equal(arrayGroupKey('RIGHT street lamps'),'right street');
 assert.equal(arrayGroupKey('Right Ave Crowns'),'right ave');
 assert.equal(arrayGroupKey('Right Street'),null);
 assert.equal(findArrayCompanions(doc,'exterior','east_banks')
   .some(x=>x.id==='east_beams'),false,'same name prefix cannot merge mismatched repeats');
});

test('named streetlight array merge is atomic, preserving each light position and parent count',()=>{
 const source=realWorldPairs(),before=structuredClone(source);
 const companion=findArrayCompanions(source,'exterior','right_street_poles')
   .find(x=>x.nameMatch&&x.id==='right_street_lamps');
 assert.ok(companion);
 const pole=source.scenes[0].objects.find(x=>x.id==='right_street_poles');
 const after=saveArrayPrototype(source,['exterior'],'exterior',pole.id,{
   name:pole.name,scale:pole.scale,material:pole.material,
   parts:{objects:[{...companion.part,id:'lamp_component'}],lights:[]}
 },[pole.id],companion.ids);
 assert.deepEqual(source,before);
 const parent=after.scenes[0].objects.find(o=>o.id===pole.id);
 assert.equal(parent.repeat.count[2],11);
 assert.equal(parent.arrayParts.objects[0].id,'lamp_component');
 assert.deepEqual(parent.arrayParts.objects[0].position.map(x=>Math.round(x*10)/10),[.8,4.2,0]);
 assert.equal(after.scenes[0].objects.some(o=>o.id==='right_street_lamps'),false);
 assert.equal(after.scenes[0].objects.some(o=>o.id==='right_ave_trunks'),true);
});


test('reusing Right Ave tree assembly replaces South Edge crown and creates aligned South Edge Trunks',async()=>{
 const {listAssemblyTemplates,replaceArrayAssembly,saveAssemblyTemplateDraft}=
   await import('../array-assembly-templates.js');
 const mk=(id,name,primitive,position,count,spacing)=>{
   const o=makePrimitive(primitive,id,position);
   o.name=name;o.repeat={count,spacing};return o;
 };
 const original={schemaVersion:1,scenes:[{shotId:'exterior',objects:[
   mk('avenue_trunks','Right Ave Trunks','cylinder',[70.5,1.6,-5],[1,1,14],[0,0,10.5]),
   mk('avenue_crowns','Right Ave Crowns','sphere',[70.5,4.2,-5],[1,1,14],[0,0,10.5]),
   mk('south_edge_trees','South Edge Trees','sphere',[-5,4.2,91],[14,1,1],[11,0,0])
 ]}]};
 const before=structuredClone(original);
 const template=listAssemblyTemplates(original,'exterior').find(t=>t.key==='right ave');
 assert.ok(template);
 assert.equal(template.parts.length,2);
 const crown=template.parts.find(x=>x.name==='Right Ave Crowns');
 const trunk=template.parts.find(x=>x.name==='Right Ave Trunks');
 const applied=replaceArrayAssembly(original,['exterior'],'exterior',
   'south_edge_trees',template.id,crown.id,trunk.id);
 assert.deepEqual(original,before,'template application must be transactional');
 const src=applied.document.scenes[0].objects;
 const edge=src.find(x=>x.id==='south_edge_trees');
 const stem=src.find(x=>x.name==='South Edge Trunks');
 assert.equal(edge.name,'South Edge Crowns');
 assert.ok(stem,'sibling trunk array was added with destination convention');
 assert.deepEqual(edge.repeat,{count:[14,1,1],spacing:[11,0,0]});
 assert.deepEqual(stem.repeat,edge.repeat);
 assert.deepEqual(edge.position,[-5,4.2,91]);
 assert.deepEqual(stem.position,[-5,1.6,91]);
 assert.deepEqual(src.find(x=>x.id==='avenue_trunks'),before.scenes[0].objects[0],
   'source assembly unchanged');
 assert.equal(src.length,4);
 const local=structuredClone(stem);
 local.id='draft_trunk';local.position=[0,-2.6,0];local.rotation=[0,0,0];
 delete local.repeat;delete local.layer;
 const saved=saveAssemblyTemplateDraft(applied.document,['exterior'],'exterior',
   edge.id,edge,{objects:[local],lights:[]},
   [{targetId:stem.id,partId:'draft_trunk'}]);
 assert.equal(saved.scenes[0].objects.find(x=>x.id===stem.id).name,'South Edge Trunks');
 assert.equal(saved.scenes[0].objects.length,4);
 assert.throws(()=>replaceArrayAssembly(original,['exterior'],'exterior',
   'south_edge_trees',template.id,crown.id,crown.id),/distinct/);
});
test('single object groups save local part adjustments without becoming arrays',()=>{
 const base=makePrimitive('cylinder','tree_trunk',[0,2,0]);
 base.name='Sample Tree';
 base.arrayParts={objects:[{...makePrimitive('sphere','crown',[0,3,0]),name:'Sample crown'}],lights:[]};
 const input={schemaVersion:1,scenes:[{shotId:'grove',objects:[base]}]};
 const normalized=validatePrimitiveDocument(input,['grove']);
 assert.equal(normalized.scenes[0].objects[0].repeat,undefined);
 const changed=saveArrayPrototype(input,['grove'],'grove','tree_trunk',{
   name:'Sample Tree',material:base.material,scale:base.scale,
   parts:{objects:[{...base.arrayParts.objects[0],position:[0,4,0]}],lights:[]}
 },['tree_trunk']);
 assert.deepEqual(changed.scenes[0].objects[0].arrayParts.objects[0].position,[0,4,0]);
 assert.equal(changed.scenes[0].objects[0].repeat,undefined);
});


test('array template replacement carries real prototype spotlights with local XYZ aim',async()=>{
 const {replaceArrayAssembly,listAssemblyTemplates}=await import('../array-assembly-templates.js');
 const mk=(id,name,primitive,position,count,spacing)=>{
   const o=makePrimitive(primitive,id,position);o.name=name;o.repeat={count,spacing};return o;
 };
 const trunk=mk('front_trunks','Front Ave Trunks','cylinder',[0,1.6,0],[4,1,1],[10,0,0]);
 trunk.arrayParts={objects:[],lights:[{
   id:'lamp',name:'Canopy uplight',type:'spot',position:[0,4,0],
   target:[0,0,0],color:'#ffffff',intensity:120,distance:30,angle:.5,penumbra:.2
 }]};
 const doc={schemaVersion:1,scenes:[{shotId:'a',objects:[trunk,
   mk('front_crowns','Front Ave Crowns','sphere',[0,4.2,0],[4,1,1],[10,0,0]),
   mk('south_trees','South Edge Trees','sphere',[30,4.2,10],[1,1,4],[0,0,9])
 ]}]};
 const template=listAssemblyTemplates(doc,'a').find(x=>x.key==='front ave');
 assert.ok(template);
 assert.equal(template.lights.length,1);
 const output=replaceArrayAssembly(doc,['a'],'a','south_trees',template.id,
   template.parts.find(p=>p.name==='Front Ave Crowns').id,
   template.parts.find(p=>p.name==='Front Ave Trunks').id);
 const dst=output.document.scenes[0].objects.find(o=>o.id==='south_trees');
 assert.equal(dst.arrayParts.lights.length,1);
 const moved=dst.arrayParts.lights[0];
 assert.ok(Math.abs(moved.position[1]-1.4)<1e-8);
 assert.ok(Math.abs(moved.target[1]+2.6)<1e-8);
 assert.equal(moved.type,'spot');
 assert.equal(moved.intensity,120);
 assert.equal(doc.scenes[0].objects.find(x=>x.id==='front_trunks').arrayParts.lights.length,1);
});


test('assembly replacement and subsequent edits propagate over multiple destination rows',async()=>{
 const {replaceArrayAssembly,listAssemblyTemplates,saveAssemblyTemplateDraft}=
   await import('../array-assembly-templates.js');
 const mk=(id,name,primitive,position,repeat,rotation=[0,0,0])=>{
   const obj=makePrimitive(primitive,id,position);
   obj.name=name;obj.repeat=repeat;obj.rotation=rotation;return obj;
 };
 const layout={count:[3,1,1],spacing:[8,0,0]};
 const source={schemaVersion:1,scenes:[{shotId:'forest',objects:[
   mk('src_trunk','Right Ave Trunks','cylinder',[0,1,0],layout),
   mk('src_crown','Right Ave Crowns','sphere',[0,3,0],layout),
   mk('dst_a','South Edge Trees','sphere',[0,4,20],
      {count:[5,1,1],spacing:[6,0,0]}),
   mk('dst_b','South Edge Trees','sphere',[40,4,20],
      {count:[1,1,6],spacing:[0,0,7]},[0,Math.PI/2,0])
 ]}]};
 const template=listAssemblyTemplates(source,'forest').find(x=>x.key==='right ave');
 const crown=template.parts.find(x=>x.name==='Right Ave Crowns');
 const trunk=template.parts.find(x=>x.name==='Right Ave Trunks');
 const replaced=replaceArrayAssembly(source,['forest'],'forest',
   'dst_a',template.id,crown.id,trunk.id);
 assert.equal(replaced.created.length,2,'one new trunk array per destination source row');
 const first=replaced.document.scenes[0].objects.find(x=>x.id==='dst_a');
 const draftPart={...structuredClone(replaced.document.scenes[0].objects.find(
   x=>x.id===replaced.created[0].targetId)),id:'trunk_edit',
   position:[0,-3,0],rotation:[0,0,0]};
 delete draftPart.repeat;delete draftPart.arrayParts;delete draftPart.layer;
 const saved=saveAssemblyTemplateDraft(replaced.document,['forest'],'forest',
   first.id,{...first,material:{...first.material,color:'#889944'}},
   {objects:[draftPart],lights:[]},
   replaced.created.map(m=>({...m,partId:'trunk_edit'})));
 for(const rowId of ['dst_a','dst_b']){
   const row=saved.scenes[0].objects.find(x=>x.id===rowId);
   assert.equal(row.name,'South Edge Crowns');
   assert.equal(row.material.color,'#889944');
 }
 assert.deepEqual(saved.scenes[0].objects.find(x=>x.id==='dst_b').repeat,
   {count:[1,1,6],spacing:[0,0,7]});
 for(const created of replaced.created)
   assert.ok(saved.scenes[0].objects.some(x=>x.id===created.targetId),
     'each sibling preserved after editing one prototype');
});


test('3-part lamp assemblies retain complete descriptors, copies and existing destination lights',async()=>{
 const {listAssemblyTemplates,replaceArrayAssembly,assemblyDescriptor}
   =await import('../array-assembly-templates.js');
 const create=(id,name,type,at)=>({
   ...makePrimitive(type,id,at),name,repeat:{count:[1,1,7],spacing:[0,0,9]}
 });
 const post=create('lamp_post','Right Street Posts','cylinder',[0,3.5,0]);
 const housing=create('lamp_housing','Right Street Lamp Housings','box',[0,7.3,0]);
 housing.arrayParts={objects:[],lights:[{
   id:'source_beam',name:'Right Street Beam Lights',type:'spot',
   color:'#ffffff',intensity:80,position:[0,0,0],target:[0,-4,0],
   angle:.7,penumbra:.25,distance:25
 }]};
 const glass=create('lamp_glass','Right Street Glass Globes','sphere',[0,7.5,0]);
 const target=create('south_lamps','South Edge Lamps','box',[20,7.3,50]);
 target.arrayParts={objects:[],lights:[{
   id:'existing_light',name:'South Edge Lamp Glow',type:'spot',
   color:'#ffccaa',intensity:220,position:[0,0,0],target:[0,-5,0],
   angle:.6,penumbra:.3,distance:32
 }]};
 const before={schemaVersion:1,scenes:[{shotId:'a',objects:[post,housing,glass,target]}]};
 const original=structuredClone(before);
 const template=listAssemblyTemplates(before,'a').find(t=>t.key==='right street');
 assert.ok(template,'a light-bearing array must not prevent source template discovery');
 assert.equal(template.parts.length,3);
 assert.equal(template.lights.length,1);
 assert.match(template.label,/Lamp Housings/);
 assert.match(template.label,/Glass Globes/);
 assert.equal(assemblyDescriptor('Right Street Light Housing','Right Street'),'Light Housing');
 const housingComponent=template.parts.find(p=>p.name===housing.name);
 const result=replaceArrayAssembly(before,['a'],'a','south_lamps',
   template.id,housingComponent.id);
 assert.deepEqual(before,original);
 const after=result.document.scenes[0].objects;
 const main=after.find(x=>x.id==='south_lamps');
 assert.equal(main.name,'South Edge Lamp Housings');
 assert.equal(main.repeat.count[2],7);
 assert.equal(main.arrayParts.lights.length,1,
   'the destination existing light must be retained instead of duplicated');
 assert.equal(main.arrayParts.lights[0].intensity,220);
 assert.equal(after.find(x=>x.name==='South Edge Posts').repeat.count[2],7);
 assert.equal(after.find(x=>x.name==='South Edge Glass Globes').repeat.count[2],7);
 assert.equal(after.length,6,'3 source arrays untouched + 3 target arrays');
 assert.ok(Math.abs(after.find(x=>x.name==='South Edge Posts').position[1]-3.5)<1e-8);
 assert.deepEqual(after.find(x=>x.name==='South Edge Glass Globes').repeat,main.repeat);
 const override=replaceArrayAssembly(before,['a'],'a','south_lamps',
   template.id,housingComponent.id,undefined,{replaceLights:true});
 assert.equal(override.document.scenes[0].objects.find(x=>x.id==='south_lamps')
   .arrayParts.lights[0].intensity,80,'source lights require explicit opt-in');
});


test('scene Outliner converts a legacy two-part tree into one parent array with real child geometry',async()=>{
 const {editableAssembly,saveAssemblyHierarchy}=
   await import('../array-assembly-templates.js');
 const copies={count:[1,1,14],spacing:[0,0,10]};
 const mk=(id,name,type,position)=>{
   const item=makePrimitive(type,id,position);item.name=name;item.repeat=structuredClone(copies);
   return item;
 };
 const crowns=mk('crowns','Corner Grove Crowns','sphere',[20,4.3,5]);
 const trunks=mk('trunks','Corner Grove Trunks','cylinder',[20,1.6,5]);
 const old={schemaVersion:1,scenes:[{shotId:'forest',objects:[crowns,trunks]}]};
 const source=structuredClone(old);
 const converted=editableAssembly(crowns);
 assert.equal(converted.base.primitive,'group');
 assert.equal(converted.parts.objects.length,1);
 const trunk={...structuredClone(trunks),id:'local_trunk',position:[0,-2.7,0],
   rotation:[0,0,0]};
 delete trunk.repeat;
 converted.parts.objects.push(trunk);
 converted.parts.order.push('object:local_trunk');
 const saved=saveAssemblyHierarchy(old,['forest'],'forest','crowns',converted,['crowns'],['trunks']);
 assert.deepEqual(old,source,'editing a prototype cannot modify the scene before Save');
 assert.equal(saved.scenes[0].objects.length,1);
 const group=saved.scenes[0].objects[0];
 assert.equal(group.primitive,'group');
 assert.equal(group.name,'Corner Grove');
 assert.equal(group.arrayParts.objects.length,2);
 assert.deepEqual(group.arrayParts.order,['object:source_mesh','object:local_trunk']);
 assert.deepEqual(group.position,crowns.position);
 assert.deepEqual(group.repeat,copies);
 assert.equal(validatePrimitiveDocument(saved,['forest']).scenes[0].objects[0].arrayParts.order.length,2);
});

test('replace entire three-mesh lamp assembly and all lights, retaining destination XYZ rotation and copies',async()=>{
 const {listAssemblyTemplates,replaceAssemblyContents,saveAssemblyHierarchy}
   =await import('../array-assembly-templates.js');
 const mk=(id,name,type,pos,rep)=>{
   const item=makePrimitive(type,id,pos);
   item.name=name;item.repeat=rep;return item;
 };
 const sourceRepeat={count:[1,1,3],spacing:[0,0,7]};
 const targetRepeat={count:[5,1,1],spacing:[11,0,0]};
 const post=mk('post','Right Street Posts','cylinder',[0,3,0],sourceRepeat);
 const housing=mk('house','Right Street Lamp Housing','box',[0,7,0],sourceRepeat);
 const lens=mk('lens','Right Street Glass Lens','sphere',[0,7.3,0],sourceRepeat);
 housing.arrayParts={objects:[],lights:[{
   id:'source_glow',name:'Right Street Soft Light',type:'spot',color:'#ffedcc',
   intensity:180,position:[0,0,0],target:[0,-3,0],distance:40,
   angle:.6,penumbra:.4
 }]};
 const target=mk('target','South Edge Trees','sphere',[70,3,20],targetRepeat);
 target.rotation=[0,Math.PI/2,0];
 target.arrayParts={objects:[],lights:[{
   id:'old',name:'South Edge Old Light',type:'point',color:'#ffffff',
   intensity:25,position:[0,0,0],distance:12
 }]};
 const input={schemaVersion:1,scenes:[{shotId:'street',objects:[post,housing,lens,target]}]};
 const snapshot=structuredClone(input);
 const template=listAssemblyTemplates(input,'street').find(t=>t.key==='right street');
 assert.ok(template,'3-part lamp can be used as a template');
 const result=replaceAssemblyContents(input,['street'],'street','target',template.id);
 assert.deepEqual(input,snapshot,'the real scene is immutable before Save');
 assert.equal(result.componentCount,4,'all three meshes and spotlight copied');
 const swapped=result.document.scenes[0].objects.find(x=>x.id==='target');
 assert.equal(swapped.primitive,'group');
 assert.deepEqual(swapped.position,target.position);
 assert.deepEqual(swapped.rotation,target.rotation);
 assert.deepEqual(swapped.repeat,target.repeat);
 assert.equal(swapped.arrayParts.objects.length,3);
 assert.equal(swapped.arrayParts.lights.length,1);
 assert.deepEqual(swapped.arrayParts.order.length,4);
 assert.deepEqual(swapped.arrayParts.objects.map(x=>x.name),[
   'South Edge Posts','South Edge Lamp Housing','South Edge Glass Lens'
 ]);
 assert.equal(swapped.arrayParts.lights[0].name,'South Edge Soft Light');
 assert.equal(swapped.arrayParts.lights[0].intensity,180);
 assert.equal(result.document.scenes[0].objects.length,4,'source assembly remains untouched');
 const edited=structuredClone(swapped);
 edited.arrayParts.objects[0].name='South Edge Renamed Post';
 edited.arrayParts.objects[0].position[0]+=.6;
 edited.arrayParts.order.reverse();
 const saved=saveAssemblyHierarchy(result.document,['street'],'street','target',
   {base:edited,parts:edited.arrayParts},['target']);
 const after=saved.scenes[0].objects.find(x=>x.id==='target');
 assert.deepEqual(after.position,target.position);
 assert.deepEqual(after.rotation,target.rotation);
 assert.deepEqual(after.repeat,target.repeat);
 assert.equal(after.arrayParts.objects[0].name,'South Edge Renamed Post');
 assert.equal(after.arrayParts.order[0].startsWith('light:'),true);
 assert.throws(()=>validatePrimitiveDocument({schemaVersion:1,scenes:[{shotId:'street',
   objects:[{...after,arrayParts:{...after.arrayParts,order:[
     ...after.arrayParts.order.slice(0,-1),'object:does_not_exist']}}]}]},['street']),/order/);
});

test('single newly authored tree group can be reused as an assembly template',async()=>{
 const {listAssemblyTemplates,replaceAssemblyContents}=
   await import('../array-assembly-templates.js');
 const root=makePrimitive('group','pine_parent',[1,0,2]);
 root.name='Forest Pine';root.arrayParts={objects:[
   {...makePrimitive('cylinder','trunk',[0,2,0]),name:'Forest Pine Trunk'},
   {...makePrimitive('sphere','crown',[0,5,0]),name:'Forest Pine Crown'}
 ],lights:[],order:['object:trunk','object:crown']};
 const target=makePrimitive('sphere','target',[40,5,10]);
 target.name='South Edge Trees';target.repeat={count:[3,1,1],spacing:[12,0,0]};
 const input={schemaVersion:1,scenes:[{shotId:'forest',objects:[root,target]}]};
 const src=listAssemblyTemplates(input,'forest').find(x=>x.id==='pine_parent');
 assert.ok(src,'a single non-repeating multi-piece group is a valid source');
 const result=replaceAssemblyContents(input,['forest'],'forest','target','pine_parent');
 assert.equal(result.document.scenes[0].objects.find(x=>x.id==='target').arrayParts.objects.length,2);
});
