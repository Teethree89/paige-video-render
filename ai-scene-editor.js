import {validatePrimitiveDocument} from './primitive-schema.js';
import {cleanupPrimitiveDocument,cleanupSummary} from './primitive-cleanup.js';
import {appendArgonDetail,argonDetailIndex} from './argon-detail.js';
import {createArgonOverlay} from './ai-generation-overlay.js';
import {referenceFrameTimes,ENVIRONMENT_PASSES,appendEnvironmentPass} from './environment-generation.js';

const el=id=>document.getElementById(id);
const api='./scene-proxy.php';
const headers={'Content-Type':'application/json','X-Paige-Client':'SceneStudio'};

async function request(action,data={}) {
  // Bound free polls, including a stalled response body. Never replay a paid
  // start: a lost start response can still represent a submitted paid request.
  const polling=action==='argon_status',readOnly=polling||action==='argon_output';
  const controller=readOnly?new AbortController():null;
  const timer=controller?setTimeout(()=>controller.abort(),40000):null;
  let response,result;
  try{
    response=await fetch(api,{
      method:'POST',credentials:'same-origin',headers,cache:'no-store',
      ...(controller?{signal:controller.signal}:{}),body:JSON.stringify({action,...data})
    });
    result=await response.json();
  }catch(error){
    if(!readOnly)throw error;
    throw Object.assign(Error(controller.signal.aborted?'Editor '+(polling?'status check':'output download')+' timed out':
      response?'The editor server returned an unreadable status response':
        'Connection to the editor server was interrupted'),
      {status:response?.status,transient:!response||response.ok||response.status>=500});
  }finally{if(timer!==null)clearTimeout(timer);}
  if(!response.ok||!result.ok){
    const error=Error(result.error||'Scene request failed');
    error.status=response.status;
    if(result.diagnostic&&typeof result.diagnostic==='object')error.diagnostic=result.diagnostic;
    if(result.usage&&typeof result.usage==='object')error.usage=result.usage;
    throw error;
  }
  return result;
}
// Normal cadence only. Connection refusals do not establish a keep-alive cause;
// transient polls back off separately, for network and HTTP failures alike.
const POLL_MS=6500;
// Waits between status checks, but returns early when a backgrounded tab is
// shown again, so a resumed phone checks immediately.
function pollPause(ms) {
  return new Promise(resolve=>{
    const doc=globalThis.document;
    const done=()=>{clearTimeout(timer);doc?.removeEventListener?.('visibilitychange',wake);
      globalThis.removeEventListener?.('online',done);resolve();};
    const wake=()=>{if(doc?.visibilityState==='visible')done();};
    const timer=setTimeout(done,ms);
    doc?.addEventListener?.('visibilitychange',wake);
    globalThis.addEventListener?.('online',done,{once:true});
  });
}
// Fixed provider tokens already validated by the Worker and PHP; never prose.
export function describeDiagnostic(d) {
  const list=value=>Array.isArray(value)?value.filter(x=>typeof x==='string').join(', '):'';
  return 'Provider diagnostic: '+[d.phase,d.http?'HTTP '+d.http:d.status,
    'reason '+d.reason,list(d.codes)&&'code '+list(d.codes),
    list(d.fields)&&'fields '+list(d.fields),
    list(d.terms)&&'terms '+list(d.terms)].filter(Boolean).join(' · ');
}
// Token counts from Google, already reduced to fixed numeric fields by the
// Worker and PHP. The cap covers thinking plus output, so its share shows how
// close a job came to being cut off.
export function describeUsage(label,u) {
  const n=key=>Number.isInteger(u?.[key])?u[key].toLocaleString('en-US'):null;
  const parts=[n('input')&&n('input')+' input'+(n('inputImage')?' ('+n('inputImage')+' image)':''),
    n('cached')&&n('cached')+' cached',n('thinking')&&n('thinking')+' thinking',
    n('output')&&n('output')+' output',n('total')&&n('total')+' total'].filter(Boolean);
  let line=label+' tokens: '+(parts.join(' · ')||'not reported')+'.';
  const used=(u?.thinking||0)+(u?.output||0);
  if(Number.isInteger(u?.thinking)&&Number.isInteger(u?.output)&&Number.isInteger(u?.cap)&&u.cap>0&&used>0)
    line+=' Thinking + output used '+used.toLocaleString('en-US')+' of '+n('cap')+
      ' ('+Math.round(used/u.cap*100)+'%).';
  return line;
}
// Argon settings the Worker and PHP accept (ARGON_THINKING, ARGON_DETAIL).
const ARGON_THINKING=Object.freeze(['minimal','low','medium','high']);
const ARGON_DETAIL_LABELS=Object.freeze({standard:'Standard',high:'High',max:'Maximum'});
const ARGON_RETRY_TOKENS=10000;
// Three additional paid jobs at most; each retry is only eligible after an
// independently confirmed cheap terminal failure of its preceding attempt.
const ARGON_RETRY_MAX=3;
const ARGON_RETRY_DELAY_MS=15000;
// Only a terminal scene-validation failure has complete generated-token usage.
// Transport failures (even with partial counts) never authorize another bill.
export function argonRetryReason(error){
  if(error?.argonTerminal!==true)return null;
  const reason=error.diagnostic?.reason;
  if(reason==='start_not_received')return 'start';
  if(reason!=='scene_schema_mismatch')return null;
  const {thinking,output}=error.usage||{};
  return Number.isSafeInteger(thinking)&&thinking>=0&&Number.isSafeInteger(output)&&output>=0&&
    thinking+output<ARGON_RETRY_TOKENS?'scene':null;
}

