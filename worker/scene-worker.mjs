/**
 * Paige scene inference endpoint.
 * This file is deployed to the user's already-created paige-video-render Worker.
 * Secrets GEMINI_API_KEY and SCENE_ACCESS_TOKEN exist as encrypted Worker bindings.
 * It has no CORS exposure; all calls come from the authenticated PHP gateway.
 */
const MODEL = 'gemini-2.5-flash-lite';
const MAX_BYTES = 1_600_000;
const FRAME_LIMIT = 3;

const reply = (value, status=200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }
});
const fail = (code, message) => reply({ok:false,error:message},code);
function secretMatches(a,b) {
  if(typeof a !== 'string'||typeof b !== 'string'||b.length<32)return false;
  // Compare full UTF-8 buffers without exiting at the first mismatched byte.
  const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);
  let different=x.length^y.length;
  for(let i=0;i<Math.max(x.length,y.length);i++) different|=(x[i]||0)^(y[i]||0);
  return different===0;
}
async function readLimitedBody(request) {
  const length=Number(request.headers.get('content-length')||0);
  if(length>MAX_BYTES)throw Error('Request too large');
  const reader=request.body?.getReader();
  if(!reader)throw Error('No request body');
  const pieces=[];let total=0;
  while(true){
    const {value,done}=await reader.read();
    if(done)break;
    total+=value.byteLength;
    if(total>MAX_BYTES){await reader.cancel();throw Error('Request too large');}
    pieces.push(value);
  }
  const combined=new Uint8Array(total);
  let cursor=0;
  for(const part of pieces){combined.set(part,cursor);cursor+=part.byteLength;}
  return JSON.parse(new TextDecoder().decode(combined));
}
export function validateInput(payload) {
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid request');
  const shotId=payload.shotId;
  if(typeof shotId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(shotId))
    throw Error('Invalid shot');
  const frames=payload.frames;
  if(!Array.isArray(frames)||frames.length<1||frames.length>FRAME_LIMIT)throw Error('Invalid frame count');
  const content=[];
  for(const frame of frames){
    if(!frame||typeof frame!=='object'||typeof frame.imageDataUrl!=='string')
      throw Error('Invalid frame');
    if(typeof frame.at!=='number'||!Number.isFinite(frame.at)||frame.at<0||frame.at>36000)
      throw Error('Invalid frame timestamp');
    if(frame.imageDataUrl.length>500000)throw Error('Frame is too large');
    const match=/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(frame.imageDataUrl);
    if(!match)throw Error('Only base64 JPEG frames accepted');
    const bytes=atob(match[1]);
    if(bytes.length>350000||bytes.charCodeAt(0)!==255||bytes.charCodeAt(1)!==216)
      throw Error('Invalid JPEG image data');
    content.push({text:'Reference frame at '+frame.at.toFixed(3)+' seconds'});
    content.push({inlineData:{mimeType:'image/jpeg',data:match[1]}});
  }
  return {shotId,content};
}
const PROMPT=`Build an approximate, EDITABLE 3D scene from these chronologically ordered video frames.
Return ONLY JSON for the supported primitive schema.
Coordinates: +Y up, floor Y=0, viewer at +Z looking toward -Z.
Allowed primitives: box, sphere, cylinder, plane, torus.
Each object: id, name, primitive, position [x,y,z], rotation [x,y,z] in radians,
scale [x,y,z], material {color:"#RRGGBB",metalness:0..1,roughness:0..1}.
Create no more than 16 visible, coherent objects, approximate rather than exact.
Do not hallucinate invisible details; if evidence is weak use fewer primitives.
Root must be {"schemaVersion":1,"scenes":[{"shotId":"SHOT_ID","objects":[...]}]}.
No arbitrary code, animations, textures or extra metadata. JSON only.
`;
function validateOutput(value,shotId) {
  if(!value||typeof value!=='object'||value.schemaVersion!==1||
    !Array.isArray(value.scenes)||value.scenes.length!==1)throw Error('Invalid scene JSON');
  const scene=value.scenes[0];
  if(!scene||scene.shotId!==shotId||!Array.isArray(scene.objects)||scene.objects.length>16)
    throw Error('Incorrect shot or object budget');
  const ids=new Set();
  const objects=scene.objects.map(raw=>{
    if(!raw||typeof raw!=='object')throw Error('Invalid object');
    if(typeof raw.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.id)||ids.has(raw.id))
      throw Error('Invalid object ID');
    ids.add(raw.id);
    if(!['box','sphere','cylinder','plane','torus'].includes(raw.primitive))
      throw Error('Unsupported primitive');
    const vec=(arr,min,max)=>{
      if(!Array.isArray(arr)||arr.length!==3||arr.some(x=>typeof x!=='number'||!Number.isFinite(x)||x<min||x>max))
        throw Error('Invalid transform');
      return arr;
    };
    const m=raw.material||{};
    if(typeof m.color!=='string'||!/^#[0-9a-fA-F]{6}$/.test(m.color))throw Error('Invalid color');
    for(const n of [m.metalness,m.roughness])
      if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>1)throw Error('Invalid material');
    if(raw.name!==undefined&&(typeof raw.name!=='string'||raw.name.length>100))
      throw Error('Invalid object name');
    return {id:raw.id,name:raw.name||raw.id,primitive:raw.primitive,
      position:vec(raw.position,-10000,10000),rotation:vec(raw.rotation,-1000,1000),
      scale:vec(raw.scale,.01,500),
      material:{color:m.color.toLowerCase(),metalness:m.metalness,roughness:m.roughness}};
  });
  return {schemaVersion:1,scenes:[{shotId,objects}]};
}
export {validateOutput,secretMatches};

