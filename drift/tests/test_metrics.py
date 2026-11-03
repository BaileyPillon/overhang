"""Metrics: toy event matching, burst placement, latency estimation, bootstrap determinism, paired shifts,
and the end-to-end numbers on the real replay (needs the fetch cache)."""
from __future__ import annotations

import json
from datetime import date

import numpy as np
import pytest

from drift import metrics as M


# ---- per-step matching (toy) -------------------------------------------------------------------------------------
def test_match_steps_toy_case():
    true = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
    det = np.array([1.1, 2.4, 2.6, 9.0])          # 1.1 hits 1.0; 2.4 hits 2.0 (0.4 <= 0.5 only); 2.6 hits 3.0; 9.0 is a FP
    assert M.match_steps(det, true, 0.25) == (1, 4, 5)            # only 1.1 is within 250 ms of a true step
    assert M.match_steps(det, true, 0.5) == (3, 4, 5)             # 1.1, 2.4, 2.6
    tp, nd, nt = M.match_steps(det, true, 0.5)
    p, r, f = (float(x) for x in M.prf(tp, nd, nt))
    assert (p, r) == (0.75, 0.6) and f == pytest.approx(2 * 0.75 * 0.6 / (0.75 + 0.6))


def test_match_is_one_to_one():
    # two detections near one true step: only one may match
    assert M.match_steps(np.array([1.0, 1.1]), np.array([1.05]), 0.25) == (1, 2, 1)
    # one detection between two true steps matches only one of them
    assert M.match_steps(np.array([1.5]), np.array([1.4, 1.6]), 0.25) == (1, 1, 2)
    assert M.match_steps(np.array([]), np.array([1.0]), 0.25) == (0, 0, 1)


def test_prf_handles_empty_denominators():
    p, r, f = M.prf(0, 0, 0)
    assert np.isnan(p) and np.isnan(r) and f == 0.0


# ---- burst placement ----------------------------------------------------------------------------------------------
def test_step_times_places_a_burst_on_the_last_k_peaks():
    ev = np.zeros(40, dtype=np.int32)
    pk = np.zeros(40, dtype=np.int8)
    pk[[5, 12, 20, 27, 35, 39]] = 1
    ev[39] = 6                                     # six steps confirmed at once at the sixth peak
    t = M.step_times(ev, pk, 10.0)
    assert np.allclose(t, np.array([5, 12, 20, 27, 35, 39]) / 10.0)
    ev2 = np.zeros(40, dtype=np.int32)
    ev2[39] = 1
    assert np.allclose(M.step_times(ev2, pk, 10.0), [3.9])        # a single step sits on its own peak
    assert M.step_times(np.zeros(5, dtype=np.int32), None, 10.0).size == 0


def test_step_times_falls_back_to_the_sample_when_peaks_are_missing():
    ev = np.zeros(10, dtype=np.int32)
    ev[8] = 3
    assert np.allclose(M.step_times(ev, None, 10.0), [0.8, 0.8, 0.8])


# ---- latency --------------------------------------------------------------------------------------------------------
def test_estimate_latency_recovers_a_known_delay():
    rng = np.random.default_rng(1)
    pairs = []
    for _ in range(6):
        true = np.cumsum(rng.uniform(0.45, 0.9, 120))               # irregular gait, so the correlation has one peak
        det = true + 1.37 + rng.normal(0, 0.03, true.size)
        keep = rng.random(true.size) > 0.1                         # 10% missed steps
        pairs.append((det[keep], true))
    assert M.estimate_latency(pairs) == pytest.approx(1.37, abs=0.03)


def test_estimate_latency_with_no_events_is_zero():
    assert M.estimate_latency([(np.zeros(0), np.array([1.0, 2.0]))]) == 0.0


# ---- bootstrap ---------------------------------------------------------------------------------------------------------
def test_bootstrap_is_deterministic_and_seeded():
    v = np.array([1.0, 2.5, -0.5, 4.0, 3.2, 0.1, 2.2, 5.5, 1.8, 0.9])
    a = M.bootstrap_ci(v, "mean")
    b = M.bootstrap_ci(v, "mean")
    assert a == b                                                   # identical, not merely close
    assert a[1] < a[0] < a[2]
    assert M.bootstrap_ci(v, "mean", seed=43) != a
    assert M.bootstrap_ci(v, "median") == M.bootstrap_ci(v, "median")
    # the documented defaults
    assert M.N_BOOT == 10_000 and M.SEED == 42
    idx = M.boot_indices(len(v))
    assert idx.shape == (10_000, len(v)) and np.array_equal(idx, M.boot_indices(len(v)))
    # reference value computed straight from numpy with the documented recipe
    ref = np.random.default_rng(42).integers(0, len(v), size=(10_000, len(v)))
    lo, hi = np.percentile(v[ref].mean(axis=1), [2.5, 97.5])
    assert (a[1], a[2]) == (float(lo), float(hi))


