"""Benjamini-Hochberg q on the facet tables, and the pre-registered `replicate`
command: one synthetic case per verdict. No embedding model is needed (replicate
reads ids, titles and tags only)."""

from __future__ import annotations

import json

import numpy as np
import pytest

from gapfind import cli
from gapfind.facets import bh_qvalues, cell_pq, poisson_cdf
from gapfind.io import InputError, read_json, write_json, write_jsonl
from gapfind.replicate import verdict

from test_facets import make_corpus, make_run, run_facets

MOVES = [f"m{i}" for i in range(4)]
MATS = [f"t{i}" for i in range(4)]


# ------------------------------------------------------------ BH q-values

def test_bh_hand_computed():
    # sorted: 0.005 (rank 1), 0.01 (2), 0.03 (3), 0.04 (4); m = 4
    # raw p*m/rank = 0.02, 0.02, 0.04, 0.04 -> already monotone
    q = bh_qvalues([0.01, 0.04, 0.03, 0.005])
    assert q.tolist() == pytest.approx([0.02, 0.04, 0.04, 0.02])


def test_bh_enforces_monotonicity_and_caps_at_one():
    # raw p*m/rank for sorted [0.01, 0.04, 0.03, 0.9, 0.6] -> sorted 0.01,0.03,0.04,0.6,0.9, m = 5:
    # 0.05, 0.075, 0.0667, 0.75, 0.9  -> from the right, running minimum: 0.05, 0.0667, 0.0667, 0.75, 0.9
    q = bh_qvalues([0.01, 0.04, 0.03, 0.9, 0.6])
    assert q.tolist() == pytest.approx([0.05, 0.2 / 3, 0.2 / 3, 0.9, 0.75])
    assert bh_qvalues([0.9, 0.95]).tolist() == pytest.approx([0.95, 0.95])   # 0.9*2/1 = 1.8 -> capped, then min
    assert bh_qvalues([0.7]).tolist() == [0.7]
    assert bh_qvalues([]).tolist() == []
    assert bh_qvalues([0.6, 0.9])[0] <= 1.0


def test_cell_pq_family_is_the_cells_with_enough_expected():
    O = np.array([[0, 5], [4, 0]])
    E = np.array([[3.0, 0.5], [4.0, 2.0]])      # (0,1) has E < 1: outside the family
    fam, p, q = cell_pq(O, E, 1.0)
    assert fam.tolist() == [[True, False], [True, True]]
    assert p[0, 0] == pytest.approx(np.exp(-3.0))
    assert p[1, 0] == pytest.approx(poisson_cdf(4, 4.0))
    assert p[1, 1] == pytest.approx(np.exp(-2.0))
    assert np.isnan(p[0, 1]) and np.isnan(q[0, 1])
    # family of 3: sorted p = e^-3 (0.0498), e^-2 (0.1353), 0.6288 -> raw 0.1494, 0.2030, 0.6288
    assert q[0, 0] == pytest.approx(3 * np.exp(-3.0))
    assert q[1, 1] == pytest.approx(1.5 * np.exp(-2.0))
    assert q[1, 0] == pytest.approx(poisson_cdf(4, 4.0))


def test_facets_writes_q_on_holes_and_cell_tables(tmp_path):
    env = make_run(tmp_path, make_corpus())
    doc = run_facets(env)
    for pr in doc["pairs"]:
        P, Q = pr["p_cell"], pr["q"]
        assert pr["family_size"] == sum(x is not None for row in Q for x in row)
        fam = [(i, j) for i, row in enumerate(Q) for j, x in enumerate(row) if x is not None]
        assert fam == [(i, j) for i, row in enumerate(P) for j, x in enumerate(row) if x is not None]
        # independent re-derivation: naive Benjamini-Hochberg on the family's p-values
        ps = np.array([P[i][j] for i, j in fam])
        order = np.argsort(ps)
        m = len(ps)
        naive = {}
        best = 1.0
        for rank in range(m, 0, -1):
            k = order[rank - 1]
            best = min(best, ps[k] * m / rank)
            naive[fam[k]] = best
        for (i, j), v in naive.items():
            assert Q[i][j] == pytest.approx(v)
        # p is the Poisson deficit probability of the observed count given the stored E
        a, b = pr["axes"]
        for hid in pr["holes"]:
            g = next(x for x in doc["gaps"] if x["id"] == hid)
            i, j = pr["rows"].index(g["cell"][a]), pr["cols"].index(g["cell"][b])
            assert g["family_size"] == pr["family_size"]
            assert g["q"] == pytest.approx(Q[i][j]) and g["q"] >= g["p"] - 1e-12
            assert P[i][j] == pytest.approx(g["p"])
        for t in pr["thin"]:
            i, j = pr["rows"].index(t["cell"][a]), pr["cols"].index(t["cell"][b])
            assert t["q"] == pytest.approx(Q[i][j])
    top = next(g for g in doc["gaps"] if g["id"] == "hole-move-material-01")
    assert top["q"] < 1e-6                                   # the planted hole stays significant


