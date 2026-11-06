# Pre-registration 2: are Claude's holes empty for every AI assistant?

Registered 2026-11-06, before any report of another AI assistant was collected. The commit that adds this file is the timestamp, and the branch carrying it is pushed to GitHub in the same hour, so the public timestamp is the registration time this time (the first registration was only public a day later).

This is a second, separate test. **It does not change the first pre-registration ([`PREREG.md`](PREREG.md), commit `363f0e1`) or its result: 0 of 19 replicated, 12 refuted, 7 underpowered.** It asks a different question of a different family of cells.

## Question

The pooled Claude corpus (run `r2`, N = 1,563, adjudicated tags in `corpus/facets/tags.jsonl` at commit `5f79f20`) has exactly **44 cells** that are empty and have a quasi-independence expected count E ≥ 1 (z = 3, at most 5 refits), across the three facet-pair tables. They are the holes in the app's catalog, listed below and frozen in [`corpus/assist/family.json`](corpus/assist/family.json). For each one: **do people using other AI assistants (ChatGPT, Codex, Gemini, Copilot, Cursor, local models and the rest) report doing it?**

A cell that other assistants fill is not empty across AI. That does not by itself show Claude users never do it: the Claude corpus can simply have missed it, as 12 of the first 19 holes showed. A cell that stays empty with enough expected reports is a candidate hole for AI assistants in general.

## The new sample

- **What counts.** A sourced report of someone using an AI assistant other than Claude for something specific. Same schema and phrasing rules as the Claude corpus ([`corpus/SCHEMA.md`](corpus/SCHEMA.md)), plus five fields: `assistant`, `assistant_name`, `model_family`, `model_basis`, `sampled_by` ([`corpus/assist/SCHEMA.md`](corpus/assist/SCHEMA.md)). The `text` and `title` never name the assistant, so taggers cannot see it.
- **Excluded.** Work done by a Claude model in any product; comparisons where no single non-Claude assistant did the work; any source already in the Claude corpus or `corpus/sources_seen.txt`; reports that describe no use.
- **Collection design.** 20 collectors, one slice each, quota 35 reports (target about 700). As in the replication, a slice is a *single* facet value or a random draw, never a combination, and no slice combines a facet value with an assistant:
  - 14 single facet values, chosen because they are the margins most of the 44 cells sit on:
    - **move:** coordinate many agents; reverse-engineer or unlock; audit or diagnose; extract and structure.
    - **material:** consumer-device firmware or hardware; financial and legal paperwork; a playable game; circuits and printable parts; robots, vehicles and drones.
    - **for:** family or household; researchers or science; the public or a community; a business or its customers; a child.
  - 2 systematic random samples across all non-Claude assistants: Hacker News (Algolia API) and GitHub search.
  - 4 single-assistant random samples, so the smaller assistants appear at all: Gemini, Codex, GitHub Copilot, local models.
- **Blinding.** Collectors are given their slice, the schema and the facet definitions. They are never shown this file, the 44 cells, the hole catalog, or each other's slices.
- **Closing rule.** Collection closes when all 20 collectors have delivered. The merge validates the schema, drops excluded items, and removes duplicates (the same URL, or the same use reported twice: keep the more concrete). Nothing is topped up after that. No cell count of the new sample is computed until both taggers' labels and the adjudication are committed.

## Tagging

Two taggers label every new report blind to each other, to this file and to the assistant, with the unchanged vocabulary ([`corpus/facets/vocab.json`](corpus/facets/vocab.json)), seeing only `id`, `title` and `text`. Disagreements are adjudicated; the adjudicated label is primary. Cohen's κ is reported per axis.

## Primary analysis set

The new reports with `model_basis` of `stated` or `product-default`, the ones known to have run a non-Anthropic model. Reports with `model_basis` = `unknown` (for example Cursor with no model named) are collected, tagged and drawn on the globe, and enter only sensitivity S2.

## The test, per cell

For each of the 44 cells *c*, with gapfind's own functions (`contingency`, `quasi_expected` with z = 3 and `max_rounds` = 5, `poisson_cdf`, `bh_qvalues`):

