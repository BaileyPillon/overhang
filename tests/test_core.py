"""Geometry tests on synthetic data (no embedding model needed)."""

from __future__ import annotations

import numpy as np
import pytest

from gapfind.core import (Space, center, check_concepts, find_gaps, knn_score, l2_normalize,
                          loo_knn_distance, loo_nn_distance, percentile_of, resolve_band,
                          resolve_gap, sample_blends)
from gapfind.io import InputError
from gapfind.stability import run_stability

K = 5
PCA = 32


@pytest.fixture(scope="module")
def found(planted):
    space = Space.fit(planted.X, PCA)
    doc, d_knn = find_gaps(planted.X, planted.items, samples=30000, top=6, seed=42,
                           coh_q=0.5, nms=0.25, k=K, space=space)
    return doc, d_knn, space


def _vec(g, key="vector"):
    return np.asarray(g[key], np.float32)


def test_top_gap_is_the_planted_hole(planted, found):
    doc, _, space = found
    top = _vec(doc["gaps"][0])
    Y_hole = space.project(planted.hole[None])[0]
    Y_centers = space.project(planted.centers)
    to_hole = float(top @ Y_hole)
    to_centers = Y_centers @ top
    assert to_hole > to_centers.max(), (to_hole, to_centers)
    assert to_hole > 0.9
    # the full-dimension version of the same gap (same parents, same weights) agrees
    full = _vec(doc["gaps"][0], "vector_full")
    assert float(full @ planted.hole) > (planted.centers @ full).max()
    # and it is a real hole: emptier than the space around nearly all items
    assert doc["gaps"][0]["percentile"] >= 95
    assert doc["gaps"][0]["score"] > 1.5 * doc["gaps"][1]["score"]


def test_top_gap_is_the_hole_in_other_dimensions(planted):
    for pca in (0, 16):
        doc, _ = find_gaps(planted.X, planted.items, samples=20000, top=3, seed=3, pca=pca,
                           nms=0.1)
        full = _vec(doc["gaps"][0], "vector_full")
        assert float(full @ planted.hole) > (planted.centers @ full).max(), pca
        assert doc["pca"]["dim"] == pca


def test_blend_in_populated_bridge_scores_lower_than_in_empty_bridge(planted, found):
    """The degeneracy k-NN scoring fixes: two 2-parent blends of equally
    distant parents, one across a bridge full of other items, one across an
    empty bridge. The score must ask whether anything *else* lives nearby."""
    doc, d_knn, space = found
    Y = space.project(planted.X)

    def blend_scores(pair):
        u = l2_normalize(Y[pair[0]] + Y[pair[1]])[None]
        g_k, g1 = knn_score(u, Y, K)
        return float(g_k[0]), float(g1[0])

    # the two bridges have comparable widths (about 110 and 105 degrees between parents)
    sep = lambda p: float(planted.raw[p[0]] @ planted.raw[p[1]])  # noqa: E731
    assert abs(sep(planted.pair_empty) - sep(planted.pair_populated)) < 0.15

    g_pop, g1_pop = blend_scores(planted.pair_populated)
    g_emp, g1_emp = blend_scores(planted.pair_empty)
    assert g_pop < g_emp
    assert g_emp > 2 * g_pop, (g_pop, g_emp)
    # and measured against the corpus's own k-NN novelty scale the empty bridge is
    # far out in the tail while the populated one is ordinary
    d_sorted = np.sort(d_knn)
    assert percentile_of(d_sorted, g_emp) > 95
    assert percentile_of(d_sorted, g_pop) < percentile_of(d_sorted, g_emp)
    assert g1_pop < g1_emp                                   # 1-NN agrees on the ordering here


