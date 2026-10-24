import * as THREE from 'three';
import {TransformControls} from 'three/addons/controls/TransformControls.js';

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
    if(!node.isMesh||!node.geometry)return;
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
  onEnter,onExit,onTransform,onDelete,onSelect,onStatus,getInitialObjectId
}){
  const el=id=>document.getElementById(id);
  const view=el('sceneModeView'),edit=el('sceneModeEdit'),tools=el('sceneEditTools');
  const move=el('sceneEditMove'),rotate=el('sceneEditRotate');
  const erase=el('sceneEditDelete'),name=el('sceneEditName'),hint=el('sceneEditStatus');
  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();
  const transform=new TransformControls(camera,canvas);
  // The editor pins Three r166, where TransformControls is an Object3D.
  // Newer Three versions expose its visual root through getHelper().
  const helper=typeof transform.getHelper==='function'?transform.getHelper():transform;
  scene.add(helper);
  transform.enabled=false;
  transform.detach();
  let active=false,selectedId=null,selectedShot=null,operation='translate';
  let frameStart=null,draggingHandle=false,skipClick=false,highlight=null;
  const message=text=>{if(hint)hint.textContent=text;onStatus?.(text);};
  const currentShot=()=>getActiveShot()?.id||null;
  function clearHighlight(){
    highlight?.dispose();highlight=null;
  }
  function updateHighlight(){highlight?.update();}
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
    move?.classList.toggle('active',operation==='translate');
    rotate?.classList.toggle('active',operation==='rotate');
    move?.setAttribute('aria-pressed',String(operation==='translate'));
    rotate?.setAttribute('aria-pressed',String(operation==='rotate'));
    if(erase)erase.disabled=!active||!selectedId;
    if(name)name.textContent=selectedId?getDocument()?.scenes?.find(s=>s.shotId===selectedShot)
      ?.objects?.find(o=>o.id===selectedId)?.name||selectedId:'No object selected';
    if(canvas)canvas.style.cursor=active?'crosshair':'';
  }
  function select(id,notify=true){
    if(!active)return false;
    const shotId=currentShot();
    const node=id?world.getObjectNode(shotId,id):null;
    if(id&&!node)return false;
    selectedId=id||null;selectedShot=shotId;
    transform.detach();clearHighlight();
    if(node){
      transform.attach(node);showHighlight(node);
      message('Drag X / Y / Z gizmo handles · Orbit on empty space · W move / E rotate · Delete removes');
    }else message('Click an editable shape to select it; drag to orbit and scroll to zoom.');
    updateButtons();if(notify)onSelect?.(selectedId);
    return true;
  }
  function setMode(value){
    if(!['translate','rotate'].includes(value))return;
    operation=value;transform.setMode(value);
    // World axes for movement; local rings for rotation.
    transform.setSpace(value==='translate'?'world':'local');
    updateButtons();
  }
  function setActive(next,{skipExit=false}={}){
    if(active===next)return true;
    if(next){
      if(onEnter?.()===false){updateButtons();return false;}
      active=true;transform.enabled=true;
      orbitControls.enabled=true;
      selectedShot=currentShot();
      setMode('translate');
      if(!select(getInitialObjectId?.()||null,false))select(null,false);
    }else{
      active=false;selectedId=null;selectedShot=null;frameStart=null;
      transform.detach();transform.enabled=false;clearHighlight();
      orbitControls.enabled=true; // onExit restores cinematic state
      updateButtons();
      if(!skipExit)onExit?.();
      message('View mode · timeline camera');
      onSelect?.(null);
    }
    updateButtons();return true;
  }
  function refresh(){
    if(!active)return;
    if(selectedShot!==currentShot()){setActive(false);return;}
    if(selectedId){
      const id=selectedId;
      if(!world.getObjectNode(selectedShot,id)){select(null);return;}
      select(id,false); // reattach to rebuilt geometry after a committed edit
    }
  }
  function commit(){
    if(!active||!selectedId||!transform.object)return;
    const objectId=selectedId;
    const node=transform.object;
    const vector=operation==='translate'?node.position.toArray():
      [node.rotation.x,node.rotation.y,node.rotation.z];
    try{
      onTransform?.(selectedShot,objectId,operation,vector);
      message((operation==='translate'?'Moved ':'Rotated ')+objectId+'. Saved to the editable timeline.');
    }catch(error){
      message('Transform rejected: '+error.message);
      refresh(); // discard unsaved invalid canvas transform
    }
  }
  function deleteSelected(){
    if(!active||!selectedId)return false;
    const id=selectedId,shot=selectedShot;
    try{
      onDelete?.(shot,id);
      selectedId=null;
      transform.detach();clearHighlight();
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
  transform.addEventListener('objectChange',updateHighlight);
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
  canvas.addEventListener('pointerdown',event=>{
    frameStart=active&&event.button===0?{x:event.clientX,y:event.clientY}:null;
    if(active&&transform.axis)skipClick=true;
  });
  canvas.addEventListener('pointerup',event=>{
    if(!active||!frameStart||event.button!==0)return;
    const from=frameStart;frameStart=null;
    if(Math.hypot(event.clientX-from.x,event.clientY-from.y)>5||
       draggingHandle||transform.dragging||skipClick){skipClick=false;return;}
    ndc(event);raycaster.setFromCamera(pointer,camera);
    const hits=raycaster.intersectObjects(world.getPickableMeshes(currentShot()),false);
    select(hits[0]?.object?.userData?.primitiveId||null);
  });
  canvas.addEventListener('pointercancel',()=>{frameStart=null;skipClick=false;});
  view?.addEventListener('click',()=>setActive(false));
  edit?.addEventListener('click',()=>setActive(true));
  move?.addEventListener('click',()=>setMode('translate'));
  rotate?.addEventListener('click',()=>setMode('rotate'));
  erase?.addEventListener('click',deleteSelected);
  updateButtons();
  return {
    get active(){return active;},
    get selectedId(){return selectedId;},
    setActive,refresh,select,setMode,deleteSelected,updateHighlight,
    dispose(){setActive(false,{skipExit:true});transform.dispose?.();scene.remove(helper);clearHighlight();}
  };
}
