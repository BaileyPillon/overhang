// Plate hero (#plate): a survey plate of every source (UMAP x,y), the top holes marked as voids.
//
// Honesty: a 2D void placed in empty-looking space would be a lie, because UMAP distorts distance. So a void
// marker sits at the midpoint of the two filament centroids (hole.x, hole.y), and hovering or selecting a hole
// lights the two filaments it sits between: the points carrying its row value (void color, filled dot) and the
// points carrying its column value (ink, hollow ring). Everything else dims.
import './styles/plate.css';
import { Delaunay } from 'd3';
import type { AppData, Hole, Point } from './data';
import { cellLabel } from './data';
import { esc, fmtE, fmtN, tooltip } from './ui';
import { isLight } from './theme';

type RGB = [number, number, number];
type Box = [number, number, number, number];
type Pt = [number, number];

/** Domain -> spectral family (restrained "starlight" tints, blue-white to rose). */
const FAMILIES: { name: string; domains: string[] }[] = [
  { name: 'Devices, software, security', domains: ['devices-home', 'software-dev', 'security-privacy'] },
  { name: 'Science, learning', domains: ['science-research', 'learning'] },
  { name: 'Games, creative, other', domains: ['games', 'creative-media', 'other'] },
  { name: 'Work, civic, home life', domains: ['work-productivity', 'civic-legal', 'food-home-life'] },
  { name: 'Money, travel', domains: ['money-business', 'travel-outdoors'] },
  { name: 'Health, family, social', domains: ['health-body', 'family-kids', 'social-relationships'] },
];
const FAMILY_OF = new Map<string, number>();
FAMILIES.forEach((f, i) => f.domains.forEach((d) => FAMILY_OF.set(d, i)));

const NS = 'http://www.w3.org/2000/svg';
const K = 1.15; // horizontal stretch: a layout choice only, UMAP axes carry no metric meaning
const N_VOIDS = 6;
const NARROW_BELOW = 900;
const NAME_FONT = 'italic 400 17px Newsreader, "Source Serif 4", Georgia, serif';
const CODE_FONT = '500 10.5px "IBM Plex Mono", ui-monospace, monospace';
const SMALL_FONT = '400 10px "IBM Plex Mono", ui-monospace, monospace';

/* ------------------------------------------------------------------ small helpers */

function svgEl<T extends SVGElement = SVGElement>(tag: string, attrs: Record<string, string | number>, parent?: Element): T {
  const e = document.createElementNS(NS, tag) as T;
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(e);
  return e;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

let colorCtx: CanvasRenderingContext2D | null = null;
/** Resolve any CSS color (hex, rgb, color-mix) to RGB. */
function rgbOf(css: string): RGB {
  if (!colorCtx) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    colorCtx = c.getContext('2d', { willReadFrequently: true });
  }
  const x = colorCtx;
  if (!x) return [128, 128, 128];
  x.clearRect(0, 0, 1, 1);
  x.fillStyle = '#808080';
  x.fillStyle = css;
  x.fillRect(0, 0, 1, 1);
  const d = x.getImageData(0, 0, 1, 1).data;
  return [d[0] as number, d[1] as number, d[2] as number];
}

const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round) as RGB;
const rgbStr = (c: RGB, a = 1): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

let measureCtx: CanvasRenderingContext2D | null = null;
function textW(str: string, font: string): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return str.length * 6;
  measureCtx.font = font;
  return measureCtx.measureText(str).width;
}

const rectsHit = (a: Box, b: Box): boolean => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
function circleRect(c: Pt, r: number, b: Box): boolean {
  const nx = Math.max(b[0], Math.min(c[0], b[2]));
  const ny = Math.max(b[1], Math.min(c[1], b[3]));
  return Math.hypot(nx - c[0], ny - c[1]) < r;
}
function segCircleDist(a: Pt, b: Pt, c: Pt): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((c[0] - a[0]) * vx + (c[1] - a[1]) * vy) / l2));
  return Math.hypot(a[0] + t * vx - c[0], a[1] + t * vy - c[1]);
}
function segCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const o = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return o(p3, p4, p1) * o(p3, p4, p2) < 0 && o(p1, p2, p3) * o(p1, p2, p4) < 0;
}
function segHitsRect(a: Pt, b: Pt, r: Box): boolean {
  const n = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6));
  for (let i = 0; i <= n; i++) {
    const x = a[0] + ((b[0] - a[0]) * i) / n;
    const y = a[1] + ((b[1] - a[1]) * i) / n;
    if (x > r[0] && x < r[2] && y > r[1] && y < r[3]) return true;
  }
  return false;
}

/** Coarse grid of star counts, so label placement can ask "how crowded is this box" in O(cells). */
class StarGrid {
  private readonly cs = 10;
  private readonly nx: number;
  private readonly ny: number;
  private readonly cells: Uint16Array;
  constructor(w: number, h: number, pts: Pt[]) {
    this.nx = Math.ceil(w / this.cs) + 1;
    this.ny = Math.ceil(h / this.cs) + 1;
    this.cells = new Uint16Array(this.nx * this.ny);
    for (const [x, y] of pts) {
      const cx = Math.floor(x / this.cs);
      const cy = Math.floor(y / this.cs);
      if (cx >= 0 && cy >= 0 && cx < this.nx && cy < this.ny) this.cells[cy * this.nx + cx]!++;
    }
  }
  inBox(b: Box, pad: number): number {
    let n = 0;
    const x0 = Math.max(0, Math.floor((b[0] - pad) / this.cs));
    const x1 = Math.min(this.nx - 1, Math.floor((b[2] + pad) / this.cs));
    const y0 = Math.max(0, Math.floor((b[1] - pad) / this.cs));
    const y1 = Math.min(this.ny - 1, Math.floor((b[3] + pad) / this.cs));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) n += this.cells[y * this.nx + x] as number;
    return n;
  }
  nearSeg(a: Pt, b: Pt): number {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(2, Math.round(len / 8));
    let n = 0;
    for (let i = 0; i <= steps; i++) {
      const x = a[0] + ((b[0] - a[0]) * i) / steps;
      const y = a[1] + ((b[1] - a[1]) * i) / steps;
      if (this.inBox([x, y, x, y], 3) > 0) n++;
    }
    return n;
  }
}

