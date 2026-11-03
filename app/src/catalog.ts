// The catalog (catalog.html, #catalog): every report as one row. Search, facet and domain filters, sortable headers,
// a windowed list (only the rows in view are in the DOM, so 1,600 rows scroll as fast as 16), a detail drawer,
// and a shareable URL (?q=&domain=&move=&material=&for=&video=1&sampled=new&hole=OV-01&sort=date:desc).
import './styles/catalog.css';
import type { AppData, AxisName, Hole, Point } from './data';
import { cellLabel } from './data';
import { esc, fmtN } from './ui';

/* ------------------------------------------------------------------ model */

type Dim = 'domain' | 'move' | 'material' | 'for';
type SortKey = 'title' | 'domain' | 'move' | 'material' | 'for' | 'source' | 'date';

interface State {
  q: string;
  domain: string;
  move: string;
  material: string;
  for: string;
  video: boolean;
  sampled: '' | 'original' | 'new';
  hole: string;
  sort: { key: SortKey; dir: 1 | -1 } | null;
}

interface Row {
  p: Point;
  host: string;
  hay: string;
  domLabel: string;
}

const DIMS: { dim: Dim; label: string; all: string; pick: (p: Point) => string }[] = [
  { dim: 'domain', label: 'Domain', all: 'All domains', pick: (p) => p.d },
  { dim: 'move', label: 'Move', all: 'All moves', pick: (p) => p.mv },
  { dim: 'material', label: 'Material', all: 'All materials', pick: (p) => p.mt },
  { dim: 'for', label: 'Audience', all: 'Any audience', pick: (p) => p.fr },
];

const ROW_H = 84;
const ROW_H_CARD = 176; // phones: each row is a small card with its meta lines
const OVERSCAN = 6;

