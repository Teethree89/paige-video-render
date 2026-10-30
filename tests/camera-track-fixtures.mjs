// Synthetic camera-track scenarios with known ground truth. Shared by the
// node tests and scripts/camera_track_harness.mjs. No video, network or model.
import {seededRandom,lookAtPose,focalFromFov,cameraCenter,rotationAngle,svd3} from '../camera-track-solver.js';

const lerp=(a,b,u)=>a.map((v,i)=>v+(b[i]-v)*u);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const len=v=>Math.hypot(...v);
const mm=(A,B)=>{const C=new Array(9);for(let i=0;i<3;i++)for(let j=0;j<3;j++)
 C[i*3+j]=A[i*3]*B[j]+A[i*3+1]*B[3+j]+A[i*3+2]*B[6+j];return C;};
const mt=A=>[A[0],A[3],A[6],A[1],A[4],A[7],A[2],A[5],A[8]];
const mv=(A,v)=>[0,1,2].map(r=>A[r*3]*v[0]+A[r*3+1]*v[1]+A[r*3+2]*v[2]);

/** A small "campus": a main block, a tower and ground texture, centered near [0,4,0]. */
export function syntheticPoints(count=260,seed=11){
 const random=seededRandom(seed),points=[];
 const box=(c,s)=>{const face=Math.floor(random()*6),axis=face>>1,sign=face&1?1:-1;
   const p=c.map((v,i)=>v+(random()-.5)*s[i]);p[axis]=c[axis]+sign*s[axis]/2;return p;};
 for(let i=0;i<count;i++){
   const r=random();
   points.push(r<.45?box([0,4,0],[16,8,10]):r<.7?box([6,8,-2],[4,16,4]):
     [(random()-.5)*50,0,(random()-.5)*40]);
 }
 return points;
}

const gauss=random=>{const u=Math.max(1e-12,random()),v=random();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};

/**
 * @param {object} spec
 * @param {(u:number)=>{position:number[],target:number[]}} spec.path
 */
export function syntheticShot({name,path,frames=24,width=1280,height=720,fov=50,noisePx=.4,
 outlierRate=0,movingPoints=0,trackLifetime=0,hideFov=false,seed=3,points=syntheticPoints()}){
 const random=seededRandom(seed),focal=focalFromFov(fov,height),poses=[];
 for(let f=0;f<frames;f++){const {position,target}=path(f/(frames-1));poses.push(lookAtPose(position,target));}
 const world=points.map((X,i)=>({id:'p'+i,at:()=>X}));
 for(let i=0;i<movingPoints;i++){
   // An independently moving object: points that slide sideways over the shot.
   const base=[-4+random()*3,1+random()*3,7+random()*2];
   world.push({id:'m'+i,at:u=>[base[0]+u*9,base[1],base[2]],moving:true});
 }
 const tracks=new Map();
 for(const point of world){
   // Stagger lifetimes so features hand over gradually, as a real tracker's do.
   let segment=0,run=trackLifetime?Math.floor(random()*trackLifetime):0;
   for(let f=0;f<frames;f++){
     const X=point.at(f/(frames-1)),pose=poses[f];
     const c=mv(pose.R,X).map((v,i)=>v+pose.t[i]);
     if(c[2]<.5){run=0;continue;}
     let x=width/2+focal*c[0]/c[2],y=height/2+focal*c[1]/c[2];
     if(x<4||y<4||x>width-4||y>height-4){run=0;continue;}
     if(trackLifetime&&run>=trackLifetime){segment++;run=0;}
     run++;
     x+=gauss(random)*noisePx;y+=gauss(random)*noisePx;
     if(random()<outlierRate){x=random()*width;y=random()*height;}
     const id=point.id+(trackLifetime?'_'+segment+'_'+(f-run+1):'');
     if(!tracks.has(id))tracks.set(id,{id,source:point.id,obs:[]});
     tracks.get(id).obs.push([f,+x.toFixed(3),+y.toFixed(3)]);
   }
 }
 const input={width,height,frameCount:frames,tracks:[...tracks.values()].filter(t=>t.obs.length>=2)};
 if(!hideFov)input.fov=fov;
 return {name,input,truth:{poses,fov,points:new Map(points.map((X,i)=>['p'+i,X]))}};
}

/** Similarity (s,R,t) with dst ~= s R src + t (Umeyama). */
export function similarity(src,dst){
 const n=src.length,ms=[0,1,2].map(i=>src.reduce((s,p)=>s+p[i],0)/n),md=[0,1,2].map(i=>dst.reduce((s,p)=>s+p[i],0)/n);
 const H=new Array(9).fill(0);let varS=0;
 for(let k=0;k<n;k++){const a=sub(src[k],ms),b=sub(dst[k],md);varS+=a[0]**2+a[1]**2+a[2]**2;
   for(let i=0;i<3;i++)for(let j=0;j<3;j++)H[i*3+j]+=b[i]*a[j];}
 const {U,S,V}=svd3(H);let D=[1,0,0,0,1,0,0,0,1];
 if((U[0]*(U[4]*U[8]-U[5]*U[7])-U[1]*(U[3]*U[8]-U[5]*U[6])+U[2]*(U[3]*U[7]-U[4]*U[6]))*
    (V[0]*(V[4]*V[8]-V[5]*V[7])-V[1]*(V[3]*V[8]-V[5]*V[6])+V[2]*(V[3]*V[7]-V[4]*V[6]))<0)D=[1,0,0,0,1,0,0,0,-1];
 const R=mm(mm(U,D),mt(V)),s=(S[0]*D[0]+S[1]*D[4]+S[2]*D[8])/varS;
 const t=sub(md,mv(R,ms).map(v=>v*s));
 return {s,R,apply:p=>mv(R,p).map((v,i)=>v*s+t[i])};
}

