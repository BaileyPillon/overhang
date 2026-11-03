"""results/drift/infinitime_hr.json: generations, verification of the within-generation identity claims, ground-truth
metrics with bootstrap CIs, agreement on the real PineTime recordings, synthetic sanity, provenance and the caveat."""
from __future__ import annotations

import datetime as _dt
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

from drift import REPO_ROOT, buildcache, generated_date, replay as replay_mod
from drift.targets.infinitime_hr import metrics
from drift.targets.infinitime_hr.data import WINDOW_S

OUT_PATH = REPO_ROOT / "results" / "drift" / "infinitime_hr.json"
SENSITIVITY_AC_STD = (10.0, 25.0, 60.0)


def _jsonable(o):
    if isinstance(o, dict):
        return {str(k): _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.ndarray):
        return _jsonable(o.tolist())
    if isinstance(o, (_dt.date, _dt.datetime)):
        return o.isoformat()
    if isinstance(o, Path):
        return str(o)
    return o


# --------------------------------------------------------------------------------------------------------------
def verify_variants(target, repo: Path, cache: Path, recs, natives) -> list[dict]:
    """Build and replay EVERY distinct blob set (10: 7 gen A, 3 gen B) on every recording and compare with the
    representative of its family.  gen B is compared with the -2 'not enough data' sentinel (1.16.0+) mapped to 0."""
    variants = target.variant_list
    reps = {"A": next(v for v in variants if target.variant_info[v.gen_id]["family"] == "A"),
            "B": next(v for v in variants if target.variant_info[v.gen_id]["family"] == "B")}
    dlls = {v.gen_id: buildcache.build_generation(target, v, repo, cache) for v in variants}

    def run_all(v):
        return {r.rec_id: target.run(dlls[v.gen_id], natives[r.rec_id]) for r in recs}

    ref = {fam: run_all(v) for fam, v in reps.items()}
    out = []
    for v in variants:
        info = target.variant_info[v.gen_id]
        fam = info["family"]
        runs = ref[fam] if v.gen_id == reps[fam].gen_id else run_all(v)
        n_samples = n_ret_diff = n_sentinel_only = n_shown_diff = n_rec_identical = 0
        for r in recs:
            a, b = ref[fam][r.rec_id], runs[r.rec_id]
            ra, rb = a.hr[1], b.hr[1]
            n_samples += len(ra)
            diff = ra != rb
            n_ret_diff += int(diff.sum())
            sentinel = diff & ((ra == -2) | (rb == -2)) & ((np.maximum(ra, 0) == np.maximum(rb, 0)))
            n_sentinel_only += int(sentinel.sum())
            n_shown_diff += int((a.meta["shown"] != b.meta["shown"]).sum())
            n_rec_identical += int(not (diff & ~sentinel).any() and np.array_equal(a.meta["shown"], b.meta["shown"]))
        out.append({
            "gen_id": v.gen_id, "family": fam, "first_tag": v.first_tag, "last_tag": v.last_tag, "tags": v.tags,
            "commit": v.commit, "blobs": {Path(p).name: b for p, b in v.blobs.items()},
            "compared_with": f"gen {fam} representative ({reps[fam].first_tag})",
            "recordings_compared": len(recs), "samples_compared": n_samples,
            "samples_with_different_return": n_ret_diff,
            "samples_differing_only_by_minus2_sentinel": n_sentinel_only,
            "samples_with_different_displayed_value": n_shown_diff,
            "recordings_identical_apart_from_sentinel": n_rec_identical,
            "identical_output": bool(n_ret_diff == n_sentinel_only and n_shown_diff == 0),
            "identical_raw_return": bool(n_ret_diff == 0),
        })
    return out


def static_diff(target, repo: Path) -> list[dict]:
    """What changed in the heart-rate files between consecutive distinct blob sets (git facts, not interpretation)."""
    rows = []
    vs = target.variant_list
    files = target.algo_files
    for a, b in zip(vs, vs[1:]):
        row = {"from": a.first_tag, "to": b.first_tag}
        try:
            num = subprocess.run(["git", "-C", str(repo), "diff", "--numstat", f"refs/tags/{a.last_tag}", f"refs/tags/{b.first_tag}",
                                  "--", *files], capture_output=True, text=True, check=True).stdout
            ins = dele = 0
            for line in num.splitlines():
                p = line.split("\t")
                if p[0].isdigit():
                    ins += int(p[0])
                    dele += int(p[1])
            row.update({"files_changed": len(num.splitlines()), "lines_added": ins, "lines_removed": dele})
            log = subprocess.run(["git", "-C", str(repo), "log", "--format=%h %cs %s", f"refs/tags/{a.last_tag}..refs/tags/{b.first_tag}",
                                  "--", *files], capture_output=True, text=True, check=True).stdout
            row["commits"] = log.strip().splitlines()[:12]
        except Exception as e:  # blobs missing and no network, etc.
            row["error"] = str(e)[:200]
        rows.append(row)
    return rows


