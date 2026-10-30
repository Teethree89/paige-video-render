// Per-chapter camera tracking wizard.
//   1 Video points  : click the same spots the model has (clicks snap to corners), Done
//   2 Model points  : click the matching spots on the 3D model (snap to model corners), Done
//   3 Compare       : a before/after wipe of the video and the model seen from the solved camera
//   4 Tracking      : follow the pinned points through the chapter
//   5 Preview       : scrub the new camera path; Apply replaces this chapter's camera keys
// Everything runs in this browser. The host (app.js) owns the 3D view.
import {snapToCorner} from './feature-tracker.js';
import {resectCamera,projectPoint,MIN_PIN_POINTS} from './camera-resection.js';
import {pathToKeys,buildAnchoredCameraProposal,DENSITY} from './camera-anchor.js';
import {createFrameLoader,trackAnchored,describeTrackSummary} from './camera-track-ui.js';

export const MAX_PINS=24;
export const RECOMMENDED_PINS=6;
const SNAP_CSS_PX=14;
const PHASES=Object.freeze(['video','model','compare','tracking','preview']);
export const PHASE_COPY=Object.freeze({
 video:{step:'STEP 1 OF 3 · VIDEO',title:'Mark points in the video',
   help:'Click distinct spots that stay visible during the shot: building corners, roof edges, poles. Pick 6 to 10, spread across the frame. Clicks snap to the nearest corner; drag a point to adjust it.'},
 model:{step:'STEP 2 OF 3 · 3D MODEL',title:'Match each point on the model',
   help:'Orbit and zoom the model, then click the same spot as the highlighted point. Clicks snap to the nearest model corner. Skip a point you cannot find; at least 4 must be matched.'},
 compare:{step:'STEP 3 OF 3 · CHECK',title:'Does the model line up?',
   help:'Drag the slider: video on the left, the model seen from the solved camera on the right. Cyan crosses are your video points; orange rings are where the model points land.'},
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
   wipe:$('twWipe'),wipeRow:$('twWipeRow'),density:$('twDensity'),apply:$('twApply'),discard:$('twDiscard'),progress:$('twProgress'),stats:$('twStats'),
   timeRow:$('twTimeRow'),densityRow:$('twDensityRow')};
 let st=null;

 const say=(text,kind='')=>{el.status.textContent=text;el.status.dataset.kind=kind;};
 const setPhase=phase=>{
   st.phase=phase;root.dataset.phase=phase;
   // Pinning, comparing and tracking use the whole editor area; the preview needs the timeline back.
   host.setFocusLayout?.(phase!=='preview');
   const c=PHASE_COPY[phase];el.stepText.textContent=c.step;el.title.textContent=c.title;el.help.textContent=c.help;
   el.back.hidden=!['model','compare','preview'].includes(phase);
   el.clear.hidden=phase!=='video';el.skip.hidden=phase!=='model';el.timeRow.hidden=phase!=='video';
   el.wipeRow.hidden=phase!=='compare';el.density.closest('.tw-density').hidden=phase!=='preview';
   el.apply.hidden=el.discard.hidden=phase!=='preview';el.progress.hidden=phase!=='tracking';
   el.done.hidden=!['video','model','compare'].includes(phase);
   el.done.textContent=phase==='compare'?'Track motion':'Done';
   el.back.textContent=phase==='preview'?'Back to adjust':'Back';
   el.cancel.textContent=phase==='preview'?'Close':'Cancel';
   el.svg.hidden=phase!=='compare';el.handle.hidden=phase!=='compare';
   el.videoLayer.dataset.wipe=phase==='compare'?'on':'off';
   layout();renderMarks();renderList();updateButtons();
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
     st.refTime=time; // chapter time; the frame itself is read at the source time
     showFrame(frame);el.timeText.textContent=clock(time);
   }catch(error){say('Could not read the video frame: '+error.message,'error');}
 }

 // ---- pins ----
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
     el.time.disabled=n>0;el.time.title=n>0?'Clear the points to choose another reference frame':'Choose the frame to mark points on';
     say(n<MIN_PIN_POINTS?`${n} point${n===1?'':'s'} marked. Mark at least ${MIN_PIN_POINTS} (${RECOMMENDED_PINS}–10 is better), then press Done.`:
       `${n} points marked${n<RECOMMENDED_PINS?` (${RECOMMENDED_PINS} or more gives a steadier result)`:''}. Press Done when you are finished.`);
   }else if(st.phase==='model'){
     el.done.disabled=matched<MIN_PIN_POINTS;
     el.skip.disabled=!st.pins.length;
   }else if(st.phase==='compare'){
     el.done.disabled=!st.resection?.ok;
   }
 }

 // ---- video phase: click / drag ----
 let drag=null;
 el.frameBox.addEventListener('pointerdown',e=>{
   if(!st||st.phase!=='video'||e.button!==0)return;
   const rect=frameCss(),nx=clamp((e.clientX-rect.left)/rect.width,0,1),ny=clamp((e.clientY-rect.top)/rect.height,0,1);
   const markEl=e.target.closest?.('.tw-mark');
   if(markEl){drag={index:Number(markEl.dataset.index)};el.frameBox.setPointerCapture(e.pointerId);e.preventDefault();return;}
   if(st.pins.length>=MAX_PINS){say(`At most ${MAX_PINS} points. Delete one first.`,'warn');return;}
   const hit=snapAt(nx,ny);
   st.pins.push({id:nextId(),x:hit.x,y:hit.y,snapped:hit.snapped,X:null});
   renderMarks();renderList();updateButtons();
 });
 el.frameBox.addEventListener('pointermove',e=>{
   if(!drag||!st)return;
   const rect=frameCss();
   const pin=st.pins[drag.index];pin.x=clamp((e.clientX-rect.left)/rect.width,0,1);pin.y=clamp((e.clientY-rect.top)/rect.height,0,1);
   renderMarks();
 });
 const endDrag=()=>{
   if(!drag||!st)return;
   const pin=st.pins[drag.index],hit=snapAt(pin.x,pin.y,10);
   pin.x=hit.x;pin.y=hit.y;pin.snapped=hit.snapped;drag=null;renderMarks();renderList();
 };
 el.frameBox.addEventListener('pointerup',endDrag);el.frameBox.addEventListener('pointercancel',endDrag);

 // ---- scrubbing the reference frame ----
 let scrubTimer=null;
 el.time.addEventListener('input',()=>{
   if(!st||st.phase!=='video'||st.pins.length)return;
   const t=Number(el.time.value);el.timeText.textContent=clock(t);
   clearTimeout(scrubTimer);scrubTimer=setTimeout(()=>loadFrameAt(t),120);
 });
 el.clear.addEventListener('click',()=>{if(!st)return;st.pins=[];st.active=0;renderMarks();renderList();updateButtons();});

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

 function enterCompare(){
   const pins=matchedPins(st.pins),{width:W,height:H}=st.frame;
   const res=resectCamera(pins.map(p=>({x:p.x*W,y:p.y*H,X:p.X})),{width:W,height:H});
   st.resection=res;
   host.setPicking(false);host.setMarkers([]);
   if(!res.ok){setPhase('compare');renderCompare();say(res.reason,'error');el.stats.textContent='';return;}
   host.showCompareView({pose:res.pose,fov:res.fov,videoAspect:W/H});
   setPhase('compare');setWipe(50);renderCompare();
   const worst=Math.max(...res.errors),worstIndex=res.errors.indexOf(worst),worstNumber=st.pins.indexOf(pins[worstIndex])+1;
   const quality=res.rmsPx<3?'good':res.rmsPx<8?'fair':'poor';
   el.stats.textContent=`${quality} match · average ${res.rmsPx.toFixed(1)} px · worst point ${worstNumber} (${worst.toFixed(1)} px) · lens ${res.fov.toFixed(0)}°${res.fovEstimated?' (estimated)':''}`;
   say(res.ambiguous?'These points fit more than one camera position. Add more points, spread out in depth, for a reliable match.':
     quality==='poor'?'The points disagree. Go back and check that each video point is matched to the same spot on the model.':
     'Drag the slider to compare. If it lines up, press Track motion.',res.ambiguous||quality==='poor'?'warn':'');
 }

 // ---- tracking + preview ----
 function buildPreview(){
   const shot=st.shot,seq=host.getSequence(),res=st.resection,pins=matchedPins(st.pins);
   const centroid=[0,1,2].map(k=>pins.reduce((s,p)=>s+p.X[k],0)/pins.length);
   const target=Math.max(1,Math.hypot(...centroid.map((c,k)=>c-res.center[k])));
   const keys=pathToKeys(st.track.frames,{fov:res.fov,targetDistance:target,density:st.density});
   const savedPins={version:1,refTime:st.refTime,fov:Math.round(res.fov*100)/100,
     points:pins.map(p=>({x:Math.round(p.x*1e5)/1e5,y:Math.round(p.y*1e5)/1e5,X:p.X.map(v=>Math.round(v*1000)/1000)}))};
   const proposal=buildAnchoredCameraProposal(seq,shot.id,{keys,anchor:host.getAnchor(shot.id),pins:savedPins,
     summary:{scale:st.track.scale,anchorRmsPx:st.track.anchorRmsPx==null?null:Math.round(st.track.anchorRmsPx*100)/100,
       pins:pins.length,rollDeg:Math.round(st.track.rollDeg*10)/10}});
   host.previewProposal(proposal);
   st.proposal=proposal;
   const r=proposal.report;
   el.stats.textContent=`${r.updatedKeys} new camera keys will replace this chapter's ${r.removedKeys} current key${r.removedKeys===1?'':'s'}`+
     (st.track.anchorRmsPx!=null?` · pinned points reproject within ${st.track.anchorRmsPx.toFixed(1)} px`:'')+
     (st.track.rollDeg>4?` · note: the video camera is rolled ${st.track.rollDeg.toFixed(0)}°, which keys cannot store`:'')+
     (st.track.problems.length?` · ${st.track.problems.map(p=>p.direction+': '+p.message).join('; ')} (camera held there)`:'');
   say('Scrub or play the timeline to review the new camera. Apply to save it, or go back to adjust the points.');
 }
 async function startTracking(){
   const res=st.resection,pins=matchedPins(st.pins);
   host.exitView();host.hideCompareView?.();
   setPhase('tracking');st.abort=new AbortController();
   el.progress.removeAttribute('value');say('Decoding frames…');
   try{
     st.track=await trackAnchored({source:st.source,chapter:{start:st.shot.start,end:st.shot.end},refTime:st.refTime,
       pins:pins.map(p=>({id:p.id,x:p.x,y:p.y,X:p.X})),refPose:res.pose,fov:res.fov,signal:st.abort.signal,
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
 el.done.addEventListener('click',()=>{
   if(!st||el.done.disabled)return;
   if(st.phase==='video'){
     st.active=0;st.pins.forEach(p=>{p.X=null;});
     host.enterModelView(st.shot.id);host.setPicking(true,onModelPick);
     setPhase('model');syncMarkers();say('Click point 1 on the 3D model.');
   }else if(st.phase==='model'){enterCompare();}
   else if(st.phase==='compare'){startTracking();}
 });
 el.back.addEventListener('click',()=>{
   if(!st)return;
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
   st={shot:{...shot},source,pins:[],active:0,nextPin:1,density:'normal',phase:'video',frame:null,track:null,proposal:null,resection:null};
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
