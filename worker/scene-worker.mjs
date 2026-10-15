/**
 * Paige scene inference endpoint.
 * This file is deployed to the user's already-created paige-video-render Worker.
 * Secrets GEMINI_API_KEY and SCENE_ACCESS_TOKEN exist as encrypted Worker bindings.
 * It has no CORS exposure; all calls come from the authenticated PHP gateway.
 */
// Google now restricts Gemini 2.5 Flash-Lite for projects without prior use.
// 3.5 Flash-Lite is a stable, low-cost multimodal replacement with free-tier
// availability. Keep one explicit model; never silently fall back to paid-only
// or alternate endpoints.
const MODEL = 'gemini-3.5-flash-lite';
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
// Keep generated models bounded for mobile WebGL while allowing enough parts
// to express actual architecture and equipment, not just rough silhouette.
const MAX_GENERATED_OBJECTS = 36;
const PROMPT=`You are an architectural and environment blockout artist. Reconstruct the VISIBLY OBSERVED scene
from these three chronological video frames as a recognizable, editable Three.js model.
Analyze all frames together: infer consistent relative proportions, visible materials,
camera movement and placement. Do NOT treat the three views as three separate scenes.

OUTPUT: only strict JSON, no markdown or notes:
{"schemaVersion":1,"scenes":[{"shotId":"SHOT_ID","objects":[...]}]}
Each object MUST have exactly:
{"id":"unique_ascii_id","name":"Descriptive part name","primitive":"box",
"position":[x,y,z],"rotation":[rx,ry,rz],"scale":[sx,sy,sz],
"material":{"color":"#RRGGBB","metalness":0.1,"roughness":0.7}}
Allowed primitives: box, sphere, cylinder, plane, torus. Unique ID per object.
Numeric transforms only. Scale > 0; metalness/roughness between 0 and 1.
Three.js geometry convention: unit-sized box, plane centered on XY facing +Z;
cylinder vertical along Y. Rotation is in RADIANS, not degrees.
World: Y up, ground plane Y=0; camera at +Z looking toward -Z.
Place objects around local world X/Z origin. Floor and roofs must be horizontal,
not upright: horizontal plane rotation [-1.571,0,0].
For a box resting on the floor, position.y = scale.y/2.

QUALITY REQUIREMENTS:
1. First identify the dominant visible subject (building exterior, equipment hall,
   machine, circuit board, or something else). Represent its meaningful visible
   parts and recognizable silhouette rather than generic stacked cubes.
2. For building scenes: include the observed footprint, wall masses, roof/parapet,
   entrance(s), distinct glazing/window bays, architectural bands, and observed
   ground/site features when seen. Windows should be thin, dark or reflective
   boxes on wall faces, not free-floating slabs. Align repeated parts neatly.
3. For technical/indoor scenes: include distinctive racks, frames, panels,
   consoles, rails, repeated hardware, or visible layout as appropriate.
4. Allocate shapes to details that improve recognition, not giant blank filler.
   Use at most 36 editable objects; target roughly 18–32 when detail is visible.
   Where evidence is ambiguous, use fewer honest shapes. Do NOT invent signs,
   logos, hidden rooms, unsupported windows, or whole unseen buildings.
5. Give objects informative names ('Roof parapet north', 'Window row east',
   'Entrance canopy', 'Rack bank A') to make them individually editable.
6. Match the observed palette and lighting mood, but keep key forms legible:
   dark objects should have distinguishable face and detail colors.
   Use believable scales and grounded placements: no floating planes,
   intersecting windows, or random scattered cubes.
7. Composition should be recognizable from an elevated three-quarter +Z view.
   Object positions, colors and orientations must be mutually consistent.

Each object's material must have color, metalness, roughness. Do not return
textures, external URLs, scripts, custom shaders, cameras, lighting, or metadata.
No arbitrary code. Return validated JSON ONLY.
`;

function validateOutput(value,shotId) {
  if(!value||typeof value!=='object'||value.schemaVersion!==1||
    !Array.isArray(value.scenes)||value.scenes.length!==1)throw Error('Invalid scene JSON');
  const scene=value.scenes[0];
  if(!scene||scene.shotId!==shotId||!Array.isArray(scene.objects)||scene.objects.length>MAX_GENERATED_OBJECTS)
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
    // A successful deployment does not prove runtime secret bindings exist.
    // Provide a public, non-sensitive status only: never return names or values.
    if(path==='/health'&&request.method==='GET'){
      const ready=!!(env?.GEMINI_API_KEY&&env?.SCENE_ACCESS_TOKEN);
      // Model ID is public configuration, not a secret. This field confirms
      // which Worker version actually reached Cloudflare, NOT API entitlement.
      return reply({ok:ready,service:'paige-scene',ready,model:MODEL,generationProfile:'detailed-36-v2'},ready?200:503);
    }
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
      generationConfig:{responseMimeType:'application/json',temperature:0.2,maxOutputTokens:7500}};
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
    // Classify only the HTTP status; never return or log Gemini's raw error
    // response, which can include provider-specific account information.
    if(!result.ok){
      if(result.status===401||result.status===403)
        return fail(502,'AI provider authentication or permission failed');
      if(result.status===404)return fail(502,'Requested AI model is unavailable');
      if(result.status===400||result.status===422)
        return fail(502,'AI provider rejected request format');
      if(result.status>=500)return fail(502,'AI provider temporarily unavailable');
      return fail(502,'AI provider refused the request');
    }
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
