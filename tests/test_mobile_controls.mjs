import test from 'node:test';
import assert from 'node:assert/strict';
import {FRAME,LAYERS,nextLayer,scrubDelta} from '../mobile-controls.js';

test('layer switch cycles in both directions and wraps',()=>{
  assert.deepEqual([...LAYERS],['scenes','camera','text']);
  assert.equal(nextLayer('scenes',1),'camera');
  assert.equal(nextLayer('text',1),'scenes');
  assert.equal(nextLayer('scenes',-1),'text');
});

test('fine scrub is slow: a 300 px swipe moves under two seconds and 6 px is one frame',()=>{
  assert.ok(Math.abs(scrubDelta(300))<2);
  assert.ok(Math.abs(scrubDelta(6)-FRAME)<1e-9);
  assert.equal(scrubDelta(0),0);
  assert.ok(scrubDelta(-10)<0);
});
