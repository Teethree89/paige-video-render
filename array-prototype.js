import {validatePrimitiveDocument,repeatOffsets} from './primitive-schema.js';

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
  {name,material,scale,parts},linkedIds=null,absorbedIds=[]){
 const doc=validatePrimitiveDocument(source,allowedShots);
 const entry=doc.scenes.find(s=>s.shotId===shotId);
 const base=entry?.objects.find(o=>o.id===objectId&&o.repeat);
 if(!base)throw Error('Selected repeat array no longer exists');
 const eligible=findMatchingArrays(doc,shotId,objectId);
 const ids=linkedIds||eligible;
 if(!Array.isArray(ids)||!ids.includes(objectId)||ids.some(id=>!eligible.includes(id)))
   throw Error('Linked arrays changed; reopen the prototype editor');
 const absorbed=new Set(absorbedIds);
 if(absorbed.size!==absorbedIds.length||[...absorbed].some(id=>
   ids.includes(id)||!entry.objects.some(o=>o.id===id&&o.repeat)))
   throw Error('Companion arrays changed; reopen the prototype editor');
 for(const id of ids){
   const target=entry.objects.find(o=>o.id===id);
   target.name=name;
   target.material=structuredClone(material);
   target.scale=[...scale];
   if(parts.objects.length||parts.lights.length)
     target.arrayParts=structuredClone(parts);
   else delete target.arrayParts;
 }
 if(absorbed.size)entry.objects=entry.objects.filter(o=>!absorbed.has(o.id));
 return validatePrimitiveDocument(doc,allowedShots);
}

// Spatially aligned, independently authored arrays can be folded into one
// repeated prototype. This is opt-in: proximity only suggests companions.
// Do not merge arrays if even one repeated instance would shift, or if a
// matching streetlight on another row does not have the same local assembly.
const quat=e=>{
 const [x,y,z]=e.map(v=>Math.sin(v/2)),[a,b,c]=e.map(v=>Math.cos(v/2));
 return [x*b*c+a*y*z,a*y*c-x*b*z,a*b*z+x*y*c,a*b*c-x*y*z];
};
const inverse=q=>[-q[0],-q[1],-q[2],q[3]];
const multiply=(a,b)=>[
 a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],
 a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
 a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],
 a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
const rotate=(q,v)=>{
 const p=multiply(multiply(q,[...v,0]),inverse(q));
 return p.slice(0,3);
};
const subtract=(a,b)=>a.map((v,i)=>v-b[i]);
const plus=(a,b)=>a.map((v,i)=>v+b[i]);
const distance=(a,b)=>Math.hypot(...subtract(a,b));
const toEuler=q=>{
 const [x,y,z,w]=q;
 const m13=2*(x*z+y*w),m23=2*(y*z-x*w),m33=1-2*(x*x+y*y);
 const m12=2*(x*y-z*w),m11=1-2*(y*y+z*z);
 const m32=2*(y*z+x*w),m22=1-2*(x*x+z*z);
 return Math.abs(m13)<.9999999?
   [Math.atan2(-m23,m33),Math.asin(Math.max(-1,Math.min(1,m13))),Math.atan2(-m12,m11)]:
   [Math.atan2(m32,m22),Math.asin(Math.max(-1,Math.min(1,m13))),0];
};
const points=o=>{
 const q=quat(o.rotation);
 return repeatOffsets(o.repeat).map(offset=>plus(o.position,rotate(q,offset)));
};
const relative=(base,other)=>{
 if(!base.repeat||!other.repeat)return null;
 const bp=points(base),cp=points(other);
 if(bp.length!==cp.length||bp.length<2)return null;
 // The component must occupy a constant displacement from every prototype.
 // Reversed / reordered repeats cannot safely be collapsed with this layout.
 const q=quat(base.rotation),cq=quat(other.rotation);
 const local=rotate(inverse(q),subtract(cp[0],bp[0]));
 if(distance(local,[0,0,0])>6)return null;
 for(let i=1;i<bp.length;i++)
   if(distance(rotate(inverse(q),subtract(cp[i],bp[i])),local)>.08)return null;
 const orientation=multiply(inverse(q),cq);
 return {position:local,rotation:toEuler(orientation),quaternion:orientation};
};
const sameRelative=(a,b)=>distance(a.position,b.position)<.08&&
 Math.abs(Math.abs(a.quaternion.reduce((v,n,i)=>v+n*b.quaternion[i],0))-1)<.0001;

// Return only companions with a one-to-one, compatible array beside EVERY
// matching source row. Candidate selection is explicit in the mini editor.
export function findArrayCompanions(source,shotId,objectId){
 const doc=validatePrimitiveDocument(source);
 const entry=doc.scenes.find(s=>s.shotId===shotId);
 const base=entry?.objects.find(o=>o.id===objectId&&o.repeat);
 if(!base)return [];
 const roots=findMatchingArrays(doc,shotId,objectId);
 const rootSet=new Set(roots);
 const all=entry.objects;
 const result=[],used=new Set(roots);
 for(const other of all){
   if(!other.repeat||used.has(other.id)||other.arrayParts?.objects.length||
     other.arrayParts?.lights.length)continue;
   const origin=relative(base,other);
   if(!origin)continue;
   const typeMatches=findMatchingArrays(doc,shotId,other.id);
   if(typeMatches.length!==roots.length||typeMatches.some(id=>rootSet.has(id)))continue;
   const companions=[];
   let okay=true;
   for(const baseId of roots){
     const row=all.find(o=>o.id===baseId);
     const pairs=typeMatches.filter(id=>!companions.includes(id)).map(id=>{
       const candidate=all.find(o=>o.id===id);
       return {candidate,placement:relative(row,candidate)};
     }).filter(x=>x.placement&&sameRelative(x.placement,origin));
     if(pairs.length!==1){okay=false;break;}
     companions.push(pairs[0].candidate.id);
   }
   if(!okay||companions[roots.indexOf(objectId)]!==other.id)continue;
   const imported={
     id:other.id,name:other.name,primitive:other.primitive,
     position:origin.position,rotation:origin.rotation,
     scale:[...other.scale],material:structuredClone(other.material),
     ...(other.points?{points:structuredClone(other.points)}:{})
   };
   result.push({id:other.id,name:other.name,ids:companions,part:imported});
   for(const id of companions)used.add(id);
 }
 return result;
}
