// Imported source videos, keyed by the timeline's videoIntake.sourceId. Never
// uploaded. A blob URL cannot survive reload; persist bytes, then mint a fresh
// URL. Each file expires 48 hours after saving unless kept (local-media-store.js).
import {createLocalMediaStore} from './local-media-store.js';

const LEGACY_KEY='active'; // Before the clip library, only one video was stored.

export function createSingleVideoStore(factory=globalThis.indexedDB,options={}){
  const store=createLocalMediaStore({dbName:'paige-source-video-v1',storeName:'source',factory,...options});
  return {
    store,
    /** Resolves to {savedAt, expiresAt, keep}. */
    save(id,file){
      if(typeof id!=='string'||!id||id===LEGACY_KEY||!(file instanceof Blob))return Promise.reject(Error('Invalid source video'));
      return store.put(id,{id,file,name:file.name||'Source video',kind:'video'});
    },
    /** Only the video saved for exactly this sourceId; never an unrelated one. */
    async read(id){
      if(!id)return null;
      const entry=await store.get(id);
      if(entry)return entry;
      const legacy=await store.get(LEGACY_KEY);
      if(legacy?.id!==id)return null;
      // Move the legacy single slot to its own key (with a fresh 48 hours).
      await store.put(id,{...legacy});await store.delete(LEGACY_KEY);
      return await store.get(id);
    },
    purgeExpired:()=>store.purgeExpired(),
    clear:()=>store.clear(),
    clearUnkept:()=>store.clearUnkept()
  };
}

/** Reference Builder images and clips, keyed by their mediaId. */
export function createReferenceMediaStore(factory=globalThis.indexedDB,options={}){
  return createLocalMediaStore({dbName:'paige-reference-media-v1',storeName:'media',factory,...options});
}
