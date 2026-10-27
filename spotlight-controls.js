// Keep inspector fields aligned with the selected chapter spotlight pipeline.
export function spotlightFieldVisibility(type,mode='real'){
 const fakeOnly=type==='spot'&&mode==='fake';
 return {
  intensity:!fakeOnly,
  penumbra:type==='spot'&&!fakeOnly,
  shadows:!fakeOnly,
  fakeConeOpacity:type==='spot'&&mode!=='real'
 };
}
