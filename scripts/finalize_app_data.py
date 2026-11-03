"""Finish the app data after `export_app_data.py --run r2`: things the exporter does not know about.

    .venv\\Scripts\\python.exe -I scripts\\finalize_app_data.py

Reads (never writes): corpus/facets/tags.jsonl, runs/r1/items.jsonl, runs/grow/new_ids.txt, results/evidence.json,
results/sensitivity.json, runs/r2/globe/{globe.json,land.png}.
Writes only app/public/data/:

  meta.json         kappa.r1 and kappa.grow recomputed from the two taggers' labels (Cohen's kappa, 3 decimals)
  holes.json        concept and prior_art for the six holes the concept stage worked on (the top-ranked concept per hole;
                    the pick, H1-c1, for firmware x researchers); a run of the exporter keeps them
  winner.json       {"status": "pending", "pick": {...}}: the pick of design/WINNER.md. Nothing is built yet.
  sensitivity.json  the replication verdicts under independence and quasi-independence at z = 3, 4, 5, plus the tagging audit
  globe.json        points (lat, lon, 6 nearest on the globe, continent), continents, land threshold, stats (no hole geometry:
                    the app derives it from the holes' row and column ids)
  land.png          the 360 x 180 density map
"""

from __future__ import annotations

import collections
import json
import shutil
import sys
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "public" / "data"


