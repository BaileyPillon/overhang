"""Clemson adapter: 15 Hz in g -> 12.5 Hz int16 counts, true step counts from steps.txt, clipping of out-of-range
indices.  Synthetic-fixture tests always run; the real-data tests need the fetch cache."""
from __future__ import annotations

import numpy as np
import pytest

from drift import recordings as R
from drift.targets import get_target


def _make_rec_dir(root, pid, gait, n_rows, step_lines, wrist=None):
    d = root / pid / gait
    d.mkdir(parents=True)
    a = np.zeros((n_rows, 9))
    a[:, :3] = wrist if wrist is not None else [0.0, 1.0, 0.0]
    np.savetxt(d / f"{pid}_{gait}.txt", a, fmt="%.6f")
    (d / "steps.txt").write_text("\r\n".join(step_lines) + "\r\n")
    return d


def test_synthetic_truth_and_clipping(tmp_path):
    d = _make_rec_dir(tmp_path, "P099", "Irregular", 300,
                      ["30 left", "75 right", "120 leftshift", "299 right", "300 left", "450 rightshift"])
    rec = R.load_clemson_recording(d)
    assert (rec.rec_id, rec.subject, rec.kind, rec.rate_hz, rec.unit) == ("P099_Irregular", "P099", "irregular", 15.0, "g")
    assert rec.data.shape == (300, 3)
    # rows 300 and 450 are past the end of the data (valid rows are 0..299): clipped away, not stacked at the end
    assert rec.truth["steps_total"] == 4 and rec.truth["steps_annotated"] == 6 and rec.truth["n_clipped"] == 2
    st = rec.truth["step_times_s"]
    assert np.allclose(st, np.array([30, 75, 120, 299]) / 15.0)
    assert st.max() <= (rec.n - 1) / 15.0
    assert list(rec.meta["step_side"]) == ["left", "right", "leftshift", "right"]


def test_synthetic_adapter_scaling_and_length(tmp_path):
    t = np.arange(450) / 15.0
    wrist = np.stack([0.5 * np.sin(2 * np.pi * 2.0 * t), np.ones_like(t), np.zeros_like(t)], axis=1)
    rec = R.load_clemson_recording(_make_rec_dir(tmp_path, "P098", "Regular", 450, ["10 left"], wrist))
    native = get_target("espruino_stepcount").adapt(rec)
    assert native.dtype == np.int16 and native.shape == (375, 3)          # ceil(450 * 12.5 / 15)
    assert abs(float(np.median(native[:, 1])) - 8192) <= 2               # 1 g -> 8192 counts
    inner = native[20:-20, 0].astype(float)
    assert 4096 - 40 <= inner.max() <= 4096 + 40 and -4096 - 40 <= inner.min() <= -4096 + 40   # 0.5 g -> 4096 counts


def test_adapter_saturates_to_int16():
    rec = R.Recording("x", "t", None, "regular", 15.0, np.full((60, 3), 6.0), {}, unit="g")   # 6 g = 49152 counts
    native = R.to_bangle_native(rec)
    assert native.dtype == np.int16 and native.max() == 32767 and native.min() == 32767


def test_bangle_counts_pass_through_untouched():
    data = np.arange(30, dtype=np.int16).reshape(10, 3)
    rec = R.Recording("b", "t", None, "walk", 12.5, data, {}, unit="counts")
    out = R.to_bangle_native(rec)
    assert out.dtype == np.int16 and np.array_equal(out, data) and out is not data


# ---- real data ---------------------------------------------------------------------------------------------------
def test_real_dataset_shape(clemson_recs):
    assert len(clemson_recs) == 90
    assert {r.subject for r in clemson_recs.values()} == {f"P{i:03d}" for i in range(1, 31)}
    assert {r.kind for r in clemson_recs.values()} == {"regular", "semiregular", "irregular"}
    assert all(r.rate_hz == 15.0 and r.unit == "g" and r.data.shape[1] == 3 for r in clemson_recs.values())


def test_real_true_step_counts_from_steps_txt(clemson_recs):
    # 60,801 annotated steps in total (the project page says 60,805); exactly two recordings have 1 index past the end
    annotated = sum(r.truth["steps_annotated"] for r in clemson_recs.values())
    assert annotated == 60801
    clipped = {rid: r.truth["n_clipped"] for rid, r in clemson_recs.items() if r.truth["n_clipped"]}
    assert clipped == {"P010_Regular": 1, "P019_Irregular": 1}
    assert sum(r.truth["steps_total"] for r in clemson_recs.values()) == 60799
    p1 = clemson_recs["P001_Regular"]
    assert p1.truth["steps_total"] == 937 and p1.truth["steps_annotated"] == 937      # wc -l of steps.txt
    for r in clemson_recs.values():
        st = r.truth["step_times_s"]
        assert len(st) == r.truth["steps_total"] and np.all(np.diff(st) >= 0) and st.max() <= (r.n - 1) / 15.0


def test_real_adapter_15hz_to_12p5hz_counts(target, clemson_recs):
    r = clemson_recs["P001_Regular"]
    native = target.adapt(r)
    assert native.dtype == np.int16 and native.shape == (int(np.ceil(r.n * 12.5 / 15.0)), 3)
    # durations agree to one sample and the mean |a| survives resampling+scaling to <0.5 %
    assert abs(len(native) / 12.5 - r.n / 15.0) <= 1 / 12.5
    mag_in = np.linalg.norm(r.data, axis=1).mean() * 8192
    mag_out = np.linalg.norm(native.astype(float), axis=1).mean()
    assert abs(mag_out / mag_in - 1) < 0.005


def test_real_wrist_is_in_g(clemson_recs):
    for rid in ("P001_Regular", "P010_Regular", "P019_Irregular"):
        m = np.linalg.norm(clemson_recs[rid].data, axis=1)
        assert 0.8 < np.median(m) < 1.4
