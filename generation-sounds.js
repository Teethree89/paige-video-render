// Shared end-of-workflow sounds for scene generation and paid diagnostic runs.
// Arm from a trusted click *before* the long asynchronous request: browsers,
// especially Safari, generally refuse autoplay without an active user gesture.
// Audio errors must never change the state, billing or result of a generation.
export const GENERATION_SOUND_PATHS=Object.freeze({
  success:'./assets/sounds/success.mp3',
  failed:'./assets/sounds/failed.mp3'
});

export function createGenerationSounds({
  AudioContextClass=globalThis.AudioContext||globalThis.webkitAudioContext,
  AudioClass=globalThis.Audio,
  fetchSound=(...args)=>globalThis.fetch(...args)
}={}){
  let context=null,buffers=null,armed=false;
  const startFetch=(type)=>{
    if(!context||typeof fetchSound!=='function')return Promise.resolve(null);
    return Promise.resolve().then(()=>fetchSound(GENERATION_SOUND_PATHS[type],
      {credentials:'same-origin',cache:'force-cache'}))
      .then(response=>{
        if(!response?.ok)throw Error('Sound asset unavailable');
        return response.arrayBuffer();
      }).then(bytes=>context.decodeAudioData(bytes)).catch(()=>null);
  };
  // Call this synchronously in a click handler, not after polling or prompts.
  function arm(){
    armed=true;
    if(!context&&typeof AudioContextClass==='function'){
      try{context=new AudioContextClass();}catch{context=null;}
    }
    if(context){
      // Resume in the gesture. Do not await; fetching/decoding runs in parallel.
      try{Promise.resolve(context.resume?.()).catch(()=>{});}catch{}
      if(!buffers)buffers={success:startFetch('success'),failed:startFetch('failed')};
    }
  }
  async function play(outcome){
    if(!Object.hasOwn(GENERATION_SOUND_PATHS,outcome))return false;
    if(!armed)arm();
    try{
      const buffer=buffers?await buffers[outcome]:null;
      if(context&&buffer){
        if(context.state==='suspended')await context.resume();
        const source=context.createBufferSource();
        source.buffer=buffer;
        source.connect(context.destination);
        source.start(0);
        return true;
      }
      // Older browsers without Web Audio can still play after user interaction.
      if(typeof AudioClass==='function'){
        const audio=new AudioClass(GENERATION_SOUND_PATHS[outcome]);
        audio.preload='auto';
        await audio.play();
        return true;
      }
    }catch{/* Missing file, autoplay blocked, disconnected device: stay silent. */}
    return false;
  }
  return {arm,play};
}
