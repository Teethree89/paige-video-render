// Per-chapter camera tracking wizard.
//   1 Video points  : click the same spots the model has (clicks snap to corners), Done
//   2 Model points  : click the matching spots on the 3D model (snap to model corners), Done
//   3 Compare       : a before/after wipe of the video and the model seen from the solved camera
//   4 Tracking      : follow the pinned points through the chapter
//   5 Preview       : scrub the new camera path; Apply replaces this chapter's camera keys
// In the compare step, extra reference frames (the same numbered points, at other times) pin the camera
// there and correct drift in the tracked path.
// Everything runs in this browser. The host (app.js) owns the 3D view.
import {snapToCorner} from './feature-tracker.js';
import {resectCamera,projectPoint,MIN_PIN_POINTS} from './camera-resection.js';
import {segmentsToKeys,buildAnchoredCameraProposal,DENSITY} from './camera-anchor.js';
import {createFrameLoader,trackAnchored,describeTrackSummary} from './camera-track-ui.js';

export const MAX_PINS=24;
export const RECOMMENDED_PINS=6;
const SNAP_CSS_PX=14;
const EXTRA_MAX_RMS_PX=8;
const PHASES=Object.freeze(['video','model','compare','frame','tracking','preview']);
export const MAX_EXTRA_FRAMES=6;
export const PHASE_COPY=Object.freeze({
 video:{step:'STEP 1 OF 3 · VIDEO',title:'Mark points in the video',
   help:'Click distinct spots that stay visible during the shot: building corners, roof edges, poles. Pick 6 to 10, spread across the frame. Clicks snap to the nearest corner; drag a point to adjust it.'},
 model:{step:'STEP 2 OF 3 · 3D MODEL',title:'Match each point on the model',
   help:'Orbit and zoom the model, then click the same spot as the highlighted point. Clicks snap to the nearest model corner. Skip a point you cannot find; at least 4 must be matched.'},
 compare:{step:'STEP 3 OF 3 · CHECK',title:'Does the model line up?',
   help:'Drag the slider: video on the left, the model seen from the solved camera on the right. Cyan crosses are your video points; orange rings are where the model points land.'},
 frame:{step:'EXTRA REFERENCE FRAME',title:'Mark the same points in another frame',
   help:'Pick a frame where the camera has moved, then click where each numbered point is. Only the points you already matched on the model are offered (never more than in the first frame); skip any you cannot see. This pins the camera there and corrects drift in between.'},
 tracking:{step:'TRACKING',title:'Tracking the camera',help:'Following your points through the chapter on this device. Nothing is uploaded.'},
 preview:{step:'PREVIEW',title:'Preview the tracked camera',help:''}});

const SVG='http://www.w3.org/2000/svg';
const clamp=(n,a,b)=>Math.min(b,Math.max(a,n));
const clock=t=>Math.floor(t/60)+':'+(t%60).toFixed(2).padStart(5,'0');

/** Fit a w:h box inside a container, centered ("contain"). */
export function containRect(containerW,containerH,aspect){
 if(!(containerW>0&&containerH>0&&aspect>0))return {x:0,y:0,w:0,h:0};
 let w=containerW,h=w/aspect;if(h>containerH){h=containerH;w=h*aspect;}
 return {x:(containerW-w)/2,y:(containerH-h)/2,w,h};
}
/** Pins with both a video position and a model position. */
export const matchedPins=pins=>pins.filter(p=>Array.isArray(p.X));

/**
 * @param {object} host
 *   getSequence(), getShot(), resolveSource(shot), canEdit(), getAnchor(shotId),
 *   enterModelView(shotId), exitView(), setPicking(on,handler), setMarkers(list),
 *   showCompareView({pose,fov,videoAspect}), previewProposal(proposal), applyProposal(), discardProposal(), notify(text)
 */
