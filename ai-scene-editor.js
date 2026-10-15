import {validatePrimitiveDocument} from './primitive-schema.js';
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
async function sampleVideo(reference,shot,playhead) {
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
    canvas.width=640;
    canvas.height=Math.max(2,Math.round(640*video.videoHeight/video.videoWidth));
    const ctx=canvas.getContext('2d',{alpha:false});
    if(!ctx)throw Error('Cannot sample video frames');
    for(const at of referenceFrameTimes(shot,playhead,video.duration)){
      const waiting=once('seeked',10000);
      video.currentTime=at;
      await waiting;
      ctx.drawImage(video,0,0,canvas.width,canvas.height);
      const imageDataUrl=canvas.toDataURL('image/jpeg',.65);
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
  const create=el('aiSceneGenerate'),scope=el('aiSceneScope'),inspect=el('aiSceneInspect'),accept=el('aiSceneAccept');
  const discard=el('aiSceneDiscard'),message=el('aiSceneStatus');
  let csrf=null,authenticated=false,pending=null,pendingShot=null,busy=true;
  const status=text=>{message.textContent=text;};
  const ui=()=>{
    loginArea.hidden=authenticated;
    controls.hidden=!authenticated;
    loginButton.disabled=busy;
    create.disabled=busy||!authenticated;
    scope.disabled=busy;
    inspect.hidden=!pending;inspect.disabled=busy||!pending;
    accept.hidden=!pending; discard.hidden=!pending;
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
      status(authenticated?'Private AI gateway ready.':'Sign in with your editor passphrase to generate 3D scenes.');
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
        csrf=verified.csrf;authenticated=true;
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
    busy=true;ui();
    try {
      // Check PHP's actual current session BEFORE decoding/compressing video.
      const session=await readServerSession();
      if(!session.authenticated){sessionEnded();return;}
      csrf=session.csrf;
      const fullEnvironment=scope.value!=='subject';
      status('Sampling the selected playhead frame and two chapter context frames…');
      const frames=await sampleVideo(getReferenceVideo(),shot,getPlayheadTime?.());
      let doc;
      if(fullEnvironment){
        let assembled=[];
        for(let i=0;i<ENVIRONMENT_PASSES.length;i++){
          const pass=ENVIRONMENT_PASSES[i];
          status('Reconstructing environment '+(i+1)+' / '+ENVIRONMENT_PASSES.length+': '+pass.label+'…');
          const result=await request('generate',{
            csrf,shotId:shot.id,frames,layer:pass.id,existing:assembled
          });
          assembled=appendEnvironmentPass(shot.id,assembled,result.proposal,pass.id);
        }
        doc=validatePrimitiveDocument({schemaVersion:1,
          scenes:[{shotId:shot.id,objects:assembled}]},getSequence().shots.map(s=>s.id));
      }else {
        status('Gemini is proposing the primary subject…');
        const result=await request('generate',{csrf,shotId:shot.id,frames});
        doc=validatePrimitiveDocument(result.proposal,getSequence().shots.map(s=>s.id));
      }
      if(doc.scenes.length!==1||doc.scenes[0].shotId!==shot.id)
        throw Error('Model returned geometry for the wrong shot.');
      if(getActiveShot()?.id!==shot.id)throw Error('Selected chapter changed; generate again.');
      if(pending){onDiscard();pending=null;pendingShot=null;}
      pending=doc.scenes[0];pendingShot=shot.id;
      onPreview(pending);
      const counts=fullEnvironment?ENVIRONMENT_PASSES.map(p=>
        p.label+': '+pending.objects.filter(o=>o.layer===p.id).length).join(' · '):'';
      status('Preview: '+pending.objects.length+' editable objects. '+counts+
        '. Inspect, accept or discard. No changes saved yet.');
    }catch(error){
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
  inspect.addEventListener('click',()=>{
    if(pending&&!busy&&getActiveShot()?.id===pendingShot)onInspect?.(pendingShot);
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
      status('Accepted. Geometry saved in your working timeline; export JSON for a backup.');
      pending=null;pendingShot=null;
    }catch(error){status('Could not accept geometry: '+error.message);}
    ui();
  });
  discard.addEventListener('click',()=>{
    if(busy)return;
    onDiscard();pending=null;pendingShot=null;
    status('Preview discarded; saved geometry is unchanged.');ui();
  });
  ui();checkLogin();
  return {reset:()=>{
    if(pending)onDiscard();
    pending=null;pendingShot=null;ui();
  }};
}
