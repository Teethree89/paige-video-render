// Regression: boot the real primitive-editor module against a tiny DOM fixture.
// This catches the document-shadowing crash that syntax/unit tests missed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

class FakeNode {
  constructor(tag='div') {
    this.tag=tag;this.children=[];this.listeners=new Map();
    this.value='';this.disabled=false;this.hidden=false;
    this.textContent='';this.dataset={};this.files=[];
  }
  addEventListener(name,fn){this.listeners.set(name,fn);}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];}
  querySelectorAll(selector){return selector==='[data-prim]'?this.transformInputs||[]:[];}
  async fire(name, event={}) {
    const listener=this.listeners.get(name);
    assert.ok(listener,'Expected '+name+' listener');
    return listener({target:this,...event});
  }
}
test('primitive inspector initializes and adds editable scene geometry without clobbering document',async()=>{
  const previousDocument=globalThis.document;
  const ids=new Map();
  const fields=[];
  for(const vector of ['position','rotation','scale']){
    for(let i=0;i<3;i++){
      const node=new FakeNode('input');
      node.dataset.prim=vector+'.'+i;
      fields.push(node);
    }
  }
  const dom={
    getElementById(id){
      if(!ids.has(id))ids.set(id,new FakeNode());
      return ids.get(id);
    },
    createElement(tag){return new FakeNode(tag);},
    body:new FakeNode('body')
  };
  dom.getElementById('primitiveEditor').transformInputs=fields;
  globalThis.document=dom;
  try {
    // Keep the tested editor source intact except for replacing Three.js's
    // external export adapter, which is not used in initialization tests.
    const raw=await readFile(new URL('../primitive-editor.js',import.meta.url),'utf8');
    const schemaUrl=new URL('../primitive-schema.js',import.meta.url).href;
    const catalogUrl=new URL('../scene-asset-catalog.js',import.meta.url).href;
    assert.match(raw,/getPrimitiveDocument/);
    const executable=raw.replace(
      "import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';",
      "class GLTFExporter { parse() { throw Error('Not tested'); } }"
    ).replace(
      "from './primitive-schema.js';",
      "from '"+schemaUrl+"';"
    ).replace(
      "from './scene-asset-catalog.js';",
      "from '"+catalogUrl+"';"
    );
    assert.ok(!executable.includes("from 'three/addons/exporters/GLTFExporter.js'"));
    const moduleUrl='data:text/javascript;base64,'+Buffer.from(executable).toString('base64');
    const {setupPrimitiveEditor}=await import(moduleUrl);
    let sequence={shots:[{id:'draft_001',name:'Imported shot'}]};
    let currentIsolation=null;
    const editor=setupPrimitiveEditor({
      getSequence:()=>sequence,
      getActiveShot:()=>sequence.shots[0],
      onDocumentChange:doc=>{sequence.primitiveScenes=doc;},
      world:{hasObjects:()=>false,
        getIsolation:()=>currentIsolation,
        setIsolation:(_shot,next)=>{
          currentIsolation=JSON.stringify(currentIsolation)===JSON.stringify(next)?null:next;
          return currentIsolation;
        }}
    });
    assert.equal(typeof editor.refresh,'function');
    const tree=dom.getElementById('primitiveSceneOutliner');
    assert.ok(tree.children.length,'chapter hierarchy initializes without a separate layer dropdown');
    assert.ok(tree.children.some(group=>group.textContent?.includes('No objects or lights yet')||
      group.children?.some(child=>child.textContent?.includes('No objects or lights yet'))));
    assert.equal(dom.getElementById('primitiveObjectSelect').children[0].tag,'option');
    assert.equal(dom.getElementById('primitiveShotLabel').textContent,'Imported shot · 0 object(s)');
    dom.getElementById('primitiveType').value='box';
    await dom.getElementById('primitiveAdd').fire('click');
    assert.equal(sequence.primitiveScenes.scenes[0].objects.length,1);
    const shape=sequence.primitiveScenes.scenes[0].objects[0];
    assert.equal(shape.primitive,'box');
    const manualCollection=()=>tree.children.find(group=>
      group.children?.[0]?.children?.some(x=>x.textContent?.includes('Manual shapes')));
    let collection=manualCollection();
    assert.ok(collection);
    assert.equal(collection.children[0].children.length,3,
      'layer headings expose expand, eye and isolate controls');
    await collection.children[0].children[1].fire('click');
    assert.equal(sequence.primitiveScenes.scenes[0].layerVisibility.manual,false,
      'eye hides its entire layer in saved scene data');
    collection=manualCollection();
    await collection.children[0].children[1].fire('click');
    assert.equal(sequence.primitiveScenes.scenes[0].layerVisibility?.manual,undefined,
      'eye restores the layer and removes the explicit hidden override');
    collection=manualCollection();
    await collection.children[0].children[2].fire('click');
    assert.deepEqual(currentIsolation,{kind:'layer',layer:'manual'});
    collection=manualCollection();
    await collection.children[0].children[2].fire('click');
    assert.equal(currentIsolation,null,'isolate toggles back without saving scene changes');
    collection=manualCollection();
    const objectRow=collection.children.find(child=>child.className?.includes('primitive-tree-row'));
    const eye=objectRow.children.find(child=>child.className==='primitive-tree-visibility');
    await eye.fire('click');
    assert.equal(sequence.primitiveScenes.scenes[0].objects[0].visible,false,
      'individual eye is persisted');
    
    assert.ok(tree.children.some(group=>group.children?.[0]?.children?.some(child=>child.textContent?.includes('Manual shapes'))),
      'new primitive appears in expandable Manual shapes collection');
    assert.equal(dom.getElementById('primitiveFields').hidden,false);
    assert.equal(typeof editor.selectObject,'function');
    assert.equal(editor.selectObject('missing'),false);
    assert.equal(editor.selectObject(shape.id),true);
    assert.equal(editor.getSelectedId(),shape.id);

    // Input updates must round-trip through validated scene JSON.
    const x=fields.find(x=>x.dataset.prim==='position.0');
    x.value='6.5';
    await x.fire('change');
    assert.equal(sequence.primitiveScenes.scenes[0].objects[0].position[0],6.5);
    editor.refresh();
    assert.equal(dom.getElementById('primitiveObjectSelect').children.length,2);
    // New shapes come from the same dropdown, with a usable default footprint.
    dom.getElementById('primitiveType').value='extrude';
    await dom.getElementById('primitiveAdd').fire('click');
    assert.equal(sequence.primitiveScenes.scenes[0].objects[1].points.length,6);
    assert.equal(dom.getElementById('primitiveShapeReadOnly').textContent,'extrude · 6-point footprint');
    // Fields without inputs survive transform edits and duplication.
    sequence.primitiveScenes.scenes[0].objects.push({id:'windows',name:'Windows',primitive:'box',
      position:[0,4,0],rotation:[0,0,0],scale:[1,1.4,.1],repeat:{count:[5,2,1],spacing:[2,3,0]},
      material:{color:'#223344',metalness:0,roughness:.3,emissive:'#ffcc66',emissiveIntensity:1.5,opacity:.6}});
    sequence.primitiveScenes.scenes[0].camera={position:[0,3,20],target:[0,2,0],fov:40};
    const select=dom.getElementById('primitiveObjectSelect');
    select.value='windows';await select.fire('change');
    assert.equal(dom.getElementById('primitiveShapeReadOnly').textContent,
      'box · 10 copies (5×2×1) · glow #ffcc66 ×1.5 · 60% opacity');
    const y=fields.find(x=>x.dataset.prim==='position.1');
    y.value='5';await y.fire('change');
    await dom.getElementById('primitiveDuplicate').fire('click');
    const scene=sequence.primitiveScenes.scenes[0];
    const [windows,copy]=scene.objects.slice(2);
    assert.equal(windows.position[1],5);
    for(const item of [windows,copy]){
      assert.deepEqual(item.repeat,{count:[5,2,1],spacing:[2,3,0]});
      assert.equal(item.material.emissive,'#ffcc66');assert.equal(item.material.opacity,.6);
    }
    assert.deepEqual(scene.camera,{position:[0,3,20],target:[0,2,0],fov:40});
    // Layers are editable; "manual" removes the layer. Lights are counted.
    const layer=dom.getElementById('primitiveLayer');
    layer.value='structures';await layer.fire('change');
    assert.equal(sequence.primitiveScenes.scenes[0].objects.find(o=>o.id===copy.id).layer,'structures');
    assert.equal(layer.value,'structures');
    layer.value='manual';await layer.fire('change');
    assert.equal('layer' in sequence.primitiveScenes.scenes[0].objects.find(o=>o.id===copy.id),false);
    sequence.primitiveScenes.scenes[0].lights=[{type:'point',color:'#ffcc88',intensity:20,position:[0,4,0]}];
    editor.refresh();
    assert.match(dom.getElementById('primitiveShotLabel').textContent,/· 4 object\(s\) · 1 light\(s\)$/);
    // The checkbox changes only shadow intent, through the real inspector
    // save/validate/refresh path; point shadows are explicitly opt-in.
    assert.equal(editor.selectLight('light_1'),true);
    const shadow=dom.getElementById('primitiveLightCastShadow');
    assert.equal(shadow.checked,false);
    const lampBefore=structuredClone(sequence.primitiveScenes.scenes[0].lights[0]);
    shadow.checked=true;await shadow.fire('change');
    assert.equal(sequence.primitiveScenes.scenes[0].lights[0].castShadow,true);
    assert.equal(shadow.checked,true);
    shadow.checked=false;await shadow.fire('change');
    assert.deepEqual(sequence.primitiveScenes.scenes[0].lights[0],
      {...lampBefore,id:'light_1',name:'point light 1',distance:0,castShadow:false});
    // Loading/filtering older saved generations must not hide unlayered or
    // explicitly manual objects, or write a replacement scene to the timeline.
    sequence.primitiveScenes={schemaVersion:1,scenes:[{shotId:'draft_001',objects:[
      {...shape,id:'legacy'}, {...shape,id:'explicit_manual',layer:'manual'},
      {...shape,id:'empty_layer',layer:null}, {...shape,id:'layered',layer:'structures'}]}]};
    const saved=structuredClone(sequence),filter=dom.getElementById('primitiveLayerFilter');
    const listed=()=>select.children.slice(1).map(option=>option.value);
    filter.value='all';await filter.fire('change');
    assert.deepEqual(listed(),['legacy','explicit_manual','empty_layer','layered']);
    filter.value='manual';await filter.fire('change');
    assert.deepEqual(listed(),['legacy','explicit_manual','empty_layer']);
    filter.value='structures';await filter.fire('change');assert.deepEqual(listed(),['layered']);
    filter.value='all';await filter.fire('change');
    assert.equal(listed().length,4);assert.deepEqual(sequence,saved);
    // A rejected saved scene is reported without crashing startup or erasing it.
    sequence.primitiveScenes.scenes[0].objects[0].primitive='script';
    const rejected=structuredClone(sequence);
    assert.doesNotThrow(()=>editor.refresh());
    assert.match(dom.getElementById('primitiveStatus').textContent,/Export Timeline JSON/);
    assert.match(dom.getElementById('primitiveShotLabel').textContent,/saved geometry unavailable/);
    assert.equal(select.children[0].textContent,'Saved geometry could not be loaded');
    assert.deepEqual(sequence,rejected);
  } finally {
    if(previousDocument===undefined)delete globalThis.document;
    else globalThis.document=previousDocument;
  }
});
