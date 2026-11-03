"""Upstream reproduction: our DLLs, fed the Bangle recordings exactly like upstream's main.c (the last sample repeated
ACCELFILTER_TAP_NUM times: 57 for the 2v10 blob, 7 for 2v11 and later), must give the numbers cross-checked against
gfwilliams/step-count main.c built on the same stepcount.c.  These constants are the FAST path; test_upstream_live.py
builds the pinned upstream main.c and compares live, so a change in data, harness or toolchain cannot go unnoticed.
(Rows 100 and 100_4 are not in upstream's FILES list; their values are Drift's own and are not live-checked.)

Column order: 2v09 inline, 2v10 (9c2c3738), 2v11 (e33e1183), 2v12-2v21 (afb4943c); the 2v22-2v28 and 2v29 columns are
equal to afb4943c (asserted in test_null_controls).  Source: drift/recon/espruino.md results table.
"""
from __future__ import annotations

import pytest

from drift.targets import get_target

COLS = ["inline", "9c2c3738", "e33e1183", "afb4943c"]
TABLE = {
    "HughB-walk-6605":            (3223, 6628, 6397, 6054),
    "HughB-walk-2350":            (1042, 2293, 2243, 2164),
    "HughB-walk-a3070-b3046":     (1909, 3129, 3013, 2858),
    "HughB-walk-a10021-b10248":   (12222, 13140, 10253, 9903),
    "HughB-walk-1834":            (1093, 1847, 1799, 1773),
    "HughB-walk-2331":            (1874, 2334, 2257, 2272),
    "HughB-drive-36min-0":        (1199, 486, 160, 45),
    "HughB-drive-29min-0":        (1153, 559, 192, 58),
    "HughB-drive-a3-b136":        (535, 371, 124, 67),
    "HughB-work-66":              (980, 294, 97, 65),
    "HughB-work-0":               (760, 139, 20, 6),
    "HughB-mixed-390":            (1871, 1186, 541, 407),
    "HughB-general-a260-b573":    (3854, 1323, 578, 400),
    "HughB-housework-a958-b2658": (5762, 5367, 2663, 1825),
    "0_HughB_train_journey_b31":  (1660, 95, 36, 15),
    "100":                        (108, 105, 18, 51),
    "100_4":                      (24, 95, 95, 89),
}
# upstream main.c output for afb4943c, in its FILES order (work-66 appears twice there)
UPSTREAM_MAIN_C = {"HughB-walk-6605": 6054, "HughB-walk-2350": 2164, "HughB-walk-a3070-b3046": 2858,
                   "HughB-walk-a10021-b10248": 9903, "HughB-drive-36min-0": 45, "HughB-drive-29min-0": 58,
                   "HughB-drive-a3-b136": 67, "HughB-work-66": 65, "HughB-mixed-390": 407,
                   "HughB-general-a260-b573": 400, "HughB-housework-a958-b2658": 1825, "MrPloppy-stationary-0": 0}


@pytest.fixture(scope="module")
def flushed():
    return get_target("espruino_stepcount", flush=True)


@pytest.mark.parametrize("rec_id", list(TABLE))
def test_all_generations_match_recon_table(rec_id, flushed, bangle_recs, gen_by_commit, dlls):
    native = flushed.adapt(bangle_recs[rec_id])
    got = tuple(flushed.run(dlls[gen_by_commit[c].gen_id], native).total for c in COLS)
    assert got == TABLE[rec_id], f"{rec_id}: {dict(zip(COLS, got))}"


def test_afb4943c_equals_upstream_main_c(flushed, bangle_recs, gen_by_commit, dlls):
    dll = dlls[gen_by_commit["afb4943c"].gen_id]
    got = {rid: flushed.run(dll, flushed.adapt(bangle_recs[rid])).total for rid in UPSTREAM_MAIN_C}
    assert got == UPSTREAM_MAIN_C
    # the four headline numbers named in the spec
    assert [got[r] for r in ("HughB-walk-6605", "HughB-walk-2350", "HughB-walk-a3070-b3046", "HughB-walk-a10021-b10248")] \
        == [6054, 2164, 2858, 9903]


def test_flush_tail_is_the_tap_count_of_each_blob(flushed, bangle_recs, gen_by_commit, dlls):
    """Upstream flushes ACCELFILTER_TAP_NUM samples: 57 for the 2v10 blob, 7 for 2v11 and later (2v09 inline: 7)."""
    rec = bangle_recs["HughB-walk-2350"]
    want = {"inline": 7, "9c2c3738": 57, "e33e1183": 7, "afb4943c": 7, "3138205d": 7, "2913ca0a": 7}
    for c, tail in want.items():
        out = flushed.run(dlls[gen_by_commit[c].gen_id], flushed.adapt(rec))
        assert out.n_samples == rec.n + tail and out.meta["flush_tail"] == tail, c


def test_device_faithful_run_does_not_flush(target, flushed, bangle_recs, gen_by_commit, dlls):
    """Default (no tail flush) differs from the upstream harness by at most a few steps at the very end."""
    dll = dlls[gen_by_commit["afb4943c"].gen_id]
    rec = bangle_recs["HughB-walk-6605"]
    plain, tail = target.run(dll, target.adapt(rec)), flushed.run(dll, flushed.adapt(rec))
    assert plain.n_samples == rec.n and tail.n_samples == rec.n + 7
    assert 0 <= tail.total - plain.total <= 6
