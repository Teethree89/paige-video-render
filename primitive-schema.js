// Versioned, AI-safe data contract for user-authored or future model-generated
// primitive geometry. No generated JavaScript, remote URLs or arbitrary shaders.
// schemaVersion 1 grows additively: every field after the original five
// primitives is optional, and v1 input validates to exactly the same output.
export const PRIMITIVE_TYPES = Object.freeze(['box','sphere','cylinder','plane','torus',
  'cone','wedge','gable','extrude']);
export const ENVIRONMENT_LAYERS = Object.freeze(['structures','ground','vegetation','details']);
// glTF's KHR_lights_punctual types, so every light also exports to GLB.
export const LIGHT_TYPES = Object.freeze(['directional','point','spot']);
// A repeat array renders every copy as its own mesh, so copies are capped per
// object and per scene to keep mobile WebGL, GLB and After Effects responsive.
export const LIMITS = Object.freeze({scenes:120, objectsPerScene:240, totalObjects:2000,
  instancesPerScene:2000, copiesPerObject:400, repeatPerAxis:100, footprintPoints:32,
  // Each light adds shading cost to every material, so keep mobile WebGL fast.
  lightsPerScene:8});
const fail = message => {throw Error('Primitive scene: '+message);};
const finite = (value, label, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    fail(label+' must be finite between '+min+' and '+max);
  return value;
};
const vec = (value,label,min,max) => {
  if (!Array.isArray(value) || value.length !== 3) fail(label+' must be a 3-number array');
  return value.map((n,i) => finite(n,label+'['+i+']',min,max));
};
const identifier=(value,label)=>{
  if (typeof value !== 'string'|| !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value))
    fail(label+' must be a unique ASCII identifier (1–64 chars)');
  return value;
};
const hexColor=(value,label)=>{
  if(typeof value!=='string'||!/^#[0-9a-fA-F]{6}$/.test(value))fail(label+' must be a #RRGGBB string');
  return value.toLowerCase();
};
// Copies are centered on the object's position and step along its own
// rotated axes, so a window row stays on a rotated facade.
const repeatSpec=(value,id)=>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail(id+' repeat must be {count,spacing}');
  if(!Array.isArray(value.count)||value.count.length!==3)fail(id+' repeat.count must be 3 integers');
  const count=value.count.map((n,i)=>{
    if(!Number.isInteger(n)||n<1||n>LIMITS.repeatPerAxis)
      fail(id+' repeat.count['+i+'] must be an integer from 1 to '+LIMITS.repeatPerAxis);
    return n;
  });
  const copies=count[0]*count[1]*count[2];
  if(copies>LIMITS.copiesPerObject)fail(id+' repeats into more than '+LIMITS.copiesPerObject+' copies');
  const spacing=vec(value.spacing,id+' repeat.spacing',-1000,1000);
  return copies===1?undefined:{count,spacing};
};
// Footprint corners are normalized ([x,z] within ±1, usually ±0.5) and
// scaled by scale[0]/scale[2]; scale[1] is the extruded height.
const footprint=(value,id)=>{
  if(!Array.isArray(value)||value.length<3||value.length>LIMITS.footprintPoints)
    fail(id+' extrude needs 3 to '+LIMITS.footprintPoints+' footprint points');
  const points=value.map((point,i)=>{
    if(!Array.isArray(point)||point.length!==2)fail(id+' footprint point '+i+' must be [x,z]');
    return point.map((n,k)=>finite(n,id+' footprint['+i+']['+k+']',-1,1));
  });
  let area=0; // shoelace formula; a zero-area outline cannot be extruded
  for(let i=0;i<points.length;i++){
    const [x1,z1]=points[i],[x2,z2]=points[(i+1)%points.length];
    area+=x1*z2-x2*z1;
  }
  if(Math.abs(area)/2<1e-4)fail(id+' footprint has no area');
  return points;
};
const sceneCamera=(value,shotId)=>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail(shotId+' camera must be {position,target,fov}');
  const position=vec(value.position,'camera position',-10000,10000);
  const target=vec(value.target,'camera target',-10000,10000);
  if(Math.hypot(...position.map((n,i)=>n-target[i]))<.01)fail(shotId+' camera must look at a distinct target');
  return {position,target,fov:finite(value.fov,'camera fov',10,120)};
};
// Lights add to the editor's base lighting, only while their shot is shown.
// Intensities use Three.js units: directional in lux-like units, point and
// spot in candela with physical (squared) falloff, like the original world.
const sceneLights=(value,shotId)=>{
  if(!Array.isArray(value)||value.length>LIMITS.lightsPerScene)
    fail(shotId+' lights must be an array of at most '+LIMITS.lightsPerScene);
  const seen=new Set();
  return value.map((light,i)=>{
    const label=shotId+' light '+(i+1);
    const id=light?.id==null?null:identifier(light.id,'light id');
    if(id&&seen.has(id))fail('duplicate light id '+id);
    if(id)seen.add(id);
    if(!light||typeof light!=='object'||Array.isArray(light))fail(label+' is invalid');
    if(!LIGHT_TYPES.includes(light.type))fail(label+' has unsupported light type');
    const out={...(id?{id}:{}),type:light.type,name:displayName(light.name,light.type+' light '+(i+1)),
      color:hexColor(light.color,label+' color'),
      intensity:finite(light.intensity,label+' intensity',0,light.type==='directional'?10:500),
      position:vec(light.position,label+' position',-10000,10000)};
    if(light.type!=='point'){
      out.target=light.target==null?[0,0,0]:vec(light.target,label+' target',-10000,10000);
      if(Math.hypot(...out.position.map((n,k)=>n-out.target[k]))<.01)fail(label+' must aim at a distinct target');
    }
    if(light.type!=='directional')
      out.distance=light.distance==null?0:finite(light.distance,label+' distance',0,1000); // 0: no cutoff
    if(light.type==='spot'){
      out.angle=light.angle==null?.6:finite(light.angle,label+' angle',.05,1.5);
      out.penumbra=light.penumbra==null?.3:finite(light.penumbra,label+' penumbra',0,1);
    }
    return out;
  });
};
// Chapter-specific look profile; additive v1 schema extension. These
// parameters are stored in JSON (and portable projects), not arbitrary GLSL.
export function validateSceneEffects(value){
 if(value===undefined||value===null)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value))fail('effects must be an object');
 const fog=value.fog||{mode:'default',color:'#526779',density:.008};
 if(!['default','off','custom'].includes(fog.mode))fail('invalid fog mode');
 const bloom=value.bloom||{enabled:false,strength:.45,threshold:.8,radius:.35};
 if(typeof bloom.enabled!=='boolean')fail('bloom enabled must be boolean');
 return {
   fog:{mode:fog.mode,color:hexColor(fog.color||'#526779','fog color'),
     density:finite(fog.density??.008,'fog density',0,.15)},
   bloom:{enabled:bloom.enabled,strength:finite(bloom.strength??.45,'bloom strength',0,4),
     threshold:finite(bloom.threshold??.8,'bloom threshold',0,1),
     radius:finite(bloom.radius??.35,'bloom radius',0,1)},
   exposure:finite(value.exposure??1.35,'scene exposure',.2,5),
   vignette:finite(value.vignette??.45,'vignette strength',0,1)
 };
}
export function repeatOffsets(repeat){
  if(!repeat)return [[0,0,0]];
  const [nx,ny,nz]=repeat.count,[dx,dy,dz]=repeat.spacing,offsets=[];
  for(let i=0;i<nx;i++)for(let j=0;j<ny;j++)for(let k=0;k<nz;k++)
    offsets.push([(i-(nx-1)/2)*dx,(j-(ny-1)/2)*dy,(k-(nz-1)/2)*dz]);
  return offsets;
}
const displayName=(v, fallback)=>{
  if(v===undefined || v===null)return fallback;
  if(typeof v!=='string' || v.length>100)fail('name must be text of at most 100 characters');
  return v.trim()||fallback;
};
export const blankPrimitiveDocument = () => ({schemaVersion:1,scenes:[]});

