# Data-validity memo: Bangle.js (Espruino) step counter, 2021-05-01 to 2022-06-30

Prepared 2026-11-03 · Drift 0.1.0 · target `espruino_stepcount` · population: older adults, regular gait · gait type used: Regular · comparability threshold ±2 percentage points

> **Bottom line**
> **4 different step-counting algorithms were live during this window** (2v09, 2v10, 2v11, 2v12–2v21), with 3 boundaries. Which one a participant's watch ran depends on when they updated, which is unknown unless the firmware version was logged. Drift covers firmware from 2v09 on; anything older is not covered.
> For Regular gait on the Clemson recordings the data cannot tell the generations apart on average: the 95% CI of the mean shift includes 0 at every adjacent boundary: 2v09 → 2v10 [-4.2, +4.3]; 2v10 → 2v11 [-2.4, +0.7]; 2v11 → 2v12–2v21 [-0.8, +0.8]. That is absence of evidence of a mean shift, not evidence that counts are interchangeable: the same intervals are too wide to rule out shifts larger than ±2 points at 2 of 3 boundaries.
> Verdict per adjacent boundary, after the native cross-check below: not confirmed (the Clemson CI is inside ±2 points but the native Bangle.js walking recordings disagree): 2v11 → 2v12–2v21; not comparable: 2v09 → 2v10; 2v10 → 2v11. 'Comparable' here means only that the mean paired shift is within ±2 points; individual participants' counts can still differ (section 3).
> Largest point shift in walking count error for Regular gait on Clemson: -0.9 points [-2.4, +0.7] at 2v10 → 2v11.
> **The native Bangle.js walking recordings (6 files, 1 wearer) disagree with Clemson.** At 2v09 → 2v10 the Clemson mean shift is -0.1 points but the native walks move by a mean of +35.7 (range +9.2 to +53.2). The transfer from the Clemson recordings (young adults, 15 Hz sensor resampled to 12.5 Hz) to Bangle.js data is **unvalidated**; treat the Clemson shifts as estimates for that cohort and resampler only.
> For other gait types the generations do differ clearly: Irregular gait shifts -460.8 points [-512.3, -411.7] at 2v09 → 2v10 (Clemson).
> Outside walking the generations differ in what they count: on 5 drive and train recordings from one wearer (HughB; 2.41 h in total) they count between 86 and 2122 steps per hour above the expected total of each file. This rests on a handful of files from one wearer and carries no confidence interval.

## 1. Which firmware was live

Each row is a distinct step-counting algorithm, found by comparing the git blob of the algorithm source at every release tag. Dates are the commit dates of the release tags. A watch only runs a version after its owner installs it, and owners update on their own schedule, so the real switch date of any participant is later than the tag date and is unknown unless the firmware version was logged. Firmware older than 2v09 is not covered.

| Release tags | What the algorithm does | Released | Superseded | Days in window | Source |
| --- | --- | --- | --- | --- | --- |
| 2v09 | inline hysteresis | 2021-04-19 | 2021-08-13 | 104 d | inline in jswrap_bangle.c |
| 2v10 | bandpass FIR + history gate | 2021-08-13 | 2021-12-15 | 124 d | `9c2c3738` |
| 2v11 | state machine + raw gate | 2021-12-15 | 2022-02-01 | 48 d | `e33e1183` |
| 2v12 to 2v21 | DC filter | 2022-02-01 | 2024-05-21 (next code change; behaviourally identical on every recording) | 150 d | `afb4943c` |

## 2. Expected bias of each generation (Regular gait)

