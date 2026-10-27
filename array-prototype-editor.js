import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {TransformControls} from 'three/addons/controls/TransformControls.js';
import {createPrimitiveWorld} from './primitive-world.js';
import {CREATE_CATEGORIES,insertCreatedAsset} from './scene-asset-catalog.js';
import {findMatchingArrays,findArrayCompanions,saveArrayPrototype,arrayGroupKey} from './array-prototype.js';
import {repeatOffsets,radiansToDegrees,degreesToRadians,lightCastsShadow,validateSceneEffects,validatePrimitiveDocument} from './primitive-schema.js';
import {DEFAULT_EFFECTS,applyShotEffects} from './scene-effects.js';
import {listAssemblyTemplates,replaceAssemblyContents,saveAssemblyHierarchy,editableAssembly}
  from './array-assembly-templates.js';

const sampleShot='arrayPreview';
const finite=value=>Number.isFinite(Number(value))?Number(value):null;
export const displayHundredth=value=>Number.isFinite(Number(value))?String(Number(Number(value).toFixed(2))):'0';

// Never treat a visible, enabled Replace action as a no-op: older projects
// and browser restorations may leave the select on the blank placeholder.
export function resolveAssemblyTemplateSelection(templates,selectedId){
 if(!Array.isArray(templates)||!templates.length)return null;
 return templates.find(item=>item.id===selectedId)||templates[0];
}

// getBounds().center is a plain [x,y,z] tuple, NOT a THREE.Vector3.
// Vector3.copy(array) silently writes undefined X/Y/Z, then the WebGL
// camera matrix becomes NaN and the viewport draws only its clear color.
export function framePrototypeCamera(camera,orbit,bounds){
 const center=bounds?.center;
 if(!Array.isArray(center)||center.length!==3||
   !center.every(Number.isFinite)||!Number.isFinite(bounds?.radius))
   throw Error('Prototype bounds are not valid XYZ coordinates.');
 const radius=Math.max(3,bounds.radius);
 orbit.target.fromArray(center);
 camera.position.fromArray(center).add(new THREE.Vector3(
   radius*1.9,radius*1.4,radius*2.7));
 camera.near=.05;
 camera.far=Math.max(1500,radius*100);
 camera.updateProjectionMatrix();
 orbit.update();
 return radius;
}

// Helpers are never attached to the primitive-world root. This keeps them
// present in the editor only, not in exported GLB or After Effects packages.
export function createPrototypeGuides(scene){
 // Solid modeling ground, never part of the saved or exported assembly.
 const floor=new THREE.Mesh(new THREE.PlaneGeometry(20,20),
   new THREE.MeshBasicMaterial({color:0x1b3541,side:THREE.DoubleSide}));
 floor.name='Prototype studio floor (editor only)';
 floor.rotation.x=-Math.PI/2;
 floor.renderOrder=-2;
 scene.add(floor);
 const grid=new THREE.GridHelper(20,20,0x79a8b5,0x496e7e);
 grid.name='Prototype ground grid (editor only)';
 grid.material.transparent=true;grid.material.opacity=.72;
 grid.material.depthWrite=false;grid.renderOrder=-1;
 scene.add(grid);
 const axes=new THREE.AxesHelper(2);
 axes.name='Prototype XYZ axes (editor only)';
 scene.add(axes);
 return {floor,grid,axes};
}

// Modeling worklights are never authored. Keep the prototype readable even
// when the source chapter deliberately disables studio/environment lighting.
export function createPrototypeStudioLights(scene){
 const group=new THREE.Group();
 group.name='Prototype studio worklights (editor only)';
 const ambient=new THREE.AmbientLight(0xe9f5ff,1.3);
 const hemisphere=new THREE.HemisphereLight(0xdff0ff,0x52748a,2.1);
 const key=new THREE.DirectionalLight(0xffffff,4.6);
 key.name='Studio key';key.position.set(8,15,12);
 const fill=new THREE.DirectionalLight(0xd5e7ff,2.8);
 fill.name='Studio side fill';fill.position.set(-10,7,5);
 const rim=new THREE.DirectionalLight(0xffdfbb,3.0);
 rim.name='Studio back rim';rim.position.set(2,9,-12);
 group.add(ambient,hemisphere,key,fill,rim);
 scene.add(group);
 return group;
}

