// The #built section: Drift's results (Figures 5 to 8, memo excerpt, run-it-yourself, prior-art credits, globe note).
// Every number is read from app/public/data/winner.json (written by drift/export.py), app/public/data/drift-infinitime.json
// (a byte copy of results/drift/infinitime_hr.json, see scripts/sync-drift.mjs) or app/public/drift/memo.html (a byte copy of
// results/drift/memo-example.html). The only literals are prose, the figure titles, and commands/credits copied from
// drift/README.md and the memo (scripts/check-built-text.mjs asserts that they still appear there).
// Charts are SVG strings built here, drawn at the width of their container (ResizeObserver), so type never scales down.
import './styles/built.css';
import type { AppData, Hole } from './data';
import { cellLabel } from './data';
import { esc, fmtE, fmtN, fmtP, honesty, tooltip } from './ui';

export interface BuiltCtx {
  d: AppData;
  holes: Hole[];
  nReplicated: number;
  repoPublished: boolean;
  /** Table 2, the concept-stage prior-art search (lives in paper.ts, which keeps its numbering) */
  priorArt: () => string;
}

/* ================================================================== data shapes (what drift/export.py writes) */

interface Gen {
  gen_id: string; label: string; short: string; first_tag: string; last_tag: string; n_tags: number;
  first_date: string; last_date: string | null; description: string; commit: string | null; null_control: boolean;
}
interface Native { mean_pct: number; median_pct: number; min_pct: number; max_pct: number }
interface Shift {
  from: string; to: string; gait: string; shift_pct: number; ci_pct: [number, number]; sd_pct: number;
  n_beyond_threshold: number; n_subjects: number; max_abs_subject_change_pct: number; comparable_at_2pct: boolean;
  native_walks: Native; overall_verdict: string;
}
interface GaitRow { gen_id: string; label: string; median_pct: number; iqr_pct: [number, number]; values: number[] }
interface Demo {
  timeline: Gen[];
  memo_window: [string, string];
  memo_html: string;
  headline: { generations: number; distinct_algorithms_to_compare: number; null_controls_passed: boolean; median_error_pct_irregular: Record<string, number>; same_10021_step_walk: Record<string, number> };
  error_distributions: { unit: string; subjects: string[]; gait_names: Record<string, string>; by_gait: Record<string, GaitRow[]> };
  false_positives_per_hour: { unit: string; generations: string[]; series: Record<'drive' | 'train' | 'drive_train', number[]>; hours: Record<'drive' | 'train' | 'drive_train', number>; files: Record<'drive' | 'train', string[]> };
  boundary_shifts: Shift[];
  same_walk: { rec_id: string; steps_true: number; counted: Record<string, number>; note: string };
  native_walk_check: { n_files: number; wearers: string[]; definition: string };
  null_controls: { control: string; reference: string; recordings: number; identical_totals: boolean; identical_events: boolean; identical_peaks: boolean; passed: boolean }[];
  caveats: string[];
  provenance: { generated: string; firmware_tag_pin: { n_tags: number } };
}

interface HRDiff {
  n_windows_both_valid: number; mae_a_on_common: number; mae_b_on_common: number;
  abs_error_diff_subject_bootstrap: { estimate: number; ci95: [number, number]; n_units: number; n_boot: number };
  abs_error_diff_window_bootstrap: { estimate: number; ci95: [number, number]; n_units: number };
}
interface HRSummary { n_windows: number; n_valid: number; valid_fraction: number; mae_bpm: number }
interface HRData {
  caveat: string;
  generations: { role: string; label: string; first_tag: string; last_tag: string; native_rate_hz: number }[];
  ground_truth_eval: {
    dataset: string; n_recordings: number; n_subjects: number; n_windows: number; window_s: number;
    overall: Record<'A' | 'B' | 'A_null', HRSummary>;
    difference_B_minus_A: HRDiff;
    difference_B_minus_A_by_kind: Record<string, HRDiff>;
    null_control_A: { windows: number; identical_window_outputs: boolean };
  };
  scaling_sensitivity: { ac_sigma_counts: number; overall: Record<'A' | 'B', HRSummary> }[];
  provenance: { bootstrap: { resamples: number; seed: number } };
}

/* ================================================================== small helpers */

const MINUS = '−';
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (n: number): string => (Number.isInteger(n) && n >= 0 && n < WORDS.length ? (WORDS[n] as string) : fmtN(n));
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** Signed number with a real minus sign; a value that rounds to zero prints without a sign. */
function sgn(x: number, d = 1): string {
  const s = Math.abs(x).toFixed(d);
  if (Number(s) === 0) return s;
  return (x < 0 ? MINUS : '+') + s;
}
const plain = (x: number, d = 1): string => (x < 0 ? MINUS : '') + Math.abs(x).toFixed(d);
const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 86400000;
const n1 = (x: number): string => String(Math.round(x * 10) / 10);
/** "RELEASE_2V09" -> "2v09" */
const tagName = (t: string): string => t.replace(/^RELEASE_/i, '').toLowerCase();
const baseUrl = (): string => import.meta.env.BASE_URL;
/** Dates never break across lines (a line break would otherwise fall at a hyphen of the ISO date). */
const nb = (iso: string): string => `<span class="nowrap">${esc(iso)}</span>`;
const nbDates = (html: string): string => html.replace(/\d{4}-\d{2}-\d{2}/g, (d) => nb(d));
/** Typographic cleanup for text that comes straight from a results file: a real arrow, and en dashes in version and number ranges. */
const typo = (t: string): string => t.replace(/\s->\s/g, ' → ').replace(/(\d)-(?=\d)/g, '$1–');

/** Text width in px, measured on a canvas with the figure fonts (a little generous, so labels never collide). */
const SANS = '"IBM Plex Sans Condensed", "Arial Narrow", system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, Consolas, monospace';
let c2d: CanvasRenderingContext2D | null | undefined;
function tw(s: string, px: number, o: { w?: number; mono?: boolean; ls?: number } = {}): number {
  if (c2d === undefined) {
    try { c2d = document.createElement('canvas').getContext('2d'); } catch { c2d = null; }
  }
  const ls = o.ls ?? 0;
  if (!c2d) return s.length * (px * (o.mono ? 0.62 : 0.52) + ls);
  c2d.font = `${o.w ?? 400} ${px}px ${o.mono ? MONO : SANS}`;
  return c2d.measureText(s).width * 1.04 + s.length * ls;
}

/** Break text into lines no wider than maxW. */
function wrap(text: string, maxW: number, px: number, o: { w?: number; mono?: boolean } = {}): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    const t = cur ? `${cur} ${word}` : word;
    if (cur && tw(t, px, o) > maxW) { out.push(cur); cur = word; } else cur = t;
  }
  if (cur) out.push(cur);
  return out;
}

/* ---- label lanes: put labels on rows so that no label crosses another label or another label's stem ---- */

interface LaneItem { x: number; w: number; dir: 1 | -1; row?: number }
const span = (it: LaneItem): [number, number] => (it.dir === 1 ? [it.x, it.x + it.w] : [it.x - it.w, it.x]);
/**
 * Each item has a stem at x that runs from row 1 out to its own row, and a label that extends right (dir 1) or left (dir -1) of the stem.
 * Items are placed from the right; the first row where the label meets no other label and no other stem is taken. Returns the row count.
 */
function assignRows(items: LaneItem[], pad = 6): number {
  const order = items.map((_, i) => i).sort((a, b) => (items[b] as LaneItem).x - (items[a] as LaneItem).x);
  const placed: LaneItem[] = [];
  let rows = 0;
  for (const i of order) {
    const it = items[i] as LaneItem;
    const [a, b] = span(it);
    let r = 1;
    for (; r < 14; r++) {
      let ok = true;
      for (const j of placed) {
        const [ja, jb] = span(j);
        const jr = j.row as number;
        if (a < jb + pad && ja < b + pad && jr === r) ok = false; // same row, overlapping labels
        if (j.x >= a - pad && j.x <= b + pad && r <= jr) ok = false; // j's stem would run through my label
        if (it.x >= ja - pad && it.x <= jb + pad && jr < r) ok = false; // my stem would run through j's label
        if (!ok) break;
      }
      if (ok) break;
    }
    it.row = r;
    placed.push(it);
    rows = Math.max(rows, r);
  }
  return rows;
}

/* ================================================================== model */

type VKind = 'nc' | 'ncf' | 'ok';
interface Bd { from: Gen; to: Gen; date: string; verdict: string; label: string; kind: VKind; shift: Shift; inWin: boolean }
interface Model {
  demo: Demo;
  gens: Gen[];
  /** per generation: index among the live (non-null-control) generations, and the live generation it is identical to */
  liveIdx: number[];
  refOf: Gen[];
  nLive: number;
  bounds: Bd[];
  winLo: string;
  winHi: string;
  /** the Regular-gait shift row for each boundary, in order */
  shifts: Shift[];
}

function verdictKind(v: string): VKind {
  const k = v.trim().toLowerCase();
  if (k.startsWith('not confirmed')) return 'ncf';
  if (k.startsWith('not comparable')) return 'nc';
  return 'ok';
}

function buildModel(d: AppData): Model | null {
  const w = d.winner as { status: string; demo?: unknown };
  const demo = w.demo as Demo | undefined;
  if (!demo || !Array.isArray(demo.timeline) || !demo.timeline.length || !demo.error_distributions || !demo.boundary_shifts || !demo.false_positives_per_hour) return null;
  const gens = demo.timeline;
  const byId = new Map(gens.map((g) => [g.gen_id, g]));
  let live = -1;
  const liveIdx: number[] = [];
  const refOf: Gen[] = [];
  let lastLive: Gen = gens[0] as Gen;
  for (const g of gens) {
    if (!g.null_control) { live += 1; lastLive = g; }
    liveIdx.push(Math.max(live, 0));
    refOf.push(lastLive);
  }
  const [winLo, winHi] = demo.memo_window;
  const shifts = demo.boundary_shifts.filter((s) => s.gait === 'regular');
  const bounds: Bd[] = [];
  for (const s of shifts) {
    const from = byId.get(s.from);
    const to = byId.get(s.to);
    if (!from || !to) continue;
    const verdict = s.overall_verdict;
    const date = to.first_date;
    bounds.push({ from, to, date, verdict, label: verdict.replace(/\s*\(.*\)\s*$/, ''), kind: verdictKind(verdict), shift: s, inWin: date >= winLo && date <= winHi });
  }
  return { demo, gens, liveIdx, refOf, nLive: live + 1, bounds, winLo, winHi, shifts };
}

/** Fill for a generation band: a step along the ramp per live generation; a null control takes the fill of the generation it repeats. */
function genFill(m: Model, i: number): string {
  const idx = m.liveIdx[i] as number;
  const t = m.nLive > 1 ? 44 + (54 * idx) / (m.nLive - 1) : 70;
  return `color-mix(in srgb, var(--ramp-1) ${n1(t)}%, var(--ramp-0))`;
}

const pillW = (text: string): number => tw(text.toUpperCase(), 11, { w: 600, ls: 0.66 }) + 14;

function pillSvg(x: number, y: number, text: string, kind: VKind, dir: 1 | -1 = 1): string {
  const w = pillW(text);
  const rx = dir === 1 ? x : x - w;
  return `<g class="bt-pg ${kind}"><rect x="${n1(rx)}" y="${n1(y)}" width="${n1(w)}" height="18" rx="3"/><text x="${n1(rx + w / 2)}" y="${n1(y + 12.6)}" text-anchor="middle">${esc(text.toUpperCase())}</text></g>`;
}

/* ================================================================== Figure 5: the timeline */

const WIDE = 620;

