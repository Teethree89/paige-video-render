import test from 'node:test';
import assert from 'node:assert/strict';
import {createDraftTimeline} from '../shot-analysis.js';
import {motionFrameTimes,validateVideoMotion,savedVideoMotion,buildVideoCameraMotion,hasUntouchedPlaceholderCamera,cameraSceneIndex,validateCameraSceneIndex} from '../video-camera-motion.js';
import worker from '../worker/scene-worker.mjs';
import {setupAiSceneEditor} from '../ai-scene-editor.js';
import {syncChapterCameraMotion} from '../camera-motion-sync.js';
import {prepareAcceptedCameraSync} from '../accepted-camera-sync.js';
import {evaluateCamera} from '../animation-curves.js';
import {shotAnchorMap} from '../primitive-preview.js';
import {makePrimitive,validatePrimitiveDocument} from '../primitive-schema.js';

const image='data:image/jpeg;base64,'+Buffer.from([255,216,255,217]).toString('base64');
const token='test-motion-token-only-012345678901234567890';
const env={GEMINI_API_KEY:'not-a-real-key',SCENE_ACCESS_TOKEN:token};
const motion=(type='push')=>({version:1,start:0,end:6,type,confidence:.7,uncertainty:'Scale is not calibrated.',
 keys:[{u:0,p:[0,1,5],t:[0,0,0],fov:55},
 {u:.5,p:[0,1,4],t:[0,0,0],fov:55},
 {u:1,p:[0,1,3],t:[0,0,0],fov:55}]});
const project=()=>{
 const seq=createDraftTimeline({duration:12,cuts:[6]});
 seq.shots[0].videoCameraMotion=motion();
 return seq;
};
const payload=()=>({task:'camera_motion',shotId:'draft_001',start:0,end:6,aspect:16/9,profile:'g38_low',
 frames:motionFrameTimes({start:0,end:6}).map(at=>({at,imageDataUrl:image}))});
const call=body=>worker.fetch(new Request('https://mock.workers.dev/api/scene'+(body.task==='camera_alignment'?'/camera-align':''),{
 method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(body)}),env);
const provider=value=>new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[
 {thought:true,text:'private thought must be ignored'},{text:JSON.stringify(value)}]}}],
 usageMetadata:{promptTokenCount:100,candidatesTokenCount:200,thoughtsTokenCount:30,secret:'private'}}));
const modelScene={objects:[{id:'main_building',name:'Main building front',primitive:'box',
 position:[12,5,-8],rotation:[0,.7,0],scale:[40,10,20]}]};