// Direct-image jobs that stopped on Cloudflare's side, not Google's.
const JOB_STOPS=Object.freeze({
  job_interrupted_deploy:'The Worker was redeployed during the paid call; a deploy restarts running jobs, which cut the call off. Wait until a deploy has finished before starting a paid run.',
  job_interrupted:'The job stopped during the paid call (a Worker deploy is the usual cause).',
  job_not_started:'The job never started, so nothing was sent to Google.',
  start_not_received:'The start request never reached the job, so nothing was sent to Google. You can start again.'
});
// PHP's fixed reasons for a start whose reply never arrived (startUnconfirmed).
const LOST_START=Object.freeze({dns:'name lookup failed',connect:'connection failed',
  timeout:'timed out',tls:'secure connection failed',reset:'connection dropped',
  size:'reply too large',invalid:'unreadable reply',other:'no reply'});
function describeLostStart(lost){
  if(lost?.reason==='http'&&Number.isInteger(lost.http))return 'HTTP '+lost.http;
  return Object.hasOwn(LOST_START,lost?.reason||'')?LOST_START[lost.reason]:'no reply';
}
// Worker reasons for an HTTP 5xx answer from Google (providerStatusReason).
const SERVER_FAILURES=Object.freeze(['provider_internal','provider_deadline','provider_gateway','provider_unavailable','provider_capacity']);
// The Worker's fixed repair codes (ARGON_REPAIR_CODES), in plain words.
const REPAIR_LABELS=Object.freeze({json:'unreadable JSON',
  truncated:'answer cut off at the token limit (complete objects kept)',scene:'no scene',
  empty:'no objects in the answer',
  shot_id:'wrong shot ID (fixed)',scenes_merged:'several scenes (merged)',
  object_cap:'over the object limit',object:'malformed object',id:'invalid ID',
  duplicate_id:'duplicate ID (renamed)',primitive:'unknown shape',
  transform:'position or rotation out of range',scale:'size out of range',
  material:'material converted or defaulted',repeat:'repeat over its limits',footprint:'invalid footprint',
  name:'name too long',scene_copies:'over 2,000 rendered copies',light:'invalid light',
  light_cap:'over 8 lights',camera:'invalid camera estimate',other:'other rule'});
