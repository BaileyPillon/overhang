## gapfind

`gapfind` finds the empty regions of a corpus of short texts and scores how well new
concept texts fill them. It is corpus-agnostic: it needs an `id` and a `text` per item.
It has two ways of finding holes, and a validation layer shared by both:

- **Facet holes** (`facets`): tag every item on a few categorical axes, then look for
  combinations of two values that are each common but never occur together. This is the
  primary method for corpora of hundreds of items.
- **Blend gaps** (`find`): sample points between existing items in embedding space and
  rank them by how far from everything they land. This is the method gapfind started
  from (a Steam analysis: embed 146,060 games, sample 320,000 points between them, rank
  by distance from anything that exists). It needs a dense corpus.
- **Validation**: embeddings, from two unrelated models, say whether a hole found by
  either method is also empty in embedding space and whether a concept really lands in it.
  A human or an LLM then picks the winner.

### Setup

Python 3.12 in a local venv (numba/umap/onnxruntime may lack wheels for 3.14):

```powershell
python -m pip install uv
python -m uv venv --python 3.12
python -m uv pip install --python .venv\Scripts\python.exe -e ".[dev]"
.venv\Scripts\activate            # or call .venv\Scripts\python.exe directly
python -m pytest                  # first run downloads two embedding models (~0.7 GB)
```

Embeddings are local (no API key): `fastembed` (ONNX) with `BAAI/bge-base-en-v1.5`,
falling back to `sentence-transformers` if fastembed cannot load the model
(`pip install -e ".[st]"`). Embeddings are cached in `.cache/` (a SQLite file keyed by
model name plus a SHA-256 of each text) and model weights in `.cache/models/`, so a
re-run on unchanged texts never loads the model. Both are gitignored.

### Commands

```
python -m gapfind embed  corpus/corpus.jsonl --out runs/X

# facet holes (primary for small corpora)
python -m gapfind facets --run runs/X --tags corpus/facets/tags.jsonl --vocab corpus/facets/vocab.json [--axes move material] [--top 30] [--boot 1000] [--seed 42]

# blend gaps (dense corpora) and their stability
python -m gapfind find      --run runs/X --samples 320000 --top 30 --seed 42
python -m gapfind stability --run runs/X --pca 16 32 64 --seeds 1 2 3

# validation and pictures, for either kind of gap: --gaps holes (facet holes) or the default gaps.json
python -m gapfind check --run runs/X concepts.jsonl [--gaps holes] [--models BAAI/bge-base-en-v1.5,nomic-ai/nomic-embed-text-v1.5]
python -m gapfind map   --run runs/X [--gaps holes] --concepts concepts.jsonl
python -m gapfind show  --run runs/X [--gaps holes] [--table]

# pre-registered replication of facet holes (see "Pre-registration and replication")
python -m gapfind replicate --prereg runs/r1/holes.json --run runs/r2 --tags corpus/facets/tags.jsonl --vocab corpus/facets/vocab.json --new-ids runs/grow/new_ids.txt
```

Input is JSONL with at least `id` and `text`; every other field (`title`, `domain`,
`source`, `from_video`, ...) is carried through untouched. `embed` accepts several files
or a glob (expanded by gapfind itself, so it works on Windows shells). Duplicate ids are
an error unless you pass `--on-dup-id keep-first|rename`.

Concept JSONL: `id`, `text`, optional `title`, optional `target_gap` (a gap id such as
`gap-03`, or a hole id such as `hole-move-material-07`). Other fields are carried through
to the checks file.

Flags (defaults in brackets):

