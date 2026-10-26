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

const batchFixture=()=>({schemaVersion:1,scenes:[{shotId:'array',objects:[
 unit('lamps','group',{position:[4,3,-2],rotation:[0,.3,0],instanceRotation:[0,.8,0],
   repeat:{count:[4,1,1],spacing:[5,0,0]},arrayParts:{objects:[
     unit('stem','cylinder',{name:'Stem',scale:[.2,5,.2]}),
     unit('head','sphere',{name:'Head',position:[1,3,0],scale:[2,.5,1]}),
     unit('glass','box',{name:'Glass',position:[0,2,0],material:{...mat,opacity:.4}})
   ],lights:[{...lights[2],id:'beam'}]}})
]}]});

test('GPU arrays batch opaque parts while preserving every pickable copy, light and transparent mesh',()=>{
 const scene=new THREE.Scene(),world=createPrimitiveWorld(scene,{batchRepeats:true});
 const source=batchFixture(),snapshot=structuredClone(source);
 try{
   world.setDocument(source,null,{array:[100,0,-30]});world.showShot('array');world.prepareRender('array');
   const visible=[],foundLights=[];
   scene.traverseVisible(n=>{if(n.isMesh)visible.push(n);if(n.isLight)foundLights.push(n);});
   assert.equal(visible.length,6,'12 mesh submissions become 2 instanced batches plus 4 sorted glass meshes');
   assert.equal(visible.filter(n=>n.isInstancedMesh).length,2);
   assert.equal(visible.reduce((sum,n)=>sum+(n.isInstancedMesh?n.count:1),0),12);
   assert.equal(foundLights.length,4,'instancing never caps or merges punctual lights');
   const pickables=world.getPickableMeshes('array');
   assert.equal(pickables.length,12);assert.ok(pickables.every(n=>!n.isInstancedMesh));
   assert.equal(pickables.filter(n=>n.visible).length,4,'glass retains its ordinary draw/sort behavior');
   assert.equal(world.getArrayInstances('array','lamps').length,4);
   assert.deepEqual(source,snapshot,'source scene data is not mutated');
 }finally{world.dispose();}
});

test('instanced matrices follow copy-local rotation and holder transforms; light-only edits keep uploads cached',()=>{
 const scene=new THREE.Scene(),world=createPrimitiveWorld(scene,{batchRepeats:true});
 try{
   world.setDocument(batchFixture(),null,{array:[100,0,-30]});world.showShot('array');world.prepareRender('array');
   const holder=world.getObjectNode('array','lamps'),batches=holder.children.filter(n=>n.isInstancedMesh);
   const assertMatrices=()=>{
     scene.updateMatrixWorld(true);
     for(const batch of batches){
       const originals=world.getPickableMeshes('array').filter(n=>n.geometry===batch.geometry&&n.material===batch.material);
       originals.forEach((mesh,i)=>{
         const matrix=new THREE.Matrix4();batch.getMatrixAt(i,matrix);matrix.premultiply(batch.matrixWorld);
         matrix.elements.forEach((n,j)=>assert.ok(Math.abs(n-mesh.matrixWorld.elements[j])<1e-4));
       });
     }
   };
   assertMatrices();
   for(const copy of world.getArrayInstances('array','lamps'))copy.rotation.y+=Math.PI/2;
   holder.position.x+=8;holder.rotation.z=.2;
   world.invalidateGeometry('array');world.prepareRender('array');assertMatrices();
   const versions=batches.map(n=>n.instanceMatrix.version);
   world.invalidateShadows('array');world.prepareRender('array');
   assert.deepEqual(batches.map(n=>n.instanceMatrix.version),versions,'light changes do not re-upload geometry');
   const disposals=batches.map(()=>0);
   batches.forEach((batch,i)=>batch.addEventListener('dispose',()=>disposals[i]++));
   world.dispose();assert.deepEqual(disposals,[1,1]);
 }finally{world.dispose();}
});

