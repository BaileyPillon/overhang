"""Sensitivity of the pre-registered replication verdicts to the expected-count model.

`replicate` fixes one model (quasi-independence, structural z = 3). This module
re-evaluates the SAME registered cells and the SAME verdict rule under other
models, in the new sample alone and in the pooled sample:

  indep      plain independence, E = n_row * n_col / N
  z3/z4/z5   quasi-independence with structural threshold z = 3, 4, 5

For each model: E_new, p_new = P(X <= O | Poisson(E_new)), E_pooled, p_pooled, and
the Benjamini-Hochberg q of the pooled p-values over the cells of that axis pair with
E_pooled >= min_expected under that model (so the family can differ between models).
It never touches the official replication.json.
"""

from __future__ import annotations

import numpy as np

from .facets import Tags, cell_pq, codes, contingency, poisson_cdf, quasi_expected
from .io import InputError
from .replicate import registered_cells, verdict

# (key, label, structural z or None for plain independence)
MODELS: list[tuple[str, str, float | None]] = [
    ("indep", "independence", None),
    ("z3", "quasi z=3", 3.0),
    ("z4", "quasi z=4", 4.0),
    ("z5", "quasi z=5", 5.0),
]


def model_expected(O: np.ndarray, z: float | None, max_rounds: int = 5) -> np.ndarray:
    """E under one model: plain independence (z is None) or quasi-independence at z."""
    E0, Eq, _ = quasi_expected(O, 3.0 if z is None else z, max_rounds)
    return E0 if z is None else Eq


def sensitivity_cells(prereg: dict, items: list[dict], tags: Tags, vocab: dict[str, list[str]],
                      new_ids: set[str], *, min_expected: float = 1.0, max_rounds: int = 5,
                      models: list[tuple[str, str, float | None]] = MODELS) -> dict:
    cands = registered_cells(prereg, min_expected)
    is_new = np.array([it["id"] in new_ids for it in items])
    pairs: list[tuple[str, str]] = []
    for c in cands:
        t = tuple(c["axes"])
        if t not in pairs:
            pairs.append(t)
    prim = {ax: codes(tags.primary[ax], vocab[ax]) for ax in tags.axes}

    tables: dict[tuple[str, str], dict] = {}
    for a, b in pairs:
        na, nb = len(vocab[a]), len(vocab[b])
        O_all = contingency(prim[a], prim[b], na, nb)
        O_new = contingency(np.where(is_new, prim[a], -1), prim[b], na, nb)
        per = {}
        for key, _, z in models:
            E_new = model_expected(O_new, z, max_rounds)
            E_all = model_expected(O_all, z, max_rounds)
            fam, P_all, Q_all = cell_pq(O_all, E_all, min_expected)
            per[key] = dict(E_new=E_new, E_all=E_all, P_all=P_all, Q_all=Q_all,
                            family_size=int(fam.sum()))
        tables[(a, b)] = dict(O_new=O_new, O_all=O_all, per=per)

    cells = []
    for c in cands:
        a, b = c["axes"]
        for ax in (a, b):
            if c["cell"][ax] not in vocab.get(ax, []):
                raise InputError(f"{c['prereg_id']}: value {c['cell'][ax]!r} is not in the "
                                 f"vocabulary of axis {ax!r}")
        i, j = vocab[a].index(c["cell"][a]), vocab[b].index(c["cell"][b])
        T = tables[(a, b)]
        o_new, o_all = int(T["O_new"][i, j]), int(T["O_all"][i, j])
        row = {**c, "observed_new": o_new, "observed_pooled": o_all,
               "n_row_new": int(T["O_new"][i].sum()), "n_col_new": int(T["O_new"][:, j].sum()),
               "N_new": int(T["O_new"].sum()), "N_pooled": int(T["O_all"].sum()),
               "models": {}}
        for key, label, z in models:
            m = T["per"][key]
            e_new = float(m["E_new"][i, j])
            q = m["Q_all"][i, j]
            p = m["P_all"][i, j]
            q_pooled = None if np.isnan(q) else float(q)
            row["models"][key] = {
                "label": label, "structural_z": z,
                "E_new": round(e_new, 4),
                "p_new": float(poisson_cdf(o_new, e_new)),
                "E_pooled": round(float(m["E_all"][i, j]), 4),
                "p_pooled": None if np.isnan(p) else float(p),
                "q_pooled": q_pooled,
                "family_size": m["family_size"],
                "verdict": verdict(o_new, e_new, q_pooled),
            }
        cells.append(row)
    summary = {key: {k: sum(1 for c in cells if c["models"][key]["verdict"] == k)
                     for k in ("replicated", "refuted", "underpowered")}
               for key, _, _ in models}
    return {"cells": cells, "summary": summary,
            "models": [{"key": k, "label": l, "structural_z": z} for k, l, z in models]}


def format_sensitivity(doc: dict) -> str:
    keys = [m["key"] for m in doc["models"]]
    labels = {m["key"]: m["label"] for m in doc["models"]}

    def f(x, spec):
        return "-" if x is None else format(x, spec)

    head = ["cell", "O_new"]
    for k in keys:
        head += [f"E_new {labels[k]}", f"verdict {labels[k]}", f"q_pooled {labels[k]}"]
    L = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for c in doc["cells"]:
        a, b = c["axes"]
        r = [f"{c['prereg_id']}: {c['cell'][a]} x {c['cell'][b]}", str(c["observed_new"])]
        for k in keys:
            m = c["models"][k]
            r += [f"{m['E_new']:.2f}", m["verdict"], f(m["q_pooled"], ".3f")]
        L.append("| " + " | ".join(r) + " |")
    L.append("")
    L.append("Verdict totals (replicated / refuted / underpowered):")
    L.append("")
    for k in keys:
        s = doc["summary"][k]
        L.append(f"- {labels[k]}: {s['replicated']} / {s['refuted']} / {s['underpowered']}")
    return "\n".join(L)
