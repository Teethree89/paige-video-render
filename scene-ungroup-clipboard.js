import * as THREE from 'three';
import {validatePrimitiveDocument,repeatOffsets} from './primitive-schema.js';

// Pure document edits: ungroup an editable assembly into top-level shapes, and
// copy/paste shapes + lights between chapters through a plain-data clipboard.
const v=xyz=>new THREE.Vector3(...xyz);
const quat=angles=>new THREE.Quaternion().setFromEuler(new THREE.Euler(...angles));
const angles=q=>new THREE.Euler().setFromQuaternion(q,'XYZ').toArray().slice(0,3).map(n=>n===0?0:n);
const uniqueId=(base,taken)=>{
  base=String(base||'part').slice(0,58);
  let id=base,n=2;
  while(taken.has(id))id=(base+'_'+n++).slice(0,64);
  taken.add(id);return id;
};
const lightKey=id=>id?.startsWith('light-target::')?id.slice(14):id?.startsWith('light::')?id.slice(7):null;

/** Replace each selected group/assembly with its parts at their current world poses. */
export function ungroupSceneSelection(source,allowedShots,shotId,selectedIds){
 const doc=validatePrimitiveDocument(source,allowedShots);
 const chapter=doc.scenes.find(sc=>sc.shotId===shotId);
 if(!chapter)throw Error('This chapter has no editable objects');
 const targets=[...new Set(selectedIds)].map(id=>chapter.objects.find(o=>o.id===id))
   .filter(o=>o?.arrayParts&&(o.arrayParts.objects?.length||o.arrayParts.lights?.length));
 if(!targets.length)throw Error('Select a group or assembly to ungroup.');
 const removed=new Set(targets.map(o=>o.id));
 const objTaken=new Set(chapter.objects.filter(o=>!removed.has(o.id)).map(o=>o.id));
 const lightTaken=new Set((chapter.lights||[]).map(l=>l.id));
 const objects=[],lights=[],ids=[];
 for(const group of targets){
   const rootQ=quat(group.rotation),copyQ=quat(group.instanceRotation||[0,0,0]);
   const scale=v(group.scale||[1,1,1]);
   for(const offset of repeatOffsets(group.repeat)){
     const origin=v(group.position).add(v(offset).applyQuaternion(rootQ));
     const q=rootQ.clone().multiply(copyQ);
     const world=p=>v(p).multiply(scale).applyQuaternion(q).add(origin);
     if(group.primitive!=='group'&&offset.every(n=>n===0)&&!group.repeat){
       const root=structuredClone(group);delete root.arrayParts;
       objects.push(root);objTaken.add(root.id);ids.push(root.id);
     }
     for(const part of group.arrayParts.objects||[]){
       const copy=structuredClone(part);
       copy.id=uniqueId(part.id,objTaken);
       copy.position=world(part.position).toArray();
       copy.rotation=angles(q.clone().multiply(quat(part.rotation)));
       copy.scale=v(part.scale||[1,1,1]).multiply(scale).toArray();
       if(group.layer&&!copy.layer)copy.layer=group.layer;
       copy.source='editor';
       objects.push(copy);ids.push(copy.id);
     }
     for(const part of group.arrayParts.lights||[]){
       const copy=structuredClone(part);
       copy.id=uniqueId(part.id||'light',lightTaken);
       copy.position=world(part.position).toArray();
       if(part.target)copy.target=world(part.target).toArray();
       copy.source='editor';
       lights.push(copy);ids.push('light::'+copy.id);
     }
   }
 }
 chapter.objects=chapter.objects.filter(o=>!removed.has(o.id)).concat(objects);
 if(lights.length)chapter.lights=[...(chapter.lights||[]),...lights];
 return {document:validatePrimitiveDocument(doc,allowedShots),selectedIds:ids};
}

/** Snapshot the selected shapes/lights as plain data that can be pasted in any chapter. */
export function copySceneSelection(source,allowedShots,shotId,selectedIds){
 const doc=validatePrimitiveDocument(source,allowedShots);
 const chapter=doc.scenes.find(sc=>sc.shotId===shotId);
 if(!chapter)throw Error('Selected chapter no longer exists');
 const keys=[...new Set(selectedIds)];
 const objects=keys.filter(id=>!lightKey(id)).map(id=>chapter.objects.find(o=>o.id===id));
 const lights=[...new Set(keys.filter(lightKey).map(lightKey))]
   .map(id=>(chapter.lights||[]).find(l=>l.id===id));
 if(objects.some(x=>!x)||lights.some(x=>!x))throw Error('One of the selected items no longer exists.');
 if(!objects.length&&!lights.length)throw Error('Select something to copy.');
 return {shotId,objects:structuredClone(objects),lights:structuredClone(lights)};
}

/** Paste a clipboard into any chapter with fresh ids. Same-chapter pastes are nudged. */
export function pasteSceneClipboard(source,allowedShots,shotId,clipboard){
 if(!clipboard||(!clipboard.objects?.length&&!clipboard.lights?.length))
   throw Error('Nothing copied yet.');
 const doc=validatePrimitiveDocument(source,allowedShots);
 const chapter=doc.scenes.find(sc=>sc.shotId===shotId);
 if(!chapter)throw Error('This chapter has no editable objects');
 const offset=clipboard.shotId===shotId?1.5:0;
 const shift=p=>[p[0]+offset,p[1],p[2]];
 const objTaken=new Set(chapter.objects.map(o=>o.id));
 chapter.lights??=[];
 const lightTaken=new Set(chapter.lights.map(l=>l.id));
 const ids=[];
 for(const item of structuredClone(clipboard.objects||[])){
   item.id=uniqueId(offset?item.id+'_copy':item.id,objTaken);
   item.position=shift(item.position);
   delete item.editorModified;item.source='editor';
   chapter.objects.push(item);ids.push(item.id);
 }
 for(const item of structuredClone(clipboard.lights||[])){
   item.id=uniqueId(offset?item.id+'_copy':item.id,lightTaken);
   item.position=shift(item.position);
   if(item.target)item.target=shift(item.target);
   delete item.editorModified;item.source='editor';
   chapter.lights.push(item);ids.push('light::'+item.id);
 }
 return {document:validatePrimitiveDocument(doc,allowedShots),selectedIds:ids};
}
