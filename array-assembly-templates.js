import * as THREE from 'three';
import {validatePrimitiveDocument} from './primitive-schema.js';
import {arrayGroupKey,findArrayCompanions,findMatchingArrays} from './array-prototype.js';

const quat=angles=>new THREE.Quaternion().setFromEuler(new THREE.Euler(...angles));
const euler=q=>new THREE.Euler().setFromQuaternion(q,'XYZ').toArray().slice(0,3);
const idPart=text=>text.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,50)||'component';
const unique=(id,taken)=>{
 let name=idPart(id),index=2;
 while(taken.has(name))name=(idPart(id).slice(0,55)+'_'+index++).slice(0,64);
 taken.add(name);return name;
};
const xyz=(v)=>new THREE.Vector3(...v);
const poseOf=(base,child)=>{
 const q=quat(base.rotation);
 return {...child,position:xyz(child.position).applyQuaternion(q).add(xyz(base.position)).toArray(),
   rotation:euler(q.multiply(quat(child.rotation)))};
};
const component=(root,child=null)=>{
 const item=child?poseOf(root,child):root;
 return {id:child?root.id+'::'+child.id:root.id,name:item.name,
   primitive:item.primitive,position:[...item.position],rotation:[...item.rotation],
   scale:[...item.scale],material:structuredClone(item.material),
   ...(item.points?{points:structuredClone(item.points)}:{}),
   layer:item.layer||root.layer};
};
// Descriptors are the COMPLETE text after the two-word assembly prefix,
// not the last token and not hard-coded "Crown", "Trunk", "Post", etc.
export function assemblyDescriptor(name,prefix=''){
 const words=String(name||'').trim().split(/\s+/);
 const head=String(prefix||'').trim().split(/\s+/);
 if(head.length>=2&&words.slice(0,head.length).join(' ').toLowerCase()===head.join(' ').toLowerCase())
   return words.slice(head.length).join(' ')||'Component';
 return String(name||'').trim()||'Component';
}
const partsFor=root=>[...(root.primitive==='group'?[]:[component(root)]),
 ...(root.arrayParts?.objects||[]).map(part=>component(root,part))];
