// Pure export layout shared by the browser ZIP builder and regression tests.
// Current timeline edits are copied; AE-only registration metadata does not
// get written into the live editor timeline.
export const AE_MODEL_IDS=['exterior','hall','pcb','atoms','laser','fiber','optics'];
const LEGACY_OFFSETS={exterior:0,hall:180,pcb:360,atoms:440,laser:560,fiber:690,optics:815};

export function modelIdForShot(shotId){
  const id=shotId==='hallreturn'?'hall':shotId==='finale'?'exterior':shotId;
  return AE_MODEL_IDS.includes(id)?id:null;
}

export function shotAssetPath(index){
  return 'assets/shots/shot-'+String(index+1).padStart(2,'0')+'.glb';
}

export function aeOriginForShot(shot,cameraAt){
  const id=modelIdForShot(shot.id);
  if(id!==null)return [LEGACY_OFFSETS[id],0,0];
  // Arbitrary imported videos do not have the seven original scene origins.
  // Align their editable primitives around the source camera's start target.
  const time=Math.max(shot.start,Math.min(shot.end-.001,shot.start+.01));
  const target=cameraAt(time)?.t||[0,0,0];
  return [Number(target[0])||0,0,Number(target[2])||0];
}

export function createAETimeline(sequence,cameraAt){
  const copy=JSON.parse(JSON.stringify(sequence));
  copy.shots=copy.shots.map(shot=>({...shot,aeOrigin:aeOriginForShot(shot,cameraAt)}));
  return copy;
}
