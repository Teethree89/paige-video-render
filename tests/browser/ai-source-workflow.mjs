// Real editor, real IndexedDB and video decoder; private gateway is mocked.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const three=resolve(process.env.THREE_NODE_MODULES,'three');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.mp4':'video/mp4'};
let paidRequests=0;
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://local');
  if(url.pathname==='/scene-proxy.php'){
   if(req.method!=='GET'){
    let body='';for await(const chunk of req)body+=chunk;
    const action=JSON.parse(body).action;
    if(action!=='workspace_clear'){paidRequests++;throw Error('Unexpected gateway action: '+action);}
   }
   res.setHeader('Content-Type','application/json');
   res.end(JSON.stringify(req.method==='GET'?{ok:true,authenticated:true,csrf:'test-only-csrf'}:{ok:true,cleared:true}));return;
  }
  if(url.pathname==='/fixture'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Local source fixture</title>');return;}
  const path=url.pathname.startsWith('/three/')?resolve(three,url.pathname.slice(7)):
    resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
  if(!path.startsWith(root+'/')&&!path.startsWith(three+'/'))throw Error('Invalid path');
  let content=await readFile(path);
  if(path.endsWith('/index.html'))content=content.toString().replaceAll('https://cdn.jsdelivr.net/npm/three@0.166.1','/three');
  res.setHeader('Content-Type',mime[extname(path)]||'application/octet-stream');res.end(content);
 }catch(error){res.statusCode=404;res.end('Unavailable');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,
  args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1365,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 // No provider or public CDN access is needed for this regression.
 await page.route('https://**/*',route=>route.abort());
 const base='http://127.0.0.1:'+server.address().port;
 await page.goto(base+'/fixture');
 await page.evaluate(async()=>{
  const {createSingleVideoStore}=await import('/single-video-source.js');
  const {createDraftTimeline}=await import('/shot-analysis.js');
  const file=new File([await (await fetch('/assets/reference.mp4')).blob()],'reference.mp4',{type:'video/mp4'});
  const video=document.createElement('video');video.src=URL.createObjectURL(file);
  await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=reject;});
  const timeline=createDraftTimeline({duration:video.duration,title:'Source restore regression'});
  timeline.videoIntake.sourceId='test-source';timeline.videoIntake.sourceName=file.name;
  await createSingleVideoStore().save('test-source',file);
  localStorage.setItem('atoms-ai-sequence-v1',JSON.stringify(timeline));
  localStorage.setItem('paige-assembly-library-v1','retained-library-fixture');
  URL.revokeObjectURL(video.src);
 });
 const ready=async()=>{
  await page.waitForFunction(()=>window.__atomsEditorStarted===true);
  assert.equal(await page.locator('#errorBanner').isVisible(),false,errors.join('\n'));
 };
 await page.goto(base+'/');await ready();
 assert.equal(await page.locator('#referenceMediaStatus').count(),1);
 assert.equal(await page.locator('#referenceStill').count(),1);
 await page.locator('#inspectorSourceButton').click();
 await page.waitForFunction(()=>document.getElementById('referenceVideo').readyState>=2);
 assert.equal(await page.locator('#sourceOverlayEnabled').isEnabled(),true,'cached source restores overlay availability');
 assert.match(await page.locator('#referenceMediaStatus').textContent(),/reference.mp4.*synced/);
 const scrub=async fraction=>{
  const box=await page.locator('#tracks').boundingBox();
  await page.mouse.click(box.x+box.width*fraction,box.y+10);
  await page.waitForFunction(f=>{
   const duration=JSON.parse(localStorage.getItem('atoms-ai-sequence-v1')).duration;
   return Math.abs(document.getElementById('referenceVideo').currentTime-duration*f)<.3;
  },fraction);
 };
 await scrub(.2);
 await page.locator('#sourceOverlayEnabled').check();
 assert.equal(await page.locator('#sourceViewportOverlay > #referenceVideo').count(),1);
 await scrub(.4);
 await page.reload();await ready();
 await page.locator('#inspectorSourceButton').click();
 await page.waitForFunction(()=>document.getElementById('referenceVideo').readyState>=2);
 await scrub(.3);

 await page.locator('#inspectorGenerationButton').click();
 await page.waitForFunction(()=>!document.getElementById('aiSceneControls').hidden);
 await page.locator('#aiSceneModel').selectOption('argon_direct');
 for(const width of [360,280]){
  await page.locator('#studioWorkbench').evaluate((node,w)=>node.style.setProperty('--inspector-width',w+'px'),width);
  for(const id of ['aiArgonAddDetail','aiArgonRetry','videoMotionAuto']){
   const aligned=await page.locator('#'+id).evaluate(input=>{
    const a=input.getBoundingClientRect(),b=input.nextElementSibling.getBoundingClientRect();
    return a.width===16&&a.height===16&&b.left>a.right&&Math.abs(a.top-b.top)<=3;
   });
   assert.ok(aligned,id+' is a compact left-aligned checkbox at '+width+'px');
  }
 }
 await page.locator('#studioWorkbench').evaluate(node=>node.style.setProperty('--inspector-width','360px'));
 assert.equal(await page.locator('#aiSceneDiagnostics').getAttribute('open'),null);
 assert.equal(await page.locator('#aiSceneCheckArgon').isVisible(),false);
 assert.equal(await page.locator('#aiSceneStatus').isVisible(),true);
 assert.ok(await page.locator('#aiSceneDiagnostics').evaluate(node=>!!(node.compareDocumentPosition(document.getElementById('aiSceneGenerate'))&Node.DOCUMENT_POSITION_PRECEDING)));
 await page.locator('#aiArgonAddDetailField strong').click();
 assert.equal(await page.locator('#aiArgonAddDetail').isChecked(),false,'clicking the inline label toggles its checkbox');
 await page.locator('#aiSceneScope').selectOption('subject');
 assert.equal(await page.locator('#aiArgonAddDetailField').isVisible(),false);
 await page.locator('#aiSceneModel').selectOption('lite_default');
 assert.equal(await page.locator('#aiArgonRetryField').isVisible(),false);
 await page.locator('#aiSceneModel').selectOption('argon_direct');
 await page.locator('#aiSceneScope').selectOption('environment');
 await page.locator('#aiSceneDiagnostics > summary').click();
 assert.equal(await page.locator('#aiSceneCheckArgon').isVisible(),true);
 await page.locator('#aiSceneDiagnostics > summary').click();
 await page.locator('.inspector').evaluate(node=>node.scrollTop=0);
 if(process.env.UI_SCREENSHOT_LOG==='1'){
  const screenshot=await page.locator('.inspector').screenshot();
  console.log('AI_PANEL_SCREENSHOT:'+screenshot.toString('base64'));
 }

 // An unrelated timeline must not silently use the last cached video.
 await page.evaluate(()=>{
  const timeline=JSON.parse(localStorage.getItem('atoms-ai-sequence-v1'));
  timeline.videoIntake.sourceId='other-source';
  localStorage.setItem('atoms-ai-sequence-v1',JSON.stringify(timeline));
 });
 await page.reload();await ready();await page.locator('#inspectorSourceButton').click();
 assert.equal(await page.locator('#sourceOverlayControls').isVisible(),true);
 assert.equal(await page.locator('#sourceOverlayEnabled').isDisabled(),true);
 assert.equal(await page.locator('#referenceVideo').isVisible(),false);
 assert.equal(await page.locator('#referenceVideo').getAttribute('poster'),null);
 assert.match(await page.locator('#referenceMediaStatus').textContent(),/missing/);
 await page.locator('#sourceRelinkFile').setInputFiles(resolve(root,'assets/reference.mp4'));
 await page.waitForFunction(()=>!document.getElementById('sourceOverlayEnabled').disabled);
 await page.waitForFunction(()=>document.getElementById('sourceRelinkStatus').textContent.includes('saved locally'));
 await scrub(.25);
 await page.reload();await ready();await page.locator('#inspectorSourceButton').click();
 await page.waitForFunction(()=>document.getElementById('referenceVideo').readyState>=2);
 assert.equal(await page.locator('#sourceOverlayEnabled').isEnabled(),true,'reattached file survives reload');
 const cachedId=await page.evaluate(()=>JSON.parse(localStorage.getItem('atoms-ai-sequence-v1')).videoIntake.sourceId);
 await page.locator('#inspectorObjectsButton').click();
 await page.locator('#clearWorkspaceBtn').click();
 await Promise.all([page.waitForNavigation(),page.locator('#workspaceClearDialog button[value="clear"]').click()]);
 await ready();
 const cleared=await page.evaluate(async id=>{
  const {createSingleVideoStore}=await import('/single-video-source.js');
  const store=createSingleVideoStore();
  const sourceCleared=await store.read(id)===null;
  // Pending saves and Clear must stay ordered as well.
  await Promise.all([store.save('race',new File(['test'],'test.mp4')),store.clear()]);
  return {sourceCleared,missing:await store.read('race')===null,library:localStorage.getItem('paige-assembly-library-v1'),
   empty:localStorage.getItem('paige-empty-workspace-v1')};
 },cachedId);
 assert.deepEqual(cleared,{sourceCleared:true,missing:true,library:'retained-library-fixture',empty:'1'});
 assert.equal(paidRequests,0,'layout, source recovery and clearing never submit model requests');
 assert.deepEqual(errors,[]);
 console.log('PASS: AI tab layout, local source restoration, playhead/overlay sync, relink and clear');
}finally{
 await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));
}
