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
const partsFor=root=>[component(root),
 ...(root.arrayParts?.objects||[]).map(part=>component(root,part))];
export function listAssemblyTemplates(source,shotId){
 const doc=validatePrimitiveDocument(source);
 const entry=doc.scenes.find(s=>s.shotId===shotId);
 if(!entry)return [];
 const out=[],seen=new Set(),byName=new Map();
 // The exterior contains hundreds of unrelated repeated arrays. Avoid
 // geometry comparisons for names that cannot possibly form an assembly.
 for(const item of entry.objects.filter(x=>x.repeat)){
   const key=arrayGroupKey(item.name);
   if(!key)continue;
   if(!byName.has(key))byName.set(key,[]);
   byName.get(key).push(item);
 }
 for(const [key,roots] of byName){
   if(roots.length<2&&!roots.some(x=>x.arrayParts?.objects?.length))continue;
   // Match once per named family, not once per repeated object in the scene.
   for(const base of roots.slice(0,1)){
   const others=findArrayCompanions(doc,shotId,base.id).filter(x=>x.nameMatch);
   const ids=[base.id,...others.map(c=>c.id)];
   const assembled=ids.map(id=>entry.objects.find(x=>x.id===id));
   const components=assembled.flatMap(partsFor);
   if(components.length<2)continue;
   const signature=[...ids].sort().join('|');
   if(seen.has(signature))continue;
   seen.add(signature);
   const prefix=base.name.trim().split(/\s+/).slice(0,2).join(' ');
   const labels=components.map(c=>c.name.split(/\s+/).at(-1)).join(' + ');
   out.push({id:base.id,key,label:prefix+' — '+labels,
     parts:components,rootIds:ids});
   }
 }
 return out.sort((a,b)=>a.label.localeCompare(b.label));
}
// Copies another assembly's primitive shapes while keeping the *destination*
// distribution: XYZ center, rotation, count, spacing and per-scene layer.
// New components are real sibling arrays named after the destination prefix,
// not a mutation of the source's prototypes or locations.
export function replaceArrayAssembly(source,allowedShots,shotId,destinationId,templateId,primaryId,secondaryId){
 const doc=validatePrimitiveDocument(source,allowedShots);
 const entry=doc.scenes.find(s=>s.shotId===shotId);
 const dest=entry?.objects.find(o=>o.id===destinationId&&o.repeat);
 if(!dest)throw Error('Destination must be an existing repeated object');
 const sourceTemplate=listAssemblyTemplates(doc,shotId).find(t=>t.id===templateId);
 if(!sourceTemplate)throw Error('Source assembly has changed; reopen the template list');
 const primary=sourceTemplate.parts.find(p=>p.id===primaryId);
 const secondary=sourceTemplate.parts.find(p=>p.id===secondaryId);
 if(!primary||!secondary||primary.id===secondary.id)
   throw Error('Choose distinct primary and supporting components');
 const naming=dest.name.trim().split(/\s+/).slice(0,2).join(' ');
 if(!arrayGroupKey(dest.name))throw Error('Destination needs a two-word group name');
 const roots=findMatchingArrays(doc,shotId,dest.id);
 // Do not absorb unrelated array definitions just because their names match.
 const oldCompanions=findArrayCompanions(doc,shotId,dest.id)
   .filter(c=>c.nameMatch).flatMap(c=>c.ids);
 const removed=new Set(oldCompanions.filter(id=>!roots.includes(id)));
 const used=new Set(entry.objects.map(o=>o.id));
 const members=[primary,...sourceTemplate.parts.filter(p=>p.id!==primary.id)];
 const primaryQuat=quat(primary.rotation);
 const copies=members.map((part,index)=>{
   const local=xyz(part.position).sub(xyz(primary.position))
     .applyQuaternion(primaryQuat.clone().invert());
   const relative=primaryQuat.clone().invert().multiply(quat(part.rotation));
   const role=part.name.trim().split(/\s+/).at(-1);
   const label=naming+' '+role;
   return {part,index,local,relative,label};
 });
 const created=[];
 for(const rootId of roots){
   const target=entry.objects.find(o=>o.id===rootId);
   const savedPosition=[...target.position],savedRotation=[...target.rotation],savedRepeat=structuredClone(target.repeat);
   const aim=quat(savedRotation);
   for(const spec of copies){
     const position=xyz(savedPosition).add(spec.local.clone().applyQuaternion(aim)).toArray();
     const rotation=euler(aim.clone().multiply(spec.relative));
     const shape={
       id:spec.index===0?target.id:unique(naming+'_'+spec.label.split(' ').at(-1),used),
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
 const root=entry?.objects.find(o=>o.id===rootId&&o.repeat);
 if(!root)throw Error('Template destination no longer exists');
 const q=quat(base.rotation);
 const mapped=new Set(mappings.map(x=>x.partId));
 for(const map of mappings){
   const row=entry.objects.find(o=>o.id===map.targetId);
   const edit=parts.objects.find(o=>o.id===map.partId);
   if(!row)throw Error('Template sibling array is missing');
   if(!edit){entry.objects=entry.objects.filter(x=>x.id!==map.targetId);continue;}
   row.name=edit.name;row.primitive=edit.primitive;
   row.position=xyz(edit.position).applyQuaternion(q).add(xyz(base.position)).toArray();
   row.rotation=euler(q.clone().multiply(quat(edit.rotation)));
   row.material=structuredClone(edit.material);row.scale=[...edit.scale];
   if(edit.points)row.points=structuredClone(edit.points);else delete row.points;
 }
 const extra=parts.objects.filter(part=>!mapped.has(part.id));
 Object.assign(root,{name:base.name,primitive:base.primitive,position:[...base.position],
   rotation:[...base.rotation],scale:[...base.scale],material:structuredClone(base.material)});
 if(base.points)root.points=structuredClone(base.points);else delete root.points;
 if(extra.length||parts.lights.length)root.arrayParts={objects:extra,lights:parts.lights};
 else delete root.arrayParts;
 return validatePrimitiveDocument(doc,allowedShots);
}
