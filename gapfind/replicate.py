"""Pre-registered replication test for facet holes.

A candidate hole was registered (PREREG.md, holes.json) before new data existed.
`replicate` evaluates each registered cell on a fresh sample and on the pooled
sample, and returns one of three verdicts by the rule fixed in advance:

  refuted       the cell gained observations in the NEW sample
  replicated    the cell is still empty in the new sample, its expected count under
                quasi-independence fitted on the new sample alone is >= 2, and it is
                still a hole in the pooled sample with Benjamini-Hochberg q <= 0.10
                across the cells of its axis pair (the same family as `facets`)
  underpowered  empty in the new sample but E_new < 2, or q_pooled > 0.10
                (or the cell is outside the pooled family because E_pooled is below
                --min-expected)

Items are matched by axes and cell values, never by hole id.
"""

from __future__ import annotations

import numpy as np

from .facets import (Tags, bootstrap_stability, cell_pq, codes, contingency, poisson_cdf,
                     quasi_expected)
from .io import InputError

E_NEW_MIN = 2.0     # pre-registered: power floor for the new-sample expected count
Q_MAX = 0.10        # pre-registered: pooled false discovery rate


def verdict(observed_new: int, e_new: float, q_pooled: float | None) -> str:
    """The pre-registered rule. `q_pooled` is None when the cell is outside the
    pooled family (its pooled expected count is below --min-expected)."""
    if observed_new > 0:
        return "refuted"
    if e_new >= E_NEW_MIN and q_pooled is not None and q_pooled <= Q_MAX:
        return "replicated"
    return "underpowered"


def registered_cells(prereg: dict, min_expected: float) -> list[dict]:
    """The pre-registered candidates: every gap with expected >= min_expected."""
    gaps = prereg.get("gaps") if isinstance(prereg, dict) else None
    if not isinstance(gaps, list):
        raise InputError("--prereg: expected a holes.json with a 'gaps' list")
    out = []
    for g in gaps:
        axes, cell = g.get("axes"), g.get("cell")
        if not (isinstance(axes, list) and len(axes) == 2 and isinstance(cell, dict)
                and all(a in cell for a in axes)):
            raise InputError(f"--prereg: gap {g.get('id')!r} has no axes/cell")
        if g.get("expected") is None:
            raise InputError(f"--prereg: gap {g.get('id')!r} has no expected count")
        if float(g["expected"]) >= min_expected:
            out.append({"prereg_id": g.get("id"), "axes": list(axes),
                        "cell": {a: cell[a] for a in axes},
                        "expected_prereg": float(g["expected"]),
                        "n_prereg": g.get("N")})
    return out


