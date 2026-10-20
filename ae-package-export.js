import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {zipFiles} from './zip-utils.js';
import {AE_MODEL_IDS,modelIdForShot,shotAssetPath,createAETimeline} from './ae-package-plan.js';

function assertGLB(buffer,label){
  if(!(buffer instanceof ArrayBuffer)||buffer.byteLength<12||
     new DataView(buffer).getUint32(0,true)!==0x46546c67)
    throw Error('Invalid GLB export for '+label);
  return new Uint8Array(buffer);
}
async function exportGLB(source,label){
  const exporter=new GLTFExporter();
  const binary=await new Promise((resolve,reject)=>exporter.parse(source,resolve,reject,{
    binary:true,onlyVisible:false,trs:true,maxTextureSize:2048,includeCustomExtensions:false
  }));
  return assertGLB(binary,label);
}
async function loadAEBuilder(){
  const response=await fetch('./AfterEffects/BUILD_EDITABLE_PROJECT.jsx',{cache:'no-store'});
  if(!response.ok)throw Error('AE builder unavailable (HTTP '+response.status+')');
  const script=await response.text();
  if(!script.includes('function addCameraKeys')||!script.includes('aeOrigin'))
    throw Error('AE builder is outdated; reload the editor and retry.');
  return script;
}
const instructions=`AFTER EFFECTS — EDITABLE PROJECT EXPORT

1. Extract the entire ZIP to a new folder. Keep timeline.json, AfterEffects/
   and assets/ in their original relative locations.
2. In Adobe After Effects 24.1+ use File > Scripts > Run Script File and choose
   AfterEffects/BUILD_EDITABLE_PROJECT.jsx.
3. The builder saves a new, non-overwriting .aep with editable shot workspaces,
   3D model layers, camera guides, and text layers. The master sequences those
   shot workspaces at their timeline cuts beneath the editable titles.
4. For the nine original flythrough shots, assets/models/ holds the seven live
   editable GLB models. For shots with accepted custom primitives, assets/shots/
   contains the shot-specific geometry and overrides the generic model.
5. Keep GLB Model Settings at default meter units, Y Up, Flip Z enabled.
   Do not use Make Comp Size: it changes model scale independently of cameras.
   The builder compensates AE's 512 px/m import conversion with 3.515625% layer
   Scale so models and cameras both use 18 pixels per source world unit.
6. Inspect MODEL CHECK and shot cameras in AE before treating the export as final.

This ZIP captures the current saved timeline and the editor's CURRENT model
replacements, including imported GLB previews. Unaccepted AI geometry is not
exported. Source/reference videos, browser-only video URLs, Three.js runtime
lighting, sprites, particles, and a prebuilt .aep are NOT included. The editor's
Export JSON remains available as a lightweight timeline-only backup.
`;

export async function buildAfterEffectsPackage({
  sequence,world,primitiveWorld,cameraAt,onProgress=()=>{}
}){
  const snapshot=createAETimeline(sequence,cameraAt);
  onProgress('Loading After Effects project builder…');
  const script=await loadAEBuilder();
  const entries=[
    {name:'timeline.json',data:JSON.stringify(snapshot,null,2)},
    {name:'AfterEffects/BUILD_EDITABLE_PROJECT.jsx',data:script},
    {name:'README-AFTER-EFFECTS.txt',data:instructions}
  ];
  // Capture live replacement GLBs, not just the original committed files.
  for(let index=0;index<AE_MODEL_IDS.length;index++){
    const id=AE_MODEL_IDS[index];
    onProgress('Exporting live model '+(index+1)+'/'+AE_MODEL_IDS.length+': '+id+'…');
    const bytes=await exportGLB(world.modelForAEExport(id),id);
    entries.push({name:'assets/models/'+id+'.glb',data:bytes});
  }
  let shotCount=0;
  // Custom primitives REPLACE the legacy world in the live renderer.
  // Only accepted primitive scenes get their own GLB override.
  const accepted=sequence.primitiveScenes?.scenes||[];
  for(let index=0;index<snapshot.shots.length;index++){
    const shot=snapshot.shots[index];
    const item=accepted.find(scene=>scene.shotId===shot.id && scene.objects?.length);
    if(!item)continue;
    if(!primitiveWorld.hasObjects(shot.id))
      throw Error('Accepted primitives missing from scene '+shot.name);
    onProgress('Exporting scene '+(index+1)+'/'+snapshot.shots.length+': '+shot.name+'…');
    const root=primitiveWorld.getSceneForExport(shot.id);
    // Primitives are anchored globally for Three.js, but must be scene-local
    // for After Effects, using the very same origin as the shot camera.
    root.position.x-=shot.aeOrigin[0];
    root.position.y-=shot.aeOrigin[1];
    root.position.z-=shot.aeOrigin[2];
    entries.push({name:shotAssetPath(index),data:await exportGLB(root,shot.name)});
    shotCount++;
  }
  const manifest={version:1,units:'Three.js scene-local units, Y up',models:Object.fromEntries(
    AE_MODEL_IDS.map(id=>[id,{enabled:true,url:'assets/models/'+id+'.glb',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]}]))};
  entries.push({name:'assets/models/manifest.json',data:JSON.stringify(manifest,null,2)});
  onProgress('Packing timeline, '+AE_MODEL_IDS.length+' models and '+shotCount+' custom shot(s)…');
  return zipFiles(entries);
}
