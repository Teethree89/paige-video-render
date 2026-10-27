import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {clamp,centeredScroll} from '../workspace-controls.js';

test('workspace timeline zoom clamps its center within content',()=>{
 assert.equal(centeredScroll(0,1200,400),0);
 assert.equal(centeredScroll(.5,1200,400),400);
 assert.equal(centeredScroll(1,1200,400),800);
 assert.equal(centeredScroll(.5,200,400),0);
 assert.equal(clamp(20,1,12),12);
 assert.equal(clamp(0,1,12),1);
});

// CSS guards both drag selection of chrome and Ctrl/Cmd+A in actual input boxes.
test('the editor selects input text, not timeline and inspector chrome',()=>{
 const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
 assert.match(css,/html,body\{[^}]*-webkit-user-select:none;user-select:none/);
 assert.match(css,/input,textarea,\[contenteditable\]:not\(\[contenteditable="false"\]\)\{[^}]*-webkit-user-select:text;user-select:text/);
});
