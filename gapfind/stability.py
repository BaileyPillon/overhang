"""Stability of gaps under re-runs.

A gap is "stable" when re-running the search under other PCA dimensions and
other seeds keeps finding a gap in the same place. Matching is done in the
FULL centered dimension, because that is the only space common to runs with
different PCA projections: each gap's full-space point is the blend of the
same parents with the same weights taken in the full centered space
(`vector_full` in gaps.json), and two gaps match when the cosine of their
full vectors is at least `match`.

To say what a given radius means, every re-run also draws a random set of
coherent blends (same size as its top list) and records how often *those*
match a primary gap: the chance-level stability reported as `null`.
"""

from __future__ import annotations

import numpy as np

from .core import Space, blend, candidate_mask, l2_normalize, sample_blends, select_gaps
from .io import InputError


def run_stability(X: np.ndarray, gdoc: dict, *, pca_list, seeds, match: float = 0.8,
                  topk: int | None = None, samples: int | None = None,
                  null_draws: int = 20, progress=None) -> dict:
    """Re-run `find` for every (pca, seed) pair and match its top-K against
    the primary gaps in `gdoc`. X is the full centered corpus."""
    gaps = gdoc["gaps"]
    if not gaps:
        raise InputError("gaps.json has no gaps")
    if "vector_full" not in gaps[0]:
        raise InputError("gaps.json lacks `vector_full` (written by an older version); re-run `find`")
    P = l2_normalize(np.asarray([g["vector_full"] for g in gaps], np.float32))
    par = gdoc["params"]
    topk = int(topk or par["top"])
    samples = int(samples or par["samples"])
    k, band, nms, p_k2 = par["k"], par["coh_band"], par["nms"], par["p_k2"]
    min_weight = par.get("min_weight", 0.0)

    settings, spaces = [], {}
    for d in pca_list:
        for seed in seeds:
            if d == par["pca"] and seed == par["seed"]:
                continue  # that is the primary run itself
            if d not in spaces:
                sp0 = Space.fit(X, d)
                spaces[d] = (sp0, sp0.project(X))
            sp, Y = spaces[d]
            if progress:
                progress(f"stability rerun: pca {d}, seed {seed}")
            S = sample_blends(Y, samples, seed=seed, p_k2=p_k2, k=k)
            c_lo, c_hi, _, sel, U = select_gaps(Y, S, band=band, top=topk, nms=nms,
                                                min_weight=min_weight)
            Rf = blend(X, S["idx"][sel], S["w"][sel])[0]
            best = (P @ Rf.T).max(axis=1) if len(sel) else np.full(len(P), -1.0, np.float32)

            # chance level: random coherent blends in place of the top list
            rng = np.random.default_rng([seed, d, 7])
            pool = np.flatnonzero(candidate_mask(S, band, min_weight)[0])
            hits = []
            for _ in range(null_draws):
                pick = rng.choice(pool, size=min(topk, len(pool)), replace=False)
                Nf = blend(X, S["idx"][pick], S["w"][pick])[0]
                hits.append(((P @ Nf.T).max(axis=1) >= match).mean())
            settings.append({"pca": int(d), "seed": int(seed), "found": len(sel),
                             "explained_variance": round(sp.explained, 4),
                             "best_cos": [round(float(b), 4) for b in best],
                             "matched": [bool(b >= match) for b in best],
                             "null_match_rate": round(float(np.mean(hits)), 4)})
    if not settings:
        raise InputError("no reruns to do (every pca/seed pair equals the primary run)")
    M = np.array([s["matched"] for s in settings], float)
    return {"match": match, "topk": topk, "samples": samples,
            "pca": [int(d) for d in pca_list], "seeds": [int(s) for s in seeds],
            "n_reruns": len(settings),
            "stability": [round(float(v), 4) for v in M.mean(axis=0)],
            "null": round(float(np.mean([s["null_match_rate"] for s in settings])), 4),
            "settings": settings}
