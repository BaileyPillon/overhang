"""infinitime_hr: history/generations, build smoke (all 10 distinct blob sets under zig c++), synthetic-sine sanity at
native rates, the null control, within-generation identity on real PPG, agreement with the MSVC recon harness,
the WFDB/stitching/scaling adapters and the bootstrap.  Tests that need the fetch cache skip with a clear message
(`python -m drift fetch --target infinitime_hr`); the adapter and metric tests always run."""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pytest

from drift import CACHE_DIR, buildcache, REPO_ROOT
from drift.recordings import Recording
from drift.targets import get_target
from drift.targets.infinitime_hr import data, metrics
from drift.targets.infinitime_hr.target import RATE_A, RATE_B

RECON_HARNESS = REPO_ROOT / "drift" / "recon" / "harness"


def _need(path: Path, what: str):
    if not Path(path).exists():
        pytest.skip(f"{what} not in cache ({path}); run: python -m drift fetch --target infinitime_hr")


# --------------------------------------------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------------------------------------------
@pytest.fixture(scope="session")
def hr_target():
    return get_target("infinitime_hr")


@pytest.fixture(scope="session")
def hr_repo(hr_target) -> Path:
    p = hr_target.repo_path(CACHE_DIR)
    _need(p, "InfiniTime clone")
    return p


@pytest.fixture(scope="session")
def hr_gens(hr_target, hr_repo):
    gens = hr_target.generations(hr_repo)
    return {hr_target.roles[g.gen_id]: g for g in gens}


@pytest.fixture(scope="session")
def hr_dlls(hr_target, hr_repo, hr_gens):
    return {role: buildcache.build_generation(hr_target, g, hr_repo, CACHE_DIR) for role, g in hr_gens.items()}


@pytest.fixture(scope="session")
def hr_variant_dlls(hr_target, hr_repo, hr_gens):
    return {v.gen_id: buildcache.build_generation(hr_target, v, hr_repo, CACHE_DIR) for v in hr_target.variant_list}


@pytest.fixture(scope="session")
def hr_recs():
    from drift.fetch import ppg
    _need(ppg.wrist_dir(CACHE_DIR), "PhysioNet wrist PPG")
    _need(ppg.fork_dir(CACHE_DIR), "PineTime fork recordings")
    return {r.rec_id: r for r in data.load_wrist(CACHE_DIR) + data.load_fork(CACHE_DIR)}


# --------------------------------------------------------------------------------------------------------------
# history and build smoke
# --------------------------------------------------------------------------------------------------------------
def test_history_two_generations_and_ten_distinct_blob_sets(hr_target, hr_repo, hr_gens):
    vs = hr_target.variant_list
    fam = [hr_target.variant_info[v.gen_id]["family"] for v in vs]
    assert fam == ["A"] * 7 + ["B"] * 3
    assert [v.first_tag for v in vs] == ["0.11.0", "0.13.0", "1.1.0", "1.2.0", "1.8.0", "1.9.0", "1.12.0", "1.13.0", "1.15.0", "1.16.0"]
    a, b, null = hr_gens["A"], hr_gens["B"], hr_gens["A_null"]
    assert (a.first_tag, a.last_tag) == ("0.11.0", "1.12.0")
    assert (b.first_tag, b.last_tag) == ("1.13.0", "1.16.1")
    assert a.last_date == b.first_date and b.last_date is None
    assert len({a.gen_id, b.gen_id, null.gen_id}) == 3
    assert null.first_tag == "1.12.0" and set(a.tags) >= {"1.0.0", "1.12.0"}
    assert not any("rc" in t.lower() or "fosdem" in t for g in (a, b) for t in g.tags)   # release tags only


def test_gen_b_uses_the_pinned_arduinofft(hr_target, hr_repo, hr_gens):
    from drift.fetch import infinitime
    from drift import history
    for tag in ("1.13.0", "1.14.1", "1.15.0", "1.16.1"):
        assert history.blob_at(hr_repo, f"refs/tags/{tag}", "src/libs/arduinoFFT") == infinitime.FFT_COMMIT


def test_build_smoke_all_variants_and_native_rates(hr_target, hr_gens, hr_dlls, hr_variant_dlls):
    assert len(hr_variant_dlls) == 10
    for p in hr_variant_dlls.values():
        assert Path(p).exists() and Path(p).stat().st_size > 10_000
    assert hr_target.rate_of(hr_dlls["A"]) == RATE_A == 24.0
    assert hr_target.rate_of(hr_dlls["A_null"]) == RATE_A
    assert hr_target.rate_of(hr_dlls["B"]) == RATE_B == 10.0
    assert hr_dlls["A"] != hr_dlls["A_null"]            # the control is a separately built library