test('scene-aware camera matching sends actual dimensions/rotation and returns one view without geometry generation',async()=>{
 const old=globalThis.fetch;let calls=0;
 const alignment={position:[70,50,80],target:[12,5,-8],fov:48,confidence:.8,uncertainty:'Facade correspondence is approximate.'};
 const input={...payload(),task:'camera_alignment',frames:[{at:3,imageDataUrl:image},{at:1,imageDataUrl:image},{at:5,imageDataUrl:image}],sceneIndex:cameraSceneIndex(modelScene)};
 globalThis.fetch=async(url,opts)=>{
   calls++;assert.match(url,/gemini-3.8-flash/);
   const body=JSON.parse(opts.body);assert.match(body.contents[0].parts[0].text,/ANY side/);
   assert.match(JSON.stringify(body),/Main building front/);assert.match(JSON.stringify(body),/rotation/);
   assert.equal(body.contents[0].parts.filter(p=>p.inlineData).length,3);
   return provider(alignment);
 };
 try{
   const r=await call(input);assert.equal(r.status,200);
   const data=await r.json();assert.deepEqual(data.alignment,alignment);assert.equal(data.referenceAt,3);
   assert.equal(calls,1);assert.equal(data.motion,undefined);
   assert.equal((await call({...input,sceneIndex:[{...input.sceneIndex[0],script:'do not execute'}]})).status,400);
   assert.equal(calls,1,'malformed geometry context must fail before another call');
 }finally{globalThis.fetch=old;}
});
test('camera index budgets inference context without capping or mutating manual objects',()=>{
 const scene={objects:Array.from({length:300},(_,i)=>({...modelScene.objects[0],id:'part_'+i,scale:[i+1,2,3]}))};
 const index=cameraSceneIndex(scene);
 assert.equal(index.length,240);assert.equal(scene.objects.length,300);
 assert.equal(index[0].scale[0],300);
 assert.throws(()=>validateCameraSceneIndex([{...index[0],position:[Infinity,0,0]}]));
 assert.ok(JSON.stringify(index).length<=60000);
});
test('camera matching accepts real grouped assemblies with their component layout and repeat orientation',async()=>{
 const group={...makePrimitive('group','assembly',[10,0,-4]),name:'Building assembly',rotation:[0,.4,0],
   instanceRotation:[0,.8,0],repeat:{count:[2,1,1],spacing:[50,0,0]},arrayParts:{objects:[
     {...makePrimitive('box','walls'),position:[0,5,0],scale:[30,10,20]},
     {...makePrimitive('extrude','roof'),position:[0,12,0]}
   ],lights:[]}};
 const scene=validatePrimitiveDocument({schemaVersion:1,scenes:[{shotId:'draft_001',objects:[group]}]},['draft_001']).scenes[0];
 const before=structuredClone(scene),index=cameraSceneIndex(scene);
 assert.equal(index[0].primitive,'group');assert.equal(index[0].parts.length,2);
 assert.deepEqual(index[0].instanceRotation,[0,.8,0]);
 assert.deepEqual(index[0].parts.find(o=>o.primitive==='box').scale,[30,10,20]);
 assert.deepEqual(index[0].parts.find(o=>o.primitive==='extrude').points,group.arrayParts.objects[1].points);
 assert.deepEqual(scene,before);
 assert.throws(()=>validateCameraSceneIndex([{...index[0],parts:[{...index[0].parts[0],script:'bad'}]}]));
 const old=globalThis.fetch;let calls=0;
 globalThis.fetch=async(url,opts)=>{
   calls++;const data=JSON.parse(opts.body);assert.match(JSON.stringify(data),/Building assembly/);
   assert.match(JSON.stringify(data),/instanceRotation/);
   return provider({position:[70,50,80],target:[12,5,-8],fov:48,confidence:.8,uncertainty:'Estimate'});
 };
 try{
   const result=await call({...payload(),task:'camera_alignment',sceneIndex:index,
     frames:[{at:3,imageDataUrl:image},{at:1,imageDataUrl:image},{at:5,imageDataUrl:image}]});
   assert.equal(result.status,200);assert.equal(calls,1);
 }finally{globalThis.fetch=old;}
});

