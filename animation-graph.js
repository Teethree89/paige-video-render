import {curveEasing,setCameraCurve,CURVE_MODES} from './animation-curves.js';
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const colors=['#78e9dc','#eac08a','#ad9cea','#d1e5ef'];
export function setupAnimationGraph({getSequence,getSelected,onCommit}){
 const panel=document.getElementById('cameraPanel');
 if(!panel)return null;
 const section=document.createElement('section');
 section.className='animation-curve-panel';
 section.innerHTML=`
   <div class="section-label">ANIMATION CURVES</div>
   <p class="field-help">The selected key controls motion toward the next camera key. Cut keys jump instantly.</p>
   <label class="field">Keyframe interpolation
    <select id="cameraCurveMode">
     <option value="smooth">Smooth · Legacy</option><option value="linear">Linear</option>
     <option value="ease-in">Ease in</option><option value="ease-out">Ease out</option>
     <option value="hold">Hold / step</option><option value="bezier">Custom cubic Bézier</option>
    </select>
   </label>
   <canvas id="cameraEaseGraph" width="440" height="205" role="img"
     aria-label="Editable Bézier easing curve with two draggable handles"></canvas>
   <div id="cameraCurveHandles" class="curve-handle-fields" hidden>
    <label>IN X<input id="curveInX" type="number" min="0" max="1" step="0.01"></label>
    <label>IN Y<input id="curveInY" type="number" min="0" max="1" step="0.01"></label>
    <label>OUT X<input id="curveOutX" type="number" min="0" max="1" step="0.01"></label>
    <label>OUT Y<input id="curveOutY" type="number" min="0" max="1" step="0.01"></label>
   </div>
   <div class="section-label">KEY VALUE GRAPH</div>
   <canvas id="cameraValueGraph" width="440" height="160" role="img"
     aria-label="Camera position X Y Z and field-of-view animation curves"></canvas>
   <p id="curveGraphStatus" class="field-help" role="status">Choose a camera key to edit its outgoing curve.</p>`;
 panel.append(section);
 const textPanel=document.getElementById('textPanel');
 if(textPanel){
   const holder=document.createElement('label');holder.className='field';
   holder.textContent='Text fade interpolation';
   const fade=document.createElement('select');fade.id='textFadeMode';
   for(const [value,label] of [['linear','Linear (original)'],['smooth','Smooth'],
     ['ease-in','Ease in'],['ease-out','Ease out'],['hold','Hold / step']]){
     const option=document.createElement('option');option.value=value;option.textContent=label;fade.append(option);
   }
   holder.append(fade);textPanel.append(holder);
   fade.addEventListener('change',()=>{
     const selected=getSelected(),seq=structuredClone(getSequence());
     const item=seq.text?.find(x=>x.id===selected?.id);
     if(!item)return;
     item.textFade=fade.value;
     try{onCommit(seq);}catch(error){const node=document.getElementById('curveGraphStatus');if(node)node.textContent=error.message;}
   });
 }
 const el=id=>document.getElementById(id);
 const mode=el('cameraCurveMode'),ease=el('cameraEaseGraph'),graph=el('cameraValueGraph');
 const status=el('curveGraphStatus'),inputs=['curveInX','curveInY','curveOutX','curveOutY'].map(el);
 let editHandle=-1,moving=false;
 const current=()=>getSequence()?.camera?.find(x=>x.id===getSelected()?.id);
 const output=()=>{
   const selected=current(),m=mode.value;
   if(!selected)return;
   const handles=inputs.map(i=>clamp(Number(i.value)||0,0,1));
   try{onCommit(setCameraCurve(getSequence(),selected.id,
     m==='bezier'?{mode:m,handles}:{mode:m}));status.textContent='Curve saved to timeline JSON.';}
   catch(err){status.textContent=err.message;}
 };
 const coord=(canvas,event)=>{
   const r=canvas.getBoundingClientRect();
   return {x:(event.clientX-r.left)/r.width,y:(event.clientY-r.top)/r.height};
 };
 const scale={left:29,right:12,top:13,bottom:25};
 function drawEase(curve){
   const ctx=ease.getContext('2d');if(!ctx)return;
   const w=ease.width,h=ease.height,dx=w-scale.left-scale.right,dy=h-scale.top-scale.bottom;
   const x=t=>scale.left+t*dx,y=v=>h-scale.bottom-clamp(v,0,1)*dy;
   ctx.clearRect(0,0,w,h);ctx.fillStyle='#091825';ctx.fillRect(0,0,w,h);
   ctx.strokeStyle='#264052';ctx.lineWidth=1;
   for(let i=0;i<=4;i++){const t=i/4;ctx.beginPath();ctx.moveTo(x(t),scale.top);
     ctx.lineTo(x(t),h-scale.bottom);ctx.stroke();ctx.beginPath();ctx.moveTo(scale.left,y(t));
     ctx.lineTo(w-scale.right,y(t));ctx.stroke();}
   ctx.strokeStyle='#8feada';ctx.lineWidth=2.5;ctx.beginPath();
   for(let i=0;i<=100;i++){const t=i/100;if(i===0)ctx.moveTo(x(t),y(curveEasing(t,curve)));
     else ctx.lineTo(x(t),y(curveEasing(t,curve)));}
   ctx.stroke();
   if(curve?.mode==='bezier'){
     const [x1,y1,x2,y2]=curve.handles;
     ctx.strokeStyle='#7798ac';ctx.lineWidth=1.2;ctx.beginPath();
     ctx.moveTo(x(0),y(0));ctx.lineTo(x(x1),y(y1));
     ctx.moveTo(x(1),y(1));ctx.lineTo(x(x2),y(y2));ctx.stroke();
     for(const [cx,cy] of [[x1,y1],[x2,y2]]){
       ctx.beginPath();ctx.arc(x(cx),y(cy),7,0,Math.PI*2);
       ctx.fillStyle='#b5fbec';ctx.fill();ctx.lineWidth=1.4;ctx.strokeStyle='#113b46';ctx.stroke();
     }
   }
   ctx.fillStyle='#8faeba';ctx.font='11px sans-serif';
   ctx.fillText('0',scale.left-7,h-7);ctx.fillText('1',w-scale.right-8,h-7);
 }
 function drawValues(){
   const keys=[...getSequence().camera].sort((a,b)=>a.at-b.at);
   const ctx=graph.getContext('2d');if(!ctx)return;
   const w=graph.width,h=graph.height,L=34,R=12,T=12,B=23;
   ctx.clearRect(0,0,w,h);ctx.fillStyle='#0a1825';ctx.fillRect(0,0,w,h);
   ctx.strokeStyle='#2e4557';ctx.lineWidth=1;
   for(let i=0;i<=4;i++){const yy=T+(h-T-B)*i/4;ctx.beginPath();ctx.moveTo(L,yy);ctx.lineTo(w-R,yy);ctx.stroke();}
   if(keys.length<2)return;
   const values=[k=>k.p[0],k=>k.p[1],k=>k.p[2],k=>k.fov];
   const total=Math.max(.001,getSequence().duration);
   values.forEach((read,j)=>{
     const all=keys.map(read),lo=Math.min(...all),hi=Math.max(...all),range=Math.max(.001,hi-lo);
     ctx.beginPath();
     for(let n=0;n<=200;n++){
       const t=total*n/200;
       const a=keys.findIndex((key,i)=>i<keys.length-1&&key.at<=t&&t<keys[i+1].at);
       const key=a<0?keys[keys.length-1]:keys[a],next=a<0?key:keys[a+1];
       const t0=a<0?1:curveEasing((t-key.at)/(next.at-key.at),key.curve);
       const v=read(key)+(read(next)-read(key))*(next.cut?0:t0);
       const x=L+n/200*(w-L-R),y=h-B-(v-lo)/range*(h-T-B);
       if(n===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
     }
     ctx.strokeStyle=colors[j];ctx.lineWidth=j===3?1.4:1.8;ctx.stroke();
     ctx.fillStyle=colors[j];ctx.font='10px sans-serif';
     ctx.fillText(['X','Y','Z','FOV'][j],L+8+j*42,14);
   });
   const selected=current();
   if(selected){const x=L+selected.at/total*(w-L-R);
     ctx.strokeStyle='#ffffff99';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,T);ctx.lineTo(x,h-B);ctx.stroke();}
 }
 function refresh(){
   const key=current();if(!key){status.textContent='Select a camera key to edit its outgoing curve.';return;}
   const curve=key.curve||{mode:'smooth'};
   mode.value=CURVE_MODES.includes(curve.mode)?curve.mode:'smooth';
   el('cameraCurveHandles').hidden=mode.value!=='bezier';
   const handles=curve.mode==='bezier'?curve.handles:[.25,.1,.75,.9];
   for(let i=0;i<4;i++)inputs[i].value=Number(handles[i].toFixed(2));
   drawEase(curve);drawValues();
   status.textContent='Camera key at '+key.at.toFixed(2)+' s · '+mode.value;
 }
 mode.addEventListener('change',()=>{
   el('cameraCurveHandles').hidden=mode.value!=='bezier';
   if(mode.value==='bezier')for(let i=0;i<4;i++)inputs[i].value=[.25,.1,.75,.9][i];
   output();refresh();
 });
 inputs.forEach(input=>input.addEventListener('change',()=>{output();refresh();}));
 ease.addEventListener('pointerdown',event=>{
   if(mode.value!=='bezier')return;
   const pos=coord(ease,event),h=inputs.map(i=>Number(i.value));
   const W=ease.width,H=ease.height;
   const normX=(pos.x*W-scale.left)/(W-scale.left-scale.right);
   const normY=(H*(1-pos.y)-scale.bottom)/(H-scale.top-scale.bottom);
   const d0=Math.hypot(normX-h[0],normY-h[1]),d1=Math.hypot(normX-h[2],normY-h[3]);
   editHandle=d0<=d1?0:2;moving=true;
   ease.setPointerCapture(event.pointerId);event.preventDefault();
 });
 ease.addEventListener('pointermove',event=>{
   if(!moving||editHandle<0)return;
   const pos=coord(ease,event),W=ease.width,H=ease.height;
   const x=clamp((pos.x*W-scale.left)/(W-scale.left-scale.right),0,1);
   const y=clamp((H*(1-pos.y)-scale.bottom)/(H-scale.top-scale.bottom),0,1);
   inputs[editHandle].value=x.toFixed(2);
   inputs[editHandle+1].value=y.toFixed(2);
   drawEase({mode:'bezier',handles:inputs.map(i=>Number(i.value))});
 });
 ease.addEventListener('pointerup',()=>{
   if(!moving)return;moving=false;editHandle=-1;output();refresh();
 });
 ease.addEventListener('pointercancel',()=>{moving=false;editHandle=-1;refresh();});
 return {refresh};
}
