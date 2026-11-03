# Recon: InfiniTime / PineTime as a Drift differential-execution target

Key: infinitime. Date: 2026-11-03. Everything below was verified from git history or by running code in this session unless marked (inferred) or (unverified).

## 0. Verdict (short)

- Heart rate: feasible and cheap. `Ppg.cpp` is pure C++ with no RTOS/hardware dependency. All 9 sampled releases (0.11.0 ... 1.16.1) compiled on the host with MSVC (VS2022 14.44, /std:c++17) and ran on streams. Harness and build script are in `recon\harness\`.
- Only TWO real algorithm generations exist: (A) wasp-os time-domain autocorrelation, 0.11.0 .. 1.12.0, and (B) Ceimour's FFT algorithm, 1.13.0 .. 1.16.1. Within A, I found no output difference at all (see 1.2); within B, 1.16.0 adds only a "-2 not enough data" sentinel.
- The larger firmware-update effect on the data is in the sensor driver (HRS3300 gain, LED current, ADC resolution, sample interval), which changes the raw counts themselves and cannot be replayed from a recording. Drift can only replay the algorithm layer; flag this as a limit in the report.
- Step counting is NOT a differential target: it runs inside the BMA421 chip (Bosch binary microcode). The config blob is byte-identical in 1.0.0 and 1.16.1 and the InfiniTime-side config (100 Hz, 2 g) never changed. No sleep tracking exists in InfiniTime.
- No recorded raw PPG ships with InfiniTime or wasp-os. One small community recording exists (about 12 min, 10 Hz, no ground truth). Real ground-truth datasets are wrist-PPG at 64-256 Hz and need resampling to 10 Hz (and 24 Hz for the old algorithm).
- License: InfiniTime is GPL-3.0-or-later; the FFT lib is GPL-3.0-or-later; the original PPG code is LGPL-3.0-or-later. Drift can link them only if Drift is GPL-compatible (decision for the orchestrator).

## 1. Repo and downloads

- Repo: https://github.com/InfiniTimeOrg/InfiniTime. Cloned blobless with full history (needed for the history analysis; `--filter=blob:none`, 31 MB on disk): `drift\recon\dl\infinitime` (no checkout; read with `git show <tag>:<path>`). Not a shallow clone, because a depth-1 clone cannot give release history.
- HEAD at clone time: 9ad16304f5fd526b781a760cf1313813d232645e (2026-11-03, = 1.16.0-28-g9ad1630). Latest release: 1.16.1 = e172b9b3c447e2b79c45510c751855a090a208b4 (2026-07-05, "Set version to 1.16.1", only CMakeLists.txt changed vs 1.16.0 for HR purposes: Ppg blobs identical).
- arduinoFFT (InfiniTime submodule `src/libs/arduinoFFT`, same pin in 1.13.0 through 1.16.1): https://github.com/kosme/arduinoFFT at 419d7b044e56b87de8efbcf76f09c04759628fb4 (2023-05-26, "Merge pull request #83 from FintasticMan/customisable_sqrt", describe v1.5.5-23-g419d7b0; library.properties says 1.9.2). Cloned and checked out: `dl\arduinoFFT` (335 KB). Header-only (`src/arduinoFFT.h` 15277 B, `defs.h`, `types.h`).
- Extracted per-release HR sources (read-only copies via `git show`): `dl\infinitime-src\<tag>\components\heartrate\` for 0.11.0, 1.0.0, 1.1.0, 1.2.0, 1.8.0, 1.12.0, 1.13.0, 1.15.0, 1.16.1; plus `dl\infinitime-src\stubs\` (nrf_log.h stub, msvc_compat.h shim).
- Community raw PPG (untrusted data, read only): `dl\infinitime-fork-ppg\` from https://github.com/marcinkosztolowicz/InfiniTime branch `heart-rate-debug-tools`, commit 11989240743a3ebbfccdf5242dc1b062a54161c0 (2024-10-15), path `ppg_analysis/data/`. I did not run its notebooks or scripts.

## 2. HR algorithm history (releases 0.11.0 ... 1.16.1)

Files: `src/components/heartrate/{Ppg,Biquad,Ptagc}.{cpp,h}`, `src/heartratetask/HeartRateTask.cpp`, `src/drivers/Hrs3300.cpp`. Releases before 0.11.0 have no HR code. `git tag --contains 1a58281` shows the first HR commit (2021-01-10, "First implementation of the HR sensor using 100% foss code (ported from waspos)", Jean-Francois Milants) first shipped in 0.11.0.

Ppg.cpp blob id (7 chars) per release; releases sharing a blob have identical algorithm source:

| Release (tag date) | Ppg.cpp blob | Algorithm / what changed in the metric path | Outputs differ from previous row? |
|---|---|---|---|
| 0.11.0, 0.12.0, 0.12.1 (2021-01-23 .. 02-07) | 233c300 | Gen A. wasp-os port: input minus offset -> HPF biquad -> Ptagc AGC -> LPF biquad -> int, 200-sample buffer; `Trough()` of squared-difference autocorrelation at lag 7..48, then refine at 2x, 3/2x, 4/3x; bpm = 60*24*4/lag3 (constants assume 24 Hz). `int` buffer, `int` mn/mx floats. Contains a debug `cccount`/`asm("nop")` leftover. | baseline |
| 0.13.0 .. 1.0.0 (+RC1-4) (2021-02-14 .. 04-21) | e84cbdf | `Compare` loop index int -> size_t (build-warning fix 169b861). Hrs3300 SetGain cosmetic. | no (harness: identical) |
| 1.1.0 (2021-05-21) | da0789e | a62b81d "Use int8_t for PPG data array" (issue #209) + clang-format. Buffer and `Preprocess` return are `int8_t`; `Trough` mn/mx are `uint8_t`. This is the only change in gen A that could alter numerics (narrowing). | no on 60 randomised stress runs + all test streams |
| 1.2.0 .. 1.7.1 (2021-06-20 .. 11-15) | fcba381 | Ctor `Ppg()` (offset no longer a ctor arg; HeartRateTask calls SetOffset on start), removed debug asm. | no |
| 1.8.0 (2022-01-07), 1.9.0, 1.10.0, 1.11.0, 1.11.0-fosdem | a5d8369 | Include-path edits only. | no |
| 1.12.0 (2023-04-02) | 900b1c2 | Float locals -> int; `HeartRate()` returns int; braces. Behaviour-equivalent by inspection and by harness. | no |
| 1.13.0, 1.14.0, 1.14.1 (2023-06-24 .. 2024-09-04) | 3a6988a | Gen B. c22e30a "Refactored Ppg for frequency based algorithm. (#1486)" by Ceimour, 2023-04-30 (author text: FFT based on ArduinoFFT, GPLv3). 10 Hz sampling (`deltaTms = 100`), window `dataLength = 64`, new analysis every `overlapWindow = 5` samples (0.5 s), spectral average of `spectralAvgMax = 2` (+1) spectra, `Detrend` (linear detrend then first difference), `Filter30to240` (4x EMA lowpass alpha 0.816 then 4x EMA highpass alpha 0.268), Hann window (hardcoded 64-pt table), arduinoFFT<float> forward + magnitude, HR ROI 30..240 bpm (bins 3..21 at 0.156 Hz resolution), SNR threshold 3.0, DC bin < 0.5, peak threshold 0.6*max, `PeakSearch` with linear interpolation (0.01 bin step), max peak width 2.5 bins, HR limits 40..230 bpm, running mean over `dataAverage[20]`. Ambient-light (ALS) gating added: `Preprocess(hrs, als)` returns 1 if als > 2x last als -> task resets buffers. Biquad/Ptagc files deleted. Hrs3300 retuned (see 3). | YES, large |
| 1.15.0 (2024-12-03) | efbed85 | Preprocess takes `uint16_t` (was uint32). Hrs3300 now returns packed 16-bit HRS/ALS in one atomic I2C read (ad3bf49 "Atomic HRS reads (#1845)", 2024-09-21). | no for the algorithm (harness identical); sensor read path changed |
| 1.16.0, 1.16.1 (2026-01-06, 2026-07-05) | 25be623 | 8daddf8 "Background heartrate measurement" (2025-06-18), fcc8073 "Isochronous PPG sampling" (2025-06-23). `HeartRate()` returns -2 until the first full 64-sample window; HeartRateTask becomes a state machine (Disabled/Waiting/BackgroundMeasuring/ForegroundMeasuring) with periodic background measurement (30 s limit) and drift-free tick scheduling. Spectral analysis unchanged. | Algorithm no; task-level output timing/sentinels yes |

Notes:
- Tags 0.1.0 ... 0.10.0 and v0.x predate HR. Tag dates above are tag commit dates.
- Hrs3300.cpp blobs: 2aded7d (0.11-0.12.x), dc9f9cd (0.13-1.0.0), edb9e81 (1.1-1.7.1), c14fe7a (1.8.0), ec620af (1.9.0-1.11.0), 6c47ae2 (1.12.0), 7dfd301 (1.13.0-1.14.1), a4b7247 (1.15.0-1.16.1).
- Quirk worth knowing for fidelity: `SetOffset(uint16_t)` truncates the 18-bit `ReadHrs()` offset (1.9.0+ returns uint32); harmless at the observed ~3600 counts.
- Quirk: in 1.13.0/1.14.x `Preprocess(uint32_t hrs...)` stores into a `uint16_t` buffer (silent narrowing); made explicit in 1.15.0.

## 2b. Sensor-side changes that alter the raw data (not replayable by recorded-trace differential execution)

| Change | Commit / date | First release | Effect |
|---|---|---|---|
| Hgain 0x10 = 64x -> 0xc = 8x ("reduced value for better readings") | b4e9562 hatmajster 2022-01-24 | 1.9.0 | Raw counts scale |
| ReadHrs/ReadAls return uint32 (18-bit HRS read) | 464b689 / 4cc9509 (author date 2021-12-13) | 1.9.0 (the 1.8.0 blob c14fe7a still returns uint16; verified by diff 1.8.0..1.10.0) | Bit-order fix; the 2 extra HRS bits no longer lost to uint16 truncation |
| c22e30a retune: Enable 0x60 -> 0x50 (50 ms wait vs 12.5 ms), PDriver -> 0x2f (12.5 mA, low nibble 0xF), Res 0x88 (16-bit) -> 0x77 (15-bit, about 50 ms LED/ADC period), Hgain -> 0x00 (1x), ALS enabled | c22e30a 2023-04-30 | 1.13.0 | New operating point built for exactly 10 Hz |
| Sleep mode when disabled | a48d4e0 2023-05-07 | 1.13.0 | Power only |
| Atomic 6-register burst read, 16-bit packed | ad3bf49 2024-09-21 | 1.15.0 | Removes torn reads |

Sampling rate:
- Gen B: 10 Hz by design (`Ppg::deltaTms = 100`; HRS3300 configured for about 50 ms conversion + 50 ms wait). Confirmed from the real recordings: row timestamps advance 1.0735 s per 10-11 new samples.
- Gen A: the task polls every 40 ticks of a 1024 Hz tick (`configTICK_RATE_HZ 1024`), about 39 ms = about 25.6 Hz poll; the algorithm constants assume 24 Hz (`60*24*...`, inherited from wasp-os which reads the sensor at 24 Hz). With 16-bit mode and 12.5 ms wait the chip likely produces new conversions slower than the poll rate, so duplicates are plausible (inferred from the datasheet resolution/conversion-time relationship, not measured). For Drift: feed gen A at 24 Hz; feeding it 10 Hz data gives 2.4x wrong bpm (measured below).

## 3. Host compile feasibility (done)

Toolchain: Windows has MSVC (VS2022 Community, 14.44.35207, `...\Auxiliary\Build\vcvars64.bat`); no g++/clang/cmake on PATH. All builds use MSVC.

What was needed (InfiniTime source untouched):
- nrf_log.h stub (`NRF_LOG_INFO(...)` -> no-op): `dl\infinitime-src\stubs\nrf_log.h`. This is the only InfiniTime dependency of Ppg.cpp (plus `<vector>`, `<array>`).
- `msvc_compat.h` force-included (`/FI`): defines `_ALLOW_KEYWORD_MACROS`, includes `<iso646.h>` (Ppg.cpp 1.13+ uses `and`, which MSVC rejects without /permissive-), and `#define asm(x) ((void)0)` (0.11.0 .. 1.1.0 Ppg.cpp contains `asm("nop")`, unsupported on x64 MSVC).
- Include root: `-I<tag>` (so `components/heartrate/Ppg.h` and, for 1.13+, `libs/arduinoFFT/src/arduinoFFT.h` resolve). For 1.13/1.15/1.16.1 the pinned arduinoFFT `src/` was copied to `<tag>\libs\arduinoFFT\src`. Biquad.cpp/Ptagc.cpp are compiled for gen A only.
- Ppg.h (1.13+) sets `#define sqrt_internal sqrtf` and `FFT_SPEED_OVER_PRECISION` itself, so no extra flags.

