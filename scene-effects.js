// Shared browser preview/video visual pipeline. The scene document stores
// only safe fog/bloom/tonal settings; no generated shader code is permitted.
import * as THREE from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {validateSceneEffects} from './primitive-schema.js';

export const DEFAULT_EFFECTS=Object.freeze({
 fog:{mode:'default',color:'#526779',density:.008},
 bloom:{enabled:false,strength:.45,threshold:.8,radius:.35},
 exposure:1.35,vignette:.45
});
export function effectsForShot(sequence,shotId){
 return validateSceneEffects(sequence?.primitiveScenes?.scenes?.find(x=>x.shotId===shotId)?.effects)
   ||structuredClone(DEFAULT_EFFECTS);
}
// World.update() assigns scene.fog density every frame; apply this AFTER that
// update so saved chapter settings have priority and never spill between shots.
export function applyShotEffects(scene,renderer,effects,{
 originalFogColor='#050d17',defaultExposure=1.35,review=false
}={}){
 const profile=validateSceneEffects(effects)||structuredClone(DEFAULT_EFFECTS);
 if(scene.fog){
   if(profile.fog.mode==='custom'){
     scene.fog.color.set(profile.fog.color);
     scene.fog.density=review?0:profile.fog.density;
   }else{
     scene.fog.color.set(originalFogColor);
     if(profile.fog.mode==='off'||review)scene.fog.density=0;
     // 'default' retains the environment's world.update density.
   }
 }
 renderer.toneMappingExposure=review?Math.max(1.65,profile.exposure):profile.exposure;
 return profile;
}
export function createScenePostprocessor(renderer,scene,camera){
 let composer=null,bloom=null,enabled=false,width=1,height=1,pixelRatio=renderer.getPixelRatio();
 function syncPixelRatio(){
   if(!composer)return;
   const next=renderer.getPixelRatio();
   if(next!==pixelRatio){pixelRatio=next;composer.setPixelRatio(next);}
 }
 function ensure(){
   if(composer)return;
   composer=new EffectComposer(renderer);
   pixelRatio=renderer.getPixelRatio();
   composer.addPass(new RenderPass(scene,camera));
   bloom=new UnrealBloomPass(new THREE.Vector2(width,height),.45,.35,.8);
   composer.addPass(bloom);
   composer.addPass(new OutputPass());
   composer.setSize(width,height);
 }
 function setSize(w,h){
   width=Math.max(1,Math.floor(w));height=Math.max(1,Math.floor(h));
   if(composer){syncPixelRatio();composer.setSize(width,height);}
 }
 function configure(profile){
   enabled=!!profile?.bloom?.enabled&&profile.bloom.strength>0;
   if(!enabled)return;
   ensure();
   bloom.strength=profile.bloom.strength;
   bloom.radius=profile.bloom.radius;
   bloom.threshold=profile.bloom.threshold;
 }
 function render(){
   if(enabled){ensure();syncPixelRatio();composer.render();}
   else renderer.render(scene,camera);
 }
 return {setSize,configure,render,get enabled(){return enabled;}};
}
export function vignetteOpacity(profile){
 // Existing editor vignette is the default. 0 turns it fully off.
 const v=profile?.vignette??.45;
 return Math.max(0,Math.min(1,v/.45));
}
export function vignetteStyle(profile){
 const strength=profile?.vignette??.45;
 const scale=Math.min(2.2,Math.max(0,strength/.45));
 const top=Math.min(.9,.25*scale),bottom=Math.min(.94,.48*scale);
 return `linear-gradient(180deg,rgba(3,8,13,${top}) 0%,transparent 26%,transparent 75%,rgba(4,11,17,${bottom}) 100%)`;
}
export function paintVignette(ctx,w,h,profile){
 const strength=profile?.vignette??.45;
 if(strength<=0)return;
 const scale=Math.min(2.2,strength/.45);
 const gr=ctx.createLinearGradient(0,0,0,h);
 gr.addColorStop(0,`rgba(3,8,13,${Math.min(.9,.25*scale)})`);
 gr.addColorStop(.26,'rgba(3,8,13,0)');
 gr.addColorStop(.75,'rgba(4,11,17,0)');
 gr.addColorStop(1,`rgba(4,11,17,${Math.min(.94,.48*scale)})`);
 ctx.fillStyle=gr;ctx.fillRect(0,0,w,h);
}