def _recording_rows(tab, roles: list[str]) -> list[dict]:
    rows = []
    for rid in dict.fromkeys(tab["rec_id"]):
        m = tab["rec_id"] == rid
        row = {"rec_id": rid, "subject": str(tab["subject"][m][0]), "kind": str(tab["kind"][m][0]), "n_windows": int(m.sum()),
               "ecg_hr_median_bpm": float(np.median(tab["truth"][m]))}
        for r in roles:
            s = metrics.summarize(tab["truth"][m], tab[f"out_{r}"][m])
            row[f"mae_{r}"] = s["mae_bpm"]
            row[f"valid_fraction_{r}"] = s["valid_fraction"]
        rows.append(row)
    return rows


def sensitivity(target, res, dlls: dict, roles: dict) -> list[dict]:
    """Overall result for several AC-amplitude scalings of the public PPG (the scaling is an assumption)."""
    from drift.targets.infinitime_hr.target import InfiniTimeHR
    wrist = [r for r in res.recordings if "hr_bpm" in r.truth]
    out = []
    for ac in SENSITIVITY_AC_STD:
        tg = InfiniTimeHR(target.cache, ac_std=ac)
        r2 = replay_mod.replay(tg, res.generations, dlls, wrist)
        tab = metrics.window_table(r2, roles)
        ev = metrics.evaluate(tab, ["A", "B", "A_null"])
        out.append({"ac_sigma_counts": ac, "overall": ev["overall"], "difference_B_minus_A": ev["difference_B_minus_A"]})
    return out


def headline(ev: dict, scal: list[dict], variants: list[dict]) -> dict:
    """The numbers a reader quotes, computed from the blocks below (no hand-typed values)."""
    o, d = ev["overall"], ev["difference_B_minus_A"]
    sb, wb = d["abs_error_diff_subject_bootstrap"], d["abs_error_diff_window_bootstrap"]
    vf = d["valid_fraction_diff"]["subject_bootstrap"]
    return {
        "mae_bpm": {r: o[r]["mae_bpm"] for r in o},
        "valid_fraction": {r: o[r]["valid_fraction"] for r in o},
        "median_abs_error_bpm": {r: o[r]["median_ae_bpm"] for r in o},
        "B_minus_A_abs_error_bpm": {"estimate": sb["estimate"], "ci95_subjects": sb["ci95"], "ci95_windows": wb["ci95"],
                                    "n_windows_both_valid": d["n_windows_both_valid"]},
        "B_minus_A_valid_fraction": {"estimate": vf["estimate"], "ci95_subjects": vf["ci95"]},
        "null_control_A_identical": bool(o["A"] == o["A_null"]),
        "all_variants_identical_within_generation": bool(all(v["identical_output"] for v in variants)),
        "scaling_sensitivity": [{"ac_sigma_counts": s["ac_sigma_counts"],
                                 "valid_fraction": {r: s["overall"][r]["valid_fraction"] for r in ("A", "B")},
                                 "mae_bpm": {r: s["overall"][r]["mae_bpm"] for r in ("A", "B")},
                                 "B_minus_A_abs_error_bpm": s["difference_B_minus_A"]["abs_error_diff_subject_bootstrap"]["estimate"]}
                                for s in scal],
    }