# --------------------------------------------------------------------------------------------------------------
# synthetic sine sanity at native rates (SYNTHETIC: tests the harness, not the firmware's accuracy)
# --------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("bpm", [60, 72, 100])
def test_synthetic_sine_at_native_rates(bpm, hr_target, hr_dlls):
    med_a, n_a = metrics.median_output(hr_target, hr_dlls["A"], metrics.synthetic_ppg(RATE_A, bpm))
    med_b, n_b = metrics.median_output(hr_target, hr_dlls["B"], metrics.synthetic_ppg(RATE_B, bpm))
    assert n_a >= 8 and n_b >= 100
    assert abs(med_a - bpm) <= 4      # autocorrelation lag is quantised: 59/71/97 for 60/72/100 bpm
    assert abs(med_b - bpm) <= 2      # FFT with 0.01-bin peak interpolation


def test_synthetic_rate_mismatch_shows_why_native_rates_are_used(hr_target, hr_dlls):
    """Gen A assumes 24 Hz.  Fed a 10 Hz stream of the same 72 bpm sine, it reports about 2.4x the true rate."""
    med, n = metrics.median_output(hr_target, hr_dlls["A"], metrics.synthetic_ppg(RATE_B, 72))
    assert n > 0 and med > 72 * 2.0


def test_null_control_equals_gen_a_on_synthetic(hr_target, hr_dlls):
    for bpm in (50, 80, 120):
        x = metrics.synthetic_ppg(RATE_A, bpm, noise=15.0, harmonic=0.35, seed=bpm)
        a, n = hr_target.run(hr_dlls["A"], x), hr_target.run(hr_dlls["A_null"], x)
        assert np.array_equal(a.hr[1], n.hr[1]) and np.array_equal(a.meta["shown"], n.meta["shown"])


# --------------------------------------------------------------------------------------------------------------
# real PPG: null control, within-generation identity, MSVC cross-check
# --------------------------------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def sample_natives(hr_target, hr_recs):
    ids = ["s1_walk", "s3_run", "s4_run", "s9_walk", "s2_low_resistance_bike", "pinetime-1727535595", "pinetime-1727541509"]
    return {i: hr_target.adapt(hr_recs[i]) for i in ids}


def test_null_control_identical_and_generations_differ_on_real_ppg(hr_target, hr_dlls, sample_natives):
    differ = 0
    for rid, nat in sample_natives.items():
        a, n, b = (hr_target.run(hr_dlls[r], nat) for r in ("A", "A_null", "B"))
        assert np.array_equal(a.hr[1], n.hr[1]), rid
        assert np.array_equal(a.meta["shown"], n.meta["shown"]), rid
        assert a.hr[1].shape[0] != b.hr[1].shape[0]                    # 24 Hz vs 10 Hz inputs
        differ += int(np.median(a.hr[1][a.hr[1] > 0]) != np.median(b.hr[1][b.hr[1] > 0])) if (b.hr[1] > 0).any() else 1
    assert differ >= 3                                                 # not a vacuous control


def test_within_generation_identity_on_real_ppg(hr_target, hr_gens, hr_variant_dlls, hr_dlls, sample_natives):
    """Every distinct blob set equals its family representative.  1.16.0+ differs from 1.13.0 only by the -2 sentinel."""
    fam = {v.gen_id: hr_target.variant_info[v.gen_id]["family"] for v in hr_target.variant_list}
    for v in hr_target.variant_list:
        role = fam[v.gen_id]
        for rid, nat in sample_natives.items():
            ref = hr_target.run(hr_dlls[role], nat)
            got = hr_target.run(hr_variant_dlls[v.gen_id], nat)
            a, b = ref.hr[1], got.hr[1]
            assert np.array_equal(np.maximum(a, 0), np.maximum(b, 0)), (v.first_tag, rid)
            assert np.array_equal(ref.meta["shown"], got.meta["shown"]), (v.first_tag, rid)
            if v.first_tag != "1.16.0":
                assert np.array_equal(a, b), (v.first_tag, rid)


