# Methods

This is the long version of the argument in the [README](../README.md) and in the paper inside the app. Every number below comes from a file in this repository: `results/*.json`, `app/public/data/*.json`, `PREREG.md`, or the code in `gapfind/`. Where the paper and the code differ in wording, the code is what ran and this document follows it (see [Notes on wording](#notes-on-wording)).

Contents: [1 Corpus](#1-corpus) · [2 Tagging](#2-tagging) · [3 Counting what is missing](#3-counting-what-is-missing) · [4 Evidence for one hole](#4-evidence-for-one-hole) · [5 The Steam method](#5-the-steam-method-and-why-it-fails-at-n--514) · [6 Pre-registration and replication](#6-pre-registration-and-replication) · [7 Sensitivity](#7-sensitivity-analysis) · [8 Tagging audit](#8-tagging-audit) · [9 From hole to build](#9-from-hole-to-build) · [10 The globe](#10-the-globe) · [11 Limits](#11-limits)

## 1 Corpus

**Unit.** One *report*: a sourced instance of someone using Claude for something specific. Each is rewritten as one sentence of 15 to 35 words, present tense, starting with a verb, never naming the tool or the person (schema: [`corpus/SCHEMA.md`](../corpus/SCHEMA.md)). The sentence, not the original post, is what gets embedded, so that phrasing is uniform across collectors. Each entry keeps its `source` URL, a `domain` (one of 16), a `confidence` (`seen` if the collector read the report itself, `secondhand` if only a roundup described it) and a `from_video` flag.

**Two samples.**

| | N | How collected |
|---|---|---|
| First sample | 514 | Hand collection across 16 domains, 84 of them *anchors*: representative tasks written from eight published Anthropic usage reports (the Economic Index reports and related studies), flagged wherever shown. 36 entries are flagged as from one video. |
| New sample | 1,049 | Collected **after** the holes were registered, by collectors never shown the registered cells. Each collector sampled by a *single* facet value (one move, one material, or one audience) or at random (systematic samples of GitHub and Hacker News), never by a combination. |
| Pooled | 1,563 | Both. |

The new sample is what makes replication a test: its collectors had no way to aim at, or away from, a registered cell. It is not a random sample of anything, and the single-facet design deliberately over-samples rare values (a cell's row and column are each sampled, but not their intersection). Items found later by targeted prior-art search are kept out of the new sample.

## 2 Tagging

Every report gets three categorical tags, defined in [`corpus/facets/vocab.json`](../corpus/facets/vocab.json):

- **move** (20 values): what Claude does, for example *reverse-engineer or unlock*, *audit or diagnose*, *operate a live system*;
- **material** (24 values): what it acts on, for example *a codebase*, *a playable game*, *consumer-device firmware or hardware*;
- **audience** (`for`, 7 values): who it is for, for example *researchers or science*, *a child*, *family or household*.

Two taggers labelled every report independently and blind to each other; disagreements were adjudicated, and the adjudicated label is the primary tag used in all tables. The second tagger's raw labels are kept (`*_alt` in `tags.jsonl`) for the robustness check in 4.3. Agreement is Cohen's kappa:

$$\kappa=\frac{p_o-p_e}{1-p_e}$$

where $p_o$ is the share of reports labelled identically and $p_e$ the share expected to match by chance given each tagger's label frequencies.

| | move | material | audience |
|---|---|---|---|
| κ, first 514 | 0.878 | 0.897 | 0.878 |
| κ, new 1,049 | 0.904 | 0.929 | 0.876 |
| raw agreement, pooled 1,563 (recomputed from the two label columns) | 90.8% | 92.5% | 91.8% |

(`PREREG.md` rounds the first audience value to 0.879; recomputed from the tag file it is 0.8785. The lowest κ anywhere is 0.876, the audience axis of the new sample; over all six values the range is 0.876 to 0.929. The `agree` flags in `corpus/facets/tags.jsonl` give 90.9 / 92.6 / 91.8%, one more agreeing row each on move and material and on audience; three rows (`g-firmware-053` on move, `g-robots-021` on material, `g-rand-hn-042` on audience) carry a flag that contradicts their own two labels. The table uses the labels. The κ values are unaffected.) High agreement shows the labels are repeatable. It says nothing about whether the vocabulary carves the world in a useful way.

## 3 Counting what is missing

### 3.1 Tables and independence

Pairing two axes gives a contingency table. There are three: move × material (20 × 24 = 480 cells), move × audience (20 × 7 = 140) and material × audience (24 × 7 = 168), 788 cells in all. For table cell $(i,j)$ let $O_{ij}$ be the observed count, $n_i$ the row total, $n_j$ the column total and $N$ the number of reports. If the two tags were unrelated:

$$E_{ij}=\frac{n_i\,n_j}{N}$$

### 3.2 Quasi-independence

Some pairings are populated by design: a report that reverse-engineers a game ROM is, by definition, about a compiled binary. Those cells soak up reports and make the rest of their row and column look emptier than they are, so plain $E_{ij}$ over-states what the other cells should hold. We therefore mask such *structural* cells and refit.

Define the Pearson residual

$$r_{ij}=\frac{O_{ij}-E_{ij}}{\sqrt{E_{ij}}}$$

and let $S$ be the set of structural cells. The procedure (`gapfind.facets.quasi_expected_batch`), with threshold $z=3$ unless stated:

1. Start with $E$ from plain independence and $S=\varnothing$.
2. **Reference fit.** Fit $a_i b_j$ by iterative proportional fitting (IPF) over the cells outside $S$ and outside $L$, where $L$ is the set of empty cells with $r_{ij}<-z$ that are not in $S$ (the holes themselves). The reason is that a genuine hole lowers its own row and column margins, which would raise the residuals of its populated neighbours and get them flagged by mistake, one after another, until the whole row is masked.
3. **Flag.** Add to $S$ every cell not yet in $S$ whose residual against the reference fit exceeds $z$: $r_{ij}>z$.
4. **Refit.** Fit IPF over the cells outside $S$ only. Structural cells keep $E_{ij}=O_{ij}$.
5. Repeat from step 2 until no new cell is flagged, or after 5 rounds.

The result is the quasi-independence expectation

$$\tilde E_{ij}=a_i\,b_j\quad\text{for }(i,j)\notin S,\qquad \tilde E_{ij}=O_{ij}\quad\text{for }(i,j)\in S,$$

where $a_i, b_j$ are chosen so that the fitted totals over the non-structural cells match the observed totals over those cells, row by row and column by column. In the pooled tables this flags 77, 19 and 30 cells in the three tables.

### 3.3 What a hole is

A **hole** is a cell with $O_{ij}=0$ and $\tilde E_{ij}\ge 1$. Cells that are empty only because both their values are rare ($\tilde E<1$) are counted but not ranked: nothing is missing from a cell nobody was expected to fill. Holes are ranked by $\tilde E$, largest first. At $n=514$ there were 19 (the registered list). In the pooled tables the catalog has 56 entries: the 19 registered cells, wherever they ended up, plus the 37 other cells that are empty with $\tilde E\ge1$ on the pooled data. Each has a permanent code `OV-NN` that is the same on the globe, the matrix and the tables; a code is never reused.

### 3.4 How surprising a zero is

Treat the count in a cell as Poisson with mean $\tilde E$. The deficit probability for any cell is

$$p_{ij}=\Pr\!\left(X\le O_{ij}\right)=\sum_{k=0}^{O_{ij}}\frac{e^{-\tilde E_{ij}}\,\tilde E_{ij}^{\,k}}{k!},\qquad X\sim\mathrm{Poisson}(\tilde E_{ij})$$

and for a hole this collapses to

$$p=e^{-\tilde E}$$

so a cell expected to hold three reports and holding none has $p=e^{-3}\approx0.05$.

With many cells, some will be empty by luck. For each table the **test family** is every cell, empty or not, with $\tilde E\ge1$ (family sizes on the pooled data: 161, 99 and 96). This is the code's family. The registration worded it differently ("all empty cells of its axis pair"); the three readings and why it matters are in [section 6](#6-pre-registration-and-replication) and [`results/bh-family-ruling.md`](../results/bh-family-ruling.md). Sort that family's $m$ p-values as $p_{(1)}\le\dots\le p_{(m)}$; the Benjamini-Hochberg adjusted value is

$$q_{(i)}=\min_{j\ge i}\ \min\!\left(1,\ \frac{m}{j}\,p_{(j)}\right)$$

and calling every cell with $q\le\alpha$ a hole keeps the expected share of false holes among those called at about $\alpha$ (we use $\alpha=0.10$).

At $n=514$ this settled almost nothing: of the 19 registered holes only one had $p<0.05$ (hole-move-for-01, $p=0.040$) before any correction. So $p$ ranks the cells and does not certify them. That is why the holes were treated as hypotheses.

## 4 Evidence for one hole

Each hole also carries three checks of its own.

### 4.1 Bootstrap stability

Resample the $N$ reports with replacement $B=1000$ times, recount the table, refit $\tilde E^{*}$ (structural set recomputed for each resample), and record how often the cell is still a hole:

$$s_{ij}=\frac1B\sum_{b=1}^{B}\mathbf 1\!\left[\,O^{*b}_{ij}=0\ \text{ and }\ \tilde E^{*b}_{ij}\ge 2\,\right]$$

Resampling $N$ items with replacement gives cell counts that are $\mathrm{Multinomial}(N, O/N)$, so the code draws them directly (the same distribution, much faster; a test checks the two agree). A hole that is empty only because one lucky report was missing, or whose margins shrink in many resamples, scores low.

### 4.2 Embedding novelty

An independent opinion that never sees the tags. Embed each sentence with `BAAI/bge-base-en-v1.5` (768 dimensions, local). Sentence embeddings are anisotropic (every pair looks 0.5 to 0.8 similar), so subtract the corpus mean and renormalize, then project to the first 32 principal components and renormalize again. The *novelty* of a unit vector $u$ is its mean cosine distance to the $k$ nearest reports ($k=10$):

$$\nu(u)=\frac1k\sum_{x\in \mathrm{NN}_k(u)}\bigl(1-u\cdot x\bigr)$$

For every report the same quantity is computed leaving that report out, and a point's **percentile** is the share of reports with a smaller value: "emptier than the space around 97% of existing reports". A hole's vector is the normalized sum of the centroid of the reports carrying its row value and the centroid of those carrying its column value. If the tag-based and embedding-based views agreed, holes would have high percentiles; they mostly do not, and we report the disagreement instead of averaging it away.

### 4.3 Tag robustness

Recompute the tables using the second tagger's label wherever present. A hole is *tag-robust* if it is still empty with $\tilde E\ge1$ under both taggers. This tests noise between taggers, not the choice of vocabulary. OV-15 is tag-robust on the pooled data only: at registration `PREREG.md` says \"survives 2nd tagger: no\" (`registered.tag_robust` is false in `holes.json`).

## 5 The Steam method, and why it fails at n = 514

**The recipe.** Embed every item, sample points *between* items, and rank the points by distance from any real item. The post that inspired this embedded 146,060 Steam games and sampled 320,000 points between them (as described in the video; the figures are in corpus entry `video-034`). We ran the same recipe, as implemented in `gapfind find`, on the first 514 reports:

1. Draw a blend: choose 2 parents (probability 0.6) or 3 (0.4) uniformly without replacement, weights $w\sim\mathrm{Dirichlet}(\mathbf 1)$, and form $v=\sum_i w_i x_i$.
2. The length $c=\lVert v\rVert$ is the blend's *coherence*; $u=v/\lVert v\rVert$ is the sample. Keep samples with $c$ between the 0.3 and 0.8 quantiles (this drops antipodal blends and blends that are essentially one parent).
3. Score each sample by the novelty $\nu(u)$ of 4.2, here with $k=5$ in the 32-dimensional PCA space. A blend's own parents are only 2 or 3 of its $k$ neighbours, so the score asks whether anything *else* lives nearby.
4. Take the best, discard every sample within cosine distance 0.25 of it, repeat. Keep 20.
5. **Stability.** Rerun under PCA sizes 16, 32 and 64 and seeds 1, 2 and 3 (9 reruns). A rerun *finds again* a gap when its top-20 list holds a gap whose full-dimension vector has cosine at least 0.8 with it. To calibrate, each rerun also draws random coherent blends the size of its top list and records how often *those* match: the chance level, 0.026.

**What came out** (`app/public/data/dryrun.json`, from `runs/dry`):

- By its own scores every gap looked good: novelty percentiles 86.0 to 96.7, coherence 0.70 to 0.76.
- Every one of the 20 gaps lay **0.8435 to 0.9509 cosine from its nearest report** (median 0.895). A blend is a weighted mean of a few reports and, in a corpus this small, nothing else is around it. It is a smear between things that exist.
- **1 of 20** gaps was found again in all 9 reruns, **5** in none, and 3 more in only 1 or 2. 15 of 20 beat the chance level, but the median gap was found again in 39% of reruns (mean 0.38).
- Forcing balanced blends (`--min-weight 0.4`, `runs/dry-balanced`) removes the lopsided ones; what remains are midpoints of unrelated reports, with stability of 0 to 0.2 for nearly all of them.

Stability measures the wrong thing here. A blend of two particular reports is found again whenever those two are sampled, so a stable gap is one the procedure can reproduce, not one the world lacks. The method needs a dense space; a few hundred hand-collected items over a dozen topics is not one. The question was changed from *where in the space is there nothing* to *which combinations of things has nobody reported*, which is what sections 3 to 6 do. (The Steam method is kept in `gapfind find` for dense corpora.)

## 6 Pre-registration and replication

**Registered.** Before any new report existed, [`PREREG.md`](../PREREG.md) listed the 19 holes of the first pass (empty cells with $\tilde E\ge1$ in the three tables of 514 reports), each with its expected count, and the test below. Commit [`363f0e1`](https://github.com/BaileyPillon/overhang/commit/363f0e1) is the timestamp (the link works only once the repository is pushed under that name; until then it is a local commit whose date is self-asserted, and only a public push, a signed tag or an archive snapshot makes it independently checkable). Prior-art items found afterwards by targeted search never enter the test.

**For each registered cell**, on the new sample ($N_\mathrm{new}=1049$) and on the pooled sample ($N=1563$):

- $O_\mathrm{new}$: reports in the cell from the new sample;
- $\tilde E_\mathrm{new}$: the quasi-independence expectation ($z=3$) fitted on the new sample's table **alone**, so it reflects how many reports the new data's own margins predict;
- $p_\mathrm{new}=\Pr(X\le O_\mathrm{new}\mid X\sim\mathrm{Poisson}(\tilde E_\mathrm{new}))$;
- $\tilde E_\mathrm{pooled}$ and $q_\mathrm{pooled}$ from the pooled table, with the Benjamini-Hochberg family of section 3.4.

**The rule**, thresholds and verdicts fixed in advance and not changed after the data (the one place where the code and the registered wording differ, the Benjamini-Hochberg family for $q$, is in the table below and in [Notes on wording](#notes-on-wording)):

| verdict | condition |
|---|---|
| replicated | $O_\mathrm{new}=0$ **and** $\tilde E_\mathrm{new}\ge2$ **and** $q_\mathrm{pooled}\le0.10$ |
| refuted | $O_\mathrm{new}>0$ |
| underpowered | otherwise (empty, but $\tilde E_\mathrm{new}<2$ or $q_\mathrm{pooled}>0.10$, or outside the pooled family) |

The floor of 2 on $\tilde E_\mathrm{new}$ is a power requirement: an empty cell is only evidence if the new data expected something there. At $\tilde E=2$ an empty cell has $p=e^{-2}\approx0.14$.

**Result** (`results/replication.json`): **0 replicated, 12 refuted, 7 underpowered**, from 19 registered cells. The refuted cells collected from 1 to 11 new reports each (for instance *operate a live system × a codebase*: 11 observed, 9.9 expected). The seven underpowered cells stayed empty. Four lacked power in the new sample ($\tilde E_\mathrm{new}<2$, including OV-15 at 1.53) and three had $\tilde E_\mathrm{new}\ge2$ but a pooled $q$ above 0.10.

**Which Benjamini-Hochberg family?** [`PREREG.md`](../PREREG.md) (commit `363f0e1`) says the pooled $q$ is corrected "across all empty cells of its axis pair". `gapfind replicate` was written after registration but before any replication result was seen, and corrects over **all cells with $\tilde E\ge1$** in the pair. The pooled $q$ under three readings (deficit $p=\Pr(X\le O\mid\mathrm{Poisson}(\tilde E))$, $m$ the family size; computed by `scripts/bh_family_readings.py`, written to `results/bh-family-readings.json`):

| registered cell | $O_\mathrm{new}$ / $\tilde E_\mathrm{new}$ | literal: all empty cells | code: all cells $\tilde E\ge1$ | alternative: empty cells $\tilde E\ge1$ |
|---|---|---|---|---|
| extract and structure × a codebase (OV-06) | 0 / 4.86 | **0.497** ($m$=280) | 0.286 ($m$=161) | 0.037 ($m$=21) |
| consumer-device firmware or hardware × researchers or science (OV-15) | 0 / 1.53 | 0.002 ($m$=71) | 0.003 ($m$=96) | 0.0004 ($m$=14) |
| financial and legal paperwork × the public or a community (OV-19) | 0 / 6.38 | 0.632 ($m$=71) | 0.855 ($m$=96) | 0.125 ($m$=14) |
| reverse-engineer or unlock × a business or its customers (OV-09) | 0 / 12.29 | 0.685 ($m$=39) | 0.963 ($m$=99) | 0.158 ($m$=9) |

**The official count stays 0 of 19 replicated.** It holds under the literal registered wording, which controls, and under the code's family. OV-06 fails the $q$ gate under both (0.497 and 0.286). OV-15 passes the $q$ gate under every reading and fails the registered $\tilde E_\mathrm{new}\ge2$ gate at 1.53. Restricting the family to empty cells with $\tilde E\ge1$, the candidate-eligible cells, would make OV-06 pass ($q=0.037$) and the count 1. That is not what the registration says, so it is a **sensitivity**, never the result. The registered wording does not give 0.037; it gives 0.497.

## 7 Sensitivity analysis

The registered verdict leans on one modelling choice: how $\tilde E_\mathrm{new}$ is computed. We re-evaluated **the same 19 cells with the same unchanged rule** under four models (`results/sensitivity.json`; the $z=3$ column reproduces the official result exactly, which the script checks):

| model | replicated | refuted | underpowered |
|---|---|---|---|
| plain independence | 6 | 12 | 1 |
| quasi-independence, $z=3$ (registered) | 0 | 12 | 7 |
| quasi-independence, $z=4$ | 2 | 12 | 5 |
| quasi-independence, $z=5$ | 1 | 12 | 6 |

Reading it:

- **The 12 refutations never move.** A report in a cell is a report in the cell under any model.
- **Everything else depends on the model.** Which cells count as structural is a judgment about the data; moving one threshold moves the headline from "nothing replicated" to "six did". We keep the registered column official and show the rest as **exploratory**, beside it.
- The cell that matters for what we built, *consumer-device firmware or hardware × researchers or science* (OV-15), is the clearest case. Under plain independence the new sample alone expects 9.46 reports and holds 0, with pooled $q=2\times10^{-5}$: it replicates. Under the registered model the new sample expects only 1.53 (below the bar of 2), so it is underpowered even though pooled $q=0.0026$. At $z=4$ it expects 1.99, a whisker under the bar. We report all of these.

## 8 Tagging audit

A hole is only as good as the tags on either side of it. For OV-15 three auditors (a strict, a lenient and an adversarial reading) each read all 188 reports tagged *researchers or science*, all 116 tagged *consumer-device firmware or hardware*, and others matched by keyword, then ruled on whether the empty cell is real. The 116 firmware reports are 106 for the self, 5 for the public, 3 for a child, 2 for family and none for science.

Verdicts: **hole weakened** (strict), **hole refuted** (lenient), **hole weakened** (adversarial). The auditors are model outputs and are recorded as they were given, not corrected. One recorded judge's reason in `results/evidence.json` (concept H1-c1, score 6) says "two of three auditors weakened or refuted it"; all three did (weakened, refuted, weakened). The error is noted here instead of being edited out. What they found is specific. Two reports reverse-engineer *scientific-grade* equipment for research (an industrial imaging-station camera, `g-revenge-046`, and a lab instrument's raw data format, `g-revenge-007`); the vocabulary files them under *molecules and lab experiments* because the material definition says "retail device". No report applies Claude to *consumer-grade* hardware (wearables, phones, cheap gadgets) for research. The honest scope of the hole is therefore narrower than its label: **consumer hardware in research**. The audit prompts and answers are in `results/evidence.json`.

## 9 From hole to build

Three gates, in order, with at most one build: (1) the hole **replicated**; (2) a bounded web and code search finds **no prior art**; (3) the concept is **judged buildable** and demonstrable.

What happened:

- **Gate 1 produced nothing.** No hole replicated under the registered rule.
- For the six holes the concept stage worked on, 18 concepts were written (three per hole). Each was embedded under two unrelated models (`bge-base-en-v1.5` and `nomic-ai/nomic-embed-text-v1.5`, the latter with its `clustering:` prefix) and scored for novelty against the corpus in each model's own space. A concept that is far out under both is more likely to be new than one that is only odd to one.
- 36 prior-art searches were run, two lenses per concept (AI-assisted work, and products). Of the 36 verdicts, 33 were *partial*, 2 were *done* (already built) and 1 was *none found*. **No concept came back clean** under both lenses.
- Three judges scored the concepts; scores and one-line reasons are in `results/evidence.json`. The judges' top total went to a different concept (`H5-c2`, family recipe reconciliation, 22.5). Drift's concept `H1-c1` totalled 17, seventh of 12 ranked.

Drift was picked anyway, after seeing all of this, by the lead session, for reasons recorded in [`design/WINNER.md`](../design/WINNER.md): it sits in the only hole with strong pooled statistical support under the registered model (under the exploratory z = 4 model OV-09 also gets a pooled q near 0 and replicates; pooled $\tilde E=10.5$, observed 0, $q=0.0026$, still empty in 89% of bootstrap resamples, tag-robust on the pooled data though not at registration, when it was not tag-robust); it answers a documented scientific problem (vendor firmware updates silently change step, heart-rate and sleep algorithms, making cohort data from before and after an update non-comparable); it is software-only on public firmware; and it bridges device hacking and science, the two coastlines the data says never meet. **It is an exception to the registered rule, reported as one.** Drift's own prior art is re-checked in its refined form (differential execution), and every number it reports comes from a script in the repository.

## 10 The globe

**Why a sphere.** Normalized embeddings live on a hypersphere, so a sphere is the natural flat-free target. The coordinates come from a spherical UMAP (`scripts/globe_data.py`): UMAP with `output_metric="haversine"`, `metric="cosine"`, `n_neighbors=15`, `min_dist=0.1`, `random_state=42`, on the centered 32-dimensional PCA vectors, mapped to the sphere by $x=\sin\theta_0\cos\theta_1,\ y=\sin\theta_0\sin\theta_1,\ z=\cos\theta_0$.

**Land and ocean.** *Land* is the densest 30% of the sphere's area under a von Mises-Fisher kernel density estimate of the report positions,

$$\hat f(u)=\frac1N\sum_{i=1}^{N}C(\kappa)\,e^{\kappa\,u\cdot u_i},\qquad \kappa=40,$$

thresholded so that 30% of the area is land. The rest is ocean. There are 13 continents.

**How faithful it is.** Measured in `globe.json`:

| | share |
|---|---|
| a report's 6 nearest neighbours on the globe that share its domain | 45.4% |
| the same in the full 768-dimensional space | 56.3% |
| the same in the 32-dimensional PCA space | 52.5% |
| the same by chance | 9.7% |
| overlap between the 6 nearest neighbours on the globe and in the full space | 15.2% |

Clusters are roughly real. Distances between them are not. Nothing in sections 3 to 9 is computed on the picture.

**Holes on the globe.** A 2D (or spherical) void placed in empty-looking map space would be a lie, because the projection distorts. Instead, selecting a hole lights the two groups of reports it sits between (those carrying its row value and those carrying its column value). The ring is placed at the normalized sum of the two groups' unit-vector centroids on the sphere, and its size grows with $\tilde E$.

## 11 Limits

1. **The corpus defines the world.** A hole is an absence from what is *reported*, not from what is done. 36 reports are flagged as from one video, 313 are known only through a roundup, 84 are anchors from Anthropic's usage reports and not one person's report, and the largest domain holds a large share of everything.
2. **The tags define the holes.** A different vocabulary draws different cells. Agreement between two taggers shows repeatability, not correctness.
3. **The globe is a picture** (section 10).
4. **Expected counts know nothing about meaning.** A hole can be empty because nobody wants the combination. Replication says a cell is really empty; only judgment can say it should be filled.
5. **"No prior art found" is a statement about a bounded search**, not about the world.
6. **Pre-registration protects the replication, not the choice of model.** The sensitivity analysis is post hoc and exploratory, and the pick of Drift is a post-hoc exception.
7. **A pre-registration has to name its multiple-testing family exactly.** Ours said "all empty cells of its axis pair"; the code used "all cells with $\tilde E\ge1$"; a third reading, "empty cells with $\tilde E\ge1$", would have turned 0 of 19 into 1 for OV-06 ($q$ 0.497, 0.286 and 0.037). The official result is 0 of 19 under the first two, and the third is reported as a sensitivity. Write the family, the cell set and the $\tilde E$ cut-off into the registration, and check the code against the wording before the first replication result is seen.

## Notes on wording

Where the paper in the app and the code word something differently, this document follows the code:

- *Benjamini-Hochberg family.* The code (`gapfind.facets.cell_pq`, used by `replicate`) corrects over **every cell with $\tilde E\ge1$** in the pair's table, empty or not (families of 161, 99 and 96). `PREREG.md` says "across all empty cells of its axis pair", which is a different family (280, 71 and 39 cells for the pairs the candidates use). **This choice moves the headline, so all three readings are in the table in section 6.** The official count is 0 of 19 under the literal wording (OV-06 $q=0.497$) and under the code's family ($q=0.286$). Only the alternative reading, empty cells with $\tilde E\ge1$ (families of 21, 9 and 14), makes OV-06 pass ($q=0.037$) and the count 1; OV-09 would get 0.158 and OV-19 0.125 (neither passes) and OV-15 0.0004. That reading is reported as a sensitivity and not as the result. The registered wording in `PREREG.md` is left as it was committed. Ruling: [`results/bh-family-ruling.md`](../results/bh-family-ruling.md).
- *Bootstrap "still a hole".* The code requires $\tilde E^{*}\ge2$ in the resample (`bootstrap_stability`'s default `min_expected=2`), while holes themselves are defined by $\tilde E\ge1$. The paper's text said 1 in both places and now says 2 for the resample; the published stability values (0.09 for OV-15 at registration, 0.89 pooled) were computed with 2.
- *Sample size of the video.* The video's title says 31 use cases; 36 corpus entries carry `from_video: true`.
