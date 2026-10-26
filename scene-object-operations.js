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
  // Rotating an array rotates each individual copy in place, leaving the
  // array center, layout axes, repeat counts and spacing untouched.
  const key=mode==='translate'?'position':item.repeat?'instanceRotation':'rotation';
  item[key]=[...vector];
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

// Convert an existing object or composite single-object group into an editable
// centered repeat. Existing XYZ remains the array center; child parts remain
// local to each copy. Editing an existing repeat changes only its distribution.
export function setSceneObjectRepeat(source,allowedShots,shotId,objectId,count,spacing){
 const doc=validatePrimitiveDocument(source,allowedShots);
 const object=doc.scenes.find(s=>s.shotId===shotId)?.objects.find(o=>o.id===objectId);
 if(!object)throw Error('Selected scene object no longer exists');
 if(!Array.isArray(count)||count.length!==3||
    count.some(x=>!Number.isInteger(x)||x<1||x>100))
    throw Error('Copy counts must be integers between 1 and 100');
 if(!Array.isArray(spacing)||spacing.length!==3||
    spacing.some(x=>typeof x!=='number'||!Number.isFinite(x)||Math.abs(x)>1000))
    throw Error('XYZ spacing must be finite and within ±1000');
 if(count.every(x=>x===1))throw Error('Choose at least two copies on one axis');
 if(count.some((n,i)=>n>1&&spacing[i]===0))
    throw Error('Each repeated axis must have nonzero spacing');
 object.repeat={count:[...count],spacing:[...spacing]};
 return validatePrimitiveDocument(doc,allowedShots);
}
