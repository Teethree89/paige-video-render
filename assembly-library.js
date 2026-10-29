import {validatePrimitiveDocument} from './primitive-schema.js';

// Portable single-assembly and pack files. Geometry and light specifications
// only; never executable code, remote assets, camera keys or chapter effects.
export const ASSEMBLY_FORMAT='paige-array-assembly';
export const PACK_FORMAT='paige-array-assembly-pack';
export const ASSEMBLY_LIBRARY_KEY='paige-assembly-library-v1';
const clone=v=>structuredClone(v);
const validateAsset=raw=>{
  const source=raw?.assembly||raw;
  const item=validatePrimitiveDocument({schemaVersion:1,scenes:[
    {shotId:'assembly_asset',objects:[source]}
  ]},['assembly_asset']).scenes[0].objects[0];
  return clone(item);
};
export function makeAssemblyFile(item){
  return {format:ASSEMBLY_FORMAT,version:1,assembly:validateAsset(item)};
}
export function makeAssemblyPack(scene){
  const assets=(scene?.objects||[]).filter(o=>o.repeat||o.arrayParts)
    .map(item=>makeAssemblyFile(item));
  return {format:PACK_FORMAT,version:1,assets};
}
export function parseAssemblyFile(raw){
  if(!raw||raw.version!==1)throw Error('Not a supported assembly JSON (version 1 required).');
  const entries=raw.format===ASSEMBLY_FORMAT?[raw]:
    raw.format===PACK_FORMAT&&Array.isArray(raw.assets)?raw.assets:null;
  if(!entries||!entries.length||entries.length>240)
    throw Error('Choose an assembly or a nonempty assembly-pack JSON.');
  return entries.map(entry=>{
    if(entry.format!==ASSEMBLY_FORMAT||entry.version!==1)
      throw Error('Assembly-pack contains an unsupported asset.');
    return validateAsset(entry);
  });
}
export function readAssemblyLibrary(storage){
  try{
    const raw=JSON.parse(storage.getItem(ASSEMBLY_LIBRARY_KEY)||'[]');
    if(!Array.isArray(raw))return [];
    return raw.filter(x=>x&&typeof x.id==='string'&&x.asset&&typeof x.label==='string')
      .slice(0,100);
  }catch{return [];}
}
export function addAssembliesToLibrary(storage,raw){
  const assets=Array.isArray(raw)?raw:parseAssemblyFile(raw);
  const current=readAssemblyLibrary(storage);
  const next=[...current];
  for(const asset of assets){
    const item=validateAsset(asset);
    const signature=JSON.stringify(item);
    if(next.some(entry=>JSON.stringify(entry.asset)===signature))continue;
    next.unshift({id:'asset_'+Date.now()+'_'+Math.random().toString(36).slice(2,10),
      label:item.name,asset:item});
  }
  if(next.length>100)throw Error('Assembly library supports 100 saved assets; remove older entries.');
  storage.setItem(ASSEMBLY_LIBRARY_KEY,JSON.stringify(next));
  return next.length-current.length;
}
export function removeAssemblyFromLibrary(storage,id){
  const next=readAssemblyLibrary(storage).filter(x=>x.id!==id);
  storage.setItem(ASSEMBLY_LIBRARY_KEY,JSON.stringify(next));
}
