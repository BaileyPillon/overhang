from __future__ import annotations

import json

import pytest

from gapfind.io import InputError, expand_inputs, load_records


def _write(path, rows):
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")


def test_extra_fields_pass_through_untouched(tmp_path):
    p = tmp_path / "a.jsonl"
    row = {"id": "a-1", "text": "Does a thing.", "title": "T", "domain": "d", "source": "s",
           "from_video": True, "nested": {"k": [1, 2]}, "n": None}
    _write(p, [row])
    (rec,) = load_records([p])
    assert rec == row


def test_glob_and_multiple_files(tmp_path):
    _write(tmp_path / "x1.jsonl", [{"id": "1", "text": "a"}])
    _write(tmp_path / "x2.jsonl", [{"id": "2", "text": "b"}])
    files = expand_inputs([str(tmp_path / "x*.jsonl"), str(tmp_path / "x1.jsonl")])
    assert [f.name for f in files] == ["x1.jsonl", "x2.jsonl"]  # no duplicates
    assert [r["id"] for r in load_records(files)] == ["1", "2"]
    with pytest.raises(InputError):
        expand_inputs([str(tmp_path / "nothing*.jsonl")])


def test_validation_and_duplicate_ids(tmp_path):
    p = tmp_path / "a.jsonl"
    _write(p, [{"id": "1", "text": "a"}, {"id": "1", "text": "b"}])
    with pytest.raises(InputError, match="duplicate"):
        load_records([p])
    assert [r["text"] for r in load_records([p], on_dup_id="keep-first")] == ["a"]
    assert [r["id"] for r in load_records([p], on_dup_id="rename")] == ["1", "1-dup2"]
    _write(p, [{"id": "1"}])
    with pytest.raises(InputError, match="no `text`"):
        load_records([p])
    _write(p, [{"text": "a"}])
    with pytest.raises(InputError, match="no `id`"):
        load_records([p])
