// Regenerates tests/fixtures/track-orbit.mp4: the synthetic orbit scene
// rendered as a short H.264 clip (480x270, 12 fps, 50° vertical FOV).
//   node tests/browser/make-track-fixture.mjs   (needs ffmpeg on PATH)
import {spawnSync} from 'node:child_process';
import {renderSyntheticVideo,renderBoxScene,SCENARIOS} from '../camera-track-fixtures.mjs';
const video=renderSyntheticVideo({path:SCENARIOS.find(s=>s.name==='orbit').path,frames:36,noise:.6});
const raw=Buffer.concat(video.frames.map(f=>Buffer.from(Uint8Array.from(f,v=>Math.round(v)))));
const out=new URL('../fixtures/track-orbit.mp4',import.meta.url).pathname;
const run=spawnSync('ffmpeg',['-y','-loglevel','error','-f','rawvideo','-pix_fmt','gray','-s',`${video.width}x${video.height}`,
 '-r','12','-i','-','-c:v','libx264','-preset','slow','-crf','14','-pix_fmt','yuv420p','-movflags','+faststart',out],{input:raw});
if(run.status!==0)throw Error(String(run.stderr));
console.log('wrote',out);

// A video of three textured boxes along a 3 s orbit: the clip the tracking wizard test pins against.
const boxes=renderBoxScene({frames:36});
const boxRaw=Buffer.concat(boxes.frames.map(f=>Buffer.from(Uint8Array.from(f,v=>Math.round(v)))));
const boxOut=new URL('../fixtures/track-boxes.mp4',import.meta.url).pathname;
const run2=spawnSync('ffmpeg',['-y','-loglevel','error','-f','rawvideo','-pix_fmt','gray','-s',`${boxes.width}x${boxes.height}`,
 '-r','12','-i','-','-c:v','libx264','-preset','slow','-crf','12','-pix_fmt','yuv420p','-movflags','+faststart',boxOut],{input:boxRaw});
if(run2.status!==0)throw Error(String(run2.stderr));
console.log('wrote',boxOut);