# ------------------------------------------------------------- verdict rule

def test_verdict_rule():
    assert verdict(0, 3.0, 0.05) == "replicated"
    assert verdict(0, 2.0, 0.10) == "replicated"              # both bounds are inclusive
    assert verdict(1, 30.0, 1e-9) == "refuted"                # any new observation refutes
    assert verdict(0, 1.99, 0.001) == "underpowered"
    assert verdict(0, 5.0, 0.101) == "underpowered"
    assert verdict(0, 5.0, None) == "underpowered"            # outside the pooled family


# --------------------------------------------------- synthetic replications

def build(tmp_path, old, new, titles=None):
    """Items from two 4x4 count tables (old sample, new sample) -> run dir with items
    only (no embeddings), tags, vocab, new-ids file and a prereg file whose single
    registered cell is (m0, t0) under an unrelated id, plus a decoy below min-expected."""
    items, tags, new_ids = [], [], []
    for tag, table in (("old", old), ("new", new)):
        for i in range(4):
            for j in range(4):
                for n in range(table[i][j]):
                    rid = f"{tag}-{i}{j}-{n}"
                    items.append({"id": rid, "text": rid, "title": (titles or {}).get(rid, f"Title {rid}")})
                    tags.append({"id": rid, "move": MOVES[i], "material": MATS[j]})
                    if tag == "new":
                        new_ids.append(rid)
    run = tmp_path / "r2"
    run.mkdir()
    write_jsonl(run / "items.jsonl", items)
    write_jsonl(tmp_path / "tags.jsonl", tags)
    write_json(tmp_path / "vocab.json", {"axes": {
        "move": [{"value": v, "definition": v} for v in MOVES],
        "material": [{"value": v, "definition": v} for v in MATS]}})
    (tmp_path / "new_ids.txt").write_text("\n".join(new_ids) + "\n", encoding="utf-8")
    write_json(tmp_path / "prereg.json", {
        "params": {"structural_z": 3.0},
        "gaps": [
            {"id": "hole-not-the-same-id-99", "axes": ["move", "material"],
             "cell": {"move": "m0", "material": "t0"}, "expected": 5.0, "observed": 0},
            {"id": "hole-below-min", "axes": ["move", "material"],
             "cell": {"move": "m1", "material": "t1"}, "expected": 0.4, "observed": 0}]})
    return run


def table(fill, zero=(), extra=None):
    t = [[fill] * 4 for _ in range(4)]
    for i, j in zero:
        t[i][j] = 0
    for (i, j), v in (extra or {}).items():
        t[i][j] = v
    return t


def replicate(tmp_path, run, *extra):
    argv = ["replicate", "--prereg", str(tmp_path / "prereg.json"), "--run", str(run),
            "--tags", str(tmp_path / "tags.jsonl"), "--vocab", str(tmp_path / "vocab.json"),
            "--new-ids", str(tmp_path / "new_ids.txt"), "--boot", "200", *extra]
    assert cli.main(argv) == 0
    return read_json(run / "replication.json")


def only(doc):
    assert len(doc["cells"]) == 1                 # the below-min-expected decoy is not tested
    return doc["cells"][0]


