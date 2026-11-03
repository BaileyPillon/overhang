# Recon: espruino (Bangle.js step counter)

Verdict: GREEN. Clean, tiny, dependency-free C; recorded raw traces with labelled step counts exist; 6 shipped firmware variants plus 6 dev variants compiled to DLLs and run on all traces on Windows with `python -m ziglang cc` (zig 0.16.0 already in the venv). Results cross-checked bit-for-bit against upstream's own harness (main.c) for the 2v12 algorithm and the 2v09 "orig" counter.

## Source locations (github.com/espruino/Espruino, MPL-2.0; blobless clone at dl/espruino/src, HEAD 3b5c8d97 2026-10-21)
- `libs/misc/stepcount.c` (8.8 KB) + `stepcount.h` (815 B): the algorithm. API: `void stepcount_init(); int stepcount_new(int accMagSquared);` Input 12.5 Hz, 8192 = 1 g, accMagSquared = x*x+y*y+z*z (int32). Return value = steps to add for this sample.
- Caller: `libs/banglejs/jswrap_bangle.c` (poll loop, DEFAULT_ACCEL_POLL_INTERVAL 80 ms; `accMagSquared = acc.x*acc.x + acc.y*acc.y + acc.z*acc.z`; init when leaving power-save; skipped in power-save; 2v29 adds `stepCounterDisabled`).
- Versions <= 2v09 had NO stepcount.c: a hysteresis counter inline in jswrap_bangle.c (thresholds (8192-80)^2 and (8192+80)^2 on accMagSquared). Source: `RELEASE_2V09:libs/banglejs/jswrap_bangle.c` lines ~499-501 and 917-922. Transcribed in `espruino-harness/wrap_2v09.c`.

## History of libs/misc/stepcount.c (21 commits) and what each firmware shipped
Mapping done by comparing the blob SHA of stepcount.c at every RELEASE_2Vxx tag against each commit.

| Firmware (tag date) | stepcount.c commit | Algorithm |
|---|---|---|
| <= 2v09 (2021-04-19) | none (inline in jswrap_bangle.c) | raw mag^2 hysteresis +-80 around 1 g |
| 2v10 (2021-08-13) | 9c2c3738 (2021-06-17) | 57-tap bandpass FIR on (mag-8192)>>5, peak threshold 1000, history gate "5 steps in 75 samples" |
| 2v11 (2021-12-15) | e33e1183 (2021-08-29) | 7-tap FIR (-11,-15,44,68,44,-15,-11), peak detect, state machine (4..16 samples between steps, 6 in a row), raw gate RAW_THRESHOLD=14 for 3 samples |
| 2v12 to 2v21 (2022-02-01 to 2024-02-05) | afb4943c (2022-01-29) | adds exponential DC filter (NSAMPLE=12) replacing the fixed 8192 offset, RAW_THRESHOLD=15; int_sqrt32 moved to jsutils |
| 2v22 to 2v28 (2024-05-21 to 2025-11-05) | 3138205d (2024-03-14) | cosmetic (`static const` reorder); output identical to afb4943c on all data |
| 2v29 (2026-02-24) | 2913ca0a (2025-11-27) | clamp bug fix (`a<-32768` then `a=-32768`, was +32768); output identical on all data |

