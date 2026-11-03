# Corpus license

The one-sentence summaries in this corpus (the `title` and `text` fields of every entry in `raw/`, `grow-raw/` and `corpus.jsonl`), the facet vocabulary and definitions (`facets/vocab.json`), and the tags (`facets/tags.jsonl`) were written by the Overhang project and are licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). Cite them as "Overhang corpus, Bailey Pillon, 2026" with a link to the repository.

What this license does **not** cover:

- **Third-party content stays with its owners.** Each entry's `source` field links to the page where the report was found. The summaries describe what a source reports in our own words; they do not reproduce it. The sources, and anything written or made by the people who wrote them, belong to those authors and publishers under their own terms. Handles in the `who` field name the public author of a source.
- **No third-party datasets are redistributed** in this repository. Datasets and firmware sources used by Drift (for example the Clemson Pedometer Evaluation data and the Bangle.js step-count recordings) are downloaded from their owners by `drift/fetch/` into a git-ignored cache, and remain under their owners' terms.
- **Anchors.** Entries whose id starts with `anchors-` are representative tasks written from Anthropic's published usage reports, not individual people's reports. Each links to the report it was written from, which remains Anthropic's.

The code in this repository is under the MIT license (see `../LICENSE`).
