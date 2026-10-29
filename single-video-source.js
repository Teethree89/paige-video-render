// One local source file, keyed by the timeline's sourceId. Never uploaded.
// A blob URL cannot survive reload; persist bytes, then mint a fresh URL.
export function createSingleVideoStore(factory=globalThis.indexedDB){
  let queue=Promise.resolve();
  const run=task=>{
    const result=queue.then(task);
    queue=result.catch(()=>{});
    return result;
  };
  const transaction=(mode,action)=>new Promise((resolve,reject)=>{
    if(!factory){reject(Error('Local video storage is unavailable'));return;}
    const request=factory.open('paige-source-video-v1',1);
    let expired=false;
    const timer=setTimeout(()=>{expired=true;reject(Error('Local video storage timed out'));},5000);
    const fail=error=>{expired=true;clearTimeout(timer);reject(error||Error('Local video storage failed'));};
    request.onupgradeneeded=()=>request.result.createObjectStore('source');
    request.onerror=()=>fail(request.error);
    request.onblocked=()=>fail(Error('Local video storage is blocked'));
    request.onsuccess=()=>{
      clearTimeout(timer);
      const db=request.result;
      if(expired){db.close();return;}
      try{
        const tx=db.transaction('source',mode),operation=action(tx.objectStore('source'));
        tx.oncomplete=()=>{db.close();resolve(operation.result);};
        tx.onabort=()=>{db.close();fail(tx.error);};
        tx.onerror=()=>{db.close();fail(tx.error);};
      }catch(error){db.close();fail(error);}
    };
  });
  return {
    save(id,file){
      if(typeof id!=='string'||!id||!(file instanceof Blob))return Promise.reject(Error('Invalid source video'));
      return run(()=>transaction('readwrite',store=>store.put({id,file,name:file.name||'Source video'},'active')));
    },
    read(id){
      if(!id||!factory)return Promise.resolve(null);
      return run(async()=>{
        const entry=await transaction('readonly',store=>store.get('active'));
        return entry?.id===id&&entry.file instanceof Blob?entry:null;
      });
    },
    clear(){
      if(!factory)return Promise.resolve();
      // Serialize with saves so a pending write cannot resurrect cleared data.
      return run(()=>transaction('readwrite',store=>store.clear()));
    }
  };
}
