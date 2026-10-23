// Runs the real Worker module in workerd (via Miniflare) with a SQLite-backed
// Durable Object and real alarms. Node mocks once accepted a fetch option that
// workerd rejects (PR #72), so the Durable Object path is checked in the real
// runtime too. Every outbound fetch hits the Google mock below; no network.
// Usage: MINIFLARE_MODULE=<miniflare entry> node tests/workerd_argon_jobs.mjs
import assert from 'node:assert/strict';
import {pathToFileURL,fileURLToPath} from 'node:url';
const {Miniflare}=await import(process.env.MINIFLARE_MODULE?
  pathToFileURL(process.env.MINIFLARE_MODULE).href:'miniflare');
const scriptPath=process.argv[2]||fileURLToPath(new URL('../worker/scene-worker.mjs',import.meta.url));
const token='test-token-should-be-at-least-thirty-two-chars-private';
const jpeg='data:image/jpeg;base64,'+Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');
// Rich fields exercise the shared validator the Worker imports from the repo root.
const scene={schemaVersion:1,scenes:[{shotId:'shot_a',camera:{position:[0,3,15],target:[0,1,0],fov:40},
  lights:[{type:'spot',name:'Floodlight',color:'#ffffff',intensity:120,position:[0,8,4],target:[0,0,0],
    distance:40,angle:.5,penumbra:.3}],objects:[
  {id:'facade',name:'Facade',layer:'structures',primitive:'box',position:[0,1,0],rotation:[0,0,0],scale:[4,2,1],
    material:{color:'#334455',metalness:0.1,roughness:0.6}},
  {id:'windows',name:'Windows',primitive:'box',position:[0,1.2,.55],rotation:[0,0,0],scale:[.5,.6,.05],
    repeat:{count:[5,2,1],spacing:[.75,.8,0]},
    material:{color:'#223344',metalness:0.3,roughness:0.2,emissive:'#ffcc88',emissiveIntensity:1.2,opacity:.8}},
  {id:'roof',name:'Roof',primitive:'gable',position:[0,2.5,0],rotation:[0,0,0],scale:[4,1,1.2],
    material:{color:'#553322',metalness:0,roughness:0.8}}]}]};
