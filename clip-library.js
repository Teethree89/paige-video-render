// Clip library (Source tab): every video, clip and image saved in this browser,
// with thumbnails, expiry, a "Keep" checkbox, 3D / camera mapping chips and the
// saved versions of each clip's chapters. Local only; nothing is uploaded.
import {formatExpiry} from './local-media-store.js';
import {clipMappingStatus,ITERATION_KINDS} from './clip-history.js';

const THUMB_W=160,THUMB_H=90;
const fmtSize=bytes=>!Number.isFinite(bytes)?'':bytes>=1e9?(bytes/1e9).toFixed(1)+' GB':
 bytes>=1e6?(bytes/1e6).toFixed(1)+' MB':Math.max(1,Math.round(bytes/1e3))+' KB';
const fmtDuration=s=>Number.isFinite(s)?Math.floor(s/60)+':'+String(Math.round(s%60)).padStart(2,'0'):'';
const fmtWhen=t=>new Date(t).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});

/** Small JPEG data URL (and video duration) for a stored file. */
export async function makeThumbnail(file,kind){
 const canvas=document.createElement('canvas');canvas.width=THUMB_W;canvas.height=THUMB_H;
 const ctx=canvas.getContext('2d',{alpha:false});
 const url=URL.createObjectURL(file);
 const cover=(w,h,draw)=>{const r=Math.max(THUMB_W/w,THUMB_H/h);ctx.fillStyle='#08131e';ctx.fillRect(0,0,THUMB_W,THUMB_H);
   draw((THUMB_W-w*r)/2,(THUMB_H-h*r)/2,w*r,h*r);};
 const wait=(target,event,ms=10000)=>new Promise((resolve,reject)=>{
   const t=setTimeout(()=>reject(Error('Thumbnail timed out')),ms);
   target.addEventListener(event,()=>{clearTimeout(t);resolve();},{once:true});
   target.addEventListener('error',()=>{clearTimeout(t);reject(Error('Cannot decode media'));},{once:true});
 });
 try{
   if(kind==='image'){
     const img=new Image();const loaded=wait(img,'load');img.src=url;await loaded;
     cover(img.naturalWidth,img.naturalHeight,(x,y,w,h)=>ctx.drawImage(img,x,y,w,h));
     return {thumbnail:canvas.toDataURL('image/jpeg',.72),width:img.naturalWidth,height:img.naturalHeight};
   }
   const video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='auto';
   const meta=wait(video,'loadeddata');video.src=url;await meta;
   const at=Math.min(1.5,(video.duration||1)*.15);
   if(at>0){const seeked=wait(video,'seeked');video.currentTime=at;await seeked;}
   cover(video.videoWidth,video.videoHeight,(x,y,w,h)=>ctx.drawImage(video,x,y,w,h));
   const out={thumbnail:canvas.toDataURL('image/jpeg',.72),duration:video.duration,width:video.videoWidth,height:video.videoHeight};
   video.removeAttribute('src');video.load();
   return out;
 }finally{URL.revokeObjectURL(url);}
}

/**
 * @param {{videoStore:{store:object},referenceStore:object,history:object,getSequence:Function,
 *   canEdit:Function,onRestore:(snapshot:object)=>string|void,onDeleted?:(clipKey:string)=>void}} options
 */
