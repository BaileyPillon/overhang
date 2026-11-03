"""History mapping: a synthetic git fixture (always runs) and the real Espruino tag map (needs the fetch cache)."""
from __future__ import annotations

import os
import subprocess
from datetime import date
from pathlib import Path

import pytest

from drift import history


def _git(repo: Path, *args: str, env_date: str | None = None) -> str:
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    if env_date:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = env_date
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, env=env)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


class Fx:
    def __init__(self, path, cA, cB, cH, cR):
        self.path, self.cA, self.cB, self.cH, self.cR = path, cA, cB, cH, cR


@pytest.fixture()
def fixture_repo(tmp_path):
    """Release tags R1..R9:
         R1            no algo files yet (inline era)
         R2, R3        algo.c = A
         R4            algo.c = A, only an unrelated file changed       -> same generation as R3
         R5            algo.c = B
         R6            algo.c = B, algo.h = H2 (header change counts)    -> new generation
         R7            algo.c = A again (revert)                         -> NEW generation, not merged with R2-R4
         R8, R10       same as R7 (R10 checks natural, not lexical, tag order)
    """
    r = tmp_path / "fx"
    r.mkdir()
    _git(r, "init", "-q")
    d = r / "lib"
    d.mkdir()

    def commit(msg, date_):
        _git(r, "add", "-A")
        _git(r, "commit", "-q", "--allow-empty", "-m", msg, env_date=date_)
        return _git(r, "rev-parse", "HEAD")

    def tag(name):
        _git(r, "tag", name)

    (r / "other.txt").write_text("0")
    commit("inline era", "2021-01-01T10:00:00+00:00"); tag("REL_1")
    (d / "algo.c").write_text("A"); (d / "algo.h").write_text("H1")
    cA = commit("add algo", "2021-02-01T10:00:00+00:00"); tag("REL_2")
    commit("noop doc", "2021-03-01T10:00:00+00:00"); tag("REL_3")
    (r / "other.txt").write_text("1")
    commit("unrelated", "2021-04-01T10:00:00+00:00"); tag("REL_4")
    (d / "algo.c").write_text("B")
    cB = commit("algo B", "2021-05-01T10:00:00+00:00"); tag("REL_5")
    (d / "algo.h").write_text("H2")
    cH = commit("header", "2021-06-01T10:00:00+00:00"); tag("REL_6")
    (d / "algo.c").write_text("A")
    cR = commit("revert", "2021-07-01T10:00:00+00:00"); tag("REL_7")
    (r / "other.txt").write_text("2")
    commit("unrelated 2", "2021-08-01T10:00:00+00:00"); tag("REL_8")
    tag("REL_10")           # natural order: REL_10 sorts after REL_8, before nothing else
    tag("NOTAG")            # does not match the glob
    return Fx(r, cA, cB, cH, cR)


ALGO = ["lib/algo.c", "lib/algo.h"]


def test_fixture_generations(fixture_repo):
    r = fixture_repo
    gens = history.build_history(r.path, ALGO, "REL_*")
    assert [g.tags for g in gens] == [["REL_1"], ["REL_2", "REL_3", "REL_4"], ["REL_5"], ["REL_6"],
                                      ["REL_7", "REL_8", "REL_10"]]
    inline, a, b, h, rev = gens
    # absent files: no blobs, but still a generation with its own id
    assert inline.blobs == {} and a.blobs.keys() == {"lib/algo.c", "lib/algo.h"}
    # the reverted algo.c has the same .c blob as REL_2 but a different .h blob (H2), so ids differ
    assert len({g.gen_id for g in gens}) == 5
    # representative commit = last commit that touched the algo files at the first tag
    assert a.commit == r.cA and b.commit == r.cB and h.commit == r.cH and rev.commit == r.cR
    # dates: first tag's commit date; last_date = next generation's first date; final = None (still current)
    assert a.first_date == date(2021, 2, 1) and a.last_date == b.first_date == date(2021, 5, 1)
    assert inline.first_date == date(2021, 1, 1) and inline.last_date == a.first_date
    assert rev.last_date is None
    assert (a.first_tag, a.last_tag) == ("REL_2", "REL_4")
    assert a.label == "2–4" and inline.label == "1"


def test_fixture_tag_min_and_natural_order(fixture_repo):
    assert history.list_tags(fixture_repo.path, "REL_*") == ["REL_1", "REL_2", "REL_3", "REL_4", "REL_5", "REL_6", "REL_7",
                                                        "REL_8", "REL_10"]
    gens = history.build_history(fixture_repo.path, ALGO, "REL_*", tag_min="REL_5")
    assert gens[0].first_tag == "REL_5" and len(gens) == 3


def test_same_blobs_nonadjacent_get_distinct_ids():
    from drift.history import TagInfo, collapse
    d = date(2020, 1, 1)
    infos = [TagInfo("T1", d, {"a": "x"}, "c1"), TagInfo("T2", d, {"a": "y"}, "c2"), TagInfo("T3", d, {"a": "x"}, "c3")]
    gens = collapse(infos, ["a"])
    assert len(gens) == 3 and len({g.gen_id for g in gens}) == 3


def test_natural_key():
    assert history.natural_key("RELEASE_2V09") < history.natural_key("RELEASE_2V10") < history.natural_key("RELEASE_2V100")


# ---- the real thing ------------------------------------------------------------------------------------------
def test_espruino_generations(generations, gen_by_commit):
    labels = [(g.first_tag, g.last_tag, "inline" if not g.blobs else g.commit[:8]) for g in generations]
    assert labels == [
        ("RELEASE_2V09", "RELEASE_2V09", "inline"),
        ("RELEASE_2V10", "RELEASE_2V10", "9c2c3738"),
        ("RELEASE_2V11", "RELEASE_2V11", "e33e1183"),
        ("RELEASE_2V12", "RELEASE_2V21", "afb4943c"),
        ("RELEASE_2V22", "RELEASE_2V28", "3138205d"),
        ("RELEASE_2V29", "RELEASE_2V29", "2913ca0a"),
    ]
    g12 = gen_by_commit["afb4943c"]
    assert len(g12.tags) == 10 and g12.first_date == date(2022, 2, 1) and g12.last_date == date(2024, 5, 21)
    assert gen_by_commit["inline"].first_date == date(2021, 4, 19)
    assert generations[-1].last_date is None
    # blob SHAs found in recon (stepcount.c) at the representative tags
    assert gen_by_commit["afb4943c"].blobs["libs/misc/stepcount.c"] == "40ad2dead3a3792de663325c8ef3771370c2cdf3"
    assert gen_by_commit["2913ca0a"].blobs["libs/misc/stepcount.c"] == "17c68cb41025351e038c139390249f9b2de8081d"
    assert gen_by_commit["9c2c3738"].blobs["libs/misc/stepcount.c"] == "c964ba752e2d8658f9c23dc405dc442f369d6b55"