- O<sub>oth</sub>(c), E<sub>oth</sub>(c): the observed count and the quasi-independence expected count in the primary non-Claude set, fitted on that set alone.
- O<sub>all</sub>(c), E<sub>all</sub>(c): the same in the pool of the 1,563 Claude reports and the primary non-Claude set, fitted on the pool.
- p<sub>all</sub>(c) = P(X ≤ O<sub>all</sub>(c)) for X ~ Poisson(E<sub>all</sub>(c)), and p = 1 when E<sub>all</sub>(c) is 0 or not finite.
- **The Benjamini–Hochberg family is exactly these 44 cells, m = 44,** taken together across all three axis pairs. Every one of the 44 gets a p-value and enters the family whatever its verdict, its observed count, its expected count, or whether the pooled fit marks it structural. No other cell enters the family and no listed cell leaves it. q<sub>all</sub>(c) is the step-up BH adjusted p-value over those 44 (`gapfind.facets.bh_qvalues`).

Three verdicts, fixed now:

| verdict | rule |
|---|---|
| **filled by other assistants** | O<sub>oth</sub>(c) ≥ 1 |
| **empty across assistants** | O<sub>oth</sub>(c) = 0, E<sub>oth</sub>(c) ≥ 2, and q<sub>all</sub>(c) ≤ 0.10 |
| **underpowered** | every other case |

The thresholds (1, 2, 0.10) are the replication's. The pooled q reuses the Claude sample that picked these cells, as the replication's pooled q did; the independent evidence is O<sub>oth</sub> = 0 with E<sub>oth</sub> ≥ 2. S1 reports the test without the Claude sample.

## Secondary analyses (reported beside the primary, never in its place)

- **S1, new sample only.** q<sub>oth</sub> = BH over the same 44 cells of p<sub>oth</sub>(c) = P(X ≤ O<sub>oth</sub>(c) | Poisson(E<sub>oth</sub>(c))). How many "empty across assistants" cells also have q<sub>oth</sub> ≤ 0.10.
- **S2, all non-Claude reports**, including `model_basis` = `unknown`.
- **S3, stated models only** (`model_basis` = `stated`).
- **S4, second tagger.** The second tagger's label wherever one exists, for both corpora.
- **S5, plain independence** instead of quasi-independence, for E<sub>oth</sub> and E<sub>all</sub>.
- **Descriptive.** For each filled cell, which assistants filled it and with which reports; counts per assistant.

## Exploratory (labelled exploratory, no test)

Cells empty among the non-Claude reports but filled in the Claude corpus; facet distributions per assistant (the slice design over-samples chosen margins, so only the random slices are comparable across corpora); the globe positions of the new reports. The globe places each new report by its nearest Claude reports with the LIVE layer's recipe; nothing is scored on the picture.

## Implementation and deviations

`scripts/cross_assistant.py` implements this test and is committed before the new sample is tagged. **If the code and this text disagree, this text controls,** and the disagreement is reported (the lesson of [`results/bh-family-ruling.md`](results/bh-family-ruling.md)). Any deviation from this plan is listed, with its reason, in a Deviations section of `results/cross-assistant.md`.

## The family: 44 cells

E is the quasi-independence expected count in the pooled Claude corpus, where each cell has 0 reports. n<sub>row</sub> and n<sub>col</sub> are the Claude reports carrying the cell's row value and column value. The seven cells marked *registered* are the ones from the first pre-registration that the replication left underpowered; the other 37 became holes only in the pooled sample.