/* ------------------------------------------------------------------ label placement */

interface Cand {
  E: Pt;
  A: Pt;
  S: Pt;
  side: 1 | -1;
  box: Box;
  base: number;
}
interface Callout {
  hole: Hole;
  c: Pt;
  r: number;
  w: number;
  h: number;
  lines: string[];
  cands: Cand[];
  pick: Cand | null;
}

function placeCallouts(items: Callout[], grid: StarGrid, avoid: Box[], plot: Box, narrow: boolean): void {
  const lens = narrow ? [12, 24, 38, 56] : [24, 48, 80, 120, 170, 230, 300, 380];
  for (const cc of items) {
    cc.cands = [];
    for (let a = 0; a < 360; a += 10) {
      const rad = (a * Math.PI) / 180;
      const dx = Math.cos(rad);
      const dy = -Math.sin(rad);
      const side: 1 | -1 = dx >= 0 ? 1 : -1;
      for (const Ln of lens) {
        const E: Pt = [cc.c[0] + dx * cc.r, cc.c[1] + dy * cc.r];
        const A: Pt = [cc.c[0] + dx * (cc.r + Ln), cc.c[1] + dy * (cc.r + Ln)];
        const S: Pt = [A[0] + side * (cc.w + 6), A[1]];
        cc.cands.push({
          E, A, S, side,
          box: [Math.min(A[0], S[0]), A[1] - cc.h, Math.max(A[0], S[0]), A[1] + 3],
          base: Ln * 0.3 + Math.abs(dy) * (narrow ? 4 : 26),
        });
      }
    }
    cc.pick = null;
  }
  const cost = (cc: Callout, cd: Cand): number => {
    let c = cd.base;
    const box = cd.box;
    if (box[0] < plot[0] || box[2] > plot[2] || box[1] < plot[1] || box[3] > plot[3]) return 1e6;
    for (const av of avoid) if (rectsHit(box, av)) return 1e6;
    for (const oc of items) {
      if (circleRect(oc.c, oc.r + 5, box)) return 1e6;
      if (oc !== cc && (segCircleDist(cd.E, cd.A, oc.c) < oc.r + 4 || segCircleDist(cd.A, cd.S, oc.c) < oc.r + 4)) c += 4000;
    }
    for (const o of items) {
      if (o === cc || !o.pick) continue;
      const pk = o.pick;
      if (rectsHit(box, pk.box)) return 1e6;
      if (segHitsRect(cd.E, cd.A, pk.box) || segHitsRect(pk.E, pk.A, box)) c += 4000;
      if (segHitsRect(cd.A, cd.S, pk.box) || segHitsRect(pk.A, pk.S, box)) c += 4000;
      for (const [p1, p2] of [[cd.E, cd.A], [cd.A, cd.S]] as [Pt, Pt][]) {
        for (const [p3, p4] of [[pk.E, pk.A], [pk.A, pk.S]] as [Pt, Pt][]) if (segCross(p1, p2, p3, p4)) c += 3500;
      }
    }
    c += grid.inBox(box, 6) * 12;
    c += (grid.nearSeg(cd.E, cd.A) + grid.nearSeg(cd.A, cd.S)) * 10;
    return c;
  };
  const best = (cc: Callout): Cand | null => {
    let b: Cand | null = null;
    let bc = Infinity;
    for (const cd of cc.cands) {
      const cs = cost(cc, cd);
      if (cs < bc) { bc = cs; b = cd; }
    }
    return b;
  };
  const order = items.slice().sort((a, b) => b.hole.E - a.hole.E);
  for (const cc of order) cc.pick = best(cc);
  for (let pass = 0; pass < 3; pass++) for (const cc of order) cc.pick = best(cc);
}

interface SmallLabel {
  x: number;
  y: number;
  text: string;
}
interface PlacedSmall {
  it: SmallLabel;
  ax: number;
  ay: number;
  dir: Pt;
}