def test_knn_score_sees_past_the_parents():
    """Where 1-NN is blind: a blend of two close items that live alone in an
    otherwise empty region has a tiny 1-NN distance (its parents), the same as
    a blend of two neighbors inside a dense cluster. Only the k-NN score
    notices that nothing else lives near the isolated pair."""
    rng = np.random.default_rng(5)
    D = 64
    base = np.eye(D)[:2]                                       # two far-apart directions
    dense = l2_normalize(base[0] + 0.3 * rng.normal(size=(200, D)) / np.sqrt(D))
    lone_dir = base[1]
    lone = l2_normalize(lone_dir + 0.3 * rng.normal(size=(2, D)) / np.sqrt(D))
    Y = np.vstack([dense, lone]).astype(np.float32)
    u_dense = l2_normalize(Y[0] + Y[1])[None]                  # parents inside the dense cluster
    u_lone = l2_normalize(Y[200] + Y[201])[None]               # the isolated pair
    gk_d, g1_d = knn_score(u_dense, Y, K)
    gk_l, g1_l = knn_score(u_lone, Y, K)
    assert float(g1_l[0]) < 0.1 and float(g1_d[0]) < 0.1       # 1-NN: both look fully occupied
    assert float(gk_l[0]) > 3 * float(gk_d[0])                 # k-NN: only the dense one is


def test_top_gaps_are_mutually_distinct_after_nms(planted, found):
    doc, _, space = found
    nms = doc["params"]["nms"]
    V = np.stack([_vec(g) for g in doc["gaps"]])
    assert len(V) >= 3
    sims = V @ V.T
    np.fill_diagonal(sims, -1.0)
    assert (1.0 - sims.max()) >= nms - 1e-4
    # without suppression the same search returns near-duplicates of the best gap
    raw, _ = find_gaps(planted.X, planted.items, samples=30000, top=6, seed=42, nms=0.0,
                       space=space)
    R = np.stack([_vec(g) for g in raw["gaps"]])
    rs = R @ R.T
    np.fill_diagonal(rs, -1.0)
    assert (1.0 - rs.max()) < 0.01 < nms


def test_gap_record_fields(planted, found):
    doc, d_knn, space = found
    g = doc["gaps"][0]
    assert g["id"] == "gap-01"
    assert set(g) >= {"id", "score", "g1", "percentile", "blend_percentile", "coherence",
                      "stability", "parents", "neighbors", "domain_mix", "vector",
                      "vector_full"}
    assert g["stability"] is None                       # filled in by `stability`
    assert len(g["vector"]) == PCA                      # working-space vector (for check)
    assert len(g["vector_full"]) == planted.X.shape[1]  # full centered blend (for stability)
    assert abs(np.linalg.norm(_vec(g)) - 1.0) < 1e-3
    assert abs(np.linalg.norm(_vec(g, "vector_full")) - 1.0) < 1e-3
    assert len(g["neighbors"]) == 8
    assert set(g["neighbors"][0]) >= {"id", "title", "domain", "cos"}
    assert sum(g["domain_mix"].values()) == 8
    assert abs(sum(p["weight"] for p in g["parents"]) - 1.0) < 1e-3
    assert all(set(p) >= {"id", "title", "text", "weight"} for p in g["parents"])
    cos = [n["cos"] for n in g["neighbors"]]
    assert cos == sorted(cos, reverse=True)
    assert abs(g["g1"] - (1 - cos[0])) < 1e-3                  # g1 is the 1-NN distance
    assert abs(g["score"] - (1 - np.mean(cos[:K]))) < 1e-3     # score is the k-NN distance
    assert g["score"] >= g["g1"]
    # params and pca bookkeeping
    assert doc["params"]["k"] == K and doc["params"]["pca"] == PCA
    assert doc["params"]["coh_band"] == [0.5, 0.8]             # --coh-q only moved the lower edge
    assert 0 < doc["pca"]["explained_variance"] <= 1
    assert doc["novelty"]["k"] == K


def test_gap_scores_are_knn_and_percentile_uses_matching_scale(planted, found):
    doc, d_knn, space = found
    Y = space.project(planted.X)
    assert np.allclose(d_knn, loo_knn_distance(Y, K), atol=1e-6)
    ds = np.sort(d_knn)
    for g in doc["gaps"]:
        u = _vec(g)[None]
        g_k, g1 = knn_score(u, Y, K)
        assert g["score"] == pytest.approx(float(g_k[0]), abs=2e-4)
        assert g["g1"] == pytest.approx(float(g1[0]), abs=2e-4)
        assert g["percentile"] == pytest.approx(float(percentile_of(ds, g["score"])), abs=0.02)


def test_deterministic(planted):
    a, _ = find_gaps(planted.X, planted.items, samples=5000, top=4, seed=7)
    b, _ = find_gaps(planted.X, planted.items, samples=5000, top=4, seed=7)
    c, _ = find_gaps(planted.X, planted.items, samples=5000, top=4, seed=8)
    for d in (a, b, c):
        d["sampling"].pop("seconds")
    assert a == b
    assert a != c


