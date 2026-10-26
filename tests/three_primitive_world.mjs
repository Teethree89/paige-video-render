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
