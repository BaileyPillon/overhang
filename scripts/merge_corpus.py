"""Merge corpus/raw/*.jsonl into corpus/corpus.jsonl.

- concatenates the files (sorted by name, original line order kept, every
  field untouched);
- validates against corpus/SCHEMA.md: hard errors stop the merge (nothing is
  written), style problems are warnings;
- flags near-duplicates (raw cosine >= --dup-cos under the bge-base model) for
  human review. Nothing is dropped automatically.

Run from the repo root with the venv's python:
    .venv\\Scripts\\python.exe scripts\\merge_corpus.py
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from gapfind.embed import DEFAULT_MODEL, embed_texts  # noqa: E402
from gapfind.io import InputError, read_jsonl, write_jsonl  # noqa: E402

DOMAINS = {"devices-home", "security-privacy", "science-research", "health-body",
           "money-business", "work-productivity", "software-dev", "family-kids",
           "creative-media", "games", "learning", "social-relationships", "civic-legal",
           "travel-outdoors", "food-home-life", "other"}
CONFIDENCE = {"seen", "secondhand"}
BANNED = re.compile(r"\b(claude|ai|llms?|models?|agents?)\b", re.IGNORECASE)


def validate(rows: list[dict]) -> tuple[list[str], list[tuple[str, str]]]:
    """rows carry `__file__` and `__line__`. Returns (errors, warnings); each
    warning is (kind, message) so they can be grouped."""
    errors: list[str] = []
    warnings: list[tuple[str, str]] = []
    seen: dict[str, str] = {}
    for r in rows:
        where = f"{r['__file__']}:{r['__line__']}"
        rid = r.get("id")
        if not isinstance(rid, str) or not rid:
            errors.append(f"{where}: missing id")
            continue
        if rid in seen:
            errors.append(f"{where}: duplicate id {rid} (also {seen[rid]})")
        seen[rid] = where
        text = r.get("text")
        if not isinstance(text, str) or not text.strip():
            errors.append(f"{where} {rid}: missing text")
            continue
        if r.get("domain") not in DOMAINS:
            errors.append(f"{where} {rid}: domain {r.get('domain')!r} is not in the schema list")
        stem = Path(r["__file__"]).stem
        if not rid.startswith(stem + "-"):
            warnings.append(("id prefix differs from the file name", f"{where} {rid}: id does not start with '{stem}-'"))
        n_words = len(text.split())
        if not 15 <= n_words <= 35:
            warnings.append(("text length outside 15-35 words", f"{where} {rid}: {n_words} words"))
        hit = BANNED.search(text)
        if hit:
            warnings.append(("text names the tool/model (Claude, AI, LLM, model, agent)", f"{where} {rid}: says {hit.group(0)!r}"))
        if len(str(r.get("title") or "").split()) > 8:
            warnings.append(("title longer than 8 words", f"{where} {rid}"))
        if not r.get("title"):
            warnings.append(("no title", f"{where} {rid}"))
        if not r.get("source"):
            warnings.append(("no source", f"{where} {rid}"))
        if "confidence" in r and r["confidence"] not in CONFIDENCE:
            warnings.append(("unknown confidence value", f"{where} {rid}: {r['confidence']!r}"))
        if "from_video" in r and not isinstance(r["from_video"], bool):
            warnings.append(("from_video is not a boolean", f"{where} {rid}"))
        d = r.get("date")
        if d is not None and not re.fullmatch(r"\d{4}-\d{2}", str(d)):
            warnings.append(("date is not YYYY-MM", f"{where} {rid}: {d!r}"))
    return errors, warnings


def near_duplicates(emb: np.ndarray, threshold: float) -> list[tuple[int, int, float]]:
    """Index pairs (i < j, cos) of L2-normalized rows with cosine >= threshold,
    sorted by descending cosine."""
    pairs: list[tuple[int, int, float]] = []
    n = len(emb)
    step = 2048
    for s in range(0, n, step):
        sims = emb[s:s + step] @ emb.T
        for a, b in zip(*np.nonzero(sims >= threshold)):
            i, j = s + int(a), int(b)
            if i < j:
                pairs.append((i, j, float(sims[a, b])))
    return sorted(pairs, key=lambda p: -p[2])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--raw-dir", default=str(ROOT / "corpus" / "raw"))
    ap.add_argument("--out", default=str(ROOT / "corpus" / "corpus.jsonl"))
    ap.add_argument("--dup-cos", type=float, default=0.92,
                    help="flag pairs with raw cosine >= this (default %(default)s)")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--cache-dir", default=str(ROOT / ".cache"))
    ap.add_argument("--no-dupes", action="store_true", help="skip the near-duplicate scan")
    a = ap.parse_args(argv)
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    files = sorted(Path(a.raw_dir).glob("*.jsonl"))
    if not files:
        print(f"no *.jsonl files in {a.raw_dir}", file=sys.stderr)
        return 2
    rows: list[dict] = []
    try:
        for f in files:
            for obj in read_jsonl(f):
                _, ln = obj.pop("__src__")
                obj["__file__"], obj["__line__"] = f.name, ln
                rows.append(obj)
    except InputError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    per_file = Counter(r["__file__"] for r in rows)
    print("files: " + ", ".join(f"{k} {v}" for k, v in per_file.items()) + f"  (total {len(rows)})")
    errors, warnings = validate(rows)
    dom = Counter(r.get("domain") for r in rows)
    print("domains: " + ", ".join(f"{k} {v}" for k, v in dom.most_common()))
    if warnings:
        kinds = defaultdict(list)
        for kind, msg in warnings:
            kinds[kind].append(msg)
        print(f"\n{len(warnings)} warnings (kept; for review):")
        for kind, msgs in sorted(kinds.items(), key=lambda kv: -len(kv[1])):
            print(f"  [{len(msgs)}] {kind}")
            for m in msgs[:3]:
                print(f"      {m}")
    if errors:
        print(f"\n{len(errors)} ERRORS, nothing written:")
        for e in errors:
            print(f"  {e}")
        return 1

    items = [{k: v for k, v in r.items() if k not in ("__file__", "__line__")} for r in rows]
    out = Path(a.out)
    write_jsonl(out, items)
    print(f"\nwrote {len(items)} items to {out}")

    if not a.no_dupes:
        emb, _ = embed_texts([it["text"] for it in items], model=a.model, cache_dir=a.cache_dir,
                             verbose=False)
        margin = 0.04  # also show pairs just below the threshold, so it can be judged
        all_pairs = near_duplicates(emb, a.dup_cos - margin)
        pairs = [p for p in all_pairs if p[2] >= a.dup_cos]
        border = [p for p in all_pairs if p[2] < a.dup_cos]
        for title, group in ((f"near-duplicates (raw cosine >= {a.dup_cos} under {a.model})", pairs),
                             (f"borderline (cosine {a.dup_cos - margin:.2f} to {a.dup_cos}), "
                              "not flagged", border)):
            print(f"\n{title}: {len(group)} pair(s)")
            for i, j, c in group:
                x, y = rows[i], rows[j]
                print(f"  {c:.3f}  {x['id']} \"{x.get('title')}\" [{x['__file__']}]  <->  "
                      f"{y['id']} \"{y.get('title')}\" [{y['__file__']}]")
                print(f"           {x['text'][:110]}")
                print(f"           {y['text'][:110]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