test('hidden picking meshes still raycast and GLB exports every ordinary copy without preview instances',async()=>{
 const scene=new THREE.Scene(),world=createPrimitiveWorld(scene,{batchRepeats:true});
 try{
   const array=unit('boxes','box',{position:[0,0,0],repeat:{count:[3,1,1],spacing:[3,0,0]}});
   world.setDocument({schemaVersion:1,scenes:[{shotId:'array',objects:[array]}]},null,{array:[100,0,20]});
   world.showShot('array');world.prepareRender('array');scene.updateMatrixWorld(true);
   const [hit]=new THREE.Raycaster(new THREE.Vector3(97,0,30),new THREE.Vector3(0,0,-1))
     .intersectObjects(world.getPickableMeshes('array'),false);
   assert.ok(hit,'render-hidden ordinary mesh remains pickable');
   assert.equal(hit.object.userData.primitiveArrayIndex,0);
   const exported=world.getSceneForExport('array'),nodes=[];
   exported.traverse(n=>{assert.equal(!!n.userData.previewBatch,false);assert.equal(!!n.userData.previewSource,false);if(n.isMesh)nodes.push(n);});
   assert.equal(nodes.length,3);assert.ok(nodes.every(n=>n.visible&&!n.isInstancedMesh));
   const gltf=await new GLTFExporter().parseAsync(exported,{binary:false,onlyVisible:true,trs:true});
   assert.equal(gltf.nodes.filter(n=>n.mesh!==undefined).length,3);
   assert.equal(gltf.meshes.length,1);
   assert.ok(!gltf.extensionsUsed?.includes('EXT_mesh_gpu_instancing'));
   const {createSelectionOutline}=await import('../scene-object-edit.js');
   const outline=createSelectionOutline(world.getObjectNode('array','boxes'));
   assert.ok(outline);
   assert.equal(outline.line.matrix.elements[0],7);
   assert.equal(outline.line.matrix.elements[5],1);
   assert.equal(outline.line.matrix.elements[10],1);
   assert.deepEqual(outline.line.matrix.elements.slice(12,15),[100,0,20]);
   outline.dispose();
 }finally{world.dispose();}
});

test('bloom render targets follow preview pixel-ratio changes instead of staying at full retina resolution',async()=>{
 const {createScenePostprocessor}=await import('../scene-effects.js');
 const original=THREE.WebGLRenderTarget.prototype.setSize,targets=[];
 let ratio=2;
 THREE.WebGLRenderTarget.prototype.setSize=function(w,h,...args){
   const result=original.call(this,w,h,...args);
   if(this.texture.name==='EffectComposer.rt1')targets.push([this.width,this.height]);
   return result;
 };
 try{
   const renderer={getPixelRatio:()=>ratio,getSize:target=>target.set(800,600)};
   const post=createScenePostprocessor(renderer,new THREE.Scene(),new THREE.PerspectiveCamera());
   post.setSize(800,600);post.configure({bloom:{enabled:true,strength:.1,radius:0,threshold:.8}});
   assert.deepEqual(targets.at(-1),[1600,1200]);
   ratio=.75;post.setSize(800,600);
   assert.deepEqual(targets.at(-1),[600,450]);
 }finally{THREE.WebGLRenderTarget.prototype.setSize=original;}
});

