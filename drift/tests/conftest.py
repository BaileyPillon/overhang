"""Shared fixtures.  Integration tests need the fetch cache (python -m drift fetch) and skip with a clear message
when it is absent, so a clean checkout can still run the pure-logic tests."""
from __future__ import annotations

from pathlib import Path

import pytest

from drift import CACHE_DIR, buildcache, history
from drift.fetch import bangle, clemson, espruino
from drift.targets import get_target


def _need(path: Path, what: str):
    if not Path(path).exists():
        pytest.skip(f"{what} not in cache ({path}); run: python -m drift fetch --target espruino_stepcount")


@pytest.fixture(scope="session")
def target():
    return get_target("espruino_stepcount")


@pytest.fixture(scope="session")
def espruino_repo() -> Path:
    p = espruino.repo_path(CACHE_DIR)
    _need(p, "Espruino source clone")
    return p


@pytest.fixture(scope="session")
def generations(target, espruino_repo):
    return history.build_history(espruino_repo, target.algo_files, target.tag_glob, tag_min=target.tag_min, tag_max=target.tag_max)


@pytest.fixture(scope="session")
def dlls(target, generations, espruino_repo):
    return buildcache.build_all(target, generations, espruino_repo, CACHE_DIR)


@pytest.fixture(scope="session")
def gen_by_commit(generations):
    """commit prefix (8) -> Generation; the inline 2v09 generation is keyed 'inline'."""
    return {("inline" if not g.blobs else g.commit[:8]): g for g in generations}


@pytest.fixture(scope="session")
def bangle_recs(target):
    _need(bangle.data_dir(CACHE_DIR), "Bangle step-count data")
    from drift.recordings import load_bangle
    return {r.rec_id: r for r in load_bangle(bangle.data_dir(CACHE_DIR))}


@pytest.fixture(scope="session")
def clemson_recs():
    _need(clemson.data_dir(CACHE_DIR), "Clemson Data")
    from drift.recordings import load_clemson
    return {r.rec_id: r for r in load_clemson(clemson.data_dir(CACHE_DIR))}
