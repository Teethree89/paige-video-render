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
export function editLightTarget(source,allowedShots,shotId,lightId,target){
 if(!Array.isArray(target)||target.length!==3||
   target.some(v=>typeof v!=='number'||!Number.isFinite(v)))
   throw Error('Light target must contain three finite coordinates');
 const doc=validatePrimitiveDocument(source,allowedShots);
 const light=doc.scenes.find(s=>s.shotId===shotId)?.lights?.find(l=>l.id===lightId);
 if(!light||light.type==='point')throw Error('Selected aimed light no longer exists in this chapter');
 light.target=[...target];
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

/** Duplicate a selected scene primitive or light without touching its original.
 * The new entry remains editable through the existing inspector/gizmo path.
 * Repeated prototypes retain their child shapes, lights and repeat layout. */
export function duplicateSceneSelection(source,allowedShots,shotId,selectedId){
 const doc=validatePrimitiveDocument(source,allowedShots);
 const entry=doc.scenes.find(s=>s.shotId===shotId);
 if(!entry)throw Error('Selected chapter no longer exists');
 const isLight=selectedId.startsWith('light::')||selectedId.startsWith('light-target::');
 const id=selectedId.replace(/^light(?::|\-target:):/,'');
 const list=isLight?(entry.lights||[]):entry.objects;
 const item=list.find(x=>x.id===id);
 if(!item)throw Error('Selected object no longer exists');
 const taken=new Set(list.map(x=>x.id));
 const prefix=(id+'_copy').slice(0,58);
 let copyId=prefix,index=2;
 while(taken.has(copyId))copyId=(prefix+'_'+index++).slice(0,64);
 const copy=structuredClone(item);
 copy.id=copyId;
 copy.name=(item.name+' copy').slice(0,100);
 const offset=isLight?1.5:Math.min(10,Math.max(1.5,item.scale[0]*.5));
 copy.position=[item.position[0]+offset,item.position[1],item.position[2]];
 if(isLight&&copy.target)copy.target=[copy.target[0]+offset,copy.target[1],copy.target[2]];
 list.push(copy);
 return {document:validatePrimitiveDocument(doc,allowedShots),
   selectedId:(isLight?'light::':'')+copyId};
}
