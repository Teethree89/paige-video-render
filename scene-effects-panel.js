import {blankPrimitiveDocument,validatePrimitiveDocument,validateSceneEffects} from './primitive-schema.js';
import {DEFAULT_EFFECTS,effectsForShot} from './scene-effects.js';

const fields={
 fogMode:['sceneFogMode',v=>v],
 fogColor:['sceneFogColor',v=>v],
 fogDensity:['sceneFogDensity',Number],
 bloomEnabled:['sceneBloomEnabled',Boolean],
 shadowsEnabled:['sceneShadowsEnabled',Boolean],
 lightsEnabled:['sceneLightsEnabled',Boolean],
 bloomStrength:['sceneBloomStrength',Number],
 bloomThreshold:['sceneBloomThreshold',Number],
 bloomRadius:['sceneBloomRadius',Number],
 exposure:['sceneExposure',Number],
 vignette:['sceneVignette',Number]
};
export function setupSceneEffectsPanel({getSequence,getActiveShot,canEdit,onDocumentChange}){
 const panel=document.getElementById('sceneEffectsPanel');
 if(!panel)return null;
 const $=id=>document.getElementById(id),status=$('sceneEffectsStatus');
 let lastShot=null;
 function current(){
   const shot=getActiveShot();
   return shot?effectsForShot(getSequence(),shot.id):structuredClone(DEFAULT_EFFECTS);
 }
 function refresh(){
   const shot=getActiveShot();
   if(!shot)return;
   const profile=current();
   $('sceneFogMode').value=profile.fog.mode;
   $('sceneFogColor').value=profile.fog.color;
   $('sceneFogDensity').value=profile.fog.density;
   $('sceneBloomEnabled').checked=profile.bloom.enabled;
   $('sceneShadowsEnabled').checked=profile.shadows.enabled;
   $('sceneLightsEnabled').checked=profile.lights.enabled;
   $('sceneBloomStrength').value=profile.bloom.strength;
   $('sceneBloomThreshold').value=profile.bloom.threshold;
   $('sceneBloomRadius').value=profile.bloom.radius;
   $('sceneExposure').value=profile.exposure;
   $('sceneVignette').value=profile.vignette;
   $('sceneFogFields').hidden=profile.fog.mode!=='custom';
   $('sceneBloomFields').hidden=!profile.bloom.enabled;
   for(const [_,[id]] of Object.entries(fields))$(id).disabled=!canEdit();
   $('sceneEffectsReset').disabled=!canEdit();
   if(lastShot!==shot.id){
     lastShot=shot.id;
     status.textContent='Editing visual effects for '+shot.name+'.';
   }
 }
 function commit(profile){
   try{
     if(!canEdit())throw Error('Finish or discard the active AI proposal before editing scene effects');
     const shot=getActiveShot();if(!shot)throw Error('No active chapter');
     const doc=validatePrimitiveDocument(getSequence().primitiveScenes||blankPrimitiveDocument(),
       getSequence().shots.map(s=>s.id));
     let entry=doc.scenes.find(s=>s.shotId===shot.id);
     if(!entry){entry={shotId:shot.id,objects:[]};doc.scenes.push(entry);}
     entry.effects=validateSceneEffects(profile);
     onDocumentChange(validatePrimitiveDocument(doc,getSequence().shots.map(s=>s.id)));
     status.textContent='Visual effects saved for '+shot.name+'.';
     refresh();
   }catch(err){status.textContent=err.message;refresh();}
 }
 for(const [key,[id,cast]] of Object.entries(fields)){
   $(id).addEventListener('change',event=>{
     const value=id==='sceneBloomEnabled'||id==='sceneShadowsEnabled'?event.target.checked:cast(event.target.value);
     const profile=structuredClone(current());
     switch(key){
      case 'fogMode':profile.fog.mode=value;break;
      case 'fogColor':profile.fog.color=value;break;
      case 'fogDensity':profile.fog.density=value;break;
      case 'bloomEnabled':profile.bloom.enabled=value;break;
      case 'shadowsEnabled':profile.shadows.enabled=value;break;
      case 'lightsEnabled':profile.lights.enabled=value;break;
      case 'bloomStrength':profile.bloom.strength=value;break;
      case 'bloomThreshold':profile.bloom.threshold=value;break;
      case 'bloomRadius':profile.bloom.radius=value;break;
      case 'exposure':profile.exposure=value;break;
      case 'vignette':profile.vignette=value;break;
     }
     commit(profile);
   });
 }
 $('sceneEffectsReset').addEventListener('click',()=>{
   try{
     if(!canEdit())throw Error('Finish the active AI proposal first.');
     const shot=getActiveShot();
     const doc=validatePrimitiveDocument(getSequence().primitiveScenes||blankPrimitiveDocument(),
       getSequence().shots.map(s=>s.id));
     const entry=doc.scenes.find(s=>s.shotId===shot?.id);
     if(entry){delete entry.effects;if(!entry.objects.length&&!entry.lights?.length&&!entry.camera)
       doc.scenes=doc.scenes.filter(x=>x!==entry);}
     onDocumentChange(validatePrimitiveDocument(doc,getSequence().shots.map(s=>s.id)));
     status.textContent='Restored the default look for '+shot.name+'.';
     refresh();
   }catch(error){status.textContent=error.message;}
 });
 refresh();
 return {refresh};
}
