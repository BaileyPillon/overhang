"""Metrics for the InfiniTime heart-rate target.

Evaluation unit = a non-overlapping 10 s window of a recording with ECG ground truth (HR = 60 / mean RR of the
hand-annotated R-peaks inside the window).  For each generation the window's output is the LAST positive value
returned by Ppg::HeartRate() inside that window (gen A emits one value per 200 samples = 8.33 s, so every 10 s window
can hold one; gen B emits every 0.5 s).  A window is VALID for a generation when at least one positive value was
emitted in it.  MAE is computed on valid windows; the valid fraction is reported next to it, never hidden.

Differences between generations use a bootstrap with a fixed seed (10,000 resamples):
  * over subjects (cluster bootstrap: whole subjects are resampled; the primary interval, 8 subjects), and
  * over windows (i.i.d. window resampling; narrower, because windows of one recording are autocorrelated).
"""
from __future__ import annotations

import numpy as np

from drift.targets.infinitime_hr.data import WINDOW_S, reference_check

N_BOOT = 10_000
SEED = 20261103
PULSE_VISIBLE_BPM = 5.0       # reference spectral peak within this many bpm of the ECG HR


# --------------------------------------------------------------------------------------------------------------
# window outputs
# --------------------------------------------------------------------------------------------------------------
def window_outputs(ret: np.ndarray, shown: np.ndarray, rate: float, n_windows: int,
                   window_s: float = WINDOW_S) -> tuple[np.ndarray, np.ndarray]:
    """(last positive output inside each window, value shown at the window end); NaN where there is none."""
    last = np.full(n_windows, np.nan)
    held = np.full(n_windows, np.nan)
    for k in range(n_windows):
        lo = int(round(k * window_s * rate))
        hi = min(int(round((k + 1) * window_s * rate)), len(ret))
        if hi <= lo:
            continue
        seg = ret[lo:hi]
        pos = np.flatnonzero(seg > 0)
        if len(pos):
            last[k] = seg[pos[-1]]
        if shown[hi - 1] > 0:
            held[k] = shown[hi - 1]
    return last, held


def window_table(res, roles: dict[str, str]) -> dict[str, np.ndarray]:
    """Flat per-window arrays over every recording with ground truth.

    Keys: rec_idx, subject, kind, k, truth, ref (spectral reference), and for each role r: out_<r>, held_<r>.
    """
    cols: dict[str, list] = {"rec_id": [], "subject": [], "kind": [], "k": [], "truth": [], "ref": []}
    for r in roles.values():
        cols[f"out_{r}"] = []
        cols[f"held_{r}"] = []
    for rec in res.recordings:
        if "hr_bpm" not in rec.truth:
            continue
        t_end, bpm = rec.truth["hr_bpm"]
        ref = reference_check(rec)
        n = len(bpm)
        outs = {}
        for gid, role in roles.items():
            run = res.runs[(gid, rec.rec_id)]
            outs[role] = window_outputs(run.hr[1], run.meta["shown"], run.meta["rate_hz"], n)
        for k in range(n):
            if not np.isfinite(bpm[k]):
                continue
            cols["rec_id"].append(rec.rec_id)
            cols["subject"].append(rec.subject)
            cols["kind"].append(rec.kind)
            cols["k"].append(k)
            cols["truth"].append(bpm[k])
            cols["ref"].append(ref[k])
            for role in roles.values():
                cols[f"out_{role}"].append(outs[role][0][k])
                cols[f"held_{role}"].append(outs[role][1][k])
    return {k: np.asarray(v) for k, v in cols.items()}


