// The matrix figure (direction B, restyled to the approved tokens): a pair switcher, the observed-count grid with
// hatched holes, marginal bars, and a detail panel. Plate and matrix stay in sync through the window event
// "overhang:select-hole" { code }.
import './styles/matrix.css';
import type { AppData, AxisName, FacetTable, Hole, Point, TableKey } from './data';
import { esc, fmtE, fmtF, fmtN, fmtP, fmtPercentile, fmtQ, honesty, pill, tooltip } from './ui';

type SortMode = 'vocab' | 'total';
type Sel = { kind: 'hole'; code: string } | { kind: 'cell'; ri: number; ci: number } | null;

const AXIS_FIELD: Record<AxisName, 'mv' | 'mt' | 'fr'> = { move: 'mv', material: 'mt', for: 'fr' };
// one name per axis on every surface of the page: the third axis is the audience (the data field is still called `for`)
const AXIS_NOUN: Record<AxisName, string> = { move: 'move', material: 'material', for: 'audience' };
const SELECT_EVENT = 'overhang:select-hole';

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Only http(s) links are ever rendered as links. */
function safeUrl(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

function splitKey(key: TableKey): [AxisName, AxisName] {
  const [a, b] = key.split('×') as [AxisName, AxisName];
  return [a, b];
}

function keyOfHole(h: Hole): TableKey {
  return `${h.axes[0]}×${h.axes[1]}` as TableKey;
}

export function initMatrix(el: HTMLElement, data: AppData): void {
  const { meta, facets, holes } = data;
  const pairKeys = (Object.keys(facets.tables) as TableKey[]).filter((k) => facets.tables[k]);
  if (!pairKeys.length) {
    el.innerHTML = `<h2>The matrix</h2><p class="stub">No facet tables in the data.</p>`;
    return;
  }

  const pointById = new Map<string, Point>(data.points.map((p) => [p.id, p]));
  const holesByKey = new Map<TableKey, Hole[]>();
  for (const h of holes) {
    const k = keyOfHole(h);
    const list = holesByKey.get(k) ?? [];
    list.push(h);
    holesByKey.set(k, list);
  }
  const holeByCode = new Map<string, Hole>(holes.map((h) => [h.code, h]));
  const pending = meta.replication_status === 'pending';

  /* ------------------------------------------------------------ state */
  const initialKey: TableKey = pairKeys.includes('move×material') ? 'move×material' : (pairKeys[0] as TableKey);
  const state: { key: TableKey; sort: SortMode; sel: Sel; focus: [number, number] } = {
    key: initialKey,
    sort: 'vocab',
    sel: null,
    focus: [0, 0],
  };
  const firstHole = holesByKey.get(initialKey)?.[0];
  if (firstHole) state.sel = { kind: 'hole', code: firstHole.code };

  /* ------------------------------------------------------------ static shell */
  const nReg = holes.filter((h) => h.prereg).length;
  const nExpl = holes.length - nReg;
  const nRefuted = data.replication.rows.filter((r) => r.verdict === 'refuted').length;
  const nUnder = data.replication.rows.filter((r) => r.verdict === 'underpowered').length;
  const nReplicated = data.replication.rows.filter((r) => r.verdict === 'replicated').length;
  const honestyLabel = pending
    ? `<span class="honesty mx-honesty" title="The holes are candidates. They were pre-registered before the replication sample was drawn, and the out-of-sample test has not run yet.">candidates · pre-registered · awaiting the out-of-sample test</span>`
    : `<span class="honesty mx-honesty" title="Counts are pooled over the original and the new sample. A solid outline marks a hole registered at ${fmtN(meta.N_r1)} reports; a dashed one was found after pooling and is exploratory.">pooled ${fmtN(meta.N)} reports · ${nReg} registered holes · ${nExpl} exploratory</span>`;
  el.innerHTML = `
    <h2>Where the reports pile up, and where they don&rsquo;t</h2>
    <p class="lead">Every report is tagged with what the person did (the move), what they did it to (the material) and who it was for. Cross any two of the three and you get a grid. The empty squares between two common tags are the holes.</p>
    <figure class="figure mx" aria-label="Matrix of observed counts for a pair of tags, with holes hatched">
      <div class="mx-head">
        <span class="fig-label">Figure 2 · Matrix</span>
        <span class="mx-sub" id="mx-sub"></span>
        ${honestyLabel}
      </div>
      <div class="mx-controls">
        <div class="mx-ctl"><span class="mx-ctl-l">Pair</span>
          <div class="mx-seg" role="group" aria-label="Pair of tags" id="mx-pairs"></div></div>
        <div class="mx-ctl"><span class="mx-ctl-l">Order</span>
          <div class="mx-seg" role="group" aria-label="Order of rows and columns" id="mx-sort">
            <button type="button" data-sort="vocab" aria-pressed="true">Vocabulary</button>
            <button type="button" data-sort="total" aria-pressed="false">By total</button>
          </div></div>
      </div>
      <div class="mx-body">
        <div class="mx-main">
          <p class="mx-scrollhint">Scroll the matrix sideways</p>
          <div class="scroll-x mx-scroll" id="mx-scroll" tabindex="-1"><div class="mx-grid" id="mx-grid" role="grid"></div></div>
          <div class="mx-keybar" id="mx-key"></div>
        </div>
        <aside class="mx-detail" id="mx-detail" aria-label="Selected cell" aria-live="polite"></aside>
      </div>
      <figcaption id="mx-cap"></figcaption>
    </figure>`;

  const $ = <T extends HTMLElement>(id: string): T => el.querySelector<T>(`#${id}`) as T;
  const subEl = $('mx-sub');
  const pairsEl = $('mx-pairs');
  const sortEl = $('mx-sort');
  const gridEl = $('mx-grid');
  const keyEl = $('mx-key');
  const scrollEl = $('mx-scroll');
  const detailEl = $('mx-detail');
  const capEl = $('mx-cap');
  const tip = tooltip();

  pairsEl.innerHTML = pairKeys
    .map((k) => {
      const [a, b] = splitKey(k);
      const n = holesByKey.get(k)?.length ?? 0;
      return `<button type="button" data-key="${esc(k)}" aria-pressed="false">${esc(AXIS_NOUN[a])} × ${esc(AXIS_NOUN[b])}<span class="mx-badge" title="${n} holes in this pair">${n}</span></button>`;
    })
    .join('');

  /* ------------------------------------------------------------ geometry helpers */
  interface Layout {
    table: FacetTable;
    axA: AxisName;
    axB: AxisName;
    rowOrder: number[];
    colOrder: number[];
    rowTot: number[];
    colTot: number[];
    max: number;
    total: number;
    holeAt: Map<string, Hole>;
  }

  function layout(): Layout {
    const table = facets.tables[state.key];
    const [axA, axB] = splitKey(state.key);
    const nr = table.rows.length;
    const nc = table.cols.length;
    const rowTot = table.observed.map((r) => r.reduce((s, v) => s + v, 0));
    const colTot = Array.from({ length: nc }, (_, j) => table.observed.reduce((s, r) => s + (r[j] ?? 0), 0));
    const idx = (n: number) => Array.from({ length: n }, (_, i) => i);
    const byDesc = (tot: number[]) => (i: number, j: number) => (tot[j] ?? 0) - (tot[i] ?? 0) || i - j;
    const rowOrder = state.sort === 'total' ? idx(nr).sort(byDesc(rowTot)) : idx(nr);
    const colOrder = state.sort === 'total' ? idx(nc).sort(byDesc(colTot)) : idx(nc);
    const max = Math.max(1, ...table.observed.flat());
    const holeAt = new Map<string, Hole>();
    for (const h of holesByKey.get(state.key) ?? []) {
      const ri = table.rows.indexOf(h.cell[axA] ?? '');
      const ci = table.cols.indexOf(h.cell[axB] ?? '');
      if (ri >= 0 && ci >= 0) holeAt.set(`${ri},${ci}`, h);
    }
    return { table, axA, axB, rowOrder, colOrder, rowTot, colTot, max, total: rowTot.reduce((s, v) => s + v, 0), holeAt };
  }

  let L = layout();

  /** Position on the ramp, 0..1, for a count: logarithmic, so a cell with 2 reports and one with 9 are plainly different next to a cell with 60. */
  const tOf = (n: number): number => 0.1 + 0.9 * (Math.log(1 + n) / Math.log(1 + Math.max(2, L.max)));
  /** Four stops (navy, steel, sand, starlight; paper: mist, powder, blue, cobalt), mixed in OKLab so the middle never turns to mud. */
  const fillCss = (t: number): string => {
    const seg = t < 0.34 ? 0 : t < 0.67 ? 1 : 2;
    const lo = ['--ramp-0', '--ramp-a', '--ramp-b'][seg];
    const hi = ['--ramp-a', '--ramp-b', '--ramp-1'][seg];
    const a = [0, 0.34, 0.67][seg] as number;
    const w = [0.34, 0.33, 0.33][seg] as number;
    return `color-mix(in oklab, var(${hi}) ${Math.round(100 * Math.max(0, Math.min(1, (t - a) / w)))}%, var(${lo}))`;
  };

  /* ------------------------------------------------------------ grid */
  function renderGrid(): void {
    const { table, rowOrder, colOrder, rowTot, colTot, holeAt } = L;
    const nr = rowOrder.length;
    const nc = colOrder.length;
    const maxCol = Math.max(1, ...colTot);
    const maxRow = Math.max(1, ...rowTot);
    gridEl.style.setProperty('--n', String(nc));
    gridEl.setAttribute('aria-label', `${state.key.replace('×', ' by ')} matrix of observed counts, ${nr} rows by ${nc} columns`);
    gridEl.setAttribute('aria-rowcount', String(nr + 1));
    gridEl.setAttribute('aria-colcount', String(nc + 1));

    const sw = `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((k) => fillCss(tOf(1) + k * (1 - tOf(1)))).join(', ')})`;
    const key = `<div class="mx-key" aria-hidden="true">
      <div class="mx-key-row"><div class="mx-key-ramp" style="background:${sw}"></div>
        <div class="mx-key-ticks mono"><span>1</span><span>${fmtN(Math.max(2, Math.round(Math.sqrt(L.max))))}</span><span>${fmtN(L.max)}</span></div>
        <span class="mx-key-t"><b>Fill</b>: reports observed</span></div>
      <div class="mx-key-row"><span class="mx-sw mx-sw-hole" aria-hidden="true"></span><span class="mx-key-t"><b>Hole</b>: none observed, E printed</span></div>
      <div class="mx-key-row"><span class="mx-sw mx-sw-st" aria-hidden="true"></span><span class="mx-key-t"><b>Structural</b> (a groove)</span></div>
      <div class="mx-key-row"><span class="mx-sw mx-sw-bar" aria-hidden="true"><i></i><i></i><i></i></span><span class="mx-key-t"><b>Bars</b>: row and column totals</span></div>
    </div>`;

    const head: string[] = [];
    colOrder.forEach((ci, pos) => {
      const gc = 4 + pos;
      const lab = table.cols[ci] ?? '';
      const n = colTot[ci] ?? 0;
      head.push(
        `<div class="mx-collab" role="columnheader" data-col="${ci}" style="grid-row:1;grid-column:${gc}" title="${esc(lab)}"><span>${esc(lab)}</span></div>` +
          `<div class="mx-colbar" aria-hidden="true" data-col="${ci}" style="grid-row:2;grid-column:${gc}"><i style="height:${((n / maxCol) * 100).toFixed(1)}%"></i></div>` +
          `<div class="mx-colnum mono" aria-hidden="true" data-col="${ci}" style="grid-row:3;grid-column:${gc}">${n}</div>`,
      );
    });

    const body: string[] = [];
    rowOrder.forEach((ri, rpos) => {
      const gr = 4 + rpos;
      const lab = table.rows[ri] ?? '';
      const n = rowTot[ri] ?? 0;
      const cells: string[] = [];
      colOrder.forEach((ci, cpos) => {
        const o = table.observed[ri]?.[ci] ?? 0;
        const hole = holeAt.get(`${ri},${ci}`);
        const st = table.structural[ri]?.[ci] === true;
        const gc = 4 + cpos;
        const cls = ['mx-cell'];
        let inner = '';
        let style = `grid-row:${gr};grid-column:${gc}`;
        if (hole) {
          cls.push('hole');
          if (!hole.prereg) cls.push('expl');
          inner += `<span class="e"><i>E</i><b>${esc(fmtE(hole.E))}</b></span>`;
          if (o > 0) {
            cls.push('seen');
            inner += `<span class="seen-n">${o}</span>`;
          }
        } else if (o > 0) {
          const t = tOf(o);
          cls.push('fill');
          if (t > 0.6) cls.push('hi');
          style += `;--fill:${fillCss(t)}`;
          inner += `<span class="n">${o}</span>`;
        }
        if (st) cls.push('st');
        const label = `${cap(lab)} by ${table.cols[ci] ?? ''}: ${o} observed${hole ? `, hole ${hole.code}, E ${fmtE(hole.E)}` : ''}${st ? ', structural' : ''}`;
        cells.push(
          `<div class="${cls.join(' ')}" role="gridcell" tabindex="-1" data-ri="${ri}" data-ci="${ci}" data-pos="${rpos},${cpos}" aria-label="${esc(label)}" style="${style}">${inner}</div>`,
        );
      });
      body.push(
        `<div role="row" class="mx-row">` +
          `<div class="mx-rowlab" role="rowheader" data-row="${ri}" style="grid-row:${gr};grid-column:1" title="${esc(lab)}"><span>${esc(lab)}</span></div>` +
          `<div class="mx-rowbar" aria-hidden="true" data-row="${ri}" style="grid-row:${gr};grid-column:2"><i style="width:${((n / maxRow) * 100).toFixed(1)}%"></i></div>` +
          `<div class="mx-rownum mono" aria-hidden="true" data-row="${ri}" style="grid-row:${gr};grid-column:3">${n}</div>` +
          cells.join('') +
          `</div>`,
      );
    });

    keyEl.innerHTML = key;
    gridEl.innerHTML =
      `<div role="row" class="mx-row">${head.join('')}</div>` +
      body.join('') +
      `<div class="mx-band r" aria-hidden="true" hidden></div><div class="mx-band c" aria-hidden="true" hidden></div>`;
    applySelectionClasses();
    syncRovingFocus(false);
  }

  function cellAt(ri: number, ci: number): HTMLElement | null {
    return gridEl.querySelector<HTMLElement>(`.mx-cell[data-ri="${ri}"][data-ci="${ci}"]`);
  }

  function selectedCellIdx(): [number, number] | null {
    const s = state.sel;
    if (!s) return null;
    if (s.kind === 'cell') return [s.ri, s.ci];
    const h = holeByCode.get(s.code);
    if (!h || keyOfHole(h) !== state.key) return null;
    for (const [k, v] of L.holeAt) if (v.code === h.code) return k.split(',').map(Number) as [number, number];
    return null;
  }

  function applySelectionClasses(): void {
    gridEl.querySelectorAll('.mx-cell.sel').forEach((n) => {
      n.classList.remove('sel');
      n.removeAttribute('aria-selected');
    });
    const at = selectedCellIdx();
    if (at) {
      const c = cellAt(at[0], at[1]);
      c?.classList.add('sel');
      c?.setAttribute('aria-selected', 'true');
    }
  }

  /* roving tabindex: the grid is one tab stop, arrows move between cells */
  function syncRovingFocus(focus: boolean): void {
    const rows = L.rowOrder.length;
    const cols = L.colOrder.length;
    const sel = selectedCellIdx();
    let [rp, cp] = state.focus;
    if (sel) {
      rp = L.rowOrder.indexOf(sel[0]);
      cp = L.colOrder.indexOf(sel[1]);
    }
    rp = Math.max(0, Math.min(rows - 1, rp));
    cp = Math.max(0, Math.min(cols - 1, cp));
    state.focus = [rp, cp];
    gridEl.querySelectorAll<HTMLElement>('.mx-cell[tabindex="0"]').forEach((n) => n.setAttribute('tabindex', '-1'));
    const target = gridEl.querySelector<HTMLElement>(`.mx-cell[data-pos="${rp},${cp}"]`);
    if (target) {
      target.setAttribute('tabindex', '0');
      if (focus) target.focus({ preventScroll: false });
    }
  }

  /* ------------------------------------------------------------ head, caption */
  function renderChrome(): void {
    const { table, total } = L;
    subEl.textContent = `${table.rows.length} × ${table.cols.length} cells · ${fmtN(total)} reports tagged on both axes of ${fmtN(meta.N)}`;
    pairsEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === state.key)));
    sortEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === state.sort)));
  }

  const nHoles = holes.length;
  capEl.innerHTML = `
    <p><b>Fill</b> is the number of reports that carry both tags, printed in the square when it is above zero. The scale runs from empty to the largest cell in the table, so single reports stay visible.
    A <b>hatched, outlined square</b> is a hole: no report sits there, although its row and its column are both common enough that the cell should hold about <span class="mono">E</span> of them. <span class="mono">E</span> is printed inside.</p>
    <p>The expectation is a <b>quasi-independence</b> model: what each cell would hold if the two tags were unrelated, after setting aside the <b>structural cells</b> (a small tick in the corner), pairings that are so over-full that the model fits them exactly and leaves them out when it estimates the rest. A cell counts as a hole when nothing is observed and <span class="mono">E</span> is at least 1. The hover tip gives the catalog code, and the same codes label the globe, the tables and the catalog.</p>
    ${
      pending
        ? `<p class="mx-pending"><span class="honesty">candidates</span> The ${nHoles} holes are candidates, not findings. Their list was pre-registered at <code>${esc(meta.prereg_commit)}</code> and is awaiting the out-of-sample test on a fresh sample, so none is called real yet.</p>`
        : `<p class="mx-pending"><span class="honesty">pooled</span> These counts pool the ${fmtN(meta.N_r1)} original reports with the ${fmtN(meta.N - meta.N_r1)} new ones. ${nReg} holes (solid outline) were registered at ${fmtN(meta.N_r1)} reports; under the registered rule ${nReplicated} replicated, ${nRefuted} were refuted (a cell that gained a report prints its count in the corner) and ${nUnder} are underpowered. ${nExpl} more empty cells appear only after pooling (dashed outline): they are <span class="honesty exploratory">exploratory</span>.</p>`
    }`;

  /* ------------------------------------------------------------ detail panel */
  function itemsIn(ri: number, ci: number): Point[] {
    const { table, axA, axB } = L;
    const fa = AXIS_FIELD[axA];
    const fb = AXIS_FIELD[axB];
    const a = table.rows[ri];
    const b = table.cols[ci];
    return data.points.filter((p) => p[fa] === a && p[fb] === b).sort((x, y) => x.t.localeCompare(y.t));
  }

  function metaLine(p: Point): string {
    return [p.d, p.w, p.dt, host(p.s)].filter(Boolean).map((s) => esc(s)).join(' · ');
  }

  function itemLink(p: Point): string {
    const url = safeUrl(p.s);
    const t = esc(p.t);
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${t}</a>` : `<span>${t}</span>`;
  }

  function itemLi(p: Point, tag?: string): string {
    return `<li>${tag ? `<span class="mx-ax">${esc(tag)}</span>` : ''}<span class="mx-it"><span class="mx-tt">${itemLink(p)}</span><span class="mx-meta" title="${esc(p.id)}">${metaLine(p)}</span></span></li>`;
  }

  function nearest(ids: string[], h: Hole, skip: Set<string>): Point[] {
    const pts: Point[] = [];
    for (const id of ids) {
      const p = pointById.get(id);
      if (p && !skip.has(id)) pts.push(p);
    }
    const d2 = (p: Point) => (p.x - h.x) ** 2 + (p.y - h.y) ** 2;
    return pts.sort((a, b) => d2(a) - d2(b) || a.id.localeCompare(b.id)).slice(0, 6);
  }
  let showAll = false;

  const pendingSpan = `<span class="mx-pending-txt">pending</span>`;

  function holePanel(h: Hole): string {
    const [axA, axB] = h.axes;
    const rowV = h.cell[axA] ?? '';
    const colV = h.cell[axB] ?? '';
    const rep = h.replication ? pill(h.replication.verdict) : h.prereg ? pill('pending') : '<span class="mx-pending-txt">not tested</span>';
    const prior = h.prior_art ? pill(h.prior_art.verdict) : '<span class="mx-pending-txt">not searched</span>';
    const concept = h.concept
      ? `<p class="mx-concept-t"><b>${esc(h.concept.title)}</b></p><p class="mx-concept-p">${esc(h.concept.pitch || h.concept.text)}</p>`
      : `<p class="mx-concept-p"><span class="mx-pending-txt">none written</span></p>`;
    const rowNear = nearest(h.row_ids, h, new Set());
    const colNear = nearest(h.col_ids, h, new Set(rowNear.map((p) => p.id)));
    // by default the three closest across both filaments; "show all" adds up to three more on each side
    const tagged = [...rowNear.map((p) => ({ p, ax: AXIS_NOUN[axA] })), ...colNear.map((p) => ({ p, ax: AXIS_NOUN[axB] }))];
    const d2 = (p: Point) => (p.x - h.x) ** 2 + (p.y - h.y) ** 2;
    const shown = showAll ? tagged : [...tagged].sort((a, b) => d2(a.p) - d2(b.p)).slice(0, 3);
    const near =
      shown.map((x) => itemLi(x.p, x.ax)).join('') || `<li><span class="mx-meta">No tagged reports for these values.</span></li>`;
    const nearMore = tagged.length > 3 ? `<button type="button" class="mx-more" data-more="1" aria-expanded="${showAll}">${showAll ? 'Show fewer' : `Show ${tagged.length - 3} more`}</button>` : '';
    const reg = h.registered;
    const regLine = reg
      ? `<div class="span2"><dt>At registration (${esc(fmtN(reg.N ?? meta.N_r1))} reports)</dt><dd><span>E ${esc(fmtE(reg.E))}</span><small>p ${esc(fmtP(reg.p))} · bootstrap ${esc(fmtF(reg.stability, 2))}</small></dd></div>`
      : '';
    const repLine = h.replication
      ? `<small>new sample: ${esc(fmtN(h.replication.observed_new))} observed, E ${esc(fmtE(h.replication.E_new))}</small>`
      : '';
    const stab = Math.max(0, Math.min(1, h.stability));
    return `
      <div class="mx-d-head"><span class="code mx-code">${esc(h.code)}</span>
        <span class="eyebrow">${esc(AXIS_NOUN[axA])} × ${esc(AXIS_NOUN[axB])}</span>
        ${h.prereg ? '' : honesty('exploratory')}</div>
      <h3 class="mx-d-title void-name">${esc(cap(rowV))}&nbsp;<span class="x">×</span> ${esc(colV)}</h3>
      <dl class="mx-stats">
        ${regLine}
        <div><dt>Expected E, quasi-independence${reg ? ', pooled' : ''}</dt><dd class="sig">${esc(fmtE(h.E))}</dd></div>
        <div><dt>Expected E, independence${reg ? ', pooled' : ''}</dt><dd>${esc(fmtE(h.E_indep))}</dd></div>
        <div><dt>Observed${reg ? ', pooled' : ''}</dt><dd>${esc(fmtN(h.observed))}</dd></div>
        <div><dt>p</dt><dd>${esc(fmtP(h.p))}</dd></div>
        <div><dt>q (BH)</dt><dd title="${h.q == null ? 'Benjamini-Hochberg q is not computed for this run' : 'Benjamini-Hochberg false-discovery q'}">${esc(fmtQ(h.q))}</dd></div>
        <div><dt>Tagger-robust</dt><dd class="mx-yn">${h.tag_robust ? '<span class="mx-yes">yes</span>' : '<span class="mx-no">no</span>'}<small>still a hole under the second tagger</small></dd></div>
        <div class="span2"><dt>Bootstrap stability</dt><dd><span class="mx-meter" role="img" aria-label="${fmtF(stab)}"><i style="width:${(stab * 100).toFixed(1)}%"></i></span><span>${esc(fmtF(h.stability))}</span><small>share of resamples where the cell is still a hole (empty and E ≥ 1)</small></dd></div>
        <div class="span2"><dt>Embedding novelty</dt><dd><span>${esc(fmtPercentile(h.knn_pct ?? h.registered?.knn_pct))}</span><small>percentile of its direction by k-NN novelty${h.knn_pct == null && h.registered?.knn_pct != null ? ', at registration' : ''}</small></dd></div>
        <div><dt>Replication</dt><dd>${rep}${repLine}</dd></div>
        <div><dt>Prior art</dt><dd>${prior}</dd></div>
      </dl>
      <div class="mx-block"><div class="eyebrow">Concept</div>${concept}</div>
      <div class="mx-block"><div class="eyebrow">Nearest real use cases</div>
        <ol class="mx-near">${near}</ol>${nearMore}
        <a class="mx-catlink" href="catalog.html?hole=${esc(h.code)}">All reports in the row and column of ${esc(h.code)}</a></div>`;
  }

  function cellPanel(ri: number, ci: number): string {
    const { table, axA, axB } = L;
    const rowV = table.rows[ri] ?? '';
    const colV = table.cols[ci] ?? '';
    const o = table.observed[ri]?.[ci] ?? 0;
    const e = table.expected[ri]?.[ci];
    const ei = table.expected_indep[ri]?.[ci];
    const q = table.q[ri]?.[ci] ?? null;
    const st = table.structural[ri]?.[ci] === true;
    const items = itemsIn(ri, ci);
    const list = items.length
      ? `<ol class="mx-near mx-scroll-list">${items.map((p) => itemLi(p)).join('')}</ol>`
      : `<p class="mx-concept-p">No report carries both tags. Its expected count is ${esc(fmtE(e))}, under the threshold of 1 that makes an empty cell a hole.</p>`;
    return `
      <div class="mx-d-head"><span class="eyebrow">${esc(AXIS_NOUN[axA])} × ${esc(AXIS_NOUN[axB])}</span>
        ${st ? '<span class="mx-struct" title="A pairing the model fits exactly and sets aside when estimating the other cells">structural (a groove)</span>' : ''}</div>
      <h3 class="mx-d-title void-name">${esc(cap(rowV))}&nbsp;<span class="x">×</span> ${esc(colV)}</h3>
      <dl class="mx-stats">
        <div><dt>Observed</dt><dd class="sig">${esc(fmtN(o))}</dd></div>
        <div><dt>Expected E, quasi-independence</dt><dd>${esc(fmtE(e))}</dd></div>
        <div><dt>Expected E, independence</dt><dd>${esc(fmtE(ei))}</dd></div>
        <div><dt>q (BH)</dt><dd>${esc(fmtQ(q))}</dd></div>
      </dl>
      <div class="mx-block"><div class="eyebrow">${o === 1 ? 'The report' : o > 1 ? `The ${fmtN(o)} reports` : 'Reports'}</div>${list}</div>`;
  }

  function renderDetail(): void {
    const s = state.sel;
    if (s?.kind === 'hole') {
      const h = holeByCode.get(s.code);
      if (h && keyOfHole(h) === state.key) {
        detailEl.innerHTML = holePanel(h);
        return;
      }
    }
    if (s?.kind === 'cell') {
      detailEl.innerHTML = cellPanel(s.ri, s.ci);
      return;
    }
    detailEl.innerHTML = `<div class="mx-d-head"><span class="eyebrow">No cell selected</span></div>
      <p class="mx-concept-p">Pick any square to see its count and the reports in it. Hatched squares are the holes: they open a panel with the full test.</p>`;
  }

  /* ------------------------------------------------------------ actions */
  function selectHole(code: string, fromUser: boolean): void {
    const h = holeByCode.get(code);
    if (!h) return;
    showAll = false;
    const k = keyOfHole(h);
    const changedKey = k !== state.key;
    state.sel = { kind: 'hole', code };
    if (changedKey) {
      state.key = k;
      L = layout();
      renderChrome();
      renderGrid();
    } else {
      applySelectionClasses();
      syncRovingFocus(false);
    }
    renderDetail();
    if (changedKey) scrollEl.scrollLeft = 0;
    if (fromUser) window.dispatchEvent(new CustomEvent(SELECT_EVENT, { detail: { code, source: 'matrix' } }));
  }

  function selectCell(ri: number, ci: number): void {
    const hole = L.holeAt.get(`${ri},${ci}`);
    if (hole) {
      selectHole(hole.code, true);
      return;
    }
    state.sel = { kind: 'cell', ri, ci };
    applySelectionClasses();
    syncRovingFocus(false);
    renderDetail();
  }

  function setPair(k: TableKey): void {
    if (k === state.key) return;
    state.key = k;
    L = layout();
    scrollEl.scrollLeft = 0;
    const first = holesByKey.get(k)?.[0];
    if (first) {
      state.sel = { kind: 'hole', code: first.code };
      renderChrome();
      renderGrid();
      renderDetail();
      window.dispatchEvent(new CustomEvent(SELECT_EVENT, { detail: { code: first.code, source: 'matrix' } }));
    } else {
      state.sel = null;
      renderChrome();
      renderGrid();
      renderDetail();
    }
  }

  function setSort(m: SortMode): void {
    if (m === state.sort) return;
    state.sort = m;
    L = layout();
    renderChrome();
    renderGrid();
  }

  /* ------------------------------------------------------------ hover (row and column highlight, tooltip) */
  let hov: [number, number] | null = null;
  function setHover(ri: number | null, ci: number | null): void {
    if (hov) {
      gridEl.querySelectorAll('.on').forEach((n) => n.classList.remove('on'));
      gridEl.querySelectorAll<HTMLElement>('.mx-band').forEach((b) => (b.hidden = true));
      hov = null;
    }
    if (ri == null || ci == null) return;
    hov = [ri, ci];
    gridEl.querySelectorAll(`[data-row="${ri}"]`).forEach((n) => n.classList.add('on'));
    gridEl.querySelectorAll(`[data-col="${ci}"]`).forEach((n) => n.classList.add('on'));
    const rpos = L.rowOrder.indexOf(ri);
    const cpos = L.colOrder.indexOf(ci);
    const br = gridEl.querySelector<HTMLElement>('.mx-band.r');
    const bc = gridEl.querySelector<HTMLElement>('.mx-band.c');
    if (br) {
      br.style.gridRow = String(4 + rpos);
      br.style.gridColumn = '1 / -1';
      br.hidden = false;
    }
    if (bc) {
      bc.style.gridColumn = String(4 + cpos);
      bc.style.gridRow = '1 / -1';
      bc.hidden = false;
    }
  }

  function tipHtml(ri: number, ci: number): string {
    const { table, holeAt } = L;
    const o = table.observed[ri]?.[ci] ?? 0;
    const e = table.expected[ri]?.[ci];
    const hole = holeAt.get(`${ri},${ci}`);
    const st = table.structural[ri]?.[ci] === true;
    const names = `${esc(cap(table.rows[ri] ?? ''))} × ${esc(table.cols[ci] ?? '')}`;
    const code = hole ? `<span class="mono">${esc(hole.code)}</span> ` : '';
    const line = hole
      ? `hole · observed ${o} · E ${esc(fmtE(hole.E))}`
      : `observed <b>${o}</b> · E ${esc(fmtE(e))}${st ? ' · structural' : ''}`;
    return `${code}<b>${names}</b><br><span class="mono">${line}</span>`;
  }

  gridEl.addEventListener('pointermove', (ev) => {
    const c = (ev.target as HTMLElement).closest<HTMLElement>('.mx-cell');
    if (c) {
      const ri = Number(c.dataset.ri);
      const ci = Number(c.dataset.ci);
      if (!hov || hov[0] !== ri || hov[1] !== ci) {
        setHover(ri, ci);
        tip.show(tipHtml(ri, ci), ev.clientX, ev.clientY);
      } else tip.move(ev.clientX, ev.clientY);
      return;
    }
    const lab = (ev.target as HTMLElement).closest<HTMLElement>('.mx-collab, .mx-rowlab');
    if (lab) {
      tip.show(`<b>${esc(lab.title)}</b>`, ev.clientX, ev.clientY);
      setHover(lab.dataset.row != null ? Number(lab.dataset.row) : null, lab.dataset.col != null ? Number(lab.dataset.col) : null);
      // a label highlights only its own line
      if (lab.dataset.row != null) gridEl.querySelectorAll<HTMLElement>('.mx-band.c').forEach((b) => (b.hidden = true));
      if (lab.dataset.col != null) gridEl.querySelectorAll<HTMLElement>('.mx-band.r').forEach((b) => (b.hidden = true));
      return;
    }
    setHover(null, null);
    tip.hide();
  });
  gridEl.addEventListener('pointerleave', () => {
    setHover(null, null);
    tip.hide();
  });
  scrollEl.addEventListener('scroll', () => tip.hide(), { passive: true });

  gridEl.addEventListener('click', (ev) => {
    const c = (ev.target as HTMLElement).closest<HTMLElement>('.mx-cell');
    if (!c) return;
    state.focus = (c.dataset.pos ?? '0,0').split(',').map(Number) as [number, number];
    selectCell(Number(c.dataset.ri), Number(c.dataset.ci));
    syncRovingFocus(false);
  });

  gridEl.addEventListener('focusin', (ev) => {
    const c = (ev.target as HTMLElement).closest<HTMLElement>('.mx-cell');
    if (!c) return;
    setHover(Number(c.dataset.ri), Number(c.dataset.ci));
  });
  gridEl.addEventListener('focusout', () => setHover(null, null));

  gridEl.addEventListener('keydown', (ev) => {
    const c = (ev.target as HTMLElement).closest<HTMLElement>('.mx-cell');
    if (!c) return;
    let [rp, cp] = (c.dataset.pos ?? '0,0').split(',').map(Number) as [number, number];
    const rows = L.rowOrder.length;
    const cols = L.colOrder.length;
    switch (ev.key) {
      case 'ArrowDown': rp = Math.min(rows - 1, rp + 1); break;
      case 'ArrowUp': rp = Math.max(0, rp - 1); break;
      case 'ArrowRight': cp = Math.min(cols - 1, cp + 1); break;
      case 'ArrowLeft': cp = Math.max(0, cp - 1); break;
      case 'Home': cp = 0; break;
      case 'End': cp = cols - 1; break;
      case 'Enter':
      case ' ':
        ev.preventDefault();
        selectCell(Number(c.dataset.ri), Number(c.dataset.ci));
        return;
      default:
        return;
    }
    ev.preventDefault();
    state.focus = [rp, cp];
    syncRovingFocus(true);
  });

  detailEl.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('[data-more]')) {
      showAll = !showAll;
      renderDetail();
    }
  });
  pairsEl.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-key]');
    if (b?.dataset.key) setPair(b.dataset.key as TableKey);
  });
  sortEl.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-sort]');
    if (b?.dataset.sort) setSort(b.dataset.sort as SortMode);
  });

  /* plate -> matrix */
  window.addEventListener(SELECT_EVENT, (ev) => {
    const d = (ev as CustomEvent<{ code?: string; source?: string }>).detail;
    if (!d || !d.code || d.source === 'matrix') return;
    if (state.sel?.kind === 'hole' && state.sel.code === d.code) return;
    selectHole(d.code, false);
  });

  /* ------------------------------------------------------------ go */
  renderChrome();
  renderGrid();
  renderDetail();
}