const lightsFor=root=>(root.arrayParts?.lights||[]).map(light=>{
 const rotation=quat(root.rotation),center=xyz(root.position);
 const global=p=>xyz(p).applyQuaternion(rotation).add(center).toArray();
 return {...structuredClone(light),position:global(light.position),
   ...(light.target?{target:global(light.target)}:{})};
});
export function listAssemblyTemplates(source,shotId){
 const doc=validatePrimitiveDocument(source);
 const entry=doc.scenes.find(s=>s.shotId===shotId);
 if(!entry)return [];
 const out=[],seen=new Set(),byName=new Map();
 // The exterior contains hundreds of unrelated repeated arrays. Avoid
 // geometry comparisons for names that cannot possibly form an assembly.
 for(const item of entry.objects.filter(x=>
   x.repeat||x.arrayParts?.objects?.length||x.arrayParts?.lights?.length)){
   const key=arrayGroupKey(item.name)||
     (item.arrayParts?.objects?.length||item.arrayParts?.lights?.length?
       item.name.trim().toLowerCase():null);
   if(!key)continue;
   if(!byName.has(key))byName.set(key,[]);
   byName.get(key).push(item);
 }
 for(const [key,roots] of byName){
   if(roots.length<2&&!roots.some(x=>
     x.arrayParts?.objects?.length||x.arrayParts?.lights?.length))continue;
   // Match once per named family, not once per repeated object in the scene.
   for(const base of roots.slice(0,1)){
   const others=base.primitive==='group'?[]:
     findArrayCompanions(doc,shotId,base.id,{includeComposites:true})
       .filter(x=>x.nameMatch);
   const ids=[base.id,...others.map(c=>c.id)];
   const assembled=ids.map(id=>entry.objects.find(x=>x.id===id));
   const components=assembled.flatMap(partsFor);
   if(components.length+assembled.flatMap(lightsFor).length<2)continue;
   const signature=[...ids].sort().join('|');
   if(seen.has(signature))continue;
   seen.add(signature);
   const prefix=base.name.trim().split(/\s+/).slice(0,2).join(' ');
   const labels=components.map(c=>assemblyDescriptor(c.name,prefix)).join(' + ');
   out.push({id:base.id,key,prefix,label:prefix+' — '+labels,
     parts:components,lights:assembled.flatMap(lightsFor),rootIds:ids});
   }
 }
 return out.sort((a,b)=>a.label.localeCompare(b.label));
}
// Copies another assembly's primitive shapes while keeping the *destination*
// distribution: XYZ center, rotation, count, spacing and per-scene layer.
// New components are real sibling arrays named after the destination prefix,
// not a mutation of the source's prototypes or locations.
export function replaceArrayAssembly(source,allowedShots,shotId,destinationId,templateId,primaryId,secondaryId,
 {replaceLights=false}={}){
 const doc=validatePrimitiveDocument(source,allowedShots);
 const entry=doc.scenes.find(s=>s.shotId===shotId);
 const dest=entry?.objects.find(o=>o.id===destinationId&&o.repeat);
 if(!dest)throw Error('Destination must be an existing repeated object');
 const sourceTemplate=listAssemblyTemplates(doc,shotId).find(t=>t.id===templateId);
 if(!sourceTemplate)throw Error('Source assembly has changed; reopen the template list');
 const primary=sourceTemplate.parts.find(p=>p.id===primaryId);
 const secondary=sourceTemplate.parts.find(p=>p.id===secondaryId);
 if(!primary||secondaryId&&(!secondary||primary.id===secondary.id))
   throw Error('Choose distinct primary and supporting components');
 const naming=dest.name.trim().split(/\s+/).slice(0,2).join(' ');
 if(!arrayGroupKey(dest.name))throw Error('Destination needs a two-word group name');
 const roots=findMatchingArrays(doc,shotId,dest.id);
 // Do not absorb unrelated array definitions just because their names match.
 const companionGroups=findArrayCompanions(doc,shotId,dest.id,
   {includeComposites:true}).filter(c=>c.nameMatch);
 const oldCompanions=companionGroups.flatMap(c=>c.ids);
 const removed=new Set(oldCompanions.filter(id=>!roots.includes(id)));
 const used=new Set(entry.objects.map(o=>o.id));
 const members=[primary,...sourceTemplate.parts.filter(p=>p.id!==primary.id)];
 const primaryQuat=quat(primary.rotation);
 const copies=members.map((part,index)=>{
   const local=xyz(part.position).sub(xyz(primary.position))
     .applyQuaternion(primaryQuat.clone().invert());
   const relative=primaryQuat.clone().invert().multiply(quat(part.rotation));
   const role=assemblyDescriptor(part.name,sourceTemplate.prefix);
   const label=naming+' '+role;
   return {part,index,local,relative,label};
 });
 const sourceLights=(sourceTemplate.lights||[]).map((spec,index)=>{
   const relative=p=>xyz(p).sub(xyz(primary.position))
     .applyQuaternion(primaryQuat.clone().invert()).toArray();
   return {...structuredClone(spec),id:'assembly_light_'+index,
     position:relative(spec.position),
     ...(spec.target?{target:relative(spec.target)}:{})};
 });
 const created=[];
 for(const [rootIndex,rootId] of roots.entries()){
   const target=entry.objects.find(o=>o.id===rootId);
   const savedPosition=[...target.position],savedRotation=[...target.rotation],savedRepeat=structuredClone(target.repeat);
   const aim=quat(savedRotation);
   // Existing destination lights win by default. Transfer any lights attached
   // to displaced companion rows into this owner's local frame. Source lights
   // are used when there are no destination lights, or after explicit opt-in.
   const existingLights=[...(target.arrayParts?.lights||[])].map(l=>structuredClone(l));
   for(const companion of companionGroups){
     const id=companion.ids[rootIndex],other=entry.objects.find(o=>o.id===id);
     if(!other)continue;
     for(const originalLight of lightsFor(other)){
       const toLocal=p=>xyz(p).sub(xyz(savedPosition))
         .applyQuaternion(aim.clone().invert()).toArray();
       existingLights.push({...originalLight,position:toLocal(originalLight.position),
         ...(originalLight.target?{target:toLocal(originalLight.target)}:{})});
     }
   }
   const preferredLights=replaceLights||!existingLights.length?sourceLights:existingLights;
   // Never deduplicate authored lights simply because they occupy the same XYZ:
   // two coincident colored lights may be deliberate. No manual-light limit.
   const finalLights=preferredLights.map((l,index)=>({...l,id:'assembly_light_'+index}));
   for(const spec of copies){
     const position=xyz(savedPosition).add(spec.local.clone().applyQuaternion(aim)).toArray();
     const rotation=euler(aim.clone().multiply(spec.relative));
     const shape={
       id:spec.index===0?target.id:unique(naming+'_'+idPart(spec.label)+'_'+spec.index,used),
       name:spec.label,primitive:spec.part.primitive,position,rotation,
       scale:[...spec.part.scale],material:structuredClone(spec.part.material),
       ...(spec.part.points?{points:structuredClone(spec.part.points)}:{}),
       repeat:structuredClone(savedRepeat),
       ...(target.layer?{layer:target.layer}:{})
     };
     if(spec.index===0){
       Object.assign(target,shape);
       delete target.arrayParts;delete target.points;
       if(shape.points)target.points=shape.points;
       if(finalLights.length)target.arrayParts={objects:[],lights:structuredClone(finalLights)};
     }else{
       entry.objects.push(shape);created.push({rootId,targetId:shape.id,partId:spec.part.id});
     }
   }
 }
 if(removed.size)entry.objects=entry.objects.filter(o=>!removed.has(o.id));
 return {document:validatePrimitiveDocument(doc,allowedShots),
   primaryId:dest.id,created,source:sourceTemplate,primaryComponent:primary.id,
   secondaryComponent:secondary.id};
}
// Save the preview after a template operation. Template children are held as
// editable local parts but retained as independent named sibling arrays in
// the persisted scene; additional manual parts stay inside the root group.
export function saveAssemblyTemplateDraft(staged,allowedShots,shotId,rootId,base,parts,mappings){
 const doc=validatePrimitiveDocument(staged,allowedShots);
 const entry=doc.scenes.find(s=>s.shotId===shotId);
 const initial=entry?.objects.find(o=>o.id===rootId&&o.repeat);
 if(!initial)throw Error('Template destination no longer exists');
 const movement=xyz(base.position).sub(xyz(initial.position));
 const turn=quat(base.rotation).multiply(quat(initial.rotation).invert());
 const mapped=new Set(mappings.map(x=>x.partId));
 const extras=parts.objects.filter(part=>!mapped.has(part.id));
 const rows=new Set([rootId,...mappings.map(m=>m.rootId)]);
 for(const id of rows){
   const row=entry.objects.find(o=>o.id===id&&o.repeat);
   if(!row)throw Error('Linked template array row no longer exists');
   row.position=xyz(row.position).add(movement).toArray();
   row.rotation=euler(turn.clone().multiply(quat(row.rotation)));
   row.name=base.name;row.primitive=base.primitive;
   row.scale=[...base.scale];row.material=structuredClone(base.material);
   if(base.points)row.points=structuredClone(base.points);else delete row.points;
   if(extras.length||parts.lights.length)
     row.arrayParts={objects:structuredClone(extras),lights:structuredClone(parts.lights)};
   else delete row.arrayParts;
 }
 for(const map of mappings){
   const row=entry.objects.find(o=>o.id===map.targetId);
   const owner=entry.objects.find(o=>o.id===map.rootId);
   const edit=parts.objects.find(o=>o.id===map.partId);
   if(!row||!owner)throw Error('Template sibling array is missing');
   if(!edit){entry.objects=entry.objects.filter(x=>x.id!==map.targetId);continue;}
   row.name=edit.name;row.primitive=edit.primitive;
   row.position=xyz(edit.position).applyQuaternion(quat(owner.rotation))
     .add(xyz(owner.position)).toArray();
   row.rotation=euler(quat(owner.rotation).multiply(quat(edit.rotation)));
   row.material=structuredClone(edit.material);row.scale=[...edit.scale];
   if(edit.points)row.points=structuredClone(edit.points);else delete row.points;
 }
 return validatePrimitiveDocument(doc,allowedShots);
}


