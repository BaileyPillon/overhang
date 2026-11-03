// The paper: #abstract, #steam, (counting), #replication, #built, #methods, #references.
// Direction C restyled to TARGET. Every number is read from the data files; the only literals are the
// ones noted in comments (prose structure, the Steam source's own figures parsed from its report text).
import './styles/paper.css';
import 'katex/dist/katex.min.css';
import type { AppData, DryRunGap, Hole, Point, ReplicationRow } from './data';
import { cellLabel, indexPoints } from './data';
import { esc, fmtE, fmtF, fmtN, fmtP, fmtPct, honesty, pill, tooltip } from './ui';

/* ================================================================== helpers */

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
/** 0..20 as words, everything else as digits. */
const word = (n: number): string => (Number.isInteger(n) && n >= 0 && n <= 20 ? (WORDS[n] as string) : fmtN(n));
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function monthYear(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** The number of reruns behind the dry-run stability fractions (k/9 for the current run): the smallest k that makes every value an integer count. */
function inferReruns(stab: number[]): number {
  for (let k = 2; k <= 30; k++) {
    if (stab.every((s) => Math.abs(s * k - Math.round(s * k)) < 0.002)) return k;
  }
  return 9; // data/DATA.md: "fraction of 9 re-runs"
}

function pairLabel(axes: [string, string]): string {
  const nice = (a: string) => (a === 'for' ? 'audience' : a);
  return `${nice(axes[0])} × ${nice(axes[1])}`;
}

/** Family of a source host, for the "where the reports came from" sidenote. */
function hostFamily(h: string): string {
  if (/(^|\.)(anthropic\.com|claude\.com|claude\.ai)$/.test(h)) return "Anthropic's own pages";
  if (/reddit/.test(h)) return /(^|\.)reddit\.com$/.test(h) ? 'Reddit' : 'Reddit (archived copies)';
  if (/github/.test(h)) return 'GitHub';
  if (/ycombinator|^hn\./.test(h)) return 'Hacker News';
  if (/youtube|youtu\.be/.test(h)) return 'YouTube';
  if (/(^|\.)dev\.to$/.test(h)) return 'dev.to';
  return 'other sites';
}

/** Settings of the dry run that dryrun.json does not carry (runs/dry/stability.json: match, pca, seeds). Noted literals. */
const DRY = { match: 0.8, pca: [16, 32, 64], seeds: 3 };
/** Bootstrap resamples behind hole stability (runs/r1/holes.json params.boot). Noted literal. */
const BOOT = 1000;

/* ================================================================== citations */

interface Ref {
  who: string;
  title: string;
  date: string | null;
  url: string;
  note?: string;
}

/* ================================================================== context */

interface Ctx {
  d: AppData;
  P: Map<string, Point>;
  byTitle: Map<string, Point>;
  S: ReturnType<typeof computeStats>;
  cite: (...keys: string[]) => string;
  citePoint: (id: string | undefined, note?: string) => string;
  citeTitle: (title: string | undefined) => string;
  refs: () => string;
  tex: (src: string, fallback: string) => string;
  eq: (src: string, fallback: string, label: string) => string;
  sn: (html: string) => string;
}

function computeStats(d: AppData) {
  const { meta, points, facets, holes, dryrun, replication } = d;
  const gaps = dryrun.gaps;
  const stab = gaps.map((g) => g.stability);
  const nn = gaps.map((g) => g.nn_cos);
  const reruns = inferReruns(stab);
  const tables = Object.entries(facets.tables);
  const cellsByTable = tables.map(([k, t]) => ({ key: k, cells: t.rows.length * t.cols.length, structural: t.structural.flat().filter(Boolean).length }));
  const prereg = holes.filter((h) => h.prereg);
  // first-pass values: what each registered hole looked like at registration, before any new report existed
  const regs = prereg.map((h) => ({
    h, E: h.registered?.E ?? h.E, Eind: h.registered?.E_indep ?? h.E_indep, p: h.registered?.p ?? h.p, stab: h.registered?.stability ?? h.stability,
    robust: h.registered?.tag_robust ?? h.tag_robust, knn: h.registered?.knn_pct ?? h.knn_pct,
  }));
  const hp = regs.map((r) => r.p ?? 1);
  const rows = replication.rows;
  const nVerdict = (v: string) => rows.filter((r) => r.verdict === v).length;
  const anchors = points.filter((p) => p.id.startsWith('anchors-'));
  const anchorUrls = new Set(anchors.map((p) => p.s));
  const pick = d.winner.status === 'pending' ? d.winner.pick : undefined;
  const fam = new Map<string, number>();
  for (const p of points) fam.set(hostFamily(host(p.s)), (fam.get(hostFamily(host(p.s))) ?? 0) + 1);
  const domainCount = new Map<string, number>();
  for (const p of points) domainCount.set(p.d, (domainCount.get(p.d) ?? 0) + 1);
  const topDomain = [...domainCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const kappa = meta.kappa.r1;
  const kVals = [kappa.move, kappa.material, kappa.for];
  const steamPt = points.find((p) => /steam/i.test(p.tx) && /\d[\d,]{4,}\s+steam games/i.test(p.tx));
  const steamMatch = steamPt ? /(\d[\d,]{4,})\s+Steam games/i.exec(steamPt.tx) : null;
  const steamSample = steamPt ? /samples\s+(\d[\d,]{3,})\s+points/i.exec(steamPt.tx) : null;
  return {
    N: meta.N,
    N0: meta.N_r1,
    nVideo: points.filter((p) => p.v).length,
    nSecond: points.filter((p) => p.c === 'secondhand').length,
    nSeen: points.filter((p) => p.c === 'seen').length,
    nDomains: domainCount.size,
    topDomain: topDomain ? { name: topDomain[0], n: topDomain[1] } : { name: '', n: 0 },
    nMove: facets.axes.move.length,
    nMat: facets.axes.material.length,
    nFor: facets.axes.for.length,
    cellsByTable,
    cells: cellsByTable.reduce((a, t) => a + t.cells, 0),
    holes,
    nHoles: holes.length,
    prereg,
    regs,
    nPrereg: prereg.length,
    nNew: meta.N - meta.N_r1,
    nPooledOnly: holes.length - prereg.length,
    nRefuted: nVerdict('refuted'),
    nUnder: nVerdict('underpowered'),
    nReplicated: nVerdict('replicated'),
    nAnchors: anchors.length,
    nAnchorUrls: anchorUrls.size,
    repoPublished: !!meta.repo_published,
    pick,
    pMin: Math.min(...hp),
    pMax: Math.max(...hp),
    nP05: regs.filter((r) => (r.p ?? 1) < 0.05).length,
    nQuasiLower: regs.filter((r) => r.E < r.Eind).length,
    nRobust: regs.filter((r) => r.robust).length,
    knnMin: Math.min(...regs.map((r) => r.knn ?? 0)),
    knnMax: Math.max(...regs.map((r) => r.knn ?? 0)),
    knnMed: median(regs.map((r) => r.knn ?? 0)),
    stabMed: median(regs.map((r) => r.stab ?? 0)),
    nStable50: regs.filter((r) => (r.stab ?? 0) >= 0.5).length,
    gaps,
    nGaps: gaps.length,
    nnLo: Math.min(...nn),
    nnHi: Math.max(...nn),
    nnMed: median(nn),
    cohLo: Math.min(...gaps.map((g) => g.coherence)),
    cohHi: Math.max(...gaps.map((g) => g.coherence)),
    pctLo: Math.min(...gaps.map((g) => g.pct)),
    pctHi: Math.max(...gaps.map((g) => g.pct)),
    chance: d.dryrun.chance,
    reruns,
    nFull: stab.filter((s) => s >= 0.9999).length,
    nZero: stab.filter((s) => s === 0).length,
    nLow: stab.filter((s) => s > 0 && s <= 2 / reruns + 1e-9).length,
    stabMean: mean(stab),
    stabMedGaps: median(stab),
    nAboveChance: stab.filter((s) => s > d.dryrun.chance).length,
    kappa,
    kappaGrow: meta.kappa.grow,
    kappaMin: Math.min(...kVals),
    kappaMax: Math.max(...kVals),
    fam: [...fam.entries()].sort((a, b) => b[1] - a[1]),
    pca: meta.pca,
    k: meta.k,
    status: replication.status,
    steamGames: steamMatch ? steamMatch[1] : null,
    steamSample: steamSample ? steamSample[1] : null,
    steamId: steamPt?.id,
    commitUrl: `${meta.repo_url}/commit/${meta.prereg_commit}`,
    dryN: d.dryrun.N,
  };
}

function makeCtx(d: AppData): Ctx {
  const P = indexPoints(d.points);
  const byTitle = new Map(d.points.map((p) => [p.t, p]));
  const S = computeStats(d);
  const order: string[] = [];
  const refMap = new Map<string, Ref>();

  const cite = (...keys: string[]): string => {
    const out: string[] = [];
    for (const k of keys) {
      if (!refMap.has(k)) continue;
      if (!order.includes(k)) order.push(k);
      const n = order.indexOf(k) + 1;
      out.push(`<a href="#ref-${n}" aria-label="Reference ${n}">${n}</a>`);
    }
    return out.length ? `<sup class="cite">${out.join('<span class="sep">,</span>')}</sup>` : '';
  };

  // the corpus video, from meta
  refMap.set('video', { who: d.meta.video.channel, title: d.meta.video.title, date: null, url: d.meta.video.url, note: `source of the ${S.nVideo} reports flagged as from the video (the corpus notes count 31 use cases in it; the other flags were not reconciled)` });

  const citePoint = (id: string | undefined, note?: string): string => {
    if (!id) return '';
    const p = P.get(id);
    if (!p) return '';
    if (!refMap.has(id)) refMap.set(id, { who: p.w ?? host(p.s), title: p.t, date: p.dt, url: p.s, note });
    return cite(id);
  };
  const citeTitle = (title: string | undefined): string => (title ? citePoint(byTitle.get(title)?.id) : '');

  const refs = (): string => {
    if (!order.length) return '';
    const items = order.map((k, i) => {
      const r = refMap.get(k) as Ref;
      const meta = [r.who, r.date].filter(Boolean).join(', ');
      return `<li id="ref-${i + 1}"><span class="pp-ref-meta">${esc(meta)}${meta ? '.' : ''}</span> <span class="pp-ref-title">${esc(r.title)}.</span> <a class="pp-ref-url" href="${esc(r.url)}" rel="noopener noreferrer" target="_blank">${esc(host(r.url))}</a>${r.note ? ` <span class="pp-ref-note">${esc(r.note)}.</span>` : ''}</li>`;
    });
    return `<ol class="pp-refs">${items.join('')}</ol>`;
  };

  const tex = (src: string, fallback: string): string => `<span class="tex" data-tex="${esc(src)}">${fallback}</span>`;
  let eqn = 0;
  const eq = (src: string, fallback: string, label: string): string => {
    eqn += 1;
    return `<div class="pp-eq" role="math" aria-label="${esc(label)}"><div class="tex" data-display="1" data-tex="${esc(src)}"><span class="pp-eq-plain">${fallback}</span></div><span class="pp-eq-n">(${eqn})</span></div>`;
  };
  const sn = (html: string): string => `<span class="sn"></span><span class="sn-body">${html}</span>`;

  return { d, P, byTitle, S, cite, citePoint, citeTitle, refs, tex, eq, sn };
}

/* ================================================================== #abstract */

function abstractHTML(c: Ctx): string {
  const { d, S, tex, sn } = c;
  const fam = S.fam.filter(([n]) => n !== 'other sites').slice(0, 5).map(([n, k]) => `${esc(n)} ${fmtN(k)}`).join(' · ');
  const nRows = d.replication.rows.length;
  const tested =
    S.status === 'done' && nRows
      ? `We pre-registered them, then tested them on ${fmtN(S.nNew)} new reports tagged blind to the hypotheses (Figure 4). Under the registered rule, ${word(S.nReplicated)} of ${word(nRows)} replicated: ${word(S.nRefuted)} were refuted by a new report landing in the cell and ${word(S.nUnder)} are underpowered.`
      : `We pre-registered them, and test them on new reports tagged blind to the hypotheses. The test is under way.`;
  const pickLine = S.pick
    ? `No hole has passed all three gates, so the one we are building from, <span class="nowrap">${esc(S.pick.code)}</span>, is an exception chosen after the result and reported as one.`
    : `Holes that replicate go to a prior-art search, and at most one is built.`;
  return `
<p class="eyebrow pp-eyebrow">Research note</p>
<h2 class="pp-title">Holes in the Space of Claude Use Cases</h2>
<p class="pp-byline"><b>Overhang</b><span>${esc(monthYear(d.meta.generated))}</span><span class="mono">${fmtN(S.N)} sourced reports (${fmtN(S.N0)} + ${fmtN(S.nNew)} new) · ${word(d.meta.models.length)} embedding models</span></p>
<div class="pp-tbcol">
  <div class="glance pp-glance" aria-label="Key numbers">
    <div class="pp-stat"><span class="n">${fmtN(S.N)}</span><span class="l"><b>reports</b>: ${fmtN(S.N0)} at the start and ${fmtN(S.nNew)} gathered after the holes were registered; ${fmtN(S.nVideo)} are flagged as from one video</span></div>
    <div class="pp-stat"><span class="n">${fmtN(S.nPrereg)}</span><span class="l"><b>holes</b> registered at ${fmtN(S.N0)} reports: empty cells whose expected count is at least 1, across ${fmtN(S.cells)} cells in three tables</span></div>
    <div class="pp-stat"><span class="n acc">${S.nReplicated}/${S.nPrereg}</span><span class="l"><b>replicated</b> under the pre-registered rule (${S.nRefuted} refuted, ${S.nUnder} underpowered)</span></div>
    <div class="pp-stat"><span class="n">${fmtF(S.kappaMin, 2)}</span><span class="l"><b>Cohen&rsquo;s &kappa;</b>, the lowest of three tag agreements between two blind taggers</span></div>
  </div>
  <div class="pp-abstract">
    <p class="pp-lbl">Abstract</p>
    <p>We collected ${fmtN(S.N0)} sourced reports of things people have done with Claude and asked what is missing. The obvious method, borrowed from an analysis of ${esc(S.steamGames ?? 'a very large number of')} Steam games, samples points between reports in embedding space and keeps the emptiest. At this scale it finds artifacts: all ${word(S.nGaps)} top gaps sit ${fmtF(S.nnLo, 2)} to ${fmtF(S.nnHi, 2)} cosine from an existing report, and only ${word(S.nFull)} of them ${S.nFull === 1 ? 'reappears' : 'reappear'} in all ${word(S.reruns)} reruns.
    So we tag each report by what Claude does (${S.nMove} moves), what it acts on (${S.nMat} materials) and who it is for (${S.nFor} audiences), and look at the tables instead. A <em>hole</em> is a cell whose expected count ${tex('E', '<i>E</i>')} is high under quasi-independence and whose observed count is zero, scored by ${tex('e^{-E}', 'e<sup>&minus;E</sup>')}. The first pass found ${fmtN(S.nPrereg)}.${sn(`Where the ${fmtN(S.N)} reports came from, by host: ${fam}, and a long tail of blogs and forums. ${fmtN(S.nSecond)} are known only through a roundup or article and carry that flag. ${fmtN(S.nAnchors)} are not individual reports at all: they are representative tasks written from ${word(S.nAnchorUrls)} of Anthropic&rsquo;s usage reports, and are flagged as such wherever one is shown.`)}
    Because we picked them from the same sample we are testing, they are hypotheses. ${tested} ${pickLine}</p>
  </div>
</div>`;
}

/* ================================================================== #steam (Figure 2) */

function figure2HTML(c: Ctx): string {
  const { S } = c;
  return `
<figure class="figure pp-f2" id="fig2">
  <div class="pp-f2-head"><span class="fig-label">Figure 3</span><span class="pp-f2-read" id="f2-read" aria-live="polite">Hover or focus a dot or a bar. Across all ${word(S.nGaps)} gaps the nearest report is at cosine ${fmtF(S.nnLo, 3)} to ${fmtF(S.nnHi, 3)}; ${word(S.nFull)} gap${S.nFull === 1 ? '' : 's'} was found again in every rerun.</span></div>
  <div class="pp-f2-grid">
    <div class="pp-f2-p" id="f2a">${panelA(c)}</div>
    <div class="pp-f2-p" id="f2b">${panelB(c)}</div>
  </div>
  <figcaption><span class="pp-fn">Figure 3.</span> <b>Why the Steam method fails at <i>n</i> = ${fmtN(S.dryN)}.</b> (a) A blend is the mean of reports, so it lands beside them: the diagram is a schematic, but the strip below it is measured, one dot per gap, the cosine from the gap to its nearest report. (b) Stability of each of the ${word(S.nGaps)} gaps across ${word(S.reruns)} reruns, against the ${fmtF(S.chance, 3)} that a random direction achieves. Only one bar reaches the top, and ${word(S.nZero)} gaps were never found again.</figcaption>
</figure>`;
}

function panelA(c: Ctx): string {
  const { S } = c;
  const W = 520;
  const lo = Math.min(0.8, Math.floor(S.nnLo * 20) / 20);
  const hi = 1;
  const xl = 28;
  const xr = W - 24;
  const X = (v: number) => xl + ((v - lo) / (hi - lo)) * (xr - xl);

  // schematic: two reports with a blend placed beside the nearer one; spacing from the median nearest cosine
  const ay = 96;
  const ax = 74;
  const qx = W - 74;
  const near = Math.max(0.08, Math.min(0.4, (1 - S.nnMed) * 2.6)); // fraction of the A-B span (picture only)
  const bx = ax + near * (qx - ax);

  // strip: stack dots in 0.0125-wide bins
  const sy = 262;
  const r = 5.5;
  const bins = new Map<number, number>();
  const dots = S.gaps.map((g) => {
    const key = Math.round(g.nn_cos / 0.008);
    const k = bins.get(key) ?? 0;
    bins.set(key, k + 1);
    return { g, x: X(g.nn_cos), y: sy - r - 1 - k * (2 * r + 1) };
  });
  const ticks: number[] = [];
  for (let v = Math.ceil(lo * 20) / 20; v <= hi + 1e-9; v += 0.05) ticks.push(Math.round(v * 100) / 100);

  return `
<p class="pp-ph">(a) A blend beside its own parent ${honesty('illustrative', 'The diagram is a schematic. The strip below it is measured from the dry run.')}</p>
<svg viewBox="0 0 ${W} 330" role="img" aria-label="Schematic of a blend lying close to one of the two reports it was made from, and a strip showing the measured cosine from each of ${S.nGaps} gaps to its nearest report, from ${fmtF(S.nnLo, 2)} to ${fmtF(S.nnHi, 2)}.">
  <line class="pp-conn" x1="${ax}" y1="${ay}" x2="${qx}" y2="${ay}"/>
  <circle class="pp-par" cx="${ax}" cy="${ay}" r="9"/>
  <circle class="pp-par o" cx="${qx}" cy="${ay}" r="9"/>
  <path class="pp-blend" d="M${bx} ${ay - 10} L${bx + 10} ${ay} L${bx} ${ay + 10} L${bx - 10} ${ay} Z"/>
  <text class="pp-t" x="${ax}" y="${ay - 22}" text-anchor="middle">report</text>
  <text class="pp-t" x="${qx}" y="${ay - 22}" text-anchor="middle">another report</text>
  <text class="pp-t pp-tk" x="${bx}" y="${ay - 22}" text-anchor="middle">blend</text>
  <path class="pp-brk" d="M${ax} ${ay + 20} v6 H${bx - 2} v-6"/>
  <text class="pp-t pp-tm" x="${(ax + bx) / 2}" y="${ay + 42}" text-anchor="middle">cos ${fmtF(S.nnLo, 2)} to ${fmtF(S.nnHi, 2)}</text>
  <path class="pp-brk dim" d="M${bx + 4} ${ay + 20} v6 H${qx} v-6"/>
  <text class="pp-t pp-tm" x="${(bx + qx) / 2 + 2}" y="${ay + 42}" text-anchor="middle">farther: the other report</text>

  <text class="pp-t pp-th" x="${xl}" y="196">Measured: nearest report to each gap</text>
  <rect class="pp-range" x="${X(S.nnLo) - 7}" y="${sy - 46}" width="${X(S.nnHi) - X(S.nnLo) + 14}" height="${52}" rx="3"/>
  <line class="pp-axis" x1="${xl}" y1="${sy + 6}" x2="${xr}" y2="${sy + 6}"/>
  ${ticks.map((v) => `<line class="pp-axis" x1="${X(v)}" y1="${sy + 6}" x2="${X(v)}" y2="${sy + 10}"/><text class="pp-t pp-tm" x="${X(v)}" y="${sy + 24}" text-anchor="middle">${v.toFixed(2)}</text>`).join('')}
  <line class="pp-guide" x1="${X(1)}" y1="${sy - 52}" x2="${X(1)}" y2="${sy + 6}"/>
  <text class="pp-t pp-tm" x="${X(1)}" y="${sy - 58}" text-anchor="end">1.00 = the same report</text>
  ${dots.map((o) => `<circle class="pp-dot" tabindex="0" data-rank="${o.g.rank}" cx="${o.x.toFixed(1)}" cy="${o.y.toFixed(1)}" r="${r}" role="img" aria-label="Gap ${o.g.rank}: nearest report at cosine ${fmtF(o.g.nn_cos, 3)}"/>`).join('')}
  <text class="pp-t pp-tm" x="${xl}" y="${sy + 46}">cosine between the gap and its nearest report, ${S.nGaps} gaps</text>
</svg>`;
}

function panelB(c: Ctx): string {
  const { S } = c;
  const W = 520;
  const H = 330;
  const xl = 40;
  const xr = W - 16;
  const yt = 40;
  const yb = 270;
  const n = S.gaps.length;
  const bw = (xr - xl) / n;
  const Y = (v: number) => yb - v * (yb - yt);
  const gridVals = [0, 0.25, 0.5, 0.75, 1];
  const bars = S.gaps
    .map((g, i) => {
      const x = xl + i * bw + bw * 0.16;
      const w = bw * 0.68;
      const k = Math.round(g.stability * S.reruns);
      const label = `${k}/${S.reruns}`;
      const body =
        g.stability > 0
          ? `<rect class="pp-bar${g.stability >= 0.9999 ? ' full' : ''}" x="${x.toFixed(1)}" y="${Y(g.stability).toFixed(1)}" width="${w.toFixed(1)}" height="${(yb - Y(g.stability)).toFixed(1)}" rx="1"/>`
          : `<rect class="pp-bar zero" x="${x.toFixed(1)}" y="${yb - 3}" width="${w.toFixed(1)}" height="3" rx="1"/>`;
      return `<g class="pp-bar-g" tabindex="0" data-rank="${g.rank}" role="img" aria-label="Gap ${g.rank}: found again in ${k} of ${S.reruns} reruns">
        <rect class="pp-hit" x="${(xl + i * bw).toFixed(1)}" y="${yt - 14}" width="${bw.toFixed(1)}" height="${yb - yt + 28}"/>
        ${body}
        <text class="pp-t pp-tm pp-bl" x="${(x + w / 2).toFixed(1)}" y="${(g.stability > 0 ? Y(g.stability) - 4 : yb - 12).toFixed(1)}" text-anchor="middle">${label}</text>
        <text class="pp-t pp-tm" x="${(x + w / 2).toFixed(1)}" y="${yb + 15}" text-anchor="middle">${String(g.rank).padStart(2, '0')}</text>
      </g>`;
    })
    .join('');
  return `
<p class="pp-ph">(b) Are the ${S.nGaps} gaps found again? Stability across ${S.reruns} reruns</p>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart of stability for ${S.nGaps} dry-run gaps against a chance line at ${fmtF(S.chance, 3)}. ${S.nFull} gap reaches ${S.reruns} of ${S.reruns}; ${S.nZero} are never found again.">
  ${gridVals.map((v) => `<line class="pp-grid" x1="${xl}" y1="${Y(v)}" x2="${xr}" y2="${Y(v)}"/><text class="pp-t pp-tm" x="${xl - 7}" y="${Y(v) + 3.5}" text-anchor="end">${v === 0 ? '0' : fmtPct(v)}</text>`).join('')}
  <line class="pp-axis" x1="${xl}" y1="${yb}" x2="${xr}" y2="${yb}"/>
  ${bars}
  <line class="pp-chance" x1="${xl}" y1="${Y(S.chance)}" x2="${xr}" y2="${Y(S.chance)}"/>
  <line class="pp-chance" x1="${xr - 112}" y1="${yt - 25}" x2="${xr - 90}" y2="${yt - 25}"/>
  <text class="pp-t pp-tm pp-tchance" x="${xr - 84}" y="${yt - 22}" text-anchor="start">chance ${fmtF(S.chance, 3)}</text>
  <text class="pp-t pp-tm" x="${xl}" y="${yb + 36}">gap rank, from the most isolated blend (01) down</text>
  <text class="pp-t pp-tm" x="${xl - 7}" y="${yt - 22}" text-anchor="start">share of reruns that found it again</text>
</svg>`;
}

function steamHTML(c: Ctx): string {
  const { d, S, cite, citePoint, citeTitle, sn } = c;
  const g = (rank: number): DryRunGap | undefined => S.gaps.find((x) => x.rank === rank);
  const g1 = g(1);
  // a stable gap other than the best-scoring one: the example that being stable is not the same as being a real gap
  const gs = S.gaps.filter((x) => x.rank !== 1).sort((a, b) => b.stability - a.stability || a.rank - b.rank)[0];
  const fullPart = S.nFull === 0 ? 'No gap came back in every rerun' : `Only ${word(S.nFull)} of the ${word(S.nGaps)} gaps came back in every rerun`;
  const stabLine = `${fullPart}, ${word(S.nZero)} never did, and ${word(S.nLow)} more came back once or twice.`;
  const steamCite = citePoint(S.steamId, 'as described in the video') + cite('video');
  const games = S.steamGames ?? 'all the';
  const sample = S.steamSample;
  const quote = (t: string | undefined) => (t ? `&ldquo;${esc(t)}&rdquo;` : '');
  return `
<p class="eyebrow pp-eyebrow">The first method</p>
<h2>The Steam method, and why it fails at <span class="nowrap"><i>n</i> = ${fmtN(S.dryN)}</span></h2>
<p>The idea that started this project is clever and cheap. Someone embedded ${esc(games)} Steam games${sample ? `, sampled ${esc(sample)} points between them` : ', sampled points between them'}, scored each point by its distance to the nearest real game, and kept the emptiest.${steamCite} With that many games the space is dense, so a point that lands far from every game really is somewhere no game is.</p>
<p>We ran the same recipe on our first ${fmtN(S.dryN)} reports, in the ${S.pca}-dimensional PCA of their embeddings. Blends of reports go through a coherence filter, and the ${word(S.nGaps)} emptiest survivors are the &ldquo;gaps&rdquo; below.${sn(`Cosine similarity is 1 when two vectors point the same way and falls toward 0 as they diverge. A blend at cosine 1 would be an existing report. The coherence scores of the ${word(S.nGaps)} gaps run from ${fmtF(S.cohLo, 2)} to ${fmtF(S.cohHi, 2)}, and their novelty percentiles from ${fmtF(S.pctLo, 1)} to ${fmtF(S.pctHi, 1)}. By the method&rsquo;s own scores they all look good.`)} Figure 3 is what came out. It is not a result. It is a diagnosis.</p>
${figure2HTML(c)}
<p>Panel (a) is the reason. A blend is a weighted mean of a few reports, and in a corpus this small there is nothing else around it. Every one of the ${word(S.nGaps)} gaps lies ${fmtF(S.nnLo, 2)} to ${fmtF(S.nnHi, 2)} cosine from its nearest report, with a median of ${fmtF(S.nnMed, 2)}. The map calls them empty because each is a smear between two things that exist, not because anything is missing from it.${g1 ? ` Gap 01, the best-scoring one, is built from ${quote(g1.parents[0])}${citeTitle(g1.parents[0])} and ${quote(g1.parents[1])}${citeTitle(g1.parents[1])}.` : ''}</p>
<p>Panel (b) asks whether the method at least agrees with itself. A random direction is matched by a rerun ${fmtPct(S.chance, 1)} of the time. ${stabLine} Most gaps do beat chance, ${S.nAboveChance} of ${S.nGaps}, but the median gap is found again in only ${fmtPct(S.stabMedGaps)} of reruns.${sn(`Mean stability is ${fmtF(S.stabMean, 2)}; the median is ${fmtF(S.stabMedGaps, 2)}. Chance is the rate at which random coherent blends are matched by a rerun. A rerun matches a gap when the two vectors, compared in the full embedding space, have cosine ${fmtF(DRY.match, 1)} or more. The ${word(S.reruns)} reruns use PCA to ${DRY.pca.slice(0, -1).join(', ')} and ${DRY.pca[DRY.pca.length - 1]} dimensions, ${word(DRY.seeds)} seeds each.`)} That is not an encouraging number for a method whose output is meant to be a list of things to build.</p>
<p>Stability cannot rescue the method either, because it measures the wrong thing. A blend of two particular reports is found again whenever those two reports are sampled, so a stable gap is a gap the procedure can reproduce, not a gap in the world. ${gs ? `Gap ${String(gs.rank).padStart(2, '0')} was found again in ${Math.round(gs.stability * S.reruns)} of ${S.reruns} reruns, and it is a blend of ${quote(gs.parents[0])}${citeTitle(gs.parents[0])} and ${quote(gs.parents[1])}${citeTitle(gs.parents[1])}. ` : ''}A reader can see at a glance that nobody needs a thing that is half of each.</p>
<p>The Steam method needs a dense space, and ${fmtN(S.dryN)} reports collected by hand will not become one. So we changed the question. Not <em>where in the space is nothing</em>, but <em>which combinations of things has nobody reported?</em></p>`;
}

/* ================================================================== counting (methods narrative, Table 1) */

function holesTableHTML(c: Ctx): string {
  const { S } = c;
  const rows = [...S.regs]
    .sort((a, b) => a.h.code.localeCompare(b.h.code))
    .map(
      (r) => `<tr>
<td class="code">${esc(r.h.code)}</td>
<td>${esc(pairLabel(r.h.axes))}</td>
<td class="pp-cell">${esc(r.h.cell[r.h.axes[0]] ?? '')} <span class="pp-x">×</span> ${esc(r.h.cell[r.h.axes[1]] ?? '')}</td>
<td class="num">${fmtE(r.E)}</td>
<td class="num">${fmtE(r.Eind)}</td>
<td class="num">${fmtP(r.p)}</td>
<td class="num">${fmtF(r.stab, 2)}</td>
<td class="pp-yn">${r.robust ? '<span class="pp-yes" title="still a hole under the second tagger">yes</span>' : '<span class="pp-no" title="filled under the second tagger">no</span>'}</td>
<td class="num">${fmtF(r.knn, 1)}</td>
</tr>`,
    )
    .join('');
  const big = S.regs.filter((r) => r.E >= 2).length;
  return `
<figure class="figure pp-tbl" id="tab1">
  <div class="scroll-x"><table class="pp-holes">
    <thead><tr><th scope="col">Code</th><th scope="col">Table</th><th scope="col">Cell (row × column)</th><th scope="col" class="num">Ẽ</th><th scope="col" class="num">E plain</th><th scope="col" class="num nc">p = e<sup>−Ẽ</sup></th><th scope="col" class="num">Bootstrap<small>still a hole</small></th><th scope="col">Second tagger<small>still empty</small></th><th scope="col" class="num">Novelty<small>kNN pctile</small></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <figcaption><span class="pp-fn">Table 1.</span> <b>The ${fmtN(S.nPrereg)} registered holes, ranked as in the catalog.</b> Real values from the first pass over ${fmtN(S.N0)} reports, as registered; the pooled values after the new sample are in Figure 4. The codes (OV-NN) are permanent: the globe, the matrix and this table use the same ones. Ẽ is the quasi-independence expectation, <em>E plain</em> the plain one. Cells have no <em>q</em> here, because the first pass predates the correction. ${cap(word(big))} holes have Ẽ of 2 or more; OV-10 is 1.998, just under.</figcaption>
</figure>`;
}

function countingHTML(c: Ctx): string {
  const { d, S, tex, eq, sn, cite } = c;
  const ax = d.facets.axes;
  const ex = (a: 'move' | 'material' | 'for', i: number) => `<em>${esc(ax[a][i]?.value ?? '')}</em>`;
  const tbl = S.cellsByTable;
  const structTotal = tbl.reduce((a, t) => a + t.structural, 0);
  const lowerShare = S.nQuasiLower / Math.max(1, S.nPrereg);
  const kap = S.kappa;
  const kapGrow = S.kappaGrow ? ` On the ${fmtN(S.nNew)} newly sampled reports it is ${fmtF(S.kappaGrow.move, 3)}, ${fmtF(S.kappaGrow.material, 3)} and ${fmtF(S.kappaGrow.for, 3)}.` : '';
  return `
<p class="eyebrow pp-eyebrow">The method that replaces it</p>
<h2>Counting what is missing</h2>
<p>Give every report three tags. The <em>move</em> is what Claude does: one of ${S.nMove} values, such as ${ex('move', 0)}, ${ex('move', 1)} or ${ex('move', 8)}. The <em>material</em> is what it acts on: one of ${S.nMat}, such as ${ex('material', 5)}, ${ex('material', 9)} or ${ex('material', 19)}. The <em>audience</em> is who it is for: one of ${S.nFor}, such as ${ex('for', 1)} or ${ex('for', 5)}. Pair the tags and you get three tables: ${tbl.map((t) => `${esc(t.key.replace('for', 'audience'))} (${fmtN(t.cells)} cells)`).join(', ')}. Each has the same ${fmtN(S.N0)} reports to spread over its cells in the first pass.${sn('Every definition is in the catalog and in the matrix&rsquo;s detail panel. The tags are coarse on purpose: a coarse grid is something we can count, and every cell we report can be checked by hand against the reports behind it.')}</p>
<p>A cell&rsquo;s row holds ${tex('n_i', '<i>n<sub>i</sub></i>')} reports and its column holds ${tex('n_j', '<i>n<sub>j</sub></i>')}. If moves and materials were unrelated, the number of reports expected in the cell would be</p>
${eq(String.raw`E_{ij} \;=\; \frac{n_i \, n_j}{N}`, 'E<sub>ij</sub> = n<sub>i</sub> n<sub>j</sub> / N', 'E sub i j equals n sub i times n sub j over N')}
<p>with ${tex(`N = ${S.N0}`, `<i>N</i> = ${fmtN(S.N0)}`)}. A cell with a large ${tex('E', '<i>E</i>')} that is nevertheless empty is conspicuous: both its row and its column are common, and nobody has combined them.</p>
<p>Plain independence is too crude, though, because some pairings are populated by design. A report that reverse-engineers a game ROM is, by definition, about a compiled binary. Those cells soak up reports and make the rest of their row and column look emptier than they are. So we first flag a cell as <em>structural</em> when its Pearson residual exceeds 3,</p>
${eq(String.raw`r_{ij} \;=\; \frac{O_{ij} - E_{ij}}{\sqrt{E_{ij}}} \;>\; 3 \quad\Longrightarrow\quad (i,j) \in S`, 'r<sub>ij</sub> = (O<sub>ij</sub> − E<sub>ij</sub>) / √E<sub>ij</sub> &gt; 3 ⇒ (i,j) ∈ S', 'Pearson residual greater than three marks a cell as structural')}
<p>where ${tex('O_{ij}', '<i>O<sub>ij</sub></i>')} is the observed count. The first round takes its residuals from plain independence. The flagging is then repeated, up to five rounds, with the residuals taken from a reference fit that leaves out the structural cells already found and the empty cells with a residual below −3 (the holes themselves), so a cell that only looks over-full beside an empty one is not flagged. In the final, pooled tables that flags ${fmtN(structTotal)} cells in all (${tbl.map((t) => fmtN(t.structural)).join(', ')} in the three tables). We then refit each table by iterative proportional fitting, scaling rows and columns in turn until the fitted totals over the non-structural cells match the observed ones:</p>
${eq(String.raw`\tilde E_{ij} \;=\; a_i \, b_j \qquad (i,j) \notin S`, 'Ẽ<sub>ij</sub> = a<sub>i</sub> b<sub>j</sub> for (i,j) not in S', 'Quasi-independence: E tilde i j equals a sub i times b sub j outside the structural set')}
<p>This is the <em>quasi-independence</em> expectation ${tex(String.raw`\tilde E`, 'Ẽ')}. It asks the right question: given that some cells are linked by design, how many reports should land in this one? Compared with plain independence it is lower for ${S.nQuasiLower} of the ${S.nPrereg} registered holes${lowerShare >= 0.5 ? ', so the refit mostly removes false holes rather than adding them' : ''}. A hole is an empty cell with ${tex(String.raw`\tilde E \ge 1`, 'Ẽ ≥ 1')}.</p>
<p>To say how conspicuous a hole is, treat the count in a cell as Poisson with mean ${tex(String.raw`\tilde E`, 'Ẽ')}. The probability of seeing at most ${tex('O', '<i>O</i>')} reports is</p>
${eq(String.raw`p \;=\; \Pr\!\left(X \le O \mid X \sim \mathrm{Poisson}(\tilde E)\right) \;=\; \sum_{k=0}^{O} \frac{e^{-\tilde E}\,\tilde E^{\,k}}{k!}`, 'p = P(X ≤ O | X ~ Poisson(Ẽ)) = Σ e<sup>−Ẽ</sup> Ẽ<sup>k</sup> / k!', 'p is the Poisson cumulative probability of seeing at most O')}
<p>For a hole ${tex('O = 0', '<i>O</i> = 0')} and the sum collapses to a single term,</p>
${eq(String.raw`p \;=\; e^{-\tilde E}`, 'p = e<sup>−Ẽ</sup>', 'p equals e to the minus E tilde')}
<p>so a cell expected to hold three reports and holding none has ${tex(String.raw`p = e^{-3} \approx 0.05`, 'p = e<sup>−3</sup> ≈ 0.05')}.</p>
<p>That arithmetic is also a warning. The ${fmtN(S.cells)} cells give us many chances to see a surprising zero, so some will clear 0.05 by luck. We correct for it with the Benjamini–Hochberg procedure: sort the ${tex('m', '<i>m</i>')} p-values of the empty cells of one table (${tex('m', '<i>m</i>')} counts the empty cells of that pair of tags, not all its cells) and set</p>
${eq(String.raw`q_{(k)} \;=\; \min_{j \ge k} \; \frac{m}{j}\, p_{(j)}`, 'q<sub>(k)</sub> = min over j ≥ k of (m / j) p<sub>(j)</sub>', 'Benjamini-Hochberg adjusted q-value')}
<p>so that <em>q</em> is the share of false discoveries we accept if we call every cell up to that rank a hole. At ${tex(`n = ${S.N0}`, `<i>n</i> = ${fmtN(S.N0)}`)} this settles little. Among the ${S.nPrereg} registered holes the smallest <em>p</em> is ${fmtP(S.pMin)} and only ${word(S.nP05)} falls under 0.05 before any correction, so <em>p</em> ranks the cells and does not certify them. The holes are hypotheses, not findings. That is what the pre-registration below is for.</p>
<p>Each hole also faces three checks of its own. <strong>Bootstrap stability</strong> resamples the ${fmtN(S.N0)} reports with replacement ${tex('B', '<i>B</i>')} times (${fmtN(BOOT)} in our run), recounts the table, and records how often the cell is still a hole, which means empty with an expected count of at least 1:</p>
${eq(String.raw`s_{ij} \;=\; \frac{1}{B}\sum_{b=1}^{B} \mathbf{1}\!\left[\,O^{*b}_{ij} = 0 \ \text{and}\ \tilde E^{*b}_{ij} \ge 1\,\right]`, 's<sub>ij</sub> = (1/B) Σ 1[O* = 0 and Ẽ* ≥ 1]', 'Bootstrap stability is the share of resamples in which the cell is still a hole')}
<p>The median registered hole is still a hole in ${fmtPct(S.stabMed)} of resamples; ${word(S.nStable50)} of ${S.nPrereg} ${S.nStable50 === 1 ? 'is' : 'are'} in more than half of them. <strong>A second tagger</strong>, blind to the first one&rsquo;s labels, tags every report again, and a hole is <em>tag-robust</em> if it is still empty under both: ${S.nRobust} of ${S.nPrereg} are. <strong>Embedding novelty</strong> asks whether the hole direction is also unusual in embedding space, ranked among all reports by distance to the ${S.k} nearest neighbours. The percentile runs from ${fmtF(S.knnMin, 1)} to ${fmtF(S.knnMax, 1)} with a median of ${fmtF(S.knnMed, 1)}, so most of the holes are not far from anything in embedding space, and the two ways of seeing a hole disagree. We report the disagreement instead of averaging it away.</p>
<p>The taggers agree with each other as Cohen&rsquo;s <em>&kappa;</em> measures it, the agreement beyond what chance alone would give:</p>
${eq(String.raw`\kappa \;=\; \frac{p_o - p_e}{1 - p_e}`, 'κ = (p<sub>o</sub> − p<sub>e</sub>) / (1 − p<sub>e</sub>)', 'Cohen kappa equals observed agreement minus chance agreement over one minus chance agreement')}
<p>where ${tex('p_o', '<i>p<sub>o</sub></i>')} is the share of reports the two taggers label identically and ${tex('p_e', '<i>p<sub>e</sub></i>')} the share they would match by chance given how often each uses each label. On the first ${fmtN(S.N0)} reports ${tex(String.raw`\kappa`, 'κ')} is ${fmtF(S.kappa.move, 3)} for move, ${fmtF(S.kappa.material, 3)} for material and ${fmtF(S.kappa.for, 3)} for audience.${kapGrow}${sn('The pre-registration file rounds the audience value to 0.879; recomputed from the tag file it is 0.8785, shown here as 0.878. Two taggers can agree and still both be wrong in the same way. Agreement here shows the labels are repeatable, not that the vocabulary is the right one.')}</p>
${holesTableHTML(c)}`;
}

/* ================================================================== #replication (Figure 4) */

interface F4Row {
  code: string;
  label: string;
  axes: string;
  eReg: number;
  eNew: number | null;
  oNew: number | null;
  verdict: string;
  q: number | null;
  stability: number | null;
}

function f4Rows(c: Ctx): F4Row[] {
  const { d, S } = c;
  const rep = d.replication;
  const byCode = new Map(S.holes.map((h) => [h.code, h]));
  if (rep.status === 'done' && rep.rows.length) {
    return [...rep.rows]
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((r: ReplicationRow) => {
        const h = byCode.get(r.code);
        return { code: r.code, label: r.cell_label, axes: pairLabel(r.axes), eReg: r.E_prereg, eNew: r.E_new, oNew: r.observed_new, verdict: r.verdict, q: r.q_pooled, stability: r.stability ?? h?.stability ?? null };
      });
  }
  return S.prereg
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((h: Hole) => ({ code: h.code, label: cellLabel(h), axes: pairLabel(h.axes), eReg: h.E, eNew: null, oNew: null, verdict: 'pending', q: null, stability: null }));
}

function figure4HTML(c: Ctx): string {
  const { d, S } = c;
  const rows = f4Rows(c);
  const done = d.replication.status === 'done' && d.replication.rows.length > 0;
  const maxV = Math.max(1, ...rows.map((r) => Math.max(done ? (r.eNew ?? 0) : r.eReg, r.oNew ?? 0)));
  const top = Math.ceil(maxV * 1.08);
  const pct = (v: number) => `${((v / top) * 100).toFixed(2)}%`;
  const tickEvery = top > 12 ? 5 : top > 6 ? 2 : 1;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += tickEvery) ticks.push(v);
  const tickEls = ticks.map((v) => `<span class="pp-tick" style="left:${pct(v)}">${v}</span>`).join('');
  const gridEls = ticks.map((v) => `<i class="pp-gl" style="left:${pct(v)}"></i>`).join('');
  const body = rows
    .map((r) => {
      const dotKind = !done ? 'ghost' : normalize(r.verdict);
      const barV = done ? (r.eNew ?? 0) : r.eReg;
      const dot = done && r.oNew != null ? `<b class="pp-dotm ${dotKind}" style="left:${pct(r.oNew)}" title="observed in new data: ${r.oNew}"></b>` : `<b class="pp-dotm ghost" style="left:0" title="the hole predicts 0 in new data"></b>`;
      const tip = done
        ? `<b>${esc(r.code)}</b> ${esc(r.label)}<br><span class="mono">E new ${fmtE(r.eNew)} · observed ${r.oNew ?? '–'} · E registered ${fmtE(r.eReg)}</span>`
        : `<b>${esc(r.code)}</b> ${esc(r.label)}<br><span class="mono">E at registration ${fmtE(r.eReg)} · new data: awaiting</span>`;
      return `<div class="pp-f4-row${done ? '' : ' pending'}" role="row" data-tip="${esc(tip)}">
  <span class="code" role="cell">${esc(r.code)}</span>
  <span class="pp-f4-cell" role="cell"><span>${esc(r.label)}</span><small>${esc(r.axes)}</small></span>
  <span class="pp-f4-track" role="cell">${gridEls}<i class="pp-bar4${done ? '' : ' hatch'}" style="width:${pct(barV)}"></i>${dot}</span>
  <span class="pp-f4-v" role="cell">${pill(r.verdict)}</span>
  <span class="num pp-f4-q" role="cell">${r.q == null ? '<span class="pp-dash" title="not computed until the pooled run">–</span>' : fmtP(r.q)}</span>
</div>`;
    })
    .join('');
  const banner = done
    ? ''
    : `<div class="pp-f4-banner">${pill('pending')}<span><b>Awaiting new data.</b> The hatched bars are the expected counts registered before any new report was read. The hollow dot at zero is what each hole predicts. Nothing here has been tested yet.</span></div>`;
  const legend = done
    ? `<span class="pp-lg"><i class="pp-bar4 sw"></i>expected new count, <em>E</em></span><span class="pp-lg"><b class="pp-dotm sw replicated"></b>observed new count</span>`
    : `<span class="pp-lg"><i class="pp-bar4 hatch sw"></i>E when registered (${fmtN(S.N0)} reports)</span><span class="pp-lg"><b class="pp-dotm ghost sw"></b>the prediction: 0 in new data</span>`;
  return `
<figure class="figure pp-f4" id="fig4">
  ${banner}
  <div class="scroll-x">
    <div class="pp-f4-grid" role="table" aria-label="Pre-registered holes: expected and observed counts in new data">
      <div class="pp-f4-head" role="row">
        <span role="columnheader">Code</span><span role="columnheader">Cell</span>
        <span class="pp-f4-axis" role="columnheader"><span class="pp-f4-ticks">${tickEls}</span><span class="pp-f4-axt">${done ? 'reports in the cell, new data' : 'reports expected in the cell'}</span></span>
        <span role="columnheader">Verdict</span><span class="num nc" role="columnheader"><i>q</i> pooled</span>
      </div>
      ${body}
    </div>
  </div>
  <div class="pp-f4-legend">${legend}</div>
  <figcaption><span class="pp-fn">Figure 4.</span> <b>One row per pre-registered hole.</b> ${done ? 'The bar is the count expected in the new reports (E new, quasi-independence fitted to the new sample alone); the dot is the count observed. A dot at zero under a bar that reaches 2 or more is a hole that held. <em>q</em> is the Benjamini–Hochberg value on the pooled sample, over the empty cells of the same pair of tags.' : `The bar is the expected count when the hole was registered; the dot will be the count in the new reports, and <em>q</em> the Benjamini–Hochberg value after pooling. The figure fills in when the new sample is tagged.`}</figcaption>
</figure>`;
}

function normalize(v: string): string {
  const k = v.trim().toLowerCase().replace(/[_-]+/g, ' ');
  return ['replicated', 'refuted', 'underpowered', 'pending', 'partial'].includes(k) ? k : 'other';
}

function replicationHTML(c: Ctx): string {
  const { d, S } = c;
  const rows = d.replication.rows;
  const done = d.replication.status === 'done' && rows.length > 0;
  const tally = new Map<string, number>();
  for (const r of rows) tally.set(normalize(r.verdict), (tally.get(normalize(r.verdict)) ?? 0) + 1);
  const order = ['replicated', 'refuted', 'underpowered'];
  const parts = order.filter((k) => tally.has(k) || k === 'replicated').map((k) => `${tally.get(k) ? word(tally.get(k) as number) : 'none'} ${k === 'replicated' && !tally.get(k) ? 'replicated' : k}`);
  const near = rows.find((r) => r.observed_new === 1 && r.E_new >= 2);
  const summary = done
    ? `<p><strong>Result.</strong> Of ${word(rows.length)} pre-registered holes, ${parts.join(', ')}. The rule is blunt on purpose: ${near ? `${esc(near.code)} looks like a near miss, with one new report against ${fmtE(near.E_new)} expected, but one report is enough to refute a hole. ` : ''}The twelve refutations are listed below, each with the reports that fill the cell.</p>`
    : '';
  const status = done
    ? ''
    : `<div class="pp-status"><p class="pp-lbl">Status · awaiting new data</p><p>The new reports have not been tagged yet. Until they are, every verdict is pending and no number below claims otherwise. When the data arrive, the file the figure reads is replaced, and the bars, dots, verdicts and <em>q</em> fill in by themselves.</p></div>`;
  const refuting = done
    ? rows
        .filter((r) => r.refuting.length)
        .map((r) => `<li><span class="code">${esc(r.code)}</span> ${esc(r.cell_label)}: ${r.refuting.slice(0, 6).map((x) => { const p = c.P.get(x.id); return p ? `<a href="${esc(p.s)}" rel="noopener noreferrer" target="_blank">${esc(x.t)}</a>` : esc(x.t); }).join('; ')}</li>`)
        .join('')
    : '';
  const hash = S.repoPublished
    ? `<a href="${esc(S.commitUrl)}" rel="noopener noreferrer" target="_blank"><code>${esc(d.meta.prereg_commit)}</code></a> in the project repository. The hash fixes the hypotheses in time, and anything changed afterwards shows up as a diff.`
    : `<code>${esc(d.meta.prereg_commit)}</code> in the project repository. The repository is not public yet, so the commit cannot be opened from this page; the file it contains, <code>PREREG.md</code>, is the one the rule below is quoted from, and the hash will be checkable once the repository is pushed.`;
  return `
<p class="eyebrow pp-eyebrow">The test</p>
<h2>Pre-registered, then tested on data that never saw the hypotheses</h2>
<p>Everything above was computed on the sample we used to look. Choosing a hole from a sample and then confirming it on the same sample proves nothing, because the choosing is where the luck gets in. So before any new report existed we wrote down the ${word(S.nPrereg)} holes, their expected counts and the test, and committed the file: ${hash}</p>
<p>The new reports were gathered and tagged without the hypothesis list in front of the taggers. For every cell we ask two questions of the new data: how many reports would its row and column predict (<i>E</i><sub>new</sub>, quasi-independence fitted on the new sample alone), and how many are there (<i>O</i><sub>new</sub>)? The verdict is one of three, by a rule fixed in advance.</p>
<dl class="pp-verdicts">
  <div><dt>${pill('replicated')}</dt><dd>The cell stays empty in the new sample (<i>O</i><sub>new</sub> = 0), the new data alone expect at least two reports there (<i>E</i><sub>new</sub> &ge; 2), and the pooled <em>q</em>, corrected over the empty cells of its pair of tags, is at most 0.10.</dd></div>
  <div><dt>${pill('refuted')}</dt><dd>The cell gains any report in the new sample (<i>O</i><sub>new</sub> &gt; 0). The hole was an accident of the first sample.</dd></div>
  <div><dt>${pill('underpowered')}</dt><dd>Neither: the cell stayed empty, but the new data expect fewer than two reports there or the pooled <em>q</em> is above 0.10. This is not counted as a success.</dd></div>
</dl>
${status}
${summary}
${figure4HTML(c)}
${refuting ? `<h3>Reports that refute a hole</h3><ul class="pp-plain">${refuting}</ul>` : ''}
<p>The final column pools the old and new samples and corrects across the empty cells of the same pair of tags. A hole needs a small pooled <em>q</em>, not a single lucky zero. Nothing here is rescued by a different threshold afterwards: the rules above were written before the verdicts could be.</p>`;
}

function sensitivityHTML(c: Ctx): string {
  const { d } = c;
  const sens = d.sensitivity;
  if (!sens || !sens.rows.length) return '';
  const lab = (k: string) => sens.models.find((m) => m.key === k)?.label ?? k;
  const keys = sens.models.map((m) => m.key);
  const official = keys.find((k) => sens.models.find((m) => m.key === k)?.structural_z === 3) ?? keys[0];
  const sumLine = keys
    .map((k) => {
      const x = sens.summary[k];
      return x ? `${esc(cap(lab(k)))}: ${x.replicated} replicated, ${x.refuted} refuted, ${x.underpowered} underpowered` : '';
    })
    .filter(Boolean)
    .join('; ');
  const head = keys.map((k) => `<th scope="col" colspan="2" class="pp-sg${k === official ? ' off' : ''}">${esc(lab(k))}${k === official ? '<small>registered</small>' : ''}</th>`).join('');
  const sub = keys.map(() => '<th scope="col" class="num">E new</th><th scope="col">verdict</th>').join('');
  const body = sens.rows
    .map((r) => {
      const cells = keys
        .map((k) => {
          const m = r.models[k];
          return m ? `<td class="num">${fmtE(m.E_new)}</td><td>${pill(m.verdict)}</td>` : '<td></td><td></td>';
        })
        .join('');
      return `<tr><td class="code">${esc(r.code)}</td><td class="pp-cell">${esc(r.cell_label)}</td><td class="num">${r.observed_new}</td>${cells}</tr>`;
    })
    .join('');
  const aud = sens.audit;
  const verdictWord = (v: string) => v.replace(/^hole_/, '').replace(/_/g, ' ');
  const pickHole = d.holes.find((h) => h.code === aud.code);
  const rowN = pickHole?.row_ids.length ?? 0;
  const colN = pickHole?.col_ids.length ?? 0;
  const belongs = aud.belongs.map((b) => `&ldquo;${esc(b.title)}&rdquo;`).join(' and ');
  return `
<p class="eyebrow pp-eyebrow">Does the verdict depend on the model?</p>
<h2>Sensitivity and the tagging audit</h2>
<p>The registered verdict leans on one choice: how the expected count <i>E</i><sub>new</sub> is modelled. We reran the same rule, unchanged, with plain independence and with quasi-independence at structural cutoffs of 3 (the registered one), 4 and 5. ${esc(sumLine)}.</p>
<p>The refutations never move: a report in the cell is a report in the cell, under any model. What moves is the underpowered group, and the model choice is the whole difference between &ldquo;nothing replicated&rdquo; and &ldquo;a handful did&rdquo;. That is why the registered column stays the official one and the others sit beside it, labelled, instead of replacing it.</p>
<figure class="figure pp-tbl" id="tab3">
  <div class="scroll-x"><table class="pp-holes pp-sens">
    <thead><tr><th scope="col" rowspan="2">Code</th><th scope="col" rowspan="2">Cell</th><th scope="col" rowspan="2" class="num">O new</th>${head}</tr><tr>${sub}</tr></thead>
    <tbody>${body}</tbody>
  </table></div>
  <figcaption><span class="pp-fn">Table 3.</span> <b>The same ${word(sens.rows.length)} cells under four expectation models.</b> <i>E</i> new is the count the new reports alone predict; the verdict applies the registered rule to it. Real values from the sensitivity run; this analysis is <span class="honesty exploratory" title="Not part of the pre-registered test.">exploratory</span>.</figcaption>
</figure>
<h3>The tagging audit</h3>
<p>For the hole we picked, <span class="nowrap">${esc(aud.code)}</span>, three auditors reread the tags. Each read all ${fmtN(colN)} reports tagged for researchers and all ${fmtN(rowN)} tagged with the consumer-device material, and each ruled on whether the empty cell is real. They disagreed: ${aud.verdicts.map((v, i) => `${['strict', 'lenient', 'adversarial'][i] ?? 'another'} reading, ${esc(verdictWord(v))}`).join('; ')}.${c.sn(`The three readings are ${aud.verdicts.map(esc).join(', ')}. The audit prompts and answers are in results/evidence.json in the repository.`)}</p>
<p>What the auditors found is specific. Reverse-engineering of <em>scientific-grade</em> instruments for research does exist in the corpus: ${belongs}. The vocabulary files those under lab experiments, because the material definition says &ldquo;retail device&rdquo;. No report applies Claude to <em>consumer-grade</em> devices (wearables, phones, cheap gadgets) for research. So the honest scope of this hole is narrower than its label: consumer hardware used in research.</p>`;
}

/* ================================================================== #built */

function builtHTML(c: Ctx): string {
  const { d, S } = c;
  const w = d.winner;
  if (w.status === 'built') {
    const h = S.holes.find((x) => x.code === w.code);
    const demo = (w.demo ?? {}) as Record<string, unknown>;
    const demoUrl = typeof demo.url === 'string' ? demo.url : typeof demo.href === 'string' ? demo.href : null;
    return `
<p class="eyebrow pp-eyebrow">Built</p>
<h2>${esc(cap(w.title))}</h2>
<p class="pp-lead"><span class="code">${esc(w.code)}</span>${h ? ` · ${esc(cellLabel(h))} · expected ${fmtE(h.E)}, observed 0` : ''}</p>
<p>${esc(w.pitch)}</p>
${w.how_it_works.length ? `<h3>How it works</h3><ol class="pp-how">${w.how_it_works.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
<p>${demoUrl ? `<a href="${esc(demoUrl)}" rel="noopener noreferrer" target="_blank">Open the demo</a> · ` : ''}${S.repoPublished ? `<a href="${esc(d.meta.repo_url)}" rel="noopener noreferrer" target="_blank">Source</a> ` : ''}${w.repo_path ? `<span class="mono">${esc(w.repo_path)}</span>` : ''}</p>
${priorArtHTML(c)}`;
  }
  const nTested = d.replication.rows.length;
  const pick = w.pick;
  const stage = w.concept_stage;
  const pickHole = pick ? S.holes.find((h) => h.code === pick.code) : undefined;
  const gate1 = d.replication.status === 'done' ? `${S.nReplicated} of ${nTested} replicated` : 'not tested yet';
  const gate2 = stage ? `${stage.clean} of ${stage.concepts} concepts came back clean (${stage.searches} searches)` : `${S.holes.filter((h) => h.prior_art).length} of ${S.nHoles} searched`;
  const gate3 = stage ? `${stage.concepts} concepts scored by two judges` : 'not yet judged';
  const pickCard = pick
    ? `
<div class="pp-pick" role="status">
  <span class="eyebrow">The pick, an exception · picked, not built</span>
  <p class="pp-built-h"><span class="void-name">${esc(pick.title)}</span></p>
  <p class="pp-lead"><span class="code">${esc(pick.code)}</span>${pickHole ? ` · ${esc(cellLabel(pickHole))}` : ''}</p>
  <p>${esc(pick.pitch)}</p>
  <h3>Why it was picked, and why that is an exception</h3>
  <p>Under the registered rule <span class="nowrap">${esc(pick.code)}</span> is <strong>${esc(pick.stats.official_verdict)}</strong>: it stayed empty in the new sample (observed ${pick.stats.observed_new}), but the new reports alone predict only ${fmtE(pick.stats.E_new)}, below the bar of 2. That is a failure of gate 1, so by the rules written in advance nothing here has earned a build. We picked it anyway, after seeing the results, and say so. On the pooled sample it is the strongest hole there is: ${fmtE(pick.stats.E_pooled)} expected, none observed, <em>q</em> = ${fmtP(pick.stats.q_pooled)}. Under plain independence the new sample alone gives ${fmtE(pick.stats.E_new_indep)} expected and none observed (<em>q</em> ${fmtP(pick.stats.q_pooled_indep)}), which would replicate. Both readings are in the sensitivity table, and the official verdict stays as registered. The tagging audit weakens the hole to consumer hardware in research, which is the scope Drift works in.</p>
  <h3>How it works</h3>
  <ol class="pp-how">${pick.how_it_works.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
  <p class="pp-dim">Nothing is built yet${pick.repo_path ? `; reconnaissance of the open firmware toolchains is in <span class="mono">${esc(pick.repo_path)}</span>` : ''}. If differential execution turns out infeasible for a given algorithm we will say so and fall back to a static diff, labelled as one. Every number it reports will come from a script in the repository that anyone can rerun, and its own prior art gets checked again in its refined form.</p>
</div>`
    : `<div class="pp-built-ph" role="status"><span class="eyebrow">Build status</span><p class="pp-built-h"><span class="void-name">Nothing to show yet.</span></p><p>This section reports what was made, which hole it fills, and the closest prior art we found, whether or not that flatters the result. If no hole passes all three gates, it says so.</p></div>`;
  return `
<p class="eyebrow pp-eyebrow">Built</p>
<h2>At most one hole gets built</h2>
<p>Not every hole survives, and we do not pick our favorite. The one that gets built is the first to pass three gates, in this order. If no hole passes all three, this section says so.</p>
<ol class="pp-gates">
  <li><span class="pp-gn">1</span><b>Replicated</b><span>It stays empty in the new, blind sample, with a small pooled <em>q</em>.</span><span class="pp-gs">${esc(gate1)}</span></li>
  <li><span class="pp-gn">2</span><b>No prior art found</b><span>A search of the web and code repositories turns up nobody who has already made it.</span><span class="pp-gs">${esc(gate2)}</span></li>
  <li><span class="pp-gn">3</span><b>Judged buildable</b><span>It can be made in a stretch of work we can finish and show running, so the claim can be checked by use.</span><span class="pp-gs">${esc(gate3)}</span></li>
</ol>
${d.replication.status === 'done' && S.nReplicated === 0 ? `<p><strong>No hole passed gate 1.</strong> By the pre-registered rule, nothing earned a build.</p>` : ''}
${pickCard}
${priorArtHTML(c)}`;
}

function oneSentence(t: string, max = 190): string {
  const m = /^(.{40,}?[.!?])(\s|$)/.exec(t);
  const s1 = m ? (m[1] as string) : t;
  return s1.length > max ? `${s1.slice(0, max - 1).trimEnd()}…` : s1;
}

function priorArtHTML(c: Ctx): string {
  const { S, d } = c;
  const withArt = S.holes.filter((h) => h.prior_art);
  if (!withArt.length) return '';
  const rows = withArt
    .map((h) => {
      const a = h.prior_art;
      if (!a) return '';
      const closest = a.closest.slice(0, 3).map((x) => `<li><a href="${esc(x.url)}" rel="noopener noreferrer" target="_blank">${esc(host(x.url))}</a> ${esc(oneSentence(x.what))} <span class="pp-dim">(closeness ${esc(x.how_close)})</span></li>`).join('');
      return `<tr><td class="code">${esc(h.code)}</td><td>${esc(cellLabel(h))}${h.concept ? `<small class="pp-concept">${esc(h.concept.title)}</small>` : ''}</td><td>${pill(a.verdict)}</td><td><ul class="pp-plain tight">${closest}</ul></td></tr>`;
    })
    .join('');
  const stage = d.winner.status === 'pending' ? d.winner.concept_stage : undefined;
  return `<figure class="figure pp-tbl" id="tab2"><div class="scroll-x"><table class="pp-holes pp-prior"><thead><tr><th>Code</th><th>Cell and concept</th><th>Prior art</th><th>Closest found</th></tr></thead><tbody>${rows}</tbody></table></div><figcaption><span class="pp-fn">Table 2.</span> <b>Prior-art search.</b> The top-ranked concept for each of the ${word(withArt.length)} holes the concept stage worked on, with the closest items found and how close we judged them (0 to 1). ${stage ? `All ${stage.concepts} concepts and ${stage.searches} searches, two lenses each, are in <span class="mono">results/evidence.json</span>. ` : ''}A verdict of <em>partial</em> means the problem or part of the idea is covered, not all of it.</figcaption></figure>`;
}

/* ================================================================== #methods (limits) */

function methodsHTML(c: Ctx): string {
  const { d, S, citeTitle, cite } = c;
  const top = S.topDomain;
  const topShare = top.n / Math.max(1, S.N);
  return `
<p class="eyebrow pp-eyebrow">Limits</p>
<h2>Limits, honestly</h2>
<p>Five things this note cannot do, in the order we would worry about them.</p>
<ol class="pp-limits">
  <li><b>The corpus defines the world.</b> A hole here is an absence from what is <em>reported</em>, not from what is done. The ${fmtN(S.N)} reports are a hand-collected sample of what people choose to write about, and that choice has an editor. ${fmtN(S.nVideo)} are flagged as from a single video,${cite('video')} ${fmtN(S.nSecond)} we know only through a roundup, ${fmtN(S.nAnchors)} are representative tasks from Anthropic&rsquo;s usage reports and not one person&rsquo;s report, and the largest domain, <em>${esc(top.name)}</em>, holds ${fmtPct(topShare)} of everything. An empty cell can mean nobody has done it, or nobody wrote it down where we looked.</li>
  <li><b>The tags are a model of meaning.</b> ${S.nMove} moves, ${S.nMat} materials and ${S.nFor} audiences are one way to carve a use of Claude into pieces, and a different vocabulary draws different cells. Two taggers agree (&kappa; of ${fmtF(S.kappaMin, 2)} to ${fmtF(S.kappaMax, 2)}), which shows the labels are repeatable and nothing about whether they are right. Tag robustness tests noise between taggers, not the choice of vocabulary.</li>
  <li><b>The globe is a picture.</b> It projects a ${S.pca}-dimensional space onto a sphere. Clusters are roughly real; the distances between them are not, and empty-looking ocean is not evidence of anything. Nothing we score is computed on the picture. That is why a selected hole lights the two groups of reports it sits between, rather than a patch of blank map.</li>
  <li><b>A hole can be empty because it is nonsense.</b> Expected counts come from how common a row and a column are, and know nothing about whether they belong together. Two common margins can predict a pairing nobody wants. Replication tells us a cell is really empty. Only judgment, which is the third gate, can say it should be filled.</li>
  <li><b>&ldquo;No prior art found&rdquo; is a statement about a search, not about the world.</b> It means a bounded search of the web and of code repositories found nothing close enough to count. It does not mean nobody has built it: work can be private, behind a login, in another language, or just badly indexed. The results for the concepts we carried forward are listed in Table 2, close or not, so a reader can judge how close <em>close</em> was; the rest are in the repository.</li>
</ol>
<p>None of this means the method does not work. It means what the method gives you is a short list of well-tested questions, each with its evidence one click away: the report counts behind a cell are in <a href="catalog.html">the catalog</a>, the pre-registration is in the repository, and the data files are the ones the figures read.</p>`;
}

/* ================================================================== #references */

function referencesHTML(c: Ctx): string {
  const list = c.refs();
  return `
<h2>References</h2>
<p class="pp-refs-intro">The sources cited above. Every report&rsquo;s own source is linked from the globe, the matrix and the catalog; URLs are as recorded in the corpus, and Reddit links go to archived copies.</p>
${list}`;
}

/* ================================================================== typeset + wiring */

function typeset(root: ParentNode): void {
  const els = root.querySelectorAll<HTMLElement>('.tex[data-tex]');
  if (!els.length) return;
  import('katex')
    .then((m) => {
      const katex = m.default;
      els.forEach((el) => {
        try {
          katex.render(el.dataset.tex ?? '', el, { throwOnError: false, displayMode: !!el.dataset.display, output: 'htmlAndMathml' });
          el.dataset.done = '1';
        } catch {
          /* leave the plain-text fallback */
        }
      });
    })
    .catch(() => {
      /* offline or blocked: the plain-text fallbacks stay */
    });
}

function wireFigure2(c: Ctx): void {
  const read = document.getElementById('f2-read');
  const fig = document.getElementById('fig2');
  if (!read || !fig) return;
  const base = read.innerHTML;
  const { S } = c;
  const gap = (rank: number) => S.gaps.find((g) => g.rank === rank);
  const text = (rank: number, from: 'a' | 'b'): string => {
    const g = gap(rank);
    if (!g) return base;
    const k = Math.round(g.stability * S.reruns);
    const par = g.parents.map((p) => `&ldquo;${esc(p)}&rdquo;`).join(' and ');
    return from === 'a'
      ? `<b>Gap ${String(g.rank).padStart(2, '0')}.</b> Nearest report at cosine <span class="mono">${fmtF(g.nn_cos, 3)}</span>. Made from ${par}.`
      : `<b>Gap ${String(g.rank).padStart(2, '0')}.</b> Found again in <span class="mono">${k} of ${S.reruns}</span> reruns (chance: ${fmtPct(S.chance, 1)}). Made from ${par}.`;
  };
  const clear = () => {
    read.innerHTML = base;
    fig.querySelectorAll('.on').forEach((e) => e.classList.remove('on'));
  };
  const hook = (sel: string, from: 'a' | 'b') => {
    fig.querySelectorAll<SVGElement>(sel).forEach((el) => {
      const rank = Number(el.dataset.rank);
      const on = () => {
        fig.querySelectorAll('.on').forEach((e) => e.classList.remove('on'));
        fig.querySelectorAll<SVGElement>(`[data-rank="${rank}"]`).forEach((e) => e.classList.add('on'));
        read.innerHTML = text(rank, from);
      };
      el.addEventListener('pointerenter', on);
      el.addEventListener('focus', on);
      el.addEventListener('pointerleave', clear);
      el.addEventListener('blur', clear);
    });
  };
  hook('.pp-dot', 'a');
  hook('.pp-bar-g', 'b');
}

function wireFigure4(): void {
  const fig = document.getElementById('fig4');
  if (!fig) return;
  const tip = tooltip();
  fig.querySelectorAll<HTMLElement>('.pp-f4-row').forEach((row) => {
    const html = row.dataset.tip ?? '';
    row.addEventListener('pointermove', (e) => tip.show(html, e.clientX, e.clientY));
    row.addEventListener('pointerleave', () => tip.hide());
  });
}

/** Number every sidenote on the page in document order. The chip (.sn) and its note (.sn-body, a child or the next sibling) share data-n. */
function numberSidenotes(): void {
  let n = 0;
  document.querySelectorAll<HTMLElement>('.sn').forEach((sn) => {
    n += 1;
    sn.dataset.n = String(n);
    const next = sn.nextElementSibling;
    const body = sn.querySelector<HTMLElement>('.sn-body') ?? (next && next.classList.contains('sn-body') ? (next as HTMLElement) : null);
    if (body) body.dataset.n = String(n);
  });
}

/* ================================================================== entry */

export function initPaper(data: AppData): void {
  const c = makeCtx(data);
  const set = (id: string, html: string) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
    return el;
  };

  // order matters: citations are numbered in the order the sections are built (which is document order)
  set('abstract', abstractHTML(c));
  const steam = set('steam', steamHTML(c));
  // the methods narrative continues the argument right after the Steam section
  let counting = document.getElementById('counting');
  if (!counting && steam) {
    counting = document.createElement('section');
    counting.id = 'counting';
    steam.insertAdjacentElement('afterend', counting);
  }
  if (counting) counting.innerHTML = countingHTML(c);
  set('replication', replicationHTML(c));
  set('sensitivity', sensitivityHTML(c));
  set('built', builtHTML(c));
  set('methods', methodsHTML(c));
  set('references', referencesHTML(c));

  numberSidenotes();
  const papers = document.querySelector('.paper');
  typeset(papers ?? document);
  wireFigure2(c);
  wireFigure4();
}
