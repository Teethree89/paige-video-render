// Real Chromium, whole wizard: pin 8 corners in a rendered video of three boxes, pick the same
// corners on the 3D model with real clicks (snapping to corners), check the wipe compare, track
// the motion in the Worker, preview, and Apply. The result is compared with the TRUE camera path.
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
 // Cancel leaves everything untouched.
 await page.locator('#cameraTrackStart').click();
 await page.waitForSelector('#trackWizard:not([hidden]) #twFrameBox canvas',{timeout:30000});
 assert.equal(await page.getAttribute('#trackWizard','data-phase'),'video');
 await page.locator('#twCancel').click();
 await page.waitForSelector('#trackWizard',{state:'hidden'});
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('atoms-ai-sequence-v1')).camera),initial.camera,'cancel changes nothing');

 // ---- Step 1: pin corners in the video ----
 await page.locator('#cameraTrackStart').click();
 await page.waitForSelector('#trackWizard:not([hidden]) #twFrameBox canvas');
 assert.equal(await page.isDisabled('#twDone'),true,'Done needs at least 4 points');
 await page.evaluate(t=>{const r=document.getElementById('twTime');r.value=String(t);r.dispatchEvent(new Event('input'));},REF_TIME);
 await page.waitForFunction(t=>Math.abs((window.__atomsTrackWizard._state()?.refTime??-1)-t)<1e-3,REF_TIME,{timeout:20000});
 await page.waitForTimeout(400);
 assert.equal(Math.floor(REF_TIME*FPS),REF_FRAME);
 const refPose=lookAtPose(...Object.values(wizardPath(REF_FRAME/35)));
 const corners=[ // [model corner, name]: clear, well separated corners of this frame
   [[-8,8,5],'block top near-left'],[[8,8,5],'block top near-right'],[[8,0,5],'block bottom near-right'],
   [[4,16,0],'tower top near-left'],[[8,16,0],'tower top near-right'],
   [[-8,8,-5],'block top far-left'],[[-15,0,10],'annex bottom near-left'],[[-9,0,10],'annex bottom near-right']];
 const rect=await page.locator('#twFrameBox').boundingBox();
 for(const [X] of corners){
   const p=projectPoint(refPose,FOV,W,H,X);
   assert.ok(p&&p.x>5&&p.y>5&&p.x<W-5&&p.y<H-5,'corner is in frame: '+X);
   // Click a few pixels off the corner: the click must snap onto it.
   await page.mouse.click(rect.x+(p.x+3)/W*rect.width,rect.y+(p.y-2)/H*rect.height);
 }
 if(process.env.UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.UI_SCREENSHOT_DIR+'/wizard-1-video.png'});
 let pins=await page.evaluate(()=>window.__atomsTrackWizard._state().pins.map(p=>({x:p.x,y:p.y,snapped:p.snapped})));
 assert.equal(pins.length,8);
 corners.forEach(([X,name],i)=>{
   const p=projectPoint(refPose,FOV,W,H,X),err=Math.hypot(pins[i].x*W-p.x,pins[i].y*H-p.y);
   assert.ok(pins[i].snapped&&err<3.5,`${name}: snapped=${pins[i].snapped}, ${err.toFixed(2)} px from the true corner`);
 });
 await page.locator('#twDone').click();

 // ---- Step 2: pick the same corners on the model ----
 await page.waitForFunction(()=>window.__atomsTrackWizard.phase==='model');
 // Put the 3D view near the video camera so every corner is visible (a person would orbit).
 await page.evaluate(([p,t,f])=>window.__atomsSetView(p,t,f),[[-14,16,58],[-8,5,2],48]);
 await page.waitForTimeout(300);
 for(let i=0;i<corners.length;i++){
   const [X,name]=corners[i];
   const s=await page.evaluate(X=>window.__atomsProject(X),X);
   const c=await page.evaluate(b=>window.__atomsProject(b),boxes.find(b=>Math.abs(X[0]-b.center[0])<=b.size[0]/2+.01&&Math.abs(X[2]-b.center[2])<=b.size[2]/2+.01&&X[1]<=b.center[1]+b.size[1]/2+.01).center);
   const d=Math.hypot(c.x-s.x,c.y-s.y)||1,x=s.x+(c.x-s.x)/d*7,y=s.y+(c.y-s.y)/d*7; // 7 px inside the shape, off the exact corner
   await page.mouse.click(x,y);
   await page.waitForFunction(n=>window.__atomsTrackWizard._state().pins.filter(p=>p.X).length>=n,i+1,{timeout:10000}).catch(async e=>{
     if(process.env.UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.UI_SCREENSHOT_DIR+'/wizard-2-fail.png'});
     throw Error(`model pick failed for ${name} (click ${x.toFixed(0)},${y.toFixed(0)}, corner ${s.x.toFixed(0)},${s.y.toFixed(0)})`);
   });
 }
 pins=await page.evaluate(()=>window.__atomsTrackWizard._state().pins.map(p=>({X:p.X,s:p.modelSnapped})));
 corners.forEach(([X,name],i)=>{
   assert.ok(pins[i].s,`${name} snapped to a model corner`);
   assert.ok(len(pins[i].X.map((v,k)=>v-X[k]))<.05,`${name} picked at ${pins[i].X.map(v=>v.toFixed(2))} (want ${X})`);
 });
 assert.equal(await page.isDisabled('#twDone'),false);
 if(process.env.UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.UI_SCREENSHOT_DIR+'/wizard-2-model.png'});
 await page.locator('#twDone').click();

 // ---- Step 3: before/after wipe ----
 await page.waitForFunction(()=>window.__atomsTrackWizard.phase==='compare');
 const resection=await page.evaluate(()=>{const r=window.__atomsTrackWizard._state().resection;return {ok:r.ok,rms:r.rmsPx,fov:r.fov,ambiguous:r.ambiguous};});
 assert.ok(resection.ok&&resection.rms<2,'the model lines up with the video: '+JSON.stringify(resection));
 assert.ok(Math.abs(resection.fov-FOV)<4,'lens estimated near the true 50 deg: '+resection.fov);
 assert.equal(resection.ambiguous,false);
 assert.match(await page.textContent('#twStats'),/good match/);
 await page.locator('#twWipe').evaluate(el=>{el.value='30';el.dispatchEvent(new Event('input'));});
 assert.equal(await page.evaluate(()=>getComputedStyle(document.getElementById('trackWizard')).getPropertyValue('--wipe').trim()),'30%');
 assert.equal(await page.isVisible('#twVideoLayer[data-wipe="on"]'),true);
 if(process.env.UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.UI_SCREENSHOT_DIR+'/wizard-3-compare.png'});
 await page.locator('#twDone').click();

 // ---- Steps 4-5: track (forward and backward from the reference frame), preview ----
 await page.waitForFunction(()=>window.__atomsTrackWizard.phase==='preview',null,{timeout:240000});
 const preview=await page.evaluate(()=>{const s=window.__atomsTrackWizard._state(),r=s.proposal.report;
   return {report:r,keys:s.proposal.sequence.camera.filter(k=>k.at<3),other:s.proposal.sequence.camera.filter(k=>k.at>=3),stats:document.getElementById('twStats').textContent};});
 assert.ok(preview.report.updatedKeys>=2);
 assert.ok(preview.report.anchorRmsPx<6,'pinned points reproject onto their tracks: '+preview.report.anchorRmsPx);
 assert.match(preview.stats,/replace this chapter's \d+ current key/);
 // The 12 fps video shows frame floor(12 t) at chapter time t, and frame i was rendered at path(i/35).
 const truth=t=>wizardPath(Math.min(35,Math.floor(t*FPS+1e-9))/35).position;
 const extent=len(wizardPath(1).position.map((v,i)=>v-wizardPath(0).position[i]));
 let worstKey=0;
 for(const k of preview.keys){
   const err=len(k.p.map((v,i)=>v-truth(k.at)[i]))/extent*100;worstKey=Math.max(worstKey,err);
   assert.ok(err<7,`key at ${k.at}s is ${err.toFixed(1)}% of the path extent from the true camera`);
 }
 assert.ok(Math.abs(preview.keys.at(-1).fov-FOV)<4);
 assert.deepEqual(preview.other,initial.camera.filter(k=>k.at>=3),'the other chapter is untouched in the preview');
 if(process.env.UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.UI_SCREENSHOT_DIR+'/wizard-4-preview.png'});
 // Density changes the number of keys without tracking again.
 const counts={};
 for(const d of ['few','many']){await page.locator('#twDensity').selectOption(d);
   counts[d]=await page.evaluate(()=>window.__atomsTrackWizard._state().proposal.sequence.camera.filter(k=>k.at<3).length);}
 assert.ok(counts.few<=counts.many,JSON.stringify(counts));
 await page.locator('#twDensity').selectOption('normal');

 // ---- Apply: replaces ONLY chapter 1's keys ----
 await page.locator('#twApply').click();
 await page.waitForSelector('#trackWizard',{state:'hidden'});
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('atoms-ai-sequence-v1')));
 const mine=saved.camera.filter(k=>k.at<3);
 assert.ok(mine.length>=2&&mine.every(k=>k.generated==='video-track'),'chapter 1 now has tracked keys only');
 assert.ok(initial.camera.filter(k=>k.at<3).every(old=>!mine.some(k=>k.id===old.id)),'the old chapter keys are gone');
 assert.deepEqual(saved.camera.filter(k=>k.at>=3),initial.camera.filter(k=>k.at>=3),'chapter 2 camera untouched');
 assert.equal(saved.shots[0].cameraSync.mode,'anchored-track');
 assert.equal(saved.shots[0].trackingPins.points.length,8);
 assert.deepEqual(saved.primitiveScenes,initial.primitiveScenes,'the model is untouched');
 await page.waitForSelector('#chapterNameCard:not([hidden])',{timeout:10000});
 // Undo restores the old keys.
 await page.keyboard.press('Control+z');
 assert.ok(errors.length===0,errors.join('\n'));
 console.log('PASS: camera tracking wizard (pin, match, compare, track, preview, apply)',JSON.stringify({keys:mine.length,anchorRmsPx:preview.report.anchorRmsPx,matchRmsPx:+resection.rms.toFixed(2),worstKeyErrorPct:+worstKey.toFixed(2)}));
}finally{await browser?.close();server.close();}
