import { frameSignature, detectShotCuts, normalizeCuts, createDraftTimeline } from './shot-analysis.js';

const byId = id => document.getElementById(id);
const pretty = t => {
  const m = Math.floor(t / 60), s = Math.max(0,t-m*60);
  return String(m).padStart(2,'0') + ':' + s.toFixed(2).padStart(5,'0');
};
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));

function waitForVideo(video, event, timeoutMs=15000) {
  return new Promise((resolve,reject)=>{
    const timer = setTimeout(()=>finish(Error('Video decode timed out')),timeoutMs);
    const finish = err => {
      clearTimeout(timer);video.removeEventListener(event,ok);video.removeEventListener('error',bad);
      if (err) reject(err);else resolve();
    };
    const ok=()=>finish(),bad=()=>finish(Error('Unable to decode this video in your browser'));
    video.addEventListener(event,ok,{once:true});
    video.addEventListener('error',bad,{once:true});
  });
}
async function seekVideo(video,t) {
  if (Math.abs(video.currentTime-t)<0.012 && video.readyState>=2) return;
  const ready=waitForVideo(video,'seeked');
  video.currentTime=t;
  await ready;
}

async function sampleVideo(file, url, {step,onProgress,isCancelled}) {
  const video=document.createElement('video');
  video.muted=true;video.playsInline=true;video.preload='auto';
  video.src=url;
  try {
    if (video.readyState<1) await waitForVideo(video,'loadedmetadata');
    const duration=video.duration;
    if (!Number.isFinite(duration)||duration<0.25) throw Error('Video duration must be at least 0.25 seconds');
    if (duration>3600) throw Error('For now, please use videos under 60 minutes');
    if (video.readyState<2) await waitForVideo(video,'loadeddata');
    const canvas=document.createElement('canvas');canvas.width=96;canvas.height=54;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    if (!ctx) throw Error('Unable to create a frame analysis canvas');
    const thumb=document.createElement('canvas');thumb.width=192;thumb.height=108;
    const thumbCtx=thumb.getContext('2d');
    const times=[];for(let t=0.04;t<duration-0.04;t+=step)times.push(t);
    if(!times.length)times.push(Math.min(duration/2,0.05));
    if(times.at(-1)<duration-0.08)times.push(Math.max(0.01,duration-0.05));
    if(times.length>2400)throw Error('Too many samples. Increase the sampling interval');
    const samples=[];
    for (let i=0;i<times.length;i++) {
      if(isCancelled())throw Error('Analysis cancelled');
      await seekVideo(video,times[i]);
      ctx.drawImage(video,0,0,96,54);
      thumbCtx.drawImage(video,0,0,192,108);
      samples.push({at:+times[i].toFixed(3), signature:frameSignature(ctx.getImageData(0,0,96,54)),
        image:thumb.toDataURL('image/jpeg',0.63)});
      if (i%5===0 || i===times.length-1) {
        onProgress((i+1)/times.length,i+1,times.length);
        await pause(0);
      }
    }
    return {samples,duration, width:video.videoWidth,height:video.videoHeight};
  } finally {
    video.pause();video.removeAttribute('src');video.load();
  }
}

