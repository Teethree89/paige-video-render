// Real Chromium: switching View -> Edit keeps the camera exactly where it was
// (timeline camera at the playhead, or the user's orbit pose), and a camera key
// added in Edit mode uses that pose. Local only.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDraftTimeline} from '../../shot-analysis.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const three=resolve(process.env.THREE_NODE_MODULES,'three');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://local');
  if(url.pathname==='/scene-proxy.php'){res.setHeader('Content-Type','application/json');res.end('{"ok":true,"authenticated":false,"csrf":"x"}');return;}
  const path=url.pathname.startsWith('/three/')?resolve(three,url.pathname.slice(7)):resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
  if(!path.startsWith(root+'/')&&!path.startsWith(three+'/'))throw Error('Invalid path');
  let content=await readFile(path);
  if(path.endsWith('/index.html'))content=content.toString().replaceAll('https://cdn.jsdelivr.net/npm/three@0.166.1','/three');
  res.setHeader('Content-Type',mime[extname(path)]||'application/octet-stream');res.end(content);
 }catch{res.statusCode=404;res.end('Unavailable');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,
  args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const seq=createDraftTimeline({duration:6,cuts:[3],title:'Edit camera'});
 seq.primitiveScenes={schemaVersion:1,scenes:[{shotId:'draft_001',objects:[
   {id:'block',name:'Block',primitive:'box',position:[0,4,0],rotation:[0,0,0],scale:[16,8,10],material:{color:'#4a6a88',metalness:.1,roughness:.7}}]}]};
 // A distinctive timeline camera that the old behaviour would have replaced.
 seq.camera=seq.camera.filter(k=>k.at>=3);
 seq.camera.unshift({id:'k0',at:0,p:[40,12,-30],t:[2,3,1],fov:37,cut:true},{id:'k1',at:2.9,p:[44,14,-26],t:[2,3,1],fov:37});
 const page=await browser.newPage({viewport:{width:1365,height:900}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(s=>{if(!sessionStorage.getItem('seeded')){localStorage.setItem('atoms-ai-sequence-v1',s);sessionStorage.setItem('seeded','1');}},JSON.stringify(seq));
 await page.goto(base+'/');
 await page.waitForFunction(()=>window.__atomsEditorStarted===true,null,{timeout:60000});
 if(await page.locator('#workspaceStartDialog').isVisible())await page.locator('#workspaceStartClose').click();
 await page.waitForTimeout(500);
 const pose=()=>page.evaluate(()=>window.__atomsCameraPose());
 const close=(a,b,msg)=>{for(let i=0;i<3;i++)assert.ok(Math.abs(a.p[i]-b.p[i])<1e-3&&Math.abs(a.t[i]-b.t[i])<1e-3,msg+' '+JSON.stringify([a,b]));assert.ok(Math.abs(a.fov-b.fov)<1e-3,msg+' fov');};
 // 1. View mode at the playhead, then Edit: same camera.
 const view=await pose();
 assert.ok(Math.abs(view.fov-37)<.01&&view.p[0]>35,'the timeline camera is showing: '+JSON.stringify(view));
 await page.locator('#sceneModeEdit').click();
 await page.waitForSelector('#sceneEditTools:not([hidden])');
 await page.waitForTimeout(300);
 close(await pose(),view,'Edit keeps the View camera');
 // 2. Adding a camera key in Edit mode records that exact pose.
 const keysBefore=await page.evaluate(()=>JSON.parse(localStorage.getItem('atoms-ai-sequence-v1')).camera.map(k=>k.id));
 await page.locator('#addCameraBtn').click();
 await page.waitForFunction(n=>JSON.parse(localStorage.getItem('atoms-ai-sequence-v1')).camera.length>n,keysBefore.length);
 const keyed=await page.evaluate(ids=>JSON.parse(localStorage.getItem('atoms-ai-sequence-v1')).camera.find(k=>!ids.includes(k.id)),keysBefore);
 assert.ok(keyed,'a camera key was added in Edit mode');
 for(let i=0;i<3;i++)assert.ok(Math.abs(keyed.p[i]-view.p[i])<.01,'the new key uses the Edit-mode camera: '+JSON.stringify([keyed.p,view.p]));
 // 3. Back to View returns to the timeline camera; Orbit pose survives a switch into Edit.
 await page.locator('#sceneModeView').click();
 await page.waitForTimeout(300);
 await page.locator('#inspectBtn').click();
 await page.mouse.move(140,260);await page.mouse.down();await page.mouse.move(300,230,{steps:8});await page.mouse.up();await page.waitForTimeout(300);
 // Orbit damping keeps coasting for a moment after release: wait until the camera is still.
 let orbited=await pose();
 for(let i=0;i<40;i++){await page.waitForTimeout(100);const next=await pose();
   if(next.p.every((v,k)=>Math.abs(v-orbited.p[k])<1e-6))break;orbited=next;}
 assert.ok(Math.abs(orbited.p[0]-view.p[0])>.05,'orbiting moved the camera');
 await page.locator('#sceneModeEdit').click();
 await page.waitForTimeout(300);
 close(await pose(),orbited,'Edit keeps the orbit pose');
 assert.deepEqual(errors,[]);
 console.log('PASS: Edit mode keeps the current view camera');
}finally{await browser?.close();server.close();}
