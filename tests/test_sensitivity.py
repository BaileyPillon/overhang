"""Sensitivity analysis of the replication verdicts: the independence model is
E = n_row * n_col / N, and the cell-level results match the pre-registered rule."""

from __future__ import annotations

import numpy as np
import pytest

from gapfind.facets import Tags, bh_qvalues, poisson_cdf
from gapfind.io import write_json, write_jsonl
from gapfind.replicate import verdict
from gapfind.sensitivity import MODELS, model_expected, sensitivity_cells

MOVES = [f"m{i}" for i in range(3)]
MATS = [f"t{i}" for i in range(3)]


def test_independence_e_matches_row_times_col_over_n():
    O = np.array([[0, 6, 4],
                  [10, 5, 5],
                  [2, 3, 15]])
    N = O.sum()                                   # 50
    E = model_expected(O, None)
    for i in range(3):
        for j in range(3):
            assert E[i, j] == pytest.approx(O[i].sum() * O[:, j].sum() / N)
    assert E[0, 0] == pytest.approx(10 * 12 / 50)  # 2.4, hand-computed
    assert E.sum() == pytest.approx(N)
    # the quasi model with a threshold nobody reaches is the same table
    assert model_expected(O, 1e9) == pytest.approx(E)


def toy(tmp_path):
    """Old sample: 3x3 table of 10 per cell with (0,0) empty. New sample: 5 per cell,
    (0,0) empty. Registered cell: (m0, t0)."""
    items, tags, new_ids = [], [], []
    for tag, fill in (("old", 10), ("new", 5)):
        for i in range(3):
            for j in range(3):
                n = 0 if (i, j) == (0, 0) else fill
                for k in range(n):
                    rid = f"{tag}-{i}{j}-{k}"
                    items.append({"id": rid, "text": rid})
                    tags.append({"id": rid, "move": MOVES[i], "material": MATS[j]})
                    if tag == "new":
                        new_ids.append(rid)
    write_jsonl(tmp_path / "tags.jsonl", tags)
    vocab = {"move": MOVES, "material": MATS}
    prereg = {"gaps": [{"id": "x", "axes": ["move", "material"], "expected": 3.0,
                        "cell": {"move": "m0", "material": "t0"}}]}
    return prereg, items, Tags(items, ["move", "material"], vocab, tmp_path / "tags.jsonl"), \
        vocab, set(new_ids)


def test_sensitivity_cell_values_and_verdicts(tmp_path):
    prereg, items, tags, vocab, new_ids = toy(tmp_path)
    doc = sensitivity_cells(prereg, items, tags, vocab, new_ids)
    assert [m["key"] for m in doc["models"]] == [k for k, _, _ in MODELS]
    (c,) = doc["cells"]
    assert c["observed_new"] == 0 and c["N_new"] == 40 and c["N_pooled"] == 120
    ind = c["models"]["indep"]
    # new sample: row m0 has 10, column t0 has 10, N = 40 -> E = 10 * 10 / 40
    assert ind["E_new"] == pytest.approx(2.5)
    assert ind["p_new"] == pytest.approx(poisson_cdf(0, 2.5))
    # pooled: row m0 = 30, column t0 = 30, N = 120 -> E = 7.5
    assert ind["E_pooled"] == pytest.approx(7.5)
    assert ind["p_pooled"] == pytest.approx(np.exp(-7.5))
    # q is BH over the family of cells with E >= 1; the empty cell has the smallest p (rank 1)
    assert ind["family_size"] == 9
    assert ind["q_pooled"] == pytest.approx(9 * np.exp(-7.5), rel=1e-6)
    assert ind["verdict"] == verdict(0, ind["E_new"], ind["q_pooled"]) == "replicated"
    for key in ("z3", "z4", "z5"):
        m = c["models"][key]
        assert m["verdict"] == verdict(c["observed_new"], m["E_new"], m["q_pooled"])
    assert doc["summary"]["indep"]["replicated"] == 1


def test_any_new_observation_refutes_under_every_model(tmp_path):
    prereg, items, tags, vocab, new_ids = toy(tmp_path)
    # move one new item into the cell
    for k, it in enumerate(items):
        if it["id"] == "new-11-0":
            tags.primary["move"][k], tags.primary["material"][k] = "m0", "t0"
    doc = sensitivity_cells(prereg, items, tags, vocab, new_ids)
    (c,) = doc["cells"]
    assert c["observed_new"] == 1
    assert {m["verdict"] for m in c["models"].values()} == {"refuted"}
    assert bh_qvalues([0.5]).tolist() == [0.5]    # sanity: helper is the shared BH
