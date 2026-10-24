// Single optional workspace surface; mounted separately so the legacy editor's
// long HTML file, authentication form and current video analyzer remain intact.
export function mountReferenceBuilderUI(root=document){
 if(root.getElementById('referenceBuilderModal'))return;
 const stylesheet=root.createElement('link');stylesheet.rel='stylesheet';stylesheet.href='./reference-builder.css';root.head.append(stylesheet);
 const videoButton=root.getElementById('videoImportOpenBtn');
 if(!videoButton)throw Error('Video import toolbar button is missing');
 const opener=root.createElement('button');
 opener.id='referenceBuilderOpenBtn';opener.className='ghost';opener.type='button';
 opener.textContent='Reference Builder';
 opener.title='Compose a sequence from video clips and still images';
 videoButton.parentNode.insertBefore(opener,videoButton);
 const card=root.querySelector('.reference-card');
 if(card){
   const still=root.createElement('img');still.id='referenceStill';still.alt='Current reference still';
   still.hidden=true;
   const note=root.createElement('p');note.id='referenceMediaStatus';
   note.className='reference-media-status';note.setAttribute('aria-live','polite');
   card.querySelector('#referenceVideo')?.insertAdjacentElement('afterend',still);
   still.insertAdjacentElement('afterend',note);
 }
 const markup=`
<section id="referenceBuilderModal" class="reference-builder-modal" hidden aria-label="Mixed media reference builder">
  <div class="reference-builder-dialog" role="dialog" aria-modal="true" aria-labelledby="referenceBuilderTitle">
    <header class="reference-builder-header">
      <div><span class="tiny-eyebrow">PAIGE / STUDIO · REFERENCE WORKSPACE</span>
        <h2 id="referenceBuilderTitle">Reference Builder</h2>
        <p>Arrange video clips and still images into scenes. Originals remain on this device.</p>
      </div><button id="rbClose" type="button" aria-label="Close reference builder">✕</button>
    </header>
    <div class="reference-builder-grid">
      <aside class="rb-sidebar">
        <div class="rb-section-heading">SCENE LIBRARY <span id="rbSummary">0 scenes</span></div>
        <div class="rb-button-pair">
          <button id="rbAddMedia" type="button" class="primary">+ Add media</button>
          <button id="rbRelinkButton" type="button" class="ghost">Relink files</button>
        </div>
        <input id="rbFiles" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,.mov,.mp4,.webm" multiple hidden>
        <input id="rbRelink" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,.mov,.mp4,.webm" multiple hidden>
        <div id="rbScenes" class="rb-scenes" aria-label="Ordered reference scenes"></div>
        <p class="rb-sidebar-help">Use ↑ ↓ to reorder scenes, duplicate a source, or remove it. Exported JSON stores timing and source names, not source files.</p>
      </aside>
      <main class="rb-center">
        <div class="rb-preview-top"><strong>SOURCE PREVIEW</strong><span>Video · Images · Scene composition</span></div>
        <div class="rb-monitor">
          <img id="rbImage" alt="Reference still preview" hidden>
          <video id="rbVideo" controls muted playsinline hidden aria-label="Reference video preview"></video>
          <div class="rb-empty-preview">Add a video clip or image to begin</div>
        </div>
        <div class="rb-sequence-heading"><strong>REFERENCE SEQUENCE</strong><div class="rb-preview-transport">
          <span id="rbSequenceClock">0:00.00</span>
          <button id="rbPlaySequence" type="button" aria-pressed="false">▶ Play sequence</button>
        </div></div>
        <div id="rbSequenceStrip" class="rb-sequence-strip" aria-label="Reference scene order"></div>
        <p id="rbStatus" role="status">Add your first media file to build a reference sequence.</p>
      </main>
      <aside class="rb-properties">
        <div class="rb-section-heading">SCENE INSPECTOR</div>
        <div id="rbFields" hidden>
          <label class="field">Scene title<input id="rbName" type="text" maxlength="100"></label>
          <div id="rbMediaName" class="rb-source-label"></div>
          <label class="field">Framing<select id="rbFit"><option value="cover">Fill frame (crop)</option><option value="contain">Fit entire source</option></select></label>
          <label class="field">Duration (seconds)<input id="rbDuration" type="number" min="0.5" max="3600" step="0.1"></label>
          <div id="rbVideoFields">
            <label class="field">Video in (seconds)<input id="rbSourceIn" type="number" min="0" step="0.1"></label>
            <label class="field">Video out (seconds)<input id="rbSourceOut" type="number" min="0.5" step="0.1"></label>
            <button id="rbSplitVideo" type="button" class="rb-split-button">Split clip at current preview time</button>
            <p class="field-help">Move the preview playhead between the in/out points, then split to create two reference scenes. The source file is reused.</p>
          </div>
        </div>
        <p class="rb-inspector-help">Select a scene to adjust source in/out points, duration, and framing. Editable 3D generation happens later for each reference scene.</p>
      </aside>
    </div>
    <footer class="reference-builder-footer">
      <span>LOCAL MEDIA · REATTACH ORIGINAL FILES AFTER RELOADING</span>
      <div><input id="rbBundlePicker" type="file" accept=".zip,application/zip" hidden>
        <button id="rbBundleOpen" type="button" class="ghost">Open project ZIP</button>
        <button id="rbBundleExport" type="button" class="ghost">Export with media ZIP</button>
        <button id="rbDownload" type="button" class="ghost">Export reference JSON</button>
        <button id="rbApply" type="button" class="primary" disabled>Use in 3D Editor →</button>
      </div>
    </footer>
  </div>
</section>`;
 root.body.insertAdjacentHTML('beforeend',markup);
}
