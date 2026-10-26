import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setupSceneSelectionPanel} from '../scene-selection-panel.js';
import {setupRadialCreate} from '../radial-create.js';

class Node {
 constructor(id=''){
  this.id=id;this.hidden=false;this.children=[];this.parentNode=null;
  this.events={};this.style={setProperty(){}};this.dataset={};
  this.classList={toggle(){}};this.textContent='';this.value='';
 }
 insertBefore(child,before){
  if(child.parentNode){
   const existing=child.parentNode.children.indexOf(child);
   if(existing>=0)child.parentNode.children.splice(existing,1);
  }
  const index=before?this.children.indexOf(before):-1;
  this.children.splice(index<0?this.children.length:index,0,child);
  child.parentNode=this;return child;
 }
 appendChild(node){return this.insertBefore(node,null);}
 append(node){return this.appendChild(node);}
 replaceChildren(...nodes){for(const node of this.children)node.parentNode=null;
   this.children=[];nodes.forEach(node=>this.appendChild(node));}
 addEventListener(type,fn){this.events[type]??=[];this.events[type].push(fn);}
 dispatch(type,event={}){for(const fn of this.events[type]||[])fn(event);}
 click(){this.dispatch('click',{preventDefault(){},stopPropagation(){}});}
 contains(node){for(let n=node;n;n=n.parentNode)if(n===this)return true;return false;}
 closest(){return null;}
 setAttribute(){}
 getBoundingClientRect(){return {left:0,top:0,right:1000,bottom:700,width:1000,height:700};}
 focus(){}
}

test('floating selected-object panel owns actual editable stats and returns them on View',()=>{
 const sidebar=new Node('primitiveEditor'),object=new Node('primitiveFields'),
  light=new Node('primitiveLightFields'),slot=new Node('sceneEditFields');
 sidebar.appendChild(object);sidebar.appendChild(light);
 const elements={sceneEditFields:slot,primitiveFields:object,primitiveLightFields:light};
 const root={getElementById:id=>elements[id]||null,
  createComment:text=>new Node('comment:'+text)};
 const events=[];
 light.addEventListener('change',()=>events.push('light saved'));
 object.addEventListener('change',()=>events.push('object saved'));
 const controller=setupSceneSelectionPanel(root);
 controller.sync('light::bulb_1');
 assert.equal(light.parentNode,slot,'light editor physically moves into viewport dialog');
 assert.equal(object.parentNode,sidebar);
 assert.equal(slot.hidden,false);
 light.dispatch('change');
 controller.sync('box_1');
 assert.equal(object.parentNode,slot);
 assert.equal(light.parentNode,sidebar);
 object.dispatch('change');
 controller.sync('light-target::bulb_1');
 assert.equal(light.parentNode,slot,'aim endpoint edits the same actual light properties');
 controller.restore();
 assert.equal(light.parentNode,sidebar);
 assert.equal(object.parentNode,sidebar);
 assert.equal(slot.hidden,true);
 assert.deepEqual(events,['light saved','object saved'],'original event listeners survive');
});

test('Create quick-repeat can remember and repeat a light (not just props)',()=>{
 const previousDocument=globalThis.document,previousWindow=globalThis.window;
 const previousLocalStorage=globalThis.localStorage,previousPerformance=globalThis.performance;
 const registry=Object.fromEntries(['sceneCreateMenu','sceneCreateWheel',
   'sceneCreateSubmenu','sceneCreateMenuButton','sceneCreateMenuHint'].map(id=>[id,new Node(id)]));
 const viewport=new Node('viewport');
 viewport.appendChild(registry.sceneCreateMenu);
 const handlers={},store=new Map(),created=[];
 globalThis.document={
   getElementById:id=>registry[id]||null,
   createElement:()=>new Node('button'),
   addEventListener:(name,fn)=>{(handlers[name]??=[]).push(fn);}
 };
 const windowMock=new Node('window');
 globalThis.window=windowMock;
 globalThis.localStorage={
   getItem:key=>store.get(key)||null,
   setItem:(key,value)=>store.set(key,value)
 };
 globalThis.performance={now:()=>100};
 const down={button:2,target:viewport,clientX:200,clientY:200,
   preventDefault(){},stopPropagation(){}};
 const up={button:2,preventDefault(){},stopPropagation(){}};
 try{
   const wheel=setupRadialCreate({viewport,canCreate:()=>true,
     getCreateOrigin:(_x,_y,category,item)=>category==='lights'&&item==='point-blue'?[1,3,5]:[0,0,0],
     onCreate:(category,item,origin)=>{created.push({category,item,origin});return true;}});
   wheel.open(200,200);
   const lights=registry.sceneCreateWheel.children.find(node=>node.textContent.includes('Lights'));
   assert.ok(lights);
   lights.click(); // first ring uses allowed light default (point-warm).
   assert.equal(wheel.last.category,'lights');
   viewport.dispatch('pointerdown',down);
   windowMock.dispatch('pointerup',up);
   assert.deepEqual(created.map(x=>x.category),['lights','lights']);
   assert.deepEqual(created.map(x=>x.item),['point-warm','point-warm']);
   assert.match(store.get('paige-create-recents-v1'),/"category":"lights"/);
   // L bypasses the wheel entirely and uses the last actual cursor point.
   viewport.dispatch('pointermove',{target:viewport,clientX:417,clientY:251});
   let prevented=false;
   for(const listener of handlers.keydown||[])
     listener({key:'l',target:viewport,shiftKey:false,ctrlKey:false,metaKey:false,
       altKey:false,repeat:false,preventDefault(){prevented=true;}});
   assert.equal(prevented,true);
   assert.deepEqual(created[2],{category:'lights',item:'point-warm',origin:[0,0,0]});
   assert.equal(created.length,3);
   // The shortcut must never create anything while a field is being edited.
   for(const listener of handlers.keydown||[])
     listener({key:'l',target:{closest:()=>true},shiftKey:false,ctrlKey:false,
       metaKey:false,altKey:false,repeat:false,preventDefault(){throw Error('typing');}});
   assert.equal(created.length,3);
 }finally{
   globalThis.document=previousDocument;
   globalThis.window=previousWindow;
   globalThis.localStorage=previousLocalStorage;
   globalThis.performance=previousPerformance;
 }
});

