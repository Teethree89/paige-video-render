import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {buildWorld} from './world.js';
import {setupModelTools} from './model-tools.js';
import {buildAfterEffectsPackage} from './ae-package-export.js';
import {setupVideoImport} from './video-import.js';
import {setupReferenceBuilder} from './reference-builder.js';
import {referenceAt} from './reference-sequence.js';
import {createTimelineHistory,checkTimeline} from './timeline-operations.js';
import {setupTimelineEditing} from './timeline-tools.js';
import {evaluateCamera,curveEasing} from './animation-curves.js';
import {setupAnimationGraph} from './animation-graph.js';
import {sampleReferenceMedia} from './reference-frames.js';
import {syncChapterCameraMotion,clipPlanesForScene} from './camera-motion-sync.js';
import {setupAcceptedCameraSync} from './accepted-camera-sync.js';
import {createDraftWorld} from './draft-world.js';
import {createPrimitiveWorld} from './primitive-world.js';
import {setupPrimitiveEditor} from './primitive-editor.js';
import {setupSceneObjectEditing} from './scene-object-edit.js';
import {setupArrayPrototypeEditor} from './array-prototype-editor.js';
import {setupRadialCreate} from './radial-create.js';
import {setupSceneEffectsPanel} from './scene-effects-panel.js';
import {createScenePostprocessor,applyShotEffects,effectsForShot,vignetteStyle} from './scene-effects.js';
import {createRenderDiagnostics} from './render-diagnostics.js';
import {editPrimitiveTransform,deletePrimitiveObject,duplicateSceneSelection,setSceneObjectRepeat,editLightTransform,editLightTarget,deleteLightObject} from './scene-object-operations.js';
import {setupAiSceneEditor} from './ai-scene-editor.js';
import {validatePrimitiveDocument} from './primitive-schema.js';
import {markEditorEdits,composeGeneratedChapter,editorEditCount,createLibraryEntry,
  readEditLibrary,saveEditLibraryEntry,restoreEditLibraryEntry,deleteEditLibraryEntry}
  from './scene-generation-compose.js';
import {cleanupPrimitiveDocument,cleanupSummary} from './primitive-cleanup.js';
import {shotAnchorMap,fitDistance,restoreSavedPrimitiveWorld,createPreviewRenderState,previewPixelRatio} from './primitive-preview.js';
import {foldHelpText} from './help-toggles.js';

foldHelpText();

const el=id=>document.getElementById(id);
const canvas=el('scene'),viewport=el('viewport');
const previewFrames=createPreviewRenderState();
const requestViewportRender=()=>previewFrames.invalidate();
const previewQuality=el('previewQuality');
try{
 const saved=localStorage.getItem('atoms-ai-preview-quality-v1');
 if(['fast','balanced','full'].includes(saved))previewQuality.value=saved;
}catch{}
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});
renderer.setPixelRatio(previewPixelRatio(previewQuality.value,window.devicePixelRatio));
renderer.setSize(viewport.clientWidth,viewport.clientHeight);
renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=1.35;
renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(50,16/9,.35,500);
const controls=new OrbitControls(camera,renderer.domElement);
controls.enabled=false;controls.enableDamping=true;controls.dampingFactor=.08;controls.maxDistance=Infinity;
// Orbiting zooms out without limit: the clip planes follow the orbit
// distance, so a far view is never cut off and close-ups keep precision.
// The cinematic camera keeps its fixed planes (applyCamera).
let orbitFar=500;
controls.addEventListener('change',()=>{
  requestViewportRender();
  const distance=camera.position.distanceTo(controls.target);
  const near=Math.max(.01,distance*.01),far=Math.max(orbitFar,distance*10);
  if(near!==camera.near||far!==camera.far){camera.near=near;camera.far=far;camera.updateProjectionMatrix();}
});
const world=buildWorld(scene);
// Temporary studio lighting is ON only when examining a generated proposal.
// It is never serialized, exported or applied to the authored timeline.
const reviewLights=new THREE.Group();
const reviewKey=new THREE.DirectionalLight(0xe1f8ff,3.0);
reviewKey.position.set(24,35,40);reviewLights.add(reviewKey);
const reviewFill=new THREE.DirectionalLight(0xffdcb7,1.35);
reviewFill.position.set(-25,18,-10);reviewLights.add(reviewFill);
reviewLights.visible=false;scene.add(reviewLights);
// Temporary reference grid grounds the generated geometry during inspection.
// It never enters primitiveScenes or GLB exports.
const reviewStage=new THREE.Group();
const reviewFloor=new THREE.Mesh(
  new THREE.PlaneGeometry(1,1),
  new THREE.MeshBasicMaterial({color:0x13283a,side:THREE.DoubleSide,transparent:true,opacity:.6,depthWrite:false})
);
reviewFloor.rotation.x=-Math.PI/2;
reviewStage.add(reviewFloor);
const reviewGrid=new THREE.GridHelper(40,20,0x5f9eab,0x325768);
reviewGrid.material.transparent=true;reviewGrid.material.opacity=.42;
reviewStage.add(reviewGrid);reviewStage.visible=false;scene.add(reviewStage);
const draftWorld=createDraftWorld(scene);
const primitiveWorld=createPrimitiveWorld(scene,{batchRepeats:true});
const studioPost=createScenePostprocessor(renderer,scene,camera);
studioPost.setSize(viewport.clientWidth,viewport.clientHeight);
const renderStats=createRenderDiagnostics({
  renderer,scene,root:el('renderDiagnostics'),
  getDocument:()=>sequence?.primitiveScenes,
  getShotId:()=>sequence?shotAt(playhead)?.id:null,
  getBatches:id=>primitiveWorld.getRenderBatchStats(id)
});
previewQuality.addEventListener('change',()=>{
 renderer.setPixelRatio(previewPixelRatio(previewQuality.value,window.devicePixelRatio));
 studioPost.setSize(viewport.clientWidth,viewport.clientHeight);
 requestViewportRender();
 try{localStorage.setItem('atoms-ai-preview-quality-v1',previewQuality.value);}catch{}
});
const cameraBoundsCache=new Map();
let sceneEffectsPanel=null,lastEffectsShot=null,lastShadowEnabled=true;
let primitiveEditor=null,aiSceneEditor=null,modelTools=null,lastPrimitiveShotId=null,reviewShotId=null,sceneObjectEditor=null,arrayPrototypeEditor=null,referenceBuilder=null,timelineHistory=null,timelineEditing=null,animationGraph=null,cameraSyncSession=null,cameraSyncPreview=null,acceptedCameraSync=null,acceptedCameraPreview=null;
function primitiveAnchors(){return shotAnchorMap(sequence,cameraAt);}
function commitEditedScenes(doc){
  sequence.primitiveScenes=markEditorEdits(sequence.primitiveScenes,doc,sequence.shots.map(s=>s.id));
  syncPrimitiveWorld();saveLocal();renderWorld();
}
function syncPrimitiveWorld(){
  cameraBoundsCache.clear();
  primitiveWorld.setDocument(sequence.primitiveScenes,sequence.shots.map(s=>s.id),primitiveAnchors());
  lastPrimitiveShotId=null;
  primitiveEditor?.refresh();
  sceneObjectEditor?.refresh();
}
const referenceVideo=el('referenceVideo');referenceVideo.volume=0;
for(const id of ['playBtn','backBtn','nextBtn','addCameraBtn','addTextBtn','inspectBtn','loadBtn','exportBtn','resetBtn'])el(id).disabled=true;
let sequence,originalSequence,ready=false,playhead=0,playing=false,lastFrame=performance.now(),speed=1,selection=null,orbitMode=false;
let activeSingleVideoUrl=null;
const sourceOverlay=el('sourceViewportOverlay'),sourceVideoHome=el('referenceVideoHome');
function sourceVideoOverlayAvailable(){return !!(sequence?.videoIntake&&!sequence.referenceSequence&&activeSingleVideoUrl);}
function refreshSourceVideoOverlay(){
  const allowed=sourceVideoOverlayAvailable(),toggle=el('sourceOverlayEnabled');
  el('sourceOverlayControls').hidden=!allowed;
  el('sourceOverlayUnavailable').hidden=allowed;
  toggle.disabled=!allowed;
  if(!allowed)toggle.checked=false;
  const enabled=allowed&&toggle.checked;
  if(enabled){
    // Reuse the existing synchronized video element, not an additional decoder.
    if(referenceVideo.parentElement!==sourceOverlay)sourceOverlay.appendChild(referenceVideo);
    sourceOverlay.hidden=false;referenceVideo.style.display='block';el('showRef').checked=true;
  }else{
    if(referenceVideo.parentElement!==sourceVideoHome)sourceVideoHome.appendChild(referenceVideo);
    sourceOverlay.hidden=true;referenceVideo.style.display=el('showRef').checked?'block':'none';
  }
  el('showRef').disabled=enabled;
  const opacity=Number(el('sourceOverlayOpacity').value);
  const value=Number.isFinite(opacity)?Math.max(0,Math.min(100,opacity)):50;
  sourceOverlay.style.opacity=String(value/100);
  el('sourceOverlayOpacityOutput').textContent=value+'%';
  el('sourceOverlayOpacity').disabled=!allowed;
}
el('sourceOverlayEnabled').addEventListener('change',refreshSourceVideoOverlay);
el('sourceOverlayOpacity').addEventListener('input',refreshSourceVideoOverlay);
canvas.addEventListener('webglcontextrestored',()=>{
 if(sequence)primitiveWorld.invalidateGeometry(shotAt(playhead).id);
 requestViewportRender();
});
const overlayEls=new Map();
const clamp=(n,a,b)=>Math.min(b,Math.max(a,n));
function endGeometryReview(){
  sceneObjectEditor?.setActive(false,{skipExit:true});
  el('inspectBtn').disabled=false;
  if(!reviewShotId){
    if(orbitMode){orbitMode=false;controls.enabled=false;applyCamera();}
    return;
  }
  reviewShotId=null;
  orbitMode=false;controls.enabled=false;
  el('inspectBtn').classList.remove('active');
  el('returnTimelineCameraBtn').hidden=true;
  camera.near=.35;camera.far=500;orbitFar=500;
  reviewLights.visible=false;reviewStage.visible=false;renderer.toneMappingExposure=1.35;
  applyCamera();renderWorld();
}
function showGeneratedGeometry(shotId,scroll=false,{editMode=false}={}){
  const bounds=primitiveWorld.getBounds(shotId);
  if(!bounds)return false;
  // Freeze cinematic playback and inspect the proposed geometry without
  // modifying authored camera keys or saving unaccepted primitives.
  setPlaying(false);
  reviewShotId=shotId;orbitMode=true;controls.enabled=true;
  // AI preview uses temporary studio fill. Edit mode must display the
  // authored lights without extra fill masking their actual effect.
  reviewLights.visible=!editMode;renderer.toneMappingExposure=editMode?1.35:1.65;
  // The cinematic distance haze obscures small primitive details when viewing
  // them close up. Keep the original fog object and restore it on exit.
  if(scene.fog)scene.fog.density=0;
  el('inspectBtn').classList.add('active');
  el('returnTimelineCameraBtn').hidden=false;
  const center=new THREE.Vector3(...bounds.center);
  const stageSize=Math.max(20,Math.min(200,bounds.radius*3));
  reviewFloor.position.set(center.x,-.20,center.z);
  reviewFloor.scale.set(stageSize,stageSize,1);
  reviewGrid.position.set(center.x,-.18,center.z);
  reviewGrid.scale.setScalar(stageSize/40);
  reviewStage.visible=true;
  // Start from the model's estimate of the reference camera when it plausibly
  // frames the geometry, so the preview lines up with the video frame. It is
  // only a starting view: camera keys are never written from it.
  const estimate=primitiveWorld.getCamera(shotId);
  const target=estimate?new THREE.Vector3(...estimate.target):center.clone();
  const usable=estimate&&target.distanceTo(center)<=bounds.radius*1.5&&
    new THREE.Vector3(...estimate.position).distanceTo(center)<=bounds.radius*6+10;
  if(usable){camera.fov=estimate.fov;camera.position.set(...estimate.position);}
  else{
    target.copy(center);camera.fov=52;
    camera.position.copy(center).addScaledVector(new THREE.Vector3(.58,.38,1).normalize(),
      fitDistance(bounds.radius,52,camera.aspect));
  }
  const distance=camera.position.distanceTo(target);
  camera.near=Math.max(.01,Math.min(.35,distance*.01));
  camera.far=orbitFar=Math.max(500,distance+bounds.radius*5);
  camera.lookAt(target);camera.updateProjectionMatrix();
  controls.target.copy(target);controls.update();
  if(scroll)viewport.scrollIntoView?.({behavior:'smooth',block:'start'});
  return true;
}
el('returnTimelineCameraBtn').addEventListener('click',()=>endGeometryReview());
const lerp=(a,b,u)=>a+(b-a)*u;
const ease=u=>u*u*(3-2*u);
const fmt=t=>{let m=Math.floor(Math.max(0,t)/60),s=Math.max(0,t)-m*60;return String(m).padStart(2,'0')+':'+s.toFixed(2).padStart(5,'0');};
const atPercent=t=>((t/sequence.duration)*100)+'%';
const safeNum=(v,fallback=0)=>Number.isFinite(Number(v))?Number(v):fallback;

