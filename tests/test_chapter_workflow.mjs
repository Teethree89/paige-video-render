import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chapterStatus,chapterCamera,projectProgress,nextOpenChapter,workflowStep,nameChapter,keepChapterCamera,
 suggestChapterName,cleanChapterName,isGuidedProject} from '../chapter-workflow.js';
import {createDraftTimeline} from '../shot-analysis.js';
import {buildReferenceTimeline} from '../reference-sequence.js';
import {createEmptyWorkspace} from '../workspace-reset.js';
import {checkTimeline} from '../timeline-operations.js';

const draft=()=>createDraftTimeline({duration:12,cuts:[4,8],title:'clip'});
const withGeometry=(seq,shotId,objects=[{id:'a',name:'Main building',primitive:'box',position:[0,0,0],rotation:[0,0,0],scale:[20,10,8]},
 {id:'b',name:'Antenna',primitive:'cylinder',position:[0,6,0],rotation:[0,0,0],scale:[1,4,1]}])=>{
 seq.primitiveScenes={version:1,scenes:[...(seq.primitiveScenes?.scenes||[]).filter(s=>s.shotId!==shotId),{shotId,objects}]};
 return seq;
};
const withTrackedCamera=(seq,shotId)=>{
 const shot=seq.shots.find(s=>s.id===shotId);
 seq.camera=seq.camera.filter(k=>!(k.at>=shot.start&&k.at<shot.end));
 seq.camera.push({id:'t0',at:shot.start,p:[0,5,30],t:[0,3,0],fov:50,cut:true,generated:'video-track'},
   {id:'t1',at:shot.end-.04,p:[0,5,20],t:[0,3,0],fov:50,generated:'video-track'});
 seq.camera.sort((a,b)=>a.at-b.at);
 return seq;
};

test('fresh video chapters are pending: not generated and not camera tracked',()=>{
 const seq=draft(),status=chapterStatus(seq,seq.shots[0]);
 assert.deepEqual({...status},{guided:true,objects:0,geometry:false,camera:'placeholder',cameraDone:false,
   named:false,pending:true,step:'geometry'});
 assert.equal(workflowStep(seq,seq.shots[0]),'geometry');
 assert.deepEqual(projectProgress(seq),{...projectProgress(seq),guided:3,done:0,pending:3});
});

test('the steps advance: models, then camera, then a name',()=>{
 let seq=withGeometry(draft(),'draft_001');
 assert.equal(chapterStatus(seq,seq.shots[0]).step,'camera');
 assert.equal(chapterStatus(seq,seq.shots[0]).pending,true,'geometry alone is still pending blocking');
 seq=withTrackedCamera(seq,'draft_001');
 const ready=chapterStatus(seq,seq.shots[0]);
 assert.equal(ready.camera,'tracked');assert.equal(ready.pending,false);assert.equal(ready.step,'name');
 assert.equal(workflowStep(seq,seq.shots[0]),'name');
 const named=nameChapter(seq,'draft_001','  Night campus\nexterior ');
 assert.equal(named.shots[0].name,'Night campus exterior');
 assert.equal(named.shots[0].title,'NIGHT CAMPUS EXTERIOR');
 assert.equal(named.shots[0].nameConfirmed,true);
 assert.equal(chapterStatus(named,named.shots[0]).step,'done');
 assert.equal(seq.shots[0].nameConfirmed,undefined,'naming returns a copy');
 checkTimeline(named);
 assert.equal(projectProgress(named).done,1);
});

test('camera states distinguish placeholder, estimates, tracks, authored edits and kept cameras',()=>{
 const seq=draft(),shot=seq.shots[1];
 assert.equal(chapterCamera(seq,shot),'placeholder');
 const moved=structuredClone(seq);moved.camera.find(k=>k.at>=4&&k.at<8).p=[1,5,22];
 assert.equal(chapterCamera(moved,moved.shots[1]),'authored','editing a placeholder key counts as authored');
 const estimated=structuredClone(seq);estimated.camera.filter(k=>k.at>=4&&k.at<8).forEach(k=>{k.generated='video-estimate';});
 assert.equal(chapterCamera(estimated,estimated.shots[1]),'estimated');
 const kept=keepChapterCamera(seq,'draft_002');
 assert.equal(chapterCamera(kept,kept.shots[1]),'kept');
 assert.equal(chapterStatus(kept,kept.shots[1]).cameraDone,true);
 assert.equal(chapterCamera(seq,seq.shots[1]),'placeholder','keeping returns a copy');
});

test('next open chapter skips completed chapters and wraps around',()=>{
 let seq=withTrackedCamera(withGeometry(draft(),'draft_002'),'draft_002');
 seq=nameChapter(seq,'draft_002','Hall');
 assert.equal(nextOpenChapter(seq,'draft_001').id,'draft_003');
 assert.equal(nextOpenChapter(seq,'draft_003').id,'draft_001');
 for(const id of ['draft_001','draft_003'])seq=nameChapter(withTrackedCamera(withGeometry(seq,id),id),id,'Done '+id);
 assert.equal(nextOpenChapter(seq,'draft_001'),null);
});

test('original authored timelines and empty workspaces are not nagged as pending',()=>{
 const original=JSON.parse(readFileSync(new URL('../timeline.json',import.meta.url),'utf8'));
 assert.equal(isGuidedProject(original),false);
 assert.equal(projectProgress(original).pending,0);
 assert.ok(original.shots.every(s=>chapterStatus(original,s).step==='done'));
 assert.equal(workflowStep(original,original.shots[0]),'source');
 const empty=createEmptyWorkspace();
 assert.equal(workflowStep(empty,empty.shots[0]),'source');
});

test('reference builder chapters use the same guided steps',()=>{
 const seq=buildReferenceTimeline([{id:'ref_a',mediaId:'m1',kind:'image',name:'Lobby',duration:3},
   {id:'ref_b',mediaId:'m2',kind:'image',name:'Server room',duration:3}]);
 assert.equal(isGuidedProject(seq),true);
 assert.equal(chapterStatus(seq,seq.shots[0]).pending,true);
 assert.equal(suggestChapterName(seq,seq.shots[0]),'Lobby','meaningful names are kept as the suggestion');
});

test('name suggestions use the largest generated objects, and names are bounded plain text',()=>{
 const seq=withGeometry(draft(),'draft_001');
 assert.equal(suggestChapterName(seq,seq.shots[0]),'Main building & Antenna');
 assert.equal(suggestChapterName(seq,seq.shots[1]),'Chapter 02');
 assert.throws(()=>cleanChapterName('   '),/Enter a chapter name/);
 assert.throws(()=>cleanChapterName('x'.repeat(81)),/limited to 80/);
 assert.equal(cleanChapterName('a\u0000b'),'a b');
 assert.throws(()=>nameChapter(seq,'missing','x'),/Unknown chapter/);
});

test('the editor wires the guide, pending overlay and naming card',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 for(const id of ['workflowGuide','workflowGuideAction','chapterPendingOverlay','chapterPendingTitle','chapterPendingChecklist',
   'chapterPendingAction','chapterPendingChip','chapterNameCard','chapterNameInput','chapterNameSave','chapterNameNext'])
   assert.match(html,new RegExp(`id="${id}"`),id);
 for(const step of ['source','geometry','camera','name'])assert.match(html,new RegExp(`data-step="${step}"`));
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 assert.match(app,/import \{setupChapterWorkflow\b[^}]*\} from '\.\/chapter-workflow\.js'/);
 assert.match(app,/chapterWorkflow=setupChapterWorkflow\(/);
});
