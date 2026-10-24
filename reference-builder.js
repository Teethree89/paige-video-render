import {buildReferenceTimeline,validateReferenceItems} from './reference-sequence.js';
import {mountReferenceBuilderUI} from './reference-builder-ui.js';
import {makePortableProject,openPortableProject} from './portable-reference.js';

const el=id=>document.getElementById(id);
const rounded=n=>Math.round(n*1000)/1000;
const fmt=n=>Math.floor(n/60)+':'+(n%60).toFixed(2).padStart(5,'0');
const safe=(value,fallback)=>Number.isFinite(Number(value))?Number(value):fallback;
const mediaKind=file=>{
  if(file.type.startsWith('image/')||/\.(png|jpg|jpeg|webp)$/i.test(file.name))return 'image';
  if(file.type.startsWith('video/')||/\.(mp4|mov|webm)$/i.test(file.name))return 'video';
  return null;
};
async function loadVideoMetadata(url){
  const video=document.createElement('video');video.muted=true;video.preload='metadata';
  video.playsInline=true;
  try{
    const ready=new Promise((resolve,reject)=>{
      video.addEventListener('loadedmetadata',resolve,{once:true});
      video.addEventListener('error',()=>reject(Error('Video cannot be decoded')),{once:true});
      setTimeout(()=>reject(Error('Video metadata timed out')),15000);
    });
    video.src=url;await ready;
    if(!Number.isFinite(video.duration)||video.duration<.5||video.duration>3600)
      throw Error('Video must be 0.5 seconds to 60 minutes long');
    let thumbnail='';
    try{
      video.preload='auto';
      const seeked=new Promise(resolve=>{
        video.addEventListener('seeked',resolve,{once:true});
        setTimeout(resolve,2000);
      });
      video.currentTime=Math.min(.3,video.duration/2);await seeked;
      const canvas=document.createElement('canvas');canvas.width=320;
      canvas.height=Math.max(1,Math.round(320*(video.videoHeight/video.videoWidth||.5625)));
      canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
      thumbnail=canvas.toDataURL('image/jpeg',.65);
    }catch{}
    return {duration:rounded(video.duration),thumbnail};
  }finally{video.removeAttribute('src');video.load();}
}
let counter=0;
const newId=prefix=>prefix+'_'+Date.now().toString(36)+'_'+(++counter).toString(36);
export function setupReferenceBuilder({onApply,getSequence=()=>null}){
  mountReferenceBuilderUI();
  const modal=el('referenceBuilderModal'),status=el('rbStatus'),
    list=el('rbScenes'),image=el('rbImage'),video=el('rbVideo'),
    fileInput=el('rbFiles'),relinkInput=el('rbRelink');
  if(!modal||!list||!fileInput)throw Error('Reference Builder markup is missing');
  const assets=new Map();
  let items=[],selectedId=null,busy=false;
  let previewPlaying=false,previewElapsed=0,previewFrame=0,lastTick=0;
  const transport=el('rbPlaySequence');
  function stopSequence(){
    previewPlaying=false;if(previewFrame)cancelAnimationFrame(previewFrame);
    previewFrame=0;video.pause();
    transport.textContent='▶ Play sequence';transport.setAttribute('aria-pressed','false');
  }
  function tick(now){
    if(!previewPlaying)return;
    previewElapsed+=Math.max(0,Math.min(.25,(now-lastTick)/1000));lastTick=now;
    let offset=0,item=items[items.length-1];
    for(const entry of items){
      if(previewElapsed<offset+entry.duration){item=entry;break;}
      offset+=entry.duration;
    }
    if(!item){stopSequence();return;}
    if(selectedId!==item.id){selectedId=item.id;render();}
    const source=assetFor(item);
    if(item.kind==='video'&&source&&video.readyState>=1){
      const wanted=Math.min(item.sourceOut-.001,item.sourceIn+Math.max(0,previewElapsed-offset));
      if(Math.abs(video.currentTime-wanted)>.2)try{video.currentTime=wanted;}catch{}
      if(video.paused)video.play().catch(()=>{});
    }else video.pause();
    el('rbSequenceClock').textContent=fmt(previewElapsed);
    const total=items.reduce((sum,entry)=>sum+entry.duration,0);
    if(previewElapsed>=total){stopSequence();return;}
    previewFrame=requestAnimationFrame(tick);
  }

  const say=message=>{status.textContent=message;};
  const current=()=>items.find(x=>x.id===selectedId)||null;
  const assetFor=item=>item&&assets.get(item.mediaId);
  function sourceForShot(id){
    const item=items.find(x=>x.id===id),asset=assetFor(item);
    if(!item||!asset)return null;
    return {...item,url:asset.url,file:asset.file,mediaDuration:asset.duration};
  }
  function loadFromSequence(sequence){
    stopSequence();
    const loaded=sequence?.referenceSequence?.items;
    if(!loaded){items=[];selectedId=null;render();return;}
    try{items=validateReferenceItems(loaded);}catch(error){say(error.message);return;}
    selectedId=items[0]?.id||null;render();
  }
  function preview(){
    video.pause();
    image.hidden=true;video.hidden=true;
    const item=current(),asset=assetFor(item);
    const placeholder=modal.querySelector('.rb-empty-preview');
    if(placeholder)placeholder.hidden=!!asset;
    if(!item||!asset){say(item?'Missing source: add the original media using Relink files.':
      'Add videos or still images to compose your reference.');return;}
    if(item.kind==='image'){image.src=asset.url;image.style.objectFit=item.fit;image.hidden=false;}
    else{
      if(video.dataset.media!==item.mediaId){video.src=asset.url;video.dataset.media=item.mediaId;}
      video.hidden=false;video.currentTime=item.sourceIn;
      video.style.objectFit=item.fit;
    }
  }
  function render(){
    list.replaceChildren();
    const total=rounded(items.reduce((sum,item)=>sum+item.duration,0));
    el('rbSummary').textContent=items.length+' scenes · '+fmt(total);
    items.forEach((item,index)=>{
      const asset=assetFor(item),row=document.createElement('div');
      row.className='rb-scene'+(item.id===selectedId?' active':'');
      const thumb=document.createElement('div');thumb.className='rb-thumb';
      if(asset?.thumbnail||item.kind==='image'&&asset){
        const img=document.createElement('img');img.src=asset.thumbnail||asset.url;
        img.alt='';thumb.append(img);
      }else thumb.textContent=item.kind==='image'?'▧':'▶';
      const details=document.createElement('div');details.className='rb-scene-label';
      const title=document.createElement('strong');title.textContent=item.name;
      const meta=document.createElement('small');
      meta.textContent=(item.kind==='video'?'VIDEO':'IMAGE')+' · '+fmt(item.duration)+
        (asset?'':' · RE-LINK');
      details.append(title,meta);
      const select=document.createElement('button');select.type='button';
      select.className='rb-select';select.append(thumb,details);
      select.setAttribute('aria-label','Select scene '+item.name);
      select.addEventListener('click',()=>{stopSequence();selectedId=item.id;render();});
      const actions=document.createElement('div');actions.className='rb-scene-actions';
      const action=(glyph,title,callback,disabled=false)=>{
        const button=document.createElement('button');button.type='button';button.textContent=glyph;
        button.title=title;button.setAttribute('aria-label',title);button.disabled=disabled;
        button.addEventListener('click',()=>{callback();render();});actions.append(button);
      };
      action('↑','Move scene earlier',()=>{[items[index-1],items[index]]=[items[index],items[index-1]];},index===0);
      action('↓','Move scene later',()=>{[items[index],items[index+1]]=[items[index+1],items[index]];},index===items.length-1);
      action('⧉','Duplicate scene',()=>{items.splice(index+1,0,{...item,id:newId('ref')});});
      action('×','Remove scene',()=>{items.splice(index,1);if(selectedId===item.id)selectedId=items[Math.min(index,items.length-1)]?.id||null;});
      row.draggable=true;
      row.addEventListener('dragstart',event=>{
        stopSequence();event.dataTransfer?.setData('text/plain',item.id);
        if(event.dataTransfer)event.dataTransfer.effectAllowed='move';
      });
      row.addEventListener('dragover',event=>{event.preventDefault();});
      row.addEventListener('drop',event=>{
        event.preventDefault();const id=event.dataTransfer?.getData('text/plain');
        const from=items.findIndex(x=>x.id===id),to=items.findIndex(x=>x.id===item.id);
        if(from<0||to<0||from===to)return;
        const [moved]=items.splice(from,1);items.splice(to,0,moved);render();
      });
      row.append(select,actions);list.append(row);
    });
    const item=current();
    const fields=el('rbFields');fields.hidden=!item;
    if(item){
      el('rbName').value=item.name;
      el('rbDuration').value=item.duration;
      el('rbDuration').disabled=item.kind==='video';
      el('rbVideoFields').hidden=item.kind!=='video';
      el('rbSourceIn').value=item.sourceIn;
      el('rbSourceOut').value=item.sourceOut;
      el('rbFit').value=item.fit;
      el('rbMediaName').textContent=item.fileName;
    }
    const strip=el('rbSequenceStrip');strip.replaceChildren();
    for(const item of items){
      const cell=document.createElement('button');cell.type='button';cell.className='rb-strip-item';
      cell.style.flex=String(Math.max(.2,item.duration));cell.title=item.name+' · '+fmt(item.duration);
      cell.textContent=item.kind==='video'?'▶ '+item.name:'▧ '+item.name;
      cell.setAttribute('aria-pressed',String(selectedId===item.id));
      cell.addEventListener('click',()=>{stopSequence();selectedId=item.id;render();});
      strip.append(cell);
    }
    el('rbApply').disabled=busy||!items.length||items.some(i=>!assetFor(i));
    preview();
  }
  async function addFiles(files,onlyRelink=false){
    if(busy)return;
    busy=true;el('rbApply').disabled=true;
    try{
      let count=0;
      for(const file of files){
        const kind=mediaKind(file);
        if(!kind){say('Unsupported file: '+file.name);continue;}
        let target=null;
        if(onlyRelink){
          target=items.find(x=>x.fileName===file.name&&x.kind===kind&&
            (!x.fileSize||x.fileSize===file.size));
          if(!target)continue;
        }else if(items.length>=80){say('80 scene limit reached.');break;}
        const mediaId=target?.mediaId||newId('media');
        const url=URL.createObjectURL(file);
        let details={duration:5,thumbnail:kind==='image'?url:''};
        try{if(kind==='video')details=await loadVideoMetadata(url);}
        catch(error){URL.revokeObjectURL(url);say('Cannot read '+file.name+': '+error.message);continue;}
        const old=assets.get(mediaId);
        assets.set(mediaId,{file,url,kind,...details});
        if(old?.url&&old.url!==url)URL.revokeObjectURL(old.url);
        if(!onlyRelink){
          const duration=kind==='image'?5:details.duration;
          const item={id:newId('ref'),mediaId,kind,fileName:file.name,fileSize:file.size,
            name:file.name.replace(/\.[^.]+$/,'').slice(0,100),
            duration,sourceIn:0,sourceOut:kind==='video'?duration:0,fit:'cover'};
          items.push(item);selectedId=item.id;
        }
        count++;
      }
      say((onlyRelink?'Relinked ':'Added ')+count+' media file(s). Files remain local to your browser.');
    }finally{busy=false;render();}
  }
  fileInput.addEventListener('change',async()=>{await addFiles(fileInput.files||[]);fileInput.value='';});
  relinkInput.addEventListener('change',async()=>{await addFiles(relinkInput.files||[],true);relinkInput.value='';});
  el('rbAddMedia').addEventListener('click',()=>fileInput.click());
  el('rbRelinkButton').addEventListener('click',()=>relinkInput.click());
  el('referenceBuilderOpenBtn').addEventListener('click',()=>{modal.hidden=false;render();});
  el('rbClose').addEventListener('click',()=>{stopSequence();modal.hidden=true;});
  modal.addEventListener('click',event=>{if(event.target===modal){stopSequence();modal.hidden=true;}});
  transport.addEventListener('click',()=>{
    if(previewPlaying){stopSequence();return;}
    if(!items.length||items.some(i=>!assetFor(i))){
      say('Relink all images/videos before playing this reference sequence.');return;
    }
    previewElapsed=0;lastTick=performance.now();previewPlaying=true;selectedId=items[0].id;
    transport.textContent='Ⅱ Pause sequence';transport.setAttribute('aria-pressed','true');
    render();previewFrame=requestAnimationFrame(tick);
  });
  el('rbSplitVideo').addEventListener('click',()=>{
    stopSequence();
    const item=current(),asset=assetFor(item);
    if(!item||item.kind!=='video'||!asset){say('Select a linked video clip to split.');return;}
    const at=rounded(video.currentTime);
    if(!Number.isFinite(at)||at<=item.sourceIn+.5||at>=item.sourceOut-.5){
      say('Move the source preview playhead at least half a second inside the clip before splitting.');return;
    }
    const index=items.findIndex(i=>i.id===item.id),last=item.sourceOut;
    const second={...item,id:newId('ref'),sourceIn:at,sourceOut:last,
      duration:rounded(last-at),name:item.name+' · 2'};
    item.sourceOut=at;item.duration=rounded(at-item.sourceIn);
    items.splice(index+1,0,second);selectedId=second.id;render();
    say('Split into two scenes; both reference the same original local video.');
  });
  el('rbName').addEventListener('input',event=>{const item=current();if(!item)return;item.name=event.target.value.slice(0,100);const row=list.querySelector('.rb-scene.active strong');if(row)row.textContent=item.name;});
  el('rbName').addEventListener('change',render);
  el('rbFit').addEventListener('change',event=>{const item=current();if(item){item.fit=event.target.value;render();}});
  const onTimingChange=()=>{
    const item=current();if(!item)return;
    if(item.kind==='image'){
      item.duration=rounded(Math.max(.5,Math.min(3600,safe(el('rbDuration').value,item.duration))));
    }else{
      const max=assetFor(item)?.duration||Math.max(item.sourceOut,.5);
      let start=Math.max(0,Math.min(max-.5,safe(el('rbSourceIn').value,item.sourceIn)));
      let end=Math.max(start+.5,Math.min(max,safe(el('rbSourceOut').value,item.sourceOut)));
      item.sourceIn=rounded(start);item.sourceOut=rounded(end);
      item.duration=rounded(end-start);
    }
    render();
  };
  for(const id of ['rbDuration','rbSourceIn','rbSourceOut'])
    el(id).addEventListener('change',onTimingChange);
  el('rbApply').addEventListener('click',()=>{
    try{
      const timeline=buildReferenceTimeline(items);
      if(items.some(i=>!assetFor(i)))throw Error('Relink all source media before applying.');
      if(!confirm('Use this reference sequence in the editor? This replaces the current working timeline. Export existing edits first.'))return;
      onApply({timeline});stopSequence();modal.hidden=true;say('Reference sequence applied. Media stays local.');
    }catch(error){say(error.message);}
  });
  const bundlePicker=el('rbBundlePicker');
  el('rbBundleOpen').addEventListener('click',()=>bundlePicker.click());
  bundlePicker.addEventListener('change',async()=>{
    const file=bundlePicker.files?.[0];bundlePicker.value='';
    if(!file||busy)return;
    if(!confirm('Import this portable project with its original media? This replaces the working editor timeline. Export current edits first.'))return;
    busy=true;render();say('Reading portable project and validating media files…');
    try{
      const loaded=await openPortableProject(file);
      stopSequence();
      for(const item of loaded.media){
        const old=assets.get(item.mediaId);
        const url=URL.createObjectURL(item.file);
        let details={duration:5,thumbnail:item.kind==='image'?url:''};
        try{if(item.kind==='video')details=await loadVideoMetadata(url);}
        catch(err){URL.revokeObjectURL(url);throw Error('Bundled video cannot be decoded: '+err.message);}
        assets.set(item.mediaId,{file:item.file,url,kind:item.kind,...details});
        if(old?.url&&old.url!==url)URL.revokeObjectURL(old.url);
      }
      onApply({timeline:loaded.timeline,fromBundle:true});
      loadFromSequence(loaded.timeline);
      modal.hidden=true;
      say('Portable project and all '+loaded.media.length+' sources restored locally.');
    }catch(err){say('Could not open portable project: '+err.message);}
    finally{busy=false;render();}
  });
  el('rbBundleExport').addEventListener('click',async()=>{
    if(busy||!items.length)return;
    busy=true;render();say('Packaging project and original media locally…');
    try{
      const original=getSequence();
      const normalized=validateReferenceItems(items);
      const matches=original?.referenceSequence?.items&&
        JSON.stringify(validateReferenceItems(original.referenceSequence.items))===JSON.stringify(normalized);
      const timeline=matches?original:buildReferenceTimeline(normalized);
      const zip=await makePortableProject(timeline,item=>assets.get(item.mediaId)?.file);
      const url=URL.createObjectURL(zip),a=document.createElement('a');
      a.href=url;a.download='paige-studio-portable-project.zip';
      document.body.append(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      say('Project ZIP exported with '+new Set(items.map(x=>x.mediaId)).size+' original media file(s).'+
        (matches?'':' Unapplied scene changes were exported as a draft timeline.'));
    }catch(err){say('Portable project export failed: '+err.message);}
    finally{busy=false;render();}
  });
  el('rbDownload').addEventListener('click',()=>{
    try{
      const manifest=buildReferenceTimeline(items);
      const url=URL.createObjectURL(new Blob([JSON.stringify(manifest,null,2)],{type:'application/json'}));
      const a=document.createElement('a');a.href=url;a.download='paige-reference-timeline.json';a.click();
      setTimeout(()=>URL.revokeObjectURL(url),10000);say('Downloaded metadata; keep media files separately.');
    }catch(error){say(error.message);}
  });
  render();
  return {loadFromSequence,sourceForShot,hasSourceForShot:id=>!!sourceForShot(id),
    open:()=>{modal.hidden=false;render();}};
}