/** "devices-home" -> "Devices & home". Display only; the raw value stays in the title attribute. */
function domainLabel(d: string): string {
  const parts = d.split('-').filter(Boolean);
  if (!parts.length) return d;
  const head = parts[0] as string;
  const first = head.charAt(0).toUpperCase() + head.slice(1);
  if (parts.length === 1) return first;
  const rest = parts.slice(1);
  if (rest.length === 1) return `${first} & ${rest[0]}`;
  return `${first}, ${rest.slice(0, -1).join(', ')} & ${rest[rest.length - 1]}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function emptyState(): State {
  return { q: '', domain: '', move: '', material: '', for: '', video: false, sampled: '', hole: '', sort: null };
}

function readUrl(): State {
  const s = emptyState();
  try {
    const u = new URLSearchParams(location.search);
    s.q = u.get('q') ?? '';
    s.domain = u.get('domain') ?? '';
    s.move = u.get('move') ?? '';
    s.material = u.get('material') ?? '';
    s.for = u.get('for') ?? '';
    s.video = u.get('video') === '1';
    const sm = u.get('sampled');
    s.sampled = sm === 'original' || sm === 'new' ? sm : '';
    s.hole = u.get('hole') ?? '';
    const so = u.get('sort');
    if (so) {
      const [k, d] = so.split(':');
      if (['title', 'domain', 'move', 'material', 'for', 'source', 'date'].includes(k ?? '')) s.sort = { key: k as SortKey, dir: d === 'desc' ? -1 : 1 };
    }
  } catch {
    /* no URL access: defaults */
  }
  return s;
}

function writeUrl(s: State): void {
  try {
    const u = new URLSearchParams();
    if (s.q) u.set('q', s.q);
    if (s.domain) u.set('domain', s.domain);
    if (s.move) u.set('move', s.move);
    if (s.material) u.set('material', s.material);
    if (s.for) u.set('for', s.for);
    if (s.video) u.set('video', '1');
    if (s.sampled) u.set('sampled', s.sampled);
    if (s.hole) u.set('hole', s.hole);
    if (s.sort) u.set('sort', `${s.sort.key}:${s.sort.dir === -1 ? 'desc' : 'asc'}`);
    const qs = u.toString();
    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
  } catch {
    /* sandboxed or blocked: the page still works, it just is not shareable */
  }
}

function tokens(q: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q.toLowerCase()))) out.push((m[1] ?? m[2] ?? '').trim());
  return out.filter(Boolean);
}

/* ------------------------------------------------------------------ entry */

export function initCatalog(el: HTMLElement, data: AppData): void {
  const points = data.points;
  // the new sample is everything after the original reports (the exporter puts the original N_r1 first); `sampled_by` is not set on all of them
  const newIds = new Set(points.slice(data.meta.N_r1).map((p) => p.id));
  const hasNew = newIds.size > 0;
  const phone = window.matchMedia('(max-width: 700px)');
  const rowH = (): number => (phone.matches ? ROW_H_CARD : ROW_H);
  const defs = new Map<string, string>();
  for (const a of ['move', 'material', 'for'] as AxisName[]) for (const v of data.facets.axes[a]) defs.set(`${a}|${v.value}`, v.definition);
  const holeByCode = new Map<string, Hole>(data.holes.map((h) => [h.code, h]));

  const rows: Row[] = points.map((p) => {
    const host = hostOf(p.s);
    const dl = domainLabel(p.d);
    return { p, host, domLabel: dl, hay: [p.t, p.tx, p.w ?? '', dl, p.d, p.mv, p.mt, p.fr, host, p.dt ?? '', p.g ?? '', p.v ? 'video' : ''].join(' \u0001 ').toLowerCase() };
  });

  const st: State = readUrl();
  let holeSet: Set<string> | null = null;
  let view: number[] = [];
  let selected: number | null = null;
  let opener: HTMLElement | null = null;

  /* ---- skeleton */
  const cols = hasNew ? 'cat-cols with-g' : 'cat-cols';
  el.innerHTML = `
<div class="cat-head">
  <p class="eyebrow">Catalog</p>
  <h1 class="cat-title">Every report, one row each</h1>
  <p class="cat-lede">${fmtN(points.length)} sourced reports of things people have done with Claude. Search the text, filter by domain or by what was done, what it acted on and who it was for, and follow any row back to the page where we saw it. The tags are the primary, adjudicated ones. Pick a hole (OV-NN) in the filters to list the reports that carry either side of it: its row value or its column value.</p>
</div>
<form class="cat-tools" role="search" aria-label="Filter the catalog">
  <label class="cat-search"><span class="sr">Search reports</span>
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13 13l4.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    <input type="search" id="cat-q" placeholder="Search titles, text, people, sources" autocomplete="off" spellcheck="false" aria-controls="cat-body">
  </label>
  <div class="cat-filters">
    ${DIMS.map((d) => `<label class="cat-sel"><span>${d.label}</span><select id="cat-${d.dim}" data-dim="${d.dim}"></select></label>`).join('')}
    <label class="cat-sel"><span>Hole</span><select id="cat-hole" aria-label="Only the reports behind one hole"></select></label>
    <label class="cat-chk"><input type="checkbox" id="cat-video"><span>From the video</span></label>
    ${hasNew ? `<label class="cat-sel"><span>Sample</span><select id="cat-sampled"><option value="">Original and new</option><option value="original">Original sample</option><option value="new">New sample</option></select></label>` : ''}
  </div>
  <div class="cat-status">
    <output id="cat-count" class="cat-count" aria-live="polite"></output>
    <div class="cat-chips" id="cat-chips"></div>
  </div>
</form>
<div class="cat-table" role="table" aria-label="Reports" aria-rowcount="${points.length + 1}">
  <div class="cat-scroll" id="cat-scroll" tabindex="0">
    <div class="cat-headrow ${cols}" role="row">
      <span role="columnheader" aria-sort="none"><button type="button" class="cat-sort" data-sort="title">Report</button></span>
      <span role="columnheader" aria-sort="none"><button type="button" class="cat-sort" data-sort="domain">Domain</button></span>
      <span role="columnheader" aria-sort="none"><button type="button" class="cat-sort" data-sort="move">Move</button></span>
      <span role="columnheader" aria-sort="none"><button type="button" class="cat-sort" data-sort="material">Material</button></span>
      <span role="columnheader" aria-sort="none"><button type="button" class="cat-sort" data-sort="for">Audience</button></span>
      <span role="columnheader" aria-sort="none"><button type="button" class="cat-sort" data-sort="source">Source</button></span>
      <span role="columnheader" aria-sort="none"><button type="button" class="cat-sort" data-sort="date">Date</button></span>
      <span role="columnheader">Video</span>
      ${hasNew ? '<span role="columnheader">Sampled by</span>' : ''}
    </div>
    <div class="cat-body" id="cat-body" role="rowgroup"><div class="cat-rows" id="cat-rows"></div></div>
  </div>
</div>
<p class="cat-foot">Rows are in corpus order until you sort. Every number on the globe and in the matrix is counted from these rows.</p>
<aside class="cat-drawer" id="cat-drawer" aria-label="Report detail" hidden></aside>`;

  const $ = <T extends HTMLElement>(id: string) => el.querySelector<T>(`#${id}`) as T;
  const qIn = $<HTMLInputElement>('cat-q');
  const videoIn = $<HTMLInputElement>('cat-video');
  const sampledIn = el.querySelector<HTMLSelectElement>('#cat-sampled');
  const holeIn = $<HTMLSelectElement>('cat-hole');
  const countEl = $('cat-count');
  const chipsEl = $('cat-chips');
  const scroll = $('cat-scroll');
  const body = $('cat-body');
  const rowsEl = $('cat-rows');
  const drawer = $('cat-drawer');
  const head = el.querySelector<HTMLElement>('.cat-headrow') as HTMLElement;
  const sels = new Map<Dim, HTMLSelectElement>(DIMS.map((d) => [d.dim, $<HTMLSelectElement>(`cat-${d.dim}`)]));

  /* ---- filtering */
  function resolveHole(): void {
    holeSet = null;
    if (!st.hole) return;
    const h = holeByCode.get(st.hole.toUpperCase());
    if (!h) {
      st.hole = '';
      return;
    }
    st.hole = h.code;
    holeSet = new Set([...h.row_ids, ...h.col_ids]);
  }

  function pass(r: Row, skip: Dim | 'none', toks: string[]): boolean {
    const p = r.p;
    for (const d of DIMS) {
      if (d.dim === skip) continue;
      const want = st[d.dim];
      if (want && d.pick(p) !== want) return false;
    }
    if (st.video && !p.v) return false;
    if (st.sampled === 'original' && newIds.has(p.id)) return false;
    if (st.sampled === 'new' && !newIds.has(p.id)) return false;
    if (holeSet && !holeSet.has(p.id)) return false;
    for (const t of toks) if (!r.hay.includes(t)) return false;
    return true;
  }

  function sortKeyOf(r: Row, k: SortKey): string {
    const p = r.p;
    switch (k) {
      case 'title': return p.t.toLowerCase();
      case 'domain': return r.domLabel.toLowerCase();
      case 'move': return p.mv;
      case 'material': return p.mt;
      case 'for': return p.fr;
      case 'source': return r.host;
      case 'date': return p.dt ?? '';
    }
  }

  function recompute(): void {
    const toks = tokens(st.q);
    const out: number[] = [];
    for (let i = 0; i < rows.length; i++) if (pass(rows[i] as Row, 'none', toks)) out.push(i);
    if (st.sort) {
      const { key, dir } = st.sort;
      out.sort((a, b) => {
        const ra = rows[a] as Row;
        const rb = rows[b] as Row;
        const ka = sortKeyOf(ra, key);
        const kb = sortKeyOf(rb, key);
        if (key === 'date') {
          if (!ka && !kb) return a - b;
          if (!ka) return 1; // undated rows always last
          if (!kb) return -1;
        }
        return ka < kb ? -dir : ka > kb ? dir : a - b;
      });
    }
    view = out;
    // faceted counts: each dimension counted with the other filters applied
    for (const d of DIMS) {
      const counts = new Map<string, number>();
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] as Row;
        if (!pass(r, d.dim, toks)) continue;
        const v = d.pick(r.p);
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      fillSelect(d, counts);
    }
  }

  function optionsFor(d: (typeof DIMS)[number]): string[] {
    if (d.dim === 'domain') {
      const c = new Map<string, number>();
      for (const p of points) c.set(p.d, (c.get(p.d) ?? 0) + 1);
      return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
    }
    const axis = d.dim as AxisName;
    return data.facets.axes[axis].map((v) => v.value);
  }
  const optionCache = new Map<Dim, string[]>(DIMS.map((d) => [d.dim, optionsFor(d)]));

  function fillSelect(d: (typeof DIMS)[number], counts: Map<string, number>): void {
    const sel = sels.get(d.dim) as HTMLSelectElement;
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const vals = optionCache.get(d.dim) as string[];
    const cur = st[d.dim];
    const lab = (v: string) => (d.dim === 'domain' ? domainLabel(v) : v);
    const opts = [`<option value="">${esc(d.all)} (${fmtN(total)})</option>`];
    for (const v of vals) {
      const n = counts.get(v) ?? 0;
      opts.push(`<option value="${esc(v)}"${v === cur ? ' selected' : ''}${n === 0 && v !== cur ? ' disabled' : ''}>${esc(lab(v))} (${fmtN(n)})</option>`);
    }
    if (cur && !vals.includes(cur)) opts.push(`<option value="${esc(cur)}" selected>${esc(cur)} (0)</option>`);
    sel.innerHTML = opts.join('');
    sel.value = cur;
    sel.classList.toggle('on', !!cur);
  }

  function fillHoleSelect(): void {
    const opt = (h: Hole) => `<option value="${esc(h.code)}"${h.code === st.hole ? ' selected' : ''}>${esc(h.code)} · ${esc(cellLabel(h))}</option>`;
    const reg = data.holes.filter((h) => h.prereg);
    const expl = data.holes.filter((h) => !h.prereg);
    holeIn.innerHTML = `<option value="">Any hole</option><optgroup label="Registered (${reg.length})">${reg.map(opt).join('')}</optgroup>${expl.length ? `<optgroup label="Found after pooling, exploratory (${expl.length})">${expl.map(opt).join('')}</optgroup>` : ''}`;
    holeIn.value = st.hole;
    holeIn.classList.toggle('on', !!st.hole);
  }

  /* ---- status line, chips */
  function renderStatus(): void {
    const n = view.length;
    const filtered = n !== points.length;
    countEl.innerHTML = `<b>${fmtN(n)}</b> of ${fmtN(points.length)} report${points.length === 1 ? '' : 's'}${filtered ? ' match' : ''}`;
    const chips: string[] = [];
    const chip = (k: string, label: string) => `<button type="button" class="cat-chip" data-clear="${k}" aria-label="Remove filter ${esc(label)}">${esc(label)}<span aria-hidden="true">×</span></button>`;
    if (st.q) chips.push(chip('q', `“${st.q}”`));
    for (const d of DIMS) if (st[d.dim]) chips.push(chip(d.dim, `${d.label.toLowerCase()}: ${d.dim === 'domain' ? domainLabel(st.domain) : st[d.dim]}`));
    if (st.video) chips.push(chip('video', 'from the video'));
    if (st.sampled) chips.push(chip('sampled', `${st.sampled} sample`));
    if (st.hole) {
      const h = holeByCode.get(st.hole);
      chips.push(chip('hole', `${st.hole}: reports carrying either side of ${h ? cellLabel(h) : 'the hole'}`));
    }
    if (chips.length > 1 || st.sort) chips.push(`<button type="button" class="cat-clear" data-clear="all">Clear all</button>`);
    chipsEl.innerHTML = chips.join('');
  }

  function renderSortHeaders(): void {
    head.querySelectorAll<HTMLButtonElement>('.cat-sort').forEach((b) => {
      const on = st.sort && st.sort.key === b.dataset.sort;
      b.parentElement?.setAttribute('aria-sort', on ? (st.sort?.dir === 1 ? 'ascending' : 'descending') : 'none');
      b.dataset.dir = on ? (st.sort?.dir === 1 ? 'asc' : 'desc') : '';
    });
  }

  /* ---- windowed rows */
  function rowHTML(vi: number): string {
    const r = rows[view[vi] as number] as Row;
    const p = r.p;
    const tag = (dim: Dim, v: string) => `<button type="button" class="cat-tag${st[dim] === v ? ' on' : ''}" data-dim="${dim}" data-v="${esc(v)}" title="Only ${esc(v)}">${esc(v)}</button>`;
    return `<div class="cat-row ${cols}${selected === view[vi] ? ' sel' : ''}" role="row" aria-rowindex="${vi + 2}" data-i="${view[vi]}" style="top:${vi * rowH()}px">
  <span class="cat-c cat-report" role="cell"><button type="button" class="cat-open" data-i="${view[vi]}">${esc(p.t)}</button><span class="cat-tx">${esc(p.tx)}</span><span class="cat-m" aria-hidden="true"><span>${esc(r.domLabel)}${p.v ? ' · video' : ''}</span><span>${esc(p.mv)} · ${esc(p.mt)} · ${esc(p.fr)}</span><span>${esc(r.host)}${p.dt ? ` · ${esc(p.dt)}` : ''}</span></span></span>
  <span class="cat-c cat-dom" role="cell" title="${esc(p.d)}">${esc(r.domLabel)}</span>
  <span class="cat-c" role="cell">${tag('move', p.mv)}</span>
  <span class="cat-c" role="cell">${tag('material', p.mt)}</span>
  <span class="cat-c" role="cell">${tag('for', p.fr)}</span>
  <span class="cat-c cat-src" role="cell"><a href="${esc(p.s)}" target="_blank" rel="noopener noreferrer" title="${esc(p.s)}">${esc(r.host)}<span aria-hidden="true"> ↗</span><span class="sr"> (opens the source)</span></a>${p.w ? `<small>${esc(p.w)}</small>` : ''}</span>
  <span class="cat-c cat-date num" role="cell">${p.dt ? esc(p.dt) : '<span class="cat-dash">–</span>'}</span>
  <span class="cat-c" role="cell">${p.v ? '<span class="cat-vid" title="Listed in the video">video</span>' : '<span class="cat-dash">–</span>'}</span>
  ${hasNew ? `<span class="cat-c cat-g" role="cell">${p.g ? `<span class="mono">${esc(p.g)}</span>` : '<span class="cat-dash">–</span>'}</span>` : ''}
</div>`;
  }

  let raf = 0;
  function renderWindow(): void {
    raf = 0;
    const n = view.length;
    const RH = rowH();
    body.style.height = `${n * RH}px`;
    if (!n) {
      rowsEl.innerHTML = `<div class="cat-empty"><p><b>No report matches.</b></p><p>Try fewer words, or <button type="button" class="cat-clear" data-clear="all">clear all filters</button>.</p></div>`;
      body.style.height = '220px';
      return;
    }
    const vh = scroll.clientHeight;
    const top = Math.max(0, scroll.scrollTop - head.offsetHeight);
    const start = Math.max(0, Math.floor(top / RH) - OVERSCAN);
    const end = Math.min(n, Math.ceil((top + vh) / RH) + OVERSCAN);
    const html: string[] = [];
    for (let i = start; i < end; i++) html.push(rowHTML(i));
    rowsEl.innerHTML = html.join('');
  }
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(renderWindow);
  };

  function refresh(resetScroll: boolean): void {
    resolveHole();
    fillHoleSelect();
    recompute();
    renderStatus();
    renderSortHeaders();
    writeUrl(st);
    if (resetScroll) scroll.scrollTop = 0;
    renderWindow();
  }

  /* ---- detail drawer */
  function openDrawer(i: number, from: HTMLElement | null): void {
    const r = rows[i] as Row;
    const p = r.p;
    selected = i;
    opener = from;
    const fac = (label: string, axis: AxisName, v: string) => {
      const def = defs.get(`${axis}|${v}`);
      return `<div class="cat-fac"><dt>${label}</dt><dd><b>${esc(v)}</b>${def ? `<span>${esc(def)}</span>` : ''}</dd></div>`;
    };
    drawer.hidden = false;
    drawer.innerHTML = `
<div class="cat-dr-in">
  <div class="cat-dr-top"><span class="eyebrow">${esc(r.domLabel)}${p.v ? ' · from the video' : ''}</span><button type="button" class="cat-close" id="cat-close" aria-label="Close detail">×</button></div>
  <h2 class="cat-dr-h">${esc(p.t)}</h2>
  <p class="cat-dr-tx">${esc(p.tx)}</p>
  <dl class="cat-facs">
    ${fac('Move', 'move', p.mv)}
    ${fac('Material', 'material', p.mt)}
    ${fac('For', 'for', p.fr)}
  </dl>
  <dl class="cat-meta">
    <div><dt>Source</dt><dd><a href="${esc(p.s)}" target="_blank" rel="noopener noreferrer">${esc(r.host)} ↗</a></dd></div>
    ${p.w ? `<div><dt>Who</dt><dd>${esc(p.w)}</dd></div>` : ''}
    ${p.dt ? `<div><dt>Date</dt><dd class="num">${esc(p.dt)}</dd></div>` : ''}
    <div><dt>Read at source</dt><dd>${p.c === 'seen' ? 'yes, we read the page' : 'no, known through a roundup or article'}</dd></div>
    ${p.g ? `<div><dt>Sampled by</dt><dd class="num">${esc(p.g)}</dd></div>` : ''}
    <div><dt>ID</dt><dd class="num">${esc(p.id)}</dd></div>
  </dl>
  <p class="cat-dr-url num">${esc(p.s)}</p>
</div>`;
    document.body.classList.add('cat-drawer-open');
    renderWindow();
    (drawer.querySelector('#cat-close') as HTMLElement | null)?.focus();
  }
  function closeDrawer(): void {
    if (selected == null) return;
    selected = null;
    drawer.hidden = true;
    drawer.innerHTML = '';
    document.body.classList.remove('cat-drawer-open');
    renderWindow();
    const back = opener && el.contains(opener) ? opener : scroll;
    back.focus({ preventScroll: true });
    opener = null;
  }

  /* ---- events */
  el.querySelector('form')?.addEventListener('submit', (e) => e.preventDefault());
  let qTimer = 0;
  qIn.addEventListener('input', () => {
    window.clearTimeout(qTimer);
    qTimer = window.setTimeout(() => {
      st.q = qIn.value.trim();
      refresh(true);
    }, 110);
  });
  sels.forEach((sel, dim) => sel.addEventListener('change', () => {
    st[dim] = sel.value;
    refresh(true);
  }));
  videoIn.addEventListener('change', () => {
    st.video = videoIn.checked;
    refresh(true);
  });
  holeIn.addEventListener('change', () => {
    st.hole = holeIn.value;
    refresh(true);
  });
  sampledIn?.addEventListener('change', () => {
    st.sampled = sampledIn.value as State['sampled'];
    refresh(true);
  });
  scroll.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);

  head.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.cat-sort');
    if (!b) return;
    const key = b.dataset.sort as SortKey;
    if (!st.sort || st.sort.key !== key) st.sort = { key, dir: 1 };
    else if (st.sort.dir === 1) st.sort = { key, dir: -1 };
    else st.sort = null;
    refresh(true);
  });

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const clear = t.closest<HTMLElement>('[data-clear]');
    if (clear) {
      const k = clear.dataset.clear as string;
      if (k === 'all') Object.assign(st, emptyState());
      else if (k === 'q') st.q = '';
      else if (k === 'video') st.video = false;
      else if (k === 'sampled') st.sampled = '';
      else if (k === 'hole') st.hole = '';
      else if (k === 'domain' || k === 'move' || k === 'material' || k === 'for') st[k] = '';
      qIn.value = st.q;
      videoIn.checked = st.video;
      if (sampledIn) sampledIn.value = st.sampled;
      refresh(true);
      return;
    }
    const tag = t.closest<HTMLButtonElement>('.cat-tag');
    if (tag) {
      const dim = tag.dataset.dim as Dim;
      st[dim] = st[dim] === tag.dataset.v ? '' : (tag.dataset.v as string);
      refresh(true);
      return;
    }
    if (t.closest('a')) return;
    const open = t.closest<HTMLElement>('.cat-open');
    const row = t.closest<HTMLElement>('.cat-row');
    if (open || row) {
      const i = Number((open ?? (row as HTMLElement)).dataset.i);
      if (!Number.isNaN(i)) openDrawer(i, (open ?? row) as HTMLElement);
      return;
    }
    if (t.closest('#cat-close')) closeDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected != null) closeDrawer();
  });

  /* ---- start */
  qIn.value = st.q;
  videoIn.checked = st.video;
  if (sampledIn) sampledIn.value = st.sampled;
  refresh(false);
}
