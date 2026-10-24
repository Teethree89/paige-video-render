import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {buildWorld} from './world.js';
import {createDraftWorld} from './draft-world.js';
import {createPrimitiveWorld} from './primitive-world.js';
import {shotAnchorMap,restoreSavedPrimitiveWorld} from './primitive-preview.js';
import {evaluateCamera,curveEasing} from './animation-curves.js';
import {clipPlanesForScene} from './camera-motion-sync.js';
import {effectsForShot,applyShotEffects,createScenePostprocessor,paintVignette} from './scene-effects.js';
import {createGenerationSounds} from './generation-sounds.js';
const $=id=>document.getElementById(id);
const out=$('output'), ctx=out.getContext('2d',{alpha:false});
const source=document.createElement('canvas');
const renderer=new THREE.WebGLRenderer({canvas:source,antialias:true,preserveDrawingBuffer:true,powerPreference:'high-performance'});
renderer.setPixelRatio(1);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.35;
const scene=new THREE.Scene(),cam=new THREE.PerspectiveCamera(50,16/9,.35,500);const world=buildWorld(scene),draftWorld=createDraftWorld(scene),primitiveWorld=createPrimitiveWorld(scene);
let seq,modelCount=0,frameRequest=0,previewing=false,recording=false,previewStart=0,previewTime=0,recorder=null;
const renderBoundsCache=new Map();
const post=createScenePostprocessor(renderer,scene,cam);
const generationSounds=createGenerationSounds();
let exportFinalized=false;
const finalExportSound=outcome=>{
 if(exportFinalized)return;
 exportFinalized=true;
 void generationSounds.play(outcome);
};
const lerp=(a,b,u)=>a+(b-a)*u, ease=u=>u*u*(3-2*u), clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function modelId(id){return id==='hallreturn'?'hall':id==='finale'?'exterior':id;}
function shotAt(t){return seq.shots.find((s,i)=>t>=s.start&&(t<s.end||i===seq.shots.length-1))||seq.shots[0];}
function cameraAt(t){return evaluateCamera(seq.camera,t);}
function labelsAt(t){if(!$('captions').checked)return;const W=out.width,H=out.height;
 for(const tx of seq.text){if(t<tx.start||t>=tx.end)continue;let alpha=clamp(Math.min(curveEasing((t-tx.start)/.58,{mode:tx.textFade||'linear'}),curveEasing((tx.end-t)/.55,{mode:tx.textFade||'linear'})),0,1);if(alpha<=0)continue;
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
function render(t){
 if(!seq)return;
 const c=cameraAt(t),currentShot=shotAt(t);
 if(!renderBoundsCache.has(currentShot.id))
   renderBoundsCache.set(currentShot.id,primitiveWorld.getBounds(currentShot.id));
 const planes=clipPlanesForScene(c.p,c.t,renderBoundsCache.get(currentShot.id));
 cam.position.set(...c.p);cam.lookAt(...c.t);cam.fov=c.fov;cam.aspect=16/9;
 cam.near=planes.near;cam.far=planes.far;cam.updateProjectionMatrix();
 const custom=primitiveWorld.hasObjects(currentShot.id);world.update(t,currentShot.id,custom);primitiveWorld.showShot(currentShot.id);draftWorld.update(currentShot,custom);
 const profile=applyShotEffects(scene,renderer,effectsForShot(seq,currentShot.id));
 post.configure(profile);post.render();ctx.drawImage(source,0,0,out.width,out.height);
 // Match the saved chapter vignette while omitting editor controls.
 paintVignette(ctx,out.width,out.height,profile);
 labelsAt(t);
 // Match source timeline's intentionally brief black flash at camera cuts.
 let flash=0;for(const k of seq.camera){if(!k.cut||k.at<=0)continue;const dt=Math.abs(t-k.at);if(dt<.17)flash=Math.max(flash,(1-dt/.17)*.72);}if(flash){ctx.fillStyle=`rgba(3,11,18,${flash})`;ctx.fillRect(0,0,out.width,out.height);}
}
function resize(){const w=Number($('size').value);out.width=source.width=w;out.height=source.height=Math.round(w*9/16);renderer.setSize(w,out.height,false);post.setSize(w,out.height);cam.aspect=w/out.height;cam.updateProjectionMatrix();render(previewTime);}
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
 if(!seq||recording)return;
 if(typeof MediaRecorder==='undefined'||!out.captureStream){
   alert('Use a recent version of Chrome or Edge for browser video recording.');return;
 }
 const choice=chosenType();
 if(!choice){alert('Your browser does not support MediaRecorder video encoding.');return;}
 generationSounds.arm(); // prime sound on the export click, long before onstop
 exportFinalized=false;
 const [mime,ext]=choice,stream=out.captureStream(Number($('fps').value)),chunks=[];
 let failed=false;
 const unlock=()=>{$('export').disabled=false;$('preview').disabled=false;
   $('size').disabled=false;$('fps').disabled=false;$('captions').disabled=false;};
 try{
   recorder=new MediaRecorder(stream,{mimeType:mime,
     videoBitsPerSecond:out.width>=1920?15000000:9000000});
 }catch(error){
   alert('Unable to start encoder: '+error.message);
   stream.getTracks().forEach(t=>t.stop());finalExportSound('failed');return;
 }
 recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
 recorder.onerror=e=>{
   console.error(e);failed=true;recording=false;
   $('status').textContent='Recorder failed; check browser permissions and console.';
   finalExportSound('failed'); // onstop can still arrive; never play success too
   unlock();
 };
 recorder.onstop=()=>{
   stream.getTracks().forEach(t=>t.stop());
   try{
     if(failed)throw Error('Recorder failed; no valid export created.');
     const blob=new Blob(chunks,{type:mime});
     if(!blob.size)throw Error('Recorder produced an empty video.');
     const link=document.createElement('a'),u=URL.createObjectURL(blob);
     link.href=u;
     link.download=`Atoms-to-AI-${$('captions').checked?'titles':'clean'}-${out.width}x${out.height}.${ext}`;
     document.body.append(link);link.click();link.remove();
     setTimeout(()=>URL.revokeObjectURL(u),300000);
     $('status').textContent=`Saved ${ext.toUpperCase()} (${(blob.size/1048576).toFixed(1)} MB). ${ext==='webm'?'Use convert_to_mp4 to make an H.264 MP4.':'MP4 is ready to import into After Effects.'}`;
     finalExportSound('success');
   }catch(error){
     $('status').textContent='Video export failed: '+error.message;
     finalExportSound('failed');
   }finally{recording=false;unlock();}
 };
 previewing=false;previewTime=0;resize();render(0);
 $('export').disabled=true;$('preview').disabled=true;
 $('size').disabled=true;$('fps').disabled=true;$('captions').disabled=true;$('progress').value=0;
 try{
   recorder.start(500);recording=true;previewStart=performance.now();
   $('status').textContent='Recording started…';
 }catch(error){
   stream.getTracks().forEach(t=>t.stop());recording=false;unlock();
   $('status').textContent='Unable to start recording: '+error.message;
   finalExportSound('failed');
 }
};
async function boot(){let original=await fetch('./timeline.json').then(r=>{if(!r.ok)throw Error('timeline.json missing');return r.json();});let cached=null;try{cached=JSON.parse(localStorage.getItem('atoms-ai-sequence-v1')||'null');}catch(e){}seq=(cached&&cached.duration>0&&Array.isArray(cached.camera)&&Array.isArray(cached.text)&&Array.isArray(cached.shots))?cached:original;
 renderBoundsCache.clear();
 const geometryError=restoreSavedPrimitiveWorld(primitiveWorld,seq,shotAnchorMap(seq,cameraAt));
 resize();const failed=await loadModels();render(0);$('info').textContent=`Ready · ${seq.duration.toFixed(2)} seconds · ${modelCount}/7 linked GLBs${failed.length?' ('+failed.length+' procedural fallback)':''}`;$('export').disabled=!!geometryError;$('preview').disabled=false;frameRequest=requestAnimationFrame(animationLoop);const codec=chosenType();$('status').textContent=geometryError?'Saved geometry could not be loaded. Return to the editor and export Timeline JSON for repair; the saved project is retained.':codec?`Ready to record ${codec[1].toUpperCase()}. ${seq.camera.length} camera keys and ${seq.text.length} text overlays detected.`:'No MediaRecorder codec found in this browser.';}
boot().catch(e=>{$('status').textContent='Unable to initialize: '+e.message;$('info').textContent='Check browser console and serve project with an HTTP server.';console.error(e);});