export default {
  async fetch(request,env){
    const path=new URL(request.url).pathname;
    if(path==='/health'&&request.method==='GET')return reply({ok:true,service:'paige-scene',ready:true});
    if(path!=='/api/scene')return fail(404,'Not found');
    if(request.method!=='POST')return fail(405,'POST required');
    if(!env.GEMINI_API_KEY || !env.SCENE_ACCESS_TOKEN)
      return fail(503,'AI backend is not configured');
    const bearer=request.headers.get('Authorization')||'';
    const token=bearer.startsWith('Bearer ')?bearer.slice(7):'';
    if(!secretMatches(token,env.SCENE_ACCESS_TOKEN))return fail(401,'Unauthorized');
    let validated;
    try {validated=validateInput(await readLimitedBody(request));}
    catch(error){return fail(error?.message==='Request too large'?413:400,'Invalid image request');}
    const prompt=PROMPT.replace('SHOT_ID',validated.shotId);
    const requestBody={contents:[{role:'user',parts:[{text:prompt},...validated.content]}],
      generationConfig:{responseMimeType:'application/json',temperature:0.2,maxOutputTokens:3500}};
    let result;
    try {
      result=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+MODEL+':generateContent',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},
        body:JSON.stringify(requestBody),
        signal:AbortSignal.timeout(45000)
      });
    }catch(error){return fail(502,'AI provider connection failed');}
    if(result.status===429)return fail(429,'Provider rate limit reached');
    if(!result.ok)return fail(502,'AI provider refused the request');
    let providerResponse;
    try {providerResponse=await result.json();}
    catch(error){return fail(502,'Invalid provider response');}
    const text=providerResponse?.candidates?.[0]?.content?.parts
      ?.filter(part=>typeof part.text==='string').map(part=>part.text).join('');
    if(!text||text.length>75000)return fail(502,'Provider produced no usable scene');
    try {
      const primitiveScenes=validateOutput(JSON.parse(text),validated.shotId);
      return reply(primitiveScenes);
    } catch(error){return fail(502,'Provider scene did not match the editor schema');}
  }
};