Count error is (counted − true) / true, in percent, per Clemson subject and gait type (n = 30 subjects). Positive means over-counting. The step-level F1 matches each detected step to a video-annotated step within ±100 ms or ±250 ms after aligning the two event trains by a constant (estimated on the other half of the subjects; it is a phase, not a device latency, see section 6). Steps per hour is the count above the expected total on 5 drive and train recordings from one wearer (HughB; 2.41 h in total): 0_HughB_train_journey_b31 (0 expected), HughB-drive-18 (18 expected), HughB-drive-29min-0 (0 expected), HughB-drive-36min-0 (0 expected), HughB-drive-a3-b136 (3 expected). In Regular gait the median interval between annotated steps is 0.53 s, so a ±250 ms window spans 94% of it and a ±100 ms window 38%. A wide window barely separates a step detector from guessing: the table therefore also shows the F1 of the same number of detections at random times and of an oracle metronome (the file's own mean cadence at the best phase, no sensor data). Read the F1 columns against those two rows, and prefer ±100 ms. The calibration cohort is the Clemson Pedometer Evaluation Project: 30 adults aged 19 to 27 (median 22), each walking a regular, a semi-regular and an irregular course with wrist, hip and ankle sensors and video-annotated steps. The requested population ('older adults, regular gait') is not represented by an age-matched cohort, so treat the numbers as the best available proxy for gait type 'Regular', not as measurements of that population. An independent treadmill study of the Bangle.js 2 found heavy undercounting at slow speeds (see the Ravanelli et al. entry below), so the near-zero Regular-gait bias of young adults must not be read as applying to slow or older walkers. 6.8% of the annotated Clemson steps are weight-shift steps ('leftshift'/'rightshift') and are counted as true steps; removing them from the truth moves the Regular median error of 2v12–2v21 from -0.3 to -0.0 (full table in the results JSON).

| Generation | Mean error, % [95% CI] | Median error, % (IQR) | Step F1 at ±100 ms [95% CI], 15 test subjects | Step F1 at ±250 ms [95% CI] | F1 of the same number of detections at random times (±100 / ±250 ms) | Steps/h while driving or on a train |
| --- | --- | --- | --- | --- | --- | --- |
| 2v09 | -0.8 [-5.6, +3.8] | +2.7 (-12.3 to +8.0) | 0.36 [0.25, 0.48] | 0.82 [0.77, 0.87] | 0.30 / 0.59 | 2122 |
| 2v10 | -0.9 [-2.2, +0.1] | +0.3 (-0.9 to +0.8) | 0.57 [0.40, 0.71] | 0.95 [0.91, 0.98] | 0.30 / 0.59 | 832 |
| 2v11 | -1.8 [-3.7, -0.2] | -0.8 (-2.7 to +0.6) | 0.54 [0.40, 0.68] | 0.93 [0.88, 0.97] | 0.30 / 0.59 | 270 |
| 2v12 to 2v21 | -1.8 [-3.8, -0.2] | -0.3 (-2.2 to +0.7) | 0.55 [0.40, 0.68] | 0.93 [0.89, 0.97] | 0.30 / 0.59 | 86 |
| Oracle metronome (not a firmware) | - | - | 0.45 [0.43, 0.48] | 0.95 [0.93, 0.96] | - | - |

## 3. Shift between generations and comparability

The shift is the mean over subjects of the paired difference in count error (later minus earlier generation), in percentage points of the true count, with a 95% bootstrap CI over subjects (10,000 resamples, seed 42). **'Mean shift within ±2' means only that the whole CI of the MEAN shift lies within ±2 points.** It does not mean that individual counts agree: the table also gives the SD of the per-subject changes, how many subjects move by more than ±2 points, and the largest single change. Anything else is 'not shown to be within', including the case where the estimate is small but the CI is too wide to show it.

| Generation pair | Adjacent | Mean shift, points | 95% CI | SD of per-subject changes | Subjects changing by more than ±2 | Largest single change | Mean shift with linear resampling [95% CI] | Clemson verdict | Basis |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2v09 → 2v10 | yes | -0.11 | [-4.22, +4.27] | 12.12 | 26 of 30 | 37.39 | +5.10 [+0.75, +9.80] | mean shift not shown to be within ±2 | point estimate is small but the CI is wider than ±2 |
| 2v09 → 2v11 | no | -1.01 | [-5.16, +3.39] | 12.18 | 28 of 30 | 34.83 | +3.96 [-0.63, +9.00] | mean shift not shown to be within ±2 | point estimate is small but the CI is wider than ±2 |
| 2v09 → 2v12–2v21 | no | -1.00 | [-4.98, +3.31] | 11.82 | 29 of 30 | 33.71 | +3.66 [-0.65, +8.34] | mean shift not shown to be within ±2 | point estimate is small but the CI is wider than ±2 |
| 2v10 → 2v11 | yes | -0.90 | [-2.43, +0.72] | 4.38 | 11 of 30 | 14.21 | -1.14 [-2.77, +0.76] | mean shift not shown to be within ±2 | point estimate is small but the CI is wider than ±2 |
| 2v10 → 2v12–2v21 | no | -0.90 | [-2.35, +0.37] | 3.85 | 11 of 30 | 16.67 | -1.45 [-2.74, -0.05] | mean shift not shown to be within ±2 | point estimate is small but the CI is wider than ±2 |
| 2v11 → 2v12–2v21 | yes | +0.01 | [-0.82, +0.83] | 2.29 | 6 of 30 | 6.67 | -0.31 [-1.65, +0.83] | **mean shift within ±2** | CI inside ±2 |

**Resampler sensitivity.** The Clemson sensor runs at 15 Hz and the watch at 12.5 Hz, so every recording is resampled; Drift's default is a polyphase filter. Re-running with plain linear interpolation (same firmware, same recordings) changes the Regular shift at the adjacent boundaries as follows (poly → linear): 2v09 → 2v10 -0.11 → +5.10 [+0.75, +9.80]; 2v10 → 2v11 -0.90 → -1.14 [-2.77, +0.76]; 2v11 → 2v12–2v21 +0.01 → -0.31 [-1.65, +0.83]. Median count errors of the newest live generation move too (Regular 2v12–2v21 median -0.3 → -0.9; SemiRegular 2v12–2v21 median -4.7 → -11.2; Irregular 2v12–2v21 median +21.5 → +10.2). The comparability verdict for Regular gait changes at 0 of 6 generation pairs. Count-error medians for the semi-regular and irregular gaits are resampler-sensitive and should not be quoted without this caveat.

**Cross-check on the native Bangle.js walking recordings.** The only data that went through the firmware exactly as recorded are the 6 labelled walking files (HughB, one wearer, 12.5 Hz, no resampling). Per-file shift = error after minus error before, in points of the file's expected total (no CI: six files, one wearer). The overall verdict is 'comparable' only when both the Clemson CI and the native walks (mean and median) are within ±2.

| Generation pair | Adjacent | Native walks: mean (median; range) | Files moving by more than ±2 | Clemson mean shift [95% CI] | Overall verdict |
| --- | --- | --- | --- | --- | --- |
| 2v09 → 2v10 | yes | +35.7 (median +40.4; range +9.2 to +53.2) | 6 of 6 | -0.11 [-4.22, +4.27] | **not comparable** |
| 2v09 → 2v11 | no | +28.4 (median +37.2; range -19.6 to +51.1) | 6 of 6 | -1.01 [-5.16, +3.39] | **not comparable** |
| 2v09 → 2v12–2v21 | no | +25.4 (median +34.0; range -23.1 to +47.7) | 6 of 6 | -1.00 [-4.98, +3.31] | **not comparable** |
| 2v10 → 2v11 | yes | -7.3 (median -3.4; range -28.8 to -2.1) | 6 of 6 | -0.90 [-2.43, +0.72] | **not comparable** |
| 2v10 → 2v12–2v21 | no | -10.3 (median -7.1; range -32.3 to -2.7) | 6 of 6 | -0.90 [-2.35, +0.37] | **not comparable** |
| 2v11 → 2v12–2v21 | yes | -3.0 (median -3.4; range -5.2 to +0.6) | 4 of 6 | +0.01 [-0.82, +0.83] | **not confirmed (native walks disagree)** |

Same adjacent boundaries for the other gait types on Clemson (shift in points with 95% CI; * = mean shift not shown to be within ±2):

| Boundary | Regular | SemiRegular | Irregular | All gaits |
| --- | --- | --- | --- | --- |
| 2v09 → 2v10 | -0.1 [-4.2, +4.3] * | -22.8 [-27.4, -18.2] * | -460.8 [-512.3, -411.7] * | -161.2 [-178.2, -144.9] * |
| 2v10 → 2v11 | -0.9 [-2.4, +0.7] * | -17.1 [-21.4, -12.9] * | -146.7 [-160.8, -132.7] * | -54.9 [-60.0, -49.8] * |
| 2v11 → 2v12–2v21 | +0.0 [-0.8, +0.8] | -3.3 [-4.6, -2.0] * | -17.8 [-22.0, -13.8] * | -7.0 [-8.4, -5.7] * |

Multiplicity and margin: 6 generation pairs × 4 gait types are examined here without correction for multiple comparisons, and the ±2-point margin is a convention, not derived from any study's tolerance. The percentile bootstrap intervals are a few percent narrower than t-intervals at n = 30 (the t-interval of every shift is in the results JSON as ci_t_pct), so a verdict close to the margin is fragile.

## 4. Recommendations

- **Record the firmware version of every participant's device at every sync**, not the model name alone. Without it, the table above cannot be applied to your data.
- **Stratify by generation** in any analysis that spans a boundary that is not established as comparable, or include generation as a covariate; do not pool pre- and post-boundary counts as one measurement.
- **Where raw acceleration exists, re-derive steps with one fixed algorithm version.** Drift can replay every participant's raw data through a single generation (python -m drift replay), which removes the firmware effect instead of modelling it.
- **Treat non-walking time separately.** On the few non-walking recordings available the generations differ in what they count while the wearer is not walking. Drift has not computed daily totals, so how much this changes a participant's day is not measured here.
- **Report the version in the paper.** The sources below show that unreported version changes are a known threat to validity.

## 5. Why this matters: evidence

- **Ravanelli N, Lefebvre K, Brough A, Paquette S, Lin W. Validation of an Open-Source Smartwatch for Continuous Monitoring of Physical Activity and Heart Rate in Adults. Sensors 2025;25(9):2926.** Validated the step counter of the Bangle.js 2, the watch whose firmware Drift replays, against a Fitbit Charge 5 (47 adults, 24 h free-living, plus a treadmill and stair session). A firmware update (V2.19) landed during data collection; the paper describes it as replacing the filter used for heart-beat detection, and two participants did the 24 h condition once before and once after it. The paper does not report a before/after comparison of step counts, so what that update did to steps is unmeasured. The Bangle.js 2 undercounted at every treadmill speed, heavily at slow ones (mean absolute percent error 56.0% at 2 mph, 14.3% at 3, 14.6% at 4, 6.1% at 5 mph), so a near-zero bias measured on young adults walking at a normal pace does not carry over to slow or older walkers. The authors describe its step algorithm as a finite state machine. [Source](https://pmc.ncbi.nlm.nih.gov/articles/PMC12074211/)
- **Woolley SI, Collins T, Mitchell J, Fredericks D. Investigation of wearable health tracker version updates. BMJ Health Care Inform 2019;26(1):e100083.** Read the changelogs of six wrist-worn trackers (device models used in clinical-trial registrations): 194 update items, 32% judged as possibly affecting device validation. Only the Polar changelog carried dates, and for that one the intervals between updates ranged from 5 to 218 days. Because devices can update during synchronisation, firmware changes can be applied in the middle of a study without the researchers noticing. The authors conclude that firmware updates can nullify device validations. [Source](https://pmc.ncbi.nlm.nih.gov/articles/PMC7062347/)
- **Collins T, Woolley SI, Oniani S, Pires IM, Garcia NM, Ledger SJ, Pandyan A. Version Reporting and Assessment Approaches for New and Updated Activity and Heart Rate Monitors. Sensors 2019;19(7):1705.** Argues that validity is not maintained when firmware and software updates change device performance, that devices with the same model name but different versions are distinct devices, and that version numbers belong in the study report. As an illustration they note that one Garmin model went through 14 versions in about 30 months. Their own experiment tested a single version, so it demonstrates the problem and a re-assessment method rather than measuring an update's effect. [Source](https://pmc.ncbi.nlm.nih.gov/articles/PMC6480461/)
- **Koffman L, Crainiceanu C, Muschelli J. Comparing Step Counting Algorithms for High-Resolution Wrist Accelerometry Data in NHANES 2011-2014. arXiv:2410.11040 (2024).** Ran five step-counting algorithms on the same NHANES wrist recordings. The estimates were correlated and predicted mortality about equally well, but the population mean daily step counts ranged from 2,453 to 12,169 and the hazard ratio for a 500-step increase ranged from 0.88 to 0.96. This is algorithm choice, not firmware version; it shows how far the same raw data can move when the step algorithm changes, which is the question Drift asks of each release. [Source](https://arxiv.org/abs/2410.11040)
- **Williams G. step-count: offline test harness for the Espruino step counter (GitHub repository).** The technique Drift builds on: a small C harness that runs Espruino's own step-counter code over recorded accelerometer files and prints the difference between the expected and the calculated count. Drift applies that idea to every released version of the code, adds the Clemson recordings, and turns the differences into dated, uncertainty-bounded shifts. Its recordings are used here by reference and are not redistributed. [Source](https://github.com/gfwilliams/step-count)

## 6. Method and limits

- Differential execution: the step-counter source of each generation is compiled for the host and every recording is replayed through all of them, identical input each time. Null controls: generations that differ from 2v12–2v21 only cosmetically (2v22–2v28) or by an unreachable clamp fix (2v29) produce identical counts and step events on all 126 recordings, as the tests assert.
- Only the step-counting function is replayed. Changes to the sensor driver, sampling or device settings would not show up here.
- Clemson data (15 Hz, g) is resampled to the device's 12.5 Hz, 8192 counts per g; the results depend on the resampler (section 3). The Clemson wrist sensor recorded raw acceleration only between −2 and +2 g (Mattfeld et al. 2021), so strong peaks are clipped; the Bangle.js counter works on a wider range (int16 at 8192 counts per g, about ±4 g). Part of the Irregular and SemiRegular error may reflect that and the resampling rather than the algorithms. Clemson's ground truth is video-annotated steps, including weight-shift steps. The data files carry no header or documentation: that the first three of the nine columns are the wrist sensor is an assumption (the paper lists wrist, hip and ankle; the ankle triple is clearly the most energetic in all 90 files, but wrist and hip cannot be told apart by amplitude).
- The Bangle.js recordings' ground truth is a per-file expected total taken from the file name and upstream main.c; how those totals were produced is not documented in the repository. Most files come from one wearer.
- The Clemson subjects are a small cohort of young adults; CIs reflect between-subject variation only, not population mismatch. The Clemson-to-Bangle.js transfer is unvalidated: the native walking files disagree (section 3).
- The per-step alignment value is the maximum of a cross-correlation estimated on the even-numbered subjects and applied to the odd-numbered ones. Gait is periodic, so it is identified only modulo the step period (~0.5 to 0.6 s): it is a phase for aligning the event trains, not a device latency, and it is published only for transparency. The CIs for step metrics use the 15 test subjects.
- 'All gaits' means different things for different columns: for count error it is the equal-weight mean of a subject's three per-gait errors (dominated by the Irregular gait); for step matching it pools the step counts of the three gaits.
- The plain-language description of each generation is written by Claude from the code diff.

## 7. Data sources and citations

- **Clemson Pedometer Evaluation Project** (30 subjects × 3 gaits, 15 Hz, video-annotated steps): Mattfeld R, Jesch E, Hoover A. A new dataset for evaluating pedometer performance. IEEE International Conference on Bioinformatics and Biomedicine (BIBM) 2017:865-869; Mattfeld R, Jesch E, Hoover A. Evaluating Pedometer Algorithms on Semi-Regular and Unstructured Gaits. Sensors 2021;21(13):4260, doi:10.3390/s21134260. Data page: [cecas.clemson.edu/~ahoover/pedometer](https://cecas.clemson.edu/~ahoover/pedometer/). The page states no licence; the data is fetched from there and not redistributed.
- **Bangle.js step-count harness and recordings**: Gordon Williams, [gfwilliams/step-count](https://github.com/gfwilliams/step-count) (no licence stated; referenced at a pinned commit, not redistributed). The recordings were contributed by Espruino forum users (HughB, cartron, d3nd3-o0, Pablo, Guillaume_G, MrPloppy) for calibrating the step counter, in the threads [Better Pedometer - HELP NEEDED!](http://web.archive.org/web/20241221151609/https://forum.espruino.com/conversations/359542/) and [Pebble vs Bangle](http://web.archive.org/web/20241221145916/https://forum.espruino.com/conversations/371740/) (Wayback copies; the live URLs now redirect to the Espruino GitHub discussions).
- **Espruino firmware** (MPL-2.0): [espruino/Espruino](https://github.com/espruino/Espruino), fetched at the pinned release tags and compiled locally.

Reproduce: python -m drift memo --target espruino_stepcount --start 2021-05-01 --end 2022-06-30 --population "older adults, regular gait" · python -m drift all runs the whole pipeline from a clean cache. Algorithm commits: 2v10 9c2c3738, 2v11 e33e1183, 2v12–2v21 afb4943c.