let mode='ok',release=()=>{};const calls=[];
// CF_VERSION_METADATA mirrors wrangler.toml's version_metadata binding.
const options=version=>({
  // The repository root: the Worker imports ../primitive-schema.js, an ES
  // module with a .js name (Wrangler's esbuild bundles it the same way).
  modules:true,scriptPath,modulesRoot:scriptPath.replace(/\/[^/]*\/[^/]*$/,''),compatibilityDate:'2026-07-01',
  modulesRules:[{type:'ESModule',include:['**/*.js']}],
  bindings:{GEMINI_API_KEY:'do-not-print-secret',SCENE_ACCESS_TOKEN:token,CF_VERSION_METADATA:{id:version}},
  durableObjects:{ARGON_JOBS:{className:'ArgonJob',useSQLite:true}},
  async outboundService(request){
    calls.push({url:request.url,method:request.method,body:await request.text(),
      key:request.headers.get('x-goog-api-key'),revision:request.headers.get('Api-Revision'),
      deadline:request.headers.get('X-Server-Timeout')});
    if(mode.startsWith('long')){
      const id='v1_long_workerd';
      if(request.method==='POST')return new Response(JSON.stringify({id,status:'queued'}));
      assert.equal(request.method,'GET');assert.ok(request.url.endsWith('/'+id));
      if(mode==='long_pending')return new Response(JSON.stringify({id,status:'in_progress'}));
      const output=JSON.stringify(scene),cut=output.length>>1;
      return new Response(JSON.stringify({id,status:'completed',usage:{total_thought_tokens:72000,total_output_tokens:10000},steps:[
        {type:'thought',content:[{type:'text',text:'PRIVATE_THOUGHT'}]},
        {type:'model_output',content:[{type:'text',text:output.slice(0,cut)}]},
        {type:'model_output',content:[{type:'text',text:output.slice(cut)}]}
      ]}));
    }
    if(mode==='hang')await new Promise(r=>{release=r;}); // still answering when the deploy lands
    await new Promise(r=>setTimeout(r,1500)); // a slow model: longer than the start request
    if(mode==='reject')return new Response(JSON.stringify({error:{code:'invalid_request',
      message:'The agent does not support image input modality. PRIVATE_DETAIL'}}),{status:400});
    const frame=event=>'data: '+JSON.stringify(event)+'\n\n';
    const output=JSON.stringify(scene),encoder=new TextEncoder();
    return new Response(new ReadableStream({async start(controller){
      controller.enqueue(encoder.encode(frame({event_type:'step.start',index:0,step:{type:'model_output'}})));
      await new Promise(r=>setTimeout(r,250));
      controller.enqueue(encoder.encode(frame({event_type:'step.delta',index:0,
        delta:{type:'text',text:output.slice(0,100)}})));
      await new Promise(r=>setTimeout(r,250));
      controller.enqueue(encoder.encode(frame({event_type:'step.delta',index:0,
        delta:{type:'text',text:output.slice(100)}})+frame({event_type:'step.stop',index:0,
        usage:{total_input_tokens:1800,total_thought_tokens:9120,total_output_tokens:11204,total_tokens:22124,
          input_tokens_by_modality:[{modality:'image',tokens:1200}],private_metadata:'PRIVATE_USAGE'}})+
        frame({event_type:'interaction.completed',interaction:{id:'v1_sync',status:'completed'}})));
      controller.close();
    }}),{headers:{'Content-Type':'text/event-stream'}});
  }
});
const mf=new Miniflare(options('0a1b2c3d-0000-4000-8000-000000000001'));
const post=(path,body,headers={})=>mf.dispatchFetch('https://worker.test'+path,{method:'POST',
  headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
// Full scene: the same single synchronous call, with the full-scene scope.
const job={shotId:'shot_a',profile:'argon_direct',mode:'full_scene',thinking:'high',detail:'max',
  frames:[{at:2,imageDataUrl:jpeg},{at:0.5,imageDataUrl:jpeg},{at:4,imageDataUrl:jpeg}]};
async function runJob(){
  const t0=Date.now();
  const start=await (await post('/api/scene/argon/direct-start',job)).json();
  const startMs=Date.now()-t0;
  assert.equal(start.ok,true);assert.match(start.jobId,/^do_[0-9a-f]{64}$/);assert.equal(start.status,'queued');
  const seen=[],statusMs=[];let result;
  for(let i=0;i<40;i++){
    const polledAt=Date.now();
    result=await (await post('/api/scene/argon/status',{jobId:start.jobId,shotId:'shot_a'})).json();
    statusMs.push(Date.now()-polledAt);
    if(seen.at(-1)!==result.status)seen.push(result.status);
    if(['completed','failed'].includes(result.status))break;
    await new Promise(r=>setTimeout(r,250));
  }
  return {start,startMs,seen,result,statusMs};
}
try{
  const health=await (await mf.dispatchFetch('https://worker.test/health')).json();
  assert.equal(health.argonDirectJobs,true);assert.equal(health.workerRevision,'argon-100k-experiment-v1');
  // 1) Success: start returns before the slow model finishes; polling sees it.
  const ok=await runJob();
  console.log('start returned in',ok.startMs,'ms; statuses seen:',ok.seen.join(' -> '));
  assert.ok(ok.startMs<1500,'start must not wait for Google');
  assert.ok(ok.statusMs.every(ms=>ms<1500),'free status responses must not wait for the slow model');
  assert.deepEqual(ok.result,{ok:true,status:'completed',proposal:scene,
    usage:{input:1800,inputImage:1200,thinking:9120,output:11204,total:22124,cap:32768}});
  assert.equal(calls.length,1,'exactly one provider call');
  const sent=JSON.parse(calls[0].body);
  assert.equal(calls[0].url,'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(calls[0].key,'do-not-print-secret');assert.equal(calls[0].revision,'2026-05-20');
  assert.equal(calls[0].deadline,'690');
  assert.equal(sent.store,false);assert.equal(sent.background,undefined);
  assert.equal(sent.stream,true);
  assert.match(sent.system_instruction,/SCOPE: FULL SCENE/);
  assert.match(sent.system_instruction,/DETAIL: MAXIMUM/);
  assert.equal(sent.generation_config.thinking_level,'high');
  assert.deepEqual(sent.input.map(x=>x.type),['text','image','text','image','text','image']);
  assert.equal(sent.input[0].text,'Reference frame at 2.000 seconds');
  assert.deepEqual(sent.input.filter(x=>x.type==='image').map(x=>x.resolution),['high','high','high']);
  // Re-polling a finished job never calls Google again.
  const again=await (await post('/api/scene/argon/status',{jobId:ok.start.jobId,shotId:'shot_a'})).json();
  assert.equal(again.status,'completed');assert.equal(calls.length,1);
  const raw=await (await post('/api/scene/argon/output',{jobId:ok.start.jobId,shotId:'shot_a'})).json();
  assert.deepEqual(JSON.parse(raw.output),scene);assert.equal(raw.partial,false);
  assert.ok(!JSON.stringify(raw).includes('PRIVATE'));
  assert.equal(calls.length,1,'original download is a private storage read, not generation');
  // Wrong chapter for the job is refused.
  assert.equal((await post('/api/scene/argon/status',{jobId:ok.start.jobId,shotId:'other'})).status,400);
  // 2) Provider rejection is reported with the sanitized diagnostic, once.
  mode='reject';
  const bad=await runJob();
  assert.equal(bad.result.status,'failed');
  console.log('rejection diagnostic:',JSON.stringify(bad.result.diagnostic));
  assert.equal(bad.result.diagnostic.phase,'create');
  assert.deepEqual(bad.result.diagnostic.terms,['image','modality','not','agent']);
  assert.ok(!JSON.stringify(bad.result).includes('PRIVATE'));
  assert.equal(calls.length,2,'no retry after the rejection');
  // 3) Invalid input never creates a job or reaches Google.
  const invalid=await post('/api/scene/argon/direct-start',{...job,mode:'environment'});
  assert.equal(invalid.status,400);
  const unknown=await post('/api/scene/argon/status',{jobId:'do_'+'0'.repeat(64),shotId:'shot_a'});
  assert.equal(unknown.status,400,'malformed object id');
  assert.equal(calls.length,2);
  // 4) A PHP-named job (idFromName) is pollable by the name PHP chose, and a
  // sealed name refuses a late start without reaching Google.
  mode='ok';
  const key='5e'.repeat(32);
  const named=await (await post('/api/scene/argon/direct-start',job,{'X-Argon-Job-Key':key})).json();
  assert.deepEqual(named,{ok:true,jobId:'dk_'+key,status:'queued'});
  let namedStatus;
  for(let i=0;i<40;i++){
    namedStatus=await (await post('/api/scene/argon/status',{jobId:'dk_'+key,shotId:'shot_a'})).json();
    if(namedStatus.status==='completed')break;
    await new Promise(r=>setTimeout(r,250));
  }
  assert.equal(namedStatus.status,'completed');assert.equal(calls.length,3);
  const lostKey='7f'.repeat(32);
  const sealed=await (await post('/api/scene/argon/status',{jobId:'dk_'+lostKey,shotId:'shot_a',seal:true})).json();
  assert.equal(sealed.diagnostic.reason,'start_not_received');
  assert.equal((await post('/api/scene/argon/direct-start',job,{'X-Argon-Job-Key':lostKey})).status,409);
  await new Promise(r=>setTimeout(r,500));
  assert.equal(calls.length,3,'a sealed job never reaches Google');
  // 5) A deploy mid-call: restarting workerd on a new version resets the
  // object while Google is still answering. The re-delivered alarm names the
  // deploy and never calls Google again (2026-10-23: a run cut off this way).
  mode='hang';
  const cut=await (await post('/api/scene/argon/direct-start',job)).json();
  const cutStatus=async()=>(await post('/api/scene/argon/status',{jobId:cut.jobId,shotId:'shot_a'})).json();
  for(let i=0;i<40&&calls.length<4;i++)await new Promise(r=>setTimeout(r,100));
  assert.equal(calls.length,4);assert.equal((await cutStatus()).status,'in_progress');
  await mf.setOptions(options('0a1b2c3d-0000-4000-8000-000000000002'));
  let after;
  for(let i=0;i<40;i++){
    after=await cutStatus();
    if(after.status!=='in_progress')break;
    await new Promise(r=>setTimeout(r,250));
  }
  assert.deepEqual([after.status,after.diagnostic.reason],['failed','job_interrupted_deploy']);
  assert.equal(calls.length,4,'never resubmitted after the deploy');
  // 6) Stored 100k generation survives a restart. All subsequent traffic is
  // GET of the same interaction, including after a repeated alarm/deploy.
  mode='long_pending';
  const long=await (await post('/api/scene/argon/direct-start',{...job,tokenBudget:100000})).json();
  const longStatus=async()=>(await post('/api/scene/argon/status',{jobId:long.jobId,shotId:'shot_a'})).json();
  for(let i=0;i<40&&!calls.some(c=>c.method==='GET');i++){
    await longStatus();await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(calls.some(c=>c.method==='GET'),'background job was persisted and polled');
  const longBody=JSON.parse(calls[4].body);
  assert.equal(longBody.generation_config.max_output_tokens,100000);
  assert.equal(longBody.background,true);assert.equal(longBody.store,true);assert.equal(longBody.stream,undefined);
  assert.equal(longBody.system_instruction,sent.system_instruction);
  assert.deepEqual(longBody.input,sent.input);
  await mf.setOptions(options('0a1b2c3d-0000-4000-8000-000000000003'));
  mode='long_complete';
  const longResult=await longStatus();
  assert.deepEqual(longResult,{ok:true,status:'completed',proposal:scene,usage:{thinking:72000,output:10000,cap:100000}});
  const callCount=calls.length;
  assert.deepEqual(await longStatus(),longResult);assert.equal(calls.length,callCount);
  assert.equal(calls.filter(c=>c.method==='POST').length,5,'only one new paid POST for the 100k job');
  assert.ok(calls.slice(5).every(c=>c.method==='GET'));
  const longOutput=await (await post('/api/scene/argon/output',{jobId:long.jobId,shotId:'shot_a'})).json();
  assert.deepEqual(JSON.parse(longOutput.output),scene);assert.ok(!longOutput.output.includes('PRIVATE'));
  console.log('WORKERD TEST PASS');
}finally{release();await mf.dispose();}
