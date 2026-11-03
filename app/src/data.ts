// Typed loaders for the data contract (files in public/data/, fetched from /data/*.json).
// The app must work for any N: nothing here assumes 514, 36, 16, or any fixed axis size.

export type RunId = 'r1' | 'r2';
export type ReplicationStatus = 'pending' | 'done';
export type AxisName = 'move' | 'material' | 'for';
export type TableKey = 'move×material' | 'move×for' | 'material×for';

export interface Kappa {
  move: number;
  material: number;
  for: number;
}

export interface Meta {
  N: number;
  N_r1: number;
  run: RunId;
  kappa: { r1: Kappa; grow: Kappa | null };
  models: string[];
  pca: number;
  k: number;
  prereg_commit: string;
  repo_url: string;
  /** true once repo_url is public; the commit and source links are shown only then */
  repo_published?: boolean;
  video: { title: string; channel: string; url: string };
  generated: string;
  replication_status: ReplicationStatus;
}

export interface Point {
  id: string;
  /** title */
  t: string;
  /** text */
  tx: string;
  /** domain */
  d: string;
  /** from_video */
  v: boolean;
  /** source url */
  s: string;
  /** who */
  w: string | null;
  /** date */
  dt: string | null;
  /** confidence */
  c: string;
  /** UMAP 2D */
  x: number;
  y: number;
  /** facet values: move, material, for */
  mv: string;
  mt: string;
  fr: string;
  /** sampled_by; null for the original sample */
  g: string | null;
}

export interface AxisValue {
  value: string;
  definition: string;
}

export interface FacetTable {
  rows: string[];
  cols: string[];
  observed: number[][];
  expected: number[][];
  expected_indep: number[][];
  structural: boolean[][];
  q: (number | null)[][];
}

export interface Facets {
  axes: Record<AxisName, AxisValue[]>;
  tables: Record<TableKey, FacetTable>;
}

/** The values at registration (first pass over the original reports), kept next to the pooled ones. */
export interface HoleRegistered {
  observed: number;
  E: number;
  E_indep: number;
  p: number | null;
  stability: number | null;
  tag_robust: boolean;
  knn_pct: number | null;
  N: number | null;
}

export interface HoleReplication {
  verdict: string;
  observed_new: number;
  E_new: number;
  p_new: number;
  observed_pooled: number;
  E_pooled: number;
  q_pooled: number;
}

export interface HoleConcept {
  title: string;
  text: string;
  pitch: string;
}

export interface PriorArtHit {
  url: string;
  what: string;
  how_close: string;
}

export interface PriorArt {
  verdict: string;
  closest: PriorArtHit[];
}

export interface Hole {
  /** stable catalog code, e.g. "OV-01" */
  code: string;
  /** gapfind id */
  id: string;
  axes: [AxisName, AxisName];
  /** { [axisA]: value, [axisB]: value } */
  cell: Record<string, string>;
  observed: number;
  E: number;
  E_indep: number;
  p: number;
  q: number | null;
  stability: number;
  tag_robust: boolean;
  knn_pct: number;
  row_ids: string[];
  col_ids: string[];
  /** midpoint of the 2D centroids of row_ids and col_ids */
  x: number;
  y: number;
  prereg: boolean;
  /** present for pre-registered holes */
  registered: HoleRegistered | null;
  replication: HoleReplication | null;
  concept: HoleConcept | null;
  prior_art: PriorArt | null;
}

export interface ReplicationRow {
  code: string;
  cell_label: string;
  axes: [AxisName, AxisName];
  E_prereg: number;
  observed_new: number;
  E_new: number;
  p_new: number;
  observed_pooled: number;
  E_pooled: number;
  q_pooled: number;
  stability: number;
  verdict: string;
  refuting: { id: string; t: string }[];
}

export interface Replication {
  status: ReplicationStatus;
  rows: ReplicationRow[];
}

export interface DryRunGap {
  rank: number;
  pct: number;
  stability: number;
  coherence: number;
  nn_cos: number;
  parents: string[];
}

export interface DryRun {
  N: number;
  chance: number;
  gaps: DryRunGap[];
}

export interface WinnerPick {
  code: string;
  name: string;
  title: string;
  concept: string;
  pitch: string;
  how_it_works: string[];
  stats: { observed_new: number; E_new: number; E_pooled: number; q_pooled: number; E_new_indep: number; q_pooled_indep: number; official_verdict: string; stability_pooled: number };
  /** true when the pick is an exception to the pre-registered gates */
  exception: boolean;
  repo_path: string;
}

