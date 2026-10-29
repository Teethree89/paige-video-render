import * as THREE from 'three';
import {validatePrimitiveDocument,repeatOffsets} from './primitive-schema.js';

// Consolidate selected scene primitives and optional standalone lights into
// ONE editable parent with local components, preserving existing world poses.
const v=xyz=>new THREE.Vector3(...xyz);
const quat=angles=>new THREE.Quaternion().setFromEuler(new THREE.Euler(...angles));
const angles=q=>new THREE.Euler().setFromQuaternion(q,'XYZ').toArray().slice(0,3).map(n=>n===0?0:n);
const unique=(prefix,taken)=>{
  let base=String(prefix||'part').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,46);
  if(!/^[a-zA-Z0-9]/.test(base))base='part_'+base;
  let id=base,n=2;
  while(taken.has(id))id=base+'_'+n++;
  taken.add(id);return id;
};
export function groupSceneSelection(source,allowedShots,shotId,selectedIds,name='New Object Group'){
 const doc=validatePrimitiveDocument(source,allowedShots);
 const chapter=doc.scenes.find(sc=>sc.shotId===shotId);
 if(!chapter)throw Error('This chapter has no editable objects');
 const ids=[...new Set(selectedIds)].map(id=>id.startsWith('light-target::')?
   'light::'+id.slice(14):id);
 if(ids.length<2)throw Error('Select at least two objects or lights to group.');
 const objects=ids.filter(id=>!id.startsWith('light::'))
   .map(id=>chapter.objects.find(o=>o.id===id));
 const lights=ids.filter(id=>id.startsWith('light::'))
   .map(id=>(chapter.lights||[]).find(l=>l.id===id.slice(7)));
 if(objects.some(x=>!x)||lights.some(x=>!x))throw Error('One of the selected items no longer exists.');
 const center=new THREE.Vector3();
 for(const item of [...objects,...lights])center.add(v(item.position));
 center.divideScalar(objects.length+lights.length);
 const used=new Set(),children=[],bulbs=[],order=[];
 const addObject=(item,point,rotation)=>{
   const part=structuredClone(item);
   part.id=unique(item.id,used);part.position=point.clone().sub(center).toArray();
   part.rotation=angles(rotation);
   delete part.layer;delete part.repeat;delete part.instanceRotation;
   delete part.arrayParts;delete part.source;delete part.editorModified;
   children.push(part);order.push('object:'+part.id);
 };
 const addLight=(light,point,target)=>{
   const part=structuredClone(light);part.id=unique(light.id||'light',used);
   part.position=point.clone().sub(center).toArray();
   if(target)part.target=target.clone().sub(center).toArray();
   delete part.source;delete part.editorModified;
   bulbs.push(part);order.push('light:'+part.id);
 };
 for(const obj of objects){
   const rootRotation=quat(obj.rotation);
   const copyRotation=quat(obj.instanceRotation||[0,0,0]);
   for(const offset of repeatOffsets(obj.repeat)){
     const copyPos=v(obj.position).add(v(offset).applyQuaternion(rootRotation));
     const q=rootRotation.clone().multiply(copyRotation);
     if(obj.primitive==='group'){
       for(const part of obj.arrayParts?.objects||[]){
         addObject(part,v(part.position).applyQuaternion(q).add(copyPos),
           q.clone().multiply(quat(part.rotation)));
       }
       for(const part of obj.arrayParts?.lights||[]){
         const worldPoint=p=>v(p).applyQuaternion(q).add(copyPos);
         addLight(part,worldPoint(part.position),
           part.target?worldPoint(part.target):null);
       }
     }else{
       addObject(obj,copyPos,q);
       for(const part of obj.arrayParts?.objects||[]){
         addObject(part,v(part.position).applyQuaternion(q).add(copyPos),
           q.clone().multiply(quat(part.rotation)));
       }
       for(const part of obj.arrayParts?.lights||[]){
         const worldPoint=p=>v(p).applyQuaternion(q).add(copyPos);
         addLight(part,worldPoint(part.position),
           part.target?worldPoint(part.target):null);
       }
     }
   }
 }
 for(const light of lights)addLight(light,v(light.position),light.target?v(light.target):null);
 if(!children.length&&!bulbs.length)throw Error('Nothing renderable was selected.');
 const taken=new Set(chapter.objects.map(o=>o.id));
 const id=unique('group_'+name,taken);
 const layer=objects.length&&objects.every(o=>o.layer===objects[0].layer)?
   objects[0].layer:null;
 const parent={id,name:String(name).slice(0,100)||'Object Group',primitive:'group',
   position:center.toArray(),rotation:[0,0,0],scale:[1,1,1],
   material:{color:'#888888',metalness:0,roughness:1},
   ...(layer?{layer}:{}),source:'editor',
   arrayParts:{objects:children,lights:bulbs,order}};
 const removedObjects=new Set(objects.map(o=>o.id)),removedLights=new Set(lights.map(l=>l.id));
 chapter.objects=chapter.objects.filter(o=>!removedObjects.has(o.id));
 chapter.objects.push(parent);
 if(removedLights.size)chapter.lights=(chapter.lights||[]).filter(l=>!removedLights.has(l.id));
 return {document:validatePrimitiveDocument(doc,allowedShots),selectedId:id,
   objectCount:children.length,lightCount:bulbs.length};
}
