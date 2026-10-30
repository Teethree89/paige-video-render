import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalMediaStore,MEDIA_TTL_MS,formatExpiry} from '../local-media-store.js';
import {createSingleVideoStore,createReferenceMediaStore} from '../single-video-source.js';

// Minimal asynchronous IndexedDB stand-in: open/upgrade, one object store per
// database, put/get/delete/clear and cursors, with transaction completion.
function fakeIndexedDB(){
 const databases=new Map();
 const later=fn=>setTimeout(fn,0);
 return {databases,open(name){
   const request={};
   later(()=>{
     const fresh=!databases.has(name);
     if(fresh)databases.set(name,new Map());
     const stores=databases.get(name);
     const db={createObjectStore:store=>{stores.set(store,new Map());},close(){},
       transaction(storeName){
         let pending=0,done=false;const tx={};
         const settle=()=>later(()=>{if(!pending&&!done){done=true;tx.oncomplete?.();}});
         const req=fn=>{const r={};pending++;later(()=>{r.result=fn();r.onsuccess?.();pending--;settle();});return r;};
         const data=stores.get(storeName);
         tx.objectStore=()=>({
           put:(value,key)=>req(()=>{data.set(key,value);return key;}),
           get:key=>req(()=>data.get(key)),
           delete:key=>req(()=>{data.delete(key);}),
           clear:()=>req(()=>{data.clear();}),
           openCursor(){
             const keys=[...data.keys()],r={};let i=0;pending++;
             const step=()=>later(()=>{
               if(i>=keys.length){r.result=null;r.onsuccess?.();pending--;settle();return;}
               const key=keys[i++];
               r.result={key,value:data.get(key),delete:()=>data.delete(key),continue:step};
               r.onsuccess?.();
             });
             step();return r;
           }
         });
         settle();return tx;
       }};
     request.result=db;
     if(fresh)request.onupgradeneeded?.();
     request.onsuccess?.();
   });
   return request;
 }};
}
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
