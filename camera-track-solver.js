// Feature-track camera solver: 2D point tracks -> relative camera path.
// Pure and deterministic (seeded RANSAC); no DOM, network or provider calls.
// The path is only known up to one similarity transform (rotation,
// translation, scale). trackSolveToVideoMotion converts it into the existing
// reviewable `videoCameraMotion` estimate, which buildVideoCameraMotion then
// fits to the generated geometry. Nothing here writes camera keys.
import {validateVideoMotion} from './video-camera-motion.js';

const DEG=Math.PI/180;
export const TRACK_SOLVER_VERSION=1;

export function seededRandom(seed=1){
 let a=(seed>>>0)||1;
 return ()=>{a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
}

// ---- small vector / matrix helpers (3x3 matrices are row-major arrays) ----
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>Math.hypot(a[0],a[1],a[2]);
const scale=(a,s)=>[a[0]*s,a[1]*s,a[2]*s];
const plus=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const minus=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const unit=a=>scale(a,1/(norm(a)||1));
const I3=()=>[1,0,0,0,1,0,0,0,1];
const mm=(A,B)=>{const C=new Array(9);for(let i=0;i<3;i++)for(let j=0;j<3;j++)
 C[i*3+j]=A[i*3]*B[j]+A[i*3+1]*B[3+j]+A[i*3+2]*B[6+j];return C;};
const mt=A=>[A[0],A[3],A[6],A[1],A[4],A[7],A[2],A[5],A[8]];
const mv=(A,v)=>[A[0]*v[0]+A[1]*v[1]+A[2]*v[2],A[3]*v[0]+A[4]*v[1]+A[5]*v[2],A[6]*v[0]+A[7]*v[1]+A[8]*v[2]];
const det3=A=>A[0]*(A[4]*A[8]-A[5]*A[7])-A[1]*(A[3]*A[8]-A[5]*A[6])+A[2]*(A[3]*A[7]-A[4]*A[6]);
const median=values=>{if(!values.length)return NaN;const v=[...values].sort((a,b)=>a-b),m=v.length>>1;
 return v.length%2?v[m]:(v[m-1]+v[m])/2;};
const percentile=(values,q)=>{const v=[...values].sort((a,b)=>a-b);return v[Math.min(v.length-1,Math.max(0,Math.round(q*(v.length-1))))];};

export function rotationFromVector(w){
 const th=norm(w);if(th<1e-14)return I3();
 const k=scale(w,1/th),c=Math.cos(th),s=Math.sin(th),v=1-c;
 return [c+k[0]*k[0]*v,k[0]*k[1]*v-k[2]*s,k[0]*k[2]*v+k[1]*s,
   k[1]*k[0]*v+k[2]*s,c+k[1]*k[1]*v,k[1]*k[2]*v-k[0]*s,
   k[2]*k[0]*v-k[1]*s,k[2]*k[1]*v+k[0]*s,c+k[2]*k[2]*v];
}
export function rotationAngle(R){return Math.acos(Math.max(-1,Math.min(1,(R[0]+R[4]+R[8]-1)/2)));}

// Cyclic Jacobi eigen-decomposition of a small symmetric n x n matrix.
// Returns ascending eigenvalues and eigenvectors as columns of `vectors`.
export function symmetricEigen(input,n){
 const a=Float64Array.from(input),v=new Float64Array(n*n);
 for(let i=0;i<n;i++)v[i*n+i]=1;
 let scaleSum=0;for(let i=0;i<n*n;i++)scaleSum+=a[i]*a[i];
 for(let sweep=0;sweep<80;sweep++){
   let off=0;for(let p=0;p<n;p++)for(let q=p+1;q<n;q++)off+=a[p*n+q]*a[p*n+q];
   if(off<=1e-30*(scaleSum||1))break;
   for(let p=0;p<n;p++)for(let q=p+1;q<n;q++){
     const apq=a[p*n+q];if(Math.abs(apq)<1e-300)continue;
     const theta=(a[q*n+q]-a[p*n+p])/(2*apq);
     const t=(theta>=0?1:-1)/(Math.abs(theta)+Math.sqrt(theta*theta+1));
     const c=1/Math.sqrt(t*t+1),s=t*c;
     for(let k=0;k<n;k++){const kp=a[k*n+p],kq=a[k*n+q];a[k*n+p]=c*kp-s*kq;a[k*n+q]=s*kp+c*kq;}
     for(let k=0;k<n;k++){const pk=a[p*n+k],qk=a[q*n+k];a[p*n+k]=c*pk-s*qk;a[q*n+k]=s*pk+c*qk;}
     for(let k=0;k<n;k++){const kp=v[k*n+p],kq=v[k*n+q];v[k*n+p]=c*kp-s*kq;v[k*n+q]=s*kp+c*kq;}
   }
 }
 const order=[...Array(n).keys()].sort((i,j)=>a[i*n+i]-a[j*n+j]);
 const vectors=new Float64Array(n*n);
 order.forEach((col,k)=>{for(let r=0;r<n;r++)vectors[r*n+k]=v[r*n+col];});
 return {values:order.map(i=>a[i*n+i]),vectors};
}
const column=(eig,n,k)=>Array.from({length:n},(_,r)=>eig.vectors[r*n+k]);

// 3x3 SVD: M = U diag(S) V^T with descending S.
export function svd3(M){
 const eig=symmetricEigen(mm(mt(M),M),3);
 const vs=[column(eig,3,2),column(eig,3,1),column(eig,3,0)];
 // |M v| is far more accurate than sqrt(eigenvalue) for tiny singular values.
 const mvs=vs.map(v=>mv(M,v)),S=mvs.map(norm),us=[];
 for(let i=0;i<3;i++){
   if(S[i]>1e-9*S[0])us.push(scale(mvs[i],1/S[i]));
   else if(i===2)us.push(unit(cross(us[0],us[1])));
   else{const a=us[0],helper=Math.abs(a[0])<.9?[1,0,0]:[0,1,0];us.push(unit(cross(a,helper)));}
 }
 const U=[us[0][0],us[1][0],us[2][0],us[0][1],us[1][1],us[2][1],us[0][2],us[1][2],us[2][2]];
 const V=[vs[0][0],vs[1][0],vs[2][0],vs[0][1],vs[1][1],vs[2][1],vs[0][2],vs[1][2],vs[2][2]];
 return {U,S,V};
}

function solveSPD(A,b,n){
 const L=new Float64Array(n*n);
 for(let i=0;i<n;i++)for(let j=0;j<=i;j++){
   let s=A[i*n+j];for(let k=0;k<j;k++)s-=L[i*n+k]*L[j*n+k];
   if(i===j){if(!(s>0))return null;L[i*n+i]=Math.sqrt(s);}else L[i*n+j]=s/L[j*n+j];
 }
 const y=new Float64Array(n),x=new Float64Array(n);
 for(let i=0;i<n;i++){let s=b[i];for(let k=0;k<i;k++)s-=L[i*n+k]*y[k];y[i]=s/L[i*n+i];}
 for(let i=n-1;i>=0;i--){let s=y[i];for(let k=i+1;k<n;k++)s-=L[k*n+i]*x[k];x[i]=s/L[i*n+i];}
 return x;
}
function inverse3(A){
 const d=det3(A);if(!(Math.abs(d)>1e-300))return null;
 return [(A[4]*A[8]-A[5]*A[7])/d,(A[2]*A[7]-A[1]*A[8])/d,(A[1]*A[5]-A[2]*A[4])/d,
   (A[5]*A[6]-A[3]*A[8])/d,(A[0]*A[8]-A[2]*A[6])/d,(A[2]*A[3]-A[0]*A[5])/d,
   (A[3]*A[7]-A[4]*A[6])/d,(A[1]*A[6]-A[0]*A[7])/d,(A[0]*A[4]-A[1]*A[3])/d];
}

// ---- camera geometry (camera axes: x right, y down, z forward) ----
export const cameraCenter=pose=>scale(mv(mt(pose.R),pose.t),-1);
export const cameraForward=pose=>[pose.R[6],pose.R[7],pose.R[8]];
export const cameraRight=pose=>[pose.R[0],pose.R[1],pose.R[2]];
export const cameraUp=pose=>[-pose.R[3],-pose.R[4],-pose.R[5]];
export const focalFromFov=(fovDeg,height)=>height/2/Math.tan(fovDeg*DEG/2);
export const fovFromFocal=(focal,height)=>2*Math.atan(height/2/focal)/DEG;
/** World->camera pose that looks from `position` to `target` with world +Y up. */
export function lookAtPose(position,target,up=[0,1,0]){
 const f=unit(minus(target,position)),r=unit(cross(f,up)),d=cross(f,r);
 const R=[...r,...d,...f];return {R,t:scale(mv(R,position),-1)};
}

function residualAngle(R,a,b){const p=mv(R,a);return Math.atan2(norm(cross(p,b)),dot(p,b));}
// Rotation R minimizing sum |R a - b|^2 over weighted unit bearings.
function kabsch(a,b,weights=null){
 const H=new Array(9).fill(0);
 for(let i=0;i<a.length;i++){const w=weights?weights[i]:1;if(!w)continue;
   for(let r=0;r<3;r++)for(let c=0;c<3;c++)H[r*3+c]+=w*a[i][r]*b[i][c];}
 const {U,V}=svd3(H),R=mm(V,mt(U));
 if(det3(R)>=0)return R;
 return mm(mm(V,[1,0,0,0,1,0,0,0,-1]),mt(U));
}
function fitRotation(a,b,focal,thresholdPx,random){
 const n=a.length,thr=thresholdPx/focal;let best=null,bestCount=-1;
 for(let it=0;it<48&&n>=2;it++){
   const i=Math.floor(random()*n);let j=Math.floor(random()*n);if(j===i)j=(j+1)%n;
   const R=kabsch([a[i],a[j]],[b[i],b[j]]);
   let count=0;for(let k=0;k<n;k++)if(residualAngle(R,a[k],b[k])<thr)count++;
   if(count>bestCount){bestCount=count;best=R;}
 }
 let R=best||I3();
 for(let pass=0;pass<3;pass++){
   const w=a.map((_,k)=>residualAngle(R,a[k],b[k])<thr*2?1:0);
   if(w.reduce((s,x)=>s+x,0)>=2)R=kabsch(a,b,w);
 }
 const residuals=a.map((_,k)=>residualAngle(R,a[k],b[k])*focal);
 return {R,medianPx:median(residuals),inliers:residuals.filter(e=>e<thresholdPx).length};
}

// Essential matrix (x2^T E x1 = 0, X2 = R X1 + t) from normalized coordinates.
function essentialEightPoint(p1,p2,indices){
 const A=new Float64Array(81);
 for(const k of indices){
   const [x1,y1]=p1[k],[x2,y2]=p2[k],row=[x2*x1,x2*y1,x2,y2*x1,y2*y1,y2,x1,y1,1];
   for(let i=0;i<9;i++)for(let j=0;j<9;j++)A[i*9+j]+=row[i]*row[j];
 }
 const e=column(symmetricEigen(A,9),9,0),{U,V}=svd3(e);
 return mm(mm(U,[1,0,0,0,1,0,0,0,0]),mt(V));
}
function sampson(E,a,b){
 const x1=[a[0],a[1],1],x2=[b[0],b[1],1],Ex1=mv(E,x1),Etx2=mv(mt(E),x2);
 const num=dot(x2,Ex1);return num*num/(Ex1[0]**2+Ex1[1]**2+Etx2[0]**2+Etx2[1]**2||1e-30);
}
function estimateEssential(p1,p2,focal,thresholdPx,random){
 const n=p1.length,thr=(thresholdPx/focal)**2;let best=null,bestInliers=[];
 for(let it=0;it<260&&n>=8;it++){
   const sample=new Set();while(sample.size<8)sample.add(Math.floor(random()*n));
   const E=essentialEightPoint(p1,p2,[...sample]),inliers=[];
   for(let k=0;k<n;k++)if(sampson(E,p1[k],p2[k])<thr)inliers.push(k);
   if(inliers.length>bestInliers.length){best=E;bestInliers=inliers;}
 }
 if(!best)return null;
 for(let pass=0;pass<2&&bestInliers.length>=8;pass++){
   const E=essentialEightPoint(p1,p2,bestInliers),inliers=[];
   for(let k=0;k<n;k++)if(sampson(E,p1[k],p2[k])<thr)inliers.push(k);
   if(inliers.length>=bestInliers.length){best=E;bestInliers=inliers;}else break;
 }
 return {E:best,inliers:bestInliers};
}

export function triangulate(poses,points){
 const A=new Float64Array(16);
 for(let i=0;i<poses.length;i++){
   const {R,t}=poses[i],[x,y]=points[i];
   const P=[[R[0],R[1],R[2],t[0]],[R[3],R[4],R[5],t[1]],[R[6],R[7],R[8],t[2]]];
   for(const row of [P[2].map((v,k)=>x*v-P[0][k]),P[2].map((v,k)=>y*v-P[1][k])]){
     const len=Math.hypot(...row)||1;
     for(let r=0;r<4;r++)for(let c=0;c<4;c++)A[r*4+c]+=row[r]*row[c]/(len*len);
   }
 }
 const h=column(symmetricEigen(A,4),4,0);
 if(Math.abs(h[3])<1e-12)return null;
 return [h[0]/h[3],h[1]/h[3],h[2]/h[3]];
}
function projectNormalized(pose,X){
 const c=plus(mv(pose.R,X),pose.t);return c[2]>1e-9?[c[0]/c[2],c[1]/c[2],c[2]]:null;
}
function poseFromEssential(E,p1,p2,indices){
 let {U,V}=svd3(E);
 if(det3(U)<0)U=U.map(v=>-v);if(det3(V)<0)V=V.map(v=>-v);
 const W=[0,-1,0,1,0,0,0,0,1],t=[U[2],U[5],U[8]];
 const first={R:I3(),t:[0,0,0]};let best=null,bestCount=-1;
 for(const R of [mm(mm(U,W),mt(V)),mm(mm(U,mt(W)),mt(V))])for(const sign of [1,-1]){
   const pose={R,t:scale(t,sign)};let count=0;
   for(const k of indices){const X=triangulate([first,pose],[p1[k],p2[k]]);
     if(X&&X[2]>0&&projectNormalized(pose,X))count++;}
   if(count>bestCount){bestCount=count;best=pose;}
 }
 return best;
}

// Robust (Huber) residual and Jacobian of one pixel observation.
function huber(e,k){return e<=k?{w:1,rho:e*e}:{w:k/e,rho:2*k*e-k*k};}
function pixelResidual(pose,X,focal,o){
 const Xc=plus(mv(pose.R,X),pose.t);if(Xc[2]<=1e-9)return null;
 const a=[Xc[0]/Xc[2],Xc[1]/Xc[2]];
 return {Xc,a,r:[focal*a[0]-o.dx,focal*a[1]-o.dy]};
}
// d(pixel)/d(camera-space point): 2x3 row-major.
const projectionJacobian=(focal,Xc,a)=>{const s=focal/Xc[2];return [s,0,-s*a[0],0,s,-s*a[1]];};
const mul23x33=(J,M)=>{const out=new Array(6);for(let r=0;r<2;r++)for(let c=0;c<3;c++)
 out[r*3+c]=J[r*3]*M[c]+J[r*3+1]*M[3+c]+J[r*3+2]*M[6+c];return out;};
// Left-perturbation rotation Jacobian: d(exp(w) R X)/dw = -[RX]x.
const negSkew=v=>[0,v[2],-v[1],-v[2],0,v[0],v[1],-v[0],0];

function refinePose(start,matches,focal,huberPx,iterations=25){
 let pose={R:start.R.slice(),t:start.t.slice()},lambda=1e-3;
 const cost=p=>{let c=0;for(const m of matches){const res=pixelResidual(p,m.X,focal,m.o);
   c+=res?huber(Math.hypot(res.r[0],res.r[1]),huberPx).rho:1e6;}return c;};
 let current=cost(pose);
 for(let it=0;it<iterations;it++){
   const H=new Float64Array(36),g=new Float64Array(6);
   for(const m of matches){
     const res=pixelResidual(pose,m.X,focal,m.o);if(!res)continue;
     const {w}=huber(Math.hypot(res.r[0],res.r[1]),huberPx),Jp=projectionJacobian(focal,res.Xc,res.a);
     const Jw=mul23x33(Jp,negSkew(minus(res.Xc,pose.t)));
     for(let r=0;r<2;r++){
       const row=[Jw[r*3],Jw[r*3+1],Jw[r*3+2],Jp[r*3],Jp[r*3+1],Jp[r*3+2]];
       for(let i=0;i<6;i++){g[i]+=w*row[i]*res.r[r];for(let j=0;j<6;j++)H[i*6+j]+=w*row[i]*row[j];}
     }
   }
   let improved=false;
   for(let attempt=0;attempt<8&&!improved;attempt++){
     const D=Float64Array.from(H);for(let i=0;i<6;i++)D[i*7]+=lambda*(H[i*7]+1e-9)+1e-12;
     const step=solveSPD(D,g.map(v=>-v),6);
     if(step){
       const next={R:mm(rotationFromVector([step[0],step[1],step[2]]),pose.R),t:plus(pose.t,[step[3],step[4],step[5]])};
       const c=cost(next);
       if(c<current){const gain=current-c;pose=next;current=c;lambda=Math.max(1e-9,lambda/4);improved=true;
         if(gain<1e-9*(current+1e-9))return pose;continue;}
     }
     lambda*=8;
   }
   if(!improved)break;
 }
 return pose;
}
// Linear PnP from at least six 3D-2D matches (normalized coordinates).
function poseDLT(matches){
 const m=matches.reduce((s,x)=>plus(s,x.X),[0,0,0]).map(v=>v/matches.length);
 const s=Math.max(1e-9,median(matches.map(x=>norm(minus(x.X,m)))));
 const A=new Float64Array(144);
 for(const {X,n} of matches){
   const P=[...scale(minus(X,m),1/s),1];
   for(const row of [[...P,0,0,0,0,...P.map(v=>-n[0]*v)],[0,0,0,0,...P,...P.map(v=>-n[1]*v)]])
     for(let i=0;i<12;i++)for(let j=0;j<12;j++)A[i*12+j]+=row[i]*row[j];
 }
 let p=column(symmetricEigen(A,12),12,0);
 const depth=matches.reduce((sum,{X})=>{const P=[...scale(minus(X,m),1/s),1];
   return sum+Math.sign(p[8]*P[0]+p[9]*P[1]+p[10]*P[2]+p[11]);},0);
 if(depth<0)p=p.map(v=>-v);
 const M=[p[0],p[1],p[2],p[4],p[5],p[6],p[8],p[9],p[10]],{U,S,V}=svd3(M);
 const R=mm(U,mt(V));if(det3(R)<0)return null;
 const lam=(S[0]+S[1]+S[2])/3,tp=[p[3]/lam,p[7]/lam,p[11]/lam];
 return {R,t:minus(scale(tp,s),mv(R,m))};
}
function inlierCount(pose,matches,focal,thresholdPx){
 let n=0;for(const x of matches){const res=pixelResidual(pose,x.X,focal,x.o);
   if(res&&Math.hypot(res.r[0],res.r[1])<thresholdPx)n++;}return n;
}
function solvePnP(init,matches,focal,opts,random){
 let pose=refinePose(init,matches,focal,opts.huberPx);
 let count=inlierCount(pose,matches,focal,opts.inlierPx);
 if(count>=Math.max(8,matches.length*.6)||matches.length<8)return {pose,count};
 for(let it=0;it<80;it++){
   const sample=new Set();while(sample.size<6)sample.add(Math.floor(random()*matches.length));
   const guess=poseDLT([...sample].map(i=>matches[i]));if(!guess)continue;
   const c=inlierCount(guess,matches,focal,opts.inlierPx*2);
   if(c>count){const refined=refinePose(guess,matches,focal,opts.huberPx);
     const rc=inlierCount(refined,matches,focal,opts.inlierPx);
     if(rc>count){pose=refined;count=rc;}}
 }
 return {pose,count};
}

// Sparse Levenberg-Marquardt bundle adjustment with a Schur complement over
// points. Optionally refines one shared focal length. Frame 0 fixes the gauge;
// the free global scale is held by damping and resolved later by fitting.
function bundleAdjust(state,{iterations=12,huberPx,optimizeFocal=false,fixed}){
 const frames=[...state.poses.keys()].filter(f=>!fixed.has(f)).sort((a,b)=>a-b);
 const camIndex=new Map(frames.map((f,i)=>[f,i])),nf=optimizeFocal?1:0,nc=frames.length*6+nf;
 const byPoint=new Map();
 for(const o of state.obs){
   if(o.outlier||!state.poses.has(o.frame)||!state.points.has(o.id))continue;
   if(!byPoint.has(o.id))byPoint.set(o.id,[]);byPoint.get(o.id).push(o);
 }
 const cost=(poses,points,focal)=>{let c=0;for(const [id,list] of byPoint)for(const o of list){
   const res=pixelResidual(poses.get(o.frame),points.get(id),focal,o);
   c+=res?huber(Math.hypot(res.r[0],res.r[1]),huberPx).rho:1e6;}return c;};
 let current=cost(state.poses,state.points,state.focal),lambda=1e-4;
 for(let it=0;it<iterations;it++){
   const A=new Float64Array(nc*nc),gc=new Float64Array(nc),blocks=[];
   for(const [id,list] of byPoint){
     const X=state.points.get(id),C=new Float64Array(9),gp=new Float64Array(3),entries=[];
     for(const o of list){
       const pose=state.poses.get(o.frame),res=pixelResidual(pose,X,state.focal,o);if(!res)continue;
       const {w}=huber(Math.hypot(res.r[0],res.r[1]),huberPx),Jp=projectionJacobian(state.focal,res.Xc,res.a);
       const Jx=mul23x33(Jp,pose.R),idx=[],rows=[[],[]];
       if(camIndex.has(o.frame)){
         const base=camIndex.get(o.frame)*6,Jw=mul23x33(Jp,negSkew(minus(res.Xc,pose.t)));
         for(let k=0;k<6;k++)idx.push(base+k);
         for(let r=0;r<2;r++)rows[r].push(Jw[r*3],Jw[r*3+1],Jw[r*3+2],Jp[r*3],Jp[r*3+1],Jp[r*3+2]);
       }
       if(nf){idx.push(nc-1);rows[0].push(res.a[0]);rows[1].push(res.a[1]);}
       for(let r=0;r<2;r++){
         for(let i=0;i<3;i++){gp[i]+=w*Jx[r*3+i]*res.r[r];for(let j=0;j<3;j++)C[i*3+j]+=w*Jx[r*3+i]*Jx[r*3+j];}
         for(let i=0;i<idx.length;i++){gc[idx[i]]+=w*rows[r][i]*res.r[r];
           for(let j=0;j<idx.length;j++)A[idx[i]*nc+idx[j]]+=w*rows[r][i]*rows[r][j];}
       }
       if(idx.length){
         const E=new Float64Array(idx.length*3);
         for(let i=0;i<idx.length;i++)for(let j=0;j<3;j++)
           E[i*3+j]=w*(rows[0][i]*Jx[j]+rows[1][i]*Jx[3+j]);
         entries.push({idx,E});
       }
     }
     blocks.push({id,C,gp,entries});
   }
   let improved=false;
   for(let attempt=0;attempt<8&&!improved;attempt++){
     const S=Float64Array.from(A),b=gc.map(v=>-v),solved=[];
     for(let i=0;i<nc;i++)S[i*nc+i]+=lambda*(A[i*nc+i]+1e-9)+1e-12;
     let ok=true;
     for(const blk of blocks){
       const C=Array.from(blk.C);for(let i=0;i<3;i++)C[i*4]+=lambda*(blk.C[i*4]+1e-9)+1e-12;
       const Ci=inverse3(C);if(!Ci){ok=false;break;}
       const F=blk.entries.map(e=>{const out=new Float64Array(e.idx.length*3);
         for(let i=0;i<e.idx.length;i++)for(let j=0;j<3;j++)
           out[i*3+j]=e.E[i*3]*Ci[j]+e.E[i*3+1]*Ci[3+j]+e.E[i*3+2]*Ci[6+j];return out;});
       blk.entries.forEach((e,a)=>{
         for(let i=0;i<e.idx.length;i++)b[e.idx[i]]+=F[a][i*3]*blk.gp[0]+F[a][i*3+1]*blk.gp[1]+F[a][i*3+2]*blk.gp[2];
         for(const e2 of blk.entries)for(let i=0;i<e.idx.length;i++)for(let j=0;j<e2.idx.length;j++)
           S[e.idx[i]*nc+e2.idx[j]]-=F[a][i*3]*e2.E[j*3]+F[a][i*3+1]*e2.E[j*3+1]+F[a][i*3+2]*e2.E[j*3+2];
       });
       solved.push(Ci);
     }
     const dc=ok?(nc?solveSPD(S,b,nc):new Float64Array(0)):null;
     if(dc){
       const poses=new Map(state.poses),points=new Map(state.points);
       for(const [f,i] of camIndex){const p=state.poses.get(f),d=dc.subarray(i*6,i*6+6);
         poses.set(f,{R:mm(rotationFromVector([d[0],d[1],d[2]]),p.R),t:plus(p.t,[d[3],d[4],d[5]])});}
       blocks.forEach((blk,k)=>{
         const rhs=[-blk.gp[0],-blk.gp[1],-blk.gp[2]];
         for(const e of blk.entries)for(let i=0;i<e.idx.length;i++)for(let j=0;j<3;j++)rhs[j]-=e.E[i*3+j]*dc[e.idx[i]];
         points.set(blk.id,plus(state.points.get(blk.id),mv(solved[k],rhs)));
       });
       const focal=nf?Math.max(50,state.focal+dc[nc-1]):state.focal;
       const c=cost(poses,points,focal);
       if(c<current){
         const gain=current-c;state.poses=poses;state.points=points;state.focal=focal;current=c;
         lambda=Math.max(1e-10,lambda/4);improved=true;
         if(gain<1e-7*current)return current;continue;
       }
     }
     lambda*=8;
   }
   if(!improved)break;
 }
 return current;
}

function prepare(input){
 const {width,height}=input;
 if(!(width>0&&height>0))throw Error('Track solve needs image width and height');
 const frameCount=input.frameCount??(1+Math.max(...input.tracks.flatMap(t=>t.obs.map(o=>o[0]))));
 if(!(frameCount>=2))throw Error('Track solve needs at least two frames');
 const cx=width/2,cy=height/2,obs=[],perFrame=Array.from({length:frameCount},()=>new Map());
 for(const track of input.tracks||[])for(const [frame,x,y] of track.obs){
   if(!Number.isInteger(frame)||frame<0||frame>=frameCount||!Number.isFinite(x)||!Number.isFinite(y))continue;
   const o={id:track.id,frame,dx:x-cx,dy:y-cy,outlier:false};obs.push(o);perFrame[frame].set(track.id,o);
 }
 return {width,height,frameCount,obs,perFrame};
}
const normalized=(o,focal)=>[o.dx/focal,o.dy/focal];
const bearing=(o,focal)=>unit([o.dx/focal,o.dy/focal,1]);

function rotationSolve(data,focal,opts){
 const random=seededRandom(opts.seed),poses=new Map([[0,{R:I3(),t:[0,0,0]}]]),dirs=new Map();
 for(const o of data.perFrame[0].values())dirs.set(o.id,bearing(o,focal));
 const residuals=[];
 for(let f=1;f<data.frameCount;f++){
   const a=[],b=[];
   for(const o of data.perFrame[f].values())if(dirs.has(o.id)){a.push(dirs.get(o.id));b.push(bearing(o,focal));}
   if(a.length<opts.minMatches)continue;
   const fit=fitRotation(a,b,focal,opts.inlierPx,random);
   poses.set(f,{R:fit.R,t:[0,0,0]});
   a.forEach((v,k)=>residuals.push(residualAngle(fit.R,v,b[k])*focal));
   for(const o of data.perFrame[f].values())if(!dirs.has(o.id))dirs.set(o.id,mv(mt(fit.R),bearing(o,focal)));
 }
 const inliers=residuals.filter(e=>e<opts.inlierPx*2);
 return {mode:'rotation',focal,poses,points:new Map(),
   rmsPx:inliers.length?Math.sqrt(inliers.reduce((s,e)=>s+e*e,0)/inliers.length):Infinity,
   medianPx:residuals.length?median(residuals):Infinity,inlierRatio:residuals.length?inliers.length/residuals.length:0};
}

function parallaxProbe(data,focal,opts){
 const random=seededRandom(opts.seed+7),probe=[];
 for(let f=1;f<data.frameCount;f++){
   const a=[],b=[];
   for(const o of data.perFrame[f].values()){const first=data.perFrame[0].get(o.id);
     if(first){a.push(bearing(first,focal));b.push(bearing(o,focal));}}
   if(a.length<opts.minMatches)continue;
   const fit=fitRotation(a,b,focal,opts.inlierPx,random);
   probe.push({frame:f,common:a.length,parallaxPx:fit.medianPx});
 }
 return probe;
}

function triangulateNew(state,data,opts){
 const byTrack=new Map();
 for(const o of state.obs)if(!o.outlier&&state.poses.has(o.frame)&&!state.points.has(o.id)){
   if(!byTrack.has(o.id))byTrack.set(o.id,[]);byTrack.get(o.id).push(o);}
 for(const [id,list] of byTrack){
   if(list.length<2)continue;
   const rays=list.map(o=>{const p=state.poses.get(o.frame);
     return {o,pose:p,c:cameraCenter(p),d:unit(mv(mt(p.R),[o.dx/state.focal,o.dy/state.focal,1]))};});
   let maxAngle=0;
   for(let i=0;i<rays.length;i++)for(let j=i+1;j<rays.length;j++)
     maxAngle=Math.max(maxAngle,Math.acos(Math.max(-1,Math.min(1,dot(rays[i].d,rays[j].d)))));
   if(maxAngle<opts.minTriangulationDeg*DEG)continue;
   const X=triangulate(rays.map(r=>r.pose),rays.map(r=>normalized(r.o,state.focal)));
   if(!X)continue;
   let good=true;
   for(const r of rays){const res=pixelResidual(r.pose,X,state.focal,r.o);
     if(!res||Math.hypot(res.r[0],res.r[1])>opts.inlierPx*2){good=false;break;}}
   if(good)state.points.set(id,X);
 }
}
function pruneOutliers(state,opts){
 const counts=new Map();
 for(const o of state.obs){
   if(!state.poses.has(o.frame)||!state.points.has(o.id))continue;
   const res=pixelResidual(state.poses.get(o.frame),state.points.get(o.id),state.focal,o);
   o.outlier=!res||Math.hypot(res.r[0],res.r[1])>opts.outlierPx;
   if(!o.outlier)counts.set(o.id,(counts.get(o.id)||0)+1);
 }
 for(const id of [...state.points.keys()])if((counts.get(id)||0)<2)state.points.delete(id);
}
function residualStats(state){
 const errors=[];
 for(const o of state.obs){
   if(o.outlier||!state.poses.has(o.frame)||!state.points.has(o.id))continue;
   const res=pixelResidual(state.poses.get(o.frame),state.points.get(o.id),state.focal,o);
   if(res)errors.push(Math.hypot(res.r[0],res.r[1]));
 }
 const total=state.obs.filter(o=>state.poses.has(o.frame)).length||1;
 return {rmsPx:errors.length?Math.sqrt(errors.reduce((s,e)=>s+e*e,0)/errors.length):Infinity,
   inlierRatio:errors.length/total,observations:errors.length};
}

function parallaxSolve(data,focal,initFrame,opts){
 const random=seededRandom(opts.seed);
 const p1=[],p2=[],ids=[];
 for(const o of data.perFrame[initFrame].values()){const first=data.perFrame[0].get(o.id);
   if(first){p1.push(normalized(first,focal));p2.push(normalized(o,focal));ids.push(o.id);}}
 const essential=estimateEssential(p1,p2,focal,opts.inlierPx,random);
 if(!essential||essential.inliers.length<opts.minMatches)return null;
 const second=poseFromEssential(essential.E,p1,p2,essential.inliers);
 const state={focal,poses:new Map([[0,{R:I3(),t:[0,0,0]}],[initFrame,second]]),points:new Map(),
   obs:data.obs.map(o=>({...o}))};
 for(const k of essential.inliers){
   const X=triangulate([state.poses.get(0),second],[p1[k],p2[k]]);
   if(X&&X[2]>0&&projectNormalized(second,X))state.points.set(ids[k],X);
 }
 if(state.points.size<opts.minMatches)return null;
 const fixed=new Set([0]);
 bundleAdjust(state,{iterations:10,huberPx:opts.huberPx,fixed});
 pruneOutliers(state,opts);
 // Fill the frames between the initial pair first, then continue forward.
 const order=[...Array(data.frameCount).keys()].filter(f=>f!==0&&f!==initFrame)
   .sort((a,b)=>((a>initFrame)-(b>initFrame))||a-b);
 let sinceBA=0;
 for(const f of order){
   const matches=[];
   for(const o of data.perFrame[f].values())if(state.points.has(o.id))
     matches.push({X:state.points.get(o.id),o,n:normalized(o,state.focal)});
   if(matches.length<opts.minMatches)continue;
   const posed=[...state.poses.keys()].sort((a,b)=>Math.abs(a-f)-Math.abs(b-f));
   const {pose,count}=solvePnP(state.poses.get(posed[0]),matches,state.focal,opts,random);
   if(count<Math.max(6,opts.minMatches*.5))continue;
   state.poses.set(f,pose);
   triangulateNew(state,data,opts);
   if(++sinceBA>=4){bundleAdjust(state,{iterations:6,huberPx:opts.huberPx,fixed});pruneOutliers(state,opts);sinceBA=0;}
 }
 bundleAdjust(state,{iterations:20,huberPx:opts.huberPx,fixed});
 pruneOutliers(state,opts);
 triangulateNew(state,data,opts);
 bundleAdjust(state,{iterations:opts.optimizeFocal?30:15,huberPx:opts.huberPx,optimizeFocal:opts.optimizeFocal,fixed});
 pruneOutliers(state,opts);
 return {mode:'parallax',focal:state.focal,poses:state.poses,points:state.points,initFrame,state,...residualStats(state)};
}

const DEFAULTS=Object.freeze({seed:1,inlierPx:3,huberPx:1.5,outlierPx:6,minMatches:12,
 rotationOnlyPx:2.5,minTriangulationDeg:1,fovCandidates:[35,55,75],defaultFov:50});

function solveWithFocal(data,focal,opts){
 const probe=parallaxProbe(data,focal,opts);
 const maxParallax=probe.length?Math.max(...probe.map(p=>p.parallaxPx)):0;
 if(maxParallax<opts.rotationOnlyPx)return {...rotationSolve(data,focal,opts),probe};
 // Prefer the largest rotation-compensated parallax that still shares tracks.
 const initial=data.perFrame[0].size||1;
 const best=probe.filter(p=>p.parallaxPx>=opts.rotationOnlyPx)
   .map(p=>({...p,score:Math.min(p.parallaxPx,40)*Math.min(1,p.common/Math.max(opts.minMatches*2,initial*.5))}))
   .sort((a,b)=>b.score-a.score)[0];
 const solved=best&&parallaxSolve(data,focal,best.frame,opts);
 return solved?{...solved,probe}:{...rotationSolve(data,focal,opts),probe,fallback:'no-stable-parallax-pair'};
}

/**
 * Solve a relative camera path from 2D feature tracks.
 * @param {{width:number,height:number,frameCount?:number,fov?:number,
 *   tracks:{id:string|number,obs:[number,number,number][]}[]}} input
 *   Observations are [frameIndex, xPixels, yPixels] (y down). `fov` is the
 *   vertical field of view in degrees when known; otherwise it is estimated.
 * @returns {{mode:'parallax'|'rotation'|'failed',fov:number,focal:number,
 *   poses:Map<number,{R:number[],t:number[]}>,points:Map,rmsPx:number,inlierRatio:number}}
 */
export function solveCameraTracks(input,options={}){
 const opts={...DEFAULTS,...options},data=prepare(input);
 const known=Number.isFinite(input.fov)&&input.fov>=5&&input.fov<=150;
 let result;
 if(known){
   result=solveWithFocal(data,focalFromFov(input.fov,data.height),{...opts,optimizeFocal:!!opts.refineFov});
 }else{
   // Pure rotation fits a rotation only at the right focal length, while
   // parallax never does: scan focal lengths before choosing the model.
   let scan=null;
   for(let fov=15;fov<=110;fov+=5){
     const probe=parallaxProbe(data,focalFromFov(fov,data.height),opts);
     const worst=probe.length?Math.max(...probe.map(p=>p.parallaxPx)):Infinity;
     if(!scan||worst<scan.worst)scan={fov,worst};
   }
   if(scan&&scan.worst<opts.rotationOnlyPx){
     let lo=Math.max(8,scan.fov-6),hi=Math.min(130,scan.fov+6);
     const cost=fov=>{const r=rotationSolve(data,focalFromFov(fov,data.height),opts);return r.medianPx/r.focal;};
     for(let i=0;i<18;i++){const a=lo+(hi-lo)*.382,b=lo+(hi-lo)*.618;if(cost(a)<cost(b))hi=b;else lo=a;}
     result=rotationSolve(data,focalFromFov((lo+hi)/2,data.height),opts);
     const span=Math.max(...[...result.poses.values()].map(p=>rotationAngle(p.R)))/DEG;
     // A (nearly) static camera does not reveal its lens: report the default.
     if(span<2)result=rotationSolve(data,focalFromFov(opts.defaultFov,data.height),opts);
     else result.fovEstimated=true;
   }else{
     const trials=opts.fovCandidates.map(fov=>solveWithFocal(data,focalFromFov(fov,data.height),{...opts,optimizeFocal:false}))
       .filter(r=>r.mode==='parallax'&&Number.isFinite(r.rmsPx));
     const best=trials.sort((a,b)=>(b.poses.size-a.poses.size)||(a.rmsPx-b.rmsPx))[0];
     if(best){
       const {state}=best,fixed=new Set([0]);
       bundleAdjust(state,{iterations:40,huberPx:opts.huberPx,optimizeFocal:true,fixed});
       pruneOutliers(state,opts);
       bundleAdjust(state,{iterations:15,huberPx:opts.huberPx,optimizeFocal:true,fixed});
       result={...best,focal:state.focal,poses:state.poses,points:state.points,...residualStats(state),fovEstimated:true};
     }
   }
 }
 if(!result||result.poses.size<2||!result.poses.has(0))
   return {mode:'failed',reason:'Too few consistent feature tracks',fov:known?input.fov:NaN,focal:NaN,
     poses:new Map(),points:new Map(),rmsPx:Infinity,inlierRatio:0,frameCount:data.frameCount};
 return {...result,fov:fovFromFocal(result.focal,data.height),width:data.width,height:data.height,
   frameCount:data.frameCount,fovEstimated:!!result.fovEstimated};
}

// ---- conversion to the reviewable videoCameraMotion estimate ----
function worldBasis(solve){
 const poses=[...solve.poses.entries()].sort((a,b)=>a[0]-b[0]).map(e=>e[1]),first=poses[0];
 // Assume no camera roll: every right vector is horizontal, so "up" is the
 // direction most perpendicular to all of them when they vary enough.
 const M=new Float64Array(9);
 for(const p of poses){const r=cameraRight(p);for(let i=0;i<3;i++)for(let j=0;j<3;j++)M[i*3+j]+=r[i]*r[j];}
 const eig=symmetricEigen(M,3);
 let up=cameraUp(first);
 if(eig.values[1]>.02*poses.length){const u=column(eig,3,0);up=dot(u,up)<0?scale(u,-1):u;}
 const fwd=cameraForward(first);let back=scale(minus(fwd,scale(up,dot(fwd,up))),-1);
 if(norm(back)<1e-6)back=cameraUp(first);
 back=unit(back);const x=unit(cross(up,back)),z=cross(x,up);
 return {x,y:up,z};
}
function pointDepths(solve,pose){
 const depths=[];
 for(const X of solve.points.values()){const p=projectNormalized(pose,X);
   if(p&&Math.abs(p[0])*solve.focal<solve.width*.6&&Math.abs(p[1])*solve.focal<solve.height*.6)depths.push(p[2]);}
 return depths;
}
function classify(keys,mode,rotationSpan){
 const p0=keys[0].p,p1=keys.at(-1).p;
 const travel=keys.slice(1).reduce((s,k,i)=>s+norm(minus(k.p,keys[i].p)),0);
 const look=keys.map(k=>unit(minus(k.t,k.p))),yaw=look.map(v=>Math.atan2(v[0],-v[2])),pitch=look.map(v=>Math.asin(Math.max(-1,Math.min(1,v[1])))) ;
 const span=a=>(Math.max(...a)-Math.min(...a))/DEG;
 if(mode==='rotation'||travel<.02){
   if(rotationSpan<.5&&travel<.02)return 'static';
   const dy=span(yaw),dp=span(pitch);
   return dy>2*dp?'pan':dp>2*dy?'tilt':'mixed';
 }
 const radii=keys.map(k=>norm(k.p)),meanR=radii.reduce((s,r)=>s+r,0)/radii.length;
 const azimuth=keys.map(k=>Math.atan2(k.p[0],k.p[2]));
 const spread=Math.sqrt(radii.reduce((s,r)=>s+(r-meanR)**2,0)/radii.length)/meanR;
 // An orbit turns the camera with its azimuth around the subject, at a
 // steady distance and height; a truck slides past without turning.
 const lift=Math.abs(p1[1]-p0[1])/meanR;
 if(span(azimuth)>12&&spread<.15&&lift<.2&&rotationSpan>.5*span(azimuth)&&
    look.every((v,i)=>dot(v,unit(scale(keys[i].p,-1)))>.85))return 'orbit';
 const d=minus(p1,p0),len=norm(d)||1,f=unit([look[0][0],0,look[0][2]]),r=unit(cross(f,[0,1,0]));
 const parts={forward:Math.abs(dot(d,f))/len,truck:Math.abs(dot(d,r))/len,pedestal:Math.abs(d[1])/len};
 const [name,share]=Object.entries(parts).sort((a,b)=>b[1]-a[1])[0];
 if(share<.8||rotationSpan>12)return 'mixed';
 return name==='forward'?(dot(d,f)>0?'push':'pull'):name;
}
// Choose up to `limit` frames so linear interpolation stays near the path.
function simplify(samples,limit,tolerance){
 const chosen=[0,samples.length-1];
 const err=(i)=>{const sorted=[...chosen].sort((a,b)=>a-b);let lo=sorted[0],hi=sorted.at(-1);
   for(const c of sorted){if(c<=i)lo=c;if(c>=i){hi=c;break;}}
   if(lo===hi)return 0;const u=(samples[i].u-samples[lo].u)/(samples[hi].u-samples[lo].u);
   const lerp=(a,b)=>a.map((v,k)=>v+(b[k]-v)*u);
   return Math.max(norm(minus(samples[i].p,lerp(samples[lo].p,samples[hi].p))),
     norm(minus(samples[i].t,lerp(samples[lo].t,samples[hi].t))));};
 while(chosen.length<Math.min(limit,samples.length)){
   let worst=-1,worstErr=tolerance;
   for(let i=0;i<samples.length;i++)if(!chosen.includes(i)){const e=err(i);if(e>worstErr){worst=i;worstErr=e;}}
   if(worst<0)break;chosen.push(worst);
 }
 return chosen.sort((a,b)=>a-b).map(i=>samples[i]);
}

/**
 * Convert a solve into validated `shots[].videoCameraMotion` (version 1):
 * Y up, subject center at the origin, one unit ~ the subject radius, the
 * initial camera on +Z. Uncertainty text is fixed template data, never prose.
 */
export function trackSolveToVideoMotion(solve,{start,end,times=null,maxKeys=11}={}){
 if(!solve||solve.mode==='failed'||!solve.poses?.has(0))throw Error('No usable camera track solve');
 const frames=[...solve.poses.keys()].sort((a,b)=>a-b);
 const last=solve.frameCount-1,timeOf=f=>times?times[f]:f/Math.max(1,last);
 const t0=timeOf(0),t1=timeOf(last);
 const basis=worldBasis(solve),first=solve.poses.get(0),toLocal=v=>[dot(v,basis.x),dot(v,basis.y),dot(v,basis.z)];
 let center,radius;
 if(solve.mode==='parallax'&&solve.points.size){
   const depth=median(pointDepths(solve,first))||1;
   center=plus(cameraCenter(first),scale(cameraForward(first),depth));
   radius=Math.max(1e-6,median([...solve.points.values()].map(X=>norm(minus(X,center)))));
 }else{center=scale(cameraForward(first),3);radius=1;}
 let samples=frames.map(f=>{
   const pose=solve.poses.get(f),c=cameraCenter(pose);
   const depths=solve.mode==='parallax'?pointDepths(solve,pose):[];
   const dist=depths.length?Math.max(.25*radius,median(depths)):norm(minus(center,c))||3*radius;
   return {u:f===0?0:f===last?1:(timeOf(f)-t0)/(t1-t0||1),
     p:toLocal(scale(minus(c,center),1/radius)),
     t:toLocal(scale(minus(plus(c,scale(cameraForward(pose),dist)),center),1/radius))};
 });
 samples[0].u=0;samples.at(-1).u=1;
 const extent=Math.max(...samples.flatMap(s=>[...s.p,...s.t].map(Math.abs)));
 const shrink=extent>29?29/extent:1;
 samples=samples.map(s=>({u:s.u,p:scale(s.p,shrink),t:scale(s.t,shrink)}));
 const rotationSpan=Math.max(...frames.map(f=>rotationAngle(mm(solve.poses.get(f).R,mt(first.R)))))/DEG;
 const type=classify(samples,solve.mode,rotationSpan);
 const fov=Math.min(110,Math.max(10,Math.round(solve.fov*100)/100));
 const round=v=>v.map(n=>Math.round(n*10000)/10000);
 let keys=['static'].includes(type)?[samples[0],{...samples[0],u:1}]:simplify(samples,maxKeys,.01);
 keys=keys.map(k=>({u:k.u,p:round(k.p),t:round(k.t),fov}));
 const confidence=Math.round(Math.max(.05,Math.min(.95,(1-Math.min(1,solve.rmsPx/4))*
   Math.min(1,solve.inlierRatio*1.2)*Math.min(1,(solve.mode==='parallax'?solve.points.size:40)/60)*
   Math.min(1,frames.length/(last+1)+.2)))*100)/100;
 const uncertainty=[
   `Feature-track solve (${solve.mode==='parallax'?'parallax':'rotation only'}): ${frames.length}/${last+1} frames posed`,
   solve.mode==='parallax'?`, ${solve.points.size} triangulated points`:'',
   `, reprojection RMS ${Number.isFinite(solve.rmsPx)?solve.rmsPx.toFixed(2):'n/a'} px`,
   solve.fovEstimated?`, vertical FOV estimated at ${fov.toFixed(1)} deg`:'',
   '. Scale and facing are relative; vertical assumes no camera roll.',
   shrink<1?' Path compressed to fit the estimate range.':'',
 ].join('');
 const value={version:1,start,end,type,confidence,uncertainty,keys};
 return {...validateVideoMotion(value,{start,end}),source:'feature-track'};
}
