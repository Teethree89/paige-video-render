// Local video access for the camera-tracking wizard: frame loading for the
// pinning steps, the anchored tracking run (forward and backward from the
// reference frame) in a Web Worker, and the Motion-tab panel that opens the
// wizard. Frames never leave this browser; nothing is uploaded.
import {trackingFrameTimes,mergeAnchoredPasses,MIN_TRACK_FRAMES} from './camera-track-pipeline.js';
import {savedVideoMotion} from './video-camera-motion.js';
import {toGray} from './feature-tracker.js';

const TRACK_WIDTH=480;

function waitFor(target,event,timeoutMs){
 return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>done(Error('Video decoding timed out')),timeoutMs);
   const ok=()=>done(),fail=()=>done(Error('The source video could not be decoded'));
   function done(error){clearTimeout(timer);target.removeEventListener(event,ok);target.removeEventListener('error',fail);
     if(error)reject(error);else resolve();}
   target.addEventListener(event,ok,{once:true});target.addEventListener('error',fail,{once:true});
 });
}

/** Seek through `times` (source seconds) and hand each grayscale frame to onFrame. */
export async function sampleGrayFrames(url,times,{width=TRACK_WIDTH,signal,onFrame}){
 const video=document.createElement('video');
 video.muted=true;video.playsInline=true;video.preload='auto';video.src=url;
 try{
   await waitFor(video,'loadedmetadata',16000);
   if(video.readyState<2)await waitFor(video,'loadeddata',16000);
   const height=Math.max(64,Math.round(width*video.videoHeight/video.videoWidth/2)*2);
   const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
   const ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
   if(!ctx)throw Error('Cannot read video frames in this browser');
   for(let i=0;i<times.length;i++){
     if(signal?.aborted)throw Object.assign(Error('Tracking cancelled'),{cancelled:true});
     const at=Math.min(Math.max(0,times[i]),Math.max(0,video.duration-.001));
     if(Math.abs(video.currentTime-at)>.0005){const seeked=waitFor(video,'seeked',12000);video.currentTime=at;await seeked;}
     // A source that cannot seek would silently repeat one frame and look like a static camera.
     if(Math.abs(video.currentTime-at)>.25)throw Error('The source video cannot seek to this chapter');
     ctx.drawImage(video,0,0,width,height);
     await onFrame(toGray(ctx.getImageData(0,0,width,height).data,width,height),i,{width,height});
   }
   return {width,height};
 }finally{video.pause();video.removeAttribute('src');video.load();}
}

/**
 * Scrubbable frame source for the pinning steps. `frame(time)` returns a canvas
 * (for display) plus its grayscale pixels (for corner snapping).
 */
export async function createFrameLoader(url,{maxWidth=1280}={}){
 const video=document.createElement('video');
 video.muted=true;video.playsInline=true;video.preload='auto';video.src=url;
 await waitFor(video,'loadedmetadata',16000);
 if(video.readyState<2)await waitFor(video,'loadeddata',16000);
 const width=Math.min(maxWidth,video.videoWidth),height=Math.max(2,Math.round(width*video.videoHeight/video.videoWidth));
 let queue=Promise.resolve();
 return {
   width,height,duration:video.duration,
   frame(time){
     const task=queue.then(async()=>{
       const at=Math.min(Math.max(0,time),Math.max(0,video.duration-.001));
       if(Math.abs(video.currentTime-at)>.0005){const seeked=waitFor(video,'seeked',12000);video.currentTime=at;await seeked;}
       if(Math.abs(video.currentTime-at)>.25)throw Error('The source video cannot seek to this time');
       const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
       const ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
       ctx.drawImage(video,0,0,width,height);
       return {canvas,gray:toGray(ctx.getImageData(0,0,width,height).data,width,height),width,height,time:at};
     });
     queue=task.catch(()=>{});return task;
   },
   close(){video.pause();video.removeAttribute('src');video.load();}
 };
}

