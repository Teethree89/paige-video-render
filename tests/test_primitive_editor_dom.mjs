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
    assert.match(raw,/getPrimitiveDocument/);
    const executable=raw.replace(
      "import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';",
      "class GLTFExporter { parse() { throw Error('Not tested'); } }"
    ).replace(
      "from './primitive-schema.js';",
      "from '"+schemaUrl+"';"
    );
    assert.ok(!executable.includes("from 'three/addons/exporters/GLTFExporter.js'"));
    const moduleUrl='data:text/javascript;base64,'+Buffer.from(executable).toString('base64');
    const {setupPrimitiveEditor}=await import(moduleUrl);
    let sequence={shots:[{id:'draft_001',name:'Imported shot'}]};
    const editor=setupPrimitiveEditor({
      getSequence:()=>sequence,
      getActiveShot:()=>sequence.shots[0],
      onDocumentChange:doc=>{sequence.primitiveScenes=doc;},
      world:{hasObjects:()=>false}
    });
    assert.equal(typeof editor.refresh,'function');
    assert.equal(dom.getElementById('primitiveObjectSelect').children[0].tag,'option');
    assert.equal(dom.getElementById('primitiveShotLabel').textContent,'Imported shot · 0 object(s)');
    dom.getElementById('primitiveType').value='box';
    await dom.getElementById('primitiveAdd').fire('click');
    assert.equal(sequence.primitiveScenes.scenes[0].objects.length,1);
    const shape=sequence.primitiveScenes.scenes[0].objects[0];
    assert.equal(shape.primitive,'box');
    assert.equal(dom.getElementById('primitiveFields').hidden,false);
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
  } finally {
    if(previousDocument===undefined)delete globalThis.document;
    else globalThis.document=previousDocument;
  }
});