def rj(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def wj(p: Path, d) -> None:
    p.write_text(json.dumps(d, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def kappa(a, b) -> float:
    n = len(a)
    po = sum(x == y for x, y in zip(a, b)) / n
    ca, cb = collections.Counter(a), collections.Counter(b)
    pe = sum(ca[k] * cb.get(k, 0) for k in ca) / n / n
    return (po - pe) / (1 - pe)


def hkey(axes, row, col) -> str:
    return f"{axes[0]}×{axes[1]}|{row}|{col}"


def main() -> int:
    meta = rj(OUT / "meta.json")
    holes = rj(OUT / "holes.json")
    codes = rj(OUT / "codes.json")

    # ---- kappa
    tags = {}
    for line in (ROOT / "corpus" / "facets" / "tags.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            tags[r["id"]] = r
    r1 = [json.loads(l)["id"] for l in (ROOT / "runs" / "r1" / "items.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    new = [l.strip() for l in (ROOT / "runs" / "grow" / "new_ids.txt").read_text(encoding="utf-8").splitlines() if l.strip()]

    def kap(ids):
        return {ax: round(kappa([tags[i][ax] for i in ids], [tags[i][ax + "_alt"] for i in ids]), 3) for ax in ("move", "material", "for")}

    meta["kappa"] = {"r1": kap(r1), "grow": kap(new)}
    # github.com/BaileyPillon/overhang/commit/0549f44 returned 404 when checked; flip this once the repository is pushed (public)
    meta["repo_published"] = False
    wj(OUT / "meta.json", meta)
    print("kappa", meta["kappa"])

    # ---- concepts and prior art
    ev = rj(ROOT / "results" / "evidence.json")
    rank = {r["id"]: r["total"] for r in ev["ranking"]}
    by_hole: dict[str, list] = collections.defaultdict(list)
    for c in ev["dossier"]:
        by_hole[c["hole"]].append(c)
    by_cell = {}
    for h in holes:
        by_cell[f"{h['cell'][h['axes'][0]]} x {h['cell'][h['axes'][1]]}"] = h
    pick_id = "H1-c1"
    n_attached = 0
    for hid, cs in by_hole.items():
        cell = cs[0]["cell"]
        h = by_cell.get(cell)
        if not h:
            print("no hole for", cell)
            continue
        best = next((c for c in cs if c["id"] == pick_id), None) or max(cs, key=lambda c: rank.get(c["id"], -1))
        h["concept"] = {"title": best["title"], "text": best["text"], "pitch": best["pitch"]}
        hits = []
        for lens in ("prior_art_ai", "prior_art_product"):
            for x in best[lens]["closest"]:
                hits.append(x)
        hits.sort(key=lambda x: -float(x.get("how_close") or 0))
        verdicts = {best["prior_art_ai"]["verdict"], best["prior_art_product"]["verdict"]}
        verdict = "done" if "done" in verdicts else ("partial" if "partial" in verdicts else "none found")
        h["prior_art"] = {"verdict": verdict,
                          "closest": [{"url": x["url"], "what": x["what"], "how_close": f"{float(x.get('how_close') or 0):.2f}"} for x in hits[:4]]}
        n_attached += 1
    wj(OUT / "holes.json", holes)
    print("concepts/prior art attached to", n_attached, "holes; concepts", len(ev["dossier"]), "searches", 2 * len(ev["dossier"]))

    # ---- winner (the pick; nothing is built)
    pick_hole = by_cell["consumer-device firmware or hardware x researchers or science"]
    sens = rj(ROOT / "results" / "sensitivity.json")
    cell_s = next(c for c in sens["cells"]
                  if c["cell"] == pick_hole["cell"] and list(c["axes"]) == pick_hole["axes"])
    z3 = cell_s["models"]["z3"]
    ind = cell_s["models"]["indep"]
    winner = {
        "status": "pending",
        "pick": {
            "code": pick_hole["code"],
            "name": "Drift",
            "title": "Drift: firmware forensics for science",
            "concept": "H1-c1",
            "pitch": ("Consumer wearables are used as research instruments, and vendors silently change their step, heart-rate and sleep "
                      "algorithms in firmware updates, which makes cohort data from before and after an update non-comparable. Drift takes two or "
                      "more firmware versions of an open-source wearable, finds the code on the metric path, runs each version's algorithm on the "
                      "same recorded sensor data so the effect is a measured number, and writes a dated data-validity memo for a research team."),
            "how_it_works": [
                "Take two or more firmware versions of an open-source wearable (Bangle.js / Espruino, PineTime / InfiniTime), so there are no legal grey zones.",
                "Locate the code on the metric path, from sensor input to reported metric, and show what changed.",
                "Run differential execution: compile the metric algorithm from each version for the host and feed every version the same recorded raw sensor data.",
                "Write a dated memo for the research team: which date ranges are not comparable, by how much, and a suggested sensitivity check.",
            ],
            "stats": {"observed_new": cell_s["observed_new"], "E_new": z3["E_new"], "E_pooled": z3["E_pooled"], "q_pooled": z3["q_pooled"],
                      "E_new_indep": ind["E_new"], "q_pooled_indep": ind["q_pooled"], "official_verdict": z3["verdict"], "stability_pooled": pick_hole["stability"]},
            "exception": True,
            "repo_path": "drift/",
        },
    }
    clean = sum(1 for c in ev["dossier"] if c["prior_art_ai"]["verdict"] == "none_found" and c["prior_art_product"]["verdict"] == "none_found")
    winner["concept_stage"] = {"concepts": len(ev["dossier"]), "searches": 2 * len(ev["dossier"]), "clean": clean,
                               "ranked": len(ev["ranking"]), "pick_rank": 1 + [r["id"] for r in ev["ranking"]].index(pick_id)}
    wj(OUT / "winner.json", winner)

    # ---- sensitivity + audit
    rows = []
    for c in sens["cells"]:
        k = hkey(c["axes"], c["cell"][c["axes"][0]], c["cell"][c["axes"][1]])
        rows.append({"code": codes[k], "cell_label": f"{c['cell'][c['axes'][0]]} × {c['cell'][c['axes'][1]]}", "axes": c["axes"],
                     "observed_new": c["observed_new"],
                     "models": {m: {"E_new": None if v["E_new"] is None else round(v["E_new"], 3),
                                    "q_pooled": None if v["q_pooled"] is None else round(v["q_pooled"], 6), "verdict": v["verdict"]}
                                for m, v in c["models"].items()}})
    rows.sort(key=lambda r: int(r["code"][3:]))
    audits = ev["audits"]
    belongs = {}
    # the two reports design/WINNER.md names as the scientific-grade cases the vocabulary files elsewhere
    named = {"g-revenge-046", "g-revenge-007"}
    for a in audits:
        for b in a.get("belongs", []):
            if b["id"] in named:
                belongs[b["id"]] = b["title"]
    wj(OUT / "sensitivity.json", {
        "rule": sens["rule"], "models": sens["models"], "summary": sens["summary"], "rows": rows,
        "audit": {"code": pick_hole["code"], "verdicts": [a["verdict"] for a in audits], "belongs": [{"id": i, "title": t} for i, t in belongs.items()]},
    })
    print("sensitivity rows", len(rows), "audit", [a["verdict"] for a in audits])

    # ---- globe
    g = rj(ROOT / "runs" / "r2" / "globe" / "globe.json")
    pts = [{"id": p["id"], "lat": p["lat"], "lon": p["lon"], "nn": [[i, d] for i, d in p["nn"]], "c": p.get("cont", 0), "off": bool(p.get("offshore"))} for p in g["points"]]
    conts = [{"id": c["id"], "name": c.get("name"), "lat": c["lat"], "lon": c["lon"],
              "n": c.get("n_items_on_land", 0) + c.get("n_items_offshore_assigned", 0),
              "top": [d["domain"] for d in c.get("top_domains", [])[:2]]} for c in g["continents"]]
    slim = {"n": g["n"], "land": g["land"], "points": pts, "continents": conts, "stats": {k: g["stats"][k] for k in (
        "domain_purity_at6", "neighbour_overlap_globe_vs_full_at6", "n_continents", "globe_nn_deg", "items_on_land", "items_offshore", "grid") if k in g["stats"]}}
    (OUT / "globe.json").write_text(json.dumps(slim, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    shutil.copyfile(ROOT / "runs" / "r2" / "globe" / "land.png", OUT / "land.png")
    print("globe", len(pts), "points", len(conts), "continents")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