// Single-parent assembly operations. New assemblies do NOT represent every
// component as a separate sibling array. One parent keeps its own XYZ,
// rotation and repeat layout; all geometry and punctual lights are local nodes.
export function editableAssembly(object){
 const base=structuredClone(object);
 const existing=structuredClone(object.arrayParts||{objects:[],lights:[]});
 if(object.primitive==='group')
   return {base,parts:existing};
 const used=new Set([...existing.objects.map(p=>p.id),
   ...existing.lights.map(p=>p.id)]);
 const id=unique('source_mesh',used);
 const rootMesh={
   id,name:object.name,primitive:object.primitive,
   position:[0,0,0],rotation:[0,0,0],scale:[...object.scale],
   material:structuredClone(object.material),
   ...(object.points?{points:structuredClone(object.points)}:{})
 };
 const objects=[rootMesh,...existing.objects];
 const lights=existing.lights;
 const order=['object:'+id,...(existing.order||
   [...existing.objects.map(p=>'object:'+p.id),
     ...lights.map(p=>'light:'+p.id)])];
 const prefix=object.name.trim().split(/\s+/).slice(0,2).join(' ');
 return {base:{...base,name:prefix,primitive:'group',scale:[1,1,1],
     material:{color:'#888888',metalness:0,roughness:1}},
   parts:{objects,lights,order}};
}
const childKey=(id,used)=>{
 let key=idPart(id).slice(0,48)||'part',suffix=2;
 while(used.has(key))key=idPart(id).slice(0,44)+'_'+suffix++;
 used.add(key);return key;
};
const parentPrefix=name=>String(name||'').trim().split(/\s+/).slice(0,2).join(' ');

