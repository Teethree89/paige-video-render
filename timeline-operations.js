// Pure NLE timeline transactions. No DOM, networking, media access or AI calls.
// All chapter mutations preserve shot IDs unless a deliberate duplicate creates one.
const rnd=n=>Math.round(n*1000)/1000;
const clone=x=>structuredClone(x);
const MIN=.15; // Legacy shot detection can legitimately produce 0.15s scenes.
const near=(a,b)=>Math.abs(a-b)<.004;
const num=n=>Number.isFinite(n);
export function checkTimeline(seq){
  if(!seq||!num(seq.duration)||seq.duration<MIN||!Array.isArray(seq.shots)||
    !seq.shots.length||!Array.isArray(seq.camera)||!Array.isArray(seq.text))
    throw Error('Invalid timeline structure');
  const ids=new Set();
  let last=0;
  for(const shot of seq.shots){
    if(typeof shot.id!=='string'||!shot.id||ids.has(shot.id)||
      !num(shot.start)||!num(shot.end)||!near(shot.start,last)||
      shot.end-shot.start<MIN-.004)throw Error('Invalid or noncontiguous chapter');
    ids.add(shot.id);last=shot.end;
  }
  if(!near(last,seq.duration))throw Error('Chapter endpoints do not match duration');
  for(const key of seq.camera)if(!num(key.at)||key.at<-.004||key.at>seq.duration+.004)
    throw Error('Camera key outside timeline');
  for(const tx of seq.text)if(!num(tx.start)||!num(tx.end)||tx.start<-.004||
    tx.end>seq.duration+.004||tx.end-tx.start<.03)
    throw Error('Text overlay outside timeline');
  return seq;
}
export function chapterAt(seq,time){
  return seq.shots.find((s,i)=>time>=s.start-.0001&&
    (time<s.end-.0001||i===seq.shots.length-1))||null;
}
const midpoint=(a,b)=>a+(b-a)*.5;
const assignOwner=(seq,tx)=>{
  // Cross-boundary overlays are ambiguous when chapters are reordered.
  // Explicitly refuse rather than silently moving half of an overlay.
  const owner=chapterAt(seq,midpoint(tx.start,tx.end));
  if(!owner||tx.start<owner.start-.003||tx.end>owner.end+.003)
    throw Error('An overlay spans chapter boundaries. Split it before reordering or deleting chapters.');
  return owner.id;
};
const reorderItems=(seq)=>{
  if(seq.referenceSequence?.items){
    const byId=new Map(seq.referenceSequence.items.map(x=>[x.id,x]));
    seq.referenceSequence.items=seq.shots.map(s=>byId.get(s.id)).filter(Boolean);
  }
};
const updateShotReference=(seq,shot)=>{
  const item=seq.referenceSequence?.items?.find(x=>x.id===shot.id);
  if(item){item.duration=rnd(shot.end-shot.start);
    if(item.kind==='video')item.sourceOut=rnd(item.sourceIn+item.duration);
  }
};
export function moveTimelineKey(source,kind,id,newStart,{snap=true}={}){
  const seq=clone(checkTimeline(source));
  const track=kind==='camera'?seq.camera:kind==='text'?seq.text:null;
  if(!track)throw Error('Unsupported timeline track');
  const key=track.find(k=>k.id===id);
  if(!key)throw Error('Key not found');
  if(!num(newStart))throw Error('Non-finite timeline position');
  const fps=Math.max(1,seq.fps||30),step=v=>snap?Math.round(v*fps)/fps:v;
  if(kind==='camera')key.at=rnd(step(Math.max(0,Math.min(seq.duration,newStart))));
  else{
    const length=key.end-key.start;
    key.start=rnd(step(Math.max(0,Math.min(seq.duration-length,newStart))));
    key.end=rnd(key.start+length);
  }
  seq.camera.sort((a,b)=>a.at-b.at);
  return checkTimeline(seq);
}
export function resizeChapter(source,id,newDuration,{ripple=true,sourceDuration=null}={}){
  const seq=clone(checkTimeline(source));
  const index=seq.shots.findIndex(x=>x.id===id);
  if(index<0)throw Error('Chapter not found');
  if(!num(newDuration)||newDuration<MIN||newDuration>3600)
    throw Error('Chapter length must be 0.25 to 3600 seconds');
  const shot=seq.shots[index],oldStart=shot.start,oldEnd=shot.end,oldLength=oldEnd-oldStart;
  let duration=rnd(newDuration);
  if(seq.referenceSequence?.items){
    const item=seq.referenceSequence.items.find(x=>x.id===id);
    if(item?.kind==='video'&&sourceDuration!==null&&
      (!num(sourceDuration)||item.sourceIn+duration>sourceDuration+.001))
      throw Error('Video source does not contain enough frames for this duration.');
  }
  if(!ripple){
    const next=seq.shots[index+1];
    if(!next)throw Error('The last chapter has no shared boundary; use ripple resize');
    const nextLength=next.end-next.start;
    if(nextLength-(duration-oldLength)<MIN)
      throw Error('Adjacent chapter would become shorter than 0.25 seconds');
    // Re-time both adjacent chapters within their old time windows.
    const pivot=rnd(oldStart+duration),nextEnd=next.end;
    const map=t=>t>=oldStart-.001&&t<oldEnd-.001?
      oldStart+(t-oldStart)*duration/oldLength:
      t>=oldEnd-.001&&t<=nextEnd+.001?
      pivot+(t-oldEnd)*(nextEnd-pivot)/nextLength:t;
    for(const key of seq.camera)key.at=rnd(map(key.at));
    for(const tx of seq.text){tx.start=rnd(map(tx.start));tx.end=rnd(map(tx.end));}
    shot.end=pivot;next.start=pivot;
    // Preserve the next video's source-out while moving its in point.
    const other=seq.referenceSequence?.items?.find(x=>x.id===next.id);
    if(other?.kind==='video'){
      const delta=duration-oldLength;
      other.sourceIn=rnd(other.sourceIn+delta);
      if(other.sourceIn<0||other.sourceOut-other.sourceIn<MIN)
        throw Error('Adjacent reference video cannot absorb this trim');
    }
    updateShotReference(seq,shot);updateShotReference(seq,next);
  }else{
    const delta=rnd(duration-oldLength),boundary=rnd(oldStart+duration);
    const map=t=>t<oldStart-.001?t:
      t<oldEnd-.001?oldStart+(t-oldStart)*duration/oldLength:t+delta;
    for(const key of seq.camera)key.at=rnd(map(key.at));
    for(const tx of seq.text){tx.start=rnd(map(tx.start));tx.end=rnd(map(tx.end));}
    shot.end=boundary;
    for(let i=index+1;i<seq.shots.length;i++){
      seq.shots[i].start=rnd(seq.shots[i].start+delta);
      seq.shots[i].end=rnd(seq.shots[i].end+delta);
    }
    seq.duration=rnd(seq.duration+delta);
    updateShotReference(seq,shot);
  }
  seq.camera.sort((a,b)=>a.at-b.at);
  return checkTimeline(seq);
}
export function copyChapter(source,id){
  const seq=checkTimeline(source),shot=seq.shots.find(s=>s.id===id);
  if(!shot)throw Error('Chapter not found');
  const keys=seq.camera.filter(k=>k.at>=shot.start-.001&&k.at<shot.end-.001)
    .map(k=>({...clone(k),at:rnd(k.at-shot.start)}));
  const captions=seq.text.filter(tx=>tx.start<shot.end&&tx.end>shot.start)
    .map(tx=>({...clone(tx),start:rnd(Math.max(0,tx.start-shot.start)),
      end:rnd(Math.min(shot.end,tx.end)-shot.start)}));
  const entry=seq.primitiveScenes?.scenes?.find(s=>s.shotId===id);
  const ref=seq.referenceSequence?.items?.find(x=>x.id===id);
  return {version:1,shot:clone(shot),keys,captions,
    geometry:entry?clone(entry):null,reference:ref?clone(ref):null};
}
export function pasteChapter(source,clipboard,afterId,newId){
  const seq=clone(checkTimeline(source));
  if(clipboard?.version!==1||!clipboard.shot||typeof newId!=='string'||
    !/^[A-Za-z0-9_-]{1,80}$/.test(newId)||
    seq.shots.some(s=>s.id===newId))throw Error('Invalid copied chapter or duplicate ID');
  const index=seq.shots.findIndex(s=>s.id===afterId);
  if(index<0)throw Error('Paste destination chapter not found');
  const at=seq.shots[index].end,duration=rnd(clipboard.shot.end-clipboard.shot.start);
  if(duration<MIN)throw Error('Copied chapter is too short');
  for(let i=index+1;i<seq.shots.length;i++){
    seq.shots[i].start=rnd(seq.shots[i].start+duration);
    seq.shots[i].end=rnd(seq.shots[i].end+duration);
  }
  for(const key of seq.camera)if(key.at>=at-.001)key.at=rnd(key.at+duration);
  for(const tx of seq.text){
    if(tx.start>=at-.001){tx.start=rnd(tx.start+duration);tx.end=rnd(tx.end+duration);}
    else if(tx.end>at){tx.end=rnd(tx.end+duration);}
  }
  const newShot={...clone(clipboard.shot),id:newId,start:at,end:rnd(at+duration)};
  seq.shots.splice(index+1,0,newShot);seq.duration=rnd(seq.duration+duration);
  const unique=(prefix)=>prefix+'_'+newId+'_'+Math.floor(Math.random()*1e7).toString(36);
  for(const key of clipboard.keys||[])seq.camera.push({
    ...clone(key),id:unique('cam'),at:rnd(at+key.at),cut:key.at<.004?true:key.cut});
  for(const tx of clipboard.captions||[]){
    if(tx.end-tx.start<.03)continue;
    seq.text.push({...clone(tx),id:unique('text'),start:rnd(at+tx.start),end:rnd(at+tx.end)});
  }
  if(clipboard.geometry){
    if(!seq.primitiveScenes)seq.primitiveScenes={schemaVersion:1,scenes:[]};
    seq.primitiveScenes.scenes.push({...clone(clipboard.geometry),shotId:newId,
      objects:(clipboard.geometry.objects||[]).map(o=>({...clone(o),id:unique('prim')}))});
  }
  if(seq.referenceSequence){
    if(!clipboard.reference)throw Error('Clipboard chapter lacks media reference');
    seq.referenceSequence.items.splice(index+1,0,{...clone(clipboard.reference),id:newId});
  }
  seq.camera.sort((a,b)=>a.at-b.at);
  return checkTimeline(seq);
}
export function moveChapter(source,id,destinationIndex){
  const seq=clone(checkTimeline(source));
  const index=seq.shots.findIndex(s=>s.id===id);
  if(index<0||!Number.isInteger(destinationIndex)||
    destinationIndex<0||destinationIndex>=seq.shots.length)
    throw Error('Invalid destination chapter');
  if(index===destinationIndex)return seq;
  const captions=new Map(seq.text.map(t=>[t.id,assignOwner(seq,t)]));
  const oldById=new Map(seq.shots.map(s=>[s.id,{...s}]));
  const keyOwner=seq.camera.map(k=>{
    const shot=chapterAt(seq,Math.min(seq.duration-.001,k.at));
    return {key:k,owner:shot.id,offset:rnd(k.at-shot.start)};
  });
  const [moved]=seq.shots.splice(index,1);
  seq.shots.splice(destinationIndex,0,moved);
  let t=0;for(const shot of seq.shots){
    const length=rnd(oldById.get(shot.id).end-oldById.get(shot.id).start);
    shot.start=rnd(t);t=rnd(t+length);shot.end=t;
  }
  for(const {key,owner,offset} of keyOwner){
    const shot=seq.shots.find(s=>s.id===owner);
    key.at=rnd(Math.min(seq.duration,shot.start+offset));
  }
  for(const tx of seq.text){
    const old=oldById.get(captions.get(tx.id));
    const next=seq.shots.find(s=>s.id===old.id);
    const delta=next.start-old.start;
    tx.start=rnd(tx.start+delta);tx.end=rnd(tx.end+delta);
  }
  reorderItems(seq);
  seq.camera.sort((a,b)=>a.at-b.at);
  return checkTimeline(seq);
}
export function deleteChapter(source,id){
  const seq=clone(checkTimeline(source));
  if(seq.shots.length===1)throw Error('Cannot delete the last chapter');
  const index=seq.shots.findIndex(s=>s.id===id);
  if(index<0)throw Error('Chapter not found');
  const owners=new Map(seq.text.map(tx=>[tx.id,assignOwner(seq,tx)]));
  const chapter=seq.shots[index],length=rnd(chapter.end-chapter.start);
  seq.shots.splice(index,1);
  for(let i=index;i<seq.shots.length;i++){
    seq.shots[i].start=rnd(seq.shots[i].start-length);
    seq.shots[i].end=rnd(seq.shots[i].end-length);
  }
  seq.camera=seq.camera.filter(k=>!(k.at>=chapter.start-.001&&k.at<chapter.end-.001));
  for(const k of seq.camera)if(k.at>=chapter.end-.001)k.at=rnd(k.at-length);
  seq.text=seq.text.filter(tx=>owners.get(tx.id)!==id);
  for(const tx of seq.text)if(tx.start>=chapter.end-.001){
    tx.start=rnd(tx.start-length);tx.end=rnd(tx.end-length);
  }
  if(seq.primitiveScenes?.scenes)seq.primitiveScenes.scenes=
    seq.primitiveScenes.scenes.filter(s=>s.shotId!==id);
  if(seq.referenceSequence?.items)seq.referenceSequence.items=
    seq.referenceSequence.items.filter(x=>x.id!==id);
  seq.duration=rnd(seq.duration-length);
  if(!seq.camera.length){
    const original=source.camera[0];
    const first=seq.shots[0];
    seq.camera.push({...clone(original),id:'cam_kept_'+first.id,at:0,cut:true});
  }
  seq.camera.sort((a,b)=>a.at-b.at);
  return checkTimeline(seq);
}
export function resizeText(source,id,newEnd){
  const seq=clone(checkTimeline(source));
  const tx=seq.text.find(x=>x.id===id);
  if(!tx||!num(newEnd)||newEnd-tx.start<.05||newEnd>seq.duration)
    throw Error('Text overlay must be at least 0.05 seconds and within the timeline');
  tx.end=rnd(newEnd);
  return checkTimeline(seq);
}
export function createTimelineHistory(initial,max=90){
  let states=[JSON.stringify(checkTimeline(initial))],at=0;
  return {
    record(doc){
      const serialized=JSON.stringify(checkTimeline(doc));
      if(states[at]===serialized)return;
      states=states.slice(0,at+1);states.push(serialized);
      if(states.length>max)states.shift();
      at=states.length-1;
    },
    reset(doc){states=[JSON.stringify(checkTimeline(doc))];at=0;},
    undo(){if(at<=0)return null;return JSON.parse(states[--at]);},
    redo(){if(at>=states.length-1)return null;return JSON.parse(states[++at]);},
    get canUndo(){return at>0;},get canRedo(){return at<states.length-1}
  };
}
