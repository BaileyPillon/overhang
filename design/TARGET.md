# Approved target: the Overhang app

Bailey picked **Mix A + B + C** on 2026-11-02 from the three mockups (screenshots in `design/options/`):
- `design/options/a-sky-survey.png`
- `design/options/b-zwicky-box.png`
- `design/options/c-paper.png`

## Why the mix works

Each direction is strongest at one job:
- **A** gives the first-screen wonder: real points glowing like a survey plate, with the holes as cataloged voids.
- **B** is where the evidence lives: the move × material matrix, with every count, every expected value, and every hole hatched.
- **C** carries the argument: a paper with sidenotes, equations, the honest failure of the Steam method, and the pre-registered test.

## Reaction log

- **Liked:** A's star plate and void labels with catalog codes; B's hatched holes printing E inside the cell, the marginal bars, the detail panel; C's abstract, its sidenotes, Figure 2 (the blend-artifact diagnosis), KaTeX, and the "every claim checkable" tone.
- **Must remain:**
  - real data everywhere, with honesty labels wherever a number is illustrative or exploratory;
  - both themes;
  - catalog codes (OV-NN) that are the same in the plate, the matrix and the tables;
  - sources one click away.
- **Must change:**
  - A's light theme is cream, a banned cliché. Use C's cool paper white instead.
  - Unify the type: the three mockups use three systems.
  - Voids on the plate must be honest. A 2D void placed in "empty-looking" space is a lie, because UMAP distorts. Instead, hovering or selecting a hole lights the two filaments it sits between (the items carrying its row value and its column value), with the void marker at the midpoint of their 2D centroids.
- **Still undecided:**
  - the winner section, which depends on what gets built;
  - whether the full catalog gets its own page (default yes, as a searchable table).

## Update 2026-11-02, later: "God's Eye View, but for AI use cases"

Bailey pointed at bilawalsidhu/gods-eye-view: a real-data 3D globe console with a HUD, layers, click-to-track and sensor reskins. That reframes the **hero and the overall shell**, so the options round is redone for that area only.

- **The direction:** a use-case globe built from a spherical UMAP of the embeddings, which is honest because normalized embeddings live on a hypersphere. Continents are dense clusters, oceans are sparse regions, and holes are uncharted rings between two coastlines. Click-to-track gives a contact panel; there are layers, sensor modes, and a LIVE layer of new reports.
- **The options**, in `design/options/`: G1 Orbital Console, G2 Globe then paper, G3 Mission wall.
- **Unchanged:** the matrix (B) and the paper and replication sections (C) stay as the evidence layer.
- **Rule:** use the genre, not a clone. No "God's Eye View" name, logo or copied layout.
- **Picked 2026-11-03: G1 + paper below.** G1's full Orbital Console is the first screen: layers, the tracked-contact panel, the hole catalog, sensor modes, and the equirectangular inset. "Read the evidence" leads into the paper sections: the matrix (B), the Steam-method failure, the pre-registered replication, sensitivity, the tagging audit, prior art, the winner, methods, and the catalog. The 2D plate from A is retired; the globe replaces it.

## Design system

- **Layout:** a full-bleed plate hero, then a paper column (about 680px) with a right sidenote margin. Figures break out to about 1200px, and the matrix figure takes full width with its detail panel on the right. Everything stacks on phones, and wide figures scroll inside their own container.
- **Theme:** dark-first, as a survey plate. Light is the printed negative (ink on cool paper).

| token | dark (default) | light (paper) | role |
|---|---|---|---|
| `--bg` | `#0A0F1C` | `#F5F7FA` | page |
| `--panel` | `#10172A` | `#FFFFFF` | figure ground |
| `--ink` | `#E9E6DD` | `#15171C` | text |
| `--dim` | `#8C95A8` | `#5B6372` | secondary text, ticks |
| `--rule` | `#243049` | `#D9DEE6` | hairlines |
| `--void` | `#8FD3E8` | `#17708C` | holes, voids, hatch; the one accent |
| `--ramp-0` → `--ramp-1` | `#151D33` → `#F1D9A6` (starlight) | `#EEF1F6` → `#1F3A8A` (cobalt) | matrix counts |
| `--refuted` | `#D98A6A` | `#B4532F` | refuted-hypothesis pills only |

- **Type:** Newsreader for display (italic for void names), Source Serif 4 for prose, IBM Plex Sans Condensed for UI, figure labels and sidenotes, IBM Plex Mono for numbers and catalog codes (tabular).
- **Stars:** restrained spectral tints per domain family (six families, as in A). Video items are slightly brighter. Never rainbow.
