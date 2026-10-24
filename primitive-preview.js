// Pure placement helpers: Gemini emits shot-local geometry (origin near 0),
// while authored shot cameras may target different absolute world coordinates.
// Never change saved primitive positions or cinematic camera keyframes.
// A bad saved scene must not replace the working project with the starter
// timeline. Keep the source intact for export/repair and clear partial meshes.
export function restoreSavedPrimitiveWorld(world,sequence,anchors={}) {
  const allowed=sequence.shots.map(shot=>shot.id);
  try{
    world.setDocument(sequence.primitiveScenes,allowed,anchors);
    return null;
  }catch(error){
    world.setDocument(undefined,allowed,anchors);
    return error;
  }
}

export function shotAnchorMap(sequence, cameraAt) {
  return Object.fromEntries(sequence.shots.map(shot => {
    // Camera Sync freezes the original scene anchor before retargeting keys.
    // Without this, camera-target changes shift regenerated geometry too,
    // creating feedback on every subsequent refresh/export.
    if(Array.isArray(shot.sceneAnchor)&&shot.sceneAnchor.length===3&&
      shot.sceneAnchor.every(n=>Number.isFinite(n)&&Math.abs(n)<=10000)){
      return [shot.id,[...shot.sceneAnchor]];
    }
    const at = Math.min(shot.end - 0.001, shot.start + 0.01);
    const target = cameraAt(Math.max(shot.start, at))?.t;
    const x = Number.isFinite(target?.[0]) ? target[0] : 0;
    const z = Number.isFinite(target?.[2]) ? target[2] : 0;
    // Keep source geometry's floor at Y=0 instead of raising it to eye height.
    return [shot.id, [x, 0, z]];
  }));
}

// Fit a spherical bound at any viewport aspect ratio. Returns the distance
// to the bounding center; caller can orbit around the center without touching
// the authored cinematic camera data.
export function fitDistance(radius, verticalFovDegrees, aspect) {
  const r = Math.max(0.7, Number.isFinite(radius) ? radius : 0.7);
  const vFov = Math.max(10, Math.min(100, verticalFovDegrees)) * Math.PI / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.25, aspect));
  return Math.max(3, 1.4 * r / Math.sin(Math.min(vFov, hFov) / 2));
}
