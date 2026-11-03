# Drift: firmware forensics for science

Drift measures how each released firmware version of an **open-source** wearable changes the research metric it reports. It compiles the metric algorithm from every version for the host, replays the **same recorded raw sensor data** through all of them (differential execution), and writes a dated data-validity memo for a study team.

## Why it exists

Consumer wearables are used as research instruments, and vendors change their step, heart-rate and sleep algorithms in firmware updates, which can make cohort data from before and after an update non-comparable. The literature argues this risk rather than measuring it: Collins et al. 2019 (*Sensors* 19(7):1705) argue that validity is not maintained when updates change device performance and recommend reporting device versions (their own experiment tested a single firmware version), and Woolley et al. 2019 (*BMJ Health Care Inform* 26(1):e100083) found that 32% of 194 changelog items across six trackers could affect validation. Neither measures an update's effect on a metric; Drift's differential runs do. Overhang's map of what people build with Claude showed a measured hole at exactly this intersection: consumer-device firmware or hardware, for researchers or science. Observed 0 in 1,563 pooled items. The full reasoning, the pre-registered result and the honesty notes are in [../design/WINNER.md](../design/WINNER.md).

The firmware Drift compiles is open source (Espruino MPL-2.0; InfiniTime GPL-3.0-or-later with LGPL-3.0-or-later heart-rate files). The recordings are a different matter: they are third-party data, several with no stated terms, so Drift fetches them from their owners, cites them and **never redistributes them**.

## Headline numbers

Filled from `results/drift/espruino_stepcount.json` after a run of `python -m drift all --target espruino_stepcount` (2026-11-03). Medians over 30 Clemson subjects, count error in %, IQR in brackets. Read the verdict rows before the accuracy rows: the Clemson numbers are for 30 young adults on a 15 Hz sensor resampled to 12.5 Hz, and **the native Bangle.js recordings disagree with them** (see below).