/** Worker-backed session with an in-page fallback where module workers are unavailable. */
export async function openSession(options,{anchored=false}={}){
 let worker=null;
 try{worker=new Worker(new URL('./camera-track-worker.js',import.meta.url),{type:'module'});}catch{worker=null;}
 if(!worker){
   const {createTrackSession,createAnchoredSession}=await import('./camera-track-pipeline.js');
   const session=anchored?createAnchoredSession(options):createTrackSession(options);
   return {addFrame:(gray,time)=>Promise.resolve(session.addFrame(gray,time)),
     finish:()=>new Promise((resolve,reject)=>setTimeout(()=>{try{resolve(session.finish());}catch(e){reject(e);}},0)),
     close(){}};
 }
 const waiting=[];
 worker.onmessage=({data})=>{
   if(data.type==='solving')return;
   const next=waiting.shift();if(!next)return;
   if(data.type==='error')next.reject(Object.assign(Error(data.message),{summary:data.summary}));else next.resolve(data);
 };
 worker.onerror=event=>{event.preventDefault?.();while(waiting.length)waiting.shift().reject(Error('Tracking worker failed: '+(event.message||'unknown error')));};
 const call=(message,transfer=[])=>new Promise((resolve,reject)=>{waiting.push({resolve,reject});worker.postMessage(message,transfer);});
 await call({type:'start',options,anchored});
 return {
   addFrame:(gray,time,index)=>call({type:'frame',gray:gray.buffer,time,index},[gray.buffer]).then(d=>d.stats),
   finish:()=>call({type:'finish'}),
   close:()=>worker.terminate()
 };
}

/**
 * Track one chapter from the user's pinned points. Frames go forward and backward
 * from the reference frame (each pass in its own worker session); the pinned
 * points' 3D positions place the path in the model.
 * @param {{source:{url:string,toSourceTime:Function},chapter:{start:number,end:number},refTime:number,
 *   pins:{id:string,x:number,y:number,X:number[]}[],refPose:object,fov:number,signal?:AbortSignal,onProgress?:Function}} input
 *   Pin x/y are normalized (0..1) in the frame.
 */
export async function trackAnchored({source,chapter,refTime,pins,refPose,fov,signal,onProgress=()=>{}}){
 const all=trackingFrameTimes(chapter.start,chapter.end),spacing=(chapter.end-chapter.start)/Math.max(1,all.length-1);
 const forward=[refTime,...all.filter(t=>t>refTime+spacing/2)];
 const backward=[refTime,...all.filter(t=>t<refTime-spacing/2).reverse()];
 const passes=[['forward',forward],['backward',backward]].filter(([,t])=>t.length>=MIN_TRACK_FRAMES);
 if(!passes.length)throw Error('The reference frame is too close to the edges of this chapter to track. Pick a frame nearer the middle.');
 const total=passes.reduce((n,[,t])=>n+t.length,0),done={count:0},results={},problems=[];
 for(const [direction,times] of passes){
   let session=null;
   try{
     await sampleGrayFrames(source.url,times.map(source.toSourceTime),{signal,onFrame:async(gray,i,dims)=>{
       if(!session)session=await openSession({width:dims.width,height:dims.height,refPose,fov,
         seeds:pins.map(p=>({id:p.id,x:p.x*dims.width,y:p.y*dims.height,X:p.X}))},{anchored:true});
       const stats=await session.addFrame(gray,times[i],i);
       onProgress({phase:'tracking',frame:++done.count,frames:total,active:stats.active,direction});
     }});
     if(signal?.aborted)throw Object.assign(Error('Tracking cancelled'),{cancelled:true});
     onProgress({phase:'solving',frames:total,direction});
     results[direction]=await session.finish();
   }catch(error){
     if(error.cancelled)throw error;
     problems.push({direction,message:error.message,summary:error.summary||null});
   }finally{session?.close();}
 }
 const main=results.forward||results.backward;
 if(!main){const first=problems[0];throw Object.assign(Error(first.message),{summary:first.summary,problems});}
 const frames=mergeAnchoredPasses(results.forward||results.backward,results.forward?results.backward:null);
 return {frames,problems,passes:Object.fromEntries(Object.entries(results).map(([k,v])=>[k,v.summary])),
   scale:main.anchored.scale,anchorRmsPx:main.anchored.anchorRmsPx,seedsUsed:main.anchored.seedsUsed,
   rollDeg:main.anchored.rollDeg,mode:main.anchored.mode};
}

export function describeTrackSummary(summary){
 if(!summary)return '';
 return `${summary.frames} frames, ${summary.tracks} tracks, ${summary.posed??0}/${summary.keyframes??0} keyframes solved`+
   (summary.mode==='parallax'?`, ${summary.points} 3D points`:summary.mode?', rotation only':'')+
   (summary.rmsPx!=null?`, ${summary.rmsPx.toFixed(2)} px error`:'');
}

/**
 * Motion-tab panel: opens the tracking wizard and, for projects without an
 * attached video, lets the user choose a local video file for this tab only
 * (its 0:00 must match the timeline's 0:00).
 * @param {{getSequence:Function,getShot:Function,getSource:(shot:object)=>({url:string,toSourceTime:Function}|{reason:string}|null),
 *   canUseFile?:Function,canEdit:Function,onOpen:Function}} options
 */
