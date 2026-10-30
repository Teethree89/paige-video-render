// Clip iterations: every accepted 3D model, applied camera and tracked camera
// for a chapter is saved as a version of its source clip. The original clip
// file is never modified. Snapshots are validated timeline data only (no
// media, no provider text) and live in this browser next to their clip.
import {idbTransaction} from './local-media-store.js';
import {validatePrimitiveDocument} from './primitive-schema.js';
import {validateVideoMotion} from './video-camera-motion.js';
import {checkTimeline} from './timeline-operations.js';
import {chapterStatus} from './chapter-workflow.js';

export const ITERATION_KINDS=Object.freeze({
 geometry:'3D model accepted',camera:'Camera keys applied',track:'Camera tracked from video'});
export const MAX_ITERATIONS_PER_CLIP=25;
const MAX_SNAPSHOT_CHARS=600000;

const owns=(sequence,shot)=>{
 const last=sequence.shots.at(-1)?.id===shot.id;
 return k=>k.at>=shot.start-.0001&&(k.at<shot.end-.0001||(last&&k.at<=shot.end+.0001));
};

/** Library key of the clip a chapter came from, or null (original timeline / blank). */
export function clipKeyForShot(sequence,shotId){
 if(!sequence)return null;
 if(sequence.referenceSequence){
   const item=sequence.referenceSequence.items?.find(i=>i.id===shotId);
   return item?'reference:'+item.mediaId:null;
 }
 const id=sequence.videoIntake?.sourceId;
 return id&&sequence.shots.some(s=>s.id===shotId)?'video:'+id:null;
}
/** Chapter ids in the current timeline that use a clip. */
export function shotsForClip(sequence,clipKey){
 return (sequence?.shots||[]).filter(s=>clipKeyForShot(sequence,s.id)===clipKey).map(s=>s.id);
}

/** Snapshot one chapter as a reviewable version (geometry, camera keys, motion estimate). */
export function snapshotChapter(sequence,shotId,kind,{now=Date.now()}={}){
 if(!ITERATION_KINDS[kind])throw Error('Unknown iteration kind');
 const shot=sequence.shots.find(s=>s.id===shotId);
 if(!shot)throw Error('Unknown chapter');
 const scene=sequence.primitiveScenes?.scenes?.find(s=>s.shotId===shotId)||null;
 const camera=sequence.camera.filter(owns(sequence,shot)).map(k=>structuredClone(k));
 const snapshot={id:'it_'+now.toString(36)+'_'+Math.random().toString(36).slice(2,8),kind,at:now,
   shotId,chapter:{name:shot.name,start:shot.start,end:shot.end},
   scene:scene?structuredClone(scene):null,camera,
   motion:shot.videoCameraMotion?structuredClone(shot.videoCameraMotion):null,
   summary:{objects:scene?.objects?.length||0,lights:scene?.lights?.length||0,keys:camera.length,
     camera:chapterStatus(sequence,shot).camera,motion:shot.videoCameraMotion?.type||null}};
 if(JSON.stringify(snapshot).length>MAX_SNAPSHOT_CHARS){snapshot.scene=null;snapshot.summary.sceneOmitted=true;}
 return snapshot;
}

/**
 * Put a version back into its chapter. Returns a new sequence; the chapter must
 * still exist with the same start/end. Geometry and camera are restored together.
 */