# --------------------------------------------------------------------------------------------------------------
# summaries
# --------------------------------------------------------------------------------------------------------------
def summarize(truth: np.ndarray, out: np.ndarray, held: np.ndarray | None = None) -> dict:
    valid = np.isfinite(out)
    err = out[valid] - truth[valid]
    ae = np.abs(err)
    d = {
        "n_windows": int(len(truth)), "n_valid": int(valid.sum()),
        "valid_fraction": float(valid.mean()) if len(truth) else None,
        "mae_bpm": float(ae.mean()) if len(ae) else None,
        "median_ae_bpm": float(np.median(ae)) if len(ae) else None,
        "bias_bpm": float(err.mean()) if len(err) else None,
        "within_5_bpm_of_valid": float((ae <= 5).mean()) if len(ae) else None,
        "within_5_bpm_of_all": float((ae <= 5).sum() / len(truth)) if len(truth) else None,
    }
    if held is not None:
        hv = np.isfinite(held)
        d["held_valid_fraction"] = float(hv.mean()) if len(truth) else None
        d["held_mae_bpm"] = float(np.abs(held[hv] - truth[hv]).mean()) if hv.any() else None
    return d


def bootstrap_ratio(num: np.ndarray, den: np.ndarray, groups: np.ndarray | None = None,
                    n_boot: int = N_BOOT, seed: int = SEED) -> dict:
    """Bootstrap CI of sum(num)/sum(den).  groups=None resamples items; otherwise whole groups (cluster bootstrap)."""
    rng = np.random.default_rng(seed)
    num = np.asarray(num, dtype=float)
    den = np.asarray(den, dtype=float)
    if groups is None:
        n = len(num)
        if n == 0:
            return {"estimate": None, "ci95": [None, None], "n_units": 0}
        idx = rng.integers(0, n, size=(n_boot, n))
        stat = num[idx].sum(1) / den[idx].sum(1)
        est = num.sum() / den.sum()
        units = n
    else:
        labels = np.unique(groups)
        sn = np.array([num[groups == g].sum() for g in labels])
        sd = np.array([den[groups == g].sum() for g in labels])
        idx = rng.integers(0, len(labels), size=(n_boot, len(labels)))
        stat = sn[idx].sum(1) / sd[idx].sum(1)
        est = sn.sum() / sd.sum()
        units = len(labels)
    lo, hi = np.percentile(stat, [2.5, 97.5])
    return {"estimate": float(est), "ci95": [float(lo), float(hi)], "n_units": int(units),
            "n_boot": n_boot, "seed": seed}


def paired_difference(tab: dict[str, np.ndarray], a: str, b: str, mask: np.ndarray | None = None) -> dict:
    """b minus a.  Absolute-error difference on windows where BOTH generations are valid (negative = b is better),
    and the difference in valid fraction on all windows, each with subject-cluster and window bootstrap CIs."""
    m = np.ones(len(tab["truth"]), dtype=bool) if mask is None else mask
    truth, oa, ob = tab["truth"][m], tab[f"out_{a}"][m], tab[f"out_{b}"][m]
    subj = tab["subject"][m]
    both = np.isfinite(oa) & np.isfinite(ob)
    d_ae = np.abs(ob[both] - truth[both]) - np.abs(oa[both] - truth[both])
    one = np.ones(both.sum())
    out = {
        "definition": f"|err {b}| - |err {a}| on windows valid for both, bpm (negative: {b} closer to ECG)",
        "n_windows_both_valid": int(both.sum()),
        "mae_a_on_common": float(np.abs(oa[both] - truth[both]).mean()) if both.any() else None,
        "mae_b_on_common": float(np.abs(ob[both] - truth[both]).mean()) if both.any() else None,
        "abs_error_diff_subject_bootstrap": bootstrap_ratio(d_ae, one, subj[both]) if both.any() else None,
        "abs_error_diff_window_bootstrap": bootstrap_ratio(d_ae, one, None) if both.any() else None,
    }
    va, vb = np.isfinite(oa).astype(float), np.isfinite(ob).astype(float)
    ones = np.ones(len(va))
    out["valid_fraction_diff"] = {
        "definition": f"valid fraction {b} minus valid fraction {a}, all windows",
        "subject_bootstrap": bootstrap_ratio(vb - va, ones, subj),
        "window_bootstrap": bootstrap_ratio(vb - va, ones, None),
    }
    return out


