import test from 'node:test';
import assert from 'node:assert/strict';
import {setupViewportTools,TOOLS,TOOL_KEYS} from '../viewport-tools.js';

function fakeStrip(){
  const buttons=TOOLS.map(name=>{
    const listeners=[];
    const classes=new Set();
    return {dataset:{tool:name},disabled:false,listeners,
      classList:{toggle:(c,on)=>on?classes.add(c):classes.delete(c),contains:c=>classes.has(c)},
      setAttribute(k,v){this[k]=v;},addEventListener:(t,fn)=>listeners.push(fn),click(){if(!this.disabled)listeners.forEach(fn=>fn());}};
  });
  return {buttons,root:{dataset:{},querySelectorAll:()=>buttons}};
}

test('orbit is always available and is the starting tool',()=>{
  const {root}=fakeStrip(),tools=setupViewportTools({root});
  assert.equal(tools.tool,'orbit');
  assert.ok(tools.isAvailable('orbit'));
  assert.ok(!tools.isAvailable('move'));
  assert.ok(!tools.isAvailable('point'));
});

test('only available tools can be chosen, and choosing notifies the host',()=>{
  const {root,buttons}=fakeStrip(),chosen=[];
  const tools=setupViewportTools({root,onSelect:t=>chosen.push(t)});
  assert.equal(tools.choose('move'),false);
  tools.setAvailable(['move','rotate']);
  buttons[1].click();
  assert.equal(tools.tool,'move');
  assert.deepEqual(chosen,['move']);
  assert.equal(buttons[1].disabled,false);
  assert.equal(buttons[3].disabled,true);
  assert.equal(root.dataset.tool,'move');
});

test('a tool that stops being available falls back to orbit (point set only while tracking)',()=>{
  const {root}=fakeStrip(),tools=setupViewportTools({root});
  tools.setAvailable(['point']);
  tools.set('point');
  assert.equal(tools.tool,'point');
  tools.setAvailable(['move','rotate']);
  assert.equal(tools.tool,'orbit');
});

test('shortcut keys map to the four tools',()=>{
  assert.equal(TOOL_KEYS.KeyO,'orbit');
  assert.equal(TOOL_KEYS.KeyW,'move');
  assert.equal(TOOL_KEYS.KeyE,'rotate');
  assert.equal(TOOL_KEYS.KeyP,'point');
});