function renderTimeline(W: number, m: Model): string {
  const { gens, bounds } = m;
  const padL = 22;
  const yr0 = new Date(gens[0]?.first_date ?? '2021-01-01').getUTCFullYear();
  const yr1 = new Date(m.demo.provenance.generated).getUTCFullYear() + 1;
  const t0 = day(`${yr0}-01-01`);
  const t1 = day(`${yr1}-01-01`);
  const gEnd = (g: Gen): string => g.last_date ?? m.demo.provenance.generated;

  // label widths, then the right margin: the timeline stops early enough that the newest generations' labels start at their
  // stem and run to the right (they never flip to the left of their stem, where they would sit under the previous band)
  const pillWs = bounds.map((b) => pillW(b.label));
  const lines = gens.map((g, i) => {
    const l1 = g.short;
    const dates = `${g.first_date} → ${g.last_date ?? 'now'}`;
    const l3 = g.null_control ? `identical output to ${(m.refOf[i] as Gen).short}` : '';
    const w = Math.max(tw(l1, 12, { mono: true, w: 500 }) + 8 + tw(dates, 11), tw(g.description, 11), l3 ? tw(l3, 11, { w: 600 }) : 0) + 12;
    return { l1, dates, l2: g.description, l3, w };
  });
  const frac = (iso: string): number => (day(iso) - t0) / (t1 - t0);
  const needR = (padR: number): boolean => {
    const pw = W - padL - padR;
    return (
      bounds.some((b, i) => padL + frac(b.date) * pw + (pillWs[i] as number) > W - 6) ||
      gens.some((g, i) => padL + frac(g.first_date) * pw + (lines[i] as { w: number }).w > W - 6)
    );
  };
  let padR = 18;
  while (needR(padR) && padR < Math.min(260, W * 0.24)) padR += 6;
  const plotW = W - padL - padR;
  const X = (iso: string): number => padL + frac(iso) * plotW;

  // boundary flags (verdict pills on stems that rise from the band)
  const pItems: LaneItem[] = bounds.map((b, i) => {
    const w = pillWs[i] as number;
    const x = X(b.date);
    return { x, w, dir: x + w > W - 6 ? -1 : 1 };
  });
  const pRows = assignRows(pItems, 5);
  const capH = 22;
  const pillArea = pRows * 24 + 4;
  const bandTop = capH + pillArea + 8;
  const bandH = 26;
  const bandBot = bandTop + bandH;
  const axisBot = bandBot + 24;
  const labelTop = axisBot + 10;

  // generation labels (stems that drop from the band)
  const lItems: LaneItem[] = gens.map((g, i) => {
    const x = X(g.first_date);
    const w = (lines[i] as { w: number }).w;
    return { x, w, dir: x + w > W - 6 ? -1 : 1 };
  });
  const lRows = assignRows(lItems, 8);
  const rowH = 46;
  const H = labelTop + lRows * rowH + 6;

  const defs = `<defs><pattern id="bt-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(135)"><line x1="0" y1="0" x2="0" y2="6" class="bt-hl"/></pattern></defs>`;
  const winX0 = X(m.winLo);
  const winX1 = X(m.winHi);
  let s = `<svg class="bt-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`Timeline of ${gens.length} Bangle.js firmware generations from ${gens[0]?.first_date} on, with the example study window ${m.winLo} to ${m.winHi} and the verdict at each boundary: ${bounds.map((b) => `${b.from.short} to ${b.to.short} ${b.label}`).join('; ')}.`)}">${defs}`;

  // the example study window, behind everything
  s += `<rect class="bt-win" x="${n1(winX0)}" y="${capH - 2}" width="${n1(winX1 - winX0)}" height="${n1(bandBot - capH + 2)}"/>`;
  s += `<line class="bt-winl" x1="${n1(winX0)}" y1="${capH - 2}" x2="${n1(winX0)}" y2="${n1(bandBot)}"/><line class="bt-winl" x1="${n1(winX1)}" y1="${capH - 2}" x2="${n1(winX1)}" y2="${n1(bandBot)}"/>`;
  s += `<text class="bt-wint" x="${n1(winX0)}" y="12">Example study window · ${esc(m.winLo)} → ${esc(m.winHi)}</text>`;

  // bands
  gens.forEach((g, i) => {
    const x0 = X(g.first_date);
    const x1 = X(gEnd(g));
    const tip = `<b>${esc(g.short)}</b> · ${esc(g.description)}<br><span class="mono">${esc(g.first_tag)}${g.n_tags > 1 ? ` to ${esc(g.last_tag)}` : ''} · ${g.n_tags} tag${g.n_tags === 1 ? '' : 's'}<br>${esc(g.first_date)} → ${esc(g.last_date ?? 'the latest tag')}${g.commit ? `<br>algorithm source ${esc(g.commit)}` : ''}</span>${g.null_control ? '<br>Null control: identical output on every recording.' : ''}`;
    s += `<g data-bt-tip="${esc(tip)}"><rect class="bt-band" x="${n1(x0 + 0.5)}" y="${bandTop}" width="${n1(Math.max(1, x1 - x0 - 1))}" height="${bandH}" style="fill:${genFill(m, i)}"/>`;
    if (g.null_control) {
      s += `<rect x="${n1(x0 + 0.5)}" y="${bandTop}" width="${n1(Math.max(1, x1 - x0 - 1))}" height="${bandH}" fill="url(#bt-hatch)" class="bt-bandh"/>`;
      const label = 'identical output';
      const lw = tw(label, 11, { w: 600 }) + 12;
      if (x1 - x0 > lw + 10) s += `<rect class="bt-chip" x="${n1((x0 + x1) / 2 - lw / 2)}" y="${bandTop + 5}" width="${n1(lw)}" height="16" rx="2"/><text class="bt-idt" x="${n1((x0 + x1) / 2)}" y="${bandTop + 17}" text-anchor="middle">${label}</text>`;
    }
    s += '</g>';
  });

  // ruler: ticks on 1 January, year labels centred in the year
  s += `<line class="bt-ax" x1="${padL}" y1="${bandBot + 0.5}" x2="${n1(padL + plotW)}" y2="${bandBot + 0.5}"/>`;
  const stemLines: string[] = [];
  lItems.forEach((it, i) => {
    const yRow = labelTop + ((it.row as number) - 1) * rowH;
    stemLines.push(`<line class="bt-stem" x1="${n1(it.x)}" y1="${bandBot}" x2="${n1(it.x)}" y2="${n1(yRow + 2)}"/>`);
    void i;
  });
  s += stemLines.join('');
  for (let y = yr0; y <= yr1; y++) {
    const x = X(`${y}-01-01`);
    s += `<line class="bt-ax" x1="${n1(x)}" y1="${bandBot}" x2="${n1(x)}" y2="${bandBot + 6}"/>`;
    if (y < yr1) s += `<text class="bt-yr" x="${n1(X(`${y}-07-01`))}" y="${bandBot + 18}" text-anchor="middle">${y}</text>`;
  }

  // boundary flags
  bounds.forEach((b, i) => {
    const it = pItems[i] as LaneItem;
    const yTop = bandTop - 4 - (it.row as number) * 24 + 3;
    s += `<g data-bt-tip="${esc(boundaryTip(b))}"><line class="bt-flag" x1="${n1(it.x)}" y1="${n1(yTop)}" x2="${n1(it.x)}" y2="${bandTop}"/>${pillSvg(it.x, yTop, b.label, b.kind, it.dir)}</g>`;
  });

  // generation labels
  gens.forEach((g, i) => {
    const it = lItems[i] as LaneItem;
    const ln = lines[i] as { l1: string; dates: string; l2: string; l3: string };
    const yRow = labelTop + ((it.row as number) - 1) * rowH;
    const left = it.dir === 1;
    const x = it.x + (left ? 6 : -6);
    const anchor = left ? 'start' : 'end';
    s += `<g class="bt-gl"><text x="${n1(x)}" y="${n1(yRow + 11)}" text-anchor="${anchor}"><tspan class="bt-gs">${esc(ln.l1)}</tspan><tspan class="bt-gd" dx="8">${esc(ln.dates)}</tspan></text>`;
    s += `<text class="bt-gd2" x="${n1(x)}" y="${n1(yRow + 24)}" text-anchor="${anchor}">${esc(ln.l2)}</text>`;
    if (ln.l3) s += `<text class="bt-gi" x="${n1(x)}" y="${n1(yRow + 37)}" text-anchor="${anchor}">${esc(ln.l3)}</text>`;
    s += '</g>';
  });
  return `${s}</svg>`;
}

function boundaryTip(b: Bd): string {
  const sh = b.shift;
  return `<b>${esc(b.from.short)} → ${esc(b.to.short)}</b> · ${esc(b.date)}<br>${esc(b.verdict)}<br><span class="mono">Clemson, Regular: ${sgn(sh.shift_pct, 2)} [${sgn(sh.ci_pct[0], 2)}, ${sgn(sh.ci_pct[1], 2)}] points<br>native walks: ${sgn(sh.native_walks.mean_pct)} (${sgn(sh.native_walks.min_pct)} to ${sgn(sh.native_walks.max_pct)})</span>`;
}

/** The narrow layout of Figure 5: a to-scale strip, then the generations and boundaries as a list with the study window grouped. */
function timelineStack(m: Model): string {
  const { gens, bounds } = m;
  const yr0 = new Date(gens[0]?.first_date ?? '2021-01-01').getUTCFullYear();
  const yr1 = new Date(m.demo.provenance.generated).getUTCFullYear() + 1;
  const t0 = day(`${yr0}-01-01`);
  const t1 = day(`${yr1}-01-01`);
  const pc = (iso: string): number => ((day(iso) - t0) / (t1 - t0)) * 100;
  const gEnd = (g: Gen): string => g.last_date ?? m.demo.provenance.generated;
  const strip = gens
    .map((g, i) => `<i class="bt-seg${g.null_control ? ' nullc' : ''}" style="left:${n1(pc(g.first_date))}%;width:${n1(pc(gEnd(g)) - pc(g.first_date))}%;background-color:${genFill(m, i)}" title="${esc(g.short)}"></i>`)
    .join('');
  const years = Array.from({ length: yr1 - yr0 }, (_, k) => `<span style="left:${n1(pc(`${yr0 + k}-07-01`))}%">${yr0 + k}</span>`).join('');
  const inWinGen = (g: Gen): boolean => g.first_date <= m.winHi && gEnd(g) >= m.winLo;
  const genLi = (g: Gen, i: number): string =>
    `<li class="bt-sg${g.null_control ? ' nullc' : ''}"><i class="bt-sw" style="background-color:${genFill(m, i)}"></i><div><b class="mono">${esc(g.short)}</b> <span>${esc(g.description)}</span><small>${esc(g.first_date)} → ${esc(g.last_date ?? 'now')}</small>${g.null_control ? `<em>identical output to ${esc((m.refOf[i] as Gen).short)}</em>` : ''}</div></li>`;
  const bdLi = (b: Bd): string => `<li class="bt-sb"><span class="mono">${esc(b.from.short)} → ${esc(b.to.short)}</span><span class="pill bt-${b.kind}">${esc(b.label)}</span></li>`;
  let out = '';
  let inWin = false;
  const closeWin = (): void => { if (inWin) { out += '</ol></li>'; inWin = false; } };
  gens.forEach((g, i) => {
    const bd = i > 0 ? bounds.find((b) => b.to.gen_id === g.gen_id) : undefined;
    const gw = inWinGen(g);
    if (gw && !inWin) { out += `<li class="bt-swin"><p class="bt-wint">Example study window · ${esc(m.winLo)} → ${esc(m.winHi)}</p><ol>`; inWin = true; }
    if (!gw) closeWin();
    if (bd) out += bdLi(bd);
    out += genLi(g, i);
  });
  closeWin();
  return `<div class="bt-strip" aria-hidden="true"><div class="bt-sbar">${strip}<i class="bt-wbox" style="left:${n1(pc(m.winLo))}%;width:${n1(pc(m.winHi) - pc(m.winLo))}%"></i></div><div class="bt-yrs">${years}</div></div><ol class="bt-stackl">${out}</ol>`;
}

/* ================================================================== Figure 6a: count error by gait, symlog axis */

