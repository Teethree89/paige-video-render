import * as THREE from 'three';
import {validatePrimitiveDocument,repeatOffsets} from './primitive-schema.js';

// A unit-depth prism along local Z from a profile in the XY plane; like every
// primitive it fills the unit cube centered on the origin, scaled by `scale`.
const prism = profile => {
  const geometry=new THREE.ExtrudeGeometry(new THREE.Shape(profile.map(([x,y])=>new THREE.Vector2(x,y))),
    {depth:1,bevelEnabled:false});
  geometry.translate(0,0,-.5);
  return geometry;
};
const geometry = item => {
  switch(item.primitive) {
    case 'box': return new THREE.BoxGeometry(1,1,1);
    case 'sphere': return new THREE.SphereGeometry(.5,24,16);
    case 'cylinder': return new THREE.CylinderGeometry(.5,.5,1,24);
    case 'plane': return new THREE.PlaneGeometry(1,1);
    case 'torus': return new THREE.TorusGeometry(.42,.12,12,32);
    case 'cone': return new THREE.CylinderGeometry(0,.5,1,24); // apex up (+Y)
    // Ramp or shed roof: high edge at -X, sloping down to +X.
    case 'wedge': return prism([[-.5,-.5],[.5,-.5],[-.5,.5]]);
    // Pitched roof: ridge along local Z.
    case 'gable': return prism([[-.5,-.5],[.5,-.5],[0,.5]]);
    case 'extrude': {
      // Footprint [x,z] in the ground plane, extruded up from Y=-0.5 to 0.5.
      const shape=new THREE.Shape(item.points.map(([x,z])=>new THREE.Vector2(x,z)));
      const extruded=new THREE.ExtrudeGeometry(shape,{depth:1,bevelEnabled:false});
      extruded.rotateX(Math.PI/2); // shape Y becomes +Z, extrusion becomes -Y
      extruded.translate(0,.5,0);
      return extruded;
    }
    default: throw Error('Unsupported primitive: '+item.primitive);
  }
};
const surface = material => new THREE.MeshStandardMaterial({
  color:material.color,metalness:material.metalness,roughness:material.roughness,
  side:THREE.DoubleSide,
  ...(material.emissive?{emissive:material.emissive,emissiveIntensity:material.emissiveIntensity}:{}),
  // Glass: blended and not written to depth, so geometry behind stays visible.
  ...(material.opacity<1?{transparent:true,opacity:material.opacity,depthWrite:false}:{})
});

export function createPrimitiveWorld(scene) {
  const groups=new Map();
  let document={schemaVersion:1,scenes:[]};
  let activeShotId=null;

  function clear() {
    for(const group of groups.values()){
      scene.remove(group);
      group.traverse(item=>{
        if(item.isMesh){item.geometry.dispose();item.material.dispose();}
      });
    }
    groups.clear();
  }
  function setDocument(value,allowedShotIds=null,anchors={}) {
    const next=validatePrimitiveDocument(value,allowedShotIds);
    clear();document=next;
    for(const entry of next.scenes){
      if(!entry.objects.length)continue;
      const root=new THREE.Group();
      root.name='Primitives_'+entry.shotId;
      root.userData.shotId=entry.shotId;
      const anchor=anchors[entry.shotId]||[0,0,0];
      root.position.set(...anchor);
      const layerGroups=new Map();
      for(const item of entry.objects){
        const key=item.layer||'manual';
        if(!layerGroups.has(key)){
          const layerRoot=new THREE.Group();
          layerRoot.name='Layer_'+key;
          layerRoot.userData.layer=key;
          layerGroups.set(key,layerRoot);root.add(layerRoot);
        }
        const shape=geometry(item),material=surface(item.material);
        const tag=node=>{
          node.userData.primitiveId=item.id;
          node.userData.primitiveType=item.primitive;
          node.userData.layer=item.layer||'manual';
          return node;
        };
        const offsets=repeatOffsets(item.repeat);
        // One copy is the object itself. An array is a group at the object's
        // transform holding one plain mesh per copy (shared geometry and
        // material), so GLB/After Effects see ordinary nodes, not instancing.
        const holder=offsets.length===1?null:tag(new THREE.Group());
        offsets.forEach((offset,index)=>{
          const mesh=tag(new THREE.Mesh(shape,material));
          mesh.name=holder?item.name+' '+(index+1):item.name;
          mesh.scale.set(...item.scale);
          if(holder)mesh.position.set(...offset);
          else{mesh.position.set(...item.position);mesh.rotation.set(...item.rotation);}
          (holder||layerGroups.get(key)).add(mesh);
        });
        if(holder){
          holder.name=item.name;
          holder.position.set(...item.position);
          holder.rotation.set(...item.rotation);
          layerGroups.get(key).add(holder);
        }
      }
      root.visible=false;
      groups.set(entry.shotId,root);
      scene.add(root);
    }
    showShot(activeShotId);
  }
  function hasObjects(shotId){return groups.has(shotId);}
  function getBounds(shotId){
    const root=groups.get(shotId);
    if(!root)return null;
    // Include the shot anchor and every rotated/scaled primitive.
    const bounds=new THREE.Box3().setFromObject(root);
    if(bounds.isEmpty())return null;
    const sphere=bounds.getBoundingSphere(new THREE.Sphere());
    return {center:sphere.center.toArray(),radius:sphere.radius};
  }
  function showShot(shotId){
    activeShotId=shotId;
    for(const [id,root] of groups)root.visible=id===shotId;
  }
  function getSceneForExport(shotId){
    const root=groups.get(shotId);
    if(!root)throw Error('No primitive scene for '+shotId);
    const copy=root.clone(true);
    copy.visible=true;
    copy.name='Editable_primitives_'+shotId;
    return copy;
  }
  // The model's estimate of the reference camera, in world space (the shot
  // anchor applied). Used to frame previews; never written to camera keys.
  function getCamera(shotId){
    const entry=document.scenes.find(scene=>scene.shotId===shotId);
    const root=groups.get(shotId);
    if(!entry?.camera||!root)return null;
    const at=point=>point.map((n,i)=>n+root.position.getComponent(i));
    return {position:at(entry.camera.position),target:at(entry.camera.target),fov:entry.camera.fov};
  }
  function getDocument(){return structuredClone(document);}
  function dispose(){clear();}
  return {setDocument,showShot,hasObjects,getBounds,getCamera,getSceneForExport,getDocument,dispose};
}
