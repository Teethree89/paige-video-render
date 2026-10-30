// Local feature tracker for camera tracking: Shi-Tomasi corners followed with
// pyramidal Lucas-Kanade optical flow and a forward-backward consistency check.
// Pure (no DOM); runs in a Web Worker or Node. Frames never leave the browser.

/** RGBA (ImageData.data) -> luminance Float32Array (0..255). */
export function toGray(rgba,width,height){
 const out=new Float32Array(width*height);
 for(let i=0,j=0;i<out.length;i++,j+=4)out[i]=.299*rgba[j]+.587*rgba[j+1]+.114*rgba[j+2];
 return out;
}

function blur(src,w,h){
 // Separable [1 4 6 4 1]/16 Gaussian with clamped borders.
 const tmp=new Float32Array(w*h),out=new Float32Array(w*h),k=[1,4,6,4,1];
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){let s=0;
   for(let i=-2;i<=2;i++)s+=k[i+2]*src[y*w+Math.min(w-1,Math.max(0,x+i))];tmp[y*w+x]=s/16;}
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){let s=0;
   for(let i=-2;i<=2;i++)s+=k[i+2]*tmp[Math.min(h-1,Math.max(0,y+i))*w+x];out[y*w+x]=s/16;}
 return out;
}
function gradients(img,w,h){
 const gx=new Float32Array(w*h),gy=new Float32Array(w*h);
 for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
   // Scharr kernel: better rotational symmetry than central differences.
   const i=y*w+x,a=img[i-w-1],b=img[i-w],c=img[i-w+1],d=img[i-1],f=img[i+1],g=img[i+w-1],hh=img[i+w],k=img[i+w+1];
   gx[i]=(3*(c-a)+10*(f-d)+3*(k-g))/32;gy[i]=(3*(g-a)+10*(hh-b)+3*(k-c))/32;
 }
 return {gx,gy};
}
/** Gaussian pyramid with gradients per level. */
export function buildPyramid(gray,width,height,levels=3){
 const pyramid=[];let img=blur(gray,width,height),w=width,h=height;
 for(let l=0;l<levels;l++){
   pyramid.push({img,w,h,...gradients(img,w,h)});
   if(w<40||h<40||l===levels-1)break;
   const nw=w>>1,nh=h>>1,next=new Float32Array(nw*nh),smooth=blur(img,w,h);
   for(let y=0;y<nh;y++)for(let x=0;x<nw;x++)next[y*nw+x]=smooth[(2*y)*w+2*x];
   img=next;w=nw;h=nh;
 }
 return pyramid;
}
const sample=(data,w,h,x,y)=>{
 if(x<0)x=0;else if(x>w-1.001)x=w-1.001;if(y<0)y=0;else if(y>h-1.001)y=h-1.001;
 const x0=x|0,y0=y|0,fx=x-x0,fy=y-y0,i=y0*w+x0;
 return (data[i]*(1-fx)+data[i+1]*fx)*(1-fy)+(data[i+w]*(1-fx)+data[i+w+1]*fx)*fy;
};

