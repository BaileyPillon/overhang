"""Null controls: 2v22-2v28 (3138205d, cosmetic) and 2v29 (2913ca0a, clamp fix) must equal 2v12-2v21 (afb4943c) on
every recording: identical totals AND identical per-sample step events.  Drift must report zero drift for them."""
from __future__ import annotations

import numpy as np
import pytest


@pytest.fixture(scope="module")
def adapted(target, bangle_recs, clemson_recs):
    out = {}
    for rid, r in {**bangle_recs, **clemson_recs}.items():
        out[rid] = target.adapt(r)
    return out


def test_recording_count(adapted):
    assert len(adapted) == 36 + 90


@pytest.mark.parametrize("control", ["3138205d", "2913ca0a"])
def test_null_control_identical_on_every_recording(control, target, adapted, gen_by_commit, dlls):
    ref = dlls[gen_by_commit["afb4943c"].gen_id]
    ctl = dlls[gen_by_commit[control].gen_id]
    assert ref != ctl, "controls must be separately built libraries, not the same file"
    mismatches = []
    for rid, native in adapted.items():
        a, b = target.run(ref, native), target.run(ctl, native)
        if a.total != b.total or not np.array_equal(a.events, b.events):
            mismatches.append((rid, a.total, b.total))
    assert not mismatches, mismatches


def test_generation_pairs_that_should_differ_do_differ(target, adapted, gen_by_commit, dlls):
    """Guards against a vacuous null control (e.g. every library secretly the same build)."""
    rec = adapted["HughB-walk-6605"]
    totals = [target.run(dlls[gen_by_commit[c].gen_id], rec).total for c in ("inline", "9c2c3738", "e33e1183", "afb4943c")]
    assert len(set(totals)) == 4