def replicate_cells(prereg: dict, items: list[dict], tags: Tags, vocab: dict[str, list[str]],
                    new_ids: set[str], *, min_expected: float = 1.0, boot: int = 1000,
                    seed: int = 42, z: float | None = None, max_rounds: int = 5) -> dict:
    if z is None:
        z = float((prereg.get("params") or {}).get("structural_z", 3.0))
    cands = registered_cells(prereg, min_expected)
    ids = [it["id"] for it in items]
    is_new = np.array([i in new_ids for i in ids])
    pairs: list[tuple[str, str]] = []
    for c in cands:
        t = tuple(c["axes"])
        if t not in pairs:
            pairs.append(t)
    prim = {ax: codes(tags.primary[ax], vocab[ax]) for ax in tags.axes}

    tables: dict[tuple[str, str], dict] = {}
    for pi, (a, b) in enumerate(pairs):
        na, nb = len(vocab[a]), len(vocab[b])
        O_all = contingency(prim[a], prim[b], na, nb)
        O_new = contingency(np.where(is_new, prim[a], -1), prim[b], na, nb)
        E_new = quasi_expected(O_new, z, max_rounds)[1]
        E_all = quasi_expected(O_all, z, max_rounds)[1]
        fam, P_all, Q_all = cell_pq(O_all, E_all, min_expected)
        stab = bootstrap_stability(O_all, boot, np.random.default_rng([seed, pi]),
                                   quasi=True, z=z, max_rounds=max_rounds)
        tables[(a, b)] = dict(O_all=O_all, O_new=O_new, E_all=E_all, E_new=E_new, P_all=P_all,
                              Q_all=Q_all, stab=stab, family_size=int(fam.sum()))

    cells = []
    for c in cands:
        a, b = c["axes"]
        for ax in (a, b):
            if c["cell"][ax] not in vocab.get(ax, []):
                raise InputError(f"--prereg: {c['prereg_id']}: value {c['cell'][ax]!r} is not "
                                 f"in the vocabulary of axis {ax!r}")
        i, j = vocab[a].index(c["cell"][a]), vocab[b].index(c["cell"][b])
        T = tables[(a, b)]
        obs_new, obs_all = int(T["O_new"][i, j]), int(T["O_all"][i, j])
        e_new, e_all = float(T["E_new"][i, j]), float(T["E_all"][i, j])
        q = T["Q_all"][i, j]
        q_pooled = None if np.isnan(q) else float(q)
        p_pooled = None if np.isnan(T["P_all"][i, j]) else float(T["P_all"][i, j])
        refuting = []
        if obs_new > 0:
            for k, it in enumerate(items):
                if is_new[k] and tags.primary[a][k] == c["cell"][a] \
                        and tags.primary[b][k] == c["cell"][b]:
                    refuting.append({"id": it["id"], "title": it.get("title")})
        v = verdict(obs_new, e_new, q_pooled)
        cells.append({
            **c, "verdict": v,
            "observed_new": obs_new, "E_new": round(e_new, 4),
            "p_new": float(poisson_cdf(obs_new, e_new)),
            "N_new": int(T["O_new"].sum()),
            "observed_pooled": obs_all, "E_pooled": round(e_all, 4),
            "p_pooled": p_pooled, "q_pooled": q_pooled,
            "family_size": T["family_size"], "N_pooled": int(T["O_all"].sum()),
            "observed_old": obs_all - obs_new,
            "bootstrap_stability": round(float(T["stab"][i, j]), 4),
            "refuting_items": refuting,
            "reason": _reason(v, obs_new, e_new, q_pooled),
        })
    counts = {k: sum(1 for c in cells if c["verdict"] == k)
              for k in ("replicated", "refuted", "underpowered")}
    return {"cells": cells, "summary": {"n_cells": len(cells), **counts},
            "pairs": [{"axes": [a, b], "N_new": int(t["O_new"].sum()),
                       "N_pooled": int(t["O_all"].sum()), "family_size": t["family_size"]}
                      for (a, b), t in tables.items()],
            "params": {"min_expected": min_expected, "boot": boot, "seed": seed,
                       "structural_z": z, "structural_max_rounds": max_rounds,
                       "e_new_min": E_NEW_MIN, "q_max": Q_MAX}}


def _reason(v: str, obs_new: int, e_new: float, q_pooled: float | None) -> str:
    if v == "refuted":
        return f"{obs_new} new item(s) in the cell"
    if v == "replicated":
        return f"empty in the new sample, E_new {e_new:.2f} >= {E_NEW_MIN:g}, q_pooled {q_pooled:.3g} <= {Q_MAX:g}"
    why = []
    if e_new < E_NEW_MIN:
        why.append(f"E_new {e_new:.2f} < {E_NEW_MIN:g}")
    if q_pooled is None:
        why.append("outside the pooled family (E_pooled below --min-expected)")
    elif q_pooled > Q_MAX:
        why.append(f"q_pooled {q_pooled:.3g} > {Q_MAX:g}")
    return "; ".join(why)


def format_replication(doc: dict) -> str:
    L = ["| prereg id | axes | cell | obs new | E new | p new | obs pooled | E pooled | p pooled | "
         "q pooled | boot | verdict |", "|---|---|---|---|---|---|---|---|---|---|---|---|"]

    def f(x, spec):
        return "-" if x is None else format(x, spec)

    for c in doc["cells"]:
        a, b = c["axes"]
        L.append(f"| {c['prereg_id']} | {a} x {b} | {c['cell'][a]} x {c['cell'][b]} | "
                 f"{c['observed_new']} | {c['E_new']:.2f} | {c['p_new']:.3f} | "
                 f"{c['observed_pooled']} | {c['E_pooled']:.2f} | {f(c['p_pooled'], '.3f')} | "
                 f"{f(c['q_pooled'], '.3f')} | {c['bootstrap_stability']:.2f} | {c['verdict']} |")
    s = doc["summary"]
    L.append("")
    L.append(f"{s['n_cells']} pre-registered cells: {s['replicated']} replicated, "
             f"{s['refuted']} refuted, {s['underpowered']} underpowered")
    for c in doc["cells"]:
        if c["verdict"] == "refuted":
            a, b = c["axes"]
            L.append(f"refuted {c['prereg_id']} ({c['cell'][a]} x {c['cell'][b]}):")
            for it in c["refuting_items"]:
                L.append(f"    {it['id']}  {it['title']}")
    return "\n".join(L)
