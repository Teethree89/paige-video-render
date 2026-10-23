// Pure reference-sequence contract. Source files are local browser assets;
// serialized JSON has descriptive metadata only, never blob URLs or image bytes.
import {createDraftTimeline} from './shot-analysis.js';
const round=n=>Math.round(n*1000)/1000;
const validId=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(s);
export function validateReferenceItems(items){
  if(!Array.isArray(items)||items.length<1||items.length>80)
    throw Error('Reference Builder requires between 1 and 80 scenes.');
  const ids=new Set();
  return items.map((raw,i)=>{
    if(!raw||!validId(raw.id)||ids.has(raw.id))throw Error('Duplicate or invalid reference scene ID');
    ids.add(raw.id);
    if(!validId(raw.mediaId)||!['image','video'].includes(raw.kind))
      throw Error('A reference scene needs an image or video media ID');
    const duration=Number(raw.duration);
    if(!Number.isFinite(duration)||duration<0.5||duration>3600)
      throw Error('Scene duration must be between 0.5 and 3600 seconds');
    const sourceIn=raw.kind==='video'?Number(raw.sourceIn??0):0;
    const sourceOut=raw.kind==='video'?Number(raw.sourceOut??(sourceIn+duration)):0;
    if(raw.kind==='video'&&(!Number.isFinite(sourceIn)||sourceIn<0||
      !Number.isFinite(sourceOut)||sourceOut-sourceIn<0.5||
      Math.abs((sourceOut-sourceIn)-duration)>.015))
      throw Error('Video scene in/out must match its duration');
    const name=String(raw.name||'Scene '+(i+1)).slice(0,100).trim()||'Scene '+(i+1);
    const fileName=String(raw.fileName||'Unlinked media').slice(0,180);
    return {id:raw.id,mediaId:raw.mediaId,kind:raw.kind,name,fileName,
      fileSize:Number.isSafeInteger(raw.fileSize)&&raw.fileSize>=0?raw.fileSize:0,
      duration:round(duration),sourceIn:round(sourceIn),sourceOut:round(sourceOut),
      fit:raw.fit==='contain'?'contain':'cover'};
  });
}
export function buildReferenceTimeline(sourceItems,{title='Untitled reference sequence',fps=30}={}){
  const items=validateReferenceItems(sourceItems);
  let elapsed=0;
  const cuts=[];
  for(let i=0;i<items.length;i++){
    elapsed=round(elapsed+items[i].duration);
    if(i<items.length-1)cuts.push({at:elapsed});
  }
  const timeline=createDraftTimeline({duration:elapsed,fps,cuts,title});
  if(timeline.shots.length!==items.length)
    throw Error('Reference scene boundaries could not be preserved');
  timeline.shots.forEach((shot,index)=>{
    const item=items[index];shot.id=item.id;shot.name=item.name;
    shot.title=item.name.toUpperCase();shot.draft=true;
    shot.sourceFrameTime=round(shot.start+item.duration/2);
    shot.reference={kind:item.kind,mediaId:item.mediaId,
      sourceIn:item.sourceIn,sourceOut:item.sourceOut,fit:item.fit};
  });
  delete timeline.videoIntake;
  timeline.referenceSequence={version:1,items};
  return timeline;
}
export function referenceAt(sequence,time){
  if(!sequence?.referenceSequence?.items)return null;
  const shot=sequence.shots?.find((s,i)=>time>=s.start&&
    (time<s.end||i===sequence.shots.length-1));
  if(!shot)return null;
  const item=sequence.referenceSequence.items.find(i=>i.id===shot.id);
  return item?{shot,item,sourceTime:item.kind==='video'?
    Math.min(item.sourceOut,Math.max(item.sourceIn,
      item.sourceIn+time-shot.start)):0}:null;
}
