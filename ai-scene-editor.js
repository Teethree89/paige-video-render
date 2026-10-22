import {validatePrimitiveDocument} from './primitive-schema.js';
import {cleanupPrimitiveDocument,cleanupSummary} from './primitive-cleanup.js';
import {referenceFrameTimes,ENVIRONMENT_PASSES,appendEnvironmentPass} from './environment-generation.js';

const el=id=>document.getElementById(id);
const api='./scene-proxy.php';
const headers={'Content-Type':'application/json','X-Paige-Client':'SceneStudio'};

async function request(action,data={}) {
  const response=await fetch(api,{
    method:'POST',credentials:'same-origin',headers,
    body:JSON.stringify({action,...data})
  });
  const result=await response.json().catch(()=>({error:'The PHP endpoint returned an invalid response'}));
  if(!response.ok||!result.ok){
    const error=Error(result.error||'Scene request failed');
    error.status=response.status;
    throw error;
  }
  return result;
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
  const discard=el('aiSceneDiscard'),cleanupButton=el('aiSceneCleanup'),message=el('aiSceneStatus');
  const resumeArgon=el('aiSceneResumeArgon');
  const checkArgon=el('aiSceneCheckArgon');
  const smokeButton=el('aiArgonSmokeRun'),smokeReset=el('aiArgonSmokeReset'),
    smokeSummary=el('aiArgonSmokeSummary');
  const smokeNames=['Minimal text, model defaults','Explicit native thinking_level=low',
    'Synthetic JPEG understanding','Structured JSON schema','Background text only',
    'Background with Google Files JPEG','Background with Files JPEG + JSON'];
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
  async function pollArgon(shotId){
    log('Argon background job accepted by Google. Polling for completion…');
    const started=Date.now();
    let prior='';
    while(Date.now()-started<10*60*1000){
      const result=await request('argon_status',{csrf});
      if(result.shotId!==shotId)throw Error('Argon job belongs to a different chapter');
      if(result.status!==prior){
        prior=result.status;
        log('Argon background status: '+result.status+'.');
      }
      if(result.status==='completed'){
        if(!result.proposal)throw Error('Argon completed without valid geometry');
        log('Argon model output received and validated by the Worker.');
        return result.proposal;
      }
      if(result.status==='failed')throw Error('Argon job failed on the provider. No geometry was returned.');
      if(!['queued','in_progress'].includes(result.status))throw Error('Unrecognized Argon status');
      if(waitInfo)waitInfo.textContent='Argon processing on Google: '+
        Math.floor((Date.now()-started)/1000)+'s elapsed';
      status('Argon Previs '+result.status.replace('_',' ')+' — waiting for editable geometry…');
      await new Promise(resolve=>setTimeout(resolve,5000));
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
    log('Preview ready: '+pending.objects.length+' editable objects. No scene saved.');
    const counts=fullEnvironment?ENVIRONMENT_PASSES.map(p=>
      p.label+': '+pending.objects.filter(o=>o.layer===p.id).length).join(' · '):'';
    status('Preview: '+pending.objects.length+' editable objects. '+counts+
      '. Inspect, accept or discard. No changes saved yet.');
  }
  const ui=()=>{
    loginArea.hidden=authenticated;
    controls.hidden=!authenticated;
    loginButton.disabled=busy;
    create.disabled=busy||!authenticated;
    scope.disabled=busy;
    if(modelSelect)modelSelect.disabled=busy;
    if(checkArgon)checkArgon.disabled=busy||!authenticated;
    if(smokeButton)smokeButton.disabled=busy||!authenticated;
    if(smokeReset)smokeReset.disabled=busy||!authenticated;
    updateSmoke();
    if(resumeArgon){resumeArgon.hidden=!authenticated||!argonJob||!!pending;
      resumeArgon.disabled=busy||!authenticated;}
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
      if(!['lite_default','g38_low','g38_medium','argon_previs'].includes(profile))
        throw Error('Unsupported AI profile selected');
      if(fullEnvironment&&['g38_medium','argon_previs'].includes(profile))
        throw Error('Medium and Argon require Primary subject only.');
      if(profile==='argon_previs'){
        if(argonJob&&['queued','in_progress'].includes(argonJob.status))
          throw Error('An Argon job already exists. Resume it instead of starting another paid request.');
        if(typeof confirm==='function'&&!confirm('Start paid Gemini 4 Argon Previs? This makes up to two paid calls: reference image analysis, then background geometry generation. Google stores the visual description and generated scene. This uses two request slots and may run for several minutes.'))
          return;
      }
      log('Preparing reference frames from the selected chapter…');
      status('Sampling the selected playhead frame and two chapter context frames…');
      const frames=await sampleVideo(getReferenceVideo(),shot,getPlayheadTime?.(),
        fullEnvironment?'standard':'primary');
      log(frames.length+' reference JPEG frames sampled.');
      log('Generation profile: '+({lite_default:'Gemini 3.5 Flash-Lite',
        g38_low:'Gemini 3.8 Low',g38_medium:'Gemini 3.8 Medium',
        argon_previs:'Gemini 4 Argon Previs (paid background)'}[profile])+'.');
      let doc;
      if(fullEnvironment){
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
        if(profile==='argon_previs'){
          log('Analyzing reference images, then starting text-only Argon background geometry (up to two paid calls)…');
          const start=await request('argon_start',{csrf,shotId:shot.id,frames,profile,mode:'primary_subject'});
          argonJob={shotId:shot.id,status:start.status};
          if(waitInfo)waitInfo.textContent='Argon background job submitted';
          log('Paid Argon job started. You may resume it after a page refresh.');
          doc=await pollArgon(shot.id);
          argonJob={shotId:shot.id,status:'completed'};
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
    }finally{busy=false;ui();}
  });
  smokeButton?.addEventListener('click',async()=>{
    if(busy||!authenticated||smoke.state==='done')return;
    const isPoll=smoke.state==='running';
    const step=smoke.step;
    if(!isPoll){
      if(typeof confirm!=='function'||!confirm(
        (smoke.state==='failed'?'Retry':'Run')+' paid Argon diagnostic '+
        (step+1)+'/'+smokeNames.length+': '+smokeNames[step]+
        '? This submits exactly one additional potentially billable API request. No client footage is sent.'))return;
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
        status('Argon diagnostic stage '+(step+1)+' failed or returned no usable answer. Do not continue; inspect the error.');
      }
    }catch(error){
      log('Argon diagnostic error on stage '+(step+1)+': '+error.message);
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
    if(typeof confirm!=='function'||!confirm(
      'Restart Argon diagnostics from stage 1? This resets progress; new submissions can incur charges.'))return;
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
      log('Resuming existing paid Argon background job without starting another request.');
      const proposal=await pollArgon(shot.id);
      argonJob={shotId:shot.id,status:'completed'};
      showProposal(proposal,shot);
    }catch(error){
      log('Argon resume: '+error.message);
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