export function validatePrimitiveDocument(value, allowedShotIds = null) {
  if (value === undefined || value === null) return blankPrimitiveDocument();
  if (typeof value !== 'object' || Array.isArray(value)||value.schemaVersion!==1 || !Array.isArray(value.scenes))
    fail('expected {schemaVersion:1,scenes:[...]}');
  if (value.scenes.length>LIMITS.scenes)fail('too many scenes');
  const allowed=allowedShotIds===null?null:new Set(allowedShotIds);
  const sceneIds=new Set();let total=0;
  const scenes=value.scenes.map((scene,index)=>{
    if (!scene || typeof scene!=='object' || Array.isArray(scene))fail('scene '+index+' is invalid');
    const shotId=identifier(scene.shotId,'shotId');
    if(allowed&&!allowed.has(shotId))fail('unknown shotId: '+shotId);
    if(sceneIds.has(shotId))fail('duplicate shotId: '+shotId);
    sceneIds.add(shotId);
    if(!Array.isArray(scene.objects)||scene.objects.length>LIMITS.objectsPerScene)
      fail('scene '+shotId+' needs an objects array with at most '+LIMITS.objectsPerScene+' objects');
    total+=scene.objects.length;
    if(total>LIMITS.totalObjects)fail('too many total objects');
    const ids=new Set();let instances=0;
    const objects=scene.objects.map((item,j)=>{
      if(!item||typeof item!=='object'||Array.isArray(item))fail(shotId+' object '+j+' is invalid');
      const id=identifier(item.id,'object id');
      if(ids.has(id))fail('duplicate object id '+id+' in '+shotId);
      ids.add(id);
      if(!PRIMITIVE_TYPES.includes(item.primitive))fail(id+' has unsupported primitive type');
      const position=vec(item.position,'position',-10000,10000);
      const rotation=vec(item.rotation,'rotation',-1000,1000);
      // Up to 2 km: a full scene's ground or road can exceed 500 m.
      const scale=vec(item.scale,'scale',.01,2000);
      const m=item.material;
      if(!m||typeof m!=='object'||Array.isArray(m))fail(id+' is missing material');
      const material={color:hexColor(m.color,id+' color'),metalness:finite(m.metalness,'metalness',0,1),
        roughness:finite(m.roughness,'roughness',0,1)};
      if(m.emissive!=null){
        material.emissive=hexColor(m.emissive,id+' emissive');
        material.emissiveIntensity=m.emissiveIntensity==null?1:
          finite(m.emissiveIntensity,'emissiveIntensity',0,10);
      }
      if(m.opacity!=null)material.opacity=finite(m.opacity,'opacity',.05,1);
      // Older exports can spell the unlayered/manual bucket explicitly.
      // Canonical v1 data still represents it by the absence of a layer.
      const layer=item.layer==null||item.layer===''||item.layer==='manual'?undefined:item.layer;
      if(layer!==undefined&&!ENVIRONMENT_LAYERS.includes(layer))fail(id+' has unsupported environment layer');
      const repeat=item.repeat==null?undefined:repeatSpec(item.repeat,id);
      instances+=repeat?repeat.count[0]*repeat.count[1]*repeat.count[2]:1;
      if(instances>LIMITS.instancesPerScene)
        fail(shotId+' has more than '+LIMITS.instancesPerScene+' rendered copies');
      const points=item.primitive==='extrude'?footprint(item.points,id):undefined;
      return {id,name:displayName(item.name,item.primitive+' '+id),
        primitive:item.primitive,position,rotation,scale,
        ...(points?{points}:{}),
        ...(repeat?{repeat}:{}),
        ...(layer===undefined?{}:{layer}),
        material};
    });
    const camera=scene.camera==null?undefined:sceneCamera(scene.camera,shotId);
    const lights=scene.lights==null?[]:sceneLights(scene.lights,shotId);
    const effects=validateSceneEffects(scene.effects);
    return {shotId,objects,...(camera?{camera}:{}),...(lights.length?{lights}:{}),
      ...(effects?{effects}:{})};
  });
  return {schemaVersion:1,scenes};
}