test('shadow toggles preserve illumination, support opt-in point shadows and free shadow slots',async()=>{
 const scene=new THREE.Scene(),world=createPrimitiveWorld(scene);
 const specs=Array.from({length:5},(_,i)=>({...lights[2],id:'spot_'+i,
   castShadow:i!==0}));
 const source={schemaVersion:1,scenes:[{shotId:'test',objects:[unit('box','box')],lights:specs}]};
 try{
   world.setDocument(source);world.showShot('test');
   assert.equal(world.getLightNode('test','spot_0').castShadow,false);
   assert.equal(world.getLightNode('test','spot_0').intensity,120);
   assert.equal(world.getLightNode('test','spot_4').castShadow,true,
     'the disabled first light leaves a slot for the fifth');
   source.scenes[0].lights=[{...lights[1],id:'point',castShadow:true},
     {...lights[0],id:'sun',castShadow:false}];
   world.setDocument(source);
   const point=world.getLightNode('test','point'),sun=world.getLightNode('test','sun');
   assert.equal(point.castShadow,true);
   assert.equal(point.shadow.getViewportCount(),6);
   assert.equal(sun.castShadow,false);assert.equal(sun.intensity,1.2);
   const exported=await new GLTFExporter().parseAsync(world.getSceneForExport('test'),
     {binary:false,onlyVisible:false,trs:true});
   assert.equal(exported.nodes.find(n=>n.name==='Lamp').extras.castShadow,true);
   assert.equal(exported.nodes.find(n=>n.name==='Moonlight').extras.castShadow,false);
 }finally{world.dispose();}
});

test('assembly copies share prototype GPU resources and dispose each resource exactly once',()=>{
 const scene=new THREE.Scene(),world=createPrimitiveWorld(scene);
 const part=unit('head','sphere',{position:[0,3,0]});
 const assembly=unit('row','group',{repeat:{count:[20,1,1],spacing:[3,0,0]},
   arrayParts:{objects:[part],lights:[{...lights[2],id:'beam',castShadow:false}]}});
 world.setDocument({schemaVersion:1,scenes:[{shotId:'street',objects:[assembly]}]});
 world.showShot('street');
 const copies=world.getArrayInstances('street','row');
 assert.equal(copies.length,20);
 const heads=copies.map(copy=>copy.children.find(n=>n.isMesh));
 assert.ok(heads.every(n=>n.geometry===heads[0].geometry&&n.material===heads[0].material));
 assert.equal(new Set(heads.map(n=>n.id)).size,20,'copies remain individually pickable meshes');
 for(const copy of copies){
   const beam=copy.children.find(n=>n.isLight);
   assert.equal(beam.castShadow,false);assert.equal(beam.intensity,120);
 }
 const resources=[heads[0].geometry,heads[0].material];
 const disposals=[0,0];
 resources.forEach((resource,index)=>resource.addEventListener('dispose',()=>disposals[index]++));
 world.dispose();assert.deepEqual(disposals,[1,1]);
});

