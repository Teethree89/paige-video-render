import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {blankPrimitiveDocument,validatePrimitiveDocument,makePrimitive,makeExampleBlockout} from './primitive-schema.js';

const el=id=>document.getElementById(id);
function download(content,filename,mime='application/json'){
  const blob=content instanceof Blob?content:new Blob([content],{type:mime});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),15000);
}
const safeFile=id=>id.replace(/[^a-zA-Z0-9_-]/g,'-');
// Fields without their own inputs (copies, footprint, glow, glass) are shown
// read-only; they stay intact through every edit and are changed in JSON.
export function shapeSummary(item){
  const parts=[item.primitive];
  if(item.points)parts.push(item.points.length+'-point footprint');
  if(item.repeat){
    const [x,y,z]=item.repeat.count;
    parts.push(x*y*z+' copies ('+x+'×'+y+'×'+z+')');
  }
  if(item.material.emissive)parts.push('glow '+item.material.emissive+' ×'+item.material.emissiveIntensity);
  if(item.material.opacity!==undefined&&item.material.opacity<1)
    parts.push(Math.round(item.material.opacity*100)+'% opacity');
  return parts.join(' · ');
}
export function setupPrimitiveEditor({getSequence,getActiveShot,onDocumentChange,world}) {
  let selectedId=null,previousShot=null;
  const editor=el('primitiveEditor'),objectSelect=el('primitiveObjectSelect');
  const layerFilter=el('primitiveLayerFilter');
  const status=el('primitiveStatus');
  const editable=el('primitiveFields');
  const file=el('primitiveImportFile');
  const allowed=()=>getSequence().shots.map(s=>s.id);
  const getPrimitiveDocument=()=>validatePrimitiveDocument(getSequence().primitiveScenes||blankPrimitiveDocument(),allowed());
  const sceneFor=(doc,shotId,create=false)=>{
    let entry=doc.scenes.find(s=>s.shotId===shotId);
    if(!entry && create){entry={shotId,objects:[]};doc.scenes.push(entry);}
    return entry;
  };
  function apply(edit){
    try{
      const doc=getPrimitiveDocument(),shot=getActiveShot();
      if(!shot)throw Error('No active shot');
      const entry=sceneFor(doc,shot.id,true);
      edit(entry,doc,shot);
      onDocumentChange(validatePrimitiveDocument(doc,allowed()));
      status.textContent='Scene changes saved in your editable timeline.';
      refresh();
    }catch(err){status.textContent='Change rejected: '+err.message;console.error(err);}
  }
  function refresh(){
    const shot=getActiveShot();if(!shot)return;
    if(previousShot!==shot.id){previousShot=shot.id;selectedId=null;}
    const doc=getPrimitiveDocument(),entry=sceneFor(doc,shot.id);
    const objects=entry?.objects||[];
    const chosenLayer=layerFilter.value||'all';
    const filtered=objects.filter(o=>chosenLayer==='all'||
      (o.layer||'manual')===chosenLayer);
    const selected=filtered.find(o=>o.id===selectedId);
    el('primitiveShotLabel').textContent=shot.name+' · '+objects.length+' object(s)';
    objectSelect.replaceChildren();
    const none=document.createElement('option');
    none.value='';none.textContent=filtered.length?'Select an object…':
      (objects.length?'No objects in this layer':'No objects yet — add one below');
    objectSelect.append(none);
    for(const item of filtered){
      const option=document.createElement('option');
      option.value=item.id;option.textContent='['+(item.layer||'manual')+'] '+item.name+' · '+item.primitive;
      objectSelect.append(option);
    }
    if(selected){
      objectSelect.value=selected.id;
      el('primitiveName').value=selected.name;
      el('primitiveColor').value=selected.material.color;
      el('primitiveMetalness').value=selected.material.metalness;
      el('primitiveRoughness').value=selected.material.roughness;
      el('primitiveShapeReadOnly').textContent=shapeSummary(selected);
      for(const input of editor.querySelectorAll('[data-prim]')){
        const [field,index]=input.dataset.prim.split('.');
        input.value=selected[field][Number(index)];
      }
    }else {selectedId=null;objectSelect.value='';}
    editable.hidden=!selected;
    el('primitiveExportGLB').disabled=objects.length===0;
    el('primitiveDelete').disabled=!selected;
    el('primitiveDuplicate').disabled=!selected;
  }
  const nextId=(entry,shape)=>{
    let i=1;while(entry.objects.some(o=>o.id===shape+'_'+i))i++;
    return shape+'_'+i;
  };
  el('primitiveAdd').addEventListener('click',()=>{
    apply(entry=>{
      const shape=el('primitiveType').value;
      const obj=makePrimitive(shape,nextId(entry,shape));
      entry.objects.push(obj);selectedId=obj.id;
    });
  });
  el('primitiveExample').addEventListener('click',()=>{
    const shot=getActiveShot();
    if(!shot)return;
    const existing=sceneFor(getPrimitiveDocument(),shot.id)?.objects.length||0;
    if(existing && !confirm('Replace the current shot\'s primitives with an example room blockout?'))return;
    apply(entry=>{entry.objects=makeExampleBlockout(shot.id).objects;selectedId='rack_0_0';});
  });
  layerFilter.addEventListener('change',()=>{selectedId=null;refresh();});
  objectSelect.addEventListener('change',()=>{selectedId=objectSelect.value||null;refresh();});
  el('primitiveName').addEventListener('change',event=>apply(entry=>{
    const item=entry.objects.find(o=>o.id===selectedId);if(item)item.name=event.target.value;
  }));
  for(const key of ['Color','Metalness','Roughness']){
    el('primitive'+key).addEventListener('change',event=>apply(entry=>{
      const item=entry.objects.find(o=>o.id===selectedId);
      if(item)item.material[key.toLowerCase()]=key==='Color'?event.target.value:Number(event.target.value);
    }));
  }
  for(const input of editor.querySelectorAll('[data-prim]')){
    input.addEventListener('change',event=>apply(entry=>{
      const item=entry.objects.find(o=>o.id===selectedId);if(!item)return;
      const [field,index]=input.dataset.prim.split('.');
      item[field][Number(index)]=Number(event.target.value);
    }));
  }
  el('primitiveDelete').addEventListener('click',()=>{
    apply(entry=>{entry.objects=entry.objects.filter(o=>o.id!==selectedId);selectedId=null;});
  });
  el('primitiveDuplicate').addEventListener('click',()=>{
    apply(entry=>{
      const item=entry.objects.find(o=>o.id===selectedId);if(!item)return;
      const duplicate=structuredClone(item);
      duplicate.id=nextId(entry,item.primitive);
      duplicate.name=item.name+' copy';
      duplicate.position[0]+=1.5;
      entry.objects.push(duplicate);selectedId=duplicate.id;
    });
  });
  el('primitiveExportJSON').addEventListener('click',()=>{
    download(JSON.stringify(getPrimitiveDocument(),null,2),'editable-primitives.json');
    status.textContent='Exported all primitive scenes as JSON.';
  });
  el('primitiveImport').addEventListener('click',()=>file.click());
  file.addEventListener('change',async()=>{
    const chosen=file.files?.[0];file.value='';if(!chosen)return;
    try{
      const raw=JSON.parse(await chosen.text());
      const parsed=validatePrimitiveDocument(raw.primitiveScenes||raw,allowed());
      if(!confirm('Replace every primitive scene in this project? Camera and captions stay unchanged.'))return;
      selectedId=null;onDocumentChange(parsed);refresh();
      status.textContent='Imported '+parsed.scenes.length+' primitive scene(s).';
    }catch(err){status.textContent='Invalid primitive JSON: '+err.message;}
  });
  el('primitiveExportGLB').addEventListener('click',async()=>{
    const shot=getActiveShot();if(!shot||!world.hasObjects(shot.id))return;
    const button=el('primitiveExportGLB');button.disabled=true;
    status.textContent='Exporting editable GLB for '+shot.name+'…';
    try{
      const data=await new Promise((resolve,reject)=>{
        new GLTFExporter().parse(world.getSceneForExport(shot.id),resolve,reject,
          {binary:true,onlyVisible:false,trs:true,maxTextureSize:2048});
      });
      download(new Blob([data],{type:'model/gltf-binary'}),safeFile(shot.id)+'.glb','model/gltf-binary');
      status.textContent='GLB exported for '+shot.name+'.';
    }catch(err){status.textContent='GLB export failed: '+err.message;}
    finally{button.disabled=false;refresh();}
  });
  refresh();
  return {refresh};
}
