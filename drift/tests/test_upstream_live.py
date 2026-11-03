"""Live upstream reproduction: build gfwilliams/step-count's own main.c (pinned commit, UNMODIFIED) against the blobs of
2v10, 2v11 and 2v12 and compare its output with Drift's `--flush` replay, so the reproduction claim does not rest on
constants copied from a past run.  Skipped when the Bangle data, the Espruino clone or zig are not available.

main.c needs POSIX getline() (a shim is injected with -include; the source is untouched).  For 2v10, whose
stepcount.c lacks X_STEPS / RAW_THRESHOLD (used in one printf of main.c), the two names are defined on the command line.
"""
from __future__ import annotations

import re
import shutil
import subprocess

import numpy as np
import pytest

from drift import buildcache
from drift.fetch import bangle
from drift.targets import get_target

pytest.importorskip("ziglang")

HERE_SHIM = None
COMMITS = ["afb4943c", "e33e1183", "9c2c3738"]


@pytest.fixture(scope="module")
def flushed():
    return get_target("espruino_stepcount", flush=True)


def _shim():
    from drift import PKG_DIR
    p = PKG_DIR / "recon" / "espruino-harness" / "getline_shim.h"
    if not p.exists():
        pytest.skip("getline shim not present")
    return p


def _run_upstream(tmp_path, commit, gen, espruino_repo):
    from drift import CACHE_DIR
    from drift.toolchain import compile_c
    repo = bangle.repo_path(CACHE_DIR)
    root = tmp_path / commit
    misc = root / "Espruino" / "libs" / "misc"
    sc = root / "step-count"
    misc.mkdir(parents=True)
    sc.mkdir()
    buildcache.materialize(espruino_repo, gen, misc)
    shutil.copy(repo / "jsutils.h", misc / "jsutils.h")
    shutil.copy(repo / "jsutils.h", sc / "jsutils.h")
    shutil.copy(repo / "main.c", sc / "main.c")                  # byte-identical to the pinned upstream file
    (sc / "data").mkdir()
    for line in (repo / "main.c").read_text().splitlines():
        m = re.match(r'\s*"([^"]+\.csv)"', line)
        if m and (repo / "data" / m.group(1)).exists():
            shutil.copy(repo / "data" / m.group(1), sc / "data" / m.group(1))
    defs = {"X_STEPS": 0, "RAW_THRESHOLD": 0} if commit == "9c2c3738" else None
    exe = compile_c([sc / "main.c"], root / "main", defines=defs, includes=[sc], std="-std=gnu11",
                    extra=["-include", str(_shim()), "-w"])
    r = subprocess.run([exe], cwd=sc, capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stderr
    rows = []
    for ln in r.stdout.splitlines():
        m = re.match(r"(\S+)\.csv, (\d+), (\d+), (-?\d+), [\d.]+ %, \((\d+)\)", ln)
        if m:
            rows.append((m.group(1), int(m.group(3)), int(m.group(5))))
    return rows


@pytest.mark.parametrize("commit", COMMITS)
def test_drift_flush_equals_upstream_main_c_built_live(commit, tmp_path, flushed, target, bangle_recs, gen_by_commit,
                                                      dlls, espruino_repo):
    rows = _run_upstream(tmp_path, commit, gen_by_commit[commit], espruino_repo)
    assert len(rows) >= 12, rows
    dll = dlls[gen_by_commit[commit].gen_id]
    tail = flushed._load(dll).drift_flush_tail()
    assert tail == (57 if commit == "9c2c3738" else 7)
    inline = dlls[gen_by_commit["inline"].gen_id]
    for name, simulated, original in rows:
        native = flushed.adapt(bangle_recs[name])
        assert flushed.run(dll, native).total == simulated, (commit, name, "stepcount.c")
        # main.c's "(Original)" column is the 2v09 inline counter fed with the same flushed stream (its own tap count)
        fed = np.vstack([native, np.repeat(native[-1:], tail, axis=0)])
        assert target.run(inline, fed).total == original, (commit, name, "original")
