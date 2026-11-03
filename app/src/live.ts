// LIVE layer: new Hacker News stories mentioning Claude, embedded in the browser and placed on the globe.
//
// The recipe is the one frozen in public/data/live_index.json (scripts/place_on_globe.py wrote it and checked it):
//   embed   Xenova/bge-small-en-v1.5, CLS pooling, normalised, no prefix
//   vector  v = normalize(embedding - mean)
//   index   int8 rows, dequantised with the per-dimension scale and L2-normalised once at load
//   8-NN    cosine, weights w_j = max(cos_j - cos_8 + 0.02, 1e-9)
//   place   p = normalize(sum w_j xyz_j) ; R = |sum w_j xyz_j| / sum w_j (neighbour agreement, the confidence)
//   facets  majority vote of the 8 neighbours' tags (ties: larger summed weight)
//
// This file has two halves. The first (index, recipe, selftest) is plain TypeScript with no DOM, so Node can run the
// selftest too. The second (HN fetch, the model, the drawer, the toasts) needs the browser. The model library is imported
// dynamically, so nothing here weighs on the main bundle until LIVE is switched on.

/* ================================================================== types */

export interface Guess {
  value: string | null;
  votes: number;
  of: number;
}

export type Conf = 'high' | 'medium' | 'low';

export interface LiveIndexFile {
  version: number;
  n: number;
  dims: number;
  scale: number[];
  ids: string[];
  mean: number[];
  recipe: { neighbours: number; weights: { tau: number } };
  validation: {
    placement_error_deg: { median: number; p90: number };
    by_neighbour_agreement: { bins: { bin: string; median_deg: number }[] };
    facet_guess: Record<'move' | 'material' | 'for', { accuracy: number; by_vote_share: { winning_votes: string; accuracy: number }[] }>;
  };
  selftest: { cases: SelftestCase[] };
}

export interface SelftestCase {
  item: string;
  skip_row: number;
  vector: number[];
  neighbours: string[];
  cos: number[];
  weights: number[];
  lat: number;
  lon: number;
}

export interface TagSet {
  mv: string | null | undefined;
  mt: string | null | undefined;
  fr: string | null | undefined;
}

export interface LiveIndex {
  meta: LiveIndexFile;
  n: number;
  d: number;
  /** dequantised, row-normalised, row-major (n, d) */
  rows: Float32Array;
  mean: Float32Array;
  ids: string[];
  /** x, y, z per row in the recipe's convention (z up) */
  xyz: Float32Array;
  tags: TagSet[];
}

export interface Placement {
  lat: number;
  lon: number;
  R: number;
  nn: { id: string; cos: number; w: number }[];
  mv: Guess;
  mt: Guess;
  fr: Guess;
}

export interface LiveStory {
  id: string;
  title: string;
  url: string | null;
  text: string | null;
  created: number;
  points: number | null;
  comments: number | null;
}

/** one placed story, as the drawer and the globe both use it */
export interface LivePlaced {
  id: string;
  title: string;
  url: string | null;
  created: number;
  lat: number;
  lon: number;
  R: number;
  conf: Conf;
  mv: Guess;
  mt: Guess;
  fr: Guess;
  /** hole code when the guessed cell, with at least 6 of 8 votes on both axes, is a hole cell */
  filler: string | null;
  /** least of the two vote counts behind the filler guess */
  fillerVotes: number;
}

export interface HoleCell {
  code: string;
  axes: [string, string];
  cell: Record<string, string>;
  /** the replication verdict, when there is one */
  verdict?: string;
}

export interface LiveHost {
  base: string;
  /** the console element: the drawer and the toasts are appended to it */
  mount: HTMLElement;
  lonlat: (id: string) => [number, number] | undefined;
  tags: (id: string) => TagSet | undefined;
  holes: HoleCell[];
  /** the globe replaces its comets with these (newest first) and plays the drop */
  setItems: (items: LivePlaced[]) => void;
  flashHole: (code: string) => void;
  flyTo: (lat: number, lon: number) => void;
  /** the drawer opened or closed: the globe re-fits itself above it */
  relayout: () => void;
  /** LIVE was closed from inside the drawer */
  closed: () => void;
}

export interface LiveCtl {
  setActive: (on: boolean) => void;
  select: (id: string | null) => void;
  hover: (id: string | null) => void;
}

