// Local browser-only source sampling for mixed-media reference scenes.
// Existing authenticated PHP/Worker contracts require exactly three JPEG frames.
// No media URL or original file is sent to the Worker, only bounded JPEG samples.
import {referenceFrameTimes} from './environment-generation.js';
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
export function mediaFrameTimes(source,shot,playhead){
  if(!source||!shot||!['image','video'].includes(source.kind))
    throw Error('Reference scene is missing its image or video source. Relink files first.');
  const times=referenceFrameTimes(shot,playhead,shot.end);
  return times.map(at=>({at,sourceAt:source.kind==='image'?0:
    clamp(source.sourceIn+at-shot.start,source.sourceIn,source.sourceOut-.001)}));
}
function waitFor(target,event,timeoutMs=15000){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(Error('Reference media decoding timed out')),timeoutMs);
    const cleanup=()=>{clearTimeout(timer);target.removeEventListener(event,yes);target.removeEventListener('error',no);};
    const finish=error=>{cleanup();if(error)reject(error);else resolve();};
    const yes=()=>finish(),no=()=>finish(Error('Reference media could not be decoded'));
    target.addEventListener(event,yes,{once:true});
    target.addEventListener('error',no,{once:true});
  });
}
function paintFrame(canvas,drawable,width,height,fit){
  canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:false});
  if(!ctx)throw Error('Cannot create reference image canvas');
  const iw=drawable.videoWidth||drawable.naturalWidth||drawable.width;
  const ih=drawable.videoHeight||drawable.naturalHeight||drawable.height;
  if(!iw||!ih)throw Error('Reference image has invalid dimensions');
  const ratio=fit==='contain'?Math.min(width/iw,height/ih):Math.max(width/iw,height/ih);
  const w=iw*ratio,h=ih*ratio;
  ctx.fillStyle='#08131e';ctx.fillRect(0,0,width,height);
  ctx.drawImage(drawable,(width-w)/2,(height-h)/2,w,h);
}
function encodedFrame(canvas,drawable,fit,detailed){
  const widths=detailed?[768,640,480]:[640,480,384];
  for(const width of widths){
    paintFrame(canvas,drawable,width,Math.round(width*9/16),fit);
    for(const quality of [detailed?.78:.66,.58,.48]){
      const imageDataUrl=canvas.toDataURL('image/jpeg',quality);
      if(imageDataUrl.length<=460000)return imageDataUrl;
    }
  }
  throw Error('Reference frame is too large for the private gateway (460k characters).');
}
export async function sampleReferenceMedia(source,shot,playhead,detailProfile='standard'){
  if(!source?.url)throw Error('This reference scene is unlinked. Open Reference Builder and reattach its source.');
  const detailed=detailProfile==='primary';
  const schedule=mediaFrameTimes(source,shot,playhead);
  const canvas=document.createElement('canvas'),frames=[];
  let drawable;
  if(source.kind==='image'){
    drawable=document.createElement('img');
    const ready=waitFor(drawable,'load');
    drawable.src=source.url;await ready;
  }else{
    drawable=document.createElement('video');
    drawable.muted=true;drawable.playsInline=true;drawable.preload='auto';
    const loaded=waitFor(drawable,'loadedmetadata');
    drawable.src=source.url;
    await loaded;
    if(drawable.readyState<2)await waitFor(drawable,'loadeddata');
  }
  try{
    for(const point of schedule){
      if(source.kind==='video'&&Math.abs(drawable.currentTime-point.sourceAt)>.01){
        const seeked=waitFor(drawable,'seeked',12000);
        drawable.currentTime=point.sourceAt;
        await seeked;
      }
      frames.push({at:+point.at.toFixed(3),
        imageDataUrl:encodedFrame(canvas,drawable,source.fit,detailed)});
    }
    if(frames.length!==3)throw Error('Expected exactly three reference frames');
    if(frames.reduce((n,frame)=>n+frame.imageDataUrl.length,0)>1500000)
      throw Error('Reference images exceed authenticated gateway limits');
    return frames;
  }finally{
    if(source.kind==='video'){drawable.pause();drawable.removeAttribute('src');drawable.load();}
    else drawable.removeAttribute('src');
  }
}
