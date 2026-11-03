---
name: drift-onboard-device
description: Onboard a new open-source wearable or sensor device into Drift, the firmware-forensics tool, to check whether firmware updates changed the data the device produces (step counts, heart rate, any metric a research study relies on). Use when a user wants to know if firmware versions of an open-source device give different numbers on the same raw sensor data, wants a data-validity memo for a study window, or wants to add a target under drift/targets/. Covers finding the metric path, mapping release tags to algorithm blobs, writing a C/C++ shim and wrapper, building with drift.toolchain, writing the adapter, validating against upstream, null controls, replay and memo. Open-source firmware only.
---

# Onboard a new device target into Drift

Drift compiles the metric algorithm of every released firmware version for the host and replays the **same recorded raw sensor data** through all of them (differential execution). The effect of a firmware update on a research metric becomes a measured number. This skill is the procedure for adding a new device ("target") to `drift/`.

Worked example throughout: `drift/targets/espruino_stepcount/` (Bangle.js step counter, `libs/misc/stepcount.c`). Read it before you start; it is the reference for every step below. Read `drift/SPEC.md` first for the Target protocol.

## Boundary: read this before anything else

- **Open-source firmware only.** The firmware source must be published under an open-source license and fetched from its public repository. Lawful interoperability and research use only.
- **No closed vendor binaries.** Do not extract, disassemble, decompile or run proprietary firmware images or binary blobs. If the metric path ends in a closed blob (Bangle.js 2 heart rate is a binary blob, `heartrate_vc31_binary.c`; the PineTime step counter runs in Bosch BMA421 microcode), that metric is **not a target**. Say so and stop, or fall back to a clearly labelled static diff of the open part.
- **No DRM or access-control circumvention.** Do not bypass authentication, encryption, signing, bot challenges or download gates. If a dataset sits behind a challenge (OxWalk answered 403 with a Cloudflare challenge), a human downloads it in a browser; you do not work around it.
- **Algorithm layer only.** Drift replays the algorithm from recorded sensor data. It cannot replay sensor-driver changes (gain, LED current, ADC settings, sampling interval) because those change the raw counts themselves. State this limit in every result and memo. Example: InfiniTime's HRS3300 gain change in 1.9.0 and the 1.13.0 retune are outside what Drift can measure.
- **License check.** Record the firmware license (Espruino: MPL-2.0; InfiniTime: GPL-3.0-or-later). Never vendor firmware source or third-party datasets into the repo: they live under `.cache/drift/` (gitignored) and are fetched by `drift/fetch/`. Datasets without a license (Bangle.js step-count repo, Clemson) are referenced by URL and commit, never redistributed.
- **Honesty.** Every number must come from a command anyone can rerun. If differential execution is infeasible for an algorithm, say so and label any fallback as a static diff.

## Prerequisites

- Python: the project venv (`.venv` at the repo root; activate it, or call `.venv/Scripts/python` on Windows or `.venv/bin/python` elsewhere), shown as `python` below. Add pure-Python deps with `python -m pip install <pkg>` and record them in `drift/requirements.txt`.
- Run scripts that read downloaded data with `-I`. Never commit to git unless the user asks. Do not touch `app/`.
- C compiler: bundled zig/clang via `drift.toolchain` (`compile_c`, `compile_cpp`, `zig_version`). No system compiler needed.

## Step 1. Find the metric path

Trace from the sensor sample to the number a study would report. Use `git show <tag>:<path>` on a blobless clone; no checkout is needed.

1. Find the caller that reads the sensor (Espruino: `libs/banglejs/jswrap_bangle.c`, poll loop at 80 ms = 12.5 Hz, `accMagSquared = acc.x*acc.x + acc.y*acc.y + acc.z*acc.z`).
2. Find the pure function that turns samples into the metric (`stepcount_new(int accMagSquared)` returns steps to add).
3. Write down: input rate, units/scaling (8192 counts = 1 g), integer widths, and what is global state. Integer width matters: Drift compiles with `-fwrapv` so int32 overflow wraps as it does on the device.
4. Check history before the algorithm had its own file. Espruino 2v09 and earlier had an inline hysteresis counter in `jswrap_bangle.c`; Drift transcribes it as `wrap_2v09.c`.
5. Record what is out of reach (driver gain, closed blobs, on-chip microcode). This goes in the target's caveats.

