"""Command line: python -m gapfind {embed,find,facets,replicate,show,stability,check,map}."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

from . import __version__
from .core import (Space, center, check_concepts, find_gaps, loo_knn_distance, novelty_summary,
                   resolve_band)
from .crossmodel import novelty_by_model
from .embed import DEFAULT_CACHE_DIR, DEFAULT_MODEL, embed_texts
from .facets import Tags, facet_holes, load_vocab, resolve_axes
from .io import InputError, expand_inputs, load_records, read_json, read_jsonl, write_json, write_jsonl
from .replicate import format_replication, replicate_cells
from .run import DERIVED, Run
from .stability import run_stability


def _clip(s, n=78) -> str:
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 3] + "..."


def _label(rec: dict, n=78) -> str:
    return _clip(rec.get("title") or rec.get("text"), n)


def _tag(gaps_name: str) -> str:
    """Suffix for output files so `--gaps holes` does not overwrite the blend outputs."""
    stem = Path(gaps_name).name.removesuffix(".json")
    return "" if stem == "gaps" else f"_{stem}"


def _log(msg: str) -> None:
    print(f"[gapfind] {msg}", file=sys.stderr, flush=True)


# ------------------------------------------------------------------ embed

def cmd_embed(a) -> int:
    files = expand_inputs(a.inputs)
    items = load_records(files, kind="item", on_dup_id=a.on_dup_id)
    texts = [it["text"] for it in items]
    t0 = time.time()
    emb, stats = embed_texts(texts, model=a.model, backend=a.backend, cache_dir=a.cache_dir,
                             model_dir=a.model_dir, batch_size=a.batch_size)
    mean = emb.mean(axis=0).astype(np.float32)

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name in DERIVED:  # derived from the previous corpus: now stale
        if (out / name).exists():
            (out / name).unlink()
            _log(f"removed stale {name}")
    for r, it in enumerate(items):
        if "row" in it:
            it["row_in"] = it["row"]
        it["row"] = r
    write_jsonl(out / "items.jsonl", items)
    np.save(out / "emb.npy", emb)
    np.save(out / "mean.npy", mean)
    meta = {"model": a.model, "backend": stats["backend"], "dim": int(emb.shape[1]),
            "n_items": len(items), "items_path": "items.jsonl", "emb_path": "emb.npy",
            "mean_path": "mean.npy", "mean_norm": round(float(np.linalg.norm(mean)), 6),
            "inputs": [str(f) for f in files],
            "cache": {k: stats[k] for k in ("unique", "cache_hits", "cache_misses")}}
    write_json(out / "meta.json", meta)

    dup_text = len(texts) - len(set(texts))
    print(f"embedded {len(items):,} items from {len(files)} file(s) with {a.model} "
          f"(dim {emb.shape[1]}) in {time.time() - t0:.1f}s")
    print(f"cache: {stats['cache_hits']:,} hit, {stats['cache_misses']:,} new")
    print(f"anisotropy: mean pairwise cosine of raw embeddings is about "
          f"{meta['mean_norm'] ** 2:.2f}; centering removes it")
    if dup_text:
        print(f"warning: {dup_text} item(s) repeat another item's text exactly; "
              "they add zero-distance neighbors to the novelty scale")
    print(f"wrote {out / 'items.jsonl'}, emb.npy, mean.npy, meta.json")
    return 0


# ------------------------------------------------------------------- find

def format_gaps(doc: dict, n_neighbors_shown: int = 3) -> str:
    L = []
    nov, smp, par, pc = doc["novelty"], doc["sampling"], doc["params"], doc["pca"]
    space = (f"PCA {pc['dim']}/{pc['full_dim']} dims keeping {pc['explained_variance']:.0%} of the "
             "variance" if pc["dim"] else f"full {pc['full_dim']} dims")
    mw = f" | min weight {par['min_weight']:g}" if par.get("min_weight") else ""
    L.append(f"{nov['n']:,} items | {par['samples']:,} samples | {space} | k={par['k']}{mw} | "
             f"coherence band q{par['coh_band'][0]:g}-q{par['coh_band'][1]:g} = "
             f"[{smp['coherence_range'][0]:.3f}, {smp['coherence_range'][1]:.3f}] kept "
             f"{smp['kept']:,} | {smp['found']} distinct gaps (nms {par['nms']}, min separation "
             f"{smp['min_gap_separation']}) | {smp['seconds']}s")
    L.append(f"novelty scale (leave-one-out {par['k']}-NN distance): median {nov['p50']:.3f}, "
             f"p90 {nov['p90']:.3f}, p99 {nov['p99']:.3f}, max {nov['max']:.3f}; "
             f"best raw sample scored {smp['max_score_all_samples']:.3f}")
    for g in doc["gaps"]:
        stab = f"  stability {g['stability']:.2f}" if g.get("stability") is not None else ""
        L.append("")
        L.append(f"{g['id']}  score={g['score']:.3f} (1-NN g1={g['g1']:.3f})  emptier than "
                 f"{g['percentile']:.1f}% of existing items{stab}  (coherence "
                 f"{g['coherence']:.2f}; above {g['blend_percentile']:.1f}% of coherent blends)")
        for p in g["parents"]:
            L.append(f"   parent {p['weight']:.2f}  {_label(p, 90)}")
        for n in g["neighbors"][:n_neighbors_shown]:
            L.append(f"   near   {n['cos']:.2f}  [{n['domain']}] {_label(n, 80)}")
        mix = ", ".join(f"{k} {v}" for k, v in g["domain_mix"].items())
        L.append(f"   neighbor mix ({len(g['neighbors'])}): {mix}")
    return "\n".join(L)


def cmd_find(a) -> int:
    run = Run(a.run)
    if a.samples < 1 or a.top < 1 or a.k < 1:
        raise InputError("--samples, --top and --k must be positive")
    band = resolve_band(a.coh_band, a.coh_q)
    X = run.X
    space = Space.fit(X, a.pca)
    doc, d_knn = find_gaps(X, run.items, samples=a.samples, top=a.top, seed=a.seed,
                           coh_band=band, nms=a.nms, min_weight=a.min_weight, p_k2=a.p_k2, n_neighbors=a.neighbors,
                           batch=a.batch, group_field=a.group_field, k=a.k, pca=a.pca,
                           space=space, progress=_log)
    doc["model"] = run.meta["model"]
    for name in ("checks.json", "stability.json", "map.json", "map.png"):
        if (run.path / name).exists():  # these describe the previous gaps
            (run.path / name).unlink()
            _log(f"removed stale {name}")
    if space.dim:
        space.save(run.path / "pca.npz")
    elif (run.path / "pca.npz").exists():
        (run.path / "pca.npz").unlink()
    np.save(run.path / "novelty.npy", d_knn)
    write_json(run.path / "gaps.json", doc)
    print(format_gaps(doc))
    if doc["sampling"]["found"] < a.top:
        print(f"\nwarning: only {doc['sampling']['found']} of {a.top} requested gaps survived "
              "the filter and suppression; lower --nms or widen --coh-band, or raise --samples")
    print(f"\nwrote {run.path / 'gaps.json'}")
    return 0


# ------------------------------------------------------------------- show

def format_table(doc: dict, n_neighbors: int = 3) -> str:
    """One markdown row per gap: id, percentile, stability, coherence, parents, nearest items."""
    L = ["| gap | pct | stab | coh | parents (weight) | nearest items |",
         "|---|---|---|---|---|---|"]
    for g in doc["gaps"]:
        stab = "-" if g.get("stability") is None else f"{g['stability']:.2f}"
        par = "; ".join(f"{_clip(p.get('title') or p['text'], 40)} ({p['weight']:.2f})"
                        for p in g["parents"])
        near = "; ".join(_clip(n.get("title") or n["text"], 40) for n in g["neighbors"][:n_neighbors])
        L.append(f"| {g['id']} | {g['percentile']:.1f} | {stab} | {g['coherence']:.2f} | "
                 f"{par} | {near} |")
    return "\n".join(L)


def cmd_show(a) -> int:
    doc = Run(a.run).gaps_doc(a.gaps)
    if doc.get("source") == "facet":
        print(format_hole_table(doc) if a.table else format_holes(doc))
    else:
        print(format_table(doc, a.neighbors) if a.table else format_gaps(doc, a.neighbors))
    return 0


# ----------------------------------------------------------------- facets

def format_holes(doc: dict, per_pair: int = 10, n_thin: int = 5) -> str:
    L = []
    tg = doc["tagging"]
    L.append(f"{tg['n_items']:,} items; tagged: " + ", ".join(f"{a} {n}" for a, n in tg["tagged"].items())
             + f" | bootstrap {doc['params']['boot']} | embedding validation: k={doc['params']['k']}, "
             + (f"PCA {doc['pca']['dim']}" if doc["pca"]["dim"] else "full dimension"))
    if tg["agreement"]:
        L.append("tagger agreement: " + ", ".join(f"{a} {v['rate']:.0%} (n={v['n']})"
                                                  for a, v in tg["agreement"].items()))
    byid = {g["id"]: g for g in doc["gaps"]}
    for pr in doc["pairs"]:
        a, b = pr["axes"]
        L.append("")
        L.append(f"{a} x {b}: {len(pr['rows'])} x {len(pr['cols'])} table, N={pr['N']}, "
                 f"{pr['n_empty']} empty cells ({pr['n_empty_below_min_expected']} with expected "
                 f"below {doc['params']['min_expected']:g}, not ranked), {pr['n_thin']} thin"
                 + (f", {pr['n_structural']} structural" if pr.get("n_structural") is not None else ""))
        for hid in pr["holes"][:per_pair]:
            g = byid[hid]
            alt = ""
            if g["alt"] is not None:
                alt = (" | 2nd tagger: hole kept" if g["alt"]["survives"]
                       else f" | 2nd tagger: GONE (obs {g['alt']['observed']}, E {g['alt']['expected']:.1f})")
            ind = (f" (indep {g.get('expected_indep', g['expected']):.1f})"
                   if g.get("expected_quasi") is not None else "")
            L.append(f"  {hid}  {g['cell'][a]} x {g['cell'][b]}  E={g['expected']:.1f}{ind} "
                     f"p={g['p']:.1e} q={g.get('q', float('nan')):.3f}  stability {g['stability']:.2f}{alt}")
            L.append(f"      embedding: emptier than {g['percentile']:.1f}% of items "
                     f"(k-NN score {g['score']:.3f}, 1-NN {g['g1']:.3f})")
            for ax in g["axes"]:
                ex = g["examples"][ax]
                L.append(f"      {ax}={ex['value']} (n={ex['n']}): "
                         + " | ".join(_clip(i.get("title") or i["text"], 42) for i in ex["items"]))
        if pr["thin"]:
            L.append(f"  thin cells (observed >= 1 but <= E/{1 / doc['params']['thin_frac']:g}), lowest p first:")
            for t in pr["thin"][:n_thin]:
                L.append(f"    {t['cell'][a]} x {t['cell'][b]}  observed {t['observed']}  "
                         f"E={t['expected']:.1f}  p={t['p']:.1e}")
    return "\n".join(L)


def format_hole_table(doc: dict) -> str:
    L = ["| hole | cell | E | p | q | stab | 2nd tagger | emb pct | E indep |",
         "|---|---|---|---|---|---|---|---|---|"]
    for g in doc["gaps"]:
        a, b = g["axes"]
        alt = "-" if g["alt"] is None else ("kept" if g["alt"]["survives"] else "gone")
        L.append(f"| {g['id']} | {g['cell'][a]} x {g['cell'][b]} | {g['expected']:.1f} | "
                 f"{g['p']:.1e} | {g.get('q', float('nan')):.3f} | {g['stability']:.2f} | {alt} | {g['percentile']:.1f} | "
                 f"{g.get('expected_indep', g['expected']):.1f} |")
    return "\n".join(L)


def cmd_facets(a) -> int:
    run = Run(a.run)
    vocab, defs = load_vocab(a.vocab)
    pairs = resolve_axes(vocab, a.axes)
    axes = [x for x in vocab if any(x in p for p in pairs)]
    tags = Tags(run.items, axes, vocab, a.tags)
    if a.top < 1 or a.boot < 0:
        raise InputError("--top must be positive and --boot non-negative")
    if a.structural_z <= 0:
        raise InputError("--structural-z must be positive")

    # the working space: find's (same centering, PCA and k, so percentiles are comparable)
    # unless --pca / --k are given or find has not been run
    X = run.X
    if (run.path / "gaps.json").is_file() and a.pca is None and a.k is None:
        gdoc = run.gaps_doc()
        space, k = run.space(gdoc), gdoc["params"]["k"]
        Y = space.project(X)
        d_knn = run.novelty(gdoc, Y)
        space_from = "gaps.json"
    else:
        space = Space.fit(X, 32 if a.pca is None else a.pca)
        Y = space.project(X)
        k = max(1, min(5 if a.k is None else a.k, len(Y) - 1))
        d_knn = loo_knn_distance(Y, k)
        space_from = "fit"
    if space.dim:
        space.save(run.path / "holes_pca.npz")
    elif (run.path / "holes_pca.npz").exists():
        (run.path / "holes_pca.npz").unlink()
    np.save(run.path / "holes_novelty.npy", d_knn)
    for name in ("checks_holes.json", "map_holes.json", "map_holes.png"):
        if (run.path / name).exists():  # these describe the previous holes
            (run.path / name).unlink()
            _log(f"removed stale {name}")

    res = facet_holes(run.items, Y, d_knn, tags, vocab, defs, pairs=pairs, top=a.top,
                      boot=a.boot, seed=a.seed, min_expected=a.min_expected,
                      thin_frac=a.thin_frac, k=k, n_neighbors=a.neighbors,
                      group_field=a.group_field, quasi=a.quasi, structural_z=a.structural_z)
    doc = {
        "source": "facet",
        "params": {"axes": axes, "pairs": [list(p) for p in pairs], "top": a.top, "boot": a.boot,
                   "seed": a.seed, "min_expected": a.min_expected, "thin_frac": a.thin_frac,
                   "quasi": a.quasi, "structural_z": a.structural_z, "structural_max_rounds": 5,
                   "k": k, "pca": space.dim, "neighbors": a.neighbors,
                   "group_field": a.group_field, "space_from": space_from,
                   "model": run.meta["model"], "tags": str(a.tags), "vocab": str(a.vocab)},
        "pca": {"dim": space.dim, "full_dim": int(X.shape[1]),
                "explained_variance": round(space.explained, 4),
                "path": "holes_pca.npz" if space.dim else None},
        "novelty": novelty_summary(d_knn, k),
        "novelty_path": "holes_novelty.npy",
        "tagging": tags.summary(len(run.items)),
        "pairs": res["pairs"],
        "gaps": res["gaps"],
    }
    write_json(run.path / "holes.json", doc)
    print(format_holes(doc))
    tg = doc["tagging"]
    if tg["untagged_items"] or tg["tag_rows_not_in_run"] or tg["unknown_values"]:
        print(f"\nwarning: {tg['untagged_items']} run item(s) have no tag row, "
              f"{tg['tag_rows_not_in_run']} tag row(s) match no run item, "
              f"values outside the vocabulary: {tg['unknown_values'] or 'none'}")
    print(f"\nwrote {run.path / 'holes.json'} ({len(doc['gaps'])} holes; use it as "
          f"`--gaps holes` in check, map and show)")
    return 0


# -------------------------------------------------------------- replicate

def _load_items(run_dir) -> list[dict]:
    """Items of a run directory; replication needs ids and titles, not embeddings."""
    d = Path(run_dir)
    if (d / "meta.json").is_file():
        items_path = d / read_json(d / "meta.json").get("items_path", "items.jsonl")
    else:
        items_path = d / "items.jsonl"
    if not items_path.is_file():
        raise InputError(f"{items_path} not found; run `embed` on the pooled corpus first")
    items = read_jsonl(items_path)
    for it in items:
        it.pop("__src__", None)
    return items


def cmd_replicate(a) -> int:
    if a.boot < 0:
        raise InputError("--boot must be non-negative")
    prereg = read_json(a.prereg)
    vocab, _ = load_vocab(a.vocab)
    items = _load_items(a.run)
    ids = {it["id"] for it in items}
    new_ids = {ln.strip() for ln in Path(a.new_ids).read_text(encoding="utf-8").splitlines()
               if ln.strip() and not ln.lstrip().startswith("#")}
    if not new_ids:
        raise InputError(f"{a.new_ids} lists no ids")
    cands_axes = sorted({ax for g in prereg.get("gaps", []) for ax in g.get("axes", [])})
    unknown = [ax for ax in cands_axes if ax not in vocab]
    if unknown:
        raise InputError(f"--prereg uses axes {unknown} that are not in the vocabulary")
    tags = Tags(items, cands_axes, vocab, a.tags)
    res = replicate_cells(prereg, items, tags, vocab, new_ids, min_expected=a.min_expected,
                          boot=a.boot, seed=a.seed, z=a.structural_z)
    missing = sorted(new_ids - ids)
    doc = {
        "source": "replication",
        "prereg": str(a.prereg), "tags": str(a.tags), "vocab": str(a.vocab),
        "new_ids_file": str(a.new_ids),
        "n_items": len(items), "n_new_ids": len(new_ids),
        "n_new_in_run": len(new_ids & ids),
        "new_ids_not_in_run": missing,
        "tagging": tags.summary(len(items)),
        **res,
    }
    out = Path(a.run)
    out.mkdir(parents=True, exist_ok=True)
    write_json(out / "replication.json", doc)
    print(f"{len(items):,} pooled items, {len(new_ids & ids):,} new "
          f"(tagged: " + ", ".join(f"{ax} {n}" for ax, n in doc["tagging"]["tagged"].items()) + ")")
    print(format_replication(doc))
    if missing:
        print(f"\nwarning: {len(missing)} id(s) in --new-ids are not in the run, e.g. {missing[:3]}")
    tg = doc["tagging"]
    if tg["untagged_items"] or tg["unknown_values"]:
        print(f"warning: {tg['untagged_items']} run item(s) have no tag row, "
              f"values outside the vocabulary: {tg['unknown_values'] or 'none'}")
    print(f"\nwrote {out / 'replication.json'}")
    return 0


# -------------------------------------------------------------- stability

def cmd_stability(a) -> int:
    run = Run(a.run)
    gdoc = run.gaps_doc()
    res = run_stability(run.X, gdoc, pca_list=a.pca, seeds=a.seeds, match=a.match, topk=a.topk,
                        samples=a.samples, progress=_log)
    for g, s in zip(gdoc["gaps"], res["stability"]):
        g["stability"] = s
    gdoc["stability_run"] = {k: res[k] for k in
                             ("match", "topk", "samples", "pca", "seeds", "n_reruns", "null")}
    write_json(run.path / "gaps.json", gdoc)
    write_json(run.path / "stability.json", res)

    best = np.array([s["best_cos"] for s in res["settings"]])  # (reruns, gaps)
    print(f"{res['n_reruns']} reruns (pca {res['pca']} x seeds {res['seeds']}), top-{res['topk']} "
          f"each, {res['samples']:,} samples; a gap is matched when a rerun's top list holds a gap "
          f"with full-space cosine >= {res['match']}")
    print(f"chance level (random coherent blends instead of a top list): {res['null']:.3f}")
    print(f"{'gap':8} {'stability':>9} {'median best cos':>16}  parents")
    for i, g in enumerate(gdoc["gaps"]):
        pt = " + ".join(_clip(p.get("title") or p["text"], 34) for p in g["parents"])
        print(f"{g['id']:8} {res['stability'][i]:9.2f} {np.median(best[:, i]):16.2f}  {pt}")
    print(f"\nwrote stability into {run.path / 'gaps.json'} and detail to "
          f"{run.path / 'stability.json'}")
    return 0


# ------------------------------------------------------------------ check

def _embed_concepts(run: Run, concept_files, a):
    concepts = load_records(expand_inputs(concept_files), kind="concept")
    emb, _ = embed_texts([c["text"] for c in concepts], model=run.meta["model"],
                         backend=a.backend, cache_dir=a.cache_dir, model_dir=a.model_dir,
                         batch_size=a.batch_size, verbose=False)
    return concepts, center(emb, run.mean)


def format_checks(results: list[dict], min_percentile: float) -> str:
    L = []
    for r in results:
        mark = "LANDS " if r["lands_in_gap"] else "misses"
        L.append(f"{mark} {r['id']}  {_label(r, 70)}")
        L.append(f"   novelty score={r['score']:.3f} (g1 {r['g1']:.3f}), emptier than "
                 f"{r['percentile']:.1f}% of items (needs >= {min_percentile:g}%)")
        if r.get("by_model"):
            L.append("   percentile by model: " + ", ".join(
                f"{m.split('/')[-1]} {v['percentile']:.1f}%" for m, v in r["by_model"].items()))
        gap_line = f"   nearest gap {r['nearest_gap']} (cos {r['nearest_gap_cos']:.2f})"
        if r.get("target_gap_cos") is not None:
            gap_line += f"; target {r['target_gap']} cos {r['target_gap_cos']:.2f}"
        gap_line += f"; best corpus cos {r['nearest_items'][0]['cos']:.2f} [{r['lands_basis']} basis]"
        L.append(gap_line)
        for n in r["nearest_items"][:3]:
            L.append(f"   near {n['cos']:.2f}  [{n['domain']}] {_label(n, 76)}")
    n_ok = sum(r["lands_in_gap"] for r in results)
    L.append("")
    L.append(f"{n_ok} of {len(results)} concepts land in a gap")
    return "\n".join(L)


def cmd_check(a) -> int:
    run = Run(a.run)
    doc = run.gaps_doc(a.gaps)
    par = doc["params"]
    space = run.space(doc)
    Y = space.project(run.X)
    concepts, Zc = _embed_concepts(run, a.concepts, a)
    Zs = space.project(Zc)
    d_sorted = np.sort(run.novelty(doc, Y))
    results = check_concepts(Zs, concepts, Y, run.items, doc["gaps"], d_sorted, k=par["k"],
                             n_neighbors=a.neighbors, min_percentile=a.min_percentile,
                             group_field=par.get("group_field", "domain"))
    models_doc = None
    if a.models:
        primary = run.meta["model"]
        listed = [m.strip() for m in a.models.split(",") if m.strip()]
        others = [m for m in dict.fromkeys(listed) if m != primary]
        by = novelty_by_model([it["text"] for it in run.items], [c["text"] for c in concepts],
                              others, pca=par["pca"], k=par["k"], backend=a.backend,
                              cache_dir=a.cache_dir, model_dir=a.model_dir,
                              batch_size=a.batch_size, verbose=False) if others else {}
        order = [m for m in dict.fromkeys(listed)]
        models_doc = {"primary": primary, "models": order,
                      "info": {m: {k: v for k, v in by[m].items() if k not in ("score", "percentile")}
                               for m in by}}
        for i, r in enumerate(results):
            r["by_model"] = {}
            for m in order:
                if m == primary:
                    r["by_model"][m] = {"score": r["score"], "percentile": r["percentile"]}
                else:
                    r["by_model"][m] = {"score": by[m]["score"][i], "percentile": by[m]["percentile"][i]}
    out = run.path / f"checks{_tag(a.gaps)}.json"
    write_json(out, {
        "params": {"min_percentile": a.min_percentile, "neighbors": a.neighbors,
                   "model": run.meta["model"], "k": par["k"], "pca": par["pca"],
                   "gaps": a.gaps, "gaps_source": doc.get("source", "blend"),
                   "cross_model": models_doc},
        "concepts": results})
    print(format_checks(results, a.min_percentile))
    print(f"\nwrote {out}")
    return 0


# -------------------------------------------------------------------- map

def cmd_map(a) -> int:
    from .mapviz import draw_png, umap_project

    run = Run(a.run)
    if a.gaps == "gaps.json":  # the default is optional: without it only the corpus is drawn
        gdoc = run.gaps_doc() if (run.path / "gaps.json").is_file() else None
    else:
        gdoc = run.gaps_doc(a.gaps)
    gaps = gdoc["gaps"] if gdoc else []
    if not gaps:
        _log("no gaps.json found: mapping the corpus only")
    space = run.space(gdoc)  # the same projection `find` and `check` used
    Y = space.project(run.X)
    G = np.asarray([g["vector"] for g in gaps], np.float32).reshape(len(gaps), Y.shape[1])
    concepts, Z, checks = [], np.zeros((0, Y.shape[1]), np.float32), []
    if a.concepts:
        concepts, Zc = _embed_concepts(run, a.concepts, a)
        Z = space.project(Zc)
        checks = check_concepts(Z, concepts, Y, run.items, gaps, np.sort(run.novelty(gdoc, Y)),
                                k=gdoc["params"]["k"], n_neighbors=1,
                                min_percentile=a.min_percentile) if gaps else \
            [dict(c, lands_in_gap=False) for c in concepts]

    _log(f"fitting UMAP on {len(run.items):,} items in {Y.shape[1]} dims (this is the slow step)")
    xy, (gxy, cxy) = umap_project(Y, [G, Z], n_neighbors=a.n_neighbors,
                                  min_dist=a.min_dist, seed=a.seed)

    r5 = lambda v: round(float(v), 5)  # noqa: E731
    points = [dict(it, x=r5(p[0]), y=r5(p[1])) for it, p in zip(run.items, xy)]
    gaps_out = [{"id": g["id"], "source": g.get("source", "blend"), "score": g["score"],
                 "percentile": g["percentile"], "stability": g.get("stability"),
                 "x": r5(p[0]), "y": r5(p[1]),
                 "parents": [q["id"] for q in g["parents"]],
                 "neighbors": [q["id"] for q in g["neighbors"]]}
                for g, p in zip(gaps, gxy)]
    concepts_out = [{"id": c["id"], "title": c.get("title"), "text": c["text"],
                     "target_gap": c.get("target_gap"), "x": r5(p[0]), "y": r5(p[1]),
                     "lands_in_gap": bool(k["lands_in_gap"])}
                    for c, k, p in zip(concepts, checks, cxy)]
    tag = _tag(a.gaps)
    write_json(run.path / f"map{tag}.json", {
        "params": {"n_neighbors": a.n_neighbors, "min_dist": a.min_dist, "metric": "cosine",
                   "random_state": a.seed, "space_dim": int(Y.shape[1]), "gaps": a.gaps,
                   "note": "2D picture only; scoring is in the working space"},
        "points": points, "gaps": gaps_out, "concepts": concepts_out})
    group_field = a.group_field
    groups = [str(it.get(group_field) if it.get(group_field) is not None else "unknown")
              for it in run.items]
    draw_png(run.path / f"map{tag}.png", xy, groups, gaps, gxy, concepts_out, cxy,
             group_field=group_field)
    print(f"mapped {len(points):,} items, {len(gaps_out)} gaps, {len(concepts_out)} concepts")
    print(f"wrote {run.path / f'map{tag}.json'} and {run.path / f'map{tag}.png'}")
    return 0


# ------------------------------------------------------------------- main

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="gapfind",
        description="Map a corpus in embedding space, find its biggest empty regions, "
                    "and score concepts that fill them.")
    p.add_argument("--version", action="version", version=f"gapfind {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    def emb_flags(sp, with_model: bool):
        if with_model:
            sp.add_argument("--model", default=DEFAULT_MODEL,
                            help="embedding model name (default %(default)s)")
        sp.add_argument("--backend", choices=["auto", "fastembed", "sentence-transformers"],
                        default="auto", help="auto = fastembed, then sentence-transformers")
        sp.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR,
                        help="embedding cache + model weights (default %(default)s)")
        sp.add_argument("--model-dir", default=None,
                        help="where model weights live (default <cache-dir>/models)")
        sp.add_argument("--batch-size", type=int, default=64)

    e = sub.add_parser("embed", help="embed JSONL files into a run directory")
    e.add_argument("inputs", nargs="+", help="JSONL files or globs with at least id and text")
    e.add_argument("--out", required=True, help="run directory to write")
    e.add_argument("--on-dup-id", choices=["error", "keep-first", "rename"], default="error",
                   help="what to do when two items share an id (default error)")
    emb_flags(e, True)
    e.set_defaults(fn=cmd_embed)

    f = sub.add_parser("find", help="sample blends between items and rank the emptiest spots")
    f.add_argument("--run", required=True)
    f.add_argument("--samples", type=int, default=320000)
    f.add_argument("--top", type=int, default=30)
    f.add_argument("--seed", type=int, default=42)
    f.add_argument("--k", type=int, default=5,
                   help="a blend's score is its mean cosine distance to its k nearest items "
                        "(default %(default)s)")
    f.add_argument("--pca", type=int, default=32,
                   help="do everything in the top-D principal axes of the centered corpus; "
                        "0 = full dimension (default %(default)s)")
    f.add_argument("--coh-band", type=float, nargs=2, metavar=("LO", "HI"), default=None,
                   help="keep blends whose coherence lies between these quantiles of "
                        "coherence (default 0.3 0.8)")
    f.add_argument("--coh-q", type=float, default=None,
                   help="alias: set only the band's lower quantile (the old coherence floor)")
    f.add_argument("--min-weight", type=float, default=0.0,
                   help="optional: only blends in which every parent has at least this weight "
                        "(0 = off, the default; try 0.25 to drop lopsided blends that are "
                        "really one item plus a whisper of others)")
    f.add_argument("--nms", type=float, default=0.25,
                   help="cosine distance within which a better gap suppresses a worse one "
                        "(default %(default)s)")
    f.add_argument("--p-k2", type=float, default=0.6,
                   help="probability of 2 parents; otherwise 3 (default %(default)s)")
    f.add_argument("--neighbors", type=int, default=8, help="nearest items listed per gap")
    f.add_argument("--batch", type=int, default=8192, help="samples per batch (memory only)")
    f.add_argument("--group-field", default="domain",
                   help="item field used for the neighbor mix (default %(default)s)")
    f.set_defaults(fn=cmd_find)

    fa = sub.add_parser("facets", help="find facet co-occurrence holes (a Zwicky box with an "
                                       "independence model and a bootstrap), validated in "
                                       "embedding space")
    fa.add_argument("--run", required=True)
    fa.add_argument("--tags", required=True, help="tags.jsonl: id plus one value per axis "
                                                  "(optionally <axis>_alt and agree)")
    fa.add_argument("--vocab", required=True, help="vocab.json: {axes: {axis: [{value, definition}]}}")
    fa.add_argument("--axes", nargs="+", default=None,
                    help="axes to analyze, every pair among them (default: all axes in the vocab)")
    fa.add_argument("--top", type=int, default=30, help="holes kept per axis pair")
    fa.add_argument("--boot", type=int, default=1000, help="bootstrap resamples")
    fa.add_argument("--seed", type=int, default=42)
    fa.add_argument("--min-expected", type=float, default=1.0,
                    help="an empty cell is only ranked as a hole if its expected count is at "
                         "least this (default %(default)s)")
    fa.add_argument("--thin-frac", type=float, default=0.25,
                    help="thin cell: observed >= 1 but <= this fraction of expected "
                         "(default %(default)s)")
    fa.add_argument("--quasi", action=argparse.BooleanOptionalAction, default=True,
                    help="rank holes by quasi-independence expected counts (cells above "
                         "--structural-z are masked and E is refitted by IPF); --no-quasi "
                         "uses plain independence (default: on)")
    fa.add_argument("--structural-z", type=float, default=3.0,
                    help="a cell with Pearson residual (O-E)/sqrt(E) above this is structural "
                         "(default %(default)s)")
    fa.add_argument("--pca", type=int, default=None,
                    help="working-space PCA dimension; default: the one `find` used, else 32")
    fa.add_argument("--k", type=int, default=None,
                    help="k for the embedding novelty; default: the one `find` used, else 5")
    fa.add_argument("--neighbors", type=int, default=8, help="nearest items listed per hole")
    fa.add_argument("--group-field", default="domain",
                    help="item field used for the neighbor mix (default %(default)s)")
    fa.set_defaults(fn=cmd_facets)

    rp = sub.add_parser("replicate", help="test pre-registered facet holes on a new sample "
                                          "and on the pooled sample (verdict per cell)")
    rp.add_argument("--prereg", required=True, help="the pre-registered holes.json")
    rp.add_argument("--run", required=True, help="run directory of the pooled corpus (items.jsonl); "
                                                 "replication.json is written here")
    rp.add_argument("--tags", required=True, help="tags.jsonl covering the pooled items")
    rp.add_argument("--vocab", required=True)
    rp.add_argument("--new-ids", required=True, help="text file, one id per line: the new sample")
    rp.add_argument("--min-expected", type=float, default=1.0,
                    help="registered cells need expected >= this; also the pooled BH family "
                         "(default %(default)s)")
    rp.add_argument("--boot", type=int, default=1000, help="bootstrap resamples (pooled data)")
    rp.add_argument("--seed", type=int, default=42)
    rp.add_argument("--structural-z", type=float, default=None,
                    help="quasi-independence z; default: the one in the prereg file, else 3.0")
    rp.set_defaults(fn=cmd_replicate)

    sh = sub.add_parser("show", help="print gaps.json (or holes.json) again, or as a table")
    sh.add_argument("--run", required=True)
    sh.add_argument("--gaps", default="gaps.json", help="which gaps document to use: gaps.json (blend gaps from `find`, default) or "
                        "holes / holes.json (facet holes from `facets`)")
    sh.add_argument("--table", action="store_true", help="one markdown row per gap")
    sh.add_argument("--neighbors", type=int, default=3, help="nearest items shown per gap")
    sh.set_defaults(fn=cmd_show)

    s = sub.add_parser("stability", help="re-run find under other PCA dims and seeds and "
                                         "record how often each gap comes back")
    s.add_argument("--run", required=True)
    s.add_argument("--pca", type=int, nargs="+", default=[16, 32, 64],
                   help="PCA dimensions to re-run with (default 16 32 64)")
    s.add_argument("--seeds", type=int, nargs="+", default=[1, 2, 3],
                   help="seeds to re-run with (default 1 2 3)")
    s.add_argument("--match", type=float, default=0.8,
                   help="two gaps match when the cosine of their full-dimension centered "
                        "vectors is at least this (default %(default)s)")
    s.add_argument("--topk", type=int, default=None,
                   help="size of each re-run's top list (default: the primary run's --top)")
    s.add_argument("--samples", type=int, default=None,
                   help="samples per re-run (default: the primary run's)")
    s.set_defaults(fn=cmd_stability)

    c = sub.add_parser("check", help="score concept texts against the corpus and the gaps")
    c.add_argument("--run", required=True)
    c.add_argument("concepts", nargs="+", help="JSONL with id, text, optional title, target_gap")
    c.add_argument("--gaps", default="gaps.json", help="which gaps document to use: gaps.json (blend gaps from `find`, default) or "
                        "holes / holes.json (facet holes from `facets`)")
    c.add_argument("--neighbors", type=int, default=5)
    c.add_argument("--min-percentile", type=float, default=90.0,
                   help="novelty percentile a concept needs to land in a gap (default %(default)s)")
    c.add_argument("--models", default=None,
                   help="comma-separated embedding models; reports each concept's novelty "
                        "percentile under each (lands_in_gap stays in the run's own model)")
    emb_flags(c, False)
    c.set_defaults(fn=cmd_check)

    m = sub.add_parser("map", help="2D UMAP picture (map.json + map.png)")
    m.add_argument("--run", required=True)
    m.add_argument("--gaps", default="gaps.json", help="which gaps document to use: gaps.json (blend gaps from `find`, default) or "
                        "holes / holes.json (facet holes from `facets`)")
    m.add_argument("--concepts", nargs="+", default=None, help="concept JSONL file(s) to overlay")
    m.add_argument("--n-neighbors", type=int, default=15)
    m.add_argument("--min-dist", type=float, default=0.1)
    m.add_argument("--seed", type=int, default=42)
    m.add_argument("--group-field", default="domain", help="field that colors the points")
    m.add_argument("--min-percentile", type=float, default=90.0)
    emb_flags(m, False)
    m.set_defaults(fn=cmd_map)
    return p


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    args = build_parser().parse_args(argv)
    try:
        return args.fn(args)
    except InputError as e:
        print(f"gapfind: error: {e}", file=sys.stderr)
        return 2
