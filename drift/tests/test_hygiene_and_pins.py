"""Repository hygiene, pinned inputs, reproducible dates, hidden firmware state and resampler behaviour above 4 Hz."""
from __future__ import annotations

import os
import subprocess
from datetime import date

import numpy as np
import pytest

from drift import PKG_DIR, REPO_ROOT, generated_date, history
from drift import recordings as R

MAX_TRACKED_BYTES = 1_000_000
FORBIDDEN_SUFFIXES = {".zip", ".dll", ".so", ".exe", ".obj", ".pdb", ".lib", ".pack"}
FORBIDDEN_NAMES = {"stepcount.c", "stepcount.h", "Ppg.cpp", "Ppg.h", "Biquad.cpp", "Ptagc.cpp", "main.c"}


def _candidate_files() -> list[str]:
    """Every file under drift/ that `git add drift` would add: tracked, plus untracked and not ignored."""
    try:
        r = subprocess.run(["git", "-C", str(REPO_ROOT), "ls-files", "--cached", "--others", "--exclude-standard", "--", "drift"],
                           capture_output=True, text=True)
    except FileNotFoundError:
        pytest.skip("git not available")
    if r.returncode:
        pytest.skip("not a git work tree")
    return [ln for ln in r.stdout.splitlines() if ln]


def test_nothing_third_party_would_be_committed():
    files = _candidate_files()
    assert files
    bad = []
    for f in files:
        p = REPO_ROOT / f
        parts = f.split("/")
        if "dl" in parts or f.startswith("drift/recon/espruino-harness/src/") or "xcheck" in parts:
            bad.append((f, "third-party path"))
        elif os.path.basename(f) in FORBIDDEN_NAMES or p.suffix.lower() in FORBIDDEN_SUFFIXES:
            bad.append((f, "third-party source or binary"))
        elif os.path.basename(f).startswith("real_") and p.suffix == ".csv":
            bad.append((f, "third-party recording"))
        elif p.exists() and p.stat().st_size > MAX_TRACKED_BYTES:
            bad.append((f, f"{p.stat().st_size} bytes"))
    assert not bad, bad


def test_recon_downloads_are_ignored():
    r = subprocess.run(["git", "-C", str(REPO_ROOT), "check-ignore", "-q", "drift/recon/dl/datasets/clemson/Data.zip"])
    assert r.returncode == 0


# ---- pinned firmware tags ----------------------------------------------------------------------------------------
def test_espruino_tag_pin_matches_and_a_wrong_pin_fails(target, espruino_repo):
    info = history.check_tag_pin(espruino_repo, target.tag_glob, target.tag_min, target.tag_max, target.tag_pin)
    assert info["matches_pin"] and info["n_tags"] == 21
    with pytest.raises(RuntimeError, match="pinned"):
        history.check_tag_pin(espruino_repo, target.tag_glob, target.tag_min, target.tag_max, "0" * 16, strict=True)
    # non-strict only warns (this is what DRIFT_ALLOW_UNPINNED=1 selects)
    assert not history.check_tag_pin(espruino_repo, target.tag_glob, target.tag_min, target.tag_max, "0" * 16, strict=False)["matches_pin"]


def test_generations_stop_at_the_pinned_last_tag(generations):
    assert generations[-1].last_tag == "RELEASE_2V29" and generations[0].first_tag == "RELEASE_2V09"


def test_clemson_digests_are_pinned():
    from drift.fetch import clemson
    assert len(clemson.DATA_SHA256) == 64 and len(clemson.DEMOGRAPHICS_SHA256) == 64


# ---- reproducible dates ---------------------------------------------------------------------------------------------
def test_generated_date_can_be_pinned(monkeypatch):
    monkeypatch.delenv("SOURCE_DATE_EPOCH", raising=False)
    monkeypatch.setenv("DRIFT_DATE", "2030-01-02")
    assert generated_date() == date(2030, 1, 2)
    monkeypatch.delenv("DRIFT_DATE")
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1700000000")
    assert generated_date() == date(2023, 11, 14)
    monkeypatch.delenv("SOURCE_DATE_EPOCH")
    assert generated_date() == date.today()


# ---- hidden firmware state ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("commit", ["9c2c3738", "e33e1183", "afb4943c", "2913ca0a"])
def test_results_do_not_depend_on_the_previous_recording(commit, target, bangle_recs, gen_by_commit, dlls):
    """2v11+ stepcount_init() leaves gate_open / active_sample_count alone; drift_init() zeroes them, so a recording that
    follows a walk (gate open at the end) counts exactly what it counts after a static file (gate closed)."""
    dll = dlls[gen_by_commit[commit].gen_id]
    walk, still = target.adapt(bangle_recs["HughB-walk-2350"]), target.adapt(bangle_recs["MrPloppy-stationary-0"])
    probe = target.adapt(bangle_recs["HughB-work-66"])
    target.run(dll, walk)
    a = target.run(dll, probe)
    target.run(dll, still)
    b = target.run(dll, probe)
    target.run(dll, walk)
    c = target.run(dll, probe)
    assert a.total == b.total == c.total
    assert np.array_equal(a.events, b.events) and np.array_equal(a.events, c.events)


# ---- resampling above 4 Hz ----------------------------------------------------------------------------------------------
def _amp(y):
    y = y[40:-40]
    return float(np.sqrt(2.0 * np.mean((y - y.mean()) ** 2)))


def test_poly_resampler_keeps_5_5_hz_and_suppresses_the_alias_of_6_9_hz_linear_does_not():
    """The device band ends at 6.25 Hz (half of 12.5 Hz).  Walking harmonics live above 4 Hz, so check there: a 5.5 Hz
    tone survives, a 6.9 Hz tone (above the new Nyquist) is filtered by the polyphase resampler but folds to 5.6 Hz
    under plain linear interpolation."""
    n = 3000
    t = np.arange(n) / 15.0
    keep = np.sin(2 * np.pi * 5.5 * t)[:, None]
    above = np.sin(2 * np.pi * 6.9 * t)[:, None]
    assert _amp(R.resample(keep, 15.0, 12.5, "poly")[:, 0]) == pytest.approx(1.0, abs=0.08)
    assert _amp(R.resample(above, 15.0, 12.5, "poly")[:, 0]) < 0.15
    assert _amp(R.resample(above, 15.0, 12.5, "linear")[:, 0]) > 0.3
