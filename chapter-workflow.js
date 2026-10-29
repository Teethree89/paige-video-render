// Guided chapter workflow: 1 choose a source workflow, 2 generate base models
// and colors, 3 add camera movement, 4 name the chapter and continue.
// Status is derived from timeline data only (no extra saved state besides the
// optional `nameConfirmed` / `cameraConfirmed` chapter flags), so imported,
// undone or hand-edited timelines always show their true progress.
import {isEmptyWorkspace} from './workspace-reset.js';

export const WORKFLOW_STEPS=Object.freeze([
 {id:'source',label:'Choose workflow',short:'Source'},
 {id:'geometry',label:'Base models & colors',short:'Models'},
 {id:'camera',label:'Camera movement',short:'Camera'},
 {id:'name',label:'Name & continue',short:'Name'},
]);
export const CAMERA_STATES=Object.freeze({
 none:'No camera keys',placeholder:'Stationary placeholder',estimated:'AI motion estimate',
 tracked:'Tracked video motion',authored:'Authored keys',kept:'Kept as is'});
export const MAX_CHAPTER_NAME=80;

const shotKeys=(sequence,shot)=>{
 const last=sequence.shots.at(-1)?.id===shot.id;
 return sequence.camera.filter(k=>k.at>=shot.start-.0001&&(k.at<shot.end-.0001||(last&&k.at<=shot.end+.0001)));
};
/** Chapters created by Video → timeline or Reference Builder need the guided steps. */
export const isGuidedChapter=shot=>!!(shot&&(shot.draft===true||/^draft_/.test(shot.id||'')));
export function isGuidedProject(sequence){
 return !!(sequence&&(sequence.videoIntake||sequence.referenceSequence||sequence.shots?.some(isGuidedChapter)));
}
export function chapterGeometry(sequence,shot){
 const scene=sequence?.primitiveScenes?.scenes?.find(s=>s.shotId===shot?.id);
 return scene?.objects?.length||0;
}
export function chapterCamera(sequence,shot){
 const keys=shotKeys(sequence,shot);
 if(!keys.length)return shot.cameraConfirmed?'kept':'none';
 if(keys.some(k=>k.generated==='video-track'))return 'tracked';
 if(keys.some(k=>k.generated==='video-estimate'))return 'estimated';
 const untouched=keys.every(k=>k.generated==='placeholder')&&(!Array.isArray(shot.placeholderCameraKeys)||
   JSON.stringify(keys)===JSON.stringify(shot.placeholderCameraKeys));
 if(untouched)return shot.cameraConfirmed?'kept':'placeholder';
 return 'authored';
}
/**
 * @returns {{guided:boolean,objects:number,geometry:boolean,camera:string,cameraDone:boolean,
 *   named:boolean,pending:boolean,step:'geometry'|'camera'|'name'|'done'}}
 */
export function chapterStatus(sequence,shot){
 const guided=isGuidedChapter(shot),objects=chapterGeometry(sequence,shot),camera=chapterCamera(sequence,shot);
 const geometry=objects>0||!guided,cameraDone=!guided||!['none','placeholder'].includes(camera);
 const named=!guided||shot.nameConfirmed===true;
 const step=!geometry?'geometry':!cameraDone?'camera':!named?'name':'done';
 return {guided,objects,geometry,camera,cameraDone,named,pending:guided&&(!geometry||!cameraDone),step};
}
export function projectProgress(sequence){
 const chapters=(sequence?.shots||[]).map((shot,index)=>({shot,index,status:chapterStatus(sequence,shot)}));
 const guided=chapters.filter(c=>c.status.guided);
 return {chapters,guided:guided.length,done:guided.filter(c=>c.status.step==='done').length,
   pending:guided.filter(c=>c.status.pending).length};
}
/** The next chapter (after `fromId`, wrapping) that still needs a step. */
export function nextOpenChapter(sequence,fromId=null){
 const {chapters}=projectProgress(sequence),start=Math.max(0,chapters.findIndex(c=>c.shot.id===fromId));
 for(let i=1;i<=chapters.length;i++){
   const c=chapters[(start+i)%chapters.length];
   if(c.status.guided&&c.status.step!=='done')return c.shot;
 }
 return null;
}
/** Which of the four guide steps is active for the current chapter. */
export function workflowStep(sequence,shot){
 if(!sequence||isEmptyWorkspace(sequence)||!isGuidedProject(sequence))return 'source';
 const status=chapterStatus(sequence,shot);
 return status.step==='done'?'name':status.step;
}

