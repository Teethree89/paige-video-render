// Shared browser preview/video visual pipeline. The scene document stores
// only safe fog/bloom/tonal settings; no generated shader code is permitted.
import * as THREE from 'three';
import {DecalGeometry} from 'three/addons/geometries/DecalGeometry.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {validateSceneEffects} from './primitive-schema.js';

export const DEFAULT_EFFECTS=Object.freeze({
 fog:{mode:'default',color:'#526779',density:.008},
 bloom:{enabled:false,strength:.45,threshold:.8,radius:.35},
 shadows:{enabled:true},
 lights:{enabled:true,studio:true,spot:true,point:true,directional:true,area:true,spotMode:'real',fakeBeams:true},
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
   if(!profile.lights.enabled||node.userData.authoredVisible===false||
       node.userData.editorIsolationHidden)return false;
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
   // Hidden layer, assembly or child light must never spawn a fake beam.
   let hierarchyVisible=true;
   for(let ancestor=node.parent;ancestor;ancestor=ancestor.parent)
     if(!ancestor.visible){hierarchyVisible=false;break;}
   if(activeRoot&&isActiveNode(node)&&hierarchyVisible&&allowed(node)&&node.isSpotLight
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
 updateFakeSpots(scene,faked,activeRoot,profile.lights.fakeBeams);
 return profile;
}

const FAKE_SPOT_CACHE=new WeakMap();
function fakeSpotRig(scene){
 let rig=FAKE_SPOT_CACHE.get(scene);
 if(rig)return rig;
 const group=new THREE.Group();group.name='Runtime_fake_spotlights';group.userData.fakeSpotRig=true;
 const coneGeometry=new THREE.ConeGeometry(1,1,32,1,true);
 coneGeometry.translate(0,-.5,0);
 // A translucent cone shell is not true volumetric light. Drawing both sides
 // creates a hard double image when the camera crosses it. Keep the far face,
 // smoothly feather grazing-angle silhouettes and fade nearby shell fragments.
 const beamMaterial=new THREE.ShaderMaterial({
   transparent:true,depthTest:true,depthWrite:false,
   side:THREE.BackSide,blending:THREE.AdditiveBlending,
   vertexShader:`
     varying vec3 vLocal;varying vec3 vColor;
     varying vec3 vViewPosition;varying vec3 vViewNormal;
     void main(){
       vec4 viewPosition=modelViewMatrix*instanceMatrix*vec4(position,1.0);
       vLocal=position;vColor=instanceColor;
       vViewPosition=viewPosition.xyz;
       vViewNormal=normalize(mat3(modelViewMatrix)*mat3(instanceMatrix)*normal);
       gl_Position=projectionMatrix*viewPosition;
     }
   `,
   fragmentShader:`
     varying vec3 vLocal;varying vec3 vColor;
     varying vec3 vViewPosition;varying vec3 vViewNormal;
     void main(){
       float axial=smoothstep(-0.99,-0.67,vLocal.y)*
         (1.0-smoothstep(-0.25,-0.025,vLocal.y));
       float facing=abs(dot(normalize(vViewNormal),normalize(-vViewPosition)));
       float feather=smoothstep(0.015,0.32,facing);
       float nearFade=smoothstep(1.5,6.0,length(vViewPosition));
       gl_FragColor=vec4(vColor,0.026*axial*feather*nearFade);
     }
   `
 });
 // Each ground surface receives a clipped decal where the light cone meets
 // its polygons. All decals share one batched additive shader draw call.
 const poolMaterial=new THREE.ShaderMaterial({
   transparent:true,depthTest:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,
   polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2,
   vertexShader:`attribute vec3 color;varying vec2 vUv;varying vec3 vColor;void main(){vUv=uv;vColor=color;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
   fragmentShader:`varying vec2 vUv;varying vec3 vColor;void main(){float r=length(vUv-.5)*2.;float a=pow(max(0.,1.-r*r),2.5);gl_FragColor=vec4(vColor,a*.16);}`
 });
 const pool=new THREE.Mesh(new THREE.BufferGeometry(),poolMaterial);
 pool.name='Fake spotlight ground pools';
 pool.frustumCulled=false;pool.visible=false;
 group.add(pool);
 group.frustumCulled=false;scene.add(group);
 rig={group,coneGeometry,beamMaterial,poolMaterial,beam:null,pool,capacity:0,poolKey:'',poolRoot:null};
 FAKE_SPOT_CACHE.set(scene,rig);return rig;
}
const _spotPos=new THREE.Vector3(),_spotTarget=new THREE.Vector3(),_spotDir=new THREE.Vector3();
const _spotQuat=new THREE.Quaternion(),_spotMatrix=new THREE.Matrix4(),_spotScale=new THREE.Vector3();
const _spotUp=new THREE.Vector3(0,-1,0);
const FAKE_BEAM_MAX_LENGTH=12,FAKE_POOL_GROUND_Y=.08;
// Pool illumination follows the authored light's range, independently from
// the atmospheric cone's intentionally short 12-unit visible beam.
const FAKE_POOL_MAX_DISTANCE=48;
const FAKE_POOL_DECAL_LIFT=.008;
const _fakePoolProjectorOrientation=new THREE.Euler(-Math.PI/2,0,0);
const _fakePoolProjectorSize=new THREE.Vector3();
const _fakePoolProjectorPosition=new THREE.Vector3();

const _fakeGroundMeshes=new WeakMap(),_fakeGroundHits=new WeakMap(),_fakePoolPatches=new WeakMap();
const _fakeGroundRay=new THREE.Raycaster();
const _fakeGroundOrigin=new THREE.Vector3(),_fakeGroundDown=new THREE.Vector3(0,-1,0);
const _fakeGroundProbe=new THREE.Vector3();
const FAKE_POOL_SURFACE_LIFT=.018;
// Ground support is computed from authored geometry, not an arbitrary Y=0 plane.
// Build bounds just once per chapter root and raycast only when a light moves
// or the primitive world is rebuilt. Never raycast per frame for static arrays.
function fakeGroundSurfaces(root){
 if(!root)return [];
 const version=root.userData.fakeGroundVersion||0;
 const cached=_fakeGroundMeshes.get(root);
 if(cached?.version===version)return cached.surfaces;
 const surfaces=[];
 root.updateWorldMatrix(true,true);
 root.traverse(node=>{
   if(!node.isMesh||node.isInstancedMesh||node.userData.previewSource||
       node.userData.layer!=='ground'||!node.geometry)return;
   // Exclude hidden/interactively isolated surfaces from ground receivers.
   for(let ancestor=node;ancestor&&ancestor!==root;ancestor=ancestor.parent)
     if(!ancestor.visible)return;
   if(!node.geometry.boundingBox)node.geometry.computeBoundingBox();
   const bounds=node.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld);
   surfaces.push({node,bounds});
 });
 _fakeGroundMeshes.set(root,{version,surfaces});
 return surfaces;
}
function groundHeightAt(root,light,x,z,lightY){
 const version=root?.userData.fakeGroundVersion||0;
 const prior=light?_fakeGroundHits.get(light):null;
 if(prior?.root===root&&prior.version===version&&Math.abs(prior.x-x)<.001&&
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
 if(light)_fakeGroundHits.set(light,{root,version,x,z,lightY,groundY});
 return groundY;
}

// CPU-create decals only on authored ground-layer surface polygons that the
// spotlight cone reaches. A road decal and a base-ground decal may overlap:
// depth testing hides the lower one behind raised opaque pavement, while the
// geometry projector clips each to its own mesh boundaries.
function fakePoolPatch(root,node,origin,direction,maxLength){
 const version=root?.userData.fakeGroundVersion||0;
 const key=[
   origin.x,origin.y,origin.z,direction.x,direction.y,direction.z,
   maxLength,node.angle,node.color.r,node.color.g,node.color.b
 ].map(v=>Number(v).toFixed(4)).join(':');
 const prior=_fakePoolPatches.get(node);
 if(prior?.root===root&&prior.version===version&&prior.key===key)return prior;
 const vertices=[],uvs=[],colors=[],indices=[];
 if(direction.y<-.001){
  const maxPoolLength=Math.min(maxLength,FAKE_POOL_MAX_DISTANCE);
  for(const {node:surface,bounds} of fakeGroundSurfaces(root)){
   // The top of a road/terrain mesh determines its approximate cone section.
   // The projector's depth then clips to the actual triangles, including slopes.
   const surfaceY=bounds.max.y;
   const t=(origin.y-surfaceY)/-direction.y;
   if(t<=.05||t>maxPoolLength)continue;
   const radius=Math.tan(node.angle)*t*1.05;
   if(!Number.isFinite(radius)||radius<=.01)continue;
   _fakePoolProjectorPosition.copy(origin).addScaledVector(direction,t);
   _fakePoolProjectorPosition.y=surfaceY;
   const x=_fakePoolProjectorPosition.x,z=_fakePoolProjectorPosition.z;
   if(bounds.max.x<x-radius||bounds.min.x>x+radius||
      bounds.max.z<z-radius||bounds.min.z>z+radius)continue;
   // Clip against real surface triangles instead of trying to bend a pool
   // mesh across raised road edges. Reject sides and undersides after clipping.
   _fakePoolProjectorSize.set(
     radius*2,radius*2,Math.max(1,2*(bounds.max.y-bounds.min.y+.25))
   );
   const decal=new DecalGeometry(surface,_fakePoolProjectorPosition,
     _fakePoolProjectorOrientation,_fakePoolProjectorSize);
   const positions=decal.getAttribute('position');
   const texcoords=decal.getAttribute('uv');
   const normals=decal.getAttribute('normal');
   if(!positions||!texcoords||!normals){decal.dispose();continue;}
   const index=decal.getIndex();
   const triangleCount=(index?index.count:positions.count)/3;
   for(let tri=0;tri<triangleCount;tri++){
     const ia=index?index.getX(tri*3):tri*3;
     const ib=index?index.getX(tri*3+1):tri*3+1;
     const ic=index?index.getX(tri*3+2):tri*3+2;
     // Ground/top faces must point upwards; do not light curb side walls
     // or underside geometry as though they were horizontal pavement.
     if(Math.min(normals.getY(ia),normals.getY(ib),normals.getY(ic))<.45)continue;
     for(const i of [ia,ib,ic]){
       // Offset along the polygon normal, not vertical Y. This prevents
       // camera-distance z-fighting on sloped ground without pulling the
       // decal through neighbouring raised surfaces.
       vertices.push(positions.getX(i)+normals.getX(i)*FAKE_POOL_DECAL_LIFT,
         positions.getY(i)+normals.getY(i)*FAKE_POOL_DECAL_LIFT,
         positions.getZ(i)+normals.getZ(i)*FAKE_POOL_DECAL_LIFT);
       uvs.push(texcoords.getX(i),texcoords.getY(i));
       colors.push(node.color.r,node.color.g,node.color.b);
       indices.push(indices.length);
     }
   }
   decal.dispose();
  }
 }
 const patch={root,version,key,vertices,uvs,colors,indices};
 _fakePoolPatches.set(node,patch);
 return patch;
}
function syncFakePoolBatch(rig,patches,root){
 const key=patches.map(({node,patch})=>node.uuid+':'+patch.version+':'+patch.key).join('|');
 if(key===rig.poolKey&&root===rig.poolRoot)return;
 rig.poolKey=key;rig.poolRoot=root;
 if(!patches.length){
   rig.pool.visible=false;
   rig.pool.userData.fakePoolCount=0;
   return;
 }
 const positions=[],uvs=[],colors=[],indices=[];
 for(const {patch} of patches){
   const offset=positions.length/3;
   positions.push(...patch.vertices);
   uvs.push(...patch.uvs);
   colors.push(...patch.colors);
   for(const index of patch.indices)indices.push(offset+index);
 }
 const geometry=new THREE.BufferGeometry();
 geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
 geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
 geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
 geometry.setIndex(indices);
 geometry.computeBoundingSphere();
 rig.pool.geometry.dispose();
 rig.pool.geometry=geometry;
 rig.pool.visible=true;
 rig.pool.userData.fakePoolCount=patches.length;
 rig.pool.userData.fakePoolSurfaceTriangles=indices.length/3;
}
function updateFakeSpots(scene,faked,activeRoot,showBeams=true){
 let rig=FAKE_SPOT_CACHE.get(scene);
 if(!rig&&!faked.length)return;
 rig=rig||fakeSpotRig(scene);
 if(faked.length>rig.capacity){
   rig.beam?.removeFromParent();
   rig.beam?.dispose();
   rig.capacity=Math.max(faked.length,rig.capacity*2,16);
   rig.beam=new THREE.InstancedMesh(rig.coneGeometry,rig.beamMaterial,rig.capacity);
   rig.beam.frustumCulled=false;
   rig.group.add(rig.beam);
 }
 if(!rig.beam)return;
 let beams=0;
 const poolPatches=[];
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
   // The atmospheric beam has a short cap; its projected ground pool does not.
   const poolRange=Math.min(node.distance>0?node.distance:32,FAKE_POOL_MAX_DISTANCE);
   const poolGroundHit=groundT>.05&&groundT<=poolRange;
   const length=groundHit?groundT:maximum;
   if(length<=.05)continue;
   const radius=Math.tan(node.angle)*length;
   if(showBeams){
     _spotQuat.setFromUnitVectors(_spotUp,_spotDir);
     _spotScale.set(radius,length,radius);
     _spotMatrix.compose(_spotPos,_spotQuat,_spotScale);
     rig.beam.setMatrixAt(beams,_spotMatrix);
     rig.beam.setColorAt(beams,node.color);
     beams++;
   }
   if(poolGroundHit){
     const patch=fakePoolPatch(activeRoot,node,_spotPos,_spotDir,poolRange);
     if(patch.indices.length)poolPatches.push({node,patch});
   }
 }
 rig.beam.count=beams;
 if(beams){
   rig.beam.instanceMatrix.needsUpdate=true;
   if(rig.beam.instanceColor)rig.beam.instanceColor.needsUpdate=true;
 }
 syncFakePoolBatch(rig,poolPatches,activeRoot);
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