const D2R = Math.PI / 180;
const K = 8;
const TAU = 0.02;

/* ================================================================== the recipe (no DOM) */

export async function loadIndex(
  base: string,
  lonlat: (id: string) => [number, number] | undefined,
  tags: (id: string) => TagSet | undefined,
  fetcher: (url: string) => Promise<Response> = fetch,
): Promise<LiveIndex> {
  const [jr, br] = await Promise.all([fetcher(`${base}data/live_index.json`), fetcher(`${base}data/live_index.bin`)]);
  if (!jr.ok || !br.ok) throw new Error('live index not found');
  const meta = (await jr.json()) as LiveIndexFile;
  const q = new Int8Array(await br.arrayBuffer());
  const n = meta.n;
  const d = meta.dims;
  if (q.length !== n * d) throw new Error(`live_index.bin is ${q.length} bytes, expected ${n * d}`);
  const rows = new Float32Array(n * d);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * d;
    for (let k = 0; k < d; k++) {
      const v = (q[o + k] as number) * (meta.scale[k] as number);
      rows[o + k] = v;
      s += v * v;
    }
    const inv = 1 / (Math.sqrt(s) || 1);
    for (let k = 0; k < d; k++) rows[o + k] = (rows[o + k] as number) * inv;
  }
  const xyz = new Float32Array(n * 3);
  const tg: TagSet[] = [];
  meta.ids.forEach((id, i) => {
    const ll = lonlat(id);
    if (ll) {
      const la = ll[0] * D2R;
      const lo = ll[1] * D2R;
      xyz[i * 3] = Math.cos(la) * Math.cos(lo);
      xyz[i * 3 + 1] = Math.cos(la) * Math.sin(lo);
      xyz[i * 3 + 2] = Math.sin(la);
    }
    tg.push(tags(id) ?? { mv: null, mt: null, fr: null });
  });
  return { meta, n, d, rows, mean: Float32Array.from(meta.mean), ids: meta.ids, xyz, tags: tg };
}

/** v = normalize(embedding - mean) */
export function centre(idx: LiveIndex, emb: ArrayLike<number>): Float32Array {
  const v = new Float32Array(idx.d);
  let s = 0;
  for (let k = 0; k < idx.d; k++) {
    const x = (emb[k] as number) - (idx.mean[k] as number);
    v[k] = x;
    s += x * x;
  }
  const inv = 1 / (Math.sqrt(s) || 1);
  for (let k = 0; k < idx.d; k++) v[k] = (v[k] as number) * inv;
  return v;
}

function vote(idx: LiveIndex, nn: { i: number; w: number }[], key: keyof TagSet): Guess {
  const tally = new Map<string, { n: number; w: number }>();
  nn.forEach(({ i, w }) => {
    const t = (idx.tags[i] as TagSet)[key];
    if (!t) return;
    const e = tally.get(t) ?? { n: 0, w: 0 };
    e.n += 1;
    e.w += w;
    tally.set(t, e);
  });
  let best: string | null = null;
  let bn = 0;
  let bw = 0;
  tally.forEach((e, t) => {
    if (e.n > bn || (e.n === bn && e.w > bw)) {
      best = t;
      bn = e.n;
      bw = e.w;
    }
  });
  return { value: best, votes: bn, of: nn.length };
}

/** The 8 nearest rows by cosine, the weights, the position, R and the facet votes. `skip` leaves one corpus row out (validation only). */
export function place(idx: LiveIndex, vec: Float32Array, skip = -1): Placement {
  const { rows, n, d } = idx;
  const top: { i: number; c: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (i === skip) continue;
    let c = 0;
    const o = i * d;
    for (let k = 0; k < d; k++) c += (rows[o + k] as number) * (vec[k] as number);
    if (top.length < K) {
      top.push({ i, c });
      top.sort((a, b) => b.c - a.c);
    } else if (c > (top[K - 1] as { c: number }).c) {
      top[K - 1] = { i, c };
      top.sort((a, b) => b.c - a.c);
    }
  }
  const ck = (top[top.length - 1] as { c: number }).c;
  const nn = top.map((t) => ({ i: t.i, c: t.c, w: Math.max(t.c - ck + TAU, 1e-9) }));
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let sw = 0;
  nn.forEach(({ i, w }) => {
    sx += w * (idx.xyz[i * 3] as number);
    sy += w * (idx.xyz[i * 3 + 1] as number);
    sz += w * (idx.xyz[i * 3 + 2] as number);
    sw += w;
  });
  const len = Math.hypot(sx, sy, sz) || 1;
  const px = sx / len;
  const py = sy / len;
  const pz = sz / len;
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, pz))) / D2R,
    lon: Math.atan2(py, px) / D2R,
    R: len / (sw || 1),
    nn: nn.map((t) => ({ id: idx.ids[t.i] as string, cos: t.c, w: t.w })),
    mv: vote(idx, nn, 'mv'),
    mt: vote(idx, nn, 'mt'),
    fr: vote(idx, nn, 'fr'),
  };
}

