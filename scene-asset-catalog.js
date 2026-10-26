// Editable low-poly starter assets for the radial Create wheel.
// No imported model downloads or provider calls: every preset is ordinary
// scene v1 geometry (and/or punctual lights), editable and GLB-exportable.
import {makePrimitive,validatePrimitiveDocument,LIMITS} from './primitive-schema.js';
export const CREATE_CATEGORIES=Object.freeze([
 {id:'lights',label:'Lights',glyph:'☀',items:[
  ['point-warm','Warm point light'],['point-white','White point light'],
  ['point-blue','Blue point light'],['point-red','Red accent light'],
  ['spot-warm','Warm spotlight'],['spot-cool','Cool spotlight'],
  ['sun','Directional sun']]},
 {id:'primitives',label:'Primitives',glyph:'⬡',items:[
  ['box','Box'],['sphere','Sphere'],['cylinder','Cylinder'],['cone','Cone'],
  ['plane','Plane'],['torus','Torus'],['wedge','Ramp'],['gable','Pitched roof'],['extrude','Footprint']]},
 {id:'vegetation',label:'Vegetation',glyph:'♣',items:[
  ['pine','Pine tree'],['deciduous','Leafy tree'],['shrub','Shrub'],['grass','Grass clump']]},
 {id:'vehicles',label:'Vehicles',glyph:'▣',items:[
  ['car','Car blockout'],['truck','Cargo truck'],['van','Delivery van'],['forklift','Forklift']]},
 {id:'structures',label:'Structures',glyph:'▤',items:[
  ['wall','Wall'],['column','Column'],['door','Door'],['window','Glowing window']]},
 {id:'props',label:'Props',glyph:'✦',items:[
  ['crate','Crate'],['barrel','Barrel'],['bollard','Bollard'],['lamp-post','Streetlamp']]},
 {id:'terrain',label:'Terrain',glyph:'▱',items:[
  ['ground','Ground plane'],['road','Road slab'],['water','Water plane'],['platform','Platform']]}
]);
export const CREATE_DEFAULTS=Object.freeze(Object.fromEntries(CREATE_CATEGORIES.map(c=>[c.id,c.items[0][0]])));
const simple=new Set(['box','sphere','cylinder','cone','plane','torus','wedge','gable','extrude']);
const layerFor={vegetation:'vegetation',vehicles:'details',structures:'structures',props:'details',terrain:'ground'};
const lightSpec=(id,p,origin)=>({
 id,type:id==='sun'?'directional':id.startsWith('spot')?'spot':'point',
 name:id.replaceAll('-',' ')+' light',
 color:id.includes('warm')?'#ffd2a0':id.includes('blue')?'#80bcff':id.includes('red')?'#ff655c':
  id.includes('cool')?'#c9e9ff':'#ffffff',
 // Candela values must be high enough to compete with the base hemisphere/sun fill.
 intensity:id==='sun'?2.1:id.startsWith('spot')?240:180,
 position:[origin[0],origin[1]+4,origin[2]+3],
 target:[origin[0],origin[1],origin[2]],
 distance:28,angle:.53,penumbra:.35
});
const specs={
 pine:[['cylinder',[.8,3,.8],[0,1.5,0],'#725438'],['cone',[3.5,6,3.5],[0,5,0],'#28563b']],
 deciduous:[['cylinder',[.85,4,.85],[0,2,0],'#674a31'],['sphere',[5,4.6,5],[0,5.3,0],'#467449']],
 shrub:[['sphere',[3,2.2,3],[0,1,0],'#446d37']],
 grass:[['cone',[.6,2,.6],[-.7,1,0],'#5b8b39'],['cone',[.6,2,.6],[0,1.1,.4],'#699947'],['cone',[.6,2,.6],[.7,.8,-.2],'#477a3d']],
 car:[['box',[4.6,1.4,2.3],[0,1.2,0],'#4c8faa'],['box',[2.3,1.1,2],[-.2,2.2,0],'#87b7c3'],['cylinder',[.8,.55,.8],[-1.4,.58,-1.13],'#1b2933'],['cylinder',[.8,.55,.8],[1.4,.58,-1.13],'#1b2933'],['cylinder',[.8,.55,.8],[-1.4,.58,1.13],'#1b2933'],['cylinder',[.8,.55,.8],[1.4,.58,1.13],'#1b2933']],
 truck:[['box',[5,2.7,2.7],[-1.4,2.3,0],'#526b75'],['box',[2.4,2.4,2.5],[2.2,2.1,0],'#4895a3'],['box',[8,.45,2.6],[0,.95,0],'#223540'],['cylinder',[1,.7,1],[-2.4,.55,-1.2],'#212a30'],['cylinder',[1,.7,1],[2.7,.55,-1.2],'#212a30'],['cylinder',[1,.7,1],[-2.4,.55,1.2],'#212a30'],['cylinder',[1,.7,1],[2.7,.55,1.2],'#212a30']],
 van:[['box',[5,2.8,2.5],[0,2,0],'#b0b7ba'],['box',[.06,1,2.2],[2.54,2.5,0],'#547d8c'],['cylinder',[.85,.5,.85],[-1.45,.5,-1.1],'#1d2a32'],['cylinder',[.85,.5,.85],[1.45,.5,-1.1],'#1d2a32'],['cylinder',[.85,.5,.85],[-1.45,.5,1.1],'#1d2a32'],['cylinder',[.85,.5,.85],[1.45,.5,1.1],'#1d2a32']],
 forklift:[['box',[3,1.2,2],[0,1.1,0],'#d5a34c'],['box',[1.5,.2,2],[-.4,3.1,0],'#26343a'],['box',[.25,3,.25],[.9,2.3,-.9],'#26343a'],['box',[.25,3,.25],[.9,2.3,.9],'#26343a'],['box',[2,.1,.4],[2.1,.5,-.5],'#a7b5b5'],['box',[2,.1,.4],[2.1,.5,.5],'#a7b5b5']],
 wall:[['box',[10,5,.4],[0,2.5,0],'#71858a']],
 column:[['cylinder',[1,7,1],[0,3.5,0],'#9da9ac']],
 door:[['box',[2.4,4,.2],[0,2,0],'#6b7c83']],
 window:[['box',[3.5,2.6,.15],[0,2,0],'#264a57']],
 crate:[['box',[2,2,2],[0,1,0],'#867052']],
 barrel:[['cylinder',[1.6,2.4,1.6],[0,1.2,0],'#737f8a']],
 bollard:[['cylinder',[.42,1.3,.42],[0,.65,0],'#c7b37b']],
 'lamp-post':[['cylinder',[.18,7,.18],[0,3.5,0],'#48565d'],['sphere',[.75,.55,.75],[0,7.3,0],'#fff1cc']],
 ground:[['plane',[40,40,1],[0,0,0],'#506057']],
 road:[['box',[15,.15,45],[0,0,0],'#32393d']],
 water:[['plane',[30,30,1],[0,.01,0],'#38768d']],
 platform:[['box',[13,1.2,13],[0,.6,0],'#546876']]
};
export function validateCreateChoice(category,id){
 const cat=CREATE_CATEGORIES.find(c=>c.id===category);
 if(!cat||!cat.items.some(p=>p[0]===id))throw Error('Unrecognized Create preset');
 return cat;
}
export function insertCreatedAsset(source,shotId,category,id,origin=[0,0,0]){
 validateCreateChoice(category,id);
 if(!Array.isArray(origin)||origin.length!==3||origin.some(n=>!Number.isFinite(n)||Math.abs(n)>9900))
  throw Error('Create position must be a local finite 3D position');
 const doc=validatePrimitiveDocument(source);
 let entry=doc.scenes.find(x=>x.shotId===shotId);
 if(!entry){entry={shotId,objects:[]};doc.scenes.push(entry);}
 let selected=null;
 const unique=(prefix,taken)=>{
   let i=1,ref=prefix;while(taken.has(ref)){ref=prefix+'_'+(++i);}
   taken.add(ref);return ref;
 };
 const used=new Set(entry.objects.map(x=>x.id));
 if(category==='lights'){
   entry.lights??=[];
   const spec=lightSpec(id,id,origin),ids=new Set(entry.lights.map(x=>x.id));
   spec.id=unique('light',ids);
   if(spec.type==='point')delete spec.target;
   if(spec.type==='directional'){delete spec.distance;delete spec.angle;delete spec.penumbra;}
   if(spec.type==='spot'){/* keep spotlight settings */}
   if(spec.type==='point'){delete spec.angle;delete spec.penumbra;}
   entry.lights.push(spec);
   selected={kind:'light',id:spec.id};
 }else{
   const pieces=simple.has(id)&&category==='primitives'?
     [[id,null,[0,1,0],'#72c9db']] : specs[id];
   if(!pieces)throw Error('Unknown scene asset');
   const layer=layerFor[category];
   for(const [shape,scale,offset,color] of pieces){
     const objectId=unique(shape,used);
     const obj=makePrimitive(shape,objectId,[
       origin[0]+offset[0],origin[1]+offset[1],origin[2]+offset[2]]);
     obj.name=(id.replaceAll('-',' ')+' '+shape).slice(0,100);
     if(scale)obj.scale=[...scale];
     obj.material.color=color;
     if(id==='window'||id==='water'||id==='lamp-post'&&shape==='sphere'){
       obj.material.emissive=color;obj.material.emissiveIntensity=id==='window'?1.4:0.5;
     }
     if(layer)obj.layer=layer;
     if(shape==='plane'&&category==='terrain')obj.rotation=[-Math.PI/2,0,0];
     if(shape==='cylinder'&&category==='vehicles')obj.rotation=[Math.PI/2,0,0];
     entry.objects.push(obj);selected={kind:'object',id:obj.id};
   }
 }
 return {document:validatePrimitiveDocument(doc),selected};
}
