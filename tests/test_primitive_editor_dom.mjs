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
  } finally {
    if(previousDocument===undefined)delete globalThis.document;
    else globalThis.document=previousDocument;
  }
});
