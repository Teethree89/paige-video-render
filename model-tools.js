import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {zipFiles} from './zip-utils.js';

const MODEL_IDS=['exterior','hall','pcb','atoms','laser','fiber','optics'];
const LABELS={exterior:'Exterior campus',hall:'Server & power hall',pcb:'GaN circuit board',atoms:'Atomic lattice',laser:'InP laser',fiber:'Optical fiber',optics:'Garnet isolator'};
const MANIFEST_URL='./assets/models/manifest.json';
const el=id=>document.getElementById(id);
const defaultManifest=()=>({version:1,units:'Three.js world units; Y up; geometry local to each scene origin',
 models:Object.fromEntries(MODEL_IDS.map(id=>[id,{enabled:true,url:`assets/models/${id}.glb`,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]}]))});
function download(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);}
function status(msg,busy=false){el('modelStatus').textContent=msg;for(const id of ['exportModelBtn','exportAllModelsBtn','importModelBtn','reloadModelsBtn','restoreModelBtn'])el(id).disabled=busy;}
async function glbFromWorld(world,id){
 const exporter=new GLTFExporter();const source=world.modelForExport(id);
 const binary=await new Promise((resolve,reject)=>exporter.parse(source,resolve,reject,{
  binary:true,onlyVisible:false,trs:true,maxTextureSize:2048,includeCustomExtensions:false
 }));
 if(!(binary instanceof ArrayBuffer))throw Error('Exporter returned non-binary data for '+id);
 if(new DataView(binary).getUint32(0,true)!==0x46546c67)throw Error('Bad GLB signature for '+id);
 return new Uint8Array(binary);
}
const loader=new GLTFLoader();
export function setupModelTools(world,{onSceneChanged=()=>{}}={}){
 let linkedManifest=null;
 const slot=()=>el('modelSlot').value;
 const mark=()=>{let id=slot();status(`${LABELS[id]}: ${world.replacements[id]?'Linked GLB':'Procedural fallback'}`);};
 const loadGlbBytes=async(file)=>{
   if(!file.name.toLowerCase().endsWith('.glb'))throw Error('Choose a binary .glb file. A .gltf file may require external resources.');
   const buf=await file.arrayBuffer();if(new DataView(buf).getUint32(0,true)!==0x46546c67)throw Error('Not a valid GLB file');
   const result=await loader.parseAsync(buf,'');return result.scene;
 };
 const loadLinked=async()=>{
  status('Reading assets/models/manifest.json…',true);
  try{
   const r=await fetch(MANIFEST_URL,{cache:'no-store'});
   if(!r.ok)throw Error('Model manifest missing (HTTP '+r.status+')');
   const manifest=await r.json();linkedManifest=manifest;
   let loaded=0,failed=[];
   for(const id of MODEL_IDS){
    const entry=manifest.models?.[id];
    if(!entry?.enabled){world.restoreModel(id);continue;}
    try{
     // URL has to be supplied in the local manifest, not a remote arbitrary server.
     const url=new URL(entry.url||`assets/models/${id}.glb`,location.href);
     if(url.origin!==location.origin)throw Error('Only same-origin GLBs are supported');
     const gltf=await loader.loadAsync(url.href+'?v='+Date.now());
     world.replaceModel(id,gltf.scene,entry);loaded++;
    }catch(err){world.restoreModel(id);failed.push(`${id}: ${err.message}`);}
   }
   onSceneChanged();
   if(failed.length){console.warn('Some linked GLBs could not be loaded; procedural fallback retained:',failed);status(`${loaded} GLB(s) linked. ${failed.length} missing/invalid; procedural fallback used.`);}
   else status(`${loaded} linked GLB(s) loaded. Remaining slots use procedural geometry.`);
  }catch(err){linkedManifest=null;status('Procedural mode — no external model manifest loaded.');console.info(err.message);}
 };
 el('modelSlot').addEventListener('change',mark);
 el('exportModelBtn').addEventListener('click',async()=>{
  const id=slot();try{status('Exporting '+LABELS[id]+' as editable GLB…',true);
   const bytes=await glbFromWorld(world,id);download(new Blob([bytes],{type:'model/gltf-binary'}),`${id}.glb`);
   status(`${LABELS[id]} exported (${(bytes.length/1024/1024).toFixed(1)} MB).`);
  }catch(err){status('Export failed: '+err.message);console.error(err);}
 });
 el('exportAllModelsBtn').addEventListener('click',async()=>{
  try{
   const entries=[];for(let i=0;i<MODEL_IDS.length;i++){
    const id=MODEL_IDS[i];status(`Exporting ${i+1}/7: ${LABELS[id]}…`,true);
    const bytes=await glbFromWorld(world,id);
    entries.push({name:`assets/models/${id}.glb`,data:bytes});
   }
   const manifest=defaultManifest();
   entries.push({name:'assets/models/manifest.json',data:JSON.stringify(manifest,null,2)});
   entries.push({name:'HOW_TO_INSTALL.txt',data:'Extract this ZIP INTO your atoms-to-ai-threejs project root. Do not nest an extra folder.\n\nEdit assets/models/*.glb in Blender or Tripo, preserving scene-local origin and dimensions.\nRefresh the browser to load revised GLBs, or choose Reload linked GLBs.\nLive particles, laser beams and glow sprites remain in Three.js.\n\nScene slots: '+MODEL_IDS.map(id=>id+' ('+LABELS[id]+')').join(', ')+'\n'});
   status('Packaging editable GLBs…',true);
   const zip=zipFiles(entries);download(zip,'atoms-to-ai-editable-models.zip');
   status(`All 7 GLBs exported (${(zip.size/1024/1024).toFixed(1)} MB). Unzip into project root, then reload.`);
  }catch(err){status('Batch export failed: '+err.message);console.error(err);}
 });
 el('importModelBtn').addEventListener('click',()=>el('modelFile').click());
 el('modelFile').addEventListener('change',async(event)=>{
  const file=event.target.files?.[0];if(!file)return;
  const id=slot();try{status('Parsing '+file.name+'…',true);
   const model=await loadGlbBytes(file);world.replaceModel(id,model,linkedManifest?.models?.[id]);onSceneChanged();
   status(`${LABELS[id]}: previewing ${file.name}. For permanent linking, copy to assets/models/${id}.glb and enable it in manifest.json.`);
  }catch(err){status('Import failed: '+err.message);console.error(err);}
  event.target.value='';
 });
 el('reloadModelsBtn').addEventListener('click',loadLinked);
 el('restoreModelBtn').addEventListener('click',()=>{const id=slot();world.restoreModel(id);onSceneChanged();mark();});
 for(const id of ['exportModelBtn','exportAllModelsBtn','importModelBtn','reloadModelsBtn','restoreModelBtn'])el(id).disabled=false;
 // Loading linked models is async and must not block animation startup.
 void loadLinked();
 return{loadLinked,mark};
}