const SYMC = 2;
const symlog = (v: number): number => Math.sign(v) * Math.log10(1 + Math.abs(v) / SYMC);
const GAITS = ['regular', 'semiregular', 'irregular'] as const;

function laneMark(gait: string, x: number, y: number, hollow: boolean): string {
  const c = hollow ? ' hollow' : '';
  if (gait === 'regular') return `<circle class="bt-mk g1${c}" cx="${n1(x)}" cy="${n1(y)}" r="4.6"/>`;
  if (gait === 'semiregular') return `<path class="bt-mk g2${c}" d="M${n1(x)} ${n1(y - 5.6)}L${n1(x + 5.6)} ${n1(y)}L${n1(x)} ${n1(y + 5.6)}L${n1(x - 5.6)} ${n1(y)}Z"/>`;
  return `<rect class="bt-mk g3${c}" x="${n1(x - 4.4)}" y="${n1(y - 4.4)}" width="8.8" height="8.8"/>`;
}

/** Lay legend items out left to right, wrapping to a new row when the next one would pass the right edge. */
function flowLegend(widths: number[], x0: number, W: number, y0 = 12, rowGap = 18): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let x = x0;
  let row = 0;
  for (const w of widths) {
    if (x > x0 && x + w - 18 > W - 4) { x = x0; row += 1; }
    out.push({ x, y: y0 + row * rowGap });
    x += w;
  }
  return out;
}

/** Width of the row-label column: wide enough for the longest generation name; with room for the description when there is room. */
function labelCol(m: Model, compact: boolean): number {
  const names = Math.max(...m.gens.map((g) => tw(g.short, 12, { mono: true, w: 500 })));
  return compact ? Math.ceil(names) + 26 : 158;
}

function renderCount(W: number, m: Model): string {
  const ed = m.demo.error_distributions;
  const compact = W < 520;
  const labelW = labelCol(m, compact);
  const padR = 56;
  const plotL = labelW;
  const plotR = W - padR;
  const plotW = plotR - plotL;
  // axis domain from the data: the smallest tick at or below the lowest IQR end, the smallest tick at or above the highest
  let lo = Infinity;
  let hi = -Infinity;
  for (const gait of GAITS) for (const r of ed.by_gait[gait] ?? []) { lo = Math.min(lo, r.iqr_pct[0]); hi = Math.max(hi, r.iqr_pct[1]); }
  const dLo = [-1000, -500, -200, -100, -50, -20, -10, -5, 0].find((t) => t <= lo) ?? lo;
  const dHi = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((t) => t >= hi) ?? hi;
  const a = symlog(dLo);
  const b = symlog(dHi);
  const X = (v: number): number => plotL + ((symlog(v) - a) / (b - a)) * plotW;
  const gaitName = (g: string): string => ed.gait_names[g] ?? cap(g);
  const legPos = flowLegend(GAITS.map((g) => 16 + tw(gaitName(g), 11) + 18), plotL, W, 12, 18);
  const lgRow = ((legPos[legPos.length - 1] as { y: number }).y - 12) / 18;
  const legendH = 26 + lgRow * 18;
  const rowH = 58;
  const top = legendH + 4;
  const n = m.gens.length;
  const axisY = top + n * rowH + 4;
  const axtLines = wrap(`count error, % of the true step count (median and IQR over ${ed.subjects.length} subjects; linear within ±${SYMC}, shaded)`, W - plotL - 4, 11);
  const H = axisY + 36 + axtLines.length * 13 + 2;
  // ticks by priority (0, then ±100, ±10, ±1000 ...), each kept only when its label clears the labels already kept
  const tickLab = (t: number): string => `${t > 0 ? '+' : t < 0 ? MINUS : ''}${fmtN(Math.abs(t))}`;
  const kept: number[] = [];
  for (const t of [0, 100, -100, 10, -10, 1000, -1000, 10000].filter((t) => t >= dLo && t <= dHi)) {
    if (kept.every((u) => Math.abs(X(t) - X(u)) >= (tw(tickLab(t), 10.5, { mono: true }) + tw(tickLab(u), 10.5, { mono: true })) / 2 + 4)) kept.push(t);
  }
  const ticks = kept.sort((p, q) => p - q);

  let s = `<svg class="bt-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`Clemson count error in percent by gait for each of ${n} firmware generations: median and interquartile range, on a symlog axis. Irregular gait reaches ${sgn(hi, 0)} percent at the upper quartile of the oldest generation.`)}">`;
  // legend (drawn by hand: markers need absolute positions)
  GAITS.forEach((g, k) => {
    const p = legPos[k] as { x: number; y: number };
    s += laneMark(g, p.x + 6, p.y, false);
    s += `<text class="bt-lg" x="${n1(p.x + 16)}" y="${p.y + 4}">${esc(gaitName(g))}</text>`;
  });
  // grid and zero line
  for (const t of ticks) s += `<line class="${t === 0 ? 'bt-zero' : 'bt-gridl'}" x1="${n1(X(t))}" y1="${top - 2}" x2="${n1(X(t))}" y2="${axisY}"/>`;
  // linear zone, shaded: |v| <= the symlog constant
  s += `<rect class="bt-lin" x="${n1(X(-SYMC))}" y="${top - 2}" width="${n1(X(SYMC) - X(-SYMC))}" height="${n1(axisY - top + 2)}"/>`;

  m.gens.forEach((g, i) => {
    const y0 = top + i * rowH;
    const nullc = g.null_control;
    if (i % 2 === 1) s += `<rect class="bt-zebra" x="0" y="${y0}" width="${W}" height="${rowH}"/>`;
    s += `<rect class="bt-sw" x="0" y="${y0 + 7}" width="10" height="10" style="fill:${genFill(m, i)}"/>`;
    s += `<text class="bt-rl" x="16" y="${y0 + 16}">${esc(g.short)}</text>`;
    if (!compact) s += `<text class="bt-rd" x="16" y="${y0 + 30}">${esc(nullc ? 'identical output' : g.description)}</text>`;
    GAITS.forEach((gait, k) => {
      const row = (ed.by_gait[gait] ?? []).find((r) => r.gen_id === g.gen_id);
      if (!row) return;
      const cy = y0 + 13 + k * 15;
      const x0 = X(row.iqr_pct[0]);
      const x1 = X(row.iqr_pct[1]);
      const tip = `<b>${esc(g.short)}</b> · ${esc(gaitName(gait))} gait<br>median ${sgn(row.median_pct)}%<br><span class="mono">IQR ${sgn(row.iqr_pct[0])} to ${sgn(row.iqr_pct[1])}%<br>${row.values.length} subjects</span>${nullc ? '<br>Null control: same as ' + esc((m.refOf[i] as Gen).short) + '.' : ''}`;
      s += `<g data-bt-tip="${esc(tip)}" class="bt-lane${nullc ? ' nullc' : ''}"><rect class="bt-hit" x="${plotL - 4}" y="${cy - 7}" width="${n1(plotW + padR)}" height="14"/>`;
      s += `<line class="bt-wh" x1="${n1(x0)}" y1="${n1(cy)}" x2="${n1(x1)}" y2="${n1(cy)}"/><line class="bt-wh" x1="${n1(x0)}" y1="${n1(cy - 3.5)}" x2="${n1(x0)}" y2="${n1(cy + 3.5)}"/><line class="bt-wh" x1="${n1(x1)}" y1="${n1(cy - 3.5)}" x2="${n1(x1)}" y2="${n1(cy + 3.5)}"/>`;
      s += laneMark(gait, X(row.median_pct), cy, nullc);
      // a whisker narrower than its marker is hidden behind it: draw the interquartile range as a small bracket under the marker
      if (x1 - x0 < 13) s += `<path class="bt-wh" d="M${n1(x0)} ${n1(cy + 6)}V${n1(cy + 9)}H${n1(x1)}V${n1(cy + 6)}"/>`;
      if (!nullc) s += `<text class="bt-val" x="${n1(x1 + 9)}" y="${n1(cy + 3.6)}">${sgn(row.median_pct)}</text>`;
      s += '</g>';
    });
  });

  // axis
  s += `<line class="bt-ax" x1="${n1(plotL)}" y1="${axisY}" x2="${n1(plotR)}" y2="${axisY}"/>`;
  for (const t of ticks) {
    s += `<line class="bt-ax" x1="${n1(X(t))}" y1="${axisY}" x2="${n1(X(t))}" y2="${axisY + 5}"/><text class="bt-tk" x="${n1(X(t))}" y="${axisY + 18}" text-anchor="middle">${tickLab(t)}</text>`;
  }
  // the edges of the linear zone get a short unlabelled tick
  for (const t of [-SYMC, SYMC]) s += `<line class="bt-ax" x1="${n1(X(t))}" y1="${axisY}" x2="${n1(X(t))}" y2="${axisY + 3}"/>`;
  axtLines.forEach((ln, k) => { s += `<text class="bt-axt" x="${n1(plotL)}" y="${axisY + 36 + k * 13}">${esc(ln)}</text>`; });
  return `${s}</svg>`;
}

/* ================================================================== Figure 6b: native walks against Clemson, per boundary */

const sayShift = (x: number): string => (Math.abs(x) < 0.5 ? '~0' : sgn(x));