/** Nothing is built yet. `pick` is the hole chosen to build (design/WINNER.md), if the choice has been made. */
export interface WinnerPending {
  status: 'pending';
  pick?: WinnerPick;
  /** what the concept stage did: concepts written, searches run (two lenses each), concepts with no prior art in both */
  concept_stage?: { concepts: number; searches: number; clean: number; ranked: number; pick_rank: number };
}

export interface SensitivityRow {
  code: string;
  cell_label: string;
  axes: [AxisName, AxisName];
  observed_new: number;
  models: Record<string, { E_new: number | null; q_pooled: number | null; verdict: string }>;
}

export interface Sensitivity {
  rule: { replicated: string; refuted: string; underpowered: string };
  models: { key: string; label: string; structural_z: number | null }[];
  summary: Record<string, { replicated: number; refuted: number; underpowered: number }>;
  rows: SensitivityRow[];
  audit: { code: string; verdicts: string[]; belongs: { id: string; title: string }[] };
}

export interface WinnerBuilt {
  status: 'built';
  code: string;
  title: string;
  pitch: string;
  how_it_works: string[];
  demo: Record<string, unknown>;
  repo_path: string;
  /** the pick card data stays in the file after the build (the abstract and the globe still say it was an exception) */
  pick?: WinnerPick;
  concept_stage?: { concepts: number; searches: number; clean: number; ranked: number; pick_rank: number };
}

export type Winner = WinnerPending | WinnerBuilt;

/** Pooled q of the registered cells under three Benjamini-Hochberg families (scripts/bh_family_readings.py; results/bh-family-ruling.md). */
export interface BhFamilyCell {
  code: string | null;
  axes: string[];
  cell: Record<string, string>;
  observed_new: number;
  E_new: number;
  q_literal: number | null;
  q_code: number | null;
  q_alternative: number | null;
  m_literal: number;
  m_code: number;
  m_alternative: number;
}
export interface BhFamily {
  q_max: number;
  e_new_min: number;
  cells: BhFamilyCell[];
  counts: Record<'literal' | 'code' | 'alternative', { 'q_le_0.10_and_Enew_ge_2': number; 'q_le_0.10_only': number }>;
}

export interface AppData {
  meta: Meta;
  points: Point[];
  facets: Facets;
  holes: Hole[];
  replication: Replication;
  dryrun: DryRun;
  winner: Winner;
  /** the sensitivity analysis and the tagging audit; null when the file is absent */
  sensitivity: Sensitivity | null;
  /** the three BH-family readings; null when the file is absent */
  bhFamily: BhFamily | null;
}

async function getJSON<T>(name: string): Promise<T> {
  const url = `${import.meta.env.BASE_URL}data/${name}.json`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return (await res.json()) as T;
}

export const loadMeta = () => getJSON<Meta>('meta');
export const loadPoints = () => getJSON<Point[]>('points');
export const loadFacets = () => getJSON<Facets>('facets');
export const loadHoles = () => getJSON<Hole[]>('holes');
export const loadReplication = () => getJSON<Replication>('replication');
export const loadDryRun = () => getJSON<DryRun>('dryrun');
export const loadWinner = () => getJSON<Winner>('winner');
export const loadSensitivity = () => getJSON<Sensitivity>('sensitivity').catch(() => null);
export const loadBhFamily = () => getJSON<BhFamily>('bh_family').catch(() => null);

/** Load everything in parallel. Rejects with a readable Error if any file is missing or malformed. */
export async function loadAll(): Promise<AppData> {
  const [meta, points, facets, holes, replication, dryrun, winner, sensitivity, bhFamily] = await Promise.all([
    loadMeta(),
    loadPoints(),
    loadFacets(),
    loadHoles(),
    loadReplication(),
    loadDryRun(),
    loadWinner(),
    loadSensitivity(),
    loadBhFamily(),
  ]);
  return { meta, points, facets, holes, replication, dryrun, winner, sensitivity, bhFamily };
}

/** Convenience: id -> Point lookup. */
export function indexPoints(points: Point[]): Map<string, Point> {
  return new Map(points.map((p) => [p.id, p]));
}

/** "move×material" style label for a hole's cell, e.g. "reverse-engineer × medical bills". */
export function cellLabel(h: Hole): string {
  return `${h.cell[h.axes[0]]} × ${h.cell[h.axes[1]]}`;
}
