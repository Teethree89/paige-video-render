import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {buildWorld} from './world.js';
import {setupModelTools} from './model-tools.js';
import {setupVideoImport} from './video-import.js';
import {createDraftWorld} from './draft-world.js';
import {createPrimitiveWorld} from './primitive-world.js';
import {setupPrimitiveEditor} from './primitive-editor.js';
import {validatePrimitiveDocument} from './primitive-schema.js';

const el=id=>document.getElementById(id);
const canvas=el('scene'),viewport=el('viewport');
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.7));
renderer.setSize(viewport.clientWidth,viewport.clientHeight);
renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=1.35;
renderer.shadowMap.enabled=false;
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(50,16/9,.35,500);
const controls=new OrbitControls(camera,renderer.domElement);
controls.enabled=false;controls.enableDamping=true;controls.dampingFactor=.08;controls.maxDistance=140;
const world=buildWorld(scene);
const draftWorld=createDraftWorld(scene);
const primitiveWorld=createPrimitiveWorld(scene);
let primitiveEditor=null,lastPrimitiveShotId=null;
function syncPrimitiveWorld(){
  primitiveWorld.setDocument(sequence.primitiveScenes,sequence.shots.map(s=>s.id));
  lastPrimitiveShotId=null;
  primitiveEditor?.refresh();
}
const referenceVideo=el('referenceVideo');referenceVideo.volume=0;
for(const id of ['playBtn','backBtn','nextBtn','addCameraBtn','addTextBtn','inspectBtn','loadBtn','exportBtn','resetBtn'])el(id).disabled=true;
let sequence,originalSequence,ready=false,playhead=0,playing=false,lastFrame=performance.now(),speed=1,selection=null,orbitMode=false;
const overlayEls=new Map();
const clamp=(n,a,b)=>Math.min(b,Math.max(a,n));
const lerp=(a,b,u)=>a+(b-a)*u;
const ease=u=>u*u*(3-2*u);
const fmt=t=>{let m=Math.floor(Math.max(0,t)/60),s=Math.max(0,t)-m*60;return String(m).padStart(2,'0')+':'+s.toFixed(2).padStart(5,'0');};
const atPercent=t=>((t/sequence.duration)*100)+'%';
const safeNum=(v,fallback=0)=>Number.isFinite(Number(v))?Number(v):fallback;

