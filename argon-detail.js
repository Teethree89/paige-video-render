import {LIMITS,validatePrimitiveDocument,ENVIRONMENT_LAYERS} from './primitive-schema.js';

const count=item=>item.repeat?item.repeat.count.reduce((a,b)=>a*b,1):1;
const rounded=vec=>vec.map(n=>Math.round(n*1000)/1000);
// Data-only, bounded spatial reference for Argon; not an editable document,
// raw model output, prompt, instruction or hidden video metadata.
export function argonDetailIndex(doc){
  const objects=doc?.scenes?.[0]?.objects||[];
  if(objects.length===0||objects.length>=LIMITS.objectsPerScene)
    return [];
  return objects.map(o=>({id:o.id,name:o.name||o.id,
    layer:ENVIRONMENT_LAYERS.includes(o.layer)?o.layer:'structures',
    primitive:o.primitive,position:rounded(o.position),scale:rounded(o.scale)}));
}
// Add, never replace. Preserve base camera/lights, discard duplicate ids,
// identical model geometry, and any part exceeding the shared object/copy caps.
export function appendArgonDetail(base,addition,shotId){
  const before=validatePrimitiveDocument(base,[shotId]);
  const next=validatePrimitiveDocument(addition,[shotId]);
  if(before.scenes.length!==1||next.scenes.length!==1||
    before.scenes[0].shotId!==shotId||next.scenes[0].shotId!==shotId)
    throw Error('Detail geometry belongs to a different chapter');
  const original=before.scenes[0],extras=next.scenes[0].objects;
  const ids=new Set(original.objects.map(o=>o.id));
  const signature=o=>JSON.stringify([o.primitive,o.layer,o.position,o.rotation,o.scale,o.repeat||null]);
  const shapes=new Set(original.objects.map(signature));
  let copies=original.objects.reduce((sum,o)=>sum+count(o),0);
  const added=[];
  for(const object of extras){
    const shape=signature(object),instances=count(object);
    if(ids.has(object.id)||shapes.has(shape)||original.objects.length+added.length>=LIMITS.objectsPerScene||
      copies+instances>LIMITS.instancesPerScene)continue;
    ids.add(object.id);shapes.add(shape);copies+=instances;added.push(object);
  }
  const document={schemaVersion:1,scenes:[{...original,objects:[...original.objects,...added]}]};
  return {document:validatePrimitiveDocument(document,[shotId]),added:added.length,rendered:copies};
}
