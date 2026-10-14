// Versioned, AI-safe data contract for user-authored or future model-generated
// primitive geometry. No generated JavaScript, remote URLs or arbitrary shaders.
export const PRIMITIVE_TYPES = Object.freeze(['box','sphere','cylinder','plane','torus']);
export const LIMITS = Object.freeze({scenes:120, objectsPerScene:200, totalObjects:2000});
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
    const ids=new Set();
    const objects=scene.objects.map((item,j)=>{
      if(!item||typeof item!=='object'||Array.isArray(item))fail(shotId+' object '+j+' is invalid');
      const id=identifier(item.id,'object id');
      if(ids.has(id))fail('duplicate object id '+id+' in '+shotId);
      ids.add(id);
      if(!PRIMITIVE_TYPES.includes(item.primitive))fail(id+' has unsupported primitive type');
      const position=vec(item.position,'position',-10000,10000);
      const rotation=vec(item.rotation,'rotation',-1000,1000);
      const scale=vec(item.scale,'scale',.01,500);
      const m=item.material;
      if(!m||typeof m!=='object'||Array.isArray(m))fail(id+' is missing material');
      if(typeof m.color!=='string'||!/^#[0-9a-fA-F]{6}$/.test(m.color))
        fail(id+' color must be a #RRGGBB string');
      return {id,name:displayName(item.name,item.primitive+' '+id),
        primitive:item.primitive,position,rotation,scale,
        material:{color:m.color.toLowerCase(),metalness:finite(m.metalness,'metalness',0,1),
          roughness:finite(m.roughness,'roughness',0,1)}};
    });
    return {shotId,objects};
  });
  return {schemaVersion:1,scenes};
}

export function makePrimitive(type, id, position=[0,1,0]) {
  if(!PRIMITIVE_TYPES.includes(type))fail('unsupported type');
  const scales={box:[2,2,2],sphere:[2,2,2],cylinder:[2,3,2],plane:[12,12,1],torus:[2,2,.6]};
  const item={id,name:type+' '+id,primitive:type,position,rotation:[0,0,0],
    scale:scales[type],material:{color:'#72c9db',metalness:.25,roughness:.6}};
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