test('real Three.js shadow pass reuses static maps, refreshes edits, and preserves animated-world updates',async()=>{
 // Run the pinned renderer's real shadow traversal/dirty-flag algorithm.
 // Only the final GPU submission is replaced by counters; no FPS is inferred.
 const {WebGLShadowMap}=await import('three/src/renderers/webgl/WebGLShadowMap.js');
 const {world,root}=build(),scene=root.parent;
 const camera=new THREE.PerspectiveCamera(50,1,.1,1000);
 const casters=[];root.traverse(node=>{if(node.isLight&&node.castShadow)casters.push(node);});
 let passes=0,draws=0;
 const backend={
   getRenderTarget:()=>null,getActiveCubeFace:()=>0,getActiveMipmapLevel:()=>0,
   setRenderTarget:target=>{if(target)passes++;},clear(){},
   renderBufferDirect(){draws++;},properties:{get:()=>({})},
   state:{setBlending(){},setScissorTest(){},viewport(){},
     buffers:{color:{setClear(){}},depth:{setTest(){}}}}
 };
 const shadows=new WebGLShadowMap(backend,{update:object=>object.geometry},{maxTextureSize:8192});
 shadows.enabled=true;shadows.type=THREE.PCFSoftShadowMap;
 const frame=()=>{
   passes=draws=0;scene.updateMatrixWorld(true);camera.updateMatrixWorld();
   shadows.render(casters,scene,camera);return {passes,draws};
 };
 try{
   assert.equal(casters.length,2);
   assert.ok(casters.every(node=>!node.shadow.autoUpdate));
   const initial=frame();assert.equal(initial.passes,2);assert.ok(initial.draws>0);
   camera.position.x+=5;
   assert.deepEqual(frame(),{passes:0,draws:0},'orbiting reuses both cached maps');
   // Compare the previous continuous update behavior on the same scene.
   for(const node of casters)node.shadow.autoUpdate=true;
   assert.equal(frame().passes,2);assert.equal(frame().passes,2);
   for(const node of casters)node.shadow.autoUpdate=false;
   assert.equal(frame().passes,0);
   world.getObjectNode('s1','box').position.x+=2;world.invalidateShadows('s1');
   assert.equal(frame().passes,2,'moving geometry refreshes every affected shadow');
   assert.equal(frame().passes,0);
   world.setLightMarkersVisible(true);
   world.getLightMarker('s1','light_1').position.x+=3;
   world.updateLightVisuals(camera,720);
   assert.equal(frame().passes,2,'live light movement refreshes shadows');
   world.updateLightVisuals(camera,720);
   assert.equal(frame().passes,0,'unchanged light markers do not invalidate the cache');
   world.getLightTargetMarker('s1','light_1').position.z+=3;
   world.updateLightVisuals(camera,720);
   assert.equal(frame().passes,2,'aim target movement refreshes shadows');
   world.showShot('other');world.showShot('s1');assert.equal(frame().passes,2);
   world.setDocument({schemaVersion:1,scenes:[{shotId:'s1',objects:[],lights:[lights[0]]}]});
   assert.equal(world.getLightNode('s1','light_1').shadow.autoUpdate,true,
     'lights over the original animated world must keep updating');
 }finally{world.dispose();}
});

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
    const gizmo=scene.children.find(node=>node.isTransformControls);
    const sun=world.getLightNode('s1','light_1');
    sun.shadow.needsUpdate=false;
    gizmo.dispatchEvent({type:'objectChange'});
    assert.equal(sun.shadow.needsUpdate,true,'live transform invalidates cached shadows');
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

test('combining aligned lamp arrays keeps physical mesh coordinates and exports per-copy lights',async()=>{
 const {findArrayCompanions,saveArrayPrototype}=await import('../array-prototype.js');
 const array={count:[3,1,1],spacing:[8,0,0]};
 const pole=unit('pole','cylinder',{name:'Pole',position:[0,3,0],scale:[.3,6,.3],repeat:array});
 const bulb=unit('bulb','sphere',{name:'Bulb',position:[0,6.5,0],scale:[1,.5,1],repeat:array,
   material:{color:'#ffe4ad',metalness:.2,roughness:.55}});
 const before={schemaVersion:1,scenes:[{shotId:'s1',objects:[pole,bulb]}]};
 const scene1=new THREE.Scene(),world1=createPrimitiveWorld(scene1);
 world1.setDocument(before,['s1']);world1.showShot('s1');
 scene1.updateMatrixWorld(true);
 const originalPoints=world1.getArrayInstances('s1','bulb').map(node=>
   node.getWorldPosition(new THREE.Vector3()).toArray().map(round));
 const candidate=findArrayCompanions(before,'s1','pole')[0];
 assert.deepEqual(candidate.ids,['bulb']);
 const withLights={objects:[candidate.part],lights:[{
   id:'bulb_spot',type:'spot',name:'Lamp cone',
   color:'#ffefc9',intensity:100,position:[0,3.5,0],
   target:[0,-2,0],angle:.55,penumbra:.2,distance:25
 }]};
 const after=saveArrayPrototype(before,['s1'],'s1','pole',{
   name:pole.name,scale:pole.scale,material:pole.material,parts:withLights
 },['pole'],['bulb']);
 const scene2=new THREE.Scene(),world2=createPrimitiveWorld(scene2);
 world2.setDocument(after,['s1']);world2.showShot('s1');
 scene2.updateMatrixWorld(true);
 const instances=world2.getArrayInstances('s1','pole');
 assert.equal(instances.length,3);
 const mergedPoints=instances.map(node=>
   node.children.find(child=>child.name.startsWith('Bulb '))
     .getWorldPosition(new THREE.Vector3()).toArray().map(round));
 assert.deepEqual(mergedPoints,originalPoints,'real Three.js positions stay unchanged');
 const exportRoot=world2.getSceneForExport('s1');
 const gltf=await new GLTFExporter().parseAsync(exportRoot,{binary:false,onlyVisible:false});
 assert.equal(gltf.extensions.KHR_lights_punctual.lights.length,3);
 assert.equal(gltf.nodes.filter(n=>(n.name||'').startsWith('Bulb ')).length,3);
 world1.dispose();world2.dispose();
});


