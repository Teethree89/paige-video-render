// Lightweight per-render instrumentation. Paused previews never render just
// to update statistics; renderer.info is reset ONCE per actual displayed frame.
export function chapterGeometryStats(document,shotId){
 const entry=document?.scenes?.find(scene=>scene.shotId===shotId);
 if(!entry)return {objects:0,arrayCopies:0,meshCopies:0,lights:0};
 let arrayCopies=0,meshCopies=0,lights=entry.lights?.length||0;
 for(const item of entry.objects||[]){
   const copies=item.repeat?.count?.reduce((n,x)=>n*x,1)||1;
   if(item.repeat)arrayCopies+=copies;
   meshCopies+=copies*((item.primitive==='group'?0:1)+(item.arrayParts?.objects?.length||0));
   lights+=copies*(item.arrayParts?.lights?.length||0);
 }
 return {objects:entry.objects?.length||0,arrayCopies,meshCopies,lights};
}

// Measure actual Three.js draw submissions, including shadow-map passes and
// bloom/composer passes, rather than guessing from the authoring graph.
// Renderer hooks do not change saved data or light state.
export function createRenderCallCounter(renderer,scene){
 const info=renderer.info;
 const originalAutoReset=info.autoReset;
 const originalRender=renderer.render;
 const originalShadowRender=renderer.shadowMap.render;
 let shadowCalls=0,postCalls=0;
 info.autoReset=false;
 renderer.shadowMap.render=function(...args){
   const before=info.render.calls;
   try{return originalShadowRender.apply(this,args);}
   finally{shadowCalls+=Math.max(0,info.render.calls-before);}
 };
 renderer.render=function(nextScene,...args){
   const before=info.render.calls;
   try{return originalRender.call(this,nextScene,...args);}
   finally{if(nextScene!==scene)postCalls+=Math.max(0,info.render.calls-before);}
 };
 return {
   beginFrame(){shadowCalls=0;postCalls=0;info.reset();},
   endFrame(){
     const total=info.render.calls;
     const shadows=Math.min(total,shadowCalls);
     const bloom=Math.min(total-shadows,postCalls);
     return {draws:total,scene:Math.max(0,total-shadows-bloom),
       shadows,bloom,triangles:info.render.triangles};
   },
   dispose(){
     renderer.render=originalRender;
     renderer.shadowMap.render=originalShadowRender;
     info.autoReset=originalAutoReset;
   }
 };
}
export function createRenderDiagnostics({renderer,scene,root,getDocument,getShotId,getBatches}){
 const counter=createRenderCallCounter(renderer,scene);
 let lastFrameTime=-Infinity,lastUpdate=0,windowStart=0,windowFrames=0,fps=null,lastShot=null;
 let latest={draws:0,scene:0,shadows:0,bloom:0,triangles:0};
 const $=id=>root?.querySelector('#'+id);
 function update(now,force=false){
   const shot=getShotId();
   if(!force&&now-lastUpdate<500&&shot===lastShot)return;
   lastUpdate=now;lastShot=shot;
   const counts=chapterGeometryStats(getDocument(),shot),gpu=getBatches(shot);
   const idle=now-lastFrameTime>900;
   const status=idle?'Idle':fps===null?'Sampling':String(fps);
   const fields={
     renderStatsFps:'FPS: '+status,
     renderStatsObjects:counts.objects,
     renderStatsCopies:counts.arrayCopies,
     renderStatsMeshCopies:counts.meshCopies,
     renderStatsGpuInstances:gpu.instances+' / '+gpu.batches,
     renderStatsDraws:latest.draws,
     renderStatsSceneCalls:latest.scene,
     renderStatsShadowCalls:latest.shadows,
     renderStatsBloomCalls:latest.bloom,
     renderStatsTriangles:latest.triangles.toLocaleString()
   };
   for(const [id,value] of Object.entries(fields)){const node=$(id);if(node)node.textContent=String(value);}
 }
 function beginFrame(){counter.beginFrame();}
 function endFrame(now=performance.now()){
   latest=counter.endFrame();
   if(now-lastFrameTime>250){windowStart=now;windowFrames=0;fps=null;}
   lastFrameTime=now;windowFrames++;
   if(now-windowStart>=650){fps=Math.round(1000*windowFrames/(now-windowStart));windowStart=now;windowFrames=0;}
   update(now);
 }
 function noteIdle(now=performance.now()){
   if(now-lastFrameTime>900){fps=null;update(now);}
 }
 const log=$('renderStatsLog');
 if(log)log.addEventListener('click',()=>console.info('[Paige viewport render snapshot]',{
   shot:getShotId(),fps:performance.now()-lastFrameTime>900?'Idle':fps,
   ...chapterGeometryStats(getDocument(),getShotId()),
   ...getBatches(getShotId()),...latest
 }));
 update(performance.now(),true);
 return {beginFrame,endFrame,noteIdle,getSnapshot:()=>({...latest}),dispose:counter.dispose};
}
