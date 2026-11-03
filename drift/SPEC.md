# Drift: build spec (v1)

Firmware forensics for science. Given an open-source wearable's firmware history and recorded raw sensor data, Drift measures how each released firmware version changes the research metric. It does this by compiling the metric algorithm from every version for the host and replaying the same recordings through all of them (**differential execution**). It then writes a dated data-validity memo for a study team.

The recon (in `drift/recon/`) has shown the core works: 12 Espruino step-counter variants were compiled with `python -m ziglang cc` and replayed through ctypes, and they reproduce upstream's `main.c` numbers exactly.

## Layout (Python package `drift/`, in the overhang repo)

```
drift/
  __init__.py  __main__.py  cli.py
  toolchain.py          # exists (recon): compile_c / compile_cpp via ziglang
  history.py            # tag → algorithm-blob map; collapse identical blobs into generations
  buildcache.py         # compile each unique blob once, cached by blob SHA under .cache/drift/
  recordings.py         # Recording dataclass + loaders/adapters (Bangle CSV, Clemson, PPG set)
  replay.py             # run every generation on every recording → results table
  metrics.py            # count error, per-step precision/recall (tolerance window), FP on non-walking, bootstrap CIs
  memo.py               # study window → dated validity memo (Markdown + HTML)
  export.py             # results → results/drift/*.json and app/public/data/winner.json
  targets/
    base.py             # Target protocol (below)
    espruino_stepcount/ # shim/, wrap.c, wrap_2v09.c (from recon), target.py
    infinitime_hr/      # shim/, harness (from recon), target.py (secondary target)
  fetch/                # scripts that download datasets and firmware sources (never vendor third-party data)
  skill/SKILL.md        # Claude Code skill: onboard a NEW open-source device target
  tests/
```

## Target protocol (`targets/base.py`)

```python
@dataclass
class Generation:      # one distinct algorithm implementation
    gen_id: str        # short blob-set hash
    blobs: dict[str, str]          # path -> blob sha
    first_tag: str; last_tag: str; tags: list[str]
    first_date: date; last_date: date    # release dates of first_tag / of the next generation's first tag
    commit: str        # representative commit to build from
    label: str         # e.g. "2v12–2v21 (DC filter)"

@dataclass
class Recording:
    rec_id: str; source: str; subject: str|None; kind: str   # walk / regular / irregular / drive / train / mixed / hr
    rate_hz: float; data: np.ndarray                          # native units of the source
    truth: dict      # {"steps_total": int} and/or {"step_times_s": np.ndarray} and/or {"hr_bpm": (t, bpm)}

class Target(Protocol):
    name: str; repo_url: str; algo_files: list[str]; tag_glob: str
    def adapt(self, rec: Recording) -> np.ndarray      # resample/scale to the device's native input
    def build(self, gen: Generation, src_dir: Path) -> Path   # → dll
    def run(self, dll: Path, native: np.ndarray) -> RunOut  # totals + per-sample events (steps) or HR series
```

## Targets

1. **`espruino_stepcount` (the hero).** Bangle.js `libs/misc/stepcount.c` plus the 2v09 inline counter.
   - Generations: 2v09 inline, 2v10 (9c2c3738), 2v11 (e33e1183), 2v12–2v21 (afb4943c), 2v22–2v28 (3138205d, cosmetic), 2v29 (2913ca0a, clamp fix).
   - Input: |a|² at 12.5 Hz, 8192 = 1 g. The wrapper exposes per-sample step events so per-step matching works.
   - The dev-only commits from 2021 are an optional appendix (`--all-commits`).
2. **`infinitime_hr` (secondary, with honest caveats).** Two real generations: gen A, autocorrelation, 24 Hz, 0.11–1.12; gen B, FFT, 10 Hz, 1.13+. Each is fed at its native rate.
   - Data: a public raw-PPG dataset with ground-truth HR (see `recon/datasets.md`), resampled, plus the 6 real PineTime 1.14 recordings from the community fork (no ground truth: agreement only).
   - Caveat, stated everywhere: Drift replays the **algorithm layer only**. Sensor-driver changes (gain 64×→8× in 1.9.0; the 1.13.0 retune) cannot be replayed from recordings.
   - If the PPG data turns out unusable, ship the HR target as "static diff + synthetic sanity check", clearly labeled.

