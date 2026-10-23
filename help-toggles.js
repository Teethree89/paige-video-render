// Folds static explainer text behind small "?" buttons. Paragraphs with an
// id or role are live status lines and stay visible. Without this script
// every explanation simply stays open.
const HEADINGS='.section-label, summary, .input-group-title';
let counter=0;

export function foldHelpText(root=document) {
  // Adjacent explainers share one button.
  const runs=[];
  for(const paragraph of root.querySelectorAll('p.field-help')){
    if(paragraph.id||paragraph.getAttribute('role'))continue;
    const run=runs.at(-1);
    if(run&&run.at(-1)===paragraph.previousElementSibling)run.push(paragraph);
    else runs.push([paragraph]);
  }
  for(const run of runs){
    const button=run[0].ownerDocument.createElement('button');
    button.type='button';
    button.className='help-gem';
    button.textContent='?';
    button.setAttribute('aria-label','Show explanation');
    button.setAttribute('aria-expanded','false');
    // The generated id also marks the paragraph as folded, so a second call skips it.
    button.setAttribute('aria-controls',run.map(p=>p.id='help-text-'+(++counter)).join(' '));
    for(const paragraph of run)paragraph.hidden=true;
    button.addEventListener('click',event=>{
      event.preventDefault(); // inside a <summary>, do not also fold the whole section
      const open=button.getAttribute('aria-expanded')!=='true';
      button.setAttribute('aria-expanded',String(open));
      button.setAttribute('aria-label',open?'Hide explanation':'Show explanation');
      for(const paragraph of run)paragraph.hidden=!open;
    });
    const anchor=run[0].previousElementSibling;
    if(anchor?.matches(HEADINGS))anchor.append(button);
    else{button.classList.add('standalone');run[0].before(button);}
  }
  return runs.length;
}