async function boot(){
 // A failed timeline fetch must never leave interactive transport controls half-initialized.
 let original=await fetch('./timeline.json').then(r=>{if(!r.ok)throw new Error('timeline.json not found');return r.json();});
 let cached=null;try{const raw=localStorage.getItem('atoms-ai-sequence-v1');if(raw)cached=JSON.parse(raw);}catch(e){}
 originalSequence=original;sequence=validSequence(cached)?cached:structuredClone(original);
 timelineHistory=createTimelineHistory(sequence);
 const geometryError=restoreSavedPrimitiveWorld(primitiveWorld,sequence,primitiveAnchors());
 if(geometryError){
   console.warn('Saved primitive geometry could not be loaded; project retained',geometryError);
   el('errorBanner').hidden=false;
   el('errorBanner').textContent='Saved geometry could not be loaded. Your timeline and saved objects are retained; export Timeline JSON for a backup. '+geometryError.message;
 }
 refreshAll();seek(0,{force:true});ready=true;
 if(sequence.videoIntake||sequence.referenceSequence){referenceVideo.style.display='none';el('showRef').checked=false;el('saveStatus').textContent='● REATTACH SOURCE MEDIA';}
 refreshSourceVideoOverlay();
 for(const id of ['playBtn','backBtn','nextBtn','addCameraBtn','addTextBtn','inspectBtn','loadBtn','exportBtn','resetBtn','sceneModeView','sceneModeEdit'])el(id).disabled=false;
 window.__atomsEditorStarted=true;animate(performance.now());
 modelTools=setupModelTools(world,{onSceneChanged:()=>renderWorld()});
 primitiveEditor=setupPrimitiveEditor({
   getSequence:()=>sequence,
   getActiveShot:()=>shotAt(playhead),
   world:primitiveWorld,
   onDocumentChange:doc=>commitEditedScenes(doc),
   onSelectionChange:id=>sceneObjectEditor?.select(id,false),
    onEditAssembly:(shotId,id)=>arrayPrototypeEditor?.open(shotId,id)||false
 });
 sceneObjectEditor=setupSceneObjectEditing({
   scene,camera,canvas,orbitControls:controls,world:primitiveWorld,
   onVisualChange:requestViewportRender,
   getActiveShot:()=>shotAt(playhead),
   getDocument:()=>sequence.primitiveScenes,
   getInitialObjectId:()=>primitiveEditor?.getSelectedId?.()||(primitiveEditor?.getSelectedLightId?.()?'light::'+primitiveEditor.getSelectedLightId():null),
   onEnter:()=>{
     if(aiSceneEditor?.hasPending?.()){
       el('primitiveStatus').textContent='Accept or discard the AI proposal before editing saved objects.';
       return false;
     }
     setPlaying(false);
     // Edit mode owns the inspector; clear camera/text key selection so the
     // existing numeric XYZ primitive fields remain visible and synchronized.
     selection=null;el('inspectorSceneButton')?.click();renderInspector();renderTimeline();
     const shot=shotAt(playhead);
     if(!reviewShotId&&primitiveWorld.hasSceneContent(shot.id))showGeneratedGeometry(shot.id,false,{editMode:true});
     else if(!reviewShotId){
       orbitMode=true;controls.enabled=true;
       controls.target.set(...cameraAt(playhead).t);controls.update();
     }
     el('inspectBtn').disabled=true;
     return true;
   },
   onExit:()=>{el('sceneCreateFeedback').hidden=true;endGeometryReview();},
   onTransform:(shotId,objectId,mode,vector)=>{
     commitEditedScenes(editPrimitiveTransform(sequence.primitiveScenes,
       sequence.shots.map(s=>s.id),shotId,objectId,mode,vector));
   },
   onMakeArray:(shotId,objectId,count,spacing)=>{
     commitEditedScenes(setSceneObjectRepeat(sequence.primitiveScenes,
       sequence.shots.map(s=>s.id),shotId,objectId,count,spacing));
   },
   onDuplicate:(shotId,selectedId)=>{
     const next=duplicateSceneSelection(sequence.primitiveScenes,sequence.shots.map(s=>s.id),shotId,selectedId);
     commitEditedScenes(next.document);
     return next.selectedId;
   },
   onDelete:(shotId,objectId)=>{
     commitEditedScenes(deletePrimitiveObject(sequence.primitiveScenes,
       sequence.shots.map(s=>s.id),shotId,objectId));
   },
   onLightTransform:(shotId,lightId,position)=>{
     commitEditedScenes(editLightTransform(sequence.primitiveScenes,
       sequence.shots.map(s=>s.id),shotId,lightId,position));
   },
   onLightTargetTransform:(shotId,lightId,target)=>{
     commitEditedScenes(editLightTarget(sequence.primitiveScenes,
       sequence.shots.map(s=>s.id),shotId,lightId,target));
   },
   onDeleteLight:(shotId,lightId)=>{
     commitEditedScenes(deleteLightObject(sequence.primitiveScenes,
       sequence.shots.map(s=>s.id),shotId,lightId));
   },
   onSelect:id=>id?.startsWith('light-target::')?
     primitiveEditor?.selectLight(id.slice(14)):
     id?.startsWith('light::')?
     primitiveEditor?.selectLight(id.slice(7)):primitiveEditor?.selectObject(id),
   onStatus:message=>{el('primitiveStatus').textContent=message;},
   onArrayEdit:(shotId,id)=>arrayPrototypeEditor?.open(shotId,id)||false
 });
 arrayPrototypeEditor=setupArrayPrototypeEditor({
   getDocument:()=>sequence.primitiveScenes,
   getShotIds:()=>sequence.shots.map(shot=>shot.id),
   onSave:doc=>{
     sceneObjectEditor?.clearArrayHighlights?.();
     commitEditedScenes(doc);
     sceneObjectEditor?.refresh();
     el('primitiveStatus').textContent='Array prototype saved to every matching instance.';
   },
   onClose:()=>{sceneObjectEditor?.clearArrayHighlights?.();requestViewportRender();}
 });
 const referenceSampler=(shot,at,detail)=>sampleReferenceMedia(
   referenceBuilder?.sourceForShot(shot.id),shot,at,detail);
 referenceSampler.available=id=>referenceBuilder?.hasSourceForShot(id)===true;
 aiSceneEditor=setupAiSceneEditor({
   getSequence:()=>sequence,
   getActiveShot:()=>shotAt(playhead),
   getReferenceVideo:()=>referenceVideo,
   getReferenceFrames:referenceSampler,
   getPlayheadTime:()=>playhead,
   getEditCount:shotId=>editorEditCount(
     sequence.primitiveScenes?.scenes?.find(s=>s.shotId===shotId)),
   getLegacyCount:shotId=>{
     const scene=sequence.primitiveScenes?.scenes?.find(s=>s.shotId===shotId);
     return [...(scene?.objects||[]),...(scene?.lights||[])].filter(item=>!item.source).length;
   },
   listEditLibrary:()=>readEditLibrary(localStorage),
   restoreEditLibrary:item=>{
     const shot=shotAt(playhead);
     const restored=restoreEditLibraryEntry(sequence.primitiveScenes,shot.id,item,
       sequence.shots.map(s=>s.id));
     commitEditedScenes(restored);
   },
   deleteEditLibrary:id=>deleteEditLibraryEntry(localStorage,id),
   onPreview:(entry,{editsMode='keep'}={})=>{
     acceptedCameraSync?.reset();
     acceptedCameraPreview=null;
     sceneObjectEditor?.setActive(false);
     // Snapshot the SAVED geometry before mounting a newly generated proposal.
     // Cleanup may preview the same pending scene again; retain the original.
     if(cameraSyncSession?.shotId!==entry.shotId){
       cameraSyncSession={shotId:entry.shotId,
         oldBounds:primitiveWorld.getBounds(entry.shotId),
         anchor:[...(primitiveAnchors()[entry.shotId]||[0,0,0])]};
     }
     cameraSyncPreview=null;
     const doc=validatePrimitiveDocument(sequence.primitiveScenes,sequence.shots.map(s=>s.id));
     const oldScene=doc.scenes.find(s=>s.shotId===entry.shotId);
     const composed=composeGeneratedChapter(oldScene,entry,editsMode,
       sequence.shots.map(s=>s.id));
     doc.scenes=doc.scenes.filter(s=>s.shotId!==entry.shotId);
     doc.scenes.push(composed);
     cameraBoundsCache.clear();
     primitiveWorld.setDocument(doc,sequence.shots.map(s=>s.id),primitiveAnchors());
     renderWorld();
     if(entry.objects.length)showGeneratedGeometry(entry.shotId,true);
   },
   onInspect:shotId=>showGeneratedGeometry(shotId,true),
   onCameraSync:(entry,mode)=>{
     if(cameraSyncSession?.shotId!==entry.shotId)
       throw Error('The reference chapter changed. Generate a new preview.');
     if(!primitiveWorld.hasObjects(entry.shotId))
       throw Error('There is no preview geometry to frame.');
     const proposal=syncChapterCameraMotion(sequence,entry.shotId,{
       oldBounds:cameraSyncSession.oldBounds,
       newBounds:primitiveWorld.getBounds(entry.shotId),
       modelCamera:primitiveWorld.getCamera(entry.shotId),
       anchor:cameraSyncSession.anchor,mode,
       aspect:16/9
     });
     cameraSyncPreview=proposal.sequence;
     // Leave orbit review so the editor displays the synchronized CINEMATIC
     // camera and lets the user scrub the path before saving anything.
     endGeometryReview();
     seek(sequence.shots.find(s=>s.id===entry.shotId).start+.01);
     return proposal.report;
   },
   onCameraSyncReset:()=>{
     if(cameraSyncPreview){
       cameraSyncPreview=null;
       if(ready){applyCamera();renderWorld();}
     }
   },
   onDiscard:()=>{
     acceptedCameraSync?.reset();
     acceptedCameraPreview=null;
     cameraSyncPreview=null;cameraSyncSession=null;
     endGeometryReview();syncPrimitiveWorld();renderWorld();
   },
   onAccept:(entry,{syncCamera=false,editsMode='keep'}={})=>{
     acceptedCameraSync?.reset();
     acceptedCameraPreview=null;
     const doc=validatePrimitiveDocument(sequence.primitiveScenes,sequence.shots.map(s=>s.id));
     const previous=doc.scenes.find(s=>s.shotId===entry.shotId);
     const replacement=composeGeneratedChapter(previous,entry,editsMode,
       sequence.shots.map(s=>s.id));
     doc.scenes=doc.scenes.filter(s=>s.shotId!==entry.shotId);
     doc.scenes.push(replacement);
     const accepted=validatePrimitiveDocument(doc,sequence.shots.map(s=>s.id));
     // No destructive change occurs until composition AND local-library backup succeed.
     if(editsMode==='library'&&previous&&editorEditCount(previous)){
       const backup=createLibraryEntry(previous,sequence.shots.find(s=>s.id===entry.shotId)?.name+
         ' · editor edits');
       saveEditLibraryEntry(localStorage,backup);
     }
     if(syncCamera){
       if(cameraSyncSession?.shotId!==entry.shotId||!cameraSyncPreview)
         throw Error('Preview camera synchronization before applying it.');
       const next=structuredClone(cameraSyncPreview);
       next.primitiveScenes=accepted;
       // Commit BOTH changes at once, preserving the geometry anchor on the
       // chapter. Other chapters' keys and accepted scenes remain untouched.
       sequence=next;
     }else{
       sequence.primitiveScenes=accepted;
     }
     cameraSyncPreview=null;cameraSyncSession=null;
     endGeometryReview();syncPrimitiveWorld();
     refreshAll();seek(Math.min(playhead,sequence.duration));saveLocal();
   }
 });
 sceneEffectsPanel=setupSceneEffectsPanel({
    getSequence:()=>sequence,getActiveShot:()=>shotAt(playhead),
    canEdit:()=>ready&&!aiSceneEditor?.hasPending?.()&&!aiSceneEditor?.isBusy?.(),
    onDocumentChange:doc=>{
      sequence.primitiveScenes=doc;
      syncPrimitiveWorld();renderWorld();saveLocal();
    }
  });
 acceptedCameraSync=setupAcceptedCameraSync({
   getSequence:()=>sequence,
   getActiveShot:()=>shotAt(playhead),
   getBounds:id=>primitiveWorld.getBounds(id),
   getCamera:id=>primitiveWorld.getCamera(id),
   getAnchor:id=>[...(primitiveAnchors()[id]||[0,0,0])],
   canEdit:()=>ready&&!aiSceneEditor?.isBusy?.()&&!aiSceneEditor?.hasPending?.(),
   onPreview:proposal=>{
     setPlaying(false);
     sceneObjectEditor?.setActive(false);
     // Camera alignment is reversible: never change sequence here.
     endGeometryReview();
     acceptedCameraPreview=proposal;
     seek(sequence.shots.find(shot=>shot.id===proposal.shotId).start+.01);
   },
   onApply:proposal=>{
     const next=proposal.sequence;
     validatePrimitiveDocument(next.primitiveScenes,next.shots.map(shot=>shot.id));
     checkTimeline(next);
     const at=playhead;
     acceptedCameraPreview=null;
     sequence=next;
     endGeometryReview();
     syncPrimitiveWorld();
     refreshAll();seek(at);saveLocal();
   },
   onDiscard:()=>{
     acceptedCameraPreview=null;
     if(ready){applyCamera();renderWorld();}
   }
 });
 const radialCreate=setupRadialCreate({
    viewport,
    getObjectAt:(clientX,clientY)=>sceneObjectEditor?.pickObjectAt(clientX,clientY)||null,
    onObjectAction:(action,id)=>{
      if(!sceneObjectEditor?.select(id))return;
      if(action==='array')sceneObjectEditor.openMakeArray(id);
      else if(action==='duplicate')sceneObjectEditor.duplicateSelected();
      else if(action==='edit'){
        if(!sceneObjectEditor.openGroupEditor(id))
          el('sceneEditStatus').textContent=
            'This is a single shape. Use Make Array or create a multi-part object to edit components.';
      }
    },
    canCreate:()=>ready&&sceneObjectEditor?.active&&
      !aiSceneEditor?.hasPending?.()&&!aiSceneEditor?.isBusy?.(),
    getCreateOrigin:(clientX,clientY,category)=>{
      const id=shotAt(playhead)?.id;
      const anchor=primitiveAnchors()[id]||[0,0,0];
      let target=controls.target.clone();
      if(Number.isFinite(clientX)&&Number.isFinite(clientY)){
        const rect=canvas.getBoundingClientRect();
        const nx=2*(clientX-rect.left)/rect.width-1,ny=1-2*(clientY-rect.top)/rect.height;
        const ray=new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(nx,ny),camera);
        const hit=new THREE.Vector3();
        // Lights illuminate the actual mesh surface under the click, not an
        // unrelated Y=0 intersection behind an elevated model.
        // Ordinary geometry keeps its existing ground-plane placement.
        const surface=category==='lights'
          ?ray.intersectObjects(primitiveWorld.getPickableMeshes(id).filter(
            node=>!!node.userData.primitiveId),false)[0]:null;
        if(surface)target=surface.point;
        else if(ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),hit))
          target=hit;
      }
      return target.toArray().map((v,i)=>Math.max(-9000,Math.min(9000,v-anchor[i])));
    },
    onCreate:(category,item,origin)=>{
      const created=primitiveEditor.createAsset(category,item,origin);
      if(!created)throw Error(primitiveEditor.getLastCreateError()||'Unknown creation error.');
      if(category!=='lights')return true;
      sceneObjectEditor?.focusSelectionIfOffscreen();
      const shotId=shotAt(playhead).id;
      const entry=sequence.primitiveScenes?.scenes?.find(s=>s.shotId===shotId);
      const lightId=primitiveEditor.getSelectedLightId();
      const source=entry?.lights?.find(l=>l.id===lightId);
      const node=primitiveWorld.getLightNode(shotId,lightId);
      const marker=primitiveWorld.getLightMarker(shotId,lightId);
      const visible=primitiveWorld.isLightMarkerVisible(shotId,lightId);
      const count=entry?.lights?.length||0;
      return source&&node&&marker&&visible?
        'Light created: '+source.name+' ('+count+' total). Saved '+lightId+
          ' · Three.js light ✓ · Edit gizmo ✓ · XYZ '+
          source.position.map(n=>n.toFixed(1)).join(', '):
        'Light saved ('+count+' total), but viewport verification FAILED: '+
          ['saved='+!!source,'Three.js='+!!node,'gizmo='+!!marker,'visible='+visible].join(' · ');
    },
    onStatus:message=>{
      el('primitiveStatus').textContent=message;
      el('sceneEditStatus').textContent=message;
      const feedback=el('sceneCreateFeedback');
      if(feedback){
        feedback.textContent=message;
        feedback.hidden=false;
        feedback.classList.toggle('error',/failed|rejected|cap|maximum/i.test(message));
      }
    }
  });
 el('primitiveCleanupSaved')?.addEventListener('click',()=>{
   const note=el('primitiveStatus');
   try{
     if(aiSceneEditor?.hasPending?.()){
       note.textContent='Accept or discard the AI preview before cleaning the saved chapter.';
       return;
     }
     const shot=shotAt(playhead);
     const doc=validatePrimitiveDocument(sequence.primitiveScenes,sequence.shots.map(s=>s.id));
     const current=doc.scenes.find(s=>s.shotId===shot.id);
     if(!current?.objects?.length){
       note.textContent='No saved primitive geometry in this chapter to clean.';
       return;
     }
     const cleaned=cleanupPrimitiveDocument({schemaVersion:1,scenes:[current]},[shot.id]);
     const report=cleaned.report;
     const summary=cleanupSummary(report);
     if(report.removedDuplicates||report.nudgedOverlaps){
       doc.scenes=doc.scenes.map(s=>s.shotId===shot.id?cleaned.document.scenes[0]:s);
       sequence.primitiveScenes=validatePrimitiveDocument(doc,sequence.shots.map(s=>s.id));
       syncPrimitiveWorld();saveLocal();renderWorld();
     }
     note.textContent=summary+' Saved chapter '+shot.id+'. Export JSON for a backup.';
   }catch(error){
     note.textContent='Geometry cleanup failed: '+error.message;
   }
 });
 setupVideoImport({onApply:({timeline,videoUrl})=>{
   if(aiSceneEditor?.isBusy?.()||aiSceneEditor?.hasPending?.())throw Error('Finish the active AI job or proposal before replacing the timeline');
   if(!validSequence(timeline))throw Error('Generated timeline is invalid');
   endGeometryReview();setPlaying(false);selection=null;orbitMode=false;controls.enabled=false;
   activeSingleVideoUrl=videoUrl;
   referenceVideo.pause();referenceVideo.src=videoUrl;referenceVideo.load();
   referenceVideo.style.display='block';el('showRef').checked=true;
   aiSceneEditor?.reset();sequence=timeline;syncPrimitiveWorld();refreshAll();seek(0);
   refreshSourceVideoOverlay();el('inspectorSourceButton')?.click();saveLocal();
   el('saveStatus').textContent='● VIDEO DRAFT SAVED · SOURCE LOCAL';
  referenceBuilder?.loadFromSequence(null);
  timelineHistory?.reset(sequence);
 }});
 referenceBuilder=setupReferenceBuilder({getSequence:()=>sequence,onApply:({timeline})=>{
   if(!validSequence(timeline))throw Error('Reference Builder created an invalid timeline');
   if(aiSceneEditor?.isBusy?.()||aiSceneEditor?.hasPending?.())throw Error('Finish the active AI job or proposal before changing the timeline');
   endGeometryReview();setPlaying(false);selection=null;orbitMode=false;controls.enabled=false;
   referenceVideo.pause();activeSingleVideoUrl=null;
   aiSceneEditor?.reset();sequence=timeline;syncPrimitiveWorld();
   referenceBuilder?.loadFromSequence(timeline);
   el('showRef').checked=true;
   refreshAll();seek(0);refreshSourceVideoOverlay();saveLocal();
   el('saveStatus').textContent='● MIXED REFERENCE READY · MEDIA LOCAL';
 }});
 referenceBuilder.loadFromSequence(sequence);
 if(sequence.referenceSequence)syncReferenceMedia(playhead);
 animationGraph=setupAnimationGraph({
   getSequence:()=>sequence,getSelected:()=>selection,
   onCommit:doc=>{if(aiSceneEditor?.isBusy?.()||aiSceneEditor?.hasPending?.())throw Error('Finish the current AI job or proposal before editing camera curves.');sequence=doc;refreshAll();renderWorld();saveLocal();}
 });
 timelineEditing=setupTimelineEditing({
   getSequence:()=>sequence,getSelectedKey:()=>selection,
   canEdit:()=>ready&&!aiSceneEditor?.hasPending?.()&&!aiSceneEditor?.isBusy?.(),
   sourceDuration:id=>referenceBuilder?.sourceForShot(id)?.mediaDuration??null,
   canUndo:()=>timelineHistory?.canUndo===true,canRedo:()=>timelineHistory?.canRedo===true,
   onCommit:(doc,time,retain)=>{
     setPlaying(false);endGeometryReview();
     validatePrimitiveDocument(doc.primitiveScenes,doc.shots.map(s=>s.id));
     checkTimeline(doc);
     sequence=doc;referenceBuilder.loadFromSequence(sequence);
     syncPrimitiveWorld();selection=retain||null;refreshAll();
     seek(time===null?Math.min(playhead,sequence.duration):Math.min(time,sequence.duration));
     saveLocal();
   },
   onUndo:()=>applyHistory(timelineHistory?.undo?.()),
   onRedo:()=>applyHistory(timelineHistory?.redo?.())
 });
}
function validSequence(s){return !!(s&&Number.isFinite(s.duration)&&s.duration>0&&Array.isArray(s.shots)&&s.shots.length&&Array.isArray(s.camera)&&s.camera.length&&Array.isArray(s.text));}
function syncReferenceMedia(time){
 if(!sequence?.referenceSequence)return false;
 const image=el('referenceStill'),note=el('referenceMediaStatus'),shown=el('showRef').checked;
 const ref=referenceAt(sequence,time),src=ref&&referenceBuilder?.sourceForShot(ref.shot.id);
 if(!src){
   referenceVideo.pause();referenceVideo.style.display='none';
   if(image)image.hidden=true;
   if(note)note.textContent='Original source media not attached. Open Reference Builder → Relink files.';
   return true;
 }
 if(note)note.textContent=src.fileName+' · local reference '+(src.kind==='image'?'image':'clip');
 if(src.kind==='image'){
   referenceVideo.pause();referenceVideo.style.display='none';
   if(image){if(image.dataset.media!==src.mediaId){image.src=src.url;image.dataset.media=src.mediaId;}
     image.style.objectFit=src.fit;image.hidden=!shown;}
 }else{
   if(image)image.hidden=true;
   if(referenceVideo.dataset.media!==src.mediaId){
     referenceVideo.pause();referenceVideo.src=src.url;referenceVideo.dataset.media=src.mediaId;
     referenceVideo.load();
   }
   referenceVideo.style.objectFit=src.fit;
   referenceVideo.style.display=shown?'block':'none';
   if(referenceVideo.readyState>=1&&Math.abs(referenceVideo.currentTime-ref.sourceTime)>.12){
     try{referenceVideo.currentTime=ref.sourceTime;}catch{}
   }
   if(playing&&shown&&referenceVideo.paused)referenceVideo.play().catch(()=>{});
   else if(!playing&&!referenceVideo.paused)referenceVideo.pause();
 }
 return true;
}
function applyHistory(doc){
 if(!doc)return;
 // Undo/redo is a data operation, not a request to leave object editing.
 // Preserve orbit framing and the current gizmo when its object survives;
 // syncPrimitiveWorld reattaches the selection to rebuilt nodes (or clears
 // the selection if the undone object was just created).
 const editing=sceneObjectEditor?.active===true;
 setPlaying(false);
 if(!editing)endGeometryReview();
 sequence=doc;
 referenceBuilder?.loadFromSequence(sequence);syncPrimitiveWorld();selection=null;
 refreshAll();seek(Math.min(playhead,sequence.duration));
 if(editing&&sceneObjectEditor?.active&&!primitiveWorld.hasSceneContent(shotAt(playhead).id)){
   // Removing the last object/light must not leave an orphan review stage.
   reviewShotId=null;reviewLights.visible=false;reviewStage.visible=false;
   el('returnTimelineCameraBtn').hidden=true;
 }
 saveLocal(false);
}
function saveLocal(record=true){
 if(record){try{timelineHistory?.record(sequence);}catch(error){console.warn('Timeline history skipped invalid intermediate edit:',error.message);}}
 try{localStorage.setItem('atoms-ai-sequence-v1',JSON.stringify(sequence));}catch(e){}
 el('saveStatus').textContent='● SAVED LOCALLY';timelineEditing?.refresh?.();acceptedCameraSync?.refresh?.();sceneEffectsPanel?.refresh?.();
}
function shotAt(t){return sequence.shots.find((s,i)=>t>=s.start&&(t<s.end||i===sequence.shots.length-1))||sequence.shots[0];}
function cameraAt(t){
 // Temporary motion preview affects only the selected chapter's renderer.
 // No scene JSON, exported camera, or local storage changes before Accept.
 if(cameraSyncPreview&&cameraSyncSession?.shotId===shotAt(t)?.id)
   return evaluateCamera(cameraSyncPreview.camera,t);
 if(acceptedCameraPreview?.shotId===shotAt(t)?.id)
   return evaluateCamera(acceptedCameraPreview.sequence.camera,t);
 return evaluateCamera(sequence.camera,t);
}
function applyCamera(){
 requestViewportRender();
 if(orbitMode&&!playing)return;
 const c=cameraAt(playhead),id=shotAt(playhead)?.id;
 camera.position.set(...c.p);camera.lookAt(...c.t);camera.fov=c.fov;
 if(id&&!cameraBoundsCache.has(id))
   cameraBoundsCache.set(id,primitiveWorld.getBounds(id));
 const planes=clipPlanesForScene(c.p,c.t,id?cameraBoundsCache.get(id):null);
 camera.near=planes.near;camera.far=planes.far;
 camera.updateProjectionMatrix();controls.target.set(...c.t);
}
function seek(t,opts={}){if((reviewShotId&&shotAt(t)?.id!==reviewShotId)||
 (sceneObjectEditor?.active&&shotAt(t)?.id!==shotAt(playhead)?.id))endGeometryReview();playhead=clamp(t,0,sequence.duration);if(!opts.fromFrame){lastFrame=performance.now();if(!playing&&!sequence.referenceSequence){try{referenceVideo.currentTime=playhead;}catch(e){}}}if(sequence.referenceSequence)syncReferenceMedia(playhead);if(orbitMode&&!playing){}else applyCamera();refreshPlayhead();renderOverlays();renderShotName();renderWorld();acceptedCameraSync?.refresh?.();}