def test_replicated(tmp_path, capsys):
    run = build(tmp_path, old=table(25, [(0, 0)]), new=table(25, [(0, 0)]))
    c = only(replicate(tmp_path, run))
    assert c["verdict"] == "replicated"
    assert c["prereg_id"] == "hole-not-the-same-id-99"      # matched by cell values, not by id
    assert c["observed_new"] == 0 and c["E_new"] >= 2
    assert c["observed_pooled"] == 0 and c["observed_old"] == 0
    assert c["q_pooled"] <= 0.10 and c["p_new"] == pytest.approx(np.exp(-c["E_new"]), rel=1e-3)
    assert c["family_size"] == 16 and c["N_new"] == 375 and c["N_pooled"] == 750
    assert c["bootstrap_stability"] > 0.9 and c["refuting_items"] == []
    out = capsys.readouterr().out
    assert "replicated" in out and "| prereg id |" in out
    assert "1 pre-registered cells: 1 replicated, 0 refuted, 0 underpowered" in out


def test_refuted_lists_the_new_items(tmp_path):
    titles = {"new-00-0": "A counterexample", "new-00-1": "Another one"}
    run = build(tmp_path, old=table(25, [(0, 0)]), new=table(25, extra={(0, 0): 2}), titles=titles)
    c = only(replicate(tmp_path, run))
    assert c["verdict"] == "refuted"
    assert c["observed_new"] == 2 and c["observed_pooled"] == 2 and c["observed_old"] == 0
    assert [(x["id"], x["title"]) for x in c["refuting_items"]] == [
        ("new-00-0", "A counterexample"), ("new-00-1", "Another one")]
    assert c["p_new"] == pytest.approx(poisson_cdf(2, c["E_new"]), rel=1e-3)


def test_old_items_in_the_cell_do_not_refute_but_are_reported(tmp_path):
    # an old-sample item in the cell shows up as observed_old, not as a new observation
    run = build(tmp_path, old=table(25, extra={(0, 0): 1}), new=table(25, [(0, 0)]))
    c = only(replicate(tmp_path, run))
    assert c["observed_new"] == 0 and c["observed_old"] == 1 and c["refuting_items"] == []


def test_underpowered_when_the_new_sample_is_too_small(tmp_path):
    # new sample: 3 per cell, (0,0) empty: E_new = 9*9/45 = 1.8 < 2, though the pooled
    # sample is large and the cell is a hole there
    run = build(tmp_path, old=table(25, [(0, 0)]), new=table(3, [(0, 0)]))
    c = only(replicate(tmp_path, run))
    assert c["verdict"] == "underpowered"
    assert c["observed_new"] == 0 and c["E_new"] == pytest.approx(1.8, abs=1e-6) and c["E_new"] < 2
    assert c["q_pooled"] <= 0.10
    assert "E_new" in c["reason"]


def test_underpowered_when_the_pooled_q_is_too_large(tmp_path):
    # new sample: 4 per cell, (0,0) empty: E_new = 12*12/60 = 2.4 >= 2, but p = exp(-2.4) = 0.09
    # is not extreme enough to survive BH over 16 cells
    run = build(tmp_path, old=table(0), new=table(4, [(0, 0)]))
    c = only(replicate(tmp_path, run))
    assert c["verdict"] == "underpowered"
    assert c["observed_new"] == 0 and c["E_new"] >= 2
    assert c["q_pooled"] > 0.10
    assert c["p_pooled"] == pytest.approx(np.exp(-c["E_pooled"]), rel=1e-3)
    assert "q_pooled" in c["reason"]


def test_min_expected_filters_the_registered_cells(tmp_path):
    run = build(tmp_path, old=table(25, [(0, 0)]), new=table(25, [(0, 0)]))
    doc = replicate(tmp_path, run, "--min-expected", "6")      # the prereg cell has expected 5
    assert doc["cells"] == [] and doc["summary"]["n_cells"] == 0
    doc = replicate(tmp_path, run, "--min-expected", "0.3")    # now the decoy (0.4) is registered
    assert len(doc["cells"]) == 2


def test_unknown_vocabulary_value_is_an_error(tmp_path):
    run = build(tmp_path, old=table(25, [(0, 0)]), new=table(25, [(0, 0)]))
    doc = read_json(tmp_path / "prereg.json")
    doc["gaps"][0]["cell"]["move"] = "nope"
    write_json(tmp_path / "prereg.json", doc)
    argv = ["replicate", "--prereg", str(tmp_path / "prereg.json"), "--run", str(run),
            "--tags", str(tmp_path / "tags.jsonl"), "--vocab", str(tmp_path / "vocab.json"),
            "--new-ids", str(tmp_path / "new_ids.txt")]
    assert cli.main(argv) == 2                     # InputError -> exit code 2, nothing written
    assert not (run / "replication.json").exists()
