// Decorative, non-metric generation visualization. Argon provides phases,
// not percent complete/ETA. Never present animation as measured progress.
export function createArgonOverlay(root=globalThis.document){
  const overlay=root?.getElementById?.('argonParticleOverlay');
  const canvas=root?.getElementById?.('argonParticleCanvas');
  const stage=root?.getElementById?.('argonParticleStage');
  const detail=root?.getElementById?.('argonParticleDetail');
  const elapsed=root?.getElementById?.('argonParticleElapsed');
  const meter=root?.getElementById?.('argonParticleMeter');
  const minimize=root?.getElementById?.('argonParticleMinimize');
  const reopen=root?.getElementById?.('argonParticleReopen');
  if(!overlay||!canvas||typeof canvas.getContext!=='function')
    return {show(){},step(){},phase(){},hide(){}};
  const ctx=canvas.getContext('2d',{alpha:true});
  if(!ctx)return {show(){},step(){},phase(){},hide(){}};
  let active=false,frame=0,start=0,operation=0,stepNumber=1,steps=1,phaseName='queued';
  let particles=[],mouse={x:-99999,y:-99999},size={w:0,h:0},prior=0;
  const raf=globalThis.requestAnimationFrame?.bind(globalThis);
  const cancel=globalThis.cancelAnimationFrame?.bind(globalThis);
  const reduced=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches===true;
  const phases={queued:'Waiting for Cloudflare job',waiting:'Waiting for Argon response',
    reasoning:'Argon reasoning',geometry:'Receiving editable geometry',
    validating:'Validating returned geometry',reconnecting:'Reconnecting to existing job'};
  const tickTime=()=>{const seconds=Math.max(0,Math.floor((Date.now()-start)/1000));
    if(elapsed)elapsed.textContent=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')+
      ' elapsed · finish time unknown';
  };
  const label=()=>{if(stage)stage.textContent=stepNumber===1?'Generating base scene':
    'Adding detail · pass '+(stepNumber-1)+' of 2';
    if(detail)detail.textContent=phases[phaseName]||phases.waiting;
    if(meter){meter.style.width='34%';meter.setAttribute?.('aria-label',
      'Step '+stepNumber+' of '+steps+', progress unknown');}
    if(reopen)reopen.textContent='Generation running · '+stepNumber+'/'+steps+' · Show overlay';
  };
  function prepare(){
    const w=globalThis.innerWidth||overlay.clientWidth||1000;
    const h=globalThis.innerHeight||overlay.clientHeight||700;
    const ratio=Math.min(2,globalThis.devicePixelRatio||1);
    size={w,h};canvas.width=Math.max(1,Math.round(w*ratio));
    canvas.height=Math.max(1,Math.round(h*ratio));canvas.style.width=w+'px';canvas.style.height=h+'px';
    ctx.setTransform(ratio,0,0,ratio,0,0);
    const sample=root.createElement('canvas'),c=sample.getContext('2d');
    if(!c){particles=[];return;}
    sample.width=820;sample.height=200;
    c.font='900 176px system-ui, sans-serif';c.textAlign='center';c.textBaseline='middle';
    c.fillStyle='white';c.fillText('PAIGE',410,104,790);
    const pixels=c.getImageData(0,0,820,200).data,spots=[];
    for(let y=5;y<200;y+=4)for(let x=8;x<815;x+=4){
      if(pixels[(y*820+x)*4+3]>120)spots.push({x,y});
    }
    const stride=Math.max(1,Math.ceil(spots.length/1750));
    particles=spots.filter((_,i)=>i%stride===0).map((p,i)=>({
      tx:(p.x-410)*Math.min(w*.00105,1.15),
      ty:(p.y-100)*Math.min(h*.00145,1.2),
      z:Math.sin(i*21.91)*22,
      x:(Math.sin(i*76.97)*w*.48),y:(Math.cos(i*31.57)*h*.42),
      vx:0,vy:0,letter:Math.max(0,Math.min(4,Math.floor(p.x/164))),
      size:.65+Math.abs(Math.sin(i*14.19))*1.05
    }));
  }
  function paint(now){
    if(!active||overlay.hidden||!raf)return;
    if(size.w!==(globalThis.innerWidth||overlay.clientWidth||1000)||
       size.h!==(globalThis.innerHeight||overlay.clientHeight||700))prepare();
    const {w,h}=size;
    ctx.clearRect(0,0,w,h);
    const gradient=ctx.createRadialGradient(w/2,h*.44,15,w/2,h*.44,Math.max(w,h)*.7);
    gradient.addColorStop(0,'#172c36');gradient.addColorStop(1,'#03080d');
    ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);
    const age=(now-operation)/1000;
    const visible=reduced?5:Math.min(5,1+Math.floor(Math.max(0,age)/1.05));
    const cx=w/2,cy=h*.47;
    const maxDist=110;
    for(let i=0;i<particles.length;i++){
      const p=particles[i],enabled=p.letter<visible,tx=enabled?p.tx:p.tx*1.7;
      const ty=enabled?p.ty:p.ty*1.7;
      const px=cx+p.x,py=cy+p.y,dx=px-mouse.x,dy=py-mouse.y;
      const dist=Math.hypot(dx,dy)||1;
      const push=dist<maxDist?(1-dist/maxDist)**2*18:0;
      const ax=(tx-p.x)*(reduced?.3:.033)+(dx/dist)*push;
      const ay=(ty-p.y)*(reduced?.3:.033)+(dy/dist)*push;
      p.vx=(p.vx+ax)*.82;p.vy=(p.vy+ay)*.82;
      p.x+=p.vx;p.y+=p.vy;
      const glow=.6+.4*Math.sin(now*.0015+i*2.1);
      const radius=Math.max(.35,p.size*(1+p.z/150))*(dist<maxDist?1.65:1);
      ctx.beginPath();ctx.arc(cx+p.x,cy+p.y,radius,0,Math.PI*2);
      ctx.fillStyle=i%8===0?'rgba(116,255,229,'+(.55+.35*glow)+')':
        'rgba(208,243,247,'+(.43+.44*glow)+')';
      ctx.fill();
    }
    tickTime();
    prior=now;frame=raf(paint);
  }
  function animate(){if(!active||overlay.hidden||!raf)return;
    if(frame&&cancel)cancel(frame);frame=raf(paint);}
  canvas.addEventListener?.('pointermove',event=>{
    const r=canvas.getBoundingClientRect?.()||{left:0,top:0};
    mouse={x:event.clientX-r.left,y:event.clientY-r.top};
  });
  canvas.addEventListener?.('pointerleave',()=>{mouse={x:-99999,y:-99999};});
  minimize?.addEventListener?.('click',()=>{
    overlay.hidden=true;if(reopen)reopen.hidden=false;
    if(frame&&cancel)cancel(frame);frame=0;
  });
  reopen?.addEventListener?.('click',()=>{
    overlay.hidden=false;reopen.hidden=true;prepare();animate();
  });
  return {
    show({totalStages=1}={}){
      active=true;start=Date.now();operation=globalThis.performance?.now?.()||0;
      stepNumber=1;steps=Math.max(1,Math.min(3,totalStages));phaseName='queued';
      overlay.hidden=false;if(reopen)reopen.hidden=true;prepare();label();tickTime();animate();
    },
    step(n){if(!active)return;stepNumber=Math.min(steps,Math.max(1,n));
      operation=globalThis.performance?.now?.()||0;phaseName='queued';label();},
    phase(value){if(!active)return;if(Object.hasOwn(phases,value))phaseName=value;label();},
    hide(){active=false;overlay.hidden=true;if(reopen)reopen.hidden=true;
      if(frame&&cancel)cancel(frame);frame=0;mouse={x:-99999,y:-99999};}
  };
}
