# Pre-registration: candidate holes at N = 514

Registered 2026-11-02, before any replication data was collected. The git commit containing this file is the timestamp.

**Method.** Each of 514 sourced Claude use cases was tagged double-blind on three facets (move, material, for; Cohen's κ = 0.878 / 0.897 / 0.879) and adjudicated. Expected counts come from a quasi-independence model (IPF with structural cells masked, z = 3). A candidate hole is an empty cell with E ≥ 1.

**Replication test (decided now).** A new sample of about 1,100 use cases will be collected by agents who are never shown these cells. Each collector samples by a *single* facet value (one move, one material, or one beneficiary) or at random, never by a combination. A candidate **replicates** if (a) it stays empty in the new sample, with its expected count under the same quasi-independence model fitted on the new sample alone ≥ 2, and (b) it remains a hole in the pooled sample with Benjamini–Hochberg q ≤ 0.10 across all empty cells of its axis pair. A candidate that gains observations in the new sample is **refuted**. Prior-art items found later by targeted search are kept separate and never enter this test.

| id | cell | axes | E (quasi) | E (indep) | p | bootstrap | survives 2nd tagger | n_row | n_col |
|---|---|---|---|---|---|---|---|---|---|
| hole-move-for-01 | reverse-engineer or unlock × a business or its customers | move × for | 3.23 | 5.40 | 0.040 | 0.74 | no | 37 | 75 |
| hole-move-material-01 | audit or diagnose × a playable game | move × material | 2.38 | 4.12 | 0.093 | 0.24 | yes | 46 | 46 |
| hole-move-material-02 | investigate a question × a codebase | move × material | 2.31 | 5.10 | 0.099 | 0.38 | yes | 46 | 57 |
| hole-move-material-03 | operate a live system × a codebase | move × material | 2.26 | 1.77 | 0.104 | 0.10 | yes | 16 | 57 |
| hole-move-for-02 | reverse-engineer or unlock × family or household | move × for | 2.00 | 2.02 | 0.136 | 0.27 | yes | 37 | 28 |
| hole-material-for-01 | consumer-device firmware or hardware × family or household | material × for | 1.68 | 1.85 | 0.186 | 0.06 | no | 34 | 28 |
| hole-move-for-03 | design a physical thing × a business or its customers | move × for | 1.59 | 3.06 | 0.203 | 0.29 | no | 21 | 75 |
| hole-move-material-04 | audit or diagnose × body and biometric data | move × material | 1.51 | 1.25 | 0.221 | 0.09 | no | 46 | 14 |
| hole-move-material-05 | audit or diagnose × genome | move × material | 1.37 | 1.43 | 0.254 | 0.02 | no | 46 | 16 |
| hole-material-for-02 | circuits and printable parts × family or household | material × for | 1.33 | 1.47 | 0.263 | 0.02 | no | 27 | 28 |
| hole-move-material-06 | extract and structure × a codebase | move × material | 1.33 | 2.00 | 0.263 | 0.02 | no | 18 | 57 |
| hole-material-for-03 | consumer-device firmware or hardware × researchers or science | material × for | 1.32 | 4.43 | 0.267 | 0.09 | no | 34 | 67 |
| hole-material-for-04 | circuits and printable parts × the public or a community | material × for | 1.26 | 1.89 | 0.283 | 0.01 | no | 27 | 36 |
| hole-move-material-07 | audit or diagnose × robots, vehicles and drones | move × material | 1.19 | 1.16 | 0.304 | 0.07 | no | 46 | 13 |
| hole-material-for-05 | consumer-device firmware or hardware × a business or its customers | material × for | 1.14 | 4.96 | 0.319 | 0.01 | no | 34 | 75 |
| hole-move-material-08 | coordinate many agents × financial and legal paperwork | move × material | 1.14 | 1.08 | 0.321 | 0.01 | no | 15 | 37 |
| hole-material-for-06 | circuits and printable parts × researchers or science | material × for | 1.05 | 3.52 | 0.350 | 0.04 | no | 27 | 67 |
| hole-move-for-04 | reverse-engineer or unlock × a child | move × for | 1.05 | 1.87 | 0.351 | 0.04 | no | 37 | 26 |
| hole-material-for-07 | financial and legal paperwork × the public or a community | material × for | 1.02 | 2.59 | 0.360 | 0.01 | yes | 37 | 36 |