export function setupTrackWizard(host){
 const $=id=>document.getElementById(id);
 const root=$('trackWizard');
 if(!root)return null;
 const el={stepText:$('twStep'),title:$('twTitle'),help:$('twHelp'),stage:$('twStage'),frameBox:$('twFrameBox'),canvasHolder:$('twCanvasHolder'),
   marks:$('twMarks'),svg:$('twOverlay'),videoLayer:$('twVideoLayer'),handle:$('twHandle'),time:$('twTime'),timeText:$('twTimeText'),
   list:$('twPoints'),status:$('twStatus'),back:$('twBack'),done:$('twDone'),cancel:$('twCancel'),clear:$('twClear'),skip:$('twSkip'),
   wipe:$('twWipe'),wipeRow:$('twWipeRow'),lens:$('twLens'),lensRow:$('twLensRow'),lensNote:$('twLensNote'),density:$('twDensity'),apply:$('twApply'),discard:$('twDiscard'),progress:$('twProgress'),stats:$('twStats'),
   timeRow:$('twTimeRow'),densityRow:$('twDensityRow'),framesRow:$('twFramesRow'),frames:$('twFrames'),addFrame:$('twAddFrame')};
 let st=null;

 const say=(text,kind='')=>{el.status.textContent=text;el.status.dataset.kind=kind;};
 const setPhase=phase=>{
   st.phase=phase;root.dataset.phase=phase;
   // Pinning, comparing and tracking use the whole editor area; the preview needs the timeline back.
   host.setFocusLayout?.(phase!=='preview');
   const c=PHASE_COPY[phase];el.stepText.textContent=c.step;el.title.textContent=c.title;el.help.textContent=c.help;
   el.back.hidden=!['model','compare','preview','frame'].includes(phase);
   el.clear.hidden=phase!=='video';el.skip.hidden=phase!=='model';el.timeRow.hidden=!['video','frame'].includes(phase);el.framesRow.hidden=!['video','compare'].includes(phase);
   el.wipeRow.hidden=phase!=='compare';el.lensRow.hidden=phase!=='compare';el.density.closest('.tw-density').hidden=phase!=='preview';
   el.apply.hidden=el.discard.hidden=phase!=='preview';el.progress.hidden=phase!=='tracking';
   el.done.hidden=!['video','model','compare','frame'].includes(phase);
   el.done.textContent=phase==='compare'?'Track motion':phase==='frame'?'Save frame':'Done';
   el.back.textContent=phase==='preview'?'Back to adjust':phase==='frame'?'Discard frame':'Back';
   el.cancel.textContent=phase==='preview'?'Close':'Cancel';
   el.svg.hidden=phase!=='compare';el.handle.hidden=phase!=='compare';
   el.videoLayer.dataset.wipe=phase==='compare'?'on':'off';
   layout();renderMarks();renderList();updateButtons();renderFrames();
 };

 // ---- frame display ----
 function layout(){
   if(!st?.frame)return;
   const box=el.stage.getBoundingClientRect(),r=containRect(box.width,box.height,st.frame.width/st.frame.height);
   Object.assign(el.frameBox.style,{left:r.x+'px',top:r.y+'px',width:r.w+'px',height:r.h+'px'});
   st.rect=r;
 }
 function showFrame(frame){
   st.frame=frame;
   el.canvasHolder.replaceChildren(frame.canvas);frame.canvas.setAttribute('role','img');
   frame.canvas.setAttribute('aria-label','Video frame at '+clock(frame.time));
   el.svg.setAttribute('viewBox',`0 0 ${frame.width} ${frame.height}`);
   layout();
 }
 async function loadFrameAt(time){
   try{
     const frame=await st.loader.frame(st.source.toSourceTime(time));
     if(!st)return;
     if(st.editFrame)st.editFrame.time=time;else st.refTime=time; // chapter time; the frame itself is read at the source time
     showFrame(frame);el.timeText.textContent=clock(time);
   }catch(error){say('Could not read the video frame: '+error.message,'error');}
 }

 // ---- pins ----
 // From the video step any numbered point can be marked in another frame; from the compare step only the
 // ones matched on the model (an extra frame never has more points than the first frame).
 const eligible=p=>st.frameFrom==='video'||!!p.X;
 const nextId=()=>'pin'+(st.nextPin++);
 const frameCss=()=>el.frameBox.getBoundingClientRect();
 function snapAt(nx,ny,radiusCss=SNAP_CSS_PX){
   const f=st.frame,r=frameCss(),scale=f.width/Math.max(1,r.width);
   const hit=snapToCorner(f.gray,f.width,f.height,nx*f.width,ny*f.height,{radius:radiusCss*scale});
   return {x:clamp(hit.x/f.width,0,1),y:clamp(hit.y/f.height,0,1),snapped:hit.snapped};
 }
 function renderMarks(){
   if(!st)return;
   el.marks.replaceChildren();
   if(st.phase==='frame'){
     st.pins.forEach((pin,i)=>{
       const o=st.editFrame?.obs[pin.id];if(!o)return;
       const m=document.createElement('div');m.className='tw-mark';m.dataset.index=String(i);
       m.style.left=o.x*100+'%';m.style.top=o.y*100+'%';m.dataset.state=i===st.active?'active':'todo';
       m.textContent=String(i+1);m.title=`Point ${i+1}`;el.marks.append(m);
     });
     return;
   }
   st.pins.forEach((pin,i)=>{
     const m=document.createElement('div');m.className='tw-mark';m.dataset.index=String(i);
     m.style.left=pin.x*100+'%';m.style.top=pin.y*100+'%';
     m.dataset.state=st.phase==='model'?(i===st.active?'active':pin.X?'done':'todo'):'todo';
     m.textContent=String(i+1);m.title=`Point ${i+1}`+(pin.snapped?' (snapped to a corner)':'');
     el.marks.append(m);
   });
 }
 function renderList(){
   if(!st)return;
   if(st.phase==='frame'){
     const ed=st.editFrame;
     el.list.replaceChildren(...st.pins.map((pin,i)=>{
       if(!eligible(pin))return null;
       const li=document.createElement('li');li.dataset.index=String(i);
       li.dataset.state=ed.obs[pin.id]?'done':i===st.active?'active':'';
       const label=document.createElement('button');label.type='button';label.className='tw-point';label.textContent=`${i+1}`;
       const text=document.createElement('span');text.textContent=ed.obs[pin.id]?'placed':i===st.active?'click it in the video':'not placed';
       label.append(text);
       label.addEventListener('click',()=>{st.active=i;renderMarks();renderList();say(`Click point ${i+1} in this frame.`);});
       li.append(label);
       if(ed.obs[pin.id]){
         const del=document.createElement('button');del.type='button';del.className='tw-del';del.textContent='×';
         del.setAttribute('aria-label',`Remove point ${i+1} from this frame`);
         del.addEventListener('click',()=>{delete ed.obs[pin.id];st.active=i;renderMarks();renderList();updateButtons();});
         li.append(del);
       }
       return li;
     }).filter(Boolean));
     return;
   }
   el.list.replaceChildren(...st.pins.map((pin,i)=>{
     const li=document.createElement('li');li.dataset.index=String(i);
     li.dataset.state=st.phase==='model'?(i===st.active?'active':pin.X?'done':'todo'):'';
     const label=document.createElement('button');label.type='button';label.className='tw-point';
     label.textContent=`${i+1}`;
     const text=document.createElement('span');
     text.textContent=st.phase==='video'?(pin.snapped?'corner':'free point'):pin.X?'matched':i===st.active?'click it on the model':'not matched';
     label.append(text);
     label.addEventListener('click',()=>{if(st.phase==='model'){st.active=i;renderMarks();renderList();updateButtons();
       say(`Click point ${i+1} on the 3D model.`);}});
     li.append(label);
     if(st.phase==='video'){
       const del=document.createElement('button');del.type='button';del.className='tw-del';del.textContent='×';
       del.setAttribute('aria-label',`Delete point ${i+1}`);
       del.addEventListener('click',()=>{st.pins.splice(i,1);renderMarks();renderList();updateButtons();});
       li.append(del);
     }
     return li;
   }));
 }
 function updateButtons(){
   if(!st)return;
   const n=st.pins.length,matched=matchedPins(st.pins).length;
   if(st.phase==='video'){
     el.done.disabled=n<MIN_PIN_POINTS;
     renderFrames();
     el.time.disabled=n>0;el.time.title=n>0?'Clear the points to choose another reference frame':'Choose the frame to mark points on';
     say(n<MIN_PIN_POINTS?`${n} point${n===1?'':'s'} marked. Mark at least ${MIN_PIN_POINTS} (${RECOMMENDED_PINS}–10 is better), then press Done.`:
       `${n} points marked${n<RECOMMENDED_PINS?` (${RECOMMENDED_PINS} or more gives a steadier result)`:''}. Press Done when you are finished.`);
   }else if(st.phase==='frame'){
     const placed=Object.keys(st.editFrame.obs).length,matched=st.pins.filter(eligible).length;
     el.done.disabled=placed<MIN_PIN_POINTS;
     el.time.disabled=placed>0;el.time.title=placed>0?'Remove the points to choose another frame':'Choose the extra frame';
     say(placed<MIN_PIN_POINTS?`${placed} of ${matched} points placed. Place at least ${MIN_PIN_POINTS}, then press Save frame.`:
       `${placed} of ${matched} points placed. Press Save frame when you are finished.`);
   }else if(st.phase==='model'){
     el.done.disabled=matched<MIN_PIN_POINTS;
     el.skip.disabled=!st.pins.length;
   }else if(st.phase==='compare'){
     el.done.disabled=!st.resection?.ok;
   }
 }

 // ---- video phase: click / drag ----
 let drag=null;
 const dragTarget=()=>st.phase==='frame'?st.editFrame.obs[st.pins[drag.index]?.id]:st.pins[drag.index];
 el.frameBox.addEventListener('pointerdown',e=>{
   if(!st||!['video','frame'].includes(st.phase)||e.button!==0)return;
   const rect=frameCss(),nx=clamp((e.clientX-rect.left)/rect.width,0,1),ny=clamp((e.clientY-rect.top)/rect.height,0,1);
   const markEl=e.target.closest?.('.tw-mark');
   if(markEl){drag={index:Number(markEl.dataset.index)};el.frameBox.setPointerCapture(e.pointerId);e.preventDefault();return;}
   if(st.phase==='frame'){
     // Extra frames reuse the numbered points matched on the model: never more than the first frame has.
     const ed=st.editFrame;
     let i=st.active;
     if(!st.pins[i]||!eligible(st.pins[i])||ed.obs[st.pins[i].id])i=st.pins.findIndex(p=>eligible(p)&&!ed.obs[p.id]);
     if(i<0){say('Every matched point is already placed in this frame. Drag one to adjust it.','warn');return;}
     const hit=snapAt(nx,ny);
     ed.obs[st.pins[i].id]={x:hit.x,y:hit.y,snapped:hit.snapped};
     const next=st.pins.findIndex((p,k)=>k>i&&eligible(p)&&!ed.obs[p.id]);
     st.active=next>=0?next:st.pins.findIndex(p=>eligible(p)&&!ed.obs[p.id]);
     renderMarks();renderList();updateButtons();return;
   }
   if(st.pins.length>=MAX_PINS){say(`At most ${MAX_PINS} points. Delete one first.`,'warn');return;}
   const hit=snapAt(nx,ny);
   st.pins.push({id:nextId(),x:hit.x,y:hit.y,snapped:hit.snapped,X:null});
   renderMarks();renderList();updateButtons();
 });
 el.frameBox.addEventListener('pointermove',e=>{
   if(!drag||!st)return;
   const rect=frameCss();
   const pin=dragTarget();if(!pin)return;
   pin.x=clamp((e.clientX-rect.left)/rect.width,0,1);pin.y=clamp((e.clientY-rect.top)/rect.height,0,1);
   renderMarks();
 });
 const endDrag=()=>{
   if(!drag||!st)return;
   const pin=dragTarget(),hit=pin?snapAt(pin.x,pin.y,10):null;
   if(!pin){drag=null;return;}
   pin.x=hit.x;pin.y=hit.y;pin.snapped=hit.snapped;drag=null;renderMarks();renderList();
 };
 el.frameBox.addEventListener('pointerup',endDrag);el.frameBox.addEventListener('pointercancel',endDrag);

 // ---- scrubbing the reference frame ----
 let scrubTimer=null;
 el.time.addEventListener('input',()=>{
   if(!st||!['video','frame'].includes(st.phase)||(st.phase==='video'?st.pins.length:Object.keys(st.editFrame.obs).length))return;
   const t=Number(el.time.value);el.timeText.textContent=clock(t);
   clearTimeout(scrubTimer);scrubTimer=setTimeout(()=>loadFrameAt(t),120);
 });
 el.clear.addEventListener('click',()=>{if(!st)return;st.pins=[];st.extra=[];st.extraFits=[];st.active=0;renderMarks();renderList();updateButtons();});

 // ---- model phase ----
 function firstUnmatched(from=0){
   const n=st.pins.length;
   for(let k=0;k<n;k++){const i=(from+k)%n;if(!st.pins[i].X)return i;}
   return -1;
 }
 function syncMarkers(){
   host.setMarkers(st.pins.map((p,i)=>p.X?{n:i+1,X:p.X}:null).filter(Boolean));
 }
 function onModelPick(hit){
   if(!st||st.phase!=='model')return;
   if(!hit?.point){say('No model surface there. Click directly on the model.','warn');return;}
   const pin=st.pins[st.active];if(!pin)return;
   pin.X=hit.point;pin.modelSnapped=!!hit.snapped;
   syncMarkers();
   const next=firstUnmatched(st.active+1);
   if(next>=0){st.active=next;say(`Point ${st.active} matched${hit.snapped?' (snapped to a corner)':''}. Now click point ${next+1}.`);}
   else say(`All ${st.pins.length} points matched. Press Done.`);
   renderMarks();renderList();updateButtons();
 }
 el.skip.addEventListener('click',()=>{
   if(!st||st.phase!=='model')return;
   const pin=st.pins[st.active];if(pin)pin.X=null;
   const next=firstUnmatched(st.active+1);
   if(next>=0&&next!==st.active)st.active=next;
   renderMarks();renderList();updateButtons();syncMarkers();
   say(`Skipped. Click point ${st.active+1} on the model, or press Done if ${MIN_PIN_POINTS}+ are matched.`);
 });

 // ---- compare phase ----
 function renderCompare(){
   el.svg.replaceChildren();
   const res=st.resection;if(!res?.ok)return;
   const {width:W,height:H}=st.frame;
   matchedPins(st.pins).forEach((pin,k)=>{
     const px=pin.x*W,py=pin.y*H,proj=projectPoint(res.pose,res.fov,W,H,pin.X);
     const g=document.createElementNS(SVG,'g');
     if(proj){const line=document.createElementNS(SVG,'line');
       line.setAttribute('x1',px);line.setAttribute('y1',py);line.setAttribute('x2',proj.x);line.setAttribute('y2',proj.y);line.setAttribute('class','tw-err');g.append(line);
       const ring=document.createElementNS(SVG,'circle');ring.setAttribute('cx',proj.x);ring.setAttribute('cy',proj.y);ring.setAttribute('r',Math.max(6,W/150));ring.setAttribute('class','tw-ring');g.append(ring);}
     const s=Math.max(7,W/120),cross=document.createElementNS(SVG,'path');
     cross.setAttribute('d',`M${px-s} ${py}H${px+s}M${px} ${py-s}V${py+s}`);cross.setAttribute('class','tw-cross');g.append(cross);
     el.svg.append(g);
   });
 }
 el.lens.addEventListener('change',()=>{
   if(!st||st.phase!=='compare')return;
   const v=el.lens.value.trim()===''?null:Number(el.lens.value);
   st.lens=v!=null&&Number.isFinite(v)&&v>=12&&v<=110?v:null;
   enterCompare();
 });
 function setWipe(percent){
   const p=clamp(percent,0,100);root.style.setProperty('--wipe',p+'%');el.wipe.value=String(p);
 }
 el.wipe.addEventListener('input',()=>setWipe(Number(el.wipe.value)));
 let wiping=false;
 el.frameBox.addEventListener('pointerdown',e=>{
   if(!st||st.phase!=='compare')return;wiping=true;el.frameBox.setPointerCapture(e.pointerId);
   const r=frameCss();setWipe((e.clientX-r.left)/r.width*100);
 });
 el.frameBox.addEventListener('pointermove',e=>{if(wiping&&st?.phase==='compare'){const r=frameCss();setWipe((e.clientX-r.left)/r.width*100);}});
 el.frameBox.addEventListener('pointerup',()=>{wiping=false;});

 /** Vertical FOV of the chapter's first camera key (what it uses today), or null. */
 function chapterFov(){
   const key=host.getSequence()?.camera?.filter(k=>k.at>=st.shot.start-1e-4&&k.at<st.shot.end).sort((a,b)=>a.at-b.at)[0];
   return Number.isFinite(key?.fov)?key.fov:null;
 }
 /** Camera at each extra reference frame, with the lens fixed to the first frame's. */
 function fitExtraFrames(){
   const {width:W,height:H}=st.frame,res=st.resection;
   return (st.extra||[]).map(e=>{
     const pts=matchedPins(st.pins).filter(p=>e.obs[p.id]).map(p=>({x:e.obs[p.id].x*W,y:e.obs[p.id].y*H,X:p.X}));
     if(pts.length<MIN_PIN_POINTS)return {time:e.time,points:pts.length,usable:false,reason:`only ${pts.length} of its points are still matched`};
     const r=resectCamera(pts,{width:W,height:H,fov:res.fov});
     if(!r.ok)return {time:e.time,points:pts.length,usable:false,reason:r.reason};
     return {time:e.time,points:pts.length,res:r,rmsPx:r.rmsPx,usable:r.rmsPx<=EXTRA_MAX_RMS_PX&&!r.ambiguous,
       reason:r.ambiguous?'its points fit more than one camera position':r.rmsPx>EXTRA_MAX_RMS_PX?`its points disagree with the model (${r.rmsPx.toFixed(1)} px)`:''};
   });
 }
 function renderFrames(){
   const fits=st.extraFits||[];
   el.frames.replaceChildren(...(st.extra||[]).map((e,i)=>{
     const f=st.phase==='compare'?fits[i]:null,n=Object.keys(e.obs).length;
     const li=document.createElement('li');
     const text=document.createElement('span');
     text.textContent=`Frame ${i+2} · ${clock(e.time)} · ${f?f.points:n} points`+(f?(f.usable?` · ${f.rmsPx.toFixed(1)} px`:` · not used: ${f.reason}`):'');
     if(f&&!f.usable)li.dataset.state='bad';
     const del=document.createElement('button');del.type='button';del.className='tw-del';del.textContent='×';
     del.setAttribute('aria-label',`Remove reference frame ${i+2}`);
     del.addEventListener('click',()=>{st.extra.splice(i,1);if(st.phase==='compare')enterCompare();else{renderFrames();}});
     li.append(text,del);return li;
   }));
   const full=(st.extra||[]).length>=MAX_EXTRA_FRAMES;
   el.addFrame.disabled=full||(st.phase==='video'&&st.pins.length<MIN_PIN_POINTS);
   el.addFrame.title=st.phase==='video'&&st.pins.length<MIN_PIN_POINTS?`Mark at least ${MIN_PIN_POINTS} points first`:'Mark the same numbered points in another frame';
 }
 function enterCompare(){
   const pins=matchedPins(st.pins),{width:W,height:H}=st.frame;
   const res=resectCamera(pins.map(p=>({x:p.x*W,y:p.y*H,X:p.X})),{width:W,height:H,fov:st.lens});
   st.resection=res;
   el.lens.value=st.lens==null?'':String(st.lens);
   if(res.ok)el.lens.placeholder=res.fov.toFixed(0);
   host.setPicking(false);host.setMarkers([]);
   if(!res.ok){setPhase('compare');renderCompare();say(res.reason,'error');el.stats.textContent='';return;}
   host.showCompareView({pose:res.pose,fov:res.fov,videoAspect:W/H});
   const keepWipe=st.phase==='compare';
   setPhase('compare');if(!keepWipe)setWipe(50);renderCompare();
   const own=chapterFov();
   const far=st.lens==null&&own&&(res.fov<own*.75||res.fov>own*1.33);
   el.lensNote.textContent=st.lens!=null?(Math.abs(st.lens-(own||-1))<.05?`Using this chapter's lens (${st.lens}°), so the points are matched at that zoom and the camera distance follows from it. Clear the box to estimate the lens from your points instead (can drift).`:'Fixed. Clear the box to estimate it again.'):
     far?`Estimated ${res.fov.toFixed(0)}°, but this chapter's camera uses ${own.toFixed(0)}°. A much narrower lens puts the camera far from the model: type the real lens angle (${own.toFixed(0)}° keeps the current one).`:
     'Estimated from your points. A few points at similar depth cannot tell lens from distance: type the lens angle if you know it.';
   el.lensNote.dataset.kind=far?'warn':'';
   st.extraFits=fitExtraFrames();renderFrames();
   const worst=Math.max(...res.errors),worstIndex=res.errors.indexOf(worst),worstNumber=st.pins.indexOf(pins[worstIndex])+1;
   const quality=res.rmsPx<3?'good':res.rmsPx<8?'fair':'poor';
   el.stats.textContent=`${quality} match · average ${res.rmsPx.toFixed(1)} px · worst point ${worstNumber} (${worst.toFixed(1)} px) · lens ${res.fov.toFixed(0)}°${res.fovEstimated?' (estimated)':''}`+
     (st.extraFits.length?` · ${st.extraFits.filter(f=>f.usable).length} extra reference frame${st.extraFits.filter(f=>f.usable).length===1?'':'s'} will correct drift`:'');
   say(res.ambiguous?'These points fit more than one camera position. Add more points, spread out in depth, for a reliable match.':
     quality==='poor'?'The points disagree with the model. Go back and check that each video point is matched to the same spot, and that this is the video the timeline was made from.':
     'Drag the slider to compare. If it lines up, press Track motion.',res.ambiguous||quality==='poor'?'warn':'');
 }

 // ---- tracking + preview ----
 function buildPreview(){
   const shot=st.shot,seq=host.getSequence(),res=st.resection,pins=matchedPins(st.pins);
   const centroid=[0,1,2].map(k=>pins.reduce((s,p)=>s+p.X[k],0)/pins.length);
   const target=Math.max(1,Math.hypot(...centroid.map((c,k)=>c-res.center[k])));
   const refs=(st.extraFits||[]).filter(f=>f.usable).map(f=>({time:f.time,center:f.res.center,forward:f.res.forward}));
   const fixed=segmentsToKeys(st.track.segments,{fov:res.fov,targetDistance:target,density:st.density,refs});
   const keys=fixed.keys;
   const savedPins={version:1,refTime:st.refTime,fov:Math.round(res.fov*100)/100,
     points:pins.map(p=>({x:Math.round(p.x*1e5)/1e5,y:Math.round(p.y*1e5)/1e5,X:p.X.map(v=>Math.round(v*1000)/1000)}))};
   if(refs.length)savedPins.extraFrames=(st.extra||[]).filter((e,i)=>st.extraFits[i]?.usable).map(e=>({time:Math.round(e.time*1000)/1000,
     points:pins.map((p,k)=>e.obs[p.id]?{point:k,x:Math.round(e.obs[p.id].x*1e5)/1e5,y:Math.round(e.obs[p.id].y*1e5)/1e5}:null).filter(Boolean)}));
   const proposal=buildAnchoredCameraProposal(seq,shot.id,{keys,anchor:host.getAnchor(shot.id),pins:savedPins,
     summary:{scale:st.track.scale,anchorRmsPx:st.track.anchorRmsPx==null?null:Math.round(st.track.anchorRmsPx*100)/100,
       pins:pins.length,rollDeg:Math.round(st.track.rollDeg*10)/10,referenceFrames:refs.length+1,segments:fixed.segments,
       correctionDeg:fixed.corrections.length?Math.round(Math.max(...fixed.corrections.map(c=>c.degrees))*10)/10:0}});
   host.previewProposal(proposal);
   st.proposal=proposal;
   const r=proposal.report;
   el.stats.textContent=`${r.updatedKeys} new camera keys will replace this chapter's ${r.removedKeys} current key${r.removedKeys===1?'':'s'}`+
     (st.track.anchorRmsPx!=null?` · pinned points reproject within ${st.track.anchorRmsPx.toFixed(1)} px`:'')+
     (st.track.rollDeg>4?` · note: the video camera is rolled ${st.track.rollDeg.toFixed(0)}°, which keys cannot store`:'')+
     (fixed.corrections.length?` · ${refs.length} extra reference frame${refs.length===1?'':'s'} corrected the path by up to ${Math.max(...fixed.corrections.map(c=>c.degrees)).toFixed(1)}°`:'')+
     (fixed.segments>1?` · ${fixed.segments} tracked stretches joined by a cut`:'')+
     (st.track.gaps.length?` · NOT TRACKED ${st.track.gaps.map(g=>`${clock(g.from)}–${clock(g.to)}`).join(', ')}${st.track.cutAt!=null?` (the picture cuts at ${clock(st.track.cutAt)}; add a reference frame after the cut to continue)`:''}: camera held there`:'')+
     (st.track.problems.length?` · ${st.track.problems.map(p=>p.direction+': '+p.message).join('; ')}`:'');
   say('Scrub or play the timeline to review the new camera. Apply to save it, or go back to adjust the points.');
 }
 /** Extra reference frames that can each start a tracked stretch: their own camera fix and the points seen there. */
 function extraSegments(){
   return (st.extra||[]).map((e,i)=>({e,fit:st.extraFits?.[i]})).filter(({fit})=>fit?.usable).map(({e,fit})=>({time:e.time,refPose:fit.res.pose,
     pins:matchedPins(st.pins).filter(p=>e.obs[p.id]).map(p=>({id:p.id,x:e.obs[p.id].x,y:e.obs[p.id].y,X:p.X}))}));
 }
 async function startTracking(){
   const res=st.resection,pins=matchedPins(st.pins);
   host.exitView();host.hideCompareView?.();
   setPhase('tracking');st.abort=new AbortController();
   el.progress.removeAttribute('value');say('Decoding frames…');
   try{
     st.track=await trackAnchored({source:st.source,chapter:{start:st.shot.start,end:st.shot.end},refTime:st.refTime,
       pins:pins.map(p=>({id:p.id,x:p.x,y:p.y,X:p.X})),refPose:res.pose,fov:res.fov,signal:st.abort.signal,
       extras:extraSegments(),
       onProgress:p=>{
         if(p.phase==='tracking'){el.progress.max=p.frames;el.progress.value=p.frame;say(`Tracking frame ${p.frame}/${p.frames} (${p.direction}) · ${p.active} points`);}
         else{el.progress.removeAttribute('value');say('Solving the camera path…');}
       }});
     if(!st)return;
     setPhase('preview');buildPreview();
   }catch(error){
     if(!st)return;
     if(error.cancelled){backToCompare('Tracking cancelled. Nothing was saved.');return;}
     backToCompare(`${error.message}${error.summary?' ('+describeTrackSummary(error.summary)+')':''}. Nothing was saved.`);
   }
 }
 function backToCompare(message){
   host.discardProposal();
   st.resection=null;enterModelThenCompare(message);
 }
 function enterModelThenCompare(message){
   // Re-run the resection so the compare view and its wipe are restored.
   enterCompare();if(message)say(message,'warn');
 }
 el.density.addEventListener('change',()=>{
   if(!st||st.phase!=='preview')return;
   st.density=el.density.value;host.discardProposal();
   try{buildPreview();}catch(error){say(error.message,'error');}
 });
 el.apply.addEventListener('click',()=>{
   if(!st||st.phase!=='preview'||!st.proposal)return;
   if(!host.canEdit()){say('Finish the active AI job or proposal first.','warn');return;}
   try{host.applyProposal();host.notify?.(`Camera keys saved for ${st.shot.name}. Undo is available.`);close({keepProposal:true});}
   catch(error){say('Not applied: '+error.message,'error');}
 });
 el.discard.addEventListener('click',()=>{if(st?.phase==='preview'){host.discardProposal();st.proposal=null;say('Preview discarded. Saved camera keys are unchanged.');}});

 // ---- navigation buttons ----
 async function returnFromFrame(){
   const from=st.frameFrom;
   st.editFrame=null;
   await loadFrameAt(st.refTime);
   if(!st)return;
   if(from==='compare')enterCompare();else{setPhase('video');renderFrames();}
 }
 el.addFrame.addEventListener('click',async()=>{
   if(!st||!['video','compare'].includes(st.phase)||(st.extra||[]).length>=MAX_EXTRA_FRAMES||el.addFrame.disabled)return;
   st.frameFrom=st.phase;
   const {start,end}=st.shot,span=end-start;
   // Start far from the first reference frame, where the camera has moved most.
   const t=st.refTime<start+span/2?end-span*.15:start+span*.1;
   st.editFrame={time:t,obs:{}};
   st.active=st.pins.findIndex(eligible);
   if(st.frameFrom==='compare')host.hideCompareView?.();
   el.time.value=String(t);setPhase('frame');
   await loadFrameAt(t);
   if(st?.editFrame){say(`Scrub to a frame where the camera has moved, then click where point ${st.active+1} is.`);}
 });
 el.done.addEventListener('click',()=>{
   if(!st||el.done.disabled)return;
   if(st.phase==='frame'){
     const ed=st.editFrame,{width:W,height:H}=st.frame;
     if(Math.abs(ed.time-st.refTime)<.1){say('Choose a frame at least a tenth of a second away from the first reference frame.','warn');return;}
     if(st.frameFrom==='compare'){
     const pts=matchedPins(st.pins).filter(p=>ed.obs[p.id]).map(p=>({x:ed.obs[p.id].x*W,y:ed.obs[p.id].y*H,X:p.X}));
     const r=resectCamera(pts,{width:W,height:H,fov:st.resection.fov});
     if(!r.ok){say(r.reason,'error');return;}
     if(r.rmsPx>EXTRA_MAX_RMS_PX){say(`These points do not fit the model from any camera (${r.rmsPx.toFixed(1)} px). Check that each number marks the same spot as before.`,'error');return;}
     }
     (st.extra=st.extra||[]).push({time:ed.time,obs:ed.obs});
     returnFromFrame();return;
   }
   if(st.phase==='video'){
     st.active=0;st.pins.forEach(p=>{p.X=null;});
     host.enterModelView(st.shot.id);host.setPicking(true,onModelPick);
     setPhase('model');syncMarkers();say('Click point 1 on the 3D model.');
   }else if(st.phase==='model'){enterCompare();}
   else if(st.phase==='compare'){startTracking();}
 });
 el.back.addEventListener('click',()=>{
   if(!st)return;
   if(st.phase==='frame'){returnFromFrame();return;}
   if(st.phase==='model'){host.setPicking(false);host.setMarkers([]);host.exitView();setPhase('video');}
   else if(st.phase==='compare'){
     host.hideCompareView?.();host.enterModelView(st.shot.id);host.setPicking(true,onModelPick);
     setPhase('model');syncMarkers();say('Adjust any point: click it in the list, then click its spot on the model.');
   }else if(st.phase==='preview'){
     host.discardProposal();st.proposal=null;enterCompare();
   }
 });
 el.cancel.addEventListener('click',()=>{
   if(!st)return;
   if(st.phase==='tracking'){st.abort?.abort();return;}
   close();
 });
 root.addEventListener('keydown',e=>{if(e.key==='Escape'&&st&&st.phase!=='tracking'){e.stopPropagation();close();}});

 // ---- open / close ----
 async function open(){
   if(st)return;
   const shot=host.getShot(),seq=host.getSequence();
   if(!shot||!seq)return;
   if(!host.canEdit()){host.notify?.('Finish the active AI job or proposal first.');return;}
   const source=host.resolveSource(shot);
   if(!source?.url){host.notify?.(source?.reason||'Attach the source video first.');return;}
   if(!seq.primitiveScenes?.scenes?.some(s=>s.shotId===shot.id&&s.objects?.length)){host.notify?.('This chapter needs a 3D model first.');return;}
   const own=host.getSequence().camera.filter(k=>k.at>=shot.start-1e-4&&k.at<shot.end).sort((a,b)=>a.at-b.at)[0]?.fov;
   st={shot:{...shot},source,pins:[],active:0,nextPin:1,density:'normal',phase:'video',frame:null,track:null,proposal:null,frameFrom:'video',resection:null,lens:Number.isFinite(own)?clamp(Math.round(own*10)/10,12,110):null,extra:[],extraFits:[],editFrame:null};
   root.hidden=false;
   el.density.value='normal';
   say('Loading the video…');
   try{
     st.loader=await createFrameLoader(source.url);
     const start=shot.start+Math.min(.1,(shot.end-shot.start)/10);
     el.time.min=String(shot.start);el.time.max=String(shot.end);el.time.step='0.0333';el.time.value=String(start);
     setPhase('video');
     await loadFrameAt(start);
   }catch(error){
     host.notify?.('Could not open the video: '+error.message);close();
   }
 }
 function close({keepProposal=false}={}){
   if(!st)return;
   const phase=st.phase;
   st.abort?.abort();
   host.setPicking(false);host.setMarkers([]);host.hideCompareView?.();
   if(!keepProposal&&st.proposal)host.discardProposal();
   if(phase!=='preview'||!keepProposal)host.exitView();
   st.loader?.close();
   host.setFocusLayout?.(false);
   root.hidden=true;root.removeAttribute('data-phase');
   el.canvasHolder.replaceChildren();el.svg.replaceChildren();el.marks.replaceChildren();
   st=null;
 }
 /** Called when the playhead's chapter or the project changes. */
 function refresh(){
   if(!st)return;
   const shot=host.getShot();
   if(!shot||shot.id!==st.shot.id){host.notify?.('Tracking closed because the chapter changed.');close();}
 }
 window.addEventListener('resize',()=>{if(st)layout();});
 if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>{if(st)layout();}).observe(root);
 return {open,close,refresh,get isOpen(){return !!st;},get phase(){return st?.phase||null;},
   // Test hooks: drive the wizard without pointer events on the 3D canvas.
   _state:()=>st};
}
export {DENSITY,PHASES};
