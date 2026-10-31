import * as THREE from 'three';
import {TransformControls} from 'three/addons/controls/TransformControls.js';
import {setupSceneSelectionPanel} from './scene-selection-panel.js';
import {findMatchingArrays,findArrayCompanions} from './array-prototype.js';
import {repeatOffsets} from './primitive-schema.js';

// Construct the bounds in the selected object's LOCAL coordinates. A world
// BoxHelper is axis aligned and visually slips away from rotated primitives.
// Keeping this line in the scene (rather than under the selected object) also
// prevents temporary editing chrome from appearing in GLB/AE exports.
export function createSelectionOutline(object){
  if(!object)throw Error('Selection outline requires an object');
  object.updateWorldMatrix(true,true);
  const inverse=new THREE.Matrix4().copy(object.matrixWorld).invert();
  const relative=new THREE.Matrix4(),localBounds=new THREE.Box3();
  let found=false;
  object.traverse(node=>{
    if(!node.isMesh||!node.geometry||node.userData.previewBatch)return;
    if(!node.geometry.boundingBox)node.geometry.computeBoundingBox();
    if(!node.geometry.boundingBox)return;
    relative.multiplyMatrices(inverse,node.matrixWorld);
    const bounds=node.geometry.boundingBox.clone().applyMatrix4(relative);
    localBounds.union(bounds);
    found=true;
  });
  if(!found||localBounds.isEmpty())return null;
  // Edges of a unit cube, transformed first to LOCAL object bounds and then
  // by the selected node's complete world matrix (shot anchor + rotation +
  // nonuniform scale). This is an oriented box, unlike BoxHelper.
  const unit=new THREE.BoxGeometry(1,1,1);
  const edges=new THREE.EdgesGeometry(unit);unit.dispose();
  const line=new THREE.LineSegments(edges,new THREE.LineBasicMaterial({
    color:0x93fff0,depthTest:false,transparent:true,opacity:.95
  }));
  const center=localBounds.getCenter(new THREE.Vector3());
  const dimensions=localBounds.getSize(new THREE.Vector3());
  const localTransform=new THREE.Matrix4().compose(
    center,new THREE.Quaternion(),dimensions);
  line.name='Selected object outline (editor only)';
  line.renderOrder=999;
  line.frustumCulled=false;line.matrixAutoUpdate=false;
  function update(){
    object.updateWorldMatrix(true,false);
    line.matrix.multiplyMatrices(object.matrixWorld,localTransform);
    line.matrixWorld.copy(line.matrix);
  }
  update();
  return {line,update,dispose(){
    line.removeFromParent();line.geometry.dispose();line.material.dispose();
  }};
}