export function setupArrayPrototypeEditor({getDocument,getShotIds,onSave,onClose=()=>{}}){
 const byId=id=>document.getElementById(id);
 const modal=byId('arrayEditModal');
 const canvas=byId('arrayEditCanvas');
 const category=byId('arrayEditCategory'),preset=byId('arrayEditPreset');
 const outliner=byId('arrayEditOutliner');
 const fields=byId('arrayEditProperties');
 const info=byId('arrayEditInfo'),status=byId('arrayEditStatus');
 if(!modal||!canvas||!fields||!category||!preset||!outliner)
   return {open(){return false;},close(){}};

 const scene=new THREE.Scene();
 scene.background=new THREE.Color(0x10212c);
 const {floor,grid,axes}=createPrototypeGuides(scene);
 const worklights=createPrototypeStudioLights(scene);
 const camera=new THREE.PerspectiveCamera(46,1,.1,2000);
 camera.position.set(9,7,13);
 // Avoid allocating a second WebGL context during normal page startup.
 // It is needed only after a user confirms opening the mini editor.
 let renderer=null;
 function ensureRenderer(){
   if(renderer)return;
   renderer=new THREE.WebGLRenderer({canvas,antialias:true});
   renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
   renderer.outputColorSpace=THREE.SRGBColorSpace;
   renderer.shadowMap.enabled=true;
   renderer.shadowMap.type=THREE.PCFSoftShadowMap;
 }
 const orbit=new OrbitControls(camera,canvas);
 orbit.enableDamping=true;orbit.minDistance=.5;orbit.maxDistance=300;
 const transform=new TransformControls(camera,canvas);
 const helper=typeof transform.getHelper==='function'?transform.getHelper():transform;
 scene.add(helper);
 transform.setSpace('world');transform.enabled=false;
 let operation='translate',dragging=false;
 const world=createPrimitiveWorld(scene);
 let draft=null,source=null,shotId=null,objectId=null,linked=[],candidates=[],selected='root',frame=0;
 let spotMode='real',initialSpotMode='real';
 const spotModeSelect=byId('arrayEditSpotMode');
 let previewEffects=structuredClone(DEFAULT_EFFECTS);
 spotModeSelect?.addEventListener('change',()=>{
   if(!draft||!['real','fake','hybrid'].includes(spotModeSelect.value))return;
   spotMode=spotModeSelect.value;
   previewEffects.lights.spotMode=spotMode;
   rerender();
 });
 let sourceTemplates=[],beforeTemplate=null,hoverOutlines=[];
 const originalRoot=()=>source?.scenes?.find(s=>s.shotId===shotId)?.objects.find(o=>o.id===objectId);
 const pose=()=>{
   const old=originalRoot();
   const center=new THREE.Vector3(...draft.base.position).sub(new THREE.Vector3(...old.position));
   const angles=draft.base.rotation.map((n,i)=>n-old.rotation[i]);
   const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(...angles));
   return {center,q};
 };
 const asWorldPosition=(p,t)=>new THREE.Vector3(...p).applyQuaternion(t.q).add(t.center).toArray();
 const asLocalPosition=(p,t)=>new THREE.Vector3(...p).sub(t.center).applyQuaternion(t.q.clone().invert()).toArray();
 const asWorldRotation=(p,t)=>new THREE.Euler().setFromQuaternion(
   t.q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...p)))).toArray().slice(0,3);
 const asLocalRotation=(p,t)=>new THREE.Euler().setFromQuaternion(
   t.q.clone().invert().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...p)))).toArray().slice(0,3);
 function uniquePartId(base='copy'){
   const used=new Set([objectId,...draft.parts.objects.map(o=>o.id),...draft.parts.lights.map(l=>l.id)]);
   const prefix=('part_'+base).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,55);
   let id=prefix,n=2;
   while(used.has(id))id=prefix+'_'+n++;
   return id;
 }
 function previewItem(item,kind,t){
   const copy=structuredClone(item);
   copy.position=asWorldPosition(item.position,t);
   if(kind==='object')copy.rotation=asWorldRotation(item.rotation,t);
   else if(item.target)copy.target=asWorldPosition(item.target,t);
   return copy;
 }
 function partNode(key){
   const parent=world.getObjectNode(sampleShot,objectId);
   if(!parent)return null;
   if(key==='root')return parent;
   const id=key.slice(key.indexOf(':')+1);
   let found=null;
   parent.traverse(node=>{
     if(!found&&node.userData.primitiveArrayPartId===id&&
       (key.startsWith('object:')?node.isMesh:node.isLight))found=node;
   });
   return found;
 }
 function attachSelected(){
   transform.detach();
   if(!draft)return;
   const node=selected==='root'&&operation==='rotate'?
     partNode('root')?.children.find(child=>child.userData.primitiveId===objectId):
     partNode(selected);
   if(!node)return;
   if(selected.startsWith('light:')&&operation==='rotate')setMode('translate');
   transform.attach(node);
 }
 function setMode(mode){
   if(!['translate','rotate'].includes(mode))return;
   if(mode==='rotate'&&selected.startsWith('light:'))return;
   operation=mode;transform.setMode(mode);
   transform.setSpace(mode==='translate'?'world':'local');
   if(draft)attachSelected();
   for(const [id,value] of [['arrayEditMove','translate'],['arrayEditRotate','rotate']]){
     const button=byId(id);if(!button)continue;
     button.setAttribute('aria-pressed',String(mode===value));
     button.classList.toggle('active',mode===value);
     button.disabled=value==='rotate'&&selected.startsWith('light:');
   }
 }
 byId('arrayEditMove')?.addEventListener('click',()=>setMode('translate'));
 byId('arrayEditRotate')?.addEventListener('click',()=>setMode('rotate'));
 const setStatus=value=>{if(status)status.textContent=value;};
 function rootItem(){
   if(!draft)return null;
   const old=originalRoot();
   return {...draft.base,id:objectId,
     position:draft.base.position.map((n,i)=>n-old.position[i]),
     rotation:draft.base.rotation.map((n,i)=>n-old.rotation[i]),
     repeat:undefined,arrayParts:undefined};
 }
 function previewDocument(){
   if(!draft)return null;
   // Preview and export the exact same group hierarchy.
   const base=rootItem();
   delete base.repeat;
   base.arrayParts=structuredClone(draft.parts);
   return {schemaVersion:1,scenes:[{shotId:sampleShot,objects:[base]}]};
 }
 function addPreviewLightHandles(){
   const node=partNode('root');
   node?.traverse(item=>{
     if(!item.isLight||!item.userData.primitiveArrayPartId)return;
     const bulb=new THREE.Mesh(new THREE.SphereGeometry(.13,10,8),
       new THREE.MeshBasicMaterial({color:item.color,depthTest:false,depthWrite:false}));
     bulb.name='Outliner light handle';
     bulb.userData.primitiveArrayPartId=item.userData.primitiveArrayPartId;
     bulb.userData.primitiveId=objectId;
     item.add(bulb);
   });
 }
 function rerender({refit=false}={}){
   if(!draft)return;
   try{
     const doc=previewDocument();
     clearOutlinerHighlight();transform.detach();
     world.setDocument(doc,[sampleShot]);world.showShot(sampleShot);
     addPreviewLightHandles();
     if(refit){
       const bounds=world.getBounds(sampleShot);
       const radius=framePrototypeCamera(camera,orbit,bounds);
       const body=world.getObjectNode(sampleShot,objectId);
       const box=body?new THREE.Box3().setFromObject(body):null;
       const at=box&&!box.isEmpty()?box.getCenter(new THREE.Vector3()):
         new THREE.Vector3().fromArray(bounds.center);
       const floorY=box&&!box.isEmpty()?box.min.y-.035:at.y-radius;
       grid.position.set(at.x,floorY+.004,at.z);
       floor.position.set(at.x,floorY-.008,at.z);
       // Grid divisions track the object's dimensions without obstructing it.
       const stageScale=Math.max(.5,Math.min(50,radius*4/20));
       grid.scale.setScalar(stageScale);
       floor.scale.set(stageScale,stageScale,1);
       axes.position.copy(grid.position);
       axes.scale.setScalar(Math.max(.3,Math.min(12,radius*.27)));
     }
     attachSelected();
     setStatus('Changes are temporary until Save. W to move / E to rotate.');
     return true;
   }catch(error){
     setStatus('Preview: '+error.message);
     return false;
   }
 }
 function stop(){
   if(frame)cancelAnimationFrame(frame);
   frame=0;
 }
 function animate(){
   if(!draft||!renderer)return;
   const width=canvas.clientWidth||500,height=canvas.clientHeight||320;
   if(canvas.width!==Math.round(width*renderer.getPixelRatio())||
     canvas.height!==Math.round(height*renderer.getPixelRatio())){
     renderer.setSize(width,height,false);
     camera.aspect=width/height;camera.updateProjectionMatrix();
   }
   orbit.update();
   world.updateLightVisuals(camera,canvas.clientHeight||320);
   applyShotEffects(scene,renderer,previewEffects,{camera,shotId:sampleShot});
   // Do not let the final chapter's studio-light checkbox darken the editor.
   for(const light of worklights.children)light.visible=true;
   renderer.render(scene,camera);
   frame=requestAnimationFrame(animate);
 }
 function makeEl(tag,text='',attributes={}){
   const node=document.createElement(tag);
   if(text)node.textContent=text;
   for(const [key,value] of Object.entries(attributes))node.setAttribute(key,value);
   return node;
 }
 function selectOptions(select,options){
   select.replaceChildren();
   for(const [value,text] of options){
     const option=makeEl('option',text);option.value=value;select.append(option);
   }
 }
 function updatePresets(){
   const cat=CREATE_CATEGORIES.find(c=>c.id===category.value)||CREATE_CATEGORIES[0];
   selectOptions(preset,cat.items);
 }
 selectOptions(category,CREATE_CATEGORIES.map(c=>[c.id,c.label]));
 category.value='primitives';updatePresets();
 category.addEventListener('change',updatePresets);
 function itemRef(){
   if(!draft)return null;
   if(selected==='root')return {kind:'base',value:draft.base};
   const [kind,id]=selected.split(':');
   return {kind,value:(kind==='light'?draft.parts.lights:draft.parts.objects)
     .find(x=>x.id===id)};
 }
 function property(label,value,onChange,{type='number',step='0.01',min=null,max=null}={}){
   const wrap=makeEl('label',label,{class:'array-property'});
   const input=makeEl('input');
   const degrees=type==='degrees',number=type==='number'||degrees;
   input.type=degrees?'number':type;
   if(type==='color')input.value=value;
   else if(type==='text')input.value=String(value??'');
   else if(type==='checkbox')input.checked=!!value;
   else{
     input.step=degrees?'0.01':step;
     input.value=displayHundredth(degrees?radiansToDegrees(value??0):(value??0));
     if(min!=null)input.min=degrees?radiansToDegrees(min):min;
     if(max!=null)input.max=degrees?radiansToDegrees(max):max;
   }
   input.addEventListener('change',()=>{
     let v=type==='checkbox'?input.checked:number?finite(input.value):input.value;
     if(v===null){setStatus('Enter a finite number.');return;}
     if(degrees)v=degreesToRadians(v);
     if(number&&((min!=null&&v<min-1e-10)||(max!=null&&v>max+1e-10))){
       setStatus('Value outside the allowed range.');return;
     }
     try{onChange(v);rerender();}
     catch(error){setStatus(error.message);}
   });
   wrap.append(input);fields.append(wrap);
 }
 function xyz(label,vector,onChange,{degrees=false}={}){
   const line=makeEl('div','',{class:'array-xyz'});
   line.append(makeEl('div',label,{class:'array-xyz-title'}));
   const cells=makeEl('div','',{class:'array-xyz-grid'});
   for(let i=0;i<3;i++){
     const field=makeEl('label',['X','Y','Z'][i]);
     const input=makeEl('input');input.type='number';input.step='.01';
     input.value=displayHundredth(degrees?radiansToDegrees(vector[i]):vector[i]);
     input.addEventListener('change',()=>{
       const v=finite(input.value);
       if(v===null){setStatus('Enter a finite XYZ value.');return;}
       const result=[...vector];result[i]=degrees?degreesToRadians(v):v;
       onChange(result);refreshFields();rerender();
     });
     field.append(input);cells.append(field);
   }
   line.append(cells);fields.append(line);
 }
 function refreshFields(){
   fields.replaceChildren();
   const current=itemRef(),item=current?.value;
   if(!item)return;
   const root=current.kind==='base',isLight=current.kind==='light';
   fields.append(makeEl('h3',isLight?'Light settings':root?'Assembly parent':'Component settings'));
   property('Name',item.name,v=>{item.name=v;refreshList();},{type:'text'});
   if(!isLight){
     if(root){
       fields.append(makeEl('p','Rotation of each copy turns the objects in place; it does not change their array positions or spacing. Layout direction is a separate advanced adjustment.'));
       xyz('Array center XYZ (scene)',item.position,v=>item.position=v);
       xyz('Rotation of each copy (°)',item.instanceRotation||[0,0,0],
         v=>item.instanceRotation=v,{degrees:true});
       if(item.repeat)xyz('Array layout direction (°) · changes row positions',
         item.rotation,v=>item.rotation=v,{degrees:true});
     }
     if(!root)xyz('Dimensions',item.scale,v=>item.scale=v);
     if(!root){
       xyz('Local XYZ',item.position,v=>item.position=v);
       xyz('Local rotation (°)',item.rotation,v=>item.rotation=v,{degrees:true});
     }
     if(!root){
       property('Material color',item.material.color,v=>item.material.color=v,{type:'color'});
       property('Metalness',item.material.metalness,v=>item.material.metalness=v,{min:0,max:1});
       property('Roughness',item.material.roughness,v=>item.material.roughness=v,{min:0,max:1});
       property('Glow color',item.material.emissive||'#000000',v=>{
         item.material.emissive=v;item.material.emissiveIntensity??=1;
       },{type:'color'});
       property('Glow strength',item.material.emissiveIntensity||0,v=>{
         item.material.emissiveIntensity=v;item.material.emissive??='#000000';
       },{min:0,max:10});
     }
   }else{
     const lightTypes=['point','spot','directional'];
     const select=makeEl('select');
     selectOptions(select,lightTypes.map(v=>[v,v]));
     select.value=item.type;
     select.addEventListener('change',()=>{
       item.type=select.value;
       if(item.type!=='point')item.target??=[0,0,0];
       else delete item.target;
       if(item.type==='directional'){delete item.distance;delete item.angle;delete item.penumbra;}
       else{item.distance??=28;
         if(item.type==='spot'){item.angle??=.6;item.penumbra??=.3;}
         else{delete item.angle;delete item.penumbra;}}
       refreshFields();rerender();
     });
     const typeField=makeEl('label','Light type',{class:'array-property'});
     typeField.append(select);fields.append(typeField);
     property('Light color',item.color,v=>item.color=v,{type:'color'});
     property('Intensity',item.intensity,v=>item.intensity=v,{min:0,max:item.type==='directional'?10:500});
     property('Cast shadows',lightCastsShadow(item),v=>item.castShadow=v,{type:'checkbox'});
     fields.append(makeEl('p','Turning shadows off keeps the light on. This setting applies to all copies; up to 4 lights cast shadows per chapter.'));
     xyz('Source XYZ',item.position,v=>item.position=v);
     if(item.type!=='point')xyz('Aim XYZ',item.target,v=>item.target=v);
     if(item.type!=='directional')property('Range',item.distance||0,v=>item.distance=v,{min:0,max:1000});
     if(item.type==='spot'){
       property('Cone angle (°)',item.angle,v=>item.angle=v,
         {type:'degrees',min:.05,max:1.5});
       property('Penumbra',item.penumbra,v=>item.penumbra=v,{min:0,max:1});
     }
   }
   const deleteButton=byId('arrayEditDeletePart');
   if(deleteButton)deleteButton.disabled=root;
   const duplicateButton=byId('arrayEditDuplicatePart');
   if(duplicateButton)duplicateButton.disabled=root;
 }
 function orderedKeys(){
   const actual=[...draft.parts.objects.map(x=>'object:'+x.id),
     ...draft.parts.lights.map(x=>'light:'+x.id)];
   const valid=new Set(actual);
   return [...new Set([...(draft.parts.order||[]).filter(key=>valid.has(key)),
     ...actual])];
 }
 function itemForKey(key){
   if(key==='root')return draft.base;
   const [kind,id]=key.split(':');
   return (kind==='light'?draft.parts.lights:draft.parts.objects)
     .find(x=>x.id===id);
 }
 function reorderChild(key,before){
   if(key==='root'||before==='root'||key===before)return;
   const order=[...orderedKeys()],from=order.indexOf(key),to=order.indexOf(before);
   if(from<0||to<0)return;
   order.splice(from,1);order.splice(to,0,key);
   draft.parts.order=order;
   refreshList();rerender();
 }
 function clearOutlinerHighlight(){
   for(const outline of hoverOutlines){
     outline.removeFromParent();outline.geometry.dispose();outline.material.dispose();
   }
   hoverOutlines=[];
 }
 function highlightOutliner(key){
   clearOutlinerHighlight();
   const node=partNode(key);
   if(!node)return;
   node.traverse(mesh=>{
     if(!mesh.isMesh||!mesh.geometry||mesh.name==='Outliner light handle')return;
     const outline=new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry),
       new THREE.LineBasicMaterial({color:0xffd276,depthTest:false,depthWrite:false}));
     outline.renderOrder=1005;mesh.add(outline);hoverOutlines.push(outline);
   });
   if(node.isLight){
     const marker=node.children.find(mesh=>mesh.name==='Outliner light handle');
     if(marker){
       const outline=new THREE.LineSegments(new THREE.EdgesGeometry(marker.geometry),
         new THREE.LineBasicMaterial({color:0xffd276,depthTest:false,depthWrite:false}));
       outline.renderOrder=1005;marker.add(outline);hoverOutlines.push(outline);
     }
   }
 }
 function refreshList(){
   if(!draft)return;
   if(selected!=='root'&&!itemForKey(selected))selected='root';
   outliner.replaceChildren();
   const makeRow=(key,depth=0)=>{
     const item=itemForKey(key),root=key==='root',light=key.startsWith('light:');
     if(!item)return;
     const row=makeEl('div','',{class:'array-outliner-row'});
     row.setAttribute('role','treeitem');
     row.setAttribute('aria-selected',String(key===selected));
     row.style.paddingLeft=(8+depth*20)+'px';
     row.dataset.nodeKey=key;
     const pick=makeEl('button',(root?'▾ ◇':light?'☀':'▱'),{class:'array-node-pick'});
     pick.type='button';pick.title='Select '+item.name;
     pick.addEventListener('click',()=>{
       selected=key;refreshList();rerender();
     });
     const name=makeEl('input');name.type='text';name.maxLength=100;
     name.value=item.name;name.title='Rename this node';
     name.setAttribute('aria-label','Rename '+item.name);
     name.addEventListener('focus',()=>{
       selected=key;attachSelected();refreshFields();
       outliner.querySelectorAll('.array-outliner-row').forEach(line=>
         line.setAttribute('aria-selected',String(line.dataset.nodeKey===key)));
     });
     name.addEventListener('change',()=>{
       item.name=name.value.trim()||item.name;
       name.value=item.name;rerender();
     });
     row.addEventListener('mouseenter',()=>highlightOutliner(key));
     row.addEventListener('mouseleave',clearOutlinerHighlight);
     row.append(pick,name);
     if(!root){
       const keys=orderedKeys(),index=keys.indexOf(key);
       for(const [symbol,step] of [['↑',-1],['↓',1]]){
         const button=makeEl('button',symbol,{class:'array-node-order'});
         button.type='button';button.title=step<0?'Move up':'Move down';
         button.disabled=index+step<0||index+step>=keys.length;
         button.addEventListener('click',()=>reorderChild(key,keys[index+step]));
         row.append(button);
       }
       row.draggable=true;
       row.addEventListener('dragstart',event=>{
         event.dataTransfer?.setData('text/plain',key);
         if(event.dataTransfer)event.dataTransfer.effectAllowed='move';
       });
       row.addEventListener('dragover',event=>event.preventDefault());
       row.addEventListener('drop',event=>{
         event.preventDefault();
         const from=event.dataTransfer?.getData('text/plain');
         if(from)reorderChild(from,key);
       });
     }
     outliner.append(row);
   };
   makeRow('root');
   for(const key of orderedKeys())makeRow(key,1);
   refreshFields();attachSelected();setMode(operation);
 }
 function includeCompanion(companion){
   if(draft.absorbed.has(companion.id))return;
   const part=structuredClone(companion.part);
   part.id=uniquePartId(companion.id);
   draft.parts.objects.push(part);
   draft.absorbed.set(companion.id,{ids:[...companion.ids],partId:part.id});
 }
 function excludeCompanion(companion){
   const original=draft.absorbed.get(companion.id);
   if(!original)return;
   draft.parts.objects=draft.parts.objects.filter(p=>p.id!==original.partId);
   draft.absorbed.delete(companion.id);
   if(selected==='object:'+original.partId)selected='root';
 }
 function updateAssemblySummary(){
   if(!draft||!info)return;
   const copies=linked.reduce((sum,key)=>{
     const row=source.scenes.find(s=>s.shotId===shotId).objects.find(o=>o.id===key);
     return sum+repeatOffsets(row?.repeat).length;
   },0);
   const included=draft.absorbed.size;
   info.textContent=copies+' instance(s) · '+linked.length+' source group(s) · '+
     (draft.templatePlan?'Template replacement staged · ':included+' companion array(s) · ')+
     'Only Save writes the assembled copies.';
 }
 function renderCompanions(){
   const holder=byId('arrayEditCompanions');
   if(!holder)return;
   holder.replaceChildren();
   if(!candidates.length){
     holder.append(makeEl('p','No other arrays with safely aligned repeat positions were found.'));
     return;
   }
   for(const companion of candidates){
     const line=makeEl('label','',{class:'array-companion'});
     const check=makeEl('input');check.type='checkbox';
     check.checked=draft.absorbed.has(companion.id);
     const count=companion.ids.reduce((n,id)=>{
       const row=source.scenes.find(s=>s.shotId===shotId).objects.find(o=>o.id===id);
       return n+repeatOffsets(row.repeat).length;
     },0);
     const label=makeEl('span',(companion.nameMatch?'Named assembly · ':'Nearby array · ')+
       companion.name+' · '+count+' copies');
     line.append(check,label);
     check.addEventListener('change',()=>{
       if(check.checked){
         includeCompanion(companion);
         selected='object:'+draft.absorbed.get(companion.id).partId;
       }else excludeCompanion(companion);
       updateAssemblySummary();refreshList();rerender({refit:true});
     });
     holder.append(line);
   }
 }

 // Clicking a prototype mesh or light selects the same editable fields as the
 // component dropdown. A drag remains an orbit operation, not selection.
 const picker=new THREE.Raycaster(),mouse=new THREE.Vector2();
 let pointerStart=null;
 canvas.addEventListener('pointerdown',event=>{
   if(event.button===0&&!transform.axis)pointerStart={x:event.clientX,y:event.clientY};
   else pointerStart=null;
 });
 canvas.addEventListener('pointerup',event=>{
   if(!draft||event.button!==0||!pointerStart||dragging||transform.dragging)return;
   const start=pointerStart;pointerStart=null;
   if(Math.hypot(event.clientX-start.x,event.clientY-start.y)>5)return;
   const rect=canvas.getBoundingClientRect();
   mouse.set(2*(event.clientX-rect.left)/rect.width-1,
     1-2*(event.clientY-rect.top)/rect.height);
   picker.setFromCamera(mouse,camera);
   const hit=picker.intersectObjects(world.getPickableMeshes(sampleShot),false)[0]?.object;
   const component=hit?.userData?.primitiveArrayPartId;
   const partId=component?(hit.name==='Outliner light handle'?'light:':'object:')+component:
     hit?.userData?.primitiveId===objectId?'root':null;
   if(!partId)return;
   selected=partId;refreshList();
 });
 canvas.addEventListener('pointercancel',()=>{pointerStart=null;});
 function commitGizmo(){
   if(!draft||!transform.object)return;
   const node=transform.object,current=itemRef();
   if(!current?.value)return;
   const original=originalRoot(),item=current.value;
   if(current.kind==='base'){
     draft.base.position=node.position.toArray().map((n,i)=>n+original.position[i]);
     if(operation==='rotate'){
       draft.base.instanceRotation=[node.rotation.x,node.rotation.y,node.rotation.z];
     }else{
       draft.base.rotation=[node.rotation.x,node.rotation.y,node.rotation.z]
         .map((n,i)=>n+original.rotation[i]);
     }
   }else if(current.kind==='light'){
     // Child nodes already live in the assembly's local coordinate frame.
     item.position=node.position.toArray();
   }else{
     item.position=node.position.toArray();
     item.rotation=[node.rotation.x,node.rotation.y,node.rotation.z];
   }
   refreshFields();rerender();
 }
 transform.addEventListener('mouseDown',()=>{
   if(!draft)return;dragging=true;orbit.enabled=false;pointerStart=null;
 });
 transform.addEventListener('mouseUp',()=>{
   if(!draft)return;
   orbit.enabled=true;
   if(dragging){dragging=false;commitGizmo();}
 });
 transform.addEventListener('objectChange',()=>{
   if(draft){
     world.updateLightVisuals(camera,canvas.clientHeight||320);
     world.invalidateGeometry(sampleShot);
   }
 });
 byId('arrayEditAdd')?.addEventListener('click',()=>{
   if(!draft)return;
   try{
     const old=previewDocument();
     const created=insertCreatedAsset(old,sampleShot,category.value,preset.value,pose().center.toArray());
     const oldScene=old.scenes[0],nextScene=created.document.scenes[0],t=pose();
     const existingObjects=new Set(oldScene.objects.map(o=>o.id));
     const existingLights=new Set((oldScene.lights||[]).map(l=>l.id));
     let lastKey=null;
     const addShape=obj=>{
       const piece=structuredClone(obj);
       delete piece.repeat;delete piece.arrayParts;delete piece.layer;
       piece.id=uniquePartId(piece.id);
       piece.position=asLocalPosition(obj.position,t);
       piece.rotation=asLocalRotation(obj.rotation,t);
       draft.parts.objects.push(piece);lastKey='object:'+piece.id;
     };
     const addLight=light=>{
       const piece=structuredClone(light);
       piece.id=uniquePartId(piece.id);
       piece.position=asLocalPosition(light.position,t);
       if(light.target)piece.target=asLocalPosition(light.target,t);
       draft.parts.lights.push(piece);lastKey='light:'+piece.id;
     };
     for(const obj of nextScene.objects.filter(o=>!existingObjects.has(o.id))){
       if(obj.primitive!=='group'){addShape(obj);continue;}
       const quat=new THREE.Quaternion().setFromEuler(new THREE.Euler(...obj.rotation));
       const worldPoint=point=>new THREE.Vector3(...point).applyQuaternion(quat)
         .add(new THREE.Vector3(...obj.position)).toArray();
       const worldRotation=angles=>new THREE.Euler().setFromQuaternion(
         quat.clone().multiply(new THREE.Quaternion().setFromEuler(
           new THREE.Euler(...angles)))).toArray().slice(0,3);
       for(const child of obj.arrayParts?.objects||[])
         addShape({...child,position:worldPoint(child.position),
           rotation:worldRotation(child.rotation)});
       for(const child of obj.arrayParts?.lights||[])
         addLight({...child,position:worldPoint(child.position),
           ...(child.target?{target:worldPoint(child.target)}:{})});
     }
     for(const light of (nextScene.lights||[]).filter(l=>!existingLights.has(l.id)))
       addLight(light);
     if(lastKey)selected=lastKey;
     refreshList();rerender({refit:true});
   }catch(error){setStatus('Cannot add component: '+error.message);}
 });
 function duplicatePart(){
   if(!draft)return;
   const current=itemRef();if(!current?.value)return;
   const root=current.kind==='base';
   if(root){setStatus('Choose a child mesh or light to duplicate.');return;}
   const copy=structuredClone(current.value);
   copy.id=uniquePartId(copy.id);
   copy.name=(copy.name+' copy').slice(0,100);
   copy.position=[copy.position[0]+.9,copy.position[1],copy.position[2]];
   if(current.kind==='light'){
     if(copy.target)copy.target=[copy.target[0]+.9,copy.target[1],copy.target[2]];
     draft.parts.lights.push(copy);
     selected='light:'+copy.id;
   }else{
     draft.parts.objects.push(copy);
     selected='object:'+copy.id;
   }
   refreshList();rerender({refit:true});
 }
 byId('arrayEditDuplicatePart')?.addEventListener('click',duplicatePart);
 const templateSelect=byId('arrayEditTemplate');
 const useTemplate=byId('arrayEditUseTemplate');
 const templateStatus=byId('arrayEditTemplateStatus');
 const undoTemplate=byId('arrayEditUndoTemplate');
 const updateTemplateStatus=(message,error=false)=>{
   if(templateStatus){
     templateStatus.textContent=message;
     templateStatus.classList.toggle('error',error);
   }
   if(error)setStatus(message);
 };
 function undoReplacement(){
   if(!beforeTemplate)return;
   draft=beforeTemplate.draft;candidates=beforeTemplate.candidates;
   beforeTemplate=null;
   if(undoTemplate)undoTemplate.hidden=true;
   renderCompanions();refreshList();updateAssemblySummary();rerender({refit:true});
   updateTemplateStatus('Replacement preview discarded; original assembly restored.');
 }
 undoTemplate?.addEventListener('click',undoReplacement);
 function replaceContents(){
   if(!draft)return;
   const template=resolveAssemblyTemplateSelection(sourceTemplates,templateSelect?.value);
   if(!template){updateTemplateStatus('Choose a source assembly first.',true);return;}
   const backup={draft:structuredClone(draft),candidates:[...candidates]};
   try{
     const change=replaceAssemblyContents(source,getShotIds(),shotId,objectId,template.id);
     const staged=change.document;
     const root=staged.scenes.find(sc=>sc.shotId===shotId)
       ?.objects.find(obj=>obj.id===objectId);
     if(!root||root.primitive!=='group')throw Error('Replacement did not produce a group parent');
     const preview={base:structuredClone(root),
       parts:structuredClone(root.arrayParts),absorbed:new Map(),
       templatePlan:{document:staged}};
     draft=preview;candidates=[];selected='root';
     if(!rerender({refit:true}))throw Error('The new assembly could not be drawn');
     if(!beforeTemplate)beforeTemplate=backup;
     if(undoTemplate)undoTemplate.hidden=false;
     renderCompanions();refreshList();updateAssemblySummary();
     updateTemplateStatus('Previewing '+change.componentCount+' copied mesh/light nodes from '+
       template.label+'. Parent XYZ, rotation and copy spacing unchanged. Save or Undo.');
     setStatus('Replacement is staged locally; Save commits or Cancel discards everything.');
     outliner.scrollIntoView?.({block:'nearest'});
   }catch(error){
     draft=backup.draft;candidates=backup.candidates;
     renderCompanions();refreshList();updateAssemblySummary();rerender({refit:true});
     updateTemplateStatus('Cannot replace assembly: '+error.message,true);
   }
 }
 useTemplate?.addEventListener('click',replaceContents);
 templateSelect?.addEventListener('change',()=>{
   const template=sourceTemplates.find(x=>x.id===templateSelect.value);
   if(useTemplate)useTemplate.disabled=!template;
   updateTemplateStatus(template?
     'Ready to copy '+template.parts.length+' mesh(es) and '+template.lights.length+
       ' light(s) from '+template.label+'.':'Choose a source assembly.');
 });
 canvas.addEventListener('pointermove',event=>{
   if(!draft||transform.dragging)return;
   const rect=canvas.getBoundingClientRect();
   mouse.set(2*(event.clientX-rect.left)/rect.width-1,
     1-2*(event.clientY-rect.top)/rect.height);
   picker.setFromCamera(mouse,camera);
   const hit=picker.intersectObjects(world.getPickableMeshes(sampleShot),false)[0]?.object;
   const childId=hit?.userData?.primitiveArrayPartId;
   const key=childId?
     (hit.name==='Outliner light handle'?'light:':'object:')+childId:null;
   if(key)highlightOutliner(key);
   else clearOutlinerHighlight();
 });
 canvas.addEventListener('pointerleave',clearOutlinerHighlight);
 byId('arrayEditDeletePart')?.addEventListener('click',()=>{
   if(!draft||selected==='root')return;
   const [kind,id]=selected.split(':');
   const paired=candidates.find(c=>draft.absorbed.get(c.id)?.partId===id);
   if(paired){
     // Removing an imported companion from the prototype must not silently
     // destroy its original array on Save. Unlink it instead.
     excludeCompanion(paired);
     renderCompanions();updateAssemblySummary();
     setStatus('Unlinked '+paired.name+'. Its original array remains intact.');
   }else{
     const list=kind==='light'?draft.parts.lights:draft.parts.objects;
     const index=list.findIndex(x=>x.id===id);
     if(index!==-1)list.splice(index,1);
   }
   draft.parts.order=orderedKeys().filter(key=>!!itemForKey(key));
   selected='root';refreshList();rerender();
 });
 function close(){
   clearOutlinerHighlight();beforeTemplate=null;
   if(undoTemplate)undoTemplate.hidden=true;
   stop();transform.detach();transform.enabled=false;dragging=false;
   orbit.enabled=true;
   draft=null;source=null;shotId=null;objectId=null;linked=[];candidates=[];
   modal.hidden=true;world.setDocument({schemaVersion:1,scenes:[]},[]);
   onClose();
 }
 byId('arrayEditCancel')?.addEventListener('click',close);
 byId('arrayEditSave')?.addEventListener('click',()=>{
   if(!draft)return;
   try{
     draft.parts.order=orderedKeys().filter(key=>!!itemForKey(key));
     const document=saveAssemblyHierarchy(
       draft.templatePlan?.document||source,getShotIds(),shotId,objectId,
       {base:draft.base,parts:draft.parts},linked,
       draft.templatePlan?[]:[...draft.absorbed.values()].flatMap(x=>x.ids));
     if(spotMode!==initialSpotMode){
       const entry=document.scenes.find(scene=>scene.shotId===shotId);
       if(!entry)throw Error('The source chapter is missing');
       const profile=validateSceneEffects(entry.effects)||structuredClone(DEFAULT_EFFECTS);
       profile.lights.spotMode=spotMode;
       entry.effects=validateSceneEffects(profile);
     }
     onSave(validatePrimitiveDocument(document,getShotIds()));
     close();
   }catch(error){setStatus('Save blocked: '+error.message);}
 });
 modal.addEventListener('keydown',event=>{
   // While editing an isolated prototype, W/E/L/Delete, timeline shortcuts
   // and the Create wheel must never mutate the underlying live chapter.
   event.stopPropagation();
   if(event.key==='Escape'){event.preventDefault();close();return;}
   if(event.target?.closest?.('input,textarea,select,[contenteditable]'))return;
   if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='d'){
     event.preventDefault();duplicatePart();
   }else if(event.key.toLowerCase()==='w')setMode('translate');
   else if(event.key.toLowerCase()==='e')setMode('rotate');
 });
 return {
   open(id,partId){
     if(draft)return false;
     try{ensureRenderer();}
     catch(error){setStatus('3D prototype preview unavailable: '+error.message);return false;}
     const doc=getDocument(),shot=getShotIds().find(s=>s===id);
     if(!shot)return false;
     const scene=doc?.scenes?.find(s=>s.shotId===id);
     const base=scene?.objects?.find(o=>o.id===partId&&(o.repeat||o.arrayParts));
     if(!base)return false;
     const matches=base.repeat?findMatchingArrays(doc,id,partId):[partId];
     const converted=editableAssembly(base);
     draft={...converted,absorbed:new Map()};
     source=structuredClone(doc);shotId=id;objectId=partId;linked=matches;
     previewEffects=validateSceneEffects(scene.effects)||structuredClone(DEFAULT_EFFECTS);
     spotMode=initialSpotMode=previewEffects.lights.spotMode;
     if(spotModeSelect)spotModeSelect.value=spotMode;
     candidates=base.repeat?findArrayCompanions(doc,id,partId):[];
     sourceTemplates=listAssemblyTemplates(doc,id).filter(t=>t.id!==partId);
     selectOptions(templateSelect||makeEl('select'),
       [['','Choose an assembly…'],...sourceTemplates.map(t=>[t.id,t.label])]);
     if(templateSelect)templateSelect.value=sourceTemplates[0]?.id||'';
     if(useTemplate)useTemplate.disabled=!sourceTemplates.length;
     updateTemplateStatus(sourceTemplates.length?
       'Ready to copy '+sourceTemplates[0].parts.length+' mesh(es) and '+
       sourceTemplates[0].lights.length+' light(s) from '+sourceTemplates[0].label+'.':
       'No source assembly available in this chapter.');
     beforeTemplate=null;if(undoTemplate)undoTemplate.hidden=true;
     selected='root';dragging=false;transform.enabled=true;setMode('translate');
     for(const candidate of candidates.filter(candidate=>candidate.nameMatch))
       includeCompanion(candidate);
     const group=arrayGroupKey(base.name);
     const title=byId('arrayEditTitle');
     if(title)title.textContent=!base.repeat?'Edit grouped object':group?
       'Edit '+base.name.trim().split(/\s+/).slice(0,2).join(' ')+' assembly':
       'Edit one object, update the array';
     modal.hidden=false;modal.tabIndex=-1;modal.focus();
     updateAssemblySummary();renderCompanions();
     refreshList();rerender({refit:true});animate();
     return true;
   },
   close,
   get active(){return !!draft;},
   dispose(){close();world.dispose();renderer?.dispose();orbit.dispose();
     transform.dispose?.();scene.remove(helper);
     floor.geometry.dispose();floor.material.dispose();
     grid.geometry.dispose();grid.material.dispose();
     axes.geometry.dispose();axes.material.dispose();}
 };
}
