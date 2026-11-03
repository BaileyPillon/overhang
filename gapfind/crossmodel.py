"""Cross-model check: does a concept look novel to more than one embedding model?

For each model the whole pipeline is redone on its own embeddings (cached):
embed the corpus and the concepts, center with that model's corpus mean, fit
PCA with the same dimension, and compare each concept's k-NN distance with the
corpus items' leave-one-out k-NN distances in that model's space. Gaps are not
involved; `lands_in_gap` stays defined in the primary model only.
"""

from __future__ import annotations

import numpy as np

from .core import Space, center, concept_novelty, loo_knn_distance
from .embed import embed_texts


def novelty_by_model(corpus_texts: list[str], concept_texts: list[str], models: list[str], *,
                     pca: int, k: int, **embed_kw) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for m in models:
        ec, _ = embed_texts(corpus_texts, model=m, **embed_kw)
        eq, _ = embed_texts(concept_texts, model=m, **embed_kw)
        mean = ec.mean(axis=0)
        Xc, Zc = center(ec, mean), center(eq, mean)
        space = Space.fit(Xc, pca)
        Y, Zs = space.project(Xc), space.project(Zc)
        kk = max(1, min(k, len(Y) - 1))
        d = np.sort(loo_knn_distance(Y, kk))
        score, pct = concept_novelty(Zs, Y, d, kk)
        out[m] = {"dim": int(ec.shape[1]), "pca": space.dim,
                  "explained_variance": round(space.explained, 4),
                  "score": [round(float(v), 6) for v in score],
                  "percentile": [round(float(v), 2) for v in pct]}
    return out