export function restoreIteration(sequence,snapshot){
 const next=structuredClone(sequence),shot=next.shots.find(s=>s.id===snapshot?.shotId);
 if(!shot)throw Error('This chapter is not in the current project.');
 if(Math.abs(shot.start-snapshot.chapter.start)>.001||Math.abs(shot.end-snapshot.chapter.end)>.001)
   throw Error('The chapter was resized since this version; restore is disabled to keep timing intact.');
 if(snapshot.scene){
   const doc=next.primitiveScenes?structuredClone(next.primitiveScenes):{schemaVersion:1,scenes:[]};
   doc.scenes=[...(doc.scenes||[]).filter(s=>s.shotId!==shot.id),structuredClone(snapshot.scene)];
   next.primitiveScenes=validatePrimitiveDocument(doc,next.shots.map(s=>s.id));
 }
 if(snapshot.camera?.length){
   const mine=owns(next,shot),used=new Set(next.camera.filter(k=>!mine(k)).map(k=>k.id));
   const keys=snapshot.camera.map(k=>{const key=structuredClone(k);while(used.has(key.id))key.id+='_r';used.add(key.id);return key;});
   next.camera=[...next.camera.filter(k=>!mine(k)),...keys].sort((a,b)=>a.at-b.at);
 }
 if(snapshot.motion){
   try{shot.videoCameraMotion=validateVideoMotion(snapshot.motion,shot);}catch{delete shot.videoCameraMotion;}
 }
 checkTimeline(next);
 return next;
}

/**
 * Mapping status of a clip: from the current timeline when its chapters are
 * open, else from its saved versions.
 */
export function clipMappingStatus(sequence,clipKey,iterations=[]){
 const shots=shotsForClip(sequence,clipKey).map(id=>sequence.shots.find(s=>s.id===id));
 const statuses=shots.map(s=>chapterStatus(sequence,s));
 const mapped3d=statuses.filter(s=>s.objects>0).length;
 const mappedCamera=statuses.filter(s=>!['none','placeholder'].includes(s.camera)).length;
 return {inProject:shots.length>0,chapters:shots.length,mapped3d,mappedCamera,
   has3d:mapped3d>0||iterations.some(i=>i.kind==='geometry'&&i.summary?.objects>0),
   hasCamera:mappedCamera>0||iterations.some(i=>i.kind==='camera'||i.kind==='track'),
   tracked:statuses.some(s=>s.camera==='tracked')||iterations.some(i=>i.kind==='track'),
   versions:iterations.length};
}

/** Version lists per clip, in their own IndexedDB database. */
export function createClipHistoryStore(factory=globalThis.indexedDB){
 const DB='paige-clip-history-v1',STORE='history';
 let queue=Promise.resolve();
 const run=task=>{const r=queue.then(task);queue=r.catch(()=>{});return r;};
 const tx=(mode,action)=>run(()=>idbTransaction(factory,DB,STORE,mode,action));
 return {
   async list(clipKey){
     if(!factory||!clipKey)return [];
     return (await tx('readonly',(s,box)=>{const r=s.get(clipKey);r.onsuccess=()=>{box.value=r.result?.iterations||[];};}))||[];
   },
   async all(){
     if(!factory)return new Map();
     const rows=await tx('readonly',(s,box)=>{box.value=[];const c=s.openCursor();
       c.onsuccess=()=>{const k=c.result;if(!k)return;box.value.push([k.key,k.value?.iterations||[]]);k.continue();};});
     return new Map(rows||[]);
   },
   /** Prepend a version; keeps the newest MAX_ITERATIONS_PER_CLIP. */
   add(clipKey,snapshot){
     if(!factory||!clipKey)return Promise.resolve([]);
     return tx('readwrite',(s,box)=>{const r=s.get(clipKey);r.onsuccess=()=>{
       const iterations=[snapshot,...(r.result?.iterations||[])].slice(0,MAX_ITERATIONS_PER_CLIP);
       s.put({clipKey,iterations},clipKey);box.value=iterations;};});
   },
   remove(clipKey){if(!factory)return Promise.resolve();return tx('readwrite',s=>s.delete(clipKey));},
   /** Drop version lists whose clip no longer exists in the browser. */
   prune(liveKeys){
     if(!factory)return Promise.resolve(0);
     const keep=new Set(liveKeys);
     return tx('readwrite',(s,box)=>{box.value=0;const c=s.openCursor();
       c.onsuccess=()=>{const k=c.result;if(!k)return;if(!keep.has(k.key)){k.delete();box.value++;}k.continue();};});
   },
   clear(){if(!factory)return Promise.resolve();return tx('readwrite',s=>s.clear());}
 };
}