def test_bootstrap_degenerate_inputs():
    assert M.bootstrap_ci(np.zeros(12)) == (0.0, 0.0, 0.0)
    est, lo, hi = M.bootstrap_ci(np.array([]))
    assert np.isnan(est) and np.isnan(lo) and np.isnan(hi)


def test_paired_shift_null_pair_is_exactly_zero():
    e = np.random.default_rng(3).normal(0, 5, 30)
    s = M.paired_shift(e, e.copy())
    assert s["shift_pct"] == 0.0 and s["ci_pct"] == [0.0, 0.0] and s["frac_subjects_changed"] == 0.0
    assert M.verdict(tuple(s["ci_pct"]))


def test_paired_shift_detects_a_constant_offset_and_verdict_threshold():
    a = np.random.default_rng(4).normal(0, 5, 30)
    s = M.paired_shift(a, a + 3.0)
    assert s["shift_pct"] == pytest.approx(3.0) and s["ci_pct"][0] == pytest.approx(3.0)
    assert not M.verdict(tuple(s["ci_pct"]))                        # +3 is outside +-2
    assert M.verdict(tuple(s["ci_pct"]), threshold=3.5)             # configurable threshold
    assert M.verdict((-1.9, 1.9)) and not M.verdict((-2.1, 0.5)) and not M.verdict((-0.5, 2.5))
    with pytest.raises(ValueError):
        M.paired_shift(np.zeros(3), np.zeros(4))


def test_pooled_prf_ci_is_deterministic_and_bounded():
    counts = np.array([[80, 100, 90], [45, 60, 50], [90, 95, 100], [30, 40, 35], [70, 80, 75]])
    a, b = M.pooled_prf_ci(counts), M.pooled_prf_ci(counts)
    assert a == b
    assert a["precision"] == pytest.approx(315 / 375) and a["recall"] == pytest.approx(315 / 350)
    for k in ("precision", "recall", "f1"):
        lo, hi = a[f"{k}_ci"]
        assert 0 <= lo <= a[k] + 1e-9 and a[k] - 1e-9 <= hi <= 1


def test_split_by_subject_parity():
    assert [M.split_of(s) for s in ("P001", "P002", "P029", "P030")] == ["test", "train", "test", "train"]
    with pytest.raises(ValueError):
        M.subject_number("nobody")


def test_count_error_and_summary():
    e = M.count_error_pct([110, 90, 100], [100, 100, 100])
    assert np.allclose(e, [10, -10, 0])
    s = M.summarize_errors(e)
    assert s["median_pct"] == 0 and s["n"] == 3 and s["mean_abs_pct"] == pytest.approx(20 / 3)


# ---- memo logic (pure) -------------------------------------------------------------------------------------------------
GENS = [
    {"gen_id": "a", "label": "2v09 (inline)", "first_tag": "RELEASE_2V09", "last_tag": "RELEASE_2V09", "tags": ["RELEASE_2V09"],
     "first_date": "2021-04-19", "last_date": "2021-08-13", "commit": "11111111", "blobs": {}, "description": "inline"},
    {"gen_id": "b", "label": "2v10 (fir)", "first_tag": "RELEASE_2V10", "last_tag": "RELEASE_2V10", "tags": ["RELEASE_2V10"],
     "first_date": "2021-08-13", "last_date": "2022-02-01", "commit": "22222222", "blobs": {"x": "1"}, "description": "fir"},
    {"gen_id": "c", "label": "2v12 (dc)", "first_tag": "RELEASE_2V12", "last_tag": "RELEASE_2V12", "tags": ["RELEASE_2V12"],
     "first_date": "2022-02-01", "last_date": None, "commit": "33333333", "blobs": {"x": "2"}, "description": "dc"},
]


def test_live_generations_window_overlap():
    from drift.memo import live_generations
    live = live_generations(GENS, date(2021, 5, 1), date(2022, 6, 30))
    assert [g["gen_id"] for g in live] == ["a", "b", "c"]
    assert live[0]["days_in_window"] == (date(2021, 8, 12) - date(2021, 5, 1)).days + 1      # until the day before 2v10
    assert live[2]["live_to"] == "2022-06-30"
    # a window that starts on the release day of the next generation excludes the previous one
    assert [g["gen_id"] for g in live_generations(GENS, date(2021, 8, 13), date(2021, 9, 1))] == ["b"]
    assert [g["gen_id"] for g in live_generations(GENS, date(2030, 1, 1), date(2030, 2, 1))] == ["c"]
    assert live_generations(GENS, date(2020, 1, 1), date(2020, 2, 1)) == []