def evaluate(tab: dict[str, np.ndarray], roles: list[str]) -> dict:
    """Overall, per-activity, per-subject summaries and the A-vs-B differences (roles: e.g. ["A", "B", "A_null"])."""
    def block(mask: np.ndarray) -> dict:
        return {r: summarize(tab["truth"][mask], tab[f"out_{r}"][mask], tab[f"held_{r}"][mask]) for r in roles}

    allm = np.ones(len(tab["truth"]), dtype=bool)
    out: dict = {"overall": block(allm), "by_kind": {}, "by_subject": {}}
    for kind in sorted(set(tab["kind"])):
        out["by_kind"][kind] = block(tab["kind"] == kind)
    for s in sorted(set(tab["subject"])):
        out["by_subject"][s] = block(tab["subject"] == s)
    out["difference_B_minus_A"] = paired_difference(tab, "A", "B")
    out["difference_B_minus_A_by_kind"] = {k: paired_difference(tab, "A", "B", tab["kind"] == k)
                                           for k in sorted(set(tab["kind"]))}
    visible = np.isfinite(tab["ref"]) & (np.abs(tab["ref"] - tab["truth"]) <= PULSE_VISIBLE_BPM)
    out["pulse_visible_windows"] = {
        "definition": (f"windows where a firmware-independent spectral peak of the PPG (40-200 bpm) lies within "
                       f"{PULSE_VISIBLE_BPM:g} bpm of the ECG HR, i.e. the cardiac component dominates the window. "
                       "The gate itself is a spectral method, so it favours spectral estimators; read as a stratum, not a fair ranking."),
        "n_windows": int(visible.sum()), "fraction_of_windows": float(visible.mean()),
        "summary": block(visible),
        "difference_B_minus_A": paired_difference(tab, "A", "B", visible),
    }
    if "A_null" in roles:
        a, n = tab["out_A"], tab["out_A_null"]
        out["null_control_A"] = {"windows": int(len(a)),
                                 "identical_window_outputs": bool(np.array_equal(a, n, equal_nan=True))}
    return out


def reference_quality(tab: dict[str, np.ndarray]) -> dict:
    """Firmware-independent check that ECG truth and PPG are aligned and usable (spectral peak vs ECG)."""
    ok = np.isfinite(tab["ref"])
    hit = ok & (np.abs(tab["ref"] - tab["truth"]) <= PULSE_VISIBLE_BPM)
    by = {}
    for k in sorted(set(tab["kind"])):
        m = tab["kind"] == k
        by[k] = {"n_windows": int(m.sum()), "spectral_peak_within_5_bpm": float((hit & m).sum() / m.sum())}
    return {"method": "Hann-windowed FFT peak of the 25.6 Hz PPG, 40-200 bpm, per 10 s window vs ECG HR",
            "overall_within_5_bpm": float(hit.sum() / len(hit)), "by_kind": by,
            "note": "Wrist PPG during exercise is dominated by motion artifacts; a low hit rate on run/walk is expected "
                    "and is why per-activity and pulse-visible strata are reported."}