def test_sampler_properties(planted):
    S = sample_blends(planted.X, 5000, seed=1, p_k2=0.6, batch=999)  # odd batch size on purpose
    assert S["idx"].shape == (5000, 3) and S["w"].shape == (5000, 3)
    assert np.allclose(S["w"].sum(axis=1), 1.0, atol=1e-5)
    three = S["w"][:, 2] > 0
    assert 0.35 < three.mean() < 0.45                      # k=3 with p=0.4
    i = S["idx"]
    assert (i[:, 0] != i[:, 1]).all()                      # distinct parents
    assert (i[three, 2] != i[three, 0]).all() and (i[three, 2] != i[three, 1]).all()
    assert (S["c"] > 0).all() and (S["c"] <= 1 + 1e-5).all()
    assert (S["g"] >= 0).all()
    S5 = sample_blends(planted.X, 2000, seed=1, k=5)
    assert (S5["g"] >= S5["g1"] - 1e-6).all()              # mean of k distances >= the nearest


def test_novelty_scale_and_percentile(planted):
    X = planted.X[:200]
    d = loo_nn_distance(X)
    sims = X @ X.T
    np.fill_diagonal(sims, -np.inf)
    assert np.allclose(d, 1 - sims.max(axis=1), atol=1e-5)
    # k-NN version, brute force
    d3 = loo_knn_distance(X, 3)
    top3 = -np.sort(-sims, axis=1)[:, :3]
    assert np.allclose(d3, 1 - top3.mean(axis=1), atol=1e-5)
    ds = np.sort(d)
    assert percentile_of(ds, ds.min() - 1e-3) == 0.0
    assert percentile_of(ds, ds.max() + 1e-3) == 100.0
    assert percentile_of(ds, np.median(ds)) == pytest.approx(50.0, abs=1.0)


def test_centering_removes_anisotropy(planted):
    raw_cos = planted.raw @ planted.raw.T
    c_cos = planted.X @ planted.X.T
    assert abs(c_cos.mean()) < abs(raw_cos.mean())
    assert np.allclose(np.linalg.norm(planted.X, axis=1), 1.0, atol=1e-5)


def test_pca_space(planted, tmp_path):
    sp = Space.fit(planted.X, 16)
    assert sp.dim == 16 and sp.components.shape == (16, planted.X.shape[1])
    assert np.allclose(sp.components @ sp.components.T, np.eye(16), atol=1e-5)  # orthonormal
    assert 0.5 < sp.explained < 1.0
    assert Space.fit(planted.X, 32).explained > sp.explained                    # monotone
    Y = sp.project(planted.X)
    assert Y.shape == (len(planted.X), 16)
    assert np.allclose(np.linalg.norm(Y, axis=1), 1.0, atol=1e-5)
    sp.save(tmp_path / "pca.npz")
    sp2 = Space.load(tmp_path / "pca.npz")
    assert np.array_equal(sp2.components, sp.components) and sp2.explained == sp.explained
    assert np.array_equal(sp2.project(planted.X), Y)                            # identical projection
    full = Space.fit(planted.X, 0)
    assert full.dim == 0 and full.explained == 1.0
    assert np.allclose(full.project(planted.X), planted.X, atol=1e-5)
    assert np.array_equal(Space.fit(planted.X, 16).components, sp.components)    # deterministic


def test_coherence_band(planted):
    assert resolve_band() == (0.3, 0.8)
    assert resolve_band([0.2, 0.9]) == (0.2, 0.9)
    assert resolve_band(None, 0.5) == (0.5, 0.8)            # --coh-q sets only the lower edge
    assert resolve_band([0.2, 0.9], 0.5) == (0.5, 0.9)
    with pytest.raises(InputError):
        resolve_band([0.8, 0.3])
    doc, _ = find_gaps(planted.X, planted.items, samples=8000, top=5, seed=2,
                       coh_band=[0.4, 0.6])
    lo, hi = doc["sampling"]["coherence_range"]
    assert doc["params"]["coh_band"] == [0.4, 0.6]
    assert all(lo - 1e-4 <= g["coherence"] <= hi + 1e-4 for g in doc["gaps"])
    assert abs(doc["sampling"]["kept"] - 0.2 * 8000) < 40


