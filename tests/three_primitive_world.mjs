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
const document={schemaVersion:1,scenes:[{shotId:'s1',camera:{position:[0,5,20],target:[0,2,0],fov:40},objects:[
  unit('box','box'),unit('cone','cone'),unit('wedge','wedge'),unit('gable','gable'),
  unit('ell','extrude',{points:[[-.5,-.5],[.5,-.5],[.5,0],[0,0],[0,.5],[-.5,.5]]}),
  unit('clockwise','extrude',{points:[[-.5,-.5],[-.5,.5],[.5,.5],[.5,-.5]]}),
  {id:'windows',name:'Windows',primitive:'box',position:[10,5,0],rotation:[0,Math.PI/2,0],scale:[1,1.5,.1],
    repeat:{count:[4,3,1],spacing:[2,3,0]},
    material:{...mat,emissive:'#FFAA00',emissiveIntensity:2,opacity:.5}}
]}]};
function build(){
  const scene=new THREE.Scene(),world=createPrimitiveWorld(scene);
  world.setDocument(document,['s1'],{s1:[100,0,0]});
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

test('GLB export keeps shared copies, glass and glow', async () => {
  const {world}=build(),scene=world.getSceneForExport('s1');
  const gltf=await new GLTFExporter().parseAsync(scene,{binary:false});
  assert.equal(gltf.meshes.length,7,'one glTF mesh per object, reused by every copy');
  assert.ok(gltf.nodes.length>=6+12);
  const glass=gltf.materials.find(material=>material.alphaMode==='BLEND');
  assert.equal(glass.pbrMetallicRoughness.baseColorFactor[3],.5);
  assert.equal(glass.extensions.KHR_materials_emissive_strength.emissiveStrength,2);
  const glb=await new GLTFExporter().parseAsync(scene,{binary:true});
  assert.ok(glb.byteLength>1000);
  world.dispose();
});
