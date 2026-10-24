import {validatePrimitiveDocument} from './primitive-schema.js';

// Pure document edits. Three.js gizmos are temporary view controls; they
// cannot bypass the same schema and scene caps as the numeric inspector.
export function editPrimitiveTransform(source,allowedShots,shotId,objectId,mode,vector){
  if(!['translate','rotate'].includes(mode))throw Error('Unsupported transform operation');
  if(!Array.isArray(vector)||vector.length!==3||vector.some(v=>typeof v!=='number'||!Number.isFinite(v)))
    throw Error('Transform must contain three finite coordinates');
  const doc=validatePrimitiveDocument(source,allowedShots);
  const scene=doc.scenes.find(s=>s.shotId===shotId);
  const item=scene?.objects.find(o=>o.id===objectId);
  if(!item)throw Error('Selected primitive no longer exists in this chapter');
  item[mode==='translate'?'position':'rotation']=[...vector];
  return validatePrimitiveDocument(doc,allowedShots);
}
export function deletePrimitiveObject(source,allowedShots,shotId,objectId){
  const doc=validatePrimitiveDocument(source,allowedShots);
  const entry=doc.scenes.find(s=>s.shotId===shotId);
  if(!entry||!entry.objects.some(o=>o.id===objectId))
    throw Error('Selected primitive no longer exists in this chapter');
  entry.objects=entry.objects.filter(o=>o.id!==objectId);
  return validatePrimitiveDocument(doc,allowedShots);
}

export function editLightTransform(source,allowedShots,shotId,lightId,position){
 if(!Array.isArray(position)||position.length!==3||
   position.some(v=>typeof v!=='number'||!Number.isFinite(v)))
   throw Error('Light position must contain three finite coordinates');
 const doc=validatePrimitiveDocument(source,allowedShots);
 const light=doc.scenes.find(s=>s.shotId===shotId)?.lights?.find(l=>l.id===lightId);
 if(!light)throw Error('Selected light no longer exists in this chapter');
 light.position=[...position];
 return validatePrimitiveDocument(doc,allowedShots);
}
export function deleteLightObject(source,allowedShots,shotId,lightId){
 const doc=validatePrimitiveDocument(source,allowedShots);
 const entry=doc.scenes.find(s=>s.shotId===shotId);
 if(!entry?.lights?.some(x=>x.id===lightId))
   throw Error('Selected light no longer exists in this chapter');
 entry.lights=entry.lights.filter(x=>x.id!==lightId);
 return validatePrimitiveDocument(doc,allowedShots);
}
