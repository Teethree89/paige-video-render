const KEY = 'paiver-theme';
const META_COLOR = { light: '#f4f6f9', dark: '#0a1019' };

export function currentTheme(root = document.documentElement) {
  return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme, root = document.documentElement, storage = globalThis.localStorage) {
  const next = theme === 'light' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try { storage?.setItem(KEY, next); } catch {}
  const meta = root.ownerDocument?.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', META_COLOR[next]);
  return next;
}

export function syncToggle(button, theme) {
  const light = theme === 'light';
  button.textContent = light ? '☾' : '☀';
  button.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
  button.setAttribute('aria-pressed', String(light));
}

const button = typeof document !== 'undefined' ? document.getElementById('themeToggle') : null;
if (button) {
  syncToggle(button, currentTheme());
  button.addEventListener('click', () => syncToggle(button, applyTheme(currentTheme() === 'light' ? 'dark' : 'light')));
}