/** Gauge-free errors: relative rotations, aligned camera centers and FOV. */
export function evaluateSolve(solve,truth){
 const frames=[...solve.poses.keys()].sort((a,b)=>a-b),e0=solve.poses.get(0),g0=truth.poses[0];
 let rotationDeg=0;
 for(const f of frames){
   const est=mm(solve.poses.get(f).R,mt(e0.R)),gt=mm(truth.poses[f].R,mt(g0.R));
   rotationDeg=Math.max(rotationDeg,rotationAngle(mm(mt(est),gt))*180/Math.PI);
 }
 let positionPct=null;
 if(solve.mode==='parallax'){
   const ids=[...solve.points.keys()].filter(id=>truth.points.has(id.split('_')[0]));
   const sim=similarity(ids.map(id=>solve.points.get(id)),ids.map(id=>truth.points.get(id.split('_')[0])));
   const ref=len(sub(cameraCenter(g0),[0,4,0]));
   const errors=frames.map(f=>len(sub(sim.apply(cameraCenter(solve.poses.get(f))),cameraCenter(truth.poses[f]))));
   positionPct=100*Math.sqrt(errors.reduce((s,e)=>s+e*e,0)/errors.length)/ref;
 }
 return {mode:solve.mode,posed:frames.length,frames:truth.poses.length,rotationDeg,positionPct,
   fovError:Math.abs(solve.fov-truth.fov),rmsPx:solve.rmsPx,points:solve.points.size};
}

const around=(deg,radius,height,center=[0,4,0])=>[center[0]+radius*Math.sin(deg*Math.PI/180),height,center[2]+radius*Math.cos(deg*Math.PI/180)];
// Pass limits: max relative-rotation error (deg), aligned camera-center RMS
// (% of the initial camera-subject distance) and FOV error (deg).
export const DEFAULT_LIMITS=Object.freeze({rotationDeg:.25,positionPct:1,fovDeg:.5});
export const SCENARIOS=Object.freeze([
 {name:'push',type:'push',path:u=>({position:lerp([0,8,40],[0,6,24],u),target:[0,4,0]})},
 {name:'pull',type:'pull',path:u=>({position:lerp([0,6,24],[0,8,40],u),target:[0,4,0]})},
 {name:'truck',type:'truck',path:u=>({position:[lerp([-10],[10],u)[0],6,32],target:[lerp([-10],[10],u)[0],5,0]})},
 {name:'pedestal',type:'pedestal',path:u=>({position:[0,lerp([3],[15],u)[0],32],target:[0,lerp([2],[14],u)[0],0]})},
 {name:'orbit',type:'orbit',path:u=>({position:around(-30+60*u,32,12),target:[0,4,0]})},
 {name:'pan',type:'pan',path:u=>({position:[0,6,34],target:[lerp([-14],[14],u)[0],4,0]})},
 {name:'tilt',type:'tilt',path:u=>({position:[0,6,34],target:[0,lerp([-2],[14],u)[0],0]})},
 {name:'static',type:'static',path:()=>({position:[3,7,33],target:[0,4,0]})},
 {name:'crane-mixed',type:'mixed',path:u=>({position:around(-20+30*u,lerp([36],[26],u)[0],lerp([4],[16],u)[0]),target:[0,4,0]})},
 {name:'noisy push + outliers + moving object',type:'push',noisePx:1,outlierRate:.08,movingPoints:24,
  limits:{rotationDeg:.6,positionPct:6},
  path:u=>({position:lerp([0,8,40],[0,6,24],u),target:[0,4,0]})},
 {name:'orbit · short tracks (8 frames)',type:'orbit',trackLifetime:8,path:u=>({position:around(-30+60*u,32,12),target:[0,4,0]})},
 {name:'orbit · unknown FOV (42°)',type:'orbit',fov:42,hideFov:true,limits:{fovDeg:1.5},path:u=>({position:around(-30+60*u,32,12),target:[0,4,0]})},
 {name:'pan · unknown FOV (60°)',type:'pan',fov:60,hideFov:true,limits:{fovDeg:1.5},path:u=>({position:[0,6,34],target:[lerp([-16],[16],u)[0],4,0]})},
]);
export const scenarioShot=s=>syntheticShot({...s,name:s.name});
export const scenarioMode=s=>['pan','tilt','static'].includes(s.type)?'rotation':'parallax';
/** Run one scenario end to end and list every limit it misses. */
export function runScenario(s,{solve,toMotion}){
 const shot=scenarioShot(s),started=performance.now();
 const result=solve(shot.input),metrics=evaluateSolve(result,shot.truth);
 const motion=toMotion(result,{start:0,end:4});
 const limits={...DEFAULT_LIMITS,...(s.limits||{})},failures=[];
 if(metrics.mode!==scenarioMode(s))failures.push(`mode ${metrics.mode} (want ${scenarioMode(s)})`);
 if(metrics.posed!==metrics.frames)failures.push(`posed ${metrics.posed}/${metrics.frames} frames`);
 if(!(metrics.rotationDeg<=limits.rotationDeg))failures.push(`rotation ${metrics.rotationDeg.toFixed(3)}° > ${limits.rotationDeg}°`);
 if(metrics.positionPct!==null&&!(metrics.positionPct<=limits.positionPct))failures.push(`position ${metrics.positionPct.toFixed(2)}% > ${limits.positionPct}%`);
 if(!(metrics.fovError<=limits.fovDeg))failures.push(`FOV error ${metrics.fovError.toFixed(2)}° > ${limits.fovDeg}°`);
 if(motion.type!==s.type)failures.push(`type ${motion.type} (want ${s.type})`);
 return {name:s.name,metrics,motion,failures,ms:performance.now()-started};
}

