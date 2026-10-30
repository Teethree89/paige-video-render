// Expiring browser-only media storage (IndexedDB). Original files stay on this
// device: never uploaded, never sent to a provider. Every entry expires a fixed
// 48 hours after it was saved, like a cookie; reading it does not extend it.
export const MEDIA_TTL_MS=48*60*60*1000;
export const MEDIA_TTL_HOURS=MEDIA_TTL_MS/3600000;

/**
 * @param {{dbName:string,storeName:string,factory?:IDBFactory,now?:()=>number,ttlMs?:number}} options
 */
export function createLocalMediaStore({dbName,storeName,factory=globalThis.indexedDB,now=()=>Date.now(),ttlMs=MEDIA_TTL_MS}){
 let queue=Promise.resolve();
 // Serialize operations so a pending write cannot resurrect cleared data.
 const run=task=>{const result=queue.then(task);queue=result.catch(()=>{});return result;};
 const transaction=(mode,action)=>new Promise((resolve,reject)=>{
   if(!factory){reject(Error('Local media storage is unavailable'));return;}
   let request;
   try{request=factory.open(dbName,1);}catch(error){reject(error);return;}
   let expired=false;
   const timer=setTimeout(()=>{expired=true;reject(Error('Local media storage timed out'));},5000);
   const fail=error=>{expired=true;clearTimeout(timer);reject(error||Error('Local media storage failed'));};
   request.onupgradeneeded=()=>request.result.createObjectStore(storeName);
   request.onerror=()=>fail(request.error);
   request.onblocked=()=>fail(Error('Local media storage is blocked'));
   request.onsuccess=()=>{
     clearTimeout(timer);
     const db=request.result;
     if(expired){db.close();return;}
     try{
       const tx=db.transaction(storeName,mode),box={};
       action(tx.objectStore(storeName),box);
       tx.oncomplete=()=>{db.close();resolve(box.value);};
       tx.onabort=()=>{db.close();fail(tx.error);};
       tx.onerror=()=>{db.close();fail(tx.error);};
     }catch(error){db.close();fail(error);}
   };
 });
 const isExpired=entry=>!(Number.isFinite(entry?.expiresAt)&&entry.expiresAt>now());
 // Entries saved before expiry existed get a fresh 48 hours instead of vanishing.
 const legacy=entry=>entry&&entry.file instanceof Blob&&!Number.isFinite(entry.expiresAt);
 return {
   ttlMs,
   /** Save (or replace) one file; returns {savedAt, expiresAt}. */
   put(key,{file,name,...meta}){
     if(typeof key!=='string'||!key||!(file instanceof Blob))return Promise.reject(Error('Invalid media file'));
     const savedAt=now(),expiresAt=savedAt+ttlMs;
     const entry={...meta,file,name:String(name||file.name||'Media'),savedAt,expiresAt};
     return run(()=>transaction('readwrite',store=>store.put(entry,key))).then(()=>({savedAt,expiresAt}));
   },
   /** The saved entry, or null when missing or expired (expired entries are deleted). */
   get(key){
     if(typeof key!=='string'||!key||!factory)return Promise.resolve(null);
     return run(()=>transaction('readwrite',(store,box)=>{
       const request=store.get(key);
       request.onsuccess=()=>{
         let entry=request.result;
         if(legacy(entry)){entry={...entry,savedAt:now(),expiresAt:now()+ttlMs};store.put(entry,key);}
         if(!entry||!(entry.file instanceof Blob))return;
         if(isExpired(entry)){store.delete(key);return;}
         box.value=entry;
       };
     })).then(value=>value||null);
   },
   delete(key){return run(()=>transaction('readwrite',store=>store.delete(key)));},
   clear(){if(!factory)return Promise.resolve();return run(()=>transaction('readwrite',store=>store.clear()));},
   /** Delete every expired entry; resolves to how many were removed. */
   purgeExpired(){
     if(!factory)return Promise.resolve(0);
     return run(()=>transaction('readwrite',(store,box)=>{
       box.value=0;
       const cursor=store.openCursor();
       cursor.onsuccess=()=>{
         const c=cursor.result;if(!c)return;
         if(!legacy(c.value)&&isExpired(c.value)){c.delete();box.value++;}
         c.continue();
       };
     }));
   },
 };
}

/** "Thu 8:20 PM" style local time for expiry notes. */
export function formatExpiry(expiresAt,locale=undefined){
 if(!Number.isFinite(expiresAt))return '';
 return new Date(expiresAt).toLocaleString(locale,{weekday:'short',hour:'numeric',minute:'2-digit'});
}
