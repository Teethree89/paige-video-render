import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const html=readFileSync(new URL('index.html',root),'utf8');
const code=readFileSync(new URL('primitive-editor.js',root),'utf8');
test('every ID accessed by primitive editor is a well-formed, present HTML ID',()=>{
  const actual=new Map();
  const re=/\bid=(["'])([^"'<>\s]+)\1/g;
  let match;
  while((match=re.exec(html))!==null)actual.set(match[2],(actual.get(match[2])||0)+1);
  const referenced=new Set([...code.matchAll(/\bel\(['"]([\w-]+)['"]\)/g)].map(m=>m[1]));
  for(const id of referenced){
    assert.equal(actual.get(id),1,'Missing or duplicate DOM ID: '+id);
  }
  assert.equal(actual.get('primitiveImport'),1);
  assert.doesNotMatch(html,/\bid="primitiveImport'/);
});

test('chapter outliner and mini spotlight mode controls are present and unique',()=>{
 for(const id of ['primitiveSceneOutliner','arrayEditSpotMode'])
   assert.equal(html.split('id="'+id+'"').length-1,1,id);
 assert.match(html,/role="tree" aria-label="Chapter hierarchy"/);
});
