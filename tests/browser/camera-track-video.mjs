// Real Chromium: decode tests/fixtures/track-orbit.mp4, track features in the
// module Web Worker, solve the camera and check the orbit is recovered.
// Also checks the editor's tracking panel on a draft chapter. Local only:
// no provider, upload or network access beyond this test server.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDraftTimeline} from '../../shot-analysis.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const three=resolve(process.env.THREE_NODE_MODULES,'three');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.mp4':'video/mp4'};
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://local');
  if(url.pathname==='/scene-proxy.php'){res.setHeader('Content-Type','application/json');res.end('{"ok":true,"authenticated":false,"csrf":"x"}');return;}
  if(url.pathname==='/blank'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>track</title>');return;}
  const path=url.pathname.startsWith('/three/')?resolve(three,url.pathname.slice(7)):
    resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
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
 const page=await browser.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/blank');
 const result=await page.evaluate(async()=>{
   const {trackChapterCamera}=await import('/camera-track-ui.js');
   // The editor tracks local object URLs (cached File / Reference Builder media), not HTTP ranges.
   const url=URL.createObjectURL(await (await fetch('/tests/fixtures/track-orbit.mp4')).blob());
   const progress=[];
   const out=await trackChapterCamera({start:0,end:3},{url,toSourceTime:t=>t},
     {onProgress:p=>progress.push(p.phase)});
   return {motion:out.motion,summary:out.summary,size:out.size,phases:[...new Set(progress)]};
 });
 assert.deepEqual(result.phases,['tracking','solving']);
 assert.equal(result.size.width,480);
 assert.equal(result.summary.mode,'parallax');
 assert.equal(result.motion.type,'orbit',JSON.stringify(result.summary));
 assert.equal(result.motion.source,'feature-track');
 assert.ok(Math.abs(result.summary.fov-50)<6,'lens estimate near the rendered 50° FOV: '+result.summary.fov);
 assert.ok(result.summary.posed===result.summary.keyframes,'every keyframe posed');

 // Editor, step 3 end to end: cached local source + accepted geometry ->
 // Track -> staged preview (placeholder camera) -> Apply -> chapter asks for a name.
 const context=await browser.newContext({viewport:{width:1365,height:900}});
 const editor=await context.newPage();
 editor.on('pageerror',e=>errors.push(e.message));
 await editor.goto(base+'/blank');
 await editor.evaluate(async()=>{
   const {createSingleVideoStore}=await import('/single-video-source.js');
   const {createDraftTimeline}=await import('/shot-analysis.js');
   const file=new File([await (await fetch('/tests/fixtures/track-orbit.mp4')).blob()],'track-orbit.mp4',{type:'video/mp4'});
   const timeline=createDraftTimeline({duration:3,title:'Track regression'});
   timeline.videoIntake.sourceId='track-source';timeline.videoIntake.sourceName=file.name;
   timeline.primitiveScenes={schemaVersion:1,scenes:[{shotId:'draft_001',objects:[
     {id:'block',name:'Main block',primitive:'box',position:[0,4,0],rotation:[0,0,0],scale:[16,8,10],material:{color:'#4a6a88',metalness:.1,roughness:.7}},
     {id:'tower',name:'Tower',primitive:'box',position:[6,8,-2],rotation:[0,0,0],scale:[4,16,4],material:{color:'#6a7a88',metalness:.1,roughness:.7}}]}]};
   await createSingleVideoStore().save('track-source',file);
   localStorage.setItem('atoms-ai-sequence-v1',JSON.stringify(timeline));
 });
 await editor.route('https://**/*',route=>route.abort());
 await editor.goto(base+'/');
 await editor.waitForFunction(()=>window.__atomsEditorStarted===true);
 await editor.locator('#inspectorMotionButton').click();
 await editor.waitForFunction(()=>!document.getElementById('cameraTrackStart').disabled,null,{timeout:30000});
 assert.equal(await editor.isVisible('#chapterPendingOverlay'),true,'chapter is pending before tracking');
 assert.match(await editor.textContent('#chapterPendingTitle'),/not yet been camera tracked/);
 await editor.locator('#cameraTrackStart').click();
 await editor.waitForFunction(()=>/^Tracked /.test(document.getElementById('cameraTrackStatus').textContent),null,{timeout:180000});
 const status=await editor.textContent('#cameraTrackStatus');
 assert.match(status,/^Tracked orbit/,status);
 assert.match(status,/Preview staged/,status);
 const saved=await editor.evaluate(()=>JSON.parse(localStorage.getItem('atoms-ai-sequence-v1')).shots[0].videoCameraMotion);
 assert.equal(saved.source,'feature-track');assert.equal(saved.type,'orbit');
 assert.equal(await editor.isDisabled('#acceptedCameraSyncApply'),false,'tracked preview is staged for Apply');
 const before=await editor.evaluate(()=>JSON.parse(localStorage.getItem('atoms-ai-sequence-v1')).camera.map(k=>k.generated));
 assert.ok(before.every(g=>g==='placeholder'),'staging alone changes no saved keys');
 await editor.locator('#acceptedCameraSyncApply').click();
 await editor.waitForFunction(()=>JSON.parse(localStorage.getItem('atoms-ai-sequence-v1')).camera.some(k=>k.generated==='video-track'));
 await editor.waitForSelector('#chapterNameCard:not([hidden])');
 assert.equal(await editor.isVisible('#chapterPendingOverlay'),false);
 if(process.env.UI_SCREENSHOT_DIR)await editor.screenshot({path:process.env.UI_SCREENSHOT_DIR+'/tracked-name.png'});
 // Clip library: chips, two versions (track, then applied camera), restore.
 await editor.locator('#inspectorSourceButton').click();
 const item=editor.locator('#clipLibraryList .clip-item').first();
 await editor.waitForFunction(()=>/2 versions/.test(document.querySelector('#clipLibraryList .clip-item')?.textContent||''),null,{timeout:30000});
 assert.deepEqual(await item.locator('.clip-chip.on').allTextContents(),['3D','CAM · TRACKED','2 versions','IN PROJECT']);
 await editor.waitForSelector('#clipLibraryList .clip-item .clip-thumb img',{timeout:30000});
 await item.locator('.clip-main').click();
 await editor.waitForSelector('#clipLibraryList .clip-version.original');
 const versions=await item.locator('.clip-version:not(.original) span').allTextContents();
 assert.match(versions[0],/^v2 · Camera keys applied/);assert.match(versions[1],/^v1 · Camera tracked from video/);
 if(process.env.UI_SCREENSHOT_DIR)await editor.screenshot({path:process.env.UI_SCREENSHOT_DIR+'/clip-library.png'});
 await item.locator('.clip-version:not(.original) button').nth(1).click();
 await editor.waitForFunction(()=>JSON.parse(localStorage.getItem('atoms-ai-sequence-v1')).camera.every(k=>k.generated==='placeholder'));
 await editor.waitForSelector('#chapterPendingOverlay:not([hidden])');
 assert.match(await editor.textContent('#clipLibraryStatus'),/Restored v1/);
 await context.close();

 // A draft video chapter without its cached source explains how to track.
 const seq=createDraftTimeline({duration:6,cuts:[3],title:'track test'});
 seq.videoIntake={...seq.videoIntake,sourceId:'missing-source',sourceName:'missing.mp4'};
 const missing=await browser.newPage({viewport:{width:1365,height:900}});
 missing.on('pageerror',e=>errors.push(e.message));
 await missing.addInitScript(s=>{if(!sessionStorage.getItem('seeded')){localStorage.setItem('atoms-ai-sequence-v1',s);sessionStorage.setItem('seeded','1');}},JSON.stringify(seq));
 await missing.goto(base+'/');
 await missing.waitForFunction(()=>window.__atomsEditorStarted===true);
 await missing.locator('#inspectorMotionButton').click();
 await missing.waitForSelector('#cameraTrackPanel:not([hidden])',{timeout:30000});
 assert.equal(await missing.isDisabled('#cameraTrackStart'),true);
 assert.match(await missing.textContent('#cameraTrackStatus'),/source video is not attached/);
 // An imported JSON with no video info at all: the panel is still there and works with a chosen file.
 const plain={title:'Imported JSON',duration:3,fps:30,
   shots:[{id:'shot_a',start:0,end:3,name:'Hand built',title:'HAND BUILT',tone:'teal'}],
   camera:[{id:'c1',at:0,p:[0,5,22],t:[0,3,0],fov:55,cut:true},{id:'c2',at:2.9,p:[0,5,18],t:[0,3,0],fov:55}],text:[]};
 const importer=await browser.newPage({viewport:{width:1365,height:900}});
 importer.on('pageerror',e=>errors.push(e.message));
 await importer.addInitScript(s=>{if(!sessionStorage.getItem('seeded')){localStorage.setItem('atoms-ai-sequence-v1',s);sessionStorage.setItem('seeded','1');}},JSON.stringify(plain));
 await importer.goto(base+'/');
 await importer.waitForFunction(()=>window.__atomsEditorStarted===true);
 await importer.locator('#inspectorMotionButton').click();
 await importer.waitForSelector('#cameraTrackPanel:not([hidden])',{timeout:30000});
 assert.equal(await importer.isDisabled('#cameraTrackStart'),true);
 assert.match(await importer.textContent('#cameraTrackStatus'),/Choose the video this timeline came from/);
 await importer.locator('#cameraTrackFile').setInputFiles(resolve(root,'tests/fixtures/track-orbit.mp4'));
 await importer.waitForFunction(()=>!document.getElementById('cameraTrackStart').disabled,null,{timeout:30000});
 assert.match(await importer.textContent('#cameraTrackFileStatus'),/for tracking in this tab only; it is not saved or uploaded/);
 await importer.locator('#cameraTrackStart').click();
 await importer.waitForFunction(()=>/^Tracked /.test(document.getElementById('cameraTrackStatus').textContent),null,{timeout:180000});
 assert.match(await importer.textContent('#cameraTrackStatus'),/^Tracked orbit/);
 assert.equal(await importer.evaluate(()=>JSON.parse(localStorage.getItem('atoms-ai-sequence-v1')).shots[0].videoCameraMotion.source),'feature-track');
 // A video shorter than the chapter is refused with a clear reason.
 const longPlain={...plain,duration:6,shots:[{...plain.shots[0],end:6}],camera:[plain.camera[0],{...plain.camera[1],at:5.9}]};
 await importer.evaluate(s=>{localStorage.setItem('atoms-ai-sequence-v1',s);},JSON.stringify(longPlain));
 await importer.reload();
 await importer.waitForFunction(()=>window.__atomsEditorStarted===true);
 await importer.locator('#inspectorMotionButton').click();
 await importer.locator('#cameraTrackFile').setInputFiles(resolve(root,'tests/fixtures/track-orbit.mp4'));
 await importer.waitForFunction(()=>/ends before this chapter does/.test(document.getElementById('cameraTrackStatus').textContent),null,{timeout:30000});
 assert.equal(await importer.isDisabled('#cameraTrackStart'),true);
 assert.deepEqual(errors,[]);
 console.log('PASS: browser tracked',result.motion.type,JSON.stringify(result.summary));
}finally{await browser?.close();server.close();}
