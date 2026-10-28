import test from 'node:test';
import assert from 'node:assert/strict';
import {makePrimitive,validatePrimitiveDocument} from '../primitive-schema.js';
import {tagGeneratedScene,markEditorEdits,groupGeneratedArrays,editorItems,
  composeGeneratedChapter,createLibraryEntry,saveEditLibraryEntry,readEditLibrary,
  restoreEditLibraryEntry,deleteEditLibraryEntry,editorEditCount,EDIT_LIBRARY_KEY}
  from '../scene-generation-compose.js';

const geometry=(id,name=id)=>({...makePrimitive('box',id,[0,1,0]),name});
const light=(id,type='spot')=>({id,name:id,type,color:'#ffffff',intensity:75,
  position:[0,6,0],target:[0,0,0],distance:25,angle:.7,penumbra:.3});
const doc=scene=>({schemaVersion:1,scenes:[scene]});
const validate=scene=>validatePrimitiveDocument(doc(scene)).scenes[0];

test('Argon stays data-only, while generated provenance survives JSON roundtrip',()=>{
  const raw={shotId:'shot',objects:[geometry('hall')],lights:[{...light(''),id:undefined}]};
  const original=structuredClone(raw);
  const generated=tagGeneratedScene(raw);
  assert.deepEqual(raw,original);
  assert.equal(generated.objects[0].source,'argon');
  assert.equal(generated.lights[0].source,'argon');
  assert.equal(generated.lights[0].id,'ai_light_1');
  assert.deepEqual(validate(JSON.parse(JSON.stringify(generated))),generated);
});

test('editor mutations mark new additions and keep generated modifications separate',()=>{
  const generated=tagGeneratedScene({shotId:'shot',objects:[geometry('building')],
    lights:[light('argon_spot')]});
  const next=structuredClone(generated);
  next.objects[0].material.color='#ff8800';
  next.objects.push(geometry('editor_sign'));
  next.lights[0].fakeConeOpacity=.7;
  next.lights.push(light('editor_spot'));
  const tracked=markEditorEdits(doc(generated),doc(next)).scenes[0];
  assert.equal(tracked.objects[0].source,'argon');
  assert.equal(tracked.objects[0].editorModified,true);
  assert.equal(tracked.objects[1].source,'editor');
  assert.equal(tracked.lights[0].editorModified,true);
  assert.equal(tracked.lights[1].source,'editor');
  const still=markEditorEdits(doc(tracked),doc(tracked)).scenes[0];
  assert.deepEqual(still,tracked,'repeated no-op editing does not reset provenance');
});

test('regeneration preserves modified generated items and manual spotlights only in keep mode',()=>{
  const old=tagGeneratedScene({shotId:'shot',
    objects:[geometry('building'),geometry('background')],
    lights:[light('old_argon_spot')]});
  const edited=structuredClone(old);
  edited.objects[0].material.color='#123456';
  edited.objects.push(geometry('manual_bench'));
  edited.lights.push({...light('manual_spot'),fakeConeOpacity:.3});
  const tracked=markEditorEdits(doc(old),doc(edited)).scenes[0];
  const generated=tagGeneratedScene({shotId:'shot',
    objects:[{...geometry('building'),position:[5,1,0]},geometry('new_landmark')],
    lights:[light('new_argon_spot')]});
  const keep=composeGeneratedChapter(tracked,generated,'keep');
  assert.deepEqual(keep.objects.map(x=>x.id),
    ['new_landmark','building','manual_bench']);
  assert.equal(keep.objects.find(x=>x.id==='building').material.color,'#123456');
  assert.deepEqual(keep.lights.map(x=>x.id),['new_argon_spot','manual_spot']);
  assert.equal(keep.lights[1].fakeConeOpacity,.3);
  const cleared=composeGeneratedChapter(tracked,generated,'clear');
  assert.deepEqual(cleared.objects.map(x=>x.id),['building','new_landmark']);
  assert.deepEqual(cleared.lights.map(x=>x.id),['new_argon_spot']);
  assert.deepEqual(composeGeneratedChapter(tracked,generated,'library'),cleared);
  assert.equal(tracked.objects.length,3,'original editor timeline never mutates');
  assert.equal(editorEditCount(tracked),3);
  assert.deepEqual(editorItems(tracked).objects.map(x=>x.id),['building','manual_bench']);
});