// View/Edit is deliberately separate from AI proposals. Only accepted
// primitives can be selected and edited; all changes go through validated
// scene JSON and the existing local-save/export path.
export function setupSceneObjectEditing({
  scene,camera,canvas,orbitControls,world,getActiveShot,getDocument,
  onEnter,onExit,onTransform,onDelete,onLightTransform,onLightTargetTransform,onDeleteLight,onDuplicate,onMakeArray,onGroup,onUngroup,onCopy,onPaste,onSelect,onStatus,onArrayEdit,getInitialObjectId,onVisualChange=()=>{},onToolChange=()=>{}
}){
  const el=id=>document.getElementById(id);
  const view=el('sceneModeView'),edit=el('sceneModeEdit'),tools=el('sceneEditTools');
  const createButton=el('sceneCreateMenuButton');
  const selectionPanel=setupSceneSelectionPanel();
  const move=el('sceneEditMove'),rotate=el('sceneEditRotate');
  const duplicate=el('sceneEditDuplicate'),erase=el('sceneEditDelete'),name=el('sceneEditName'),hint=el('sceneEditStatus');
  const groupButton=el('sceneEditGroup'),ungroupButton=el('sceneEditUngroup'),copyButton=el('sceneEditCopy'),pasteButton=el('sceneEditPaste'),rectangleButton=el('sceneEditRectangle'),rectOverlay=el('sceneSelectionRectangle');
  const selectedIds=new Set(),extraOutlines=new Map();
  let rectangleMode=false,selectionRect=null;
  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();
  const transform=new TransformControls(camera,canvas);
  // The editor pins Three r166, where TransformControls is an Object3D.
  // Newer Three versions expose its visual root through getHelper().
  const helper=typeof transform.getHelper==='function'?transform.getHelper():transform;
  scene.add(helper);
  transform.enabled=false;
  transform.detach();
  transform.addEventListener('change',onVisualChange);
  let active=false,selectedId=null,selectedShot=null,operation='translate',gizmoOn=true;
  let frameStart=null,draggingHandle=false,skipClick=false,highlight=null;
  let arrayHighlights=[],pendingArray=null;
  let rotationProxy=null,rotationSource=null;
  function clearRotationProxy(){
    transform.detach();
    if(rotationSource){
      const record=getDocument()?.scenes?.find(s=>s.shotId===rotationSource.shotId)
        ?.objects.find(o=>o.id===rotationSource.id);
      const reset=record?.instanceRotation||[0,0,0];
      for(const copy of world.getArrayInstances(rotationSource.shotId,rotationSource.id))
        copy.rotation.set(...reset);
      world.invalidateGeometry?.(rotationSource.shotId);
    }
    rotationProxy?.removeFromParent();
    rotationProxy=null;rotationSource=null;
  }
  function attachForMode(node,id){
    clearRotationProxy();
    const row=getDocument()?.scenes?.find(s=>s.shotId===currentShot())
      ?.objects.find(o=>o.id===id);
    if(node&&operation==='rotate'&&row?.repeat){
      // A gizmo proxy rotates COPY GEOMETRY, never the group's offset axes.
      rotationProxy=new THREE.Object3D();
      rotationProxy.name='Array copy rotation gizmo (editor only)';
      node.parent.add(rotationProxy);
      rotationProxy.position.copy(node.position);
      rotationProxy.quaternion.copy(node.quaternion).multiply(
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(...(row.instanceRotation||[0,0,0]))));
      rotationSource={id,shotId:currentShot(),holder:node};
      transform.attach(rotationProxy);
    }else if(node)transform.attach(node);
  }
  function previewCopyRotation(){
    if(rotationProxy&&rotationSource){
      const local=rotationSource.holder.quaternion.clone().invert()
        .multiply(rotationProxy.quaternion);
      for(const copy of world.getArrayInstances(rotationSource.shotId,rotationSource.id))
        copy.quaternion.copy(local);
    }
    world.invalidateGeometry?.(currentShot());
    updateHighlight();
  }
  const arrayConfirm=el('arrayEditConfirm');
  const makeArrayDialog=el('sceneMakeArrayDialog');
  let pendingArrayObject=null;
  function closeMakeArray(){
    if(makeArrayDialog?.open)makeArrayDialog.close();
    pendingArrayObject=null;
  }
  function openMakeArray(id){
    if(!active||!makeArrayDialog||!select(id))return false;
    const entry=getDocument()?.scenes?.find(s=>s.shotId===currentShot());
    const obj=entry?.objects.find(o=>o.id===id);
    if(!obj)return false;
    pendingArrayObject={shotId:currentShot(),objectId:id};
    const count=obj.repeat?.count||[3,1,1];
    const spacing=obj.repeat?.spacing||[4,0,0];
    for(const [field,values] of [['count',count],['spacing',spacing]])
      makeArrayDialog.querySelectorAll('[data-array-'+field+']').forEach(input=>{
        input.value=String(values[Number(input.dataset['array'+
          field[0].toUpperCase()+field.slice(1)])]);});
    const title=el('sceneMakeArrayTitle');
    if(title)title.textContent=(obj.repeat?'EDIT ARRAY':'MAKE ARRAY')+' · '+obj.name;
    const status=el('sceneMakeArrayStatus');if(status)status.textContent='';
    if(typeof makeArrayDialog.showModal==='function')makeArrayDialog.showModal();
    return true;
  }
  el('sceneMakeArrayCancel')?.addEventListener('click',closeMakeArray);
  makeArrayDialog?.addEventListener('cancel',()=>{pendingArrayObject=null;});
  makeArrayDialog?.addEventListener('keydown',event=>event.stopPropagation());
  el('sceneMakeArraySave')?.addEventListener('click',()=>{
    if(!pendingArrayObject)return;
    const read=(name)=>[...makeArrayDialog.querySelectorAll('[data-array-'+name+']')]
      .sort((a,b)=>Number(a.dataset['array'+name[0].toUpperCase()+name.slice(1)])-
        Number(b.dataset['array'+name[0].toUpperCase()+name.slice(1)]))
      .map(input=>Number(input.value));
    try{
      onMakeArray?.(pendingArrayObject.shotId,pendingArrayObject.objectId,
        read('count'),read('spacing'));
      closeMakeArray();refresh();
      message('Array copies and spacing saved. Double-click a copy to edit its prototype.');
    }catch(error){
      const status=el('sceneMakeArrayStatus');
      if(status)status.textContent='Cannot create array: '+error.message;
    }
  });
  const message=text=>{if(hint)hint.textContent=text;onStatus?.(text);};
  const currentShot=()=>getActiveShot()?.id||null;
  function clearHighlight(){
    highlight?.dispose();highlight=null;
    onVisualChange();
  }
  function clearArrayHighlights(){
    for(const outline of arrayHighlights)outline.dispose();
    arrayHighlights=[];pendingArray=null;
    onVisualChange();
  }
  function clearExtraHighlights(){
    for(const outline of extraOutlines.values())outline.dispose();
    extraOutlines.clear();
  }
  function syncExtraHighlights(){
    clearExtraHighlights();
    if(!active)return;
    for(const id of selectedIds){
      if(id===selectedId)continue;
      const node=id.startsWith('light::')?world.getLightMarker(currentShot(),id.slice(7)):
        world.getObjectNode(currentShot(),id);
      if(!node)continue;
      const outline=createSelectionOutline(node);
      if(!outline)continue;
      outline.line.material.color.set(0x62bbff);
      scene.add(outline.line);extraOutlines.set(id,outline);
    }
    onVisualChange();
  }
  function updateHighlight(){highlight?.update();
    for(const outline of extraOutlines.values())outline.update();
    for(const outline of arrayHighlights)outline.update();}
  function showHighlight(object){
    clearHighlight();
    highlight=createSelectionOutline(object);
    if(highlight)scene.add(highlight.line);
  }
  function updateButtons(){
    view?.setAttribute('aria-pressed',String(!active));
    edit?.setAttribute('aria-pressed',String(active));
    view?.classList.toggle('active',!active);edit?.classList.toggle('active',active);
    if(tools)tools.hidden=!active;
    if(createButton)createButton.hidden=!active;
    selectionPanel.sync(active?selectedId:null);
    move?.classList.toggle('active',operation==='translate');
    rotate?.classList.toggle('active',operation==='rotate');
    move?.setAttribute('aria-pressed',String(operation==='translate'));
    rotate?.setAttribute('aria-pressed',String(operation==='rotate'));
    if(erase)erase.disabled=!active||!selectedId;
    if(duplicate)duplicate.disabled=!active||!selectedId;
    if(groupButton)groupButton.disabled=!active||selectedIds.size<2;
    const hasGroup=active&&[...selectedIds].some(id=>getDocument()?.scenes?.find(
      s=>s.shotId===selectedShot)?.objects?.find(o=>o.id===id)?.arrayParts);
    if(ungroupButton)ungroupButton.disabled=!hasGroup;
    if(copyButton)copyButton.disabled=!active||!selectedIds.size;
    if(pasteButton)pasteButton.disabled=!active;
    rectangleButton?.classList.toggle('active',rectangleMode);
    rectangleButton?.setAttribute('aria-pressed',String(rectangleMode));
    if(rotate)rotate.disabled=!!selectedId?.startsWith('light::')||
      !!selectedId?.startsWith('light-target::');
    if(name)name.textContent=selectedIds.size>1?selectedIds.size+' objects selected':selectedId?(()=>{
      const entry=getDocument()?.scenes?.find(s=>s.shotId===selectedShot);
      return selectedId.startsWith('light-target::')?
        (entry?.lights?.find(l=>l.id===selectedId.slice(14))?.name||selectedId)+' · Aim target':
        selectedId.startsWith('light::')?
          entry?.lights?.find(l=>l.id===selectedId.slice(7))?.name||selectedId:
          entry?.objects?.find(o=>o.id===selectedId)?.name||selectedId;
    })():'No object selected';
    if(canvas)canvas.style.cursor=active?'crosshair':'';
  }
  function select(id,notify=true,keepSet=false){
    if(!active)return false;
    const shotId=currentShot();
    const targetId=id?.startsWith('light-target::')?id.slice(14):null;
    const lightId=id?.startsWith('light::')?id.slice(7):null;
    const node=targetId?world.getLightTargetMarker(shotId,targetId):
      lightId?world.getLightMarker(shotId,lightId):
      id?world.getObjectNode(shotId,id):null;
    if(id&&!node)return false;
    if(!keepSet)selectedIds.clear();
    selectedId=id||null;selectedShot=shotId;
    if(selectedId)selectedIds.add(selectedId);
    clearRotationProxy();clearHighlight();
    if(node){
      if(lightId||targetId)setMode('translate');
      attachForMode(node,id);showHighlight(node);
      message(targetId?'Drag X/Y/Z to aim this light. The direction ray updates as you move the target.':
        lightId?'Drag X/Y/Z to move this light. Follow its direction ray to the aim target.':
        'Drag gizmo handles · W move / E rotate'+
          (getDocument()?.scenes?.find(s=>s.shotId===shotId)?.objects
            .find(o=>o.id===id)?.repeat?' · E rotates EACH copy in place':'')+
          ' · Delete removes');
    }else message('Click an editable shape to select it; drag to orbit and scroll to zoom.');
    syncExtraHighlights();
    updateButtons();if(notify)onSelect?.(selectedId);
    return true;
  }
  function multiSelect(id){
    if(!id)return;
    if(selectedIds.has(id)){
      selectedIds.delete(id);
      select(selectedIds.size?[...selectedIds].at(-1):null,true,true);
    }else{
      selectedIds.add(id);select(id,true,true);
    }
  }
  function selectMany(ids){
    selectedIds.clear();
    for(const id of ids)selectedIds.add(id);
    select(ids.at(-1)||null,true,true);
    message(ids.length+' visible object(s) selected · Ctrl/Cmd+G to group.');
  }
  function visibleSelections(){
    const entry=getDocument()?.scenes?.find(s=>s.shotId===currentShot());
    if(!entry)return [];
    const layers=entry.layerVisibility||{};
    const solo=world.getIsolation?.(currentShot());
    const objectAllowed=item=>!solo||
      (solo.kind==='layer'&&solo.layer===(item.layer||'manual'))||
      (['object','part'].includes(solo.kind)&&solo.id===item.id);
    const lightAllowed=item=>!solo||
      (solo.kind==='layer'&&solo.layer==='lights')||
      (solo.kind==='light'&&solo.id===item.id);
    return [...entry.objects.filter(item=>item.visible!==false&&
      layers[item.layer||'manual']!==false&&objectAllowed(item)).map(o=>o.id),
      ...(layers.lights===false?[]:(entry.lights||[]).filter(item=>
        item.visible!==false&&lightAllowed(item)).map(light=>'light::'+light.id))];
  }
  function groupSelected(){
    if(!active||selectedIds.size<2||!onGroup)return false;
    try{
      const id=onGroup(currentShot(),[...selectedIds]);
      if(!id||!select(id))throw Error('Grouped object was not selectable');
      message('Grouped objects into a single editable assembly. Double-click to open its parts.');
      return true;
    }catch(error){message('Group rejected: '+error.message);refresh();return false;}
  }
  groupButton?.addEventListener('click',groupSelected);
  function ungroupSelected(){
    if(!active||!selectedIds.size||!onUngroup)return false;
    try{
      const ids=onUngroup(currentShot(),[...selectedIds]);
      if(!ids?.length)throw Error('Nothing was ungrouped');
      selectedIds.clear();ids.forEach(id=>selectedIds.add(id));
      if(!select(ids.at(-1),true,true))throw Error('Ungrouped parts were not selectable');
      message('Ungrouped into '+ids.length+' separate selected item(s).');
      return true;
    }catch(error){message('Ungroup rejected: '+error.message);refresh();return false;}
  }
  function copySelected(){
    if(!active||!selectedIds.size||!onCopy)return false;
    try{
      const count=onCopy(currentShot(),[...selectedIds]);
      message('Copied '+count+' item(s). Switch chapters and paste with Ctrl/Cmd+V.');
      updateButtons();return true;
    }catch(error){message('Copy rejected: '+error.message);return false;}
  }
  function pasteSelected(){
    if(!active||!onPaste)return false;
    try{
      const ids=onPaste(currentShot());
      if(!ids?.length)throw Error('Nothing pasted');
      selectedIds.clear();ids.forEach(id=>selectedIds.add(id));
      if(!select(ids.at(-1),true,true))throw Error('Pasted items were not selectable');
      message('Pasted '+ids.length+' item(s) into this chapter.');
      return true;
    }catch(error){message('Paste rejected: '+error.message);refresh();return false;}
  }
  ungroupButton?.addEventListener('click',ungroupSelected);
  copyButton?.addEventListener('click',copySelected);
  pasteButton?.addEventListener('click',pasteSelected);
  function setMode(value){
    if(!['translate','rotate'].includes(value))return;
    if(value==='rotate'&&(selectedId?.startsWith('light::')||
      selectedId?.startsWith('light-target::')))return;
    const previous=operation;
    operation=value;transform.setMode(value);setGizmoEnabled(true);
    // World axes for movement; local rings for rotation.
    transform.setSpace(value==='translate'?'world':'local');
    if(active&&selectedId&&previous!==value){
      const id=selectedId;
      const targetId=id.startsWith('light-target::')?id.slice(14):null;
      const lightId=id.startsWith('light::')?id.slice(7):null;
      const node=targetId?world.getLightTargetMarker(currentShot(),targetId):
        lightId?world.getLightMarker(currentShot(),lightId):
        world.getObjectNode(currentShot(),id);
      if(node)attachForMode(node,id);
    }
    updateButtons();onToolChange();
  }
  /** Orbit tool: hide and disable the gizmo so a drag can only move the camera. */
  function setGizmoEnabled(on){
    gizmoOn=!!on;
    transform.enabled=active&&gizmoOn&&!rectangleMode;
    helper.visible=gizmoOn;
    onToolChange();
  }
  function setActive(next,{skipExit=false}={}){
    if(active===next)return true;
    if(next){
      if(onEnter?.()===false){updateButtons();return false;}
      active=true;gizmoOn=true;helper.visible=true;transform.enabled=true;
      world.setLightMarkersVisible?.(true);
      orbitControls.enabled=true;
      selectedShot=currentShot();
      setMode('translate');
      if(!select(getInitialObjectId?.()||null,false))select(null,false);
    }else{
      active=false;selectedId=null;selectedShot=null;frameStart=null;
      selectedIds.clear();clearExtraHighlights();rectangleMode=false;selectionRect=null;
      if(rectOverlay)rectOverlay.hidden=true;
      closeArrayDialog();clearArrayHighlights();
      world.setLightMarkersVisible?.(false);
      clearRotationProxy();transform.enabled=false;clearHighlight();
      orbitControls.enabled=true; // onExit restores cinematic state
      updateButtons();
      if(!skipExit)onExit?.();
      message('View mode · timeline camera');
      onSelect?.(null);
    }
    updateButtons();onToolChange();return true;
  }
  function focusSelectionIfOffscreen(){
    if(!active||!selectedId)return;
    const id=selectedId.startsWith('light-target::')?selectedId.slice(14):
      selectedId.startsWith('light::')?selectedId.slice(7):null;
    const node=id?world.getLightMarker(currentShot(),id):null;
    if(!node)return;
    node.updateWorldMatrix(true,false);
    const position=node.getWorldPosition(new THREE.Vector3());
    const projected=position.clone().project(camera);
    if(projected.z>1||projected.z< -1||Math.abs(projected.x)>.76||Math.abs(projected.y)>.76){
      const offset=position.clone().sub(orbitControls.target);
      camera.position.add(offset);orbitControls.target.copy(position);
      camera.lookAt(position);orbitControls.update();
    }
  }
  function refresh(){
    if(!active)return;
    if(selectedShot!==currentShot()){setActive(false);return;}
    if(selectedId){
      const id=selectedId;
      if(!(id.startsWith('light-target::')?world.getLightTargetMarker(selectedShot,id.slice(14)):
        id.startsWith('light::')?world.getLightMarker(selectedShot,id.slice(7)):
        world.getObjectNode(selectedShot,id))){select(null);return;}
      // Drop removed group members rather than keeping stale highlights.
      for(const key of [...selectedIds]){
        if(!(key.startsWith('light::')?world.getLightMarker(selectedShot,key.slice(7)):
          world.getObjectNode(selectedShot,key)))selectedIds.delete(key);
      }
      select(id,false,true); // reattach to rebuilt geometry after a committed edit
    }
  }
  function commit(){
    if(!active||!selectedId||!transform.object)return;
    const objectId=selectedId;
    const node=transform.object;
    const perCopy=operation==='rotate'&&rotationProxy&&rotationSource;
    const angles=perCopy?
      new THREE.Euler().setFromQuaternion(
        rotationSource.holder.quaternion.clone().invert().multiply(node.quaternion)):
      node.rotation;
    const vector=operation==='translate'?node.position.toArray():
      [angles.x,angles.y,angles.z];
    try{
      if(objectId.startsWith('light-target::')){
        if(operation!=='translate')throw Error('Aim targets can only translate.');
        onLightTargetTransform?.(selectedShot,objectId.slice(14),vector);
      }else if(objectId.startsWith('light::')){
        if(operation!=='translate')throw Error('Use light aim fields for orientation.');
        onLightTransform?.(selectedShot,objectId.slice(7),vector);
      }else onTransform?.(selectedShot,objectId,operation,vector);
      message((operation==='translate'?'Moved ':'Rotated ')+objectId+'. Saved to the editable timeline.');
    }catch(error){
      message('Transform rejected: '+error.message);
      refresh(); // discard unsaved invalid canvas transform
    }
  }
  function duplicateSelected(){
    if(!active||!selectedId||!onDuplicate)return false;
    try{
      const copied=onDuplicate(selectedShot,selectedId);
      if(!copied||!select(copied))throw Error('Could not select copied object');
      message('Duplicated object. Move or rotate the new copy; the source is unchanged.');
      return true;
    }catch(error){message('Duplicate rejected: '+error.message);refresh();return false;}
  }
  function deleteSelected(){
    if(!active||!selectedId)return false;
    const id=selectedId,shot=selectedShot;
    try{
      if(id.startsWith('light-target::'))onDeleteLight?.(shot,id.slice(14));
      else if(id.startsWith('light::'))onDeleteLight?.(shot,id.slice(7));
      else onDelete?.(shot,id);
      selectedId=null;selectedIds.clear();clearExtraHighlights();
      clearRotationProxy();clearHighlight();
      updateButtons();onSelect?.(null);
      message('Deleted '+id+' from this chapter. Export timeline JSON to keep a backup.');
      return true;
    }catch(error){message('Delete rejected: '+error.message);return false;}
  }
  transform.addEventListener('mouseDown',()=>{
    if(!active)return;
    draggingHandle=true;skipClick=true;
    orbitControls.enabled=false;
  });
  transform.addEventListener('objectChange',previewCopyRotation);
  transform.addEventListener('mouseUp',()=>{
    if(!active)return;
    orbitControls.enabled=true;
    if(draggingHandle)commit();
    draggingHandle=false;skipClick=true;
  });
  function ndc(event){
    const box=canvas.getBoundingClientRect();
    pointer.x=(event.clientX-box.left)/box.width*2-1;
    pointer.y=-((event.clientY-box.top)/box.height*2-1);
  }
  function paintRect(x,y){
    if(!selectionRect||!rectOverlay)return;
    const bounds=canvas.getBoundingClientRect();
    const a=selectionRect;
    rectOverlay.style.left=(Math.min(a.x,x)-bounds.left)+'px';
    rectOverlay.style.top=(Math.min(a.y,y)-bounds.top)+'px';
    rectOverlay.style.width=Math.abs(x-a.x)+'px';
    rectOverlay.style.height=Math.abs(y-a.y)+'px';
  }
  function projectedBounds(node){
    node.updateWorldMatrix(true,true);
    const box=new THREE.Box3().setFromObject(node);
    if(box.isEmpty())return null;
    const corners=[];
    for(const x of [box.min.x,box.max.x])
      for(const y of [box.min.y,box.max.y])
        for(const z of [box.min.z,box.max.z]){
          const p=new THREE.Vector3(x,y,z).project(camera);
          if(p.z>=-1&&p.z<=1)corners.push(p);
        }
    if(!corners.length)return null;
    const r=canvas.getBoundingClientRect();
    const xs=corners.map(p=>r.left+(p.x+1)*r.width/2);
    const ys=corners.map(p=>r.top+(1-p.y)*r.height/2);
    return {left:Math.min(...xs),right:Math.max(...xs),
      top:Math.min(...ys),bottom:Math.max(...ys)};
  }
  function finishRectangle(end,additive){
    const start=selectionRect;selectionRect=null;
    if(rectOverlay)rectOverlay.hidden=true;
    if(!start)return;
    const rect={left:Math.min(start.x,end.x),right:Math.max(start.x,end.x),
      top:Math.min(start.y,end.y),bottom:Math.max(start.y,end.y)};
    if(rect.right-rect.left<5&&rect.bottom-rect.top<5)return;
    const selected=additive?[...selectedIds]:[];
    const crossing=end.x<start.x;
    for(const id of visibleSelections()){
      const node=id.startsWith('light::')?world.getLightMarker(currentShot(),id.slice(7)):
        world.getObjectNode(currentShot(),id);
      if(!node)continue;
      const bounds=projectedBounds(node);
      const overlap=bounds&&bounds.right>=rect.left&&bounds.left<=rect.right&&
        bounds.bottom>=rect.top&&bounds.top<=rect.bottom;
      const contained=bounds&&bounds.left>=rect.left&&bounds.right<=rect.right&&
        bounds.top>=rect.top&&bounds.bottom<=rect.bottom;
      // L→R is precise containment; R→L is crossing-selection.
      if((crossing?overlap:contained)&&!selected.includes(id))selected.push(id);
    }
    selectMany(selected);
  }
  rectangleButton?.addEventListener('click',()=>{
    rectangleMode=!rectangleMode;orbitControls.enabled=!rectangleMode;
    transform.enabled=!rectangleMode&&gizmoOn;
    updateButtons();message(rectangleMode?
      'Drag left-to-right to contain objects, right-to-left to cross-select; Shift adds.':
      'Rectangle selection off. Drag to orbit.');
  });
  // Orbit tool: a tap on an object sets the orbit pivot to it (no highlight, no gizmo); holding the
  // left button on it fills a progress ring and then selects it for editing.
  const HOLD_MS=550,HOLD_SHOW_MS=140,TAP_SLOP=5;
  let ring=null;
  function holdRing(){
    if(ring||typeof document.createElement!=='function'||!canvas.parentElement)return ring;
    ring=document.createElement('div');
    ring.className='hold-ring';ring.hidden=true;
    ring.innerHTML='<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="hold-ring-track" cx="22" cy="22" r="18"/><circle class="hold-ring-fill" cx="22" cy="22" r="18" pathLength="100"/></svg>';
    canvas.parentElement.appendChild(ring);
    return ring;
  }
  let hold=null,downAt=null;
  const orbitToolActive=()=>active&&!gizmoOn&&!rectangleMode;
  function hitAt(event){
    ndc(event);raycaster.setFromCamera(pointer,camera);
    return raycaster.intersectObjects(world.getPickableMeshes(currentShot()),false)[0]||null;
  }
  function idOfHit(hit){
    const data=hit?.object?.userData;
    return data?.primitiveLightTargetId?'light-target::'+data.primitiveLightTargetId:
      data?.primitiveLightId?'light::'+data.primitiveLightId:data?.primitiveId||null;
  }
  function cancelHold(){
    if(hold?.frame)cancelAnimationFrame(hold.frame);
    hold=null;if(ring)ring.hidden=true;
  }
  function startHold(event,hit){
    const box=canvas.getBoundingClientRect();
    hold={x:event.clientX,y:event.clientY,id:idOfHit(hit),multi:event.shiftKey||event.ctrlKey||event.metaKey,t0:performance.now(),done:false,frame:0};
    const el=holdRing();
    if(el){el.style.left=(event.clientX-box.left)+'px';el.style.top=(event.clientY-box.top)+'px';}
    const tick=now=>{
      if(!hold)return;
      const elapsed=now-hold.t0;
      if(el&&elapsed>=HOLD_SHOW_MS){el.hidden=false;el.style.setProperty('--hold',String(Math.min(1,elapsed/HOLD_MS)));}
      if(elapsed>=HOLD_MS){
        hold.done=true;if(el)el.hidden=true;
        if(hold.multi)multiSelect(hold.id);else select(hold.id);
        hold.frame=0;return;
      }
      hold.frame=requestAnimationFrame(tick);
    };
    hold.frame=requestAnimationFrame(tick);
  }
  /** Ease the orbit pivot to the middle of the object that was tapped. */
  function focusPivot(object){
    const box=new THREE.Box3().setFromObject(object);
    if(box.isEmpty())return;
    const to=box.getCenter(new THREE.Vector3()),from=orbitControls.target.clone(),t0=performance.now();
    const step=now=>{
      const k=Math.min(1,(now-t0)/260),eased=1-(1-k)**3;
      orbitControls.target.lerpVectors(from,to,eased);orbitControls.update();onVisualChange();
      if(k<1)requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  canvas.addEventListener('pointerdown',event=>{
    if(active&&rectangleMode&&event.button===0){
      selectionRect={x:event.clientX,y:event.clientY,additive:event.shiftKey};
      if(rectOverlay)rectOverlay.hidden=false;
      paintRect(event.clientX,event.clientY);frameStart=null;return;
    }
    frameStart=active&&event.button===0?{x:event.clientX,y:event.clientY}:null;
    downAt=event.button===0?{x:event.clientX,y:event.clientY}:null;
    cancelHold();
    if(active&&transform.axis)skipClick=true;
    if(orbitToolActive()&&event.button===0&&!transform.axis){
      const hit=hitAt(event);
      if(hit&&idOfHit(hit))startHold(event,hit);
    }
  });
  canvas.addEventListener('pointermove',event=>{
    if(selectionRect)paintRect(event.clientX,event.clientY);
    if(hold&&!hold.done&&Math.hypot(event.clientX-hold.x,event.clientY-hold.y)>TAP_SLOP)cancelHold();
  });
  canvas.addEventListener('pointerup',event=>{
    if(active&&selectionRect&&event.button===0){
      finishRectangle({x:event.clientX,y:event.clientY},event.shiftKey||selectionRect.additive);
      return;
    }
    const press=downAt;downAt=null;
    const held=hold?.done;
    cancelHold();
    if(event.button===0&&held){frameStart=null;skipClick=false;return;}   // the hold already selected; do not also treat it as a tap
    const tapped=press&&Math.hypot(event.clientX-press.x,event.clientY-press.y)<=TAP_SLOP&&!transform.dragging&&!draggingHandle&&!skipClick;
    if(!active){
      // Orbit inspect (View mode): tapping an object moves the orbit pivot to it.
      if(orbitControls.enabled&&event.button===0&&tapped){const hit=hitAt(event);if(hit)focusPivot(hit.object);}
      return;
    }
    if(!frameStart||event.button!==0)return;
    const from=frameStart;frameStart=null;
    if(Math.hypot(event.clientX-from.x,event.clientY-from.y)>5||
       draggingHandle||transform.dragging||skipClick){skipClick=false;return;}
    ndc(event);raycaster.setFromCamera(pointer,camera);
    const hits=raycaster.intersectObjects(world.getPickableMeshes(currentShot()),false);
    if(orbitToolActive()&&hits[0]){focusPivot(hits[0].object);return;}
    const hit=hits[0]?.object?.userData;
    const id=hit?.primitiveLightTargetId?'light-target::'+hit.primitiveLightTargetId:
      hit?.primitiveLightId?'light::'+hit.primitiveLightId:hit?.primitiveId||null;
    if(event.shiftKey||event.ctrlKey||event.metaKey)multiSelect(id);
    else select(id);
  });
  canvas.addEventListener('pointercancel',()=>{
    cancelHold();downAt=null;
    frameStart=null;skipClick=false;selectionRect=null;
    if(rectOverlay)rectOverlay.hidden=true;
  });
  function closeArrayDialog(){
    if(arrayConfirm?.open)arrayConfirm.close();
    if(arrayConfirm)arrayConfirm.hidden=true;
  }
  function askArrayEdit(shotId,objectId,clickedIndex){
    const source=getDocument();
    const sceneData=source?.scenes?.find(s=>s.shotId===shotId);
    const base=sceneData?.objects?.find(o=>o.id===objectId&&(o.repeat||o.arrayParts));
    if(!base)return;
    const matching=base.repeat?findMatchingArrays(source,shotId,objectId):[objectId];
    if(!matching.length)return;
    const named=base.repeat?findArrayCompanions(source,shotId,objectId)
      .filter(candidate=>candidate.nameMatch):[];
    const all=[...new Set([...matching,...named.flatMap(candidate=>candidate.ids)])];
    clearArrayHighlights();
    let count=0;
    for(const id of all){
      const row=sceneData.objects.find(o=>o.id===id);
      const instances=row?.repeat?world.getArrayInstances(shotId,id):
        [world.getObjectNode(shotId,id)].filter(Boolean);
      for(const [i,instance] of instances.entries()){
        const outline=createSelectionOutline(instance);
        if(!outline)continue;
        const clicked=id===objectId&&i===clickedIndex;
        outline.line.material.color.set(clicked?0xffc079:0x77f6e5);
        outline.line.material.opacity=clicked?1:.57;
        outline.line.renderOrder=clicked?1003:1000;
        scene.add(outline.line);arrayHighlights.push(outline);
        count++;
      }
    }
    pendingArray={shotId,objectId,clickedIndex};
    if(el('arrayEditConfirmText'))
      el('arrayEditConfirmText').textContent=
        'Edit '+base.name+'? The chosen '+(base.repeat?'copy':'object')+' and all '+count+
        (base.repeat?' matching copies':' matching object(s)')+' across '+all.length+' group(s) are highlighted'+
        (named.length?', including '+named.map(x=>x.name).join(', '):'')+'. '+
        'The editable components open together in the prototype editor; only Save applies edits.';
    if(arrayConfirm){
      arrayConfirm.hidden=false;
      if(typeof arrayConfirm.showModal==='function'&&!arrayConfirm.open)
        arrayConfirm.showModal();
    }
  }
  canvas.addEventListener('dblclick',event=>{
    if(!active||event.button!==0||transform.dragging||draggingHandle)return;
    ndc(event);raycaster.setFromCamera(pointer,camera);
    const entry=getDocument()?.scenes?.find(s=>s.shotId===currentShot());
    const hit=raycaster.intersectObjects(world.getPickableMeshes(currentShot()),false)
      .find(x=>{
        const ud=x.object?.userData;
        return !!ud?.primitiveId&&(ud.primitiveArrayIndex!=null||
          entry?.objects.some(o=>o.id===ud.primitiveId&&o.arrayParts));
      });
    if(!hit)return;
    const id=hit.object.userData.primitiveId;
    const index=hit.object.userData.primitiveArrayIndex;
    if(!select(id))return;
    askArrayEdit(currentShot(),id,index);
  });
  el('arrayEditNo')?.addEventListener('click',()=>{
    closeArrayDialog();clearArrayHighlights();
  });
  el('arrayEditYes')?.addEventListener('click',()=>{
    const target=pendingArray;
    closeArrayDialog();
    if(target&&!onArrayEdit?.(target.shotId,target.objectId,target.clickedIndex))
      clearArrayHighlights();
  });
  arrayConfirm?.addEventListener?.('cancel',event=>{
    event.preventDefault();closeArrayDialog();clearArrayHighlights();
  });
  arrayConfirm?.addEventListener?.('keydown',event=>event.stopPropagation());
  view?.addEventListener('click',()=>setActive(false));
  edit?.addEventListener('click',()=>setActive(true));
  move?.addEventListener('click',()=>setMode('translate'));
  rotate?.addEventListener('click',()=>setMode('rotate'));
  erase?.addEventListener('click',deleteSelected);
  duplicate?.addEventListener('click',duplicateSelected);
  document.addEventListener?.('keydown',event=>{
    if(!active||!(event.ctrlKey||event.metaKey)||
      event.target?.closest?.('input,textarea,select,[contenteditable]')||
      !el('arrayEditModal')?.hidden)return;
    if(event.key.toLowerCase()==='a'){
      event.preventDefault();selectMany(visibleSelections());
    }else if(event.key.toLowerCase()==='g'){
      event.preventDefault();event.shiftKey?ungroupSelected():groupSelected();
    }else if(event.key.toLowerCase()==='c'&&selectedIds.size){
      event.preventDefault();copySelected();
    }else if(event.key.toLowerCase()==='v'){
      event.preventDefault();pasteSelected();
    }else if(event.key.toLowerCase()==='d'&&selectedId){
      event.preventDefault();duplicateSelected();
    }
  });
  updateButtons();
  return {
    get active(){return active;},
    pickObjectAt(x,y){
      if(!active)return null;
      ndc({clientX:x,clientY:y});raycaster.setFromCamera(pointer,camera);
      return raycaster.intersectObjects(world.getPickableMeshes(currentShot()),false)
        .find(x=>x.object?.userData?.primitiveId)?.object.userData.primitiveId||null;
    },
    openMakeArray,
    openGroupEditor(id){
      const row=getDocument()?.scenes?.find(s=>s.shotId===currentShot())
        ?.objects?.find(o=>o.id===id);
      if(!row?.repeat&&!row?.arrayParts)return false;
      if(!select(id))return false;
      askArrayEdit(currentShot(),id,0);return true;
    },
    get selectedId(){return selectedId;},
    get selectedIds(){return [...selectedIds];},
    isSelected(id){return selectedIds.has(id);},
    groupSelected,ungroupSelected,copySelected,pasteSelected,
    setActive,refresh,select,setMode,setGizmoEnabled,
    get operation(){return operation;},get gizmoEnabled(){return gizmoOn;},duplicateSelected,deleteSelected,updateHighlight,focusSelectionIfOffscreen,clearArrayHighlights,
    dispose(){setActive(false,{skipExit:true});clearRotationProxy();selectionPanel.restore();
      closeMakeArray();transform.dispose?.();scene.remove(helper);clearHighlight();clearExtraHighlights();clearArrayHighlights();}
  };
}
