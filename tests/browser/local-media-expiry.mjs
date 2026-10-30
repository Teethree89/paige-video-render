// Real Chromium + IndexedDB: Reference Builder media and the single source
// video survive reloads for 48 hours, then are removed and must be re-linked.
// Local only: nothing is uploaded and no provider is called.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const three=resolve(process.env.THREE_NODE_MODULES,'three');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.mp4':'video/mp4'};
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://local');
  if(url.pathname==='/scene-proxy.php'){res.setHeader('Content-Type','application/json');res.end('{"ok":true,"authenticated":false,"csrf":"x"}');return;}
  if(url.pathname==='/blank'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>media</title>');return;}
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
const HOURS=3600*1000;
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,
  args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const errors=[];
 const ready=async page=>{await page.waitForFunction(()=>window.__atomsEditorStarted===true,null,{timeout:60000});};

 // 1. Reference Builder: a clip saved 1 hour ago restores; an image saved 49 hours ago is gone.
 const context=await browser.newContext({viewport:{width:1365,height:900}});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://**/*',route=>route.abort());
 await page.goto(base+'/blank');
 await page.evaluate(async HOURS=>{
   const {createReferenceMediaStore}=await import('/single-video-source.js');
   const {buildReferenceTimeline}=await import('/reference-sequence.js');
   const clip=new File([await (await fetch('/tests/fixtures/track-orbit.mp4')).blob()],'orbit.mp4',{type:'video/mp4'});
   const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;
   canvas.getContext('2d').fillRect(0,0,32,18);
   const still=new File([await new Promise(r=>canvas.toBlob(r,'image/png'))],'still.png',{type:'image/png'});
   await createReferenceMediaStore(indexedDB,{now:()=>Date.now()-HOURS}).put('media_clip',{file:clip,kind:'video'});
   await createReferenceMediaStore(indexedDB,{now:()=>Date.now()-49*HOURS}).put('media_still',{file:still,kind:'image'});
   const timeline=buildReferenceTimeline([
     {id:'ref_clip',mediaId:'media_clip',kind:'video',name:'Orbit clip',fileName:'orbit.mp4',fileSize:clip.size,duration:3,sourceIn:0,sourceOut:3},
     {id:'ref_still',mediaId:'media_still',kind:'image',name:'Still',fileName:'still.png',fileSize:still.size,duration:2}]);
   localStorage.setItem('atoms-ai-sequence-v1',JSON.stringify(timeline));
 },HOURS);
 await page.goto(base+'/');await ready(page);
 await page.waitForFunction(()=>/MEDIA RESTORED/.test(document.getElementById('saveStatus').textContent),null,{timeout:30000});
 const status=await page.textContent('#rbStatus');
 assert.match(status,/Restored 1 media file\(s\) from this browser/,status);
 assert.match(status,/1 file\(s\) expired after 48 hours/,status);
 await page.locator('#inspectorMotionButton').click();
 // The restored clip counts as the chapter's source; tracking then only waits for a 3D model.
 await page.waitForFunction(()=>/needs a 3D model/.test(document.getElementById('cameraTrackStatus').textContent),null,{timeout:30000});
 const stored=await page.evaluate(async()=>{
   const {createReferenceMediaStore}=await import('/single-video-source.js');
   const store=createReferenceMediaStore();
   return {clip:!!(await store.get('media_clip')),still:await store.get('media_still')};
 });
 assert.deepEqual(stored,{clip:true,still:null},'the expired image bytes were deleted');
 assert.match(await page.textContent('.media-expiry-note'),/48 hours/);
 // Reload again: still restored from the browser, still expiring at the original time.
 await page.reload();await ready(page);
 await page.waitForFunction(()=>/MEDIA RESTORED/.test(document.getElementById('saveStatus').textContent),null,{timeout:30000});
 await context.close();

 // 2. Single video saved 49 hours ago: not restored, honest missing status.
 const second=await browser.newContext({viewport:{width:1365,height:900}});
 const editor=await second.newPage();editor.on('pageerror',e=>errors.push(e.message));
 await editor.route('https://**/*',route=>route.abort());
 await editor.goto(base+'/blank');
 await editor.evaluate(async HOURS=>{
   const {createSingleVideoStore}=await import('/single-video-source.js');
   const {createDraftTimeline}=await import('/shot-analysis.js');
   const clip=new File([await (await fetch('/tests/fixtures/track-orbit.mp4')).blob()],'orbit.mp4',{type:'video/mp4'});
   await createSingleVideoStore(indexedDB,{now:()=>Date.now()-49*HOURS}).save('old-source',clip);
   const timeline=createDraftTimeline({duration:3,title:'Expired source'});
   timeline.videoIntake.sourceId='old-source';timeline.videoIntake.sourceName='orbit.mp4';
   localStorage.setItem('atoms-ai-sequence-v1',JSON.stringify(timeline));
 },HOURS);
 await editor.goto(base+'/');await ready(editor);
 await editor.locator('#inspectorSourceButton').click();
 await editor.waitForFunction(()=>/missing/.test(document.getElementById('referenceMediaStatus').textContent));
 assert.match(await editor.textContent('#referenceMediaStatus'),/removed after 48 hours/);
 assert.equal(await editor.evaluate(async()=>{
   const {createSingleVideoStore}=await import('/single-video-source.js');
   return await createSingleVideoStore().read('old-source');
 }),null);
 await second.close();
 assert.deepEqual(errors,[]);
 console.log('PASS: browser media kept for 48 hours, restored after reload, expired files removed');
}finally{await browser?.close();server.close();}
