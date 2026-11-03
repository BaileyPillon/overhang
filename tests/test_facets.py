"""Facet co-occurrence holes: statistics, planted holes, tag robustness, hole
vectors, and the facets -> check / map plumbing. No embedding model needed:
embeddings are synthetic and `check` is fed through a stub embedder."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from gapfind import cli
from gapfind.core import l2_normalize
from gapfind.facets import (bootstrap_stability, contingency, expected, load_vocab, poisson_cdf,
                            quasi_expected,
                            resolve_axes)
from gapfind.io import InputError, read_json, write_json, write_jsonl

D = 64
MOVES = ["A", "m2", "m3", "m4", "rare-m"]
MATS = ["B", "t2", "t3", "t4", "rare-t"]
FORS = ["f1", "f2", "f3"]
P_MOVE = [0.30, 0.30, 0.20, 0.20]      # rare-m is added by hand below
P_MAT = [0.30, 0.30, 0.20, 0.20]
# deliberately empty although both marginals are large: the planted holes
HOLES = {(0, 0): "A x B", (2, 3): "m3 x t4"}


def make_corpus(seed: int = 0, n: int = 600):
    """Items with (move, material, for) tags drawn from independent marginals,
    except that cells (A,B) and (m3,t4) are forced empty. Two extra items carry
    the rare values, so the cell (rare-m, rare-t) is empty only because both
    marginals are tiny."""
    rng = np.random.default_rng(seed)
    P = np.outer(P_MOVE, P_MAT)
    for (i, j) in HOLES:
        P[i, j] = 0.0
    P /= P.sum()
    cells = rng.choice(P.size, size=n - 2, p=P.ravel())
    mi, ti = cells // 4, cells % 4
    rows = [(MOVES[i], MATS[j]) for i, j in zip(mi, ti)]
    rows += [("rare-m", "t2"), ("m2", "rare-t")]
    fors = rng.integers(0, len(FORS), size=len(rows))
    return [{"move": m, "material": t, "for": FORS[f]} for (m, t), f in zip(rows, fors)]


def vocab_doc():
    return {"axes": {"move": [{"value": v, "definition": f"move {v}"} for v in MOVES],
                     "material": [{"value": v, "definition": f"material {v}"} for v in MATS],
                     "for": [{"value": v, "definition": f"for {v}"} for v in FORS]}}


def make_run(tmp: Path, tags: list[dict], seed: int = 1):
    """A run directory with additive synthetic embeddings: each item is the sum of
    its move direction and its material direction plus noise, so a co-occurrence
    hole is also an empty spot in embedding space."""
    rng = np.random.default_rng(seed)
    um = {v: l2_normalize(rng.normal(size=D)) for v in MOVES}
    ut = {v: l2_normalize(rng.normal(size=D)) for v in MATS}
    emb = np.stack([l2_normalize(um[t["move"]] + ut[t["material"]] + 0.15 * rng.normal(size=D) / 8)
                    for t in tags]).astype(np.float32)
    items = [{"id": f"it-{i:04d}", "title": f"Item {i} ({t['move']}/{t['material']})",
              "text": f"item {i}", "domain": t["move"], "row": i} for i, t in enumerate(tags)]
    run = tmp / "run"
    run.mkdir()
    write_jsonl(run / "items.jsonl", items)
    np.save(run / "emb.npy", emb)
    np.save(run / "mean.npy", emb.mean(axis=0).astype(np.float32))
    write_json(run / "meta.json", {"model": "fake/model", "backend": None, "dim": D,
                                   "n_items": len(items), "items_path": "items.jsonl",
                                   "emb_path": "emb.npy", "mean_path": "mean.npy"})
    write_jsonl(tmp / "tags.jsonl", [dict(id=it["id"], **t) for it, t in zip(items, tags)])
    write_json(tmp / "vocab.json", vocab_doc())
    return {"run": run, "tags": tmp / "tags.jsonl", "vocab": tmp / "vocab.json", "um": um,
            "ut": ut, "items": items}


def run_facets(env, *extra):
    argv = ["facets", "--run", str(env["run"]), "--tags", str(env["tags"]),
            "--vocab", str(env["vocab"]), "--boot", "400", "--pca", "16", *extra]
    assert cli.main(argv) == 0
    return read_json(env["run"] / "holes.json")


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    return make_run(tmp_path_factory.mktemp("facets"), make_corpus())


@pytest.fixture(scope="module")
def holes(env):
    return run_facets(env)


def by_pair(doc, a, b):
    return next(p for p in doc["pairs"] if p["axes"] == [a, b])


# ------------------------------------------------------------ statistics

def test_poisson_cdf():
    assert poisson_cdf(0, 2.0) == pytest.approx(np.exp(-2.0))
    assert poisson_cdf(2, 3.0) == pytest.approx(0.4231900811, abs=1e-9)
    assert poisson_cdf(5, 0.0) == 1.0
    assert poisson_cdf(100, 3.0) == pytest.approx(1.0)


def test_contingency_and_expected():
    ca = np.array([0, 0, 1, 1, 1, -1])
    cb = np.array([0, 1, 1, 1, 0, 0])
    O = contingency(ca, cb, 2, 2)                 # the item with no row tag is skipped
    assert O.tolist() == [[1, 1], [1, 2]]
    E = expected(O)
    assert E.sum() == pytest.approx(O.sum())
    assert E[0, 1] == pytest.approx(2 * 3 / 5)


def test_bootstrap_matches_resampling_items_directly():
    O = np.array([[8, 1], [6, 20]])
    N = int(O.sum())
    rng = np.random.default_rng(3)
    fast = bootstrap_stability(O, 6000, rng)[0, 1]
    labels = np.repeat(np.arange(4), O.ravel())   # one entry per item, cell index
    hits = 0
    for _ in range(6000):
        c = np.bincount(rng.choice(labels, size=N), minlength=4).reshape(2, 2)
        E = np.outer(c.sum(axis=1), c.sum(axis=0)) / N
        hits += (c[0, 1] == 0) and (E[0, 1] >= 2)
    assert fast == pytest.approx(hits / 6000, abs=0.03)
    assert 0.2 < fast < 0.5                       # about P(the single item is lost) = 0.36


def test_bootstrap_of_a_solid_hole_and_of_a_tiny_one():
    O = np.array([[0, 100], [100, 100]])          # E[0,0] = 100*100/300 = 33
    s = bootstrap_stability(O, 500, np.random.default_rng(0))
    assert s[0, 0] == 1.0 and s[1, 1] == 0.0
    O = np.array([[0, 1], [1, 300]])              # empty, but E[0,0] = 1*1/302
    assert bootstrap_stability(O, 500, np.random.default_rng(0))[0, 0] == 0.0


def test_vocab_and_axes(env, tmp_path):
    vocab, defs = load_vocab(env["vocab"])
    assert list(vocab) == ["move", "material", "for"] and vocab["move"][0] == "A"
    assert defs[("move", "A")] == "move A"
    assert resolve_axes(vocab, None) == [("move", "material"), ("move", "for"),
                                         ("material", "for")]
    assert resolve_axes(vocab, ["move", "material"]) == [("move", "material")]
    with pytest.raises(InputError):
        resolve_axes(vocab, ["move", "colour"])
    with pytest.raises(InputError):
        resolve_axes(vocab, ["move"])
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"axes": {"move": [{"value": "a"}, {"value": "a"}]}}))
    with pytest.raises(InputError):
        load_vocab(bad)


# ------------------------------------------------------- planted holes

def test_planted_cooccurrence_hole_is_the_top_hole(holes):
    pr = by_pair(holes, "move", "material")
    top = next(g for g in holes["gaps"] if g["id"] == pr["holes"][0])
    assert top["cell"] == {"move": "A", "material": "B"}
    assert top["observed"] == 0 and top["expected"] > 20 and top["p"] < 1e-8
    assert top["stability"] > 0.9
    second = next(g for g in holes["gaps"] if g["id"] == pr["holes"][1])
    assert second["cell"] == {"move": "m3", "material": "t4"}   # the other planted hole
    assert top["expected"] >= second["expected"]                 # ranked by expected count
    assert second["stability"] > 0.9
    assert top["id"] == "hole-move-material-01"
    assert top["n_row"] > 100 and top["n_col"] > 100 and top["N"] == 600


def test_tiny_marginals_do_not_rank_high(env, holes):
    pr = by_pair(holes, "move", "material")
    cells = [next(g for g in holes["gaps"] if g["id"] == h)["cell"] for h in pr["holes"]]
    assert {"move": "rare-m", "material": "rare-t"} not in cells      # E ~ 0.002 < min-expected
    assert pr["n_empty_below_min_expected"] >= 1
    # with the floor off the cell shows up, but at the very bottom, with no stability
    doc = run_facets(env, "--min-expected", "0")
    pr0 = by_pair(doc, "move", "material")
    gaps = {g["id"]: g for g in doc["gaps"]}
    rank = [gaps[h]["cell"] for h in pr0["holes"]]
    assert {"move": "rare-m", "material": "rare-t"} in rank
    idx = rank.index({"move": "rare-m", "material": "rare-t"})
    assert idx >= len(rank) - 3
    assert gaps[pr0["holes"][idx]]["stability"] == 0.0
    assert gaps[pr0["holes"][0]]["cell"] == {"move": "A", "material": "B"}
    run_facets(env)                                                    # restore the default file


def test_thin_cells_are_reported_separately(env, tmp_path):
    tags = make_corpus(seed=5)
    # thin: (m3, t3) is expected ~24 times; keep exactly one of them
    seen = False
    for t in tags:
        if t["move"] == "m3" and t["material"] == "t3":
            if seen:
                t["material"] = "t2"
            seen = True
    env2 = make_run(tmp_path, tags)
    # under quasi-independence row m3 (almost all in two columns) is explained by its partners,
    # so thin cells are checked under plain independence
    doc = run_facets(env2, "--no-quasi")
    pr = by_pair(doc, "move", "material")
    thin = [t for t in pr["thin"] if t["cell"] == {"move": "m3", "material": "t3"}]
    assert len(thin) == 1 and thin[0]["observed"] == 1 and thin[0]["expected"] > 4
    assert all(1 <= t["observed"] <= t["expected"] / 4 + 1e-9 for t in pr["thin"])
    cells = [next(g for g in doc["gaps"] if g["id"] == h)["cell"] for h in pr["holes"]]
    assert {"move": "m3", "material": "t3"} not in cells               # thin is not a hole


def test_default_pairs_and_table_bookkeeping(holes):
    assert [p["axes"] for p in holes["pairs"]] == [["move", "material"], ["move", "for"],
                                                   ["material", "for"]]
    pr = by_pair(holes, "move", "material")
    O = np.array(pr["observed"])
    assert O.shape == (5, 5) and O.sum() == pr["N"] == 600
    assert O[0, 0] == 0 and O[2, 3] == 0
    assert holes["tagging"]["tagged"] == {"move": 600, "material": 600, "for": 600}
    assert holes["source"] == "facet" and holes["params"]["boot"] == 400


# ------------------------------------------------------- tag robustness

def test_alt_tags_decide_whether_a_hole_survives(tmp_path):
    tags = make_corpus(seed=7)
    rows, moved = [], 0
    for i, t in enumerate(tags):
        r = dict(t)
        if t["move"] == "A" and t["material"] == "t2" and moved < 40:
            r["material_alt"] = "B"          # second tagger: these 40 items are really (A, B)
            r["agree"] = {"material": False}
            moved += 1
        elif i % 3 == 0:
            r["material_alt"] = t["material"]  # second tagger agrees on every third other item
            r["agree"] = {"material": True}
        rows.append(r)
    env3 = make_run(tmp_path, tags)
    write_jsonl(env3["tags"], [dict(id=it["id"], **t) for it, t in zip(env3["items"], rows)])
    doc = run_facets(env3)
    gaps = {g["id"]: g for g in doc["gaps"]}
    pr = by_pair(doc, "move", "material")
    cells = {json.dumps(gaps[h]["cell"], sort_keys=True): gaps[h] for h in pr["holes"]}
    ab = cells[json.dumps({"move": "A", "material": "B"}, sort_keys=True)]
    m3t4 = cells[json.dumps({"move": "m3", "material": "t4"}, sort_keys=True)]
    assert ab["alt"]["observed"] == 40 and ab["alt"]["survives"] is False and ab["tag_robust"] is False
    assert m3t4["alt"]["observed"] == 0 and m3t4["alt"]["survives"] is True
    assert doc["tagging"]["alt_labels"]["material"] > 40
    assert 0 < doc["tagging"]["agreement"]["material"]["rate"] < 1
    # pairs that involve no alt labels have no alt verdict
    pr_for = by_pair(doc, "move", "for")
    assert all(gaps[h]["alt"] is None for h in pr_for["holes"])


def test_no_alt_fields_means_no_verdict(holes):
    assert all(g["alt"] is None and g["tag_robust"] is None for g in holes["gaps"])
    assert holes["tagging"]["alt_labels"] == {"move": 0, "material": 0, "for": 0}


# ----------------------------------------------- vectors and validation

def test_hole_vector_examples_and_embedding_novelty(env, holes):
    top = holes["gaps"][0]
    assert top["source"] == "facet" and len(top["vector"]) == holes["pca"]["dim"] == 16
    assert abs(np.linalg.norm(top["vector"]) - 1.0) < 1e-3
    ex = top["examples"]
    assert set(ex) == {"move", "material"} and ex["move"]["value"] == "A"
    assert ex["material"]["definition"] == "material B"
    for axis in ex.values():
        assert len(axis["items"]) == 3 and set(axis["items"][0]) == {"id", "title", "text"}
    assert all("(A/" in i["title"] for i in ex["move"]["items"])          # real A items
    assert all(i["title"].endswith("/B)") for i in ex["material"]["items"])
    # the embedding space also finds that spot empty
    assert top["percentile"] >= 90 and top["score"] > top["g1"] >= 0
    assert len(top["neighbors"]) == 8 and sum(top["domain_mix"].values()) == 8
    assert abs(sum(p["weight"] for p in top["parents"]) - 1.0) < 1e-3
    # and an ordinary populated combination does not look empty to the embedding
    assert holes["pca"]["path"] == "holes_pca.npz" and (env["run"] / "holes_pca.npz").is_file()
    assert (env["run"] / "holes_novelty.npy").is_file()


def test_check_against_hole_vectors(env, holes, monkeypatch, tmp_path):
    """`check --gaps holes` with target_gap set to a hole id; lands_in_gap against
    the hole vector. The embedder is stubbed so no model is needed."""
    um, ut = env["um"], env["ut"]
    vecs = {"at the hole": um["A"] + ut["B"],
            "populated combo": um["m2"] + ut["t2"],
            "other hole": um["m3"] + ut["t4"]}
    concepts = tmp_path / "concepts.jsonl"
    write_jsonl(concepts, [
        {"id": "at-hole", "text": "at the hole", "target_gap": "hole-move-material-01"},
        {"id": "populated", "text": "populated combo", "target_gap": "hole-move-material-01"},
        {"id": "untargeted", "text": "other hole"}])

    def stub(texts, **kw):
        return np.stack([l2_normalize(vecs[t]) for t in texts]).astype(np.float32), {}
    monkeypatch.setattr(cli, "embed_texts", stub)
    assert cli.main(["check", "--run", str(env["run"]), str(concepts), "--gaps", "holes"]) == 0
    out = env["run"] / "checks_holes.json"
    assert out.is_file() and not (env["run"] / "checks.json").exists()   # blend outputs untouched
    doc = read_json(out)
    assert doc["params"]["gaps_source"] == "facet"
    by = {c["id"]: c for c in doc["concepts"]}
    assert by["at-hole"]["lands_in_gap"] is True and by["at-hole"]["lands_basis"] == "target"
    assert by["at-hole"]["target_gap_cos"] > 0.8
    assert by["populated"]["lands_in_gap"] is False and by["populated"]["percentile"] < 90
    assert by["untargeted"]["lands_basis"] == "nearest"
    assert by["untargeted"]["nearest_gap"].startswith("hole-")
    # an unknown hole id is a clear error
    write_jsonl(concepts, [{"id": "x", "text": "at the hole", "target_gap": "hole-move-material-99"}])
    assert cli.main(["check", "--run", str(env["run"]), str(concepts), "--gaps", "holes"]) == 2


def test_show_prints_holes(env, holes, capsys):
    assert cli.main(["show", "--run", str(env["run"]), "--gaps", "holes"]) == 0
    out = capsys.readouterr().out
    assert "hole-move-material-01" in out and "A x B" in out and "stability" in out
    assert cli.main(["show", "--run", str(env["run"]), "--gaps", "holes", "--table"]) == 0
    assert capsys.readouterr().out.startswith("| hole | cell | E | p | stab |")


def test_map_draws_holes_as_their_own_marker(env, holes, tmp_path):
    from gapfind.mapviz import draw_png
    rng = np.random.default_rng(0)
    xy = rng.normal(size=(len(env["items"]), 2))
    gaps = [{"id": "gap-01", "source": "blend"}, *({"id": g["id"], "source": "facet"} for g in holes["gaps"][:4])]
    gxy = rng.normal(size=(len(gaps), 2))
    png = tmp_path / "m.png"
    draw_png(png, xy, [it["domain"] for it in env["items"]], gaps, gxy, [], np.zeros((0, 2)))
    assert png.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n" and png.stat().st_size > 10_000


def test_embed_removes_stale_holes_files():
    from gapfind.run import DERIVED
    assert {"holes.json", "holes_pca.npz", "holes_novelty.npy", "checks_holes.json",
            "map_holes.json", "map_holes.png"} <= set(DERIVED)


# ------------------------------------------------- quasi-independence

def structured_table() -> np.ndarray:
    """Row 0 ("A") puts 160 of its 200 items in column 0; the 20+20 left sit in
    columns 1-2, so (A, c3) and (A, c4) are empty. A genuine hole is planted at
    (row 3, column 2), where every other row is populated."""
    p = np.array([.3, .25, .2, .15, .1])
    O = np.zeros((5, 5), int)
    O[0] = [160, 20, 20, 0, 0]
    for i in range(1, 5):
        O[i] = np.round(100 * p).astype(int)
    O[3, 2] = 0
    O[3, 0] += 10
    O[3, 1] += 10
    return O


def ranked_holes(O, E):
    cells = [(i, j) for i in range(O.shape[0]) for j in range(O.shape[1]) if O[i, j] == 0]
    return sorted(cells, key=lambda c: (-E[c], poisson_cdf(0, E[c])))


def test_quasi_row_concentrated_in_one_column_is_not_a_run_of_holes():
    O = structured_table()
    E_indep, E_quasi, struct = quasi_expected(O)
    # plain independence ranks the other empty cells of row A first (inflated E) ...
    assert [c[0] for c in ranked_holes(O, E_indep)[:2]] == [0, 0]
    # ... quasi-independence does not: the structural cell absorbed row A's mass
    assert struct[0, 0] and struct.sum() >= 1
    top = ranked_holes(O, E_quasi)
    assert top[0] == (3, 2)
    assert E_quasi[0, 3] < 0.5 * E_indep[0, 3] and E_quasi[0, 4] < 0.5 * E_indep[0, 4]
    assert all(c[0] != 0 for c in top[:1])


def test_quasi_genuine_hole_still_ranks_first_and_keeps_its_expectation():
    O = structured_table()
    E_indep, E_quasi, _ = quasi_expected(O)
    assert ranked_holes(O, E_quasi)[0] == (3, 2)
    assert E_quasi[3, 2] > 10 and E_quasi[3, 2] >= E_indep[3, 2] - 1e-9   # not eroded by the mask
    # a table without structure is left alone
    flat = np.array([[30, 20, 10], [30, 0, 10], [60, 40, 20]])
    E0, Eq, S = quasi_expected(flat)
    assert not S.any() and np.allclose(E0, Eq)


def test_quasi_fit_properties():
    O = structured_table()
    E_indep, E, S = quasi_expected(O)
    assert np.allclose(E[S], O[S])                         # structural cells absorb exactly their mass
    free = ~S
    assert np.allclose((E * free).sum(axis=1), (O * free).sum(axis=1))   # non-structural margins
    assert np.allclose((E * free).sum(axis=0), (O * free).sum(axis=0))
    assert E.sum() == pytest.approx(O.sum())
    assert np.allclose(E_indep, expected(O))
    # a residual cap that nothing exceeds leaves independence untouched
    _, E_hi, S_hi = quasi_expected(O, z=1e6)
    assert not S_hi.any() and np.allclose(E_hi, E_indep)
    # at most 5 rounds, and an all-zero table does not blow up
    assert np.isfinite(quasi_expected(np.zeros((3, 3), int))[1]).all()


def test_bootstrap_quasi_recomputes_the_structural_set_per_resample():
    O = structured_table()
    kw = dict(min_expected=10.0)
    st_q = bootstrap_stability(O, 300, np.random.default_rng(0), quasi=True, **kw)
    st_i = bootstrap_stability(O, 300, np.random.default_rng(0), quasi=False, **kw)
    assert st_q[3, 2] > 0.7                    # the genuine hole (E ~ 17) survives resampling
    assert st_i[0, 3] > 0.9 > st_q[0, 3]       # the row-A artefact (E 20 vs 7.7) only under independence
    # quasi=False is the unchanged plain bootstrap
    assert np.array_equal(st_i, bootstrap_stability(O, 300, np.random.default_rng(0), **kw))


def tags_from_table(O):
    rng = np.random.default_rng(11)
    rows = [(MOVES[i], MATS[j]) for i in range(O.shape[0]) for j in range(O.shape[1])
            for _ in range(int(O[i, j]))]
    rng.shuffle(rows)
    return [{"move": m, "material": t, "for": FORS[int(rng.integers(3))]} for m, t in rows]


def test_pipeline_quasi_on_by_default_and_no_quasi_restores_independence(tmp_path):
    env2 = make_run(tmp_path, tags_from_table(structured_table()))
    on = run_facets(env2)
    pr = by_pair(on, "move", "material")
    gaps = {g["id"]: g for g in on["gaps"]}
    first = gaps[pr["holes"][0]]
    assert on["params"]["quasi"] is True and on["params"]["structural_z"] == 3.0
    assert first["cell"] == {"move": "m4", "material": "t3"}            # the planted hole
    assert all(gaps[h]["cell"]["move"] == "A" for h in pr["holes"][1:])   # row A's holes follow
    # output fields: per-cell tables and per-hole values
    assert np.array(pr["expected_indep"]).shape == np.array(pr["expected_quasi"]).shape == (5, 5)
    assert np.array(pr["structural"])[0, 0] and pr["n_structural"] >= 1
    assert first["structural"] is False and first["expected"] == first["expected_quasi"]
    assert first["expected_indep"] > 0
    a_hole = next(gaps[h] for h in pr["holes"] if gaps[h]["cell"] == {"move": "A", "material": "t4"})
    assert a_hole["expected_quasi"] < 0.5 * a_hole["expected_indep"]
    off = run_facets(env2, "--no-quasi")
    pr0 = by_pair(off, "move", "material")
    gaps0 = {g["id"]: g for g in off["gaps"]}
    assert off["params"]["quasi"] is False
    assert gaps0[pr0["holes"][0]]["cell"]["move"] == "A"                # inflated E wins again
    g0 = gaps0[pr0["holes"][0]]
    assert g0["expected"] == g0["expected_indep"] and g0["expected_quasi"] is None
    assert pr0["structural"] is None and pr0["n_structural"] is None
    run_facets(env2, "--structural-z", "50")                            # nothing is that extreme
    assert not any(np.array(by_pair(read_json(env2["run"] / "holes.json"), "move", "material")["structural"]).ravel())


def test_alt_survival_uses_quasi_expectation(tmp_path):
    tags = tags_from_table(structured_table())
    env2 = make_run(tmp_path, tags)
    rows = [dict(id=it["id"], **t, material_alt=t["material"]) for it, t in zip(env2["items"], tags)]
    write_jsonl(env2["tags"], rows)
    doc = run_facets(env2)
    pr = by_pair(doc, "move", "material")
    g = next(g for g in doc["gaps"] if g["id"] == pr["holes"][0])
    assert g["alt"]["survives"] is True and g["alt"]["expected"] == pytest.approx(g["expected"], abs=1e-3)
    assert "expected_indep" in g["alt"]