/** Shi-Tomasi minimum-eigenvalue corners, spread by a minimum distance. */
export function detectCorners(level,{maxCorners=400,quality=.01,minDistance=10,border=8,avoid=[]}={}){
 const {w,h,gx,gy}=level,r=2,score=new Float32Array(w*h);let max=0;
 // Box-summed structure tensor via integral images.
 const integral=f=>{const s=new Float64Array((w+1)*(h+1));
   for(let y=0;y<h;y++){let row=0;for(let x=0;x<w;x++){row+=f(y*w+x);s[(y+1)*(w+1)+x+1]=s[y*(w+1)+x+1]+row;}}return s;};
 const sxx=integral(i=>gx[i]*gx[i]),syy=integral(i=>gy[i]*gy[i]),sxy=integral(i=>gx[i]*gy[i]);
 const box=(s,x,y)=>s[(y+r+1)*(w+1)+x+r+1]-s[(y-r)*(w+1)+x+r+1]-s[(y+r+1)*(w+1)+x-r]+s[(y-r)*(w+1)+x-r];
 for(let y=border;y<h-border;y++)for(let x=border;x<w-border;x++){
   const a=box(sxx,x,y),c=box(syy,x,y),b=box(sxy,x,y);
   const v=(a+c)/2-Math.sqrt(((a-c)/2)**2+b*b);score[y*w+x]=v;if(v>max)max=v;
 }
 const threshold=max*quality,candidates=[];
 for(let y=border;y<h-border;y++)for(let x=border;x<w-border;x++){
   const i=y*w+x,v=score[i];if(v<=threshold)continue;
   // 3x3 local maximum only.
   if(v<score[i-1]||v<score[i+1]||v<score[i-w]||v<score[i+w]||v<score[i-w-1]||v<score[i-w+1]||v<score[i+w-1]||v<score[i+w+1])continue;
   candidates.push(i);
 }
 candidates.sort((a,b)=>score[b]-score[a]);
 const cell=Math.max(1,minDistance),gw=Math.ceil(w/cell),gh=Math.ceil(h/cell),grid=Array.from({length:gw*gh},()=>[]);
 const near=(x,y)=>{const cx=Math.floor(x/cell),cy=Math.floor(y/cell);
   for(let j=Math.max(0,cy-1);j<=Math.min(gh-1,cy+1);j++)for(let i=Math.max(0,cx-1);i<=Math.min(gw-1,cx+1);i++)
     for(const [px,py] of grid[j*gw+i])if((px-x)**2+(py-y)**2<minDistance*minDistance)return true;return false;};
 const add=(x,y)=>grid[Math.min(gh-1,Math.floor(y/cell))*gw+Math.min(gw-1,Math.floor(x/cell))].push([x,y]);
 for(const [x,y] of avoid)if(x>=0&&y>=0&&x<w&&y<h)add(x,y);
 const corners=[];
 for(const i of candidates){
   if(corners.length>=maxCorners)break;
   const x=i%w,y=(i/w)|0;if(near(x,y))continue;
   add(x,y);corners.push([x,y]);
 }
 return corners;
}

/** Pyramidal Lucas-Kanade (Bouguet). Returns the point in `next` or null. */
export function trackPoint(prev,next,x,y,{win=7,iterations=20,epsilon=.01,minEigen=1e-3}={}){
 let gx=0,gy=0;
 const n=(2*win+1)**2,I=new Float32Array(n),Ix=new Float32Array(n),Iy=new Float32Array(n);
 for(let level=prev.length-1;level>=0;level--){
   const P=prev[level],Q=next[level],s=1/(1<<level),px=x*s,py=y*s;
   let a=0,b=0,c=0,k=0;
   for(let dy=-win;dy<=win;dy++)for(let dx=-win;dx<=win;dx++,k++){
     I[k]=sample(P.img,P.w,P.h,px+dx,py+dy);
     const ix=sample(P.gx,P.w,P.h,px+dx,py+dy),iy=sample(P.gy,P.w,P.h,px+dx,py+dy);
     Ix[k]=ix;Iy[k]=iy;a+=ix*ix;b+=ix*iy;c+=iy*iy;
   }
   const det=a*c-b*b,eig=((a+c)/2-Math.sqrt(((a-c)/2)**2+b*b))/n;
   if(eig<minEigen||Math.abs(det)<1e-9)return null;
   let vx=0,vy=0;
   for(let it=0;it<iterations;it++){
     let bx=0,by=0;k=0;
     for(let dy=-win;dy<=win;dy++)for(let dx=-win;dx<=win;dx++,k++){
       const diff=I[k]-sample(Q.img,Q.w,Q.h,px+gx+vx+dx,py+gy+vy+dy);
       bx+=diff*Ix[k];by+=diff*Iy[k];
     }
     const ex=(c*bx-b*by)/det,ey=(a*by-b*bx)/det;
     vx+=ex;vy+=ey;
     if(ex*ex+ey*ey<epsilon*epsilon)break;
   }
   if(level>0){gx=2*(gx+vx);gy=2*(gy+vy);}else{gx+=vx;gy+=vy;}
 }
 const nx=x+gx,ny=y+gy,W=next[0].w,H=next[0].h;
 if(!Number.isFinite(nx)||!Number.isFinite(ny)||nx<win||ny<win||nx>W-1-win||ny>H-1-win)return null;
 return [nx,ny];
}

