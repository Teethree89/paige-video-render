// Presentation-only workspace controls. No changes to scene data, generation,
// paid-job submission, or editor timelines. Settings stay local to this browser.
export const clamp=(value,lo,hi)=>Math.min(hi,Math.max(lo,value));
export function centeredScroll(fraction,contentWidth,viewportWidth){
  const max=Math.max(0,contentWidth-viewportWidth);
  return clamp(fraction*contentWidth-viewportWidth/2,0,max);
}
export function setupWorkspaceControls(root=document){
  const el=id=>root.getElementById(id);
  const workbench=el('studioWorkbench'),timeline=el('studioTimeline');
  const scroll=el('timelineScroll'),tracks=el('tracks'),main=root.querySelector('.main-col');
  if(!workbench||!timeline||!scroll||!tracks||!main)return null;
  const storage='paige-studio-workspace-v1';
  let state={zoom:1,timelineHeight:320,inspectorWidth:360};
  try{
    const saved=JSON.parse(localStorage.getItem(storage)||'null');
    if(saved&&typeof saved==='object')for(const key of Object.keys(state)){
      if(Number.isFinite(saved[key]))state[key]=saved[key];
    }
  }catch{}
  state.zoom=clamp(state.zoom,1,12);
  state.timelineHeight=clamp(state.timelineHeight,180,800);
  state.inspectorWidth=clamp(state.inspectorWidth,280,620);
  const save=()=>{try{localStorage.setItem(storage,JSON.stringify(state));}catch{}};
  const zoomText=el('timelineZoomText');
  const showZoom=(zoom,focus)=>{
    const oldWidth=tracks.getBoundingClientRect().width||scroll.clientWidth||1;
    const oldCenter=(scroll.scrollLeft+scroll.clientWidth/2)/oldWidth;
    state.zoom=clamp(Math.round(zoom*100)/100,1,12);
    tracks.style.width=String(state.zoom*100)+'%';
    if(zoomText)zoomText.textContent=Math.round(state.zoom*100)+'%';
    const focusFraction=typeof focus==='number'?clamp(focus,0,1):clamp(oldCenter,0,1);
    scroll.scrollLeft=centeredScroll(focusFraction,tracks.getBoundingClientRect().width,scroll.clientWidth);
    save();
  };
  const showHeight=h=>{
    const max=Math.max(180,main.getBoundingClientRect().height-150);
    state.timelineHeight=clamp(Math.round(h),180,Math.min(800,max));
    timeline.style.setProperty('--timeline-height',state.timelineHeight+'px');
    save();
  };
  const showWidth=w=>{
    state.inspectorWidth=clamp(Math.round(w),280,Math.min(620,window.innerWidth*.55));
    workbench.style.setProperty('--inspector-width',state.inspectorWidth+'px');
    save();
  };
  showWidth(state.inspectorWidth);showHeight(state.timelineHeight);showZoom(state.zoom,0);
  el('timelineZoomOut')?.addEventListener('click',()=>showZoom(state.zoom/1.4));
  el('timelineZoomIn')?.addEventListener('click',()=>showZoom(state.zoom*1.4));
  el('timelineFit')?.addEventListener('click',()=>showZoom(1,0));
  scroll.addEventListener('wheel',event=>{
    if(!event.ctrlKey&&!event.metaKey)return;
    event.preventDefault();
    const box=scroll.getBoundingClientRect();
    const fraction=(scroll.scrollLeft+event.clientX-box.left)/(tracks.getBoundingClientRect().width||1);
    showZoom(state.zoom*(event.deltaY<0?1.2:1/1.2),fraction);
    scroll.scrollLeft=clamp(fraction*tracks.getBoundingClientRect().width-(event.clientX-box.left),
      0,Math.max(0,tracks.getBoundingClientRect().width-scroll.clientWidth));
  },{passive:false});
  const expand=el('timelineExpand');
  let previousHeight=state.timelineHeight,expanded=false;
  expand?.addEventListener('click',()=>{
    if(!expanded){previousHeight=state.timelineHeight;showHeight(main.clientHeight-150);}
    else showHeight(previousHeight);
    expanded=!expanded;
    expand.setAttribute('aria-pressed',String(expanded));
    expand.textContent=expanded?'Restore':'Expand';
  });
  const bindDrag=(id,orientation,onDrag,onKeyboard)=>{
    const handle=el(id);if(!handle)return;
    let start=null;
    handle.addEventListener('pointerdown',e=>{
      if(e.button!==0)return;
      start={x:e.clientX,y:e.clientY,h:timeline.getBoundingClientRect().height,
        w:workbench.querySelector('.inspector')?.getBoundingClientRect().width||state.inspectorWidth};
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove',e=>{if(start)onDrag(start,e);});
    const done=()=>{start=null;};
    handle.addEventListener('pointerup',done);
    handle.addEventListener('pointercancel',done);
    handle.addEventListener('keydown',e=>{
      if(e.key!=='ArrowUp'&&e.key!=='ArrowDown'&&e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;
      e.preventDefault();onKeyboard(e.key,e.shiftKey?30:12);
    });
  };
  bindDrag('timelineResizeHandle','horizontal',(start,e)=>showHeight(start.h+start.y-e.clientY),
    (key,step)=>{if(key==='ArrowUp')showHeight(state.timelineHeight+step);
      if(key==='ArrowDown')showHeight(state.timelineHeight-step);});
  bindDrag('inspectorResizeHandle','vertical',(start,e)=>showWidth(start.w+start.x-e.clientX),
    (key,step)=>{if(key==='ArrowLeft')showWidth(state.inspectorWidth+step);
      if(key==='ArrowRight')showWidth(state.inspectorWidth-step);});
  el('timelineResizeHandle')?.addEventListener('dblclick',()=>showHeight(320));
  el('inspectorResizeHandle')?.addEventListener('dblclick',()=>showWidth(360));
  const tabs=[
    {key:'objects',button:'inspectorObjectsButton',panel:'inspectorObjectsPanel',title:'Project overview',hint:'Project summary, chapters and timeline reset.'},
    {key:'scene',button:'inspectorSceneButton',panel:'inspectorScenePanel',title:'3D objects',hint:'Edit chapter geometry, assemblies, lights and external models.'},
    {key:'look',button:'inspectorLookButton',panel:'inspectorLookPanel',title:'Scene effects',hint:'Control chapter fog, lighting, shadows, bloom and exposure.'},
    {key:'motion',button:'inspectorMotionButton',panel:'inspectorMotionPanel',title:'Motion & text',hint:'Select a timeline camera key or text overlay to edit.'},
    {key:'source',button:'inspectorSourceButton',panel:'inspectorSourcePanel',title:'Source video',hint:'Inspect source media and compare it with the 3D view.'},
    {key:'generation',button:'inspectorGenerationButton',panel:'inspectorGenerationPanel',title:'AI generation',hint:'Generate or review an editable 3D scene for the current chapter.'}
  ].map(tab=>({...tab,element:el(tab.button),target:el(tab.panel)}));
  // Move controls once before app.js initialization. All IDs and editor state stay intact.
  const move=(id,key)=>{
    const element=el(id),panel=tabs.find(tab=>tab.key===key)?.target;
    if(element&&panel)panel.appendChild(element);
  };
  move('sceneEffectsPanel','look');
  move('primitiveEditor','scene');
  move('externalModelLibrary','scene');
  move('acceptedCameraSyncPanel','motion');
  move('cameraPanel','motion');
  move('textPanel','motion');
  const sourceCard=root.querySelector('.reference-card');
  if(sourceCard)tabs.find(tab=>tab.key==='source')?.target?.appendChild(sourceCard);
  move('aiScenePanel','generation');
  // Remove the dividers left behind by moving controls into their own workspaces.
  const projectPanel=el('projectPanel');
  if(projectPanel){
    const dividers=[...projectPanel.children].filter(child=>child.classList.contains('divider'));
    dividers.slice(1).forEach(divider=>divider.remove());
  }
  const primitiveEditor=el('primitiveEditor'),effectsPanel=el('sceneEffectsPanel');
  if(primitiveEditor)primitiveEditor.open=true;
  if(effectsPanel)effectsPanel.open=true;
  const setInspectorTab=(value,{focus=false}={})=>{
    const key=tabs.some(tab=>tab.key===value)?value:'objects';
    for(const tab of tabs){
      const active=tab.key===key;
      if(tab.target)tab.target.hidden=!active;
      if(tab.element){
        tab.element.setAttribute('aria-selected',String(active));
        tab.element.tabIndex=active?0:-1;
        if(active&&focus)tab.element.focus?.();
      }
    }
    const current=tabs.find(tab=>tab.key===key);
    const heading=el('inspectorHeading'),hint=el('inspectorHint');
    const cameraPanel=el('cameraPanel'),textPanel=el('textPanel');
    if(heading)heading.textContent=key==='motion'&&!cameraPanel?.hidden?'Camera keyframe':
      key==='motion'&&!textPanel?.hidden?'Text overlay':current.title;
    if(hint)hint.textContent=current.hint;
    const aside=current.element?.closest?.('.inspector');
    if(aside)aside.scrollTop=0;
    try{localStorage.setItem('paige-inspector-tab-v2',key);}catch{}
  };
  tabs.forEach((tab,index)=>{
    tab.element?.addEventListener('click',()=>setInspectorTab(tab.key));
    tab.element?.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();
      const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:
        (index+(event.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length;
      setInspectorTab(tabs[next].key,{focus:true});
    });
  });
  let initialTab='objects';
  try{initialTab=localStorage.getItem('paige-inspector-tab-v2')||'objects';}catch{}
  setInspectorTab(initialTab);
  return {setZoom:showZoom,setHeight:showHeight,setInspectorTab};
}
if(typeof document!=='undefined')setupWorkspaceControls();