test('composite pine is one movable object, editable child meshes and exports all child nodes',async()=>{
 const {insertCreatedAsset}=await import('../scene-asset-catalog.js');
 const {setSceneObjectRepeat}=await import('../scene-object-operations.js');
 const blank={schemaVersion:1,scenes:[{shotId:'forest',objects:[]}]};
 const created=insertCreatedAsset(blank,'forest','vegetation','pine',[6,0,8]);
 const one=created.document.scenes[0].objects;
 assert.equal(one.length,1,'pine selects as one group');
 assert.equal(one[0].arrayParts.objects.length,1,'pine crown remains editable');
 const scene=new THREE.Scene(),world=createPrimitiveWorld(scene);
 try{
   world.setDocument(created.document,['forest']);
   world.showShot('forest');
   let top=world.getObjectNode('forest',one[0].id);
   assert.equal(top.type,'Group','root TransformControls moves whole group');
   let meshes=[];top.traverse(n=>{if(n.isMesh)meshes.push(n)});
   assert.equal(meshes.length,2,'trunk and crown drawn as separate real meshes');
   assert.equal(world.getArrayInstances('forest',one[0].id).length,0,
     'single composite is not mistakenly registered as a repeat array');
   const repeated=setSceneObjectRepeat(created.document,['forest'],'forest',
     one[0].id,[1,1,3],[0,0,8]);
   world.setDocument(repeated,['forest']);world.showShot('forest');
   const copies=world.getArrayInstances('forest',one[0].id);
   assert.equal(copies.length,3);
   for(const copy of copies){
     meshes=[];copy.traverse(n=>{if(n.isMesh)meshes.push(n)});
     assert.equal(meshes.length,2,'each repeated tree retains editable trunk and crown');
   }
   const exportRoot=world.getSceneForExport('forest');
   const gltf=await new GLTFExporter().parseAsync(exportRoot,
     {binary:false,onlyVisible:false});
   assert.ok(gltf.nodes.filter(n=>n.name?.includes('Crown')).length>=3,
     'all crown meshes survive glTF export');
 }finally{world.dispose();}
});


