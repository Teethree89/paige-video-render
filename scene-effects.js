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
 originalFogColor='#050d17',defaultExposure=1.35,review=false,camera=null,shotId=null
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
 // Chapter roots carry an explicit shotId; never generate fake lights
 // from invisible roots belonging to other chapters.
 const activeRoot=scene.children.find(node=>node.userData.shotId===shotId);
 const isActiveNode=node=>{
   for(let ancestor=node;ancestor;ancestor=ancestor.parent)
     if(ancestor===activeRoot)return true;
   return false;
 };
 const faked=[];
 const cameraPosition=camera?.position;
 scene.traverse(node=>{
   if(!node.isLight)return;
   let fakeSpot=false;
   if(activeRoot&&isActiveNode(node)&&node.isSpotLight
       &&node.userData.primitiveLight==='spot'&&profile.lights.enabled&&profile.lights.spot){
     fakeSpot=profile.lights.spotMode==='fake'
       ||(profile.lights.spotMode==='hybrid'&&cameraPosition
         &&node.getWorldPosition(_spotPos).distanceTo(cameraPosition)>=35);
     if(fakeSpot)faked.push(node);
   }
   if(!allowed(node)||fakeSpot){
     if(!Object.hasOwn(node.userData,'chapterLightOriginalVisible'))
       node.userData.chapterLightOriginalVisible=node.visible;
     node.visible=false;
   }else if(Object.hasOwn(node.userData,'chapterLightOriginalVisible')){
     node.visible=node.userData.chapterLightOriginalVisible;
     delete node.userData.chapterLightOriginalVisible;
     if(node.castShadow&&node.shadow)node.shadow.needsUpdate=true;
   }
 });
 updateFakeSpots(scene,faked,activeRoot);
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
const _spotPos=new THREE.Vector3(),_spotTarget=new THREE.Vector3(),_spotDir=new THREE.Vector3();
const _spotQuat=new THREE.Quaternion(),_spotMatrix=new THREE.Matrix4(),_spotScale=new THREE.Vector3();
const _spotUp=new THREE.Vector3(0,-1,0),_poolQuat=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),-Math.PI/2);
const FAKE_BEAM_MAX_LENGTH=12,FAKE_POOL_GROUND_Y=.08;

const _fakeGroundMeshes=new WeakMap(),_fakeGroundHits=new WeakMap();
const _fakeGroundRay=new THREE.Raycaster();
const _fakeGroundOrigin=new THREE.Vector3(),_fakeGroundDown=new THREE.Vector3(0,-1,0);
const _fakeGroundProbe=new THREE.Vector3();
const FAKE_POOL_SURFACE_LIFT=.018;
// Ground support is computed from authored geometry, not an arbitrary Y=0 plane.
// Build bounds just once per chapter root and raycast only when a light moves
// or the primitive world is rebuilt. Never raycast per frame for static arrays.
function fakeGroundSurfaces(root){
 if(!root)return [];
 let surfaces=_fakeGroundMeshes.get(root);
 if(surfaces)return surfaces;
 surfaces=[];
 root.updateWorldMatrix(true,true);
 root.traverse(node=>{
   if(!node.isMesh||node.isInstancedMesh||node.userData.previewSource||
       node.userData.layer!=='ground'||!node.geometry)return;
   if(!node.geometry.boundingBox)node.geometry.computeBoundingBox();
   const bounds=node.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld);
   surfaces.push({node,bounds});
 });
 _fakeGroundMeshes.set(root,surfaces);
 return surfaces;
}
function groundHeightAt(root,light,x,z,lightY){
 const prior=_fakeGroundHits.get(light);
 if(prior?.root===root&&Math.abs(prior.x-x)<.001&&
     Math.abs(prior.z-z)<.001&&Math.abs(prior.lightY-lightY)<.001)
   return prior.groundY;
 _fakeGroundOrigin.set(x,lightY+.1,z);
 _fakeGroundRay.set(_fakeGroundOrigin,_fakeGroundDown);
 _fakeGroundRay.near=0;
 _fakeGroundRay.far=2000;
 let groundY=null;
 for(const {node,bounds} of fakeGroundSurfaces(root)){
   if(x<bounds.min.x-.001||x>bounds.max.x+.001||
       z<bounds.min.z-.001||z>bounds.max.z+.001||bounds.min.y>lightY+.1)continue;
   // Raycast the actual surface: a very large, slightly tilted ground plane
   // has an inflated bounding box and must not override a higher road.
   const hits=_fakeGroundRay.intersectObject(node,false);
   for(const hit of hits){
     if(hit.point.y<=lightY+.01&&(groundY===null||hit.point.y>groundY))
       groundY=hit.point.y;
   }
 }
 _fakeGroundHits.set(light,{root,x,z,lightY,groundY});
 return groundY;
}

