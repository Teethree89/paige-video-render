import {validatePrimitiveDocument} from './primitive-schema.js';

// A repeated object is one authorable prototype. Other repeat groups in the
// same chapter join the edit only when their name, primitive and dimensions
// match exactly. This prevents applying edits to unrelated similar props.
export function findMatchingArrays(source,shotId,objectId){
 const doc=validatePrimitiveDocument(source);
 const entry=doc.scenes.find(s=>s.shotId===shotId);
 const base=entry?.objects.find(o=>o.id===objectId&&o.repeat);
 if(!base)return [];
 return entry.objects.filter(o=>o.repeat&&o.name===base.name&&
   o.primitive===base.primitive&&o.scale.every((n,i)=>n===base.scale[i]))
   .map(o=>o.id);
}

// A single transactional write: no scene mutation until the user explicitly
// saves the prototype. Each linked group's center, orientation, count and
// spacing are retained, while its mesh appearance and attached parts match.
export function saveArrayPrototype(source,allowedShots,shotId,objectId,
  {name,material,scale,parts},linkedIds=null){
 const doc=validatePrimitiveDocument(source,allowedShots);
 const entry=doc.scenes.find(s=>s.shotId===shotId);
 const base=entry?.objects.find(o=>o.id===objectId&&o.repeat);
 if(!base)throw Error('Selected repeat array no longer exists');
 const eligible=findMatchingArrays(doc,shotId,objectId);
 const ids=linkedIds||eligible;
 if(!Array.isArray(ids)||!ids.includes(objectId)||ids.some(id=>!eligible.includes(id)))
   throw Error('Linked arrays changed; reopen the prototype editor');
 for(const id of ids){
   const target=entry.objects.find(o=>o.id===id);
   target.name=name;
   target.material=structuredClone(material);
   target.scale=[...scale];
   if(parts.objects.length||parts.lights.length)
     target.arrayParts=structuredClone(parts);
   else delete target.arrayParts;
 }
 return validatePrimitiveDocument(doc,allowedShots);
}
