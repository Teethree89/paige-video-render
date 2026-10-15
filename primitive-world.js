import * as THREE from 'three';
import {validatePrimitiveDocument} from './primitive-schema.js';

const geometry = type => {
  switch(type) {
    case 'box': return new THREE.BoxGeometry(1,1,1);
    case 'sphere': return new THREE.SphereGeometry(.5,24,16);
    case 'cylinder': return new THREE.CylinderGeometry(.5,.5,1,24);
    case 'plane': return new THREE.PlaneGeometry(1,1);
    case 'torus': return new THREE.TorusGeometry(.42,.12,12,32);
    default: throw Error('Unsupported primitive: '+type);
  }
};

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
        const mesh=new THREE.Mesh(geometry(item.primitive),new THREE.MeshStandardMaterial({
          color:item.material.color,metalness:item.material.metalness,
          roughness:item.material.roughness,side:THREE.DoubleSide
        }));
        mesh.name=item.name;
        mesh.userData.primitiveId=item.id;
        mesh.userData.primitiveType=item.primitive;
        mesh.userData.layer=item.layer||'manual';
        mesh.position.set(...item.position);
        mesh.rotation.set(...item.rotation);
        mesh.scale.set(...item.scale);
        layerGroups.get(key).add(mesh);
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
  function getDocument(){return structuredClone(document);}
  function dispose(){clear();}
  return {setDocument,showShot,hasObjects,getBounds,getSceneForExport,getDocument,dispose};
}
