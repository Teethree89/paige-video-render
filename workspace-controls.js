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
  const objectTab=el('inspectorObjectsButton'),generationTab=el('inspectorGenerationButton');
  const objectPanel=el('inspectorObjectsPanel'),generationPanel=el('inspectorGenerationPanel');
  // Keep one live instance of the AI controls. Reparenting happens before
  // app.js initializes any paid-job handlers and leaves all IDs unchanged.
  const aiPanel=el('aiScenePanel');
  if(generationPanel&&aiPanel)generationPanel.appendChild(aiPanel);
  const setInspectorTab=(value,{focus=false}={})=>{
    const generation=value==='generation';
    if(objectPanel)objectPanel.hidden=generation;
    if(generationPanel)generationPanel.hidden=!generation;
    for(const [tab,selected] of [[objectTab,!generation],[generationTab,generation]]){
      if(!tab)continue;
      tab.setAttribute('aria-selected',String(selected));
      tab.tabIndex=selected?0:-1;
      if(selected&&focus)tab.focus?.();
    }
    const heading=el('inspectorHeading'),hint=el('inspectorHint');
    if(generation){
      if(heading)heading.textContent='AI generation';
      if(hint)hint.textContent='Generate or review an editable 3D scene for the current chapter.';
    }else{
      if(heading)heading.textContent='Project settings';
      if(hint)hint.textContent='Select a timeline item to adjust its animation.';
    }
    const aside=objectTab?.closest?.('.inspector');
    if(aside)aside.scrollTop=0;
  };
  objectTab?.addEventListener('click',()=>setInspectorTab('objects'));
  generationTab?.addEventListener('click',()=>setInspectorTab('generation'));
  [objectTab,generationTab].forEach(tab=>tab?.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const target=event.key==='Home'?'objects':event.key==='End'?'generation':
      tab===objectTab?'generation':'objects';
    setInspectorTab(target,{focus:true});
  }));
  setInspectorTab('objects');
  return {setZoom:showZoom,setHeight:showHeight,setInspectorTab};
}
if(typeof document!=='undefined')setupWorkspaceControls();
