// OFFLINE ONLY. Exercise the real Durable Object request builder with synthetic
// frames, dummy credentials and a fetch stub. There is no live/provider mode.
// Usage: node scripts/inspect_argon_prompts.mjs [variant] [scope]
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {ArgonJob} from '../worker/scene-worker.mjs';

const scopes=['full_scene','primary_subject'];
export const PROMPT_VARIANTS=Object.freeze([
  'standard','high','max','words-only','counts-only','combined'
]);

// Do not run concurrent captures in one JS realm: fetch is temporarily global.
export async function captureArgonRequest({detail='standard',mode='full_scene',
  thinking='medium',objects=[]}={}){
  assert.ok(['standard','high','max'].includes(detail));
  assert.ok(scopes.includes(mode));
  const savedFetch=globalThis.fetch,savedLog=console.log,savedWarn=console.warn;
  const data=new Map();let calls=0,body;
  const storage={
    async get(key){return structuredClone(data.get(key));},
    async put(key,value){data.set(key,structuredClone(value));},
    async delete(key){data.delete(key);},
    async deleteAll(){data.clear();},
    async setAlarm(){}
  };
  try{
    globalThis.fetch=async(url,opts)=>{
      calls++;
      assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions');
      body=JSON.parse(opts.body);
      // A completed empty answer reproduces the live failure unless a test
      // supplies synthetic objects. No prose, thought or provider metadata.
      return new Response(JSON.stringify({status:'completed',steps:[{
        type:'model_output',content:[{type:'text',text:JSON.stringify({schemaVersion:1,
          scenes:[{shotId:'exterior',objects}]})}]
      }]}));
    };
    console.log=()=>{};console.warn=()=>{};
    const job=new ArgonJob({storage},{GEMINI_API_KEY:'offline-placeholder'});
    const imageDataUrl='data:image/jpeg;base64,/9j/2Q==';
    const response=await job.fetch(new Request('https://offline.invalid/start',{
      method:'POST',body:JSON.stringify({profile:'argon_direct',shotId:'exterior',
        mode,thinking,detail,frames:[0,.95,2.15].map(at=>({at,imageDataUrl}))})
    }));
    assert.equal(response.status,200);
    await job.alarm();
    assert.equal(calls,1,'exactly one intercepted request');
    assert.ok(body,'capture must fail if the request builder changes');
    const result=await storage.get('job');
    await job.alarm();
    assert.equal(calls,1,'a repeated alarm must not resubmit');
    return {body,result,output:await storage.get('output')};
  }finally{
    globalThis.fetch=savedFetch;console.log=savedLog;console.warn=savedWarn;
  }
}

function replaceOnce(text,from,to){
  assert.equal(text.split(from).length,2,'expected exactly one prompt anchor');
  return text.replace(from,to);
}

// These are reviewable experiment TEXTS, not additional production settings.
// They reconstruct a two-factor ablation of pre-#90 High from the exact
// Standard request, retaining its budget sentence and all shared instructions.
export async function inspectArgonPrompt(variant='standard',mode='full_scene'){
  assert.ok(PROMPT_VARIANTS.includes(variant),'unknown offline prompt variant');
  if(['standard','high','max'].includes(variant))
    return (await captureArgonRequest({detail:variant,mode})).body.system_instruction;
  let prompt=(await captureArgonRequest({mode})).body.system_instruction;
  const high=(await captureArgonRequest({detail:'high',mode})).body.system_instruction;
  const detail=high.match(/\nDETAIL: HIGH\.[\s\S]*?(?=\nWork in two stages)/)?.[0];
  assert.ok(detail,'High DETAIL paragraph anchor changed');
  const base=mode==='full_scene'?'80 to 120':'48 to 96';
  const raised=mode==='full_scene'?'110 to 150':'80 to 130';
  if(variant==='words-only'||variant==='combined')
    prompt=replaceOnce(prompt,`\nTarget ${base} objects`,detail+`\nTarget ${base} objects`);
  if(variant==='counts-only'||variant==='combined'){
    prompt=replaceOnce(prompt,'- at most 120 objects, 8 lights','- at most 150 objects, 8 lights');
    prompt=replaceOnce(prompt,`Target ${base} objects`,`Target ${raised} objects`);
  }
  return prompt;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [variant='standard',mode='full_scene',...extra]=process.argv.slice(2);
  if(extra.length||!PROMPT_VARIANTS.includes(variant)||!scopes.includes(mode)){
    process.stderr.write('Offline only: inspect_argon_prompts.mjs ['+
      PROMPT_VARIANTS.join('|')+'] [full_scene|primary_subject]\n');
    process.exitCode=1;
  }else process.stdout.write(await inspectArgonPrompt(variant,mode));
}
