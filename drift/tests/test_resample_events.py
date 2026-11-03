"""Resampling round-trip sanity and per-sample step events."""
from __future__ import annotations

import numpy as np
import pytest

from drift import recordings as R


def _sine(f, rate, n, amp=0.5, offset=1.0):
    t = np.arange(n) / rate
    return offset + amp * np.sin(2 * np.pi * f * t)


@pytest.mark.parametrize("method,tol", [("poly", 2e-3), ("linear", 0.05)])
def test_resample_matches_analytic_signal(method, tol):
    x = _sine(2.0, 15.0, 1500)[:, None]
    y = R.resample(x, 15.0, 12.5, method)[:, 0]
    assert abs(len(y) - 1250) <= 1
    want = _sine(2.0, 12.5, len(y))
    # compare away from the edges; output sample j sits at j / 12.5 s (no time shift)
    assert np.max(np.abs(y[30:-30] - want[30:-30])) < tol


def test_resample_round_trip_12p5_15_12p5():
    x = _sine(1.8, 12.5, 1250)[:, None] + _sine(3.7, 12.5, 1250, amp=0.2, offset=0)[:, None]
    back = R.resample(R.resample(x, 12.5, 15.0), 15.0, 12.5)
    assert back.shape == x.shape
    assert np.max(np.abs(back[40:-40] - x[40:-40])) < 5e-3


def test_resample_identity_rate_and_multi_axis():
    x = np.random.default_rng(0).normal(size=(100, 3))
    assert np.array_equal(R.resample(x, 12.5, 12.5), x)
    assert R.resample(x, 15.0, 12.5).shape == (84, 3)       # ceil(100 * 5 / 6)


def test_counts_scale_round_trip():
    g = np.array([[-1.0, 0.0, 1.0], [0.5, -0.25, 3.999]])
    counts = R.g_to_counts(g)
    assert counts.dtype == np.int16
    assert np.allclose(counts / 8192.0, g, atol=1 / 8192)


# ---- per-sample events -----------------------------------------------------------------------------------------
@pytest.mark.parametrize("rec_id", ["HughB-walk-2350", "HughB-drive-a3-b136", "100_4", "P001_Regular", "P019_Irregular"])
def test_events_sum_to_total_for_every_generation(rec_id, target, generations, dlls, bangle_recs, clemson_recs):
    rec = {**bangle_recs, **clemson_recs}[rec_id]
    native = target.adapt(rec)
    for g in generations:
        out = target.run(dlls[g.gen_id], native)
        assert out.events.dtype == np.int32 and len(out.events) == len(native) == out.n_samples
        assert (out.events >= 0).all()
        assert int(out.events.sum()) == out.total, g.label
        assert out.total > 0 or rec_id == "HughB-drive-a3-b136"
        if not g.blobs:
            assert set(np.unique(out.events)) <= {0, 1}          # inline counter fires one step at a time


def test_state_machine_generations_fire_in_bursts(target, gen_by_commit, dlls, bangle_recs):
    """2v11+ confirm a run of steps retroactively, so a single sample can carry several steps; per-step matching
    in metrics.py must spread such bursts back over the preceding samples."""
    native = target.adapt(bangle_recs["HughB-walk-2350"])
    out = target.run(dlls[gen_by_commit["e33e1183"].gen_id], native)
    assert out.events.max() > 1


def test_peaks_cover_every_credited_step(target, generations, dlls, bangle_recs):
    """Each step event must be placeable on a step-candidate peak at or before its sample (metrics.step_times)."""
    native = target.adapt(bangle_recs["HughB-walk-2350"])
    for g in generations:
        out = target.run(dlls[g.gen_id], native)
        assert out.peaks is not None and len(out.peaks) == len(native)
        pk = np.flatnonzero(out.peaks)
        for i in np.flatnonzero(out.events):
            assert np.searchsorted(pk, i, side="right") >= out.events[i], (g.label, i)
        assert (out.peaks[out.events > 0] == 1).all()