def test_check_concept_at_hole_lands_and_cluster_does_not(planted, found):
    doc, d_knn, space = found
    ds = np.sort(d_knn)
    raw_concepts = np.stack([planted.raw_hole,              # exactly the planted hole center
                             planted.raw_hole,              # same, but no target_gap given
                             planted.raw_centers[0],        # on a cluster
                             planted.raw_centers[5]])       # on another cluster, wrong target
    Zs = space.project(center(raw_concepts, planted.mean))
    Y = space.project(planted.X)
    concepts = [{"id": "hole", "text": "x", "target_gap": "gap-01"},
                {"id": "hole-untargeted", "text": "x"},
                {"id": "cluster", "text": "x", "target_gap": "gap-01"},
                {"id": "cluster-b", "text": "x", "target_gap": "gap-01"}]
    res = check_concepts(Zs, concepts, Y, planted.items, doc["gaps"], ds, k=K)
    by = {r["id"]: r for r in res}

    assert by["hole"]["lands_in_gap"] is True
    assert by["hole"]["target_gap_cos"] > 0.9
    assert by["hole"]["nearest_gap"] == "gap-01"
    assert by["hole"]["percentile"] >= 90
    assert by["hole"]["lands_basis"] == "target"
    assert by["hole"]["score"] >= by["hole"]["g1"]

    assert by["hole-untargeted"]["lands_in_gap"] is True
    assert by["hole-untargeted"]["lands_basis"] == "nearest"
    assert by["hole-untargeted"]["target_gap_cos"] is None

    for k in ("cluster", "cluster-b"):
        assert by[k]["lands_in_gap"] is False
        assert by[k]["percentile"] < 90
        assert by[k]["nearest_items"][0]["cos"] > 0.8
        assert by[k]["target_gap_cos"] < 0.5

    # nearest items are sorted and carry the corpus fields
    ni = by["hole"]["nearest_items"]
    assert [n["cos"] for n in ni] == sorted((n["cos"] for n in ni), reverse=True)
    assert set(ni[0]) >= {"id", "title", "domain", "cos"}


def test_resolve_gap():
    ids = ["gap-01", "gap-02", "gap-10"]
    assert resolve_gap("gap-02", ids) == 1
    assert resolve_gap("gap-2", ids) == 1
    assert resolve_gap(10, ids) == 2
    assert resolve_gap("3", ["gap-03"]) == 0
    with pytest.raises(InputError):
        resolve_gap("gap-07", ids)


def test_stability_of_the_planted_hole(planted, found):
    doc, _, _ = found
    res = run_stability(planted.X, doc, pca_list=[16, 32], seeds=[1, 2], match=0.8,
                        topk=6, samples=20000)
    assert res["n_reruns"] == 4
    assert len(res["stability"]) == len(doc["gaps"])
    assert res["stability"][0] == 1.0          # the planted hole is found every time
    assert all(0.0 <= s <= 1.0 for s in res["stability"])
    assert 0.0 <= res["null"] < res["stability"][0]   # chance level is below the hole's score
    assert all(len(s["best_cos"]) == len(doc["gaps"]) for s in res["settings"])
    with pytest.raises(InputError):            # every setting equal to the primary: nothing to do
        run_stability(planted.X, doc, pca_list=[32], seeds=[42], match=0.8)


def test_min_weight_drops_lopsided_blends(planted):
    from gapfind.core import candidate_mask
    S = sample_blends(planted.X, 6000, seed=4)
    m0, _, _ = candidate_mask(S, (0.0, 1.0))
    m3, _, _ = candidate_mask(S, (0.0, 1.0), min_weight=0.3)
    assert m0.all() and 0 < m3.sum() < m0.sum()
    w = np.where(S["w"] > 0, S["w"], np.inf).min(axis=1)
    assert (w[m3] >= 0.3).all() and (w[~m3] < 0.3).all()
    doc, _ = find_gaps(planted.X, planted.items, samples=20000, top=5, seed=2, min_weight=0.3)
    assert doc["params"]["min_weight"] == 0.3
    for g in doc["gaps"]:
        assert min(p["weight"] for p in g["parents"]) >= 0.3 - 1e-3
