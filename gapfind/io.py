"""JSONL reading/writing and input expansion. All files are UTF-8."""

from __future__ import annotations

import glob
import json
import os
from pathlib import Path
from typing import Iterable


class InputError(ValueError):
    """Bad user input (missing field, duplicate id, unknown gap, ...)."""


def expand_inputs(patterns: Iterable[str]) -> list[Path]:
    """Expand file names and globs (Windows shells do not) into a
    de-duplicated list of existing files. Order: pattern order, then name."""
    out: list[Path] = []
    seen: set[str] = set()
    for pat in patterns:
        pat = str(pat)
        hits = sorted(glob.glob(pat, recursive=True)) if glob.has_magic(pat) else [pat]
        if not hits:
            raise InputError(f"no files match {pat!r}")
        for h in hits:
            p = Path(h)
            if not p.is_file():
                raise InputError(f"not a file: {h}")
            key = os.path.normcase(str(p.resolve()))
            if key not in seen:
                seen.add(key)
                out.append(p)
    return out


def read_jsonl(path: str | Path) -> list[dict]:
    """Read one JSON object per line. Each dict gets a private `__src__`
    (path, line) entry for error messages; load_records strips it."""
    rows: list[dict] = []
    with open(path, "r", encoding="utf-8-sig") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                raise InputError(f"{path}:{ln}: invalid JSON ({e})") from None
            if not isinstance(obj, dict):
                raise InputError(f"{path}:{ln}: expected a JSON object per line")
            obj["__src__"] = (str(path), ln)
            rows.append(obj)
    return rows


def write_jsonl(path: str | Path, rows: Iterable[dict]) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def write_json(path: str | Path, obj) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")


def read_json(path: str | Path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_records(paths: Iterable[str | Path], *, kind: str = "item",
                 on_dup_id: str = "error") -> list[dict]:
    """Read JSONL files, require non-empty `id` and `text`, keep every other
    field untouched. `on_dup_id`: error | keep-first | rename (suffix -dupN)."""
    recs: list[dict] = []
    seen: dict[str, tuple[str, int]] = {}
    dups: list[str] = []
    for p in paths:
        for obj in read_jsonl(p):
            src, ln = obj.pop("__src__")
            where = f"{src}:{ln}"
            if "id" not in obj or obj["id"] in (None, ""):
                raise InputError(f"{where}: {kind} has no `id`")
            text = obj.get("text")
            if not isinstance(text, str) or not text.strip():
                raise InputError(f"{where}: {kind} {obj['id']!r} has no `text`")
            obj["id"] = str(obj["id"])
            rid = obj["id"]
            if rid in seen:
                if on_dup_id == "keep-first":
                    continue
                if on_dup_id == "rename":
                    k = 2
                    while f"{rid}-dup{k}" in seen:
                        k += 1
                    obj["id"] = f"{rid}-dup{k}"
                else:
                    dups.append(f"{rid} ({where} and {seen[rid][0]}:{seen[rid][1]})")
                    continue
            seen[obj["id"]] = (src, ln)
            recs.append(obj)
    if dups:
        more = f" (+{len(dups) - 5} more)" if len(dups) > 5 else ""
        raise InputError(
            f"duplicate {kind} ids: " + "; ".join(dups[:5]) + more
            + ". Use --on-dup-id keep-first|rename to resolve."
        )
    if not recs:
        raise InputError(f"no {kind}s found")
    return recs
