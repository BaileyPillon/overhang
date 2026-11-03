"""Cross-model novelty plumbing, with a fake embedder (no model download).
The real second model is exercised in test_smoke.py."""

from __future__ import annotations

import hashlib

import numpy as np

from gapfind import crossmodel
from gapfind.core import Space, center, concept_novelty, loo_knn_distance


def _rng(*parts):
    h = hashlib.sha256("|".join(parts).encode()).digest()
    return np.random.default_rng(int.from_bytes(h[:8], "little"))


def fake_embed(texts, *, model, **kw):
    """'topic|name' -> a model-specific topic direction plus per-text noise."""
    out = []
    for t in texts:
        topic = t.split("|")[0]
        v = _rng(model, "topic", topic).normal(size=48) + 0.25 * _rng(model, t).normal(size=48)
        out.append(v / np.linalg.norm(v))
    return np.asarray(out, np.float32), {"cache_hits": 0, "cache_misses": len(texts)}


def test_novelty_by_model_reports_each_model(monkeypatch):
    monkeypatch.setattr(crossmodel, "embed_texts", fake_embed)
    corpus = [f"{t}|{i}" for t in "ABC" for i in range(40)]
    concepts = ["A|brand-new-phrasing", "Z|an-entirely-new-topic"]
    models = ["fake/one", "fake/two"]
    res = crossmodel.novelty_by_model(corpus, concepts, models, pca=16, k=5)
    assert list(res) == models
    for m in models:
        r = res[m]
        assert len(r["score"]) == len(r["percentile"]) == 2
        assert r["pca"] == 16 and 0 < r["explained_variance"] <= 1
        assert r["percentile"][0] < 90          # a new phrasing of a known topic is ordinary
        assert r["percentile"][1] >= 90         # an unseen topic is far out in the tail
        assert r["score"][1] > r["score"][0]
    # same pipeline run by hand gives the same numbers
    ec, _ = fake_embed(corpus, model="fake/one")
    eq, _ = fake_embed(concepts, model="fake/one")
    mean = ec.mean(axis=0)
    sp = Space.fit(center(ec, mean), 16)
    Y, Z = sp.project(center(ec, mean)), sp.project(center(eq, mean))
    d = np.sort(loo_knn_distance(Y, 5))
    g, pct = concept_novelty(Z, Y, d, 5)
    assert np.allclose(res["fake/one"]["score"], g, atol=1e-5)
    assert np.allclose(res["fake/one"]["percentile"], pct, atol=0.01)
