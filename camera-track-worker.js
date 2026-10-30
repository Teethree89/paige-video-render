// Module Web Worker: runs feature tracking and the camera solve off the main
// thread. Receives grayscale frames from the page; posts progress and a
// validated motion estimate. No network access.
import {createTrackSession,createAnchoredSession} from './camera-track-pipeline.js';

let session=null;
self.onmessage=({data})=>{
 try{
   if(data.type==='start'){session=data.anchored?createAnchoredSession(data.options):createTrackSession(data.options);self.postMessage({type:'ready'});return;}
   if(!session)throw Error('Tracking session was not started');
   if(data.type==='frame'){
     const stats=session.addFrame(new Float32Array(data.gray),data.time);
     self.postMessage({type:'progress',index:data.index,stats});return;
   }
   if(data.type==='finish'){
     self.postMessage({type:'solving'});
     const done=session.finish();session=null;
     self.postMessage({type:'result',motion:done.motion,anchored:done.anchored,summary:done.summary});
   }
 }catch(error){session=null;self.postMessage({type:'error',message:error.message,summary:error.summary||null});}
};
