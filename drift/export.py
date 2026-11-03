"""Results export: the full results JSON for a target and the app's winner.json (design/DATA.md contract, status "built").

results/drift/<target>.json   generations, per-recording results, metrics with CIs, null-control check, provenance,
                              figure-ready arrays
app/public/data/winner.json   status "built" + a "demo" block (headline numbers and the figure arrays), nothing else of
                              the app is touched
"""
from __future__ import annotations

import hashlib
import json
import platform
import subprocess
from pathlib import Path

import numpy as np

from drift import REPO_ROOT, __version__, generated_date
from drift.metrics import GAIT_NAMES, GAITS

RESULTS_DIR = REPO_ROOT / "results" / "drift"
WINNER_PATH = REPO_ROOT / "app" / "public" / "data" / "winner.json"
# tracked source of winner.json's non-numeric text (pitch, how_it_works, pick record), so it regenerates from scratch
WINNER_SOURCE = REPO_ROOT / "drift" / "winner_source.json"
SCHEMA = "drift/results/1"

CAVEATS = [
    "Drift replays the step-counting algorithm only. Sensor-driver, sampling or settings changes in a firmware release cannot be reproduced from recordings.",
    "Release dates are the commit dates of the git release tags. A watch runs a version only after its owner installs it, so a participant's real switch date is later and unknown without logs.",
    "Clemson subjects are 30 adults aged 19 to 27 walking marked courses; the Bangle.js recordings come from a few wearers (mostly one) and their expected totals are taken from file names and upstream main.c (provenance undocumented). Neither is an older-adult cohort.",
    "The Clemson-to-Bangle.js transfer is unvalidated: on the six native Bangle.js walking recordings (one wearer, no resampling) the boundary shifts disagree with the Clemson shifts (see native_walk_check). Verdicts that Clemson calls comparable but the native walks contradict are reported as 'not confirmed'.",
    "Clemson data (15 Hz, g) is resampled to the device's 12.5 Hz and 8192 counts per g (polyphase 5/6) and saturated to int16; this adapter is Drift's, not the device's. Count-error medians for the semi-regular and irregular gaits and the boundary CIs depend on the resampler (see resampler_sensitivity: linear interpolation gives materially different numbers). The Clemson wrist sensor recorded only -2 to +2 g, so strong peaks are clipped.",
    "A 'comparable' verdict means the 95% bootstrap CI of the MEAN paired shift lies within +-2 points. Individual participants can still change by more (sd_pct, n_beyond_threshold and max_abs_subject_change_pct are reported), 6 pairs x 4 gaits are examined without multiplicity correction, and the margin is a convention.",
    "Confidence intervals are bootstrap intervals over subjects (10,000 resamples, seed 42); they describe between-subject variation, not population mismatch.",
    "Per-step F1 is only meaningful against its reference rows: in Regular gait a +-250 ms window spans ~94% of the median 0.53 s step interval, so random timing and an oracle metronome are reported beside the firmware. +-500 ms is not reported.",
    "The per-step alignment value (latency_s) is a phase, not a device latency: gait is periodic, so it is identified only modulo the step period (~0.5 to 0.6 s).",
    "False-positive rates rest on 5 drive/train files from one wearer (2.4 h in total, timestamp span) and have no confidence interval.",
    "The plain-language description of each firmware change is written by Claude from the code diff.",
]


