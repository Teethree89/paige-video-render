// Camera-motion retargeting when accepting newly generated scene geometry.
//
// Geometry provides objective scale and center; the existing keyframe path
// provides direction, pan, orbit and timing. No Gemini call is needed, and the
// generated scene itself is never scaled, moved or overwritten here.
// A stable sceneAnchor prevents the shotAnchorMap feedback loop.
import {evaluateCamera} from './animation-curves.js';
import {buildVideoCameraMotion} from './video-camera-motion.js';
const round=n=>Math.round(n*10000)/10000;
const vec=v=>Array.isArray(v)&&v.length===3&&v.every(n=>Number.isFinite(n));
const sub=(a,b)=>a.map((n,i)=>n-b[i]);
const add=(a,b)=>a.map((n,i)=>n+b[i]);
const mul=(a,f)=>a.map(n=>n*f);
const dot=(a,b)=>a.reduce((s,n,i)=>s+n*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>Math.hypot(...a);
const unit=a=>mul(a,1/Math.max(norm(a),1e-10));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const average=vs=>mul(vs.reduce((s,v)=>add(s,v),[0,0,0]),1/vs.length);
const validBounds=b=>b&&vec(b.center)&&Number.isFinite(b.radius)&&b.radius>.001&&b.radius<10000;
const limited=v=>vec(v)&&v.every(n=>Math.abs(n)<=10000);
function rotateBetween(oldAxis,newAxis) {
  const a=unit(oldAxis),b=unit(newAxis);
  const cosine=clamp(dot(a,b),-1,1);
  if(cosine>.999999)return point=>point;
  let axis=cross(a,b),angle=Math.acos(cosine);
  if(cosine<-.999999){
    axis=cross(a,Math.abs(a[1])<.9?[0,1,0]:[1,0,0]);angle=Math.PI;
  }
  axis=unit(axis);
  return point=>{
    const cosine=Math.cos(angle),sine=Math.sin(angle);
    return add(add(mul(point,cosine),mul(cross(axis,point),sine)),
      mul(axis,dot(axis,point)*(1-cosine)));
  };
}
function safeBounds(value,label){
 if(!validBounds(value))throw Error(label+' has no usable 3D bounds; generate editable geometry first.');
 return {center:[...value.center],radius:value.radius};
}
function orientationEstimate(e){
 return e&&vec(e.position)&&vec(e.target)&&norm(sub(e.position,e.target))>.01?e:null;
}
function uniqueId(existing,prefix){
 let id=prefix,i=0;
 while(existing.has(id)){id=prefix+'_'+(++i);}
 existing.add(id);return id;
}
function chosenKeys(sequence,shot){
 const isLast=sequence.shots.at(-1)?.id===shot.id;
 const has=(k)=>k.at>=shot.start-.002&&
   (k.at<shot.end-.002||(isLast&&Math.abs(k.at-shot.end)<.002));
 const list=sequence.camera.filter(has).map(k=>structuredClone(k));
 const ids=new Set(sequence.camera.map(k=>k.id));
 const first=()=>structuredClone(evaluateCamera(sequence.camera,shot.start));
 const last=()=>structuredClone(evaluateCamera(sequence.camera,Math.max(shot.start,shot.end-1/Math.max(1,sequence.fps||30))));
 if(!list.some(k=>Math.abs(k.at-shot.start)<.002)){
   const k=first();
   Object.assign(k,{id:uniqueId(ids,'sync_'+shot.id+'_start'),at:shot.start,cut:true});
   list.push(k);
 }
 const endTime=isLast?shot.end:Math.max(shot.start,shot.end-1/Math.max(1,sequence.fps||30));
 if(!list.some(k=>k.at>=endTime-.015)){
   const k=last();
   Object.assign(k,{id:uniqueId(ids,'sync_'+shot.id+'_tail'),at:round(endTime),cut:false});
   list.push(k);
 }
 return list.sort((a,b)=>a.at-b.at);
}
function fieldAngle(fov,aspect){
 const vertical=clamp(fov,10,110)*Math.PI/180;
 return Math.min(vertical,2*Math.atan(Math.tan(vertical/2)*clamp(aspect,.35,4)));
}
function median(values){const v=[...values].sort((a,b)=>a-b);return v[Math.floor(v.length/2)];}

/**
 * @param {object} source - Existing complete sequence, never mutated.
 * @param {string} shotId - The chapter being regenerated.
 * @param {object} options
 * @param {object|null} options.oldBounds - Old accepted geometry world bounds (if any).
 * @param {object} options.newBounds - Proposed geometry world bounds.
 * @param {number[]} options.anchor - Frozen chapter geometry anchor BEFORE editing keys.
 * @param {string} options.mode - 'motion' (original dolly/pan) or 'fit' (whole scene),
 *   or 'model-view' (align baseline to the generator's *suggested* camera orientation).
 * @param {object|null} options.modelCamera - Optional validated world-space model camera.
 */
export function syncChapterCameraMotion(source,shotId,{
 oldBounds=null,newBounds,anchor,mode='motion',modelCamera=null,aspect=16/9,margin=1.12,referenceAt=null
}={}){
 if(mode==='video-motion')return buildVideoCameraMotion(source,shotId,{newBounds,anchor,modelCamera,referenceAt});
 if(!source?.shots?.length||!source?.camera?.length)throw Error('Camera timeline is missing');
 const shot=source.shots.find(s=>s.id===shotId);
 if(!shot)throw Error('Selected chapter no longer exists');
 if(!['motion','fit','model-view'].includes(mode))throw Error('Unknown camera-sync mode');
 const nextBounds=safeBounds(newBounds,'Proposed scene');
 if(oldBounds&&!validBounds(oldBounds))throw Error('Previous scene bounds are invalid');
 if(!vec(anchor)||!limited(anchor))throw Error('Geometry anchor must be captured before camera synchronization');
 if(!Number.isFinite(aspect)||aspect<.35||aspect>4)throw Error('Invalid preview aspect ratio');
 if(!Number.isFinite(margin)||margin<1||margin>2)throw Error('Framing margin must be between 1 and 2');
 const before=chosenKeys(source,shot);
 if(!before.length)throw Error('No camera motion to synchronize');
 const oldCenter=oldBounds?.center||average(before.map(k=>k.t));
 const oldRadius=oldBounds?.radius||null;
 const distances=before.map(k=>norm(sub(k.p,k.t))).filter(d=>d>.02);
 if(!distances.length)throw Error('Camera path has no usable position/target separation');
 const baseline=median(distances);
 const halfAngle=Math.min(...before.map(k=>fieldAngle(k.fov,aspect)))/2;
 const fittedDistance=nextBounds.radius/Math.sin(halfAngle)*margin;
 let scale=oldRadius?nextBounds.radius/oldRadius:fittedDistance/baseline;
 if(!Number.isFinite(scale)||scale<=0||scale>1000||scale<.0001)
   throw Error('Scene scales differ too much for a safe automatic camera sync');
 let rotate=p=>p;
 if(mode==='model-view'){
   const suggestion=orientationEstimate(modelCamera);
   if(!suggestion)throw Error('The generated scene has no valid estimated camera orientation.');
   rotate=rotateBetween(sub(before[0].p,before[0].t),sub(suggestion.position,suggestion.target));
 }
 let updated=before.map(k=>{
   const p=add(nextBounds.center,rotate(mul(sub(k.p,oldCenter),scale)));
   const t=add(nextBounds.center,rotate(mul(sub(k.t,oldCenter),scale)));
   return {...k,p,t};
 });
 if(mode==='fit'){
   // Uniformly enlarge the path if its closest frame could clip the sphere.
   // The original orbit/pan geometry is retained; only the global scale changes.
   let multiplier=1;
   for(const key of updated){
     const radiusToCamera=norm(sub(key.p,nextBounds.center));
     const offCenter=norm(sub(key.t,nextBounds.center));
     const minDistance=nextBounds.radius/Math.sin(fieldAngle(key.fov,aspect)/2)*margin+offCenter;
     multiplier=Math.max(multiplier,minDistance/Math.max(radiusToCamera,.001));
   }
   if(multiplier>1){
     updated=updated.map(k=>({...k,
       p:add(nextBounds.center,mul(sub(k.p,nextBounds.center),multiplier)),
       t:add(nextBounds.center,mul(sub(k.t,nextBounds.center),multiplier))}));
     scale*=multiplier;
   }
 }
 for(const key of updated){
   if(!limited(key.p)||!limited(key.t)||norm(sub(key.p,key.t))<.01)
     throw Error('Retargeted camera coordinates are unsafe; use manual camera editing instead');
   key.p=key.p.map(round);key.t=key.t.map(round);
 }
 const output=structuredClone(source);
 const existing=new Set(before.map(k=>k.id));
 output.camera=output.camera.filter(k=>!existing.has(k.id));
 output.camera.push(...updated);
 output.camera.sort((a,b)=>a.at-b.at);
 const outputShot=output.shots.find(s=>s.id===shotId);
 // This is the critical invariant: shotAnchorMap must never start moving the
 // newly accepted primitive scene merely because its camera targets change.
 outputShot.sceneAnchor=[...anchor];
 outputShot.cameraSync={version:1,mode,scale:round(scale),
   source:oldRadius?'previous-geometry':'authored-camera',
   syncedAt:new Date().toISOString()};
 return {sequence:output,report:{
   mode,scale:round(scale),source:oldRadius?'previous-geometry':'authored-camera',
   updatedKeys:updated.length,addedKeys:updated.filter(k=>!source.camera.some(old=>old.id===k.id)).length,
   originalRadius:oldRadius,generatedRadius:round(nextBounds.radius),
   originalDistance:round(baseline),
   syncDistance:round(median(updated.map(k=>norm(sub(k.p,k.t))))),
   estimatedOrientationUsed:mode==='model-view'
 }};
}

/** Dynamic 3D camera clip planes for much larger regenerated scenes.
 *  Kept independent from Three.js to unit test without GPU/runtime access. */
export function clipPlanesForScene(position,target,bounds){
 if(!vec(position)||!vec(target))return {near:.35,far:500};
 const distance=norm(sub(position,target));
 if(!validBounds(bounds))return {near:.35,far:Math.max(500,round(distance*4))};
 const sceneDistance=norm(sub(position,bounds.center));
 return {near:clamp(distance*.002,.05,.35),
   far:clamp(Math.max(500,sceneDistance+bounds.radius*3,distance*4),500,60000)};
}