export function cleanChapterName(value){
 const name=String(value??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim();
 if(!name)throw Error('Enter a chapter name.');
 if(name.length>MAX_CHAPTER_NAME)throw Error(`Chapter names are limited to ${MAX_CHAPTER_NAME} characters.`);
 return name;
}
/** Returns a renamed copy; the original timeline object is not changed. */
export function nameChapter(sequence,shotId,value){
 const name=cleanChapterName(value),next=structuredClone(sequence),shot=next.shots.find(s=>s.id===shotId);
 if(!shot)throw Error('Unknown chapter');
 shot.name=name;shot.title=name.toUpperCase();shot.nameConfirmed=true;
 return next;
}
/** Marks a stationary / placeholder camera as intentional for this chapter. */
export function keepChapterCamera(sequence,shotId){
 const next=structuredClone(sequence),shot=next.shots.find(s=>s.id===shotId);
 if(!shot)throw Error('Unknown chapter');
 shot.cameraConfirmed=true;
 return next;
}
const DEFAULT_NAME=/^(Shot \d+ · blockout pending|Scene \d+)$/;
/** Editable suggestion: the current name unless it is a generated default, else the largest objects' names. */
export function suggestChapterName(sequence,shot){
 if(shot?.name&&!DEFAULT_NAME.test(shot.name))return shot.name.slice(0,MAX_CHAPTER_NAME);
 const scene=sequence?.primitiveScenes?.scenes?.find(s=>s.shotId===shot?.id);
 const size=o=>(o.scale||[1,1,1]).reduce((a,b)=>a*Math.abs(b),1)*
   (Array.isArray(o.repeat)?o.repeat.reduce((n,r)=>n*Math.max(1,r?.count||1),1):1);
 const names=[];
 for(const o of [...(scene?.objects||[])].sort((a,b)=>size(b)-size(a))){
   const n=String(o.name||'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim();
   if(n&&!names.some(x=>x.toLowerCase()===n.toLowerCase()))names.push(n);
   if(names.length===2)break;
 }
 const index=(sequence?.shots?.indexOf(shot)??0)+1;
 return (names.join(' & ')||'Chapter '+String(index).padStart(2,'0')).slice(0,MAX_CHAPTER_NAME);
}

const CAMERA_HINT={
 none:'No camera keys in this chapter yet.',
 placeholder:'Still on the stationary placeholder camera.',
 estimated:'Camera follows the AI video-motion estimate.',
 tracked:'Camera follows the tracked video motion.',
 authored:'Camera keys have been authored or synced.',
 kept:'Stationary camera kept on purpose.'};

/**
 * Wires the guide bar, the pending-chapter overlay and the naming card.
 * Every data change goes through `commit(nextSequence)` (undo + autosave).
 */
export function setupChapterWorkflow({getSequence,getShot,canEdit=()=>true,commit,seekToShot,actions={}}){
 const $=id=>document.getElementById(id);
 const guide=$('workflowGuide'),overlay=$('chapterPendingOverlay'),naming=$('chapterNameCard');
 if(!guide||!overlay||!naming)return null;
 const steps=new Map(WORKFLOW_STEPS.map(s=>[s.id,guide.querySelector(`[data-step="${s.id}"]`)]));
 const guideHint=$('workflowGuideHint'),guideAction=$('workflowGuideAction'),progress=$('workflowGuideProgress');
 const collapse=$('workflowGuideCollapse');
 const pendingTitle=$('chapterPendingTitle'),pendingEyebrow=$('chapterPendingEyebrow'),
   pendingList=$('chapterPendingChecklist'),pendingAction=$('chapterPendingAction'),
   pendingSecondary=$('chapterPendingSecondary'),pendingStatus=$('chapterPendingStatus'),pendingHide=$('chapterPendingHide'),pendingChip=$('chapterPendingChip');
 const nameInput=$('chapterNameInput'),nameSave=$('chapterNameSave'),nameNext=$('chapterNameNext'),
   nameStatus=$('chapterNameStatus'),nameEyebrow=$('chapterNameEyebrow');
 let lastSignature='',minimized=false,nameShot=null,collapsed=false,lastPendingShot=null;
 try{collapsed=localStorage.getItem('paige-workflow-guide-collapsed')==='1';}catch{}

 const run=(action,...args)=>{try{actions[action]?.(...args);}catch(error){console.warn('Workflow action failed:',error);}};
 const primaryFor=(stepId,status)=>{
   if(stepId==='source')return {label:'Start / open a project…',run:()=>run('openStart')};
   if(stepId==='geometry')return {label:'Generate base models & colors',run:()=>run('openGeneration')};
   if(stepId==='camera')return {label:'Add camera movement',run:()=>run('openCamera')};
   const next=nextOpenChapter(getSequence(),getShot()?.id);
   if(!status.named)return {label:'Name this chapter',run:()=>{nameInput?.focus();nameInput?.select();}};
   return next?{label:'Continue to next chapter →',run:()=>seekToShot(next.id)}:
     {label:'Refine this chapter',run:()=>run('openRefine')};
 };
 function commitSafely(next,message,status=nameStatus){
   if(!canEdit()){status.textContent='Finish the active AI job or proposal first.';return false;}
   try{commit(next);status.textContent=message||'';return true;}
   catch(error){status.textContent=error.message;return false;}
 }
 function saveName(advance){
   const sequence=getSequence(),shot=nameShot&&sequence?.shots.find(s=>s.id===nameShot);
   if(!shot)return;
   let next;
   try{next=nameChapter(sequence,shot.id,nameInput.value);}catch(error){nameStatus.textContent=error.message;return;}
   if(!commitSafely(next,'Chapter named.'))return;
   if(advance){const following=nextOpenChapter(next,shot.id);if(following)seekToShot(following.id);}
   refresh(true);
 }
 nameSave?.addEventListener('click',()=>saveName(false));
 nameNext?.addEventListener('click',()=>saveName(true));
 nameInput?.addEventListener('keydown',event=>{
   if(event.key==='Enter'){event.preventDefault();saveName(false);}
 });
 pendingHide?.addEventListener('click',()=>{minimized=true;refresh(true);});
 pendingChip?.addEventListener('click',()=>{minimized=false;refresh(true);});
 collapse?.addEventListener('click',()=>{
   collapsed=!collapsed;try{localStorage.setItem('paige-workflow-guide-collapsed',collapsed?'1':'0');}catch{}
   refresh(true);
 });
 for(const [id,node] of steps)node?.addEventListener('click',()=>{
   const sequence=getSequence(),shot=getShot();if(!sequence||!shot)return;
   const action=primaryFor(id,chapterStatus(sequence,shot));action.run();
 });
 guideAction?.addEventListener('click',()=>{
   const sequence=getSequence(),shot=getShot();if(!sequence||!shot)return;
   primaryFor(workflowStep(sequence,shot),chapterStatus(sequence,shot)).run();
 });

 function decorate(sequence){
   const {chapters}=projectProgress(sequence);
   const byId=new Map(chapters.map(c=>[c.shot.id,c.status]));
   for(const node of document.querySelectorAll('#shotTrack .shot-item[data-shot-id], #chapterList .chapter-item[data-shot]')){
     const status=byId.get(node.dataset.shotId||node.dataset.shot);if(!status)continue;
     node.classList.toggle('chapter-pending',status.pending);
     node.classList.toggle('chapter-unnamed',status.guided&&!status.pending&&!status.named);
     node.classList.toggle('chapter-ready',status.guided&&status.step==='done');
     node.dataset.workflow=status.guided?status.step:'';
     const text=status.pending?'Pending blocking: '+[!status.geometry&&'not generated',!status.cameraDone&&'not camera tracked'].filter(Boolean).join(', ')
       :status.guided&&!status.named?'Generated and camera ready: needs a name':'';
     if(text)node.setAttribute('aria-description',text);else node.removeAttribute('aria-description');
   }
 }
 function renderGuide(sequence,shot){
   const stepId=workflowStep(sequence,shot),status=chapterStatus(sequence,shot);
   const sourceDone=stepId!=='source';
   const done={source:sourceDone,geometry:sourceDone&&status.geometry,
     camera:sourceDone&&status.geometry&&status.cameraDone,name:sourceDone&&status.step==='done'};
   for(const [id,node] of steps){
     if(!node)continue;
     const state=done[id]?'done':id===stepId?'current':'upcoming';
     node.dataset.state=state;
     node.setAttribute('aria-current',state==='current'?'step':'false');
   }
   const {guided,done:ready,pending}=projectProgress(sequence);
   progress.textContent=sourceDone&&guided?`${ready}/${guided} chapters ready${pending?` · ${pending} pending`:''}`:'';
   const hints={
     source:'Start fresh: import a video or build a reference sequence. Each chapter then walks through models, camera and a name.',
     geometry:'This chapter has no generated geometry yet. Generate base models & colors (AI) or build shapes manually.',
     camera:CAMERA_HINT[status.camera]+' Add camera movement from the video, sync it to the model, or keep the camera as is.',
     name:status.named?'Chapter complete. Continue to the next chapter, or refine shapes, lights and camera.':
       'Models and camera are in place. Give this chapter a name.'};
   guideHint.textContent=hints[stepId];
   guideAction.textContent=primaryFor(stepId,status).label;
   guide.classList.toggle('collapsed',collapsed);
   collapse.textContent=collapsed?'Show steps':'Hide';
   collapse.setAttribute('aria-expanded',String(!collapsed));
 }
 function renderPending(sequence,shot){
   const status=chapterStatus(sequence,shot),index=sequence.shots.indexOf(shot)+1;
   const show=status.pending&&!actions.isEditing?.();
   overlay.hidden=!show||minimized;
   pendingChip.hidden=!show||!minimized;
   if(!show)return;
   if(lastPendingShot!==shot.id){lastPendingShot=shot.id;pendingStatus.textContent='';}
   pendingEyebrow.textContent=`CHAPTER ${String(index).padStart(2,'0')} · PENDING BLOCKING`;
   pendingTitle.textContent=!status.geometry&&!status.cameraDone?'This chapter has not yet been generated or camera tracked':
     !status.geometry?'This chapter has not yet been generated':'This chapter has not yet been camera tracked';
   const items=[[status.geometry,'Base models & colors',status.geometry?`${status.objects} objects`:'Not generated'],
     [status.cameraDone,'Camera movement',CAMERA_STATES[status.camera]],
     [status.named,'Chapter name',status.named?shot.name:'Named after generation']];
   pendingList.replaceChildren(...items.map(([ok,label,detail])=>{
     const li=document.createElement('li');li.className=ok?'done':'';
     const mark=document.createElement('span');mark.className='mark';mark.textContent=ok?'✓':'○';mark.setAttribute('aria-hidden','true');
     const text=document.createElement('span');text.textContent=label;
     const small=document.createElement('small');small.textContent=detail;
     li.append(mark,text,small);li.setAttribute('aria-label',`${label}: ${ok?'done':'pending'} (${detail})`);return li;}));
   const primary=primaryFor(status.step,status);
   pendingAction.textContent=primary.label;pendingAction.onclick=primary.run;
   if(!status.geometry){
     pendingSecondary.hidden=false;pendingSecondary.textContent='Build shapes manually';
     pendingSecondary.onclick=()=>run('openManual');
   }else{
     pendingSecondary.hidden=false;pendingSecondary.textContent='Keep camera as is';
     pendingSecondary.onclick=()=>commitSafely(keepChapterCamera(getSequence(),shot.id),'',pendingStatus)&&refresh(true);
   }
 }
 function renderNaming(sequence,shot){
   const status=chapterStatus(sequence,shot);
   const show=status.guided&&!status.pending&&!status.named&&!actions.isEditing?.();
   naming.hidden=!show;
   if(!show){nameShot=null;return;}
   if(nameShot!==shot.id){
     nameShot=shot.id;nameInput.value=suggestChapterName(sequence,shot);nameStatus.textContent='';
     nameEyebrow.textContent=`CHAPTER ${String(sequence.shots.indexOf(shot)+1).padStart(2,'0')} · GENERATED & CAMERA READY`;
   }
   nameNext.hidden=!nextOpenChapter(sequence,shot.id);
 }
 /** Cheap when nothing relevant changed; pass force after data edits. */
 function refresh(force=false){
   const sequence=getSequence(),shot=getShot();
   if(!sequence||!shot){guide.hidden=true;overlay.hidden=true;naming.hidden=true;return;}
   const signature=shot.id+'|'+!!actions.isEditing?.();
   if(!force&&signature===lastSignature)return;
   lastSignature=signature;guide.hidden=false;
   renderGuide(sequence,shot);renderPending(sequence,shot);renderNaming(sequence,shot);decorate(sequence);
 }
 return {refresh};
}