export function setupCameraTracking({getSequence,getShot,getSource,canUseFile=()=>true,canEdit=()=>true,onOpen}){
 const $=id=>document.getElementById(id);
 const root=$('cameraTrackPanel'),start=$('cameraTrackStart'),status=$('cameraTrackStatus'),
   fileWrap=$('cameraTrackFileWrap'),fileInput=$('cameraTrackFile'),fileStatus=$('cameraTrackFileStatus');
 if(!root||!start)return null;
 let chosen=null,lastKey=null,applied='';
 const clock=t=>Math.floor(t/60)+':'+String(Math.floor(t%60)).padStart(2,'0');
 const tell=text=>{status.textContent=text;};
 /** The project's own source, else the file picked here (never for Reference Builder scenes). */
 function resolveSource(shot){
   const own=getSource(shot);
   if(own?.url||!chosen||!canUseFile())return own;
   if(shot.end>chosen.duration+.2)
     return {reason:`The chosen video (${chosen.name}, ${clock(chosen.duration)}) ends before this chapter does (${clock(shot.end)}). Its 0:00 must match the timeline's 0:00.`};
   return {url:chosen.url,toSourceTime:t=>t};
 }
 /** Cheap: only touches the DOM when the chapter, source or edit state changed. */
 function refresh(){
   const sequence=getSequence(),shot=getShot();
   if(!sequence||!shot){if(applied!=='none'){applied='none';root.hidden=true;}return;}
   const source=resolveSource(shot),usable=!!source?.url,editable=canEdit(),filePicker=canUseFile();
   const hasModel=!!sequence.primitiveScenes?.scenes?.some(s=>s.shotId===shot.id&&s.objects?.length);
   const saved=savedVideoMotion(shot),keyed=shot.cameraSync?.mode==='anchored-track';
   const state=[shot.id,usable,editable,filePicker,hasModel,keyed,chosen?.url||'',source?.reason||'',saved?.type||''].join('|');
   if(state===applied)return;
   applied=state;root.hidden=false;
   if(fileWrap)fileWrap.hidden=!filePicker;
   const ready=usable&&hasModel&&editable;
   start.disabled=!ready;
   const why=!usable?(source?.reason||(filePicker?'Choose the video this timeline came from (below) to track its camera.':'Attach this chapter\'s source video to track its camera.')):!hasModel?'This chapter needs a 3D model first: generate or build one, then come back to match points.':
     !editable?'Finish the active AI job or proposal first.':'';
   start.title=why||'Match points between the video and the 3D model, then track the camera';
   if(lastKey===state)return;
   lastKey=state;
   tell(why||(keyed?'This chapter\'s camera was tracked from pinned points. Open the tracker again to redo or adjust it.':
     'Not tracked yet. You will pin the same points in the video and on the model, then track the motion. Runs on this device; nothing is uploaded.'));
 }
 fileInput?.addEventListener('change',async()=>{
   const file=fileInput.files?.[0];fileInput.value='';
   if(!file)return;
   fileStatus.hidden=false;fileStatus.textContent='Checking video…';
   if(!file.type.startsWith('video/')&&!/\.(mp4|mov|webm)$/i.test(file.name)){
     fileStatus.textContent='Choose an MP4, MOV or WebM video.';return;}
   const url=URL.createObjectURL(file),probe=document.createElement('video');
   try{
     await new Promise((resolve,reject)=>{
       const timer=setTimeout(()=>reject(Error('Video metadata timed out.')),15000);
       probe.onloadedmetadata=()=>{clearTimeout(timer);resolve();};
       probe.onerror=()=>{clearTimeout(timer);reject(Error('The browser could not open this video.'));};
       probe.preload='metadata';probe.src=url;probe.load();
     });
     if(!Number.isFinite(probe.duration)||probe.duration<.5)throw Error('This video has no usable duration.');
     const old=chosen?.url;
     chosen={url,name:file.name,duration:probe.duration};
     if(old)URL.revokeObjectURL(old);
     const total=getSequence()?.duration;
     fileStatus.textContent=`Using ${file.name} (${clock(probe.duration)}) for tracking in this tab only; it is not saved or uploaded. Its 0:00 must match the timeline's 0:00.`+
       (Number.isFinite(total)&&Math.abs(probe.duration-total)>1?` Note: the timeline is ${clock(total)} long.`:'');
     lastKey=null;applied='';refresh();
   }catch(error){URL.revokeObjectURL(url);fileStatus.textContent='Could not use this video: '+error.message;}
   finally{probe.removeAttribute('src');probe.load();}
 });
 start.addEventListener('click',()=>{if(!start.disabled)onOpen();});
 refresh();
 return {refresh,resolveSource,tell};
}