Command that worked (from `recon\harness`, via `cmd /c "drift\recon\harness\build.bat"`; one line of it):
`cl /nologo /std:c++17 /O2 /EHsc /w /DAPI=4 /FI<SRC>\stubs\msvc_compat.h /I<SRC>\stubs /I<SRC>\1.16.1 /I<SRC>\1.16.1\components\heartrate ppg_harness.cpp <SRC>\1.16.1\components\heartrate\Ppg.cpp /Fe ppg_1.16.1.exe`
Result: `bin\ppg_{0.11.0,1.0.0,1.1.0,1.2.0,1.8.0,1.12.0,1.13.0,1.15.0,1.16.1}.exe` all built, about 190 KB each.

Harness: `harness\ppg_harness.cpp` (one source, `-DAPI=1..4` selects the per-era API: 1 = `Ppg(float)` + SetOffset, 2/3 = `Ppg()` + SetOffset, 4 = `Preprocess(hrs, als)` + `Reset`). Input: one HRS count per line, optional second column ALS. Output: `idx,ret,bpm_shown` per sample. For API 4 it re-implements the ambient-reset / `-1` reset branches of HeartRateTask (1.15 semantics, plus `-2` handling). It does NOT include HeartRateTask timing, background scheduling or HeartRateController (those need FreeRTOS stubs; only worth it if Drift wants the 1.16 task layer).
Other scripts: `harness\gen_data.py` (synthetic streams + stitching of the real recordings), `harness\summarize.py` (matrix), `harness\stress_old.py` (randomised adjacent-version diff for gen A). Raw outputs in `harness\out\`.

Accel input: none of the HR paths use accelerometer data in any release (no motion-artifact compensation). So there is no accel stream to feed; "optional accel" is moot for InfiniTime HR.

Measured results (median positive bpm / number of positive outputs; true rates 60, 72, 100):

| input | 0.11 - 1.12 (gen A, all identical) | 1.13 / 1.15 / 1.16.1 (gen B, identical) |
|---|---|---|
| synthetic 10 Hz, 60/72/100 bpm | 140 / 169 / 230 (wrong by 2.4x) | 60 / 72 / 100 (correct) |
| synthetic 24 Hz, 60/72/100 bpm | 59 / 71 / 97 (correct to quantisation) | 50 / 60 / 0 outputs (wrong; 24 Hz is not its rate) |
| real PineTime 10 Hz (6 files, no truth) | 92 .. 144 bpm, only 3-7 outputs per file | 55 .. 120 bpm, 24-187 outputs per file |

- 60 randomised 24 Hz stress trials (amplitude 5/40/300, noise 3/30/150, 1% +-2000 spikes, 50-170 bpm): outputs of 0.11.0, 1.0.0, 1.1.0, 1.2.0, 1.8.0, 1.12.0 are byte-identical for adjacent pairs. 1.13.0 vs 1.15.0 identical on all test streams; 1.15.0 vs 1.16.1 differ only in the first 63 samples (ret `-2` instead of `0`).
- Timing: gen A emits an HR once per 200 samples (about 8 s at 24 Hz) then clears the buffer. Gen B: first value after 64 samples (6.4 s) then every 5 samples (0.5 s), averaged over 20 outputs.
- Consequence for Drift: to show a "firmware update effect" on identical raw input, the A-vs-B comparison is the one with a large effect (different rate assumptions, so each version must be fed a stream resampled to its own native rate; document that this is part of the experiment design, otherwise the diff is just a rate mismatch). Intra-A and intra-B diffs are near zero; that is itself a legitimate finding.

## 4. Step counting, motion, sleep

- Steps: BMA421/BMA425 on-sensor step counter. `src/drivers/Bma421.cpp::Init()` writes Bosch's `bma423_config_file[]` (binary microcode, `src/drivers/Bma421_C/bma423.c`, BSD-3-Clause driver, V2.14.13) to the chip, enables `BMA423_STEP_CNTR`, disables the step detector, sets 100 Hz ODR, +-2 g, `BMA4_ACCEL_NORMAL_AVG4`, CIC_AVG perf mode; `Process()` reads `bma423_step_counter_output()`. I extracted `bma423_config_file[]` from 1.0.0 and 1.16.1 and compared: byte-identical (326 lines). `Bma421.cpp` changes since 1.0.0 are accel unit scaling ("binary milli-g", c2c53bc 2024-02-11) and BMA425 support (c6dca25 2021-06-19, adds a separate `bma425_config_file`); none touch the step counter. Hence NOT host-compilable, NOT differentiable from InfiniTime source. A step-count differential would need the Bosch algorithm in source (not available) or the physical chip.
- What is in InfiniTime and host-compilable (pure C++ on accel samples): `MotionController` raise-to-wake (`ShouldRaiseWake`; improved 2b1eae7 2023-05-20), lower-to-sleep (0f9f606 2023-08-27, angle check f2df0c4 2024-02-12), shake detection (`CurrentShakeSpeed`, d270275 2021-09-27, 47ca403 2023-04-05, 7ea36e8 2025-06-28). These are gesture triggers, not research metrics. MotionController.cpp blobs differ across 1.0.0 (e9ee314), 1.5.0 (b0dbada), 1.9.0 (7dd3212), 1.12.0 (9d16e00), 1.13.0 (ef3cf81), 1.15.0 (72507ac), 1.16.1 (ce959f0). Not examined further.
- Sleep tracking: none (no files; open feature request #307). 1.16.0 added a step history (716deff 2025-11-08): bookkeeping only.

## 5. Raw PPG data plan

Does InfiniTime ship raw PPG? No: no traces in the repo (`tests/` only has format/tidy scripts; `tools/` is mcuboot/bin2c). InfiniSim (https://github.com/InfiniTimeOrg/InfiniSim, GPL-3.0) stubs HeartRateTask (the Work loop is commented out), so it does not run Ppg either. wasp-os (GPL-3.0, https://github.com/wasp-os/wasp-os) has `apps/heart.py` that logs raw HRS to `hrs.data` and `tools/hrs2csv.py` (LGPL) to convert (uint16 records, sync marker 0xffff, 24 Hz) but ships no recorded data. Issues: InfiniTime #397 (2021, "gather more data to improve heart rate accuracy": discussion only), #2112 / discussion #2113 (2024, "How to get raw PPG data").

A. Real PineTime recordings that exist (use for smoke-testing, no truth): `dl\infinitime-fork-ppg\`, from marcinkosztolowicz/InfiniTime (fork of GPL-3.0 project; the data files themselves have no separate license statement: ask/credit before redistributing). 6 recordings (rows are snapshots of the `dataHRS[64]` window read over BLE UUID 2a39 about every 1.07 s; stitched by overlap into continuous 10 Hz streams, total 7,054 samples, about 11.8 min, zero stitch gaps): firmware 1.14, HRS3300 at 40 mA (one file 12 mA), 50 ms delay, activities in `*_metadatadata.json` ("steady hand", "squeezing palm", "waving hand", "squats ... walking imitation"). No HR ground truth, no accelerometer. Raw counts about 3600-3700 (DC) in 15-bit mode. Stitched streams: `harness\data\real_*.csv`. Useful because it is the true sensor output format and rate for 1.13+.

B. Public datasets with ground-truth HR (all wrist green-ish PPG, higher rate; need resampling + quantisation to HRS3300 counts; none is HRS3300):

| Dataset | Sensor / rate | Ground truth | Size / subjects | License | Fit |
|---|---|---|---|---|---|
| PPG-DaLiA (UCI 495, DOI 10.24432/C53890) | Empatica E4 wrist BVP 64 Hz + ACC 32 Hz | RespiBAN chest ECG 700 Hz | 15 subjects, data.zip 2.7 GB | CC BY 4.0 | Best: daily-life activities, has accel for motion-artifact analysis; BVP resample 64 -> 10 Hz (or 24 Hz) is 6.4x (2.67x) decimation with anti-alias |
| IEEE SPC 2015 / TROIKA (Zenodo 3902710 "IEEEPPG", DOI 10.5281/zenodo.3902710) | wrist PPG 125 Hz (2 ch), 3-axis ACC, ECG | ECG-derived HR per 8 s window (shipped repackaged as 3,096 five-dim series, 141.7 MB) | 12-23 subjects (sources disagree) | Zenodo field says CC BY 4.0, but the description says "All datasets have copyrights ... freely use for the Signal Processing Cup or your own academic research ... cite": confirm before redistributing | Good for exercise motion artifacts; small |
| Wrist PPG During Exercise (PhysioNet `wrist` 1.0.0, Casson) | Shimmer3 GSR+ wrist PPG + accel/gyro, 256 Hz | Chest ECG with hand-annotated R-peaks | 8 subjects, about 19 records, 49.8 MB | ODC-By 1.0 | Good license, treadmill/bike, easy to fetch |
| WESAD (UCI 465, DOI 10.24432/C57K5T) | E4 BVP 64 Hz + ACC 32 Hz | chest ECG 700 Hz | 15 subjects | not stated on UCI page; check the dataset's own terms (unverified) | Mostly sedentary; secondary |

Resampling plan (inferred, not yet executed): anti-alias low-pass then decimate to 10 Hz (gen B) and 24 Hz (gen A); scale to integer ADC-like counts: set DC to about 3600, AC amplitude to the 15-bit range seen in the real recordings (AC peak-to-peak about 40-100 counts); optionally add quantisation to 16-bit for gen A. Truth: ECG-derived HR on the same windows; score each version's output (bpm after warm-up, valid-output fraction, MAE). Replay each version at its native rate: gen A at 24 Hz, gen B at 10 Hz. Treat the ALS column as constant 0 (no ambient gating) unless a dataset provides ambient.

Limit: replay cannot reproduce the sensor-side deltas in 2b (gain 64x vs 8x vs 1x, LED current, resolution). A fixed-count scaling must be chosen per version; a defensible choice is to scale the input so the post-gain DC level matches each version's typical count (for gen B this is the observed 3600) and report that this is an assumption.

## 6. Licenses

- InfiniTime: GPL-3.0-or-later (README "Licenses"; LICENSE file is GPLv3 text).
- `Ppg/Biquad/Ptagc` (gen A): SPDX LGPL-3.0-or-later, (C) 2020 Daniel Thompson (wasp-os) and (C) 2021 Jean-Francois Milants. Gen B `Ppg.cpp`: GPL-3.0-or-later project license; derived FFT/interpolation parts from Arduino FOSS.
- arduinoFFT 419d7b0: GPL-3.0-or-later (file header and LICENSE), (C) Didier Longueville, Enrique Condes, Bim Overbohm.
- Bosch BMA42x driver: BSD-3-Clause (config blob included; not relevant to HR).
- wasp-os: GPL-3.0 repo, algorithm files LGPL-3.0-or-later. InfiniSim: GPL-3.0. Fork data (marcinkosztolowicz): repo shows GPL-3.0, data unlabeled.
- Implication: compiling and linking gen B (arduinoFFT) into Drift makes the resulting binary GPL-3.0; running the harness as a separate process (one exe per version, exchanging CSV) keeps Drift's own code separate. Orchestrator should decide Drift's license and process model; I recommend per-version out-of-process executables.

## 7. Recommended versions for Drift

Minimal set that spans every behavioural change (each is a distinct output stream):
1. 1.0.0 (a80e782f267cd2424d22da23d809c0c6a8ff8761, 2021-04-21): gen A reference, the first stable release; native 24 Hz.
2. 1.12.0 (238a829577c71dc9cfc5d96d01d098e47c9508ef, 2023-04-02): last gen A; expected identical to 1.0.0, serves as the "null diff" control (harness confirms identical). Include to demonstrate Drift reports no change when none exists.
3. 1.13.0 (5f3acfadd24fcf8f0ef31a75c36180585b1c88c4, 2023-06-24): first FFT release; native 10 Hz; the big change.
4. 1.16.1 (e172b9b3c447e2b79c45510c751855a090a208b4, 2026-07-05): latest; only differs from 1.13-1.15 in the "-2 not enough data" sentinel and the task/background layer (needs FreeRTOS stubs to replay that layer; otherwise treat as equal to 1.13.0 for the algorithm).
Optional extras: 1.1.0 (the int8 narrowing change; no difference observed), 1.15.0 (atomic reads; no algorithmic difference).
Skip step counting (chip microcode, unchanged blob) and sleep (absent).

## 8. Caveats / unverified

- HRS3300 effective data rate in gen A (about 25.6 Hz poll vs slower conversions) is inferred, not measured.
- Real-recording stitching assumes a constant 10 Hz and contiguous windows; the overlap matcher found zero gaps, but the BLE read cadence (1.07 s) with a 64-sample window means no loss was possible only if every poll succeeded, which the zero-gap result supports.
- The harness mirrors HeartRateTask for API 4 by hand; it is not the shipped task code.
- Dataset license/size figures were read from the dataset landing pages in this session (UCI, Zenodo, PhysioNet); WESAD license and the IEEE SPC 2015 redistribution terms are not settled.
- Tag release dates are tag-commit dates and may differ slightly from GitHub release dates.
