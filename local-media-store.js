// Expiring browser-only media storage (IndexedDB). Original files stay on this
// device: never uploaded, never sent to a provider. Every entry expires a fixed
// 48 hours after it was saved, like a cookie; reading it does not extend it.
// An entry marked `keep` (Clip library "Keep indefinitely") never expires.
export const MEDIA_TTL_MS=48*60*60*1000;
export const MEDIA_TTL_HOURS=MEDIA_TTL_MS/3600000;
const META_FIELDS=new Set(['thumbnail','duration','width','height']);

/** One IndexedDB transaction; resolves with box.value once it completes. */
export function idbTransaction(factory,dbName,storeName,mode,action,timeoutMs=5000){
 return new Promise((resolve,reject)=>{
   if(!factory){reject(Error('Local media storage is unavailable'));return;}
   let request;
   try{request=factory.open(dbName,1);}catch(error){reject(error);return;}
   let expired=false;
   const timer=setTimeout(()=>{expired=true;reject(Error('Local media storage timed out'));},timeoutMs);
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
}

/**
 * @param {{dbName:string,storeName:string,factory?:IDBFactory,now?:()=>number,ttlMs?:number}} options
 */
export function createLocalMediaStore({dbName,storeName,factory=globalThis.indexedDB,now=()=>Date.now(),ttlMs=MEDIA_TTL_MS}){
 let queue=Promise.resolve();
 // Serialize operations so a pending write cannot resurrect cleared data.
 const run=task=>{const result=queue.then(task);queue=result.catch(()=>{});return result;};
 const tx=(mode,action)=>run(()=>idbTransaction(factory,dbName,storeName,mode,action));
 const isExpired=entry=>entry?.keep!==true&&!(Number.isFinite(entry?.expiresAt)&&entry.expiresAt>now());
 // Entries saved before expiry existed get a fresh 48 hours instead of vanishing.
 const legacy=entry=>entry&&entry.file instanceof Blob&&entry.keep!==true&&!Number.isFinite(entry.expiresAt);
 const valid=entry=>entry&&entry.file instanceof Blob;
 // Read one entry inside a transaction, upgrading legacy entries and dropping expired ones.
 const read=(store,key,done)=>{
   const request=store.get(key);
   request.onsuccess=()=>{
     let entry=request.result;
     if(legacy(entry)){entry={...entry,savedAt:now(),expiresAt:now()+ttlMs};store.put(entry,key);}
     if(!valid(entry))return done(null);
     if(isExpired(entry)){store.delete(key);return done(null);}
     done(entry);
   };
 };
 return {
   ttlMs,
   /** Save (or replace) one file; a kept entry stays kept. Resolves to {savedAt, expiresAt, keep}. */
   put(key,{file,name,...meta}){
     if(typeof key!=='string'||!key||!(file instanceof Blob))return Promise.reject(Error('Invalid media file'));
     const savedAt=now();
     return tx('readwrite',(store,box)=>{
       const request=store.get(key);
       request.onsuccess=()=>{
         const keep=request.result?.keep===true,expiresAt=keep?null:savedAt+ttlMs;
         const clean=Object.fromEntries(Object.entries(meta).filter(([k])=>!['keep','expiresAt','savedAt'].includes(k)));
         store.put({...clean,file,name:String(name||file.name||'Media'),size:file.size,type:file.type||'',
           savedAt,expiresAt,keep},key);
         box.value={savedAt,expiresAt,keep};
       };
     });
   },
   /** The saved entry, or null when missing or expired (expired entries are deleted). */
   get(key){
     if(typeof key!=='string'||!key||!factory)return Promise.resolve(null);
     return tx('readwrite',(store,box)=>read(store,key,entry=>{box.value=entry;})).then(v=>v||null);
   },
   /** Every live entry with its key (expired ones are deleted on the way). */
   list(){
     if(!factory)return Promise.resolve([]);
     return tx('readwrite',(store,box)=>{
       box.value=[];
       const cursor=store.openCursor();
       cursor.onsuccess=()=>{
         const c=cursor.result;if(!c)return;
         let entry=c.value;
         if(legacy(entry)){entry={...entry,savedAt:now(),expiresAt:now()+ttlMs};store.put(entry,c.key);}
         if(!valid(entry)||isExpired(entry))c.delete();else box.value.push({key:c.key,...entry});
         c.continue();
       };
     }).then(v=>(v||[]).sort((a,b)=>b.savedAt-a.savedAt));
   },
   /** Patch display metadata (thumbnail, duration, size) without touching the file or expiry. */
   update(key,patch){
     const clean=Object.fromEntries(Object.entries(patch||{}).filter(([k])=>META_FIELDS.has(k)));
     return tx('readwrite',(store,box)=>read(store,key,entry=>{
       if(!entry)return;const next={...entry,...clean};store.put(next,key);box.value=true;
     })).then(v=>!!v);
   },
   /** Keep indefinitely, or return to a fresh 48 hours from now. Resolves to the new expiry (null = kept). */
   setKept(key,keep){
     return tx('readwrite',(store,box)=>read(store,key,entry=>{
       if(!entry){box.value=undefined;return;}
       const expiresAt=keep?null:now()+ttlMs;
       store.put({...entry,keep:!!keep,expiresAt},key);box.value=expiresAt;
     })).then(v=>{if(v===undefined)throw Error('This file is no longer saved in the browser');return v;});
   },
   delete(key){return tx('readwrite',store=>store.delete(key));},
   clear(){if(!factory)return Promise.resolve();return tx('readwrite',store=>store.clear());},
   /** Clear workspace: remove everything except files the user chose to keep. */
   clearUnkept(){
     if(!factory)return Promise.resolve(0);
     return tx('readwrite',(store,box)=>{
       box.value=0;const cursor=store.openCursor();
       cursor.onsuccess=()=>{const c=cursor.result;if(!c)return;if(c.value?.keep!==true){c.delete();box.value++;}c.continue();};
     });
   },
   /** Delete every expired entry; resolves to how many were removed. */
   purgeExpired(){
     if(!factory)return Promise.resolve(0);
     return tx('readwrite',(store,box)=>{
       box.value=0;
       const cursor=store.openCursor();
       cursor.onsuccess=()=>{
         const c=cursor.result;if(!c)return;
         if(!legacy(c.value)&&isExpired(c.value)){c.delete();box.value++;}
         c.continue();
       };
     });
   },
 };
}

/** "Thu 8:20 PM" style local time for expiry notes. */
export function formatExpiry(expiresAt,locale=undefined){
 if(!Number.isFinite(expiresAt))return '';
 return new Date(expiresAt).toLocaleString(locale,{weekday:'short',hour:'numeric',minute:'2-digit'});
}
