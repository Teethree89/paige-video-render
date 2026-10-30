// Place a tracked RELATIVE camera path into the model using user-pinned points.
// The pose at the reference frame comes from camera-resection.js; the tracker's
// path only says how the camera moved. Scale is taken from how far the pinned
// points are from the camera, so nothing here guesses the model's size.
// Pure and deterministic: no DOM, no network, no provider call.
import {cameraCenter,focalFromFov,simplifyPath} from './camera-track-solver.js';
import {rollDegrees} from './camera-resection.js';
import {acceptedCameraSnapshot} from './accepted-camera-sync.js';

const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const add=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const mul=(a,s)=>[a[0]*s,a[1]*s,a[2]*s];
const len=v=>Math.hypot(v[0],v[1],v[2]);
const mv=(A,v)=>[A[0]*v[0]+A[1]*v[1]+A[2]*v[2],A[3]*v[0]+A[4]*v[1]+A[5]*v[2],A[6]*v[0]+A[7]*v[1]+A[8]*v[2]];
const mt=A=>[A[0],A[3],A[6],A[1],A[4],A[7],A[2],A[5],A[8]];
const mm=(A,B)=>{const C=new Array(9);for(let i=0;i<3;i++)for(let j=0;j<3;j++)
 C[i*3+j]=A[i*3]*B[j]+A[i*3+1]*B[3+j]+A[i*3+2]*B[6+j];return C;};