def test_gait_from_population():
    from drift.memo import gait_from_population as g
    assert g("older adults, regular gait") == "regular"
    assert g("people with irregular gait") == "irregular"
    assert g("semi-regular walkers") == "semiregular"
    assert g("anyone") == "all"


# ---- end to end on the real replay -------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def replayed(target, generations, dlls, bangle_recs, clemson_recs):
    from drift import replay as R
    recs = list(bangle_recs.values()) + list(clemson_recs.values())
    return R.replay(target, generations, dlls, recs)


@pytest.fixture(scope="module")
def real_metrics(target, replayed):
    gens = {("inline" if not g.blobs else g.commit[:8]): g.gen_id for g in replayed.generations}
    nulls = {gens[c]: gens[r] for c, r in target.null_controls.items()}
    return M.compute_metrics(replayed, nulls, descriptions={g.gen_id: target.describe(g) for g in replayed.generations})


def test_real_null_controls_have_zero_drift(real_metrics, gen_by_commit):
    ref = gen_by_commit["afb4943c"].gen_id
    assert all(n["passed"] for n in real_metrics["null_controls"]) and len(real_metrics["null_controls"]) == 2
    for ctl in ("3138205d", "2913ca0a"):
        g = gen_by_commit[ctl].gen_id
        for d in real_metrics["drift"]:
            if d["from"] == ref and d["to"] == g:
                assert d["shift_pct"] == 0.0 and d["ci_pct"] == [0.0, 0.0] and d["comparable"]
        for gait in (*M.GAITS, "all"):
            assert real_metrics["count_error"][g][gait] == real_metrics["count_error"][ref][gait]
            for tol in ("tol_100ms", "tol_250ms"):
                assert real_metrics["step_match"]["results"][g][gait][tol] == real_metrics["step_match"]["results"][ref][gait][tol]
        assert real_metrics["false_positives"][g] == real_metrics["false_positives"][ref]


def test_real_metrics_shape_and_sanity(real_metrics):
    cfg = real_metrics["config"]
    assert cfg["n_boot"] == 10_000 and cfg["seed"] == 42
    assert len(cfg["train_subjects"]) == len(cfg["test_subjects"]) == 15
    assert set(cfg["train_subjects"]).isdisjoint(cfg["test_subjects"])
    assert all(M.subject_number(s) % 2 == 0 for s in cfg["train_subjects"])
    assert len(real_metrics["generations"]) == 6
    n_pairs = 6 * 5 // 2
    assert len(real_metrics["drift"]) == n_pairs * 4
    assert sum(d["consecutive"] for d in real_metrics["drift"]) == 5 * 4
    for g in real_metrics["generations"]:
        ce = real_metrics["count_error"][g["gen_id"]]
        assert set(ce) == {"regular", "semiregular", "irregular", "all"} and ce["regular"]["n"] == 30
        lo, hi = ce["regular"]["mean_ci_pct"]
        assert lo <= ce["regular"]["mean_pct"] <= hi
        for tol in ("tol_100ms", "tol_250ms"):
            m = real_metrics["step_match"]["results"][g["gen_id"]]["all"][tol]
            assert 0 <= m["precision"] <= 1 and 0 <= m["recall"] <= 1 and m["n_subjects"] == 15
            wide = real_metrics["step_match"]["results"][g["gen_id"]]["all"]["tol_250ms"]["f1"]
            assert wide >= real_metrics["step_match"]["results"][g["gen_id"]]["all"]["tol_100ms"]["f1"] - 1e-9
        assert real_metrics["step_match"]["latency_s"][g["gen_id"]] >= 0
    # the newest generation is far quieter than 2v09 while driving or on a train
    fp = {g["gen_id"]: real_metrics["false_positives"][g["gen_id"]]["drive_train"]["fp_per_hour"] for g in real_metrics["generations"]}
    ids = [g["gen_id"] for g in real_metrics["generations"]]
    assert fp[ids[0]] > 10 * fp[ids[3]] > 0