test('Create button is Edit-only in transport, not over the review controls',async()=>{
 const [html,css,app,obj,primitive]=await Promise.all([
   'index.html','styles.css','app.js','scene-object-edit.js','primitive-editor.js'
 ].map(file=>readFile(new URL('../'+file,import.meta.url),'utf8')));
 const trigger=html.indexOf('id="sceneCreateMenuButton"');
 const transport=html.indexOf('<section class="transport">');
 const endTransport=html.indexOf('</section>',transport);
 assert.ok(trigger>transport&&trigger<endTransport,
   'Create trigger is in transport, not layered over viewport Return button');
 assert.match(html,/id="sceneCreateMenuButton"[^>]*hidden/);
 assert.match(html,/id="sceneEditFields"/);
 assert.match(obj,/createButton\.hidden=!active/);
 assert.match(obj,/selectionPanel\.sync\(active\?selectedId:null\)/);
 assert.match(app,/sceneObjectEditor\?\.focusSelectionIfOffscreen\(\)/);
 assert.match(app,/node=>!!node\.userData\.primitiveId/);
 assert.match(obj,/function focusSelectionIfOffscreen\(/);
 assert.match(css,/\.scene-create-trigger\[hidden\]\{display:none!important\}/);
 assert.match(css,/\.scene-edit-tools\{position:absolute;left:15px/);
 assert.match(primitive,/fieldInputs\('\[data-light\]'\)/);
 assert.match(primitive,/fieldInputs\('\[data-prim\]'\)/);
});


test('Objects and AI generation are separate accessible tab panels with no scroll jump',async()=>{
 const [html,workspace,app]=await Promise.all(
  ['index.html','workspace-controls.js','app.js'].map(
    file=>readFile(new URL('../'+file,import.meta.url),'utf8')));
 for(const id of ['inspectorObjectsButton','inspectorGenerationButton'])
   assert.match(html,new RegExp('id="'+id+'" role="tab"'));
 for(const id of ['inspectorObjectsPanel','inspectorGenerationPanel'])
   assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(html,/role="tablist"/);
 assert.match(workspace,/generationPanel\.appendChild\(aiPanel\)/);
 assert.match(workspace,/objectPanel\.hidden=generation/);
 assert.match(workspace,/generationPanel\.hidden=!generation/);
 assert.match(workspace,/tab\.setAttribute\('aria-selected',String\(selected\)\)/);
 assert.match(workspace,/setInspectorTab\(target,\{focus:true\}\)/);
 assert.doesNotMatch(workspace,/aiScenePanel'\)\?\.scrollIntoView/);
 assert.match(app,/inspectorGenerationButton'\)\?\.getAttribute\('aria-selected'\)/);
});
test('L shortcut and light creation report proof of both runtime nodes in viewport',async()=>{
 const [app,radial,world,primitive,html]=await Promise.all(
  ['app.js','radial-create.js','primitive-world.js','primitive-editor.js','index.html']
  .map(file=>readFile(new URL('../'+file,import.meta.url),'utf8')));
 assert.match(radial,/create\('lights',perCategory\.lights\|\|'point-white',at\)/);
 assert.match(radial,/lastPointer=\{x:event\.clientX,y:event\.clientY\}/);
 assert.match(radial,/typeof result==='string'\?result/);
 assert.match(app,/const node=primitiveWorld\.getLightNode\(shotId,lightId\)/);
 assert.match(app,/const marker=primitiveWorld\.getLightMarker\(shotId,lightId\)/);
 assert.match(app,/const visible=primitiveWorld\.isLightMarkerVisible\(shotId,lightId\)/);
 assert.match(app,/Light saved \('/);
 assert.match(primitive,/getLastCreateError:/);
 assert.match(html,/id="sceneCreateFeedback"/);
 assert.match(world,/function getLightNode\(shotId,id\)/);
 assert.match(world,/function isLightMarkerVisible\(shotId,id\)/);
});