function renderWorld(){requestViewportRender();const shot=shotAt(playhead);const custom=primitiveWorld.hasObjects(shot.id);
 world.update(playhead,shot.id,custom);
 const profile=applyShotEffects(scene,renderer,effectsForShot(sequence,shot.id),{review:!!reviewShotId,camera,shotId:shot.id});
 // Cached static shadow maps must be repainted after restoring master shadows.
 if(profile.shadows.enabled&&!lastShadowEnabled)primitiveWorld.invalidateShadows(shot.id);
 lastShadowEnabled=profile.shadows.enabled;
 studioPost.configure(profile);
 const vignette=viewport.querySelector('.vignette');
 if(vignette){vignette.style.opacity='1';vignette.style.background=vignetteStyle(profile);}
 if(lastEffectsShot!==shot.id){lastEffectsShot=shot.id;sceneEffectsPanel?.refresh?.();}
 primitiveWorld.showShot(shot.id);
 draftWorld.update(shot,custom);
 if(lastPrimitiveShotId!==shot.id){lastPrimitiveShotId=shot.id;primitiveEditor?.refresh();}
 let cuts=sequence.camera.filter(k=>k.cut&&k.at>0).map(k=>k.at);let alpha=0;for(let cut of cuts){let diff=Math.abs(playhead-cut);if(diff<.17)alpha=Math.max(alpha,(1-diff/.17)*.72);}el('cutFlash').style.opacity=String(alpha);}
