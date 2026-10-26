import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {TransformControls} from 'three/addons/controls/TransformControls.js';
import {createPrimitiveWorld} from './primitive-world.js';
import {CREATE_CATEGORIES,insertCreatedAsset} from './scene-asset-catalog.js';
import {findMatchingArrays,findArrayCompanions,saveArrayPrototype,arrayGroupKey} from './array-prototype.js';
import {repeatOffsets} from './primitive-schema.js';
import {listAssemblyTemplates,replaceArrayAssembly,saveAssemblyTemplateDraft,assemblyDescriptor}
  from './array-assembly-templates.js';

const sampleShot='arrayPreview';
const finite=value=>Number.isFinite(Number(value))?Number(value):null;

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
 const grid=new THREE.GridHelper(20,20,0x6795a7,0x35556b);
 grid.name='Prototype ground grid (editor only)';
 grid.material.transparent=true;
 grid.material.opacity=.48;
 grid.material.depthWrite=false;
 scene.add(grid);
 const axes=new THREE.AxesHelper(2);
 axes.name='Prototype XYZ axes (editor only)';
 scene.add(axes);
 return {grid,axes};
}

export function setupArrayPrototypeEditor({getDocument,getShotIds,onSave,onClose=()=>{}}){
 const byId=id=>document.getElementById(id);
 const modal=byId('arrayEditModal');
 const canvas=byId('arrayEditCanvas');
 const category=byId('arrayEditCategory'),preset=byId('arrayEditPreset');
 const partsSelect=byId('arrayEditPartSelect');
 const fields=byId('arrayEditProperties');
 const info=byId('arrayEditInfo'),status=byId('arrayEditStatus');
 if(!modal||!canvas||!fields||!category||!preset||!partsSelect)
   return {open(){return false;},close(){}};

 const scene=new THREE.Scene();
 scene.background=new THREE.Color(0x10212c);
 scene.add(new THREE.HemisphereLight(0xcdeaff,0x344047,2));
 const {grid,axes}=createPrototypeGuides(scene);
 const key=new THREE.DirectionalLight(0xffffff,2.6);
 key.position.set(8,14,12);scene.add(key);
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
 let sourceTemplates=[],templateChoice=null,labelRows=[],beforeTemplate=null,hoverOutline=null;
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
 function attachSelected(){
   transform.detach();
   if(!draft)return;
   const node=selected==='root'?world.getObjectNode(sampleShot,objectId):
     selected.startsWith('object:')?world.getObjectNode(sampleShot,selected.slice(7)):
       world.getLightMarker(sampleShot,selected.slice(6));
   if(!node)return;
   if(selected.startsWith('light:')&&operation==='rotate')setMode('translate');
   transform.attach(node);
 }
 function setMode(mode){
   if(!['translate','rotate'].includes(mode))return;
   if(mode==='rotate'&&selected.startsWith('light:'))return;
   operation=mode;transform.setMode(mode);
   transform.setSpace(mode==='translate'?'world':'local');
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
   const base=rootItem(),t=pose();
   delete base.repeat;delete base.arrayParts;
   return {schemaVersion:1,scenes:[{shotId:sampleShot,
     objects:[base,...draft.parts.objects.map(o=>previewItem(o,'object',t))],
     lights:draft.parts.lights.map(l=>previewItem(l,'light',t))}]};
 }
 function rerender({refit=false}={}){
   if(!draft)return;
   try{
     const doc=previewDocument();
     clearLabelHighlight();transform.detach();
     world.setDocument(doc,[sampleShot]);world.showShot(sampleShot);
     world.setLightMarkersVisible(true);
     if(refit){
       const bounds=world.getBounds(sampleShot);
       const radius=framePrototypeCamera(camera,orbit,bounds);
       const body=world.getObjectNode(sampleShot,objectId);
       const box=body?new THREE.Box3().setFromObject(body):null;
       const at=box&&!box.isEmpty()?box.getCenter(new THREE.Vector3()):
         new THREE.Vector3().fromArray(bounds.center);
       grid.position.set(at.x,
         box&&!box.isEmpty()?box.min.y-.035:at.y-radius,
         at.z);
       // Grid divisions track the object's dimensions without obstructing it.
       grid.scale.setScalar(Math.max(.5,Math.min(50,radius*4/20)));
       axes.position.copy(grid.position);
       axes.scale.setScalar(Math.max(.3,Math.min(12,radius*.27)));
     }
     attachSelected();
     setStatus('Changes are temporary until Save. W to move / E to rotate.');
   }catch(error){setStatus('Preview: '+error.message);}
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
 function property(label,value,onChange,{type='number',step='0.1',min=null,max=null}={}){
   const wrap=makeEl('label',label,{class:'array-property'});
   const input=makeEl('input');input.type=type;
   if(type==='color')input.value=value;
   else if(type==='text')input.value=String(value??'');
   else {input.step=step;input.value=String(value??0);
     if(min!=null)input.min=min;if(max!=null)input.max=max;}
   input.addEventListener('change',()=>{
     let v=type==='number'?finite(input.value):input.value;
     if(v===null){setStatus('Enter a finite number.');return;}
     if(type==='number'&&min!=null&&v<min||type==='number'&&max!=null&&v>max){
       setStatus('Value outside the allowed range.');return;
     }
     try{onChange(v);rerender();}
     catch(error){setStatus(error.message);}
   });
   wrap.append(input);fields.append(wrap);
 }
 function xyz(label,vector,onChange){
   const line=makeEl('div',label,{class:'array-xyz'});
   for(let i=0;i<3;i++){
     const field=makeEl('label',['X','Y','Z'][i]);
     const input=makeEl('input');input.type='number';input.step='.1';
     input.value=String(vector[i]);
     input.addEventListener('change',()=>{
       const v=finite(input.value);
       if(v===null){setStatus('Enter a finite XYZ value.');return;}
       const result=[...vector];result[i]=v;
       onChange(result);refreshFields();rerender();
     });
     field.append(input);line.append(field);
   }
   fields.append(line);
 }
 function refreshFields(){
   fields.replaceChildren();
   const current=itemRef(),item=current?.value;
   if(!item)return;
   const root=current.kind==='base',isLight=current.kind==='light';
   fields.append(makeEl('h3',isLight?'Light settings':root?'Prototype source':'Component settings'));
   property('Name',item.name,v=>{item.name=v;refreshList();},{type:'text'});
   if(!isLight){
     if(root){
       fields.append(makeEl('p','The mini viewport stays centered on the array. XYZ and rotation change its saved placement in the scene while retaining the other matching rows.'));
       xyz('Array center XYZ (scene)',item.position,v=>item.position=v);
       xyz('Array rotation radians',item.rotation,v=>item.rotation=v);
     }
     xyz('Dimensions',item.scale,v=>item.scale=v);
     if(!root){
       xyz('Local XYZ',item.position,v=>item.position=v);
       xyz('Rotation radians',item.rotation,v=>item.rotation=v);
     }
     property('Material color',item.material.color,v=>item.material.color=v,{type:'color'});
     property('Metalness',item.material.metalness,v=>item.material.metalness=v,{min:0,max:1});
     property('Roughness',item.material.roughness,v=>item.material.roughness=v,{min:0,max:1});
     property('Glow color',item.material.emissive||'#000000',v=>{
       item.material.emissive=v;item.material.emissiveIntensity??=1;
     },{type:'color'});
     property('Glow strength',item.material.emissiveIntensity||0,v=>{
       item.material.emissiveIntensity=v;item.material.emissive??='#000000';
     },{min:0,max:10});
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
     xyz('Source XYZ',item.position,v=>item.position=v);
     if(item.type!=='point')xyz('Aim XYZ',item.target,v=>item.target=v);
     if(item.type!=='directional')property('Range',item.distance||0,v=>item.distance=v,{min:0,max:1000});
     if(item.type==='spot'){
       property('Cone radians',item.angle,v=>item.angle=v,{min:.05,max:1.5});
       property('Penumbra',item.penumbra,v=>item.penumbra=v,{min:0,max:1});
     }
   }
   const deleteButton=byId('arrayEditDeletePart');
   if(deleteButton)deleteButton.disabled=root;
 }
 function refreshList(){
   const options=[['root','Source · '+draft.base.name],
     ...draft.parts.objects.map(o=>['object:'+o.id,'Shape · '+o.name]),
     ...draft.parts.lights.map(l=>['light:'+l.id,'Light · '+l.name])];
   selectOptions(partsSelect,options);
   if(!options.some(([id])=>id===selected))selected='root';
   partsSelect.value=selected;refreshFields();attachSelected();setMode(operation);
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
 partsSelect.addEventListener('change',()=>{selected=partsSelect.value;refreshFields();attachSelected();setMode(operation);});
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
   const partId=hit?.userData?.primitiveLightTargetId?'light:'+hit.userData.primitiveLightTargetId:
     hit?.userData?.primitiveLightId?'light:'+hit.userData.primitiveLightId:
     hit?.userData?.primitiveId===objectId?'root':
     hit?.userData?.primitiveId?'object:'+hit.userData.primitiveId:null;
   if(!partId)return;
   selected=partId;refreshList();
 });
 canvas.addEventListener('pointercancel',()=>{pointerStart=null;});
 function commitGizmo(){
   if(!draft||!transform.object)return;
   const node=transform.object,current=itemRef();
   if(!current?.value)return;
   const original=originalRoot(),t=pose(),item=current.value;
   if(current.kind==='base'){
     draft.base.position=node.position.toArray().map((n,i)=>n+original.position[i]);
     draft.base.rotation=[node.rotation.x,node.rotation.y,node.rotation.z]
       .map((n,i)=>n+original.rotation[i]);
   }else if(current.kind==='light'){
     item.position=asLocalPosition(node.position.toArray(),t);
   }else{
     item.position=asLocalPosition(node.position.toArray(),t);
     item.rotation=asLocalRotation([node.rotation.x,node.rotation.y,node.rotation.z],t);
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
   if(draft)world.updateLightVisuals(camera,canvas.clientHeight||320);
 });
 byId('arrayEditAdd')?.addEventListener('click',()=>{
   if(!draft)return;
   try{
     const old=previewDocument();
     const created=insertCreatedAsset(old,sampleShot,category.value,preset.value,pose().center.toArray());
     const oldScene=old.scenes[0],nextScene=created.document.scenes[0],t=pose();
     const existingObjects=new Set(oldScene.objects.map(o=>o.id));
     const existingLights=new Set((oldScene.lights||[]).map(l=>l.id));
     for(const obj of nextScene.objects.filter(o=>!existingObjects.has(o.id))){
       obj.position=asLocalPosition(obj.position,t);
       obj.rotation=asLocalRotation(obj.rotation,t);
       draft.parts.objects.push(obj);
     }
     for(const light of (nextScene.lights||[]).filter(l=>!existingLights.has(l.id))){
       light.position=asLocalPosition(light.position,t);
       if(light.target)light.target=asLocalPosition(light.target,t);
       draft.parts.lights.push(light);
     }
     selected=(created.selected.kind==='light'?'light:':'object:')+created.selected.id;
     refreshList();rerender({refit:true});
   }catch(error){setStatus('Cannot add component: '+error.message);}
 });
 function duplicatePart(){
   if(!draft)return;
   const current=itemRef();if(!current?.value)return;
   const root=current.kind==='base';
   const copy=structuredClone(current.value);
   copy.id=uniquePartId(copy.id);
   copy.name=(copy.name+' copy').slice(0,100);
   if(root){
     delete copy.repeat;delete copy.arrayParts;
     copy.position=[0.9,0,0];copy.rotation=[0,0,0];
   }else copy.position=[copy.position[0]+.9,copy.position[1],copy.position[2]];
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
 const labelPanel=byId('arrayTemplateLabelPanel');
 const labelRowsRoot=byId('arrayTemplateLabelRows');
 const replaceLights=byId('arrayEditReplaceLights');
 function clearLabelHighlight(){
   if(!hoverOutline)return;
   hoverOutline.removeFromParent();hoverOutline.geometry.dispose();
   hoverOutline.material.dispose();hoverOutline=null;
 }
 function highlightLabelPart(key){
   clearLabelHighlight();
   if(!draft||!labelPanel||labelPanel.hidden||!key)return;
   let node=key==='root'?world.getObjectNode(sampleShot,objectId):
     key.startsWith('light:')?world.getLightMarker(sampleShot,key.slice(6)):
       world.getObjectNode(sampleShot,key.slice(7));
   if(!node)return;
   const mesh=node.isMesh?node:(()=>{
     let found=null;node.traverse(part=>{if(!found&&part.isMesh)found=part;});return found;
   })();
   if(!mesh?.geometry)return;
   hoverOutline=new THREE.LineSegments(
     new THREE.EdgesGeometry(mesh.geometry),
     new THREE.LineBasicMaterial({color:0xffd276,depthTest:false,depthWrite:false}));
   hoverOutline.name='Hovered component outline (editor only)';
   hoverOutline.renderOrder=1005;
   hoverOutline.frustumCulled=false;
   mesh.add(hoverOutline);
 }
 function resetTemplateDialog(){
   clearLabelHighlight();
   if(labelPanel)labelPanel.hidden=true;
   templateChoice=null;labelRows=[];beforeTemplate=null;
 }
 function previewChoices(kind){
   if(kind==='light')return draft.parts.lights.map(l=>({
     key:'light:'+l.id,label:'Light · '+l.name}));
   return [{key:'root',label:'Source · '+draft.base.name},
     ...draft.parts.objects.map(o=>({key:'object:'+o.id,label:'Mesh · '+o.name}))];
 }
 function renderTemplateLabels(){
   if(!labelPanel||!labelRowsRoot||!draft)return;
   labelPanel.hidden=false;
   labelRowsRoot.replaceChildren();
   for(const row of labelRows){
     const outer=makeEl('div','',{class:'array-template-label-row'});
     const question=makeEl('strong','Which '+(row.kind==='light'?'light':'mesh')+
       ' is "'+row.role+'"?');
     const select=makeEl('select');
     selectOptions(select,previewChoices(row.kind).map(x=>[x.key,x.label]));
     select.value=row.assigned;
     const labelInput=makeEl('input');labelInput.type='text';
     labelInput.maxLength=65;labelInput.value=row.role;
     labelInput.setAttribute('aria-label','New object descriptor for '+row.role);
     labelInput.addEventListener('change',()=>{row.role=labelInput.value.trim();});
     select.addEventListener('change',()=>{
       row.assigned=select.value;
       highlightLabelPart(row.assigned);
     });
     outer.addEventListener('mouseenter',()=>highlightLabelPart(row.assigned));
     outer.addEventListener('mouseleave',clearLabelHighlight);
     outer.append(question,select,makeEl('span','Descriptor after group name:'),labelInput);
     labelRowsRoot.append(outer);
   }
 }
 function discardTemplate(){
   if(!beforeTemplate||!draft)return;
   draft=beforeTemplate;beforeTemplate=null;
   candidates=draft.base.repeat?findArrayCompanions(source,shotId,objectId):[];
   resetTemplateDialog();renderCompanions();refreshList();
   updateAssemblySummary();rerender({refit:true});
   setStatus('Template changes discarded. Original destination still untouched.');
 }
 byId('arrayTemplateLabelCancel')?.addEventListener('click',discardTemplate);
 byId('arrayTemplateLabelConfirm')?.addEventListener('click',()=>{
   if(!draft?.templatePlan||!labelRows.length)return;
   const ids=new Set();
   const prefix=originalRoot()?.name.trim().split(/\s+/).slice(0,2).join(' ')||'Group';
   for(const row of labelRows){
     const name=row.role.trim();
     if(!name||name.length>65){setStatus('Enter a descriptor for every component.');return;}
     if(ids.has(row.assigned)){setStatus('Each descriptor needs a different mesh or light.');return;}
     ids.add(row.assigned);
   }
   for(const row of labelRows){
     const target=row.assigned==='root'?draft.base:
       row.assigned.startsWith('light:')?draft.parts.lights.find(l=>l.id===row.assigned.slice(6)):
         draft.parts.objects.find(o=>o.id===row.assigned.slice(7));
     if(!target){setStatus('A component is missing; please choose it again.');return;}
     target.name=(prefix+' '+row.role.trim()).slice(0,100);
   }
   draft.templatePlan.labelsConfirmed=true;
   clearLabelHighlight();labelPanel.hidden=true;
   templateChoice=null;labelRows=[];beforeTemplate=null;
   refreshList();rerender({refit:true});
   setStatus('All component labels confirmed. Save to apply the assembly to every copy.');
 });
 function stageTemplate(){
   const template=sourceTemplates.find(t=>t.id===templateSelect?.value);
   if(!draft?.base.repeat||!template)return;
   try{
     const rootOriginal=originalRoot();
     const destPrefix=rootOriginal.name.trim().split(/\s+/).slice(0,2).join(' ');
     const destRole=assemblyDescriptor(rootOriginal.name,destPrefix).toLowerCase();
     const primary=template.parts.find(p=>
       assemblyDescriptor(p.name,template.prefix).toLowerCase()===destRole)||
       template.parts[0];
     const swapped=replaceArrayAssembly(source,getShotIds(),shotId,objectId,
       template.id,primary.id,undefined,{replaceLights:!!replaceLights?.checked});
     const sceneData=swapped.document.scenes.find(sc=>sc.shotId===shotId);
     const root=sceneData.objects.find(o=>o.id===objectId);
     const rootQuat=new THREE.Quaternion().setFromEuler(new THREE.Euler(...root.rotation));
     const children=[],localIds=new Map();
     // Transfer every mesh to the mini preview before asking ANY labels.
     // Persist them as named sibling arrays when Save is finally confirmed.
     for(const mapping of swapped.created.filter(c=>c.rootId===objectId)){
       const sibling=sceneData.objects.find(o=>o.id===mapping.targetId);
       const part=structuredClone(sibling);
       delete part.repeat;delete part.arrayParts;delete part.layer;
       part.id=uniquePartId(mapping.targetId);
       part.position=new THREE.Vector3(...sibling.position)
         .sub(new THREE.Vector3(...root.position))
         .applyQuaternion(rootQuat.clone().invert()).toArray();
       part.rotation=new THREE.Euler().setFromQuaternion(
         rootQuat.clone().invert().multiply(
           new THREE.Quaternion().setFromEuler(new THREE.Euler(...sibling.rotation))))
         .toArray().slice(0,3);
       children.push(part);localIds.set(mapping.partId,part.id);
     }
     const allMappings=swapped.created.map(m=>({...m,partId:localIds.get(m.partId)}));
     if(allMappings.some(m=>!m.partId))
       throw Error('Template meshes did not align across matching destination rows');
     beforeTemplate=structuredClone(draft);
     draft.base=structuredClone(root);
     draft.parts={objects:children,
       lights:structuredClone(root.arrayParts?.lights||[])};
     draft.absorbed.clear();
     draft.templatePlan={document:swapped.document,mappings:allMappings,labelsConfirmed:false};
     candidates=[];
     templateChoice=template;
     labelRows=template.parts.map(part=>({
       kind:'object',role:assemblyDescriptor(part.name,template.prefix),
       assigned:part.id===primary.id?'root':'object:'+localIds.get(part.id)
     }));
     // Lights also appear, whether preserved from the destination or copied.
     for(const item of draft.parts.lights)
       labelRows.push({kind:'light',role:assemblyDescriptor(item.name,template.prefix),
         assigned:'light:'+item.id});
     selected='root';
     renderCompanions();refreshList();updateAssemblySummary();
     rerender({refit:true});renderTemplateLabels();
     setStatus('All '+labelRows.length+' components are visible. Hover each row or mesh, confirm labels, then Save.');
   }catch(error){setStatus('Template replacement blocked: '+error.message);}
 }
 useTemplate?.addEventListener('click',stageTemplate);
 canvas.addEventListener('pointermove',event=>{
   if(!draft||!labelPanel||labelPanel.hidden||transform.dragging)return;
   const rect=canvas.getBoundingClientRect();
   mouse.set(2*(event.clientX-rect.left)/rect.width-1,
     1-2*(event.clientY-rect.top)/rect.height);
   picker.setFromCamera(mouse,camera);
   const hit=picker.intersectObjects(world.getPickableMeshes(sampleShot),false)[0]?.object;
   const id=hit?.userData?.primitiveLightId?'light:'+hit.userData.primitiveLightId:
     hit?.userData?.primitiveId===objectId?'root':
       hit?.userData?.primitiveId?'object:'+hit.userData.primitiveId:null;
   if(id)highlightLabelPart(id);else clearLabelHighlight();
 });
 canvas.addEventListener('pointerleave',clearLabelHighlight);
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
   selected='root';refreshList();rerender();
 });
 function close(){
   resetTemplateDialog();
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
     if(draft.templatePlan&&!draft.templatePlan.labelsConfirmed)
       throw Error('Identify and confirm all template components before saving');
     const document=draft.templatePlan?
       saveAssemblyTemplateDraft(draft.templatePlan.document,getShotIds(),shotId,objectId,
         draft.base,draft.parts,draft.templatePlan.mappings):
       saveArrayPrototype(source,getShotIds(),shotId,objectId,{
         name:draft.base.name,material:draft.base.material,scale:draft.base.scale,
         position:draft.base.position,rotation:draft.base.rotation,parts:draft.parts
       },linked,[...draft.absorbed.values()].flatMap(x=>x.ids));
     onSave(document);
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
     draft={base:structuredClone(base),
       parts:structuredClone(base.arrayParts||{objects:[],lights:[]}),absorbed:new Map()};
     source=structuredClone(doc);shotId=id;objectId=partId;linked=matches;
     candidates=base.repeat?findArrayCompanions(doc,id,partId):[];
     sourceTemplates=base.repeat?listAssemblyTemplates(doc,id)
       .filter(t=>t.id!==partId):[];
     selectOptions(templateSelect||makeEl('select'),
       [['','Choose an array assembly…'],...sourceTemplates.map(t=>[t.id,t.label])]);
     if(useTemplate)useTemplate.disabled=!sourceTemplates.length;
     selected='root';dragging=false;transform.enabled=true;setMode('translate');
     // Make recognized named assemblies visible immediately. The checkboxes
     // let the editor opt out, and Cancel remains completely non-destructive.
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
     transform.dispose?.();scene.remove(helper);}
 };
}
