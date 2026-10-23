import test from 'node:test';
import assert from 'node:assert/strict';
import {cubicEasing,curveEasing,evaluateCamera,setCameraCurve} from '../animation-curves.js';
const keys=[
 {id:'a',at:0,p:[0,0,0],t:[0,0,0],fov:40},
 {id:'b',at:2,p:[10,20,30],t:[2,4,6],fov:60},
 {id:'c',at:4,p:[30,40,50],t:[4,8,9],fov:80,cut:true}
];
test('legacy easing matches smoothstep and never mutates keys',()=>{
 const midpoint=evaluateCamera(keys,1);
 assert.equal(midpoint.p[0],5);
 assert.equal(midpoint.fov,50);
 assert.equal(keys[0].curve,undefined);
});
test('linear, hold, ease in/out and custom Bézier interpolate predictably',()=>{
 const linear=structuredClone(keys);linear[0].curve={mode:'linear'};
 assert.equal(evaluateCamera(linear,.5).p[0],2.5);
 const hold=structuredClone(keys);hold[0].curve={mode:'hold'};
 assert.equal(evaluateCamera(hold,1).p[0],0);
 assert.equal(evaluateCamera(hold,2).p[0],10);
 assert.equal(curveEasing(.5,{mode:'ease-in'}),.25);
 assert.equal(curveEasing(.5,{mode:'ease-out'}),.75);
 const bez={mode:'bezier',handles:[.42,0,.58,1]};
 assert.ok(Math.abs(curveEasing(.5,bez)-.5)<.0001);
 assert.equal(cubicEasing(0,bez.handles),0);
 assert.equal(cubicEasing(1,bez.handles),1);
});
test('camera cuts continue to have priority over interpolation curves',()=>{
 const base=structuredClone(keys);
 base[1].curve={mode:'linear'};
 assert.equal(evaluateCamera(base,3).p[0],10);
 assert.equal(evaluateCamera(base,4).p[0],30);
});
test('curve editing validates authored handles without altering originals',()=>{
 const seq={camera:keys};
 const next=setCameraCurve(seq,'a',{mode:'bezier',handles:[.25,.2,.75,.9]});
 assert.equal(seq.camera[0].curve,undefined);
 assert.equal(next.camera[0].curve.mode,'bezier');
 assert.throws(()=>setCameraCurve(seq,'a',{mode:'bezier',handles:[2,0,.5,1]}),/handles/);
 assert.throws(()=>setCameraCurve(seq,'a',{mode:'teleport'}),/Unsupported/);
});