export const TRACKER_DEFAULTS=Object.freeze({maxFeatures:400,minDistance:10,quality:.01,levels:3,win:7,
 forwardBackwardPx:.8,redetectBelow:.7});

/**
 * Incremental tracker: feed grayscale frames in order, then read the tracks
 * in the solver's format ({id, obs:[[frame,x,y],...]}).
 */
export function createFeatureTracker(options={}){
 const opts={...TRACKER_DEFAULTS,...options};
 let previous=null,frame=-1,nextId=0,width=0,height=0;
 const active=new Map(),tracks=new Map(),stats=[];
 function detect(pyramid){
   const avoid=[...active.values()].map(t=>t.at);
   const want=opts.maxFeatures-active.size;if(want<=0)return 0;
   const found=detectCorners(pyramid[0],{maxCorners:want,quality:opts.quality,minDistance:opts.minDistance,
     border:opts.win+2,avoid});
   for(const [x,y] of found){
     const id='f'+(nextId++),track={id,obs:[[frame,x,y]]};
     tracks.set(id,track);active.set(id,{track,at:[x,y]});
   }
   return found.length;
 }
 return {
   addFrame(gray,w,h){
     if(frame>=0&&(w!==width||h!==height))throw Error('Tracked frames must keep one size');
     width=w;height=h;frame++;
     const pyramid=buildPyramid(gray,w,h,opts.levels);
     let kept=0,lost=0;
     if(previous){
       for(const [id,item] of active){
         const [x,y]=item.at,fwd=trackPoint(previous,pyramid,x,y,opts);
         const back=fwd&&trackPoint(pyramid,previous,fwd[0],fwd[1],opts);
         if(!back||Math.hypot(back[0]-x,back[1]-y)>opts.forwardBackwardPx){active.delete(id);lost++;continue;}
         item.at=fwd;item.track.obs.push([frame,+fwd[0].toFixed(3),+fwd[1].toFixed(3)]);kept++;
       }
     }
     const added=active.size<opts.maxFeatures*opts.redetectBelow||!previous?detect(pyramid):0;
     previous=pyramid;
     const entry={frame,kept,lost,added,active:active.size};stats.push(entry);
     return entry;
   },
   get frameCount(){return frame+1;},
   get size(){return {width,height};},
   stats:()=>stats.slice(),
   tracks:()=>[...tracks.values()].filter(t=>t.obs.length>=2),
 };
}

/**
 * Keep at most `maxFrames` evenly spaced frames (first and last included) and
 * re-index the tracks onto them, so the solver works on keyframes while the
 * tracker follows every sampled frame.
 */
export function selectKeyframes(tracks,frameCount,maxFrames=30){
 const count=Math.min(frameCount,maxFrames),chosen=[];
 for(let i=0;i<count;i++)chosen.push(Math.round(i*(frameCount-1)/Math.max(1,count-1)));
 const index=new Map([...new Set(chosen)].map((f,i)=>[f,i]));
 const out=[];
 for(const t of tracks){
   const obs=t.obs.filter(o=>index.has(o[0])).map(o=>[index.get(o[0]),o[1],o[2]]);
   if(obs.length>=2)out.push({id:t.id,obs});
 }
 return {tracks:out,frames:[...index.keys()],frameCount:index.size};
}
