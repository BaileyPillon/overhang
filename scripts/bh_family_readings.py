"""The three Benjamini-Hochberg family readings for the 19 registered holes (results/bh-family-ruling.md).

  literal      every EMPTY cell of the pair's pooled table (what PREREG.md says)
  code         every cell with E >= 1, empty or not (what gapfind.facets.cell_pq / `replicate` does)
  alternative  every EMPTY cell with E >= 1 (the candidate-eligible cells; a sensitivity, not the result)

Deficit p = P(X <= O | Poisson(E_quasi)); E_quasi is the pooled quasi-independence fit, as in `replicate`.
Run from the repo root with the project venv:   python scripts/bh_family_readings.py
Writes results/bh-family-readings.json and app/public/data/bh_family.json (same content).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from gapfind.facets import Tags, bh_qvalues, codes, contingency, load_vocab, poisson_cdf, quasi_expected
from gapfind.io import read_json, read_jsonl

ROOT = Path(__file__).resolve().parent.parent
rep = read_json(ROOT / "results" / "replication.json")
prereg = read_json(ROOT / rep["prereg"])
vocab, _ = load_vocab(ROOT / rep["vocab"])
items = read_jsonl(ROOT / "runs" / "r2" / "items.jsonl")
for it in items:
    it.pop("__src__", None)
new_ids = {ln.strip() for ln in (ROOT / rep["new_ids_file"]).read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.startswith("#")}
axes_used = sorted({ax for g in prereg["gaps"] for ax in g["axes"]})
tags = Tags(items, axes_used, vocab, str(ROOT / rep["tags"]))
Z = float(prereg["params"].get("structural_z", 3.0))
prim = {ax: codes(tags.primary[ax], vocab[ax]) for ax in tags.axes}
is_new = np.array([it["id"] in new_ids for it in items])


def q_in_family(O, E, mask):
    idx = np.argwhere(mask)
    pv = np.array([poisson_cdf(int(O[i, j]), float(E[i, j])) for i, j in idx])
    qv = bh_qvalues(pv)
    return {(int(i), int(j)): float(q) for (i, j), q in zip(idx, qv)}


tables = {}
cells = []
for rc in rep["cells"]:
    a, b = rc["axes"]
    if (a, b) not in tables:
        O = contingency(prim[a], prim[b], len(vocab[a]), len(vocab[b]))
        E = quasi_expected(O, Z, 5)[1]
        tables[(a, b)] = (O, E, {
            "literal": q_in_family(O, E, O == 0),
            "code": q_in_family(O, E, E >= 1.0),
            "alternative": q_in_family(O, E, (O == 0) & (E >= 1.0)),
        }, {"literal": int((O == 0).sum()), "code": int((E >= 1.0).sum()), "alternative": int(((O == 0) & (E >= 1.0)).sum())})
    O, E, qs, sizes = tables[(a, b)]
    i, j = vocab[a].index(rc["cell"][a]), vocab[b].index(rc["cell"][b])
    row = {"code": None, "prereg_id": rc["prereg_id"], "axes": [a, b], "cell": rc["cell"],
           "observed_new": rc["observed_new"], "E_new": rc["E_new"], "observed_pooled": int(O[i, j]), "E_pooled": round(float(E[i, j]), 4), "verdict_registered": rc["verdict"]}
    for k in ("literal", "code", "alternative"):
        row["q_" + k] = qs[k].get((i, j))
        row["m_" + k] = sizes[k]
    cells.append(row)

# attach the OV-NN codes from the app's holes file (same cell labels)
holes = json.loads((ROOT / "app" / "public" / "data" / "replication.json").read_text(encoding="utf-8"))["rows"]
by_cell = {(tuple(h["axes"]), h["cell_label"]): h["code"] for h in holes}
for c in cells:
    a, b = c["axes"]
    c["code"] = by_cell.get((tuple(c["axes"]), f'{c["cell"][a]} × {c["cell"][b]}'))

out = {
    "source": "scripts/bh_family_readings.py",
    "ruling": "results/bh-family-ruling.md",
    "note": "Pooled q under three Benjamini-Hochberg families. 'literal' is the registered wording (all empty cells of the pair); 'code' is what the verdicts used (cells with E >= 1); 'alternative' (empty cells with E >= 1) is a sensitivity, never the result.",
    "q_max": 0.10,
    "e_new_min": 2.0,
    "cells": cells,
    "counts": {k: {"q_le_0.10_and_Enew_ge_2": sum(1 for c in cells if c["observed_new"] == 0 and c["E_new"] >= 2 and c["q_" + k] is not None and c["q_" + k] <= 0.10),
                    "q_le_0.10_only": sum(1 for c in cells if c["observed_new"] == 0 and c["q_" + k] is not None and c["q_" + k] <= 0.10)}
               for k in ("literal", "code", "alternative")},
}
txt = json.dumps(out, indent=1, ensure_ascii=False)
(ROOT / "results" / "bh-family-readings.json").write_text(txt + "\n", encoding="utf-8")
(ROOT / "app" / "public" / "data" / "bh_family.json").write_text(txt + "\n", encoding="utf-8")
print(json.dumps(out["counts"]))
for c in cells:
    if c["observed_new"] == 0:
        print(c["code"], c["observed_new"], c["E_new"], *(f'{c["q_" + k]:.3f}(m={c["m_" + k]})' if c["q_" + k] is not None else "-" for k in ("literal", "code", "alternative")))
