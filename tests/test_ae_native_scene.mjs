import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {evaluateCamera} from '../animation-curves.js';
import {createAETimeline} from '../ae-package-plan.js';
const root=new URL('../',import.meta.url);
const jsx=readFileSync(new URL('AfterEffects/BUILD_EDITABLE_PROJECT.jsx',root),'utf8');
const timeline=JSON.parse(readFileSync(new URL('timeline.json',root),'utf8'));

test('AE evaluated camera matches Paige smooth, linear, hold, ease and Bezier at every sampled frame',()=>{
  const start=jsx.indexOf('  function easeCamera('),end=jsx.indexOf('  function addCameraKeys',start);
  assert.ok(start>=0&&end>start);
  const interpolate=new Function('seq','t',jsx.slice(start,end)+'\nreturn interpCamera(seq,t);');
  for(const curve of [{mode:'smooth'},{mode:'linear'},{mode:'hold'},
    {mode:'ease-in'},{mode:'ease-out'},{mode:'bezier',handles:[.16,.1,.85,.7]}]){
    const keys=[{at:0,p:[2,0,10],t:[0,0,0],fov:35,curve},
      {at:2,p:[14,8,6],t:[6,2,1],fov:65}];
    for(let frame=0;frame<=60;frame++){
      const sec=frame/30,a=interpolate({camera:keys},sec),b=evaluateCamera(keys,sec);
      for(const key of ['p','t'])for(let axis=0;axis<3;axis++)
        assert.ok(Math.abs(a[key][axis]-b[key][axis])<1e-7,
          curve.mode+' '+frame+' '+key+axis);
      assert.ok(Math.abs(a.fov-b.fov)<1e-7,curve.mode+' '+frame+' fov');
    }
  }
  const cut=[{at:0,p:[0,0,0],t:[0,0,-1],fov:40},
    {at:1,p:[40,0,0],t:[40,0,-1],fov:50,cut:true}];
  assert.equal(interpolate({camera:cut},.99).p[0],0);
  assert.equal(interpolate({camera:cut},1).p[0],40);
  assert.match(jsx,/\(visibleEnd-shot\.start\)\*FPS/);
});

test('AE snapshot freezes source-scene anchor independently of registered camera origin',()=>{
  const source=structuredClone(timeline),id=source.shots[0].id;
  source.shots[0].sceneAnchor=[18,2,27];
  source.primitiveScenes={schemaVersion:1,scenes:[{
    shotId:id,objects:[],lights:[{type:'point',position:[1,4,0],color:'#ff4400',intensity:6}]
  }]};
  const ae=createAETimeline(source,()=>({t:[300,12,-50]}));
  assert.deepEqual(ae.shots[0].aeOrigin,[0,0,0]);
  assert.deepEqual(ae.shots[0].aeSceneAnchor,[18,2,27]);
  assert.equal(source.shots[0].aeSceneAnchor,undefined);
});

