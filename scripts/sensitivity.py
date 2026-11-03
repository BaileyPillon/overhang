"""Sensitivity analysis of the pre-registered replication.

Re-evaluates the registered cells and the pre-registered verdict rule under plain
independence and quasi-independence at structural z = 3, 4, 5, in the new sample alone
and in the pooled data. Writes runs/r2/sensitivity.json and runs/r2/sensitivity.md.
Does not modify runs/r2/replication.json.

Run from the repo root:
    .venv\\Scripts\\python.exe scripts\\sensitivity.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from gapfind.cli import _load_items  # noqa: E402
from gapfind.facets import Tags, load_vocab  # noqa: E402
from gapfind.io import InputError, read_json, write_json  # noqa: E402
from gapfind.sensitivity import format_sensitivity, sensitivity_cells  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--prereg", default=str(ROOT / "runs/r1/holes.json"))
    ap.add_argument("--run", default=str(ROOT / "runs/r2"))
    ap.add_argument("--tags", default=str(ROOT / "corpus/facets/tags.jsonl"))
    ap.add_argument("--vocab", default=str(ROOT / "corpus/facets/vocab.json"))
    ap.add_argument("--new-ids", default=str(ROOT / "runs/grow/new_ids.txt"))
    ap.add_argument("--min-expected", type=float, default=1.0)
    ap.add_argument("--out", default=None, help="output directory [--run]")
    a = ap.parse_args(argv)

    prereg = read_json(a.prereg)
    vocab, _ = load_vocab(a.vocab)
    items = _load_items(a.run)
    new_ids = {ln.strip() for ln in Path(a.new_ids).read_text(encoding="utf-8").splitlines()
               if ln.strip() and not ln.lstrip().startswith("#")}
    if not new_ids:
        raise InputError(f"{a.new_ids} lists no ids")
    axes = sorted({ax for g in prereg.get("gaps", []) for ax in g.get("axes", [])})
    tags = Tags(items, axes, vocab, a.tags)
    res = sensitivity_cells(prereg, items, tags, vocab, new_ids, min_expected=a.min_expected)

    # consistency with the official run: the z = 3 model must reproduce replication.json
    rep_path = Path(a.run) / "replication.json"
    check = None
    if rep_path.is_file():
        rep = {c["prereg_id"]: c for c in read_json(rep_path)["cells"]}
        bad = []
        for c in res["cells"]:
            r, m = rep.get(c["prereg_id"]), c["models"]["z3"]
            if (r is None or r["verdict"] != m["verdict"] or abs(r["E_new"] - m["E_new"]) > 1e-3
                    or abs(r["E_pooled"] - m["E_pooled"]) > 1e-3
                    or r["observed_new"] != c["observed_new"]):
                bad.append(c["prereg_id"])
        check = {"replication_json": str(rep_path), "z3_matches_official": not bad,
                 "mismatches": bad}

    doc = {"source": "sensitivity", "prereg": str(a.prereg), "run": str(a.run),
           "tags": str(a.tags), "vocab": str(a.vocab), "new_ids_file": str(a.new_ids),
           "n_items": len(items), "n_new_ids": len(new_ids), "min_expected": a.min_expected,
           "rule": {"replicated": "O_new == 0 and E_new >= 2 and q_pooled <= 0.10",
                    "refuted": "O_new > 0", "underpowered": "otherwise"},
           "official_check": check, **res}
    out = Path(a.out or a.run)
    out.mkdir(parents=True, exist_ok=True)
    write_json(out / "sensitivity.json", doc)
    md = ["# Sensitivity of the replication verdicts to the expected-count model", "",
          f"{len(items):,} pooled items, {len(new_ids):,} new. {len(res['cells'])} pre-registered "
          "cells. Rule (unchanged): replicated if O_new == 0, E_new >= 2 and pooled q <= 0.10; "
          "refuted if O_new > 0; otherwise underpowered. E_new is fitted on the new sample alone; "
          "q_pooled is Benjamini-Hochberg over the axis pair's cells with E_pooled >= "
          f"{a.min_expected:g} under the same model.", "",
          format_sensitivity(res), ""]
    if check:
        md.append("Check: quasi z=3 reproduces the official replication.json: "
                  + ("yes." if check["z3_matches_official"] else f"NO {check['mismatches']}."))
        md.append("")
    (out / "sensitivity.md").write_text("\n".join(md), encoding="utf-8")
    print(format_sensitivity(res))
    if check:
        print(f"\nz=3 matches official replication.json: {check['z3_matches_official']} "
              f"{check['mismatches']}")
    print(f"\nwrote {out / 'sensitivity.json'} and {out / 'sensitivity.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
