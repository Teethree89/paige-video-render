import test from 'node:test';
import assert from 'node:assert/strict';
import {containRect,matchedPins,MAX_PINS,MAX_EXTRA_FRAMES,RECOMMENDED_PINS,PHASE_COPY} from '../camera-track-wizard.js';

test('containRect letterboxes a frame inside its box',()=>{
 const wide=containRect(400,400,16/9);
 assert.equal(wide.w,400);assert.ok(Math.abs(wide.h-225)<1e-9);assert.ok(Math.abs(wide.y-87.5)<1e-9);assert.equal(wide.x,0);
 const tall=containRect(200,400,2);
 assert.equal(tall.w,200);assert.equal(tall.h,100);
 const narrow=containRect(800,200,1);
 assert.equal(narrow.h,200);assert.equal(narrow.w,200);assert.equal(narrow.x,300);
});

test('containRect handles an empty box',()=>{
 assert.deepEqual(containRect(0,300,1.5),{x:0,y:0,w:0,h:0});
 assert.deepEqual(containRect(300,300,NaN),{x:0,y:0,w:0,h:0});
});

test('matchedPins keeps only points that have a model position',()=>{
 const pins=[{x:.1,y:.2},{x:.3,y:.4,X:[1,2,3]},{x:.5,y:.6,X:null}];
 assert.deepEqual(matchedPins(pins).map(p=>p.x),[.3]);
});

test('wizard limits and step copy',()=>{
 assert.ok(MAX_PINS>=RECOMMENDED_PINS&&RECOMMENDED_PINS>=4);
 assert.ok(MAX_EXTRA_FRAMES>=1);
 for(const phase of ['video','model','compare','frame','tracking','preview'])assert.ok(PHASE_COPY[phase],phase);
});
