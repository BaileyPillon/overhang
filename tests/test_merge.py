"""scripts/merge_corpus.py: validation and near-duplicate detection (no model)."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import numpy as np

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "merge_corpus.py"
spec = importlib.util.spec_from_file_location("merge_corpus", SCRIPT)
merge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(merge)

GOOD = ("Connects to a living-room television over a debugging bridge, strips the launcher "
        "advertisements, and shows a live calendar and weather dashboard instead.")


def _row(**kw):
    r = {"id": "devices-001", "title": "Ad-free TV dashboard", "text": GOOD,
         "domain": "devices-home", "source": "https://example.com/a", "who": None,
         "date": "2026-10", "from_video": False, "confidence": "seen",
         "__file__": "devices.jsonl", "__line__": 1}
    r.update(kw)
    return r


def test_valid_row_passes():
    errors, warnings = merge.validate([_row()])
    assert errors == [] and warnings == []


def test_hard_errors():
    errors, _ = merge.validate([
        _row(),
        _row(__line__=2),                          # duplicate id
        _row(id="devices-002", domain="gadgets"),  # domain not in the schema list
        _row(id="devices-003", text=""),           # no text
        {"text": GOOD, "__file__": "devices.jsonl", "__line__": 5},  # no id
    ])
    joined = "\n".join(errors)
    assert "duplicate id devices-001" in joined
    assert "'gadgets'" in joined
    assert "missing text" in joined
    assert "missing id" in joined


def test_style_problems_are_warnings_not_errors():
    errors, warnings = merge.validate([
        _row(text="Uses an AI model to sort the inbox."),                       # banned words + short
        _row(id="devices-002", title="one two three four five six seven eight nine"),
        _row(id="other-003", source=None, confidence="maybe", date="Oct 2026"),
    ])
    assert errors == []
    kinds = {k for k, _ in warnings}
    assert any("names the tool" in k for k in kinds)
    assert any("15-35" in k for k in kinds)
    assert any("title longer" in k for k in kinds)
    assert any("no source" in k for k in kinds)
    assert any("confidence" in k for k in kinds)
    assert any("YYYY-MM" in k for k in kinds)
    assert any("file name" in k for k in kinds)


def test_near_duplicates_sorted_and_thresholded():
    rng = np.random.default_rng(0)
    base = rng.normal(size=(5, 32))
    near = base[1] + 0.05 * rng.normal(size=32)           # cos with base[1] ~ 0.999
    mid = base[3] + 0.6 * rng.normal(size=32)             # cos with base[3] ~ 0.85
    E = np.vstack([base, near, mid]).astype(np.float32)
    E /= np.linalg.norm(E, axis=1, keepdims=True)
    pairs = merge.near_duplicates(E, 0.92)
    assert [(i, j) for i, j, _ in pairs] == [(1, 5)]
    assert pairs[0][2] > 0.99
    loose = merge.near_duplicates(E, 0.5)
    assert (1, 5) in {(i, j) for i, j, _ in loose} and (3, 6) in {(i, j) for i, j, _ in loose}
    assert [c for _, _, c in loose] == sorted((c for _, _, c in loose), reverse=True)


def test_main_merges_and_writes_untouched_fields(tmp_path, monkeypatch):
    raw = tmp_path / "raw"
    raw.mkdir()
    rows_a = [{k: v for k, v in _row(id=f"a-{i:03d}").items() if not k.startswith("__")}
              for i in (1, 2)]
    rows_b = [{k: v for k, v in _row(id="b-001", extra={"k": [1]}).items() if not k.startswith("__")}]
    (raw / "a.jsonl").write_text("\n".join(json.dumps(r) for r in rows_a) + "\n", encoding="utf-8")
    (raw / "b.jsonl").write_text("\n".join(json.dumps(r) for r in rows_b) + "\n", encoding="utf-8")
    out = tmp_path / "corpus.jsonl"
    rc = merge.main(["--raw-dir", str(raw), "--out", str(out), "--no-dupes"])
    assert rc == 0
    merged = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
    assert merged == rows_a + rows_b                       # concatenated, fields untouched

    # a hard error writes nothing
    (raw / "c.jsonl").write_text(json.dumps({"id": "c-001", "text": GOOD, "domain": "nope"}) + "\n",
                                 encoding="utf-8")
    out2 = tmp_path / "corpus2.jsonl"
    assert merge.main(["--raw-dir", str(raw), "--out", str(out2), "--no-dupes"]) == 1
    assert not out2.exists()
