import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const html=readFileSync(new URL('index.html',root),'utf8');
const css=readFileSync(new URL('styles.css',root),'utf8');
const app=readFileSync(new URL('app.js',root),'utf8');
const primitives=readFileSync(new URL('primitive-editor.js',root),'utf8');
test('image reference playback has real image and metadata DOM controls',()=>{
  const ids=Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>[m[1],1]));
  for(const id of ['referenceVideo','referenceStill','referenceMediaStatus','showRef'])
    assert.equal(ids[id],1,'Missing '+id);
  assert.match(app,/if\(src\.kind==='image'\)/);
  assert.match(app,/image\.src=src\.url/);
  assert.match(app,/image\.hidden=!shown/);
  assert.match(css,/\.reference-card #referenceStill\[hidden\]\{display:none/);
});
test('GLB action does not silently reject lights-only scene',()=>{
  assert.match(primitives,/el\('primitiveExportGLB'\)\.disabled=objects\.length===0&&lightsList\.length===0/);
  assert.match(primitives,/const shot=getActiveShot\(\);if\(!shot\)return;/);
  const exportHandler=primitives.slice(primitives.indexOf("el('primitiveExportGLB').addEventListener"));
  assert.doesNotMatch(exportHandler,/world\.hasObjects\(shot\.id\)/);
  assert.match(exportHandler,/world\.getSceneForExport\(shot\.id\)/);
});
