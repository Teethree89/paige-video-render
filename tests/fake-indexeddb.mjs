// Minimal asynchronous IndexedDB stand-in for Node tests: open/upgrade, one
// object store per database, put/get/delete/clear and cursors, with
// transaction completion after the last request.
export function fakeIndexedDB(){
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