function updateFakeSpots(scene,faked,activeRoot){
 let rig=FAKE_SPOT_CACHE.get(scene);
 if(!rig&&!faked.length)return;
 rig=rig||fakeSpotRig(scene);
 if(faked.length>rig.capacity){
   rig.beam?.removeFromParent();rig.pool?.removeFromParent();
   rig.beam?.dispose();rig.pool?.dispose();
   rig.capacity=Math.max(faked.length,rig.capacity*2,16);
   rig.beam=new THREE.InstancedMesh(rig.coneGeometry,rig.beamMaterial,rig.capacity);
   rig.pool=new THREE.InstancedMesh(rig.poolGeometry,rig.poolMaterial,rig.capacity);
   rig.beam.frustumCulled=false;rig.pool.frustumCulled=false;
   rig.group.add(rig.beam,rig.pool);
 }
 if(!rig.beam)return;
 let beams=0,pools=0;
 for(const node of faked){
   // Match Three.js actual target, including rotated array parents.
   // getWorldDirection() points +Z but SpotLight illuminates toward -Z.
   node.getWorldPosition(_spotPos);
   node.target.getWorldPosition(_spotTarget);
   _spotDir.subVectors(_spotTarget,_spotPos);
   if(_spotDir.lengthSq()<1e-8)continue;
   _spotDir.normalize();
   // The authored angle is a HALF angle. Visual beam length is separate
   // from the spotlight's much longer attenuation distance.
   const maximum=Math.min(node.distance>0?node.distance:FAKE_BEAM_MAX_LENGTH,FAKE_BEAM_MAX_LENGTH);
   // Find where the pool falls on the real chapter ground mesh.
   // A fixed 0.08 height hid Right Street pools under its raised road.
   let surfaceY=FAKE_POOL_GROUND_Y;
   if(_spotDir.y<-.001){
     const roughT=(_spotPos.y-surfaceY)/-_spotDir.y;
     _fakeGroundProbe.copy(_spotPos).addScaledVector(_spotDir,roughT);
     const actualY=groundHeightAt(activeRoot,node,_fakeGroundProbe.x,_fakeGroundProbe.z,_spotPos.y);
     if(actualY!==null)surfaceY=actualY+FAKE_POOL_SURFACE_LIFT;
   }
   const groundT=_spotDir.y<-.001?(_spotPos.y-surfaceY)/-_spotDir.y:Infinity;
   const groundHit=groundT>.05&&groundT<=maximum;
   const length=groundHit?groundT:maximum;
   if(length<=.05)continue;
   const radius=Math.tan(node.angle)*length;
   _spotQuat.setFromUnitVectors(_spotUp,_spotDir);
   _spotScale.set(radius,length,radius);
   _spotMatrix.compose(_spotPos,_spotQuat,_spotScale);
   rig.beam.setMatrixAt(beams,_spotMatrix);
   rig.beam.setColorAt(beams,node.color);
   beams++;
   if(groundHit){
     _spotTarget.copy(_spotPos).addScaledVector(_spotDir,groundT);
     _spotTarget.y=surfaceY;
     _spotScale.set(radius*1.05,radius*1.05,1);
     _spotMatrix.compose(_spotTarget,_poolQuat,_spotScale);
     rig.pool.setMatrixAt(pools,_spotMatrix);
     rig.pool.setColorAt(pools,node.color);
     pools++;
   }
 }
 rig.beam.count=beams;rig.pool.count=pools;
 for(const mesh of [rig.beam,rig.pool]){
   if(!mesh.count)continue;
   mesh.instanceMatrix.needsUpdate=true;
   if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;
 }
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
