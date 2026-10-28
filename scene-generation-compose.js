// Local post-generation composition. Argon provider requests and Worker JSON remain unchanged.
import {validatePrimitiveDocument,LIMITS} from './primitive-schema.js';
import {arrayGroupKey,findArrayCompanions,findMatchingArrays} from './array-prototype.js';

export const EDIT_LIBRARY_KEY='paige-scene-edit-library-v1';
export const EDIT_MODES=Object.freeze(['keep','library','clear']);
const clone=value=>structuredClone(value);
const sourceOf=item=>item?.source==='argon'?'argon':'editor';
const isEdited=item=>sourceOf(item)!=='argon'||item?.editorModified===true;
const signature=item=>JSON.stringify(Object.fromEntries(Object.entries(item).filter(
  ([key])=>key!=='source'&&key!=='editorModified')));
const copies=item=>item.repeat?item.repeat.count.reduce((n,v)=>n*v,1):1;

export function tagGeneratedScene(input){
  const validated=validatePrimitiveDocument({schemaVersion:1,scenes:[input]});
  const entry=validated.scenes[0];
  return {...entry,objects:entry.objects.map(object=>({...object,source:'argon'})),
    ...(entry.lights?{lights:entry.lights.map((light,i)=>({
      ...light,id:light.id||'argon_light_'+(i+1),source:'argon'}))}:{})};
}

// Mark new editor-created nodes and remember modifications to generated nodes.
// This is a local editor transaction, never a model-generation request.
export function markEditorEdits(before,after,allowedShots=null){
  const old=validatePrimitiveDocument(before,allowedShots);
  const next=validatePrimitiveDocument(after,allowedShots);
  const prior=new Map(old.scenes.map(scene=>[scene.shotId,scene]));
  const scenes=next.scenes.map(scene=>{
    const previous=prior.get(scene.shotId);
    const objects=new Map((previous?.objects||[]).map(item=>[item.id,item]));
    const lights=new Map((previous?.lights||[]).filter(l=>l.id).map(item=>[item.id,item]));
    const mark=(item,original)=>{
      if(!original)return {...item,source:item.source||'editor'};
      if(original.source==='argon'){
        return {...item,source:'argon',...((original.editorModified===true||
          signature(item)!==signature(original))?{editorModified:true}:{})};
      }
      return {...item,...(original.source?{source:original.source}:{})};
    };
    return {...scene,objects:scene.objects.map(item=>mark(item,objects.get(item.id))),
      ...(scene.lights?{lights:scene.lights.map((item,i)=>mark(item,
        item.id?lights.get(item.id):previous?.lights?.[i]))}:{})};
  });
  return validatePrimitiveDocument({schemaVersion:1,scenes},allowedShots);
}

