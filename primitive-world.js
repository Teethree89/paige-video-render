import * as THREE from 'three';
import {validatePrimitiveDocument,repeatOffsets,lightCastsShadow} from './primitive-schema.js';

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

// Lights live in their shot's group, so they shine only while it is shown.
// Directional and spot lights aim along their own -Z at the target, which is
// kept as a child at (0,0,-1): glTF exports that direction exactly.
// Shader samplers for shadow maps consume the GPU's texture-unit limit.
// Limit shadow *casters*, not lights: all authored/array lights still shine,
// remain editable and survive GLB export. A scene may have many light nodes.
export const MAX_PRIMITIVE_SHADOW_MAPS=4;
const light = (spec,castShadow=false,cacheShadow=false) => {
  const color=new THREE.Color(spec.color);
  const node=spec.type==='directional'?new THREE.DirectionalLight(color,spec.intensity)
    :spec.type==='spot'?new THREE.SpotLight(color,spec.intensity,spec.distance,spec.angle,spec.penumbra)
    :new THREE.PointLight(color,spec.intensity,spec.distance);
  node.name=spec.name;
  node.userData.primitiveLight=spec.type;
  // Keep the authored choice in GLB extras even if the chapter shadow budget
  // is full. Point shadows are opt-in because a cube map takes six renders.
  node.userData.castShadow=lightCastsShadow(spec);
  node.castShadow=castShadow;
  if(node.castShadow){
    // Accepted primitive geometry is static between edits; orbiting or
    // playing a camera move does not change its light-space shadow map.
    node.shadow.autoUpdate=!cacheShadow;
    node.shadow.needsUpdate=true;
    node.shadow.mapSize.set(512,512);
    node.shadow.bias=-0.0002;
    node.shadow.normalBias=0.025;
    if(spec.type==='directional'){
      const span=40;
      node.shadow.camera.left=-span;node.shadow.camera.right=span;
      node.shadow.camera.top=span;node.shadow.camera.bottom=-span;
      node.shadow.camera.near=0.1;node.shadow.camera.far=400;
    }else{
      node.shadow.camera.near=0.1;
      node.shadow.camera.far=spec.distance||100;
    }
  }
  node.position.set(...spec.position);
  if(node.target){
    const target=new THREE.Vector3(...spec.target);
    // Straight up or down is parallel to the default up axis, where lookAt
    // has to perturb the aim; any other up keeps a downlight exact.
    if(Math.abs(target.clone().sub(node.position).normalize().y)>.999)node.up.set(0,0,1);
    node.lookAt(target);
    node.target.position.set(0,0,-1);
    node.target.userData.lightTarget=true;
    node.add(node.target);
  }
  return node;
};

