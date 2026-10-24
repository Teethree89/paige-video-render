// Non-billable camera alignment for geometry already accepted into a chapter.
// Pre-accept AI proposal synchronizing remains independent in ai-scene-editor.js.
import {syncChapterCameraMotion} from './camera-motion-sync.js';

// Capture exactly the state a staged sync depends upon. Changes to geometry,
// chapter cuts or camera keys invalidate preview rather than committing stale data.
export function acceptedCameraSnapshot(sequence,shotId){
  const shot=sequence?.shots?.find(s=>s.id===shotId);
  if(!shot)throw Error('Select a valid chapter.');
  const geometry=sequence.primitiveScenes?.scenes?.find(s=>s.shotId===shotId);
  if(!geometry?.objects?.length)throw Error('No accepted 3D model in this chapter.');
  return JSON.stringify({
    shot,geometry,camera:sequence.camera,shots:sequence.shots.map(s=>[s.id,s.start,s.end])
  });
}
export function prepareAcceptedCameraSync(sequence,shotId,{
  bounds,anchor,modelCamera=null,mode='motion',aspect=16/9
}={}){
  const snapshot=acceptedCameraSnapshot(sequence,shotId);
  // Previous model bounds no longer exist after acceptance. Derive framing
  // from the saved camera path and the model's *current actual world bounds*.
  // This is deterministic and does not request or bill a Gemini model.
  const proposal=syncChapterCameraMotion(sequence,shotId,{
    oldBounds:null,newBounds:bounds,anchor,modelCamera,mode,aspect
  });
  return {...proposal,shotId,snapshot};
}
export function setupAcceptedCameraSync({
  getSequence,getActiveShot,getBounds,getAnchor,getCamera,canEdit,onPreview,onApply,onDiscard
}){
  const root=document.getElementById('acceptedCameraSyncPanel');
  if(!root)return null;
  const $=id=>document.getElementById(id);
  const mode=$('acceptedCameraSyncMode'),preview=$('acceptedCameraSyncPreview'),
    apply=$('acceptedCameraSyncApply'),cancel=$('acceptedCameraSyncCancel'),
    status=$('acceptedCameraSyncStatus');
  let staged=null,visibleShot=null;
  const tell=message=>{status.textContent=message;};
  function discard({notify=true}={}){
    const active=!!staged;
    staged=null;
    if(active)onDiscard();
    apply.disabled=true;cancel.hidden=true;
    if(notify)tell('Camera preview discarded. Saved model and camera keys are unchanged.');
  }
  function refresh(){
    const shot=getActiveShot();
    const id=shot?.id||null;
    if(staged&&staged.shotId!==id)discard({notify:false});
    const present=!!(shot&&getSequence()?.primitiveScenes?.scenes?.some(
      s=>s.shotId===id&&s.objects?.length));
    root.hidden=!present;
    if(!present){visibleShot=null;return;}
    if(id!==visibleShot&&!staged){
      visibleShot=id;
      tell('Accepted model detected. Preview camera alignment before applying changes. No AI call.');
    }
    const edit=canEdit(),reason=edit?'':'Finish the active AI job or proposal before changing saved cameras.';
    preview.disabled=!edit;
    mode.disabled=!edit;
    apply.disabled=!edit||!staged;
    if(reason&&!staged)tell(reason);
    if(staged&&acceptedCameraSnapshot(getSequence(),staged.shotId)!==staged.snapshot)
      discard({notify:false});
  }
  preview.addEventListener('click',()=>{
    if(!canEdit())return tell('Finish the active AI job or proposal before camera synchronization.');
    const shot=getActiveShot(),id=shot?.id;
    if(!id)return;
    try{
      if(staged)discard({notify:false});
      const proposal=prepareAcceptedCameraSync(getSequence(),id,{
        bounds:getBounds(id),anchor:getAnchor(id),modelCamera:getCamera(id),
        mode:mode.value,aspect:16/9
      });
      // Only the viewport uses these keys until explicit Apply.
      onPreview(proposal);
      staged=proposal;
      apply.disabled=false;cancel.hidden=false;
      tell('Previewing '+proposal.report.updatedKeys+' camera keys at '+
        proposal.report.scale+'× framing. Scrub or play this chapter. Apply to save, or discard.');
    }catch(error){discard({notify:false});tell('Camera alignment unavailable: '+error.message);}
  });
  mode.addEventListener('change',()=>{if(staged)discard({notify:false});
    tell('Mode changed. Preview again to inspect the new framing.');});
  apply.addEventListener('click',()=>{
    if(!staged)return;
    if(!canEdit())return tell('Finish the active AI job or proposal first.');
    try{
      if(getActiveShot()?.id!==staged.shotId||
         acceptedCameraSnapshot(getSequence(),staged.shotId)!==staged.snapshot)
        throw Error('Chapter, camera keys, or geometry changed. Preview alignment again.');
      onApply(staged);
      staged=null;
      apply.disabled=true;cancel.hidden=true;
      tell('Camera keys saved for this accepted chapter. The 3D model was not regenerated or moved. Undo is available.');
    }catch(error){discard({notify:false});tell('Not applied: '+error.message);}
  });
  cancel.addEventListener('click',()=>discard());
  refresh();
  return {refresh,reset:()=>discard({notify:false}),get hasPreview(){return !!staged;}};
}