def test_real_metrics_are_reproducible(real_metrics, replayed, target):
    gens = {("inline" if not g.blobs else g.commit[:8]): g.gen_id for g in replayed.generations}
    nulls = {gens[c]: gens[r] for c, r in target.null_controls.items()}
    again = M.compute_metrics(replayed, nulls, descriptions={g.gen_id: target.describe(g) for g in replayed.generations})
    assert json.dumps(again, sort_keys=True) == json.dumps(real_metrics, sort_keys=True)


def test_memo_example_window(real_metrics):
    from drift import memo as memo_mod
    m = memo_mod.build_memo(real_metrics, *memo_mod.EXAMPLE_WINDOW, memo_date=date(2026, 11, 3))
    assert [real_metrics["generations"][i]["first_tag"] for i in range(4)] == \
        ["RELEASE_2V09", "RELEASE_2V10", "RELEASE_2V11", "RELEASE_2V12"]
    assert len(m.facts["generations_live"]) == 4 and m.facts["n_boundaries"] == 3 and m.facts["gait"] == "regular"
    assert "Prepared 2026-11-03" in m.markdown and "not comparable" in m.markdown and "comparable" in m.markdown
    for key in ("Ravanelli", "Woolley", "Collins", "Koffman", "gfwilliams/step-count"):
        assert key in m.markdown
    # self-contained HTML: no scripts, stylesheets or images fetched from anywhere
    for bad in ("<script", "<link", "<img", "src=", "@import", "url("):
        assert bad not in m.html
    assert m.html.startswith("<!doctype html>") and "<table>" in m.html
    # the window decides which generations appear
    late = memo_mod.build_memo(real_metrics, date(2024, 6, 1), date(2024, 12, 31), memo_date=date(2026, 11, 3))
    assert len(late.facts["generations_live"]) == 1 and "One firmware generation" in late.markdown
    with pytest.raises(ValueError):
        memo_mod.build_memo(real_metrics, date(2022, 1, 2), date(2022, 1, 1))


def test_export_builds_results_and_winner(real_metrics, replayed, target, tmp_path):
    from drift import CACHE_DIR, export
    res = export.build_results(real_metrics, replayed, target, CACHE_DIR, None, None)
    assert res["schema"] == export.SCHEMA and res["status"] == "built" and len(res["recordings"]) == 126
    assert res["headline"]["null_controls_passed"] is True
    fig = res["figures"]
    assert len(fig["timeline"]) == 6 and len(fig["boundaries"]) == 5
    assert len(fig["error_distributions"]["by_gait"]["regular"][0]["values"]) == 30
    assert all(b["authored_by"].startswith("Claude") for b in fig["boundaries"])
    wp = tmp_path / "winner.json"
    wp.write_text(json.dumps({"status": "pending", "pick": {"code": "OV-15", "title": "t", "pitch": "p",
                                                             "how_it_works": ["a"], "repo_path": "drift/"}}))
    export.write_winner(res, wp)
    w = json.loads(wp.read_text(encoding="utf-8"))
    for k in ("code", "title", "pitch", "how_it_works", "demo", "repo_path"):
        assert k in w
    assert w["status"] == "built" and w["code"] == "OV-15" and isinstance(w["how_it_works"], list)
    json.dumps(w, allow_nan=False)


# ---- verifier findings: individual-level spread, reference rows, native cross-check, wording ---------------------------------
def test_paired_shift_reports_individual_level_spread():
    a = np.zeros(10)
    b = np.array([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 5.0, -5.0])     # mean shift 0, two subjects move by 5
    s = M.paired_shift(a, b, n_boot=500, threshold=2.0)
    assert s["shift_pct"] == pytest.approx(0.0)
    assert s["n_beyond_threshold"] == 2 and s["frac_beyond_threshold"] == pytest.approx(0.2)
    assert s["max_abs_subject_change_pct"] == pytest.approx(5.0) and s["sd_pct"] > 0
    assert s["ci_t_pct"][0] < 0 < s["ci_t_pct"][1]


def test_metronome_baseline_is_strong_on_regular_gait_and_weak_on_irregular():
    reg = np.arange(60) * 0.53 + 1.0
    det = M.metronome_times(reg, 0.25)
    tp, nd, nt = M.match_steps(det, reg, 0.25)
    assert tp == nt == 60 and nd == 60
    rng = np.random.default_rng(3)
    irr = np.cumsum(rng.choice([0.5, 0.6, 3.0, 5.0], size=60))
    tp, nd, nt = M.match_steps(M.metronome_times(irr, 0.25), irr, 0.25)
    assert tp / nt < 0.5
    # random timing with the right number of detections is far from perfect at +-100 ms
    r = M.random_times(60, float(reg[-1] + 1), np.random.default_rng(0))
    assert M.match_steps(r, reg, 0.1)[0] < 30