async function boot(){
 // A failed timeline fetch must never leave interactive transport controls half-initialized.
 let original=await fetch('./timeline.json').then(r=>{if(!r.ok)throw new Error('timeline.json not found');return r.json();});
 let cached=null;try{const raw=localStorage.getItem('atoms-ai-sequence-v1');if(raw)cached=JSON.parse(raw);}catch(e){}
 originalSequence=original;sequence=validSequence(cached)?cached:structuredClone(original);
 try{syncPrimitiveWorld();}catch(error){
   console.warn('Invalid cached primitive scenes: using original sequence',error);
   sequence=structuredClone(originalSequence);syncPrimitiveWorld();
 }
 refreshAll();seek(0,{force:true});ready=true;
 if(sequence.videoIntake){referenceVideo.style.display='none';el('showRef').checked=false;el('saveStatus').textContent='● REATTACH SOURCE VIDEO';}
 for(const id of ['playBtn','backBtn','nextBtn','addCameraBtn','addTextBtn','inspectBtn','loadBtn','exportBtn','resetBtn'])el(id).disabled=false;
 window.__atomsEditorStarted=true;animate(performance.now());
 setupModelTools(world,{onSceneChanged:()=>renderWorld()});
 primitiveEditor=setupPrimitiveEditor({
   getSequence:()=>sequence,
   getActiveShot:()=>shotAt(playhead),
   world:primitiveWorld,
   onDocumentChange:doc=>{
     sequence.primitiveScenes=doc;
     syncPrimitiveWorld();
     saveLocal();renderWorld();
   }
 });
 setupVideoImport({onApply:({timeline,videoUrl})=>{
   if(!validSequence(timeline))throw Error('Generated timeline is invalid');
   setPlaying(false);selection=null;orbitMode=false;controls.enabled=false;
   referenceVideo.pause();referenceVideo.src=videoUrl;referenceVideo.load();
   referenceVideo.style.display='block';el('showRef').checked=true;
   sequence=timeline;syncPrimitiveWorld();refreshAll();seek(0);saveLocal();
   el('saveStatus').textContent='● VIDEO DRAFT SAVED · SOURCE LOCAL';
 }});
}
function validSequence(s){return !!(s&&Number.isFinite(s.duration)&&s.duration>0&&Array.isArray(s.shots)&&s.shots.length&&Array.isArray(s.camera)&&s.camera.length&&Array.isArray(s.text));}
function saveLocal(){try{localStorage.setItem('atoms-ai-sequence-v1',JSON.stringify(sequence));}catch(e){}el('saveStatus').textContent='● SAVED LOCALLY';}
function shotAt(t){return sequence.shots.find((s,i)=>t>=s.start&&(t<s.end||i===sequence.shots.length-1))||sequence.shots[0];}
function cameraAt(t){let keys=sequence.camera.slice().sort((a,b)=>a.at-b.at);let first=keys[0];if(t<=first.at)return first;for(let i=0;i<keys.length-1;i++){let a=keys[i],b=keys[i+1];if(t>=a.at&&t<b.at){if(b.cut)return a;let u=ease(clamp((t-a.at)/(b.at-a.at),0,1));return{p:a.p.map((v,j)=>lerp(v,b.p[j],u)),t:a.t.map((v,j)=>lerp(v,b.t[j],u)),fov:lerp(a.fov,b.fov,u)};}}return keys[keys.length-1];}
function applyCamera(){if(orbitMode&&!playing)return;const c=cameraAt(playhead);camera.position.set(...c.p);camera.lookAt(...c.t);camera.fov=c.fov;camera.updateProjectionMatrix();controls.target.set(...c.t);}
function seek(t,opts={}){playhead=clamp(t,0,sequence.duration);if(!opts.fromFrame){lastFrame=performance.now();if(!playing){try{referenceVideo.currentTime=playhead;}catch(e){}}}if(orbitMode&&!playing){}else applyCamera();refreshPlayhead();renderOverlays();renderShotName();renderWorld();}
function renderWorld(){const shot=shotAt(playhead);world.update(playhead,shot.id);primitiveWorld.showShot(shot.id);
 draftWorld.update(shot,primitiveWorld.hasObjects(shot.id));
 if(lastPrimitiveShotId!==shot.id){lastPrimitiveShotId=shot.id;primitiveEditor?.refresh();}
 let cuts=sequence.camera.filter(k=>k.cut&&k.at>0).map(k=>k.at);let alpha=0;for(let cut of cuts){let diff=Math.abs(playhead-cut);if(diff<.17)alpha=Math.max(alpha,(1-diff/.17)*.72);}el('cutFlash').style.opacity=String(alpha);}