function renderShifts(W: number, m: Model): string {
  const padL = 12;
  const padR = 16;
  const plotL = padL;
  const plotR = W - padR;
  const plotW = plotR - plotL;
  // domain from the data
  let lo = Infinity;
  let hi = -Infinity;
  for (const sh of m.shifts) {
    lo = Math.min(lo, sh.ci_pct[0], sh.native_walks.min_pct);
    hi = Math.max(hi, sh.ci_pct[1], sh.native_walks.max_pct);
  }
  const dLo = Math.floor(lo / 10) * 10;
  const dHi = Math.ceil(hi / 10) * 10;
  const X = (v: number): number => plotL + ((v - dLo) / (dHi - dLo)) * plotW;
  const ticks: number[] = [];
  for (let t = Math.ceil(dLo / 20) * 20; t <= dHi; t += 20) ticks.push(t);

  const blocks: string[] = [];
  // one wording for every null-control row: the long form only when it fits beside the longest boundary name
  const nullFits = m.bounds.filter((b) => b.to.null_control).every((b) => tw(`${b.from.short} → ${b.to.short}`, 12, { mono: true, w: 500 }) + tw('null control · identical output', 10.5) + 16 < plotW);
  const tag = nullFits ? 'null control · identical output' : 'null · identical';
  let y = 30;
  let s = '';
  // legend
  const legend = `${laneMark('regular', plotL + 6, 12, false)}<text class="bt-lg" x="${plotL + 16}" y="16">Clemson, Regular (mean, 95% CI)</text>`;
  const lx = plotL + 16 + tw('Clemson, Regular (mean, 95% CI)', 11) + 16;
  const legend2 = `<path class="bt-mk nat" d="M${n1(lx + 6)} 6.4L${n1(lx + 11.6)} 12L${n1(lx + 6)} 17.6L${n1(lx + 0.4)} 12Z"/><text class="bt-lg" x="${n1(lx + 18)}" y="16">native Bangle.js walks (mean, min to max)</text>`;
  const legendWide = lx + 18 + tw('native Bangle.js walks (mean, min to max)', 11) <= W - 4;
  if (legendWide) s += legend + legend2;
  else {
    s += legend;
    s += `<path class="bt-mk nat" d="M${plotL + 6} 24.4L${plotL + 11.6} 30L${plotL + 6} 35.6L${plotL + 0.4} 30Z"/><text class="bt-lg" x="${plotL + 18}" y="34">native Bangle.js walks (mean, min to max)</text>`;
    y = 48;
  }
  const bodyTop = y;
  /** vertical extents where the grid is drawn: beside the marks only, never through the annotation text */
  const segs: [number, number][] = [];

  m.bounds.forEach((bd) => {
    const sh = bd.shift;
    const nullc = bd.to.null_control;
    const cl = sh.ci_pct;
    const nat = sh.native_walks;
    const head = `<text class="bt-bh" x="${plotL}" y="${y + 11}">${esc(bd.from.short)} → ${esc(bd.to.short)}</text>`;
    const tip = boundaryTip(bd);
    if (nullc) {
      // a null control: both shifts are exactly zero by construction (identical output), so both marks sit at 0, one lane each
      const nx = X(nat.mean_pct);
      blocks.push(`<g data-bt-tip="${esc(tip)}">${head}<text class="bt-bn" x="${plotR}" y="${y + 11}" text-anchor="end">${esc(tag)}</text><rect class="bt-hit" x="${plotL}" y="${y}" width="${n1(plotW)}" height="48"/>${laneMark('regular', X(sh.shift_pct), y + 24, true)}<path class="bt-mk nat hollow" d="M${n1(nx)} ${n1(y + 37.4)}L${n1(nx + 5.6)} ${n1(y + 43)}L${n1(nx)} ${n1(y + 48.6)}L${n1(nx - 5.6)} ${n1(y + 43)}Z"/></g>`);
      segs.push([y + 16, y + 54]);
      y += 58;
      return;
    }
    const y1 = y + 25;
    const y2 = y + 44;
    const disagree = nat.mean_pct < cl[0] || nat.mean_pct > cl[1];
    const say = `Clemson says ${sayShift(sh.shift_pct)}; native walks say ${sgn(nat.mean_pct)} points`;
    const lines = wrap(`${say}.`, plotW - 4, 12, { w: 500 });
    let blk = `<g data-bt-tip="${esc(tip)}">${head}`;
    if (disagree) blk += `<text class="bt-flagt" x="${plotR}" y="${y + 11}" text-anchor="end">DISAGREE</text>`;
    blk += `<rect class="bt-hit" x="${plotL}" y="${y}" width="${n1(plotW)}" height="${60 + lines.length * 14}"/>`;
    blk += `<line class="bt-wh" x1="${n1(X(cl[0]))}" y1="${y1}" x2="${n1(X(cl[1]))}" y2="${y1}"/><line class="bt-wh" x1="${n1(X(cl[0]))}" y1="${y1 - 3.5}" x2="${n1(X(cl[0]))}" y2="${y1 + 3.5}"/><line class="bt-wh" x1="${n1(X(cl[1]))}" y1="${y1 - 3.5}" x2="${n1(X(cl[1]))}" y2="${y1 + 3.5}"/>`;
    blk += laneMark('regular', X(sh.shift_pct), y1, false);
    blk += `<line class="bt-wh nat" x1="${n1(X(nat.min_pct))}" y1="${y2}" x2="${n1(X(nat.max_pct))}" y2="${y2}"/><line class="bt-wh nat" x1="${n1(X(nat.min_pct))}" y1="${y2 - 3.5}" x2="${n1(X(nat.min_pct))}" y2="${y2 + 3.5}"/><line class="bt-wh nat" x1="${n1(X(nat.max_pct))}" y1="${y2 - 3.5}" x2="${n1(X(nat.max_pct))}" y2="${y2 + 3.5}"/>`;
    blk += `<path class="bt-mk nat" d="M${n1(X(nat.mean_pct))} ${n1(y2 - 5.6)}L${n1(X(nat.mean_pct) + 5.6)} ${y2}L${n1(X(nat.mean_pct))} ${n1(y2 + 5.6)}L${n1(X(nat.mean_pct) - 5.6)} ${y2}Z"/>`;
    lines.forEach((ln, k) => { blk += `<text class="${disagree ? 'bt-say' : 'bt-say ok'}" x="${plotL}" y="${y2 + 24 + k * 14}">${esc(ln)}</text>`; });
    blk += '</g>';
    blocks.push(blk);
    segs.push([y + 16, y2 + 10]);
    y += 44 + 14 + lines.length * 14 + 18;
  });
  const axisY = y + 2;
  let grid = '';
  const lastSeg = segs[segs.length - 1];
  if (lastSeg) lastSeg[1] = axisY;
  for (const [g0, g1] of segs) for (const t of ticks) grid += `<line class="${t === 0 ? 'bt-zero' : 'bt-gridl'}" x1="${n1(X(t))}" y1="${n1(g0)}" x2="${n1(X(t))}" y2="${n1(g1)}"/>`;
  s += grid + blocks.join('');
  s += `<line class="bt-ax" x1="${n1(plotL)}" y1="${axisY}" x2="${n1(plotR)}" y2="${axisY}"/>`;
  for (const t of ticks) s += `<line class="bt-ax" x1="${n1(X(t))}" y1="${axisY}" x2="${n1(X(t))}" y2="${axisY + 5}"/><text class="bt-tk" x="${n1(X(t))}" y="${axisY + 18}" text-anchor="middle">${t === 0 ? '0' : sgn(t, 0)}</text>`;
  const axt = 'shift at the boundary, percentage points of the true (expected) count';
  const axtLines = wrap(axt, plotW, 11);
  axtLines.forEach((ln, k) => { s += `<text class="bt-axt" x="${plotL}" y="${axisY + 36 + k * 13}">${esc(ln)}</text>`; });
  const H = axisY + 36 + axtLines.length * 13 + 4;
  void bodyTop;
  return `<svg class="bt-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`Shift in count error at each firmware boundary: ${m.bounds.filter((b) => !b.to.null_control).map((b) => `${b.from.short} to ${b.to.short}, Clemson ${sayShift(b.shift.shift_pct)}, native walks ${sgn(b.shift.native_walks.mean_pct)}`).join('; ')} percentage points.`)}">${s}</svg>`;
}

/* ================================================================== Figure 7: phantom steps */

function fpBasis(m: Model): { files: string[]; nFiles: number; wearers: string[]; hours: number } {
  const fp = m.demo.false_positives_per_hour;
  const files = [...fp.files.drive, ...fp.files.train];
  const wearers = [...new Set(files.map((f) => f.replace(/^\d+_/, '').split(/[-_]/)[0] as string))];
  return { files, nFiles: files.length, wearers, hours: fp.hours.drive_train };
}

function renderPhantom(W: number, m: Model): string {
  const fp = m.demo.false_positives_per_hour;
  const compact = W < 520;
  const labelW = labelCol(m, compact);
  const padR = 24;
  const plotL = labelW;
  const plotR = W - padR;
  const plotW = plotR - plotL;
  const peak = Math.max(...fp.series.drive, ...fp.series.train, ...fp.series.drive_train);
  const step = [100, 200, 250, 500, 1000, 2000, 2500, 5000].find((t) => Math.ceil(peak / t) <= 6 && plotW / Math.ceil(peak / t) >= 52) ?? 1000;
  const dHi = Math.ceil(peak / step) * step;
  const X = (v: number): number => plotL + (v / dHi) * plotW;
  const nDrive = fp.files.drive.length;
  const nTrain = fp.files.train.length;
  const tDrive = `drive only, ${nDrive} files`;
  const tTrain = `train only, ${nTrain} file${nTrain === 1 ? '' : 's'}`;
  const tBar = `drive and train pooled, ${nDrive + nTrain} files`;
  // legend, wrapped to the width
  const lp = flowLegend([20 + tw(tBar, 11) + 18, 15 + tw(tDrive, 11) + 18, 15 + tw(tTrain, 11) + 18], plotL, W, 11, 18);
  const legendH = 26 + ((lp[lp.length - 1] as { y: number }).y - 11);
  const rowH = 48;
  const n = m.gens.length;
  const top = legendH + 4;
  const axisY = top + n * rowH;
  const axtLines = wrap('steps per hour above the manual count', W - plotL - 4, 11);
  const H = axisY + 36 + axtLines.length * 13 + 2;
  const ticks: number[] = [];
  for (let t = 0; t <= dHi; t += step) ticks.push(t);
  let s = `<svg class="bt-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`Steps per hour above the manual count on the non-walking recordings, per generation: ${m.gens.map((g, i) => `${g.short} ${fmtN(fp.series.drive_train[i] ?? 0)}`).join(', ')}.`)}">`;
  const [l0, l1, l2] = lp as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  s += `<rect class="bt-bar" x="${n1(l0.x)}" y="${l0.y - 5}" width="14" height="10" style="fill:${genFill(m, m.nLive > 1 ? 1 : 0)}"/><text class="bt-lg" x="${n1(l0.x + 20)}" y="${l0.y + 5}">${esc(tBar)}</text>`;
  s += `<circle class="bt-mk g1 hollow2" cx="${n1(l1.x + 5)}" cy="${l1.y}" r="4.4"/><text class="bt-lg" x="${n1(l1.x + 15)}" y="${l1.y + 5}">${esc(tDrive)}</text>`;
  s += `<path class="bt-mk g4" d="M${n1(l2.x + 5)} ${l2.y - 5}L${n1(l2.x + 10)} ${l2.y + 4}L${n1(l2.x)} ${l2.y + 4}Z"/><text class="bt-lg" x="${n1(l2.x + 15)}" y="${l2.y + 5}">${esc(tTrain)}</text>`;
  for (const t of ticks) s += `<line class="${t === 0 ? 'bt-zero' : 'bt-gridl'}" x1="${n1(X(t))}" y1="${top - 4}" x2="${n1(X(t))}" y2="${axisY}"/>`;
  m.gens.forEach((g, i) => {
    const y0 = top + i * rowH;
    const cy = y0 + 14;
    const nullc = g.null_control;
    const dt = fp.series.drive_train[i] ?? 0;
    const dr = fp.series.drive[i] ?? 0;
    const tr = fp.series.train[i] ?? 0;
    if (i % 2 === 1) s += `<rect class="bt-zebra" x="0" y="${y0 - 2}" width="${W}" height="${rowH}"/>`;
    s += `<rect class="bt-sw" x="0" y="${cy - 9}" width="10" height="10" style="fill:${genFill(m, i)}"/><text class="bt-rl" x="16" y="${cy}">${esc(g.short)}</text>`;
    if (!compact) s += `<text class="bt-rd" x="16" y="${cy + 13}">${esc(nullc ? 'identical output' : g.description)}</text>`;
    const tip = `<b>${esc(g.short)}</b><br>${fmtN(dt)} steps/h above the manual count<br><span class="mono">drive only (${nDrive} files, ${fp.hours.drive.toFixed(2)} h): ${fmtN(dr)}<br>train only (${nTrain} file, ${fp.hours.train.toFixed(2)} h): ${fmtN(tr)}</span>${nullc ? '<br>Null control: same as ' + esc((m.refOf[i] as Gen).short) + '.' : ''}`;
    s += `<g data-bt-tip="${esc(tip)}" class="bt-lane${nullc ? ' nullc' : ''}"><rect class="bt-hit" x="${plotL - 4}" y="${y0 - 1}" width="${n1(plotW + padR)}" height="${rowH - 2}"/>`;
    s += `<rect class="bt-bar${nullc ? ' nullc' : ''}" x="${plotL}" y="${cy - 6}" width="${n1(Math.max(1, X(dt) - plotL))}" height="12" style="fill:${genFill(m, i)}"/>`;
    s += `<circle class="bt-mk g1 hollow2" cx="${n1(X(dr))}" cy="${cy}" r="4.4"/><path class="bt-mk g4" d="M${n1(X(tr))} ${cy - 5}L${n1(X(tr) + 5)} ${cy + 4}L${n1(X(tr) - 5)} ${cy + 4}Z"/>`;
    // the three values, each beside the glyph that draws it (bar: pooled, circle: drive only, triangle: train only); a null control repeats the newest live generation
    const vy = cy + 22;
    let vx = plotL;
    const num = (v: number): string => fmtN(Math.round(v));
    const bw = tw(num(dt), 10.5, { mono: true });
    s += `<rect class="bt-bar" x="${n1(vx)}" y="${vy - 7}" width="12" height="8" style="fill:${genFill(m, i)}"/><text class="bt-val" x="${n1(vx + 16)}" y="${vy}">${num(dt)}</text>`;
    vx += 16 + bw + 12;
    s += `<circle class="bt-mk g1 hollow2" cx="${n1(vx + 4)}" cy="${vy - 3}" r="3.8"/><text class="bt-val" x="${n1(vx + 12)}" y="${vy}">${num(dr)}</text>`;
    vx += 12 + tw(num(dr), 10.5, { mono: true }) + 12;
    s += `<path class="bt-mk g4" d="M${n1(vx + 4)} ${vy - 8}L${n1(vx + 8.6)} ${vy - 0.5}L${n1(vx - 0.6)} ${vy - 0.5}Z"/><text class="bt-val" x="${n1(vx + 12)}" y="${vy}">${num(tr)}</text>`;
    vx += 12 + tw(num(tr), 10.5, { mono: true }) + 14;
    if (nullc) {
      const same = `${compact ? '=' : 'same as'} ${(m.refOf[i] as Gen).short}`;
      if (vx + tw(same, 10.5) <= W) s += `<text class="bt-nt" x="${n1(vx)}" y="${vy}">${esc(same)}</text>`;
    }
    s += '</g>';
  });
  s += `<line class="bt-ax" x1="${n1(plotL)}" y1="${axisY}" x2="${n1(plotR)}" y2="${axisY}"/>`;
  for (const t of ticks) s += `<line class="bt-ax" x1="${n1(X(t))}" y1="${axisY}" x2="${n1(X(t))}" y2="${axisY + 5}"/><text class="bt-tk" x="${n1(X(t))}" y="${axisY + 18}" text-anchor="middle">${fmtN(t)}</text>`;
  axtLines.forEach((ln, k) => { s += `<text class="bt-axt" x="${n1(plotL)}" y="${axisY + 36 + k * 13}">${esc(ln)}</text>`; });
  return `${s}</svg>`;
}

