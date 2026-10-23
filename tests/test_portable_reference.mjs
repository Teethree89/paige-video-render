import test from 'node:test';
import assert from 'node:assert/strict';
import {zipFiles} from '../zip-utils.js';
import {makePortableProject,openPortableProject,readStoredZip} from '../portable-reference.js';
const project={
 title:'Mixed project',fps:30,duration:7,
 shots:[{id:'one',start:0,end:4},{id:'two',start:4,end:7}],
 camera:[{id:'c1',at:0,p:[0,0,5],t:[0,0,0],fov:50},
         {id:'c2',at:7,p:[0,0,1],t:[0,0,0],fov:50}],
 text:[{id:'t1',start:1,end:3,value:'Keep me'}],
 primitiveScenes:{schemaVersion:1,scenes:[]},
 referenceSequence:{version:1,items:[
 {id:'one',mediaId:'img',kind:'image',fileName:'art.png',fileSize:4,
  duration:4,sourceIn:0,sourceOut:0,fit:'contain'},
 {id:'two',mediaId:'vid',kind:'video',fileName:'clip.mp4',fileSize:6,
  duration:3,sourceIn:2,sourceOut:5,fit:'cover'}]}
};
const files={
 img:new File([new Uint8Array([137,80,78,71])],'art.png',{type:'image/png'}),
 vid:new File([new Uint8Array([0,0,0,24,102,116])],'clip.mp4',{type:'video/mp4'})
};
test('portable ZIP preserves timeline/geometry and relinks actual media bytes',async()=>{
 const archive=await makePortableProject(project,item=>files[item.mediaId]);
 const loaded=await openPortableProject(archive);
 assert.equal(loaded.timeline.text[0].value,'Keep me');
 assert.deepEqual(loaded.timeline.camera,project.camera);
 assert.deepEqual(loaded.media.map(m=>m.mediaId),['img','vid']);
 assert.equal(loaded.media[0].file.name,'art.png');
 assert.deepEqual([...new Uint8Array(await loaded.media[0].file.arrayBuffer())],
  [137,80,78,71]);
});
test('portable export refuses missing original source, not a JSON-only fallback',async()=>{
 await assert.rejects(makePortableProject(project,()=>null),/Relink original/);
});
test('ZIP reader rejects traversal, corruption, unexpected entries and compression',async()=>{
 const bad=zipFiles([{name:'../traversal.txt',data:'x'}]);
 const unsafe=await bad.arrayBuffer();
 assert.throws(()=>readStoredZip(unsafe),/Unsafe file path/);
 const good=zipFiles([{name:'paige-project.json',data:'{}'}]);
 const bytes=new Uint8Array(await good.arrayBuffer());
 bytes[45]^=0xff;
 assert.throws(()=>readStoredZip(bytes),/checksum|mismatch|header|ZIP/);
});
