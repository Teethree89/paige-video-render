import {validatePrimitiveDocument} from './primitive-schema.js';

const el=id=>document.getElementById(id);
const api='./scene-proxy.php';
const headers={'Content-Type':'application/json','X-Paige-Client':'SceneStudio'};

async function request(action,data={}) {
  const response=await fetch(api,{
    method:'POST',credentials:'same-origin',headers,
    body:JSON.stringify({action,...data})
  });
  const result=await response.json().catch(()=>({error:'The PHP endpoint returned an invalid response'}));
  if(!response.ok||!result.ok)throw Error(result.error||'Scene request failed');
  return result;
}
async function sampleVideo(reference,shot) {
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
    for(let i=0;i<3;i++){
      const at=from+(to-from)*(i+1)/4;
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
export function setupAiSceneEditor({getSequence,getActiveShot,getReferenceVideo,onPreview,onDiscard,onAccept}) {
  const loginArea=el('aiSceneLogin'),controls=el('aiSceneControls');
  const password=el('aiScenePassphrase'),loginButton=el('aiSceneSignIn');
  const create=el('aiSceneGenerate'),accept=el('aiSceneAccept');
  const discard=el('aiSceneDiscard'),message=el('aiSceneStatus');
  let csrf=null,authenticated=false,pending=null,pendingShot=null,busy=false;
  const status=text=>{message.textContent=text;};
  const ui=()=>{
    loginArea.hidden=authenticated;
    controls.hidden=!authenticated;
    create.disabled=busy;
    accept.hidden=!pending; discard.hidden=!pending;
    accept.disabled=busy;discard.disabled=busy;
  };
  async function checkLogin(){
    try {
      const response=await fetch(api,{credentials:'same-origin',cache:'no-store'});
      const data=await response.json();
      if(!response.ok||!data.ok)throw Error(data.error||'PHP proxy is not ready');
      csrf=data.csrf;authenticated=!!data.authenticated;
      status(authenticated?'Private AI gateway ready.':'Sign in with your editor passphrase to generate 3D scenes.');
    } catch(error){
      status('AI gateway unavailable: '+error.message+'. Check PHP support and private paiver.php.');
    }
    ui();
  }
  loginButton.addEventListener('click',async()=>{
    if(busy)return;
    busy=true;ui();status('Signing in…');
    try {
      const res=await request('login',{passphrase:password.value});
      password.value='';csrf=res.csrf;authenticated=true;
      status('Connected. Select a draft chapter and generate its 3D blockout.');
    }catch(error){status(error.message);}finally{busy=false;ui();}
  });
  create.addEventListener('click',async()=>{
    if(busy||!authenticated)return;
    const shot=getActiveShot();
    if(!shot){status('Select a chapter first.');return;}
    if(getSequence().videoIntake&&el('showRef')?.checked===false){
      status('Reattach your imported MP4 before requesting an AI scene.');
      return;
    }
    if(pending){onDiscard();pending=null;pendingShot=null;}
    busy=true;ui();
    try {
      status('Sampling three representative frames locally…');
      const frames=await sampleVideo(getReferenceVideo(),shot);
      status('Gemini is proposing editable geometry…');
      const result=await request('generate',{csrf,shotId:shot.id,frames});
      const doc=validatePrimitiveDocument(result.proposal,getSequence().shots.map(s=>s.id));
      if(doc.scenes.length!==1||doc.scenes[0].shotId!==shot.id)
        throw Error('Model returned geometry for the wrong shot.');
      if(getActiveShot()?.id!==shot.id)throw Error('Selected chapter changed; generate again.');
      pending=doc.scenes[0];pendingShot=shot.id;
      onPreview(pending);
      status('Preview: '+pending.objects.length+' editable object(s). Accept to save, or discard. No changes saved yet.');
    }catch(error){status('AI proposal failed: '+error.message);onDiscard();pending=null;pendingShot=null;}
    finally{busy=false;ui();}
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
