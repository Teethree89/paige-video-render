// Replaces the browser's slow native title tooltip with a quick one that matches the theme.
// Titles are moved to data-tip on first hover so native tooltips do not double up.
const DELAY = 280;
let tip = null;
let timer = 0;
let current = null;

function ensureTip() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'ui-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  return tip;
}

function tipText(el) {
  const title = el.getAttribute('title');
  if (title) {
    if (!el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', title);
    el.dataset.tip = title;
    el.removeAttribute('title');
  }
  return el.dataset.tip || '';
}

function render(text) {
  const t = ensureTip();
  const m = text.match(/^(.*?)\s*\(([^()]{1,18})\)\s*$/);
  t.textContent = '';
  t.append(m ? m[1] : text);
  if (m) { const k = document.createElement('kbd'); k.textContent = m[2]; t.append(k); }
  return t;
}

function place(el) {
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const below = r.top < h + 16;
  const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${below ? r.bottom + 8 : r.top - h - 8}px`;
}

function hide() {
  clearTimeout(timer);
  current = null;
  tip?.classList.remove('show');
}

document.addEventListener('pointerover', (e) => {
  const el = e.target.closest?.('[title],[data-tip]');
  if (!el || el === current || el.disabled && !el.dataset.tip && !el.getAttribute('title')) return;
  hide();
  const text = tipText(el);
  if (!text) return;
  current = el;
  timer = setTimeout(() => {
    render(text);
    place(el);
    tip.classList.add('show');
  }, DELAY);
});
document.addEventListener('pointerout', (e) => { if (current && !current.contains(e.relatedTarget)) hide(); });
document.addEventListener('pointerdown', hide, true);
document.addEventListener('scroll', hide, true);
document.addEventListener('keydown', hide, true);
