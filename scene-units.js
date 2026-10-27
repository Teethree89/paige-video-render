// Authoritative Atoms to AI render-space scale.
// One Three.js scene unit equals one meter. Enlarged technical illustrations
// remain intentionally stylized; no imported geometry is silently resized.
export const METERS_PER_SCENE_UNIT=1;
export const MILLIMETERS_PER_METER=1000;
export function millimetersToSceneUnits(millimeters){
  if(typeof millimeters!=='number'||!Number.isFinite(millimeters)||millimeters<0)
    throw new RangeError('millimeters must be a finite nonnegative number');
  return millimeters/(MILLIMETERS_PER_METER*METERS_PER_SCENE_UNIT);
}
export const FAKE_SPOTLIGHT_DECAL_LIFT_MM=10;
export const FAKE_SPOTLIGHT_OCCLUDED_LIFT_MM=8;