export function makePrimitive(type, id, position=[0,1,0]) {
  if(!PRIMITIVE_TYPES.includes(type))fail('unsupported type');
  const scales={box:[2,2,2],sphere:[2,2,2],cylinder:[2,3,2],plane:[12,12,1],torus:[2,2,.6],
    cone:[2,3,2],wedge:[3,2,3],gable:[4,2,6],extrude:[6,3,6]};
  const item={id,name:type+' '+id,primitive:type,position,rotation:[0,0,0],
    scale:scales[type],material:{color:'#72c9db',metalness:.25,roughness:.6},
    // An L-shaped footprint shows what extrusion is for; edit points in JSON.
    ...(type==='extrude'?{points:[[-.5,-.5],[.5,-.5],[.5,0],[0,0],[0,.5],[-.5,.5]]}:{})};
  return validatePrimitiveDocument({schemaVersion:1,scenes:[{shotId:'preview',objects:[item]}]}).scenes[0].objects[0];
}

export function makeExampleBlockout(shotId) {
  identifier(shotId,'shotId');
  // A deliberately illustrative room with repeated server-like boxes.
  // No claim that these dimensions were derived from video.
  const objects=[];
  const floor=makePrimitive('plane','floor',[0,-.1,0]);
  floor.name='Guide floor';floor.rotation=[-Math.PI/2,0,0];
  floor.scale=[26,28,1];floor.material.color='#294456';objects.push(floor);
  for(let row=0;row<2;row++) for(let col=0;col<3;col++){
    const item=makePrimitive('box','rack_'+row+'_'+col,[(col-1)*6,3,row*-9]);
    item.name='Example equipment rack '+(row*3+col+1);
    item.scale=[3,6,2.3];item.material={color:'#314f63',metalness:.65,roughness:.4};
    objects.push(item);
  }
  return {shotId,objects};
}