| Quantity | Value | Command |
|---|---|---|
| Generations (Espruino 2v09 to 2v29, pinned tags) | 6 (replayed on 126 recordings) | `python -m drift all --target espruino_stepcount` |
| Median count error (%), Clemson regular gait | 2v09 +2.7 (-12.3 to +8.0) / 2v10 +0.3 (-0.9 to +0.8) / 2v11 -0.8 (-2.7 to +0.6) / 2v12–2v21 -0.3 (-2.2 to +0.7) | same (results/drift/espruino_stepcount.json) |
| Median count error (%), semi-regular and irregular gait (resampler-sensitive, see below) | semi: +36.8 / +14.9 / +1.7 / -4.7; irregular: +632.8 / +174.3 / +35.8 / +21.5 | same |
| Mean shift at boundary 2v09 to 2v10, Clemson regular (95% CI) | -0.11 points [-4.22, +4.27]; SD of per-subject changes 12.1, 26 of 30 subjects move by more than ±2, largest +37 | same |
| Mean shift at boundary 2v10 to 2v11 (95% CI) | -0.90 points [-2.43, +0.72]; SD 4.4, 11 of 30 beyond ±2, largest 14 | same |
| Mean shift at boundary 2v11 to 2v12 (95% CI) | +0.01 points [-0.82, +0.83]; SD 2.3, 6 of 30 beyond ±2, largest 6.7 | same |
| Same boundaries on the 6 native Bangle.js walking files (one wearer, mean / median / range) | 2v09 to 2v10 +35.7 / +40.4 / +9.2 to +53.2; 2v10 to 2v11 -7.3 / -3.4 / -28.8 to -2.1; 2v11 to 2v12 -3.0 / -3.4 / -5.2 to +0.6 | same |
| Verdict per adjacent boundary after the native cross-check | 2v09 to 2v10 not comparable; 2v10 to 2v11 not comparable; 2v11 to 2v12 **not confirmed** (Clemson CI inside ±2, native walks disagree). None is established as comparable. | same (memo) |
| Same walk of 10021 steps, counted by 2v09 / 2v10 / 2v11 / 2v12 | 12222 / 13140 / 10253 / 9903 (identical with or without upstream's tail flush) | same |
| False positives, steps per hour above the expected total, 2v09 / 2v10 / 2v11 / 2v12–2v21 (5 drive and train files, one wearer, 2.41 h, no CI) | drive only (4 files): 2453 / 1357 / 437 / 136; drive plus train (5 files): 2122 / 832 / 270 / 86 | same |
| Per-step F1, all gaits, test half, ±250 ms | 2v09 0.564 / 2v10 0.792 / 2v11 0.813 / 2v12–2v21 0.822; same number of detections at random times 0.408 / 0.466 / 0.481 / 0.482; oracle metronome (no firmware) 0.756 | same |
| Per-step F1, all gaits, test half, ±100 ms (the discriminating window) | 0.259 / 0.441 / 0.458 / 0.461; random timing 0.209 / 0.232 / 0.238 / 0.238; oracle metronome 0.351 | same |
| Null controls (2v22 to 2v28, 2v29 vs 2v12 to 2v21) | identical on all 126 recordings (asserted by test) | `python -m pytest drift/tests -q` |

Reading the F1 rows: in Regular gait the median interval between annotated steps is 0.53 s, so a ±250 ms window spans 94% of it and an oracle metronome that knows the file's cadence and phase scores 0.945 without any sensor data (Regular gait). F1 at ±250 ms therefore says little on its own; ±500 ms is not reported. Count-error medians for semi-regular and irregular gait move materially with the resampler: with plain linear interpolation instead of the polyphase default the 2v12–2v21 medians go from -4.7 to -11.2 (semi-regular) and from +21.5 to +10.2 (irregular), and the Regular 2v09 to 2v10 shift goes from -0.11 [-4.22, +4.27] to +5.10 [+0.75, +9.80] (results JSON: `resampler_sensitivity`).

Already measured and reproduced against upstream's own `main.c` (Bangle.js recordings, built live by `tests/test_upstream_live.py`, upstream tail-flush conditions, `--flush`): the 10021-step walk above, and the drive recording named `drive-36min-0` (32 minutes of data) counts 1199 / 486 / 160 / 45 steps under 2v09 / 2v10 / 2v11 / 2v12. Without the flush, which is what a device does, the same file counts 1199 / 483 / 160 / 45. (Upstream flushes `ACCELFILTER_TAP_NUM` samples: 57 for the 2v10 blob, 7 for 2v11 and later; Drift reads the number from each blob.)

## Quickstart

Run from the repository root with the project venv active (the commands below show it as `python`; on Windows call `.venv\Scripts\python.exe` directly if you do not activate it).

```
python -m pip install -r drift/requirements.txt
python -m drift fetch  --target espruino_stepcount   # firmware source + datasets into .cache/drift/
python -m drift build  --target espruino_stepcount   # tags -> generations -> one compiled library each
python -m drift replay --target espruino_stepcount   # every generation x every recording
python -m drift all    --target espruino_stepcount   # fetch, build, replay, metrics, memo, export
python -m pytest drift/tests -q                      # 112 tests: live upstream reproduction, null controls, adapters, history, pins
```

The memo command on its own is:

```
python -m drift memo --target espruino_stepcount --start 2021-05-01 --end 2022-06-30 --population "older adults, regular gait"
```

No C compiler is needed on the machine: Drift uses the `ziglang` pip package (bundled clang) through `drift/toolchain.py`.

**Reproducibility contract.** The numbers, not the bytes. Every value except dates is a pure function of the pinned inputs: the Bangle recordings at commit d4b015c, the Clemson `Data.zip` and `demographics.csv` (SHA-256 pinned), the Espruino release tags `RELEASE_2V09` to `RELEASE_2V29` and the commit each points at (a digest is checked; newer tags are ignored with a warning; `DRIFT_ALLOW_UNPINNED=1` downgrades a mismatch to a warning), the InfiniTime release tags 0.11.0 to 1.16.1, the toolchain and the fixed bootstrap seed. The date stamped into the results JSON and the memo is today's unless pinned with `--date YYYY-MM-DD`, `DRIFT_DATE` or `SOURCE_DATE_EPOCH`; with the date, library versions and platform pinned the output files are byte-identical. The pitch and pick text in `app/public/data/winner.json` comes from the tracked `drift/winner_source.json`, so that file also regenerates from scratch.

## Targets

| Target | Firmware | Metric | Generations | Status |
|---|---|---|---|---|
| `espruino_stepcount` (hero) | Bangle.js / Espruino, MPL-2.0 | step count, `libs/misc/stepcount.c` plus the 2v09 inline counter | 2v09 inline, 2v10, 2v11, 2v12 to 2v21, 2v22 to 2v28 (null control), 2v29 (null control) | built, tests pass |
| `infinitime_hr` (secondary) | PineTime / InfiniTime, GPL-3.0-or-later (heart-rate files of 0.11 to 1.12: LGPL-3.0-or-later) | heart rate, `Ppg.cpp` | A: autocorrelation, 24 Hz, 0.11 to 1.12; B: FFT, 10 Hz, 1.13 and later (plus one null control) | built, tests pass; algorithm layer only, see [targets/infinitime_hr/README.md](targets/infinitime_hr/README.md) |

Not targets: PineTime step counting (runs in closed Bosch BMA421 microcode) and Bangle.js 2 heart rate (proprietary binary blob). Adding a new device: see [skill/SKILL.md](skill/SKILL.md), a Claude Code skill (`drift-onboard-device`).

## Datasets

Fetched by `drift/fetch/` into `.cache/drift/` (gitignored; `drift/recon/dl/` and the other recon scratch copies are gitignored too and a test fails if anything third-party would be added). **Nothing third-party is committed.**

| Dataset | Use | Source | License |
|---|---|---|---|
| Bangle.js step-count recordings: 36 files, 12.5 Hz, raw counts, per-file expected totals taken from the file name and upstream `main.c` (provenance undocumented), drive and train files with 0 to 18 expected steps | native input; false positives | https://github.com/gfwilliams/step-count @ d4b015c; contributed in the Espruino forum threads [Better Pedometer - HELP NEEDED!](http://web.archive.org/web/20241221151609/https://forum.espruino.com/conversations/359542/) and [Pebble vs Bangle](http://web.archive.org/web/20241221145916/https://forum.espruino.com/conversations/371740/) (Wayback copies; the live URLs now redirect to the Espruino GitHub discussions) | none stated (no LICENSE file; all rights reserved by default); uploads were offered for firmware calibration, not research republication; referenced, never redistributed |
| Clemson Pedometer Evaluation: 30 subjects x 3 gaits, wrist accelerometer at 15 Hz in g, video-annotated step times | accuracy, per-step matching | https://cecas.clemson.edu/tracking/Pedometer/Data.zip (page: https://cecas.clemson.edu/~ahoover/pedometer/) | none stated; the papers below are to be cited |
| PhysioNet Wrist PPG During Exercise (secondary target) | heart-rate replay | https://physionet.org/content/wrist/1.0.0/ | Open Data Commons Attribution v1.0 (attribution required for derived results) |
| InfiniTime community PPG recordings, 6 files, no ground truth (agreement only) | heart-rate replay | https://github.com/marcinkosztolowicz/InfiniTime, branch `heart-rate-debug-tools`, pinned commit and file hashes | repo license applies; referenced only |

Citations:
- Clemson: Mattfeld R, Jesch E, Hoover A. A new dataset for evaluating pedometer performance. IEEE BIBM 2017:865-869; Mattfeld R, Jesch E, Hoover A. Evaluating Pedometer Algorithms on Semi-Regular and Unstructured Gaits. *Sensors* 2021;21(13):4260, doi:10.3390/s21134260 (CC BY). Resampled 15 to 12.5 Hz (polyphase, documented), scaled to counts; the two recordings with out-of-range step indices are clipped. The page says 60,000+ steps, the Sensors paper 60,805, Drift's count of the annotation files is 60,801.
- PhysioNet wrist PPG: Jarchi D, Casson AJ. *Data* 2(1):1, 2017, doi:10.3390/data2010001, and the standard PhysioNet citation the dataset page asks for (Pollard et al. 2026, *Nature Health*, doi:10.1038/s44360-026-00096-z, as given on that page).
- Collins et al. 2019 and Woolley et al. 2019 are cited as in the memo (each claim there is checked against its source). Woolley et al. is CC BY-NC; Drift paraphrases it and links the source. "Not all steps are equal" (BJSM blog, Alharbi et al. 2017) is about a Fitbit change in counting moderate-to-vigorous activity minutes and is not used as support for step or firmware drift.

## Limits

- **The Clemson transfer to Bangle.js is unvalidated.** On the six native Bangle.js walking files (one wearer, no resampling) the boundary shifts disagree with Clemson's: 2v09 to 2v10 +36 points on average against -0.11, 2v10 to 2v11 negative in 6 of 6 files (median -3.4, range -28.8 to -2.1) against -0.9, 2v11 to 2v12 -3.0 on average (4 of 6 files beyond ±2) against +0.01. 2v09 on the native walks has a mean error of -30.5% (range -55.7% to +22.0%) against Clemson's +2.7% median, and 2v12 undercounts them by 5.0% on average against -1.8% mean (-0.3% median) on Clemson regular gait. The cause (resampling, wrist placement, wearer, sensor, single subject) is not identified. Drift reports both and downgrades a Clemson "comparable" to "not confirmed" when the native walks disagree.
- **A "comparable" verdict is about the mean.** It means the 95% bootstrap CI of the mean paired shift lies within ±2 points. Individual participants can still change more (the memo reports the SD, the number of subjects beyond ±2 and the largest change); 6 pairs x 4 gaits are examined without multiplicity correction; the margin is a convention; percentile bootstrap intervals are a few percent narrower than t-intervals at n = 30 (`ci_t_pct` in the JSON).
- **Resampler-sensitive.** Clemson is 15 Hz and is resampled to the device's 12.5 Hz (polyphase by default). Linear interpolation gives materially different count errors for semi-regular and irregular gait and different boundary CIs; the results JSON and the memo show both. The Clemson wrist sensor recorded only -2 to +2 g, so strong peaks are clipped; the Bangle counter works on int16 at 8192 counts per g (about ±4 g). The column order of the Clemson files is undocumented: "first three of nine columns = wrist" is an assumption (the paper lists wrist, hip, ankle; the ankle triple is clearly the most energetic in all 90 files, wrist and hip cannot be told apart by amplitude).
- **Algorithm layer only.** Drift replays the metric algorithm on recorded sensor data. Sensor-driver changes (gain, LED current, ADC, sampling interval; for InfiniTime the gain change in 1.9.0 and the 1.13.0 retune) change the raw counts and cannot be replayed from recordings.
- **Weak ground truth for Bangle.js recordings:** a per-file expected total taken from the file name and `main.c` (how it was produced is undocumented), mostly one wearer; used for native-format replay and false positives, not as an independent accuracy reference. False-positive rates rest on 5 files from one wearer and have no confidence interval. Clemson is walking only, no running, and counts weight-shift steps (6.8% of annotated steps) as steps (the results JSON also gives the numbers without them).
- **Phase, not latency.** The per-generation constant used to align detected and true step trains is the maximum of a periodic cross-correlation, identified only modulo the step period; it is not a device latency and is published for transparency.
- **"All gaits" differs by metric:** for count error the equal-weight mean of a subject's three per-gait errors (dominated by Irregular), for step matching the pooled counts.
- **Release dates are not deployment dates.** Devices update on their own schedule, so a memo's timeline is a bound, not a fact about any participant. Firmware older than 2v09 is not covered.
- **Tail flush:** upstream's harness appends `ACCELFILTER_TAP_NUM` repeated samples (57 for 2v10, 7 otherwise); the device does not. Drift defaults to the device behaviour (`--flush` reproduces upstream).
- **Not done in this repository:** `--all-commits` appendix of development-only commits; a real network fetch of every source on a clean machine (the fetchers copy from the local recon downloads when present, and the network path, with its size and SHA-256 checks, was not exercised in the last review); courtesy notes to the data owners (see below).
- **Not medical or regulatory advice.** Drift gives measured differences for a study team to act on.

Before publishing derived per-recording counts, send a courtesy note to Gordon Williams (the step-count recordings were uploaded for firmware calibration, not research republication) and to Adam Hoover (Clemson, terms not stated). Drift does not send messages.

## Ethics and legal boundary

Open-source firmware and lawful interoperability research only. No DRM or access-control circumvention, and no closed vendor binaries. Firmware source and datasets are fetched from their public origins and never redistributed from this repo.

## Credit

The technique, compiling the firmware's step-count source for the host and feeding it recorded accelerometer files, comes from Gordon Williams' step-count test harness for Espruino ([gfwilliams/step-count](https://github.com/gfwilliams/step-count)). The recordings in it were contributed by Espruino forum users (HughB, cartron, d3nd3-o0, Pablo, Guillaume_G, MrPloppy). Drift generalises the harness across every release tag and adds the null controls, per-step matching with reference rows, confidence intervals, a native cross-check and the validity memo. Drift reproduces that harness's `main.c` numbers exactly on the same blob (tests build the pinned `main.c` live). Espruino is MPL-2.0.

InfiniTime is GPL-3.0-or-later as a project. Its heart-rate algorithm files up to 1.12.0 (`Ppg.cpp`, `Ptagc.cpp`, `Biquad.cpp`) are LGPL-3.0-or-later, "Original work Copyright (C) 2020 Daniel Thompson, C++ port Copyright (C) 2021 Jean-François Milants", derived from wasp-os; the FFT generation (1.13.0 and later) was contributed by Ceimour and uses kosme/arduinoFFT (GPL-3.0). Credit to the InfiniTime contributors. The PhysioNet wrist-PPG data is credited under Citations.

## Layout

```
drift/
  cli.py history.py buildcache.py recordings.py replay.py toolchain.py metrics.py memo.py export.py
  winner_source.json  tracked text of app/public/data/winner.json (pitch, how it works, pick record)
  targets/        base.py, espruino_stepcount/ (shim/, wrap.c, wrap_2v09.c, target.py)
  fetch/          one fetcher per firmware repo / dataset (pinned sizes, hashes, commits)
  skill/SKILL.md  onboard a new device (Claude Code skill)
  recon/          reconnaissance notes (espruino.md, infinitime.md, datasets.md, toolchain.md); scratch downloads are gitignored
  tests/
```