function buildAEWithEditableLook(){
  const source=structuredClone(timeline),shot=source.shots[0];
  shot.sceneAnchor=[20,0,40];
  source.primitiveScenes={schemaVersion:1,scenes:[{
    shotId:shot.id,objects:[],
    lights:[
      {id:'spot',type:'spot',name:'Key lamp',color:'#ffcc88',intensity:22,
        position:[2,6,3],target:[0,0,0],angle:.6,penumbra:.25},
      {id:'point',type:'point',name:'Fill',color:'#66aaff',intensity:7,position:[-4,8,2]},
      {id:'sun',type:'directional',name:'Sun',color:'#ffffff',intensity:1.5,
        position:[30,50,10],target:[0,0,0]}
    ],
    effects:{fog:{mode:'custom',color:'#526779',density:.015},
      bloom:{enabled:true,threshold:.82,radius:.4,strength:1.1},exposure:2,vignette:.7}
  }]};
  const comps=[],notices=[];
  const prop=()=>({value:{},keys:[],setValue(v){this.value=v;},
    setValueAtTime(t,v){this.keys.push({t,value:v});},
    property(n){return this[n]||(this[n]=prop());},
    addProperty(name){const item=prop();item.matchName=name;
      (this.added||(this.added=[])).push(item);return item;}});
  function layer(sourceItem=null,kind='model'){
    return Object.assign(prop(),{source:sourceItem,kind,enabled:true,
      sourceRectAtTime(){return {left:0,top:0,width:100,height:30};},
      moveToEnd(){}});
  }
  function addComp(name,w,h,pixelAspect,duration,fps){
    const result={name,width:w,height:h,duration,fps,renderers:['Advanced 3D'],
      markerProperty:{setValueAtTime(){}},layers:{items:[],
        add(src){const l=layer(src,'model');this.items.unshift(l);
          l.moveToEnd=()=>{this.items.splice(this.items.indexOf(l),1);this.items.push(l);};return l;},
        addCamera(name){const l=this.add(null);l.kind='camera';l.name=name;return l;},
        addText(){const l=this.add(null);l.kind='text';return l;},
        addLight(name){const l=this.add(null);l.kind='light';l.name=name;return l;},
        addSolid(color,name){const l=this.add(null);l.kind='solid';l.name=name;l.fill=color;return l;}
      }};
    comps.push(result);return result;
  }
  function File(path){
    this.fsName=path;this.parent={parent:{fsName:'/package'}};
    this.exists=/\/(?:timeline\.json|assets\/models\/[^/]+\.glb)$/.test(path);
    this.open=()=>true;this.read=()=>JSON.stringify(source);this.close=()=>{};
  }
  function Folder(path){this.fsName=path;this.exists=false;this.getFiles=()=>[];}
  const project={numItems:0,items:{addComp,addFolder:name=>({name})},
    importFile:opts=>({path:opts.file.fsName,width:1920,height:1080}),save(){}};
  vm.runInNewContext(jsx,{
    app:{project,beginUndoGroup(){},endUndoGroup(){}},
    File,Folder,ImportOptions:function(file){this.file=file;},
    MarkerValue:function(label){this.label=label;},
    AutoOrientType:{CAMERA_OR_POINT_OF_INTEREST:2},
    LightType:{PARALLEL:1,SPOT:2,POINT:3},
    ParagraphJustification:{CENTER_JUSTIFY:1},
    $:{fileName:'/package/AfterEffects/BUILD_EDITABLE_PROJECT.jsx',writeln(){}},
    alert:m=>notices.push(m),confirm:()=>true
  });
  return {comps,notices,shot};
}
test('AE builder produces native editable light and effect layers and complete model workspaces',()=>{
  const {comps,notices,shot}=buildAEWithEditableLook();
  assert.equal(notices.length,1);
  assert.match(notices[0],/project created and saved/);
  assert.doesNotMatch(notices[0],/Completed with .*warning/);
  const workspace=comps.find(x=>x.name.includes(shot.name+' [3D WORKSPACE]'));
  assert.ok(workspace,'source chapter workspace');
  const lights=workspace.layers.items.filter(x=>x.kind==='light');
  assert.equal(lights.length,3);
  const key=lights.find(l=>l.name.includes('Key lamp'));
  assert.equal(key.lightType,2);
  assert.deepEqual(Array.from(key.property('ADBE Transform Group').property('ADBE Position').value),
    [960+(2+20)*18,540-(6+0)*18,-(3+40)*18]);
  assert.deepEqual(Array.from(key.property('ADBE Light Options Group').property('ADBE Light Color').value),
    [1,204/255,136/255]);
  const solids=workspace.layers.items.filter(x=>x.kind==='solid');
  assert.equal(solids.length,2,'adjustment layer plus editable fog tint');
  const look=solids.find(x=>x.adjustmentLayer);
  const effects=look.property('ADBE Effect Parade').added.map(x=>x.matchName);
  assert.deepEqual(effects,['ADBE Glo2','ADBE Exposure2','CS Vignette']);
  assert.ok(solids.find(x=>x.name.includes('PAIGE FOG')));
  assert.equal(comps.filter(x=>x.name.includes('[3D WORKSPACE]')).length,timeline.shots.length);
});
