// Rehome the existing, event-wired primitive and light numeric editors into
// the selected-object viewport panel. No duplicate controls or save paths.
// Moving DOM nodes preserves their input event listeners and values.
export function setupSceneSelectionPanel(root=globalThis.document){
 const slot=root?.getElementById?.('sceneEditFields');
 const object=root?.getElementById?.('primitiveFields');
 const light=root?.getElementById?.('primitiveLightFields');
 if(!slot||!object||!light||typeof root.createComment!=='function'||
   typeof object.parentNode?.insertBefore!=='function'||
   typeof light.parentNode?.insertBefore!=='function')
   return {sync(){},restore(){}};
 const nodes=[object,light];
 const homes=nodes.map(node=>{
   const placeholder=root.createComment('Original home of '+node.id);
   node.parentNode.insertBefore(placeholder,node);
   return placeholder;
 });
 let mode=null;
 function moveHome(node,index){
   homes[index].parentNode.insertBefore(node,homes[index]);
 }
 function sync(selectedId){
   const next=selectedId?.startsWith('light::')||selectedId?.startsWith('light-target::')
     ?'light':selectedId?'object':null;
   if(mode!==next){
     nodes.forEach(moveHome);
     if(next==='object')slot.appendChild(object);
     if(next==='light')slot.appendChild(light);
     mode=next;
   }
   slot.hidden=!next;
   // Original primitiveEditor's refresh controls field visibility; don't
   // override its safety state while no selected shape/light is available.
 }
 function restore(){sync(null);}
 return {sync,restore};
}
