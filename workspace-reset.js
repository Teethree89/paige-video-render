// Workspace content is separate from reusable assembly assets and editor preferences.
export const EMPTY_WORKSPACE_KEY='paige-empty-workspace-v1';
export const SEQUENCE_STORAGE_KEY='atoms-ai-sequence-v1';
export const ASSEMBLY_LIBRARY_KEY='paige-assembly-library-v1';

export function createEmptyWorkspace(){
  // Keep a valid timeline so existing editing, rendering and camera code can
  // initialize without displaying the repository's example footage or models.
  return {
    title:'Untitled workspace',duration:10,fps:30,
    shots:[{id:'workspace_001',start:0,end:10,name:'Empty scene',
      title:'EMPTY WORKSPACE',tone:'teal'}],
    camera:[
      {id:'workspace_camera_start',at:0,p:[0,3,18],t:[0,2,0],fov:55,cut:false},
      {id:'workspace_camera_end',at:9.96,p:[0,3,18],t:[0,2,0],fov:55,cut:false}
    ],
    text:[]
  };
}

// Do not use localStorage.clear(): this origin also holds the reusable
// assembly library and non-project preferences.
export function clearWorkspaceStorage(storage){
  for(const key of [SEQUENCE_STORAGE_KEY,'paige-studio-workspace-v1','paige-inspector-tab-v2'])
    storage.removeItem(key);
  // A marker is necessary: absence of a saved sequence otherwise boots the
  // bundled Atoms to AI example on every refresh.
  storage.setItem(EMPTY_WORKSPACE_KEY,'1');
}
export function markWorkspaceSaved(storage){
  storage.removeItem(EMPTY_WORKSPACE_KEY);
}

// Server records are limited to the authenticated PHP session and its
// resumable Argon worker job. Imported video media is never uploaded there.
export async function clearServerWorkspace(fetcher=fetch){
  const url='./scene-proxy.php';
  const response=await fetcher(url,{credentials:'same-origin',cache:'no-store'});
  const state=await response.json().catch(()=>null);
  if(!response.ok||state?.ok!==true||typeof state.authenticated!=='boolean')
    throw Error(state?.error||'Cannot verify the private editor server');
  if(!state.authenticated)return {serverCleared:false,signedOut:true};
  if(typeof state.csrf!=='string'||!state.csrf)throw Error('Missing private editor session token');
  const result=await fetcher(url,{method:'POST',credentials:'same-origin',cache:'no-store',
    headers:{'Content-Type':'application/json','X-Paige-Client':'SceneStudio'},
    body:JSON.stringify({action:'workspace_clear',csrf:state.csrf})});
  const body=await result.json().catch(()=>null);
  if(!result.ok||body?.ok!==true||body.cleared!==true)
    throw Error(body?.error||'Server workspace cleanup could not be verified');
  return {serverCleared:true,signedOut:false};
}
