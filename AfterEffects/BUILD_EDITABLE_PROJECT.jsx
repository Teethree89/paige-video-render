/*
 Atoms / AI: Adobe After Effects project builder (CC 2024/24.1 or newer recommended)
 File > Scripts > Run Script File… > select this file.
 Creates a native .aep on your computer, 56.47s master comp, 13 editable titles,
 chapter markers, a camera-key reference, and seven linked GLB assets/workspaces.
 The Three.js VFX are NOT translated into AE geometry or effects.
*/
(function () {
  // Never append another set of GLBs and workspaces to an existing project.
  // AE will offer to save/close the current project if it contains edits.
  if (app.project && app.project.numItems > 0) {
    if (!confirm("This builder creates a complete NEW After Effects project.\n\n"
      + "The current project already contains " + app.project.numItems + " item(s). "
      + "Running in it would duplicate all the GLB assets and 3D workspaces.\n\n"
      + "Create a new project instead? After Effects can prompt you to save your current work.")) return;
    var freshProject=app.newProject();
    if (!freshProject || (app.project && app.project.numItems > 0)) {
      alert("Project switch was canceled. No new folders or models were created.");
      return;
    }
  }
  app.beginUndoGroup("Build Atoms to AI editable project");
  var W=1920,H=1080,FPS=30;
  // Both the GLB layers and the keyframed cameras use the SAME conversion.
  // GLBs were exported with scene-local meters and must be transformed into
  // AE's pixel-based 3D coordinate space.
  var AE_PX_PER_WORLD_UNIT=18;
  var GLB_SCALE_PERCENT=AE_PX_PER_WORLD_UNIT*100;
  var warnings=[];
  var currentStage="initialization";
  // IMPORTANT: After Effects ExtendScript throws again if a caught Error is
  // concatenated with a string. Never use ("error: " + err) or String(err).
  function errorDetails(err) {
    if(typeof err==="string")return err;
    if(err===null || typeof err==="undefined")return "Unknown error";
    var msg="";
    try {if(typeof err.message==="string"&&err.message.length)msg=err.message;}catch(ignored){}
    if(!msg)try {if(typeof err.description==="string"&&err.description.length)msg=err.description;}catch(ignored){}
    if(!msg)msg="Unspecified After Effects API error";
    try {if(typeof err.line==="number")msg+=" (line "+err.line+")";}catch(ignored){}
    return msg;
  }
  function reportWarning(area,err) {
    var details=area+": "+errorDetails(err);
    warnings.push(details);
    try{$.writeln(details);}catch(ignored){}
  }
  function indexIn(list,value){
    for(var i=0;i<list.length;i++){if(list[i]===value)return i;}
    return -1;
  }
  var base=new Folder(new File($.fileName).parent.parent.fsName);
  function path(rel){return new File(base.fsName + "/" + rel);}
  function safeImport(file, folder) {
    if (!file.exists) return null;
    try { var opts=new ImportOptions(file);var item=app.project.importFile(opts);if(folder)item.parentFolder=folder;return item; }
    catch(err){reportWarning("Could not import "+file.fsName,err);return null;}
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
  function useAdvancedRenderer(comp){
    try {
      var choices=comp.renderers;
      for(var i=0;i<choices.length;i++){
        if(/advanced/i.test(choices[i])){comp.renderer=choices[i];return true;}
      }
      reportWarning("Advanced 3D renderer not available for "+comp.name,"Select Advanced 3D in Composition Settings");
    }catch(e){reportWarning("Select Advanced 3D renderer manually for "+comp.name,e);}
    return false;
  }
  function positionGLBLayer(layer,label){
    layer.name=label;
    // In AE model layers are natively 3D. Assign transforms independently so
    // a read-only threeDLayer property cannot skip Position and Scale.
    try {layer.threeDLayer=true;}catch(e){}
    var tr=layer.property("ADBE Transform Group");
    tr.property("ADBE Position").setValue([W/2,H/2,0]);
    var scale=tr.property("ADBE Scale");
    if(!scale)throw new Error("GLB model layer has no Scale property");
    scale.setValue([GLB_SCALE_PERCENT,GLB_SCALE_PERCENT,GLB_SCALE_PERCENT]);
  }
  function requireTargetedCamera(cam,label){
    // AE can retain the user's last One-Node Camera preference. A one-node
    // camera ignores Point of Interest even when the property accepts keys.
    // Force the Two-Node / Orient Towards Point Of Interest behavior explicitly.
    try {
      cam.autoOrient=AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
      if(cam.autoOrient!==AutoOrientType.CAMERA_OR_POINT_OF_INTEREST)
        throw new Error("Point of Interest auto-orientation was not enabled");
    }catch(err){
      throw new Error("Cannot set targeted camera for "+label+": "+errorDetails(err));
    }
  }
  function addInspectionCamera(comp,id){
    // A neutral, editable overview that does NOT depend on the shot keyframes.
    // This remains a practical starting point even when the source GLB differs
    // from the procedural geometry or imported Model Settings.
    var distances={exterior:225,hall:110,pcb:52,atoms:46,laser:102,fiber:115,optics:94};
    var distance=distances[id]||100;
    var targetY=id==="exterior"?8:5;
    var cam=comp.layers.addCamera("MODEL VIEW — neutral overview",[W/2,H/2]);
    requireTargetedCamera(cam,"model inspection "+id);
    var tr=cam.property("ADBE Transform Group");
    tr.property("ADBE Position").setValue([W/2,H/2-(targetY+8)*AE_PX_PER_WORLD_UNIT,-distance*AE_PX_PER_WORLD_UNIT]);
    tr.property("ADBE Anchor Point").setValue([W/2,H/2-targetY*AE_PX_PER_WORLD_UNIT,0]);
    return cam;
  }
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
    requireTargetedCamera(camera,shot.name);
    // In ExtendScript camera Point of Interest uses the Anchor Point matchName,
    // NOT "ADBE Point of Interest" (which returns null on many AE versions).
    var tr=camera.property("ADBE Transform Group"),pos=tr.property("ADBE Position"),poi=tr.property("ADBE Anchor Point");
    var cameraOptions=camera.property("ADBE Camera Options Group");
    var zoom=cameraOptions?cameraOptions.property("ADBE Camera Zoom"):null;
    if(!zoom)reportWarning("Camera zoom keyframes unavailable for "+comp.name,"Adjust Zoom manually in Camera Options");
    if(!pos || !poi)throw new Error("Two-node camera Position or Point of Interest property unavailable");
    // Sample only frames which belong to this shot. Sampling at shot.end
    // reads the NEXT shot's cut pose and drags the prior camera toward the
    // next scene, including a different world-space origin.
    var visibleEnd=Math.max(shot.start,shot.end-1/FPS);
    var samples=Math.max(1,Math.ceil((visibleEnd-shot.start)*5));
    for(var n=0;n<=samples;n++) {
      var t=shot.start+(visibleEnd-shot.start)*n/samples;
      var a=interpCamera(seq,Math.min(t,seq.duration));
      var p=[W/2+(a.p[0]-sceneOffset)*AE_PX_PER_WORLD_UNIT,H/2-a.p[1]*AE_PX_PER_WORLD_UNIT,-a.p[2]*AE_PX_PER_WORLD_UNIT];
      var q=[W/2+(a.t[0]-sceneOffset)*AE_PX_PER_WORLD_UNIT,H/2-a.t[1]*AE_PX_PER_WORLD_UNIT,-a.t[2]*AE_PX_PER_WORLD_UNIT];
      var local=t-shot.start;pos.setValueAtTime(local,p);poi.setValueAtTime(local,q);
      // Three.js stores vertical? fov of a PerspectiveCamera is vertical,
      // whereas After Effects camera Zoom uses comp height for equivalent FOV.
      if(zoom && a.fov>1 && a.fov<179)
        zoom.setValueAtTime(local,(H/2)/Math.tan(a.fov*Math.PI/360));
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
    currentStage="open project";
    if (!app.project) app.newProject();
    currentStage="read timeline.json";
    var seq=readTimeline();var duration=seq.duration;
    if(!seq.shots || !seq.shots.length || !seq.camera || !seq.camera.length || !seq.text)throw new Error("Timeline missing shots, camera, or text entries");
    currentStage="create project folders and master composition";
    var projectRoot=makeFolder("ATOMS TO AI — GENERATED PROJECT");
    var assetsFolder=makeFolder("01 — Linked GLB assets",projectRoot),compsFolder=makeFolder("02 — 3D scene workspaces",projectRoot);
    var otherFolder=makeFolder("03 — Media and references",projectRoot),inspectionFolder=makeFolder("04 — Model inspection (camera checks)",projectRoot);
    var comp=app.project.items.addComp("ATOMS TO AI — MASTER EDITABLE",W,H,1,duration,FPS);comp.parentFolder=compsFolder;
    comp.bgColor=[.015,.030,.050];
    // Create workspaces separately so they remain editable but don't double-render over the background preview.
    var fileIds=["exterior","hall","pcb","atoms","laser","fiber","optics"];
    var sceneNames=["Campus exterior","Server and power hall","GaN circuit board","Atomic lattice","InP laser","Optical fiber","Garnet isolator"];
    var glbs={},modelsImported=0;
    for(var i=0;i<fileIds.length;i++) {
      currentStage="import model "+fileIds[i];
      var id=fileIds[i];var item=safeImport(path("assets/models/"+id+".glb"),assetsFolder);
      if(item){glbs[id]=item;modelsImported++;}
    }
    // Separate model inspection comps expose every model without the shot camera
    // obscuring it. AE still uses its own GLB import Model Settings.
    for(var mi=0;mi<fileIds.length;mi++){
      var modelId=fileIds[mi],model=glbs[modelId];if(!model)continue;
      try {
        var inspection=app.project.items.addComp("MODEL CHECK — "+modelId,W,H,1,6,FPS);
        inspection.parentFolder=inspectionFolder;inspection.bgColor=[.04,.05,.07];
        useAdvancedRenderer(inspection);
        var inspectionLayer=inspection.layers.add(model);
        positionGLBLayer(inspectionLayer,sceneNames[mi]+" — edit Scale and Model Settings");
        addInspectionCamera(inspection,modelId);
      }catch(e){reportWarning("Model inspection workspace failed for "+modelId,e);}
    }
    var offsets={exterior:0,hall:180,pcb:360,atoms:440,laser:560,fiber:690,optics:815};
    for(var i=0;i<seq.shots.length;i++){
      var shot=seq.shots[i],sid=shot.id==="finale"?"exterior":shot.id==="hallreturn"?"hall":shot.id;
      currentStage="build 3D workspace "+shot.name;
      var workspace=app.project.items.addComp((i+1<10?"0":"")+(i+1)+" — "+shot.name+" [3D WORKSPACE]",W,H,1,shot.end-shot.start,FPS);workspace.parentFolder=compsFolder;workspace.bgColor=[.01,.025,.045];
      // Imported GLB models require the Advanced 3D composition renderer.
      useAdvancedRenderer(workspace);
      addMarker(comp,shot.start,"SCENE " +(i+1)+" — "+shot.name);
      if(glbs[sid]) {
        try {
          var m=workspace.layers.add(glbs[sid]);
          positionGLBLayer(m,sceneNames[indexIn(fileIds,sid)]+" (linked GLB)");
        }
        catch(e){reportWarning("Model layer could not be added to "+sid,e);}
      }
      try{addCameraKeys(workspace,seq,shot,offsets[sid]);}
      catch(e){reportWarning("Camera import warning for "+shot.name,e);}
      // Source keyframes are an approximation; inspect MODEL CHECK comps first.
      // For a visually incorrect model use Layer > Model Settings (Y Up, Make Comp Size).
    }
    currentStage="import background plate";
    var plate=findPlate(),isClean=false;
    if(plate){
      var plateItem=safeImport(plate.file,otherFolder);if(plateItem){isClean=plate.clean;var bg=comp.layers.add(plateItem);bg.name=isClean?"RENDERED CLEAN VIDEO — replaceable background":"DRAFT PREVIEW — titles already burned in";
        bg.startTime=0;bg.inPoint=0;bg.outPoint=duration;bg.property("ADBE Transform Group").property("ADBE Scale").setValue([W/plateItem.width*100,H/plateItem.height*100]);bg.moveToEnd();bg.locked=true;}
    }
    // Editable overlays. When using the preview MP4, disable these by default to avoid duplicated titles.
    currentStage="create editable text overlays";
    for(var i=0;i<seq.text.length;i++){
      var t=seq.text[i],size={small:36,medium:54,large:76,hero:96}[t.size]||54;
      var title=makeText(comp,"TITLE "+t.id+" — "+t.value.replace(/\n/g," / "),t.value,t.x,t.y,size,t.tone,t.start,t.end);
      if(!isClean)title.enabled=false;
      if(t.subtitle){var sub=makeText(comp,"SUBTITLE "+t.id,t.subtitle,t.x,t.y+6,Math.round(size*.46),t.tone,t.start,t.end);if(!isClean)sub.enabled=false;}
    }
    currentStage="import reference video";
    var ref=safeImport(path("assets/reference.mp4"),otherFolder);
    if(ref)ref.comment="Reference only — not used for rendering";
    var readme=comp.layers.addText("EDITABLE TEXT: all TITLE/SUBTITLE layers above.\n3D GLB source scenes: open 02 — 3D scene workspaces.\nThe MP4 background is a preview and is NOT full-fidelity Three.js lighting.\nTo replace with a clean Three.js render: use Render video ↗ in index.html; export without titles; place MP4 in exports/; rerun builder.");
    readme.name="INSTRUCTIONS — guide layer (not rendered)";readme.guideLayer=true;readme.enabled=false;
    currentStage="save AEP";
    // Never overwrite an existing project or the prior (potentially edited) .aep.
    var stamp=new Date();
    function pad(n){return n<10?"0"+n:""+n;}
    var outputName="ATOMS_TO_AI_EDITABLE_CLEAN_"+
      stamp.getFullYear()+pad(stamp.getMonth()+1)+pad(stamp.getDate())+"_"+
      pad(stamp.getHours())+pad(stamp.getMinutes())+pad(stamp.getSeconds());
    var file=path("AfterEffects/"+outputName+".aep");
    var suffix=2;
    while(file.exists){file=path("AfterEffects/"+outputName+"_"+suffix+".aep");suffix++;}
    app.project.save(file);
    var notice="After Effects project created and saved:\n"+file.fsName+"\n\n"+modelsImported+"/7 GLBs imported.\n"+seq.camera.length+" source camera keyframes; approximate camera paths sampled for scene workspaces.\n"+seq.text.length+" editable title entries.\n"+(isClean?"Clean plate found: text layers are visible.":"Preview has baked titles: editable layers are disabled until you render a clean plate.");
    if(warnings.length){
      notice+="\n\nCompleted with "+warnings.length+" warning(s):";
      for(var wi=0;wi<Math.min(4,warnings.length);wi++)notice+="\n- "+warnings[wi];
      if(warnings.length>4)notice+="\n(+ "+(warnings.length-4)+" more; see ExtendScript console)";
    }
    alert(notice);
  } catch(e){alert("After Effects setup failed during "+currentStage+": "+errorDetails(e));}
  finally { app.endUndoGroup(); }
}());