def _clean(o):
    """JSON-safe: numpy to python, non-finite to None."""
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return _clean(o.tolist())
    if isinstance(o, (np.floating, float)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    return o


def dump_json(obj, path: Path, indent: int | None = 1) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_clean(obj), indent=indent, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    return path


def sha256_file(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def box_stats(values) -> dict:
    """Tukey box statistics (whiskers at the most extreme point within 1.5 IQR of the quartiles)."""
    v = np.sort(np.asarray(values, dtype=np.float64))
    q1, med, q3 = np.percentile(v, [25, 50, 75])
    iqr = q3 - q1
    inside = v[(v >= q1 - 1.5 * iqr) & (v <= q3 + 1.5 * iqr)]
    return {"min": float(v[0]), "q1": float(q1), "median": float(med), "q3": float(q3), "max": float(v[-1]),
            "whisker_lo": float(inside[0]), "whisker_hi": float(inside[-1]),
            "outliers": [float(x) for x in v if x < inside[0] or x > inside[-1]]}


def _short(label: str) -> str:
    return label.split(" ")[0]


def diff_stats(repo: Path | None, boundaries: list[dict], algo_file: str = "libs/misc/stepcount.c") -> dict:
    """(from, to) commit prefix -> {added, removed} lines of the algorithm file, when both sides have it."""
    out = {}
    if not repo or not Path(repo).exists():
        return out
    for b in boundaries:
        if b["from"] == "inline":
            continue
        r = subprocess.run(["git", "-C", str(repo), "diff", "--numstat", b["from"], b["to"], "--", algo_file],
                           capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip():
            a, d, _ = r.stdout.split("\t", 2)
            out[(b["from"], b["to"])] = {"added": int(a), "removed": int(d)}
    return out


def build_figures(metrics: dict, boundary_docs: list[dict]) -> dict:
    gens = metrics["generations"]
    gid = [g["gen_id"] for g in gens]
    subjects = metrics["config"]["subjects"]
    ce, fp, sm = metrics["count_error"], metrics["false_positives"], metrics["step_match"]["results"]
    fig: dict = {}
    fig["timeline"] = [{"gen_id": g["gen_id"], "label": g["label"], "short": _short(g["label"]),
                        "first_tag": g["first_tag"], "last_tag": g["last_tag"], "n_tags": len(g["tags"]),
                        "first_date": g["first_date"], "last_date": g["last_date"], "description": g["description"],
                        "commit": g["commit"][:8] if g["blobs"] else None,
                        "null_control": any(n["control"] == g["gen_id"] for n in metrics["null_controls"]),
                        # the next release's code change is behaviourally identical on every recording (a null control)
                        "next_is_null_control_of_this": k + 1 < len(gens) and any(
                            n["reference"] == g["gen_id"] and n["control"] == gens[k + 1]["gen_id"]
                            for n in metrics["null_controls"])}
                       for k, g in enumerate(gens)]
    dist = {}
    for gait in (*GAITS, "all"):
        dist[gait] = []
        for g in gens:
            vals = metrics["count_error_by_subject"][gait][g["gen_id"]]
            e = ce[g["gen_id"]][gait]
            dist[gait].append({"gen_id": g["gen_id"], "label": g["label"], "values": vals, "box": box_stats(vals),
                               "median_pct": e["median_pct"], "iqr_pct": [e["q25_pct"], e["q75_pct"]],
                               "mean_pct": e["mean_pct"], "mean_ci_pct": e["mean_ci_pct"]})
    fig["error_distributions"] = {"unit": "percent error of the true step count, one value per subject",
                                  "subjects": subjects, "gait_names": GAIT_NAMES, "by_gait": dist}
    fig["false_positives_per_hour"] = {
        "unit": "steps per hour above the manual count, Bangle.js recordings",
        "generations": gid, "labels": [g["label"] for g in gens],
        "series": {k: [fp[i][k]["fp_per_hour"] for i in gid] for k in ("drive", "train", "drive_train")},
        "hours": {k: fp[gid[0]][k]["hours"] for k in ("drive", "train", "drive_train")},
        "files": {k: [f["rec_id"] for f in fp[gid[0]]["files"] if f["kind"] == k] for k in ("drive", "train")}}
    base = metrics["step_match"].get("baselines")
    fig["step_match"] = {"latency_s": metrics["step_match"]["latency_s"],
                         "latency_note": "phase-ambiguous alignment value (identified modulo the ~0.5 to 0.6 s step period), not a device latency",
                         "generations": gid, "test_subjects": metrics["config"]["test_subjects"],
                         "step_timing": metrics.get("step_timing"),
                         "by_tolerance": {tol: {gait: {m: [sm[i][gait][tol][m] for i in gid]
                                                       for m in ("precision", "recall", "f1", "f1_ci")}
                                                for gait in (*GAITS, "all")}
                                          for tol in ("tol_100ms", "tol_250ms")}}
    if base:
        fig["step_match"]["baselines"] = {
            "note": base["note"],
            "oracle_metronome": {tol: {gait: {m: base["oracle_metronome"][gait][tol][m] for m in ("precision", "recall", "f1")}
                                       for gait in (*GAITS, "all")} for tol in ("tol_100ms", "tol_250ms")},
            "random_timing": {tol: {gait: [base["random_timing"][i][gait][tol]["f1"] for i in gid]
                                    for gait in (*GAITS, "all")} for tol in ("tol_100ms", "tol_250ms")}}
    thr = metrics["config"]["threshold_pct"]
    nat_pairs = {(n["from"], n["to"]): n for n in (metrics.get("native_walk_check") or {}).get("pairs", [])}
    from drift.memo import overall_verdict
    fig["boundary_shifts"] = [
        {"from": d["from"], "to": d["to"], "gait": d["gait"], "shift_pct": d["shift_pct"], "ci_pct": d["ci_pct"],
         "ci_t_pct": d.get("ci_t_pct"), "sd_pct": d.get("sd_pct"), "n_beyond_threshold": d.get("n_beyond_threshold"),
         "max_abs_subject_change_pct": d.get("max_abs_subject_change_pct"),
         "comparable_at_2pct": d["comparable"],
         "meaning": "the 95% CI of the MEAN Clemson shift lies within +-2 points; not a statement about individuals",
         "native_walks": ({k: nat_pairs[(d["from"], d["to"])][k] for k in ("mean_pct", "median_pct", "min_pct", "max_pct")}
                          if (d["from"], d["to"]) in nat_pairs else None),
         "overall_verdict": overall_verdict(d, nat_pairs.get((d["from"], d["to"])), thr),
         "n_subjects": d["n"]}
        for d in metrics["drift"] if d["consecutive"]]
    fig["native_walk_check"] = metrics.get("native_walk_check")
    fig["resampler_sensitivity"] = metrics.get("resampler_sensitivity")
    fig["boundaries"] = boundary_docs
    walk = next((r for r in metrics["bangle_labelled"] if r["rec_id"] == "HughB-walk-a10021-b10248"), None)
    if walk:
        fig["same_walk"] = {"rec_id": walk["rec_id"], "steps_true": walk["steps_true"], "counted": walk["counted"],
                            "note": "one recorded 10,021-step walk, counted by each generation (no tail flush)"}
    return fig


def headline(metrics: dict) -> dict:
    gens = metrics["generations"]
    gid = [g["gen_id"] for g in gens]
    ce, fp, sm = metrics["count_error"], metrics["false_positives"], metrics["step_match"]["results"]
    cons = [d for d in metrics["drift"] if d["consecutive"] and d["gait"] == "regular"]
    walk = next((r for r in metrics["bangle_labelled"] if r["rec_id"] == "HughB-walk-a10021-b10248"), None)
    return {
        "generations": len(gens), "distinct_algorithms_to_compare": len(gens) - len(metrics["null_controls"]),
        "null_controls_passed": all(n["passed"] for n in metrics["null_controls"]),
        "median_error_pct_regular": {_short(g["label"]): ce[g["gen_id"]]["regular"]["median_pct"] for g in gens},
        "median_error_pct_irregular": {_short(g["label"]): ce[g["gen_id"]]["irregular"]["median_pct"] for g in gens},
        "fp_per_hour_drive_train": {_short(g["label"]): fp[g["gen_id"]]["drive_train"]["fp_per_hour"] for g in gens},
        "f1_250ms_all_gaits": {_short(g["label"]): sm[g["gen_id"]]["all"]["tol_250ms"]["f1"] for g in gens},
        "f1_100ms_all_gaits": {_short(g["label"]): sm[g["gen_id"]]["all"]["tol_100ms"]["f1"] for g in gens},
        "f1_250ms_random_timing_all_gaits": {_short(g["label"]): metrics["step_match"]["baselines"]["random_timing"][g["gen_id"]]["all"]["tol_250ms"]["f1"] for g in gens},
        "f1_250ms_oracle_metronome": {k: metrics["step_match"]["baselines"]["oracle_metronome"][k]["tol_250ms"]["f1"] for k in ("regular", "all")},
        "shift_regular_pct": {f"{_short(next(x for x in gens if x['gen_id'] == d['from'])['label'])} to "
                              f"{_short(next(x for x in gens if x['gen_id'] == d['to'])['label'])}":
                              {"shift": d["shift_pct"], "ci": d["ci_pct"]} for d in cons},
        "native_walk_shift_consecutive_pct": {
            f"{_short(next(x for x in gens if x['gen_id'] == n['from'])['label'])} to "
            f"{_short(next(x for x in gens if x['gen_id'] == n['to'])['label'])}":
            {"mean": n["mean_pct"], "median": n["median_pct"], "min": n["min_pct"], "max": n["max_pct"]}
            for n in (metrics.get("native_walk_check") or {}).get("pairs", []) if n["consecutive"]},
        "same_10021_step_walk": ({_short(g["label"]): walk["counted"][g["gen_id"]] for g in gens} if walk else None),
    }


def build_results(metrics: dict, res, target, cache: Path, replay_path: Path | None = None,
                  memo_info: dict | None = None) -> dict:
    from drift.fetch import clemson, espruino
    prov = target.provenance(cache) if hasattr(target, "provenance") else {"target": target.name}
    prov = dict(prov)
    manifest = Path(clemson.base_dir(cache)) / "MANIFEST.json"
    if manifest.exists():
        prov.setdefault("datasets", {}).setdefault("clemson", {})["sha256"] = json.loads(manifest.read_text())["sha256"]
    prov["generated"] = generated_date().isoformat()
    prov["drift_version"] = __version__
    prov["python"] = platform.python_version()
    prov["numpy"] = np.__version__
    try:
        import scipy
        prov["scipy"] = scipy.__version__
    except Exception:
        pass
    if replay_path and Path(replay_path).exists():
        prov["replay_table_sha256"] = sha256_file(replay_path)
    prov["command"] = f"python -m drift all --target {target.name}"
    prov["algorithm_files"] = list(target.algo_files)

    bdoc = target.boundaries() if hasattr(target, "boundaries") else {"authored_by": "", "boundaries": []}
    by_prefix = {("inline" if not g["blobs"] else g["commit"][:8]): g for g in metrics["generations"]}
    stats = diff_stats(espruino.repo_path(cache), bdoc["boundaries"])
    boundary_docs = []
    for b in bdoc["boundaries"]:
        a, z = by_prefix[b["from"]], by_prefix[b["to"]]
        boundary_docs.append({**b, "from_gen_id": a["gen_id"], "to_gen_id": z["gen_id"], "released": z["first_date"],
                              "diff_stat": stats.get((b["from"], b["to"])), "authored_by": bdoc["authored_by"]})

    per_rec = []
    for r in res.recordings:
        counted = {g.gen_id: res.runs[(g.gen_id, r.rec_id)].total for g in res.generations}
        t = r.truth.get("steps_total")
        per_rec.append({"rec_id": r.rec_id, "source": r.source, "subject": r.subject, "kind": r.kind,
                        "duration_s": r.duration_s, "steps_true": t,
                        "split": ("train" if int("".join(c for c in r.subject if c.isdigit())) % 2 == 0 else "test")
                        if r.source == "clemson" else None,
                        "counted": counted,
                        "error_pct": {k: (None if not t else 100.0 * (v - t) / t) for k, v in counted.items()}})

    figures = build_figures(metrics, boundary_docs)
    out = {
        "schema": SCHEMA, "target": target.name, "title": "Drift: step-counter firmware drift on Bangle.js (Espruino)",
        "generated": generated_date().isoformat(),
        "provenance": prov,
        "generations": metrics["generations"],
        "boundaries": boundary_docs,
        "recordings": per_rec,
        "metrics": {k: metrics[k] for k in ("config", "context", "step_timing", "count_error",
                                            "count_error_excluding_shift_steps", "step_match", "false_positives", "drift",
                                            "bangle_labelled", "native_walk_check", "resampler_sensitivity") if k in metrics},
        "null_controls": metrics["null_controls"],
        "headline": headline(metrics),
        "figures": figures,
        "caveats": CAVEATS,
        "memo": memo_info,
        "status": "built",
    }
    return out


def write_winner(results: dict, path: Path = WINNER_PATH, memo_rel: dict | None = None,
                 source: Path | None = WINNER_SOURCE) -> Path:
    """Write the app's winner.json with status 'built'.  The text fields (code, title, pitch, how_it_works, repo_path)
    and the pick record come from the tracked drift/winner_source.json; only when that file is missing does the
    previous winner.json on disk serve as the fallback, so the output never depends on a stale copy."""
    path = Path(path)
    old = {}
    if source and Path(source).exists():
        old = json.loads(Path(source).read_text(encoding="utf-8"))
    elif path.exists():
        try:
            old = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            old = {}
    pick = old.get("pick") or {}
    fig = results["figures"]
    demo = {
        "kind": "report",
        "name": "Drift",
        "target": results["target"],
        "results_file": "results/drift/espruino_stepcount.json",
        "memo_markdown": (memo_rel or {}).get("markdown"),
        "memo_html": (memo_rel or {}).get("html"),
        "memo_window": (memo_rel or {}).get("window"),
        "headline": results["headline"],
        "timeline": fig["timeline"],
        "error_distributions": fig["error_distributions"],
        "false_positives_per_hour": fig["false_positives_per_hour"],
        "step_match": fig["step_match"],
        "boundary_shifts": fig["boundary_shifts"],
        "boundaries": [{k: b[k] for k in ("title", "summary", "changes", "expected_effect", "from_gen_id", "to_gen_id",
                                          "released", "diff_stat", "authored_by")} for b in fig["boundaries"]],
        "same_walk": fig.get("same_walk"),
        "native_walk_check": fig.get("native_walk_check"),
        "resampler_sensitivity": fig.get("resampler_sensitivity"),
        "null_controls": results["null_controls"],
        "caveats": results["caveats"],
        "provenance": {"drift_version": results["provenance"]["drift_version"], "generated": results["generated"],
                       "datasets": results["provenance"].get("datasets"), "toolchain": results["provenance"].get("toolchain"),
                       "firmware_repo": results["provenance"].get("firmware_repo"),
                       "firmware_tag_pin": results["provenance"].get("firmware_tag_pin")},
    }
    doc = {
        "status": "built",
        "code": old.get("code") or pick.get("code") or "OV-15",
        "title": old.get("title") or pick.get("title") or "Drift: firmware forensics for science",
        "pitch": old.get("pitch") or pick.get("pitch") or "",
        "how_it_works": old.get("how_it_works") or pick.get("how_it_works") or [],
        "demo": demo,
        "repo_path": old.get("repo_path") or pick.get("repo_path") or "drift/",
    }
    if pick:
        doc["pick"] = pick
    if old.get("concept_stage"):
        doc["concept_stage"] = old["concept_stage"]
    # compact: the figure arrays are what the app reads, indentation only costs bytes
    return dump_json(doc, path, indent=None)
