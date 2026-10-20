import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const jsx=readFileSync(new URL('../AfterEffects/BUILD_EDITABLE_PROJECT.jsx',import.meta.url),'utf8');
const code=jsx.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|\s)\/\/[^\n]*/g,'$1');

test('After Effects camera guides use the camera Point of Interest matchName',()=>{
  assert.match(code,/poi=tr\.property\("ADBE Anchor Point"\)/);
  assert.doesNotMatch(code,/\.property\("ADBE Point of Interest"\)/);
  assert.match(code,/pos\.setValueAtTime\(local,p\);poi\.setValueAtTime\(local,q\)/);
});

test('Adobe ExtendScript catch paths do not coerce native Error objects',()=>{
  assert.match(code,/function errorDetails\(err\)/);
  assert.match(code,/typeof err\.message==="string"/);
  assert.match(code,/reportWarning\("Camera import warning for "\+shot\.name,e\)/);
  // Reading a primitive field such as err.line is safe; coercing the Error itself is not.
  assert.doesNotMatch(code,/\+\s*(?:err|renderError|e)\b(?!\s*[.([])/);
  assert.doesNotMatch(code,/(?:String\s*\(\s*(?:err|renderError|e)\s*\)|(?:err|renderError|e)\.toString\s*\(\))/);
});

test('Avoid unsupported ES3 Array.indexOf and retain camera failure isolation',()=>{
  assert.match(code,/function indexIn\(list,value\)/);
  assert.doesNotMatch(code,/fileIds\.indexOf\(/);
  assert.match(code,/try\{addCameraKeys\(workspace,seq,shot,origin\);\}/);
  assert.match(code,/catch\(e\)\{reportWarning\("Camera import warning/);
  assert.match(code,/app\.project\.save\(file\)/);
});

test('Builder starts fresh instead of duplicating items in an open AE project',()=>{
  assert.match(code,/app\.project\.numItems\s*>\s*0/);
  assert.match(code,/app\.newProject\(\)/);
  assert.match(code,/Create a new project instead/);
  assert.match(code,/ATOMS TO AI — GENERATED PROJECT/);
  assert.match(code,/makeFolder\("01 — Linked GLB assets",projectRoot\)/);
  assert.match(code,/makeFolder\("02 — 3D scene workspaces",projectRoot\)/);
});

test('Model transforms and camera positions use the same world unit multiplier',()=>{
  assert.match(code,/var AE_PX_PER_WORLD_UNIT=18/);
  assert.match(code,/GLB_SCALE_PERCENT=AE_PX_PER_WORLD_UNIT\/AE_GLTF_PX_PER_METER\*100/);
  assert.match(code,/scale\.setValue\(\[GLB_SCALE_PERCENT,GLB_SCALE_PERCENT,GLB_SCALE_PERCENT\]\)/);
  assert.match(code,/a\.p\[0\]-sceneOffset\[0\]\)\*AE_PX_PER_WORLD_UNIT/);
  assert.match(code,/addInspectionCamera\(inspection,modelId\)/);
  assert.match(code,/positionGLBLayer\(m,modelLabel\)/);
  assert.doesNotMatch(code,/\.setValue\(\[W\/2,H\/2,0\]\);\s*\}/);
});

test('Camera zoom is derived from source vertical field of view',()=>{
  assert.match(code,/property\("ADBE Camera Zoom"\)/);
  assert.match(code,/\(H\/2\)\/Math\.tan\(a\.fov\*Math\.PI\/360\)/);
  assert.match(code,/zoom\.setValueAtTime\(local,/);
});

test('Every run writes a new file rather than overwriting previous AEP work',()=>{
  assert.match(code,/ATOMS_TO_AI_EDITABLE_CLEAN_/);
  assert.match(code,/while\(file\.exists\)/);
  assert.doesNotMatch(code,/path\("AfterEffects\/ATOMS_TO_AI_EDITABLE\.aep"\)/);
});

test('Both inspection and shot cameras are explicitly aimed at their Point of Interest',()=>{
  assert.match(code,/function requireTargetedCamera\(cam,label\)/);
  assert.match(code,/cam\.autoOrient=AutoOrientType\.CAMERA_OR_POINT_OF_INTEREST/);
  assert.match(code,/requireTargetedCamera\(cam,"model inspection "\+id\)/);
  assert.match(code,/requireTargetedCamera\(camera,shot\.name\)/);
});

test('Camera sampling cannot use the next shot cut as the previous shot endpoint',()=>{
  assert.match(code,/var visibleEnd=Math\.max\(shot\.start,shot\.end-1\/FPS\)/);
  assert.match(code,/var t=shot\.start\+\(visibleEnd-shot\.start\)\*n\/samples/);
  assert.doesNotMatch(code,/var t=shot\.start\+\(shot\.end-shot\.start\)\*n\/samples/);

  // Execute the real script's pure interpolation function against the real timeline.
  const match=jsx.match(/function interpCamera\(seq,t\) \{([\s\S]*?)\n  \}/);
  assert.ok(match,'camera interpolation function found');
  const interpolate=new Function('seq','t',match[1]);
  const sequence=JSON.parse(readFileSync(new URL('../timeline.json',import.meta.url),'utf8'));
  const exterior=sequence.shots[0];
  const frameBeforeCut=interpolate(sequence,exterior.end-1/sequence.fps);
  const followingScene=interpolate(sequence,exterior.end);
  assert.equal(frameBeforeCut.p[0],39,'last exterior frame still uses exterior camera');
  assert.equal(followingScene.p[0],180,'hall camera only begins at the hall cut');
});

// Run the complete ExtendScript builder with an AE API double. This checks
// linked asset identities and numeric transforms, beyond source-text matches.
function buildProject() {
  const sequence=JSON.parse(readFileSync(new URL('../timeline.json',import.meta.url),'utf8'));
  const comps=[],notices=[];
  function property() {
    return {value:{},keys:[],setValue(v){this.value=v;},
      setValueAtTime(t,v){this.keys.push({t,value:v});},
      property(name){return this[name]||(this[name]=property());}};
  }
  function layer(source) {
    return Object.assign(property(),{source,moveToEnd(){},
      sourceRectAtTime(){return {left:0,top:0,width:100,height:30};}});
  }
  function comp(name,width,height,pixelAspect,duration,fps) {
    const result={name,width,height,duration,fps,renderers:['Advanced 3D'],
      markerProperty:{setValueAtTime(){}},layers:{items:[],
        add(source){const l=layer(source);this.items.push(l);return l;},
        addCamera(name){const l=this.add(null);l.name=name;return l;},
        addText(){return this.add(null);}}};
    comps.push(result);return result;
  }
  function File(path) {
    this.fsName=path;this.parent={parent:{fsName:'/package'}};
    this.exists=/\/(?:timeline\.json|assets\/models\/[^/]+\.glb)$/.test(path);
    this.open=()=>true;this.read=()=>JSON.stringify(sequence);this.close=()=>{};
  }
  function Folder(path){this.fsName=path;this.exists=false;}
  const project={numItems:0,items:{addComp:comp,addFolder:name=>({name})},
    importFile:opts=>({path:opts.file.fsName}),save(){}};
  vm.runInNewContext(jsx,{
    app:{project,beginUndoGroup(){},endUndoGroup(){}},
    File,Folder,ImportOptions:function(file){this.file=file;},
    MarkerValue:function(label){this.label=label;},
    AutoOrientType:{CAMERA_OR_POINT_OF_INTEREST:2},
    ParagraphJustification:{CENTER_JUSTIFY:1},
    $:{fileName:'/package/AfterEffects/BUILD_EDITABLE_PROJECT.jsx',writeln(){}},
    alert:message=>notices.push(message),confirm:()=>true
  });
  assert.equal(notices.length,1);
  assert.match(notices[0],/project created and saved/);
  assert.doesNotMatch(notices[0],/warning/);
  return comps;
}

test('Executed builder links exterior to both campus shots and hall to both hall shots',()=>{
  const workspaces=buildProject().filter(c=>c.name.includes('[3D WORKSPACE]'));
  assert.deepEqual(workspaces.map(c=>c.layers.items.find(l=>l.source)?.source.path.split('/').pop()),
    ['exterior.glb','hall.glb','pcb.glb','atoms.glb','hall.glb','laser.glb','fiber.glb','optics.glb','exterior.glb']);
});

test('Executed model import compensates native GLTF units before camera registration',()=>{
  const comps=buildProject();
  // Measured from the supplied AE 2026 AEPX and GLB: hall width is
  // 53.01051712036133 source units, 27141.384765625 native AE pixels.
  const sourceWidth=53.01051712036133;
  const nativeWidth=27141.384765625;
  for(const c of comps.filter(c=>c.name.includes('[3D WORKSPACE]')||c.name.startsWith('MODEL CHECK'))){
    const model=c.layers.items.find(l=>l.source);
    const scale=model.property('ADBE Transform Group').property('ADBE Scale').value[0];
    assert.equal(scale,3.515625,'default model scale must compensate the 512 pixel import conversion');
    assert.ok(Math.abs(nativeWidth*scale/100-sourceWidth*18)<.001,
      'one source unit of model geometry must equal the camera conversion of 18 pixels');
    assert.deepEqual(Array.from(model.property('ADBE Transform Group').property('ADBE Position').value),[960,540,0]);
  }
});
