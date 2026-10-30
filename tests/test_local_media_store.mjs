import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalMediaStore,MEDIA_TTL_MS,formatExpiry} from '../local-media-store.js';
import {createSingleVideoStore,createReferenceMediaStore} from '../single-video-source.js';
import {fakeIndexedDB} from './fake-indexeddb.mjs';

const clock=start=>{let t=start;return {now:()=>t,advance:ms=>{t+=ms;}};};
const file=(text,name)=>Object.assign(new Blob([text],{type:'video/mp4'}),{name});

test('files are kept for 48 hours, then removed like an expiring cookie',async()=>{
 const time=clock(1_000_000),store=createLocalMediaStore({dbName:'t',storeName:'m',factory:fakeIndexedDB(),now:time.now});
 const saved=await store.put('a',{file:file('one','a.mp4'),name:'a.mp4',kind:'video'});
 assert.equal(saved.expiresAt-saved.savedAt,MEDIA_TTL_MS);
 time.advance(MEDIA_TTL_MS-60_000);
 const kept=await store.get('a');
 assert.equal(kept.name,'a.mp4');assert.equal(kept.kind,'video');assert.equal(await kept.file.text(),'one');
 assert.equal(kept.expiresAt,saved.expiresAt,'reading does not extend the expiry');
 time.advance(60_000);
 assert.equal(await store.get('a'),null,'gone exactly 48 hours after saving');
 time.advance(-MEDIA_TTL_MS);
 assert.equal(await store.get('a'),null,'an expired read deleted the stored bytes');
});

test('saving again restarts the 48 hours; purge removes only expired files',async()=>{
 const time=clock(0),store=createLocalMediaStore({dbName:'t',storeName:'m',factory:fakeIndexedDB(),now:time.now});
 await store.put('old',{file:file('x','old.png')});
 time.advance(40*3600_000);
 await store.put('new',{file:file('y','new.png')});
 time.advance(10*3600_000);
 assert.equal(await store.purgeExpired(),1);
 assert.equal(await store.get('old'),null);
 assert.equal((await store.get('new')).name,'new.png');
 await store.put('new',{file:file('z','new.png')});
 time.advance(47*3600_000);
 assert.equal(await (await store.get('new')).file.text(),'z','relinking restarts the 48 hours');
 await store.clear();
 assert.equal(await store.get('new'),null);
});

test('entries saved before expiry existed get a fresh 48 hours instead of vanishing',async()=>{
 const time=clock(5000),indexedDB=fakeIndexedDB(),single=createSingleVideoStore(indexedDB,{now:time.now});
 await single.clear(); // creates the database
 indexedDB.databases.get('paige-source-video-v1').get('source').set('active',{id:'src',file:file('v','legacy.mp4'),name:'legacy.mp4'});
 assert.equal(await single.purgeExpired(),0);
 const restored=await single.read('src');
 assert.equal(restored.name,'legacy.mp4');assert.equal(restored.expiresAt,5000+MEDIA_TTL_MS);
 assert.equal(await single.read('other-source'),null,'never attaches an unrelated cached video');
});

test('single video and reference media use separate stores',async()=>{
 const indexedDB=fakeIndexedDB(),single=createSingleVideoStore(indexedDB),refs=createReferenceMediaStore(indexedDB);
 const {expiresAt}=await single.save('src',file('v','clip.mp4'));
 assert.ok(expiresAt>Date.now());
 await refs.put('media_1',{file:file('i','still.png'),kind:'image'});
 await single.clear();
 assert.equal(await single.read('src'),null);
 assert.equal((await refs.get('media_1')).kind,'image');
 await assert.rejects(single.save('',file('v','x.mp4')),/Invalid source video/);
 await assert.rejects(refs.put('m',{file:'not a blob'}),/Invalid media file/);
});

test('missing IndexedDB fails softly',async()=>{
 const store=createLocalMediaStore({dbName:'t',storeName:'m',factory:null});
 await assert.rejects(store.put('a',{file:file('x','a.mp4')}),/unavailable/);
 assert.equal(await store.get('a'),null);
 assert.equal(await store.purgeExpired(),0);
 assert.match(formatExpiry(Date.UTC(2026,9,31,20,20),'en-US'),/\d:20/);
 assert.equal(formatExpiry(NaN),'');
});

test('kept files never expire, list and metadata updates leave the file alone',async()=>{
 const time=clock(0),store=createLocalMediaStore({dbName:'t',storeName:'m',factory:fakeIndexedDB(),now:time.now});
 await store.put('a',{file:file('aaa','a.mp4'),kind:'video'});
 await store.put('b',{file:file('bb','b.png'),kind:'image'});
 assert.equal(await store.setKept('a',true),null);
 assert.equal(await store.update('a',{thumbnail:'data:image/jpeg;base64,x',duration:3,file:'ignored',expiresAt:1}),true);
 time.advance(10*MEDIA_TTL_MS);
 const list=await store.list();
 assert.deepEqual(list.map(e=>[e.key,e.keep,e.expiresAt,e.thumbnail,e.duration,e.size]),[['a',true,null,'data:image/jpeg;base64,x',3,3]]);
 assert.equal(await list[0].file.text(),'aaa');
 await store.put('a',{file:file('new','a.mp4')});
 assert.equal((await store.get('a')).keep,true,'relinking a kept file keeps it');
 const back=await store.setKept('a',false);
 assert.equal(back,time.now()+MEDIA_TTL_MS,'un-keeping starts a fresh 48 hours');
 await assert.rejects(store.setKept('missing',true),/no longer saved/);
});

test('several imported videos are kept side by side; clear keeps the kept ones',async()=>{
 const indexedDB=fakeIndexedDB(),videos=createSingleVideoStore(indexedDB),refs=createReferenceMediaStore(indexedDB);
 await videos.save('one',file('1','one.mp4'));await videos.save('two',file('2','two.mp4'));
 assert.equal((await videos.read('one')).name,'one.mp4');assert.equal((await videos.read('two')).name,'two.mp4');
 await videos.store.setKept('one',true);
 await refs.put('m1',{file:file('i','i.png')});await refs.put('m2',{file:file('j','j.png')});await refs.setKept('m2',true);
 assert.equal(await videos.clearUnkept(),1);assert.equal(await refs.clearUnkept(),1);
 assert.deepEqual((await videos.store.list()).map(e=>e.key),['one']);
 assert.deepEqual((await refs.list()).map(e=>e.key),['m2']);
 await assert.rejects(videos.save('active',file('x','x.mp4')),/Invalid source video/);
});
