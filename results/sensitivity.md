# Sensitivity of the replication verdicts to the expected-count model

1,563 pooled items, 1,049 new. 19 pre-registered cells. Rule (unchanged): replicated if O_new == 0, E_new >= 2 and pooled q <= 0.10; refuted if O_new > 0; otherwise underpowered. E_new is fitted on the new sample alone; q_pooled is Benjamini-Hochberg over the axis pair's cells with E_pooled >= 1 under the same model.

| cell | O_new | E_new independence | verdict independence | q_pooled independence | E_new quasi z=3 | verdict quasi z=3 | q_pooled quasi z=3 | E_new quasi z=4 | verdict quasi z=4 | q_pooled quasi z=4 | E_new quasi z=5 | verdict quasi z=5 | q_pooled quasi z=5 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| hole-move-material-01: audit or diagnose x a playable game | 1 | 8.28 | refuted | 0.001 | 2.64 | refuted | 0.933 | 1.83 | refuted | 0.914 | 2.04 | refuted | 0.757 |
| hole-move-material-02: investigate a question x a codebase | 6 | 24.29 | refuted | 0.000 | 10.08 | refuted | 0.933 | 12.50 | refuted | 0.914 | 14.40 | refuted | 0.790 |
| hole-move-material-03: operate a live system x a codebase | 11 | 17.60 | refuted | 0.234 | 9.86 | refuted | 0.995 | 11.12 | refuted | 0.999 | 15.87 | refuted | 1.000 |
| hole-move-material-04: audit or diagnose x body and biometric data | 2 | 3.20 | refuted | 0.394 | 3.04 | refuted | 0.933 | 2.62 | refuted | 0.914 | 3.89 | refuted | 0.757 |
| hole-move-material-05: audit or diagnose x genome | 0 | 1.15 | underpowered | 0.271 | 0.41 | underpowered | 0.933 | 0.40 | underpowered | 0.914 | 0.47 | underpowered | 0.821 |
| hole-move-material-06: extract and structure x a codebase | 0 | 18.09 | replicated | 0.000 | 4.86 | underpowered | 0.286 | 7.78 | underpowered | 0.694 | 7.29 | underpowered | 0.686 |
| hole-move-material-07: audit or diagnose x robots, vehicles and drones | 3 | 5.00 | refuted | 0.342 | 1.79 | refuted | 0.995 | 4.87 | refuted | 0.914 | 6.53 | refuted | 0.736 |
| hole-move-material-08: coordinate many agents x financial and legal paperwork | 0 | 3.88 | replicated | 0.052 | 0.60 | underpowered | 0.933 | 0.76 | underpowered | 0.914 | 1.32 | underpowered | 0.736 |
| hole-move-for-01: reverse-engineer or unlock x a business or its customers | 0 | 14.72 | replicated | 0.000 | 12.29 | underpowered | 0.963 | 3.78 | replicated | 0.000 | 10.22 | underpowered | 0.789 |
| hole-move-for-02: reverse-engineer or unlock x family or household | 1 | 3.40 | refuted | 0.166 | 1.94 | refuted | 0.983 | 1.47 | refuted | 0.364 | 4.02 | refuted | - |
| hole-move-for-03: design a physical thing x a business or its customers | 2 | 12.94 | refuted | 0.001 | 2.05 | refuted | 0.963 | 9.80 | refuted | 0.860 | 8.98 | refuted | 0.006 |
| hole-move-for-04: reverse-engineer or unlock x a child | 1 | 3.40 | refuted | 0.166 | 0.20 | refuted | - | 1.36 | refuted | 0.966 | 4.02 | refuted | - |
| hole-material-for-01: consumer-device firmware or hardware x family or household | 2 | 2.81 | refuted | 0.349 | 0.70 | refuted | 0.968 | 0.91 | refuted | 0.868 | 3.32 | refuted | 1.000 |
| hole-material-for-02: circuits and printable parts x family or household | 4 | 3.81 | refuted | 0.572 | 1.26 | refuted | 0.992 | 1.21 | refuted | 0.999 | 4.49 | refuted | 1.000 |
| hole-material-for-03: consumer-device firmware or hardware x researchers or science | 0 | 9.46 | replicated | 0.000 | 1.53 | underpowered | 0.003 | 1.99 | underpowered | 0.008 | 6.64 | underpowered | 0.627 |
| hole-material-for-04: circuits and printable parts x the public or a community | 2 | 13.65 | refuted | 0.001 | 4.40 | refuted | 0.968 | 4.20 | refuted | 0.868 | 14.04 | refuted | 0.808 |
| hole-material-for-05: consumer-device firmware or hardware x a business or its customers | 0 | 12.19 | replicated | 0.000 | 0.32 | underpowered | 0.968 | 0.67 | underpowered | 0.868 | 1.15 | underpowered | - |
| hole-material-for-06: circuits and printable parts x researchers or science | 1 | 12.80 | refuted | 0.000 | 2.76 | refuted | 0.968 | 2.65 | refuted | 0.868 | 8.99 | refuted | 0.889 |
| hole-material-for-07: financial and legal paperwork x the public or a community | 0 | 8.49 | replicated | 0.000 | 6.38 | underpowered | 0.855 | 6.15 | replicated | 0.055 | 4.88 | replicated | 0.016 |

Verdict totals (replicated / refuted / underpowered):

- independence: 6 / 12 / 1
- quasi z=3: 0 / 12 / 7
- quasi z=4: 2 / 12 / 5
- quasi z=5: 1 / 12 / 6

Check: quasi z=3 reproduces the official replication.json: yes.