// Build all children with transforms relative to the SOURCE PARENT.
// The destination parent rotation and XYZ remain untouched. There is no
// arbitrary "primary" mesh, second-role dependency, or light checkbox.
export function replaceAssemblyContents(source,allowedShots,shotId,destinationId,templateId){
 const doc=validatePrimitiveDocument(source,allowedShots);
 const entry=doc.scenes.find(sc=>sc.shotId===shotId);
 const destination=entry?.objects.find(o=>o.id===destinationId&&(o.repeat||o.arrayParts));
 if(!destination)throw Error('Selected destination assembly no longer exists');
 const template=listAssemblyTemplates(doc,shotId).find(t=>t.id===templateId);
 if(!template)throw Error('Selected source assembly no longer exists');
 const sourceRoot=entry.objects.find(o=>o.id===templateId);
 if(!sourceRoot)throw Error('Source assembly parent no longer exists');
 const roots=destination.repeat?findMatchingArrays(doc,shotId,destinationId):[destinationId];
 if(!roots.length)throw Error('No matching destination array roots remain');
 const owned=destination.repeat?findArrayCompanions(doc,shotId,destinationId,
   {includeComposites:true}).filter(c=>c.nameMatch):[];
 const sourceIds=new Set(template.rootIds);
 const removed=new Set(owned.flatMap(c=>c.ids).filter(id=>
   !roots.includes(id)&&!sourceIds.has(id)));
 const prefix=parentPrefix(destination.name);
 const inverse=quat(sourceRoot.rotation).invert();
 const local=p=>xyz(p).sub(xyz(sourceRoot.position))
   .applyQuaternion(inverse).toArray();
 const localRotation=p=>euler(inverse.clone().multiply(quat(p)));
 const used=new Set(),objects=[],lights=[],order=[];
 for(const part of template.parts){
   const id=childKey(part.id,used);
   const suffix=assemblyDescriptor(part.name,template.prefix);
   objects.push({
     id,name:(prefix+' '+suffix).slice(0,100),
     primitive:part.primitive,position:local(part.position),
     rotation:localRotation(part.rotation),
     scale:[...part.scale],material:structuredClone(part.material),
     ...(part.points?{points:structuredClone(part.points)}:{})
   });
   order.push('object:'+id);
 }
 for(const part of template.lights){
   const id=childKey(part.id,used);
   const suffix=assemblyDescriptor(part.name,template.prefix);
   lights.push({...structuredClone(part),id,name:(prefix+' '+suffix).slice(0,100),
     position:local(part.position),
     ...(part.target?{target:local(part.target)}:{})});
   order.push('light:'+id);
 }
 if(!objects.length&&!lights.length)throw Error('Source assembly has no components');
 for(const rootId of roots){
   const row=entry.objects.find(o=>o.id===rootId);
   if(!row)throw Error('Linked array parent disappeared');
   row.primitive='group';row.name=prefix;row.scale=[1,1,1];
   row.material={color:'#888888',metalness:0,roughness:1};
   delete row.points;
   row.arrayParts={objects:structuredClone(objects),lights:structuredClone(lights),
     order:[...order]};
 }
 if(removed.size)entry.objects=entry.objects.filter(o=>!removed.has(o.id));
 return {document:validatePrimitiveDocument(doc,allowedShots),rootIds:roots,
   removedIds:[...removed],componentCount:order.length,template};
}

