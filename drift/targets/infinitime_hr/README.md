# infinitime_hr: PineTime heart rate, autocorrelation (0.11.0-1.12.0) vs FFT (1.13.0-1.16.1)

Secondary Drift target. It compiles InfiniTime's `src/components/heartrate/Ppg.cpp` from every release for the host and replays
the same PPG recordings through each distinct algorithm. Results: `results/drift/infinitime_hr.json`
(`python -m drift all --target infinitime_hr`, about 15 s once the cache is filled).

## Scope and caveat (read this first)

**Drift replays the algorithm layer only.** Sensor-driver changes (HRS3300 gain 64x to 8x in 1.9.0, the 1.13.0 retune of LED
current, resolution and wait time, atomic reads in 1.15.0) change the raw counts themselves, and the HeartRateTask layer (FreeRTOS
timing, the 1.16 background measurement) changes when values are shown. Neither can be replayed from a recording. The public PPG
data are not HRS3300 data either: they come from a different wrist sensor, and they are rescaled to HRS3300-like counts under
the assumptions listed below. The numbers describe the two algorithms on this data. They are not a statement about how accurate
a PineTime was in a given firmware release. The same caveat is stored in the results JSON (`caveat`, `caveats`).

## Generations

`history` yields 10 distinct blob sets of the heart-rate files between 0.11.0 and 1.16.1 (7 autocorrelation, 3 FFT; release tags
only, no `-RC`/`-fosdem` tags). Drift builds and replays **all 10** on every recording and checks the identical-output claims
from the recon (stored per variant in `variants_checked`):

| | Tags | Algorithm | Native rate | Kept as |
|---|---|---|---|---|
| gen A | 0.11.0 to 1.12.0 (7 blob sets) | wasp-os autocorrelation (Biquad, Ptagc), `bpm = 60*24*4/lag` | 24 Hz | generation |
| gen B | 1.13.0 to 1.16.1 (3 blob sets) | Ceimour's FFT (arduinoFFT, 64-sample Hann window every 0.5 s) | 10 Hz | generation |
| A_null | 1.12.0 | the last, most refactored gen-A blob set | 24 Hz | **null control**, must equal gen A |

Verified on all 25 recordings (19 PhysioNet + 6 PineTime): all gen-A blob sets give byte-identical returns and displayed values
(including the 1.1.0 int8 narrowing and the 1.12.0 float-to-int change); the gen-B blob sets are identical except that 1.16.0+
returns the sentinel `-2` ("not enough data") where 1.13.0 and 1.15.0 return `0`. Only the distinct generations (A, B) and the
control (A_null) are replayed in the main tables.

Each generation is fed at its own rate: 24 Hz for A, 10 Hz for B. Feeding gen A the 10 Hz stream gives 2.4x the true rate (see
`synthetic_sanity`), so the A-versus-B difference is only meaningful with per-generation resampling. That resampling is part of the
experiment design.

## Build

`wrap.cpp` is one source for all releases. The three API eras (`Ppg(float)` / `Ppg()` + `SetOffset` / `Reset(bool)` +
`Preprocess(hrs, als)`) are told apart with C++17 traits, not per-version macros. The only InfiniTime dependency outside the
algorithm files is `<nrf_log.h>`, stubbed in `shim/`. **All 10 blob sets compile under `zig c++` (ziglang 0.16.0, libc++)**; no MSVC
fallback is needed. As a cross-check, the zig builds reproduce the recon's MSVC harness bit for bit: 9 releases x 12 streams (108
comparisons) of `Ppg::HeartRate()` returns and displayed bpm are identical
(`test_zig_build_matches_msvc_recon_harness`, runs when `recon/harness/out` exists). The wrapper mirrors the HeartRateTask branches
of 1.13 to 1.15 (ambient-light reset, `-1` reset); it does not run the real task.

Licensing: the gen-B binaries link GPL-3.0 arduinoFFT and InfiniTime code. Drift builds them into libraries in `.cache/drift/` and
never commits them or the firmware source; the repository holds only `wrap.cpp`, the log stub and the harness code.

## Data and scaling

| Source | Use | Notes |
|---|---|---|
| PhysioNet Wrist PPG During Exercise 1.0.0 (Jarchi and Casson, Data 2017, 2(1):1, doi:10.3390/data2010001, plus the standard PhysioNet citation the dataset page asks for, Pollard et al. 2026, doi:10.1038/s44360-026-00096-z; ODC-By 1.0, attribution required for derived results) | ground truth | 8 subjects, 19 records (walk, run, low/high resistance bike), 256 Hz Shimmer3 PPG, hand-annotated ECG R-peaks, 670 ten-second windows with truth |
| 6 PineTime 1.14 recordings from marcinkosztolowicz/InfiniTime (branch `heart-rate-debug-tools`, commit 1198924) | agreement only | 10 Hz HRS3300 counts, about 11.8 min, no ground truth, data files carry no license statement (not redistributed) |

