// Portable Paige project media ZIP. Only our own uncompressed ZIP format is
// imported: finite, CRC-checked, bounded and free of traversal/remote URLs.
import {zipFiles} from './zip-utils.js';
import {validateReferenceItems} from './reference-sequence.js';
import {checkTimeline} from './timeline-operations.js';
const te=new TextEncoder(),td=new TextDecoder();
const MAX_TOTAL=256*1024*1024,MAX_FILES=82;
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?(c>>>1)^0xedb88320:c>>>1;return c>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;}
const mediaExt={image:'png',video:'mp4'};
const allowedType=type=>/^(image\/(png|jpeg|webp)|video\/(mp4|webm|quicktime))$/i.test(type);
function safeMediaId(id){if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(id))
 throw Error('Invalid media ID in project bundle');return id;}
function safeName(name){
 if(typeof name!=='string'||name.length>210||!/^media\/[A-Za-z0-9_-]{1,80}\.(png|jpg|jpeg|webp|mp4|mov|webm)$/i.test(name))
 throw Error('Unsafe file path in project bundle');
 return name;
}
function ext(file,kind){
 const e=String(file?.name||'').split('.').pop().toLowerCase();
 if(kind==='image'&&['png','jpg','jpeg','webp'].includes(e))return e;
 if(kind==='video'&&['mp4','mov','webm'].includes(e))return e;
 return mediaExt[kind];
}
export async function makePortableProject(timeline,getFile){
 checkTimeline(timeline);
 const items=validateReferenceItems(timeline.referenceSequence?.items);
 if(items.length!==timeline.shots.length)throw Error('Reference metadata does not match chapter count');
 const assets=new Map(),entries=[];
 let total=0;
 for(const item of items){
  if(assets.has(item.mediaId))continue;
  const file=await getFile(item);
  if(!(file instanceof Blob)||!file.size||!allowedType(file.type))
   throw Error('Relink original '+item.fileName+' before exporting. Unsupported or missing media.');
  total+=file.size;
  if(total>MAX_TOTAL)throw Error('Portable project exceeds the 256 MB safe-memory limit. Use JSON and original media for large projects.');
  const path=safeName('media/'+safeMediaId(item.mediaId)+'.'+ext(file,item.kind));
  const bytes=new Uint8Array(await file.arrayBuffer());
  entries.push({name:path,data:bytes});
  assets.set(item.mediaId,{mediaId:item.mediaId,path,mime:file.type,
    size:file.size,originalName:item.fileName,kind:item.kind,crc:crc32(bytes)});
 }
 const manifest={format:'paige-portable-reference',version:1,
   timeline:structuredClone(timeline),media:[...assets.values()]};
 const json=JSON.stringify(manifest);
 if(json.length>2*1024*1024)throw Error('Reference manifest exceeds safety limits');
 const zipped=zipFiles([{name:'paige-project.json',data:json},...entries]);
 return zipped;
}
export function readStoredZip(buffer){
 const bytes=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer);
 if(bytes.length>MAX_TOTAL+3*1024*1024)throw Error('Portable ZIP exceeds 256 MB file budget');
 if(bytes.length<22)throw Error('Incomplete ZIP');
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 // Our ZIP writer produces an EOCD without comment; locate it defensively.
 let tail=-1;
 for(let at=bytes.length-22;at>=Math.max(0,bytes.length-65557);at--){
  if(v.getUint32(at,true)===0x06054b50){tail=at;break;}
 }
 if(tail<0)throw Error('ZIP directory not found');
 if(v.getUint16(tail+20,true)!==0)throw Error('ZIP comments are unsupported');
 const count=v.getUint16(tail+10,true),offset=v.getUint32(tail+16,true),
   centralSize=v.getUint32(tail+12,true);
 if(count<1||count>MAX_FILES||offset+centralSize>tail)
   throw Error('Invalid ZIP entry count or directory');
 const files=new Map();
 let cursor=offset,total=0;
 for(let i=0;i<count;i++){
  if(cursor+46>tail||v.getUint32(cursor,true)!==0x02014b50)
   throw Error('Invalid central ZIP header');
  const method=v.getUint16(cursor+10,true),flags=v.getUint16(cursor+8,true),
    checksum=v.getUint32(cursor+16,true),size=v.getUint32(cursor+20,true),
    uncompressed=v.getUint32(cursor+24,true),nameSize=v.getUint16(cursor+28,true),
    extra=v.getUint16(cursor+30,true),comment=v.getUint16(cursor+32,true),
    disk=v.getUint16(cursor+34,true),localOffset=v.getUint32(cursor+42,true);
  if(method!==0||flags&1||size!==uncompressed||disk!==0||
     size>MAX_TOTAL||nameSize<1||nameSize>220)
    throw Error('Only bounded, unencrypted, stored ZIP entries are supported');
  const next=cursor+46+nameSize+extra+comment;
  if(next>tail)throw Error('ZIP central header truncated');
  const name=td.decode(bytes.subarray(cursor+46,cursor+46+nameSize));
  if(name!=='paige-project.json')safeName(name);
  if(files.has(name))throw Error('Duplicate ZIP entry');
  if(localOffset+30>offset||v.getUint32(localOffset,true)!==0x04034b50)
    throw Error('ZIP local header invalid');
  const lName=v.getUint16(localOffset+26,true),lExtra=v.getUint16(localOffset+28,true),
    start=localOffset+30+lName+lExtra,end=start+size;
  if(end>offset)throw Error('ZIP entry outside payload');
  const localName=td.decode(bytes.subarray(localOffset+30,localOffset+30+lName));
  if(localName!==name)throw Error('ZIP name mismatch');
  const part=bytes.subarray(start,end);
  if(crc32(part)!==checksum)throw Error('ZIP file checksum mismatch');
  total+=size;if(total>MAX_TOTAL)throw Error('Portable media total exceeds 256 MB');
  files.set(name,part);cursor=next;
 }
 if(cursor!==offset+centralSize)throw Error('ZIP directory length mismatch');
 return files;
}
export async function openPortableProject(blob){
 if(!(blob instanceof Blob)||blob.size>MAX_TOTAL+3*1024*1024)
  throw Error('Portable project must be a ZIP under 259 MB');
 const files=readStoredZip(await blob.arrayBuffer());
 const meta=files.get('paige-project.json');
 if(!meta||meta.length>2*1024*1024)throw Error('Missing or oversized project manifest');
 let manifest;
 try{manifest=JSON.parse(td.decode(meta));}catch{throw Error('Invalid project JSON');}
 if(manifest.format!=='paige-portable-reference'||manifest.version!==1)
  throw Error('Not a supported Paige portable reference project');
 const timeline=checkTimeline(manifest.timeline);
 const items=validateReferenceItems(timeline.referenceSequence?.items);
 const declared=manifest.media;
 if(!Array.isArray(declared)||declared.length>80)throw Error('Invalid media index');
 const byId=new Map(declared.map(a=>[a.mediaId,a]));
 if(byId.size!==declared.length)throw Error('Duplicate media IDs');
 if(files.size!==declared.length+1)throw Error('Unexpected media files in ZIP');
 const imported=[];
 for(const [id,descriptor] of byId){
  safeMediaId(id);
  const fileName=safeName(descriptor.path);
  const data=files.get(fileName);
  if(!data||data.length!==descriptor.size||crc32(data)!==descriptor.crc||
    !allowedType(descriptor.mime)||!['image','video'].includes(descriptor.kind))
    throw Error('Missing, altered or unsupported media in ZIP');
  const linked=items.filter(i=>i.mediaId===id);
  if(!linked.length||linked.some(i=>i.kind!==descriptor.kind))
    throw Error('Media manifest does not match reference scenes');
  const file=new File([data],String(descriptor.originalName||id).slice(0,180),
    {type:descriptor.mime});
  imported.push({mediaId:id,file,kind:descriptor.kind});
 }
 if(imported.length!==new Set(items.map(i=>i.mediaId)).size)
  throw Error('Missing reference source in ZIP');
 return {timeline,media:imported};
}
