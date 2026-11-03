// Shared UI helpers: number formatters, tooltip, verdict pills, honesty labels.

/* ---------------------------------------------------------------- formatters */

/** Expected count E, one decimal: 6.14 -> "6.1". */
export const fmtE = (e: number | null | undefined): string => {
  if (e == null || Number.isNaN(e)) return '–';
  const s = e.toFixed(1);
  // a value that rounds across a threshold the page talks about (1 or 2) prints three decimals, so "2.0" never sits beside "below 2"
  if ((e < 2 && Number(s) >= 2) || (e < 1 && Number(s) >= 1)) return e.toFixed(3);
  return s;
};

/** Integer count with thousands separators. */
export const fmtN = (n: number | null | undefined): string => (n == null || Number.isNaN(n) ? '–' : Math.round(n).toLocaleString('en-US'));

/** p or q value in sensible precision: "<0.001", "0.002", "0.047", "0.31", "0.94". */
export function fmtP(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return '–';
  if (p === 0) return '<0.0001';
  if (p < 0.001) return '<0.001';
  if (p < 0.1) return p.toFixed(3);
  if (p < 0.995) return p.toFixed(2);
  return '>0.99';
}
export const fmtQ = fmtP;

/** Fraction (0..1) as a percentage: 0.943 -> "94%" (pass digits for more). */
export function fmtPct(frac: number | null | undefined, digits = 0): string {
  if (frac == null || Number.isNaN(frac)) return '–';
  return `${(frac * 100).toFixed(digits)}%`;
}

/** A value already on a 0..100 scale (e.g. knn_pct): 97.2 -> "97th". */
export function fmtPercentile(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return '–';
  const n = Math.round(p);
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** Plain decimal, fixed digits (stability, cosines, kappa). */
export const fmtF = (x: number | null | undefined, digits = 2): string => (x == null || Number.isNaN(x) ? '–' : x.toFixed(digits));

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for safe innerHTML interpolation. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c] as string);
}

/* ---------------------------------------------------------------- tooltip */

export interface Tooltip {
  /** `html` must already be escaped. */
  show(html: string, clientX: number, clientY: number): void;
  move(clientX: number, clientY: number): void;
  hide(): void;
}

let sharedTip: Tooltip | null = null;

/** One shared tooltip element for the page. */
export function tooltip(): Tooltip {
  if (sharedTip) return sharedTip;
  const el = document.createElement('div');
  el.className = 'tip';
  el.setAttribute('role', 'tooltip');
  document.body.appendChild(el);
  const place = (x: number, y: number) => {
    const pad = 14;
    const r = el.getBoundingClientRect();
    let left = x + pad;
    let top = y + pad;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - pad;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - pad;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  };
  sharedTip = {
    show(html, x, y) {
      el.innerHTML = html;
      el.classList.add('on');
      place(x, y);
    },
    move: place,
    hide() {
      el.classList.remove('on');
    },
  };
  return sharedTip;
}

/* ---------------------------------------------------------------- verdict pills */

export type Verdict = 'replicated' | 'refuted' | 'underpowered' | 'pending' | 'none found' | 'partial' | 'done';

const VERDICT_CLASS: Record<Verdict, string> = {
  replicated: 'replicated',
  refuted: 'refuted',
  underpowered: 'underpowered',
  pending: 'pending',
  'none found': 'none-found',
  partial: 'partial',
  done: 'done',
};

/** Normalize free-form verdict strings ("Replicated", "none_found", "NONE FOUND") to a Verdict, or null if unknown. */
export function normalizeVerdict(v: string | null | undefined): Verdict | null {
  if (!v) return null;
  const k = v.trim().toLowerCase().replace(/[_-]+/g, ' ');
  return k in VERDICT_CLASS ? (k as Verdict) : null;
}

/** HTML string for a verdict pill. Unknown verdicts render neutrally with their own text. */
export function pill(verdict: string | null | undefined): string {
  const v = normalizeVerdict(verdict);
  if (!v) return `<span class="pill">${esc(verdict ?? 'n/a')}</span>`;
  return `<span class="pill ${VERDICT_CLASS[v]}">${esc(v)}</span>`;
}

/** DOM-element version of pill(). */
export function pillEl(verdict: string | null | undefined): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = pill(verdict);
  return t.content.firstElementChild as HTMLElement;
}

/* ---------------------------------------------------------------- honesty labels */

export type HonestyKind = 'illustrative' | 'exploratory';

/** The label for any number that is illustrative (fake/fixture) or exploratory (not pre-registered). */
export function honesty(kind: HonestyKind, title?: string): string {
  const tip = title ?? (kind === 'illustrative' ? 'Illustrative: not computed from the real data.' : 'Exploratory: not part of the pre-registered test.');
  return `<span class="honesty ${kind}" title="${esc(tip)}">${kind}</span>`;
}
