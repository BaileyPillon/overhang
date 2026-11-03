"""Export a gapfind run as the JSON data files of the Overhang web app.

    .venv\\Scripts\\python.exe -I scripts\\export_app_data.py                # runs/r1 -> app/public/data/
    .venv\\Scripts\\python.exe -I scripts\\export_app_data.py --run r2       # pooled run (needs runs/r1 as prereg)
    .venv\\Scripts\\python.exe -I scripts\\export_app_data.py --check        # validate the files only

The contract (files, fields, interpretation notes) is documented in design/DATA.md.
Only the standard library is used. Nothing under corpus/, gapfind/ or runs/ is written.

Inputs (all relative to the repo root unless given):
  runs/<run>/items.jsonl, map.json (else map_holes.json), holes.json, replication.json (optional)
  corpus/facets/tags.jsonl and vocab.json (the paths recorded in holes.json params, else these)
  runs/dry/gaps.json + stability.json
Outputs (app/public/data/): meta, points, facets, holes, replication, dryrun, winner, codes.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DEFAULT = ROOT / "app" / "public" / "data"

AXES = ["move", "material", "for"]
PAIRS = [("move", "material"), ("move", "for"), ("material", "for")]  # code order
PAIR_NAME = {p: f"{p[0]}×{p[1]}" for p in PAIRS}                 # "move×material"
KAPPA_R1 = {"move": 0.878, "material": 0.897, "for": 0.878}  # recomputed from tags.jsonl: for = 0.8785 (PREREG.md rounds it to 0.879)
MODELS = ["BAAI/bge-base-en-v1.5", "nomic-ai/nomic-embed-text-v1.5"]
PREREG_COMMIT = "0549f44"
REPO_URL = "https://github.com/BaileyPillon/overhang"
VIDEO = {"title": "31 Life-Changing Ways to Use Claude in 2027",
         "channel": "Nick Saraev", "url": "https://www.youtube.com/watch?v=KDyPHt4lW60"}
FILES = ["meta", "points", "facets", "holes", "replication", "dryrun", "winner", "codes"]
COMPACT = {"points", "facets"}


class ExportError(Exception):
    pass


# ----------------------------------------------------------------- helpers

def read_json(path: Path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except FileNotFoundError:
        raise ExportError(f"missing file: {path}") from None
    except json.JSONDecodeError as e:
        raise ExportError(f"{path}: invalid JSON ({e})") from None


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            for n, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError as e:
                    raise ExportError(f"{path}:{n}: invalid JSON ({e})") from None
    except FileNotFoundError:
        raise ExportError(f"missing file: {path}") from None
    return rows


def write_json(path: Path, obj, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1, allow_nan=False)
        f.write("\n")


def num(x, nd=4):
    """float rounded, or None for None/NaN/inf."""
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return round(x, nd) if math.isfinite(x) else None


def matrix(m, cast=num):
    return [[cast(v) for v in row] for row in m]


def poisson_cdf(k: int, lam: float) -> float:
    if lam <= 0:
        return 1.0
    term, tot = math.exp(-lam), 0.0
    for i in range(k + 1):
        tot += term
        term *= lam / (i + 1)
    return min(1.0, tot)


def pair_of(axes) -> tuple[str, str]:
    a, b = axes
    if a in AXES and b in AXES and AXES.index(a) > AXES.index(b):
        a, b = b, a
    return (a, b)


def hkey(axes, row, col) -> str:
    a, b = pair_of(axes)
    return f"{a}×{b}|{row}|{col}"


def resolve(p, root: Path = ROOT) -> Path:
    p = Path(p)
    return p if p.is_absolute() else root / p


# ----------------------------------------------------------------- loading

class Run:
    """Everything read from one gapfind run folder plus the facet tag files."""

    def __init__(self, run_dir: Path, a):
        self.dir = run_dir
        self.name = run_dir.name
        self.items = read_jsonl(run_dir / "items.jsonl")
        ids = [it["id"] for it in self.items]
        if len(set(ids)) != len(ids):
            raise ExportError(f"{run_dir}/items.jsonl: duplicate ids")
        self.holes = read_json(run_dir / "holes.json")
        if not isinstance(self.holes.get("gaps"), list) or not isinstance(self.holes.get("pairs"), list):
            raise ExportError(f"{run_dir}/holes.json: expected 'gaps' and 'pairs' lists (gapfind facets output)")
        params = self.holes.get("params") or {}
        # map
        mp = Path(a.map) if a.map else None
        if mp is None:
            mp = next((run_dir / n for n in ("map.json", "map_holes.json") if (run_dir / n).is_file()), None)
        if mp is None:
            raise ExportError(f"{run_dir}: no map.json or map_holes.json (run `gapfind map`)")
        self.map_path = mp
        self.map = read_json(mp)
        self.xy = {p["id"]: (float(p["x"]), float(p["y"])) for p in self.map.get("points", [])
                   if p.get("x") is not None and p.get("y") is not None}
        missing = [i for i in ids if i not in self.xy]
        if missing:
            raise ExportError(f"{mp}: {len(missing)} item(s) have no x,y, e.g. {missing[:3]}")
        # percentile fallback from the map's gaps
        self.map_gap = {g.get("id"): g for g in (self.map.get("gaps") or []) if isinstance(g, dict)}
        # vocab and tags
        vp = resolve(a.vocab or params.get("vocab") or "corpus/facets/vocab.json")
        vdoc = read_json(vp)
        self.vocab, self.defs = {}, {}
        for ax, vals in (vdoc.get("axes") or {}).items():
            names = []
            for v in vals:
                name, d = (v, None) if isinstance(v, str) else (v.get("value"), v.get("definition"))
                names.append(str(name).strip())
                self.defs[(ax, names[-1])] = d
            self.vocab[ax] = names
        for ax in AXES:
            if ax not in self.vocab:
                raise ExportError(f"{vp}: axis {ax!r} missing")
        tag_paths = [resolve(t) for t in (a.tags or [params.get("tags") or "corpus/facets/tags.jsonl"])]
        rows: dict[str, dict] = {}
        for tp in tag_paths:
            for r in read_jsonl(tp):
                rows[str(r.get("id"))] = r
        self.tag = {ax: {} for ax in AXES}
        self.untagged = 0
        idset = set(ids)
        for it in self.items:
            r = rows.get(it["id"])
            if r is None:
                self.untagged += 1
                continue
            for ax in AXES:
                v = r.get(ax)
                v = None if v is None else str(v).strip()
                if v in self.vocab[ax]:
                    self.tag[ax][it["id"]] = v
        self.tags_not_in_run = sum(1 for k in rows if k not in idset)
        self.params = params

    def ids_with(self, ax: str, value: str) -> list[str]:
        t = self.tag[ax]
        return [it["id"] for it in self.items if t.get(it["id"]) == value]


# ----------------------------------------------------------------- build

def load_codes(path: Path) -> dict[str, str]:
    if path.is_file():
        d = read_json(path)
        if isinstance(d, dict):
            return {str(k): str(v) for k, v in d.items()}
    return {}


def cell_order(h: dict):
    """code order: pair (move×material, move×for, material×for), then E descending, then p."""
    pr = pair_of(h["axes"])
    pi = PAIRS.index(pr) if pr in PAIRS else len(PAIRS)
    return (pi, -h["E"], h["p"] if h["p"] is not None else 1.0, h["rank"])


def assign_codes(ordered_keys: list[str], codes: dict[str, str]) -> None:
    used = [int(c.split("-")[1]) for c in codes.values() if c.startswith("OV-") and c[3:].isdigit()]
    n = max(used, default=0)
    for k in ordered_keys:
        if k not in codes:
            n += 1
            codes[k] = f"OV-{n:02d}"


def empty_cells(pair: dict, min_e: float):
    """Cells with observed == 0 and expected >= min_e in a holes.json pair table, E-ordered."""
    O, E = pair["observed"], pair.get("expected") or pair.get("expected_quasi")
    out = []
    for i in range(len(pair["rows"])):
        for j in range(len(pair["cols"])):
            if O[i][j] == 0 and E[i][j] is not None and E[i][j] >= min_e:
                out.append((i, j))
    out.sort(key=lambda c: (-E[c[0]][c[1]], c))
    return out


def build(a) -> dict:
    run_dir = resolve(a.run) if (Path(a.run).parts and len(Path(a.run).parts) > 1) else ROOT / "runs" / a.run
    if not run_dir.is_dir():
        raise ExportError(f"run folder not found: {run_dir}")
    out = resolve(a.out)
    run = Run(run_dir, a)
    N = len(run.items)
    min_e = float((run.params or {}).get("min_expected", 1.0))

    # --- prereg (the r1 holes) -----------------------------------------
    prereg_path = resolve(a.prereg) if a.prereg else ROOT / "runs" / "r1" / "holes.json"
    if run.name == prereg_path.parent.name or not prereg_path.is_file():
        prereg = run.holes
    else:
        prereg = read_json(prereg_path)
    prereg_gaps = [g for g in prereg.get("gaps", []) if (g.get("expected") or 0) >= 1.0]
    prereg_by_key = {hkey(g["axes"], g["cell"][g["axes"][0]], g["cell"][g["axes"][1]]): g
                     for g in prereg_gaps}
    pdir = prereg_path.parent
    if run.name == pdir.name:
        n_r1 = N
    else:
        pm = pdir / "meta.json"
        n_r1 = int(read_json(pm)["n_items"]) if pm.is_file() else len(read_jsonl(pdir / "items.jsonl"))
        # a pooled run interleaves the new reports; the contract wants the original reports first, in r1 order
        r1_ids = [it["id"] for it in read_jsonl(pdir / "items.jsonl")]
        r1_pos = {i: k for k, i in enumerate(r1_ids)}
        run.items.sort(key=lambda it: (r1_pos.get(it["id"], len(r1_ids)), 0))

    # --- replication ----------------------------------------------------
    rep_doc = None
    rp = run_dir / "replication.json"
    if rp.is_file():
        rep_doc = read_json(rp)
    rep_cells = []
    if rep_doc:
        rep_cells = rep_doc.get("cells") or rep_doc.get("rows") or []
    rep_by_key = {}
    for c in rep_cells:
        ax = c.get("axes")
        if ax and c.get("cell"):
            rep_by_key[hkey(ax, c["cell"][ax[0]], c["cell"][ax[1]])] = c
    rep_status = "pending"
    if rep_cells:
        rep_status = "done" if (rep_doc.get("status") in (None, "done")) else "pending"

    # --- holes ----------------------------------------------------------
    pairs = {pair_of(p["axes"]): p for p in run.holes["pairs"]}
    gap_by_key = {}
    for g in run.holes["gaps"]:
        if (g.get("expected") or 0) >= min_e and g.get("observed", 0) == 0:
            gap_by_key[hkey(g["axes"], g["cell"][g["axes"][0]], g["cell"][g["axes"][1]])] = g

    wanted: list[tuple[tuple[str, str], int, int, str]] = []   # (pair, i, j, key)
    seen = set()
    for pr, pair in pairs.items():
        for (i, j) in empty_cells(pair, min_e):
            k = hkey(pr, pair["rows"][i], pair["cols"][j])
            wanted.append((pr, i, j, k)); seen.add(k)
    # gap-list entries the tables do not show as empty (should not happen), and
    # pre-registered cells that left the E>=1 list on the pooled sample stay in the catalog
    for k, g in list(gap_by_key.items()) + list(prereg_by_key.items()):
        if k in seen:
            continue
        pr = pair_of(g["axes"])
        pair = pairs.get(pr)
        if pair is None:
            continue
        try:
            i, j = pair["rows"].index(g["cell"][pr[0]]), pair["cols"].index(g["cell"][pr[1]])
        except ValueError:
            continue
        wanted.append((pr, i, j, k)); seen.add(k)

    existing_holes = {}
    hp = out / "holes.json"
    if hp.is_file():
        try:
            existing_holes = {h["code"]: h for h in read_json(hp)}
        except Exception:
            existing_holes = {}

    xy = run.xy
    holes, synth = [], 0
    pre = []
    for pr, i, j, k in wanted:
        pair = pairs[pr]
        a_ax, b_ax = pr
        row_v, col_v = pair["rows"][i], pair["cols"][j]
        gap = gap_by_key.get(k) or {}
        Etab = pair.get("expected") or pair.get("expected_quasi")
        obs = int(pair["observed"][i][j])
        E = gap.get("expected", Etab[i][j])
        Eind = gap.get("expected_indep", pair["expected_indep"][i][j])
        qtab = pair.get("q")
        q = gap.get("q") if gap.get("q") is not None else (qtab[i][j] if qtab else None)
        rep = rep_by_key.get(k)
        p = gap.get("p")
        if p is None:
            p = poisson_cdf(obs, float(E))
        stab = gap.get("stability")
        if stab is None and k in prereg_by_key and not gap:
            stab = (rep or {}).get("bootstrap_stability")
        is_synth = not gap
        if is_synth:
            synth += 1
        pct = gap.get("percentile")
        if pct is None:
            pct = (run.map_gap.get(gap.get("id")) or {}).get("percentile")
        alt = gap.get("alt") or {}
        tag_robust = bool(gap.get("tag_robust") if gap.get("tag_robust") is not None
                          else alt.get("survives", prereg_by_key.get(k, {}).get("tag_robust", False)))
        row_ids, col_ids = run.ids_with(a_ax, row_v), run.ids_with(b_ax, col_v)
        if not row_ids or not col_ids:
            raise ExportError(f"hole {k}: no items carry the row or column value")
        if gap.get("n_row") is not None and (gap["n_row"], gap["n_col"]) != (len(row_ids), len(col_ids)):
            print(f"warning: {k}: n_row/n_col {gap['n_row']}/{gap['n_col']} != tagged "
                  f"{len(row_ids)}/{len(col_ids)}", file=sys.stderr)
        rx = sum(xy[t][0] for t in row_ids) / len(row_ids)
        ry = sum(xy[t][1] for t in row_ids) / len(row_ids)
        cx = sum(xy[t][0] for t in col_ids) / len(col_ids)
        cy = sum(xy[t][1] for t in col_ids) / len(col_ids)
        h = {
            "code": None, "id": gap.get("id") or f"hole-{a_ax}-{b_ax}-cell-{i}-{j}",
            "axes": [a_ax, b_ax], "cell": {a_ax: row_v, b_ax: col_v},
            "observed": obs, "E": num(E), "E_indep": num(Eind), "p": num(p, 6), "q": num(q, 6),
            "stability": num(stab), "tag_robust": tag_robust, "knn_pct": num(pct, 2),
            "row_ids": row_ids, "col_ids": col_ids,
            "x": num((rx + cx) / 2), "y": num((ry + cy) / 2),
            "prereg": k in prereg_by_key,
            "registered": None, "replication": None, "concept": None, "prior_art": None,
            "rank": gap.get("rank") or 10**6,
        }
        if rep:
            h["replication"] = {
                "verdict": rep.get("verdict"), "observed_new": rep.get("observed_new"),
                "E_new": num(rep.get("E_new")), "p_new": num(rep.get("p_new"), 6),
                "observed_pooled": rep.get("observed_pooled"), "E_pooled": num(rep.get("E_pooled")),
                "q_pooled": num(rep.get("q_pooled"), 6)}
        pg = prereg_by_key.get(k)
        if pg:
            # the values at registration (first pass, runs/r1), kept next to the pooled ones so Table 1 stays a first-pass table
            h["registered"] = {
                "observed": int(pg.get("observed", 0)), "E": num(pg.get("expected")), "E_indep": num(pg.get("expected_indep")),
                "p": num(pg.get("p"), 6), "stability": num(pg.get("stability")),
                "tag_robust": bool(pg.get("tag_robust")), "knn_pct": num(pg.get("percentile"), 2), "N": pg.get("N")}
        h["_key"] = k
        holes.append(h)

    # --- codes ----------------------------------------------------------
    codes_path = out / "codes.json"
    codes = load_codes(codes_path)
    if not codes and prereg is not run.holes:
        # first export is a pooled run: the pre-registered holes get the first codes
        pre = []
        for g in prereg_gaps:
            pr = pair_of(g["axes"])
            pre.append({"axes": pr, "E": g["expected"], "p": g.get("p"), "rank": g.get("rank", 0),
                        "_key": hkey(g["axes"], g["cell"][g["axes"][0]], g["cell"][g["axes"][1]])})
        pre.sort(key=cell_order)
        assign_codes([x["_key"] for x in pre], codes)
    holes.sort(key=cell_order)
    assign_codes([h["_key"] for h in holes], codes)
    for h in holes:
        h["code"] = codes[h["_key"]]
    holes.sort(key=lambda h: (int(h["code"][3:]), h["code"]))
    # concepts / prior art written into the output by later stages survive a re-export
    for h in holes:
        old = existing_holes.get(h["code"])
        if old and old.get("cell") == h["cell"] and old.get("axes") == h["axes"]:
            h["concept"], h["prior_art"] = old.get("concept"), old.get("prior_art")
        h.pop("rank"), h.pop("_key")
    ordered = ["code", "id", "axes", "cell", "observed", "E", "E_indep", "p", "q", "stability",
               "tag_robust", "knn_pct", "row_ids", "col_ids", "x", "y", "prereg", "registered", "replication",
               "concept", "prior_art"]
    holes = [{k: h[k] for k in ordered} for h in holes]

    # --- replication.json ----------------------------------------------
    rep_rows = []
    if rep_status == "done":
        for c in rep_cells:
            ax = c["axes"]
            k = hkey(ax, c["cell"][ax[0]], c["cell"][ax[1]])
            if k not in codes:
                assign_codes([k], codes)
            rep_rows.append({
                "code": codes[k], "cell_label": f"{c['cell'][ax[0]]} × {c['cell'][ax[1]]}",
                "axes": list(ax), "E_prereg": num(c.get("expected_prereg", c.get("E_prereg"))),
                "observed_new": c.get("observed_new"), "E_new": num(c.get("E_new")),
                "p_new": num(c.get("p_new"), 6), "observed_pooled": c.get("observed_pooled"),
                "E_pooled": num(c.get("E_pooled")), "q_pooled": num(c.get("q_pooled"), 6),
                "stability": num(c.get("bootstrap_stability", c.get("stability"))),
                "verdict": c.get("verdict"),
                "refuting": [{"id": r.get("id"), "t": r.get("title", r.get("t"))}
                             for r in (c.get("refuting_items") or c.get("refuting") or [])]})
        rep_rows.sort(key=lambda r: int(r["code"][3:]))
    replication = {"status": rep_status, "rows": rep_rows}

    # --- points ---------------------------------------------------------
    points = []
    for it in run.items:
        i = it["id"]
        x, y = run.xy[i]
        points.append({
            "id": i, "t": it.get("title"), "tx": it.get("text"), "d": it.get("domain"),
            "v": bool(it.get("from_video")), "s": it.get("source"), "w": it.get("who"),
            "dt": it.get("date"), "c": it.get("confidence"), "x": round(x, 4), "y": round(y, 4),
            "mv": run.tag["move"].get(i), "mt": run.tag["material"].get(i),
            "fr": run.tag["for"].get(i), "g": it.get("sampled_by")})

    # --- facets ---------------------------------------------------------
    axes_doc = {ax: [{"value": v, "definition": run.defs.get((ax, v))} for v in run.vocab[ax]]
                for ax in AXES}
    tables = {}
    for pr in PAIRS:
        pair = pairs.get(pr)
        if pair is None:
            continue
        nr, nc = len(pair["rows"]), len(pair["cols"])
        E = pair.get("expected") or pair.get("expected_quasi")
        struct = pair.get("structural") or [[False] * nc for _ in range(nr)]
        q = pair.get("q") or [[None] * nc for _ in range(nr)]
        tables[PAIR_NAME[pr]] = {
            "rows": list(pair["rows"]), "cols": list(pair["cols"]),
            "observed": matrix(pair["observed"], int), "expected": matrix(E, lambda v: num(v, 3)),
            "expected_indep": matrix(pair["expected_indep"], lambda v: num(v, 3)),
            "structural": matrix(struct, bool), "q": matrix(q, lambda v: num(v, 6))}
    facets = {"axes": axes_doc, "tables": tables}

    # --- meta -----------------------------------------------------------
    kappa = {"r1": dict(KAPPA_R1), "grow": None}
    if a.kappa_json:
        kj = read_json(resolve(a.kappa_json))
        if any(k in kj for k in ("r1", "grow")):
            kappa.update({k: kj[k] for k in ("r1", "grow") if k in kj})
        else:
            kappa["r1"] = kj
    gp = {}
    gpath = run_dir / "gaps.json"
    if gpath.is_file():
        gp = (read_json(gpath).get("params") or {})
    run_label = run.name if run.name in ("r1", "r2") else ("r2" if N > n_r1 else "r1")
    meta = {
        "N": N, "N_r1": n_r1, "run": run_label, "kappa": kappa, "models": list(MODELS),
        "pca": int(run.params.get("pca") or gp.get("pca") or 32),
        "k": int(run.params.get("k") or gp.get("k") or 10),
        "prereg_commit": PREREG_COMMIT, "repo_url": REPO_URL, "video": dict(VIDEO),
        "generated": _dt.date.today().isoformat(), "replication_status": rep_status}

    # --- dry run --------------------------------------------------------
    dryrun = None
    dd = resolve(a.dry)
    if (dd / "gaps.json").is_file():
        dg = read_json(dd / "gaps.json")
        st = read_json(dd / "stability.json") if (dd / "stability.json").is_file() else {}
        stab_list = st.get("stability") or []
        dm = read_json(dd / "meta.json") if (dd / "meta.json").is_file() else {}
        chance = st.get("null")
        if chance is None:
            chance = (dg.get("stability_run") or {}).get("null")
        gaps = []
        for r, g in enumerate(dg["gaps"]):
            s = stab_list[r] if r < len(stab_list) else g.get("stability")
            g1 = g.get("g1")
            gaps.append({
                "rank": r + 1, "pct": num(g.get("percentile"), 2), "stability": num(s),
                "coherence": num(g.get("coherence")),
                "nn_cos": None if g1 is None else num(1 - float(g1), 4),
                "parents": [p.get("title") if isinstance(p, dict) else str(p)
                            for p in (g.get("parents") or [])]})
        dryrun = {"N": int(dm.get("n_items") or (dg.get("novelty") or {}).get("n") or 514),
                  "chance": num(chance, 4), "gaps": gaps}

    # --- winner (never overwrite a built one) ----------------------------
    winner = {"status": "pending"}
    wp = out / "winner.json"
    if wp.is_file():
        try:
            old = read_json(wp)
            if isinstance(old, dict) and old.get("status"):
                winner = old
        except ExportError:
            pass

    docs = {"meta": meta, "points": points, "facets": facets, "holes": holes,
            "replication": replication, "dryrun": dryrun, "winner": winner, "codes": codes}
    info = {"run_dir": run_dir, "map": run.map_path, "synth": synth, "untagged": run.untagged,
            "tags_not_in_run": run.tags_not_in_run, "out": out}
    return {"docs": docs, "info": info}


# ----------------------------------------------------------------- check

def check(out: Path) -> tuple[list[str], list[str]]:
    errs: list[str] = []
    warns: list[str] = []

    def E(msg):
        errs.append(msg)

    def W(msg):
        warns.append(msg)

    def isnum(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)

    def isint(v):
        return isinstance(v, int) and not isinstance(v, bool)

    def isstr(v):
        return isinstance(v, str)

    docs = {}
    for n in FILES:
        p = out / f"{n}.json"
        if not p.is_file():
            E(f"{n}.json: missing")
            continue
        try:
            docs[n] = read_json(p)
        except ExportError as e:
            E(str(e))
    if errs:
        return errs, warns

    # meta
    m = docs["meta"]
    for k, t in [("N", isint), ("N_r1", isint), ("pca", isint), ("k", isint), ("prereg_commit", isstr),
                 ("repo_url", isstr), ("generated", isstr)]:
        if not t(m.get(k)):
            E(f"meta.{k}: bad value {m.get(k)!r}")
    if m.get("run") not in ("r1", "r2"):
        E(f"meta.run: {m.get('run')!r}")
    if m.get("replication_status") not in ("pending", "done"):
        E(f"meta.replication_status: {m.get('replication_status')!r}")
    kp = m.get("kappa")
    if not isinstance(kp, dict) or "r1" not in kp or "grow" not in kp:
        E("meta.kappa: need keys r1 and grow")
    else:
        for part in ("r1", "grow"):
            v = kp[part]
            if v is None and part == "grow":
                continue
            if not (isinstance(v, dict) and all(isnum(v.get(a)) and 0 <= v[a] <= 1 for a in AXES)):
                E(f"meta.kappa.{part}: need move/material/for in [0,1] (or null for grow)")
    if not (isinstance(m.get("models"), list) and len(m["models"]) == 2 and all(map(isstr, m["models"]))):
        E("meta.models: need two strings")
    if not (isinstance(m.get("video"), dict) and all(isstr(m["video"].get(k)) for k in ("title", "channel", "url"))):
        E("meta.video: need title, channel, url")
    try:
        _dt.date.fromisoformat(m.get("generated", ""))
    except ValueError:
        E("meta.generated: not an ISO date")

    # facets
    f = docs["facets"]
    axvals = {}
    if not (isinstance(f.get("axes"), dict) and set(f["axes"]) == set(AXES)):
        E("facets.axes: need move, material, for")
    else:
        for ax in AXES:
            vs = f["axes"][ax]
            if not (isinstance(vs, list) and vs and all(isinstance(v, dict) and isstr(v.get("value"))
                                                        and "definition" in v for v in vs)):
                E(f"facets.axes.{ax}: need [{{value, definition}}]")
                continue
            axvals[ax] = [v["value"] for v in vs]
            if len(set(axvals[ax])) != len(vs):
                E(f"facets.axes.{ax}: duplicate values")
            if any(not isstr(v["definition"]) for v in vs):
                W(f"facets.axes.{ax}: some definitions are null")
    tabs = f.get("tables") or {}
    tab_by_pair = {}
    for pr in PAIRS:
        t = tabs.get(PAIR_NAME[pr])
        if t is None:
            E(f"facets.tables: missing {PAIR_NAME[pr]}")
            continue
        tab_by_pair[pr] = t
        nr, nc = len(t.get("rows", [])), len(t.get("cols", []))
        if axvals and (t.get("rows") != axvals[pr[0]] or t.get("cols") != axvals[pr[1]]):
            E(f"facets.tables.{PAIR_NAME[pr]}: rows/cols differ from the axis values")
        for key, kind in [("observed", "int"), ("expected", "num"), ("expected_indep", "num"),
                          ("structural", "bool"), ("q", "numnull")]:
            M = t.get(key)
            if not (isinstance(M, list) and len(M) == nr and all(isinstance(r, list) and len(r) == nc for r in M)):
                E(f"facets.tables.{PAIR_NAME[pr]}.{key}: shape is not {nr}x{nc}")
                continue
            for r in M:
                for v in r:
                    ok = ((kind == "int" and isint(v) and v >= 0) or (kind == "num" and isnum(v) and v >= 0)
                          or (kind == "bool" and isinstance(v, bool))
                          or (kind == "numnull" and (v is None or (isnum(v) and 0 <= v <= 1))))
                    if not ok:
                        E(f"facets.tables.{PAIR_NAME[pr]}.{key}: bad entry {v!r}")
                        break
                else:
                    continue
                break
    n_cells_obs = {}
    for pr, t in tab_by_pair.items():
        try:
            n_cells_obs[pr] = sum(sum(r) for r in t["observed"])
        except Exception:
            pass

    # points
    pts = docs["points"]
    if not isinstance(pts, list) or not pts:
        E("points: need a non-empty array")
        return errs, warns
    ids = set()
    pt = {}
    for p in pts:
        for k, t in [("id", isstr), ("t", isstr), ("tx", isstr), ("d", isstr), ("s", isstr),
                     ("c", isstr), ("x", isnum), ("y", isnum)]:
            if not t(p.get(k)):
                E(f"points[{p.get('id')}].{k}: bad value {p.get(k)!r}")
        if not isinstance(p.get("v"), bool):
            E(f"points[{p.get('id')}].v: not bool")
        for k in ("w", "dt", "g"):
            if k not in p or not (p[k] is None or isstr(p[k])):
                E(f"points[{p.get('id')}].{k}: need string or null")
        for k, ax in (("mv", "move"), ("mt", "material"), ("fr", "for")):
            v = p.get(k)
            if v is None:
                W(f"points[{p.get('id')}].{k}: untagged")
            elif not isstr(v) or (axvals and v not in axvals[ax]):
                E(f"points[{p.get('id')}].{k}: {v!r} not in vocabulary")
        if p.get("id") in ids:
            E(f"points: duplicate id {p.get('id')}")
        ids.add(p.get("id"))
        pt[p.get("id")] = p
    if m["N"] != len(pts):
        E(f"meta.N {m['N']} != len(points) {len(pts)}")
    if m["N_r1"] > m["N"]:
        E("meta.N_r1 > meta.N")
    if m["run"] == "r1" and m["N_r1"] != m["N"]:
        E("meta.run is r1 but N_r1 != N")
    if any(p["g"] is not None for p in pts[:m["N_r1"]]):
        E("points: the first N_r1 points must have g = null")
    for pr, tot in n_cells_obs.items():
        tagged = sum(1 for p in pts if p.get({"move": "mv", "material": "mt", "for": "fr"}[pr[0]])
                     and p.get({"move": "mv", "material": "mt", "for": "fr"}[pr[1]]))
        if tot != tagged:
            E(f"facets.tables.{PAIR_NAME[pr]}: observed sums to {tot}, points with both tags: {tagged}")
    fld = {"move": "mv", "material": "mt", "for": "fr"}

    # codes + holes
    codes = docs["codes"]
    if not isinstance(codes, dict) or not all(isstr(k) and isstr(v) for k, v in codes.items()):
        E("codes: need {key: code}")
        codes = {}
    if len(set(codes.values())) != len(codes):
        E("codes: duplicate codes")
    holes = docs["holes"]
    if not isinstance(holes, list):
        E("holes: need an array")
        return errs, warns
    hcodes, hids, hkeys = set(), set(), set()
    last = 0
    for h in holes:
        c = h.get("code")
        tag = f"holes[{c}]"
        if not (isstr(c) and c.startswith("OV-") and c[3:].isdigit()):
            E(f"{tag}: bad code")
            continue
        if c in hcodes:
            E(f"{tag}: duplicate code")
        hcodes.add(c)
        if int(c[3:]) <= last:
            E(f"{tag}: holes are not in code order")
        last = int(c[3:])
        if not isstr(h.get("id")) or h["id"] in hids:
            E(f"{tag}: id missing or duplicated")
        hids.add(h.get("id"))
        ax = h.get("axes")
        if not (isinstance(ax, list) and len(ax) == 2 and tuple(ax) in PAIRS):
            E(f"{tag}: axes {ax!r} not a known pair")
            continue
        a_ax, b_ax = ax
        cell = h.get("cell")
        if not (isinstance(cell, dict) and set(cell) == {a_ax, b_ax}):
            E(f"{tag}: cell keys must be the two axes")
            continue
        if axvals and (cell[a_ax] not in axvals[a_ax] or cell[b_ax] not in axvals[b_ax]):
            E(f"{tag}: cell value not in vocabulary")
            continue
        k = hkey(ax, cell[a_ax], cell[b_ax])
        hkeys.add(k)
        if codes.get(k) != c:
            E(f"{tag}: codes.json maps {k!r} to {codes.get(k)!r}")
        for key, t in [("observed", lambda v: isint(v) and v >= 0), ("E", lambda v: isnum(v) and (v >= 1.0 - 1e-9 or (h.get("prereg") and m["run"] != "r1" and v >= 0))),
                       ("E_indep", lambda v: isnum(v) and v >= 0), ("p", lambda v: isnum(v) and 0 <= v <= 1),
                       ("x", isnum), ("y", isnum)]:
            if not t(h.get(key)):
                E(f"{tag}.{key}: bad value {h.get(key)!r}")
        for key, t in [("q", lambda v: isnum(v) and 0 <= v <= 1), ("stability", lambda v: isnum(v) and 0 <= v <= 1),
                       ("knn_pct", lambda v: isnum(v) and 0 <= v <= 100)]:
            v = h.get(key)
            if key not in h:
                E(f"{tag}.{key}: missing")
            elif v is None:
                if key != "q":
                    W(f"{tag}.{key}: null")
            elif not t(v):
                E(f"{tag}.{key}: bad value {v!r}")
        if not isinstance(h.get("tag_robust"), bool):
            E(f"{tag}.tag_robust: not bool")
        if not isinstance(h.get("prereg"), bool):
            E(f"{tag}.prereg: not bool")
        for key, ax_ in (("row_ids", a_ax), ("col_ids", b_ax)):
            L = h.get(key)
            val = cell[ax_]
            if not (isinstance(L, list) and L and all(i in ids for i in L) and len(set(L)) == len(L)):
                E(f"{tag}.{key}: need a non-empty list of point ids")
                continue
            if any(pt[i].get(fld[ax_]) != val for i in L):
                E(f"{tag}.{key}: ids whose {fld[ax_]} is not {val!r}")
            want = sum(1 for p in pts if p.get(fld[ax_]) == val)
            if want != len(L):
                E(f"{tag}.{key}: {len(L)} ids, but {want} points carry {val!r}")
        # against the table
        t = tab_by_pair.get((a_ax, b_ax))
        if t:
            i, j = t["rows"].index(cell[a_ax]), t["cols"].index(cell[b_ax])
            if h.get("observed") != t["observed"][i][j]:
                E(f"{tag}: observed {h.get('observed')} != table {t['observed'][i][j]}")
            if isnum(h.get("E")) and abs(h["E"] - t["expected"][i][j]) > 6e-4:
                E(f"{tag}: E {h['E']} != table {t['expected'][i][j]}")
        # midpoint
        try:
            r = [pt[i] for i in h["row_ids"]]
            cc = [pt[i] for i in h["col_ids"]]
            mx = (sum(p["x"] for p in r) / len(r) + sum(p["x"] for p in cc) / len(cc)) / 2
            my = (sum(p["y"] for p in r) / len(r) + sum(p["y"] for p in cc) / len(cc)) / 2
            if abs(mx - h["x"]) > 0.01 or abs(my - h["y"]) > 0.01:
                E(f"{tag}: x,y is not the midpoint of the centroids (got {h['x']},{h['y']}, want {mx:.3f},{my:.3f})")
        except Exception:
            pass
        rp = h.get("replication")
        if rp is not None:
            need = ["verdict", "observed_new", "E_new", "p_new", "observed_pooled", "E_pooled", "q_pooled"]
            if not (isinstance(rp, dict) and all(k_ in rp for k_ in need)):
                E(f"{tag}.replication: need keys {need}")
            elif rp["verdict"] not in ("replicated", "refuted", "underpowered"):
                E(f"{tag}.replication.verdict: {rp['verdict']!r}")
        elif m.get("replication_status") == "done" and h.get("prereg"):
            W(f"{tag}: prereg hole with no replication row")
        cp = h.get("concept")
        if cp is not None and not (isinstance(cp, dict) and all(isstr(cp.get(k_)) for k_ in ("title", "text", "pitch"))):
            E(f"{tag}.concept: need title, text, pitch")
        pa = h.get("prior_art")
        if pa is not None:
            if not (isinstance(pa, dict) and isstr(pa.get("verdict")) and isinstance(pa.get("closest"), list)
                    and all(isinstance(x, dict) and all(isstr(x.get(k_)) for k_ in ("url", "what", "how_close"))
                            for x in pa["closest"])):
                E(f"{tag}.prior_art: need verdict and closest[{{url, what, how_close}}]")
    if m["run"] == "r1" and not all(h.get("prereg") for h in holes):
        E("holes: in r1 every hole is pre-registered")
    # completeness: every empty E>=1 cell is listed
    for pr, t in tab_by_pair.items():
        for i, rv in enumerate(t["rows"]):
            for j, cv in enumerate(t["cols"]):
                if t["observed"][i][j] == 0 and t["expected"][i][j] >= 1.0 and hkey(pr, rv, cv) not in hkeys:
                    E(f"holes: empty cell with E>=1 is missing: {rv} x {cv} ({PAIR_NAME[pr]})")
    # holes sorted by pair, then E
    # codes are permanent, so a pooled run appends its new holes after the registered ones: each group is ordered
    for grp in (True, False):
        pi = [PAIRS.index(tuple(h["axes"])) for h in holes if bool(h.get("prereg")) == grp and tuple(h.get("axes", ())) in PAIRS]
        if m["run"] == "r1" and not grp:
            continue
        if pi != sorted(pi):
            E("holes: not ordered move×material, move×for, material×for")

    # replication
    rep = docs["replication"]
    if rep.get("status") not in ("pending", "done") or not isinstance(rep.get("rows"), list):
        E("replication: need status and rows")
    else:
        if rep["status"] != m.get("replication_status"):
            E("replication.status differs from meta.replication_status")
        if rep["status"] == "pending" and rep["rows"]:
            E("replication: pending but rows are not empty")
        if rep["status"] == "pending" and any(h.get("replication") for h in holes):
            E("replication: pending but holes carry replication")
        for r in rep["rows"]:
            need = ["code", "cell_label", "axes", "E_prereg", "observed_new", "E_new", "p_new",
                    "observed_pooled", "E_pooled", "q_pooled", "stability", "verdict", "refuting"]
            miss = [k_ for k_ in need if k_ not in r]
            if miss:
                E(f"replication.rows[{r.get('code')}]: missing {miss}")
                continue
            if r["code"] not in codes.values():
                E(f"replication.rows[{r['code']}]: code not in codes.json")
            if r["verdict"] not in ("replicated", "refuted", "underpowered"):
                E(f"replication.rows[{r['code']}].verdict: {r['verdict']!r}")
            if not all(isinstance(x, dict) and "id" in x and "t" in x for x in r["refuting"]):
                E(f"replication.rows[{r['code']}].refuting: need [{{id, t}}]")
            if r["verdict"] == "refuted" and r["observed_new"] and len(r["refuting"]) != r["observed_new"]:
                W(f"replication.rows[{r['code']}]: observed_new {r['observed_new']} != {len(r['refuting'])} refuting items")

    # dryrun
    d = docs["dryrun"]
    if not (isinstance(d, dict) and isint(d.get("N")) and isnum(d.get("chance")) and isinstance(d.get("gaps"), list)):
        E("dryrun: need N, chance, gaps")
    else:
        if d["N"] != 514:
            E(f"dryrun.N is {d['N']}, contract says 514")
        for n, g in enumerate(d["gaps"], 1):
            if g.get("rank") != n:
                E(f"dryrun.gaps[{n}].rank: {g.get('rank')!r}")
            for k_, lo, hi in (("pct", 0, 100), ("stability", 0, 1), ("coherence", -1, 1), ("nn_cos", -1, 1)):
                if not (isnum(g.get(k_)) and lo <= g[k_] <= hi):
                    E(f"dryrun.gaps[{n}].{k_}: bad value {g.get(k_)!r}")
            if not (isinstance(g.get("parents"), list) and g["parents"] and all(isstr(x) for x in g["parents"])):
                E(f"dryrun.gaps[{n}].parents: need titles")
        if not d["gaps"]:
            E("dryrun.gaps: empty")

    # winner
    w = docs["winner"]
    if not isinstance(w, dict) or w.get("status") not in ("pending", "built"):
        E("winner.status: pending or built")
    elif w["status"] == "built":
        for k_ in ("code", "title", "pitch", "how_it_works", "demo", "repo_path"):
            if k_ not in w:
                E(f"winner: built but missing {k_}")
        if w.get("code") and w["code"] not in hcodes:
            E(f"winner.code {w['code']} is not a hole code")
        if not isinstance(w.get("how_it_works"), list):
            E("winner.how_it_works: need a list")
    return errs, warns


# ----------------------------------------------------------------- summary / main

def human(n: int) -> str:
    return f"{n/1024:.1f} KB" if n < 1 << 20 else f"{n/(1 << 20):.2f} MB"


def summary(out: Path) -> None:
    print(f"\nfiles in {out}:")
    tot = 0
    for n in FILES:
        p = out / f"{n}.json"
        if p.is_file():
            s = p.stat().st_size
            tot += s
            print(f"  {n + '.json':<18}{human(s):>10}")
    print(f"  {'total':<18}{human(tot):>10}")
    try:
        m = read_json(out / "meta.json")
        pts = read_json(out / "points.json")
        holes = read_json(out / "holes.json")
        rep = read_json(out / "replication.json")
        dry = read_json(out / "dryrun.json")
        fac = read_json(out / "facets.json")
    except ExportError:
        return
    print(f"\nrun {m['run']}: N={m['N']} (N_r1={m['N_r1']}), pca={m['pca']}, k={m['k']}, "
          f"replication {m['replication_status']}")
    print(f"points: {len(pts)}  (video {sum(p['v'] for p in pts)}, with sampled_by {sum(p['g'] is not None for p in pts)})")
    print("facet values: " + ", ".join(f"{ax} {len(v)}" for ax, v in fac["axes"].items()))
    by = {}
    for h in holes:
        by.setdefault("×".join(h["axes"]), []).append(h)
    print(f"holes: {len(holes)}  (" + ", ".join(f"{k} {len(v)}" for k, v in by.items()) +
          f"); codes {holes[0]['code']}..{holes[-1]['code']}" if holes else "holes: 0")
    print(f"  prereg {sum(h['prereg'] for h in holes)}, tag_robust {sum(h['tag_robust'] for h in holes)}, "
          f"q present {sum(h['q'] is not None for h in holes)}, with replication {sum(h['replication'] is not None for h in holes)}, "
          f"concepts {sum(h['concept'] is not None for h in holes)}, prior_art {sum(h['prior_art'] is not None for h in holes)}")
    print(f"replication rows: {len(rep['rows'])}   dry-run gaps: {len(dry['gaps'])} (chance {dry['chance']})")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--run", default="r1", help="run name under runs/ (r1, r2) or a path [r1]")
    ap.add_argument("--out", default=str(OUT_DEFAULT), help="output folder [app/public/data]")
    ap.add_argument("--kappa-json", help="JSON file overriding kappa: {\"r1\": {...}, \"grow\": {...}} "
                    "or just {move, material, for} (replaces r1)")
    ap.add_argument("--prereg", help="pre-registered holes.json [runs/r1/holes.json]")
    ap.add_argument("--dry", default="runs/dry", help="dry-run folder [runs/dry]")
    ap.add_argument("--map", help="2D map json [runs/<run>/map.json, else map_holes.json]")
    ap.add_argument("--tags", action="append", help="tags.jsonl (repeatable) [path in holes.json params]")
    ap.add_argument("--vocab", help="vocab.json [path in holes.json params]")
    ap.add_argument("--check", action="store_true", help="only validate the files in --out")
    a = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    out = resolve(a.out)
    try:
        if not a.check:
            res = build(a)
            for n in FILES:
                doc = res["docs"][n]
                if doc is None:
                    print(f"warning: {n}.json not written (source missing)", file=sys.stderr)
                    continue
                write_json(out / f"{n}.json", doc, compact=n in COMPACT)
            i = res["info"]
            print(f"exported {i['run_dir'].name} (map: {i['map'].name}) -> {out}")
            if i["synth"]:
                print(f"note: {i['synth']} hole(s) built from the pair tables (not in holes.json gaps)")
            if i["untagged"]:
                print(f"warning: {i['untagged']} item(s) have no tag row", file=sys.stderr)
        errs, warns = check(out)
    except ExportError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    summary(out)
    for w in warns[:20]:
        print(f"warning: {w}")
    if len(warns) > 20:
        print(f"... and {len(warns) - 20} more warnings")
    if errs:
        print(f"\nCHECK FAILED: {len(errs)} error(s)")
        for e in errs[:40]:
            print(f"  - {e}")
        return 1
    print(f"\ncheck ok ({len(warns)} warning(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