export const confOf = (R: number): Conf => (R >= 0.9 ? 'high' : R >= 0.7 ? 'medium' : 'low');

/** The guess is a hole-filler when two axes of it, each with at least 6 of 8 votes, name a hole cell. */
export function fillerOf(p: { mv: Guess; mt: Guess; fr: Guess }, holes: HoleCell[]): { code: string; votes: number } | null {
  const strong = (g: Guess): boolean => !!g.value && g.votes >= 6;
  const pairs: [string, Guess, string, Guess][] = [
    ['material', p.mt, 'for', p.fr],
    ['move', p.mv, 'material', p.mt],
  ];
  for (const [a, ga, b, gb] of pairs) {
    if (!strong(ga) || !strong(gb)) continue;
    const h = holes.find((x) => x.axes.includes(a) && x.axes.includes(b) && x.cell[a] === ga.value && x.cell[b] === gb.value);
    if (h) return { code: h.code, votes: Math.min(ga.votes, gb.votes) };
  }
  return null;
}

export interface SelftestResult {
  ok: boolean;
  passed: number;
  total: number;
  maxDeg: number;
  problems: string[];
}

function greatCircleDeg(la1: number, lo1: number, la2: number, lo2: number): number {
  const a = la1 * D2R;
  const b = la2 * D2R;
  const c = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos((lo1 - lo2) * D2R);
  return Math.acos(Math.max(-1, Math.min(1, c))) / D2R;
}

/** The cases in live_index.json: the query vector is already centred, one corpus row is left out, the 8 neighbours,
 *  their cosines and weights and the position must come out as the script wrote them. */
export function selftest(idx: LiveIndex): SelftestResult {
  const problems: string[] = [];
  let maxDeg = 0;
  let passed = 0;
  const cases = idx.meta.selftest.cases;
  cases.forEach((c) => {
    const bad: string[] = [];
    const r = place(idx, Float32Array.from(c.vector), c.skip_row);
    const ids = r.nn.map((x) => x.id);
    if (ids.join('|') !== c.neighbours.join('|')) bad.push(`neighbours ${ids.join(',')} != ${c.neighbours.join(',')}`);
    r.nn.forEach((x, j) => {
      if (Math.abs(x.cos - (c.cos[j] as number)) > 2e-4) bad.push(`cos[${j}] ${x.cos.toFixed(5)} != ${c.cos[j]}`);
      if (Math.abs(x.w - (c.weights[j] as number)) > 2e-4) bad.push(`w[${j}] ${x.w.toFixed(5)} != ${c.weights[j]}`);
    });
    const dg = greatCircleDeg(r.lat, r.lon, c.lat, c.lon);
    maxDeg = Math.max(maxDeg, dg);
    if (dg > 0.05) bad.push(`position off by ${dg.toFixed(3)} deg`);
    if (bad.length) problems.push(`${c.item}: ${bad.join('; ')}`);
    else passed++;
  });
  return { ok: passed === cases.length && cases.length > 0, passed, total: cases.length, maxDeg, problems };
}

/** Dev only (globe.ts calls it once under import.meta.env.DEV): load the index and log the selftest. */
export async function runSelftest(
  base: string,
  lonlat: (id: string) => [number, number] | undefined,
  tags: (id: string) => TagSet | undefined,
): Promise<SelftestResult> {
  const idx = await loadIndex(base, lonlat, tags);
  const r = selftest(idx);
  const msg = `[live selftest] ${r.passed}/${r.total} cases pass, positions within ${r.maxDeg.toFixed(4)} deg of the script`;
  if (r.ok) console.info(msg);
  else console.error(msg, r.problems);
  return r;
}

