// Real Chromium, rectangle pins: mark the 4 corners of a box face in the rendered video with the
// Rectangle tool, then match all 4 on the model with ONE click on that face, add two single points,
// and check the camera solved from them. Local only, no provider call.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDraftTimeline} from '../../shot-analysis.js';
import {WIZARD_BOXES,wizardPath} from '../camera-track-fixtures.mjs';
import {lookAtPose} from '../../camera-track-solver.js';
import {projectPoint} from '../../camera-resection.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const three=resolve(process.env.THREE_NODE_MODULES,'three');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.mp4':'video/mp4'};
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://local');
  if(url.pathname==='/scene-proxy.php'){res.setHeader('Content-Type','application/json');res.end('{"ok":true,"authenticated":false,"csrf":"x"}');return;}
  if(url.pathname==='/blank'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>wizard</title>');return;}
  const path=url.pathname.startsWith('/three/')?resolve(three,url.pathname.slice(7)):resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
  if(!path.startsWith(root+'/')&&!path.startsWith(three+'/'))throw Error('Invalid path');
  let content=await readFile(path);
  if(path.endsWith('/index.html'))content=content.toString().replaceAll('https://cdn.jsdelivr.net/npm/three@0.166.1','/three');
  res.setHeader('Content-Type',mime[extname(path)]||'application/octet-stream');res.end(content);
 }catch{res.statusCode=404;res.end('Unavailable');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const W=480,H=270,FPS=12,REF_FRAME=14,REF_TIME=1.1988,FOV=50; // 1.1988 s (a slider step) is inside frame 14 of the 12 fps video: both tracking passes run
const len=v=>Math.hypot(...v);
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,
  args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const errors=[];
 const context=await browser.newContext({viewport:{width:1365,height:900}});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://**/*',route=>route.abort());
 // Project: two chapters; chapter 1 (0-3 s) is the boxes video with a model of the same three boxes.
 await page.goto(base+'/blank');
 const boxes=WIZARD_BOXES;
 await page.evaluate(async boxes=>{
   const {createSingleVideoStore}=await import('/single-video-source.js');
   const {createDraftTimeline}=await import('/shot-analysis.js');
   const file=new File([await (await fetch('/tests/fixtures/track-boxes.mp4')).blob()],'track-boxes.mp4',{type:'video/mp4'});
   const timeline=createDraftTimeline({duration:6,cuts:[3],title:'Wizard test'});
   timeline.camera.forEach(k=>{k.fov=50;}); // the chapter's lens: the wizard matches points at this zoom by default
   timeline.videoIntake.sourceId='wizard-source';timeline.videoIntake.sourceName=file.name;
   timeline.primitiveScenes={schemaVersion:1,scenes:[{shotId:'draft_001',objects:boxes.map(b=>({id:b.id,name:b.id,primitive:'box',
     position:b.center,rotation:[0,0,0],scale:b.size,material:{color:'#8899aa',metalness:.1,roughness:.7}}))}]};
   await createSingleVideoStore().save('wizard-source',file);
   localStorage.setItem('atoms-ai-sequence-v1',JSON.stringify(timeline));
 },boxes);
 const initial=await page.evaluate(()=>JSON.parse(localStorage.getItem('atoms-ai-sequence-v1')));
 await page.goto(base+'/');
 await page.waitForFunction(()=>window.__atomsEditorStarted===true,null,{timeout:60000});
 if(await page.locator('#workspaceStartDialog').isVisible())await page.locator('#workspaceStartClose').click();
 await page.locator('#inspectorMotionButton').click();
 await page.waitForFunction(()=>!document.getElementById('cameraTrackStart').disabled,null,{timeout:30000});
 assert.equal(await page.isVisible('#cameraTrackStart'),true);

 await page.locator('#cameraTrackStart').click();
 await page.waitForSelector('#trackWizard:not([hidden]) #twFrameBox canvas',{timeout:30000});
 await page.evaluate(t=>{const r=document.getElementById('twTime');r.value=String(t);r.dispatchEvent(new Event('input'));},REF_TIME);
 await page.waitForFunction(t=>Math.abs((window.__atomsTrackWizard._state()?.refTime??-1)-t)<1e-3,REF_TIME,{timeout:20000});
 await page.waitForTimeout(400);
 const refPose=lookAtPose(...Object.values(wizardPath(REF_FRAME/35)));
 const face=[[8,8,5],[-8,8,5],[-8,0,5],[8,0,5]]; // block front face, clicked from the top right, going around
 const singles=[[4,16,0],[8,16,0]];              // tower top corners
 const rect=await page.locator('#twFrameBox').boundingBox();
 const clickVideo=async X=>{const p=projectPoint(refPose,FOV,W,H,X);assert.ok(p&&p.x>5&&p.y>5&&p.x<W-5&&p.y<H-5,'in frame: '+X);
   await page.mouse.click(rect.x+(p.x+3)/W*rect.width,rect.y+(p.y-2)/H*rect.height);};

 // With the viewport tool strip (Orbit / Point), only the Point tool places pins; Orbit leaves the frame and model alone.
 const hasTools=await page.evaluate(()=>!!window.__atomsViewportTools);
 const tool=async key=>{await page.evaluate(()=>document.activeElement?.blur?.());await page.keyboard.press(key);};
 const pinCount=()=>page.evaluate(()=>window.__atomsTrackWizard._state().pins.length);

 // ---- Step 1: Rectangle tool ----
 assert.equal(await page.isVisible('#twToolRow'),true);
 await page.locator('#twToolRect').click();
 assert.equal(await page.getAttribute('#twToolRect','aria-pressed'),'true');
 if(hasTools){
   await tool('KeyO');assert.equal(await page.evaluate(()=>window.__atomsViewportTools.tool),'orbit');
   await clickVideo(face[0]);assert.equal(await pinCount(),0,'Orbit does not place a rectangle corner');
   await tool('KeyP');assert.equal(await page.evaluate(()=>window.__atomsViewportTools.tool),'point');
 }
 for(const X of face.slice(0,3))await clickVideo(X);
 assert.equal(await page.isDisabled('#twDone'),true,'Done waits for the 4th corner');
 assert.match(await page.textContent('#twStatus'),/Rectangle A: 3 of 4 corners/);
 assert.equal(await page.locator('.tw-quads polyline[data-state="draft"]').count(),1,'unfinished outline');
 await clickVideo(face[3]);
 assert.equal(await page.locator('.tw-quads polygon').count(),1,'closed outline');
 await page.locator('#twToolPoint').click();
 for(const X of singles)await clickVideo(X);
 let pins=await page.evaluate(()=>window.__atomsTrackWizard._state().pins.map(p=>({x:p.x,y:p.y,snapped:p.snapped,rect:p.rect||null})));
 assert.equal(pins.length,6);
 assert.equal(new Set(pins.slice(0,4).map(p=>p.rect)).size,1);assert.ok(pins[0].rect);assert.equal(pins[4].rect,null);
 [...face,...singles].forEach((X,i)=>{const p=projectPoint(refPose,FOV,W,H,X),err=Math.hypot(pins[i].x*W-p.x,pins[i].y*H-p.y);
   assert.ok(pins[i].snapped&&err<3.5,`video point ${i+1}: ${err.toFixed(2)} px`);});
 assert.match(await page.textContent('#twPoints'),/rectangle A corner 1/);assert.doesNotMatch(await page.textContent("#twPoints"),/corner 1 · corner/);
 if(process.env.UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.UI_SCREENSHOT_DIR+'/rect-1-video.png'});
 await page.locator('#twDone').click();

 // ---- Step 2: one click on the face matches the whole rectangle ----
 await page.waitForFunction(()=>window.__atomsTrackWizard.phase==='model');
 assert.equal(await page.isVisible('#twToolRow'),false);
 await page.evaluate(([p,t,f])=>window.__atomsSetView(p,t,f),[[-14,16,58],[-8,5,2],48]);
 await page.waitForTimeout(300);
 const s=await page.evaluate(X=>window.__atomsProject(X),[-2,5,5]);
 if(hasTools){
   await tool('KeyO');await page.mouse.click(s.x,s.y);await page.waitForTimeout(300);
   assert.equal(await page.evaluate(()=>window.__atomsTrackWizard._state().pins.filter(p=>p.X).length),0,'Orbit does not match the face');
   await tool('KeyP');
 }
 await page.mouse.click(s.x,s.y);
 await page.waitForFunction(()=>window.__atomsTrackWizard._state().pins.filter(p=>p.X).length>=4,null,{timeout:10000});
 const picked=()=>page.evaluate(()=>window.__atomsTrackWizard._state().pins.map(p=>p.X));
 let X=await picked();
 face.forEach((want,i)=>assert.ok(len(X[i].map((v,k)=>v-want[k]))<1e-3,`corner ${i+1} matched at ${X[i]} (want ${want})`));
 assert.equal(X[4],null,'single points are still to do');
 assert.equal(await page.isVisible('#twRotate'),true);
 // Turn rectangle steps through the other corner orders and comes back round.
 await page.locator('#twRotate').click();
 X=await picked();
 assert.ok(face.some((want,i)=>len(X[i].map((v,k)=>v-want[k]))>1),'turned');
 for(let i=0;i<7;i++)await page.locator('#twRotate').click();
 X=await picked();
 face.forEach((want,i)=>assert.ok(len(X[i].map((v,k)=>v-want[k]))<1e-3,'back to the first order'));
 for(let i=0;i<singles.length;i++){
   const Y=singles[i],sp=await page.evaluate(X=>window.__atomsProject(X),Y),c=await page.evaluate(X=>window.__atomsProject(X),[6,8,-2]);
   const d=Math.hypot(c.x-sp.x,c.y-sp.y)||1;
   await page.mouse.click(sp.x+(c.x-sp.x)/d*7,sp.y+(c.y-sp.y)/d*7);
   await page.waitForFunction(n=>window.__atomsTrackWizard._state().pins.filter(p=>p.X).length>=n,5+i,{timeout:10000});
 }
 X=await picked();
 singles.forEach((want,i)=>assert.ok(len(X[4+i].map((v,k)=>v-want[k]))<.05,`tower corner ${i+1} at ${X[4+i]}`));
 if(process.env.UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.UI_SCREENSHOT_DIR+'/rect-2-model.png'});
 await page.locator('#twDone').click();

 // ---- Step 3: the camera solved from the rectangle and two points ----
 await page.waitForFunction(()=>window.__atomsTrackWizard.phase==='compare');
 const res=await page.evaluate(()=>{const r=window.__atomsTrackWizard._state().resection;return {ok:r.ok,rms:r.rmsPx,center:r.center,ambiguous:r.ambiguous};});
 assert.ok(res.ok&&res.rms<2,'lines up: '+JSON.stringify(res));
 const truthCenter=wizardPath(REF_FRAME/35).position;
 assert.ok(len(res.center.map((v,k)=>v-truthCenter[k]))<1.5,`camera at ${res.center.map(v=>v.toFixed(2))}, true ${truthCenter.map(v=>v.toFixed(2))}`);
 assert.deepEqual(errors,[]);
 console.log(`tool strip ${hasTools?'checked':'absent'} · rectangle pins: rms ${res.rms.toFixed(2)} px, camera ${len(res.center.map((v,k)=>v-truthCenter[k])).toFixed(2)} from the truth`);
}finally{
 await browser?.close();server.close();
}
