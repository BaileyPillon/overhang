"""End-to-end smoke test with the real embedding model on 12 short texts.

The first run downloads BAAI/bge-base-en-v1.5 (about 200 MB) into
<repo>/.cache/models; later runs reuse it. Embeddings themselves are cached in
a fresh temp dir, so the first embed is a genuine cold run.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from gapfind import cli, embed
from gapfind.io import read_json

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(__file__).parent / "data"
MODEL_DIR = ROOT / ".cache" / "models"
SECOND_MODEL = "nomic-ai/nomic-embed-text-v1.5"  # another family; fastembed adds no prefix,
#                                                  gapfind adds "clustering: " (see embed.MODEL_PREFIXES)


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("smoke")
    lines = (DATA / "dev.jsonl").read_text(encoding="utf-8").splitlines()
    sub = lines[::3][:12]                       # 12 texts across the domains
    assert len(sub) == 12
    corpus = tmp / "smoke12.jsonl"
    corpus.write_text("\n".join(sub) + "\n", encoding="utf-8")
    return {"corpus": str(corpus), "run": tmp / "run", "cache": str(tmp / "cache"),
            "emb": ["--cache-dir", str(tmp / "cache"), "--model-dir", str(MODEL_DIR)]}


def _embed(env):
    rc = cli.main(["embed", env["corpus"], "--out", str(env["run"]), *env["emb"]])
    assert rc == 0
    return read_json(env["run"] / "meta.json")


def test_pipeline_end_to_end_and_cache(env, monkeypatch, capsys):
    run = env["run"]

    # 1. embed: cold cache, real model
    meta = _embed(env)
    assert meta["n_items"] == 12 and meta["dim"] == 768
    assert meta["model"] == "BAAI/bge-base-en-v1.5"
    assert meta["cache"] == {"unique": 12, "cache_hits": 0, "cache_misses": 12}
    emb = np.load(run / "emb.npy")
    assert emb.shape == (12, 768)
    assert np.allclose(np.linalg.norm(emb, axis=1), 1.0, atol=1e-4)
    mean = np.load(run / meta["mean_path"])
    assert np.allclose(mean, emb.mean(axis=0), atol=1e-5)
    items = [json.loads(line) for line in (run / "items.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [it["row"] for it in items] == list(range(12))
    assert items[0]["domain"] == "devices-home" and items[0]["source"] == "hand-written"

    # 2. second embed hits the cache for every text and never loads a model
    def no_model(*a, **k):
        raise AssertionError("model was loaded although every text is cached")
    monkeypatch.setattr(embed, "load_backend", no_model)
    meta2 = _embed(env)
    assert meta2["cache"] == {"unique": 12, "cache_hits": 12, "cache_misses": 0}
    assert np.array_equal(np.load(run / "emb.npy"), emb)
    monkeypatch.undo()

    # 3. find (small S)
    assert cli.main(["find", "--run", str(run), "--samples", "3000", "--top", "5",
                     "--seed", "42"]) == 0
    out = capsys.readouterr().out
    assert "gap-01" in out and "emptier than" in out
    gaps = read_json(run / "gaps.json")
    assert len(gaps["gaps"]) >= 2
    g1 = gaps["gaps"][0]
    assert gaps["pca"]["dim"] == 11                     # --pca 32 is clipped to n-1 = 11 axes
    assert len(g1["vector"]) == 11 and len(g1["vector_full"]) == 768 and len(g1["neighbors"]) == 8
    assert g1["parents"][0]["id"].startswith("dev-")
    assert g1["g1"] <= g1["score"] and g1["stability"] is None
    assert (run / "pca.npz").is_file() and (run / "novelty.npy").is_file()

    # 3b. stability: re-run under other PCA dimensions and seeds
    assert cli.main(["stability", "--run", str(run), "--pca", "4", "8", "--seeds", "1", "2",
                     "--samples", "2000", "--topk", "3"]) == 0
    capsys.readouterr()
    gaps = read_json(run / "gaps.json")
    assert all(0.0 <= g["stability"] <= 1.0 for g in gaps["gaps"])
    assert gaps["stability_run"]["n_reruns"] == 4
    assert len(read_json(run / "stability.json")["settings"]) == 4
    assert cli.main(["show", "--run", str(run), "--table"]) == 0
    table = capsys.readouterr().out
    assert table.startswith("| gap | pct | stab |") and "| gap-01 |" in table
    assert cli.main(["show", "--run", str(run)]) == 0
    assert "stability" in capsys.readouterr().out

    # 4. check (concepts: one with target gap-01, one with gap-02, one untargeted)
    assert cli.main(["check", "--run", str(run), str(DATA / "concepts.jsonl"), *env["emb"]]) == 0
    out = capsys.readouterr().out
    assert "concepts land in a gap" in out
    checks = read_json(run / "checks.json")["concepts"]
    assert [c["id"] for c in checks] == ["c-near", "c-between", "c-odd"]
    assert all(isinstance(c["lands_in_gap"], bool) for c in checks)
    assert checks[0]["target_gap_cos"] is not None and checks[1]["target_gap_cos"] is None
    assert all(len(c["nearest_items"]) == 5 for c in checks)
    # the concept that paraphrases an existing item sits right on top of it
    assert checks[0]["percentile"] < 90 and checks[0]["lands_in_gap"] is False

    # 4b. cross-model check: novelty percentile under a second model of another family
    assert cli.main(["check", "--run", str(run), str(DATA / "concepts.jsonl"),
                     "--models", f"BAAI/bge-base-en-v1.5,{SECOND_MODEL}", *env["emb"]]) == 0
    out = capsys.readouterr().out
    assert "percentile by model" in out and "nomic-embed-text-v1.5" in out
    doc = read_json(run / "checks.json")
    assert doc["params"]["cross_model"]["primary"] == "BAAI/bge-base-en-v1.5"
    for c, c0 in zip(doc["concepts"], checks):
        assert set(c["by_model"]) == {"BAAI/bge-base-en-v1.5", SECOND_MODEL}
        assert c["by_model"]["BAAI/bge-base-en-v1.5"]["percentile"] == c0["percentile"]
        assert 0.0 <= c["by_model"][SECOND_MODEL]["percentile"] <= 100.0
        assert c["lands_in_gap"] == c0["lands_in_gap"]      # still defined by the primary model

    # 5. map
    assert cli.main(["map", "--run", str(run), "--concepts", str(DATA / "concepts.jsonl"),
                     *env["emb"]]) == 0
    mp = read_json(run / "map.json")
    assert mp["params"]["space_dim"] == 11                   # same working space as find
    assert len(mp["points"]) == 12
    assert all({"x", "y", "id", "domain", "row"} <= set(p) for p in mp["points"])
    assert len(mp["gaps"]) == len(gaps["gaps"])
    assert {"id", "score", "percentile", "x", "y", "parents", "neighbors"} <= set(mp["gaps"][0])
    assert [c["id"] for c in mp["concepts"]] == ["c-near", "c-between", "c-odd"]
    assert all(isinstance(c["lands_in_gap"], bool) for c in mp["concepts"])
    png = run / "map.png"
    assert png.stat().st_size > 10_000
    assert png.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"

    # 6. facet holes on the same run: tags -> holes.json -> check / map with --gaps holes
    items = [json.loads(line) for line in (run / "items.jsonl").read_text(encoding="utf-8").splitlines()]
    tag_rows = [{"id": it["id"], "move": "A" if i < 6 else "B", "material": "X" if i < 6 else "Y",
                 "for": "P" if i % 2 == 0 else "Q"} for i, it in enumerate(items)]
    tags_path, vocab_path = run.parent / "tags.jsonl", run.parent / "vocab.json"
    tags_path.write_text("\n".join(json.dumps(r) for r in tag_rows) + "\n", encoding="utf-8")
    vocab_path.write_text(json.dumps({"axes": {
        "move": [{"value": "A", "definition": "a"}, {"value": "B", "definition": "b"}],
        "material": [{"value": "X", "definition": "x"}, {"value": "Y", "definition": "y"}],
        "for": [{"value": "P", "definition": "p"}, {"value": "Q", "definition": "q"}]}}),
        encoding="utf-8")
    assert cli.main(["facets", "--run", str(run), "--tags", str(tags_path), "--vocab",
                     str(vocab_path), "--boot", "200"]) == 0
    capsys.readouterr()
    holes = read_json(run / "holes.json")
    assert holes["params"]["space_from"] == "gaps.json"       # same PCA and k as find
    assert holes["pca"]["dim"] == 11 and len(holes["gaps"][0]["vector"]) == 11
    cells = {(g["cell"]["move"], g["cell"]["material"]) for g in holes["gaps"]
             if g["axes"] == ["move", "material"]}
    assert cells == {("A", "Y"), ("B", "X")}                    # the two planted empty cells
    assert all(g["stability"] > 0.5 and 0 <= g["percentile"] <= 100 for g in holes["gaps"])
    hole_concepts = run.parent / "hole_concepts.jsonl"
    hole_concepts.write_text("\n".join(json.dumps(c) for c in [
        {"id": "h1", "text": "Reads a lab notebook and drafts a recipe card from it.",
         "target_gap": "hole-move-material-01"},
        {"id": "h2", "text": "Sorts scanned receipts into expense categories."}]) + "\n",
        encoding="utf-8")
    assert cli.main(["check", "--run", str(run), str(hole_concepts), "--gaps", "holes", "--models",
                     f"BAAI/bge-base-en-v1.5,{SECOND_MODEL}", *env["emb"]]) == 0
    hc = read_json(run / "checks_holes.json")
    assert hc["params"]["gaps_source"] == "facet"
    assert all(isinstance(c["lands_in_gap"], bool) for c in hc["concepts"])
    assert hc["concepts"][0]["target_gap_cos"] is not None
    assert all(set(c["by_model"]) == {"BAAI/bge-base-en-v1.5", SECOND_MODEL} for c in hc["concepts"])
    assert read_json(run / "checks.json")["params"]["gaps_source"] == "blend"   # untouched
    assert cli.main(["map", "--run", str(run), "--gaps", "holes", "--concepts", str(hole_concepts),
                     *env["emb"]]) == 0
    mh = read_json(run / "map_holes.json")
    assert {g["source"] for g in mh["gaps"]} == {"facet"} and len(mh["gaps"]) == len(holes["gaps"])
    assert (run / "map_holes.png").stat().st_size > 10_000
    assert (run / "map.png").is_file()                          # the blend map is still there


def test_module_entry_point_runs():
    r = subprocess.run([sys.executable, "-m", "gapfind", "--help"], capture_output=True,
                       text=True, encoding="utf-8", cwd=ROOT)
    assert r.returncode == 0
    for cmd in ("embed", "find", "facets", "stability", "check", "map"):
        assert cmd in r.stdout
