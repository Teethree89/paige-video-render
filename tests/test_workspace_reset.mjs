import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkTimeline} from '../timeline-operations.js';
import {clearWorkspaceStorage,createEmptyWorkspace,markWorkspaceSaved,
  clearServerWorkspace,EMPTY_WORKSPACE_KEY,WELCOME_DISMISSED_KEY,
 ASSEMBLY_LIBRARY_KEY,SEQUENCE_STORAGE_KEY,isEmptyWorkspace,shouldShowWorkspaceWelcome,dismissWorkspaceWelcome} from '../workspace-reset.js';

function storage(entries){
 const data=new Map(Object.entries(entries));
 return {getItem:key=>data.get(key)??null,setItem:(key,v)=>data.set(key,String(v)),
   removeItem:key=>data.delete(key),snapshot:()=>Object.fromEntries(data)};
}
const response=(body,ok=true)=>({ok,json:async()=>body});

test('cleared workspace is a valid but empty, unbranded timeline',()=>{
 const workspace=createEmptyWorkspace();
 assert.equal(checkTimeline(workspace),workspace);
 assert.equal(workspace.shots.length,1);
 assert.equal(isEmptyWorkspace(workspace),true);
 assert.equal(workspace.camera.length,2);
 assert.equal(workspace.text.length,0);
 assert.equal(workspace.videoIntake,undefined);
 assert.equal(workspace.referenceSequence,undefined);
 assert.equal(workspace.primitiveScenes,undefined);
 assert.notEqual(workspace.shots[0].id,'hall');
});

test('clear retains reusable object library and personal preview preference',()=>{
 const store=storage({[SEQUENCE_STORAGE_KEY]:'old scenes',
   [ASSEMBLY_LIBRARY_KEY]:'valuable asset library',
   'paige-studio-workspace-v1':'old workspace layout',
   'paige-inspector-tab-v2':'scene',
   'atoms-ai-preview-quality-v1':'fast'});
 clearWorkspaceStorage(store);
 assert.equal(store.getItem(SEQUENCE_STORAGE_KEY),null);
 assert.equal(store.getItem('paige-studio-workspace-v1'),null);
 assert.equal(store.getItem('paige-inspector-tab-v2'),null);
 assert.equal(store.getItem(ASSEMBLY_LIBRARY_KEY),'valuable asset library');
 assert.equal(store.getItem('atoms-ai-preview-quality-v1'),'fast');
 assert.equal(store.getItem(EMPTY_WORKSPACE_KEY),'1');
 assert.equal(store.getItem(WELCOME_DISMISSED_KEY),null);
 markWorkspaceSaved(store);
 assert.equal(store.getItem(EMPTY_WORKSPACE_KEY),null);
});

test('welcome appears only for a freshly cleared untouched scene',()=>{
 const store=storage({[EMPTY_WORKSPACE_KEY]:'1'});
 const empty=createEmptyWorkspace();
 assert.equal(shouldShowWorkspaceWelcome(empty,store),true);
 assert.equal(isEmptyWorkspace({...empty,text:[{id:'title'}]}),false);
 assert.equal(shouldShowWorkspaceWelcome({...empty,videoIntake:{version:1}},store),false);
 assert.equal(shouldShowWorkspaceWelcome({...empty,primitiveScenes:{
   scenes:[{shotId:'workspace_001',objects:[{}]}]}},store),false);
 dismissWorkspaceWelcome(store);
 assert.equal(shouldShowWorkspaceWelcome(empty,store),false);
 clearWorkspaceStorage(store);
 assert.equal(shouldShowWorkspaceWelcome(empty,store),true);
 markWorkspaceSaved(store);
 assert.equal(shouldShowWorkspaceWelcome(empty,store),false);
});

test('welcome chooser uses working import buttons and keeps a reopening control',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 for(const id of ['workspaceStartDialog','workspaceStartVideo','workspaceStartReference','workspaceStartImport',
   'workspaceStartBlank','workspaceStartClose','workspaceStartOpenBtn'])
   assert.ok(html.includes('id="'+id+'"'),'missing welcome control: '+id);
 assert.ok(app.includes('shouldShowWorkspaceWelcome(sequence,localStorage)'));
 assert.ok(app.includes("el('videoImportOpenBtn').click()"));
 assert.ok(app.includes('referenceBuilder?.open()'));
 assert.ok(app.includes("el('loadBtn').click()"));
});

test('authenticated server clear uses same-origin session and CSRF',async()=>{
 const requests=[];
 const fetcher=async(url,opts)=>{requests.push({url,opts});
   return requests.length===1?response({ok:true,authenticated:true,csrf:'test-csrf'}):
     response({ok:true,cleared:true});};
 assert.deepEqual(await clearServerWorkspace(fetcher),{serverCleared:true,signedOut:false});
 assert.equal(requests.length,2);
 assert.equal(requests[0].opts.credentials,'same-origin');
 assert.equal(requests[1].opts.method,'POST');
 assert.equal(requests[1].opts.headers['X-Paige-Client'],'SceneStudio');
 assert.deepEqual(JSON.parse(requests[1].opts.body),{action:'workspace_clear',csrf:'test-csrf'});
});

test('signed-out sessions skip server cleanup; failures never report success',async()=>{
 let calls=0;
 assert.deepEqual(await clearServerWorkspace(async()=>{calls++;return response({ok:true,authenticated:false});}),
   {serverCleared:false,signedOut:true});
 assert.equal(calls,1);
 await assert.rejects(()=>clearServerWorkspace(async()=>response({ok:false,error:'Unavailable'},false)),/Unavailable/);
 await assert.rejects(()=>clearServerWorkspace(async()=>calls++===1?
   response({ok:true,authenticated:true,csrf:'token'}):response({ok:false,error:'Job running'},false)),/Job running/);
});

test('gateway and private worker explicitly handle terminal-only job deletion',()=>{
 const php=readFileSync(new URL('../scene-proxy.php',import.meta.url),'utf8');
 const worker=readFileSync(new URL('../worker/scene-worker.mjs',import.meta.url),'utf8');
 assert.match(php,/\$action === 'workspace_clear'/);
 assert.match(php,/Finish the active Argon job before clearing/);
 assert.match(php,/unset\(\$_SESSION\['argon_job'\], \$_SESSION\['argon_smoke'\]\)/);
 assert.match(worker,/path==='\/api\/scene\/argon\/clear'/);
 assert.match(worker,/job.state!=='completed'&&job.state!=='failed'/);
 assert.match(worker,/await this.ctx.storage.deleteAll\(\)/);
});