## Datasets (fetched by `drift/fetch/`, never committed)

- **Bangle.js step-count recordings:** github.com/gfwilliams/step-count @ d4b015c. 12.5 Hz native, filename totals, drive and train files with 0 steps. No license, so reference it, don't redistribute.
- **Clemson Pedometer Evaluation:** cecas.clemson.edu/tracking/Pedometer/Data.zip. 30 subjects × 3 gaits, wrist accel at 15 Hz in g, video-annotated step times. Resample to 12.5 Hz (polyphase or linear, documented) and scale to counts. Clip the two recordings with out-of-range step indices. Cite the dataset.
- **PPG:** per `recon/datasets.md`.

## Metrics

- **Count error per recording:** (counted − true) / true. Report the median and IQR across Clemson subjects, by gait type, per generation.
- **Per-step matching (Clemson):**
  - A detected step matches a true step if it falls within ±X ms. Default 250 ms; also report 500 ms.
  - Wearable step counters fire with a delay because of FIR filtering and run gating. Estimate a per-generation constant latency from the cross-correlation of event trains on a training half of the subjects, then apply it to the other half. Report precision, recall and F1.
- **False positives on non-walking data:** steps per hour on the Bangle drive and train recordings.
- **Drift between consecutive generations:** the paired difference in count error per recording, with a bootstrap 95% CI over subjects (10,000 resamples, seed fixed).
- **Null controls:** 2v22–2v28 and 2v29 must equal 2v12–2v21 on every recording. A test asserts it.

## Memo (`python -m drift memo --target espruino_stepcount --start 2021-05-01 --end 2022-06-30 --population "older adults, regular gait"`)

- A timeline of which generations were live during the window. Release dates come from the git tags, with a stated caveat: devices update on their own schedule.
- Expected bias for each generation, from the metrics (for the chosen gait type), plus the shift at each boundary, with CIs.
- Comparability verdicts per window pair: "comparable" when the CI of the shift is within ±2%, "not comparable" otherwise. The threshold is configurable.
- Recommendations: record firmware versions per participant; stratify by generation; re-derive steps from raw acceleration with one fixed algorithm version where raw data exists (Drift can do this, by replaying all participants through one generation).
- Motivating evidence, cited accurately (verify each claim against the source before writing it): Ravanelli et al. 2025 (Bangle.js 2 validation, firmware update mid-study), Woolley et al. 2019, Collins et al. 2019, Koffman et al. 2024. Credit Gordon Williams' step-count harness as the technique Drift builds on.

## Claude Code skill (`drift/skill/SKILL.md`)

Teaches Claude Code to onboard a new open-source device target end to end:
1. find the metric path from sensor to reported number;
2. map tags to blobs;
3. write the shim and wrapper with exported init/feed functions;
4. build through `drift.toolchain`;
5. write an adapter for the device's native input;
6. validate against any upstream harness;
7. add the null controls.

It must state the boundary: open-source firmware and lawful interoperability research only, no circumventing DRM, and no closed vendor binaries.

## Outputs

- `results/drift/espruino_stepcount.json` holds the generations, per-recording results, metrics, CIs, null-control check and provenance (source commit SHAs, dataset URLs and commits, toolchain version).
- `results/drift/infinitime_hr.json` likewise, with its caveats inline.
- `results/drift/memo-example.md` and `.html` hold one worked memo for a realistic study window spanning 2v10 → 2v12.
- `app/public/data/winner.json` follows the contract in `design/DATA.md`, extended with figure-ready arrays (per-generation error distributions by gait, FP/h, the timeline, and a diff summary of each boundary in plain words, labeled as written by Claude from the code diff).

## Acceptance

- `python -m pytest drift/tests -q` passes, including:
  - upstream reproduction: afb4943c on the Bangle files equals upstream `main.c` (6054, 2164, 2858, 9903 as found in recon);
  - the null controls;
  - resampling round-trip sanity;
  - history mapping against a fixture.
- `python -m drift all` runs fetch → build → replay → metrics → memo → export from a clean `.cache` on this machine, with every number traceable to a command.
- No third-party dataset files and no firmware source are committed; only fetch scripts, shims, wrappers and derived results are.