export function createPrimitiveWorld(scene) {
  const groups=new Map();
  // Saved primitive ID -> top-level transform node (repeat arrays share one holder).
  const objectNodes=new Map(),arrayInstances=new Map(),lightNodes=new Map(),lightMarkers=new Map(),lightTargets=new Map(),lightGuides=new Map(),lightMarkerGroups=new Map();
  const shadowLights=new Map();
  let markersEnabled=false;
  let document={schemaVersion:1,scenes:[]};
  let activeShotId=null;

  function clear() {
    const geometries=new Set(),materials=new Set();
    const disposeResources=node=>{
      if(node.geometry&&!geometries.has(node.geometry)){
        geometries.add(node.geometry);node.geometry.dispose();
      }
      for(const material of node.material?[node.material].flat():[]){
        if(!materials.has(material)){materials.add(material);material.dispose();}
      }
      if(node.isLight)node.dispose();
    };
    for(const group of groups.values()){
      scene.remove(group);
      group.traverse(disposeResources);
    }
    groups.clear();objectNodes.clear();arrayInstances.clear();lightNodes.clear();shadowLights.clear();
    for(const root of lightMarkerGroups.values()){
      scene.remove(root);
      root.traverse(disposeResources);
    }
    lightMarkerGroups.clear();lightMarkers.clear();lightTargets.clear();lightGuides.clear();
  }
  function setDocument(value,allowedShotIds=null,anchors={}) {
    const next=validatePrimitiveDocument(value,allowedShotIds);
    clear();document=next;
    for(const entry of next.scenes){
      // A shot with geometry replaces the original world; lights alone do not.
      if(!entry.objects.length&&!(entry.lights?.length))continue;
      const root=new THREE.Group();
      root.name='Primitives_'+entry.shotId;
      root.userData.shotId=entry.shotId;
      const anchor=anchors[entry.shotId]||[0,0,0];
      root.position.set(...anchor);
      const layerGroups=new Map(),nodes=new Map(),arrays=new Map();
      // Reserve up to two of four maps for explicit chapter lights; repeated
      // lamps use the rest without making the renderer exceed 16 samplers.
      const authoredShadows=(entry.lights||[]).filter(lightCastsShadow).length;
      const reserved=Math.min(2,authoredShadows);
      let arrayShadowSlots=MAX_PRIMITIVE_SHADOW_MAPS-reserved;
      let usedShadowSlots=0;
      const casters=[];
      for(const item of entry.objects){
        const key=item.layer||'manual';
        if(!layerGroups.has(key)){
          const layerRoot=new THREE.Group();
          layerRoot.name='Layer_'+key;
          layerRoot.userData.layer=key;
          layerGroups.set(key,layerRoot);root.add(layerRoot);
        }
        // An assembly parent is a real Three.Group with no phantom mesh.
        const groupOnly=item.primitive==='group';
        const shape=groupOnly?null:geometry(item);
        const material=groupOnly?null:surface(item.material);
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
        const hasParts=groupOnly||!!(item.arrayParts?.objects?.length||item.arrayParts?.lights?.length);
        // Copies share immutable prototype geometry/materials while keeping
        // ordinary Mesh nodes for independent picking, editing and export.
        const objects=item.arrayParts?.objects||[],lights=item.arrayParts?.lights||[];
        const members=new Map([
          ...objects.map(part=>['object:'+part.id,{kind:'object',part,
            shape:geometry(part),material:surface(part.material)}]),
          ...lights.map(part=>['light:'+part.id,{kind:'light',part}])
        ]);
        const order=item.arrayParts?.order||[...members.keys()];
        // Composite single assets also need a transform holder so moving the
        // selection moves every part; only actual repeats are indexed arrays.
        const holder=offsets.length===1&&!hasParts?null:tag(new THREE.Group());
        const instances=[];
        let directMesh=null;
        offsets.forEach((offset,index)=>{
          const mesh=groupOnly?null:tag(new THREE.Mesh(shape,material));
          if(mesh){
            mesh.castShadow=true;mesh.receiveShadow=true;
            mesh.userData.primitiveArrayIndex=item.repeat?index:null;
            if(!holder)directMesh=mesh;
            mesh.name=holder?item.name+' '+(index+1):item.name;
            mesh.scale.set(...item.scale);
          }
          // With prototype components, this is an actual repeated assembly:
          // a shared instance group carries the source mesh, additions and
          // shot-local punctual lights in exactly the same local frame.
          if(hasParts){
            const instance=tag(new THREE.Group());
            instance.name=item.name+' instance '+(index+1);
            instance.userData.primitiveArrayIndex=item.repeat?index:null;
            instance.position.set(...offset);
            // Rotate each copy's prototype in place, NOT the row's offset axes.
            instance.rotation.set(...(item.instanceRotation||[0,0,0]));
            if(mesh)instance.add(mesh);
            for(const id of order){
              const member=members.get(id);
              if(!member)continue;
              const {kind,part}=member;
              if(kind==='object'){
                const extra=new THREE.Mesh(member.shape,member.material);
                extra.name=part.name+' '+(index+1);
                extra.userData.primitiveId=item.id;
                extra.userData.primitiveArrayIndex=item.repeat?index:null;
                extra.userData.primitiveArrayPartId=part.id;
                extra.position.set(...part.position);
                extra.rotation.set(...part.rotation);
                extra.scale.set(...part.scale);
                extra.castShadow=true;extra.receiveShadow=true;
                instance.add(extra);
              }else{
                const shadows=lightCastsShadow(part)&&arrayShadowSlots>0;
                if(shadows){arrayShadowSlots--;usedShadowSlots++;}
                const node=light(part,shadows,true);
                if(shadows)casters.push(node);
                node.userData.primitiveArrayPartId=part.id;
                instance.add(node);
              }
            }
            holder.add(instance);instances.push(instance);
          }else{
            if(holder){
              mesh.position.set(...offset);
              mesh.rotation.set(...(item.instanceRotation||[0,0,0]));
            }else{
              mesh.position.set(...item.position);
              mesh.rotation.set(...item.rotation);
            }
            (holder||layerGroups.get(key)).add(mesh);
            if(holder)instances.push(mesh);
          }
        });
        if(item.repeat)arrays.set(item.id,instances);
        if(holder){
          holder.name=item.name;
          holder.position.set(...item.position);
          holder.rotation.set(...item.rotation);
          layerGroups.get(key).add(holder);
        }
        nodes.set(item.id,holder||directMesh);
      }
      const actualLights=new Map();
      (entry.lights||[]).forEach((spec,index)=>{
        const id=spec.id||'light_'+(index+1);
        const shadows=lightCastsShadow(spec)&&
          usedShadowSlots<MAX_PRIMITIVE_SHADOW_MAPS;
        if(shadows)usedShadowSlots++;
        const source=light(spec,shadows,entry.objects.length>0);
        if(shadows)casters.push(source);
        root.add(source);actualLights.set(id,source);
      });
      lightNodes.set(entry.shotId,actualLights);
      shadowLights.set(entry.shotId,casters);
      root.visible=false;
      // Editor-only light markers stay OUTSIDE the model root, so GLB,
      // Three.js flythrough and After Effects packages never contain gizmos.
      const markerRoot=new THREE.Group();
      markerRoot.name='Editor_light_markers_'+entry.shotId;
      markerRoot.position.set(...anchor);
      const markers=new Map(),targets=new Map(),guides=new Map();
      (entry.lights||[]).forEach((spec,index)=>{
        const id=spec.id||'light_'+(index+1);
        // Light markers are editor-only, unlit/pickable bulb icons; do not
        // suggest a solid geometric cube or block light rays.
        const marker=new THREE.Mesh(
          new THREE.SphereGeometry(.2,12,8),
          new THREE.MeshBasicMaterial({color:spec.color,depthTest:false,depthWrite:false,
            transparent:true,opacity:.96}));
        marker.name='Editor light '+spec.name;
        const rays=[];
        for(let axis=0;axis<3;axis++)for(const sign of [-1,1]){
          const inner=[0,0,0],outer=[0,0,0];
          inner[axis]=sign*.29;outer[axis]=sign*.48;
          rays.push(...inner,...outer);
        }
        const rayGeometry=new THREE.BufferGeometry();
        rayGeometry.setAttribute('position',
          new THREE.Float32BufferAttribute(rays,3));
        const rayGlyph=new THREE.LineSegments(rayGeometry,new THREE.LineBasicMaterial({
          color:spec.color,depthTest:false,depthWrite:false,transparent:true,opacity:.9}));
        rayGlyph.renderOrder=995;
        marker.add(rayGlyph);
        marker.position.set(...spec.position);
        marker.userData.primitiveLightId=id;
        marker.renderOrder=994;
        markerRoot.add(marker);markers.set(id,marker);
        if(spec.type!=='point'){
          // Actual light direction: the ray and its endpoint use the exact same
          // shot-local source/target coordinates as the serialized light.
          // Unlike light glyphs these helpers have no dynamic world scaling.
          const endpoint=new THREE.Mesh(
            new THREE.SphereGeometry(.15,12,8),
            new THREE.MeshBasicMaterial({color:0xf3fffd,depthTest:false,
              depthWrite:false,transparent:true,opacity:.95}));
          endpoint.position.set(...spec.target);
          endpoint.name='Aim target '+spec.name;
          endpoint.userData.primitiveLightTargetId=id;
          endpoint.renderOrder=995;
          markerRoot.add(endpoint);
          targets.set(id,endpoint);
          const path=new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(...spec.position),new THREE.Vector3(...spec.target)]);
          const line=new THREE.Line(path,new THREE.LineBasicMaterial({
            color:spec.color,transparent:true,opacity:.76,depthTest:false,
            depthWrite:false}));
          line.name='Aim direction '+spec.name;
          line.renderOrder=992;
          line.frustumCulled=false;
          markerRoot.add(line);
          const arrow=new THREE.Mesh(
            new THREE.ConeGeometry(1,2.3,8),
            new THREE.MeshBasicMaterial({color:spec.color,depthTest:false,
              depthWrite:false}));
          arrow.name='Aim arrow '+spec.name;arrow.renderOrder=993;
          markerRoot.add(arrow);
          guides.set(id,{line,arrow,source:marker,target:endpoint});
        }
      });
      markerRoot.visible=false;
      lightMarkerGroups.set(entry.shotId,markerRoot);
      lightMarkers.set(entry.shotId,markers);
      lightTargets.set(entry.shotId,targets);
      lightGuides.set(entry.shotId,guides);
      groups.set(entry.shotId,root);
      objectNodes.set(entry.shotId,nodes);
      arrayInstances.set(entry.shotId,arrays);
      scene.add(root);
      scene.add(markerRoot); // keep the scene's primary root first for existing integrations
    }
    showShot(activeShotId);
  }
  function hasObjects(shotId){return document.scenes.some(s=>s.shotId===shotId&&s.objects.length>0);}
  function hasSceneContent(shotId){
    return document.scenes.some(s=>s.shotId===shotId&&(s.objects.length>0||(s.lights?.length||0)>0));
  }
  function getBounds(shotId){
    const root=groups.get(shotId);
    if(!root)return null;
    // Include the shot anchor and every rotated/scaled primitive.
    const bounds=new THREE.Box3().setFromObject(root);
    if(bounds.isEmpty()){
      // Lights are Object3D nodes with no mesh geometry. A lights-only shot
      // still needs bounds so Edit mode can frame its light gizmo.
      const entry=document.scenes.find(s=>s.shotId===shotId);
      for(const spec of entry?.lights||[])
        bounds.expandByPoint(new THREE.Vector3(...spec.position).add(root.position));
    }
    if(bounds.isEmpty())return null;
    const sphere=bounds.getBoundingSphere(new THREE.Sphere());
    sphere.radius=Math.max(sphere.radius,1);
    return {center:sphere.center.toArray(),radius:sphere.radius};
  }
  function showShot(shotId){
    if(activeShotId!==shotId)invalidateShadows(shotId);
    activeShotId=shotId;
    for(const [id,root] of groups)root.visible=id===shotId;
    for(const [id,root] of lightMarkerGroups)
      root.visible=markersEnabled&&id===shotId;
  }
  function invalidateShadows(shotId=activeShotId){
    for(const node of shadowLights.get(shotId)||[])node.shadow.needsUpdate=true;
  }
  function setLightMarkersVisible(visible){
    markersEnabled=!!visible;
    showShot(activeShotId);
  }
  function getLightMarker(shotId,id){return lightMarkers.get(shotId)?.get(id)||null;}
  function getLightNode(shotId,id){return lightNodes.get(shotId)?.get(id)||null;}
  function isLightMarkerVisible(shotId,id){
    const marker=getLightMarker(shotId,id);
    return !!(marker?.visible&&marker.parent?.visible&&activeShotId===shotId);
  }
  function getLightTargetMarker(shotId,id){return lightTargets.get(shotId)?.get(id)||null;}
  const _source=new THREE.Vector3(),_target=new THREE.Vector3(),_delta=new THREE.Vector3();
  const _orientation=new THREE.Quaternion(),up=new THREE.Vector3(0,1,0);
  function updateLightVisuals(camera,viewportHeight=720){
    if(!markersEnabled||!camera)return;
    const shot=activeShotId;
    const sources=lightMarkers.get(shot),targets=lightTargets.get(shot),guides=lightGuides.get(shot);
    const actual=lightNodes.get(shot);
    if(!sources)return;
    let shadowsChanged=false;
    const height=Math.max(1,viewportHeight);
    const worldPerPixel=node=>{
      node.getWorldPosition(_source);
      const distance=camera.isOrthographicCamera?1:camera.position.distanceTo(_source);
      return camera.isOrthographicCamera?
        Math.abs(camera.top-camera.bottom)/height:
        2*Math.tan(THREE.MathUtils.degToRad(camera.fov)*.5)*distance/height;
    };
    for(const [id,source] of sources){
      source.scale.setScalar(Math.max(.0001,worldPerPixel(source)*10/.2));
      // While a transform handle is dragged the authored light follows the
      // source marker immediately, instead of illuminating the old location
      // until the gesture is committed and the scene is rebuilt.
      const node=actual?.get(id);
      if(node&&!node.position.equals(source.position)){
        node.position.copy(source.position);shadowsChanged=true;
      }
    }
    for(const target of targets?.values()||[])
      target.scale.setScalar(Math.max(.0001,worldPerPixel(target)*7/.15));
    for(const [id,guide] of guides||[]){
      const {source,target,line,arrow}=guide;
      _delta.subVectors(target.position,source.position);
      const length=_delta.length();
      const node=actual?.get(id);
      if(node&&length>.01){
        // lookAt receives world coordinates. The shot root is anchored away
        // from local origin, so convert target from shot-local -> world.
        _orientation.copy(node.quaternion);
        node.lookAt(node.parent.localToWorld(_target.copy(target.position)));
        if(!node.quaternion.equals(_orientation))shadowsChanged=true;
        node.target?.position.set(0,0,-1);
      }
      const positions=line.geometry.attributes.position;
      positions.setXYZ(0,source.position.x,source.position.y,source.position.z);
      positions.setXYZ(1,target.position.x,target.position.y,target.position.z);
      positions.needsUpdate=true;
      if(length<.01){arrow.visible=false;continue;}
      arrow.visible=true;
      arrow.position.copy(source.position).addScaledVector(_delta,.82);
      arrow.quaternion.setFromUnitVectors(up,_delta.normalize());
      const arrowSize=Math.min(length*.09,worldPerPixel(arrow)*5);
      arrow.scale.setScalar(Math.max(.001,arrowSize));
    }
    if(shadowsChanged)invalidateShadows(shot);
  }
  function getObjectNode(shotId,objectId){
    return objectNodes.get(shotId)?.get(objectId)||null;
  }
  function getArrayInstances(shotId,objectId){
    return arrayInstances.get(shotId)?.get(objectId)||[];
  }
  function getPickableMeshes(shotId){
    const root=groups.get(shotId),meshes=[];
    root?.traverse(node=>{if(node.isMesh&&node.userData.primitiveId)meshes.push(node);});
    if(markersEnabled){
      meshes.push(...(lightMarkers.get(shotId)?.values()||[]));
      meshes.push(...(lightTargets.get(shotId)?.values()||[]));
    }
    return meshes;
  }
  function getSceneForExport(shotId){
    const root=groups.get(shotId);
    if(!root)throw Error('No primitive scene for '+shotId);
    const copy=root.clone(true);
    // Cloning a light copies its target as a detached object; point it back
    // at the cloned child so the exported direction is the node's -Z.
    copy.traverse(node=>{
      const target=node.isLight&&node.children.find(child=>child.userData.lightTarget);
      if(target)node.target=target;
    });
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
  return {setDocument,showShot,hasObjects,hasSceneContent,getBounds,getCamera,getObjectNode,getLightMarker,getLightNode,isLightMarkerVisible,getLightTargetMarker,updateLightVisuals,setLightMarkersVisible,getPickableMeshes,
    getSceneForExport,getDocument,getArrayInstances,invalidateShadows,dispose};
}
