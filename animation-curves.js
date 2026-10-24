// Deterministic animation curves, including custom cubic Bezier easing.
// Camera curves are keyed on the source keyframe of each interpolation segment.
// Omitted curve = legacy smoothstep, preserving existing saved timelines.
export const CURVE_MODES=Object.freeze(['smooth','linear','ease-in','ease-out','hold','bezier']);
const bound=x=>Math.min(1,Math.max(0,x));
const bez=(p1,p2,t)=>3*p1*(1-t)**2*t+3*p2*(1-t)*t*t+t*t*t;
export function cubicEasing(u,handles=[.25,.1,.25,1]){
 if(!Array.isArray(handles)||handles.length!==4||handles.some(x=>!Number.isFinite(x)||x<0||x>1))
   throw Error('Animation handles must contain four values between 0 and 1');
 const [x1,y1,x2,y2]=handles;
 const target=bound(u);
 if(target===0||target===1)return target;
 let low=0,high=1;
 for(let i=0;i<24;i++){
   const mid=(low+high)/2;
   if(bez(x1,x2,mid)<target)low=mid;else high=mid;
 }
 return bound(bez(y1,y2,(low+high)/2));
}
export function curveEasing(u,curve=null){
 const t=bound(u),mode=typeof curve==='string'?curve:curve?.mode||'smooth';
 switch(mode){
 case 'linear':return t;
 case 'hold':return 0;
 case 'ease-in':return t*t;
 case 'ease-out':return 1-(1-t)*(1-t);
 case 'bezier':try{return cubicEasing(t,curve?.handles);}catch{return t*t*(3-2*t);}
 case 'smooth':default:return t*t*(3-2*t);
 }
}
export function evaluateCamera(keys,time){
 if(!Array.isArray(keys)||!keys.length)throw Error('Camera animation requires keys');
 const sorted=[...keys].sort((a,b)=>a.at-b.at);
 if(time<=sorted[0].at)return sorted[0];
 for(let i=0;i<sorted.length-1;i++){
   const a=sorted[i],b=sorted[i+1];
   if(time>=a.at&&time<b.at){
     if(b.cut||b.at<=a.at)return a;
     const t=curveEasing((time-a.at)/(b.at-a.at),a.curve);
     return {p:a.p.map((v,j)=>v+(b.p[j]-v)*t),
       t:a.t.map((v,j)=>v+(b.t[j]-v)*t),
       fov:a.fov+(b.fov-a.fov)*t};
   }
 }
 return sorted[sorted.length-1];
}
export function setCameraCurve(source,id,curve){
 const seq=structuredClone(source),key=seq.camera?.find(x=>x.id===id);
 if(!key)throw Error('Selected camera key does not exist');
 const mode=curve?.mode;
 if(!CURVE_MODES.includes(mode))throw Error('Unsupported interpolation mode');
 if(mode==='bezier')cubicEasing(.5,curve.handles);
 key.curve=mode==='bezier'?{mode,handles:curve.handles.map(x=>Math.round(x*1000)/1000)}:{mode};
 return seq;
}