test('clean video draft is stationary and eleven camera frames cover only their own chapter',()=>{
 const seq=project();
 assert.deepEqual(seq.camera[0].p,seq.camera[1].p);
 assert.equal(seq.camera[0].fov,seq.camera[1].fov);
 const times=motionFrameTimes({start:6,end:12});
 assert.equal(times.length,11);assert.ok(times[0]>6&&times[10]<12);
 assert.ok(times.every((t,i)=>!i||t>times[i-1]));
});
test('editing a placeholder position, curve or time makes its camera authored even if its generated marker survives',()=>{
 const original=project();
 assert.equal(hasUntouchedPlaceholderCamera(original,original.shots[0]),true);
 for(const edit of [k=>{k.p[0]=2;},k=>{k.curve={mode:'linear'};},k=>{k.at+=.2;}]){
   const seq=structuredClone(original);edit(seq.camera[0]);
   assert.equal(seq.camera[0].generated,'placeholder');
   assert.equal(hasUntouchedPlaceholderCamera(seq,seq.shots[0]),false);
 }
 const old=structuredClone(original);delete old.shots[0].placeholderCameraKeys;
 assert.equal(hasUntouchedPlaceholderCamera(old,old.shots[0]),false,'legacy projects need explicit sync');
});
test('reject stale boundaries, unordered poses, nonfinite data and invented unknown/static motion',()=>{
 const m=motion();assert.deepEqual(validateVideoMotion(m),m);
 assert.throws(()=>validateVideoMotion(m,{start:1,end:6}),/boundaries/);
 for(const value of [
   {...m,keys:[m.keys[1],m.keys[0],m.keys[2]]},
   {...m,keys:[{...m.keys[0],p:[NaN,1,3]},m.keys[2]]},
   {...m,keys:[m.keys[0],{...m.keys[2],u:.9}]},
   {...m,type:'unknown'},{...m,type:'static'}
 ])assert.throws(()=>validateVideoMotion(value));
 assert.equal(savedVideoMotion({start:1,end:6,videoCameraMotion:m}),null);
});
test('retarget video push, pan, zoom and orbit without borrowing the placeholder path or touching other chapters',()=>{
 for(const kind of ['push','pan','orbit','mixed']){
   const seq=project(),m=seq.shots[0].videoCameraMotion;m.type=kind;
   if(kind==='pan')m.keys=m.keys.map((k,i)=>({...k,p:[0,1,5],t:[i,0,0]}));
   if(kind==='orbit')m.keys=m.keys.map((k,i)=>({...k,p:[[0,1,5],[3,1,4],[5,1,0]][i]}));
   if(kind==='mixed')m.keys=m.keys.map((k,i)=>({...k,p:[0,1,5],fov:55-i*10}));
   const before=JSON.stringify(seq);
   const next=syncChapterCameraMotion(seq,'draft_001',{mode:'video-motion',
     newBounds:{center:[50,4,9],radius:10},anchor:[50,0,0]}).sequence;
   const keys=next.camera.filter(k=>k.at<6);
   assert.equal(keys.length,3);assert.equal(keys[0].cut,true);
   assert.equal(keys[0].generated,'video-estimate');
   assert.equal(keys[0].curve.mode,'linear');
   assert.ok(keys.at(-1).at<6);
   if(kind==='push')assert.ok(keys[2].p[2]<keys[0].p[2]);
   if(kind==='pan'){assert.deepEqual(keys[0].p,keys[2].p);assert.ok(keys[2].t[0]>keys[0].t[0]);}
   if(kind==='orbit')assert.ok(keys[2].p[0]>keys[0].p[0]);
   if(kind==='mixed'){assert.deepEqual(keys[0].p,keys[2].p);assert.equal(keys[2].fov,35);}
   assert.deepEqual(next.camera.filter(k=>k.at>=6),seq.camera.filter(k=>k.at>=6));
   assert.deepEqual(shotAnchorMap(next,t=>evaluateCamera(next.camera,t)).draft_001,[50,0,0]);
   assert.equal(JSON.stringify(seq),before);
 }
});
test('generated reference camera aligns the sampled timestamp rather than assuming it is chapter start',()=>{
 const seq=project(),view={position:[120,5,0],target:[100,0,0],fov:55};
 const {sequence:next,report}=buildVideoCameraMotion(seq,'draft_001',{
   newBounds:{center:[100,0,0],radius:10},anchor:[100,0,0],modelCamera:view,referenceAt:3});
 assert.equal(report.estimatedOrientationUsed,true);
 // End key is one frame before the next chapter: normalized midpoint maps there.
 const pose=evaluateCamera(next.camera,(6-1/30)/2);
 assert.ok(Math.hypot(...pose.p.map((n,i)=>n-view.position[i]))<.001);
 assert.deepEqual(pose.t,view.target);
 seq.shots[0].cameraReferenceAt=3;
 seq.primitiveScenes={schemaVersion:1,scenes:[{shotId:'draft_001',objects:[{id:'model'}]}]};
 const accepted=prepareAcceptedCameraSync(seq,'draft_001',{
   mode:'video-motion',bounds:{center:[100,0,0],radius:10},anchor:[100,0,0],modelCamera:view});
 assert.deepEqual(accepted.sequence.camera,next.camera);
});
test('camera analysis authenticates and validates all eleven timestamps before any provider call',async()=>{
 const old=globalThis.fetch;let count=0;
 globalThis.fetch=async()=>{count++;return provider(motion());};
 try{
   for(const p of [{...payload(),profile:'g38_medium'},
     {...payload(),frames:payload().frames.slice(1)},
     {...payload(),frames:[...payload().frames].reverse()},
     {...payload(),frames:payload().frames.map(f=>({...f,at:f.at+8}))},
     {...payload(),aspect:Infinity}, {...payload(),model:'arbitrary'}]){
     assert.equal((await call(p)).status,400);
   }
   const unauth=await worker.fetch(new Request('https://mock.workers.dev/api/scene',{
     method:'POST',body:JSON.stringify(payload())}),env);
   assert.equal(unauth.status,401);assert.equal(count,0);
 }finally{globalThis.fetch=old;}
});
test('analysis uses one low/minimal call, filters thoughts and emits only numeric usage',async()=>{
 const old=globalThis.fetch;
 try{
   for(const profile of ['g38_low','lite_default']){
     let count=0;
     globalThis.fetch=async(url,opts)=>{
       count++;const body=JSON.parse(opts.body);
       assert.match(url,new RegExp(profile==='g38_low'?'gemini-3.8-flash':'gemini-3.5-flash-lite'));
       assert.equal(body.generationConfig.thinkingConfig.thinkingLevel,profile==='g38_low'?'low':'minimal');
       assert.equal(body.contents[0].parts.filter(p=>p.inlineData).length,11);
       return provider(motion());
     };
     const response=await call({...payload(),profile}),value=await response.json();
     assert.equal(response.status,200);assert.equal(count,1);
     assert.deepEqual(value.motion,motion());assert.equal(value.usage.thinking,30);
     assert.ok(!JSON.stringify(value).includes('private'));
   }
 }finally{globalThis.fetch=old;}
});
test('quota, capacity and incomplete camera responses never retry or fall back',async()=>{
 const old=globalThis.fetch;
 try{
   for(const status of [429,503,500]){
     let count=0;globalThis.fetch=async()=>{count++;return new Response('private provider error',{status});};
     const r=await call(payload());assert.equal(r.status,status===429?429:502);
     assert.equal(count,1);assert.ok(!(await r.text()).includes('private'));
   }
   globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:JSON.stringify(motion())}]}}]}));
   assert.equal((await call(payload())).status,502);
 }finally{globalThis.fetch=old;}
});

