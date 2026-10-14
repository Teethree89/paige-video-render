/*
 Atoms / AI: Adobe After Effects project builder (CC 2024/24.1 or newer recommended)
 File > Scripts > Run Script File… > select this file.
 Creates a native .aep on your computer, 56.47s master comp, 13 editable titles,
 chapter markers, a camera-key reference, and seven linked GLB assets/workspaces.
 The Three.js VFX are NOT translated into AE geometry or effects.
*/
(function () {
  app.beginUndoGroup("Build Atoms to AI editable project");
  var W=1920,H=1080,FPS=30;
  var base=new Folder(new File($.fileName).parent.parent.fsName);
  function path(rel){return new File(base.fsName + "/" + rel);}
  function safeImport(file, folder) {
    if (!file.exists) return null;
    try { var opts=new ImportOptions(file);var item=app.project.importFile(opts);if(folder)item.parentFolder=folder;return item; }
    catch(err){ $.writeln("Could not import " + file.fsName + ": " + err);return null; }
  }
  function readTimeline(){
    var src=path("timeline.json");if(!src.exists)throw new Error("Missing timeline.json next to project files.");
    src.open("r");var raw=src.read();src.close();
    if(typeof JSON!=="undefined"&&JSON.parse)return JSON.parse(raw);
    // Legacy AE ExtendScript compatibility. Only run with your own trusted timeline.json.
    return eval("("+raw+")");
  }
  function addMarker(comp,t,label) {
    var m=new MarkerValue(label);comp.markerProperty.setValueAtTime(t,m);
  }
  function makeFolder(name,parent){var folder=app.project.items.addFolder(name);if(parent)folder.parentFolder=parent;return folder;}
  function AEcolor(tone){return tone==="cyan"?[.67,1,1]:tone==="amber"?[1,.84,.63]:[.968,.980,1];}
  function fadeOpacity(layer,start,end){
    var fadeIn=Math.min(.58,(end-start)/3),fadeOut=Math.min(.55,(end-start)/3);
    var opacity=layer.property("ADBE Transform Group").property("ADBE Opacity");
    opacity.setValueAtTime(start,0);opacity.setValueAtTime(start+fadeIn,100);
    opacity.setValueAtTime(end-fadeOut,100);opacity.setValueAtTime(end,0);
  }
  function makeText(comp, name, content, x, y, size, tone, start, end) {
    var layer=comp.layers.addText(content||" ");layer.name=name;layer.inPoint=start;layer.outPoint=end;
    var textProp=layer.property("ADBE Text Properties").property("ADBE Text Document"),doc=textProp.value;
    doc.text=content||" ";doc.font="Arial-BoldMT";doc.fontSize=size;doc.applyFill=true;doc.fillColor=AEcolor(tone);
    doc.applyStroke=false;
    try{doc.justification=ParagraphJustification.CENTER_JUSTIFY;}catch(err){}
    textProp.setValue(doc);
    // Text anchor: place center of the text rect on the screen-percentage target.
    try{var b=layer.sourceRectAtTime(start,false);layer.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([b.left+b.width/2,b.top+b.height/2]);}catch(err){}
    layer.property("ADBE Transform Group").property("ADBE Position").setValue([x*W/100,y*H/100]);
    fadeOpacity(layer,start,end);return layer;
  }
  function interpCamera(seq,t) {
    var keys=seq.camera;if(t<=keys[0].at)return keys[0];
    for(var i=0;i<keys.length-1;i++){
      var k0=keys[i],k1=keys[i+1];if(t>=k0.at && t<k1.at){if(k1.cut)return k0;
        var u=(t-k0.at)/(k1.at-k0.at);u=u*u*(3-2*u);
        var p=[],look=[];for(var j=0;j<3;j++){p.push(k0.p[j]*(1-u)+k1.p[j]*u);look.push(k0.t[j]*(1-u)+k1.t[j]*u);}
        return {p:p,t:look,fov:k0.fov*(1-u)+k1.fov*u};
      }
    }return keys[keys.length-1];
  }
  function addCameraKeys(comp,seq,shot,sceneOffset) {
    var camera=comp.layers.addCamera("Camera path reference — approximate AE axes",[W/2,H/2]);
    var tr=camera.property("ADBE Transform Group"),pos=tr.property("ADBE Position"),poi=tr.property("ADBE Point of Interest");
    var samples=Math.ceil((shot.end-shot.start)*5);
    for(var n=0;n<=samples;n++) {
      var t=shot.start+(shot.end-shot.start)*n/samples;
      var a=interpCamera(seq,Math.min(t,seq.duration));
      var p=[W/2+(a.p[0]-sceneOffset)*18,H/2-a.p[1]*18,-a.p[2]*18];
      var q=[W/2+(a.t[0]-sceneOffset)*18,H/2-a.t[1]*18,-a.t[2]*18];
      var local=t-shot.start;pos.setValueAtTime(local,p);poi.setValueAtTime(local,q);
    }
    camera.shy=true;return camera;
  }
  function findPlate(){
    var dir=new Folder(base.fsName+"/exports");if(!dir.exists)return null;
    var matches=dir.getFiles("Atoms-to-AI-clean-*.mp4");
    if(matches.length)return {file:matches[0],clean:true};
    var manual=path("exports/flythrough-clean.mp4");if(manual.exists)return {file:manual,clean:true};
    var fallback=path("exports/flythrough-preview.mp4");
    if(fallback.exists)return {file:fallback,clean:false};
    return null;
  }
  try {
    if (!app.project) app.newProject();
    var seq=readTimeline();var duration=seq.duration;
    var assetsFolder=makeFolder("01 — Linked GLB assets"),compsFolder=makeFolder("02 — 3D scene workspaces"),otherFolder=makeFolder("03 — Media and references");
    var comp=app.project.items.addComp("ATOMS TO AI — MASTER EDITABLE",W,H,1,duration,FPS);comp.parentFolder=compsFolder;
    comp.bgColor=[.015,.030,.050];
    // Create workspaces separately so they remain editable but don't double-render over the background preview.
    var fileIds=["exterior","hall","pcb","atoms","laser","fiber","optics"];
    var sceneNames=["Campus exterior","Server and power hall","GaN circuit board","Atomic lattice","InP laser","Optical fiber","Garnet isolator"];
    var glbs={},modelsImported=0;
    for(var i=0;i<fileIds.length;i++) {
      var id=fileIds[i];var item=safeImport(path("assets/models/"+id+".glb"),assetsFolder);
      if(item){glbs[id]=item;modelsImported++;}
    }
    var offsets={exterior:0,hall:180,pcb:360,atoms:440,laser:560,fiber:690,optics:815};
    for(var i=0;i<seq.shots.length;i++){
      var shot=seq.shots[i],sid=shot.id==="finale"?"exterior":shot.id==="hallreturn"?"hall":shot.id;
      var workspace=app.project.items.addComp((i+1<10?"0":"")+(i+1)+" — "+shot.name+" [3D WORKSPACE]",W,H,1,shot.end-shot.start,FPS);workspace.parentFolder=compsFolder;workspace.bgColor=[.01,.025,.045];
      // Imported GLB models require the Advanced 3D composition renderer.
      try {var rendererList=workspace.renderers;for(var ri=0;ri<rendererList.length;ri++){if(/advanced/i.test(rendererList[ri])){workspace.renderer=rendererList[ri];break;}}}catch(renderError){$.writeln("Select Advanced 3D renderer manually: "+renderError);}
      addMarker(comp,shot.start,"SCENE " +(i+1)+" — "+shot.name);
      if(glbs[sid]) {
        try {var m=workspace.layers.add(glbs[sid]);m.name=sceneNames[fileIds.indexOf(sid)] +" (linked GLB)";m.threeDLayer=true;m.property("ADBE Transform Group").property("ADBE Position").setValue([W/2,H/2,0]);}
        catch(e){$.writeln("Model layer could not be added to "+sid+": "+e);}
      }
      try{addCameraKeys(workspace,seq,shot,offsets[sid]);}catch(e){$.writeln("Camera import warning: "+e);}
      // GLB scale and material conversion differs between Three.js and AE; adjust manually in workspaces.
    }
    var plate=findPlate(),isClean=false;
    if(plate){
      var plateItem=safeImport(plate.file,otherFolder);if(plateItem){isClean=plate.clean;var bg=comp.layers.add(plateItem);bg.name=isClean?"RENDERED CLEAN VIDEO — replaceable background":"DRAFT PREVIEW — titles already burned in";
        bg.startTime=0;bg.inPoint=0;bg.outPoint=duration;bg.property("ADBE Transform Group").property("ADBE Scale").setValue([W/plateItem.width*100,H/plateItem.height*100]);bg.moveToEnd();bg.locked=true;}
    }
    // Editable overlays. When using the preview MP4, disable these by default to avoid duplicated titles.
    for(var i=0;i<seq.text.length;i++){
      var t=seq.text[i],size={small:36,medium:54,large:76,hero:96}[t.size]||54;
      var title=makeText(comp,"TITLE "+t.id+" — "+t.value.replace(/\n/g," / "),t.value,t.x,t.y,size,t.tone,t.start,t.end);
      if(!isClean)title.enabled=false;
      if(t.subtitle){var sub=makeText(comp,"SUBTITLE "+t.id,t.subtitle,t.x,t.y+6,Math.round(size*.46),t.tone,t.start,t.end);if(!isClean)sub.enabled=false;}
    }
    var ref=safeImport(path("assets/reference.mp4"),otherFolder);
    if(ref)ref.comment="Reference only — not used for rendering";
    var readme=comp.layers.addText("EDITABLE TEXT: all TITLE/SUBTITLE layers above.\n3D GLB source scenes: open 02 — 3D scene workspaces.\nThe MP4 background is a preview and is NOT full-fidelity Three.js lighting.\nTo replace with a clean Three.js render: use Render video ↗ in index.html; export without titles; place MP4 in exports/; rerun builder.");
    readme.name="INSTRUCTIONS — guide layer (not rendered)";readme.guideLayer=true;readme.enabled=false;
    var file=path("AfterEffects/ATOMS_TO_AI_EDITABLE.aep");app.project.save(file);
    alert("After Effects project created and saved:\n"+file.fsName+"\n\n"+modelsImported+"/7 GLBs imported.\n"+seq.camera.length+" camera keys mapped into per-scene reference workspaces.\n"+seq.text.length+" editable title entries.\n"+(isClean?"Clean plate found: text layers are visible.":"Preview has baked titles: editable layers are disabled until you render a clean plate."));
  } catch(e){alert("After Effects setup failed: "+e.toString()+"\nLine: "+e.line);throw e;}
  finally { app.endUndoGroup(); }
}());