export function setupVideoImport({onApply}) {
  const modal=byId('videoImportModal'), fileInput=byId('videoSourceFile');
  const status=byId('videoStatus'), progress=byId('videoProgress'), gallery=byId('videoStoryboard');
  const start=byId('videoAnalyzeBtn'), apply=byId('videoApplyBtn'), exportBtn=byId('videoExportBtn');
  let report=null,cuts=[],file=null,url=null,scanning=false,cancel=false;
  const referencedUrls=new Set();
  const setStatus=s=>{status.textContent=s;};
  const newTimeline=()=>createDraftTimeline({
    duration:report.duration,fps:30,cuts,title:file.name.replace(/\.[^.]+$/,'') || 'Imported video'
  });
  const controls=()=>{
    apply.disabled=exportBtn.disabled=!report||scanning;
    start.disabled=!file||scanning;
    byId('videoAddCutBtn').disabled=!report||scanning;
  };
  function open(){modal.hidden=false;setStatus(report ? 'Review cuts, add/remove boundaries, then apply to the editor.' :
    'Select an MP4, MOV, or WebM file. Analysis happens locally in this browser.');}
  function close(){modal.hidden=true;cancel=true;}
  byId('videoImportOpenBtn').addEventListener('click',open);
  byId('videoCloseBtn').addEventListener('click',close);
  modal.addEventListener('click',e=>{if(e.target===modal)close();});
  fileInput.addEventListener('change',()=>{
    if(scanning)return;
    const next=fileInput.files?.[0];
    if (!next)return;
    if(url&&!referencedUrls.has(url))URL.revokeObjectURL(url);
    file=next;url=URL.createObjectURL(file);report=null;cuts=[];gallery.replaceChildren();progress.value=0;
    byId('videoPreview').src=url;
    setStatus('Ready to scan '+file.name+' ('+(file.size/1048576).toFixed(1)+' MB).');
    controls();
  });
  function draw() {
    gallery.replaceChildren();if(!report)return;
    const timeline=newTimeline();
    byId('videoShotCount').textContent=timeline.shots.length+' scene(s) · '+pretty(report.duration)+' · '+report.samples.length+' sampled frames';
    for(let i=0;i<timeline.shots.length;i++){
      const shot=timeline.shots[i], card=document.createElement('article');card.className='video-shot-card';
      const image=document.createElement('img');image.alt='Sampled source video at '+pretty(shot.sourceFrameTime);
      const nearest=report.samples.reduce((a,b)=>Math.abs(a.at-shot.sourceFrameTime)<Math.abs(b.at-shot.sourceFrameTime)?a:b);
      image.src=nearest.image;
      const info=document.createElement('div');info.className='video-shot-info';
      const heading=document.createElement('strong');heading.textContent='Shot '+String(i+1).padStart(2,'0');
      const time=document.createElement('span');time.textContent=pretty(shot.start)+' – '+pretty(shot.end);
      info.append(heading,time);
      if (i>0) {
        const remove=document.createElement('button');remove.type='button';remove.className='video-remove-cut';
        remove.textContent='Remove cut';remove.title='Merge this shot with the previous shot';
        remove.addEventListener('click',()=>{cuts.splice(i-1,1);draw();});
        info.append(remove);
      }
      card.append(image,info);gallery.append(card);
    }
  }
  start.addEventListener('click',async()=>{
    if(!file||scanning)return;
    scanning=true;cancel=false;controls();progress.value=0;
    const step=Number(byId('videoStep').value),threshold=Number(byId('videoSensitivity').value);
    const minShotDuration=Number(byId('videoMinLength').value);
    setStatus('Decoding frames locally… no video is uploaded.');
    try{
      const found=await sampleVideo(file,url,{step,isCancelled:()=>cancel,
        onProgress:(fraction,n,total)=>{progress.value=fraction;setStatus('Analyzed '+n+' / '+total+' frames ('+Math.round(fraction*100)+'%).');}});
      if(cancel)throw Error('Analysis cancelled');
      report=found;
      cuts=detectShotCuts(found.samples,{threshold,minShotDuration});
      draw();setStatus('Analysis complete. Cut detection is approximate; review the storyboard before applying.');
    }catch(err){if(err.message!=='Analysis cancelled')setStatus('Unable to analyze video: '+err.message);
      console.warn('Video import:',err);}
    finally{scanning=false;controls();}
  });
  byId('videoSensitivity').addEventListener('change',()=>{
    if(!report||scanning)return;
    cuts=detectShotCuts(report.samples,{threshold:Number(byId('videoSensitivity').value),
      minShotDuration:Number(byId('videoMinLength').value)});draw();
  });
  byId('videoMinLength').addEventListener('change',()=>{
    if(!report||scanning)return;
    cuts=detectShotCuts(report.samples,{threshold:Number(byId('videoSensitivity').value),
      minShotDuration:Number(byId('videoMinLength').value)});draw();
  });
  byId('videoAddCutBtn').addEventListener('click',()=>{
    if(!report||scanning)return;
    const t=Number(byId('videoManualCut').value);
    if(!Number.isFinite(t)||t<=0||t>=report.duration){
      setStatus('Enter a cut time inside the video duration.');return;
    }
    const next=normalizeCuts([...cuts,{at:t,automatic:false}],report.duration);
    if(next.length===cuts.length){setStatus('There is already a cut very close to that time.');return;}
    cuts=next;draw();setStatus('Added manual cut at '+pretty(t)+'.');
  });
  exportBtn.addEventListener('click',()=>{
    if(!report)return;
    const blob=new Blob([JSON.stringify(newTimeline(),null,2)],{type:'application/json'});
    const u=URL.createObjectURL(blob),link=document.createElement('a');link.href=u;
    link.download='video-draft-timeline.json';link.click();setTimeout(()=>URL.revokeObjectURL(u),10000);
    setStatus('Timeline JSON downloaded. Keep your original video file separately.');
  });
  apply.addEventListener('click',()=>{
    if(!report||scanning)return;
    if(!confirm('Replace the current editor timeline with this video draft? Export existing edits first if needed.'))return;
    onApply({timeline:newTimeline(),videoUrl:url,videoFile:file});
    referencedUrls.add(url); // Keep the active reference video alive while the editor plays.
    close();
  });
  controls();
  return {open};
}