function animate(now){let dt=Math.min(.09,(now-lastFrame)/1000);lastFrame=now;
 if(playing){let next=playhead+dt*speed;if(next>=sequence.duration){next=sequence.duration;setPlaying(false);}seek(next,{fromFrame:true});if(referenceVideo.readyState>=2&&Math.abs(referenceVideo.currentTime-playhead)>.15){try{referenceVideo.currentTime=playhead;}catch(e){}}}
 if(controls.enabled)controls.update();renderer.render(scene,camera);requestAnimationFrame(animate);
}
function renderShotName(){let shot=shotAt(playhead),i=sequence.shots.indexOf(shot);el('shotTitle').textContent=String(i+1).padStart(2,'0')+' / '+shot.title;el('stageName').textContent=shot.name;el('shotIndex').textContent=String(i+1).padStart(2,'0');for(const node of document.querySelectorAll('.chapter-item'))node.classList.toggle('current',node.dataset.shot===shot.id);}
function renderOverlays(){for(let item of sequence.text){let dom=overlayEls.get(item.id);if(!dom)continue;let active=playhead>=item.start&&playhead<item.end,fade=.58,fadeOut=.55;let opacity=active?Math.min(1,(playhead-item.start)/fade,(item.end-playhead)/fadeOut):0;dom.style.opacity=String(clamp(opacity,0,1));dom.style.display=opacity>0?'block':'none';dom.style.left=item.x+'%';dom.style.top=item.y+'%';dom.style.textAlign=item.align||'center';dom.className='scene-caption '+(item.size||'medium')+' '+(item.tone||'white');dom.querySelector('.main-copy').textContent=item.value;dom.querySelector('.sub-copy').textContent=item.subtitle||'';}
}
function rebuildOverlayDom(){el('overlayLayer').replaceChildren();overlayEls.clear();for(let item of sequence.text){let dom=document.createElement('div');dom.className='scene-caption';let main=document.createElement('div');main.className='main-copy';let sub=document.createElement('div');sub.className='sub-copy';dom.append(main,sub);el('overlayLayer').appendChild(dom);overlayEls.set(item.id,dom);}renderOverlays();}
function refreshPlayhead(){el('playhead').style.left=atPercent(playhead);el('clock').innerHTML=`${fmt(playhead)} <span>/</span> ${fmt(sequence.duration)}`;}
function renderTimeline(){let ruler=el('ruler'),shotTrack=el('shotTrack'),camTrack=el('cameraTrack'),textTrack=el('textTrack');ruler.replaceChildren();shotTrack.replaceChildren();camTrack.replaceChildren();textTrack.replaceChildren();
 for(let sec=0;sec<=sequence.duration;sec+=5){let tick=document.createElement('span');tick.className='ruler-tick';tick.style.left=atPercent(sec);tick.textContent=`${String(sec).padStart(2,'0')}s`;ruler.append(tick);}
 for(let s of sequence.shots){let d=document.createElement('div');d.className='shot-item '+(s.tone==='amber'?'amber':s.tone==='purple'?'purple':'');d.style.left=atPercent(s.start);d.style.width=((s.end-s.start)/sequence.duration*100)+'%';d.textContent=s.name;d.title=`${fmt(s.start)} · ${s.name}`;d.onclick=e=>{e.stopPropagation();selection=null;orbitMode=false;controls.enabled=false;renderInspector();seek(s.start+.01);};shotTrack.append(d);}
 for(let key of sequence.camera){let d=document.createElement('div');d.className='key-marker '+(key.cut?'cut-key ':'')+(selection?.type==='camera'&&selection.id===key.id?'selected':'');d.style.left=atPercent(key.at);d.title=`Camera ${fmt(key.at)}${key.cut?' · CUT':''}`;d.onclick=e=>{e.stopPropagation();select('camera',key.id);seek(key.at);};camTrack.append(d);}
 for(let tx of sequence.text){let d=document.createElement('div');d.className='text-item '+(tx.size==='hero'?'hero-text ':'')+(selection?.type==='text'&&selection.id===tx.id?'selected':'');d.style.left=atPercent(tx.start);d.style.width=((tx.end-tx.start)/sequence.duration*100)+'%';d.title=tx.value.replaceAll('\n',' ')+' ('+fmt(tx.start)+')';d.textContent=tx.value.replaceAll('\n',' ');d.onclick=e=>{e.stopPropagation();select('text',tx.id);seek(Math.min(tx.start+.5,tx.end-.04));};textTrack.append(d);}
 el('keyCount').textContent=String(sequence.camera.length);el('textCount').textContent=String(sequence.text.length);}
