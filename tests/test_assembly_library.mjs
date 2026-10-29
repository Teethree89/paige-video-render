import test from 'node:test';
import assert from 'node:assert/strict';
import {makePrimitive} from '../primitive-schema.js';
import {makeAssemblyFile,makeAssemblyPack,parseAssemblyFile,
  readAssemblyLibrary,addAssembliesToLibrary,removeAssemblyFromLibrary} from '../assembly-library.js';

const lamp=()=>{
  const item=makePrimitive('group','street_lamp',[2,9,4]);
  item.repeat={count:[1,1,5],spacing:[0,0,12]};
  item.arrayParts={objects:[makePrimitive('cylinder','pole',[0,-4,0])],
    lights:[{id:'beam',name:'Beam',type:'spot',color:'#ffeeaa',intensity:200,
      position:[0,0,0],target:[0,-5,0],distance:20,angle:.65,penumbra:.3,
      fakeConeOpacity:.8}],
    order:['object:pole','light:beam']};
  return item;
};
const storage=()=>{
  const map=new Map();
  return {getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value)};
};
test('portable assembly JSON round-trip preserves grouped meshes, spotlights and array layout',()=>{
  const first=makeAssemblyFile(lamp());
  assert.equal(first.format,'paige-array-assembly');
  const [second]=parseAssemblyFile(JSON.parse(JSON.stringify(first)));
  assert.deepEqual(second,first.assembly);
  assert.equal(second.arrayParts.lights[0].fakeConeOpacity,.8);
  assert.equal(second.repeat.count[2],5);
});
test('chapter pack contains only arrays/groups and can fill the local library',()=>{
  const instance=lamp();
  const loose=makePrimitive('box','loose',[0,1,0]);
  const pack=makeAssemblyPack({objects:[instance,loose]});
  assert.equal(pack.assets.length,1);
  const read=parseAssemblyFile(pack);
  assert.equal(read.length,1);
  const local=storage();
  assert.equal(addAssembliesToLibrary(local,pack),1);
  assert.equal(addAssembliesToLibrary(local,pack),0,'identical assets are not duplicated');
  assert.equal(readAssemblyLibrary(local).length,1);
  const id=readAssemblyLibrary(local)[0].id;
  removeAssemblyFromLibrary(local,id);
  assert.deepEqual(readAssemblyLibrary(local),[]);
});
test('import rejects executable or invalid legacy payloads before writing the library',()=>{
  const local=storage();
  assert.throws(()=>parseAssemblyFile({format:'paige-array-assembly',version:2,assembly:lamp()}));
  assert.throws(()=>addAssembliesToLibrary(local,{format:'bad',version:1}));
  const unsafe=makeAssemblyFile(lamp());unsafe.assembly.arrayParts.lights[0].intensity=Infinity;
  assert.throws(()=>parseAssemblyFile(unsafe));
  assert.deepEqual(readAssemblyLibrary(local),[]);
});
