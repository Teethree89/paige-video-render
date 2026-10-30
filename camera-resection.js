// Absolute camera pose from points the user matched between a video frame and
// the 3D model (camera resection / PnP). Pure and deterministic: no DOM, no
// network, no provider call. Pixel coordinates have y down; the camera looks
// along +z with x right and y down (the solver's convention).
import {refinePose,pixelResidual,focalFromFov,fovFromFocal,lookAtPose,cameraCenter,cameraForward,
 poseDLT,rotationFromVector} from './camera-track-solver.js';

const DEG=Math.PI/180;
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const len=v=>Math.hypot(v[0],v[1],v[2]);
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const median=v=>{const s=[...v].sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
export const MIN_PIN_POINTS=4;
// A lens estimated from a few points trades off against camera distance: a very narrow lens puts the
// camera far away. Keep the automatic search inside the range real footage uses.
export const MIN_ESTIMATE_FOV=25,MAX_ESTIMATE_FOV=95;

const toMatches=(points,width,height)=>points.map(p=>({X:p.X,o:{dx:p.x-width/2,dy:p.y-height/2}}));
function errorsFor(pose,matches,focal){
 return matches.map(m=>{const r=pixelResidual(pose,m.X,focal,m.o);return r?Math.hypot(r.r[0],r.r[1]):1e6;});
}
const rms=e=>Math.sqrt(e.reduce((s,x)=>s+x*x,0)/e.length);
function cost(pose,matches,focal,huberPx){
 let c=0;for(const e of errorsFor(pose,matches,focal))c+=e<=huberPx?e*e:2*huberPx*e-huberPx*huberPx;return c;
}
// Roughly uniform directions on a sphere.
function fibonacciSphere(n){
 const out=[],golden=Math.PI*(3-Math.sqrt(5));
 for(let i=0;i<n;i++){const y=1-2*(i+.5)/n,r=Math.sqrt(1-y*y),a=golden*i;out.push([Math.cos(a)*r,y,Math.sin(a)*r]);}
 return out;
}
function solveAtFocal(matches,points,focal,{huberPx=2,directions=48}={}){
 const n=matches.length,centroid=[0,1,2].map(k=>matches.reduce((s,m)=>s+m.X[k],0)/n);
 const r3=Math.sqrt(matches.reduce((s,m)=>s+len(sub(m.X,centroid))**2,0)/n)||1;
 const cx=points.reduce((s,p)=>s+p.x,0)/n,cy=points.reduce((s,p)=>s+p.y,0)/n;
 const r2=Math.sqrt(points.reduce((s,p)=>s+(p.x-cx)**2+(p.y-cy)**2,0)/n)||1;
 const base=focal*r3/Math.max(8,r2); // pinhole: spread_px ~ focal * spread_3d / distance
 const starts=[];
 for(const dir of fibonacciSphere(directions))for(const k of [.7,1,1.5]){
   const pos=centroid.map((c,i)=>c+dir[i]*base*k);
   starts.push(lookAtPose(pos,centroid));
 }
 if(n>=6){const g=poseDLT(matches.map(m=>({X:m.X,n:[m.o.dx/focal,m.o.dy/focal]})));if(g)starts.push(g);}
 // Cheap pass over every start, then a full refinement of the best few.
 const rough=starts.map(s=>{const p=refinePose(s,matches,focal,huberPx,6);return {pose:p,c:cost(p,matches,focal,huberPx)};})
   .sort((a,b)=>a.c-b.c).slice(0,8);
 const refined=rough.map(r=>{const p=refinePose(r.pose,matches,focal,huberPx,40);return {pose:p,c:cost(p,matches,focal,huberPx)};})
   .sort((a,b)=>a.c-b.c);
 return refined;
}
const inFront=(pose,matches)=>matches.every(m=>{const c=pose.R[6]*m.X[0]+pose.R[7]*m.X[1]+pose.R[8]*m.X[2]+pose.t[2];return c>0;});

/**
 * @param {{x:number,y:number,X:number[]}[]} points pixel position in the frame and the matching 3D model point
 * @param {{width:number,height:number,fov?:number|null,huberPx?:number}} options vertical fov in degrees when known
 * @returns {{ok:boolean,reason?:string,pose?:object,fov?:number,rmsPx?:number,errors?:number[],center?:number[],
 *   forward?:number[],ambiguous?:boolean,fovEstimated?:boolean}}
 */
export function resectCamera(points,{width,height,fov=null,huberPx=2}={}){
 if(!(width>0&&height>0))throw Error('Frame size is required');
 if(!Array.isArray(points)||points.length<MIN_PIN_POINTS)
   return {ok:false,reason:`Pin at least ${MIN_PIN_POINTS} points in both the video and the model.`};
 if(points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||!Array.isArray(p.X)||p.X.length!==3||!p.X.every(Number.isFinite)))
   return {ok:false,reason:'A pinned point has invalid coordinates.'};
 const matches=toMatches(points,width,height);
 const candidates=Number.isFinite(fov)?[fov]:[28,38,50,62,78];
 let best=null;
 for(const f of candidates){
   const focal=focalFromFov(f,height),sols=solveAtFocal(matches,points,focal,{huberPx});
   for(const s of sols.slice(0,3)){
     if(!inFront(s.pose,matches))continue;
     const e=rms(errorsFor(s.pose,matches,focal));
     if(!best||e<best.rms)best={...s,fov:f,focal,rms:e,alt:sols};
   }
 }
 if(!best)return {ok:false,reason:'No camera position places all pinned points in front of the camera. Check that each video point matches the same model point.'};
 let fovEstimated=false;
 if(!Number.isFinite(fov)){
   // Golden-section search on the lens around the best coarse candidate.
   let lo=Math.max(MIN_ESTIMATE_FOV,best.fov-14),hi=Math.min(MAX_ESTIMATE_FOV,best.fov+14),pose=best.pose;
   const at=f=>{const focal=focalFromFov(f,height),p=refinePose(pose,matches,focal,huberPx,30);return {f,p,e:rms(errorsFor(p,matches,focal))};};
   let a=at(lo+(hi-lo)*.382),b=at(lo+(hi-lo)*.618);
   for(let i=0;i<14;i++){
     if(a.e<b.e){hi=b.f;b=a;a=at(lo+(hi-lo)*.382);}else{lo=a.f;a=b;b=at(lo+(hi-lo)*.618);}
   }
   const win=a.e<b.e?a:b;
   if(win.e<best.rms&&inFront(win.p,matches)){best={...best,pose:win.p,fov:win.f,focal:focalFromFov(win.f,height),rms:win.e};}
   fovEstimated=true;
 }
 const focal=focalFromFov(best.fov,height),errors=errorsFor(best.pose,matches,focal);
 // Few points can fit two quite different camera positions: warn instead of guessing.
 const center=cameraCenter(best.pose),r3=Math.max(1e-6,median(matches.map(m=>len(sub(m.X,center)))));
 let ambiguous=false;
 for(const alt of best.alt||[]){
   if(alt.pose===best.pose)continue;
   const e=rms(errorsFor(alt.pose,matches,best.focal));
   if(e<=Math.max(best.rms*1.5,best.rms+1.5)&&len(sub(cameraCenter(alt.pose),center))>.2*r3){ambiguous=true;break;}
 }
 return {ok:true,pose:best.pose,fov:best.fov,fovEstimated,rmsPx:rms(errors),errors,center,
   forward:cameraForward(best.pose),ambiguous,pointCount:points.length};
}