`fetch/ppg.py` downloads and SHA-256-verifies the PhysioNet files and fetches the fork files at the pinned commit. Nothing is committed.

Scaling of the PhysioNet PPG (assumptions, not device measurements; `data.py`):

1. anti-aliased polyphase resampling from 256 Hz to 24 Hz (3/32) for gen A and to 10 Hz (5/128) for gen B;
2. AC amplitude: robust sigma (1.4826 x MAD of the 0.5 to 4 Hz band) set to 25 counts (the six real recordings span 10 to 66);
3. baseline wander kept, median shifted to 3600 counts (the DC level of the real 1.14 recordings);
4. rounded to integers and clipped to 0..32767.

`scaling_sensitivity` repeats the evaluation at 10, 25 and 60 counts. The real PineTime streams are fed to gen B unchanged; for
gen A they are resampled 10 to 24 Hz (polyphase 12/5), which is an assumption, because a PineTime running gen A would have recorded
different raw counts.

## Metrics

Unit: non-overlapping 10 s window with ECG truth (HR = 60 / mean RR of R-peaks in the window). A generation's output for a window is
the last positive `Ppg::HeartRate()` value inside it; a window is **valid** when there is at least one. MAE is over valid windows and
the valid fraction is always reported next to it. A-versus-B differences are on windows valid for both generations
(`|err B| - |err A|`, negative means B is closer to the ECG), with a 10,000-resample bootstrap, seed 20261103: over subjects (cluster
bootstrap, 8 subjects, the primary interval) and over windows (optimistic, windows are autocorrelated). The firmware-independent
`reference_check` (spectral peak of the PPG vs ECG) shows how much of the data carries a visible pulse.

## Results (from the JSON, default scaling)

| | gen A | gen B |
|---|---|---|
| MAE on valid windows | 39.0 bpm | 24.9 bpm |
| median absolute error | 18.5 bpm | 5.2 bpm |
| windows with a valid output | 87.3 % (585/670) | 51.2 % (343/670) |

- B minus A on the 305 windows valid for both: -6.9 bpm of absolute error, subject-bootstrap 95% CI [-15.7, -0.4], window-bootstrap CI [-11.3, -3.1].
- Valid-fraction difference B minus A: -36 points, subject-bootstrap CI [-48, -25].
- The A_null control equals A on every window and every recording. All gen-A and gen-B blob sets are identical within their generation.
- Activity matters more than generation. Bike: B is far closer to the ECG (high resistance MAE 2.6 vs 29.4 bpm) and valid on 59 to 69 % of windows. Run:
  both fail (44 vs 50 bpm), with B valid on 54 %. Walk: B is valid on only 33 % of windows and, where both are valid, not better than A
  (+5.0 bpm, CI [-0.2, 13.2]). Neither algorithm uses the accelerometer.
- The headline depends on the scaling assumption: over AC sigma 10, 25 and 60 counts, B's valid fraction is 66 %, 51 % and 10 %, and its MAE
  on valid windows 32.7, 24.9 and 5.4 bpm (B rejects more windows as the signal gets larger and keeps the easy ones). The sign of
  B minus A on common windows stays negative at all three (-4.8, -6.9, -10.5 bpm). Do not read B's MAE without its valid fraction.
- Real PineTime recordings (agreement only): where both generations emit a value in the same 10 s window (37 windows), the median
  absolute difference is 4 bpm and 84 % are within 10 bpm. A valid in 63 to 85 % of windows, B in 25 to 93 %.
- Synthetic sine sanity (labelled SYNTHETIC in the JSON): at native rates, 60/72/100 bpm give 59/71/97 (A) and 60/72/100 (B). B returned no
  value on the 140 bpm sine (not investigated).

## Files

`target.py` (generations, build, run, CLI hooks), `wrap.cpp` (C ABI, API-era traits), `shim/nrf_log.h`, `data.py` (WFDB reader, stitching of
the BLE window snapshots, scaling adapter), `metrics.py` (windows, bootstrap, agreement, synthetic), `export.py` (results JSON).
Tests: `drift/tests/test_infinitime_hr.py`.