test('legacy unclassified objects are preserved unless user explicitly clears them',()=>{
  const old=validate({shotId:'shot',objects:[geometry('historic')],lights:[light('old_light')]});
  const generated=tagGeneratedScene({shotId:'shot',objects:[geometry('new_building')]});
  const kept=composeGeneratedChapter(old,generated,'keep');
  assert.deepEqual(kept.objects.map(x=>x.id),['new_building','historic']);
  assert.equal(kept.lights[0].id,'old_light');
  assert.deepEqual(composeGeneratedChapter(old,generated,'clear').objects.map(x=>x.id),
    ['new_building']);
});

test('post-generation grouping folds aligned named arrays but never unrelated fixtures',()=>{
  const repeat={count:[3,1,1],spacing:[9,0,0]};
  const pole={...makePrimitive('cylinder','north_poles',[0,3,0]),
    name:'North Road Poles',scale:[.3,6,.3],repeat};
  const head={...makePrimitive('sphere','north_heads',[0,7,0]),
    name:'North Road Heads',scale:[.7,.6,.7],repeat};
  const unrelated={...makePrimitive('box','east_fence',[0,2,18]),
    name:'East Fence Boards',repeat:{count:[3,1,1],spacing:[4,0,0]}};
  const raw=validate({shotId:'shot',objects:[pole,head,unrelated]});
  const grouped=groupGeneratedArrays(raw);
  assert.equal(grouped.grouped,1);
  assert.equal(grouped.absorbed,1);
  const parent=grouped.scene.objects.find(x=>x.id==='north_poles');
  assert.equal(parent.primitive,'group');
  assert.equal(parent.source,'argon');
  assert.equal(parent.repeat.count[0],3);
  assert.deepEqual(parent.arrayParts.objects.map(x=>x.primitive),['cylinder','sphere']);
  assert.deepEqual(parent.arrayParts.objects[1].position,[0,4,0]);
  assert.ok(grouped.scene.objects.some(x=>x.id==='east_fence'));
  assert.deepEqual(validate(grouped.scene),grouped.scene);
  assert.deepEqual(raw.objects.map(x=>x.id),['north_poles','north_heads','east_fence']);
  assert.equal(groupGeneratedArrays(grouped.scene).grouped,0,'post-processing is idempotent');
});

test('library creates durable copies, restores edited assets without mutating source, and fails closed',()=>{
  const old=tagGeneratedScene({shotId:'shot',objects:[geometry('generated')],
    lights:[light('source_spot')]});
  const edited=structuredClone(old);
  edited.objects.push(geometry('manual_plant'));
  edited.lights[0].fakeConeOpacity=.6;
  const tracked=markEditorEdits(doc(old),doc(edited)).scenes[0];
  const storage={m:new Map(),getItem(key){return this.m.get(key)||null;},
    setItem(key,value){this.m.set(key,value);}};
  const created=createLibraryEntry(tracked,'Chapter one');
  const saved=saveEditLibraryEntry(storage,created);
  assert.equal(readEditLibrary(storage).length,1);
  assert.deepEqual(saved.objects.map(o=>o.id),['manual_plant']);
  assert.deepEqual(saved.lights.map(o=>o.id),['source_spot']);
  const replacement=composeGeneratedChapter(tracked,tagGeneratedScene({
    shotId:'shot',objects:[geometry('fresh')]}),'library');
  assert.deepEqual(replacement.objects.map(o=>o.id),['fresh']);
  const restored=restoreEditLibraryEntry(doc(replacement),'shot',saved).scenes[0];
  assert.deepEqual(restored.objects.map(o=>o.id),['fresh','manual_plant']);
  assert.equal(restored.lights[0].fakeConeOpacity,.6);
  assert.equal(restored.lights[0].source,'editor');
  assert.equal(readEditLibrary(storage).length,1);
  deleteEditLibraryEntry(storage,saved.id);
  assert.deepEqual(readEditLibrary(storage),[]);
  assert.equal(storage.m.has(EDIT_LIBRARY_KEY),true);
  storage.setItem=()=>{throw Error('quota exceeded');};
  assert.throws(()=>saveEditLibraryEntry(storage,created),/quota exceeded/);
  assert.equal(tracked.lights[0].fakeConeOpacity,.6,'failed backup never edits chapter');
});