/**
 * Render a synthetic grayscale "video": the scene points drawn as soft blobs
 * (size by depth) over a smooth background with sensor noise. Exercises the
 * real feature tracker instead of handing the solver perfect tracks.
 */
export function renderSyntheticVideo({path,frames=36,width=480,height=270,fov=50,noise=1.5,seed=9,points=syntheticPoints(320,21)}){
 const random=seededRandom(seed),focal=focalFromFov(fov,height);
 const looks=points.map(()=>({amp:(random()<.5?-1:1)*(55+random()*90),size:.22+random()*.3}));
 const poses=[],images=[];
 for(let f=0;f<frames;f++){
   const {position,target}=path(f/(frames-1)),pose=lookAtPose(position,target);poses.push(pose);
   const img=new Float32Array(width*height);
   for(let y=0;y<height;y++)for(let x=0;x<width;x++)img[y*width+x]=112+18*Math.sin(x/71)+14*Math.cos(y/53);
   points.forEach((X,i)=>{
     const c=mv(pose.R,X).map((v,k)=>v+pose.t[k]);if(c[2]<.5)return;
     const u=width/2+focal*c[0]/c[2],v=height/2+focal*c[1]/c[2],s=Math.min(4,Math.max(1.1,focal*looks[i].size/c[2]));
     const r=Math.ceil(3*s);if(u<-r||v<-r||u>width+r||v>height+r)return;
     for(let y=Math.max(0,Math.floor(v-r));y<=Math.min(height-1,Math.ceil(v+r));y++)
       for(let x=Math.max(0,Math.floor(u-r));x<=Math.min(width-1,Math.ceil(u+r));x++)
         img[y*width+x]+=looks[i].amp*Math.exp(-((x-u)**2+(y-v)**2)/(2*s*s));
   });
   for(let i=0;i<img.length;i++)img[i]=Math.max(0,Math.min(255,img[i]+gauss(random)*noise));
   images.push(img);
 }
 return {width,height,frames:images,truth:{poses,fov}};
}

/** Rotation error on keyframes and camera-center error after a similarity on centers. */
export function evaluateTrackedVideo(solve,truthPoses,keyframes){
 const frames=[...solve.poses.keys()].sort((a,b)=>a-b),e0=solve.poses.get(0),g0=truthPoses[keyframes[0]];
 let rotationDeg=0;
 for(const f of frames){
   const est=mm(solve.poses.get(f).R,mt(e0.R)),gt=mm(truthPoses[keyframes[f]].R,mt(g0.R));
   rotationDeg=Math.max(rotationDeg,rotationAngle(mm(mt(est),gt))*180/Math.PI);
 }
 let positionPct=null;
 if(solve.mode==='parallax'){
   const est=frames.map(f=>cameraCenter(solve.poses.get(f))),gt=frames.map(f=>cameraCenter(truthPoses[keyframes[f]]));
   const sim=similarity(est,gt),ref=len(sub(gt[0],[0,4,0]));
   const errors=est.map((c,i)=>len(sub(sim.apply(c),gt[i])));
   positionPct=100*Math.sqrt(errors.reduce((s,e)=>s+e*e,0)/errors.length)/ref;
 }
 return {mode:solve.mode,posed:frames.length,rotationDeg,positionPct,fov:solve.fov,rmsPx:solve.rmsPx};
}
export const VIDEO_SCENARIOS=Object.freeze([
 {name:'video · push',type:'push',path:SCENARIOS.find(s=>s.name==='push').path},
 {name:'video · orbit',type:'orbit',path:SCENARIOS.find(s=>s.name==='orbit').path},
 {name:'video · truck',type:'truck',path:SCENARIOS.find(s=>s.name==='truck').path},
 {name:'video · pan',type:'pan',path:SCENARIOS.find(s=>s.name==='pan').path},
 {name:'video · static',type:'static',path:SCENARIOS.find(s=>s.name==='static').path},
]);
