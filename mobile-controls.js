// Phone-only controls: overflow menu, fine scrub strip and the one-layer-at-a-time switch.
// The CSS in mobile.css decides which of them show; everything here is inert on desktop.
export const FRAME = 1 / 30;
export const SCRUB_SECONDS_PER_PX = FRAME / 6; // slow: a 300 px swipe moves 1.7 s
export const LAYERS = Object.freeze(['scenes', 'camera', 'text']);
export const LAYER_NAMES = Object.freeze({ scenes: 'Chapters', camera: 'Camera', text: 'Text' });

export const nextLayer = (layer, step) => LAYERS[(LAYERS.indexOf(layer) + step + LAYERS.length) % LAYERS.length];
export const scrubDelta = (dx) => dx * SCRUB_SECONDS_PER_PX;

const seekBy = (delta) => document.dispatchEvent(new CustomEvent('paiver:seek-by', { detail: { delta } }));

function setupMenu(root) {
  const actions = root.querySelector('.header-actions');
  if (!actions) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost mobile-only mobile-menu-btn';
  button.textContent = '⋯';
  button.setAttribute('aria-label', 'More actions');
  button.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'mobile-menu';
  menu.hidden = true;
  const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  const fill = () => {
    menu.replaceChildren();
    for (const original of actions.querySelectorAll(':scope > button:not(.theme-toggle):not(.mobile-menu-btn)')) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'ghost';
      item.textContent = original.textContent.trim();
      item.disabled = original.disabled;
      item.addEventListener('click', () => { close(); original.click(); });
      menu.append(item);
    }
  };
  button.addEventListener('click', () => {
    if (!menu.hidden) { close(); return; }
    fill();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== button) close(); });
  actions.insertBefore(button, actions.querySelector('.timeline-export-picker'));
  root.querySelector('.topbar').append(menu);
}

function setupScrub(timeline) {
  const strip = document.createElement('div');
  strip.className = 'scrub-strip';
  strip.innerHTML = '<button type="button" aria-label="Back one frame" data-step="-1">◂</button>'
    + '<div class="scrub-pad" role="slider" aria-label="Fine scrub the playhead" tabindex="0">‹ ‹  fine scrub  › ›</div>'
    + '<button type="button" aria-label="Forward one frame" data-step="1">▸</button>';
  const header = timeline.querySelector('.timeline-header');
  header.after(strip);
  const pad = strip.querySelector('.scrub-pad');
  let last = null;
  pad.addEventListener('pointerdown', (e) => { last = e.clientX; pad.classList.add('active'); pad.setPointerCapture(e.pointerId); });
  pad.addEventListener('pointermove', (e) => {
    if (last === null) return;
    seekBy(scrubDelta(e.clientX - last));
    last = e.clientX;
  });
  const end = () => { last = null; pad.classList.remove('active'); };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  pad.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') seekBy(-FRAME);
    if (e.key === 'ArrowRight') seekBy(FRAME);
  });
  for (const step of strip.querySelectorAll('[data-step]')) step.addEventListener('click', () => seekBy(FRAME * Number(step.dataset.step)));
}

function setupLayers(timeline) {
  const header = timeline.querySelector('.timeline-header');
  const wrap = document.createElement('div');
  wrap.className = 'layer-switch';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Timeline layer');
  wrap.innerHTML = '<button type="button" data-step="-1" aria-label="Previous layer" title="Previous layer">▲</button>'
    + '<output aria-live="polite"></output>'
    + '<button type="button" data-step="1" aria-label="Next layer" title="Next layer">▼</button>';
  const label = wrap.querySelector('output');
  const set = (layer) => { timeline.dataset.layer = layer; label.textContent = LAYER_NAMES[layer]; };
  for (const b of wrap.querySelectorAll('button')) b.addEventListener('click', () => set(nextLayer(timeline.dataset.layer, Number(b.dataset.step))));
  header.prepend(wrap);
  set('scenes');
}

if (typeof document !== 'undefined') {
  const timeline = document.getElementById('studioTimeline');
  if (timeline) {
    setupMenu(document);
    setupScrub(timeline);
    setupLayers(timeline);
  }
}
