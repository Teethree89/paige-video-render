// One local source file, keyed by the timeline's sourceId. Never uploaded.
// A blob URL cannot survive reload; persist bytes, then mint a fresh URL.
// The bytes expire 48 hours after saving (see local-media-store.js).
import {createLocalMediaStore} from './local-media-store.js';

export function createSingleVideoStore(factory=globalThis.indexedDB,options={}){
  const store=createLocalMediaStore({dbName:'paige-source-video-v1',storeName:'source',factory,...options});
  return {
    /** Resolves to {savedAt, expiresAt}. */
    save(id,file){
      if(typeof id!=='string'||!id||!(file instanceof Blob))return Promise.reject(Error('Invalid source video'));
      return store.put('active',{id,file,name:file.name||'Source video'});
    },
    async read(id){
      if(!id)return null;
      const entry=await store.get('active');
      return entry?.id===id?entry:null;
    },
    purgeExpired:()=>store.purgeExpired(),
    clear:()=>store.clear()
  };
}

/** Reference Builder images and clips, keyed by their mediaId. */
export function createReferenceMediaStore(factory=globalThis.indexedDB,options={}){
  return createLocalMediaStore({dbName:'paige-reference-media-v1',storeName:'media',factory,...options});
}
