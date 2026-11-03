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

/* ---------------------------------------------------------------- motion toggle (defaults to the OS setting) */
const MOTION_KEY = 'overhang-motion';
/** True when motion is off: the viewer chose "off", or chose nothing and the OS asks for reduced motion. */
export function motionOff(): boolean {
  try {
    const v = localStorage.getItem(MOTION_KEY);
    if (v === 'off') return true;
    if (v === 'on') return false;
  } catch {
    /* storage unavailable: follow the OS */
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function setMotionOff(off: boolean): void {
  try {
    localStorage.setItem(MOTION_KEY, off ? 'off' : 'on');
  } catch {
    /* the choice lasts for this page view only */
  }
  applyMotion();
}

function applyMotion(): void {
  const off = motionOff();
  document.documentElement.toggleAttribute('data-motion-off', off);
  window.dispatchEvent(new CustomEvent('overhang:motion', { detail: { off } }));
}

/** Page chrome shared by index.html and catalog.html: the motion attribute, the phone menu, the "back to the globe" link. */
export function initChrome(): void {
  applyMotion();
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', applyMotion);
  const btn = document.getElementById('menu-btn');
  const bar = document.querySelector<HTMLElement>('.topbar');
  const nav = document.getElementById('sections-nav');
  if (btn && bar && nav) {
    const set = (open: boolean): void => {
      bar.classList.toggle('menu-open', open);
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? 'Close' : 'Menu';
    };
    btn.addEventListener('click', () => set(!bar.classList.contains('menu-open')));
    nav.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a')) set(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && bar.classList.contains('menu-open')) {
        set(false);
        btn.focus();
      }
    });
  }
  const back = document.getElementById('to-globe');
  const plate = document.getElementById('plate');
  if (back && plate && 'IntersectionObserver' in window) {
    new IntersectionObserver((es) => {
      back.hidden = es.some((e) => e.isIntersecting);
    }, { threshold: 0.05 }).observe(plate);
  }
}