function placeSmall(items: SmallLabel[], grid: StarGrid, avoid: Box[], plot: Box, circles: { c: Pt; r: number }[], taken: Box[], maxCost: number, maxN: number): PlacedSmall[] {
  const out: PlacedSmall[] = [];
  for (const it of items) {
    if (out.length >= maxN) break;
    const w = textW(it.text, SMALL_FONT) + 2;
    const hgt = 12;
    let best: { cost: number; box: Box; ax: number; ay: number; dir: Pt } | null = null;
    for (const dir of [[1, -1], [1, 0], [1, 1], [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1]] as Pt[]) {
      for (const off of [11, 17]) {
        const ax = it.x + dir[0] * off;
        const ay = it.y + dir[1] * off * 0.8;
        const x0 = dir[0] > 0 ? ax : dir[0] < 0 ? ax - w : ax - w / 2;
        const box: Box = [x0, ay - hgt / 2 - 1, x0 + w, ay + hgt / 2 + 1];
        let cost = off * 0.5 + (dir[1] !== 0 ? 1.5 : 0);
        if (box[0] < plot[0] || box[2] > plot[2] || box[1] < plot[1] || box[3] > plot[3]) cost += 8000;
        for (const b of taken) if (rectsHit(box, b)) cost += 6000;
        for (const b of avoid) if (rectsHit(box, b)) cost += 6000;
        for (const c of circles) if (circleRect(c.c, c.r + 3, box)) cost += 1500;
        // the labelled star itself sits inside the +-4 pad of nearby boxes, so discount one
        cost += Math.max(0, grid.inBox(box, 3) - 1) * 14;
        if (!best || cost < best.cost) best = { cost, box, ax, ay, dir };
      }
    }
    if (best && best.cost < maxCost) {
      taken.push(best.box);
      out.push({ it, ax: best.ax, ay: best.ay, dir: best.dir });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the plate */

interface Layout {
  W: number;
  H: number;
  narrow: boolean;
  px0: number;
  py0: number;
  pw: number;
  ph: number;
  s: number;
  ox: number;
  by: number;
  X: (x: number) => number;
  Y: (y: number) => number;
}

interface Pal {
  dark: boolean;
  tint: RGB[];
  ink: RGB;
  void: RGB;
}

interface Sprites {
  haze: HTMLCanvasElement[];
  glow: HTMLCanvasElement[];
  glowV: HTMLCanvasElement[];
  hazeInk: HTMLCanvasElement;
  hlVoid: HTMLCanvasElement;
  hlInk: HTMLCanvasElement;
}

export function initPlate(el: HTMLElement, data: AppData): void {
  const { meta, points, holes } = data;
  if (!points.length) {
    el.innerHTML = '<p class="pl-c2" style="padding:24px">No points to plot.</p>';
    return;
  }
  const N = points.length;
  const nVideo = points.filter((p) => p.v).length;
  const regHoles = holes.filter((h) => h.prereg);
  const regE = (h: Hole): number => h.registered?.E ?? h.E;
  const nAnchors = points.filter((p) => p.id.startsWith('anchors-')).length;
  const pointById = new Map(points.map((p) => [p.id, p]));
  const holeByCode = new Map(holes.map((h) => [h.code, h]));
  const top: Hole[] = regHoles.slice().sort((a, b) => regE(b) - regE(a)).slice(0, N_VOIDS);
  const isTop = new Set(top.map((h) => h.code));
  const fam = points.map((p) => FAMILY_OF.get(p.d) ?? 2);
  const hh = points.map((p) => hashStr(p.id));
  const indexOfId = new Map(points.map((p, i) => [p.id, i]));

  // data bounds (holes included, so a midpoint can never fall off the plate)
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const p of points) {
    xmin = Math.min(xmin, p.x); xmax = Math.max(xmax, p.x);
    ymin = Math.min(ymin, p.y); ymax = Math.max(ymax, p.y);
  }
  for (const h of top) {
    xmin = Math.min(xmin, h.x); xmax = Math.max(xmax, h.x);
    ymin = Math.min(ymin, h.y); ymax = Math.max(ymax, h.y);
  }
  const PAD = 0.18;
  xmin -= PAD; xmax += PAD; ymin -= PAD; ymax += PAD;
  const U = (xmax - xmin) * K;
  const V = ymax - ymin;

  const model = (meta.models[0] ?? 'bge-base-en-v1.5').split('/').pop() as string;
  const holeName = (h: Hole) => cellLabel(h);

  /* ---------------- DOM */
  el.classList.add('pl');
  el.innerHTML = `
    <div class="pl-stage">
      <canvas class="pl-sky" aria-hidden="true"></canvas>
      <svg class="pl-ov" aria-hidden="true" focusable="false"></svg>
      <div class="pl-hit"></div>
    </div>
    <div class="pl-head" data-avoid>
      <span>Survey plate I &middot; field: things done with Claude</span>
      <span class="sym" aria-hidden="true">
        <span><svg viewBox="0 0 18 14"><circle cx="9" cy="7" r="1.6" fill="currentColor"/></svg>source</span>
        <span><svg viewBox="0 0 18 14"><circle cx="9" cy="7" r="2.2" fill="currentColor"/><path d="M1 7h16M9 0v14" stroke="currentColor" stroke-width=".8"/></svg>from the video &middot; ${fmtN(nVideo)}</span>
        <span><svg viewBox="0 0 18 14"><circle cx="9" cy="7" r="5.5" fill="none" stroke="var(--void)" stroke-width="1.2" stroke-dasharray="3 2.4"/></svg>void: midpoint of two filaments</span>
      </span>
    </div>
    <div class="pl-left" data-avoid>
      <p class="pl-eyebrow">A survey of what nobody has reported yet</p>
      <h1>${esc(fmtN(N))} things people have done with Claude, and <em>the holes between them.</em></h1>
      <p class="pl-dek">Most points are something a person really did, with a source; ${esc(fmtN(nAnchors))} are representative tasks from Anthropic&rsquo;s usage reports. A move (what was done) and a material (what it was done to) can each be common and still never meet. Those unmet pairs are the holes. Hover a ring to light the two filaments it sits between.</p>
      <div class="pl-stats">
        <div><b>${esc(fmtN(N))}</b><span>sources</span></div>
        <div><b>${esc(fmtN(nVideo))}</b><span>from one video</span></div>
        <div><b>${esc(fmtN(regHoles.length))}</b><span>holes registered, top ${top.length} ringed</span></div>
      </div>
      <a class="pl-cta" href="#matrix">Read the void catalog <span aria-hidden="true">&darr;</span></a>
      <div class="pl-key">
        <h4>Spectral key &middot; domain family</h4>
        <ul>${FAMILIES.map((f, i) => `<li><span class="pl-sw" style="--c:var(--pl-s${i})"></span><span>${esc(f.name)}</span></li>`).join('')}</ul>
      </div>
    </div>
    <div class="pl-legend" data-avoid role="status" aria-live="polite"></div>
    <ol class="pl-list" aria-label="Voids"></ol>
    <div class="pl-caption" data-avoid>
      <div class="pl-c1">PLATE I &middot; ${esc(fmtN(N))} SOURCES &middot; ${esc(model)} &middot; PCA-${esc(meta.pca)} &middot; k=${esc(meta.k)}</div>
      <div class="pl-c2">Rings mark the midpoint between two filaments, not empty space: UMAP distorts distance. Axes carry no metric meaning.</div>
    </div>
    <p class="sr">Map of ${esc(fmtN(N))} sources. The ${top.length} largest holes are buttons: ${top.map((h) => esc(`${h.code} ${holeName(h)}`)).join('; ')}. Selecting one highlights the two groups of sources it sits between.</p>`;

  const stage = el.querySelector<HTMLDivElement>('.pl-stage') as HTMLDivElement;
  const cv = el.querySelector<HTMLCanvasElement>('.pl-sky') as HTMLCanvasElement;
  const ov = el.querySelector<SVGSVGElement>('.pl-ov') as SVGSVGElement;
  const hitLayer = el.querySelector<HTMLDivElement>('.pl-hit') as HTMLDivElement;
  const legend = el.querySelector<HTMLDivElement>('.pl-legend') as HTMLDivElement;
  const listEl = el.querySelector<HTMLOListElement>('.pl-list') as HTMLOListElement;
  const leftCol = el.querySelector<HTMLDivElement>('.pl-left') as HTMLDivElement;
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;

  /* hit targets, created once and repositioned on layout, so keyboard focus survives resizes */
  const btns = new Map<string, HTMLButtonElement>();
  const labHits = new Map<string, HTMLDivElement>();
  const listBtns = new Map<string, HTMLButtonElement>();
  for (const h of top) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pl-void';
    b.dataset.code = h.code;
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', `${h.code}: ${holeName(h)}. Highlight the two groups of sources this hole sits between.`);
    hitLayer.appendChild(b);
    btns.set(h.code, b);
    const lh = document.createElement('div');
    lh.className = 'pl-lab-hit';
    lh.setAttribute('aria-hidden', 'true');
    hitLayer.appendChild(lh);
    labHits.set(h.code, lh);
    const li = document.createElement('li');
    const lb = document.createElement('button');
    lb.type = 'button';
    lb.setAttribute('aria-pressed', 'false');
    lb.innerHTML = `<span class="code">${esc(h.code)}</span><span>${esc(holeName(h))}</span>`;
    li.appendChild(lb);
    listEl.appendChild(li);
    listBtns.set(h.code, lb);
  }

  /* ---------------- state */
  let L: Layout = null as unknown as Layout;
  let pal: Pal;
  let spr: Sprites;
  let dpr = 1;
  let spx: Pt[] = [];
  let delaunay: Delaunay<Pt> | null = null;
  let grid: StarGrid;
  let hover: string | null = null;
  let pinned: string | null = null;
  let shown: string | null = null; // code currently lit
  let hl: Map<string, number> | null = null; // id -> bit 1 row, bit 2 col
  let dimT = 0;
  let dimTarget = 0;
  let raf = 0;
  let lastTs = 0;
  let calloutG: Map<string, SVGGElement> = new Map();
  let markG: Map<string, SVGGElement> = new Map();
  let gActive: SVGGElement | null = null;
  let gHover: SVGGElement | null = null;
  let tapIdx = -1;
  let hoverIdx = -1;
  const tip = tooltip();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------------- palette + sprites */
  function readPalette(): Pal {
    const cs = getComputedStyle(el);
    const tint: RGB[] = [];
    for (let i = 0; i < FAMILIES.length; i++) tint.push(rgbOf(cs.getPropertyValue(`--pl-s${i}`).trim() || '#888'));
    return { dark: !isLight(), tint, ink: rgbOf(cs.getPropertyValue('--ink').trim()), void: rgbOf(cs.getPropertyValue('--void').trim()) };
  }

  function radial(c: RGB, r: number, a0: number): HTMLCanvasElement {
    const size = Math.max(2, Math.ceil(2 * r * dpr));
    const s = document.createElement('canvas');
    s.width = s.height = size;
    const x = s.getContext('2d') as CanvasRenderingContext2D;
    const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, rgbStr(c, a0));
    g.addColorStop(1, rgbStr(c, 0));
    x.fillStyle = g;
    x.fillRect(0, 0, size, size);
    return s;
  }

  function sizes() {
    const narrow = L.narrow;
    return { k: narrow ? 0.72 : 1, hk: narrow ? 0.34 : 1 };
  }

  function buildSprites(): void {
    const { k, hk } = sizes();
    const d = pal.dark;
    spr = {
      haze: pal.tint.map((c) => radial(c, 52 * hk, 0.03)),
      glow: pal.tint.map((c) => radial(c, 9 * k, 0.22)),
      glowV: pal.tint.map((c) => radial(c, 16 * k, 0.38)),
      hazeInk: radial(pal.ink, 44 * hk, d ? 0.02 : 0.02),
      hlVoid: radial(pal.void, 16 * k, 0.4),
      hlInk: radial(pal.ink, 14 * k, 0.32),
    };
  }

  /* ---------------- geometry */
  function layout(): void {
    const narrow = el.clientWidth < NARROW_BELOW;
    el.classList.toggle('pl-narrow', narrow);
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    const ml = narrow ? 34 : 64;
    const mr = narrow ? 10 : 30;
    const mt = narrow ? 14 : 46;
    const mb = narrow ? 46 : 84;
    const px0 = ml, py0 = mt, pw = W - ml - mr, ph = H - mt - mb;
    let regionL = px0 + 6;
    const regionR = px0 + pw - (narrow ? 4 : 12);
    if (!narrow) {
      const pr = el.getBoundingClientRect();
      const lr = leftCol.getBoundingClientRect();
      regionL = Math.max(px0 + 12, lr.right - pr.left + 18);
    }
    const s = Math.min((regionR - regionL) / U, (ph * (narrow ? 0.95 : 0.88)) / V);
    const dw = U * s;
    const dh = V * s;
    const cx = (regionL + regionR) / 2;
    const ox = cx - dw / 2;
    const by = py0 + ph / 2 + dh / 2;
    L = {
      W, H, narrow, px0, py0, pw, ph, s, ox, by,
      X: (x) => ox + (x - xmin) * K * s,
      Y: (y) => by - (y - ymin) * s,
    };
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    spx = points.map((p) => [L.X(p.x), L.Y(p.y)] as Pt);
    delaunay = Delaunay.from(spx);
    grid = new StarGrid(W, H, spx);
    pal = readPalette();
    buildSprites();
  }

  /* ---------------- canvas painting */
  function paintSky(): void {
    const { W, H } = L;
    const { k } = sizes();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const dim = hl ? dimT : 0;
    const fade = 1 - 0.82 * dim; // non-members
    const dark = pal.dark;
    const member = (i: number): number => (hl ? (hl.get((points[i] as Point).id) ?? 0) : 0);

    if (dark) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < N; i++) {
        const [x, y] = spx[i] as Pt;
        if (x < -80 || x > W + 80 || y < -80 || y > H + 80) continue;
        const sp = spr.haze[fam[i] as number] as HTMLCanvasElement;
        const r = sp.width / dpr / 2;
        ctx.globalAlpha = hl && !member(i) ? fade * fade : 1;
        ctx.drawImage(sp, x - r, y - r, 2 * r, 2 * r);
      }
      for (let i = 0; i < N; i++) {
        const [x, y] = spx[i] as Pt;
        const p = points[i] as Point;
        const sp = (p.v ? spr.glowV : spr.glow)[fam[i] as number] as HTMLCanvasElement;
        const r = sp.width / dpr / 2;
        ctx.globalAlpha = (hl && !member(i) ? fade : 1) * (p.v ? 1 : 0.77 + (hh[i] as number) * 0.23);
        ctx.drawImage(sp, x - r, y - r, 2 * r, 2 * r);
      }
      ctx.globalAlpha = 1;
      for (let i = 0; i < N; i++) {
        const [x, y] = spx[i] as Pt;
        const p = points[i] as Point;
        const c = mixRgb(pal.ink, pal.tint[fam[i] as number] as RGB, 0.3);
        const a = (hl && !member(i) ? fade : 1) * (p.v ? 1 : 0.9);
        const r = (p.v ? 2.1 : 1.15 + (hh[i] as number) * 0.45) * k;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 6.2832);
        ctx.fillStyle = rgbStr(c, a);
        ctx.fill();
        if (p.v) {
          const Ln = 13 * k;
          for (const d of [[1, 0], [0, 1]]) {
            const g = ctx.createLinearGradient(x - (d[0] as number) * Ln, y - (d[1] as number) * Ln, x + (d[0] as number) * Ln, y + (d[1] as number) * Ln);
            g.addColorStop(0, rgbStr(c, 0));
            g.addColorStop(0.5, rgbStr(c, 0.85 * (hl && !member(i) ? fade : 1)));
            g.addColorStop(1, rgbStr(c, 0));
            ctx.strokeStyle = g;
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            ctx.moveTo(x - (d[0] as number) * Ln, y - (d[1] as number) * Ln);
            ctx.lineTo(x + (d[0] as number) * Ln, y + (d[1] as number) * Ln);
            ctx.stroke();
          }
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    } else {
      for (let i = 0; i < N; i++) {
        const [x, y] = spx[i] as Pt;
        if (x < -80 || x > W + 80 || y < -80 || y > H + 80) continue;
        const sp = spr.hazeInk;
        const r = sp.width / dpr / 2;
        ctx.globalAlpha = hl && !member(i) ? fade * fade : 1;
        ctx.drawImage(sp, x - r, y - r, 2 * r, 2 * r);
      }
      ctx.globalAlpha = 1;
      for (let i = 0; i < N; i++) {
        const [x, y] = spx[i] as Pt;
        const p = points[i] as Point;
        const c = mixRgb(pal.ink, pal.tint[fam[i] as number] as RGB, 0.4);
        const a = (hl && !member(i) ? fade : 1) * (p.v ? 1 : 0.88);
        const r = (p.v ? 2.8 : 1.45 + (hh[i] as number) * 0.45) * k;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 6.2832);
        ctx.fillStyle = rgbStr(c, a);
        ctx.fill();
        if (p.v) {
          ctx.beginPath();
          ctx.arc(x, y, 5.6 * k, 0, 6.2832);
          ctx.strokeStyle = rgbStr(c, 0.7 * (hl && !member(i) ? fade : 1));
          ctx.lineWidth = 0.9;
          ctx.stroke();
        }
      }
    }

    // the two filaments, on top: row value = filled void-colored dot, column value = hollow ink ring
    if (hl && dim > 0) {
      for (const pass of [1, 2]) {
        for (let i = 0; i < N; i++) {
          const m = member(i);
          if (!(m & pass)) continue;
          const [x, y] = spx[i] as Pt;
          const row = pass === 1;
          if (dark) {
            ctx.globalCompositeOperation = 'lighter';
            const sp = row ? spr.hlVoid : spr.hlInk;
            const r = sp.width / dpr / 2;
            ctx.globalAlpha = dim;
            ctx.drawImage(sp, x - r, y - r, 2 * r, 2 * r);
            ctx.globalCompositeOperation = 'source-over';
          }
          ctx.globalAlpha = dim;
          if (row) {
            ctx.beginPath();
            ctx.arc(x, y, 3.4 * k, 0, 6.2832);
            ctx.fillStyle = rgbStr(pal.void);
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.arc(x, y, 4.6 * k, 0, 6.2832);
            ctx.strokeStyle = rgbStr(pal.ink);
            ctx.lineWidth = 1.4;
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  function frame(ts: number): void {
    raf = 0;
    const dt = lastTs ? Math.min(64, ts - lastTs) : 16;
    lastTs = ts;
    const step = dt / 150;
    if (dimT < dimTarget) dimT = Math.min(dimTarget, dimT + step);
    else if (dimT > dimTarget) dimT = Math.max(dimTarget, dimT - step);
    paintSky();
    if (dimT !== dimTarget) raf = requestAnimationFrame(frame);
    else {
      lastTs = 0;
      if (dimTarget === 0) hl = null;
    }
  }
  function kick(): void {
    if (reduceMotion.matches) {
      dimT = dimTarget;
      if (dimTarget === 0) hl = null;
      paintSky();
      return;
    }
    if (!raf) raf = requestAnimationFrame(frame);
  }

  /* ---------------- svg overlay */
  const fmtTick = (v: number) => String(v).replace('-', '−');

  function drawOverlay(): void {
    while (ov.firstChild) ov.removeChild(ov.firstChild);
    ov.setAttribute('viewBox', `0 0 ${L.W} ${L.H}`);
    const g0 = svgEl<SVGGElement>('g', {}, ov);
    const x0 = L.px0, y0 = L.py0, x1 = L.px0 + L.pw, y1 = L.py0 + L.ph;
    const ux = (xv: number) => L.X(xv);
    const vy = (yv: number) => L.Y(yv);
    const xlo = xmin + (x0 - L.ox) / (L.s * K);
    const xhi = xmin + (x1 - L.ox) / (L.s * K);
    const ylo = ymin + (L.by - y1) / L.s;
    const yhi = ymin + (L.by - y0) / L.s;
    for (let xv = Math.ceil(xlo); xv <= xhi; xv++) svgEl('line', { x1: ux(xv), x2: ux(xv), y1: y0, y2: y1, class: 'pl-grat' }, g0);
    for (let yv = Math.ceil(ylo); yv <= yhi; yv++) svgEl('line', { x1: x0, x2: x1, y1: vy(yv), y2: vy(yv), class: 'pl-grat' }, g0);
    svgEl('rect', { x: x0, y: y0, width: L.pw, height: L.ph, class: 'pl-frame' }, g0);
    // survey-plate edge ticks, labeled in UMAP units
    const minor = L.narrow ? 0.5 : 0.25;
    const lblEvery = L.narrow ? 2 : 1;
    for (let xv = Math.ceil(xlo / minor) * minor; xv <= xhi + 1e-9; xv += minor) {
      const maj = Math.abs(xv - Math.round(xv)) < 1e-6;
      const px = ux(xv);
      const tl = maj ? 10 : 5;
      if (px < x0 || px > x1) continue;
      svgEl('line', { x1: px, x2: px, y1: y1, y2: y1 - tl, class: 'pl-tickline' }, g0);
      svgEl('line', { x1: px, x2: px, y1: y0, y2: y0 + tl, class: 'pl-tickline' }, g0);
      if (maj && Math.round(xv) % lblEvery === 0) svgEl('text', { x: px, y: y1 + 17, 'text-anchor': 'middle', class: 'pl-tk' }, g0).textContent = fmtTick(Math.round(xv));
    }
    for (let yv = Math.ceil(ylo / minor) * minor; yv <= yhi + 1e-9; yv += minor) {
      const maj = Math.abs(yv - Math.round(yv)) < 1e-6;
      const py = vy(yv);
      const tl = maj ? 10 : 5;
      if (py < y0 || py > y1) continue;
      svgEl('line', { x1: x0, x2: x0 + tl, y1: py, y2: py, class: 'pl-tickline' }, g0);
      svgEl('line', { x1: x1, x2: x1 - tl, y1: py, y2: py, class: 'pl-tickline' }, g0);
      if (maj && Math.round(yv) % lblEvery === 0) svgEl('text', { x: x0 - 9, y: py + 3.5, 'text-anchor': 'end', class: 'pl-tk' }, g0).textContent = fmtTick(Math.round(yv));
    }
    svgEl('text', { x: (x0 + x1) / 2, y: y1 + (L.narrow ? 36 : 44), 'text-anchor': 'middle', class: 'pl-axis' }, g0).textContent = 'UMAP-1';
    svgEl('text', { x: 0, y: 0, 'text-anchor': 'middle', class: 'pl-axis', transform: `translate(${x0 - (L.narrow ? 22 : 42)} ${(y0 + y1) / 2}) rotate(-90)` }, g0).textContent = 'UMAP-2';
    if (!L.narrow) {
      for (const [cx, cy, sx, sy] of [[x0, y0, -1, -1], [x1, y0, 1, -1], [x0, y1, -1, 1], [x1, y1, 1, 1]] as number[][]) {
        svgEl('path', { d: `M${cx! + sx! * 6} ${cy}h${sx! * 12}M${cx} ${cy! + sy! * 6}v${sy! * 12}`, class: 'pl-reg' }, g0);
      }
    }

    // avoid rects (title block, head strip, legend, caption), in stage coordinates
    const sr = stage.getBoundingClientRect();
    const avoid: Box[] = [];
    el.querySelectorAll<HTMLElement>('[data-avoid]').forEach((e) => {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return;
      avoid.push([r.left - sr.left - 10, r.top - sr.top - 10, r.right - sr.left + 10, r.bottom - sr.top + 10]);
    });
    const plot: Box = [x0 + 6, y0 + 6, x1 - 6, y1 - 6];

    // callouts
    const R = L.narrow ? 7 : 9;
    const items: Callout[] = top.map((h) => {
      const name = holeName(h);
      const oneLine = textW(name, NAME_FONT) <= 290;
      const parts = [h.cell[h.axes[0]] as string, h.cell[h.axes[1]] as string];
      const lines = L.narrow ? [] : oneLine ? [name] : [`${parts[0]} ×`, parts[1] as string];
      const w = L.narrow
        ? textW(h.code, CODE_FONT) + 4
        : Math.max(...lines.map((t) => textW(t, NAME_FONT)), textW(h.code, CODE_FONT) * 1.12) + 8;
      return { hole: h, c: [L.X(h.x), L.Y(h.y)] as Pt, r: R, w, h: L.narrow ? 16 : lines.length === 1 ? 44 : 66, lines, cands: [], pick: null };
    });
    placeCallouts(items, grid, avoid, plot, L.narrow);

    gActive = svgEl<SVGGElement>('g', {}, ov);
    const gv = svgEl<SVGGElement>('g', {}, ov);
    calloutG = new Map();
    markG = new Map();
    for (const cc of items) {
      const h = cc.hole;
      const [cx, cy] = cc.c;
      const gm = svgEl<SVGGElement>('g', { class: 'pl-voidmark' }, gv);
      svgEl('circle', { cx, cy, r: R, class: 'pl-ring' }, gm);
      svgEl('circle', { cx, cy, r: R + 4, class: 'pl-ring2' }, gm);
      svgEl('path', { d: `M${cx - 3} ${cy}h6M${cx} ${cy - 3}v6`, class: 'pl-plus' }, gm);
      markG.set(h.code, gm);
      const b = cc.pick;
      if (!b) continue;
      const g = svgEl<SVGGElement>('g', { class: 'pl-callout' }, gv);
      calloutG.set(h.code, g);
      const shelfEnd = b.A[0] + b.side * (cc.w + 6);
      svgEl('path', {
        d: `M${b.E[0].toFixed(1)} ${b.E[1].toFixed(1)}L${b.A[0].toFixed(1)} ${b.A[1].toFixed(1)}${L.narrow ? '' : `L${shelfEnd.toFixed(1)} ${b.A[1].toFixed(1)}`}`,
        class: 'pl-leader',
      }, g);
      const anchor = b.side > 0 ? 'start' : 'end';
      const tx = b.A[0] + b.side * 3;
      if (L.narrow) {
        svgEl('text', { x: tx, y: b.A[1] + 3.5, 'text-anchor': anchor, class: 'pl-vcode' }, g).textContent = h.code;
      } else {
        const nl = cc.lines.length;
        svgEl('text', { x: tx, y: b.A[1] - 7 - 20 * nl, 'text-anchor': anchor, class: 'pl-vcode' }, g).textContent = h.code;
        cc.lines.forEach((ln, li) => {
          const t = svgEl('text', { x: tx, y: b.A[1] - 7 - 20 * (nl - 1 - li), 'text-anchor': anchor, class: 'pl-vname' }, g);
          const i = ln.indexOf(' ×');
          const j = ln.indexOf(' × ');
          if (j >= 0) {
            t.appendChild(document.createTextNode(ln.slice(0, j) + ' '));
            svgEl('tspan', { class: 'x' }, t).textContent = '×';
            t.appendChild(document.createTextNode(' ' + ln.slice(j + 3)));
          } else if (i >= 0 && ln.endsWith('×')) {
            t.appendChild(document.createTextNode(ln.slice(0, ln.length - 1)));
            svgEl('tspan', { class: 'x' }, t).textContent = '×';
          } else t.textContent = ln;
        });
      }
      // label hit area follows the label box
      const lh = labHits.get(h.code);
      if (lh) {
        lh.style.left = `${b.box[0]}px`;
        lh.style.top = `${b.box[1]}px`;
        lh.style.width = `${b.box[2] - b.box[0]}px`;
        lh.style.height = `${b.box[3] - b.box[1]}px`;
        lh.style.display = '';
      }
    }
    for (const cc of items) {
      const btn = btns.get(cc.hole.code);
      if (btn) {
        btn.style.left = `${cc.c[0]}px`;
        btn.style.top = `${cc.c[1]}px`;
      }
      if (!cc.pick) {
        const lh = labHits.get(cc.hole.code);
        if (lh) lh.style.display = 'none';
      }
    }

    // a few well-separated video items get tiny mono labels
    const taken: Box[] = items.map((c) => c.pick?.box).filter((b): b is Box => !!b);
    if (!L.narrow) {
      const circles = items.map((c) => ({ c: c.c, r: c.r }));
      const cand = videoCandidates().map((i) => ({ x: (spx[i] as Pt)[0], y: (spx[i] as Pt)[1], text: shortTitle((points[i] as Point).t) }));
      const placed = placeSmall(cand, grid, avoid, plot, circles, taken, 75, 6);
      const gl = svgEl<SVGGElement>('g', {}, ov);
      for (const pl of placed) {
        svgEl('circle', { cx: pl.it.x, cy: pl.it.y, r: 6.5, class: 'pl-vlring' }, gl);
        svgEl('text', { x: pl.ax, y: pl.ay + 3.5, 'text-anchor': pl.dir[0] > 0 ? 'start' : pl.dir[0] < 0 ? 'end' : 'middle', class: 'pl-vl' }, gl).textContent = pl.it.text;
      }
    }
    gHover = svgEl<SVGGElement>('g', {}, ov);
    renderActive();
    syncMarks();
  }

  /** Video items, most spread-out first (farthest-point sampling in data space), so labels do not crowd. */
  function videoCandidates(): number[] {
    const vids: number[] = [];
    points.forEach((p, i) => { if (p.v) vids.push(i); });
    if (!vids.length) return [];
    const pt = (i: number) => points[i] as Point;
    const cxm = vids.reduce((a, i) => a + pt(i).x, 0) / vids.length;
    const cym = vids.reduce((a, i) => a + pt(i).y, 0) / vids.length;
    const chosen: number[] = [];
    const shortFirst = (i: number) => (pt(i).t.length <= 30 ? 0 : 1);
    chosen.push(vids.slice().sort((a, b) => Math.hypot(pt(a).x - cxm, pt(a).y - cym) - Math.hypot(pt(b).x - cxm, pt(b).y - cym))[0] as number);
    while (chosen.length < Math.min(12, vids.length)) {
      let bi = -1;
      let bd = -1;
      for (const i of vids) {
        if (chosen.includes(i)) continue;
        const d = Math.min(...chosen.map((j) => Math.hypot(pt(i).x - pt(j).x, pt(i).y - pt(j).y))) - shortFirst(i) * 0.6;
        if (d > bd) { bd = d; bi = i; }
      }
      if (bi < 0) break;
      chosen.push(bi);
    }
    return chosen;
  }
  const shortTitle = (t: string): string => (t.length <= 30 ? t : `${t.slice(0, 29).replace(/\s+\S*$/, '')}…`);

  /* ---------------- active hole: legend, filament overlay, classes */
  function centroid(ids: string[]): Pt | null {
    let sx = 0, sy = 0, n = 0;
    for (const id of ids) {
      const i = indexOfId.get(id);
      if (i === undefined) continue;
      sx += (spx[i] as Pt)[0];
      sy += (spx[i] as Pt)[1];
      n++;
    }
    return n ? [sx / n, sy / n] : null;
  }

  function renderActive(): void {
    if (!gActive) return;
    while (gActive.firstChild) gActive.removeChild(gActive.firstChild);
    const h = shown ? holeByCode.get(shown) : null;
    if (!h) return;
    const m: Pt = [L.X(h.x), L.Y(h.y)];
    const cr = centroid(h.row_ids);
    const cc = centroid(h.col_ids);
    if (cr && cc) {
      svgEl('path', { d: `M${cr[0]} ${cr[1]}L${cc[0]} ${cc[1]}`, class: 'pl-cline' }, gActive);
      svgEl('circle', { cx: cr[0], cy: cr[1], r: 5, class: 'pl-crow' }, gActive);
      svgEl('circle', { cx: cc[0], cy: cc[1], r: 5, class: 'pl-ccol' }, gActive);
    }
    if (!isTop.has(h.code)) {
      // a hole outside the labelled six (selected from the matrix or the catalog): a transient marker
      svgEl('circle', { cx: m[0], cy: m[1], r: L.narrow ? 7 : 9, class: 'pl-ring', style: 'stroke-width:2' }, gActive);
      svgEl('circle', { cx: m[0], cy: m[1], r: (L.narrow ? 7 : 9) + 4, class: 'pl-ring2' }, gActive);
      svgEl('path', { d: `M${m[0] - 3} ${m[1]}h6M${m[0]} ${m[1] - 3}v6`, class: 'pl-plus' }, gActive);
      svgEl('text', { x: m[0] + 15, y: m[1] + 3.5, class: 'pl-ccode' }, gActive).textContent = h.code;
    }
  }

  function legendHtml(h: Hole): string {
    const [a, b] = h.axes;
    return `<div class="pl-lg-top"><b>${esc(h.code)}</b><span>E ${esc(fmtE(h.E))} &middot; observed ${esc(fmtN(h.observed))}</span></div>
      <div class="pl-lg-row"><span class="pl-dot row"></span><span><i>${esc(a)}:</i> ${esc(h.cell[a])} <i>(${esc(fmtN(h.row_ids.length))})</i></span></div>
      <div class="pl-lg-row"><span class="pl-dot col"></span><span><i>${esc(b)}:</i> ${esc(h.cell[b])} <i>(${esc(fmtN(h.col_ids.length))})</i></span></div>`;
  }

  /** Reflect `shown` / `pinned` on the (re-creatable) overlay groups and the persistent buttons. */
  function syncMarks(): void {
    el.classList.toggle('pl-has-active', !!shown);
    for (const [c, g] of calloutG) g.classList.toggle('on', c === shown);
    for (const [c, g] of markG) g.classList.toggle('on', c === shown);
    for (const [c, b] of btns) b.setAttribute('aria-pressed', String(c === pinned));
    for (const [c, b] of listBtns) b.setAttribute('aria-pressed', String(c === pinned));
  }

  function apply(): void {
    const code = hover ?? pinned;
    const h = code ? holeByCode.get(code) : undefined;
    const next = h ? h.code : null;
    if (next === shown) {
      syncMarks();
      return;
    }
    shown = next;
    syncMarks();
    if (h) {
      const map = new Map<string, number>();
      for (const id of h.row_ids) map.set(id, (map.get(id) ?? 0) | 1);
      for (const id of h.col_ids) map.set(id, (map.get(id) ?? 0) | 2);
      hl = map;
      dimTarget = 1;
      legend.innerHTML = legendHtml(h);
      legend.classList.add('on');
    } else {
      dimTarget = 0;
      legend.classList.remove('on');
    }
    renderActive();
    kick();
  }

  function setHover(code: string | null): void {
    hover = code;
    apply();
  }
  function togglePin(code: string): void {
    if (pinned === code) {
      pinned = null;
    } else {
      pinned = code;
      window.dispatchEvent(new CustomEvent('overhang:select-hole', { detail: { code, source: 'plate' } }));
    }
    apply();
  }

  for (const [code, b] of btns) {
    b.addEventListener('pointerenter', () => setHover(code));
    b.addEventListener('pointerleave', () => setHover(null));
    b.addEventListener('focus', () => setHover(code));
    b.addEventListener('blur', () => setHover(null));
    b.addEventListener('click', () => togglePin(code));
  }
  for (const [code, lh] of labHits) {
    lh.addEventListener('pointerenter', () => setHover(code));
    lh.addEventListener('pointerleave', () => setHover(null));
    lh.addEventListener('click', () => togglePin(code));
  }
  for (const [code, b] of listBtns) b.addEventListener('click', () => togglePin(code));

  window.addEventListener('overhang:select-hole', (e) => {
    const code = (e as CustomEvent<{ code?: string | null }>).detail?.code ?? null;
    if (code && !holeByCode.has(code)) return;
    if (code === pinned) return;
    pinned = code;
    apply();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pinned) {
      pinned = null;
      apply();
    }
  });

  /* ---------------- point hover + click */
  const hoverRing = (i: number | null): void => {
    if (!gHover) return;
    while (gHover.firstChild) gHover.removeChild(gHover.firstChild);
    if (i === null || i < 0) return;
    const [x, y] = spx[i] as Pt;
    svgEl('circle', { cx: x, cy: y, r: 6.5, class: 'pl-hover' }, gHover);
  };
  function pick(e: PointerEvent | MouseEvent): number {
    if (!delaunay) return -1;
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const i = delaunay.find(mx, my);
    if (i < 0) return -1;
    const [x, y] = spx[i] as Pt;
    return Math.hypot(x - mx, y - my) <= (L.narrow || ('pointerType' in e && e.pointerType === 'touch') ? 18 : 12) ? i : -1;
  }
  const hostOf = (s: string): string => {
    try {
      return new URL(s).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  function showTip(i: number, e: PointerEvent | MouseEvent): void {
    const p = points[i] as Point;
    const txt = p.tx.length > 170 ? `${p.tx.slice(0, 169).replace(/\s+\S*$/, '')}…` : p.tx;
    const host = hostOf(p.s);
    tip.show(
      `<b>${esc(p.t)}</b><div>${esc(txt)}</div><div class="mono" style="margin-top:4px">${esc(p.d.replace(/-/g, ' '))}${host ? ` &middot; ${esc(host)}` : ''}${p.v ? ' &middot; from the video' : ''}</div>`,
      e.clientX,
      e.clientY,
    );
  }
  function clearPoint(): void {
    hoverIdx = -1;
    tip.hide();
    hoverRing(null);
    cv.style.cursor = '';
  }
  cv.addEventListener('pointermove', (e) => {
    const i = pick(e);
    if (i < 0) {
      if (hoverIdx >= 0) clearPoint();
      return;
    }
    if (i !== hoverIdx) {
      hoverIdx = i;
      hoverRing(i);
      cv.style.cursor = 'pointer';
      showTip(i, e);
    } else tip.move(e.clientX, e.clientY);
  });
  cv.addEventListener('pointerleave', clearPoint);
  cv.addEventListener('click', (e) => {
    const i = pick(e);
    if (i < 0) {
      tapIdx = -1;
      if (pinned) {
        pinned = null;
        apply();
      }
      return;
    }
    const touch = (e as PointerEvent).pointerType === 'touch' || (e as PointerEvent).pointerType === 'pen' || window.matchMedia('(hover: none)').matches;
    if (touch && tapIdx !== i) {
      // first tap shows the card, second tap opens the source
      tapIdx = i;
      hoverIdx = i;
      hoverRing(i);
      showTip(i, e);
      return;
    }
    const src = (points[i] as Point).s;
    if (/^https?:\/\//i.test(src)) window.open(src, '_blank', 'noopener,noreferrer');
  });

  /* ---------------- resize, theme, fonts */
  function relayout(): void {
    clearPoint();
    layout();
    drawOverlay();
    paintSky();
  }
  let pending = 0;
  const schedule = (): void => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      relayout();
    });
  };
  if (typeof ResizeObserver !== 'undefined') {
    let lastW = 0;
    let lastH = 0;
    new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = stage.clientHeight;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      schedule();
    }).observe(el);
  } else window.addEventListener('resize', schedule);
  window.addEventListener('overhang:theme', schedule);
  window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', schedule);
  void document.fonts?.load(NAME_FONT).then(schedule).catch(() => undefined);
  void document.fonts?.ready.then(schedule);

  relayout();
}