const repairLabel=code=>REPAIR_LABELS[code]||'other rule';
export function describeRepairs(repairs) {
  const parts=Object.entries(repairs||{}).filter(([,n])=>Number.isInteger(n)&&n>0)
    .map(([code,n])=>repairLabel(code)+' '+n);
  return parts.length?'Worker validation kept the scene and repaired or dropped: '+parts.join(' · ')+'.':'';
}
async function readServerSession() {
  const response=await fetch(api,{credentials:'same-origin',cache:'no-store'});
  const session=await response.json().catch(()=>null);
  if(!response.ok||!session?.ok||typeof session.authenticated!=='boolean'||
     typeof session.csrf!=='string'){
    throw Error(session?.error||'PHP proxy is not ready');
  }
  return session;
}
async function sampleVideo(reference,shot,playhead,detailProfile='standard') {
  if(!reference?.src && !reference?.currentSrc)
    throw Error('Attach your reference MP4 first.');
  const video=document.createElement('video');
  video.muted=true; video.preload='auto'; video.playsInline=true;
  video.crossOrigin='anonymous';
  video.src=reference.src||reference.currentSrc;
  const once=(event,ms)=>new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{cleanup();reject(Error('Video decoding timed out'));},ms);
    function cleanup(){clearTimeout(timeout);video.removeEventListener(event,onSuccess);video.removeEventListener('error',onError);}
    function onSuccess(){cleanup();resolve();}
    function onError(){cleanup();reject(Error('Video source could not be decoded'));}
    video.addEventListener(event,onSuccess,{once:true});
    video.addEventListener('error',onError,{once:true});
  });
  try {
    if(video.readyState<1)await once('loadedmetadata',16000);
    const from=Math.max(0,shot.start),to=Math.min(Number(video.duration),shot.end);
    if(!Number.isFinite(to)||to-from<.15)throw Error('Invalid video shot timestamps');
    const frames=[],canvas=document.createElement('canvas');
    const detailed=detailProfile==='primary';
    const aspect=video.videoHeight/video.videoWidth;
    const configureWidth=width=>{
      canvas.width=width;
      canvas.height=Math.max(2,Math.round(width*aspect));
    };
    configureWidth(detailed?768:640);
    const ctx=canvas.getContext('2d',{alpha:false});
    if(!ctx)throw Error('Cannot sample video frames');
    for(const at of referenceFrameTimes(shot,playhead,video.duration)){
      const waiting=once('seeked',10000);
      video.currentTime=at;
      await waiting;
      // The authenticated PHP gateway accepts at most 500k encoded chars per
      // image and 1.6MB overall. Compress locally instead of burning a quota
      // request on a detailed, high-entropy frame that exceeds those limits.
      if(detailed&&canvas.width!==768)configureWidth(768);
      ctx.drawImage(video,0,0,canvas.width,canvas.height);
      let quality=detailed?.78:.65;
      let imageDataUrl=canvas.toDataURL('image/jpeg',quality);
      while(imageDataUrl.length>460000&&quality>.5){
        quality=Math.max(.5,Math.round((quality-.08)*100)/100);
        imageDataUrl=canvas.toDataURL('image/jpeg',quality);
      }
      if(imageDataUrl.length>460000&&detailed){
        configureWidth(640);
        ctx.drawImage(video,0,0,canvas.width,canvas.height);
        imageDataUrl=canvas.toDataURL('image/jpeg',.65);
      }
      if(imageDataUrl.length>460000)throw Error('Reference frame is too large to submit safely.');
      frames.push({at:+at.toFixed(3),imageDataUrl});
    }
    return frames;
  } finally {
    video.removeAttribute('src');video.load();
  }
}
export function setupAiSceneEditor({getSequence,getActiveShot,getReferenceVideo,getPlayheadTime,onPreview,onDiscard,onAccept,onInspect}) {
  const loginArea=el('aiSceneLogin'),controls=el('aiSceneControls');
  const password=el('aiScenePassphrase'),loginButton=el('aiSceneSignIn');
  const create=el('aiSceneGenerate'),scope=el('aiSceneScope'),modelSelect=el('aiSceneModel'),inspect=el('aiSceneInspect'),accept=el('aiSceneAccept');
  const argonSettings=el('aiArgonSettings'),thinkingSelect=el('aiArgonThinking'),detailSelect=el('aiArgonDetail');
  const budgetField=el('aiArgonBudgetField'),budgetSelect=el('aiArgonBudget');
  const retryField=el('aiArgonRetryField'),retrySelect=el('aiArgonRetry');
  const addDetailField=el('aiArgonAddDetailField'),addDetailSelect=el('aiArgonAddDetail');
  const overlay=createArgonOverlay();
  // Chrome silently dismisses window.confirm() when the tab is not in front
  // (live 2026-10-23), which reads as Cancel. Paid requests ask in the page
  // instead, in a dialog that waits for an answer; confirm() is the fallback.
  const askPaid=(message,label)=>{
    const dialog=el('aiConfirm');
    if(typeof dialog?.showModal!=='function')
      return Promise.resolve(typeof confirm==='function'&&confirm(message));
    el('aiConfirmText').textContent=message;
    el('aiConfirmOk').textContent=label;
    return new Promise(resolve=>{
      const closed=()=>{dialog.removeEventListener('close',closed);resolve(dialog.returnValue==='ok');};
      dialog.returnValue='';
      dialog.addEventListener('close',closed);
      dialog.showModal();
    });
  };
  const notStarted=()=>{
    log('Paid request not started: the confirmation was cancelled or dismissed. Nothing was sent.');
    status('Not started. Nothing was sent or billed.');
  };
  // The thinking and detail selectors apply to Argon only.
  const showArgonSettings=()=>{
    if(argonSettings)argonSettings.hidden=!['argon_previs','argon_direct'].includes(modelSelect?.value);
    if(budgetField)budgetField.hidden=modelSelect?.value!=='argon_direct';
    if(retryField)retryField.hidden=modelSelect?.value!=='argon_direct';
    if(addDetailField)addDetailField.hidden=modelSelect?.value!=='argon_direct'||scope?.value==='subject';
  };
  modelSelect?.addEventListener?.('change',showArgonSettings);
  scope?.addEventListener?.('change',showArgonSettings);
  showArgonSettings();
  // Each detail level selects the budget it worked with live (2026-10-23):
  // High and Maximum came back empty at 32,768 and returned 106 to 153
  // objects at 65,536; Standard keeps 32,768. The budget is a ceiling (only
  // generated tokens are billed) and can still be changed afterwards.
  const recommendBudget=()=>{
    if(budgetSelect&&detailSelect)
      budgetSelect.value=['high','max'].includes(detailSelect.value)?'65536':'32768';
  };
  detailSelect?.addEventListener?.('change',recommendBudget);
  recommendBudget();
  const discard=el('aiSceneDiscard'),cleanupButton=el('aiSceneCleanup'),message=el('aiSceneStatus');
  const resumeArgon=el('aiSceneResumeArgon');
  const downloadArgon=el('aiSceneDownloadArgon');
  const checkArgon=el('aiSceneCheckArgon');
  const smokeButton=el('aiArgonSmokeRun'),smokeReset=el('aiArgonSmokeReset'),
    smokeSummary=el('aiArgonSmokeSummary');
  const smokeNames=['Minimal text, model defaults','Explicit native thinking_level=low',
    'Synthetic JPEG understanding','Structured JSON schema','Background text only',
    'Background with inline JPEG','Background with inline JPEG + JSON'];
  let smoke={step:0,state:'idle'};
  const updateSmoke=()=>{
    if(!smokeSummary)return;
    if(smoke.state==='done')smokeSummary.textContent='All seven Argon API stages passed. No client video was submitted.';
    else if(smoke.state==='failed')smokeSummary.textContent='Stopped on stage '+(smoke.step+1)+
      ': '+smokeNames[smoke.step]+'. You can explicitly retry this stage without replaying earlier paid tests.';
    else smokeSummary.textContent='Stage '+(smoke.step+1)+'/'+smokeNames.length+': '+smokeNames[smoke.step]+
      (smoke.state==='running'?' (background job running)':'');
    if(smokeButton){
      smokeButton.hidden=smoke.state==='done';
      smokeButton.textContent=smoke.state==='running'?'Check running Argon diagnostic (no new charge)':
        smoke.state==='failed'?'Retry stage '+(smoke.step+1)+' (paid)':
        'Run stage '+(smoke.step+1)+' (paid)';
    }
    if(smokeReset)smokeReset.hidden=smoke.state==='running';
  };
  const activity=el('aiSceneLog'),waitInfo=el('aiSceneWait');
  let csrf=null,authenticated=false,pending=null,pendingShot=null,busy=true,argonJob=null;
  let activityLines=[];
  const status=text=>{message.textContent=text;};
  const log=(description)=>{
    const time=new Date().toLocaleTimeString();
    activityLines.push(time+'  '+description);
    activityLines=activityLines.slice(-50);
    if(activity)activity.textContent=activityLines.join('\n');
  };
  const logDiagnostic=source=>{
    if(!source?.diagnostic)return;
    log(describeDiagnostic(source.diagnostic));
    if(SERVER_FAILURES.includes(source.diagnostic.reason))
      log('The provider request returned a server error. Google\'s billing FAQ says failed 400/500 requests are not charged for tokens (they still count against quota). Nothing was retried.');
    if(['provider_stream_error','provider_stream_interrupted'].includes(source.diagnostic.reason))
      log('The provider stream ended without a complete result. Any reported usage is shown above; billing is not confirmed by this connection error. Nothing was retried.');
    if(['job_interrupted_deploy','job_interrupted'].includes(source.diagnostic.reason))
      log('The cut-off call was not resubmitted. Its billing is not confirmed by this job status.');
  };
  const clearActivity=()=>{
    activityLines=[];
    if(activity)activity.textContent='';
    if(waitInfo)waitInfo.textContent='';
  };
  async function sendGeneration(payload,label){
    log('Gemini processing '+label+' (reasoning/geometry are not streamed by this API).');
    const started=Date.now();
    const timer=setInterval(()=>{
      if(waitInfo)waitInfo.textContent='Waiting on Gemini: '+Math.floor((Date.now()-started)/1000)+'s elapsed';
    },1000);
    try{
      const response=await request('generate',payload);
      log('Gemini response received for '+label+' ('+Math.max(0,Math.round((Date.now()-started)/1000))+'s).');
      return response;
    }finally{
      clearInterval(timer);
      if(waitInfo)waitInfo.textContent='';
    }
  }
  // Status checks are free and never resubmit a paid job, so they are safe to
  // retry. A phone that locks or backgrounds the tab makes them fail mid-wait:
  // network, 408, 429 and 5xx failures back off within the same bounded window.
  // Auth/input failures and terminal job failures stop immediately.
  async function pollArgon(shotId){
    log('Argon job accepted. Polling for completion (status checks are free and never resubmit)…');
    const started=Date.now();
    let prior='',failures=0,interrupted=false,counted=false;
    // A finished job reports its usage on every check; log it once.
    const count=usage=>{if(usage&&!counted){counted=true;log(describeUsage('Argon',usage));}};
    while(true){
      let result=null;
      try{result=await request('argon_status',{csrf});failures=0;}
      catch(error){
        count(error.usage); // a paid result the Worker could not use
        if(error.usage)throw error; // finished generation/validation failure, not a lost poll
        if(error.status&&!error.transient&&![408,429].includes(error.status)&&error.status<500)throw error;
        failures++;
        if(!interrupted)log('Status check interrupted ('+error.message+'). Retrying without a new paid request…');
        interrupted=true;
        status('Connection to the editor server interrupted — reconnecting to the existing Argon job…');
        overlay.phase('reconnecting');
      }
      if(result){
        interrupted=false;
        if(result.shotId!==shotId)throw Error('Argon job belongs to a different chapter');
        argonJob={shotId,status:result.status};
        if(result.status==='queued')overlay.phase('queued');
        else if(result.status==='in_progress')overlay.phase(result.phase||'waiting');
        if(result.status!==prior){
          prior=result.status;
          log('Argon job status: '+result.status+'.');
        }
        count(result.usage);
        if(result.status==='failed'&&result.diagnostic?.reason==='scene_schema_mismatch'&&
           Array.isArray(result.diagnostic.codes))
          log('No part of the returned scene was usable. Rule: '+result.diagnostic.codes.map(repairLabel).join(', ')+'.');
        if(result.status==='completed'){
          if(!result.proposal)throw Error('Argon completed without valid geometry');
          const repaired=describeRepairs(result.repairs);
          if(repaired)log(repaired);
          log('Argon model output received and validated by the Worker.');
          return result.proposal;
        }
        const stop=result.status==='failed'&&Object.hasOwn(JOB_STOPS,result.diagnostic?.reason)
          ?JOB_STOPS[result.diagnostic.reason]:null;
        const empty=result.diagnostic?.reason==='scene_schema_mismatch'&&
          Array.isArray(result.diagnostic.codes)&&result.diagnostic.codes.includes('empty');
        if(result.status==='failed')throw Object.assign(Error(empty
          ?'Argon answered with an empty scene (0 objects), so there is nothing to import.'
          :result.diagnostic?.reason==='scene_schema_mismatch'
          ?'Argon returned output, but no scene passed validation. Use Download original Argon output to inspect it.'
          :stop?'Argon job stopped on Cloudflare, not at Google. '+stop+' No geometry was returned.'
          :'Argon job failed on the provider. No geometry was returned.'),{diagnostic:result.diagnostic,usage:result.usage,argonTerminal:true});
        if(!['queued','in_progress'].includes(result.status))throw Error('Unrecognized Argon status');
        status('Argon '+result.status.replace('_',' ')+' — waiting for editable geometry…');
      }
      // Checked after a poll, so a tab resumed after the window still polls once.
      if(Date.now()-started>=16*60*1000)break;
      if(waitInfo)waitInfo.textContent='Argon processing: '+
        Math.floor((Date.now()-started)/1000)+'s elapsed';
      await pollPause(result?POLL_MS:Math.min(30000,POLL_MS*2**Math.min(failures-1,3)));
    }
    throw Error('Argon is still processing. Use Resume previous Argon job later; do not resubmit a paid request.');
  }
  function showProposal(doc,shot,fullEnvironment=false){
    doc=validatePrimitiveDocument(doc,getSequence().shots.map(s=>s.id));
    if(doc.scenes.length!==1||doc.scenes[0].shotId!==shot.id)
      throw Error('Model returned geometry for the wrong shot.');
    if(getActiveShot()?.id!==shot.id)
      throw Error('Selected chapter changed; return to its chapter to preview.');
    log('Checking planar overlaps and exact duplicate shapes…');
    const result=cleanupPrimitiveDocument(doc,getSequence().shots.map(s=>s.id));
    log(cleanupSummary(result.report));
    if(pending){onDiscard();pending=null;pendingShot=null;}
    pending=result.document.scenes[0];pendingShot=shot.id;
    onPreview(pending);
    // Repeat arrays render many copies per editable object.
    const rendered=pending.objects.reduce((sum,item)=>sum+(item.repeat?
      item.repeat.count[0]*item.repeat.count[1]*item.repeat.count[2]:1),0);
    log('Preview ready: '+pending.objects.length+' editable objects'+
      (rendered>pending.objects.length?' ('+rendered+' rendered parts)':'')+'. No scene saved.');
    if(pending.camera)log('Preview starts from the model\'s estimate of the reference camera; timeline cameras are unchanged.');
    if(pending.lights)log('Scene lights: '+pending.lights.length+' ('+pending.lights.map(l=>l.type).join(', ')+
      '), shown only during this chapter.');
    const counts=fullEnvironment||pending.objects.some(o=>o.layer)?ENVIRONMENT_PASSES.map(p=>
      p.label+': '+pending.objects.filter(o=>o.layer===p.id).length).join(' · '):'';
    if(counts)log('Layers: '+counts+'.');
    status('Preview: '+pending.objects.length+' editable objects. '+(counts?counts+'. ':'')+
      'Inspect, accept or discard. No changes saved yet.');
  }
  const ui=()=>{
    loginArea.hidden=authenticated;
    controls.hidden=!authenticated;
    loginButton.disabled=busy;
    create.disabled=busy||!authenticated;
    scope.disabled=busy;
    if(modelSelect)modelSelect.disabled=busy;
    if(thinkingSelect)thinkingSelect.disabled=busy;
    if(detailSelect)detailSelect.disabled=busy;
    if(budgetSelect)budgetSelect.disabled=busy;
    if(retrySelect)retrySelect.disabled=busy;
    if(addDetailSelect)addDetailSelect.disabled=busy;
    if(checkArgon)checkArgon.disabled=busy||!authenticated;
    if(smokeButton)smokeButton.disabled=busy||!authenticated;
    if(smokeReset)smokeReset.disabled=busy||!authenticated;
    updateSmoke();
    if(resumeArgon){resumeArgon.hidden=!authenticated||!argonJob||!!pending;
      resumeArgon.disabled=busy||!authenticated;}
    if(downloadArgon){
      downloadArgon.hidden=!authenticated||!argonJob||!['completed','failed'].includes(argonJob.status);
      downloadArgon.disabled=busy||!authenticated;
    }
    inspect.hidden=!pending;inspect.disabled=busy||!pending;
    accept.hidden=!pending; discard.hidden=!pending;
    if(cleanupButton){cleanupButton.hidden=!pending;cleanupButton.disabled=busy||!pending;}
    accept.disabled=busy;discard.disabled=busy;
  };
  const sessionEnded=()=>{
    authenticated=false;csrf=null;
    status('Your PHP session is no longer active. Sign in again to generate a scene.');
  };
  async function checkLogin(){
    try {
      const session=await readServerSession();
      authenticated=session.authenticated;
      csrf=authenticated?session.csrf:null;
      argonJob=authenticated?session.argonJob:null;
      smoke=authenticated&&session.argonSmoke?session.argonSmoke:{step:0,state:'idle'};
      status(authenticated?(argonJob?'Argon job available; use Resume previous Argon job.':
        'Private AI gateway ready.'):'Sign in with your editor passphrase to generate 3D scenes.');
    } catch(error){
      authenticated=false;csrf=null;
      status('AI gateway unavailable: '+error.message+'. Check PHP support and private paiver.php.');
    } finally {busy=false;ui();}
  }
  loginButton.addEventListener('click',async()=>{
    if(busy)return;
    busy=true;ui();status('Signing in…');
    try {
      const result=await request('login',{passphrase:password.value});
      if(!result.authenticated)throw Error('PHP did not confirm sign-in');
      password.value='';
      // Verify that the PHP session cookie survived an entirely new request.
      // A login POST can succeed even when a browser/host discards its session.
      const verified=await readServerSession();
      if(!verified.authenticated){
        authenticated=false;csrf=null;
        status('Sign-in was accepted, but PHP did not retain your session. Open the editor directly in Safari and try again. If it continues, check 50webs PHP session storage.');
      } else {
        csrf=verified.csrf;authenticated=true;argonJob=verified.argonJob||null;
        smoke=verified.argonSmoke||{step:0,state:'idle'};
        status('Connected. Select a draft chapter and generate its 3D blockout.');
      }
    }catch(error){authenticated=false;csrf=null;status(error.message);}
    finally{busy=false;ui();}
  });
  create.addEventListener('click',async()=>{
    if(busy||!authenticated)return;
    const shot=getActiveShot();
    if(!shot){status('Select a chapter first.');return;}
    if(getSequence().videoIntake&&el('showRef')?.checked===false){
      status('Reattach your imported MP4 before requesting an AI scene.');
      return;
    }
    busy=true;ui();clearActivity();
    log('Checking your authenticated editor session…');
    try {
      // Check PHP's actual current session BEFORE decoding/compressing video.
      const session=await readServerSession();
      if(!session.authenticated){sessionEnded();return;}
      csrf=session.csrf;
      log('Session verified; reference source and chapter selected.');
      const fullEnvironment=scope.value!=='subject';
      // Support older cached dropdown markup while sending the new profile
      // format. Neither reasoning level nor deadlines come from the browser.
      const selected=modelSelect?.value||'lite_default';
      const profile=selected==='gemini-3.5-flash-lite'?'lite_default'
        :selected==='gemini-3.8-flash'?'g38_low':selected;
      if(!['lite_default','g38_low','g38_medium','argon_previs','argon_direct'].includes(profile))
        throw Error('Unsupported AI profile selected');
      const argon=profile==='argon_previs'||profile==='argon_direct';
      if(fullEnvironment&&profile==='g38_medium')
        throw Error('Medium thinking requires Primary subject only.');
      if(fullEnvironment&&profile==='argon_previs')
        throw Error('Argon Previs requires Primary subject only. Use Argon Direct image for a full scene.');
      // Argon Direct image rebuilds a full scene in its ONE call, not four passes.
      const argonFull=fullEnvironment&&profile==='argon_direct';
      const thinking=ARGON_THINKING.includes(thinkingSelect?.value)?thinkingSelect.value:'medium';
      const detail=Object.hasOwn(ARGON_DETAIL_LABELS,detailSelect?.value||'')?detailSelect.value:'standard';
      const largeBudget=profile==='argon_direct'&&budgetSelect?.value==='65536';
      const tokenBudget=largeBudget?65536:32768;
      const retryEnabled=profile==='argon_direct'&&retrySelect?.checked===true;
      const addDetailEnabled=argonFull&&addDetailSelect?.checked===true;
      const settings='Settings: '+thinking+' thinking, '+ARGON_DETAIL_LABELS[detail]+' detail. '+
        tokenBudget.toLocaleString('en-US')+' tokens maximum for thinking + output.'+
        (thinking==='high'||detail==='max'?' An answer cut off at the limit keeps only the objects it finished, and every generated token is billed.':'');
      if(argon){
        if(argonJob&&['queued','in_progress'].includes(argonJob.status))
          throw Error('An Argon job already exists. Resume it instead of starting another paid request.');
        if(!await askPaid(settings+' '+(profile==='argon_direct'
          ?'Start EXPERIMENTAL paid Gemini 4 Argon direct-image generation'+(argonFull?' of the FULL SCENE':'')+'? This makes ONE potentially billable initial call: the reference JPEGs are sent directly to Gemini 4 Argon. A Cloudflare job holds the request for up to 12 minutes and keeps THE REFERENCE IMAGES only until Argon answers; Google is asked not to store the request or result. Nothing falls back automatically. This uses one request slot and may run for several minutes.'+
            (retryEnabled?' You authorize up to THREE automatic paid retries as new identical jobs, with a 15-second pause before each retry. Each preceding attempt must either finish with an unusable scene AND reported thinking plus output strictly below 10,000 tokens, or have its start conclusively marked as never received by Google. At most FOUR total attempts (one initial plus three retries); each uses a separate request slot and bills its own input and generated tokens. Interrupted calls, provider errors and unknown or partial usage never trigger a retry.':'')+
            (addDetailEnabled?' After the base succeeds, you also authorize TWO additional potentially billable Argon detail calls using the same three JPEG frames and a bounded index of existing geometry. Each uses another request slot and bills its own input and generated tokens. They add new objects rather than replacing the base scene. An interrupted or failed detail pass stops further calls and retains successful geometry.':'')+
            (largeBudget?' The thinking + output ceiling is 65,536 tokens instead of 32,768, on the same call; Google bills only the tokens Argon generates, up to 65,536.':'')
          :'Start paid Gemini 4 Argon Previs? This makes up to two potentially billable calls: Gemini 3.5 Flash-Lite analyzes the reference JPEGs, then Gemini 4 Argon generates geometry in the background from TEXT ONLY. Google stores the visual description and generated scene, not the images in the background job. This uses two request slots and may run for several minutes.'),
          'Start paid Argon run')){notStarted();return;}
      }
      if(profile==='argon_direct')overlay.show({totalStages:addDetailEnabled?3:1});
      log('Preparing reference frames from the selected chapter…');
      status('Sampling the selected playhead frame and two chapter context frames…');
      const frames=await sampleVideo(getReferenceVideo(),shot,getPlayheadTime?.(),
        fullEnvironment&&!argon?'standard':'primary');
      log(frames.length+' reference JPEG frames sampled.');
      log('Generation profile: '+({lite_default:'Gemini 3.5 Flash-Lite',
        g38_low:'Gemini 3.8 Low',g38_medium:'Gemini 3.8 Medium',
        argon_previs:'Gemini 4 Argon Previs (paid background)',
        argon_direct:'Gemini 4 Argon direct image (experimental, paid)'}[profile])+'.');
      let doc;
      if(fullEnvironment&&!argon){
        let assembled=[];
        for(let i=0;i<ENVIRONMENT_PASSES.length;i++){
          const pass=ENVIRONMENT_PASSES[i];
          const label='pass '+(i+1)+'/'+ENVIRONMENT_PASSES.length+' — '+pass.label;
          status('Reconstructing '+label+'…');
          log('Starting '+label+'…');
          const result=await sendGeneration({
            csrf,shotId:shot.id,frames,profile,layer:pass.id,existing:assembled
          },label);
          assembled=appendEnvironmentPass(shot.id,assembled,result.proposal,pass.id);
          log('Validated '+label+': '+assembled.filter(o=>o.layer===pass.id).length+' objects.');
        }
        log('Validating combined environment scene…');
        doc=validatePrimitiveDocument({schemaVersion:1,
          scenes:[{shotId:shot.id,objects:assembled}]},getSequence().shots.map(s=>s.id));
      }else {
        status('Gemini is analyzing reference views and generating editable geometry…');
        if(argon){
          log(profile==='argon_direct'
            ?'Sending '+frames.length+' reference frames directly to Gemini 4 Argon'+(argonFull?' for the full scene':'')+
              ' through a Cloudflare job (one potentially billable call)…'
            :'Analyzing 3 reference frames with Gemini 3.5 Flash-Lite, then starting text-only Argon background geometry (up to two potentially billable calls)…');
          const payload={csrf,shotId:shot.id,frames,profile,
            mode:argonFull?'full_scene':'primary_subject',thinking,detail,
            ...(profile==='argon_direct'?{tokenBudget}:{})};
          log('Argon '+settings.charAt(0).toLowerCase()+settings.slice(1));
          for(let attempt=0;attempt<=(retryEnabled?ARGON_RETRY_MAX:0);attempt++){
            try{
              const start=await request('argon_start',payload);
              if(start.usage)log(describeUsage('Flash-Lite analysis',start.usage));
              argonJob={shotId:shot.id,status:start.status};
              if(waitInfo)waitInfo.textContent='Argon job submitted';
              if(start.startUnconfirmed)
                log('Cloudflare did not confirm the start ('+describeLostStart(start.startUnconfirmed)+
                  '). Checking whether the job was created; no new paid request is sent. You may resume it after a page refresh.');
              else log('Paid Argon job started. You may resume it after a page refresh.');
              doc=await pollArgon(shot.id);
              argonJob={shotId:shot.id,status:'completed'};
              break;
            }catch(error){
              if(profile==='argon_previs'&&error.usage&&!error.argonTerminal)
                log(describeUsage('Flash-Lite analysis',error.usage));
              const reason=retryEnabled&&attempt<ARGON_RETRY_MAX?argonRetryReason(error):null;
              if(!reason)throw error;
              log((reason==='scene'?'The unusable scene used '+
                (error.usage.thinking+error.usage.output).toLocaleString('en-US')+' generated tokens (under 10,000).'
                :'The first start never reached Google.')+
                ' Retrying in 15 seconds ('+(attempt+1)+'/'+ARGON_RETRY_MAX+' permitted retries).');
              status('Argon failed cheaply; retry '+(attempt+1)+'/'+ARGON_RETRY_MAX+' starts in 15 seconds…');
              await new Promise(resolve=>setTimeout(resolve,ARGON_RETRY_DELAY_MS));
              log('Starting automatic paid Argon retry '+(attempt+1)+'/'+ARGON_RETRY_MAX+' as a new identical job…');
            }
          }
          if(addDetailEnabled&&doc){
            doc=validatePrimitiveDocument(doc,getSequence().shots.map(s=>s.id));
            for(let pass=1;pass<=2;pass++){
              const existing=argonDetailIndex(doc);
              if(!existing.length){
                log('Add Detail stopped: scene already at its 240-object safety cap.');
                break;
              }
              overlay.step(pass+1);
              status('Add Detail '+pass+'/2 — preserving the existing scene…');
              log('Starting paid Add Detail '+pass+'/2 with '+existing.length+' existing editable objects…');
              try{
                const started=await request('argon_start',{...payload,detailPass:pass,existing});
                argonJob={shotId:shot.id,status:started.status};
                if(started.startUnconfirmed)log('Add Detail start not confirmed; polling the named job (no resubmission).');
                const addition=await pollArgon(shot.id);
                const result=appendArgonDetail(doc,addition,shot.id);
                doc=result.document;
                argonJob={shotId:shot.id,status:'completed'};
                log('Add Detail '+pass+'/2 added '+result.added+' new editable objects; '+doc.scenes[0].objects.length+
                  ' objects and '+result.rendered+' rendered parts in total. Existing scene preserved.');
              }catch(error){
                log('Add Detail '+pass+'/2 stopped: '+error.message+'. Keeping all earlier successful geometry; no later detail pass submitted.');
                logDiagnostic(error);
                status('Detail pass stopped; previewing all previously completed geometry.');
                break;
              }
            }
          }
        }else{
          const result=await sendGeneration({csrf,shotId:shot.id,frames,profile,mode:'primary_subject'},
            'primary subject');
          doc=result.proposal;
        }
        log('Validating AI scene JSON and transforms…');
        doc=validatePrimitiveDocument(doc,getSequence().shots.map(s=>s.id));
      }
      showProposal(doc,shot,fullEnvironment);
    }catch(error){
      log('Generation failed: '+error.message);
      logDiagnostic(error);
      if(error.status===401){
        // PHP rejected generation because its session was lost between
        // preflight and the POST. Never leave the Generate button unlocked.
        sessionEnded();
      }else if(error.status===403&&error.message==='Invalid editor session token'){
        // The PHP session rotated while the frames were being sampled.
        // Refresh its CSRF token, or return to the sign-in UI if it expired.
        try{
          const session=await readServerSession();
          authenticated=session.authenticated;
          csrf=authenticated?session.csrf:null;
          if(authenticated)status('Your PHP session changed. Try generating again.');
          else sessionEnded();
        }catch{
          authenticated=false;csrf=null;
          status('The PHP session could not be verified. Sign in again.');
        }
      }else{
        status('AI proposal failed: '+error.message);
      }
      onDiscard();pending=null;pendingShot=null;
    }finally{overlay.hide();busy=false;ui();}
  });
  smokeButton?.addEventListener('click',async()=>{
    if(busy||!authenticated||smoke.state==='done')return;
    const isPoll=smoke.state==='running';
    const step=smoke.step;
    if(!isPoll){
      if(!await askPaid(
        (smoke.state==='failed'?'Retry':'Run')+' paid Argon diagnostic '+
        (step+1)+'/'+smokeNames.length+': '+smokeNames[step]+
        '? This submits exactly one additional potentially billable API request. No client footage is sent.',
        'Run paid diagnostic')){notStarted();return;}
    }
    busy=true;ui();
    try{
      const session=await readServerSession();
      if(!session.authenticated){sessionEnded();return;}
      csrf=session.csrf;smoke=session.argonSmoke||{step:0,state:'idle'};
      if(smoke.step!==step||(isPoll&&smoke.state!=='running')||
         (!isPoll&&!['idle','passed','failed'].includes(smoke.state)))
        throw Error('Diagnostic state changed; refresh its status before submitting.');
      const retry=!isPoll&&smoke.state==='failed';
      log((isPoll?'Polling existing':retry?'Retrying one paid':'Submitting one paid')+
        ' Argon diagnostic: '+smokeNames[step]+'…');
      const result=await request(isPoll?'argon_diag_poll':'argon_diag_step',
        isPoll?{csrf}:{csrf,step,...(retry?{retry:true}:{})});
      smoke={step:result.step,state:result.state};
      if(result.state==='done'||result.state==='passed'){
        log('Argon diagnostic '+(step+1)+'/'+smokeNames.length+' passed.');
        status('Argon diagnostic stage '+(step+1)+' passed. '+(smoke.state==='done'?
          'All tests complete.':'Confirm the next stage when ready.'));
      }else if(result.state==='running'){
        log('Argon background diagnostic accepted. Use Check running diagnostic to poll without starting another request.');
        status('Argon background diagnostic is running. Check again to retrieve its result.');
      }else{
        log('Argon diagnostic stage '+(step+1)+' did not pass. Sequence stopped.');
        logDiagnostic(result);
        status('Argon diagnostic stage '+(step+1)+' failed or returned no usable answer. Do not continue; inspect the error.');
      }
    }catch(error){
      log('Argon diagnostic error on stage '+(step+1)+': '+error.message);
      logDiagnostic(error);
      status('Argon diagnostic failed: '+error.message+' (no automatic retry)');
      // The PHP session is the authority, particularly if the worker timed out
      // and has already consumed the one allowed attempt.
      try{const session=await readServerSession();
        smoke=session.argonSmoke||{step,state:'failed'};csrf=session.csrf;
      }catch{smoke={step,state:'failed'};}
    }finally{busy=false;ui();}
  });
  smokeReset?.addEventListener('click',async()=>{
    if(busy||!authenticated||smoke.state==='running')return;
    if(!await askPaid('Restart Argon diagnostics from stage 1? This resets progress; new submissions can incur charges.',
      'Restart diagnostics'))return;
    busy=true;ui();
    try{
      const session=await readServerSession();
      if(!session.authenticated){sessionEnded();return;}
      csrf=session.csrf;
      const result=await request('argon_diag_reset',{csrf});
      smoke={step:result.step,state:result.state};
      log('Argon diagnostic sequence reset. No paid request submitted.');
      status('Diagnostics reset; stage 1 is ready. Each paid stage requires confirmation.');
    }catch(error){log('Diagnostic reset failed: '+error.message);
      status('Diagnostic reset failed: '+error.message);}
    finally{busy=false;ui();}
  });
  checkArgon?.addEventListener('click',async()=>{
    if(busy||!authenticated)return;
    busy=true;ui();
    log('Checking Gemini 4 Argon model metadata (no generation or reference frames)…');
    status('Checking Argon model visibility with your existing API key…');
    try{
      const session=await readServerSession();
      if(!session.authenticated){sessionEnded();return;}
      csrf=session.csrf;
      const result=await request('argon_check',{csrf});
      if(typeof result.available!=='boolean')throw Error('Model metadata check returned an invalid result');
      if(result.available){
        log('Google lists gemini-4-argon for this key. This does not guarantee generation entitlement.');
        status('Argon model metadata is visible. This does not guarantee paid generation access or request validity.');
      }else{
        log('Google does not expose gemini-4-argon model metadata for this API key.');
        status('Argon model metadata is not available for this key. Verify the Google AI Studio project, paid tier, and model availability before trying another paid generation.');
      }
    }catch(error){
      log('Argon model check failed: '+error.message);
      status('Argon model check failed: '+error.message+'. No paid generation was submitted.');
    }finally{busy=false;ui();}
  });
  downloadArgon?.addEventListener('click',async()=>{
    if(busy||!authenticated||!argonJob)return;
    busy=true;ui();
    let url;
    try{
      const result=await request('argon_output',{csrf});
      if(result.shotId!==argonJob.shotId||typeof result.output!=='string'||typeof result.partial!=='boolean')
        throw Error('Invalid Argon output download');
      url=URL.createObjectURL(new Blob([result.output],{type:'application/json;charset=utf-8'}));
      const link=document.createElement('a');
      link.href=url;link.download='argon-output-'+result.shotId+(result.partial?'-partial':'')+'.json';
      link.click();
      log('Downloaded '+(result.partial?'partial ':'')+'original Argon output. Nothing was generated or applied.');
    }catch(error){
      log('Argon output download: '+error.message);status('Argon output download: '+error.message);
    }finally{
      if(url)setTimeout(()=>URL.revokeObjectURL(url),1000);
      busy=false;ui();
    }
  });
  resumeArgon?.addEventListener('click',async()=>{
    if(busy||!authenticated||!argonJob)return;
    const shot=getActiveShot();
    if(!shot||shot.id!==argonJob.shotId){
      status('Select chapter '+argonJob.shotId+' to resume its Argon result.');return;
    }
    busy=true;ui();clearActivity();
    try{
      const session=await readServerSession();
      if(!session.authenticated){sessionEnded();return;}
      csrf=session.csrf;argonJob=session.argonJob;
      if(!argonJob||argonJob.shotId!==shot.id)throw Error('No Argon job for this chapter');
      log('Resuming existing paid Argon job without starting another request.');
      const proposal=await pollArgon(shot.id);
      argonJob={shotId:shot.id,status:'completed'};
      showProposal(proposal,shot);
    }catch(error){
      log('Argon resume: '+error.message);
      logDiagnostic(error);
      status('Argon resume: '+error.message);
    }finally{busy=false;if(waitInfo)waitInfo.textContent='';ui();}
  });
  inspect.addEventListener('click',()=>{
    if(pending&&!busy&&getActiveShot()?.id===pendingShot)onInspect?.(pendingShot);
  });
  cleanupButton?.addEventListener('click',()=>{
    if(busy||!pending)return;
    if(getActiveShot()?.id!==pendingShot){
      status('Chapter changed; return to the proposed scene to clean it.');return;
    }
    try{
      log('Manual cleanup: checking the current proposed geometry…');
      const result=cleanupPrimitiveDocument({schemaVersion:1,scenes:[pending]},
        getSequence().shots.map(s=>s.id));
      pending=result.document.scenes[0];
      onPreview(pending);
      const summary=cleanupSummary(result.report);
      log(summary);
      status(summary+' Preview updated; nothing saved until accepted.');
    }catch(error){log('Cleanup failed: '+error.message);status('Cleanup failed: '+error.message);}
    ui();
  });
  accept.addEventListener('click',()=>{
    if(!pending||busy)return;
    if(getActiveShot()?.id!==pendingShot){
      status('Chapter changed. Discard and regenerate before accepting.');return;
    }
    const current=getSequence().primitiveScenes?.scenes?.find(x=>x.shotId===pendingShot);
    if(current?.objects?.length&&!confirm('Replace existing objects in this shot with the proposed geometry?'))return;
    try{
      onAccept(pending);
      log('Preview accepted into the editable timeline.');
      status('Accepted. Geometry saved in your working timeline; export JSON for a backup.');
      pending=null;pendingShot=null;
    }catch(error){status('Could not accept geometry: '+error.message);}
    ui();
  });
  discard.addEventListener('click',()=>{
    if(busy)return;
    onDiscard();pending=null;pendingShot=null;
    log('Preview discarded. Saved geometry was not changed.');
    status('Preview discarded; saved geometry is unchanged.');ui();
  });
  ui();checkLogin();
  return {hasPending:()=>!!pending,reset:()=>{
    if(pending)onDiscard();
    pending=null;pendingShot=null;ui();
  }};
}