class Element {
 constructor(){this.handlers=new Map();this.value='';this.checked=true;this.hidden=false;this.disabled=false;this.textContent='';}
 addEventListener(type,fn){this.handlers.set(type,fn);}
 removeEventListener(type){this.handlers.delete(type);}
 fire(type){return this.handlers.get(type)?.({target:this});}
}
test('real editor analyzes once, reuses the saved estimate, previews both changes and accepts them together',async()=>{
 const old={document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm};
 const ids=new Map(),seq=createDraftTimeline({duration:12,cuts:[6]});
 let preview=null,staged=null,accepted=null,calls=[],confirmations=[],analysisFailure=false,alignmentResult=null;
 globalThis.document={getElementById(id){if(!ids.has(id))ids.set(id,new Element());return ids.get(id);},
 createElement(tag){
   if(tag==='canvas')return {getContext:()=>({drawImage(){}}),toDataURL:()=>image};
   const node=new Element();
   if(tag==='video')Object.assign(node,{readyState:1,duration:12,videoWidth:640,videoHeight:360,
     removeAttribute(){},load(){},pause(){}});
   Object.defineProperty(node,'currentTime',{set(){queueMicrotask(()=>node.handlers.get('seeked')?.());}});
   return node;
 }};
 globalThis.confirm=message=>{confirmations.push(message);return true;};
 globalThis.fetch=async(url,opts={})=>{
   if(!opts.method)return new Response(JSON.stringify({ok:true,authenticated:true,csrf:'test'}));
   const p=JSON.parse(opts.body);calls.push(p.action);
   if(p.action==='camera_align'){
     assert.equal(p.frames.length,3);assert.deepEqual(p.sceneIndex,cameraSceneIndex(modelScene));
     return new Response(JSON.stringify({ok:true,alignment:{position:[70,50,80],target:[12,5,-8],fov:48,
       confidence:.8,uncertainty:'Approximate camera match.'}}));
   }
   if(p.action==='camera_motion'){
     if(analysisFailure)return new Response(JSON.stringify({ok:false,error:'Gemini rate limit reached'}),{status:429});
     assert.equal(p.frames.length,11);assert.deepEqual(p.frames.map(f=>f.at),motionFrameTimes(seq.shots[0]));
     return new Response(JSON.stringify({ok:true,motion:motion()}));
   }
   assert.equal(p.action,'generate');assert.equal(p.frames.length,3);assert.deepEqual(p.cameraMotion,motion());
   return new Response(JSON.stringify({ok:true,proposal:{schemaVersion:1,scenes:[{shotId:'draft_001',objects:[{
     id:'model',primitive:'box',position:[0,1,0],rotation:[0,0,0],scale:[2,2,2],
     material:{color:'#ffffff',metalness:0,roughness:.7}}]}]}}));
 };
 try{
   const editor=setupAiSceneEditor({getSequence:()=>seq,getActiveShot:()=>seq.shots[0],getPlayheadTime:()=>3,
     getReferenceVideo:()=>({src:'blob:test-video',videoWidth:640,videoHeight:360}),
     onMotionAnalysis:(id,m)=>{assert.equal(id,'draft_001');seq.shots[0].videoCameraMotion=m;},
     getAcceptedScene:()=>modelScene,onReferenceAlignment:(id,alignment,at)=>{alignmentResult={id,alignment,at};},
     onPreview:entry=>{preview=entry;},onInspect(){},onDiscard(){preview=null;},onCameraSyncReset(){staged=null;},
     onCameraSync:(entry,mode,options)=>{
       assert.equal(mode,'video-motion');assert.equal(options.referenceAt,3);
       staged=buildVideoCameraMotion(seq,entry.shotId,{newBounds:{center:[0,1,0],radius:2},anchor:[0,3,0]});
       return staged.report;
     },onAccept:(entry,options)=>{accepted={entry,options,staged};},
     generationSounds:{arm(){},play(){}}
   });
   await new Promise(resolve=>setImmediate(resolve));
   ids.get('aiSceneScope').value='subject';
   ids.get('aiSceneModel').value='lite_default';
   const oldKeys=structuredClone(seq.camera);
   await ids.get('aiSceneGenerate').fire('click');
   assert.deepEqual(calls,['camera_motion','generate']);assert.ok(preview&&staged);
   assert.deepEqual(seq.camera,oldKeys,'preview must not save camera keys');
   assert.equal(ids.get('aiCameraSyncApply').checked,true);
   await ids.get('aiSceneAccept').fire('click');
   assert.equal(accepted.options.syncCamera,true);assert.equal(accepted.options.referenceAt,3);
   assert.equal(accepted.staged.sequence.camera[0].generated,'video-estimate');
   delete seq.camera[0].generated; // a person authored this key
   await ids.get('aiSceneGenerate').fire('click');
   assert.deepEqual(calls,['camera_motion','generate','generate'],'saved analysis should not be billed again');
   assert.equal(staged,null,'authored cameras require explicit video-motion preview');
   assert.equal(ids.get('aiCameraSyncApply').checked,false);
   assert.equal(confirmations.length,1);
   editor.reset();delete seq.shots[0].videoCameraMotion;
   globalThis.confirm=()=>false;
   await ids.get('aiSceneGenerate').fire('click');
   assert.equal(calls.length,3,'cancelled camera consent must not submit geometry either');
   globalThis.confirm=()=>true;analysisFailure=true;
   await ids.get('aiSceneGenerate').fire('click');
   assert.deepEqual(calls,['camera_motion','generate','generate','camera_motion']);
   assert.equal(seq.shots[0].videoCameraMotion,undefined);
   assert.equal(editor.isBusy(),false,'quota failure releases editor for explicit later action');
   const savedBeforeMatch=JSON.stringify(seq);
   await ids.get('acceptedCameraMatchReference').fire('click');
   assert.equal(calls.at(-1),'camera_align');assert.equal(alignmentResult.id,'draft_001');
   assert.equal(alignmentResult.at,3);assert.equal(alignmentResult.alignment.position[0],70);
   assert.equal(JSON.stringify(seq),savedBeforeMatch,'matching must stage, not save camera keys');
   delete seq.videoIntake;editor.reset();editor.refresh();
   assert.equal(ids.get('videoMotionPanel').hidden,true,'fresh workspace cannot reuse the old estimate');
 }finally{Object.assign(globalThis,old);}
});
