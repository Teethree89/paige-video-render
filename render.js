import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {buildWorld} from './world.js';
import {createDraftWorld} from './draft-world.js';
const $=id=>document.getElementById(id);
const out=$('output'), ctx=out.getContext('2d',{alpha:false});
const source=document.createElement('canvas');
const renderer=new THREE.WebGLRenderer({canvas:source,antialias:true,preserveDrawingBuffer:true,powerPreference:'high-performance'});
renderer.setPixelRatio(1);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.35;
const scene=new THREE.Scene(),cam=new THREE.PerspectiveCamera(50,16/9,.35,500);const world=buildWorld(scene),draftWorld=createDraftWorld(scene);
let seq,modelCount=0,frameRequest=0,previewing=false,recording=false,previewStart=0,previewTime=0,recorder=null;
const lerp=(a,b,u)=>a+(b-a)*u, ease=u=>u*u*(3-2*u), clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function modelId(id){return id==='hallreturn'?'hall':id==='finale'?'exterior':id;}
function shotAt(t){return seq.shots.find((s,i)=>t>=s.start&&(t<s.end||i===seq.shots.length-1))||seq.shots[0];}
function cameraAt(t){const keys=seq.camera.slice().sort((a,b)=>a.at-b.at);if(t<=keys[0].at)return keys[0];for(let i=0;i<keys.length-1;i++){const a=keys[i],b=keys[i+1];if(t>=a.at&&t<b.at){if(b.cut)return a;const u=ease(clamp((t-a.at)/(b.at-a.at),0,1));return{p:a.p.map((v,j)=>lerp(v,b.p[j],u)),t:a.t.map((v,j)=>lerp(v,b.t[j],u)),fov:lerp(a.fov,b.fov,u)};}}return keys[keys.length-1];}
function labelsAt(t){if(!$('captions').checked)return;const W=out.width,H=out.height;
 for(const tx of seq.text){if(t<tx.start||t>=tx.end)continue;let alpha=clamp(Math.min((t-tx.start)/.58,(tx.end-t)/.55),0,1);if(alpha<=0)continue;
 ctx.save();ctx.globalAlpha=alpha;ctx.textBaseline='top';ctx.shadowColor='rgba(0,0,0,.97)';ctx.shadowBlur=W*.014;ctx.shadowOffsetY=H*.004;
 const fontSize=({'small':17,'medium':26,'large':40,'hero':50}[tx.size]||26)*W/1280;
 ctx.font=`700 ${Math.round(fontSize)}px Inter,Arial,sans-serif`;ctx.textAlign=tx.align||'center';
 const text=String(tx.value).split('\n'),lh=fontSize*1.15,sub=tx.subtitle||'',allH=text.length*lh+(sub?fontSize*.73:0);
 const x=tx.x*W/100,y=tx.y*H/100-allH/2;
 const fill=tx.tone==='cyan'?'#acffff':tx.tone==='amber'?'#ffd6a0':'#f7faff';ctx.fillStyle=fill;
 // For left/right aligned captions, the original CSS centers the caption box but aligns text inside it.
 const widest=Math.max(...text.map(v=>ctx.measureText(v).width),sub?ctx.measureText(sub).width:0);
 const anchor=tx.align==='left'?x-widest*.5:tx.align==='right'?x+widest*.5:x;
 text.forEach((line,i)=>ctx.fillText(line,anchor,y+i*lh));
 if(sub){ctx.fillStyle='#dbe5ea';ctx.font=`400 ${Math.max(12,Math.round(fontSize*.46))}px Inter,Arial,sans-serif`;ctx.fillText(sub,anchor,y+text.length*lh+fontSize*.13);}
 ctx.restore();
 }
}
function render(t){if(!seq)return;const c=cameraAt(t);cam.position.set(...c.p);cam.lookAt(...c.t);cam.fov=c.fov;cam.aspect=16/9;cam.updateProjectionMatrix();const currentShot=shotAt(t);world.update(t,currentShot.id);draftWorld.update(currentShot);renderer.render(scene,cam);ctx.drawImage(source,0,0,out.width,out.height);
 // Approximate viewport's vignette in the output so the scene exports without editor chrome.
 const gr=ctx.createLinearGradient(0,0,0,out.height);gr.addColorStop(0,'rgba(3,8,13,.25)');gr.addColorStop(.26,'rgba(3,8,13,0)');gr.addColorStop(.75,'rgba(4,11,17,0)');gr.addColorStop(1,'rgba(4,11,17,.48)');ctx.fillStyle=gr;ctx.fillRect(0,0,out.width,out.height);
 labelsAt(t);
 // Match source timeline's intentionally brief black flash at camera cuts.
 let flash=0;for(const k of seq.camera){if(!k.cut||k.at<=0)continue;const dt=Math.abs(t-k.at);if(dt<.17)flash=Math.max(flash,(1-dt/.17)*.72);}if(flash){ctx.fillStyle=`rgba(3,11,18,${flash})`;ctx.fillRect(0,0,out.width,out.height);}
}
function resize(){const w=Number($('size').value);out.width=source.width=w;out.height=source.height=Math.round(w*9/16);renderer.setSize(w,out.height,false);cam.aspect=w/out.height;cam.updateProjectionMatrix();render(previewTime);}
async function loadModels(){const response=await fetch('./assets/models/manifest.json',{cache:'no-store'});if(!response.ok)throw Error('Missing GLB manifest');const manifest=await response.json(),loader=new GLTFLoader();let failed=[];
 for(const id of ['exterior','hall','pcb','atoms','laser','fiber','optics']){
  const ent=manifest.models?.[id];if(!ent?.enabled)continue;
  try{const u=new URL(ent.url,location.href);if(u.origin!==location.origin)throw Error('Cross origin model');const result=await loader.loadAsync(u.href);world.replaceModel(id,result.scene,ent);modelCount++;$('info').textContent=`Loading linked models ${modelCount}/7…`;}catch(e){failed.push(`${id}: ${e.message}`);}
 }
 if(failed.length)console.warn('Procedural fallback:',failed);return failed;
}
function chosenType(){const choices=[['video/mp4;codecs="avc1.42E01E"','mp4'],['video/mp4','mp4'],['video/webm;codecs=vp9','webm'],['video/webm;codecs=vp8','webm'],['video/webm','webm']];return choices.find(([m])=>MediaRecorder.isTypeSupported(m))||null;}
function animationLoop(now){if(!seq)return;if(recording){previewTime=clamp((now-previewStart)/1000,0,seq.duration);render(previewTime);$('progress').value=previewTime/seq.duration;$('status').textContent=`Recording ${previewTime.toFixed(1)} / ${seq.duration.toFixed(1)} seconds — keep this tab open`;if(previewTime>=seq.duration){recording=false;recorder.stop();}}else if(previewing){previewTime=clamp((now-previewStart)/1000,0,seq.duration);render(previewTime);if(previewTime>=seq.duration)previewing=false;}frameRequest=requestAnimationFrame(animationLoop);}
$('size').onchange=()=>{if(!recording)resize();};$('captions').onchange=()=>{if(!recording)render(previewTime);};
$('preview').onclick=()=>{if(recording)return;previewing=!previewing;if(previewing){if(previewTime>=seq.duration)previewTime=0;previewStart=performance.now()-previewTime*1000;}$('preview').textContent=previewing?'Pause preview':'Preview / Pause';};
$('export').onclick=()=>{
 if(!seq||recording)return;if(typeof MediaRecorder==='undefined'||!out.captureStream){alert('Use a recent version of Chrome or Edge for browser video recording.');return;}
 const choice=chosenType();if(!choice){alert('Your browser does not support MediaRecorder video encoding.');return;}
 const [mime,ext]=choice;const stream=out.captureStream(Number($('fps').value));const chunks=[];
 try{recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:out.width>=1920?15000000:9000000});}catch(error){alert('Unable to start encoder: '+error.message);stream.getTracks().forEach(t=>t.stop());return;}
 recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onerror=e=>{console.error(e);$('status').textContent='Recorder failed; check browser permissions and console.';};
 recorder.onstop=()=>{stream.getTracks().forEach(t=>t.stop());const blob=new Blob(chunks,{type:mime});const link=document.createElement('a'),u=URL.createObjectURL(blob);link.href=u;link.download=`Atoms-to-AI-${$('captions').checked?'titles':'clean'}-${out.width}x${out.height}.${ext}`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(u),300000);$('status').textContent=`Saved ${ext.toUpperCase()} (${(blob.size/1048576).toFixed(1)} MB). ${ext==='webm'?'Use convert_to_mp4 to make an H.264 MP4.':'MP4 is ready to import into After Effects.'}`;$('export').disabled=false;$('preview').disabled=false;$('size').disabled=false;$('fps').disabled=false;$('captions').disabled=false;};
 previewing=false;previewTime=0;resize();render(0);$('export').disabled=true;$('preview').disabled=true;$('size').disabled=true;$('fps').disabled=true;$('captions').disabled=true;$('progress').value=0;
 recorder.start(500);recording=true;previewStart=performance.now();$('status').textContent='Recording started…';
};
async function boot(){let original=await fetch('./timeline.json').then(r=>{if(!r.ok)throw Error('timeline.json missing');return r.json();});let cached=null;try{cached=JSON.parse(localStorage.getItem('atoms-ai-sequence-v1')||'null');}catch(e){}seq=(cached&&cached.duration>0&&Array.isArray(cached.camera)&&Array.isArray(cached.text)&&Array.isArray(cached.shots))?cached:original;
 resize();const failed=await loadModels();render(0);$('info').textContent=`Ready · ${seq.duration.toFixed(2)} seconds · ${modelCount}/7 linked GLBs${failed.length?' ('+failed.length+' procedural fallback)':''}`;$('export').disabled=false;$('preview').disabled=false;frameRequest=requestAnimationFrame(animationLoop);const codec=chosenType();$('status').textContent=codec?`Ready to record ${codec[1].toUpperCase()}. ${seq.camera.length} camera keys and ${seq.text.length} text overlays detected.`:'No MediaRecorder codec found in this browser.';}
boot().catch(e=>{$('status').textContent='Unable to initialize: '+e.message;$('info').textContent='Check browser console and serve project with an HTTP server.';console.error(e);});