@pytest.mark.skipif(not (RECON_HARNESS / "out").exists(), reason="recon MSVC harness outputs not present")
def test_zig_build_matches_msvc_recon_harness(hr_target, hr_gens, hr_variant_dlls):
    """The zig c++ builds reproduce the MSVC builds of the recon harness bit for bit (ret and displayed bpm)."""
    first = {v.first_tag: v.gen_id for v in hr_target.variant_list}
    release_to_variant = {"0.11.0": "0.11.0", "1.0.0": "0.13.0", "1.1.0": "1.1.0", "1.2.0": "1.2.0", "1.8.0": "1.8.0",
                          "1.12.0": "1.12.0", "1.13.0": "1.13.0", "1.15.0": "1.15.0", "1.16.1": "1.16.0"}
    streams = sorted((RECON_HARNESS / "data").glob("*.csv"))
    assert len(streams) == 12
    for release, variant_tag in release_to_variant.items():
        dll = hr_variant_dlls[first[variant_tag]]
        for f in streams:
            ref = np.loadtxt(RECON_HARNESS / "out" / f"{f.stem}__{release}.csv", delimiter=",", dtype=np.int64)
            out = hr_target.run(dll, np.loadtxt(f, dtype=np.int64))
            assert np.array_equal(out.hr[1], ref[:, 1]) and np.array_equal(out.meta["shown"], ref[:, 2]), (release, f.name)


def test_replay_runs_every_recording_and_generation(hr_target, hr_gens, hr_dlls, hr_recs):
    from drift import replay
    recs = [hr_recs["s9_walk"], hr_recs["pinetime-1727532341"]]
    gens = [hr_gens["A"], hr_gens["B"], hr_gens["A_null"]]
    res = replay.replay(hr_target, gens, {g.gen_id: hr_dlls[r] for r, g in hr_gens.items()}, recs)
    assert len(res.runs) == 6
    assert all(run.hr is not None and run.events is None for run in res.runs.values())
    rows = res.rows()
    assert {r["rec_id"] for r in rows} == {"s9_walk", "pinetime-1727532341"} and all("hr_outputs" in r for r in rows)


def test_recordings_loaded(hr_recs):
    wrist = [r for r in hr_recs.values() if "hr_bpm" in r.truth]
    fork = [r for r in hr_recs.values() if r.kind == "hr_nogt"]
    assert len(wrist) == 19 and len({r.subject for r in wrist}) == 8 and len(fork) == 6
    assert all(r.rate_hz == 256.0 for r in wrist) and all(r.rate_hz == 10.0 and r.meta["stitch_gaps"] == 0 for r in fork)
    for r in wrist:
        _, bpm = r.truth["hr_bpm"]
        assert np.isfinite(bpm).all() and 40 < np.nanmin(bpm) and np.nanmax(bpm) < 200


def test_results_json_if_present():
    p = REPO_ROOT / "results" / "drift" / "infinitime_hr.json"
    if not p.exists():
        pytest.skip("results/drift/infinitime_hr.json not generated (python -m drift all --target infinitime_hr)")
    j = json.loads(p.read_text())
    assert "algorithm layer only" in j["caveat"].lower()
    assert j["headline"]["null_control_A_identical"] and j["headline"]["all_variants_identical_within_generation"]
    assert [g["role"] for g in j["generations"]] == ["A", "B", "A_null"]
    assert len(j["variants_checked"]) == 10
    assert j["ground_truth_eval"]["n_recordings"] == 19 and j["ground_truth_eval"]["n_subjects"] == 8
    assert j["agreement_real_pinetime"]["scope"].startswith("agreement only")


# --------------------------------------------------------------------------------------------------------------
# adapters and metrics (no cache needed)
# --------------------------------------------------------------------------------------------------------------
def _fake_ppg_recording(seconds=90, bpm=75, fs=256.0) -> Recording:
    rng = np.random.default_rng(3)
    t = np.arange(int(seconds * fs)) / fs
    x = 800 * np.sin(2 * np.pi * bpm / 60 * t) + 4000 * np.sin(2 * np.pi * 0.05 * t) + rng.normal(0, 60, t.size) - 9000
    return Recording("fake", "test", "s0", "walk", fs, np.clip(np.rint(x), -32768, 32767), unit="adc")


def test_adapter_lengths_dtype_dc_and_ac_scale():
    rec = _fake_ppg_recording()
    a, b = data.to_hrs_counts(rec, 24.0), data.to_hrs_counts(rec, 10.0)
    assert a.dtype == b.dtype == np.int32
    assert abs(len(a) - 90 * 24) <= 1 and abs(len(b) - 90 * 10) <= 1
    for x in (a, b):
        assert 0 <= x.min() and x.max() <= data.HRS_MAX
        assert abs(np.median(x) - 3600) < 400                   # the baseline wander is kept, so only roughly 3600
    # the AC amplitude is set by the robust 0.5-4 Hz sigma
    assert data.robust_ac_sigma(b.astype(float), 10.0) == pytest.approx(25.0, rel=0.15)
    lo = data.to_hrs_counts(rec, 10.0, ac_std=10.0)
    assert data.robust_ac_sigma(lo.astype(float), 10.0) == pytest.approx(10.0, rel=0.15)