test('many repeated spotlights still shine and export without exceeding GPU shadow sampler budget',async()=>{
 const {MAX_PRIMITIVE_SHADOW_MAPS}=await import('../primitive-world.js');
 const cylinder=unit('streetlamp','cylinder',{name:'Streetlamp',scale:[.2,6,.2],
   repeat:{count:[8,1,4],spacing:[12,0,12]},
   arrayParts:{objects:[],lights:[{
     id:'lamp_spot',type:'spot',name:'Streetlamp Downlight',color:'#ffffff',
     intensity:180,position:[0,3,0],target:[0,0,0],angle:.55,penumbra:.2,distance:35
   }]}});
 const topLights=Array.from({length:9},(_,i)=>({
   type:'spot',name:'Editor spotlight '+i,color:'#fffddd',
   intensity:80,position:[i*3,10,0],target:[i*3,0,0],
   angle:.6,penumbra:.2,distance:35
 }));
 const doc={schemaVersion:1,scenes:[{shotId:'street',
   objects:[cylinder],lights:topLights}]};
 const scene=new THREE.Scene(),world=createPrimitiveWorld(scene);
 try{
   world.setDocument(doc,['street']);world.showShot('street');
   const root=world.getSceneForExport('street'),lights=[];
   root.traverse(x=>{if(x.isLight)lights.push(x);});
   assert.equal(lights.filter(x=>x.isSpotLight).length,41,
     'no manually authored or repeated lights are discarded');
   assert.ok(lights.filter(x=>x.castShadow).length<=MAX_PRIMITIVE_SHADOW_MAPS,
     'no excess shadow-map samplers can make WebGL shader fail validation');
   const exportData=await new GLTFExporter().parseAsync(root,{
     binary:false,onlyVisible:false});
   assert.ok(exportData.extensions.KHR_lights_punctual.lights.length>=2);
   assert.equal(exportData.nodes.filter(x=>x.name?.startsWith('Streetlamp Downlight')).length,32,
     'all 32 real lights remain in the exported GLTF nodes');
 }finally{world.dispose();}
});


test('Replace Assembly always resolves a real template when available, never blank placeholder',async()=>{
 const {resolveAssemblyTemplateSelection}=await import('../array-prototype-editor.js');
 const templates=[
   {id:'right_street',label:'Right Street Poles + Lamps'},
   {id:'right_ave',label:'Right Ave Trunks + Crowns'}
 ];
 assert.equal(resolveAssemblyTemplateSelection(templates,'').id,'right_street',
   'blank placeholder cannot make an enabled action silently do nothing');
 assert.equal(resolveAssemblyTemplateSelection(templates,'wrong_id').id,'right_street',
   'stale browser select values recover to a valid template');
 assert.equal(resolveAssemblyTemplateSelection(templates,'right_ave').id,'right_ave',
   'explicit user selection is never overridden');
 assert.equal(resolveAssemblyTemplateSelection([],''),null);
 const {readFile}=await import('node:fs/promises');
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 const editor=await readFile(new URL('../array-prototype-editor.js',import.meta.url),'utf8');
 assert.match(html,/id="arrayEditTemplateStatus"[^>]*role="status"/,
   'replacement failure must be displayed beside the action');
 assert.match(editor,/if\(!rerender\(\{refit:true\}\)\)/,
   'preview failure must block staging rather than showing fake success');
 assert.match(editor,/draft=backup\.draft;candidates=backup\.candidates/,
   'failed preview restores the previous draft');
});


test('mesh-free scene-graph assembly emits exactly its ordered children and punctual lights in GLB',async()=>{
 const group=unit('street_parent','group',{
   name:'South Edge',position:[12,0,20],rotation:[0,Math.PI/3,0],
   repeat:{count:[3,1,1],spacing:[8,0,0]},
   arrayParts:{objects:[
     unit('post','cylinder',{name:'South Edge Post',position:[0,3,0],scale:[.3,6,.3]}),
     unit('head','box',{name:'South Edge Lamp Housing',position:[0,6.6,0],
       scale:[1.5,.5,1.2]})
   ],lights:[{
     id:'warm',name:'South Edge Warm Light',type:'spot',color:'#ffedcc',
     intensity:170,position:[0,6.2,0],target:[0,0,0],angle:.7,
     penumbra:.3,distance:30
   }],order:['object:head','light:warm','object:post']}
 });
 const scene=new THREE.Scene(),world=createPrimitiveWorld(scene);
 try{
   world.setDocument({schemaVersion:1,scenes:[{shotId:'street',objects:[group]}]},['street']);
   world.showShot('street');
   const holder=world.getObjectNode('street','street_parent');
   assert.equal(holder.type,'Group','parent is a movable Three group, not a dummy mesh');
   const instances=world.getArrayInstances('street','street_parent');
   assert.equal(instances.length,3);
   for(const instance of instances){
     assert.deepEqual(instance.children.map(node=>node.name.replace(/ \d+$/,'')),
       ['South Edge Lamp Housing','South Edge Warm Light','South Edge Post'],
       'Outliner order controls physical child-node order');
     const meshes=instance.children.filter(n=>n.isMesh);
     assert.equal(meshes.length,2,'no invisible root mesh consumes mesh budget');
     assert.ok(instance.children[1].isSpotLight);
     assert.equal(instance.children[0].userData.primitiveArrayPartId,'head');
   }
   const gltf=await new GLTFExporter().parseAsync(world.getSceneForExport('street'),
     {binary:false,onlyVisible:false});
   assert.equal(gltf.nodes.filter(n=>n.name?.startsWith('South Edge Post')).length,3);
   assert.equal(gltf.nodes.filter(n=>n.name?.startsWith('South Edge Lamp Housing')).length,3);
   assert.equal(gltf.nodes.filter(n=>n.name==='South Edge Warm Light').length,3);
   assert.equal(gltf.extensions.KHR_lights_punctual.lights.length,3);
 }finally{world.dispose();}
});



