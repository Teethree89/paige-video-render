// Builds every primitive with the real Three.js release the site imports
// (index.html import map), then exports it the way the GLB download and the
// After Effects package do. The schema tests cannot prove geometry is right.
// Usage: THREE_NODE_MODULES=<dir containing three/> node --test tests/three_primitive_world.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';
import {pathToFileURL} from 'node:url';

if(process.env.THREE_NODE_MODULES){
  // primitive-world.js imports the bare specifier 'three', like the browser.
  const parent=pathToFileURL(process.env.THREE_NODE_MODULES.replace(/\/?$/,'/')+'resolver.js').href;
  register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,next){
    return next(s,s==='three'||s.startsWith('three/')?{...c,parentURL:${JSON.stringify(parent)}}:c);}`));
}
const THREE=await import('three');
const {GLTFExporter}=await import('three/examples/jsm/exporters/GLTFExporter.js');
const {createPrimitiveWorld}=await import('../primitive-world.js');
// GLTFExporter reads its binary buffers through FileReader, which Node lacks.
globalThis.FileReader??=class{
  readAsArrayBuffer(blob){blob.arrayBuffer().then(r=>{this.result=r;this.onloadend?.();});}
  readAsDataURL(blob){blob.arrayBuffer().then(r=>{
    this.result='data:application/octet-stream;base64,'+Buffer.from(r).toString('base64');this.onloadend?.();});}
};

const mat={color:'#888888',metalness:.1,roughness:.7};
const unit=(id,primitive,extra={})=>({id,primitive,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],material:mat,...extra});
const lights=[
  {type:'directional',name:'Moonlight',color:'#aabbff',intensity:1.2,position:[20,40,20],target:[0,0,0]},
  {type:'point',name:'Lamp',color:'#ffcc88',intensity:30,position:[4,5,0],distance:25},
  {type:'spot',name:'Floodlight',color:'#ffffff',intensity:120,position:[0,12,6],target:[0,0,6],angle:.5,penumbra:.2}];
const document={schemaVersion:1,scenes:[{shotId:'s1',camera:{position:[0,5,20],target:[0,2,0],fov:40},lights,objects:[
  unit('box','box'),unit('cone','cone'),unit('wedge','wedge'),unit('gable','gable'),
  unit('ell','extrude',{points:[[-.5,-.5],[.5,-.5],[.5,0],[0,0],[0,.5],[-.5,.5]]}),
  unit('clockwise','extrude',{points:[[-.5,-.5],[-.5,.5],[.5,.5],[.5,-.5]]}),
  {id:'windows',name:'Windows',primitive:'box',position:[10,5,0],rotation:[0,Math.PI/2,0],scale:[1,1.5,.1],
    repeat:{count:[4,3,1],spacing:[2,3,0]},
    material:{...mat,emissive:'#FFAA00',emissiveIntensity:2,opacity:.5}}
]}]};
function build(){
  const scene=new THREE.Scene(),world=createPrimitiveWorld(scene);
  world.setDocument(document,['s1','other'],{s1:[100,0,0]});
  world.showShot('s1');
  const root=scene.children[0];root.updateMatrixWorld(true);
  const meshes=[];root.traverse(node=>node.isMesh&&meshes.push(node));
  return {world,root,meshes,of:id=>meshes.filter(mesh=>mesh.userData.primitiveId===id)};
}
const vertices=mesh=>{
  const p=mesh.geometry.attributes.position,out=[];
  for(let i=0;i<p.count;i++)out.push([p.getX(i),p.getY(i),p.getZ(i)]);
  return out;
};
const near=(a,b)=>Math.abs(a-b)<1e-6;
const round=n=>Math.round(n*1e4)/1e4+0; // +0 turns -0 into 0 for deepEqual

test('every primitive fills the unit cube, so scale means size', () => {
  const {of}=build();
  for(const id of ['box','cone','wedge','gable','ell','clockwise']){
    const geometry=of(id)[0].geometry;geometry.computeBoundingBox();
    const {min,max}=geometry.boundingBox;
    for(const axis of ['x','y','z'])
      assert.ok(near(min[axis],-.5)&&near(max[axis],.5),id+' spans -0.5..0.5 on '+axis);
  }
});

test('shapes keep their documented orientation', () => {
  const {of,meshes}=build();
  const top=id=>vertices(of(id)[0]).filter(([,y])=>y>.49);
  assert.ok(top('cone').every(([x,,z])=>near(Math.hypot(x,z),0)),'cone apex points up');
  assert.ok(top('wedge').every(([x])=>near(x,-.5)),'wedge high edge at -X');
  assert.ok(top('gable').every(([x])=>near(x,0)),'gable ridge along Z');
  // The L footprint's notch (+X,+Z quarter) stays open; its top is at y=0.5
  // with an upward normal, so the footprint was not mirrored.
  const ell=of('ell')[0],down=new THREE.Vector3(0,-1,0);
  assert.equal(new THREE.Raycaster(new THREE.Vector3(100.25,5,.25),down).intersectObject(ell).length,0);
  const [hit]=new THREE.Raycaster(new THREE.Vector3(99.75,5,.25),down).intersectObject(ell);
  assert.ok(near(hit.point.y,.5));
  assert.deepEqual(hit.face.normal.clone().transformDirection(ell.matrixWorld).toArray().map(Math.round),[0,1,0]);
  assert.equal(meshes.length,6+12);
});

test('a repeat is one group of plain meshes on the rotated object axes', () => {
  const {root,of}=build();
  const holder=root.getObjectByName('Windows'),copies=of('windows');
  assert.ok(holder.isGroup);assert.equal(holder.children.length,12);
  assert.equal(holder.userData.primitiveId,'windows');
  assert.deepEqual(copies.slice(0,2).map(mesh=>mesh.name),['Windows 1','Windows 2']);
  assert.ok(copies.every(mesh=>mesh.geometry===copies[0].geometry&&mesh.material===copies[0].material));
  const world=copies.map(mesh=>mesh.getWorldPosition(new THREE.Vector3()).toArray());
  // Rotated 90° about Y, the object's X spacing runs along world -Z: one facade plane.
  assert.ok(world.every(([x])=>near(x,110)));
  assert.deepEqual([...new Set(world.map(([,y])=>Math.round(y)))].sort((a,b)=>a-b),[2,5,8]);
  assert.deepEqual([...new Set(world.map(([,,z])=>Math.round(z)))].sort((a,b)=>a-b),[-3,-1,1,3]);
});

test('glow and glass materials, and plain ones unchanged', () => {
  const {of}=build();
  const glass=of('windows')[0].material,plain=of('box')[0].material;
  assert.equal(glass.emissive.getHexString(),'ffaa00');assert.equal(glass.emissiveIntensity,2);
  assert.ok(glass.transparent&&glass.opacity===.5&&glass.depthWrite===false);
  assert.equal(plain.emissive.getHex(),0);assert.equal(plain.transparent,false);assert.equal(plain.depthWrite,true);
});

test('the model camera is offset by the shot anchor', () => {
  const {world}=build();
  assert.deepEqual(world.getCamera('s1'),{position:[100,5,20],target:[100,2,0],fov:40});
  assert.equal(world.getCamera('missing'),null);
});

test('scene lights shine from their position toward their target, only during the shot', () => {
  const {world,root}=build();
  const found=[];root.traverse(node=>node.isLight&&found.push(node));
  assert.deepEqual(found.map(node=>[node.type,node.name]),
    [['DirectionalLight','Moonlight'],['PointLight','Lamp'],['SpotLight','Floodlight']]);
  const [moon,lamp,flood]=found;
  assert.equal(lamp.intensity,30);assert.equal(lamp.distance,25);assert.equal(lamp.decay,2);
  assert.equal(flood.angle,.5);assert.equal(flood.penumbra,.2);
  assert.equal(moon.color.getHexString(),'aabbff');
  // Three.js lights point from the light to its target; both are offset by the anchor.
  const direction=node=>node.target.getWorldPosition(new THREE.Vector3())
    .sub(node.getWorldPosition(new THREE.Vector3())).normalize().toArray().map(round);
  assert.deepEqual(direction(moon),new THREE.Vector3(-20,-40,-20).normalize().toArray().map(round));
  assert.deepEqual(direction(flood),[0,-1,0]);
  assert.deepEqual(flood.getWorldPosition(new THREE.Vector3()).toArray(),[100,12,6]);
  assert.ok(flood.target.parent===flood,'target is a child, as glTF expects');
  world.showShot('other');assert.equal(root.visible,false,'hidden with its shot');
  // Lights alone never replace the original world for a shot.
  const scene=new THREE.Scene(),alone=createPrimitiveWorld(scene);
  alone.setDocument({schemaVersion:1,scenes:[{shotId:'s1',objects:[],lights}]},['s1']);
  assert.equal(alone.hasObjects('s1'),false);
});

test('GLB export keeps shared copies, glass and glow', async () => {
  const {world}=build(),scene=world.getSceneForExport('s1');
  // The editor's GLB download options (primitive-editor.js).
  const gltf=await new GLTFExporter().parseAsync(scene,{binary:false,onlyVisible:false,trs:true});
  assert.equal(gltf.meshes.length,7,'one glTF mesh per object, reused by every copy');
  assert.ok(gltf.nodes.length>=6+12);
  const glass=gltf.materials.find(material=>material.alphaMode==='BLEND');
  assert.equal(glass.pbrMetallicRoughness.baseColorFactor[3],.5);
  assert.equal(glass.extensions.KHR_materials_emissive_strength.emissiveStrength,2);
  // Lights export as KHR_lights_punctual, aimed down each node's -Z.
  assert.deepEqual(gltf.extensions.KHR_lights_punctual.lights.map(light=>light.type),['directional','point','spot']);
  const point=gltf.extensions.KHR_lights_punctual.lights[1];
  assert.equal(point.intensity,30);assert.equal(point.range,25);
  const flood=gltf.nodes.find(node=>node.name==='Floodlight');
  const aim=new THREE.Vector3(0,0,-1).applyQuaternion(new THREE.Quaternion(...(flood.rotation||[0,0,0,1])));
  assert.deepEqual(aim.toArray().map(round),[0,-1,0]);
  const glb=await new GLTFExporter().parseAsync(scene,{binary:true});
  assert.ok(glb.byteLength>1000);
  world.dispose();
});

test('viewport picking resolves each repeated copy to one editable holder ID',()=>{
  const {world,root,of}=build();
  const holder=world.getObjectNode('s1','windows');
  assert.equal(holder,root.getObjectByName('Windows'));
  assert.ok(holder.isGroup);
  assert.equal(world.getObjectNode('s1','box').isMesh,true);
  assert.equal(world.getObjectNode('s1','unknown'),null);
  assert.equal(world.getObjectNode('other','windows'),null);
  const pickables=world.getPickableMeshes('s1');
  assert.equal(pickables.length,18);
  assert.ok(pickables.every(node=>node.userData.primitiveId));
  assert.ok(of('windows').every(node=>pickables.includes(node)));
  assert.equal(world.getPickableMeshes('other').length,0);
  holder.position.x+=3;
  assert.equal(holder.position.x,13);
  assert.equal(of('windows')[0].position.x,-3,'the repeated children do not need to be edited individually');
  const copy=world.getSceneForExport('s1');
  assert.ok(copy.getObjectByName('Windows'),'export continues using ordinary nodes');
});

test('pinned Three.js TransformControls attach to saved primitives and toggle orbit safely',async()=>{
  const {setupSceneObjectEditing}=await import('../scene-object-edit.js');
  const {world}=build(),scene=new THREE.Scene();
  // The real world object is already parented to its own scene; its existing
  // meshes can be referenced by TransformControls without reparenting it.
  const camera=new THREE.PerspectiveCamera(50,1,.1,1000);
  camera.position.set(0,5,30);camera.lookAt(0,0,0);
  const listeners=new Map();
  const canvas={
    style:{},addEventListener(type,fn){listeners.set(type,fn);},
    removeEventListener(type){listeners.delete(type);},
    getBoundingClientRect(){return {left:0,top:0,width:800,height:600}},
    setPointerCapture(){},releasePointerCapture(){}
  };
  const ids=new Map();
  const oldDocument=globalThis.document;
  globalThis.document={getElementById(id){
    if(!ids.has(id))ids.set(id,{
      hidden:false,disabled:false,textContent:'',classList:{toggle(){}},
      addEventListener(){},setAttribute(){}
    });
    return ids.get(id);
  }};
  const orbit={enabled:false};
  let enters=0,exits=0,selection=null,deletes=0;
  try{
    const editor=setupSceneObjectEditing({
      scene,camera,canvas,orbitControls:orbit,world,
      getActiveShot:()=>({id:'s1'}),getDocument:()=>document,
      onEnter:()=>{enters++;return true;},onExit:()=>{exits++;orbit.enabled=false;},
      onSelect:id=>selection=id,onDelete:()=>{deletes++;},
      onTransform:()=>assert.fail('Do not persist transforms on selection'),
      onStatus:()=>{}
    });
    assert.equal(editor.active,false);
    assert.equal(editor.setActive(true),true);
    assert.equal(editor.active,true);assert.equal(orbit.enabled,true);
    assert.equal(editor.select('windows'),true);
    assert.equal(editor.selectedId,'windows');assert.equal(selection,'windows');
    assert.equal(editor.setMode('rotate'),undefined);
    assert.equal(editor.select('unknown'),false);
    assert.equal(editor.deleteSelected(),true);assert.equal(deletes,1);
    assert.equal(editor.selectedId,null);
    assert.equal(editor.setActive(false),true);
    assert.equal(editor.active,false);assert.equal(enters,1);assert.equal(exits,1);
    editor.dispose();
  }finally{globalThis.document=oldDocument;world.dispose();}
});

test('oriented selection wireframe follows a moved/rotated mesh rather than dropping below it',async()=>{
  const {createSelectionOutline}=await import('../scene-object-edit.js');
  const {world,root}=build();
  const object=world.getObjectNode('s1','box');
  object.position.set(17,4,-9);
  object.rotation.set(0,Math.PI/3,.1);
  const outline=createSelectionOutline(object);
  assert.ok(outline,'selected box has a local outline');
  assert.equal(outline.line.isLineSegments,true);
  // Every wireframe vertex matches one real vertex after the complete
  // parent shot anchor + object translation + Euler rotation are applied.
  const verticesOf=(geometry,matrix)=>{
    const a=geometry.getAttribute('position'),keys=new Set();
    for(let i=0;i<a.count;i++){
      const p=new THREE.Vector3().fromBufferAttribute(a,i).applyMatrix4(matrix);
      keys.add(p.toArray().map(round).join(','));
    }
    return keys;
  };
  const expect=verticesOf(object.geometry,object.matrixWorld);
  assert.deepEqual(verticesOf(outline.line.geometry,outline.line.matrixWorld),expect);
  const before=outline.line.matrixWorld.clone();
  object.position.y+=6;
  object.rotation.z=.45;
  outline.update();
  assert.ok(!outline.line.matrixWorld.equals(before),'wireframe follows post-drag transforms');
  assert.deepEqual(verticesOf(outline.line.geometry,outline.line.matrixWorld),
    verticesOf(object.geometry,object.matrixWorld));
  // The selection outline is an editor-only scene item, not a child of the
  // primitive, and must never be exported.
  root.parent.add(outline.line);
  assert.equal(world.getSceneForExport('s1').getObjectByName(outline.line.name),undefined);
  outline.dispose();
  assert.equal(outline.line.parent,null);
  world.dispose();
});

test('rotated repeated groups stay enclosed by their object-local outline after translating',async()=>{
  const {createSelectionOutline}=await import('../scene-object-edit.js');
  const {world,root}=build();
  const holder=world.getObjectNode('s1','windows');
  holder.rotation.y=Math.PI/3;
  holder.position.set(30,12,-6);
  const outline=createSelectionOutline(holder);
  assert.ok(outline);
  const inverse=outline.line.matrixWorld.clone().invert();
  holder.traverse(node=>{
    if(!node.isMesh)return;
    const a=node.geometry.getAttribute('position');
    for(let i=0;i<a.count;i++){
      const point=new THREE.Vector3().fromBufferAttribute(a,i)
        .applyMatrix4(node.matrixWorld).applyMatrix4(inverse);
      for(const axis of ['x','y','z'])assert.ok(Math.abs(point[axis])<.501,
        'repeated mesh vertex must stay in its oriented outline');
    }
  });
  const initial=outline.line.matrixWorld.clone();
  holder.position.y-=9;
  holder.rotation.y+=.25;
  outline.update();
  assert.ok(!outline.line.matrixWorld.equals(initial));
  assert.equal(holder.parent.parent,root);
  outline.dispose();
  world.dispose();
});


test('lights-only chapters export a valid punctual-light GLTF without mesh geometry',async()=>{
  const scene=new THREE.Scene(),world=createPrimitiveWorld(scene);
  try{
    world.setDocument({schemaVersion:1,scenes:[{
      shotId:'lights',objects:[],lights:[{
        type:'point',name:'Light only',color:'#ffcc88',
        intensity:20,position:[0,4,0]
      }]
    }]},['lights'],{lights:[0,0,0]});
    assert.equal(world.hasObjects('lights'),false,
      'lights-only chapters intentionally have no geometry override');
    const asset=world.getSceneForExport('lights');
    const gltf=await new Promise((resolve,reject)=>{
      new GLTFExporter().parse(asset,resolve,reject,{
        binary:false,onlyVisible:false,trs:true
      });
    });
    assert.equal(gltf.extensions?.KHR_lights_punctual?.lights?.length,1);
    assert.equal(gltf.extensions.KHR_lights_punctual.lights[0].name,'Light only');
  }finally{world.dispose();}
});


test('L-style created light survives validation and becomes a real Three.js light plus edit gizmo',async()=>{
 const {insertCreatedAsset}=await import('../scene-asset-catalog.js');
 const scene=new THREE.Scene(),world=createPrimitiveWorld(scene);
 try{
   const base={schemaVersion:1,scenes:[]},click=[5,2,-3];
   const created=insertCreatedAsset(base,'chapter','lights','point-white',click);
   const saved=created.document.scenes[0].lights[0];
   assert.equal(saved.id,created.selected.id);
   assert.equal(saved.type,'point');
   assert.deepEqual(saved.position,[5,4,-3]);
   world.setDocument(created.document,['chapter'],{chapter:[100,0,-30]});
   world.showShot('chapter');
   world.setLightMarkersVisible(true);
   const actual=world.getLightNode('chapter',saved.id);
   const marker=world.getLightMarker('chapter',saved.id);
   assert.ok(actual?.isPointLight,'a real shaded point light exists, not only saved JSON');
   assert.ok(marker?.isMesh,'a Three.js editor gizmo was constructed');
   assert.equal(world.isLightMarkerVisible('chapter',saved.id),true);
   assert.deepEqual(actual.position.toArray(),marker.position.toArray());
   assert.deepEqual(actual.getWorldPosition(new THREE.Vector3()).toArray(),[105,4,-33]);
   assert.equal(world.getSceneForExport('chapter').children.some(x=>x.isPointLight),true);
   world.showShot('other');
   assert.equal(world.isLightMarkerVisible('chapter',saved.id),false);
   world.showShot('chapter');
   world.setLightMarkersVisible(false);
   assert.equal(world.isLightMarkerVisible('chapter',saved.id),false);
   assert.equal(world.getLightNode('chapter',saved.id)?.isPointLight,true,
     'hiding edit widgets must not delete the authored light');
 }finally{world.dispose();}
});


test('more than 32 manually created lights are real Three.js lights and remain GLB-exportable',async()=>{
  const {insertCreatedAsset}=await import('../scene-asset-catalog.js');
  let doc={schemaVersion:1,scenes:[]};
  for(let i=0;i<36;i++)
    doc=insertCreatedAsset(doc,'manual','lights',i%2?'point-blue':'point-white',
      [i*2,0,0]).document;
  const scene=new THREE.Scene(),world=createPrimitiveWorld(scene);
  try{
    world.setDocument(doc,['manual'],{manual:[100,0,20]});
    world.showShot('manual');
    world.setLightMarkersVisible(true);
    assert.equal(doc.scenes[0].lights.length,36);
    for(const light of doc.scenes[0].lights){
      assert.ok(world.getLightNode('manual',light.id)?.isPointLight,light.id+' exists in real Three scene');
      assert.ok(world.getLightMarker('manual',light.id)?.isMesh,light.id+' has an editor gizmo');
      assert.equal(world.isLightMarkerVisible('manual',light.id),true);
    }
    const copy=world.getSceneForExport('manual');
    const gltf=await new GLTFExporter().parseAsync(copy,{binary:false,onlyVisible:false});
    assert.equal(gltf.extensions.KHR_lights_punctual.lights.length,36,
      'all manually added lights survive GLB export');
  }finally{world.dispose();}
});


test('array prototype renders matching additions and real light for every rotated copy, and exports them',async()=>{
 const {saveArrayPrototype}=await import('../array-prototype.js');
 const pole={...unit('pole','cylinder'),name:'Streetlight',
   scale:[.2,6,.2],position:[5,3,0],
   repeat:{count:[3,1,1],spacing:[8,0,0]}};
 const pole2={...pole,id:'pole2',position:[20,3,4],rotation:[0,Math.PI/2,0]};
 const doc={schemaVersion:1,scenes:[{shotId:'street',objects:[pole,pole2]}]};
 const changed=saveArrayPrototype(doc,['street'],'street','pole',{
   name:'Streetlight',scale:pole.scale,material:pole.material,
   parts:{objects:[{...unit('bulb','sphere'),
     name:'Bulb',position:[0,3,0],scale:[.6,.4,.6],
     material:{color:'#ffeebb',metalness:0,roughness:.4,emissive:'#ffeebb',emissiveIntensity:2}}],
   lights:[{id:'source',type:'spot',name:'Downlight',color:'#fff1cc',intensity:280,
     position:[0,3,0],target:[0,-2,0],distance:32,angle:.5,penumbra:.3}]}
 });
 const scene=new THREE.Scene(),world=createPrimitiveWorld(scene);
 try{
   world.setDocument(changed,['street'],{street:[100,0,20]});
   world.showShot('street');
   const first=world.getArrayInstances('street','pole');
   const second=world.getArrayInstances('street','pole2');
   assert.equal(first.length,3);assert.equal(second.length,3);
   const positions=[];
   for(const [index,instance] of [...first,...second].entries()){
     const meshes=[],lights=[];
     instance.traverse(node=>{
       if(node.isMesh)meshes.push(node);
       if(node.isLight)lights.push(node);
     });
     assert.equal(meshes.length,2,'each instance contains both base and added component');
     assert.equal(lights.length,1,'each instance contains a real spotlight');
     assert.equal(lights[0].name,'Downlight');
     const source=lights[0].getWorldPosition(new THREE.Vector3());
     positions.push(source.toArray().map(round).join(','));
   }
   assert.equal(new Set(positions).size,6,'all streetlights occupy separate XYZ coordinates');
   assert.equal(world.getPickableMeshes('street').filter(n=>n.userData.primitiveArrayPartId==='bulb').length,6);
   const asset=world.getSceneForExport('street');
   const exported=[];
   asset.traverse(n=>{if(n.isSpotLight)exported.push(n);});
   assert.equal(exported.length,6,'all 6 physically positioned spotlights survive scene export');
   const gltf=await new GLTFExporter().parseAsync(asset,{binary:false,onlyVisible:false,trs:true});
   assert.ok(gltf.extensions?.KHR_lights_punctual?.lights?.length>=1);
   const names=gltf.nodes.filter(n=>n.name==='Downlight');
   assert.equal(names.length,6,'all copies are real exporter light nodes');
 }finally{world.dispose();}
});


test('double-clicking one array mesh outlines all repeats and asks before opening editor',async()=>{
 const {setupSceneObjectEditing}=await import('../scene-object-edit.js');
 const {world}=build();
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(48,800/600,.1,1000);
 camera.position.set(135,5,3);camera.lookAt(110,5,3);camera.updateMatrixWorld();
 const handlers={},elements=new Map(),oldDocument=globalThis.document;
 const element=id=>{
   if(!elements.has(id))elements.set(id,{
     hidden:true,open:false,textContent:'',disabled:false,
     classList:{toggle(){}},style:{},attrs:{},callbacks:{},
     setAttribute(name,value){this.attrs[name]=value;},
     addEventListener(type,handler){this.callbacks[type]=handler;},
     showModal(){this.open=true;},close(){this.open=false;},
     click(){this.callbacks.click?.({preventDefault(){}});}
   });
   return elements.get(id);
 };
 globalThis.document={getElementById:element};
 const canvas={style:{},
   addEventListener(type,handler){handlers[type]=handler;},
   removeEventListener(type){delete handlers[type];},
   getBoundingClientRect(){return {left:0,top:0,width:800,height:600}},
   setPointerCapture(){},releasePointerCapture(){}};
 const orbit={enabled:true};
 const calls=[];
 try{
   const editor=setupSceneObjectEditing({
     scene,camera,canvas,orbitControls:orbit,world,
     getActiveShot:()=>({id:'s1'}),getDocument:()=>document,
     onEnter:()=>true,onExit:()=>{},
     onArrayEdit:(shot,id,index)=>{calls.push([shot,id,index]);return true;},
     onSelect:()=>{},onStatus:()=>{}
   });
   assert.equal(editor.setActive(true),true);
   const prior=scene.children.length;
   handlers.dblclick({button:0,clientX:400,clientY:300});
   const dialog=element('arrayEditConfirm');
   assert.equal(dialog.open,true,'double-click opens Yes/No confirm');
   assert.match(element('arrayEditConfirmText').textContent,/12 matching copies/);
   assert.equal(editor.selectedId,'windows');
   assert.ok(scene.children.length>=prior+12,'all 12 instances get individual outline geometry');
   assert.equal(calls.length,0,'editing does not start before confirmation');
   element('arrayEditNo').click();
   assert.equal(dialog.open,false);
   assert.equal(calls.length,0);
   handlers.dblclick({button:0,clientX:400,clientY:300});
   element('arrayEditYes').click();
   assert.equal(calls.length,1);
   assert.equal(calls[0][0],'s1');assert.equal(calls[0][1],'windows');
   assert.ok(Number.isInteger(calls[0][2])&&calls[0][2]>=0&&calls[0][2]<12);
   editor.clearArrayHighlights();
   editor.dispose();
 }finally{globalThis.document=oldDocument;world.dispose();}
});


test('array prototype mini viewport frames the saved mesh with finite camera coordinates',async()=>{
 const {framePrototypeCamera,createPrototypeGuides}=
   await import('../array-prototype-editor.js');
 const scene=new THREE.Scene(),world=createPrimitiveWorld(scene);
 const prototype={...unit('right_ave_crowns','sphere'),name:'Right Ave Crowns',
   scale:[3.8,4.2,3.8],position:[0,0,0]};
 world.setDocument({schemaVersion:1,scenes:[{
   shotId:'arrayPreview',objects:[prototype]}]},['arrayPreview']);
 world.showShot('arrayPreview');
 const bounds=world.getBounds('arrayPreview');
 assert.ok(Array.isArray(bounds.center),'primitive-world emits an XYZ tuple');
 const camera=new THREE.PerspectiveCamera(46,629/729,.1,2000);
 const orbit={target:new THREE.Vector3(),update(){
   camera.lookAt(this.target);camera.updateMatrixWorld(true);
 }};
 const radius=framePrototypeCamera(camera,orbit,bounds);
 assert.ok(radius>=3);
 for(const value of [...camera.position.toArray(),...orbit.target.toArray(),
   ...camera.projectionMatrix.elements,...camera.matrixWorld.elements])
   assert.ok(Number.isFinite(value),'camera never contains NaN / undefined from XYZ bounds');
 assert.deepEqual(orbit.target.toArray(),bounds.center);
 const source=world.getObjectNode('arrayPreview','right_ave_crowns');
 assert.ok(source?.isMesh);
 const projected=source.getWorldPosition(new THREE.Vector3()).project(camera);
 assert.ok(Math.abs(projected.x)<.9&&Math.abs(projected.y)<.9,
   'source must be within the visible camera framing');
 assert.ok(projected.z>-1&&projected.z<1,'source must be between near and far planes');

 const {grid,axes}=createPrototypeGuides(scene);
 assert.equal(grid.type,'GridHelper');
 assert.equal(grid.visible,true);
 assert.equal(axes.type,'AxesHelper');
 const box=new THREE.Box3().setFromObject(source);
 grid.position.set(bounds.center[0],box.min.y-.035,bounds.center[2]);
 grid.scale.setScalar(Math.max(.5,Math.min(50,radius*4/20)));
 assert.ok(grid.position.y<box.min.y,'grid must sit below the sample object');
 assert.ok(grid.parent===scene && axes.parent===scene,
   'viewport guides must not be children of the exported 3D scene');
 const exportRoot=world.getSceneForExport('arrayPreview');
 assert.equal(exportRoot.getObjectByName(grid.name),undefined);
 assert.equal(exportRoot.getObjectByName(axes.name),undefined);
 assert.throws(()=>framePrototypeCamera(camera,orbit,{center:[NaN,0,0],radius:4}),
   /valid XYZ/);
 world.dispose();grid.geometry.dispose();grid.material.dispose();
 axes.geometry.dispose();axes.material.dispose();
});