function animate(now){let dt=Math.min(.09,(now-lastFrame)/1000);lastFrame=now;
 // The modal has its own viewport. Avoid rendering the covered full scene
 // at the same time (and doing two sets of lighting/post-processing work).
 if(arrayPrototypeEditor?.active){renderStats.noteIdle(now);requestAnimationFrame(animate);return;}
 if(playing){let next=playhead+dt*speed;if(next>=sequence.duration){next=sequence.duration;setPlaying(false);}seek(next,{fromFrame:true});if(!sequence.referenceSequence&&referenceVideo.readyState>=2&&Math.abs(referenceVideo.currentTime-playhead)>.15){try{referenceVideo.currentTime=playhead;}catch(e){}}}
 if(controls.enabled)controls.update();
 // Paused camera, scene and lighting are unchanged. Keep processing input
 // and orbit damping, but do not keep saturating the GPU with idle frames.
 if(!previewFrames.consume(playing)){renderStats.noteIdle(now);requestAnimationFrame(animate);return;}
 // Keep light source/aim markers large enough to see at ANY shot scale;
 // their physical coordinates and directional rays remain untouched.
 if(sceneObjectEditor?.active)primitiveWorld.updateLightVisuals(camera,viewport.clientHeight);
 // Keep the selected geometry's oriented outline current while dragging,
 // after scene rebuilds, and when orbiting; it is never an exported object.
 sceneObjectEditor?.updateHighlight();
 primitiveWorld.prepareRender(shotAt(playhead).id);
 renderStats.beginFrame();
 studioPost.render();
 renderStats.endFrame(performance.now());
 requestAnimationFrame(animate);
}
function renderShotName(){let shot=shotAt(playhead),i=sequence.shots.indexOf(shot);el('shotTitle').textContent=String(i+1).padStart(2,'0')+' / '+shot.title;el('stageName').textContent=shot.name;el('shotIndex').textContent=String(i+1).padStart(2,'0');for(const node of document.querySelectorAll('.chapter-item'))node.classList.toggle('current',node.dataset.shot===shot.id);}
function renderOverlays(){for(let item of sequence.text){let dom=overlayEls.get(item.id);if(!dom)continue;let active=playhead>=item.start&&playhead<item.end,fade=.58,fadeOut=.55;let opacity=active?Math.min(1,curveEasing((playhead-item.start)/fade,{mode:item.textFade||'linear'}),curveEasing((item.end-playhead)/fadeOut,{mode:item.textFade||'linear'})):0;dom.style.opacity=String(clamp(opacity,0,1));dom.style.display=opacity>0?'block':'none';dom.style.left=item.x+'%';dom.style.top=item.y+'%';dom.style.textAlign=item.align||'center';dom.className='scene-caption '+(item.size||'medium')+' '+(item.tone||'white');dom.querySelector('.main-copy').textContent=item.value;dom.querySelector('.sub-copy').textContent=item.subtitle||'';}
}
function rebuildOverlayDom(){el('overlayLayer').replaceChildren();overlayEls.clear();for(let item of sequence.text){let dom=document.createElement('div');dom.className='scene-caption';let main=document.createElement('div');main.className='main-copy';let sub=document.createElement('div');sub.className='sub-copy';dom.append(main,sub);el('overlayLayer').appendChild(dom);overlayEls.set(item.id,dom);}renderOverlays();}
function refreshPlayhead(){el('playhead').style.left=atPercent(playhead);el('clock').innerHTML=`${fmt(playhead)} <span>/</span> ${fmt(sequence.duration)}`;}
function renderTimeline(){let ruler=el('ruler'),shotTrack=el('shotTrack'),camTrack=el('cameraTrack'),textTrack=el('textTrack');ruler.replaceChildren();shotTrack.replaceChildren();camTrack.replaceChildren();textTrack.replaceChildren();
 for(let sec=0;sec<=sequence.duration;sec+=5){let tick=document.createElement('span');tick.className='ruler-tick';tick.style.left=atPercent(sec);tick.textContent=`${String(sec).padStart(2,'0')}s`;ruler.append(tick);}
 for(let s of sequence.shots){let d=document.createElement('div');d.className='shot-item '+(s.tone==='amber'?'amber':s.tone==='purple'?'purple':'');d.style.left=atPercent(s.start);d.style.width=((s.end-s.start)/sequence.duration*100)+'%';d.dataset.shotId=s.id;d.textContent=s.name;const rh=document.createElement('span');rh.className='chapter-resize-handle';rh.title='Drag to resize chapter';d.append(rh);d.title=`${fmt(s.start)} · ${s.name}`;d.onclick=e=>{e.stopPropagation();selection=null;orbitMode=false;controls.enabled=false;renderInspector();renderTimeline();seek(s.start+.01);};shotTrack.append(d);}
 for(let key of sequence.camera){let d=document.createElement('div');d.dataset.editId=key.id;d.className='key-marker '+(key.cut?'cut-key ':'')+(selection?.type==='camera'&&selection.id===key.id?'selected':'');d.style.left=atPercent(key.at);d.title=`Camera ${fmt(key.at)}${key.cut?' · CUT':''}`;d.onclick=e=>{e.stopPropagation();select('camera',key.id);seek(key.at);};camTrack.append(d);}
 for(let tx of sequence.text){let d=document.createElement('div');d.dataset.editId=tx.id;d.className='text-item '+(tx.size==='hero'?'hero-text ':'')+(selection?.type==='text'&&selection.id===tx.id?'selected':'');d.style.left=atPercent(tx.start);d.style.width=((tx.end-tx.start)/sequence.duration*100)+'%';d.title=tx.value.replaceAll('\n',' ')+' ('+fmt(tx.start)+')';d.textContent=tx.value.replaceAll('\n',' ');const rh=document.createElement('span');rh.className='text-resize-handle';rh.title='Drag to adjust overlay duration';d.append(rh);d.onclick=e=>{e.stopPropagation();select('text',tx.id);seek(Math.min(tx.start+.5,tx.end-.04));};textTrack.append(d);}
 el('keyCount').textContent=String(sequence.camera.length);el('textCount').textContent=String(sequence.text.length);
 // Re-apply chapter selection styling after replacing the clip nodes.
 timelineEditing?.refresh?.();}