# --------------------------------------------------------------------------------------------------------------
# recordings without ground truth: agreement between generations only
# --------------------------------------------------------------------------------------------------------------
def agreement(res, roles: dict[str, str], a: str = "A", b: str = "B") -> dict:
    """Real PineTime 1.14 recordings.  No ground truth, so no accuracy claim: only how often each generation
    produces a value and how far apart the two generations' values are in the same 10 s window."""
    rows = []
    pooled_diff = []
    for rec in res.recordings:
        if "hr_bpm" in rec.truth:
            continue
        n_w = int(rec.duration_s // WINDOW_S)
        per = {}
        for gid, role in roles.items():
            run = res.runs[(gid, rec.rec_id)]
            per[role] = window_outputs(run.hr[1], run.meta["shown"], run.meta["rate_hz"], n_w)[0]
        both = np.isfinite(per[a]) & np.isfinite(per[b])
        diff = np.abs(per[a][both] - per[b][both])
        pooled_diff.extend(diff.tolist())
        rows.append({
            "rec_id": rec.rec_id, "activity": rec.meta.get("activity"), "led_current_mA": rec.meta.get("led_current_mA"),
            "duration_s": rec.duration_s, "n_windows": n_w,
            **{f"valid_fraction_{r}": float(np.isfinite(per[r]).mean()) for r in per},
            **{f"median_bpm_{r}": (float(np.nanmedian(per[r])) if np.isfinite(per[r]).any() else None) for r in per},
            "n_windows_both_valid": int(both.sum()),
            "median_abs_diff_bpm": float(np.median(diff)) if len(diff) else None,
            "fraction_within_10_bpm": float((diff <= 10).mean()) if len(diff) else None,
            "null_control_identical": bool(np.array_equal(per["A"], per["A_null"], equal_nan=True)) if "A_null" in per else None,
        })
    pd = np.asarray(pooled_diff)
    return {
        "scope": "agreement only: the recordings have no ground truth, so nothing here measures accuracy",
        "input_handling": ("The stitched 10 Hz stream is fed to gen B as recorded. Gen A assumes 24 Hz, so the same stream is "
                           "resampled 10 -> 24 Hz (polyphase 12/5). This is an assumption: a PineTime running gen A would have "
                           "produced different raw counts (other gain, rate, LED settings)."),
        "recordings": rows,
        "pooled": {"n_windows_both_valid": int(len(pd)),
                   "median_abs_diff_bpm": float(np.median(pd)) if len(pd) else None,
                   "fraction_within_10_bpm": float((pd <= 10).mean()) if len(pd) else None},
    }


# --------------------------------------------------------------------------------------------------------------
# synthetic sanity check (labelled as such)
# --------------------------------------------------------------------------------------------------------------
def synthetic_ppg(rate_hz: float, bpm: float, seconds: float = 120.0, dc: float = 3600.0, amp: float = 40.0,
                  noise: float = 3.0, seed: int = 1, harmonic: float = 0.0) -> np.ndarray:
    """Sine at the heart rate (optionally plus a second harmonic of relative amplitude `harmonic`) and Gaussian
    noise, as integer counts."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(rate_hz * seconds)) / rate_hz
    f = bpm / 60.0
    x = dc + amp * np.sin(2 * np.pi * f * t) + harmonic * amp * np.sin(4 * np.pi * f * t + 0.8) + rng.normal(0, noise, t.size)
    return np.rint(x).astype(np.int32)


def median_output(target, dll, x: np.ndarray, skip_s: float = 20.0) -> tuple[float | None, int]:
    out = target.run(dll, x)
    rate = out.meta["rate_hz"]
    pos = out.hr[1][int(skip_s * rate):]
    pos = pos[pos > 0]
    return (float(np.median(pos)) if len(pos) else None), int(len(pos))


def synthetic_sanity(target, dlls: dict[str, object], roles: dict[str, str], bpms=(60, 72, 100, 140)) -> dict:
    """Each generation at its native rate on clean synthetic PPG (SYNTHETIC: a sanity check of the harness, not data),
    plus the deliberately mismatched rates that show why every generation must be fed at its own rate."""
    rate = {r: target.rate_of(dlls[g]) for g, r in roles.items()}
    rows = []
    for gid, role in roles.items():
        for bpm in bpms:
            for fed in (24.0, 10.0):
                x = synthetic_ppg(fed, bpm)
                med, n = median_output(target, dlls[gid], x)
                rows.append({"role": role, "true_bpm": bpm, "fed_rate_hz": fed, "native": fed == rate[role],
                             "median_bpm": med, "n_outputs": n,
                             "error_bpm": None if med is None else med - bpm})
    return {"label": "SYNTHETIC pure-sine PPG (60/72/100/140 bpm, DC 3600, AC 40 counts, noise sigma 3): sanity check only, not data",
            "native_rates_hz": rate, "rows": rows}