test('rotating every array copy preserves world XYZ centers and authored repeat layout',async()=>{
 const layout=[0,Math.PI/3,0],spin=[0,Math.PI/2,0];
 const parent=unit('lamps','group',{
   name:'Row of lights',position:[15,3,-4],rotation:layout,
   instanceRotation:spin,repeat:{count:[3,1,1],spacing:[8,0,0]},
   arrayParts:{objects:[
     unit('pole','cylinder',{name:'Pole',position:[0,3,0]}),
     unit('head','box',{name:'Lamp head',position:[1,7,0]})
   ],lights:[]}
 });
 const plain=unit('cars','box',{
   name:'Repeated cars',position:[2,0,10],rotation:[0,.25,0],
   instanceRotation:spin,repeat:{count:[1,1,3],spacing:[0,0,9]}
 });
 const input={schemaVersion:1,scenes:[{shotId:'road',objects:[parent,plain]}]};
 const world=createPrimitiveWorld(new THREE.Scene());
 try{
   world.setDocument(input,['road']);world.showShot('road');
   const rows=world.getArrayInstances('road','lamps');
   assert.equal(rows.length,3);
   const expected=parent.repeat.count[0],root=world.getObjectNode('road','lamps');
   assert.equal(root.rotation.y,layout[1]);
   for(let i=0;i<expected;i++){
     const offset=(i-(expected-1)/2)*8;
     assert.ok(Math.abs(rows[i].position.x-offset)<1e-10);
     assert.ok(Math.abs(rows[i].position.z)<1e-10);
     assert.ok(Math.abs(rows[i].rotation.y-spin[1])<1e-10);
   }
   const vehicle=world.getObjectNode('road','cars');
   assert.ok(Math.abs(vehicle.rotation.y-.25)<1e-10);
   for(const copy of world.getArrayInstances('road','cars')){
     assert.ok(Math.abs(copy.rotation.y-spin[1])<1e-10);
   }
   const changed=structuredClone(input);
   changed.scenes[0].objects[0].instanceRotation=[0,0,Math.PI/2];
   world.setDocument(changed,['road']);world.showShot('road');
   const next=world.getArrayInstances('road','lamps');
   assert.deepEqual(next.map(c=>c.position.toArray()),rows.map((_,i)=>
     [(i-1)*8,0,0]),'copy positions are unchanged by per-object spin');
   assert.equal(world.getObjectNode('road','lamps').rotation.y,layout[1]);
   const gltf=await new GLTFExporter().parseAsync(world.getSceneForExport('road'),
     {binary:false,onlyVisible:false});
   assert.ok(gltf.nodes.some(node=>node.name?.includes('Lamp head')));
 }finally{world.dispose();}
});