function renderChapters(){let parent=el('chapterList');parent.replaceChildren();for(let s of sequence.shots){let d=document.createElement('button');d.className='chapter-item';d.dataset.shot=s.id;const time=document.createElement('span');time.className='chapter-time';time.textContent=fmt(s.start).slice(0,5);const dot=document.createElement('span');dot.className='chapter-dot '+(s.tone==='amber'?'amber':s.tone==='purple'?'purple':'');let label=document.createElement('span');label.textContent=s.name;d.append(time,dot,label);d.onclick=()=>{selection=null;orbitMode=false;controls.enabled=false;renderInspector();timelineEditing?.selectChapter?.(s.id);renderTimeline();seek(s.start+.001);};parent.append(d);}renderShotName();}
function refreshAll(){renderTimeline();renderChapters();rebuildOverlayDom();renderInspector();refreshPlayhead();}
function select(type,id){selection={type,id};el('inspectorMotionButton')?.click();renderInspector();renderTimeline();}
function selectedData(){return selection?sequence[selection.type==='camera'?'camera':'text'].find(i=>i.id===selection.id):null;}
function renderInspector(){let item=selectedData();el('projectPanel').hidden=false;el('cameraPanel').hidden=!item||selection.type!=='camera';el('textPanel').hidden=!item||selection.type!=='text';el('motionEmptyState').hidden=!!item;if(el('inspectorMotionButton')?.getAttribute('aria-selected')==='true'){
  el('inspectorHeading').textContent=!item?'Project settings':selection.type==='camera'?'Camera keyframe':'Text overlay';
  el('inspectorHint').textContent=!item?'Select a timeline item to adjust its animation.':selection.type==='camera'?'Edit position, focal target, lens and cut behavior.':'Adjust wording, timing, screen location and styling.';
 }
 if(!item)return;
 if(selection.type==='camera'){el('camTime').textContent='KEYFRAME @ '+fmt(item.at);for(let input of document.querySelectorAll('[data-cam]')){let [k,i]=input.dataset.cam.split('.');input.value=String(+item[k][Number(i)].toFixed(2));}el('camFov').value=item.fov;el('camCut').checked=!!item.cut;}
 else{el('textValue').value=item.value;el('textSubtitle').value=item.subtitle||'';for(let field of ['Start','End','X','Y'])el('text'+field).value=item[field.toLowerCase()];el('textSize').value=item.size||'medium';el('textAlign').value=item.align||'center';el('textTone').value=item.tone||'white';const fade=el('textFadeMode');if(fade)fade.value=item.textFade||'linear';}
 animationGraph?.refresh();
}
function setPlaying(value){if(!ready||!sequence)return;if(value&&(reviewShotId||sceneObjectEditor?.active))endGeometryReview();playing=!!value;el('playBtn').textContent=playing?'Ⅱ':'▶';if(playing){orbitMode=false;controls.enabled=false;el('inspectBtn').classList.remove('active');if(playhead>=sequence.duration-.01)seek(0);if(sequence.referenceSequence)syncReferenceMedia(playhead);else if(el('showRef').checked){let p=referenceVideo.play();if(p?.catch)p.catch(()=>{});}}else referenceVideo.pause();lastFrame=performance.now();}
function shotBoundary(direction){if(!ready||!sequence)return;let shot=shotAt(playhead);let val;if(direction<0){let prev=sequence.shots.filter(s=>s.start<shot.start-.03).at(-1);val=playhead-shot.start>.6?shot.start:prev?.start??0;}else val=sequence.shots.find(s=>s.start>playhead+.05)?.start??sequence.duration;setPlaying(false);seek(val+.001);}
function addCameraKey(){if(!ready||!sequence)return;setPlaying(false);const pos=camera.position.toArray(),tar=controls.target.toArray(),at=+playhead.toFixed(3);let id='c'+Date.now();let key={id,at,p:pos.map(x=>+x.toFixed(3)),t:tar.map(x=>+x.toFixed(3)),fov:camera.fov,cut:false};sequence.camera.push(key);sequence.camera.sort((a,b)=>a.at-b.at);select('camera',id);saveLocal();}
function addText(){if(!ready||!sequence)return;setPlaying(false);const at=+playhead.toFixed(3),id='tx'+Date.now(),item={id,start:at,end:Math.min(at+3,sequence.duration),value:'Your headline here',subtitle:'Supporting detail',x:50,y:42,size:'medium',align:'center',tone:'white'};sequence.text.push(item);selection={type:'text',id};el('inspectorMotionButton')?.click();refreshAll();saveLocal();}
function deleteSelected(){let data=selectedData();if(!data)return;if(selection.type==='camera'&&sequence.camera.length<=2){alert('The sequence needs at least two camera keys.');return;}let arr=sequence[selection.type];arr.splice(arr.indexOf(data),1);selection=null;refreshAll();saveLocal();seek(playhead,{force:true});}
const tracks=el('tracks');let dragging=false;
function pointerSeek(e){if(!ready||!sequence)return;const r=tracks.getBoundingClientRect(),x=clamp((e.clientX-r.left)/r.width,0,1);if(playing)setPlaying(false);seek(x*sequence.duration);}
tracks.addEventListener('pointerdown',e=>{
 if(e.button!==0||!ready||!sequence||e.target.closest('.key-marker,.text-item,.shot-item'))return;
 // Empty timeline space seeks and deselects, without modifying authored data.
 if(selection){selection=null;renderInspector();renderTimeline();}
 dragging=true;tracks.setPointerCapture(e.pointerId);pointerSeek(e);
});
tracks.addEventListener('pointermove',e=>{if(dragging)pointerSeek(e);});tracks.addEventListener('pointerup',()=>dragging=false);tracks.addEventListener('pointercancel',()=>dragging=false);
// Pointer-specific Play/Pause handler. Keyboard Space continues to use setPlaying().
// Lifting the transport prevents visual overlays from swallowing mouse clicks.
const playButton=el('playBtn');
const playTransport=playButton.closest('.transport');
if(playTransport){playTransport.style.position='relative';playTransport.style.zIndex='30';}
playButton.style.position='relative';
playButton.style.zIndex='31';
playButton.style.pointerEvents='auto';
playButton.addEventListener('pointerdown',event=>{
 if(event.button!==0||!ready||!sequence)return;
 event.preventDefault();
 setPlaying(!playing);
});
// Keyboard activation via Enter and programmatic .click() still work.
// Pointer-generated clicks are ignored to prevent a second toggle.
playButton.addEventListener('click',event=>{
 if(event.detail===0&&ready&&sequence)setPlaying(!playing);
});
el('backBtn').onclick=()=>shotBoundary(-1);el('nextBtn').onclick=()=>shotBoundary(1);
el('speed').onchange=e=>{speed=Number(e.target.value)||1;referenceVideo.playbackRate=speed;};
el('addCameraBtn').onclick=addCameraKey;el('addTextBtn').onclick=addText;
el('inspectBtn').onclick=()=>{if(!ready||!sequence||sceneObjectEditor?.active)return;if(playing)setPlaying(false);orbitMode=!orbitMode;controls.enabled=orbitMode;el('inspectBtn').classList.toggle('active',orbitMode);if(orbitMode)controls.target.set(...cameraAt(playhead).t);else applyCamera();};
el('captureBtn').onclick=()=>{const item=selectedData();if(!item||selection.type!=='camera')return;item.p=camera.position.toArray().map(x=>+x.toFixed(3));item.t=controls.target.toArray().map(x=>+x.toFixed(3));item.fov=camera.fov;orbitMode=false;controls.enabled=false;el('inspectBtn').classList.remove('active');renderInspector();saveLocal();};
for(let input of document.querySelectorAll('[data-cam]'))input.addEventListener('input',e=>{let d=selectedData();if(!d)return;let [k,j]=input.dataset.cam.split('.');d[k][Number(j)]=safeNum(input.value);orbitMode=false;controls.enabled=false;el('inspectBtn').classList.remove('active');applyCamera();saveLocal();});
el('camFov').oninput=e=>{let d=selectedData();if(!d)return;d.fov=clamp(safeNum(e.target.value,50),10,110);applyCamera();saveLocal();};
el('camCut').onchange=e=>{let d=selectedData();if(!d)return;d.cut=e.target.checked;renderTimeline();saveLocal();};
el('removeCameraBtn').onclick=deleteSelected;el('removeTextBtn').onclick=deleteSelected;
for(let [field,key] of [['textValue','value'],['textSubtitle','subtitle'],['textStart','start'],['textEnd','end'],['textX','x'],['textY','y'],['textSize','size'],['textAlign','align'],['textTone','tone']])el(field).addEventListener('input',e=>{let d=selectedData();if(!d)return;const numeric=['start','end','x','y'].includes(key);d[key]=numeric?safeNum(e.target.value):e.target.value;if(key==='start')d.start=clamp(d.start,0,sequence.duration-.1);if(key==='end')d.end=clamp(d.end,d.start+.1,sequence.duration);if(key==='x'||key==='y')d[key]=clamp(d[key],0,100);renderTimeline();renderOverlays();saveLocal();});
function downloadExport(blob,name){
 const url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(url),15000);
}
const exportMenu=el('exportChoices'),exportButton=el('exportBtn');
function showExportMenu(open){
 exportMenu.hidden=!open;exportButton.setAttribute('aria-expanded',String(open));
}
const exportFeedback=message=>{el('exportMessage').textContent=message;};
exportButton.onclick=()=>{if(!ready||!sequence)return;showExportMenu(exportMenu.hidden);};
el('exportJSONBtn').onclick=()=>{
 if(!ready||!sequence)return;
 downloadExport(new Blob([JSON.stringify(sequence,null,2)],{type:'application/json'}),'atoms-to-ai-timeline.json');
 exportFeedback('Timeline JSON exported.');el('saveStatus').textContent='● JSON EXPORTED';showExportMenu(false);
};
el('exportAEBtn').onclick=async()=>{
 if(!ready||!sequence)return;
 const button=el('exportAEBtn');
 button.disabled=true;exportButton.disabled=true;el('exportJSONBtn').disabled=true;
 try{
   if(aiSceneEditor?.hasPending?.())
     throw Error('Accept or discard the current AI geometry preview before packaging.');
   exportFeedback('Preparing current 3D scene and camera timeline…');
   await modelTools?.ready;
   const zip=await buildAfterEffectsPackage({
     sequence,world,primitiveWorld,cameraAt,
     onProgress:message=>exportFeedback(message)
   });
   downloadExport(zip,'atoms-to-ai-after-effects-package.zip');
   el('saveStatus').textContent='● AE PACKAGE EXPORTED';
   exportFeedback('After Effects package exported ('+(zip.size/1024/1024).toFixed(1)+' MB).');
 }catch(error){
   exportFeedback('Could not export AE package: '+error.message);
   el('saveStatus').textContent='● EXPORT FAILED';
   console.error('AE package export failed',error);
 }finally{
   button.disabled=false;exportButton.disabled=false;el('exportJSONBtn').disabled=false;
 }
};
document.addEventListener('pointerdown',event=>{
 if(!event.target.closest('.timeline-export-picker'))showExportMenu(false);
});
document.addEventListener('keydown',event=>{if(event.key==='Escape')showExportMenu(false);});
el('resetBtn').onclick=()=>{if(!ready||!sequence)return;if(aiSceneEditor?.isBusy?.()||aiSceneEditor?.hasPending?.()){alert('Finish the current AI job or proposal before resetting.');return;}if(!confirm('Reset all camera and text edits to the original timeline?'))return;endGeometryReview();aiSceneEditor?.reset();sequence=structuredClone(originalSequence);syncPrimitiveWorld();activeSingleVideoUrl=null;referenceVideo.pause();referenceVideo.src='assets/reference.mp4';referenceVideo.load();referenceVideo.style.display='block';el('showRef').checked=true;referenceBuilder?.loadFromSequence(null);refreshSourceVideoOverlay();timelineHistory?.reset(sequence);selection=null;setPlaying(false);orbitMode=false;controls.enabled=false;refreshAll();seek(0);saveLocal(false);};
el('loadBtn').onclick=()=>{if(!ready)return;if(aiSceneEditor?.isBusy?.()||aiSceneEditor?.hasPending?.()){alert('Finish the current AI job or proposal before importing.');return;}el('loadFile').click();};el('loadFile').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{if(aiSceneEditor?.isBusy?.()||aiSceneEditor?.hasPending?.())throw Error('Finish the active AI job or proposal first');let data=JSON.parse(await file.text());if(!validSequence(data))throw Error('JSON must include valid duration, shots, camera and text arrays.');validatePrimitiveDocument(data.primitiveScenes,data.shots.map(s=>s.id));endGeometryReview();activeSingleVideoUrl=null;aiSceneEditor?.reset();sequence=data;timelineHistory?.reset(sequence);if(data.videoIntake){referenceVideo.pause();referenceVideo.removeAttribute('src');referenceVideo.load();el('showRef').checked=false;}else if(!data.referenceSequence){referenceVideo.pause();referenceVideo.src='assets/reference.mp4';referenceVideo.load();el('showRef').checked=true;}referenceBuilder?.loadFromSequence(data);syncPrimitiveWorld();setPlaying(false);selection=null;orbitMode=false;controls.enabled=false;refreshAll();seek(0);refreshSourceVideoOverlay();saveLocal();}catch(err){alert('Could not import timeline: '+err.message);}e.target.value='';};
el('showRef').onchange=e=>{if(el('sourceOverlayEnabled').checked)return;if(sequence.referenceSequence){syncReferenceMedia(playhead);return;}referenceVideo.style.display=e.target.checked?'block':'none';if(!e.target.checked)referenceVideo.pause();else if(playing)referenceVideo.play().catch(()=>{});};
referenceVideo.addEventListener('loadedmetadata',()=>{if(sequence?.referenceSequence)syncReferenceMedia(playhead);else try{referenceVideo.currentTime=playhead;}catch(e){}});
window.addEventListener('keydown',e=>{const target=e.target;if(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement||target.isContentEditable)return;
 if(ready&&sceneObjectEditor?.active){
   if(e.code==='KeyW'||e.code==='KeyG'){e.preventDefault();sceneObjectEditor.setMode('translate');return;}
   if(e.code==='KeyE'||e.code==='KeyR'){e.preventDefault();sceneObjectEditor.setMode('rotate');return;}
   if(e.code==='Escape'){e.preventDefault();sceneObjectEditor.select(null);return;}
   if(e.code==='Delete'||e.code==='Backspace'){
     e.preventDefault();sceneObjectEditor.deleteSelected();return;
   }
 }
 if(e.code==='Space'){e.preventDefault();if(ready)setPlaying(!playing);}if(e.code==='ArrowRight'){e.preventDefault();if(ready){setPlaying(false);seek(playhead+1/30);}}if(e.code==='ArrowLeft'){e.preventDefault();if(ready){setPlaying(false);seek(playhead-1/30);}}if(e.code==='Delete'||e.code==='Backspace'){e.preventDefault();if(ready)deleteSelected();}});
new ResizeObserver(()=>{let w=viewport.clientWidth,h=viewport.clientHeight;if(w<=0||h<=0)return;camera.aspect=w/h;camera.updateProjectionMatrix();renderer.setSize(w,h);studioPost.setSize(w,h);requestViewportRender();}).observe(viewport);
boot().catch(error=>{el('errorBanner').hidden=false;el('errorBanner').textContent='Project could not start: '+error.message;console.error(error);});