// Commit all editable children to one array parent, propagating shape edits
// to all linked parent rows while preserving each row's own layout.
export function saveAssemblyHierarchy(source,allowedShots,shotId,objectId,
 {base,parts},linkedIds=null,absorbedIds=[]){
 const doc=validatePrimitiveDocument(source,allowedShots);
 const entry=doc.scenes.find(s=>s.shotId===shotId);
 const original=entry?.objects.find(o=>o.id===objectId);
 if(!original)throw Error('Assembly parent was removed; reopen the editor');
 const eligible=original.repeat?findMatchingArrays(doc,shotId,objectId):[objectId];
 const ids=linkedIds||eligible;
 if(!Array.isArray(ids)||!ids.includes(objectId)||
   ids.some(id=>!eligible.includes(id)))throw Error('Linked assembly rows changed');
 if(base.primitive!=='group')throw Error('Assembly must have a group parent');
 const shift=xyz(base.position).sub(xyz(original.position));
 const turn=quat(base.rotation).multiply(quat(original.rotation).invert());
 const consumed=new Set(absorbedIds);
 if(consumed.size!==absorbedIds.length||[...consumed].some(id=>
   ids.includes(id)||!entry.objects.some(o=>o.id===id)))
   throw Error('Invalid companion to absorb');
 // Preview transforms are already parent-local; object and light types use
 // one validated hierarchy rather than independent top-level rows.
 for(const id of ids){
   const row=entry.objects.find(o=>o.id===id);
   row.position=xyz(row.position).add(shift).toArray();
   row.rotation=euler(turn.clone().multiply(quat(row.rotation)));
   row.name=base.name;row.primitive='group';row.scale=[1,1,1];
   row.material={color:'#888888',metalness:0,roughness:1};
   delete row.points;
   row.arrayParts=structuredClone(parts);
 }
 if(consumed.size)entry.objects=entry.objects.filter(o=>!consumed.has(o.id));
 return validatePrimitiveDocument(doc,allowedShots);
}