Prior reconnaissance lives in `drift/recon/` (`espruino.md`, `infinitime.md`): copy that style of note for a new device.

## Step 2. Map tags to blobs, collapse to generations

`drift/history.py` does this: for each release tag (version order, never date order) it reads the git blob SHA of every file in the target's `algo_files`, then merges consecutive tags with identical blob sets into one **Generation** (`gen_id` = sha1 of the blob set, 8 hex).

Set on the target class:

```python
algo_files = ["libs/misc/stepcount.c", "libs/misc/stepcount.h"]
tag_glob   = "RELEASE_2V*"
tag_min    = "RELEASE_2V09"
```

Espruino result: six generations: 2v09 inline (no blobs), 2v10 (9c2c3738), 2v11 (e33e1183), 2v12-2v21 (afb4943c, DC filter), 2v22-2v28 (3138205d, cosmetic), 2v29 (2913ca0a, clamp fix). Check your mapping by hand on two or three tags. A generation's `last_date` is the next generation's first release date, `None` for the newest. Add a `describe(gen)` note per commit (see `_NOTES` in the Espruino `target.py`).

Add a fetcher `drift/fetch/<device>.py` that clones the firmware repo blobless into `.cache/drift/`. Copy `drift/fetch/espruino.py`. Add dataset fetchers beside it (`bangle.py`, `clemson.py`) and register them in `drift/fetch/__init__.py`.

## Step 3. Shim and wrapper with exported init/feed

Upstream code rarely compiles alone. Keep the algorithm file **byte-identical** to the tag (Drift materialises it from git into the build dir), and put everything Drift adds next to it:

- **Shim** (`targets/<name>/shim/`): the minimum headers the algorithm includes. Espruino needs only `jsutils.h` with `int_sqrt32()` (copied verbatim from the step-count repo's `jsutils.h`). Do not edit the upstream file to make it compile; provide a shim header instead.
- **Wrapper** (`wrap.c`, or `.cpp`): `#include`s the algorithm and exports a small stable C ABI. For Espruino, ABI version 4:

```c
EXPORT int  drift_abi(void);                                    // returns 4
EXPORT int  drift_flush_tail(void);                             // samples upstream's harness appends (ACCELFILTER_TAP_NUM: 57 for 2v10, 7 later)
EXPORT void drift_init(void);                                   // reset: stepcount_init() AND any file-scope state it forgets (2v11+: gate_open, active_sample_count)
EXPORT int  drift_feed(int accMagSquared);                      // one sample, returns steps to add
EXPORT int  drift_run(const short *xyz, int n, int *perSample, int *peak); // total; perSample[i] = events, peak[i] = step-candidate peak
```

  Read the algorithm file for globals that the upstream `*_init()` does not reset and reset them in `drift_init`, because Drift reuses one loaded library for many recordings; add a test that a recording gives the same result after different predecessors (`test_results_do_not_depend_on_the_previous_recording`).

  Compute the algorithm's input inside C with the **same expression and int width as the firmware** (`x*x + y*y + z*z` on `int`). Export per-sample events (`perSample`, summing to the total) so per-step matching works; the firmware can add steps in bursts (several at once when a run is confirmed), so an event may be greater than 1.
- **One library per generation.** Upstream algorithms keep state in globals, so each distinct blob set is built into its own shared library. Never share a DLL between generations.
- **Older code paths** with no algorithm file get their own wrapper (`wrap_2v09.c`) with the same ABI.
- Put every file that affects the build into `recipe_files`; the build cache key includes their hash.

## Step 4. Build through drift.toolchain

`build(gen, src_dir)` calls `drift.toolchain.compile_c` (or `compile_cpp`) with `shared=True`, `includes=[shim, src_dir]`, and flags in `cflags`. Do not call a compiler directly.

```python
compile_c([HERE / "wrap.c"], out, shared=True, std="-std=c99",
          includes=[HERE / "shim", src_dir], extra=["-fwrapv"])
```

`drift/buildcache.py` compiles each unique blob set once, keyed by blob SHAs, recipe hash and zig version, under `.cache/drift/build/`. Do not bypass it. Run:

```
python -m drift build --target <name>
```

Fix warnings; the Espruino wrapper builds with `-Wall` and no warnings. Set `recipe_extra` to a string describing the compiler settings so changing them invalidates the cache.

## Step 5. Adapter for the device's native input

`adapt(rec)` turns any `Recording` (`drift/recordings.py`) into exactly what the device feeds its algorithm. For Espruino: int16 `(n, 3)` at 12.5 Hz, 8192 counts = 1 g.

- Bangle recordings are already native (12.5 Hz, counts): pass through.
- Clemson recordings are 15 Hz in g: polyphase-resample to 12.5 Hz (`scipy.signal.resample_poly`), scale by 8192 counts per g, saturate to int16. `to_bangle_native()` in `recordings.py` does this; the method (`poly` or `linear`) is recorded in provenance.
- Clip truth annotations that fall outside the data (Clemson `P010_Regular` and `P019_Irregular` have step indices past the end).
- A round-trip test (resample then compare) belongs in `tests/`, as in `test_resample_events.py` and `test_clemson_adapter.py`.

Add a loader to `recordings.py` for each dataset, filling `Recording.truth` (`steps_total`, `step_times_s`, or `hr_bpm`). State each dataset's weaknesses: Bangle truth is a per-file manual total only; Clemson is walking only.

## Step 6. Validate against any upstream harness

Never trust a build until it reproduces upstream. Espruino ships a harness (Gordon Williams' `gfwilliams/step-count`, `main.c`) that `#include`s `stepcount.c` and feeds the CSVs. Build it on the same blob, record its numbers, and assert equality.

- Live upstream test: `drift/tests/test_upstream_live.py` builds the pinned, unmodified `main.c` against the blobs (with a getline shim injected by `-include`, and `-DX_STEPS=0 -DRAW_THRESHOLD=0` for 2v10, whose `stepcount.c` lacks them) and compares it with Drift. Constants alone cannot detect drift in the data, the harness or the toolchain.
- Pin the firmware: record the tag window and a digest of the `tag<TAB>commit` lines (`history.check_tag_pin`); a clone with different commits fails, newer tags are ignored with a warning.
- Upstream reproduction test (fast path, constants): `drift/tests/test_reproduction.py`. afb4943c on the Bangle files equals upstream `main.c` (6054, 2164, 2858, 9903, 45, 58, 67, 65, 407, 400, 1825, 0); the 2v09 column equals upstream's "orig" counter (3223, 1042, 1909, 12222, ...).
- Match the harness conditions exactly. Upstream appends ACCELFILTER_TAP_NUM repeated tail samples (57 for the 2v10 blob, 7 for 2v11 and later; read it from the blob, never hard-code one number); the device does not. Drift's `flush=True` reproduces upstream, `flush=False` (default) is what the device does.
- Where the algorithm file's header comment publishes scores (stepcount.c gives 1446, 1752, 1751 on HughB-walk-1834), reproduce those too.
- With no upstream harness, write a golden test from a hand-checkable synthetic input, and say in the target docs that no external reproduction exists.

## Step 7. Null controls

A pipeline that cannot report "no change" proves nothing. For every generation boundary where blob SHAs differ but behaviour should not (cosmetic edits, bug fixes that never trigger), assert **identical totals and identical per-sample events** on every recording. Espruino: 2v22-2v28 (3138205d) and 2v29 (2913ca0a) must equal 2v12-2v21 (afb4943c) on all 126 recordings: `drift/tests/test_null_controls.py`. The controls must be separately built libraries, not the same file.

If a control is not identical, it is no longer a control: find out why (the shim, state leaking between runs, a real behaviour change) before reporting any drift. A real behaviour change is a finding; report it.

## Step 8. Register, replay, test

1. Create `drift/targets/<name>/{__init__.py,target.py,wrap.c,shim/}`. `target.py` defines the class (`name`, `repo_url`, `algo_files`, `tag_glob`, `tag_min`, `datasets`, `recipe_files`, `adapt`, `build`, `run`, `describe`, `recordings`, `provenance`) and `TARGET_CLASS = <Class>`. Register the name in `drift/targets/__init__.py`.
2. `python -m drift fetch|build|replay|all --target <name>` (from the repository root). Replay writes `.cache/drift/replay/<name>.json` plus an events archive.
3. `python -m pytest drift/tests -q` must pass with nothing skipped.

## Step 9. Run and write the memo

After replay, the metrics stage computes (see SPEC):

- count error per recording and its median/IQR by gait; per-step precision/recall/F1 with a per-generation latency estimated on a training half of the subjects and applied to the other half; false positives per hour on non-walking data; paired generation-to-generation differences with a 10,000-resample bootstrap 95% CI over subjects (fixed seed).
- the memo: `python -m drift memo --target <name> --start YYYY-MM-DD --end YYYY-MM-DD --population "<who>"`. It gives a timeline of live generations (release dates from git tags, with the caveat that devices update on their own schedule), expected bias per generation, shift at each boundary with CI, and "comparable" (CI within +/-2%) or "not comparable" verdicts. Recommend: record firmware version per participant, stratify by generation, and re-derive from raw acceleration with one fixed algorithm version where raw data exists.
- Cite only claims you verified against the source. Credit Gordon Williams' step-count harness as the technique Drift builds on.

Status note: at the time of writing, `all` runs fetch, build and replay; the metrics, memo and export stages register in `STAGES_AFTER_REPLAY` in `drift/cli.py`. Check what exists before promising a stage.

## Worked example: espruino_stepcount

| Step | Real path |
|---|---|
| Metric path | `libs/misc/stepcount.c` called from `libs/banglejs/jswrap_bangle.c`; notes in `drift/recon/espruino.md` |
| Generations | `drift/history.py` over tags `RELEASE_2V09`..`RELEASE_2V29` |
| Shim | `drift/targets/espruino_stepcount/shim/jsutils.h` |
| Wrappers | `drift/targets/espruino_stepcount/wrap.c`, `wrap_2v09.c` |
| Build | `drift/targets/espruino_stepcount/target.py` `build()`, `drift/buildcache.py`, cache `.cache/drift/build/` |
| Adapter | `target.adapt` -> `drift/recordings.py: to_bangle_native` |
| Data | `drift/fetch/bangle.py` (gfwilliams/step-count @ d4b015c), `drift/fetch/clemson.py` |
| Upstream check | `drift/tests/test_upstream_live.py` (live), `drift/tests/test_reproduction.py` (constants) |
| Null controls | `drift/tests/test_null_controls.py` |
| Headline contrast | same 10021-step walk: 2v09 12222, 2v10 13140, 2v11 10253, 2v12 9903; same car drive (file drive-36min-0, 32 min of data): 1199, 486, 160, 45 with upstream tail flush (1199, 483, 160, 45 without, the device behaviour) |

## Second example: infinitime_hr (secondary, not built when this was written)

PineTime/InfiniTime heart rate (`src/components/heartrate/Ppg.cpp`, C++, GPL-3.0-or-later): two real generations, A autocorrelation at 24 Hz (0.11.0-1.12.0) and B FFT at 10 Hz (1.13.0-1.16.1), each fed at its native rate; PhysioNet wrist PPG as data (needs resampling, no smartwatch PPG chip). Use `compile_cpp`. Recon harness: `drift/recon/harness/`. Required caveat: algorithm layer only; driver changes are unreplayable. PineTime step counting is **not** a target (Bosch BMA421 on-chip microcode, a closed binary). If the PPG data is unusable, ship "static diff plus synthetic sanity check", labelled.

## Checklist before you say done

- [ ] Firmware is open source, license recorded; no closed blob on the metric path
- [ ] Nothing third-party committed; fetchers only; `.cache/drift/` gitignored
- [ ] Generations hand-checked on 2 to 3 tags
- [ ] Upstream harness reproduced exactly (or absence stated)
- [ ] Null controls identical on every recording
- [ ] Adapter round-trip test; truth clipping documented
- [ ] `python -m pytest drift/tests -q` passes, nothing skipped
- [ ] Limits stated in the results: algorithm layer only, dataset weaknesses
