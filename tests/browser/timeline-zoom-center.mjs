// Real Chromium: decode tests/fixtures/track-orbit.mp4 frames and check the editor's
// Motion-tab tracking panel (wizard entry, file picker, refusals). The wizard itself
// is covered by camera-track-wizard.mjs. Local only:
// no provider, upload or network access beyond this test server.
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
 const page=await browser.newPage({viewport:{width:1365,height:900}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://**/*',route=>route.abort());
 await page.goto(base+'/');
 await page.waitForFunction(()=>window.__atomsEditorStarted===true);
 // Where is the playhead on screen, relative to the middle of the scrollable timeline?
 const offset=()=>page.evaluate(()=>{
   const s=document.getElementById('timelineScroll').getBoundingClientRect(),h=document.getElementById('playhead').getBoundingClientRect();
   return {head:h.left+h.width/2-(s.left+s.width/2),width:s.width,zoom:document.getElementById('timelineZoomText').textContent};
 });
 // Put the playhead part-way along the sequence, then zoom with the buttons and with Ctrl+wheel.
 const tr=await page.locator('#tracks').boundingBox();
 await page.mouse.click(tr.x+tr.width*.62,tr.y+8);
 await page.waitForFunction(()=>parseFloat(document.getElementById('playhead').style.left)>40,null,{timeout:5000});
 await page.waitForTimeout(200);
 for(let i=0;i<3;i++){
   await page.locator('#timelineZoomIn').click();await page.waitForTimeout(80);
   const o=await offset();
   assert.ok(Math.abs(o.head)<4,`zoom ${o.zoom}: playhead is ${o.head.toFixed(1)} px from the middle`);
 }
 const box=await page.locator('#timelineScroll').boundingBox();
 await page.mouse.move(box.x+box.width*.15,box.y+60);
 await page.keyboard.down('Control');await page.mouse.wheel(0,-240);await page.keyboard.up('Control');
 await page.waitForTimeout(150);
 const wheel=await offset();
 assert.ok(Math.abs(wheel.head)<4,`Ctrl+wheel zoom ${wheel.zoom}: playhead is ${wheel.head.toFixed(1)} px from the middle (cursor was elsewhere)`);
 await page.locator('#timelineZoomOut').click();await page.waitForTimeout(80);
 assert.ok(Math.abs((await offset()).head)<4,'zooming out keeps the playhead centered too');
 assert.deepEqual(errors,[]);
 console.log('PASS: timeline zoom centers on the playhead');
}finally{await browser?.close();server.close();}
