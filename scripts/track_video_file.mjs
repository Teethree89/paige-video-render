#!/usr/bin/env node
// Run the camera tracker on a real video file, chapter by chapter, with the
// same frame schedule and tracker the browser uses. Needs ffmpeg on PATH.
// Offline: nothing is uploaded and no provider is called.
//   node scripts/track_video_file.mjs assets/reference.mp4            # chapters from timeline.json
//   node scripts/track_video_file.mjs clip.mp4 --range 0 6            # one range, in seconds
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createTrackSession,trackingFrameTimes} from '../camera-track-pipeline.js';

const args=process.argv.slice(2),file=args.find(a=>!a.startsWith('--')&&!/^[\d.]+$/.test(a));
if(!file){console.error('Usage: node scripts/track_video_file.mjs <video> [--range <start> <end>]');process.exit(2);}
const W=480;
const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-show_entries','format=duration','-of','json',file]));
const H=Math.max(64,Math.round(W*probe.streams[0].height/probe.streams[0].width/2)*2),duration=Number(probe.format.duration);
const r=args.indexOf('--range');
const chapters=r>=0?[{id:'range',start:Number(args[r+1]),end:Number(args[r+2])}]:
  JSON.parse(readFileSync(new URL('../timeline.json',import.meta.url),'utf8')).shots;
let failures=0;
for(const ch of chapters){
 const times=trackingFrameTimes(ch.start,ch.end),started=performance.now();
 const session=createTrackSession({width:W,height:H,start:ch.start,end:ch.end});
 for(const t of times){
   const raw=execFileSync('ffmpeg',['-v','error','-ss',String(Math.min(t,duration-.15)),'-i',file,'-frames:v','1','-vf',`scale=${W}:${H}`,'-f','rawvideo','-pix_fmt','gray','-'],{maxBuffer:1e8});
   session.addFrame(Float32Array.from(raw),t);
 }
 try{
   const {motion,summary}=session.finish(),seg=summary.segment;
   console.log(ch.id.padEnd(11),motion.type.padEnd(9),`conf ${motion.confidence}`.padEnd(10),
     `${summary.posed}/${summary.keyframes} keys, ${summary.points} pts, ${summary.rmsPx} px, ${summary.fov}°${summary.fovEstimated?' est':summary.fovAssumed?' assumed':''}`,
     seg.frames<seg.total?`· ${seg.frames}/${seg.total} frames continuous`:'',`· ${((performance.now()-started)/1000).toFixed(1)}s`);
 }catch(error){failures++;console.log(ch.id.padEnd(11),'REFUSED  ',error.message);}
}
process.exitCode=failures&&failures===chapters.length?1:0;
