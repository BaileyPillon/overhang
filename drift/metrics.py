"""Metrics: what each firmware generation does to the research number, with uncertainty.

All functions are pure (arrays in, numbers out) except compute_metrics(), which walks a ReplayResult.  Every random
choice is a bootstrap over SUBJECTS with a fixed seed, so the same replay always gives the same numbers.

Definitions (also written into the results JSON under "config"):

count error     (counted - true) / true per recording, in percent.  Clemson: per subject and gait type; the median
                and IQR across subjects are reported per generation, plus the mean with a bootstrap CI.
per-step match  A detected step matches a true step if it falls within +-X ms (X = 100 and 250) after a constant
                per-generation latency has been removed.  Matching is one-to-one (a greedy sweep over the two sorted
                time lists, which is optimal for equal windows).  The latency is the maximum of the cross-correlation
                of the two event trains, estimated on the TRAINING half of the Clemson subjects and applied to the
                TEST half (split by subject number parity: even = training, odd = test).  Because gait is periodic the
                correlation repeats every step period, so this "latency" is a PHASE (identified modulo the step period),
                not a device delay.  Precision, recall and F1 are pooled over the subjects of the test half; CIs are
                bootstrapped over those subjects.  In Regular gait the median step interval is ~0.53 s, so a +-250 ms window spans
                ~94% of it: F1 there barely separates a step detector from a metronome.  Two reference rows make that
                visible: "random" (the same number of detections as the firmware, at uniformly random times) and an
                ORACLE metronome (the file's own mean cadence, best phase, no firmware at all).  +-100 ms is the more
                discriminating window; +-500 ms (almost two step periods) is not reported.
                Firmware that confirms a run of steps retroactively (2v11 and later) adds several steps at one
                sample; each of them is placed at its own step-candidate peak (the last k peaks), see steps_times().
false positives steps per hour on the Bangle drive and train recordings (and, as an extra, the static ones), counted
                above the expected total of the file (0 for most of them; the totals come from the file name and
                upstream main.c, their provenance is undocumented).  Hours are the TIMESTAMP span of the file, not
                n / 12.5 (samples are occasionally dropped).  Few files, one main wearer, so no confidence interval.
paired drift    for two generations A -> B, the per-subject difference in count error (B minus A, percentage points
                of the true count), averaged over subjects, with a 95% bootstrap CI over subjects
                (10,000 resamples, seed 42).  Gait type "all" first averages each subject's three gaits.  Also reported
                per pair: the SD of the per-subject differences, how many subjects move by more than the threshold
                and the largest single change (the mean alone hides individual-level differences), and a t-interval
                (the percentile bootstrap is 3 to 5% narrower at n = 30).
native walks    Cross-check on the labelled native Bangle.js walking files (not Clemson): the same boundary shifts,
                per file, in percentage points of the file's expected total.  Six files, one wearer, no CI.
"all gaits"     Count error "all" = equal-weight mean of the three per-gait percent errors of a subject.  Step matching
                "all" pools the step counts of the three gaits.  They are different things on purpose; both are named.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import gaussian_filter1d

from drift.recordings import BANGLE_RATE_HZ

N_BOOT = 10_000
SEED = 42
TOLERANCES_S = (0.1, 0.25)
GAITS = ("regular", "semiregular", "irregular")
GAIT_NAMES = {"regular": "Regular", "semiregular": "SemiRegular", "irregular": "Irregular", "all": "All gaits"}
LATENCY_WINDOW_S = (0.0, 3.0)      # a causal algorithm cannot report a step before it happened
LATENCY_BIN_S = 0.01
LATENCY_SIGMA_S = 0.08             # smoothing of the pooled cross-correlation before taking the maximum
DEFAULT_THRESHOLD_PCT = 2.0        # "comparable" if the 95% CI of the shift lies within +-2 percentage points
N_RANDOM_REPEATS = 10              # random-timing baseline: repeats per recording (pooled)
N_METRONOME_PHASES = 48            # oracle metronome: phases tried per recording
SHIFT_STEPS = ("leftshift", "rightshift")   # Clemson annotations for weight-shift steps (counted as true steps by default)
NONWALKING_KINDS = ("drive", "train")
EXTRA_NONWALKING_KINDS = ("static",)

SPLIT_RULE = ("Clemson subjects are split by the parity of the subject number (P002 -> 2): even = training half "
              "(latency estimation), odd = test half (evaluation).")


# --------------------------------------------------------------------------------------------------------------
# bootstrap
# --------------------------------------------------------------------------------------------------------------
def boot_indices(n: int, n_boot: int = N_BOOT, seed: int = SEED) -> np.ndarray:
    """(n_boot, n) resample indices; a fresh generator per call, so a result never depends on call order."""
    return np.random.default_rng(seed).integers(0, n, size=(n_boot, n))


def bootstrap_ci(values, stat: str = "mean", n_boot: int = N_BOOT, seed: int = SEED, level: float = 0.95):
    """Percentile bootstrap over the elements of `values` (one element per subject).
    Returns (estimate, lo, hi); estimate is the statistic on the original values."""
    v = np.asarray(values, dtype=np.float64)
    if v.size == 0:
        return (float("nan"),) * 3
    fn = {"mean": np.mean, "median": np.median}[stat]
    idx = boot_indices(len(v), n_boot, seed)
    boots = fn(v[idx], axis=1)
    a = (1 - level) / 2
    lo, hi = np.percentile(boots, [100 * a, 100 * (1 - a)])
    return float(fn(v)), float(lo), float(hi)


def verdict(ci: tuple[float, float], threshold: float = DEFAULT_THRESHOLD_PCT) -> bool:
    """True = comparable: the whole CI of the shift is within +-threshold."""
    return bool(ci[0] >= -threshold and ci[1] <= threshold)


# --------------------------------------------------------------------------------------------------------------
# count error
# --------------------------------------------------------------------------------------------------------------
def count_error_pct(counted, true) -> np.ndarray:
    counted = np.asarray(counted, dtype=np.float64)
    true = np.asarray(true, dtype=np.float64)
    return 100.0 * (counted - true) / true


def summarize_errors(err_pct, n_boot: int = N_BOOT, seed: int = SEED) -> dict:
    e = np.asarray(err_pct, dtype=np.float64)
    q1, med, q3 = np.percentile(e, [25, 50, 75])
    mean, mlo, mhi = bootstrap_ci(e, "mean", n_boot, seed)
    _, dlo, dhi = bootstrap_ci(e, "median", n_boot, seed)
    return {"n": int(e.size), "median_pct": float(med), "q25_pct": float(q1), "q75_pct": float(q3),
            "iqr_pct": float(q3 - q1), "median_ci_pct": [dlo, dhi],
            "mean_pct": mean, "mean_ci_pct": [mlo, mhi], "mean_abs_pct": float(np.abs(e).mean())}


# --------------------------------------------------------------------------------------------------------------
# per-step matching
# --------------------------------------------------------------------------------------------------------------
def step_times(events: np.ndarray, peaks: np.ndarray | None, rate_hz: float) -> np.ndarray:
    """Times (s) at which the counted steps physically happened.

    A sample with events[i] = k adds k steps.  Firmware with a state machine (2v11+) confirms a run of steps
    retroactively, so the k steps belong to the last k step-candidate peaks up to and including sample i; for
    generations whose steps are not retroactive the last peak is i itself.  Without peak information, or when
    fewer than k peaks precede i, the remaining steps are put at sample i.
    """
    ev = np.asarray(events)
    idx = np.flatnonzero(ev)
    if idx.size == 0:
        return np.zeros(0)
    pk = np.flatnonzero(peaks) if peaks is not None else np.zeros(0, dtype=np.int64)
    out: list[int] = []
    for i in idx:
        k = int(ev[i])
        if k == 1 and (peaks is None or peaks[i]):
            out.append(int(i))
            continue
        upto = int(np.searchsorted(pk, i, side="right"))
        chosen = pk[max(0, upto - k):upto].tolist()
        out.extend(chosen + [int(i)] * (k - len(chosen)))
    return np.sort(np.asarray(out, dtype=np.float64)) / rate_hz


def pair_offsets(det: np.ndarray, true: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """All (detected - true) differences within [lo, hi]: the cross-correlation of two impulse trains, unbinned."""
    if len(det) == 0 or len(true) == 0:
        return np.zeros(0)
    d = np.asarray(det)[None, :] - np.asarray(true)[:, None]
    d = d.ravel()
    return d[(d >= lo) & (d <= hi)]


def estimate_latency(pairs: list[tuple[np.ndarray, np.ndarray]], window: tuple[float, float] = LATENCY_WINDOW_S,
                     bin_s: float = LATENCY_BIN_S, sigma_s: float = LATENCY_SIGMA_S) -> float:
    """Constant delay (s) of the detected event train relative to the true one: the maximum of the cross-correlation
    pooled over recordings (sum of the per-recording difference histograms, Gaussian-smoothed).
    Gait is periodic, so the correlation repeats every step period; the maximum inside the (causal) window picks the
    phase that matters for matching, and matching is insensitive to which repeat is chosen."""
    lo, hi = window
    nb = int(round((hi - lo) / bin_s))
    h = np.zeros(nb)
    for det, true in pairs:
        diffs = pair_offsets(det, true, lo, hi)
        h += np.histogram(diffs, bins=nb, range=(lo, hi))[0]
    if h.sum() == 0:
        return 0.0
    hs = gaussian_filter1d(h, sigma_s / bin_s, mode="constant")
    return float(lo + (int(np.argmax(hs)) + 0.5) * bin_s)


def match_steps(det: np.ndarray, true: np.ndarray, tol: float) -> tuple[int, int, int]:
    """One-to-one matching within +-tol; returns (true positives, n detected, n true)."""
    d, t = np.sort(np.asarray(det, dtype=np.float64)), np.sort(np.asarray(true, dtype=np.float64))
    i = j = tp = 0
    eps = 1e-9
    while i < len(t) and j < len(d):
        if d[j] < t[i] - tol - eps:
            j += 1
        elif d[j] > t[i] + tol + eps:
            i += 1
        else:
            tp += 1
            i += 1
            j += 1
    return tp, int(len(d)), int(len(t))


def prf(tp, n_det, n_true) -> tuple[float, float, float]:
    tp, n_det, n_true = (np.asarray(x, dtype=np.float64) for x in (tp, n_det, n_true))
    with np.errstate(divide="ignore", invalid="ignore"):
        p = np.where(n_det > 0, tp / n_det, np.nan)
        r = np.where(n_true > 0, tp / n_true, np.nan)
        f = np.where((p + r) > 0, 2 * p * r / (p + r), 0.0)
    return p, r, f


def pooled_prf_ci(counts: np.ndarray, n_boot: int = N_BOOT, seed: int = SEED) -> dict:
    """counts: (n_subjects, 3) = tp, n_det, n_true per subject.  Micro-averaged P/R/F1 and bootstrap CIs over subjects."""
    c = np.asarray(counts, dtype=np.float64)
    p, r, f = (float(x) for x in prf(*c.sum(axis=0)))
    idx = boot_indices(len(c), n_boot, seed)
    sums = c[idx].sum(axis=1)                       # (n_boot, 3)
    bp, br, bf = prf(sums[:, 0], sums[:, 1], sums[:, 2])
    out = {"precision": p, "recall": r, "f1": f, "n_subjects": int(len(c)),
           "n_true": int(c[:, 2].sum()), "n_detected": int(c[:, 1].sum()), "n_matched": int(c[:, 0].sum())}
    for name, b in (("precision", bp), ("recall", br), ("f1", bf)):
        lo, hi = np.nanpercentile(b, [2.5, 97.5])
        out[f"{name}_ci"] = [float(lo), float(hi)]
    return out


# --------------------------------------------------------------------------------------------------------------
# paired drift
# --------------------------------------------------------------------------------------------------------------
def paired_shift(err_a, err_b, n_boot: int = N_BOOT, seed: int = SEED, threshold: float = DEFAULT_THRESHOLD_PCT) -> dict:
    """Mean per-subject difference (B - A) in count error, percentage points, with a bootstrap CI over subjects.
    Also the individual-level spread, which the mean and its CI hide: SD of the differences, the number of subjects
    whose count error moves by more than +-threshold points, the largest single change, and a t-interval."""
    a, b = np.asarray(err_a, dtype=np.float64), np.asarray(err_b, dtype=np.float64)
    if a.shape != b.shape:
        raise ValueError("paired arrays must be aligned by subject")
    d = b - a
    mean, lo, hi = bootstrap_ci(d, "mean", n_boot, seed)
    n = int(d.size)
    sd = float(np.std(d, ddof=1)) if n > 1 else 0.0
    if n > 1:
        from scipy.stats import t as _t
        half = float(_t.ppf(0.975, n - 1) * sd / np.sqrt(n))
        ci_t = [float(d.mean() - half), float(d.mean() + half)]
    else:
        ci_t = [float(d.mean()) if n else float("nan")] * 2
    beyond = int(np.sum(np.abs(d) > threshold + 1e-12))
    return {"n": n, "shift_pct": mean, "ci_pct": [lo, hi], "ci_t_pct": ci_t, "sd_pct": sd,
            "frac_subjects_changed": float(np.mean(np.abs(d) > 1e-12)),
            "n_beyond_threshold": beyond, "frac_beyond_threshold": beyond / n if n else 0.0,
            "max_abs_subject_change_pct": float(np.abs(d).max()) if d.size else 0.0}


# --------------------------------------------------------------------------------------------------------------
# step-match reference rows
# --------------------------------------------------------------------------------------------------------------
def metronome_times(true: np.ndarray, tol: float, n_phase: int = N_METRONOME_PHASES) -> np.ndarray:
    """ORACLE metronome for one recording: as many evenly spaced ticks as there are true steps, at the file's mean
    cadence ((last - first) / (n - 1)), with the phase that matches the most true steps.  It uses the answer (cadence,
    phase) and no sensor data, so it shows what a perfectly regular walker scores for free at this tolerance."""
    t = np.asarray(true, dtype=np.float64)
    if t.size < 3:
        return np.zeros(0)
    period = (t[-1] - t[0]) / (t.size - 1)
    k = np.arange(t.size)
    best, best_tp = None, -1
    for ph in np.linspace(0.0, period, n_phase, endpoint=False):
        det = t[0] - period / 2 + ph + k * period
        tp = match_steps(det, t, tol)[0]
        if tp > best_tp:
            best, best_tp = det, tp
    return best


def random_times(n_det: int, duration_s: float, rng: np.random.Generator) -> np.ndarray:
    """The same NUMBER of detections as the firmware produced, at uniformly random times."""
    return np.sort(rng.uniform(0.0, duration_s, size=int(n_det)))


# --------------------------------------------------------------------------------------------------------------
# the full computation
# --------------------------------------------------------------------------------------------------------------
def subject_number(subject: str) -> int:
    digits = "".join(ch for ch in str(subject) if ch.isdigit())
    if not digits:
        raise ValueError(f"cannot read a subject number from {subject!r}")
    return int(digits)


def split_of(subject: str) -> str:
    return "train" if subject_number(subject) % 2 == 0 else "test"


def _round(obj, nd=5):
    if isinstance(obj, dict):
        return {k: _round(v, nd) for k, v in obj.items()}
    if isinstance(obj, np.ndarray):
        return [_round(v, nd) for v in obj.tolist()]
    if isinstance(obj, (list, tuple)):
        return [_round(v, nd) for v in obj]
    if isinstance(obj, (float, np.floating)):
        return None if not np.isfinite(obj) else round(float(obj), nd)
    if isinstance(obj, np.integer):
        return int(obj)
    return obj


def generation_info(g, description: str = "") -> dict:
    return {"gen_id": g.gen_id, "label": g.label, "first_tag": g.first_tag, "last_tag": g.last_tag, "tags": list(g.tags),
            "first_date": g.first_date.isoformat(), "last_date": g.last_date.isoformat() if g.last_date else None,
            "commit": g.commit, "blobs": dict(g.blobs), "description": description}


def _span_s(r) -> float:
    """Duration of a recording in seconds: the timestamp span when the loader recorded one (Bangle files drop the
    odd sample, so n / 12.5 understates it by up to ~1%), else n / rate."""
    return float(r.meta.get("span_s") or r.duration_s)


def clemson_errors(res) -> tuple[list[str], dict, dict[str, dict[str, np.ndarray]]]:
    """(subjects, {(subject, gait): Recording}, gait -> gen_id -> per-subject count error in percent).
    "all" is the equal-weight mean of the three gaits' errors of each subject."""
    gid = [g.gen_id for g in res.generations]
    clem = [r for r in res.recordings if r.source == "clemson"]
    subjects = sorted({r.subject for r in clem}, key=subject_number)
    by = {(r.subject, r.kind): r for r in clem}
    sub_err: dict[str, dict[str, np.ndarray]] = {}
    for gait in GAITS:
        sub_err[gait] = {g: np.array([float(count_error_pct(res.runs[(g, by[(s, gait)].rec_id)].total,
                                                            by[(s, gait)].truth["steps_total"])) for s in subjects])
                         for g in gid}
    sub_err["all"] = {g: np.mean([sub_err[k][g] for k in GAITS], axis=0) for g in gid}
    return subjects, by, sub_err


