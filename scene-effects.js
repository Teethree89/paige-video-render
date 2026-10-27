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
 shadows:{enabled:true},
 lights:{enabled:true,studio:true,spot:true,point:true,directional:true,area:true,spotMode:'real'},
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
 // Renderer-level gate skips every shadow-map pass without mutating the
 // saved castShadow flag or the light's color/intensity/illumination.
 renderer.shadowMap.enabled=profile.shadows.enabled&&profile.lights.enabled;
 // Separate procedural studio lighting from authored punctual lights.
 // Keep the previous visibility state for reversible, chapter-local overrides.
 const allowed=node=>{
   if(!profile.lights.enabled)return false;
   if(!node.userData.primitiveLight)return profile.lights.studio;
   const type=node.userData.primitiveLight;
   return profile.lights[type]!==false;
 };
 scene.traverse(node=>{
   if(!node.isLight)return;
   const fakeSpot=node.isSpotLight&&node.userData.primitiveLight==='spot'&&profile.lights.spot&&profile.lights.enabled&&profile.lights.spotMode!=='real'&& (profile.lights.spotMode==='fake'||(scene.userData.activeCamera&&scene.userData.activeCamera.position.distanceTo(node.getWorldPosition(new THREE.Vector3()))>=35));
   if(!allowed(node)||fakeSpot){
     if(!Object.hasOwn(node.userData,'chapterLightOriginalVisible'))node.userData.chapterLightOriginalVisible=node.visible;
     node.visible=false;
   }else if(Object.hasOwn(node.userData,'chapterLightOriginalVisible')){
     node.visible=node.userData.chapterLightOriginalVisible;
     delete node.userData.chapterLightOriginalVisible;
   }
 });
 updateFakeSpots(scene,scene.userData.activeCamera,profile);
 return profile;
}

const FAKE_SPOT_CACHE=new WeakMap();
function fakeSpotRig(scene){
 let rig=FAKE_SPOT_CACHE.get(scene);
 if(rig)return rig;
 const group=new THREE.Group();group.name='Runtime_fake_spotlights';group.userData.fakeSpotRig=true;
 const coneGeometry=new THREE.ConeGeometry(1,1,20,1,true);
 coneGeometry.translate(0,-.5,0);
 const beamMaterial=new THREE.ShaderMaterial({
   transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,
   uniforms:{},vertexShader:`
     varying vec3 vPos;varying vec3 vColor;
     void main(){vPos=position;vColor=instanceColor;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);}
   `,
   fragmentShader:`
     varying vec3 vPos;varying vec3 vColor;
     void main(){float fade=smoothstep(-1.0,-0.15,vPos.y)*(1.0-smoothstep(-0.12,0.0,vPos.y));
       gl_FragColor=vec4(vColor,0.045*fade);}
   `
 });
 const poolGeometry=new THREE.PlaneGeometry(2,2);
 const poolMaterial=new THREE.ShaderMaterial({
   transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,
   vertexShader:`varying vec2 vUv;varying vec3 vColor;void main(){vUv=uv;vColor=instanceColor;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);}`,
   fragmentShader:`varying vec2 vUv;varying vec3 vColor;void main(){float r=length(vUv-.5)*2.;float a=pow(max(0.,1.-r*r),2.5);gl_FragColor=vec4(vColor,a*.16);}`
 });
 group.frustumCulled=false;scene.add(group);
 rig={group,coneGeometry,beamMaterial,poolGeometry,poolMaterial,beam:null,pool:null,capacity:0};
 FAKE_SPOT_CACHE.set(scene,rig);return rig;
}
const _spotPos=new THREE.Vector3(),_spotDir=new THREE.Vector3(),_spotQuat=new THREE.Quaternion(),_spotMatrix=new THREE.Matrix4(),_spotScale=new THREE.Vector3(),_spotUp=new THREE.Vector3(0,-1,0);
function updateFakeSpots(scene,camera,profile){
 const rig=fakeSpotRig(scene);
 const fake=[],hybrid=profile.lights.spotMode==='hybrid';
 scene.updateMatrixWorld(true);
 scene.traverse(node=>{
   if(!node.isSpotLight||!node.userData.primitiveLight)return;
   if(!profile.lights.enabled||!profile.lights.spot)return;
   node.getWorldPosition(_spotPos);
   const near=hybrid&&camera&&camera.position.distanceTo(_spotPos)<35;
   if(profile.lights.spotMode==='real'||near)return;
   fake.push(node);
 });
 if(fake.length>rig.capacity){
   rig.beam?.removeFromParent();rig.pool?.removeFromParent();
   rig.beam?.dispose();rig.pool?.dispose();
   rig.capacity=Math.max(fake.length,rig.capacity*2,16);
   rig.beam=new THREE.InstancedMesh(rig.coneGeometry,rig.beamMaterial,rig.capacity);
   rig.pool=new THREE.InstancedMesh(rig.poolGeometry,rig.poolMaterial,rig.capacity);
   rig.beam.frustumCulled=false;rig.pool.frustumCulled=false;
   rig.group.add(rig.beam,rig.pool);
 }
 if(!rig.beam)return;
 rig.beam.count=rig.pool.count=fake.length;
 fake.forEach((node,i)=>{
   node.getWorldPosition(_spotPos);
   node.getWorldDirection(_spotDir);
   const length=Math.min(node.distance||24,60);
   const radius=Math.tan(node.angle)*length;
   _spotQuat.setFromUnitVectors(_spotUp,_spotDir);
   _spotScale.set(radius,length,radius);
   _spotMatrix.compose(_spotPos,_spotQuat,_spotScale);
   rig.beam.setMatrixAt(i,_spotMatrix);
   const dy=_spotDir.y;
   const t=dy<-.1?Math.max(0,(_spotPos.y-.03)/-dy):length;
   const hit=_spotPos.clone().addScaledVector(_spotDir,Math.min(t,length));
   _spotQuat.setFromAxisAngle(new THREE.Vector3(1,0,0),-Math.PI/2);
   _spotScale.set(radius*1.5,radius*1.5,1);
   _spotMatrix.compose(hit,_spotQuat,_spotScale);
   rig.pool.setMatrixAt(i,_spotMatrix);
   rig.beam.setColorAt(i,node.color);
   rig.pool.setColorAt(i,node.color);
 });
 for(const mesh of [rig.beam,rig.pool]){mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;}
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
