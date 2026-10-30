// Rectangle pins for the camera tracking wizard: the four corners of a flat rectangle (a facade, a
// window, a floor tile), marked in the video with four clicks and matched on the model with ONE click
// on the face. Four corners on one plane fix the camera on their own. Pure and deterministic: no DOM.

const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=v=>{const l=Math.hypot(v[0],v[1],v[2])||1;return [v[0]/l,v[1]/l,v[2]/l];};
export const RECT_CORNERS=4;

function hull2d(points){
 const p=[...points].sort((a,b)=>a.u-b.u||a.v-b.v);
 if(p.length<3)return p;
 const turn=(o,a,b)=>(a.u-o.u)*(b.v-o.v)-(a.v-o.v)*(b.u-o.u);
 const lower=[],upper=[];
 for(const q of p){while(lower.length>=2&&turn(lower.at(-2),lower.at(-1),q)<=0)lower.pop();lower.push(q);}
 for(const q of [...p].reverse()){while(upper.length>=2&&turn(upper.at(-2),upper.at(-1),q)<=0)upper.pop();upper.push(q);}
 return lower.slice(0,-1).concat(upper.slice(0,-1)); // counter-clockwise in (u,v)
}
const area2d=q=>Math.abs(q.reduce((s,a,i)=>{const b=q[(i+1)%q.length];return s+a.u*b.v-b.u*a.v;},0))/2;

/**
 * The four corners of the flat face under a model click.
 * @param {number[][]} vertices world positions of the clicked shape's vertices
 * @param {number[]} normal world normal of the clicked triangle
 * @param {number[]} origin a point on the face (the click)
 * @returns {number[][]|null} 4 corners in order around the face (counter-clockwise seen from the front), or null
 *   when the face has fewer than 4 corners or is not close to a quadrilateral (a disc, a triangle).
 */
export function faceQuad(vertices,normal,origin){
 if(!Array.isArray(vertices)||vertices.length<4)return null;
 const n=norm(normal);
 let span=0;for(const v of vertices)span=Math.max(span,Math.abs(v[0]-origin[0]),Math.abs(v[1]-origin[1]),Math.abs(v[2]-origin[2]));
 const eps=Math.max(1e-6,span*1e-4);
 const a=Math.abs(n[0])<.9?[1,0,0]:[0,1,0],u=norm(cross(a,n)),w=cross(n,u);
 const seen=new Map(),flat=[];
 for(const X of vertices){
   const d=sub(X,origin);if(Math.abs(dot(d,n))>eps)continue;
   const p={u:dot(d,u),v:dot(d,w),X};
   const key=Math.round(p.u/eps)+','+Math.round(p.v/eps);
   if(!seen.has(key)){seen.set(key,1);flat.push(p);}
 }
 let hull=hull2d(flat);
 if(hull.length<RECT_CORNERS)return null;
 if(hull.length>24){const step=hull.length/24;hull=Array.from({length:24},(_,i)=>hull[Math.floor(i*step)]);}
 let best=null;
 const n4=hull.length;
 for(let i=0;i<n4;i++)for(let j=i+1;j<n4;j++)for(let k=j+1;k<n4;k++)for(let l=k+1;l<n4;l++){
   const q=[hull[i],hull[j],hull[k],hull[l]],s=area2d(q);
   if(!best||s>best.s)best={q,s};
 }
 // A face with many corners (a disc, an octagon) is not a rectangle: the best four must cover most of it.
 if(!best||best.s<area2d(hull)*.9)return null;
 return best.q.map(p=>p.X);
}

// The 8 ways four corners can be laid onto four others: 4 starting corners, 2 directions.
export const QUAD_ORDERS=Object.freeze([0,1,2,3].flatMap(s=>[[0,1,2,3].map(i=>(s+i)%4),[0,1,2,3].map(i=>(s+4-i)%4)]));

function normalize(quad){
 const cx=quad.reduce((s,p)=>s+p.x,0)/4,cy=quad.reduce((s,p)=>s+p.y,0)/4;
 const r=Math.sqrt(quad.reduce((s,p)=>s+(p.x-cx)**2+(p.y-cy)**2,0)/4)||1;
 return quad.map(p=>({x:(p.x-cx)/r,y:(p.y-cy)/r}));
}
/**
 * Rank the 8 orders that lay model corners onto the video corners, best first, by how alike the
 * video quad and the model face look from the current 3D view (a person orbits roughly to the shot).
 * @param {{x:number,y:number}[]} video the 4 video corners in click order (any pixel units)
 * @param {{x:number,y:number}[]} screen the 4 model corners projected into the 3D view (pixels, y down)
 * @returns {{order:number[],cost:number}[]} order[i] is the model corner for video corner i
 */
export function rankQuadOrders(video,screen){
 const a=normalize(video),b=normalize(screen);
 return QUAD_ORDERS.map(order=>({order,cost:a.reduce((s,p,i)=>s+(p.x-b[order[i]].x)**2+(p.y-b[order[i]].y)**2,0)}))
   .sort((x,y)=>x.cost-y.cost);
}

/** Video quad outline problems worth telling the person about (corners crossing, a sliver). */
export function quadProblem(quad){
 if(quad.length!==4)return null;
 const c=quad.map((p,i)=>{const a=quad[(i+3)%4],b=quad[(i+1)%4];return (p.x-a.x)*(b.y-p.y)-(p.y-a.y)*(b.x-p.x);});
 if(!(c.every(v=>v>0)||c.every(v=>v<0)))return 'crossed';
 const area=Math.abs(quad.reduce((s,a,i)=>{const b=quad[(i+1)%4];return s+a.x*b.y-b.x*a.y;},0))/2;
 const perim=quad.reduce((s,a,i)=>{const b=quad[(i+1)%4];return s+Math.hypot(b.x-a.x,b.y-a.y);},0);
 return area<perim*perim*.01?'thin':null;
}
