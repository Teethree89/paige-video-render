import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {blankPrimitiveDocument,validatePrimitiveDocument,makePrimitive,makeExampleBlockout} from './primitive-schema.js';
import {insertCreatedAsset} from './scene-asset-catalog.js';

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
export function setupPrimitiveEditor({getSequence,getActiveShot,onDocumentChange,world,onSelectionChange=()=>{}}) {
  let selectedId=null,selectedLightId=null,previousShot=null;
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
      refresh();onSelectionChange(selectedId);
    }catch(err){status.textContent='Change rejected: '+err.message;console.error(err);}
  }
  function refresh(){
    const shot=getActiveShot();if(!shot)return;
    if(previousShot!==shot.id){previousShot=shot.id;selectedId=null;selectedLightId=null;}
    let doc,loadError=false;
    try{doc=getPrimitiveDocument();}
    catch(error){
      loadError=true;
      status.textContent='Saved geometry could not be loaded: '+error.message+
        '. Export Timeline JSON to keep the original project for repair.';
      doc=blankPrimitiveDocument();
    }
    const entry=sceneFor(doc,shot.id);
    const objects=entry?.objects||[];
    const chosenLayer=layerFilter.value||'all';
    const filtered=objects.filter(o=>chosenLayer==='all'||
      (o.layer||'manual')===chosenLayer);
    const selected=filtered.find(o=>o.id===selectedId);
    const lights=entry?.lights?.length||0;
    el('primitiveShotLabel').textContent=shot.name+(loadError?' · saved geometry unavailable':
      ' · '+objects.length+' object(s)'+(lights?' · '+lights+' light(s)':''));
    objectSelect.replaceChildren();
    const none=document.createElement('option');
    none.value='';none.textContent=loadError?'Saved geometry could not be loaded':filtered.length?'Select an object…':
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
      el('primitiveLayer').value=selected.layer||'manual';
      el('primitiveShapeEdit').value=selected.primitive;
      el('primitiveColor').value=selected.material.color;
      el('primitiveEmissive').value=selected.material.emissive||'#000000';
      el('primitiveEmissiveIntensity').value=selected.material.emissiveIntensity||0;
      el('primitiveOpacity').value=selected.material.opacity??1;
      el('primitiveMetalness').value=selected.material.metalness;
      el('primitiveRoughness').value=selected.material.roughness;
      el('primitiveShapeReadOnly').textContent=shapeSummary(selected);
      for(const input of editor.querySelectorAll('[data-prim]')){
        const [field,index]=input.dataset.prim.split('.');
        input.value=selected[field][Number(index)];
      }
    }else {selectedId=null;objectSelect.value='';}
    editable.hidden=!selected;
    const lightSelect=el('primitiveLightSelect'),lightsList=entry?.lights||[];
    lightSelect.replaceChildren();
    const first=document.createElement('option');first.value='';
    first.textContent=lightsList.length?'Select a light…':'No chapter lights yet';
    lightSelect.append(first);
    for(const light of lightsList){
      const option=document.createElement('option');
      option.value=light.id;option.textContent=light.name+' · '+light.type;
      lightSelect.append(option);
    }
    const chosen=lightsList.find(x=>x.id===selectedLightId);
    if(!chosen)selectedLightId=null;
    lightSelect.value=selectedLightId||'';
    el('primitiveLightFields').hidden=!chosen;
    el('primitiveDeleteLight').disabled=!chosen;
    if(chosen){
      el('primitiveLightName').value=chosen.name;
      el('primitiveLightType').value=chosen.type;
      el('primitiveLightColor').value=chosen.color;
      el('primitiveLightIntensity').value=chosen.intensity;
      el('primitiveLightIntensity').max=chosen.type==='directional'?10:500;
      el('primitiveLightTargetWrap').hidden=chosen.type==='point';
      el('primitiveLightRangeWrap').hidden=chosen.type==='directional';
      el('primitiveLightSpotWrap').hidden=chosen.type!=='spot';
      el('primitiveLightDistance').value=chosen.distance??0;
      el('primitiveLightAngle').value=chosen.angle??.6;
      el('primitiveLightPenumbra').value=chosen.penumbra??.3;
      for(const input of editor.querySelectorAll('[data-light]')){
        const [key,index]=input.dataset.light.split('.');
        input.value=chosen[key]?.[Number(index)]??0;
      }
    }
    el('primitiveExportGLB').disabled=objects.length===0&&lightsList.length===0;
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
  function selectObject(id,{notify=false}={}){
    const shot=getActiveShot();
    const entry=shot?sceneFor(getPrimitiveDocument(),shot.id):null;
    const valid=entry?.objects.some(item=>item.id===id);
    selectedId=valid?id:null;
    if(valid)selectedLightId=null;
    if(valid&&layerFilter.value!=='all'&&
       !entry.objects.find(item=>item.id===id&&
         (item.layer||'manual')===layerFilter.value))layerFilter.value='all';
    refresh();
    if(notify)onSelectionChange(selectedId);
    return valid||!id;
  }
  layerFilter.addEventListener('change',()=>{selectedId=null;refresh();onSelectionChange(null);});
  objectSelect.addEventListener('change',()=>selectObject(objectSelect.value||null,{notify:true}));
  el('primitiveName').addEventListener('change',event=>apply(entry=>{
    const item=entry.objects.find(o=>o.id===selectedId);if(item)item.name=event.target.value;
  }));
  // "Manual" is the absence of a layer, as for hand-added shapes.
  el('primitiveLayer').addEventListener('change',event=>apply(entry=>{
    const item=entry.objects.find(o=>o.id===selectedId);if(!item)return;
    if(event.target.value==='manual')delete item.layer;else item.layer=event.target.value;
  }));
  el('primitiveShapeEdit').addEventListener('change',event=>apply(entry=>{
    const item=entry.objects.find(o=>o.id===selectedId);
    if(!item||item.primitive===event.target.value)return;
    const defaults=makePrimitive(event.target.value,'shape_template');
    item.primitive=defaults.primitive;
    if(defaults.points)item.points=defaults.points;
    else delete item.points;
  }));
  for(const key of ['Emissive','EmissiveIntensity','Opacity']){
    el('primitive'+key).addEventListener('change',event=>apply(entry=>{
      const item=entry.objects.find(o=>o.id===selectedId);if(!item)return;
      if(key==='Emissive'){
        item.material.emissive=event.target.value;
        item.material.emissiveIntensity??=0;
      }else if(key==='EmissiveIntensity'){
        item.material.emissiveIntensity=Number(event.target.value);
        item.material.emissive??='#ffffff';
      }else item.material.opacity=Number(event.target.value);
    }));
  }
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
  function createAsset(category,preset,origin=[0,0,0]){
    try{
      const shot=getActiveShot();if(!shot)throw Error('Select a scene first.');
      const result=insertCreatedAsset(getPrimitiveDocument(),shot.id,category,preset,origin);
      // The template is composed entirely of editable primitives or lights.
      selectedId=result.selected.kind==='object'?result.selected.id:null;
      selectedLightId=result.selected.kind==='light'?result.selected.id:null;
      if(selectedId)layerFilter.value='all';
      onDocumentChange(validatePrimitiveDocument(result.document,allowed()));
      refresh();onSelectionChange(selectedId);
      editor.open=true;
      status.textContent='Created '+preset.replaceAll('-',' ')+' in '+shot.name+'.';
      return true;
    }catch(err){
      status.textContent='Create failed: '+err.message;return false;
    }
  }
  el('primitiveAddLight').addEventListener('click',()=>createAsset('lights','point-white'));
  el('primitiveLightSelect').addEventListener('change',event=>{
    selectedLightId=event.target.value||null;selectedId=null;
    refresh();onSelectionChange(null);
  });
  function editLight(changer){
    apply(entry=>{
      const light=entry.lights?.find(l=>l.id===selectedLightId);
      if(light)changer(light);
    });
  }
  const lightFields={
    primitiveLightName:(v,l)=>{l.name=v;},
    primitiveLightColor:(v,l)=>{l.color=v;},
    primitiveLightIntensity:(v,l)=>{l.intensity=Number(v);},
    primitiveLightDistance:(v,l)=>{l.distance=Number(v);},
    primitiveLightAngle:(v,l)=>{l.angle=Number(v);},
    primitiveLightPenumbra:(v,l)=>{l.penumbra=Number(v);}
  };
  for(const [id,change] of Object.entries(lightFields)){
    el(id).addEventListener('change',e=>editLight(l=>change(e.target.value,l)));
  }
  el('primitiveLightType').addEventListener('change',event=>editLight(light=>{
    light.type=event.target.value;
    if(light.type==='directional'){light.intensity=Math.min(10,light.intensity);delete light.distance;}
    else light.distance??=28;
    if(light.type==='point'){delete light.target;delete light.angle;delete light.penumbra;}
    else{
      light.target??=[light.position[0],light.position[1]-4,light.position[2]];
      if(light.type==='spot'){light.angle??=.6;light.penumbra??=.3;}
      else{delete light.angle;delete light.penumbra;}
    }
  }));
  for(const input of editor.querySelectorAll('[data-light]'))
    input.addEventListener('change',event=>{
      const [key,index]=event.target.dataset.light.split('.');
      editLight(light=>{light[key][Number(index)]=Number(event.target.value);});
    });
  el('primitiveDeleteLight').addEventListener('click',()=>{
    editLight(light=>{
      const doc=getPrimitiveDocument(),id=selectedLightId;
      // Use apply() so the same validated save and undo path applies.
      return light;
    });
    apply(entry=>{entry.lights=(entry.lights||[]).filter(l=>l.id!==selectedLightId);selectedLightId=null;});
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
  return {refresh,selectObject,createAsset,getSelectedId:()=>selectedId,getSelectedLightId:()=>selectedLightId};
}