/** Project a world point with a resected camera. Returns {x,y,depth} in pixels or null behind the camera. */
export function projectPoint(pose,fov,width,height,X){
 const focal=focalFromFov(fov,height),r=pixelResidual(pose,X,focal,{dx:0,dy:0});
 if(!r)return null;
 return {x:width/2+r.r[0],y:height/2+r.r[1],depth:r.Xc[2]};
}

/**
 * Vertical FOV to render the 3D view so a video frame shown "contain"-fitted in a
 * viewport lines up with it: a viewport narrower than the video letterboxes the
 * frame vertically, so the 3D camera must see more vertical extent.
 */
export function wipeFov(videoFovDeg,videoAspect,viewportAspect){
 if(!(videoAspect>0&&viewportAspect>0))return videoFovDeg;
 if(viewportAspect>=videoAspect)return videoFovDeg;
 return 2*Math.atan(Math.tan(videoFovDeg*DEG/2)*videoAspect/viewportAspect)/DEG;
}

/** Roll of a camera pose against world up, in degrees (keys cannot store roll). */
export function rollDegrees(pose){
 const f=[pose.R[6],pose.R[7],pose.R[8]],up=[-pose.R[3],-pose.R[4],-pose.R[5]];
 const w=[0,1,0],wp=[w[0]-f[0]*dot(w,f),w[1]-f[1]*dot(w,f),w[2]-f[2]*dot(w,f)];
 if(len(wp)<1e-6)return 0;
 const a=len(wp),b=len(up),c=Math.max(-1,Math.min(1,dot(wp,up)/(a*b||1)));
 return Math.acos(c)/DEG;
}
export {rotationFromVector,fovFromFocal};
