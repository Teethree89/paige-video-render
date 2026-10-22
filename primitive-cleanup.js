// Conservative, repeatable post-processing for editable AI primitives.
// Operates on validated JSON only. No Three.js dependency or extra AI call.
// Never tries to repair arbitrary intersections or nonplanar meshes.
import {validatePrimitiveDocument} from './primitive-schema.js';

const EPS=0.018;
const TOL=0.002;
const near=(a,b,t=TOL)=>Math.abs(a-b)<=t;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const subtract=(a,b)=>a.map((v,i)=>v-b[i]);
const add=(a,b,k)=>a.map((v,i)=>v+k*b[i]);
const length=v=>Math.sqrt(dot(v,v));

function rotatedAxis(rotation,axis){
  // THREE.Euler default XYZ: matrix Rx * Ry * Rz, applied Z then Y then X.
  let [x,y,z]=axis;
  const [rx,ry,rz]=rotation;
  [x,y]=[x*Math.cos(rz)-y*Math.sin(rz),x*Math.sin(rz)+y*Math.cos(rz)];
  [x,z]=[x*Math.cos(ry)+z*Math.sin(ry),-x*Math.sin(ry)+z*Math.cos(ry)];
  [y,z]=[y*Math.cos(rx)-z*Math.sin(rx),y*Math.sin(rx)+z*Math.cos(rx)];
  return [x,y,z];
}
function basis(item){
  return [[1,0,0],[0,1,0],[0,0,1]].map(axis=>rotatedAxis(item.rotation,axis));
}
function surface(item,thinAxis=null){
  if(item.primitive==='plane'){
    const axis=basis(item);
    return {normal:axis[2],axis,half:[item.scale[0]/2,item.scale[1]/2,0],
      area:item.scale[0]*item.scale[1],thickness:0};
  }
  if(item.primitive!=='box')return null;
  const thin=thinAxis===null?item.scale.indexOf(Math.min(...item.scale)):thinAxis;
  const wide=Math.max(...item.scale);
  // Accept thin glass/window slabs and thin two-axis trim strips, but never
  // nudge large structural boxes or cylindrical/spherical shapes.
  if(item.scale[thin]>.6||item.scale[thin]>.16*wide||wide<.5)return null;
  const area=item.scale[(thin+1)%3]*item.scale[(thin+2)%3];
  return {normal:basis(item)[thin],axis:basis(item),
    half:item.scale.map(v=>v/2),area,thickness:item.scale[thin],thin};
}
function projectedHalf(info,axis){
  return info.half.reduce((sum,h,i)=>sum+h*Math.abs(dot(info.axis[i],axis)),0);
}
function faceOverlaps(detail,info,host,hostAxis){
  const rel=subtract(detail.position,host.position);
  const infoAxes=info.axis,hostAxes=basis(host);
  for(let j=0;j<3;j++){
    if(j===hostAxis)continue;
    const r=Math.abs(dot(rel,hostAxes[j]));
    const span=projectedHalf(info,hostAxes[j]),hostHalf=host.scale[j]/2;
    const intersection=Math.min(r+span,hostHalf)-Math.max(r-span,-hostHalf);
    if(intersection<=Math.min(.012,span*.2))return false;
  }
  return true;
}
function almostDuplicate(a,b){
  if(a.primitive!==b.primitive||a.layer!==b.layer)return false;
  if(!near(a.material.metalness,b.material.metalness,1e-5)||
     !near(a.material.roughness,b.material.roughness,1e-5)||
     a.material.color!==b.material.color)return false;
  return ['position','rotation','scale'].every(key=>
    a[key].every((value,i)=>near(value,b[key][i],1e-5)));
}
function tryMoveOffBox(detail,info,host){
  if(host===detail||host.primitive!=='box'||info.area<.01)return null;
  const hostAxes=basis(host);
  const rel=subtract(detail.position,host.position);
  const hostArea=[0,1,2].map(j=>host.scale[(j+1)%3]*host.scale[(j+2)%3]);
  for(let j=0;j<3;j++){
    if(Math.abs(dot(info.normal,hostAxes[j]))<.9999)continue;
    // Only a smaller decorative element is eligible; never move the wall/roof.
    if(hostArea[j]<info.area*1.35)continue;
    const current=dot(rel,hostAxes[j]);
    const half=host.scale[j]/2;
    const detailHalf=projectedHalf(info,hostAxes[j]);
    // Move when the detailed element intersects or lies flush with one face,
    // but never repair deeply intersecting structural volumes.
    if(Math.abs(Math.abs(current)-half)>Math.max(TOL,detailHalf+TOL))continue;
    if(!faceOverlaps(detail,info,host,j))continue;
    const sign=current>=0?1:-1;
    const desired=sign*(half+detailHalf+EPS);
    const delta=desired-current;
    if(Math.abs(delta)<=TOL||Math.abs(delta)>.25)continue;
    return add(detail.position,hostAxes[j],delta);
  }
  return null;
}
function tryMoveOffPlane(detail,info,other){
  if(detail===other||detail.primitive!=='plane'||other.primitive!=='plane')return null;
  const host=surface(other);
  if(!host||host.area<=info.area*1.1)return null;
  if(Math.abs(dot(info.normal,host.normal))<.9999)return null;
  const separation=dot(subtract(detail.position,other.position),host.normal);
  if(Math.abs(separation)>TOL)return null;
  // Express the smaller plane bounds in host-plane basis.
  const rel=subtract(detail.position,other.position);
  for(let j=0;j<2;j++){
    const distance=Math.abs(dot(rel,host.axis[j]));
    if(distance>=host.half[j]+projectedHalf(info,host.axis[j])-.012)return null;
  }
  const sign=dot(info.normal,host.normal)>=0?1:-1;
  return add(detail.position,host.normal,sign*EPS);
}
export function cleanupPrimitiveDocument(document,allowedShotIds=null){
  const validated=validatePrimitiveDocument(document,allowedShotIds);
  const report={removedDuplicates:0,nudgedOverlaps:0,unchanged:0};
  const scenes=validated.scenes.map(scene=>{
    const objects=[];
    for(const item of scene.objects){
      if(objects.some(earlier=>almostDuplicate(earlier,item))){
        report.removedDuplicates++;
        continue;
      }
      objects.push({...item,position:[...item.position]});
    }
    // Candidate details with the smallest surface area first, so trim goes
    // outward from walls rather than moving architectural masses.
    const candidates=objects.flatMap(item=>{
      if(item.primitive==='plane')return [{item,info:surface(item)}];
      if(item.primitive!=='box')return [];
      return [0,1,2].map(axis=>({item,info:surface(item,axis)}))
        .filter(entry=>entry.info);
    }).sort((a,b)=>a.info.area-b.info.area);
    const adjusted=new Set();
    for(const {item,info} of candidates){
      if(adjusted.has(item))continue;
      let moved=null;
      for(const host of objects){
        moved=tryMoveOffBox(item,info,host)||tryMoveOffPlane(item,info,host);
        if(moved)break;
      }
      if(moved){item.position=moved;report.nudgedOverlaps++;adjusted.add(item);}
    }
    report.unchanged+=objects.length-adjusted.size;
    return {shotId:scene.shotId,objects};
  });
  // Validation after offsets protects strict finite coordinate schema.
  return {document:validatePrimitiveDocument({schemaVersion:1,scenes},allowedShotIds),report};
}
export function cleanupSummary(report){
  return 'Z-fighting cleanup: '+report.removedDuplicates+' duplicates removed, '+
    report.nudgedOverlaps+' overlapping surfaces adjusted.';
}
