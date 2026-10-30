// "Track camera from video": decodes the chapter's local source video in this
// browser, tracks feature points and solves the camera in a Web Worker, then
// saves a validated shots[].videoCameraMotion estimate. Nothing is uploaded,
// and no camera keys change until the user previews and applies a sync.
import {trackingFrameTimes} from './camera-track-pipeline.js';
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

/** Worker-backed session with an in-page fallback where module workers are unavailable. */
async function openSession(options){
 let worker=null;
 try{worker=new Worker(new URL('./camera-track-worker.js',import.meta.url),{type:'module'});}catch{worker=null;}
 if(!worker){
   const {createTrackSession}=await import('./camera-track-pipeline.js');
   const session=createTrackSession(options);
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
 await call({type:'start',options});
 return {
   addFrame:(gray,time,index)=>call({type:'frame',gray:gray.buffer,time,index},[gray.buffer]).then(d=>d.stats),
   finish:()=>call({type:'finish'}),
   close:()=>worker.terminate()
 };
}

/**
 * Track one chapter. `source` = {url, toSourceTime(chapterSeconds)}.
 * Returns {motion, summary}; throws with `.cancelled` when aborted.
 */
export async function trackChapterCamera(shot,source,{signal,onProgress=()=>{},fov=null}={}){
 const times=trackingFrameTimes(shot.start,shot.end);
 let session=null,size=null;
 try{
   await sampleGrayFrames(source.url,times.map(source.toSourceTime),{signal,onFrame:async(gray,i,dims)=>{
     if(!session){size=dims;session=await openSession({width:dims.width,height:dims.height,start:shot.start,end:shot.end,
       ...(Number.isFinite(fov)?{fov}:{})});}
     const stats=await session.addFrame(gray,times[i],i);
     onProgress({phase:'tracking',frame:i+1,frames:times.length,active:stats.active});
   }});
   if(signal?.aborted)throw Object.assign(Error('Tracking cancelled'),{cancelled:true});
   onProgress({phase:'solving',frames:times.length});
   const {motion,summary}=await session.finish();
   return {motion,summary,size};
 }finally{session?.close();}
}

export function describeTrackSummary(summary){
 if(!summary)return '';
 const seg=summary.segment,trimmed=seg&&seg.frames<seg.total?`${seg.frames} of ${seg.total} frames continuous (the rest held still), `:'';
 return `${trimmed}${summary.frames} frames, ${summary.tracks} tracks, ${summary.posed??0}/${summary.keyframes??0} keyframes solved`+
   (summary.mode==='parallax'?`, ${summary.points} 3D points`:', rotation only')+
   (summary.rmsPx!==null?`, ${summary.rmsPx.toFixed(2)} px error`:'')+
   (summary.fov!=null?`, ${summary.fovEstimated?'estimated ':summary.fovAssumed?'assumed ':''}${summary.fov.toFixed(1)}° lens`:'');
}

/**
 * @param {{getSequence:Function,getShot:Function,getSource:(shot:object)=>({url:string,toSourceTime:Function}|{reason:string}|null),
 *   canEdit:Function,onSaved:(shotId:string,motion:object,summary:object)=>string|void,onBusy?:Function}} options
 */
export function setupCameraTracking({getSequence,getShot,getSource,canEdit=()=>true,onSaved,onBusy=()=>{}}){
 const $=id=>document.getElementById(id);
 const root=$('cameraTrackPanel'),start=$('cameraTrackStart'),cancel=$('cameraTrackCancel'),
   progress=$('cameraTrackProgress'),status=$('cameraTrackStatus');
 if(!root||!start)return null;
 let controller=null,lastKey=null;
 const tell=text=>{status.textContent=text;};
 let applied='';
 /** Cheap: only touches the DOM when the chapter, source or edit state changed. */
 function refresh(){
   const sequence=getSequence(),shot=getShot();
   if(!sequence||!shot){if(applied!=='none'){applied='none';root.hidden=true;}return;}
   const source=getSource(shot),usable=!!source?.url,editable=canEdit();
   const saved=savedVideoMotion(shot),key=shot.id+'|'+usable+'|'+(saved?.source||saved?.type||'');
   const state=[key,!source&&!shot.draft,!!controller,editable,source?.reason||''].join('|');
   if(state===applied)return;
   applied=state;
   root.hidden=!source&&!shot.draft;
   start.disabled=!!controller||!usable||!editable;
   start.title=usable?'Track feature points through this chapter on this device':(source?.reason||'Attach the source video first.');
   if(controller||lastKey===key)return;
   lastKey=key;
   tell(!usable?(source?.reason||'Attach this chapter\'s source video to track its camera.'):
     saved?.source==='feature-track'?`Tracked: ${saved.type} · ${Math.round(saved.confidence*100)}% confidence. Preview it under Sync accepted model camera.`:
     saved?'This chapter has an AI motion estimate. Tracking replaces it with a measured one.':
     'Not tracked yet. Runs locally; nothing is uploaded.');
 }
 async function run(){
   const shot=getShot(),source=shot&&getSource(shot);
   if(!shot||!source?.url||controller||!canEdit())return;
   const chapter={id:shot.id,start:shot.start,end:shot.end};
   controller=new AbortController();onBusy(true);
   start.disabled=true;cancel.hidden=false;progress.hidden=false;progress.removeAttribute('value');
   tell('Decoding frames…');
   try{
     const {motion,summary}=await trackChapterCamera(chapter,source,{signal:controller.signal,onProgress:p=>{
       if(p.phase==='tracking'){progress.max=p.frames;progress.value=p.frame;
         tell(`Tracking frame ${p.frame}/${p.frames} · ${p.active} points`);}
       else{progress.removeAttribute('value');tell(`Solving camera from ${p.frames} frames…`);}
     }});
     const now=getSequence()?.shots.find(s=>s.id===chapter.id);
     if(!now||now.start!==chapter.start||now.end!==chapter.end)throw Error('The chapter changed while tracking. Track it again.');
     const note=onSaved(chapter.id,motion,summary);
     // Keep this detailed result instead of the generic status line.
     const now2=getSequence()?.shots.find(s=>s.id===chapter.id);
     lastKey=chapter.id+'|true|'+(savedVideoMotion(now2)?.source||'');
     tell(`Tracked ${motion.type} · ${Math.round(motion.confidence*100)}% confidence (${describeTrackSummary(summary)}). `+(note||''));
   }catch(error){
     tell(error.cancelled?'Tracking cancelled. Nothing was saved.':
       `${error.message}${error.summary?' ('+describeTrackSummary(error.summary)+')':''}. Nothing was saved. `+
       'Very dark, blurry or textureless shots may not track; use AI motion analysis or keep the camera.');
   }finally{
     controller=null;onBusy(false);cancel.hidden=true;progress.hidden=true;refresh();
   }
 }
 start.addEventListener('click',run);
 cancel.addEventListener('click',()=>controller?.abort());
 refresh();
 return {refresh,run,isBusy:()=>!!controller};
}