def test_overall_verdict_is_conditioned_on_the_native_walks():
    from drift.memo import overall_verdict
    clem_ok = {"comparable": True}
    clem_bad = {"comparable": False}
    small = {"mean_pct": 0.5, "median_pct": 0.4}
    big = {"mean_pct": -3.0, "median_pct": -3.4}
    assert overall_verdict(clem_ok, small, 2.0) == "comparable"
    assert overall_verdict(clem_ok, big, 2.0).startswith("not confirmed")
    assert overall_verdict(clem_bad, small, 2.0) == "not comparable"
    assert overall_verdict(clem_ok, None, 2.0).startswith("comparable on Clemson only")


def test_real_metrics_have_reference_rows_native_check_and_no_500ms(real_metrics):
    sm = real_metrics["step_match"]
    assert set(sm["results"][next(iter(sm["results"]))]["all"]) >= {"tol_100ms", "tol_250ms"}
    assert not any("500" in k for g in sm["results"].values() for k in g["all"])
    base = sm["baselines"]
    gid = [g["gen_id"] for g in real_metrics["generations"]]
    # the oracle metronome is strong on Regular gait at 250 ms (the reason the window is not discriminating) ...
    assert base["oracle_metronome"]["regular"]["tol_250ms"]["f1"] > 0.85
    # ... and weak on Irregular gait; random timing at +-100 ms is far below any firmware
    assert base["oracle_metronome"]["irregular"]["tol_250ms"]["f1"] < 0.5
    assert all(base["random_timing"][g]["all"]["tol_100ms"]["f1"] < sm["results"][g]["all"]["tol_100ms"]["f1"] for g in gid[1:])
    nat = real_metrics["native_walk_check"]
    assert nat["n_files"] == 6 and nat["wearers"] == ["HughB"]
    assert len(nat["pairs"]) == 15 and sum(p["consecutive"] for p in nat["pairs"]) == 5
    # the native walks contradict Clemson at the 2v11 -> 2v12 boundary (the one Clemson calls comparable)
    a, b = gid[2], gid[3]
    p = next(x for x in nat["pairs"] if x["from"] == a and x["to"] == b)
    d = next(x for x in real_metrics["drift"] if x["from"] == a and x["to"] == b and x["gait"] == "regular")
    assert d["comparable"] and abs(p["mean_pct"]) > 2.0
    assert real_metrics["step_match"]["latency_note"].startswith("phase-ambiguous")
    assert real_metrics["count_error_excluding_shift_steps"]["fraction_shift_steps"] == pytest.approx(0.068, abs=0.005)
    # hours come from the timestamp span (a bit longer than n / 12.5)
    assert real_metrics["false_positives"][gid[0]]["drive_train"]["hours"] > 2.38


def test_memo_wording_is_gait_specific_and_conditioned(real_metrics):
    from datetime import date as _d
    from drift import memo as memo_mod
    m = memo_mod.build_memo(real_metrics, *memo_mod.EXAMPLE_WINDOW, memo_date=_d(2026, 11, 3))
    md = m.markdown
    assert "depends on which one their watch ran" not in md
    assert "released during this window" not in md and "were live during this window" in md
    assert "unvalidated" in md and "not confirmed" in md
    assert "SD of per-subject changes" in md and "Oracle metronome" in md and "random times" in md
    assert "even more" not in md and "daily totals of sedentary" not in md
    assert "Sensors 2021;21(13):4260" in md and "web.archive.org" in md
    assert m.facts["n_comparable"] == 0 and m.facts["n_not_confirmed"] == 1


def test_winner_json_regenerates_from_scratch(real_metrics, replayed, target, tmp_path):
    """No previous winner.json is needed: pitch, how_it_works and the pick record come from drift/winner_source.json."""
    from drift import CACHE_DIR, export
    res = export.build_results(real_metrics, replayed, target, CACHE_DIR, None, None)
    src = json.loads(export.WINNER_SOURCE.read_text(encoding="utf-8"))
    out = tmp_path / "fresh" / "winner.json"
    export.write_winner(res, out)
    w = json.loads(out.read_text(encoding="utf-8"))
    assert w["pitch"] == src["pitch"] and w["how_it_works"] == src["how_it_works"] and w["pick"] == src["pick"]
    assert w["concept_stage"] == src["concept_stage"] and "legal grey" not in json.dumps(w["how_it_works"])
    again = tmp_path / "again.json"
    export.write_winner(res, again)
    assert again.read_text(encoding="utf-8") == out.read_text(encoding="utf-8")