// A candidate pair must share a meaningful name prefix AND identical repeated
// placements; nearby unrelated arrays never get grouped automatically.
// The original meshes become local children of one ordinary group object.
export function groupGeneratedArrays(input){
  let entry=tagGeneratedScene(input);
  const originalCount=entry.objects.length;
  const used=new Set();
  const replacements=new Map(),absorbed=new Set();
  const document=()=>({schemaVersion:1,scenes:[entry]});
  for(const base of entry.objects){
    if(used.has(base.id)||!base.repeat||base.arrayParts||
       base.instanceRotation||!arrayGroupKey(base.name))continue;
    const matches=findMatchingArrays(document(),entry.shotId,base.id);
    if(matches.some(id=>used.has(id)))continue;
    const companions=findArrayCompanions(document(),entry.shotId,base.id)
      .filter(item=>item.nameMatch&&item.ids.every(id=>!used.has(id)));
    if(!companions.length)continue;
    const related=[...new Set(companions.flatMap(item=>item.ids))];
    if(related.some(id=>matches.includes(id)))continue;
    const toGroup=[];
    for(const id of matches){
      const root=entry.objects.find(o=>o.id===id);
      if(!root||root.arrayParts||root.instanceRotation)continue;
      const rootChild={id:root.id+'_mesh',name:root.name,primitive:root.primitive,
        position:[0,0,0],rotation:[0,0,0],scale:[...root.scale],
        material:clone(root.material),source:'argon',
        ...(root.points?{points:clone(root.points)}:{})};
      const children=[rootChild],childIds=new Set([rootChild.id]);
      for(const companion of companions){
        const index=matches.indexOf(id),item=entry.objects.find(o=>o.id===companion.ids[index]);
        if(!item||item.arrayParts||item.instanceRotation||item.layer!==root.layer){
          children.length=0;break;
        }
        const part={...clone(companion.part),source:'argon'};
        part.id=item.id+'_mesh';
        if(childIds.has(part.id)){children.length=0;break;}
        childIds.add(part.id);
        children.push(part);
      }
      if(!children.length)break;
      const group={...root,name:root.name.trim().split(/\s+/).slice(0,2).join(' '),
        primitive:'group',scale:[1,1,1],material:{color:'#888888',metalness:0,roughness:1},
        arrayParts:{objects:children,lights:[],
          order:children.map(part=>'object:'+part.id)}};
      delete group.points;
      toGroup.push(group);
    }
    if(toGroup.length!==matches.length)continue;
    // Validate the whole proposed replacement transaction before committing it.
    const removedIds=new Set([...matches,...related]);
    const test={...entry,objects:[...entry.objects.filter(o=>!removedIds.has(o.id)),...toGroup]};
    try{validatePrimitiveDocument({schemaVersion:1,scenes:[test]});}
    catch{continue;}
    for(const group of toGroup)replacements.set(group.id,group);
    for(const id of related)absorbed.add(id);
    for(const id of removedIds)used.add(id);
  }
  entry={...entry,objects:entry.objects.filter(o=>!absorbed.has(o.id))
    .map(o=>replacements.get(o.id)||o)};
  entry=validatePrimitiveDocument({schemaVersion:1,scenes:[entry]}).scenes[0];
  return {scene:entry,grouped:replacements.size,absorbed:originalCount-entry.objects.length};
}
export function editorItems(scene){
  return {objects:(scene?.objects||[]).filter(isEdited).map(item=>clone(item)),
    lights:(scene?.lights||[]).filter(isEdited).map(item=>clone(item))};
}
export function editorEditCount(scene){
  const items=editorItems(scene);
  return items.objects.length+items.lights.length+
    (scene?.effects?1:0)+(scene?.layerVisibility?1:0);
}
export function createLibraryEntry(scene,label,date=new Date().toISOString()){
  const edits=editorItems(scene);
  return {id:'edits_'+date.replace(/[^0-9]/g,'').slice(0,17),
    label:String(label||scene.shotId).slice(0,100),createdAt:date,
    objects:edits.objects,lights:edits.lights,
    ...(scene.effects?{effects:clone(scene.effects)}:{}),
    ...(scene.layerVisibility?{layerVisibility:clone(scene.layerVisibility)}:{})};
}
export function readEditLibrary(storage){
  let parsed;
  try{parsed=JSON.parse(storage.getItem(EDIT_LIBRARY_KEY)||'[]');}catch{return [];}
  return Array.isArray(parsed)?parsed.filter(item=>item&&typeof item.id==='string'&&
    Array.isArray(item.objects)&&Array.isArray(item.lights)).slice(0,24):[];
}
export function saveEditLibraryEntry(storage,entry){
  const current=readEditLibrary(storage);
  if(current.length>=24)throw Error('The edits library is full (24 saves). Delete an older entry before saving.');
  const next=[{...entry,id:entry.id+'_'+current.length},...current];
  // Storage errors are fatal: never discard editor additions if the backup failed.
  storage.setItem(EDIT_LIBRARY_KEY,JSON.stringify(next));
  return next[0];
}
export function deleteEditLibraryEntry(storage,id){
  const current=readEditLibrary(storage),next=current.filter(item=>item.id!==id);
  if(next.length===current.length)throw Error('Saved library entry not found.');
  storage.setItem(EDIT_LIBRARY_KEY,JSON.stringify(next));
}
export function restoreEditLibraryEntry(document,shotId,entry,allowedShots=null){
  const doc=validatePrimitiveDocument(document,allowedShots);
  let chapter=doc.scenes.find(s=>s.shotId===shotId);
  if(!chapter){chapter={shotId,objects:[]};doc.scenes.push(chapter);}
  const unique=(raw,taken)=>{
    let id=raw.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,48)||'saved';
    if(!/^[a-zA-Z0-9]/.test(id))id='saved_'+id;
    let suffix=2,chosen=id;
    while(taken.has(chosen))chosen=id+'_'+suffix++;
    taken.add(chosen);return chosen;
  };
  const objectIds=new Set(chapter.objects.map(x=>x.id));
  const lightIds=new Set((chapter.lights||[]).map(x=>x.id).filter(Boolean));
  chapter.objects.push(...entry.objects.map(item=>{
    const copy=clone(item);copy.id=unique(copy.id,objectIds);
    copy.source='editor';delete copy.editorModified;
    return copy;
  }));
  chapter.lights=[...(chapter.lights||[]),...entry.lights.map(item=>{
    const copy=clone(item);copy.id=unique(copy.id||'saved_light',lightIds);
    copy.source='editor';delete copy.editorModified;
    return copy;
  })];
  // Saving look settings is useful, but never overwrite current effects on
  // restore: those have an independent chapter-wide editor control.
  return validatePrimitiveDocument(doc,allowedShots);
}
export function composeGeneratedChapter(oldScene,newScene,mode='keep',allowedShots=null){
  if(!EDIT_MODES.includes(mode))throw Error('Unknown editor-edit handling choice');
  const generated=tagGeneratedScene(newScene);
  if(!oldScene)return generated;
  const before=validatePrimitiveDocument({schemaVersion:1,scenes:[oldScene]},allowedShots).scenes[0];
  const edits=editorItems(before);
  const keep=mode==='keep';
  const preservedObjects=keep?edits.objects:[];
  const preservedLights=keep?edits.lights:[];
  const reserved=new Set(preservedObjects.map(o=>o.id));
  const used=new Set(reserved);
  const newObjects=generated.objects.filter(o=>!reserved.has(o.id)).map(o=>{
    const copy=clone(o);
    let id=copy.id,suffix=2;
    while(used.has(id))id=copy.id.slice(0,58)+'_'+suffix++;
    copy.id=id;used.add(id);return copy;
  });
  const lightReserved=new Set(preservedLights.map(l=>l.id).filter(Boolean));
  const lightIds=new Set(lightReserved);
  const newLights=(generated.lights||[]).filter(l=>!lightReserved.has(l.id)).map(l=>{
    const copy=clone(l);let id=copy.id||'argon_light',suffix=2;
    while(lightIds.has(id))id='argon_light_'+suffix++;
    copy.id=id;lightIds.add(id);return copy;
  });
  const scene={...generated,objects:[...newObjects,...preservedObjects],
    ...((newLights.length||preservedLights.length)?{lights:[...newLights,...preservedLights]}:{}),
    ...(keep&&before.effects?{effects:clone(before.effects)}:{}),
    ...(keep&&before.layerVisibility?{layerVisibility:clone(before.layerVisibility)}:{})};
  return validatePrimitiveDocument({schemaVersion:1,scenes:[scene]},allowedShots).scenes[0];
}
