# Ruling: which Benjamini–Hochberg family the pre-registration meant

The question was raised by the numbers reviewer on 2026-11-03 and ruled on by the lead session the same day, after recomputing all three readings from `runs/r2/holes.json`.

PREREG.md (commit 0549f44) says a candidate replicates if, among other conditions, "it remains a hole in the pooled sample with Benjamini–Hochberg q ≤ 0.10 **across all empty cells of its axis pair**."

`gapfind replicate` was written after registration but before any replication result was seen. It used a different family: **all cells with E ≥ 1** in the pair.

Pooled q under three readings. Deficit p = P(X ≤ O | Poisson(E_quasi)); m is the family size.

| registered cell | O_new / E_new | literal: all empty cells | code: all cells E ≥ 1 | alternative: empty cells E ≥ 1 |
|---|---|---|---|---|
| extract and structure × a codebase (OV-06) | 0 / 4.86 | **0.497** (m=280) | 0.286 (m=161) | 0.037 (m=21) |
| consumer-device firmware or hardware × researchers or science (OV-15) | 0 / 1.53 | 0.002 (m=71) | 0.003 (m=96) | 0.000 (m=14) |
| financial and legal paperwork × the public or a community | 0 / 6.38 | 0.632 (m=71) | 0.855 (m=96) | 0.125 (m=14) |
| reverse-engineer or unlock × a business or its customers | 0 / 12.29 | 0.685 (m=39) | 0.963 (m=99) | 0.158 (m=9) |

## Ruling

- **The official count stays 0 of 19 replicated.** It holds under the literal registered wording, the controlling text, and under the code's family.
  - OV-06 fails the q gate under both: 0.497 and 0.286.
  - OV-15 passes the q gate under every reading, but fails the registered E_new ≥ 2 gate at 1.53.
- **Disclose the alternative reading everywhere the headline appears.** Restricting the family to empty cells with E ≥ 1, the candidate-eligible cells, would make OV-06 pass (q = 0.037) and the count 1. This reading is not what the registration says, so it is reported as a sensitivity, never as the result.
- **Correct earlier text.** Text that says the registered wording gives q = 0.037 is wrong; the registered wording gives 0.497. Correct it.
- **Lesson,** to state in the limits section: a pre-registration has to name its multiple-testing family exactly. "All empty cells" vs "empty cells with E ≥ 1" moves the headline.