function renderChapters(){let parent=el('chapterList');parent.replaceChildren();for(let s of sequence.shots){let d=document.createElement('button');d.className='chapter-item';d.dataset.shot=s.id;const time=document.createElement('span');time.className='chapter-time';time.textContent=fmt(s.start).slice(0,5);const dot=document.createElement('span');dot.className='chapter-dot '+(s.tone==='amber'?'amber':s.tone==='purple'?'purple':'');let label=document.createElement('span');label.textContent=s.name;d.append(time,dot,label);d.onclick=()=>{selection=null;orbitMode=false;controls.enabled=false;renderInspector();seek(s.start+.001);};parent.append(d);}renderShotName();}
function refreshAll(){renderTimeline();renderChapters();rebuildOverlayDom();renderInspector();refreshPlayhead();}
function select(type,id){selection={type,id};renderInspector();renderTimeline();}
function selectedData(){return selection?sequence[selection.type==='camera'?'camera':'text'].find(i=>i.id===selection.id):null;}
function renderInspector(){let item=selectedData();el('projectPanel').hidden=!!item;el('cameraPanel').hidden=!item||selection.type!=='camera';el('textPanel').hidden=!item||selection.type!=='text';el('inspectorHeading').textContent=!item?'Project settings':selection.type==='camera'?'Camera keyframe':'Text overlay';el('inspectorHint').textContent=!item?'Select a timeline item to adjust its animation.':selection.type==='camera'?'Edit position, focal target, lens and cut behavior.':'Adjust wording, timing, screen location and styling.';
 if(!item)return;
 if(selection.type==='camera'){el('camTime').textContent='KEYFRAME @ '+fmt(item.at);for(let input of document.querySelectorAll('[data-cam]')){let [k,i]=input.dataset.cam.split('.');input.value=String(+item[k][Number(i)].toFixed(2));}el('camFov').value=item.fov;el('camCut').checked=!!item.cut;}
 else{el('textValue').value=item.value;el('textSubtitle').value=item.subtitle||'';for(let field of ['Start','End','X','Y'])el('text'+field).value=item[field.toLowerCase()];el('textSize').value=item.size||'medium';el('textAlign').value=item.align||'center';el('textTone').value=item.tone||'white';}
}
function setPlaying(value){if(!ready||!sequence)return;playing=!!value;el('playBtn').textContent=playing?'Ⅱ':'▶';if(playing){orbitMode=false;controls.enabled=false;el('inspectBtn').classList.remove('active');if(playhead>=sequence.duration-.01)seek(0);if(el('showRef').checked){let p=referenceVideo.play();if(p?.catch)p.catch(()=>{});}}else referenceVideo.pause();lastFrame=performance.now();}
function shotBoundary(direction){if(!ready||!sequence)return;let shot=shotAt(playhead);let val;if(direction<0){let prev=sequence.shots.filter(s=>s.start<shot.start-.03).at(-1);val=playhead-shot.start>.6?shot.start:prev?.start??0;}else val=sequence.shots.find(s=>s.start>playhead+.05)?.start??sequence.duration;setPlaying(false);seek(val+.001);}
function addCameraKey(){if(!ready||!sequence)return;setPlaying(false);const pos=camera.position.toArray(),tar=controls.target.toArray(),at=+playhead.toFixed(3);let id='c'+Date.now();let key={id,at,p:pos.map(x=>+x.toFixed(3)),t:tar.map(x=>+x.toFixed(3)),fov:camera.fov,cut:false};sequence.camera.push(key);sequence.camera.sort((a,b)=>a.at-b.at);select('camera',id);saveLocal();}
function addText(){if(!ready||!sequence)return;setPlaying(false);const at=+playhead.toFixed(3),id='tx'+Date.now(),item={id,start:at,end:Math.min(at+3,sequence.duration),value:'Your headline here',subtitle:'Supporting detail',x:50,y:42,size:'medium',align:'center',tone:'white'};sequence.text.push(item);selection={type:'text',id};refreshAll();saveLocal();}
function deleteSelected(){let data=selectedData();if(!data)return;if(selection.type==='camera'&&sequence.camera.length<=2){alert('The sequence needs at least two camera keys.');return;}let arr=sequence[selection.type];arr.splice(arr.indexOf(data),1);selection=null;refreshAll();saveLocal();seek(playhead,{force:true});}
const tracks=el('tracks');let dragging=false;
function pointerSeek(e){if(!ready||!sequence)return;const r=tracks.getBoundingClientRect(),x=clamp((e.clientX-r.left)/r.width,0,1);if(playing)setPlaying(false);seek(x*sequence.duration);}
tracks.addEventListener('pointerdown',e=>{if(e.target.closest('.key-marker,.text-item,.shot-item'))return;dragging=true;tracks.setPointerCapture(e.pointerId);pointerSeek(e);});
tracks.addEventListener('pointermove',e=>{if(dragging)pointerSeek(e);});tracks.addEventListener('pointerup',()=>dragging=false);tracks.addEventListener('pointercancel',()=>dragging=false);
// Pointer-specific Play/Pause handler. Keyboard Space continues to use setPlaying().
// Lifting the transport prevents visual overlays from swallowing mouse clicks.
const playButton=el('playBtn');
const playTransport=playButton.closest('.transport');
if(playTransport){playTransport.style.position='relative';playTransport.style.zIndex='30';}
playButton.style.position='relative';
playButton.style.zIndex='31';
playButton.style.pointerEvents='auto';
playButton.addEventListener('pointerdown',event=>{
 if(event.button!==0||!ready||!sequence)return;
 event.preventDefault();
 setPlaying(!playing);
});
// Keyboard activation via Enter and programmatic .click() still work.
// Pointer-generated clicks are ignored to prevent a second toggle.
playButton.addEventListener('click',event=>{
 if(event.detail===0&&ready&&sequence)setPlaying(!playing);
});
el('backBtn').onclick=()=>shotBoundary(-1);el('nextBtn').onclick=()=>shotBoundary(1);
el('speed').onchange=e=>speed=Number(e.target.value)||1;
el('addCameraBtn').onclick=addCameraKey;el('addTextBtn').onclick=addText;
el('inspectBtn').onclick=()=>{if(!ready||!sequence)return;if(playing)setPlaying(false);orbitMode=!orbitMode;controls.enabled=orbitMode;el('inspectBtn').classList.toggle('active',orbitMode);if(orbitMode)controls.target.set(...cameraAt(playhead).t);else applyCamera();};
el('captureBtn').onclick=()=>{const item=selectedData();if(!item||selection.type!=='camera')return;item.p=camera.position.toArray().map(x=>+x.toFixed(3));item.t=controls.target.toArray().map(x=>+x.toFixed(3));item.fov=camera.fov;orbitMode=false;controls.enabled=false;el('inspectBtn').classList.remove('active');renderInspector();saveLocal();};
for(let input of document.querySelectorAll('[data-cam]'))input.addEventListener('input',e=>{let d=selectedData();if(!d)return;let [k,j]=input.dataset.cam.split('.');d[k][Number(j)]=safeNum(input.value);orbitMode=false;controls.enabled=false;el('inspectBtn').classList.remove('active');applyCamera();saveLocal();});
el('camFov').oninput=e=>{let d=selectedData();if(!d)return;d.fov=clamp(safeNum(e.target.value,50),10,110);applyCamera();saveLocal();};
el('camCut').onchange=e=>{let d=selectedData();if(!d)return;d.cut=e.target.checked;renderTimeline();saveLocal();};
el('removeCameraBtn').onclick=deleteSelected;el('removeTextBtn').onclick=deleteSelected;
for(let [field,key] of [['textValue','value'],['textSubtitle','subtitle'],['textStart','start'],['textEnd','end'],['textX','x'],['textY','y'],['textSize','size'],['textAlign','align'],['textTone','tone']])el(field).addEventListener('input',e=>{let d=selectedData();if(!d)return;const numeric=['start','end','x','y'].includes(key);d[key]=numeric?safeNum(e.target.value):e.target.value;if(key==='start')d.start=clamp(d.start,0,sequence.duration-.1);if(key==='end')d.end=clamp(d.end,d.start+.1,sequence.duration);if(key==='x'||key==='y')d[key]=clamp(d[key],0,100);renderTimeline();renderOverlays();saveLocal();});
el('exportBtn').onclick=()=>{if(!ready||!sequence)return;const json=JSON.stringify(sequence,null,2),blob=new Blob([json],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='atoms-to-ai-timeline.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);el('saveStatus').textContent='● EXPORTED';};
el('resetBtn').onclick=()=>{if(!ready||!sequence)return;if(!confirm('Reset all camera and text edits to the original timeline?'))return;sequence=structuredClone(originalSequence);syncPrimitiveWorld();referenceVideo.pause();referenceVideo.src='assets/reference.mp4';referenceVideo.load();referenceVideo.style.display='block';el('showRef').checked=true;selection=null;setPlaying(false);orbitMode=false;controls.enabled=false;refreshAll();seek(0);saveLocal();};
el('loadBtn').onclick=()=>{if(!ready)return;el('loadFile').click();};el('loadFile').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{let data=JSON.parse(await file.text());if(!validSequence(data))throw Error('JSON must include valid duration, shots, camera and text arrays.');validatePrimitiveDocument(data.primitiveScenes,data.shots.map(s=>s.id));sequence=data;syncPrimitiveWorld();setPlaying(false);selection=null;orbitMode=false;controls.enabled=false;refreshAll();seek(0);saveLocal();}catch(err){alert('Could not import timeline: '+err.message);}e.target.value='';};
el('showRef').onchange=e=>{referenceVideo.style.display=e.target.checked?'block':'none';if(!e.target.checked)referenceVideo.pause();else if(playing)referenceVideo.play().catch(()=>{});};
referenceVideo.addEventListener('loadedmetadata',()=>{try{referenceVideo.currentTime=playhead;}catch(e){}});
window.addEventListener('keydown',e=>{const target=e.target;if(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement||target.isContentEditable)return;
 if(e.code==='Space'){e.preventDefault();if(ready)setPlaying(!playing);}if(e.code==='ArrowRight'){e.preventDefault();if(ready){setPlaying(false);seek(playhead+1/30);}}if(e.code==='ArrowLeft'){e.preventDefault();if(ready){setPlaying(false);seek(playhead-1/30);}}if(e.code==='Delete'||e.code==='Backspace'){e.preventDefault();if(ready)deleteSelected();}});
new ResizeObserver(()=>{let w=viewport.clientWidth,h=viewport.clientHeight;if(w<=0||h<=0)return;camera.aspect=w/h;camera.updateProjectionMatrix();renderer.setSize(w,h);}).observe(viewport);
boot().catch(error=>{el('errorBanner').hidden=false;el('errorBanner').textContent='Project could not start: '+error.message;console.error(error);});