def test_adapter_keeps_the_heart_rate_frequency():
    rec = _fake_ppg_recording(seconds=120, bpm=75)
    for rate in (24.0, 10.0):
        x = data.to_hrs_counts(rec, rate).astype(float)
        x = (x - x.mean()) * np.hanning(len(x))
        f = np.fft.rfftfreq(len(x), 1 / rate) * 60
        s = np.abs(np.fft.rfft(x))
        band = (f > 50) & (f < 120)
        assert abs(f[band][np.argmax(s[band])] - 75) < 1.5


def test_real_pinetime_counts_are_passed_through_at_10hz_and_upsampled_for_gen_a():
    x = (3600 + 30 * np.sin(2 * np.pi * 1.2 * np.arange(300) / 10.0)).astype(np.int32)
    rec = Recording("p", "t", None, "hr_nogt", 10.0, x, unit="counts")
    assert np.array_equal(data.to_hrs_counts(rec, 10.0), x)
    up = data.to_hrs_counts(rec, 24.0)
    assert abs(len(up) - 720) <= 1 and abs(np.median(up) - 3600) < 3


def test_wfdb_annotation_parser_and_window_hr(tmp_path):
    words = [22 << 10, (63 << 10) | 3, 0x2323, 0x2300, 59 << 10, 0xFFFF, 0xFFFF, (0 << 10) | 1,
             (1 << 10) | 256, (1 << 10) | 256, (1 << 10) | 256, (1 << 10) | 300, 0]
    path = tmp_path / "x.atr"
    np.asarray(words, dtype="<u2").tofile(path)
    beats = data.read_beats(path)
    assert beats.tolist() == [256, 512, 768, 1068]               # SKIP of -1 then one tick, NOTE/AUX carry no time
    t_end, bpm = data.window_hr(beats / 256.0, 40.0)
    assert t_end.tolist() == [10.0, 20.0, 30.0, 40.0]
    assert bpm[0] == pytest.approx(60.0 / np.mean(np.diff(beats / 256.0)))   # 4 beats in window 0
    assert np.isnan(bpm[1:]).all()                                # no beats in the other windows
    steady = np.arange(0, 40, 0.8)                                # 75 bpm
    _, bpm = data.window_hr(steady, 40.0)
    assert np.allclose(bpm, 75.0)


def test_stitch_windows_rebuilds_the_stream():
    rng = np.random.default_rng(5)
    stream = rng.integers(3000, 4000, 400).tolist()
    rows, pos = [], 64
    while pos <= len(stream):
        rows.append(stream[pos - 64:pos])
        pos += 10 + int(rng.integers(0, 2))                       # the device advances 10 or 11 samples between reads
    out, gaps = data.stitch_windows(rows)
    assert gaps == 0 and out == stream[:len(out)] and len(out) >= len(stream) - 12


def test_window_outputs_take_last_positive_and_held_value():
    ret = np.zeros(300, dtype=np.int32)
    ret[40], ret[95] = 70, 74            # window 0 (0-100): last positive is 74
    ret[250] = -2                         # window 2: only a sentinel
    shown = np.zeros(300, dtype=np.int32)
    shown[40:] = 70
    shown[95:] = 74
    last, held = metrics.window_outputs(ret, shown, 10.0, 3, window_s=10.0)
    assert last[0] == 74 and np.isnan(last[1]) and np.isnan(last[2])
    assert held[0] == 74 and held[1] == 74


def test_bootstrap_reproducible_and_covers_the_estimate():
    d = np.random.default_rng(1).normal(-3.0, 4.0, 200)
    g = np.repeat(np.arange(8), 25)
    a = metrics.bootstrap_ratio(d, np.ones_like(d), g)
    b = metrics.bootstrap_ratio(d, np.ones_like(d), g)
    assert a == b and a["n_units"] == 8 and a["n_boot"] == 10_000
    assert a["ci95"][0] < a["estimate"] < a["ci95"][1]
    w = metrics.bootstrap_ratio(d, np.ones_like(d), None)
    assert w["ci95"][0] < w["estimate"] < w["ci95"][1]
    assert w["estimate"] == pytest.approx(d.mean())


def test_paired_difference_sign_and_validity():
    truth = np.array([80.0] * 40)
    tab = {"truth": truth, "subject": np.repeat(["s1", "s2", "s3", "s4"], 10), "kind": np.array(["walk"] * 40),
           "out_A": truth + 10.0, "out_B": truth + 2.0}
    tab["out_B"][:10] = np.nan
    d = metrics.paired_difference(tab, "A", "B")
    assert d["n_windows_both_valid"] == 30
    assert d["abs_error_diff_subject_bootstrap"]["estimate"] == pytest.approx(-8.0)
    assert d["valid_fraction_diff"]["subject_bootstrap"]["estimate"] == pytest.approx(-0.25)