const median=v=>{const s=[...v].sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const round=n=>Math.round(n*1000)/1000;

export const DENSITY=Object.freeze({few:{tolerance:.05,maxKeys:8},normal:{tolerance:.02,maxKeys:14},many:{tolerance:.006,maxKeys:30}});

/**
 * @param {{solve:object,seeds:{id:string,X:number[]}[],refPose:{R:number[],t:number[]},fov:number,
 *   width:number,height:number,seedObs?:Map<string,Map<number,number[]>>}} input
 *   `solve` is solveCameraTracks output for one pass whose frame 0 is the reference frame.
 * @returns {{ok:boolean,reason?:string,frames?:object[],scale?:number,anchorRmsPx?:number|null,rollDeg?:number,seedsUsed?:number}}
 */
export function anchorPath({solve,seeds,refPose,fov,width,height,seedObs=null}){
 const pose0=solve?.poses?.get(0);
 if(!pose0||solve.mode==='failed')return {ok:false,reason:'The motion could not be tracked in this chapter.'};
 const cAbs=cameraCenter(refPose),cRel0=cameraCenter(pose0);
 // Q turns the tracker's world into the model's: R_abs Q = R_ref at the reference frame.
 const Q=mm(mt(refPose.R),pose0.R);
 let s=1,seedsUsed=0,scaleSpread=0;
 if(solve.mode==='parallax'){
   const ratios=[];
   for(const seed of seeds){
     const Y=solve.points.get(seed.id);if(!Y)continue;
     const dRel=len(sub(Y,cRel0)),dModel=len(sub(seed.X,cAbs));
     if(dRel>1e-9&&dModel>1e-9)ratios.push(dModel/dRel);
   }
   if(ratios.length<3)
     return {ok:false,reason:`Only ${ratios.length} pinned point${ratios.length===1?'':'s'} could be followed in 3D. Pin points that stay visible while the camera moves (and are not on the sky or moving objects).`};
   const med=median(ratios),inliers=ratios.filter(r=>r>=med*.8&&r<=med*1.25);
   s=median(inliers.length>=3?inliers:ratios);seedsUsed=inliers.length>=3?inliers.length:ratios.length;
   scaleSpread=(Math.max(...inliers)-Math.min(...inliers))/s;
 }
 const u=mv(mt(refPose.R),sub(mul(pose0.t,s),refPose.t));
 const frames=[];
 for(const [frame,pose] of [...solve.poses.entries()].sort((a,b)=>a[0]-b[0])){
   const R=mm(pose.R,mt(Q)),center=solve.mode==='parallax'?add(mul(mv(Q,cameraCenter(pose)),s),u):cAbs.slice();
   frames.push({frame,R,center,forward:[R[6],R[7],R[8]],t:mul(mv(R,center),-1)});
 }
 // Check the alignment against the pinned points' own tracks: they should reproject onto where they were seen.
 let anchorRmsPx=null;
 if(seedObs){
   const focal=focalFromFov(fov,height),errs=[],byFrame=new Map(frames.map(f=>[f.frame,f]));
   for(const seed of seeds){
     const obs=seedObs.get(seed.id);if(!obs)continue;
     for(const [frame,px] of obs){
       const f=byFrame.get(frame);if(!f)continue;
       const c=add(mv(f.R,seed.X),f.t);if(c[2]<=1e-9)continue;
       errs.push(Math.hypot(width/2+focal*c[0]/c[2]-px[0],height/2+focal*c[1]/c[2]-px[1]));
     }
   }
   if(errs.length)anchorRmsPx=Math.sqrt(errs.reduce((a,e)=>a+e*e,0)/errs.length);
 }
 return {ok:true,frames,scale:s,scaleSpread,seedsUsed,anchorRmsPx,rollDeg:rollDegrees({R:frames[0].R}),mode:solve.mode};
}

/** Turn anchored frames into camera keys (world coordinates). Each frame's `time` (else `times[frame]`) is its chapter time. */
export function pathToKeys(frames,{times=null,fov,targetDistance,density='normal'}){
 const d=DENSITY[density]||DENSITY.normal;
 let samples=frames.map(f=>({u:f.time??times?.[f.frame],p:f.center,t:add(f.center,mul(f.forward,targetDistance))}))
   .filter(x=>Number.isFinite(x.u)).sort((a,b)=>a.u-b.u);
 samples=samples.filter((x,i)=>!i||x.u>samples[i-1].u+1e-4);
 if(samples.length<2)throw Error('The tracked path is too short to make keys.');
 const extent=Math.max(1e-6,...samples.flatMap(x=>[len(sub(x.p,samples[0].p)),len(sub(x.t,samples[0].t))]));
 const keys=simplifyPath(samples,d.maxKeys,Math.max(1e-4,extent*d.tolerance));
 return keys.map(k=>({at:k.u,p:k.p.map(round),t:k.t.map(round),fov:Math.round(fov*100)/100}));
}

const owns=(sequence,shot)=>{
 const last=sequence.shots.at(-1)?.id===shot.id;
 return k=>k.at>=shot.start-.0001&&(k.at<shot.end-.0001||(last&&k.at<=shot.end+.0001));
};

/**
 * Proposal for the existing preview / Apply flow: replaces ONLY this chapter's
 * camera keys, freezes the scene anchor so geometry does not move, and leaves
 * every other chapter, text and model untouched.
 */
export function buildAnchoredCameraProposal(sequence,shotId,{keys,anchor,summary={},pins=null}){
 const shot=sequence.shots.find(s=>s.id===shotId);
 if(!shot)throw Error('Unknown chapter');
 const snapshot=acceptedCameraSnapshot(sequence,shotId);
 if(!Array.isArray(anchor)||anchor.length!==3||!anchor.every(Number.isFinite))throw Error('The model anchor is missing.');
 const fps=Math.max(1,sequence.fps||30),last=sequence.shots.at(-1)?.id===shotId;
 const tail=last?shot.end:Math.max(shot.start,shot.end-1/fps);
 let list=keys.map(k=>({...k,at:Math.min(tail,Math.max(shot.start,k.at))})).sort((a,b)=>a.at-b.at);
 if(list[0].at>shot.start+.02)list.unshift({...list[0],at:shot.start}); // hold until the first tracked frame
 if(list.at(-1).at<tail-.02)list.push({...list.at(-1),at:tail});      // and from the last one to the chapter end
 list=list.filter((k,i)=>!i||k.at>list[i-1].at+1/(fps*2));
 if(list.length<2)throw Error('Chapter too short for tracked keys.');
 for(const k of list)if([...k.p,...k.t].some(n=>!Number.isFinite(n)||Math.abs(n)>10000)||!(k.fov>=10&&k.fov<=110))
   throw Error('The tracked camera leaves the supported scene range.');
 const output=structuredClone(sequence),mine=owns(output,shot);
 const removed=output.camera.filter(mine),used=new Set(output.camera.filter(k=>!mine(k)).map(k=>k.id));
 const newKeys=list.map((k,i)=>{
   let id='track_'+shotId+'_'+i;while(used.has(id))id+='_';used.add(id);
   return {id,at:Math.round(k.at*1000)/1000,p:k.p,t:k.t,fov:k.fov,cut:i===0,curve:{mode:'linear'},generated:'video-track'};
 });
 output.camera=[...output.camera.filter(k=>!mine(k)),...newKeys].sort((a,b)=>a.at-b.at);
 const next=output.shots.find(s=>s.id===shotId);
 next.sceneAnchor=[...anchor];
 next.cameraSync={version:1,mode:'anchored-track',source:'feature-track',scale:round(summary.scale??1)};
 if(pins)next.trackingPins=pins;
 return {sequence:output,shotId,snapshot,
   report:{mode:'anchored-track',source:'feature-track',updatedKeys:newKeys.length,addedKeys:newKeys.length,
     removedKeys:removed.length,scale:round(summary.scale??1),...summary}};
}