def native_walk_check(res, threshold_pct: float = DEFAULT_THRESHOLD_PCT) -> dict:
    """Cross-check on the labelled NATIVE Bangle.js walking recordings (12.5 Hz, no resampling, no adapter).

    For every generation pair (a before b): the per-file shift (b - a) in percentage points of the file's expected
    total.  Six files from one wearer, so there is no confidence interval, only the spread over files.  The Clemson
    shifts are an estimate for young adults on a 15 Hz sensor resampled to 12.5 Hz; this is the only data in the
    pipeline that went through the firmware exactly as recorded."""
    gid = [g.gen_id for g in res.generations]
    walks = [r for r in res.recordings if r.source != "clemson" and r.kind == "walk" and r.truth.get("steps_total")]
    if not walks:
        return {}
    files = [{"rec_id": r.rec_id, "steps_expected": int(r.truth["steps_total"]), "subject": r.subject,
              "counted": {g: res.runs[(g, r.rec_id)].total for g in gid},
              "error_pct": {g: float(count_error_pct(res.runs[(g, r.rec_id)].total, r.truth["steps_total"])) for g in gid}}
             for r in walks]
    per_gen = {}
    for g in gid:
        e = np.array([f["error_pct"][g] for f in files])
        per_gen[g] = {"mean_error_pct": float(e.mean()), "median_error_pct": float(np.median(e)),
                      "min_error_pct": float(e.min()), "max_error_pct": float(e.max())}
    pairs = []
    for i, a in enumerate(gid):
        for j in range(i + 1, len(gid)):
            b = gid[j]
            sh = np.array([f["error_pct"][b] - f["error_pct"][a] for f in files])
            pairs.append({"from": a, "to": b, "consecutive": j == i + 1, "n_files": len(files),
                          "shifts_pct": sh.tolist(), "mean_pct": float(sh.mean()), "median_pct": float(np.median(sh)),
                          "min_pct": float(sh.min()), "max_pct": float(sh.max()),
                          "n_files_beyond_threshold": int(np.sum(np.abs(sh) > threshold_pct)),
                          "n_files_negative": int(np.sum(sh < 0)), "n_files_positive": int(np.sum(sh > 0))})
    return {"definition": ("per-file shift = error(b) - error(a), percentage points of the file's expected total; the six "
                           "labelled HughB walking files (one wearer), replayed natively at 12.5 Hz; no CI"),
            "n_files": len(files), "wearers": sorted({f["subject"] for f in files if f["subject"]}),
            "files": files, "per_generation": per_gen, "pairs": pairs}


