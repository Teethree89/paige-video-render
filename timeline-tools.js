// Timeline editor interactions, separate from playback and paid AI generation.
// Requires the existing .shot-item / .key-marker / .text-item nodes.
import {moveTimelineKey,resizeChapter,resizeText,copyChapter,pasteChapter,
  moveChapter,deleteChapter} from './timeline-operations.js';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const mk=(tag,txt,attributes={})=>{
  const e=document.createElement(tag);e.textContent=txt;
  for(const [k,v] of Object.entries(attributes))e.setAttribute(k,v);
  return e;
};
export function setupTimelineEditing({
  getSequence,getShotId,onCommit,onSeek,onUndo,onRedo,canUndo,canRedo,
  canEdit=()=>true,sourceDuration=()=>null
}){
 const tracks=document.getElementById('tracks'),toolbar=document.querySelector('.timeline-toolset');
 if(!tracks||!toolbar)return null;
 const state={chapter:null,clipboard:null,ripple:true,snap:true,locks:new Set(),drag:null};
 const bar=document.createElement('div');bar.className='timeline-edit-tools';
 const btn=(label,title,id)=>{
   const node=mk('button',label,{type:'button',title,id});
   bar.append(node);return node;
 };
 const undo=btn('↶','Undo (Ctrl/Cmd+Z)','timelineUndo');
 const redo=btn('↷','Redo (Ctrl/Cmd+Shift+Z)','timelineRedo');
 const copy=btn('Copy','Copy selected chapter (Ctrl/Cmd+C)','timelineCopy');
 const paste=btn('Paste','Paste after selected chapter (Ctrl/Cmd+V)','timelinePaste');
 const remove=btn('Delete','Delete selected chapter with ripple','timelineDelete');
 const earlier=btn('← Chapter','Move chapter earlier','timelineChapterEarlier');
 const later=btn('Chapter →','Move chapter later','timelineChapterLater');
 const ripple=btn('Ripple ON','Toggle ripple trimming','timelineRipple');
 const snap=btn('Snap ON','Toggle frame and boundary snapping','timelineSnap');
 const status=mk('span','Select a chapter to copy, paste, resize or move.',{id:'timelineEditStatus',role:'status'});
 bar.append(status);
 toolbar.insertAdjacentElement('afterend',bar);
 const locks=new Map();
 for(const [kind,label] of [['scenes','SCENES'],['camera','CAMERA'],['text','TEXT']]){
   const row=Array.from(document.querySelectorAll('.track-label')).find(e=>e.textContent.includes(label));
   if(!row)continue;
   const b=mk('button','◇',{type:'button',class:'timeline-track-lock','aria-pressed':'false',
     title:'Lock/unlock '+kind+' track','aria-label':'Lock '+kind+' track'});
   row.append(b);locks.set(kind,b);
   b.addEventListener('click',()=>{
     if(state.locks.has(kind))state.locks.delete(kind);else state.locks.add(kind);
     b.textContent=state.locks.has(kind)?'🔒':'◇';
     b.setAttribute('aria-pressed',String(state.locks.has(kind)));
     b.title=state.locks.has(kind)?'Unlock '+kind+' track':'Lock '+kind+' track';
   });
 }
 function note(text){status.textContent=text;}
 function selected(){
   const seq=getSequence();
   if(state.chapter&&seq.shots.some(s=>s.id===state.chapter))return state.chapter;
   return getShotId()?.id||null;
 }
 function refresh(){
   const available=canEdit();
   undo.disabled=!canUndo();redo.disabled=!canRedo();
   for(const b of [copy,paste,remove,earlier,later,ripple,snap])b.disabled=!available;
   paste.disabled=!available||!state.clipboard;
   ripple.setAttribute('aria-pressed',String(state.ripple));
   snap.setAttribute('aria-pressed',String(state.snap));
   const id=selected(),seq=getSequence(),index=seq.shots.findIndex(s=>s.id===id);
   earlier.disabled=!available||index<=0;
   later.disabled=!available||index<0||index===seq.shots.length-1;
   remove.disabled=!available||seq.shots.length<=1;
 }
 function run(change,{time=null,label='Timeline updated'}={}){
   if(!canEdit()){note('Finish or discard the active AI generation before modifying the timeline.');return false;}
   try{
     const next=change(getSequence());
     onCommit(next,time);
     note(label);refresh();return true;
   }catch(error){note(error.message);refresh();return false;}
 }
 function newId(){
   return 'clip_'+Date.now().toString(36)+'_'+Math.floor(Math.random()*0xffffff).toString(36);
 }
 function grabChapter(id){state.chapter=id;refresh();}
 copy.onclick=()=>{
   if(state.locks.has('scenes'))return note('Unlock the scenes track to copy.');
   try{state.clipboard=copyChapter(getSequence(),selected());note('Copied chapter and its keys, overlays and geometry.');}
   catch(error){note(error.message);}refresh();
 };
 paste.onclick=()=>{
   if(state.locks.size)return note('Unlock all tracks to ripple-insert a chapter.');
   const after=selected();
   if(!state.clipboard||!after)return;
   const id=newId();
   run(seq=>pasteChapter(seq,state.clipboard,after,id),
     {time:getSequence().shots.find(s=>s.id===after).end,label:'Chapter pasted with fresh object/key IDs.'});
   state.chapter=id;refresh();
 };
 remove.onclick=()=>{
   if(state.locks.size)return note('Unlock all tracks to ripple-delete a chapter.');
   const id=selected();
   if(!id||!confirm('Delete chapter and its owned camera keys, captions and 3D geometry? Later chapters will shift left.'))return;
   run(seq=>deleteChapter(seq,id),{label:'Chapter removed with ripple.'});state.chapter=null;
 };
 earlier.onclick=()=>{
   if(state.locks.size)return note('Unlock all tracks before reordering chapters.');
   const seq=getSequence(),id=selected(),index=seq.shots.findIndex(s=>s.id===id);
   if(index>0)run(s=>moveChapter(s,id,index-1),{label:'Moved chapter earlier.'});
 };
 later.onclick=()=>{
   if(state.locks.size)return note('Unlock all tracks before reordering chapters.');
   const seq=getSequence(),id=selected(),index=seq.shots.findIndex(s=>s.id===id);
   if(index>=0&&index<seq.shots.length-1)
     run(s=>moveChapter(s,id,index+1),{label:'Moved chapter later.'});
 };
 undo.onclick=()=>{onUndo();refresh();};
 redo.onclick=()=>{onRedo();refresh();};
 ripple.onclick=()=>{state.ripple=!state.ripple;ripple.textContent=state.ripple?'Ripple ON':'Ripple OFF';refresh();};
 snap.onclick=()=>{state.snap=!state.snap;snap.textContent=state.snap?'Snap ON':'Snap OFF';refresh();};
 const times=()=>getSequence().shots.flatMap(x=>[x.start,x.end]);
 function snapTime(t){
   const seq=getSequence(),fps=Math.max(1,seq.fps||30);
   let value=state.snap?Math.round(t*fps)/fps:t;
   const rect=tracks.getBoundingClientRect(),tol=9/Math.max(1,rect.width)*seq.duration;
   if(state.snap)for(const edge of times())if(Math.abs(edge-t)<tol){value=edge;break;}
   return clamp(value,0,seq.duration);
 }
 function position(event){
   const r=tracks.getBoundingClientRect();
   return snapTime((event.clientX-r.left)/r.width*getSequence().duration);
 }
 function dragTarget(event){
   const target=event.target.closest('.chapter-resize-handle,.text-resize-handle,.key-marker,.text-item,.shot-item');
   if(!target)return null;
   const shot=target.closest('.shot-item'),tx=target.closest('.text-item'),key=target.closest('.key-marker');
   const type=target.matches('.chapter-resize-handle')?'chapter-resize':
     target.matches('.text-resize-handle')?'text-resize':key?'camera':tx?'text':'chapter-move';
   return {type,id:key?.dataset.editId||tx?.dataset.editId||shot?.dataset.shotId};
 }
 let suppressClick=false;
 tracks.addEventListener('click',event=>{
   if(!suppressClick)return;
   suppressClick=false;event.preventDefault();event.stopImmediatePropagation();
 },true);
 tracks.addEventListener('pointerdown',event=>{
   if(event.button!==0||!canEdit())return;
   const hit=dragTarget(event);if(!hit||!hit.id)return;
   const kind=hit.type.startsWith('chapter')?'scenes':hit.type==='camera'?'camera':'text';
   if(state.locks.has(kind))return;
   if(hit.type==='chapter-resize'&&state.locks.size)return note('Unlock camera and text tracks to resize a chapter.');
   if(hit.type==='chapter-move'&&state.locks.size)return note('Unlock all tracks to reorder chapters.');
   if(hit.type.startsWith('chapter'))grabChapter(hit.id);
   const seq=getSequence(),chapter=seq.shots.find(s=>s.id===hit.id);
   const key=seq.camera.find(k=>k.id===hit.id)||seq.text.find(k=>k.id===hit.id);
   state.drag={...hit,startX:event.clientX,startTime:position(event),
     initial:hit.type==='chapter-resize'?chapter.end:hit.type==='text-resize'?key.end:
       hit.type==='camera'?key.at:hit.type==='text'?key.start:chapter.start,
     element:event.target.closest('.shot-item,.key-marker,.text-item'),
     moving:false};
   tracks.setPointerCapture(event.pointerId);
   // Do not cancel normal click selection until the pointer actually moves.
 },true);
 tracks.addEventListener('pointermove',event=>{
   const drag=state.drag;if(!drag)return;
   const dx=event.clientX-drag.startX;
   if(Math.abs(dx)<4&&!drag.moving)return;
   drag.moving=true;
   if(drag.element)drag.element.style.filter='brightness(1.5)';
   const seq=getSequence(),delta=position(event)-drag.startTime;
   if(drag.element&&drag.type!=='chapter-move'){
     drag.element.style.transform=drag.type==='camera'?
       'translateX(calc(-50% + '+dx+'px)) rotate(45deg)':'translateX('+dx+'px)';
   }
   const proposed=snapTime(drag.initial+delta);
   note(drag.type==='chapter-resize'?'Resize chapter to '+Math.max(.25,proposed-(seq.shots.find(s=>s.id===drag.id)?.start||0)).toFixed(2)+'s':
     drag.type==='chapter-move'?'Release to reorder chapter':
     'Move to '+proposed.toFixed(2)+'s');
 },true);
 tracks.addEventListener('pointerup',event=>{
   const drag=state.drag;if(!drag)return;
   state.drag=null;
   if(!drag.moving)return;
   suppressClick=true;
   const seq=getSequence(),delta=position(event)-drag.startTime;
   const proposed=snapTime(drag.initial+delta);
   if(drag.type==='camera')run(s=>moveTimelineKey(s,'camera',drag.id,proposed,{snap:state.snap}),
      {time:proposed,label:'Camera key moved.'});
   else if(drag.type==='text')run(s=>moveTimelineKey(s,'text',drag.id,proposed,{snap:state.snap}),
      {time:proposed,label:'Text overlay moved.'});
   else if(drag.type==='text-resize')run(s=>resizeText(s,drag.id,proposed),
      {time:proposed,label:'Text overlay resized.'});
   else if(drag.type==='chapter-resize'){
     const item=seq.shots.find(s=>s.id===drag.id),duration=proposed-item.start;
     run(s=>resizeChapter(s,drag.id,duration,{ripple:state.ripple,
       sourceDuration:sourceDuration(drag.id)}),
       {time:item.start,label:state.ripple?'Ripple-resized chapter.':'Slip-resized chapter boundary.'});
   }else if(drag.type==='chapter-move'){
     const to=seq.shots.findIndex((s,i)=>position(event)<s.end||i===seq.shots.length-1);
     run(s=>moveChapter(s,drag.id,to),{label:'Chapter reordered with linked keys.'});
   }
   if(drag.element?.isConnected){
     drag.element.style.transform='';drag.element.style.filter='';
   }
 },true);
 tracks.addEventListener('pointercancel',()=>{if(state.drag?.element?.isConnected){
     state.drag.element.style.transform='';state.drag.element.style.filter='';
   }state.drag=null;},true);
 document.addEventListener('keydown',event=>{
   const node=event.target,typing=node?.matches?.('input,textarea,select,[contenteditable=true]');
   if(typing)return;
   const cmd=event.ctrlKey||event.metaKey;
   if(!cmd)return;
   const key=event.key.toLowerCase();
   if(key==='z'){event.preventDefault();if(event.shiftKey)redo.click();else undo.click();}
   if(key==='y'){event.preventDefault();redo.click();}
   if(key==='c'&&selected()&&!event.shiftKey){event.preventDefault();copy.click();}
   if(key==='v'&&state.clipboard&&!event.shiftKey){event.preventDefault();paste.click();}
 });
 refresh();
 return {refresh,selectChapter:grabChapter,get ripple(){return state.ripple}};
}
