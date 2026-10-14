// Small self-contained ZIP writer. Stored entries need no extra CDN dependency.
const textEncoder=new TextEncoder();
const toBytes=x=>typeof x==='string'?textEncoder.encode(x):x instanceof Uint8Array?x:new Uint8Array(x);
const crcTable=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?(c>>>1)^0xedb88320:c>>>1;t[n]=c>>>0;}return t;})();
function crc32(data){let crc=0xffffffff;for(const byte of data)crc=crcTable[(crc^byte)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;}
function localDateTime(date=new Date()){let d=Math.max(1,Math.min(31,date.getDate())),m=date.getMonth()+1,y=Math.max(1980,date.getFullYear());return{time:((date.getHours()&31)<<11)|((date.getMinutes()&63)<<5)|(Math.floor(date.getSeconds()/2)&31),date:(((y-1980)&127)<<9)|((m&15)<<5)|d};}
export function zipFiles(entries){
 const locals=[],centrals=[];let offset=0;const dt=localDateTime();
 for(const entry of entries){const name=textEncoder.encode(entry.name.replaceAll('\\','/')),data=toBytes(entry.data),sum=crc32(data);
  const local=new Uint8Array(30+name.length),v=new DataView(local.buffer);
  v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x0800,true);v.setUint16(8,0,true);v.setUint16(10,dt.time,true);v.setUint16(12,dt.date,true);v.setUint32(14,sum,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,name.length,true);local.set(name,30);
  locals.push(local,data);
  const central=new Uint8Array(46+name.length),c=new DataView(central.buffer);
  c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x0800,true);c.setUint16(10,0,true);c.setUint16(12,dt.time,true);c.setUint16(14,dt.date,true);c.setUint32(16,sum,true);c.setUint32(20,data.length,true);c.setUint32(24,data.length,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);central.set(name,46);
  centrals.push(central);offset+=local.length+data.length;
 }
 const centLen=centrals.reduce((n,b)=>n+b.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);
 e.setUint32(0,0x06054b50,true);e.setUint16(8,entries.length,true);e.setUint16(10,entries.length,true);e.setUint32(12,centLen,true);e.setUint32(16,offset,true);
 return new Blob([...locals,...centrals,end],{type:'application/zip'});
}