export function setupClipLibrary({videoStore,referenceStore,history,getSequence,canEdit=()=>true,onRestore,onDeleted=()=>{}}){
 const $=id=>document.getElementById(id);
 const root=$('clipLibrary'),list=$('clipLibraryList'),status=$('clipLibraryStatus'),usage=$('clipLibraryUsage');
 if(!root||!list)return null;
 const expanded=new Set(),thumbing=new Set();
 let timer=null,rendering=null,again=false;
 const tell=text=>{status.textContent=text;};
 const sources=[
   {prefix:'video:',store:videoStore.store,label:'Video → timeline',keyOf:e=>e.id||e.key},
   {prefix:'reference:',store:referenceStore,label:'Reference Builder',keyOf:e=>e.key}];

 async function load(){
   const clips=[];
   for(const source of sources){
     let entries=[];try{entries=await source.store.list();}catch{entries=[];}
     for(const entry of entries)clips.push({...entry,clipKey:source.prefix+source.keyOf(entry),source});
   }
   let all=new Map();try{all=await history.all();}catch{}
   return {clips:clips.sort((a,b)=>b.savedAt-a.savedAt),all};
 }
 function chip(text,on,title){const s=document.createElement('span');s.className='clip-chip'+(on?' on':'');s.textContent=text;s.title=title;return s;}
 function versionList(clip,iterations,sequence){
   const box=document.createElement('div');box.className='clip-versions';
   const original=document.createElement('div');original.className='clip-version original';
   original.textContent=`Original · ${clip.name} · ${fmtSize(clip.size)} · kept unchanged`;
   box.append(original);
   if(!iterations.length){const p=document.createElement('p');p.className='clip-version-empty';
     p.textContent='No versions yet. Accepting a 3D model, applying a camera or tracking saves one here.';box.append(p);}
   iterations.forEach((it,index)=>{
     const row=document.createElement('div');row.className='clip-version';
     const text=document.createElement('span');
     const shot=sequence?.shots.find(s=>s.id===it.shotId);
     const bits=[`v${iterations.length-index}`,ITERATION_KINDS[it.kind]||it.kind,it.chapter?.name||it.shotId,
       it.summary?.objects?`${it.summary.objects} objects`:'',it.summary?.keys?`${it.summary.keys} camera keys`:'',
       it.summary?.motion?`${it.summary.motion} motion`:'',fmtWhen(it.at)].filter(Boolean);
     text.textContent=bits.join(' · ');
     const restore=document.createElement('button');restore.type='button';restore.textContent='Restore';
     const sameTiming=shot&&Math.abs(shot.start-it.chapter.start)<.001&&Math.abs(shot.end-it.chapter.end)<.001;
     restore.disabled=!sameTiming||!canEdit();
     restore.title=!shot?'This chapter is not in the current project.':!sameTiming?'The chapter was resized since this version.':
       !canEdit()?'Finish the active AI job or proposal first.':'Put this version back into its chapter (undo is available).';
     restore.addEventListener('click',()=>{
       try{const note=onRestore(it);tell(note||`Restored v${iterations.length-index} of ${it.chapter?.name||'the chapter'}. Undo is available.`);}
       catch(error){tell('Could not restore: '+error.message);}
     });
     row.append(text,restore);box.append(row);
   });
   return box;
 }
 function row(clip,iterations,sequence){
   const li=document.createElement('li');li.className='clip-item';li.dataset.clipKey=clip.clipKey;
   const kind=clip.kind||(clip.type?.startsWith('image/')?'image':'video');
   const open=expanded.has(clip.clipKey);
   const main=document.createElement('button');main.type='button';main.className='clip-main';
   main.setAttribute('aria-expanded',String(open));
   const thumb=document.createElement('span');thumb.className='clip-thumb';
   if(clip.thumbnail){const img=document.createElement('img');img.src=clip.thumbnail;img.alt='';thumb.append(img);}
   else thumb.textContent=kind==='image'?'▧':'▶';
   const info=document.createElement('span');info.className='clip-info';
   const name=document.createElement('strong');name.textContent=clip.name;
   const meta=document.createElement('small');
   meta.textContent=[kind==='image'?'IMAGE':'VIDEO',fmtDuration(clip.duration),fmtSize(clip.size),clip.source.label].filter(Boolean).join(' · ');
   const s=clipMappingStatus(sequence,clip.clipKey,iterations);
   const chips=document.createElement('span');chips.className='clip-chips';
   chips.append(
     chip('3D',s.has3d,s.inProject?`${s.mapped3d}/${s.chapters} chapters have accepted 3D models`:s.has3d?'A 3D version is saved':'Not 3D mapped yet'),
     chip(s.tracked?'CAM · TRACKED':'CAM',s.hasCamera,s.inProject?`${s.mappedCamera}/${s.chapters} chapters have camera movement`:s.hasCamera?'A camera version is saved':'Not camera mapped yet'),
     chip(`${s.versions} version${s.versions===1?'':'s'}`,s.versions>0,'Saved versions of this clip\'s chapters'));
   if(s.inProject)chips.append(chip('IN PROJECT',true,'Used by the open timeline'));
   info.append(name,meta);
   main.append(thumb,info);
   main.addEventListener('click',()=>{if(expanded.has(clip.clipKey))expanded.delete(clip.clipKey);else expanded.add(clip.clipKey);schedule(0);});
   const side=document.createElement('div');side.className='clip-side';
   const keep=document.createElement('label');keep.className='clip-keep';
   const box=document.createElement('input');box.type='checkbox';box.checked=clip.keep===true;
   box.setAttribute('aria-label','Keep '+clip.name+' indefinitely');
   keep.append(box,document.createTextNode(' Keep'));
   const expiry=document.createElement('small');expiry.className='clip-expiry';
   expiry.textContent=clip.keep?'Kept indefinitely':'Removed '+formatExpiry(clip.expiresAt);
   box.addEventListener('change',async()=>{
     box.disabled=true;
     try{
       await clip.source.store.setKept(clip.key,box.checked);
       // Ask the browser not to evict kept files under storage pressure (it may still decline).
       if(box.checked)navigator.storage?.persist?.().catch(()=>{});
       tell(box.checked?`${clip.name} is kept until you delete it.`:`${clip.name} will be removed in 48 hours.`);
     }catch(error){box.checked=!box.checked;tell('Could not change: '+error.message);}
     schedule(0);
   });
   const remove=document.createElement('button');remove.type='button';remove.className='clip-delete';remove.textContent='×';
   remove.title='Delete '+clip.name+' and its versions from this browser';remove.setAttribute('aria-label',remove.title);
   remove.addEventListener('click',async()=>{
     if(!window.confirm(`Delete “${clip.name}” and its saved versions from this browser?`+
       (s.inProject?' Chapters using it will need the file re-linked.':'')))return;
     try{await clip.source.store.delete(clip.key);await history.remove(clip.clipKey);onDeleted(clip.clipKey);tell(clip.name+' deleted from this browser.');}
     catch(error){tell('Could not delete: '+error.message);}
     schedule(0);
   });
   side.append(keep,expiry,remove);
   li.append(main,side,chips);
   if(open)li.append(versionList(clip,iterations,sequence));
   return li;
 }
 async function render(){
   if(rendering){again=true;return rendering;}
   rendering=(async()=>{
     const {clips,all}=await load(),sequence=getSequence();
     try{await history.prune(clips.map(c=>c.clipKey));}catch{}
     list.replaceChildren(...clips.map(c=>row(c,all.get(c.clipKey)||[],sequence)));
     if(!clips.length){const li=document.createElement('li');li.className='clip-empty';
       li.textContent='No clips saved in this browser yet. Import a video or add media in Reference Builder.';list.append(li);}
     const kept=clips.filter(c=>c.keep).length,total=clips.reduce((n,c)=>n+(c.size||0),0);
     let quota='';
     try{const e=await navigator.storage?.estimate?.();if(e?.quota)quota=` of about ${fmtSize(e.quota)} available`;}catch{}
     usage.textContent=clips.length?`${clips.length} clip${clips.length===1?'':'s'} · ${fmtSize(total)}${quota}${kept?` · ${kept} kept`:''}`:'';
     // Thumbnails are made once per file and stored with it.
     for(const clip of clips)if(!clip.thumbnail&&!thumbing.has(clip.clipKey)){
       thumbing.add(clip.clipKey);
       makeThumbnail(clip.file,clip.kind||(clip.type?.startsWith('image/')?'image':'video'))
         .then(meta=>clip.source.store.update(clip.key,meta)).then(()=>schedule(0)).catch(()=>{});
     }
   })().finally(()=>{rendering=null;if(again){again=false;render();}});
   return rendering;
 }
 function schedule(ms=500){clearTimeout(timer);timer=setTimeout(render,ms);}
 return {refresh:schedule,render};
}