/* ================================================================== Figure 8: heart rate, algorithm layer only */

const KIND_LABEL: Record<string, string> = { bike_high: 'Bike, high resistance', bike_low: 'Bike, low resistance', run: 'Run', walk: 'Walk' };

function renderHRBars(W: number, hr: HRData): string {
  const ov = hr.ground_truth_eval.overall;
  const gensBy = Object.fromEntries(hr.generations.map((g) => [g.role, g]));
  const compact = W < 420;
  const labelW = compact ? 44 : 134;
  const padR = 62;
  const plotL = labelW;
  const plotR = W - padR;
  const plotW = plotR - plotL;
  const groups = [
    { title: `Windows with a value, share of ${fmtN(ov.A.n_windows)}`, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], fmt: (v: number) => `${(v * 100).toFixed(1)}%`, tk: (v: number) => `${Math.round(v * 100)}%`, get: (r: 'A' | 'B') => ov[r].valid_fraction },
    { title: 'Error on those windows, mean absolute (bpm)', max: Math.ceil(Math.max(ov.A.mae_bpm, ov.B.mae_bpm) / 10) * 10, ticks: [] as number[], fmt: (v: number) => v.toFixed(1), tk: (v: number) => String(v), get: (r: 'A' | 'B') => ov[r].mae_bpm },
  ];
  const g1 = groups[1] as (typeof groups)[number];
  for (let t = 0; t <= g1.max; t += 10) g1.ticks.push(t);
  let y = 6;
  let s = '';
  groups.forEach((gr) => {
    const X = (v: number): number => plotL + (v / gr.max) * plotW;
    const tl = wrap(gr.title, W - 4, 12, { mono: true, w: 500 });
    tl.forEach((ln, k) => { s += `<text class="bt-bh" x="0" y="${y + 11 + k * 14}">${esc(ln)}</text>`; });
    y += 6 + tl.length * 14;
    const bodyTop = y;
    const axY = bodyTop + 88;
    // grid first, so the bars are drawn over it
    for (const t of gr.ticks) s += `<line class="bt-gridl" x1="${n1(X(t))}" y1="${bodyTop - 2}" x2="${n1(X(t))}" y2="${axY}"/>`;
    (['A', 'B'] as const).forEach((role, k) => {
      const cy = y + k * 44 + 16;
      const g = gensBy[role];
      const v = gr.get(role);
      s += `<text class="bt-rl" x="0" y="${cy + 4}">${role}</text>`;
      if (!compact && g) s += `<text class="bt-rd" x="14" y="${cy + 4}">${role === 'A' ? 'autocorrelation' : 'FFT'}, ${g.native_rate_hz} Hz</text>`;
      s += `<g data-bt-tip="${esc(`<b>Generation ${role}</b> · ${esc(g?.label ?? '')}<br>${esc(gr.title)}: ${gr.fmt(v)}`)}"><rect class="bt-hit" x="0" y="${cy - 15}" width="${W}" height="30"/><rect class="bt-bar hr${role}" x="${plotL}" y="${cy - 9}" width="${n1(Math.max(1, X(v) - plotL))}" height="18"/><text class="bt-val" x="${n1(X(v) + 8)}" y="${cy + 4}">${gr.fmt(v)}</text></g>`;
    });
    y = axY + 8;
    s += `<line class="bt-ax" x1="${n1(plotL)}" y1="${axY}" x2="${n1(plotR)}" y2="${axY}"/>`;
    for (const t of gr.ticks) s += `<line class="bt-ax" x1="${n1(X(t))}" y1="${axY}" x2="${n1(X(t))}" y2="${axY + 4}"/><text class="bt-tk" x="${n1(X(t))}" y="${axY + 16}" text-anchor="middle">${gr.tk(t)}</text>`;
    y += 28;
  });
  return `<svg class="bt-svg" viewBox="0 0 ${W} ${y}" width="${W}" height="${y}" role="img" aria-label="${esc(`InfiniTime heart rate against ECG: generation A has a value in ${(ov.A.valid_fraction * 100).toFixed(1)} percent of windows with a mean absolute error of ${ov.A.mae_bpm.toFixed(1)} bpm; generation B in ${(ov.B.valid_fraction * 100).toFixed(1)} percent with ${ov.B.mae_bpm.toFixed(1)} bpm.`)}">${s}</svg>`;
}

function renderHRForest(W: number, hr: HRData): string {
  const ge = hr.ground_truth_eval;
  const compact = W < 520;
  const labelW = compact ? 0 : 150;
  const valW = compact ? 0 : 124;
  const padL = labelW;
  const plotL = padL + (compact ? 6 : 0);
  const plotR = W - valW - (compact ? 14 : 8);
  const plotW = plotR - plotL;
  const rows: { label: string; sub: string; est: number; ci: [number, number]; ci2?: [number, number]; tip: string }[] = [];
  const all = ge.difference_B_minus_A;
  rows.push({
    label: 'All activities', sub: `${ge.n_subjects} subjects, ${all.n_windows_both_valid} windows`,
    est: all.abs_error_diff_subject_bootstrap.estimate, ci: all.abs_error_diff_subject_bootstrap.ci95, ci2: all.abs_error_diff_window_bootstrap.ci95,
    tip: `<b>All activities</b><br>B minus A, absolute error on windows where both report: ${plain(all.abs_error_diff_subject_bootstrap.estimate)} bpm<br><span class="mono">subject bootstrap [${plain(all.abs_error_diff_subject_bootstrap.ci95[0])}, ${plain(all.abs_error_diff_subject_bootstrap.ci95[1])}], ${all.abs_error_diff_subject_bootstrap.n_units} subjects<br>window bootstrap [${plain(all.abs_error_diff_window_bootstrap.ci95[0])}, ${plain(all.abs_error_diff_window_bootstrap.ci95[1])}], ${all.abs_error_diff_window_bootstrap.n_units} windows (optimistic)</span>`,
  });
  for (const [k, v] of Object.entries(ge.difference_B_minus_A_by_kind)) {
    const sb = v.abs_error_diff_subject_bootstrap;
    rows.push({
      label: KIND_LABEL[k] ?? cap(k.replace(/_/g, ' ')), sub: `${sb.n_units} subjects, ${v.n_windows_both_valid} windows`, est: sb.estimate, ci: sb.ci95,
      tip: `<b>${esc(KIND_LABEL[k] ?? k)}</b><br>B minus A: ${plain(sb.estimate)} bpm<br><span class="mono">subject bootstrap [${plain(sb.ci95[0])}, ${plain(sb.ci95[1])}], ${sb.n_units} subjects, ${v.n_windows_both_valid} windows</span>`,
    });
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) { lo = Math.min(lo, r.ci[0], r.ci2?.[0] ?? Infinity); hi = Math.max(hi, r.ci[1], r.ci2?.[1] ?? -Infinity); }
  const dLo = Math.floor(lo / 10) * 10;
  const dHi = Math.max(10, Math.ceil(hi / 10) * 10);
  const X = (v: number): number => plotL + ((v - dLo) / (dHi - dLo)) * plotW;
  const ticks: number[] = [];
  for (let t = Math.ceil(dLo / 10) * 10; t <= dHi; t += 10) if (t % 20 === 0) ticks.push(t);
  const rowH = compact ? 60 : 42;
  const top = 34;
  const axY = top + rows.length * rowH + 2;
  let s = '';
  // direction labels above the plot
  s += `<text class="bt-dirl" x="${n1(X(0) - 8)}" y="14" text-anchor="end">← B closer to the ECG</text><text class="bt-dirl" x="${n1(X(0) + 8)}" y="14">B further off →</text>`;
  if (!compact) s += `<text class="bt-dirl" x="${W}" y="14" text-anchor="end">B − A [subject CI]</text>`;
  if (!compact) for (const t of ticks) s += `<line class="${t === 0 ? 'bt-zero' : 'bt-gridl'}" x1="${n1(X(t))}" y1="${top - 6}" x2="${n1(X(t))}" y2="${axY}"/>`;
  rows.forEach((r, i) => {
    const y0 = top + i * rowH;
    const cy = compact ? y0 + 42 : y0 + rowH / 2 - 1;
    if (i % 2 === 1) s += `<rect class="bt-zebra" x="0" y="${y0 - 2}" width="${W}" height="${rowH}"/>`;
    // phones: the grid is drawn only beside the interval, so it never runs through the row's text
    if (compact) for (const t of ticks) s += `<line class="${t === 0 ? 'bt-zero' : 'bt-gridl'}" x1="${n1(X(t))}" y1="${n1(cy - 14)}" x2="${n1(X(t))}" y2="${n1(cy + 14)}"/>`;
    const val = `${plain(r.est)} [${plain(r.ci[0])}, ${plain(r.ci[1])}]`;
    if (compact) {
      const crowded = tw(r.label, 12, { mono: true, w: 500 }) + tw(val, 10.5, { mono: true }) + 12 > W;
      s += `<text class="bt-rl" x="0" y="${y0 + 11}">${esc(r.label)}</text><text class="bt-rd" x="0" y="${y0 + 24}">${esc(r.sub)}</text><text class="bt-val" x="${W}" y="${y0 + (crowded ? 24 : 11)}" text-anchor="end">${val}</text>`;
    } else {
      s += `<text class="bt-rl" x="0" y="${n1(cy - 2)}">${esc(r.label)}</text><text class="bt-rd" x="0" y="${n1(cy + 11)}">${esc(r.sub)}</text><text class="bt-val" x="${W}" y="${n1(cy + 3.6)}" text-anchor="end">${val}</text>`;
    }
    s += `<g data-bt-tip="${esc(r.tip)}"><rect class="bt-hit" x="0" y="${y0 - 2}" width="${W}" height="${rowH}"/>`;
    if (r.ci2) s += `<line class="bt-wh thin" x1="${n1(X(r.ci2[0]))}" y1="${n1(cy + 8)}" x2="${n1(X(r.ci2[1]))}" y2="${n1(cy + 8)}"/>`;
    s += `<line class="bt-wh" x1="${n1(X(r.ci[0]))}" y1="${n1(cy)}" x2="${n1(X(r.ci[1]))}" y2="${n1(cy)}"/><line class="bt-wh" x1="${n1(X(r.ci[0]))}" y1="${n1(cy - 3.5)}" x2="${n1(X(r.ci[0]))}" y2="${n1(cy + 3.5)}"/><line class="bt-wh" x1="${n1(X(r.ci[1]))}" y1="${n1(cy - 3.5)}" x2="${n1(X(r.ci[1]))}" y2="${n1(cy + 3.5)}"/>`;
    s += `<circle class="bt-mk g3c" cx="${n1(X(r.est))}" cy="${n1(cy)}" r="4.6"/></g>`;
  });
  s += `<line class="bt-ax" x1="${n1(plotL)}" y1="${axY}" x2="${n1(plotR)}" y2="${axY}"/>`;
  for (const t of ticks) s += `<line class="bt-ax" x1="${n1(X(t))}" y1="${axY}" x2="${n1(X(t))}" y2="${axY + 5}"/><text class="bt-tk" x="${n1(X(t))}" y="${axY + 18}" text-anchor="middle">${t === 0 ? '0' : sgn(t, 0)}</text>`;
  const axt = 'B minus A, absolute heart-rate error in bpm, on windows where both generations report. Bracketed values and the thick line: subject-bootstrap 95% CI, every row. Thin line, first row only: window bootstrap (optimistic).';
  const axtLines = wrap(axt, W - 6, 11);
  axtLines.forEach((ln, k) => { s += `<text class="bt-axt" x="0" y="${axY + 36 + k * 13}">${esc(ln)}</text>`; });
  const H = axY + 36 + axtLines.length * 13 + 2;
  return `<svg class="bt-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`Change in heart-rate error from generation A to generation B, with subject bootstrap intervals: ${rows.map((r) => `${r.label} ${plain(r.est)} bpm, ${plain(r.ci[0])} to ${plain(r.ci[1])}`).join('; ')}.`)}">${s}</svg>`;
}