/* ================================================================== stories and the model (browser) */

const HN_URL = 'https://hn.algolia.com/api/v1/search_by_date?query=claude&tags=story&hitsPerPage=40';
const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const MODEL_BYTES = 33e6;

interface HnHit {
  objectID: string;
  title?: string | null;
  url?: string | null;
  story_text?: string | null;
  created_at_i?: number;
  points?: number | null;
  num_comments?: number | null;
}

export async function fetchStories(): Promise<LiveStory[]> {
  const res = await fetch(HN_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HN Algolia answered ${res.status}`);
  const j = (await res.json()) as { hits?: HnHit[] };
  return (j.hits ?? [])
    .filter((h) => h.title && h.created_at_i)
    .map((h) => ({
      id: h.objectID,
      title: String(h.title),
      url: h.url ?? null,
      text: h.story_text ?? null,
      created: h.created_at_i as number,
      points: h.points ?? null,
      comments: h.num_comments ?? null,
    }));
}

const stripHtml = (s: string): string => s.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

/** the title, plus the story text when HN has one (truncated; the model reads at most 512 tokens anyway) */
export const storyText = (s: LiveStory): string => (s.text ? `${s.title}. ${stripHtml(s.text).slice(0, 600)}` : s.title);

export interface Progress {
  status: string;
  loaded: number;
  total: number;
}
type Embedder = (texts: string[]) => Promise<Float32Array[]>;
let embedderP: Promise<Embedder> | null = null;

interface TFOutput {
  data: Float32Array;
  dims: number[];
}
interface TFModule {
  env: { allowLocalModels: boolean; useBrowserCache?: boolean; backends: { onnx: { wasm?: { wasmPaths?: unknown }; versions?: { web?: string } } } };
  pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<(t: string[], o: Record<string, unknown>) => Promise<TFOutput>>;
}

export function loadEmbedder(onProgress: (p: Progress) => void): Promise<Embedder> {
  if (embedderP) return embedderP;
  embedderP = (async () => {
    const tf = (await import('@huggingface/transformers')) as unknown as TFModule;
    tf.env.allowLocalModels = false;
    const files = new Map<string, { loaded: number; total: number }>();
    const progress_callback = (e: { status?: string; file?: string; loaded?: number; total?: number }): void => {
      if (e.file && typeof e.total === 'number' && typeof e.loaded === 'number') files.set(e.file, { loaded: e.loaded, total: e.total });
      let loaded = 0;
      let total = 0;
      files.forEach((f) => {
        loaded += f.loaded;
        total += f.total;
      });
      onProgress({ status: e.status ?? '', loaded, total: Math.max(total, MODEL_BYTES * 0.97) });
    };
    // The ONNX runtime's wasm ships with the app (served from our own origin, fetched only now). If that copy cannot be used,
    // the library's own default, the jsDelivr copy of the same runtime version, is the fallback.
    const wasm = tf.env.backends.onnx.wasm;
    const cdn = wasm?.wasmPaths;
    let local = false;
    try {
      const url = (await import('../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url')).default;
      if (wasm && url) {
        wasm.wasmPaths = { wasm: url };
        local = true;
      }
    } catch {
      /* no bundled copy: use the default */
    }
    let pipe;
    try {
      pipe = await tf.pipeline('feature-extraction', MODEL_ID, { dtype: 'q8', progress_callback });
    } catch (err) {
      if (!local || !wasm) throw err;
      console.warn('LIVE: the bundled wasm runtime failed, trying the CDN copy', err);
      wasm.wasmPaths = cdn;
      pipe = await tf.pipeline('feature-extraction', MODEL_ID, { dtype: 'q8', progress_callback });
    }
    return async (texts: string[]): Promise<Float32Array[]> => {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 8) {
        const t = await pipe(texts.slice(i, i + 8), { pooling: 'cls', normalize: true });
        const dim = t.dims[t.dims.length - 1] as number;
        for (let r = 0; r < (t.dims[0] as number); r++) out.push(t.data.slice(r * dim, (r + 1) * dim));
      }
      return out;
    };
  })();
  embedderP.catch(() => {
    embedderP = null;
  });
  return embedderP;
}

/* ================================================================== the drawer */

const CACHE_KEY = 'overhang-live-v1';
const CACHE_FRESH_MS = 10 * 60 * 1000;

interface Cache {
  at: number;
  items: LivePlaced[];
}

function readCache(): Cache | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cache;
    return Array.isArray(c.items) && typeof c.at === 'number' ? c : null;
  } catch {
    return null;
  }
}
function writeCache(c: Cache): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* storage blocked or full: LIVE just refetches next time */
  }
}

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const safeHref = (u: string | null | undefined): string => (u && /^https?:\/\//i.test(u) ? u : '');

function ago(sec: number): string {
  const d = Math.max(0, Date.now() / 1000 - sec);
  if (d < 90) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
}

const pct = (x: number): string => `${Math.round(x * 100)}`;

function footnote(m: LiveIndexFile | null): string {
  const v = m?.validation;
  if (!v) return 'These are guesses from the 8 nearest reports. Measured accuracy is in the methods.';
  const fg = v.facet_guess;
  const top = (a: { by_vote_share: { accuracy: number }[] }): number => (a.by_vote_share[a.by_vote_share.length - 1] as { accuracy: number }).accuracy;
  const worst = v.by_neighbour_agreement.bins[2];
  return `Guesses, not facts. Placement median error about ${v.placement_error_deg.median.toFixed(1)}° on corpus items (the recipe variant was picked for its lowest median error on this same leave-one-out run, so the figure is optimistic)${worst ? ` (${worst.median_deg.toFixed(0)}° when confidence is low)` : ''}. Facet guesses are right about ${pct(fg.move.accuracy)}% (move), ${pct(fg.material.accuracy)}% (material) and ${pct(fg.for.accuracy)}% (for) of the time overall, and about ${pct(top(fg.move))}%, ${pct(top(fg.material))}% and ${pct(top(fg.for))}% when 7–8 of 8 neighbours agree. A new story resembles the corpus less than a corpus item does, so expect worse.`;
}

const CONSENT_KEY = 'overhang-live-ok';
const hasConsent = (): boolean => {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
};
const grantConsent = (): void => {
  try {
    localStorage.setItem(CONSENT_KEY, '1');
  } catch {
    /* the question is asked again next time */
  }
};

export function createLive(host: LiveHost): LiveCtl {
  const el = host.mount;
  let active = false;
  let idx: LiveIndex | null = null;
  let items: LivePlaced[] = [];
  let busy = false;
  let selId: string | null = null;
  let built = false;
  let drawer: HTMLElement;
  let listEl: HTMLElement;
  let msgEl: HTMLElement;
  let statEl: HTMLElement;
  let toastEl: HTMLElement;
  let refreshBtn: HTMLButtonElement;
  let pendingAsk: ((ok: boolean) => void) | null = null;

  const indexP = (): Promise<LiveIndex> =>
    idx ? Promise.resolve(idx) : loadIndex(host.base, host.lonlat, host.tags).then((i) => (idx = i));

  function build(): void {
    if (built) return;
    built = true;
    drawer = document.createElement('section');
    drawer.className = 'gl-live compact';
    drawer.setAttribute('aria-label', 'LIVE: the newest Hacker News stories that mention Claude, placed on the globe');
    drawer.innerHTML = `
      <header class="gl-lv-hd">
        <span class="gl-lv-dot" aria-hidden="true"></span><b>LIVE</b>
        <span class="gl-lv-sub">Hacker News, newest stories mentioning Claude, placed like the corpus</span>
        <span class="sp"></span>
        <span class="gl-lv-stat" role="status" aria-live="polite"></span>
        <button type="button" class="gl-lv-btn" data-act="refresh" title="Fetch the newest stories again">&#8635; Refresh</button>
        <button type="button" class="gl-lv-btn x" data-act="close" aria-label="Close LIVE" title="Close LIVE">&times;</button>
      </header>
      <div class="gl-lv-msg" hidden></div>
      <div class="gl-lv-list" role="list" tabindex="0" aria-label="Stories, newest first"></div>
      <span class="gl-lv-arrow" aria-hidden="true">&rsaquo;</span>
      <p class="gl-lv-foot"></p>`;
    el.appendChild(drawer);
    toastEl = document.createElement('div');
    toastEl.className = 'gl-toasts';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    el.appendChild(toastEl);
    listEl = drawer.querySelector('.gl-lv-list') as HTMLElement;
    msgEl = drawer.querySelector('.gl-lv-msg') as HTMLElement;
    statEl = drawer.querySelector('.gl-lv-stat') as HTMLElement;
    refreshBtn = drawer.querySelector('[data-act="refresh"]') as HTMLButtonElement;
    (drawer.querySelector('.gl-lv-foot') as HTMLElement).textContent = footnote(null);
    const cue = (): void => { drawer.classList.toggle('more', listEl.scrollWidth - listEl.clientWidth - listEl.scrollLeft > 6); };
    listEl.addEventListener('scroll', cue, { passive: true });
    new ResizeObserver(cue).observe(listEl);
    drawer.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'refresh') void load(true);
      else if (act === 'close') {
        setActive(false);
        host.closed();
        return;
      }
      const card = t.closest<HTMLElement>('.gl-lv-card');
      if (card && !t.closest('a')) select(card.dataset.id ?? null, true);
    });
  }

  function setStatus(t: string): void {
    statEl.textContent = t;
  }
  function setMsg(html: string | null, kind = ''): void {
    msgEl.hidden = !html;
    msgEl.className = `gl-lv-msg ${kind}`.trim();
    if (html) msgEl.innerHTML = html;
  }

  const guessRow = (label: string, g: Guess): string => {
    const lo = g.votes <= 4;
    const w = Math.round((g.votes / g.of) * 100);
    return `<div class="gl-lv-g${lo ? ' lo' : ''}" title="${esc(g.value ?? 'no tag')}: ${g.votes} of ${g.of} neighbours${lo ? ' (a split vote: right only about half the time on the corpus)' : ''}"><small>${label}</small><span class="v">${esc(g.value ?? '–')}</span><span class="n"><i style="width:${w}%"></i></span><em>${g.votes}/${g.of}</em></div>`;
  };

  const binMedian = (c: Conf): string => {
    const b = idx?.meta.validation.by_neighbour_agreement.bins[c === 'high' ? 0 : c === 'medium' ? 1 : 2];
    return b ? `about ${b.median_deg.toFixed(0)}°` : 'see the methods';
  };

  function cardHTML(it: LivePlaced): string {
    const href = safeHref(it.url) || `https://news.ycombinator.com/item?id=${encodeURIComponent(it.id)}`;
    const confLabel = it.conf === 'high' ? 'HIGH' : it.conf === 'medium' ? 'MEDIUM' : 'LOW';
    return `<article class="gl-lv-card${it.filler ? ' fill' : ''}${selId === it.id ? ' sel' : ''}" role="listitem" tabindex="0" data-id="${esc(it.id)}">
      <div class="gl-lv-top"><time datetime="${new Date(it.created * 1000).toISOString()}" title="${esc(new Date(it.created * 1000).toLocaleString())}">${esc(ago(it.created))}</time><span class="gl-lv-pill ${it.conf}" title="Neighbour agreement R = ${it.R.toFixed(2)}: high at 0.9 or more, medium from 0.7, low below. Median placement error on the corpus at this confidence: ${binMedian(it.conf)}.">${confLabel} <span>R ${it.R.toFixed(2)}</span></span></div>
      <a class="gl-lv-ttl" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>
      ${guessRow('MOVE', it.mv)}${guessRow('MATERIAL', it.mt)}${guessRow('FOR', it.fr)}
      ${it.filler ? `<div class="gl-lv-hit" title="A guess with 6 or more of 8 votes on both axes that names a hole cell">possible filler &rarr; ${esc(it.filler)}</div>` : ''}
    </article>`;
  }

  function render(): void {
    listEl.innerHTML = items.map(cardHTML).join('');
    (drawer.querySelector('.gl-lv-foot') as HTMLElement).textContent = footnote(idx?.meta ?? null);
    // with nothing to list (loading, asking, an error) the drawer is a single strip; with cards it opens to full height
    const compact = items.length === 0;
    if (drawer.classList.contains('compact') !== compact) {
      drawer.classList.toggle('compact', compact);
      host.relayout();
    }
    listEl.dispatchEvent(new Event('scroll'));
  }

  /** first use: say what LIVE costs before anything is downloaded */
  function askConsent(): Promise<boolean> {
    return new Promise((resolve) => {
      pendingAsk = resolve;
      setStatus('waiting for you');
      setMsg('<span class="t"><b>Enable LIVE?</b> Downloads a 33 MB model, about 30 s, once. Reads the public Hacker News API.</span><button type="button" class="gl-lv-btn" data-ask="yes">Enable LIVE</button><button type="button" class="gl-lv-btn" data-ask="no">Not now</button>', 'ask');
      const on = (e: Event): void => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ask]');
        if (!b) return;
        msgEl.removeEventListener('click', on);
        pendingAsk = null;
        resolve(b.dataset.ask === 'yes');
      };
      msgEl.addEventListener('click', on);
    });
  }

  const refutedNote = (code: string): string =>
    host.holes.find((h) => h.code === code)?.verdict === 'refuted' ? '<small class="gl-toast-n">This cell was refuted at replication: the corpus already has reports in it.</small>' : '';

  function toast(it: LivePlaced): void {
    if (!it.filler) return;
    const t = document.createElement('div');
    t.className = 'gl-toast';
    const href = safeHref(it.url) || `https://news.ycombinator.com/item?id=${encodeURIComponent(it.id)}`;
    t.innerHTML = `<i aria-hidden="true"></i><span>Possible hole-filler: <a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a> &rarr; ${esc(it.filler)} <em>(guess, ${it.fillerVotes}/8 votes)</em>${refutedNote(it.filler)}</span><button type="button" aria-label="Dismiss">&times;</button>`;
    (t.querySelector('button') as HTMLElement).addEventListener('click', () => t.remove());
    toastEl.appendChild(t);
    while (toastEl.children.length > 3) toastEl.firstElementChild?.remove();
    window.setTimeout(() => t.remove(), 14000);
  }

  function announce(list: LivePlaced[]): void {
    const hits = list.filter((i) => i.filler);
    hits.slice(0, 3).forEach((it, k) => {
      window.setTimeout(() => {
        if (!active) return;
        host.flashHole(it.filler as string);
        toast(it);
      }, 1600 + k * 900);
    });
  }

  function placeOne(ix: LiveIndex, s: LiveStory, emb: Float32Array): LivePlaced {
    const p = place(ix, centre(ix, emb));
    const f = fillerOf(p, host.holes);
    return {
      id: s.id, title: s.title, url: s.url, created: s.created, lat: p.lat, lon: p.lon, R: p.R, conf: confOf(p.R),
      mv: p.mv, mt: p.mt, fr: p.fr, filler: f?.code ?? null, fillerVotes: f?.votes ?? 0,
    };
  }

  async function load(force: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    refreshBtn.disabled = true;
    try {
      const cache = readCache();
      if (!hasConsent() && !cache) {
        const ok = await askConsent();
        if (!ok) {
          setMsg(null);
          setActive(false);
          host.closed();
          return;
        }
        grantConsent();
      }
      if (cache && !force && Date.now() - cache.at < CACHE_FRESH_MS) {
        items = cache.items;
        render();
        setMsg(null);
        setStatus(`cached, ${ago(cache.at / 1000)}`);
        host.setItems(items);
        announce(items);
        void indexP().then(() => {
          (drawer.querySelector('.gl-lv-foot') as HTMLElement).textContent = footnote(idx?.meta ?? null);
        }).catch(() => undefined);
        return;
      }
      setMsg('Fetching the newest stories from Hacker News…', 'wait');
      setStatus('fetching');
      let stories: LiveStory[];
      try {
        stories = await fetchStories();
      } catch (err) {
        if (cache) {
          items = cache.items;
          render();
          host.setItems(items);
          setMsg(`Could not reach Hacker News just now (${esc((err as Error).message)}). Showing the stories from ${esc(ago(cache.at / 1000))}.`, 'warn');
          setStatus('offline, cached');
        } else {
          setMsg('<b>LIVE unavailable.</b> Hacker News could not be reached from this page (no network, or the browser blocked the request). Everything else on the globe works without it.', 'err');
          setStatus('unavailable');
          items = [];
          render();
          host.setItems([]);
        }
        return;
      }
      if (!stories.length) {
        setMsg('<b>LIVE unavailable.</b> Hacker News returned no stories that mention Claude.', 'err');
        setStatus('unavailable');
        return;
      }
      const known = new Map((cache?.items ?? []).map((i) => [i.id, i]));
      const fresh = stories.filter((s) => !known.has(s.id));
      const ix = await indexP();
      const placed = new Map<string, LivePlaced>();
      if (fresh.length) {
        let embed: Embedder;
        try {
          setStatus('loading model');
          setMsg(`<span class="gl-lv-bar"><i id="gl-lv-p" style="width:0%"></i></span>Embedding model loading (33 MB, once per browser)… <b id="gl-lv-pt">0%</b>`, 'wait');
          embed = await loadEmbedder((p) => {
            const f = Math.min(1, p.loaded / p.total);
            const bar = msgEl.querySelector<HTMLElement>('#gl-lv-p');
            const txt = msgEl.querySelector<HTMLElement>('#gl-lv-pt');
            if (bar) bar.style.width = `${(f * 100).toFixed(1)}%`;
            if (txt) txt.textContent = f >= 0.999 ? 'starting the model…' : `${(p.loaded / 1e6).toFixed(1)} of ${(p.total / 1e6).toFixed(0)} MB`;
          });
        } catch (err) {
          console.error('LIVE model failed', err);
          setMsg(`<b>LIVE unavailable.</b> The embedding model could not be loaded (${esc((err as Error).message || 'network or browser support')}). The stories are not placed.`, 'err');
          setStatus('unavailable');
          return;
        }
        setStatus('embedding');
        setMsg(`Embedding ${fresh.length} new stor${fresh.length === 1 ? 'y' : 'ies'}…`, 'wait');
        const embs = await embed(fresh.map(storyText));
        fresh.forEach((s, i) => placed.set(s.id, placeOne(ix, s, embs[i] as Float32Array)));
      }
      items = stories.map((s) => placed.get(s.id) ?? (known.get(s.id) as LivePlaced)).filter(Boolean).sort((a, b) => b.created - a.created);
      writeCache({ at: Date.now(), items });
      setMsg(null);
      setStatus(`${items.length} stories, ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
      render();
      host.setItems(items);
      announce(fresh.length ? items.filter((i) => placed.has(i.id)) : items);
    } catch (err) {
      console.error('LIVE failed', err);
      setMsg(`<b>LIVE unavailable.</b> ${esc((err as Error).message)}`, 'err');
      setStatus('unavailable');
    } finally {
      busy = false;
      refreshBtn.disabled = false;
    }
  }

  function select(id: string | null, fly = false): void {
    selId = id;
    listEl.querySelectorAll<HTMLElement>('.gl-lv-card').forEach((c) => c.classList.toggle('sel', c.dataset.id === id));
    if (!id) return;
    const it = items.find((i) => i.id === id);
    const card = listEl.querySelector<HTMLElement>(`.gl-lv-card[data-id="${CSS.escape(id)}"]`);
    if (card) {
      const l = card.offsetLeft - listEl.offsetLeft;
      if (l < listEl.scrollLeft || l + card.offsetWidth > listEl.scrollLeft + listEl.clientWidth) listEl.scrollTo({ left: Math.max(0, l - 8), behavior: 'smooth' });
      if (listEl.scrollHeight > listEl.clientHeight + 4) card.scrollIntoView({ block: 'nearest' });
    }
    if (fly && it) host.flyTo(it.lat, it.lon);
  }

  function setActive(on: boolean): void {
    active = on;
    if (on) {
      build();
      // the styles load with the drawer, so it opens only once they are in
      void import('./styles/live.css').catch(() => undefined).then(() => {
        if (!active) return;
        drawer.classList.add('open');
        host.relayout();
        void load(false);
      });
    } else if (built) {
      pendingAsk?.(false);
      drawer.classList.remove('open');
      toastEl.innerHTML = '';
      host.setItems([]);
      host.relayout();
    }
  }

  return {
    setActive,
    select: (id) => select(id, false),
    hover: (id) => {
      if (!built) return;
      listEl.querySelectorAll<HTMLElement>('.gl-lv-card').forEach((c) => c.classList.toggle('hov', !!id && c.dataset.id === id));
    },
  };
}
