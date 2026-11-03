// Theme toggle: Auto (follow the OS) / Dark / Paper (light). The choice lives in localStorage, always inside try/catch.
const KEY = 'overhang-theme';
type Choice = 'auto' | 'dark' | 'light';

function read(): Choice {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'dark' || t === 'light') return t;
  } catch {
    /* storage unavailable: Auto */
  }
  return 'auto';
}

function write(c: Choice): void {
  try {
    if (c === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, c);
  } catch {
    /* storage unavailable: the choice lasts for this page view only */
  }
}

function apply(c: Choice): void {
  const root = document.documentElement;
  if (c === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', c);
  document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.themeChoice === c));
  });
  window.dispatchEvent(new CustomEvent('overhang:theme', { detail: { choice: c } }));
}

export function initTheme(): void {
  apply(read());
  document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach((b) => {
    b.addEventListener('click', () => {
      const c = b.dataset.themeChoice as Choice;
      write(c);
      apply(c);
    });
  });
}

/** True when the page currently renders in the light (paper) theme. Canvas code should re-read tokens on 'overhang:theme'. */
export function isLight(): boolean {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t === 'light';
  return window.matchMedia('(prefers-color-scheme: light)').matches;
}

/** Read a CSS token (e.g. "--void") for canvas/SVG code. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
