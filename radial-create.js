import {CREATE_CATEGORIES,CREATE_DEFAULTS,validateCreateChoice} from './scene-asset-catalog.js';

// Right-click tap = repeat last item. Hold >= 380 ms = open radial wheel.
// Hover over a category for >= 500 ms = choose its subcategory.
// Clicking a first-ring category = repeat last item in that category.
export const CREATE_HOLD_MS=380,CREATE_HOVER_MS=500;
export function setupRadialCreate({viewport,canCreate,onCreate,getCreateOrigin,onStatus=()=>{}}){
 const menu=document.getElementById('sceneCreateMenu');
 const wheel=document.getElementById('sceneCreateWheel');
 const submenu=document.getElementById('sceneCreateSubmenu');
 const trigger=document.getElementById('sceneCreateMenuButton');
 if(!viewport||!menu||!wheel||!submenu||!trigger)throw Error('Missing Create radial menu UI');
 let shown=false,press=null,hold=null,hover=null,submenuClosing=null,menuPoint=null;
 let last={category:'primitives',item:'box'};
 const perCategory={...CREATE_DEFAULTS};
 try{
   const saved=JSON.parse(localStorage.getItem('paige-create-recents-v1')||'null');
   if(saved&&validateCreateChoice(saved.category,saved.item))last=saved;
   for(const category of CREATE_CATEGORIES){
     const remembered=saved?.perCategory?.[category.id];
     if(remembered)try{validateCreateChoice(category.id,remembered);perCategory[category.id]=remembered;}catch{}
   }
 }catch{}
 const save=()=>{try{localStorage.setItem('paige-create-recents-v1',
   JSON.stringify({...last,perCategory}));}catch{}};
 const status=document.getElementById('sceneCreateMenuHint');
 const cleanup=()=>{if(hold)clearTimeout(hold);hold=null;
   if(hover)clearTimeout(hover);hover=null;
   if(submenuClosing)clearTimeout(submenuClosing);submenuClosing=null;};
 const hide=()=>{shown=false;menu.hidden=true;submenu.hidden=true;cleanup();};
 const makeButton=(label,klass,handler)=>{
   const b=document.createElement('button');b.type='button';b.className=klass;
   b.textContent=label;b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();handler();});
   return b;
 };
 function create(category,item,at=press||menuPoint){
   try{
     validateCreateChoice(category,item);
     if(!canCreate()){onStatus('Switch to Edit mode and finish any active AI preview before creating.');hide();return false;}
     const position=getCreateOrigin(at?.x,at?.y,category,item);
     const result=onCreate(category,item,position);
     if(result!==false){
       last={category,item};perCategory[category]=item;save();
       onStatus('Created '+item.replaceAll('-',' ')+' · '+category);
     }
     hide();return result!==false;
   }catch(error){onStatus('Create failed: '+error.message);hide();return false;}
 }
 function categories(){
   wheel.replaceChildren();
   const total=CREATE_CATEGORIES.length;
   CREATE_CATEGORIES.forEach((c,i)=>{
     const angle=2*Math.PI*i/total-Math.PI/2;
     const b=makeButton(c.glyph+' '+c.label,'scene-create-petal',
       ()=>create(c.id,perCategory[c.id]));
     b.style.left=(50+Math.cos(angle)*39)+'%';
     b.style.top=(50+Math.sin(angle)*39)+'%';
     b.title='Click to repeat '+perCategory[c.id]+', hover for choices';
     b.setAttribute('aria-label',c.label+'; repeat '+perCategory[c.id]+' or hover for submenu');
     b.addEventListener('pointerenter',()=>{
       if(hover)clearTimeout(hover);
       if(submenuClosing)clearTimeout(submenuClosing);
       hover=setTimeout(()=>showSubmenu(c,b),CREATE_HOVER_MS);
     });
     b.addEventListener('pointerleave',()=>{
       if(hover)clearTimeout(hover);
       submenuClosing=setTimeout(()=>{submenu.hidden=true;},300);
     });
     wheel.append(b);
   });
 }
 function showSubmenu(category,origin){
   if(!shown)return;
   if(submenuClosing)clearTimeout(submenuClosing);
   submenu.hidden=false;submenu.replaceChildren();
   const title=document.createElement('div');title.className='scene-create-submenu-title';
   title.textContent=category.label+' · choose an item';
   submenu.append(title);
   for(const [id,label] of category.items){
     const b=makeButton(label+(perCategory[category.id]===id?' · last':''),'scene-create-option',
       ()=>create(category.id,id));
     submenu.append(b);
   }
   submenu.onpointerenter=()=>{if(submenuClosing)clearTimeout(submenuClosing);};
   submenu.onpointerleave=()=>{submenuClosing=setTimeout(()=>{submenu.hidden=true;},260);};
   const rect=viewport.getBoundingClientRect(),center=menu.getBoundingClientRect();
   const leftOfMenu=center.left+center.width/2>rect.left+rect.width*.65;
   submenu.classList.toggle('left-side',leftOfMenu);
   const desiredHeight=Math.min(330,category.items.length*39+49);
   const maximumTop=rect.bottom-center.top-desiredHeight-6;
   const minimumTop=rect.top-center.top+6;
   submenu.style.top=Math.max(minimumTop,Math.min(45,maximumTop))+'px';
   status.textContent=category.label.toUpperCase();
 }
 function open(clientX,clientY){
   if(!canCreate()){onStatus('Switch to Edit mode before using the Create wheel.');return;}
   cleanup();categories();shown=true;
   const rect=viewport.getBoundingClientRect();
   menuPoint={x:clientX,y:clientY};
   const size=Math.min(320,rect.width-12,rect.height-12),half=size/2;
   const x=Number.isFinite(clientX)?clientX:rect.left+rect.width/2;
   const y=Number.isFinite(clientY)?clientY:rect.top+rect.height/2;
   // Keep the wheel inside the viewport, including near its corners.
   menu.style.setProperty('--wheel-size',Math.max(160,size)+'px');
   menu.style.left=Math.max(half+7,Math.min(rect.width-half-7,x-rect.left))+'px';
   menu.style.top=Math.max(half+7,Math.min(rect.height-half-7,y-rect.top))+'px';
   menu.hidden=false;submenu.hidden=true;
   status.textContent='CHOOSE CATEGORY';
   wheel.querySelector('button')?.focus({preventScroll:true});
 }
 function pointerDown(event){
   if(event.button!==2||!viewport.contains(event.target)||event.target.closest('button,input,select,textarea'))return;
   if(!canCreate())return;
   // In Edit mode, secondary mouse input belongs to Create, not orbit.
   event.preventDefault();event.stopPropagation();
   press={x:event.clientX,y:event.clientY,started:performance.now(),held:false};
   cleanup();
   hold=setTimeout(()=>{if(press){press.held=true;open(press.x,press.y);}},CREATE_HOLD_MS);
 }
 function pointerUp(event){
   if(event.button!==2||!press)return;
   event.preventDefault();event.stopPropagation();
   const original=press;press=null;
   if(hold)clearTimeout(hold);hold=null;
   if(!original.held){
     if(shown)hide();
     else create(last.category,last.item,original);
   }
 }
 viewport.addEventListener('pointerdown',pointerDown,true);
 window.addEventListener('pointerup',pointerUp,true);
 window.addEventListener('pointercancel',()=>{press=null;hide();},true);
 viewport.addEventListener('contextmenu',event=>{
   if(canCreate()&&!event.target.closest('input,textarea,select')){
     event.preventDefault();event.stopPropagation();
   }
 },true);
 document.addEventListener('pointerdown',event=>{
   if(shown&&!menu.contains(event.target)&&event.target!==trigger&&event.button!==2)hide();
 },true);
 document.addEventListener('keydown',event=>{
   if(event.key==='Escape'&&shown){event.preventDefault();hide();}
   if(event.key.toLowerCase()==='c'&&event.shiftKey&&!event.ctrlKey&&!event.metaKey&&
     !event.target.closest?.('input,textarea,select,[contenteditable=true]')){
     event.preventDefault();open();
   }
 });
 trigger.addEventListener('click',()=>shown?hide():open());
 return {open,hide,get last(){return {...last}}};
}
