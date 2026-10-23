// The "?" buttons in front of explainer text, on a small DOM shaped like
// index.html: a section heading, a <summary>, a field and live status lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import {foldHelpText} from '../help-toggles.js';

class Node {
  constructor(document,tag,className='',attributes={}){
    this.ownerDocument=document;this.tagName=tag.toUpperCase();this.className=className;
    this.children=[];this.parent=null;this.hidden=false;this.textContent='';this.type='';
    this.attributes={...attributes};this.listeners={};
    this.classList={add:name=>{this.className=(this.className+' '+name).trim();}};
  }
  get id(){return this.attributes.id||'';}
  set id(value){this.attributes.id=value;}
  getAttribute(name){return name in this.attributes?this.attributes[name]:null;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  get previousElementSibling(){
    const siblings=this.parent?.children||[];
    return siblings[siblings.indexOf(this)-1]||null;
  }
  append(child){child.parent=this;this.children.push(child);}
  before(node){const siblings=this.parent.children;node.parent=this.parent;siblings.splice(siblings.indexOf(this),0,node);}
  matches(selector){
    return selector.split(',').map(part=>part.trim()).some(part=>part.startsWith('.')
      ?this.className.split(' ').includes(part.slice(1)):this.tagName===part.toUpperCase());
  }
  addEventListener(type,fn){this.listeners[type]=fn;}
  click(){let prevented=false;this.listeners.click({preventDefault:()=>{prevented=true;}});return prevented;}
  *descendants(){for(const child of this.children){yield child;yield* child.descendants();}}
  querySelectorAll(selector){
    assert.equal(selector,'p.field-help');
    return [...this.descendants()].filter(node=>node.tagName==='P'&&node.className.split(' ').includes('field-help'));
  }
}
function page(){
  const document={createElement:tag=>new Node(document,tag)};
  const root=new Node(document,'div');
  const make=(parent,tag,className,attributes)=>{const node=new Node(document,tag,className,attributes);parent.append(node);return node;};
  const details=make(root,'details');
  const summary=make(details,'summary');
  const intro=make(details,'p','field-help');
  const panel=make(root,'div');
  const heading=make(panel,'div','section-label');
  const about=make(panel,'p','field-help');
  const field=make(panel,'label','field');
  const first=make(panel,'p','field-help'),second=make(panel,'p','field-help');
  const status=make(panel,'p','field-help',{id:'aiSceneStatus',role:'status'});
  const live=make(panel,'p','field-help',{role:'status'});
  return {root,summary,intro,heading,about,field,first,second,status,live,panel};
}

test('explainers fold behind "?" buttons; live status lines stay visible', () => {
  const p=page();
  assert.equal(foldHelpText(p.root),3);
  for(const paragraph of [p.intro,p.about,p.first,p.second])assert.equal(paragraph.hidden,true);
  for(const paragraph of [p.status,p.live])assert.equal(paragraph.hidden,false);
  // Headings carry their button; elsewhere it stands just before the text.
  const gem=p.heading.children[0];
  assert.equal(gem.textContent,'?');assert.equal(gem.className,'help-gem');assert.equal(gem.type,'button');
  assert.equal(p.summary.children[0].className,'help-gem');
  const standalone=p.first.previousElementSibling;
  assert.equal(standalone.className,'help-gem standalone');
  assert.equal(p.field.children.length,0,'never inside a form label');
  // Adjacent explainers share one button.
  assert.deepEqual(standalone.getAttribute('aria-controls').split(' '),[p.first.id,p.second.id]);
});

test('a "?" button opens and closes its text, and never folds the whole section', () => {
  const p=page();
  foldHelpText(p.root);
  const gem=p.summary.children[0];
  assert.equal(gem.getAttribute('aria-expanded'),'false');
  assert.equal(gem.click(),true,'click inside <summary> must not toggle the <details>');
  assert.equal(p.intro.hidden,false);
  assert.equal(gem.getAttribute('aria-expanded'),'true');
  assert.equal(gem.getAttribute('aria-label'),'Hide explanation');
  gem.click();
  assert.equal(p.intro.hidden,true);assert.equal(gem.getAttribute('aria-label'),'Show explanation');
  const pair=p.first.previousElementSibling;
  pair.click();
  assert.equal(p.first.hidden,false);assert.equal(p.second.hidden,false);
});

test('folding twice adds no second button', () => {
  const p=page();
  foldHelpText(p.root);
  assert.equal(foldHelpText(p.root),0);
  assert.equal(p.heading.children.length,1);
  assert.equal(p.panel.children.filter(node=>node.className==='help-gem standalone').length,1);
});