| command | flags |
|---|---|
| `embed` | `--model` [`BAAI/bge-base-en-v1.5`], `--backend` [auto], `--cache-dir` [`.cache`], `--model-dir`, `--batch-size`, `--on-dup-id` [error] |
| `facets` | `--tags`, `--vocab` (required), `--axes` [all vocab axes; every pair among them], `--top` [30 per axis pair], `--boot` [1000], `--seed` [42], `--min-expected` [1], `--thin-frac` [0.25], `--quasi` / `--no-quasi` [quasi on], `--structural-z` [3.0], `--pca` / `--k` [find's, else 32 / 5], `--neighbors` [8], `--group-field` [`domain`] |
| `find` | `--samples` [320000], `--top` [30], `--seed` [42], `--k` [5], `--pca` [32; 0 = full dimension], `--coh-band LO HI` [0.3 0.8], `--coh-q` (alias: sets only LO), `--min-weight` [0 = off], `--nms` [0.25], `--p-k2` [0.6], `--neighbors` [8], `--batch` [8192, memory only], `--group-field` [`domain`] |
| `stability` | `--pca` [16 32 64], `--seeds` [1 2 3], `--match` [0.8], `--topk` [the primary `--top`], `--samples` [the primary's] |
| `check` | `--gaps` [`gaps.json`], `--models` (comma list), `--min-percentile` [90], `--neighbors` [5], plus the embedding flags |
| `map` | `--gaps` [`gaps.json`], `--concepts`, `--n-neighbors` [15], `--min-dist` [0.1], `--seed` [42], `--group-field` [`domain`], `--min-percentile` [90] |
| `replicate` | `--prereg`, `--run`, `--tags`, `--vocab`, `--new-ids` (all required), `--min-expected` [1], `--boot` [1000], `--seed` [42], `--structural-z` [the prereg file's, else 3.0] |
| `show` | `--gaps`, `--table`, `--neighbors` [3] |

`--gaps holes` is short for `--gaps holes.json`; any path to a gaps document works. With a
non-default gaps document the outputs get a suffix so nothing is overwritten
(`checks_holes.json`, `map_holes.json`, `map_holes.png`).

### Why blend gaps are not enough

The blend method samples a point between 2 or 3 existing items and asks how far it lands
from anything that exists. That only works when the corpus is dense enough that a blend of
two *related* items has other items around it, so that "nothing is near" means something.
Gapfind's dry run on the real corpus (514 items, 16 domains, a few dozen per domain) showed
what happens when it is not:

- With the defaults, all of the top 20 gaps were lopsided blends (about 70/30) sitting next
  to one *isolated* item: the nearest corpus item had cosine 0.88 to 0.95 with the "gap".
  They describe an outlier's neighborhood, not a bridge, and their stability was high only
  because the same outliers are found every time.
- Forcing balanced blends (`--min-weight 0.4`) removed those, and what remained were
  midpoints of two unrelated items: stability 0 to 0.2 for nearly all of them (chance level
  0.001), so they are not reproducible either.
- Switching from 1-NN to k-NN scoring (the parents are only 2 or 3 of the k neighbors) and
  working in a PCA subspace fixed the obvious degeneracies but not this: a few hundred items
  over a dozen topics cannot support embedding-space holes by themselves.

Blend gaps remain the right tool for dense corpora (thousands of items, many near
neighbors per item); see "Blend gaps" below.

### Facet holes: a Zwicky box with an independence model

Morphological analysis (the Zwicky box) describes a space of ideas as a few independent
dimensions, each with a handful of values, and looks at the combinations nobody has tried.
`facets` does that to the corpus, and puts statistics on it.

**Inputs.** `vocab.json` defines the axes and their values:

```json
{"axes": {"move": [{"value": "...", "definition": "..."}, ...], "material": [...], "for": [...]}}
```

`tags.jsonl` has one row per item: `{"id": "...", "move": "...", "material": "...", "for": "..."}`,
optionally with a second tagger's labels `move_alt`, `material_alt`, `for_alt` and
`"agree": {"move": true, ...}`. Values must be spelled exactly as in the vocabulary (after
trimming whitespace); anything else, and items without a tag row, are left out of the tables
that need them and counted in the output (`tagging`).

**Holes.** For each pair of axes (default: every pair, so move x material, move x for and
material x for) gapfind builds the contingency table and, for every cell, the observed count
`O`, the expected count `E = n_row * n_col / N` under independence, and the Poisson p-value
`P(X <= O | E)` (for an empty cell that is `exp(-E)`). A **hole** is a cell with `O = 0`;
holes are ranked by `E_quasi` (below; `E_indep` with `--no-quasi`), most expected but absent
first, ties broken by the `p` computed from that `E`. Cells that are
empty only because both values are rare (`E` below `--min-expected`, 1 by default) are
counted but not ranked: nothing is "missing" from a cell nobody was expected to fill. **Thin**
cells (`1 <= O <= E/4`) are reported separately.

**Quasi-independence.** Plain independence misleads when a row's mass sits in one natural
partner column (the move "build or modify software" with the material "a codebase"): every
other cell of that row then looks like a hole with an inflated `E`. So gapfind fits
independence, marks the cells whose Pearson residual `(O-E)/sqrt(E)` exceeds `--structural-z`
(3.0) as structural, and refits `E` by iterative proportional fitting over the non-structural
cells only, matching the margins of that part while each structural cell keeps `E = O` and
absorbs exactly its own mass. It repeats until no new structural cell appears (at most 5
rounds); when deciding what is structural, the residuals come from a reference fit that also
leaves out the empty cells with residual below `-z`, because a genuine hole lowers its row and
column margins and would otherwise make its populated neighbours look structural. Every cell
keeps `E_indep` next to `E_quasi` and a `structural` flag, the bootstrap and the second-tagger
check use `E_quasi` (structural set recomputed per resample), and `--no-quasi` restores the
plain model.

**Bootstrap stability.** Items are resampled with replacement `--boot` times (1000). A
hole's `stability` is the fraction of resamples in which the cell is still empty *and* its
expected count is at least 2. A hole that stays empty only because one lucky item was
missing, or whose marginals shrink in some resamples, scores low. (The resamples are drawn
as a Multinomial(N, O/N) over the cells, which has the same distribution as resampling the
N items one by one and is much faster; a test checks the two agree.)

**Tag robustness.** If `_alt` labels exist, the tables are recomputed using the second
tagger's label wherever present (the primary label elsewhere), and every hole reports
whether it survives (`alt.survives`: still empty and still expected at least
`--min-expected`). The agreement rate per axis is reported in `tagging`.

**Embedding validation.** The hole's vector is the normalized sum of the centroid of the
row value's items and the centroid of the column value's items, in the same centered, PCA
working space and with the same `k` as `find` (reused from `gaps.json` when `find` has been
run, otherwise fitted with `--pca` / `--k`). Its k-NN novelty `percentile` is measured
against the corpus's leave-one-out k-NN distances, so it says whether the embedding space
also finds that spot empty: an independent opinion, because the tags never entered the
embeddings. The 3 items of each value nearest their own centroid are listed as examples
(`id`, `title`, `text`), with the value's definition.

**Using holes elsewhere.** `holes.json` is both the full report and a gaps document: its
`gaps` list has one entry per hole (`id` like `hole-move-material-07`, `source: "facet"`,
`vector`, `score`, `percentile`, `stability`, `parents`, `neighbors`, ...), so
`check --gaps holes` measures concepts against hole vectors (`target_gap` may be a hole id;
`lands_in_gap` works as for blend gaps), `check --models a,b` gives each concept's novelty
percentile under each model, `map --gaps holes` draws holes as teal diamonds, and
`show --gaps holes` prints them.

**False discovery rate.** With dozens of cells per axis pair, some cells are empty by chance.
For each pair the test family is every cell (empty or not) with expected count `E >= --min-expected`
(1). Each cell gets the deficit p-value `P(X <= O | Poisson(E))` (for a hole, `exp(-E)`), and
`q` is the Benjamini-Hochberg adjustment over the family. Every hole and `thin` cell carries
`q`; each pair has `family_size` and the cell tables `p_cell` and `q` (null outside the
family). Reading a hole with `q <= 0.10` as real keeps the expected share of false holes among
those called at about 10%. This is the same family used by `replicate` below.

### Pre-registration and replication

Holes found on the data that suggested them are hypotheses. To test them, freeze the list
before collecting more data: `PREREG.md` states the rule, and the `holes.json` of the first
run (`runs/r1/holes.json`) is the registered list of candidates. Then collect a new sample
without showing collectors the cells, tag it with the same vocabulary, embed the pooled corpus
into a new run, and run

```
python -m gapfind replicate --prereg runs/r1/holes.json --run runs/r2 --tags corpus/facets/tags.jsonl --vocab corpus/facets/vocab.json --new-ids runs/grow/new_ids.txt [--min-expected 1.0] [--boot 1000] [--seed 42]
```

`--run` is the pooled corpus (only `items.jsonl` is read, no embeddings), `--tags` must cover
all of its items, and `--new-ids` is a text file with one id per line naming the new sample.
Every registered gap with `expected >= --min-expected` is matched by axes and cell values (not
by hole id) and gets one verdict by the pre-registered rule:

| verdict | rule |
|---|---|
| `replicated` | no new item in the cell, **and** `E_new >= 2`, **and** `q_pooled <= 0.10` |
| `refuted` | at least one new item in the cell (the items' ids and titles are listed) |
| `underpowered` | no new item, but `E_new < 2` or `q_pooled > 0.10` (or the cell is outside the pooled family) |

`E_new` is the quasi-independence expected count (same `z` as the prereg run) fitted on the new
sample's table alone, `p_new = P(X <= observed_new | E_new)`; the pooled numbers
(`observed_pooled`, `E_pooled`, `p_pooled`, `q_pooled` by Benjamini-Hochberg within the pair's
family, and the bootstrap `stability` on the pooled table) use all tagged items. Output:
`runs/r2/replication.json` (`cells[]`, `summary`, `pairs[]` with family sizes, `params`) and a
table on stdout. Items found later by targeted search are not part of the new sample and must
stay out of `--new-ids`. Do not change the rule after seeing the data.

### The shared machinery

1. **Center.** Sentence embeddings are anisotropic: every pair of texts looks 0.5 to 0.8
   similar. gapfind subtracts the corpus mean vector and re-normalizes. The mean is stored
   (`run/mean.npy`) and used for every later projection.
2. **PCA working space.** `find --pca D` (default 32) fits PCA on the centered corpus and
   re-normalizes the projections; scoring, novelty and `check` happen there (`--pca 0` keeps
   the full dimension). The components are stored in the run (`pca.npz`, or `holes_pca.npz`
   for `facets`) so `check` and `map` project exactly like the finder did, and the
   fraction of variance kept is recorded.
3. **Novelty on the corpus's own scale.** A point's novelty is its mean cosine distance to
   the k nearest corpus items (`--k`, default 5). For every corpus item the same quantity
   is computed leaving the item out; a gap's or hole's `percentile` is the share of items
   with a smaller value: "emptier than the space around 97% of existing items". Concepts
   get the same number.
4. **Check a concept.** Embed it, center it, project it, then report its nearest corpus
   items, its own k-NN score and percentile, its nearest gap or hole and the cosine to that
   vector, and (with `target_gap`) the cosine to the target. `lands_in_gap` is true when the
   concept is closer (higher cosine) to its target vector than to *any* corpus item **and**
   its percentile is at least `--min-percentile`. Without `target_gap` the nearest one is
   used (`lands_basis: "nearest"`).
5. **Cross-model check.** `check --models a,b` embeds the corpus and the concepts under each
   model (cached), redoes centering, PCA and the leave-one-out scale in that model's own
   space, and reports each concept's novelty percentile per model (`by_model` in the checks
   file). A concept that is far out under two unrelated models is much more likely to be
   genuinely new than one that is only odd to bge. `lands_in_gap` stays defined in the run's
   own model, because the gap vectors are. The second model verified here is
   `nomic-ai/nomic-embed-text-v1.5` (a different family; fastembed adds no prefix, gapfind
   adds the model card's `clustering: ` prefix to corpus and concepts alike, see
   `embed.MODEL_PREFIXES`).
6. **Map.** UMAP to 2D (cosine, n_neighbors 15, min_dist 0.1, random_state 42) fitted on the
   working-space corpus; gaps, holes and concepts are projected with the fitted model.
   **The 2D map is only a picture.** All scoring happens in the working space.

Everything is seeded: the same inputs and flags give the same output.

### Blend gaps (`find`, for dense corpora)

1. Draw S points (320,000 by default) in batches. Each picks 2 parents (probability 0.6) or
   3 (0.4) uniformly from the corpus (distinct), weights them with a Dirichlet(1) draw and
   sums: `v = sum(w_i * x_i)`. The length of `v` is the **coherence** `c`; `u = v/|v|` is the
   sample.
2. **Score** the sample with the k-NN novelty above (`score`). A blend's own parents are only
   2 or 3 of the k neighbors, so the score asks whether anything *else* lives nearby. The
   plain 1-NN distance `g1 = 1 - max_j cos(u, x_j)` is kept for reference: on a sparse
   corpus it mostly measures how far the blend is from its own parents.
3. **Coherence band.** Keep samples whose coherence lies between the `--coh-band` quantiles
   (default 0.3 to 0.8). The floor drops antipodal blends; the ceiling drops blends that are
   essentially one item. `--coh-q q` is the old single-floor flag and sets only the lower
   edge. `--min-weight W` optionally requires every parent to carry at least weight W.
4. **Distinct gaps.** Greedy non-max suppression: sort by score, take the best, discard
   every sample within cosine distance `--nms` of it, repeat until `--top` gaps.
5. **Stability.** `stability` re-runs the search under other PCA dimensions and seeds and,
   for each primary gap, reports the fraction of re-runs whose top-K list contains a gap
   within the matching radius. The match is made in the **full centered dimension**, the
   only space common to runs with different projections: a gap's full-dimension point is the
   blend of the *same parents with the same weights* taken in the full space
   (`vector_full`), and two gaps match when the cosine of these vectors is at least `--match`
   (0.8). To calibrate the radius every re-run also draws a random set of coherent blends
   the size of its top list and records how often *those* match (the `null`, "chance
   level"); on the real corpus it is 0.1% to 3% at 0.8, and real matches pile up above 0.8.
   Stability is not validity: it says the search keeps finding the same place, not that the
   place is worth filling.

### Output files (in `runs/X/`)

| file | contents |
|---|---|
| `items.jsonl`, `emb.npy`, `mean.npy`, `meta.json` | from `embed`: merged items (all original fields plus `row`), raw L2-normalized embeddings, their mean, model/dim/cache info |
| `pca.npz`, `novelty.npy` | from `find`: PCA components and the leave-one-out k-NN distances |
| `gaps.json` | `find`: `{params, pca, novelty, sampling, gaps[]}`, plus `stability_run` after `stability` |
| `stability.json` | per-rerun detail: best matching cosine for every gap, matches, chance level |
| `holes.json` | `facets`: `{source: "facet", params, pca, novelty, tagging, pairs[], gaps[]}` (see below) |
| `replication.json` | `replicate`: `{prereg, n_new_in_run, cells[], summary, pairs[], params}` |
| `holes_pca.npz`, `holes_novelty.npy` | the working space `facets` used (a copy, so a later `find` cannot change it) |
| `checks.json`, `checks_holes.json` | `check`: `{params, concepts[]}` |
| `map.json`, `map.png`, `map_holes.*` | UMAP coordinates and a quick scatter (corpus colored by `domain`, blend gaps as hollow black circles, facet holes as hollow teal diamonds, concepts as stars) |

`gaps.json` entries: `id` (`gap-01`...), `score` (k-NN), `g1` (1-NN), `percentile`,
`blend_percentile`, `coherence`, `stability` (`null` until `stability` has run), `parents`
(`id`, `title`, `text`, `weight`), `neighbors` (the 8 nearest items in the working space),
`domain_mix`, `vector` (working space, unit length) and `vector_full` (the same blend in the
full centered dimension).

`holes.json`: `tagging` (tagged counts, unknown values, alt-label counts, per-axis tagger
agreement) and `pairs[]` (axes, `N`, row/column values, the `observed` and `expected`
tables (plus `expected_indep`, `expected_quasi`, `structural` cell by cell and `n_structural`), `n_empty`, `n_empty_below_min_expected`, `holes` (ids), `thin` cells with their
`p`). Each entry of `gaps[]` is a hole: `id` (`hole-move-material-07`), `source`, `axes`,
`cell` (`{axis: value}`), `observed` (0), `expected`, `p`, `n_row`, `n_col`, `N`,
`expected_indep`, `expected_quasi` (`null` with `--no-quasi`; `expected` is the one that ranks), `structural`
(always `false` for a hole), `stability` (bootstrap), `alt` (`{observed, expected, expected_indep, survives}` or `null`) and `tag_robust`,
`examples` (per axis: value, definition, n, 3 items), and the embedding validation: `score`,
`g1`, `percentile`, `neighbors`, `domain_mix`, `parents` (the example items, equal weights),
`coherence`, `vector`.

Each entry of the checks file: the concept's own fields plus `score`, `g1`, `percentile`,
`nearest_items`, `nearest_gap`, `nearest_gap_cos`, `target_gap_cos` (or `null`),
`lands_in_gap`, `lands_basis`, and with `--models` `by_model` (`{model: {score, percentile}}`).

### Merging a corpus

`scripts/merge_corpus.py` concatenates `corpus/raw/*.jsonl` into `corpus/corpus.jsonl`,
validates every row against `corpus/SCHEMA.md` (hard errors such as a missing id/text,
duplicate id or unknown domain stop the merge and write nothing; style problems such as
word counts or naming the tool are printed as warnings), and prints near-duplicate pairs
(raw cosine >= 0.92 under bge-base, plus the borderline pairs just below it) for human
review. Nothing is dropped automatically.

```
.venv\Scripts\python.exe scripts\merge_corpus.py
```

### Limits

- **The tags define the holes.** A facet hole is only as good as the vocabulary and the
  tagging: a coarse axis hides structure, a noisy tagger creates and destroys holes. Compare
  two taggers (`_alt`) and read the examples before believing a cell.
- **Independence is a model, not the truth.** Move and material are not independent in the
  world (some combinations are impossible or pointless). A hole says "more absent than the
  marginals predict", which includes combinations nobody wants. Judgment picks the winner.
- **Small tables are noisy.** With few items per axis value `E` is small and everything is
  uncertain; the bootstrap `stability` and `--min-expected` are there to say so.
- **The embedding model defines "similar".** Embedding validation is relative to what the
  model considers close; `check --models` shows how much a verdict depends on it.
- **The corpus defines the world.** A hole is only a place no item in *this* corpus
  occupies; the corpus may simply be incomplete.
- **Blend gaps need density.** See above: below a few thousand items they mostly find
  outliers or arbitrary midpoints. Read `parents`, `neighbors` and `stability` together.

### Tests

`python -m pytest` (about a minute; the first run downloads the models). Facet holes: a
planted co-occurrence hole (also under quasi-independence, where a row with 80% of its mass in one column must not fill the ranking with false holes, checked on a table and through `facets`; two frequent values that never co-occur must be the top hole with
stability above 0.9; a cell empty only because both marginals are tiny must not rank), thin
cells, Poisson and bootstrap checks (including bootstrap vs direct resampling), tag
robustness with second-tagger labels, hole vectors and examples, `check --gaps holes` with a
hole as `target_gap`, and map markers. Blend gaps: a planted hole between clusters on a
128-D sphere (found in PCA and in full dimension), a populated bridge scoring lower than an
empty one, a pair of isolated items showing where 1-NN is blind and k-NN is not, PCA/band/
weight mechanics and stability. Plus the merge script, a fake-embedder cross-model test, and
an end-to-end smoke test with the real models on 12 texts (embed, find, stability, check
with `--models`, map, facets, `check --gaps holes --models`, `map --gaps holes`, and a
cache-hit assertion on the second embed). `tests/data/dev.jsonl` is a 42-item hand-written
dev corpus.