def compute_metrics(res, null_controls: dict[str, str] | None = None, n_boot: int = N_BOOT, seed: int = SEED,
                    threshold_pct: float = DEFAULT_THRESHOLD_PCT, descriptions: dict[str, str] | None = None,
                    context: dict | None = None, extra: dict | None = None) -> dict:
    """res: ReplayResult (with peaks).  null_controls: {control gen_id: reference gen_id}.
    descriptions: gen_id -> short text; context: extra provenance copied into the output (e.g. cohort ages);
    extra: more top-level keys to merge (e.g. the resampler sensitivity computed from a second replay)."""
    gens = list(res.generations)
    gid = [g.gen_id for g in gens]
    recs = {r.rec_id: r for r in res.recordings}
    if any(run.peaks is None for run in res.runs.values()):
        raise ValueError("replay results carry no step-candidate peaks (table written by an older replay); "
                         "re-run: python -m drift replay")
    clem = [r for r in res.recordings if r.source == "clemson"]
    subjects, by_subj_gait, sub_err = clemson_errors(res)

    # ---- count error per subject, per gait, per generation ----------------------------------------------------
    count_error = {g: {k: summarize_errors(sub_err[k][g], n_boot, seed) for k in (*GAITS, "all")} for g in gid}

    # ---- Bangle labelled recordings ---------------------------------------------------------------------------
    bangle_rows = []
    for r in res.recordings:
        if r.source != "clemson" and r.truth.get("steps_total"):
            bangle_rows.append({"rec_id": r.rec_id, "kind": r.kind, "steps_true": r.truth["steps_total"],
                                "duration_h": _span_s(r) / 3600.0,
                                "counted": {g: res.runs[(g, r.rec_id)].total for g in gid},
                                "error_pct": {g: float(count_error_pct(res.runs[(g, r.rec_id)].total,
                                                                       r.truth["steps_total"])) for g in gid}})
    native = native_walk_check(res, threshold_pct)

    # ---- per-step matching --------------------------------------------------------------------------------------
    times: dict[tuple[str, str], np.ndarray] = {}
    for g in gid:
        for r in clem:
            run = res.runs[(g, r.rec_id)]
            times[(g, r.rec_id)] = step_times(run.events, run.peaks, BANGLE_RATE_HZ)
    train_subj = [s for s in subjects if split_of(s) == "train"]
    test_subj = [s for s in subjects if split_of(s) == "test"]
    latency: dict[str, float] = {}
    for g in gid:
        pairs = [(times[(g, r.rec_id)], r.truth["step_times_s"]) for r in clem if split_of(r.subject) == "train"]
        latency[g] = estimate_latency(pairs)

    def tkey(tol, corrected=True):
        return f"tol_{int(round(tol * 1000))}ms" + ("" if corrected else "_uncorrected")

    step_match: dict[str, dict] = {}
    for g in gid:
        step_match[g] = {}
        for gait in (*GAITS, "all"):
            entry = {}
            for tol in TOLERANCES_S:
                for corrected in (True, False):
                    lag = latency[g] if corrected else 0.0
                    per_subj = []
                    for s in test_subj:
                        tp = nd = nt = 0
                        for k in (GAITS if gait == "all" else (gait,)):
                            r = by_subj_gait[(s, k)]
                            a, b, c = match_steps(times[(g, r.rec_id)] - lag, r.truth["step_times_s"], tol)
                            tp, nd, nt = tp + a, nd + b, nt + c
                        per_subj.append((tp, nd, nt))
                    entry[tkey(tol, corrected)] = pooled_prf_ci(np.array(per_subj), n_boot, seed)
            step_match[g][gait] = entry

    # reference rows: what timing alone scores (see the module docstring) -----------------------------------------
    test_recs = [by_subj_gait[(s, k)] for s in test_subj for k in GAITS]
    rec_index = {r.rec_id: i for i, r in enumerate(clem)}
    metro = {(tol, r.rec_id): match_steps(metronome_times(r.truth["step_times_s"], tol), r.truth["step_times_s"], tol)
             for tol in TOLERANCES_S for r in test_recs}
    rand_counts: dict[tuple[str, str, float], tuple[float, int, int]] = {}
    for g in gid:
        for r in test_recs:
            n_det = len(times[(g, r.rec_id)])
            dur = res.runs[(g, r.rec_id)].n_samples / BANGLE_RATE_HZ
            for tol in TOLERANCES_S:
                tps = []
                for rep in range(N_RANDOM_REPEATS):
                    rng = np.random.default_rng([seed, rec_index[r.rec_id], rep])
                    tps.append(match_steps(random_times(n_det, dur, rng), r.truth["step_times_s"], tol)[0])
                rand_counts[(g, r.rec_id, tol)] = (float(np.mean(tps)), n_det, len(r.truth["step_times_s"]))

    def pooled(fetch, gait, tol):
        per_subj = []
        for s in test_subj:
            tot = np.zeros(3)
            for k in (GAITS if gait == "all" else (gait,)):
                tot += np.array(fetch(by_subj_gait[(s, k)], tol), dtype=np.float64)
            per_subj.append(tot)
        return pooled_prf_ci(np.array(per_subj), n_boot, seed)

    baselines = {
        "note": ("Reference rows for the per-step F1.  oracle_metronome: no firmware, the file's own mean cadence and "
                 "best phase (uses the answer).  random_timing: the generation's own number of detections at uniformly "
                 f"random times, mean of {N_RANDOM_REPEATS} draws per recording.  Test-half subjects, as for the firmware."),
        "oracle_metronome": {gait: {tkey(tol): pooled(lambda r, t: metro[(t, r.rec_id)], gait, tol) for tol in TOLERANCES_S}
                             for gait in (*GAITS, "all")},
        "random_timing": {g: {gait: {tkey(tol): pooled(lambda r, t, g=g: rand_counts[(g, r.rec_id, t)], gait, tol)
                                     for tol in TOLERANCES_S} for gait in (*GAITS, "all")} for g in gid},
    }
    step_timing = {"note": ("interval between consecutive annotated steps; the matching window is +-tol, so it spans "
                            "2*tol / median interval of the step period"), "by_gait": {}}
    for gait in GAITS:
        iv = np.concatenate([np.diff(r.truth["step_times_s"]) for r in clem if r.kind == gait])
        cad = [60.0 * (len(r.truth["step_times_s"]) - 1) / (r.truth["step_times_s"][-1] - r.truth["step_times_s"][0])
               for r in clem if r.kind == gait]
        med = float(np.median(iv))
        step_timing["by_gait"][gait] = {
            "median_step_interval_s": med, "mean_cadence_steps_per_min": float(np.mean(cad)),
            "window_fraction_of_median_interval": {tkey(tol): min(2 * tol / med, 9.99) for tol in TOLERANCES_S}}

    # sensitivity: the same, without Clemson's weight-shift annotations (leftshift / rightshift) -------------------
    def noshift_mask(r):
        return ~np.isin(np.asarray(r.meta["step_side"]), SHIFT_STEPS)
    n_all = sum(len(r.truth["step_times_s"]) for r in clem)
    n_shift = sum(int((~noshift_mask(r)).sum()) for r in clem)
    ns_err = {k: {g: np.array([float(count_error_pct(res.runs[(g, by_subj_gait[(s, k)].rec_id)].total,
                                                     noshift_mask(by_subj_gait[(s, k)]).sum())) for s in subjects])
                  for g in gid} for k in GAITS}
    ns_f1 = {}
    for g in gid:
        per_subj = []
        for s in test_subj:
            tp = nd = nt = 0
            for k in GAITS:
                r = by_subj_gait[(s, k)]
                a, b, c = match_steps(times[(g, r.rec_id)] - latency[g], r.truth["step_times_s"][noshift_mask(r)], 0.25)
                tp, nd, nt = tp + a, nd + b, nt + c
            per_subj.append((tp, nd, nt))
        ns_f1[g] = float(prf(*np.array(per_subj, dtype=np.float64).sum(axis=0))[2])
    excl_shift = {
        "note": ("Clemson annotates weight-shift steps ('leftshift'/'rightshift') as steps, and the default truth counts "
                 "them.  Here they are removed from the truth (detections unchanged)."),
        "n_steps": int(n_all), "n_shift_steps": int(n_shift), "fraction_shift_steps": n_shift / n_all,
        "count_error": {g: {k: {"median_pct": float(np.median(ns_err[k][g])),
                                "q25_pct": float(np.percentile(ns_err[k][g], 25)),
                                "q75_pct": float(np.percentile(ns_err[k][g], 75))} for k in GAITS} for g in gid},
        "f1_250ms_all_gaits": ns_f1,
    }

    # ---- false positives on non-walking Bangle recordings -------------------------------------------------------
    def fp_rows(kinds):
        return [r for r in res.recordings if r.source != "clemson" and r.kind in kinds]
    fp: dict[str, dict] = {}
    for g in gid:
        out = {}
        for name, kinds in (("drive", ("drive",)), ("train", ("train",)), ("drive_train", NONWALKING_KINDS),
                            ("static", EXTRA_NONWALKING_KINDS)):
            rows = fp_rows(kinds)
            hours = sum(_span_s(r) for r in rows) / 3600.0
            excess = sum(max(res.runs[(g, r.rec_id)].total - (r.truth.get("steps_total") or 0), 0) for r in rows)
            counted = sum(res.runs[(g, r.rec_id)].total for r in rows)
            out[name] = {"n_files": len(rows), "wearers": sorted({r.subject for r in rows if r.subject}),
                         "hours": hours, "steps_counted": int(counted),
                         "steps_above_manual_count": int(excess), "fp_per_hour": excess / hours if hours else None}
        out["files"] = [{"rec_id": r.rec_id, "kind": r.kind, "hours": _span_s(r) / 3600.0,
                         "steps_true": r.truth.get("steps_total"), "counted": res.runs[(g, r.rec_id)].total,
                         "fp_per_hour": max(res.runs[(g, r.rec_id)].total - (r.truth.get("steps_total") or 0), 0)
                         / (_span_s(r) / 3600.0)} for r in fp_rows(NONWALKING_KINDS + EXTRA_NONWALKING_KINDS)]
        fp[g] = out

    # ---- paired drift between generations (all ordered pairs a < b; consecutive ones flagged) -------------------
    drift = []
    for i, a in enumerate(gid):
        for j in range(i + 1, len(gid)):
            b = gid[j]
            for gait in (*GAITS, "all"):
                sh = paired_shift(sub_err[gait][a], sub_err[gait][b], n_boot, seed, threshold_pct)
                sh.update({"from": a, "to": b, "consecutive": j == i + 1, "gait": gait,
                           "comparable": verdict(tuple(sh["ci_pct"]), threshold_pct)})
                drift.append(sh)

    # ---- null controls --------------------------------------------------------------------------------------------
    nulls = []
    for ctl, ref in (null_controls or {}).items():
        same_tot = all(res.runs[(ctl, r)].total == res.runs[(ref, r)].total for r in recs)
        same_ev = all(np.array_equal(res.runs[(ctl, r)].events, res.runs[(ref, r)].events) for r in recs)
        same_pk = all(np.array_equal(res.runs[(ctl, r)].peaks, res.runs[(ref, r)].peaks) for r in recs)
        nulls.append({"control": ctl, "reference": ref, "recordings": len(recs),
                      "identical_totals": bool(same_tot), "identical_events": bool(same_ev),
                      "identical_peaks": bool(same_pk), "passed": bool(same_tot and same_ev and same_pk)})

    out = {
        "target": res.target,
        "generations": [generation_info(g, (descriptions or {}).get(g.gen_id, "")) for g in gens],
        "context": context or {},
        "config": {
            "n_boot": n_boot, "seed": seed, "ci_level": 0.95, "ci_method": "percentile bootstrap over Clemson subjects",
            "tolerances_s": list(TOLERANCES_S), "threshold_pct": threshold_pct,
            "latency": {"window_s": list(LATENCY_WINDOW_S), "bin_s": LATENCY_BIN_S, "smoothing_sigma_s": LATENCY_SIGMA_S,
                        "method": "maximum of the pooled, smoothed cross-correlation of detected and true step trains",
                        "interpretation": ("phase-ambiguous: gait is periodic, so this value is identified only modulo "
                                           "the step period (~0.5 to 0.6 s) and is NOT a device latency; it only aligns the "
                                           "two event trains before matching")},
            "split_rule": SPLIT_RULE, "train_subjects": train_subj, "test_subjects": test_subj,
            "subjects": subjects, "gait_types": list(GAITS),
            "error_definition": "(counted - true) / true, percent; shifts are percentage points of the true count",
            "all_gaits_definition": {
                "count_error": "equal-weight mean of a subject's three per-gait percent errors (dominated by Irregular)",
                "step_match": "pooled step counts (true positives, detections, true steps) over a subject's three gaits"},
            "false_positive_definition": ("steps counted above the expected total of the file (file name / upstream main.c; "
                                          "provenance undocumented), per hour of TIMESTAMP span, excess clipped at zero per file"),
            "verdict_definition": ("'comparable' = the whole 95% bootstrap CI of the MEAN paired shift lies within "
                                   "+-threshold points.  It says nothing about individual participants "
                                   "(see sd_pct, n_beyond_threshold, max_abs_subject_change_pct) and is not corrected "
                                   "for the 6 pairs x 4 gaits examined"),
        },
        "step_timing": step_timing,
        "count_error": count_error,
        "count_error_by_subject": {k: {g: sub_err[k][g] for g in gid} for k in (*GAITS, "all")},
        "count_error_excluding_shift_steps": excl_shift,
        "bangle_labelled": bangle_rows,
        "native_walk_check": native,
        "step_match": {"latency_s": latency,
                       "latency_note": "phase-ambiguous alignment value, not a device latency (see config.latency)",
                       "results": step_match, "baselines": baselines},
        "false_positives": fp,
        "drift": drift,
        "null_controls": nulls,
    }
    if extra:
        out.update(extra)
    return _round(out, 5)


