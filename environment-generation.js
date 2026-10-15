import {validatePrimitiveDocument,ENVIRONMENT_LAYERS} from './primitive-schema.js';

// First video frame is the frame visible at the editor playhead. Two other
// timestamps supply chapter context without pushing out the user's choice.
export function referenceFrameTimes(shot,playhead,duration) {
  const start=Math.max(0,Number(shot.start));
  const end=Math.min(Number(duration),Number(shot.end));
  if(!Number.isFinite(start)||!Number.isFinite(end)||end-start<.15)
    throw Error('Invalid video chapter for frame capture');
  const clamp=x=>Math.min(end-.001,Math.max(start,x));
  const primary=clamp(Number.isFinite(playhead)?playhead:(start+end)/2);
  const times=[primary,start+(end-start)*.22,start+(end-start)*.78];
  return times.map(t=>+clamp(t).toFixed(3));
}

export const ENVIRONMENT_PASSES = Object.freeze([
  {id:'structures',label:'Buildings and structures'},
  {id:'ground',label:'Roads and terrain'},
  {id:'vegetation',label:'Trees and landscaping'},
  {id:'details',label:'Objects and infrastructure'},
]);

// Collect immutable, already validated per-pass geometry in one shared frame.
// No pass can replace geometry from an earlier pass or another chapter.
export function appendEnvironmentPass(shotId,objects,proposal,layer) {
  if(!ENVIRONMENT_LAYERS.includes(layer))throw Error('Unknown environment layer');
  if(!Array.isArray(objects)||objects.length>72)throw Error('Environment object budget exceeded');
  const parsed=validatePrimitiveDocument(proposal,[shotId]);
  if(parsed.scenes.length!==1||parsed.scenes[0].shotId!==shotId)
    throw Error('Layer generated for the wrong chapter');
  const additions=parsed.scenes[0].objects;
  if(additions.length>24||additions.some(x=>x.layer!==layer))
    throw Error('Worker returned an invalid environment layer');
  const known=new Set(objects.map(x=>x.id));
  if(additions.some(x=>known.has(x.id)))throw Error('Duplicate ID across environment passes');
  const combined=[...objects,...additions];
  if(combined.length>96)throw Error('Environment exceeds 96 shapes');
  return combined;
}