Dev commits that never were a tag state (2021-04-29 to 2021-08-26, first contained in 2v10 or 2v11):
- d338bfbf 2021-04-29 127-tap bandpass + adaptive threshold (first version, fixes #1846); 2b4e2b39 64 taps; c45ac247, bd134aba value tweaks; 05f37164 57 taps.
- e12de357 2021-05-04 higher threshold, wider response; 57a5f304 2021-06-17 STEPCOUNT_CONFIGURABLE for offline testing; 9c2c3738 2021-06-17 history gate (= 2v10).
- 7003b2bb 2021-08-19 23 taps, "4 steps in 90 s"; 6bf72283 2021-08-19 11 taps; 1fb87396 2021-08-25 7 taps, threshold 300.
- ea8733c1 2021-08-25 hughb's state machine (X_STEPS 5); 5995c021 2021-08-26 RAW 10, threshold 600; e4c49c39 2021-08-26 X=8, RAW 17; e33e1183 2021-08-29 X=6, RAW 14 (= 2v11).
- b59ae739 2022-01-05 reuse jsutils int_sqrt32; 0ceb59cb 2022-01-20 RAW 14 to 18; 19b638e9 2022-01-24 RAW 17; afb4943c 2022-01-29 DC filter, RAW 15 (= 2v12).

The comment at the top of stepcount.c gives the author's scores on HughB-walk-1834: 1446 (FIR only), 1584 (oxford filter), 1752 (peak detection), 1751 (state machine). Our builds reproduce 1446 (6bf72283), 1752 (1fb87396) and 1751 (ea8733c1) exactly, which validates the harness.

## Test data: github.com/gfwilliams/step-count (HEAD d4b015c 2022-01-25, 32 commits, repo 7.3 MB; NO LICENSE file, GitHub license = null)
Cloned to dl/espruino/step-count. `data/*.csv` = 18,345,809 bytes, 35 files, header `Time (ms),X,Y,Z`, raw accelerometer counts (8192 = 1 g), median dt 80 ms (12.5 Hz) in every file. README: data comes from forum.espruino.com/conversations/359542 (371740 for MrPloppy). Ground truth is a MANUAL step count (file name and main.c EXPECTED_STEPS); "aN-bM" = N actual, M counted by the watch then.

Long, labelled files (bytes; true steps):
- HughB-walk-6605 1,257,973 (6605; 67 min); walk-2350 357,584 (2350); walk-a3070-b3046 573,203 (3070); walk-a10021-b10248 3,515,342 (10021; 191 min); walk-1834 272,610 (1834); walk-2331 388,673 (2331).
- drive-36min-0 590,971 (0); drive-29min-0 471,915 (0); drive-a3-b136 209,879 (3); drive-18 251,016 (18).
- work-66 1,182,126 (66); work-0 1,044,477 (0); mixed-390 1,058,859 (390); general-a260-b573 3,534,471 (260); housework-a958-b2658 2,148,539 (958; "big inaccuracy, useful for optimisation").
- 0_HughB_train_journey_b31 1,076,147 (0 true, watch said 31); MrPloppy-stationary-0 16,512 (0).

Short files: 100.csv and 100_1..100_7 (14-22 KB, ~1 min each, name implies 100 steps, not stated; Gordon Williams 2021-06-17); Guillaume_G, HughB0/1/2, Pablo, cartron, d3nd3-o0 (24-38 KB, 1.5-2 min, no label); HughB-nosteps1/2/3 (0); HughB-static-0 (0).

Nothing comparable inside the Espruino repo. BangleApps has only recorder apps (accellog, accelrec, hrmaccevents), not datasets.
Licensing caveat: no license on the data repo (forum-contributed). Fine for local research; reference by URL + commit in Drift instead of vendoring, and credit/ask before redistributing.

## Host compilability: yes, trivially
- stepcount.c needs only stdlib/stdint/stdbool and `int_sqrt32()` (jsutils.h in 2v12+; defined inline in earlier versions). Pure integer maths (int8 FIR taps, int16 history, int32 DC filter). Global non-static state, so one instance per process: build each version as its own shared lib (done).
- Shim: `espruino-harness/shim/jsutils.h` (only int_sqrt32, copied from the step-count repo's jsutils.h).
- Needs 32-bit int (true on Windows x64). accMagSquared overflows int32 only if an axis exceeds about 26k counts (same as on device).
- Gotcha: upstream main.c needs POSIX getline(); on Windows use `-include getline_shim.h` (provided).

## What was built (D:\Projects\overhang\drift\recon\espruino-harness)
- `wrap.c` (per-version wrapper: `drift_init()`, `drift_feed(int mag2)`, `drift_run(int16* xyz, n, int* perSample)`), `wrap_2v09.c`, `shim/jsutils.h`, `src/<commit>/stepcount.{c,h}` (verbatim `git show <commit>:libs/misc/stepcount.{c,h}`), `build.sh`, `run.py`, `bin/sc_<commit>.dll` (12 DLLs), `getline_shim.h`, `xcheck/` (upstream main.c reproduction).
- Build command that worked: `D:\Projects\overhang\.venv\Scripts\python.exe -m ziglang cc -std=c99 -O2 -Wall -shared -I shim -I src/afb4943c wrap.c -o bin/sc_afb4943c.dll` (no warnings, ~190 KB per DLL).
- Run: `python -I run.py ../dl/espruino/step-count/data --flush` (ctypes; 17 traces x 12 versions in 2 s). `--flush` appends 7 repeated samples like upstream main.c; Espruino itself does not flush.
- Cross-check: upstream main.c + afb4943c reproduces our DLL numbers exactly (6054, 2164, 2858, 9903, 45, 58, 67, 65, 407, 400, 1825, 0); upstream "orig" column = our 2v09 numbers (3223, 1042, 1909, 12222, ...).
- Heart rate is NOT a good target here: libs/misc/heartrate.c is for Bangle.js 1 analog HRM; Bangle.js 2 uses a proprietary binary blob (heartrate_vc31_binary.c, since 2026-03). Steps are the right Espruino target.

## Results (steps counted, --flush)
| file | n | true | 2v09 | 2v10 | 2v11 | 2v12-21 | 2v22-28 | 2v29 |
|---|---|---|---|---|---|---|---|---|
| walk-6605 | 50218 | 6605 | 3223 | 6628 | 6397 | 6054 | 6054 | 6054 |
| walk-2350 | 14867 | 2350 | 1042 | 2293 | 2243 | 2164 | 2164 | 2164 |
| walk-a3070 | 23324 | 3070 | 1909 | 3128 | 3013 | 2858 | 2858 | 2858 |
| walk-a10021 | 139853 | 10021 | 12222 | 13140 | 10253 | 9903 | 9903 | 9903 |
| walk-1834 | 11493 | 1834 | 1093 | 1847 | 1799 | 1773 | 1773 | 1773 |
| walk-2331 | 15525 | 2331 | 1874 | 2334 | 2257 | 2272 | 2272 | 2272 |
| drive-36min | 24184 | 0 | 1199 | 484 | 160 | 45 | 45 | 45 |
| drive-29min | 19460 | 0 | 1153 | 558 | 192 | 58 | 58 | 58 |
| drive-a3 | 8818 | 3 | 535 | 369 | 124 | 67 | 67 | 67 |
| work-66 | 48037 | 66 | 980 | 294 | 97 | 65 | 65 | 65 |
| work-0 | 42559 | 0 | 760 | 139 | 20 | 6 | 6 | 6 |
| mixed-390 | 42838 | 390 | 1871 | 1186 | 541 | 407 | 407 | 407 |
| general-a260 | 141053 | 260 | 3854 | 1323 | 578 | 400 | 400 | 400 |
| housework-a958 | 86806 | 958 | 5762 | 5367 | 2663 | 1825 | 1825 | 1825 |
| train-journey | 44447 | 0 | 1660 | 95 | 36 | 15 | 15 | 15 |
| 100.csv | 988 | ~100 | 108 | 104 | 18 | 51 | 51 | 51 |
| 100_4 | 689 | ~100 | 24 | 93 | 95 | 89 | 89 | 89 |

Take-away: version differences are large (same 10021-step walk: 12222 / 13140 / 10253 / 9903; same car drive: 1199 / 484 / 160 / 45), which makes a strong Drift demo.

## Recommended comparison set
1. 2v09 inline (`RELEASE_2V09`, 2021-04-19): naive baseline, wildly different.
2. 2v10 = 9c2c3738: first bandpass + history gate (over-counts walks: 13140 vs 10021).
3. 2v11 = e33e1183: state machine + raw gate (biggest behaviour change; undercounts short walks, 100.csv gives 18).
4. 2v12 to 2v21 = afb4943c: DC filter, RAW 15 (long-lived, 10 releases).
5. 2v29 = 2913ca0a: latest; output identical to afb4943c, kept as a null-drift control (Drift must report zero drift). 3138205d (2v22-28) is a free second control.