| code | axes | cell | E (Claude) | n<sub>row</sub> | n<sub>col</sub> | history |
|---|---|---|---|---|---|---|
| OV-06 | move × material | extract and structure × a codebase | 6.33 | 91 | 317 | registered, underpowered |
| OV-20 | move × material | coordinate many agents × circuits and printable parts | 2.85 | 74 | 138 | pooled only |
| OV-21 | move × material | coordinate many agents × consumer-device firmware or hardware | 2.63 | 74 | 116 | pooled only |
| OV-22 | move × material | extract and structure × consumer-device firmware or hardware | 2.46 | 91 | 116 | pooled only |
| OV-23 | move × material | investigate a question × consumer-device firmware or hardware | 2.27 | 144 | 116 | pooled only |
| OV-24 | move × material | operate a live system × public datasets and papers | 2.20 | 87 | 62 | pooled only |
| OV-25 | move × material | automate a routine chore × circuits and printable parts | 1.88 | 65 | 138 | pooled only |
| OV-26 | move × material | audit or diagnose × learning material and skills | 1.73 | 132 | 35 | pooled only |
| OV-08 | move × material | coordinate many agents × financial and legal paperwork | 1.66 | 74 | 106 | registered, underpowered |
| OV-27 | move × material | reverse-engineer or unlock × business operations | 1.66 | 136 | 103 | pooled only |
| OV-28 | move × material | audit or diagnose × trips, meals and household logistics | 1.62 | 132 | 27 | pooled only |
| OV-05 | move × material | audit or diagnose × genome | 1.55 | 132 | 30 | registered, underpowered |
| OV-29 | move × material | automate a routine chore × a playable game | 1.50 | 65 | 147 | pooled only |
| OV-30 | move × material | audit or diagnose × molecules and lab experiments | 1.46 | 132 | 32 | pooled only |
| OV-31 | move × material | tutor or explain × consumer-device firmware or hardware | 1.45 | 38 | 116 | pooled only |
| OV-32 | move × material | reverse-engineer or unlock × public datasets and papers | 1.34 | 136 | 62 | pooled only |
| OV-33 | move × material | reverse-engineer or unlock × a playable game | 1.19 | 136 | 147 | pooled only |
| OV-34 | move × material | coordinate many agents × body and biometric data | 1.11 | 74 | 53 | pooled only |
| OV-35 | move × material | screen rank or map × a codebase | 1.08 | 16 | 317 | pooled only |
| OV-36 | move × material | port or translate × financial and legal paperwork | 1.06 | 51 | 106 | pooled only |
| OV-37 | move × material | draft routine documents × circuits and printable parts | 1.02 | 57 | 138 | pooled only |
| OV-38 | move × for | coordinate many agents × family or household | 3.50 | 74 | 64 | pooled only |
| OV-39 | move × for | port or translate × family or household | 2.80 | 51 | 64 | pooled only |
| OV-40 | move × for | tutor or explain × the public or a community | 2.76 | 38 | 165 | pooled only |
| OV-09 | move × for | reverse-engineer or unlock × a business or its customers | 2.66 | 136 | 231 | registered, underpowered |
| OV-41 | move × for | plan or schedule × the public or a community | 2.00 | 33 | 165 | pooled only |
| OV-42 | move × for | create creative media × researchers or science | 1.39 | 26 | 188 | pooled only |
| OV-43 | move × for | monitor over time × a business or its customers | 1.34 | 10 | 231 | pooled only |
| OV-44 | move × for | negotiate or dispute × researchers or science | 1.18 | 13 | 188 | pooled only |
| OV-45 | move × for | extract and structure × a child | 1.10 | 91 | 62 | pooled only |
| OV-15 | material × for | consumer-device firmware or hardware × researchers or science | 10.51 | 116 | 188 | registered, underpowered |
| OV-19 | material × for | financial and legal paperwork × the public or a community | 4.03 | 106 | 165 | registered, underpowered |
| OV-46 | material × for | robots, vehicles and drones × family or household | 3.04 | 74 | 64 | pooled only |
| OV-17 | material × for | consumer-device firmware or hardware × a business or its customers | 1.90 | 116 | 231 | registered, underpowered |
| OV-47 | material × for | personal and family archives × researchers or science | 1.80 | 23 | 188 | pooled only |
| OV-48 | material × for | a body of text or recordings × family or household | 1.75 | 55 | 64 | pooled only |
| OV-49 | material × for | a compiled binary or game ROM × family or household | 1.72 | 52 | 64 | pooled only |
| OV-50 | material × for | medical records and bills × the public or a community | 1.61 | 28 | 165 | pooled only |
| OV-51 | material × for | trips, meals and household logistics × researchers or science | 1.51 | 27 | 188 | pooled only |
| OV-52 | material × for | robots, vehicles and drones × a child | 1.39 | 74 | 62 | pooled only |
| OV-53 | material × for | a marketplace or other people's offers × the public or a community | 1.37 | 36 | 165 | pooled only |
| OV-54 | material × for | a playable game × a business or its customers | 1.32 | 147 | 231 | pooled only |
| OV-55 | material × for | genome × family or household | 1.23 | 30 | 64 | pooled only |
| OV-56 | material × for | financial and legal paperwork × a child | 1.07 | 106 | 62 | pooled only |
