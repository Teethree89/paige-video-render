import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {createPrimitiveWorld} from './primitive-world.js';
import {CREATE_CATEGORIES,insertCreatedAsset} from './scene-asset-catalog.js';
import {findMatchingArrays,saveArrayPrototype} from './array-prototype.js';
import {repeatOffsets} from './primitive-schema.js';

const sampleShot='arrayPreview';
const finite=value=>Number.isFinite(Number(value))?Number(value):null;

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
 const world=createPrimitiveWorld(scene);
 let draft=null,source=null,shotId=null,objectId=null,linked=[],selected='root',frame=0;
 const setStatus=value=>{if(status)status.textContent=value;};
 function rootItem(){
   return draft?{...draft.base,id:objectId,position:[0,0,0],rotation:[0,0,0],
     repeat:undefined,arrayParts:undefined}:null;
 }
 function previewDocument(){
   if(!draft)return null;
   const base=rootItem();
   delete base.repeat;delete base.arrayParts;
   return {schemaVersion:1,scenes:[{shotId:sampleShot,
     objects:[base,...draft.parts.objects],lights:draft.parts.lights}]};
 }
 function rerender({refit=false}={}){
   if(!draft)return;
   try{
     const doc=previewDocument();
     world.setDocument(doc,[sampleShot]);world.showShot(sampleShot);
     world.setLightMarkersVisible(true);
     if(refit){
       const bounds=world.getBounds(sampleShot);
       const center=bounds?.center||new THREE.Vector3();
       const radius=Math.max(3,bounds?.radius||3);
       orbit.target.fromArray(center);
       camera.position.copy(center).add(new THREE.Vector3(radius*1.9,radius*1.4,radius*2.7));
       camera.near=.05;camera.far=Math.max(1500,radius*100);camera.updateProjectionMatrix();
       orbit.update();
     }
     setStatus('Changes are temporary until Save. Orbit to inspect the prototype.');
   }catch(error){setStatus('Preview: '+error.message);}
 }
 function stop(){
   if(frame)cancelAnimationFrame(frame);
   frame=0;
 }
 function animate(){
   if(!draft)return;
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
     if(root)fields.append(makeEl('p','Edits to the source mesh are applied to all matching array copies.'));
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
   partsSelect.value=selected;refreshFields();
 }
 partsSelect.addEventListener('change',()=>{selected=partsSelect.value;refreshFields();});
 // Clicking a prototype mesh or light selects the same editable fields as the
 // component dropdown. A drag remains an orbit operation, not selection.
 const picker=new THREE.Raycaster(),mouse=new THREE.Vector2();
 let pointerStart=null;
 canvas.addEventListener('pointerdown',event=>{
   if(event.button===0)pointerStart={x:event.clientX,y:event.clientY};
 });
 canvas.addEventListener('pointerup',event=>{
   if(!draft||event.button!==0||!pointerStart)return;
   const start=pointerStart;pointerStart=null;
   if(Math.hypot(event.clientX-start.x,event.clientY-start.y)>5)return;
   const rect=canvas.getBoundingClientRect();
   mouse.set(2*(event.clientX-rect.left)/rect.width-1,
     1-2*(event.clientY-rect.top)/rect.height);
   picker.setFromCamera(mouse,camera);
   const hit=picker.intersectObjects(world.getPickableMeshes(sampleShot),false)[0]?.object;
   const partId=hit?.userData?.primitiveLightId?'light:'+hit.userData.primitiveLightId:
     hit?.userData?.primitiveId===objectId?'root':
     hit?.userData?.primitiveId?'object:'+hit.userData.primitiveId:null;
   if(!partId)return;
   selected=partId;refreshList();
 });
 canvas.addEventListener('pointercancel',()=>{pointerStart=null;});
 byId('arrayEditAdd')?.addEventListener('click',()=>{
   if(!draft)return;
   try{
     const old=previewDocument();
     const created=insertCreatedAsset(old,sampleShot,category.value,preset.value,[0,0,0]);
     draft.parts.objects=created.document.scenes[0].objects.filter(o=>o.id!==objectId);
     draft.parts.lights=created.document.scenes[0].lights||[];
     selected=(created.selected.kind==='light'?'light:':'object:')+created.selected.id;
     refreshList();rerender();
   }catch(error){setStatus('Cannot add component: '+error.message);}
 });
 byId('arrayEditDeletePart')?.addEventListener('click',()=>{
   if(!draft||selected==='root')return;
   const [kind,id]=selected.split(':');
   const list=kind==='light'?draft.parts.lights:draft.parts.objects;
   const index=list.findIndex(x=>x.id===id);
   if(index!==-1)list.splice(index,1);
   selected='root';refreshList();rerender();
 });
 function close(){
   stop();draft=null;source=null;shotId=null;objectId=null;linked=[];
   modal.hidden=true;world.setDocument({schemaVersion:1,scenes:[]},[]);
   onClose();
 }
 byId('arrayEditCancel')?.addEventListener('click',close);
 byId('arrayEditSave')?.addEventListener('click',()=>{
   if(!draft)return;
   try{
     const document=saveArrayPrototype(source,getShotIds(),shotId,objectId,{
       name:draft.base.name,material:draft.base.material,scale:draft.base.scale,parts:draft.parts
     },linked);
     onSave(document);
     close();
   }catch(error){setStatus('Save blocked: '+error.message);}
 });
 modal.addEventListener('keydown',event=>{
   // While editing an isolated prototype, W/E/L/Delete, timeline shortcuts
   // and the Create wheel must never mutate the underlying live chapter.
   event.stopPropagation();
   if(event.key==='Escape'){event.preventDefault();close();}
 });
 return {
   open(id,partId){
     if(draft)return false;
     try{ensureRenderer();}
     catch(error){setStatus('3D prototype preview unavailable: '+error.message);return false;}
     const doc=getDocument(),shot=getShotIds().find(s=>s===id);
     if(!shot)return false;
     const scene=doc?.scenes?.find(s=>s.shotId===id);
     const base=scene?.objects?.find(o=>o.id===partId&&o.repeat);
     if(!base)return false;
     const matches=findMatchingArrays(doc,id,partId);
     draft={base:structuredClone(base),parts:structuredClone(base.arrayParts||{objects:[],lights:[]})};
     source=structuredClone(doc);shotId=id;objectId=partId;linked=matches;
     selected='root';
     const copies=matches.reduce((sum,key)=>{
       const item=scene.objects.find(o=>o.id===key);
       return sum+repeatOffsets(item.repeat).length;
     },0);
     if(info)info.textContent='Editing 1 prototype · '+copies+
       ' instances across '+matches.length+' matching array group(s). Save applies to all.';
     modal.hidden=false;refreshList();rerender({refit:true});animate();
     return true;
   },
   close,
   get active(){return !!draft;},
   dispose(){close();world.dispose();renderer?.dispose();orbit.dispose();}
 };
}