def resampler_sensitivity(res_base, res_alt, label_base: str, label_alt: str, n_boot: int = N_BOOT, seed: int = SEED,
                          threshold_pct: float = DEFAULT_THRESHOLD_PCT) -> dict:
    """Count error and paired drift on the Clemson recordings under two 15 -> 12.5 Hz resamplers (same firmware, same
    recordings).  res_alt may hold the Clemson recordings only."""
    gid = [g.gen_id for g in res_base.generations]
    _, _, e0 = clemson_errors(res_base)
    _, _, e1 = clemson_errors(res_alt)
    count = {g: {k: {"median_pct": float(np.median(e1[k][g])), "q25_pct": float(np.percentile(e1[k][g], 25)),
                     "q75_pct": float(np.percentile(e1[k][g], 75)), "mean_pct": float(e1[k][g].mean()),
                     "median_pct_base": float(np.median(e0[k][g])), "mean_pct_base": float(e0[k][g].mean())}
                 for k in (*GAITS, "all")} for g in gid}
    rows = []
    for i, a in enumerate(gid):
        for j in range(i + 1, len(gid)):
            b = gid[j]
            for gait in (*GAITS, "all"):
                s0 = paired_shift(e0[gait][a], e0[gait][b], n_boot, seed, threshold_pct)
                s1 = paired_shift(e1[gait][a], e1[gait][b], n_boot, seed, threshold_pct)
                rows.append({"from": a, "to": b, "gait": gait, "consecutive": j == i + 1,
                             "shift_pct": s1["shift_pct"], "ci_pct": s1["ci_pct"],
                             "comparable": verdict(tuple(s1["ci_pct"]), threshold_pct),
                             "shift_pct_base": s0["shift_pct"], "ci_pct_base": s0["ci_pct"],
                             "comparable_base": verdict(tuple(s0["ci_pct"]), threshold_pct)})
    return {"base": label_base, "alternative": label_alt,
            "note": (f"Same firmware and recordings, only the 15 -> 12.5 Hz resampler changes ({label_base} is Drift's "
                     f"default).  Medians for the semi-regular and irregular gaits and the boundary CIs depend on it."),
            "count_error": count, "drift": rows}
