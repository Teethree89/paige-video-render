// Viewport tool strip: one explicit tool at a time, so navigating never moves or marks anything by accident.
//   orbit : look around only (no gizmo, no point placement)
//   move / rotate : transform gizmo on the selected object (Edit mode)
//   point : place and drag matching points (camera tracker)
export const TOOLS=Object.freeze(['orbit','move','rotate','point']);
export const TOOL_KEYS=Object.freeze({KeyO:'orbit',KeyW:'move',KeyG:'move',KeyE:'rotate',KeyR:'rotate',KeyP:'point'});

export function setupViewportTools({root,onSelect=()=>{}}){
  const buttons=new Map();
  for(const button of root?.querySelectorAll?.('[data-tool]')||[])buttons.set(button.dataset.tool,button);
  const available=new Set(['orbit']);
  let tool='orbit';
  function render(){
    for(const [name,button] of buttons){
      button.disabled=!available.has(name);
      button.classList.toggle('active',name===tool);
      button.setAttribute('aria-pressed',String(name===tool));
    }
    if(root)root.dataset.tool=tool;
    if(typeof document!=='undefined'&&document.body?.dataset)document.body.dataset.viewportTool=tool;
  }
  /** Which tools can be used right now; the active tool falls back to orbit when it becomes unavailable. */
  function setAvailable(names){
    available.clear();available.add('orbit');
    for(const name of names)if(TOOLS.includes(name))available.add(name);
    if(!available.has(tool))tool='orbit';
    render();
  }
  /** Reflect the current tool without asking the host to apply it. */
  function set(name){
    if(!TOOLS.includes(name)||!available.has(name))return false;
    tool=name;render();return true;
  }
  /** User choice: update the strip and let the host apply it. */
  function choose(name){
    if(!available.has(name))return false;
    set(name);onSelect(name);return true;
  }
  for(const [name,button] of buttons)button.addEventListener('click',()=>choose(name));
  render();
  return {get tool(){return tool;},isAvailable:name=>available.has(name),setAvailable,set,choose};
}
