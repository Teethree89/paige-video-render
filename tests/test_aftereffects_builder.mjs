import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const jsx=readFileSync(new URL('../AfterEffects/BUILD_EDITABLE_PROJECT.jsx',import.meta.url),'utf8');
const code=jsx.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|\s)\/\/[^\n]*/g,'$1');

test('After Effects camera guides use the camera Point of Interest matchName',()=>{
  assert.match(code,/poi=tr\.property\("ADBE Anchor Point"\)/);
  assert.doesNotMatch(code,/\.property\("ADBE Point of Interest"\)/);
  assert.match(code,/pos\.setValueAtTime\(local,p\);poi\.setValueAtTime\(local,q\)/);
});

test('Adobe ExtendScript catch paths do not coerce native Error objects',()=>{
  assert.match(code,/function errorDetails\(err\)/);
  assert.match(code,/typeof err\.message==="string"/);
  assert.match(code,/reportWarning\("Camera import warning for "\+shot\.name,e\)/);
  // Reading a primitive field such as err.line is safe; coercing the Error itself is not.
  assert.doesNotMatch(code,/\+\s*(?:err|renderError|e)\b(?!\s*[.([])/);
  assert.doesNotMatch(code,/(?:String\s*\(\s*(?:err|renderError|e)\s*\)|(?:err|renderError|e)\.toString\s*\(\))/);
});

test('Avoid unsupported ES3 Array.indexOf and retain camera failure isolation',()=>{
  assert.match(code,/function indexIn\(list,value\)/);
  assert.doesNotMatch(code,/fileIds\.indexOf\(/);
  assert.match(code,/try\{addCameraKeys\(workspace,seq,shot,offsets\[sid\]\);\}/);
  assert.match(code,/catch\(e\)\{reportWarning\("Camera import warning/);
  assert.match(code,/app\.project\.save\(file\)/);
});

test('Builder starts fresh instead of duplicating items in an open AE project',()=>{
  assert.match(code,/app\.project\.numItems\s*>\s*0/);
  assert.match(code,/app\.newProject\(\)/);
  assert.match(code,/Create a new project instead/);
  assert.match(code,/ATOMS TO AI — GENERATED PROJECT/);
  assert.match(code,/makeFolder\("01 — Linked GLB assets",projectRoot\)/);
  assert.match(code,/makeFolder\("02 — 3D scene workspaces",projectRoot\)/);
});

test('Model transforms and camera positions use the same world unit multiplier',()=>{
  assert.match(code,/var AE_PX_PER_WORLD_UNIT=18/);
  assert.match(code,/GLB_SCALE_PERCENT=AE_PX_PER_WORLD_UNIT\*100/);
  assert.match(code,/scale\.setValue\(\[GLB_SCALE_PERCENT,GLB_SCALE_PERCENT,GLB_SCALE_PERCENT\]\)/);
  assert.match(code,/a\.p\[0\]-sceneOffset\)\*AE_PX_PER_WORLD_UNIT/);
  assert.match(code,/addInspectionCamera\(inspection,modelId\)/);
  assert.match(code,/positionGLBLayer\(m,sceneNames/);
  assert.doesNotMatch(code,/\.setValue\(\[W\/2,H\/2,0\]\);\s*\}/);
});

test('Camera zoom is derived from source vertical field of view',()=>{
  assert.match(code,/property\("ADBE Camera Zoom"\)/);
  assert.match(code,/\(H\/2\)\/Math\.tan\(a\.fov\*Math\.PI\/360\)/);
  assert.match(code,/zoom\.setValueAtTime\(local,/);
});

test('Every run writes a new file rather than overwriting previous AEP work',()=>{
  assert.match(code,/ATOMS_TO_AI_EDITABLE_CLEAN_/);
  assert.match(code,/while\(file\.exists\)/);
  assert.doesNotMatch(code,/path\("AfterEffects\/ATOMS_TO_AI_EDITABLE\.aep"\)/);
});