/* ================================================================== text copied from the repository */
// scripts/check-built-text.mjs asserts that each of these still appears in drift/README.md or results/drift/memo-example.md.

const RUN_CMDS = `python -m pip install -r drift/requirements.txt
python -m drift fetch  --target espruino_stepcount   # firmware source + datasets into .cache/drift/
python -m drift build  --target espruino_stepcount   # tags -> generations -> one compiled library each
python -m drift replay --target espruino_stepcount   # every generation x every recording
python -m drift all    --target espruino_stepcount   # fetch, build, replay, metrics, memo, export
python -m pytest drift/tests -q                      # 112 tests: live upstream reproduction, null controls, adapters, history, pins`;

const MEMO_CMD = 'python -m drift memo --target espruino_stepcount --start 2021-05-01 --end 2022-06-30 --population "older adults, regular gait"';

/** The README's sentence on the two papers that argue the risk (its markdown italics shown as <em>). */
const README_PRIOR =
  'Collins et al. 2019 (<em>Sensors</em> 19(7):1705) argue that validity is not maintained when updates change device performance and recommend reporting device versions (their own experiment tested a single firmware version), and Woolley et al. 2019 (<em>BMJ Health Care Inform</em> 26(1):e100083) found that 32% of 194 changelog items across six trackers could affect validation. Neither measures an update’s effect on a metric; Drift’s differential runs do.';

/** Credits, worded as in the memo's "Why this matters: evidence" section (the README says Collins and Woolley are "cited as in the memo"). */
const CREDITS: { who: string; text: string; url: string }[] = [
  {
    who: 'Williams G. step-count: offline test harness for the Espruino step counter (GitHub repository).',
    text: "The technique Drift builds on: a small C harness that runs Espruino's own step-counter code over recorded accelerometer files and prints the difference between the expected and the calculated count. Drift applies that idea to every released version of the code, adds the Clemson recordings, and turns the differences into dated, uncertainty-bounded shifts. Its recordings are used here by reference and are not redistributed.",
    url: 'https://github.com/gfwilliams/step-count',
  },
  {
    who: 'Koffman L, Crainiceanu C, Muschelli J. Comparing Step Counting Algorithms for High-Resolution Wrist Accelerometry Data in NHANES 2011-2014. arXiv:2410.11040 (2024).',
    text: 'Ran five step-counting algorithms on the same NHANES wrist recordings. The estimates were correlated and predicted mortality about equally well, but the population mean daily step counts ranged from 2,453 to 12,169 and the hazard ratio for a 500-step increase ranged from 0.88 to 0.96. This is algorithm choice, not firmware version; it shows how far the same raw data can move when the step algorithm changes, which is the question Drift asks of each release.',
    url: 'https://arxiv.org/abs/2410.11040',
  },
  {
    who: 'Woolley SI, Collins T, Mitchell J, Fredericks D. Investigation of wearable health tracker version updates. BMJ Health Care Inform 2019;26(1):e100083.',
    text: 'Read the changelogs of six wrist-worn trackers (device models used in clinical-trial registrations): 194 update items, 32% judged as possibly affecting device validation. Only the Polar changelog carried dates, and for that one the intervals between updates that could affect validation ranged from 5 to 218 days. Because devices can update during synchronisation, firmware changes can be applied in the middle of a study without the researchers noticing. The authors conclude that firmware updates can nullify device validations.',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7062347/',
  },
  {
    who: 'Collins T, Woolley SI, Oniani S, Pires IM, Garcia NM, Ledger SJ, Pandyan A. Version Reporting and Assessment Approaches for New and Updated Activity and Heart Rate Monitors. Sensors 2019;19(7):1705.',
    text: "Argues that validity is not maintained when firmware and software updates change device performance, that devices with the same model name but different versions are distinct devices, and that version numbers belong in the study report. As an illustration they note that one Garmin model went through 14 versions in about 30 months. Their own experiment tested a single version, so it demonstrates the problem and a re-assessment method rather than measuring an update's effect.",
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6480461/',
  },
  {
    who: 'Ravanelli N, Lefebvre K, Brough A, Paquette S, Lin W. Validation of an Open-Source Smartwatch for Continuous Monitoring of Physical Activity and Heart Rate in Adults. Sensors 2025;25(9):2926.',
    text: 'Validated the step counter of the Bangle.js 2, the watch whose firmware Drift replays, against a Fitbit Charge 5 (47 adults, 24 h free-living, plus a treadmill and stair session). A firmware update (V2.19) landed during data collection; the paper describes it as replacing the filter used for heart-beat detection, and two participants did the 24 h condition once before and once after it. The paper does not report a before/after comparison of step counts, so what that update did to steps is unmeasured. The Bangle.js 2 undercounted at the slower treadmill speeds, heavily at 2 mph (mean absolute percent error 56.0%; 14.3% at 3 mph, 14.6% at 4 mph), and reached acceptable error at the fastest (6.1% at 5 mph), so a near-zero bias measured on young adults walking at a normal pace does not carry over to slow or older walkers. The authors describe its step algorithm as a finite state machine.',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC12074211/',
  },
];

/* ================================================================== the section */

const EXPLORATORY = honesty('exploratory', "Exploratory: Drift's own differential runs, not part of the pre-registered test.");

function figHead(n: number, title: string): string {
  return `<div class="bt-head"><span class="fig-label">Figure ${n}</span><span class="bt-ft">${esc(title)}</span>${EXPLORATORY}</div>`;
}

const panel = (tag: string, title: string, sub: string, inner: string): string =>
  `<div class="bt-panel"><p class="bt-ph"><span class="bt-pt">${esc(tag)}</span><b>${esc(title)}</b>${sub ? `<span class="bt-ps">${esc(sub)}</span>` : ''}</p>${inner}</div>`;

const vPill = (kind: VKind, text: string): string => `<span class="pill bt-${kind}">${esc(text)}</span>`;

