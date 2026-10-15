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
  assert.doesNotMatch(code,/\+\s*(?:err|renderError|e)\b/);
  assert.doesNotMatch(code,/(?:String\s*\(\s*(?:err|renderError|e)\s*\)|(?:err|renderError|e)\.toString\s*\(\))/);
});

test('Avoid unsupported ES3 Array.indexOf and retain camera failure isolation',()=>{
  assert.match(code,/function indexIn\(list,value\)/);
  assert.doesNotMatch(code,/fileIds\.indexOf\(/);
  assert.match(code,/try\{addCameraKeys\(workspace,seq,shot,offsets\[sid\]\);\}/);
  assert.match(code,/catch\(e\)\{reportWarning\("Camera import warning/);
  assert.match(code,/app\.project\.save\(file\)/);
});
