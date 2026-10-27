// Real WebGL occlusion regression. Run with THREE_NODE_MODULES and
// PLAYWRIGHT_MODULE set to the pinned Three.js and Playwright installations.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
// LEGACY_POOL_BIAS=1 restores the old bias and must fail the pixel assertion.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const three=resolve(process.env.THREE_NODE_MODULES,'three');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/'){
   res.setHeader('Content-Type','text/html');
   res.end(`<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>`);return;
  }
  const path=req.url.startsWith('/three/')?resolve(three,req.url.slice(7)):resolve(root,'.'+req.url);
  if(!path.startsWith(root+'/')&&!path.startsWith(three+'/'))throw Error('path');
  res.setHeader('Content-Type','text/javascript');res.end(await readFile(path));
 }catch{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 const rows=await page.evaluate(async legacy=>{
  const THREE=await import('three');
  const {applyShotEffects}=await import('/scene-effects.js');
  const scene=new THREE.Scene(),root=new THREE.Group();root.userData.shotId='test';scene.add(root);
  // A hidden base under raised pavement must not add a second glow.
  const base=new THREE.Mesh(new THREE.PlaneGeometry(80,80),new THREE.MeshBasicMaterial({color:0x09121a}));
  base.rotation.x=-Math.PI/2;base.userData.layer='ground';root.add(base);
  const road=new THREE.Mesh(new THREE.BoxGeometry(40,.2,40),base.material);
  road.position.y=.1;road.userData.layer='ground';root.add(road);
  const light=new THREE.SpotLight(0xffd2a0,320,32,.7);light.position.set(0,8,0);
  light.userData.primitiveLight='spot';root.add(light,light.target);
  const renderer=new THREE.WebGLRenderer({antialias:false});renderer.setSize(512,512);
  const target=new THREE.WebGLRenderTarget(512,512);renderer.setRenderTarget(target);
  const camera=new THREE.PerspectiveCamera(45,1,.35,2000);
  const fx={lights:{enabled:true,spot:true,spotMode:'fake',fakeBeams:false},shadows:{enabled:false}};
  scene.updateMatrixWorld(true);applyShotEffects(scene,renderer,fx,{camera,shotId:'test'});
  const pool=scene.getObjectByName('Fake spotlight ground pools');
  if(legacy){pool.material.polygonOffset=true;pool.material.polygonOffsetFactor=-2;pool.material.polygonOffsetUnits=-2;}
  const results=[];
  for(const slope of [0,.08]){
   root.rotation.z=slope;root.userData.fakeGroundVersion=(root.userData.fakeGroundVersion||0)+1;
   scene.updateMatrixWorld(true);applyShotEffects(scene,renderer,fx,{camera,shotId:'test'});
   const inverse=root.matrixWorld.clone().invert(),point=new THREE.Vector3();
   const all=pool.geometry,positions=all.getAttribute('position'),index=all.getIndex();
   const top=all.clone(),indices=[];
   for(let i=0;i<index.count;i+=3){
    if(point.fromBufferAttribute(positions,index.getX(i)).applyMatrix4(inverse).y>.1)indices.push(index.getX(i),index.getX(i+1),index.getX(i+2));
   }
   top.setIndex(indices);
   const render=geometry=>{
    pool.geometry=geometry;renderer.render(scene,camera);
    const pixels=new Uint8Array(512*512*4);renderer.readRenderTargetPixels(target,0,0,512,512,pixels);return pixels;
   };
   for(const elevation of [.2,.45])for(const near of [.01,.35,2])for(const distance of [20,40,80,120,200]){
    camera.near=near;camera.position.set(0,distance*elevation,distance);camera.lookAt(0,0,0);camera.updateProjectionMatrix();
    const actual=render(all),reference=render(top);let wrong=0,maxDelta=0;
    for(let i=0;i<actual.length;i+=4){
     const delta=Math.max(...[0,1,2].map(c=>Math.abs(actual[i+c]-reference[i+c])));
     if(delta>2)wrong++;maxDelta=Math.max(maxDelta,delta);
    }
    pool.visible=false;const dark=render(top);pool.visible=true;
    let lit=0;for(let i=0;i<reference.length;i+=4)if(reference[i]>dark[i]+2)lit++;
    results.push({slope,elevation,near,distance,wrong,maxDelta,lit});
   }
   pool.geometry=all;top.dispose();
  }
  // Smoke the beam shader after starting with beams disabled as well.
  fx.lights.fakeBeams=true;
  applyShotEffects(scene,renderer,fx,{camera,shotId:'test'});renderer.render(scene,camera);
  pool.geometry.dispose();target.dispose();renderer.dispose();
  return results;
 },process.env.LEGACY_POOL_BIAS==='1');
 console.log(JSON.stringify({views:rows.length,leakingViews:rows.filter(r=>r.wrong),minLitPixels:Math.min(...rows.map(r=>r.lit))},null,2));
 assert.deepEqual(errors,[],'WebGL shaders compile without browser errors');
 assert.ok(rows.every(r=>r.lit>10),'visible receiver retains its light pool at every camera position');
 assert.equal(rows.reduce((n,row)=>n+row.wrong,0),0,'buried ground decals must remain occluded throughout camera approach');
}finally{
 await browser?.close();await new Promise(r=>server.close(r));
}