function memoTableHTML(m: Model): string {
  const rows = m.bounds.filter((b) => b.inWin);
  const body = rows
    .map((b) => {
      const sh = b.shift;
      const nw = sh.native_walks;
      return `<tr><th scope="row"><span class="mono">${esc(b.from.short)} → ${esc(b.to.short)}</span><small>${esc(b.date)}</small></th><td class="num">${sgn(sh.shift_pct, 2)} <small>[${sgn(sh.ci_pct[0], 2)}, ${sgn(sh.ci_pct[1], 2)}]</small></td><td class="num">${sh.n_beyond_threshold} of ${sh.n_subjects}</td><td class="num">${sgn(nw.mean_pct)} <small>(${sgn(nw.min_pct)} to ${sgn(nw.max_pct)})</small></td><td>${vPill(b.kind, b.label)}</td></tr>`;
    })
    .join('');
  return `<div class="scroll-x"><table class="bt-tbl"><thead><tr><th>Boundary</th><th class="num">Clemson, Regular: mean shift [95% CI], points</th><th class="num">Subjects moving by more than ±2</th><th class="num">Six native walks: mean (range), points</th><th>Overall verdict</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

export function builtHTML(c: BuiltCtx): string {
  const { d } = c;
  const w = d.winner as { status: string; code: string; title: string; pitch: string; how_it_works: string[]; repo_path: string; pick?: { code: string; stats: { observed_new: number; E_new: number; E_pooled: number; q_pooled: number; E_new_indep: number; q_pooled_indep: number; official_verdict: string } } };
  const m = buildModel(d);
  const h = c.holes.find((x) => x.code === w.code);
  const nTested = d.replication.rows.length;
  const pick = w.pick;
  const head = `
<p class="eyebrow pp-eyebrow">Built</p>
<h2>${esc(cap(w.title))}</h2>
<p class="pp-lead"><span class="code">${esc(w.code)}</span>${h ? ` · ${esc(cellLabel(h))} · expected ${fmtE(h.E)}, observed 0` : ''}</p>
<p>${esc(w.pitch)}</p>`;
  const status = pick
    ? `
<div class="pp-status bt-status" role="note">
  <p class="pp-lbl">Status · picked after the fact, not earned</p>
  <p>No hole passed the registered gate: <strong>${c.nReplicated} of ${nTested}</strong> replicated, so by the rules written in advance nothing earned a build. We picked <span class="nowrap">${esc(pick.code)}</span> anyway, after seeing the results. Under the registered rule it is <strong>${esc(pick.stats.official_verdict)}</strong>: still empty in the new sample (observed ${pick.stats.observed_new}), but the new reports alone predict only ${fmtE(pick.stats.E_new)}, below the bar of 2. On the pooled sample it is the strongest hole there is: ${fmtE(pick.stats.E_pooled)} expected, none observed, <span class="nowrap"><em>q</em> = ${fmtP(pick.stats.q_pooled)}</span>. Under plain independence the new sample alone gives ${fmtE(pick.stats.E_new_indep)} expected and none observed (<em>q</em> ${fmtP(pick.stats.q_pooled_indep)}). Both readings are in the sensitivity table, and the official verdict stays as registered.</p>
  <p>Why this hole, then: it answers a documented problem that the literature argues but has not measured; it is software only, on public firmware; it produces numbers anyone can recompute; and it sits between the two coastlines the data says never meet, device hacking and science. The tagging audit narrows the hole to <em>consumer hardware in research</em>, which is the scope Drift works in. Everything below is Drift’s own differential run ${EXPLORATORY} and was not part of the pre-registered test.</p>
</div>`
    : '';
  const how = w.how_it_works.length ? `<h3>How it works</h3><ol class="pp-how">${w.how_it_works.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : '';
  if (!m) {
    return `${head}${status}${how}<p class="pp-dim">The result figures could not be drawn: <span class="mono">winner.json</span> has no complete <span class="mono">demo</span> block. Run <span class="mono">python -m drift all --target espruino_stepcount</span>.</p>${c.priorArt()}`;
  }

  const demo = m.demo;
  const first = m.gens[0] as Gen;
  const last = m.gens[m.gens.length - 1] as Gen;
  const nNull = m.gens.filter((g) => g.null_control).length;
  const nullRec = demo.null_controls[0]?.recordings ?? 0;
  const ed = demo.error_distributions;
  const irr = ed.by_gait.irregular ?? [];
  const reg = ed.by_gait.regular ?? [];
  const sw = demo.same_walk;
  const liveGens = m.gens.filter((g) => !g.null_control);
  const liveList = liveGens.map((g) => fmtN(sw.counted[g.gen_id] ?? NaN)).join(', ');
  const med = (rows: GaitRow[], i: number): number => (rows[i] as GaitRow).median_pct;
  const regLater = reg.slice(1, m.nLive).map((r) => r.median_pct);
  const iqrW = (r: GaitRow): number => r.iqr_pct[1] - r.iqr_pct[0];
  const shortOf = (r: GaitRow): string => m.gens.find((g) => g.gen_id === r.gen_id)?.short ?? r.label;
  // the live generations after the second, each with its own interquartile width (the newest live one is not the narrowest)
  const iqrLater = reg.slice(2, m.nLive).map((r) => `${iqrW(r).toFixed(1)} at ${esc(shortOf(r))}`).join(' and ');
  const fb = fpBasis(m);
  const fp = demo.false_positives_per_hour;
  const lastLiveIdx = m.nLive - 1;
  const wearerText = fb.wearers.length === 1 ? 'one wearer' : `${word(fb.wearers.length)} wearers`;
  const basis = `${fb.nFiles} files · ${wearerText} · ${fb.hours.toFixed(2)} h · no CI`;
  const fpCaveat = demo.caveats.find((x) => /^False-positive rates/.test(x)) ?? '';
  const nWalk = demo.native_walk_check.n_files;
  const nativeWearer = demo.native_walk_check.wearers.length === 1 ? 'one wearer' : `${demo.native_walk_check.wearers.length} wearers`;
  const irrTop = Math.max(...irr.map((r) => r.iqr_pct[1]));

  const fig5 = `
<p>Drift fetched the open Espruino firmware at every release tag from ${esc(tagName(first.first_tag))} to ${esc(tagName(last.last_tag))} (${demo.provenance.firmware_tag_pin.n_tags} tags), compiled the step-counter source of each for the host, and grouped tags whose algorithm source is identical. That leaves ${word(demo.headline.distinct_algorithms_to_compare)} different algorithms across ${word(m.gens.length)} generations. The newest ${word(nNull)} changed the source only cosmetically or by a clamp fix that cannot be reached. They are the null controls, and Drift’s output on them is identical on all ${nullRec} recordings, which is the check that a difference elsewhere comes from the algorithm and not from the harness.</p>
<figure class="figure bt-fig" id="fig5">
  ${figHead(5, `One step counter, ${word(m.gens.length)} firmware generations`)}
  <div class="bt-tlbox"><div class="bt-tlwrap" data-bt="timeline" data-mode="stack"><div class="bt-chart bt-tl-svg"></div><div class="bt-tl-stack">${timelineStack(m)}</div></div></div>
  <figcaption><span class="pp-fn">Figure 5.</span> <b>One step counter, ${word(m.gens.length)} firmware generations.</b> Bangle.js (Espruino) releases from ${nb(first.first_date)}, drawn to scale and banded by algorithm generation: a new band starts where the step-counter source changes. Band colour is the generation, from oldest (dimmest) to newest (brightest), and the same swatch marks the same generation in Figures 6 and 7. Dates are the commit dates of the release tags, not the day a given watch was updated. The hatched generations are null controls and give <em>identical output</em>. The shaded span is the example study window of the memo, ${nb(m.winLo)} to ${nb(m.winHi)}; each flag is the memo’s overall verdict for that boundary after the native cross-check (Figure 6 shows what it rests on). Flags outside the window sit on boundaries between identical generations.</figcaption>
</figure>`;

  const fig6 = `
<p>The test itself is simple: feed the identical recorded data to every generation and compare the counts. On the Clemson recordings (${ed.subjects.length} young adults, each walking three gaits) the Regular-gait median error is ${sgn(med(reg, 0))}% for ${esc(first.short)} and between ${sgn(Math.min(...regLater))}% and ${sgn(Math.max(...regLater))}% for the later generations, and the interquartile range narrows from ${iqrW(reg[0] as GaitRow).toFixed(1)} points (${esc(first.short)}) to ${iqrW(reg[1] as GaitRow).toFixed(1)} (${esc(shortOf(reg[1] as GaitRow))})${iqrLater ? `, then ${iqrLater}` : ''}. In Irregular gait the oldest generation overcounts by a median ${sgn(med(irr, 0), 0)}% and the newest live one by ${sgn(med(irr, lastLiveIdx), 0)}%. One recorded walk of ${fmtN(sw.steps_true)} steps is counted as ${esc(liveList)} by the ${word(m.nLive)} different algorithms.</p>
<p>Clemson is not Bangle.js data, though. The ${word(nWalk)} walking files recorded on a Bangle.js (${nativeWearer}, no resampling) move by very different amounts at the same boundaries, and Drift reports both rather than choosing: where the native walks disagree, a Clemson “comparable” is downgraded to “not confirmed”.</p>
<figure class="figure bt-fig" id="fig6">
  ${figHead(6, 'Same people, same steps, different firmware')}
  <div class="bt-panels p6">
    ${panel('a', 'Count error by gait', `Clemson, ${ed.subjects.length} subjects · median and IQR · symlog axis`, '<div class="bt-chart" data-bt="count"></div>')}
    ${panel('b', 'Native Bangle.js walks against Clemson', 'shift at each boundary · mean and 95% CI', '<div class="bt-chart" data-bt="shifts"></div>')}
  </div>
  <figcaption><span class="pp-fn">Figure 6.</span> <b>Same people, same steps, different firmware.</b> <i>(a)</i> Percent error of the step count against the true count, median and interquartile range over ${ed.subjects.length} subjects, per gait and generation. The axis is symlog: linear within ±${SYMC} percent of zero (shaded), logarithmic beyond. It is shared by the three gaits so they can be compared, and it keeps Regular readable while Irregular, which reaches ${sgn(irrTop, 0)}% at the upper quartile, still fits. The printed values are medians; where the interquartile range is narrower than its marker (Irregular, ${esc(first.short)}) it is drawn as a small bracket under the marker. The swatch beside each row is the generation’s colour from Figure 5, oldest to newest. <i>(b)</i> How far the count error moves at each boundary, in percentage points of the true count: Clemson Regular gait (mean and 95% bootstrap CI over ${ed.subjects.length} subjects) against the ${word(nWalk)} native Bangle.js walks (${nativeWearer}; mean and range, no CI). “Disagree” marks a native mean outside the Clemson interval. In the null-control rows both shifts are exactly 0 by construction (identical output), so their markers at 0 are measured zeros, not placeholders; they carry no interval. The resampler matters as well: with linear interpolation instead of the polyphase default the Clemson shifts and the Semi-regular and Irregular medians move materially (memo, section 3).</figcaption>
</figure>`;

  const fig7 = `
<p>Walking is what a step counter is built for. The larger change between generations is outside it. On recordings of the wearer driving or on a train, where the true count is close to zero, ${esc(first.short)} counts ${fmtN(fp.series.drive_train[0] ?? 0)} steps an hour above the manual count and ${esc((m.gens[lastLiveIdx] as Gen).short)} counts ${fmtN(fp.series.drive_train[lastLiveIdx] ?? 0)}. A study that reads sedentary time from these devices would see that as a change in the metric. The basis is thin, and the figure says so.</p>
<figure class="figure bt-fig" id="fig7">
  ${figHead(7, 'Phantom steps')}
  <div class="bt-panels p7">
    ${panel('a', 'Steps per hour above the manual count', 'non-walking recordings', '<div class="bt-chart" data-bt="phantom"></div>')}
    <div class="bt-panel bt-basis">
      <p class="bt-ph"><b>Basis</b></p>
      <p class="bt-basisline mono">${esc(basis)}</p>
      <p class="bt-dimp">${esc(fp.unit)}.</p>
      <ul class="bt-files mono">${fp.files.drive.map((f) => `<li><span>drive</span>${esc(f)}</li>`).join('')}${fp.files.train.map((f) => `<li><span>train</span>${esc(f)}</li>`).join('')}</ul>
      <p class="bt-dimp">${esc(fpCaveat)}</p>
    </div>
  </div>
  <figcaption><span class="pp-fn">Figure 7.</span> <b>Phantom steps.</b> Steps per hour counted above the expected total on the non-walking Bangle.js recordings, per generation. The bar pools drive and train (${esc(basis.replace(/ · /g, ', '))}); the markers split it into the drive files (${fp.files.drive.length} files, ${fp.hours.drive.toFixed(2)} h) and the train file (${fp.files.train.length} file, ${fp.hours.train.toFixed(2)} h; hours are rounded separately, so they may not add up to the total). The three values under each bar are, in order, the pooled bar, the drive-only circle and the train-only triangle; the null controls repeat the values of the newest live generation. Bar colour is the generation, as in Figure 5. There is no confidence interval: ${word(fb.nFiles)} files from ${wearerText} cannot support one.</figcaption>
</figure>`;

  const fig8 = `
<p id="hr-intro">Drift’s second target is the PineTime’s open InfiniTime firmware, whose heart-rate code changed algorithm once.</p>
<figure class="figure bt-fig" id="fig8">
  ${figHead(8, 'Heart rate, algorithm layer only')}
  <div id="fig8-body"><p class="bt-load" role="status">Loading the heart-rate results…</p></div>
  <figcaption id="fig8-cap"><span class="pp-fn">Figure 8.</span> <b>Heart rate, algorithm layer only.</b></figcaption>
</figure>`;

  const memo = `
<h3>The memo a study team gets</h3>
<p>For a study window, the last step of Drift is a dated data-validity memo. This is the example for ${nb(m.winLo)} to ${nb(m.winHi)}: its bottom line, and the one table that carries the verdicts.</p>
<div class="bt-memo" id="memo-card">
  <p class="eyebrow bt-memo-e">Memo excerpt · an example, not a real study</p>
  <p class="bt-memo-t" id="memo-title">Data-validity memo: Bangle.js (Espruino) step counter, ${nb(m.winLo)} to ${nb(m.winHi)}</p>
  <div class="bt-bl" id="memo-bl"><p class="bt-load" role="status">Loading the bottom line from the memo…</p></div>
  ${memoTableHTML(m)}
  <p class="bt-memo-f"><a class="bt-btn" href="${esc(baseUrl())}drift/memo.html">Read the full memo</a><span class="bt-dimp">The table is the memo’s native cross-check, Regular gait. A verdict is about a mean; individual participants can still move.</span></p>
</div>`;

  const repo = d.meta.repo_url;
  const skillUrl = `${repo}/blob/main/drift/skill/SKILL.md`;
  const run = `
<h3>Run it yourself</h3>
<p>Every number above comes from a command anyone can rerun. Run these from the repository root with the project’s Python environment (shown as <span class="mono">python</span>). No C compiler is needed: Drift uses the <span class="mono">ziglang</span> pip package through <span class="mono">drift/toolchain.py</span>.</p>
<div class="bt-code breakout"><button type="button" class="bt-copy" data-copy="run" aria-label="Copy the commands">Copy</button><pre><code id="run-cmds">${esc(RUN_CMDS)}</code></pre></div>
<p>The memo on its own:</p>
<div class="bt-code breakout"><button type="button" class="bt-copy" data-copy="memo" aria-label="Copy the memo command">Copy</button><pre><code id="memo-cmd">${esc(MEMO_CMD)}</code></pre></div>
<p class="bt-skill"><a href="${esc(skillUrl)}" rel="noopener noreferrer" target="_blank"><span class="mono">drift/skill/SKILL.md</span></a> is the Claude Code skill that onboards a new open-source device.${c.repoPublished ? '' : ' <span class="bt-dimp">(The repository is not public yet, so this link opens once it is.)</span>'}</p>`;

  const credits = `
<h3>Prior art, and whose work this stands on</h3>
<p>${README_PRIOR}</p>
<div class="breakout bt-credits" id="bt-credits">
  <p class="eyebrow">Prior art and credit · each citation was checked against its source</p>
  <ul>${CREDITS.map((x) => `<li><p class="bt-cw">${esc(x.who)}</p><p>${esc(x.text)} <a href="${esc(x.url)}" rel="noopener noreferrer" target="_blank">Source</a></p></li>`).join('')}</ul>
</div>`;

  const note = `
<aside class="bt-note" id="bt-globe-note">
  <p class="pp-lbl">A note on the globe</p>
  <h3>Why Drift sits far from <span class="nowrap">${esc(w.code)}</span> on the globe</h3>
  <p>The hole is a combination of facet tags${h ? `: ${esc(cellLabel(h))}` : ''}. Drift’s description is a different object. Embedded as text, it lands near the health and wearable reports, which is where its words live. The ring that marks the hole sits at the midpoint of two filaments, the reports carrying one tag and the reports carrying the other, so it marks a combination of tags, not a place in meaning. <a href="#${esc(w.code)}">Select ${esc(w.code)} on the globe</a>.</p>
</aside>`;

  return `${head}${status}${how}${fig5}${fig6}${fig7}${fig8}${memo}${run}${credits}${c.priorArt()}${note}`;
}

/* ================================================================== browser wiring */

function mount(measure: HTMLElement, draw: (w: number) => string, target: HTMLElement = measure): void {
  let lastW = 0;
  const run = (): void => {
    const w = Math.floor(measure.clientWidth);
    if (w < 120 || w === lastW) return;
    lastW = w;
    target.innerHTML = draw(w);
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(run).observe(measure);
  run();
  void document.fonts?.ready.then(() => { lastW = 0; run(); });
}

async function loadHR(): Promise<HRData> {
  const res = await fetch(`${baseUrl()}data/drift-infinitime.json`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Could not load data/drift-infinitime.json (${res.status})`);
  return (await res.json()) as HRData;
}

function hrBody(hr: HRData): { intro: string; body: string; cap: string } {
  const ge = hr.ground_truth_eval;
  const A = ge.overall.A;
  const B = ge.overall.B;
  const gA = hr.generations.find((g) => g.role === 'A');
  const gB = hr.generations.find((g) => g.role === 'B');
  const gN = hr.generations.find((g) => g.role === 'A_null');
  const diff = ge.difference_B_minus_A;
  const sb = diff.abs_error_diff_subject_bootstrap;
  const kinds = Object.entries(ge.difference_B_minus_A_by_kind).map(([k, v]) => {
    const b = v.abs_error_diff_subject_bootstrap;
    return { name: (KIND_LABEL[k] ?? k).toLowerCase(), est: b.estimate, lo: b.ci95[0], hi: b.ci95[1], incl0: b.ci95[0] <= 0 && b.ci95[1] >= 0 };
  });
  const posK = kinds.filter((k) => k.est > 0);
  const posText = posK.map((k) => `${k.name} (${sgn(k.est)} bpm, CI ${plain(k.lo)} to ${sgn(k.hi)}${k.incl0 ? ', which includes 0' : ''})`).join('; ');
  const otherIncl = kinds.filter((k) => k.incl0 && k.est <= 0).map((k) => k.name);
  const exclK = kinds.filter((k) => !k.incl0).map((k) => k.name);
  const exclPooled = sb.ci95[0] > 0 || sb.ci95[1] < 0;
  const exclText = exclK.length && exclK.every((n) => n.startsWith('bike')) ? `the ${word(exclK.length)} bike conditions` : exclK.join(' and ');
  const signText = posK.length
    ? `, and the sign is not the same in every activity: B is not closer on ${posText}${otherIncl.length ? `; the ${otherIncl.join(' and ')} interval also includes 0` : ''}. Only ${exclText}${exclPooled ? ' and the pooled estimate' : ''} exclude 0`
    : '';
  const sc = hr.scaling_sensitivity;
  const bShare = sc.map((x) => x.overall.B.valid_fraction);
  const sigma = sc.map((x) => x.ac_sigma_counts);
  const pc = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const intro = `Drift’s second target is the PineTime’s open InfiniTime firmware, whose heart-rate code changed algorithm once, from time-domain autocorrelation (${esc(gA?.first_tag ?? '')} to ${esc(gA?.last_tag ?? '')}) to an FFT (${esc(gB?.first_tag ?? '')} to ${esc(gB?.last_tag ?? '')}). Replayed on ${ge.n_recordings} public wrist recordings from ${ge.n_subjects} subjects, with ECG as the reference, the FFT is on average ${sb.estimate < 0 ? 'closer to' : 'further from'} the ECG on the windows where both algorithms answer, though not in every activity, and it answers in far fewer windows. The newer algorithm is not simply better, and the sensor changes that shipped with it are not part of this comparison.`;
  const body = `
<p class="bt-banner" role="note"><span class="pp-lbl">Caveat, from the results file</span><span class="bt-bt">${esc(typo(hr.caveat))}</span></p>
<div class="bt-panels p8">
  ${panel('a', 'What each generation reports', `${fmtN(ge.n_windows)} windows of ${ge.window_s} s`, '<div class="bt-chart" data-bt="hrbars"></div>')}
  ${panel('b', 'How the error changes, B minus A', 'ECG is the reference', '<div class="bt-chart" data-bt="hrforest"></div>')}
</div>`;
  const caption = `<span class="pp-fn">Figure 8.</span> <b>Heart rate, algorithm layer only.</b> InfiniTime generation A (${esc(typo(gA?.label ?? ''))}) against generation B (${esc(typo(gB?.label ?? ''))}), replayed on ${esc(ge.dataset.split(' (')[0] ?? '')}: ${ge.n_recordings} recordings, ${ge.n_subjects} subjects, ${fmtN(ge.n_windows)} windows of ${ge.window_s} s, ECG R-peaks as truth. <i>(a)</i> B gives a value in ${pc(B.valid_fraction)} of windows against ${pc(A.valid_fraction)} for A, so its mean absolute error of ${B.mae_bpm.toFixed(1)} bpm against ${A.mae_bpm.toFixed(1)} is measured on fewer, and probably easier, windows. <i>(b)</i> On the ${diff.n_windows_both_valid} windows where both report, B’s absolute error is ${Math.abs(sb.estimate).toFixed(1)} bpm ${sb.estimate < 0 ? 'lower' : 'higher'} (subject-bootstrap 95% CI ${plain(sb.ci95[0])} to ${plain(sb.ci95[1])}, ${sb.n_units} subjects, ${fmtN(hr.provenance.bootstrap.resamples)} resamples)${signText}. The public PPG is rescaled to HRS3300-like counts under an assumption; across ${sigma.map((x) => `σ = ${x}`).join(', ')} counts, B’s share of windows with a value runs from ${pc(Math.min(...bShare))} to ${pc(Math.max(...bShare))}. The null control (${esc(gN?.first_tag ?? 'the last tag of A')} run again) gives identical output in all ${ge.null_control_A.windows} windows. ${cap(word(ge.n_subjects))} subjects is few: read the subject-level interval, not the window-level one.`;
  return { intro, body, cap: caption };
}

function wireCopy(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const text = btn.parentElement?.querySelector('code')?.textContent ?? '';
      const done = (ok: boolean): void => {
        btn.textContent = ok ? 'Copied' : 'Select and copy';
        window.setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
      };
      if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
      else done(false);
    });
  });
}

async function loadMemo(m: Model): Promise<void> {
  const bl = document.getElementById('memo-bl');
  if (!bl) return;
  try {
    const res = await fetch(`${baseUrl()}drift/memo.html`);
    if (!res.ok) throw new Error(String(res.status));
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const callout = doc.querySelector('.callout');
    const h1 = doc.querySelector('h1')?.textContent?.trim();
    const meta = doc.querySelector('.meta')?.textContent?.trim();
    const title = document.getElementById('memo-title');
    if (title && h1) title.innerHTML = nbDates(esc(h1));
    const ps = callout ? [...callout.querySelectorAll('p')] : [];
    if (!ps.length) throw new Error('no bottom line');
    const heading = ps[0] as HTMLElement;
    const rest = ps.slice(1);
    // the memo's own paragraphs, kept whole: how many algorithms, the verdict per boundary, the native disagreement
    const find = (re: RegExp): HTMLElement | undefined => rest.find((p) => re.test(p.textContent ?? ''));
    const shown = [find(/different step-counting algorithms/), find(/Verdict per adjacent boundary/), find(/disagree with Clemson/)].filter((p): p is HTMLElement => !!p);
    const more = rest.filter((p) => !shown.includes(p));
    // the memo is plain ASCII; on the page its negative numbers get the same real minus sign as the table beside them
    const para = (p: HTMLElement): string => `<p>${p.innerHTML.replace(/(^|[\s(\[;,])-(?=\d)/g, `$1${MINUS}`)}</p>`;
    bl.innerHTML = `<p class="bt-bl-h">${esc(heading.textContent ?? 'Bottom line')}</p>${shown.map(para).join('')}${more.length ? `<details class="bt-more"><summary>The rest of the bottom line</summary>${more.map(para).join('')}</details>` : ''}${meta ? `<p class="bt-dimp mono bt-meta">${esc(meta)}</p>` : ''}`;
  } catch {
    bl.innerHTML = `<p class="bt-dimp">The bottom line could not be loaded here. It is the first box of <a href="${esc(baseUrl())}drift/memo.html">the full memo</a>. In short: ${m.bounds.filter((b) => b.inWin).map((b) => `${esc(b.from.short)} → ${esc(b.to.short)} ${esc(b.label)}`).join('; ')}.</p>`;
  }
}

export function hydrateBuilt(c: BuiltCtx): void {
  const root = document.getElementById('built');
  const m = buildModel(c.d);
  if (!root || !m) return;

  // tooltips: any element with data-bt-tip inside the section
  const tip = tooltip();
  root.addEventListener('pointermove', (e) => {
    const t = (e.target as Element).closest?.('[data-bt-tip]');
    if (t && root.contains(t)) tip.show(t.getAttribute('data-bt-tip') ?? '', e.clientX, e.clientY);
    else tip.hide();
  });
  root.addEventListener('pointerleave', () => tip.hide());

  // Figure 5: the SVG timeline when it fits, the stacked list when it does not
  const tl = root.querySelector<HTMLElement>('[data-bt="timeline"]');
  const tlSvg = tl?.querySelector<HTMLElement>('.bt-tl-svg');
  if (tl && tlSvg) {
    mount(tl, (w) => {
      const wide = w >= WIDE;
      tl.dataset.mode = wide ? 'svg' : 'stack';
      return wide ? renderTimeline(w, m) : '';
    }, tlSvg);
  }

  const charts: Record<string, (w: number) => string> = {
    count: (w) => renderCount(w, m),
    shifts: (w) => renderShifts(w, m),
    phantom: (w) => renderPhantom(w, m),
  };
  root.querySelectorAll<HTMLElement>('.bt-chart[data-bt]').forEach((el) => {
    const f = charts[el.dataset.bt ?? ''];
    if (f) mount(el, f);
  });

  wireCopy(root);
  void loadMemo(m);

  const body = document.getElementById('fig8-body');
  if (body) {
    loadHR().then(
      (hr) => {
        const { intro, body: html, cap } = hrBody(hr);
        const introEl = document.getElementById('hr-intro');
        if (introEl) introEl.innerHTML = intro;
        body.innerHTML = html;
        const capEl = document.getElementById('fig8-cap');
        if (capEl) capEl.innerHTML = cap;
        body.querySelectorAll<HTMLElement>('.bt-chart[data-bt]').forEach((el) => {
          if (el.dataset.bt === 'hrbars') mount(el, (w) => renderHRBars(w, hr));
          if (el.dataset.bt === 'hrforest') mount(el, (w) => renderHRForest(w, hr));
        });
      },
      (err: unknown) => {
        body.innerHTML = `<p class="bt-load" role="status">The heart-rate results could not be loaded (${esc(err instanceof Error ? err.message : String(err))}). They are in <span class="mono">results/drift/infinitime_hr.json</span>.</p>`;
      },
    );
  }
}