def build_results(target, res, cache: Path) -> dict:
    roles = dict(target.roles)
    role_names = ["A", "B", "A_null"]
    gens = {roles[g.gen_id]: g for g in res.generations}
    repo = target.repo_path(cache)
    dlls = {g.gen_id: buildcache.build_generation(target, g, repo, cache) for g in res.generations}
    natives = {r.rec_id: target.adapt(r) for r in res.recordings}

    tab = metrics.window_table(res, roles)
    ev = metrics.evaluate(tab, role_names)
    wrist = [r for r in res.recordings if "hr_bpm" in r.truth]
    subjects = sorted({r.subject for r in wrist})
    variants = verify_variants(target, repo, cache, res.recordings, natives)
    from drift.targets.infinitime_hr.target import CAVEAT, RATE_A, RATE_B
    from drift.fetch import infinitime as fw
    prov = target.provenance(cache)

    gen_rows = []
    for role in role_names:
        g = gens[role]
        gen_rows.append({
            "role": role, "gen_id": g.gen_id, "label": g.label, "first_tag": g.first_tag, "last_tag": g.last_tag,
            "tags": g.tags, "first_date": g.first_date, "last_date": g.last_date, "commit": g.commit,
            "blobs": {Path(p).name: b for p, b in g.blobs.items()},
            "native_rate_hz": RATE_A if role.startswith("A") else RATE_B,
            "algorithm": ("wasp-os time-domain autocorrelation (Biquad HPF -> Ptagc AGC -> Biquad LPF -> trough search), "
                          "200-sample buffer, bpm = 60*24*4/lag" if role.startswith("A") else
                          "Ceimour's FFT (arduinoFFT): 64-sample Hann window every 0.5 s, 3-spectrum average, peak search "
                          "30-240 bpm, running mean over 20 outputs"),
            "kept_because": {"A": "distinct generation", "B": "distinct generation (latest)",
                             "A_null": "null control: last gen-A variant (1.12.0), must equal gen A"}[role],
        })

    scal = sensitivity(target, res, dlls, roles)
    ident = {v["family"]: [] for v in variants}
    for v in variants:
        ident[v["family"]].append(v["identical_output"])
    return {
        "target": "infinitime_hr",
        "title": "InfiniTime (PineTime) heart rate: autocorrelation (0.11.0-1.12.0) vs FFT (1.13.0-1.16.1)",
        "generated": generated_date().isoformat(),
        "caveat": CAVEAT,
        "caveats": [
            CAVEAT,
            "Ground truth is ECG R-peaks from a different sensor/subject population (8 subjects, exercise); exercise PPG is "
            "dominated by motion artifacts and InfiniTime's algorithms use no accelerometer.",
            "Only 8 subjects: the subject-level bootstrap interval is wide and is the primary one; the window-level interval "
            "treats autocorrelated windows as independent and is optimistic.",
            "Scaling of the public PPG to HRS3300 counts is an assumption (see scaling_sensitivity).",
            "The six real PineTime recordings have no ground truth: they support agreement statements only.",
        ],
        "provenance": {
            **prov,
            "firmware_tags": {"first": "0.11.0", "last": "1.16.1"},
            "scaling": ("anti-aliased polyphase resample from 256 Hz to the generation's native rate; robust AC sigma "
                        f"{target.ac_std:g} counts (1.4826*MAD of the 0.5-4 Hz band), median shifted to {target.dc_counts:g} counts, "
                        "rounded, clipped to 0..32767"),
            "evaluation_window_s": WINDOW_S,
            "bootstrap": {"resamples": metrics.N_BOOT, "seed": metrics.SEED},
            "commands": ["python -m drift all --target infinitime_hr", "python -m pytest drift/tests -q"],
        },
        "headline": headline(ev, scal, variants),
        "generations": gen_rows,
        "variants_checked": variants,
        "identical_output_within_generation": {fam: all(v) for fam, v in ident.items()},
        "static_diff": static_diff(target, repo),
        "ground_truth_eval": {
            "dataset": "PhysioNet Wrist PPG During Exercise 1.0.0 (Jarchi & Casson 2017, doi:10.3390/data2010001, ODC-By 1.0)",
            "n_recordings": len(wrist), "n_subjects": len(subjects), "subjects": subjects,
            "n_windows": int(len(tab["truth"])), "window_s": WINDOW_S,
            "truth": "ECG R-peaks (hand-annotated); HR = 60 / mean RR of beats inside each non-overlapping 10 s window",
            "output_definition": "last positive Ppg::HeartRate() value inside the window; valid = at least one",
            **ev,
            "reference_check": metrics.reference_quality(tab),
            "recordings": _recording_rows(tab, role_names),
        },
        "scaling_sensitivity": scal,
        "agreement_real_pinetime": metrics.agreement(res, roles),
        "synthetic_sanity": metrics.synthetic_sanity(target, dlls, roles),
    }


def export_stage(args, target, res) -> Path:
    cache = Path(args.cache)
    results = build_results(target, res, cache)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(_jsonable(results), indent=1, allow_nan=False))
    print(f"wrote {OUT_PATH}")
    summary_lines(results)
    return OUT_PATH


def summary_lines(results: dict) -> None:
    g = results["ground_truth_eval"]
    for role, s in g["overall"].items():
        print(f"  gen {role:7s} MAE {s['mae_bpm']:.2f} bpm  valid {s['valid_fraction']:.1%}  ({s['n_valid']}/{s['n_windows']} windows)")
    d = g["difference_B_minus_A"]
    ci = d["abs_error_diff_subject_bootstrap"]["ci95"]
    print(f"  B - A |error|: {d['abs_error_diff_subject_bootstrap']['estimate']:+.2f} bpm, subject-bootstrap 95% CI [{ci[0]:+.2f}, {ci[1]:+.2f}]")


if __name__ == "__main__":
    sys.exit("run: python -m drift all --target infinitime_hr")
