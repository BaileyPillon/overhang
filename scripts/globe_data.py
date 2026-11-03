"""Build the globe data of the Overhang app from a gapfind run.

    .venv\\Scripts\\python.exe -I scripts\\globe_data.py --run runs/r2

Reads (never writes): runs/<run>/{items.jsonl, emb.npy, mean.npy, pca.npz, holes.json},
corpus/facets/tags.jsonl (the path recorded in holes.json params, else this one).
Writes only runs/<run>/globe/ (override with --out):

  globe.json        points (lat/lon + 6 nearest neighbours on the globe), continents, holes, land, stats
  land.png          360x180 equirectangular vMF-KDE density, 8 bit (threshold in globe.json -> land.threshold_8bit)
  live_index.bin    int8 (n x 384) bge-small-en-v1.5 embeddings of every item's "text", row-major, ids order
  live_index.json   dims, per-dimension scale, ids order, model ids (fastembed + transformers.js), recipe, validation
  preview.png       equirectangular scatter by domain with continents outlined and holes marked
  umap_embedding.npy, bge_small_f32.npy   caches (UMAP and the float32 bge-small vectors); delete to recompute

Geometry (as the mockups/globe/sphere.py prototype): spherical UMAP (output_metric haversine, metric cosine,
n_neighbors 15, min_dist 0.1, random_state 42) on the centered PCA-32 vectors; UMAP-docs xyz mapping
x=sin(e0)cos(e1), y=sin(e0)sin(e1), z=cos(e0); lat/lon recomputed from xyz. Land = top 30 percent of the
sphere's area under a von Mises-Fisher KDE (kappa 40) of the item positions.

Live placement recipe (what the browser repeats, see live_index.json "recipe"): embed the report text with
Xenova/bge-small-en-v1.5 (cls pooling, normalize), take the 8 nearest corpus rows by cosine, weight them, and
position = normalize(sum w_j * xyz_j). Facet guess = majority vote of the same 8 neighbours.
"""

from __future__ import annotations

import argparse
import collections
import json
import math
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
AXES = ["move", "material", "for"]
H, W = 180, 360                     # land grid: 1 degree cells, cell centres
LIVE_MODEL = "BAAI/bge-small-en-v1.5"
LIVE_BROWSER_ID = "Xenova/bge-small-en-v1.5"


def log(*a):
    print("[globe]", *a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- small helpers

def l2n(a):
    a = np.asarray(a, np.float64)
    return a / np.maximum(np.linalg.norm(a, axis=-1, keepdims=True), 1e-12)


def ang(a, b):
    """Degrees between unit vectors, all pairs."""
    return np.degrees(np.arccos(np.clip(a @ b.T, -1.0, 1.0)))


def ll_deg(v):
    return (float(np.degrees(np.arcsin(np.clip(v[2], -1, 1)))), float(np.degrees(np.arctan2(v[1], v[0]))))


def xyz_of(lat_deg, lon_deg):
    la, lo = np.radians(lat_deg), np.radians(lon_deg)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], -1)


def read_jsonl(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        return [json.loads(l) for l in f if l.strip()]


def write_json(path, obj):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def pretty_domain(d):
    return d.replace("-", " / ")


def pct(x, q):
    return float(np.percentile(x, q))


# ---------------------------------------------------------------- load

def load_run(run_dir: Path):
    items = read_jsonl(run_dir / "items.jsonl")
    ids = [it["id"] for it in items]
    if len(set(ids)) != len(ids):
        raise SystemExit("duplicate item ids")
    raw = np.load(run_dir / "emb.npy")
    mean = np.load(run_dir / "mean.npy")
    comps = np.load(run_dir / "pca.npz")["components"]
    holes = json.load(open(run_dir / "holes.json", encoding="utf-8"))
    tags_rel = holes.get("params", {}).get("tags") or "corpus/facets/tags.jsonl"
    tags_path = (ROOT / tags_rel) if not Path(tags_rel).is_absolute() else Path(tags_rel)
    tags = {r["id"]: r for r in read_jsonl(tags_path)}
    missing = [i for i in ids if i not in tags]
    if missing:
        raise SystemExit(f"{len(missing)} items without tags, e.g. {missing[:3]}")
    if raw.shape[0] != len(items):
        raise SystemExit(f"emb.npy rows {raw.shape[0]} != items {len(items)}")
    return items, ids, raw, mean, comps, holes, tags, tags_path


# ---------------------------------------------------------------- sphere

def umap_sphere(Z, seed, cache: Path, force: bool):
    if cache.exists() and not force:
        emb = np.load(cache)
        if emb.shape == (Z.shape[0], 2):
            log("UMAP embedding from cache", cache.name)
            return emb
    import umap
    log("fitting spherical UMAP (haversine) ...")
    t0 = time.time()
    m = umap.UMAP(output_metric="haversine", metric="cosine", n_neighbors=15, min_dist=0.1, random_state=seed)
    emb = m.fit_transform(Z)
    log(f"UMAP done in {time.time() - t0:.0f}s")
    np.save(cache, emb)
    return emb


def to_xyz(emb):
    # UMAP docs sphere example. (The literal haversine lat/lon reading of the two columns scored far lower
    # on neighbour domain purity in the r1 prototype; stats.mapping_check re-measures both on this run.)
    e0, e1 = emb[:, 0], emb[:, 1]
    return np.stack([np.sin(e0) * np.cos(e1), np.sin(e0) * np.sin(e1), np.cos(e0)], 1)


def knn(D, k):
    D = D.copy()
    np.fill_diagonal(D, np.inf)
    idx = np.argsort(D, 1)[:, :k]
    return idx


def purity(idx, labels):
    return float(np.mean([(labels[idx[i]] == labels[i]).mean() for i in range(len(labels))]))


# ---------------------------------------------------------------- land

def density_grid(xyz, kappa, chunk=4096):
    glat = 89.5 - np.arange(H)
    glon = -179.5 + np.arange(W)
    LA, LO = np.meshgrid(np.radians(glat), np.radians(glon), indexing="ij")
    grid = np.stack([np.cos(LA) * np.cos(LO), np.cos(LA) * np.sin(LO), np.sin(LA)], -1).reshape(-1, 3)
    cnorm = kappa / (2 * math.pi * (1 - math.exp(-2 * kappa)))     # vMF normaliser on S2
    out = np.empty(len(grid))
    for a in range(0, len(grid), chunk):
        out[a:a + chunk] = np.exp(kappa * (grid[a:a + chunk] @ xyz.T - 1.0)).sum(1)
    dens = (out * cnorm / len(xyz)).reshape(H, W)
    area = np.cos(np.radians(glat))[:, None] * np.ones((1, W))
    area /= area.sum()                                              # fraction of the sphere per cell
    return dens, area, grid, glat, glon


def land_threshold(dens, area, cover):
    order = np.argsort(dens.ravel())
    cum = np.cumsum(area.ravel()[order])
    return float(dens.ravel()[order][np.searchsorted(cum, 1 - cover)])


def label_land(land):
    """4-connected components of the land mask on the sphere: longitude wraps, and all land cells of the
    top (bottom) row are one component because they all touch the pole."""
    from scipy import ndimage
    lab, nl = ndimage.label(land)
    par = list(range(nl + 1))

    def find(a):
        while par[a] != a:
            par[a] = par[par[a]]
            a = par[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            par[ra] = rb

    for r in range(H):
        if lab[r, 0] and lab[r, -1]:
            union(lab[r, 0], lab[r, -1])
    for r in (0, H - 1):
        row = np.unique(lab[r][lab[r] > 0])
        for a in row[1:]:
            union(row[0], a)
    roots = {i: find(i) for i in range(1, nl + 1)}
    out = np.zeros_like(lab)
    for i, r in roots.items():
        out[lab == i] = r
    return out


# ---------------------------------------------------------------- holes

def sph_centroid(xyz, idx):
    s = xyz[idx].sum(0)
    n = float(np.linalg.norm(s))
    return s / max(n, 1e-12), n / max(len(idx), 1)


# ---------------------------------------------------------------- live layer

def embed_small(texts, cache_npy: Path, model_dir: Path, force: bool):
    """float32 bge-small-en-v1.5 vectors of `texts` through fastembed (L2-normalised), with a pooling check."""
    info = {}
    if cache_npy.exists() and not force:
        v = np.load(cache_npy)
        if v.shape[0] == len(texts):
            log("bge-small vectors from cache", cache_npy.name)
            return v.astype(np.float32), info
    from fastembed import TextEmbedding
    log(f"embedding {len(texts)} texts with {LIVE_MODEL} (fastembed, cache dir {model_dir}) ...")
    t0 = time.time()
    m = TextEmbedding(model_name=LIVE_MODEL, cache_dir=str(model_dir))
    vecs = np.asarray(list(m.embed(texts, batch_size=64)), np.float32)
    vecs /= np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-12)
    log(f"embedded in {time.time() - t0:.0f}s, shape {vecs.shape}")
    np.save(cache_npy, vecs)
    return vecs, info


def pooling_check(model_dir: Path, texts):
    """Which pooling does fastembed's bge-small apply? Re-run the ONNX graph and compare CLS vs mean pooling
    with what TextEmbedding.embed returns."""
    try:
        from fastembed import TextEmbedding
        m = TextEmbedding(model_name=LIVE_MODEL, cache_dir=str(model_dir))
        sample = texts[:16]
        ref = np.asarray(list(m.embed(sample)), np.float64)
        ctx = m.model.onnx_embed(sample)
        hid = np.asarray(ctx.model_output, np.float64)
        mask = np.asarray(ctx.attention_mask, np.float64)[:, :, None]
        cls = l2n(hid[:, 0])
        mean = l2n((hid * mask).sum(1) / mask.sum(1))
        desc = [d for d in TextEmbedding.list_supported_models() if d["model"] == LIVE_MODEL][0]
        return {"checked_on": len(sample),
                "cos_cls_vs_fastembed_min": round(float((cls * ref).sum(1).min()), 6),
                "cos_mean_pool_vs_fastembed_mean": round(float((mean * ref).sum(1).mean()), 4),
                "fastembed_pooling": "cls" if (cls * ref).sum(1).min() > 0.9999 else "unknown",
                "fastembed_source_repo": desc["sources"]["hf"], "fastembed_model_file": desc["model_file"],
                "max_tokens": 512}
    except Exception as e:   # non-fatal: the recipe stays valid, only the evidence is missing
        return {"error": f"{type(e).__name__}: {e}"}


def quantize_int8(V):
    """Per-dimension symmetric int8: q = round(v / scale_d), scale_d = max_i |v_id| / 127."""
    scale = np.abs(V).max(0) / 127.0
    scale = np.maximum(scale, 1e-12)
    q = np.clip(np.round(V / scale), -127, 127).astype(np.int8)
    return q, scale.astype(np.float32)


def dequant(q, scale):
    return q.astype(np.float32) * scale.astype(np.float32)


def place(sims, nbr_idx, xyz, scheme):
    """Weighted position from neighbour rows. sims (n,k) cosine to each neighbour, nbr_idx (n,k)."""
    kind, tau = scheme
    if kind == "uniform":
        w = np.ones_like(sims)
    elif kind == "softmax":
        w = np.exp((sims - sims[:, :1]) / tau)     # sims sorted descending: relative to the best neighbour
    elif kind == "shifted":                         # linear in similarity above the k-th neighbour
        w = np.maximum(sims - sims[:, -1:] + tau, 1e-9)
    else:
        raise ValueError(kind)
    s = (w[:, :, None] * xyz[nbr_idx]).sum(1)
    return l2n(s), w


def topk_sims(Q, C, k, exclude_self=True):
    S = Q @ C.T
    if exclude_self:
        np.fill_diagonal(S, -np.inf)
    idx = np.argpartition(-S, k, axis=1)[:, :k]
    ss = np.take_along_axis(S, idx, 1)
    o = np.argsort(-ss, 1)
    return np.take_along_axis(ss, o, 1), np.take_along_axis(idx, o, 1)


def vote(labels, nbr_idx, w, vocab_index):
    """Majority vote of the neighbours' labels; ties broken by summed weight. Returns (guess, share)."""
    n, k = nbr_idx.shape
    lab = labels[nbr_idx]
    guess = np.empty(n, dtype=object)
    share = np.zeros(n)
    for i in range(n):
        cnt = collections.Counter(lab[i])
        wsum = collections.defaultdict(float)
        for j in range(k):
            wsum[lab[i][j]] += w[i][j]
        best = max(cnt, key=lambda v: (cnt[v], wsum[v]))
        guess[i] = best
        share[i] = cnt[best] / k
    return guess, share


def live_validation(Fc, qdeq, xyz, tags, ids, k, schemes):
    """Leave-one-out placement of every corpus item from the others.
    Fc: float query vectors (as the browser gets them from the model), qdeq: dequantised, row-normalised index."""
    n = len(ids)
    sims, nbr = topk_sims(Fc.astype(np.float32), qdeq, k)
    rows = []
    errs = {}
    for sch in schemes:
        pos, w = place(sims, nbr, xyz, sch)
        e = np.degrees(np.arccos(np.clip((pos * xyz).sum(1), -1, 1)))
        errs[sch] = (e, w)
        rows.append({"weights": sch[0], "tau": sch[1] if sch[0] != "uniform" else None,
                     "median_deg": round(pct(e, 50), 2), "p90_deg": round(pct(e, 90), 2),
                     "mean_deg": round(float(e.mean()), 2)})
    return sims, nbr, rows, errs


# ---------------------------------------------------------------- preview

def make_preview(path, dens, thr, comp, ncomp, conts, lon, lat, dom, holes, glat, glon):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    cnt = collections.Counter(dom)
    doms = sorted(cnt, key=lambda d: -cnt[d])
    # 8 validated categorical hues x 2 marker shapes = 16 domains (colour + shape: identity is never colour-alone)
    hues = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
    shapes = ["o", "^"]
    ink, ink2, surf = "#0b0b0b", "#52514e", "#fcfcfb"
    fig, ax = plt.subplots(figsize=(17, 8.4), dpi=130)
    fig.patch.set_facecolor(surf)
    ax.set_facecolor(surf)
    ax.imshow(dens, extent=[-180, 180, -90, 90], cmap="Greys", alpha=0.45, vmin=0, vmax=dens.max())
    ax.contour(glon, glat, dens, levels=[thr], colors=ink, linewidths=1.1)
    for k, d in enumerate(doms):
        m = dom == d
        ax.scatter(lon[m], lat[m], s=16, marker=shapes[(k // 8) % 2], color=hues[k % 8],
                   label=f"{d} ({cnt[d]})", edgecolor=surf, linewidths=0.4, zorder=3)
    for c in conts:
        ax.annotate(f"C{c['k']}", (c["lon"], c["lat"]), fontsize=11, fontweight="bold", color=ink, ha="center",
                    va="center", zorder=5, bbox=dict(boxstyle="round,pad=0.15", fc=surf, ec=ink, lw=0.8, alpha=0.9))
    for n, h in enumerate(holes, 1):
        ax.scatter(h["lon"], h["lat"], marker="X", s=70, c=ink, edgecolors="white", linewidths=0.9, zorder=6)
    ax.set_xlim(-180, 180)
    ax.set_ylim(-90, 90)
    ax.set_aspect("equal")
    ax.set_xticks(range(-180, 181, 60))
    ax.set_yticks(range(-90, 91, 30))
    ax.tick_params(colors=ink2, labelsize=8)
    ax.grid(color="#d9d8d3", lw=0.5)
    for s in ax.spines.values():
        s.set_color("#c3c2b7")
    ax.set_xlabel("longitude", color=ink2)
    ax.set_ylabel("latitude", color=ink2)
    leg = ax.legend(fontsize=8, ncol=1, bbox_to_anchor=(1.01, 1), loc="upper left", frameon=False, markerscale=1.4)
    for t in leg.get_texts():
        t.set_color(ink)
    ax.set_title(f"Overhang corpus on S2 (spherical UMAP) - {len(lon)} items, {len(conts)} continents "
                 f"(outline = land), X = facet hole ({len(holes)})", color=ink, fontsize=11, loc="left")
    fig.tight_layout()
    fig.savefig(path, facecolor=surf)
    plt.close(fig)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--run", default="runs/r2", help="run directory (relative to the repo root or absolute)")
    ap.add_argument("--out", default=None, help="output directory (default <run>/globe)")
    ap.add_argument("--kappa", type=float, default=40.0, help="vMF KDE concentration")
    ap.add_argument("--cover", type=float, default=0.30, help="fraction of the sphere's area that is land")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--nn", type=int, default=6, help="neighbours per item on the globe")
    ap.add_argument("--live-k", type=int, default=8, help="neighbours used to place a new report")
    ap.add_argument("--min-continent-area", type=float, default=0.005,
                    help="components under this fraction of the sphere (or with no item on land) are islands, not continents")
    ap.add_argument("--min-expected", type=float, default=1.0, help="holes with expected below this are dropped")
    ap.add_argument("--model-dir", default=str(ROOT / ".cache" / "models"))
    ap.add_argument("--skip-live", action="store_true")
    ap.add_argument("--force-umap", action="store_true")
    ap.add_argument("--force-embed", action="store_true")
    args = ap.parse_args()

    run_dir = Path(args.run)
    run_dir = run_dir if run_dir.is_absolute() else ROOT / run_dir
    out = Path(args.out) if args.out else run_dir / "globe"
    if not out.is_absolute():
        out = ROOT / out
    out.mkdir(parents=True, exist_ok=True)
    run_name = run_dir.name

    items, ids, raw, mean, comps, holes_doc, tags, tags_path = load_run(run_dir)
    N = len(items)
    dom = np.array([it["domain"] for it in items])
    texts = [it["text"] for it in items]
    log(f"run {run_name}: {N} items, tags {tags_path.name}")

    # ---- the space UMAP sees: centered, PCA-32, unit (gapfind.core.center / Space.project)
    Xc = l2n(raw - mean)
    Z = l2n(Xc @ comps.T)

    # ---- sphere
    emb = umap_sphere(Z, args.seed, out / "umap_embedding.npy", args.force_umap)
    xyz = to_xyz(emb)
    lat = np.degrees(np.arcsin(np.clip(xyz[:, 2], -1, 1)))
    lon = np.degrees(np.arctan2(xyz[:, 1], xyz[:, 0]))

    # ---- neighbours: globe vs full space (centered 768-d, cosine) vs PCA-32
    NN = args.nn
    G = ang(xyz, xyz)
    F = ang(Xc, Xc)
    P = ang(Z, Z)
    gnn, fnn, pnn = knn(G, NN), knn(F, NN), knn(P, NN)
    overlap = float(np.mean([len(set(gnn[i]) & set(fnn[i])) / NN for i in range(N)]))
    overlap_p = float(np.mean([len(set(gnn[i]) & set(pnn[i])) / NN for i in range(N)]))
    cnt = collections.Counter(dom)
    chance = sum(c * (c - 1) for c in cnt.values()) / (N * (N - 1))    # leave-one-out chance of a same-domain neighbour
    pur_g, pur_f, pur_p = purity(gnn, dom), purity(fnn, dom), purity(pnn, dom)
    # alternative (literal haversine lat/lon) reading of the UMAP columns, for the record
    xyz_alt = xyz_of(np.degrees(emb[:, 0]), np.degrees(emb[:, 1]))
    pur_alt = purity(knn(ang(xyz_alt, xyz_alt), NN), dom)

    # ---- land
    log("density field ...")
    dens, area, grid, glat, glon = density_grid(xyz, args.kappa)
    thr = land_threshold(dens, area, args.cover)
    land = dens >= thr
    coverage = float(area[land].sum())
    comp = label_land(land)
    cell_r = np.clip(np.floor(90 - lat).astype(int), 0, H - 1)
    cell_c = np.floor(lon + 180).astype(int) % W
    pcomp = comp[cell_r, cell_c].astype(int)
    on_land = pcomp > 0

    roots = sorted(set(comp[land].tolist()), key=lambda r: -area[comp == r].sum())
    land_items = collections.Counter(pcomp[on_land].tolist())
    cont_roots = [r for r in roots if area[comp == r].sum() >= args.min_continent_area and land_items.get(r, 0) > 0]
    isl_roots = [r for r in roots if r not in cont_roots]
    log(f"{len(roots)} land components -> {len(cont_roots)} continents + {len(isl_roots)} islands")
    kmap = {r: k for k, r in enumerate(cont_roots, 1)}
    gflat = grid
    cont_cells = {k: gflat[(comp == r).ravel()] for r, k in kmap.items()}
    # every item gets a continent: the one it sits on, else the one with the nearest land cell
    item_cont = np.zeros(N, int)
    offshore = np.zeros(N, bool)
    allland_cells = gflat[np.isin(comp.ravel(), list(kmap) + isl_roots)]
    for i in range(N):
        r = int(pcomp[i])
        if r in kmap:
            item_cont[i] = kmap[r]
        else:
            offshore[i] = True
            item_cont[i] = max(cont_cells, key=lambda k: (cont_cells[k] @ xyz[i]).max())

    def top(counter, n, total):
        return [{"value": v, "n": int(c), "share": round(c / total, 3)} for v, c in counter.most_common(n)]

    conts = []
    for r, k in kmap.items():
        msk = comp == r
        inside = np.where((item_cont == k) & ~offshore)[0]
        assigned = np.where(item_cont == k)[0]
        wts = np.broadcast_to(area, comp.shape)[msk]
        cen = l2n((gflat[msk.ravel()] * wts[:, None]).sum(0))
        clat, clon = ll_deg(cen)
        tot = max(len(inside), 1)
        dcount = collections.Counter(dom[inside])
        conts.append({
            "id": f"C{k}", "k": k, "name": None,
            "lat": round(clat, 2), "lon": round(clon, 2),
            "area_pct": round(100 * float(area[msk].sum()), 2),
            "share_of_land_pct": round(100 * float(area[msk].sum()) / coverage, 1),
            "cells": int(msk.sum()),
            "n_items_on_land": int(len(inside)), "n_items_offshore_assigned": int(len(assigned) - len(inside)),
            "top_domains": [{"domain": v, "n": int(c), "share": round(c / tot, 3)} for v, c in dcount.most_common(5)],
            "top_moves": top(collections.Counter(tags[ids[i]]["move"] for i in inside), 3, tot),
            "top_materials": top(collections.Counter(tags[ids[i]]["material"] for i in inside), 3, tot),
            "top_for": top(collections.Counter(tags[ids[i]]["for"] for i in inside), 3, tot),
            "top_domain_purity": round(dcount.most_common(1)[0][1] / tot, 3) if dcount else None,
        })
    # names: top domain, "devices-home" -> "devices / home"; a mixed continent (top domain under 40 percent of its
    # items) names its top two domains; continents that still share a name get their most over-represented facet value
    corpus_share = {ax: collections.Counter(tags[i][ax] for i in ids) for ax in AXES}
    for c in conts:
        td = c["top_domains"]
        c["name"] = pretty_domain(td[0]["domain"])
        if td[0]["share"] < 0.40 and len(td) > 1 and td[1]["share"] >= 0.20:
            c["name"] += " + " + pretty_domain(td[1]["domain"])
    for c in conts:
        c["name_short"] = c["name"]
    by_name = collections.defaultdict(list)
    for c in conts:
        by_name[c["name"]].append(c)
    for name, group in by_name.items():
        if len(group) < 2:
            continue
        for c in group:
            members = [i for i in range(N) if item_cont[i] == c["k"] and not offshore[i]]
            best, best_lift = None, 0.0
            for ax in AXES:
                cc = collections.Counter(tags[ids[i]][ax] for i in members)
                for v, n in cc.items():
                    sh = n / max(len(members), 1)
                    lift = sh / (corpus_share[ax][v] / N)
                    if sh >= 0.25 and lift > best_lift:
                        best, best_lift = v, lift
            c["name"] = f"{name} - {best}" if best else name
    used = collections.Counter(c["name"] for c in conts)
    n_seen = collections.Counter()
    for c in conts:
        if used[c["name"]] > 1:
            n_seen[c["name"]] += 1
            c["name"] += f" ({n_seen[c['name']]})"
    islands = []
    for r in isl_roots:
        msk = comp == r
        cen = l2n((gflat[msk.ravel()] * np.broadcast_to(area, comp.shape)[msk][:, None]).sum(0))
        la, lo = ll_deg(cen)
        islands.append({"lat": round(la, 2), "lon": round(lo, 2), "area_pct": round(100 * float(area[msk].sum()), 3),
                        "n_items_on_land": int(land_items.get(r, 0))})

    # ---- holes
    holes = []
    for g in holes_doc["gaps"]:
        if g["expected"] < args.min_expected:
            continue
        a1, a2 = g["axes"]
        v1, v2 = g["cell"][a1], g["cell"][a2]
        ri = [k for k, i in enumerate(ids) if tags[i][a1] == v1]
        ci = [k for k, i in enumerate(ids) if tags[i][a2] == v2]
        c1, R1 = sph_centroid(xyz, ri)
        c2, R2 = sph_centroid(xyz, ci)
        mid = c1 + c2
        degenerate = bool(np.linalg.norm(mid) < 1e-3)         # antipodal coasts: no midpoint exists
        mid = l2n(mid) if not degenerate else c1
        mla, mlo = ll_deg(mid)
        rr = int(np.clip(np.floor(90 - mla), 0, H - 1))
        cc = int(np.floor(mlo + 180)) % W
        dpos = float(dens[rr, cc])
        holes.append({
            "id": g["id"], "axes": g["axes"], "cell": g["cell"], "rank": g.get("rank"),
            "observed": g["observed"], "expected": round(g["expected"], 3), "p": round(g["p"], 5),
            "q": None if g.get("q") is None else round(g["q"], 4), "stability": g.get("stability"),
            "structural": g.get("structural"), "tag_robust": g.get("tag_robust"),
            "lat": round(mla, 3), "lon": round(mlo, 3),
            "sep_deg": round(float(np.degrees(np.arccos(np.clip(c1 @ c2, -1, 1)))), 2),
            "density": round(dpos, 4), "on_land": bool(dpos >= thr), "degenerate": degenerate,
            "diffuse": bool(min(R1, R2) < 0.5),     # a coast whose items are spread over the globe has a weak centroid
            "row": {"axis": a1, "value": v1, "n": len(ri), "lat": round(ll_deg(c1)[0], 3), "lon": round(ll_deg(c1)[1], 3),
                    "R": round(R1, 3), "ids": [ids[k] for k in ri]},
            "col": {"axis": a2, "value": v2, "n": len(ci), "lat": round(ll_deg(c2)[0], 3), "lon": round(ll_deg(c2)[1], 3),
                    "R": round(R2, 3), "ids": [ids[k] for k in ci]},
        })

    # ---- stats
    stats = {
        "n": N, "nn": NN,
        "domain_purity_at6": {"globe": round(pur_g, 3), "full_space": round(pur_f, 3), "chance": round(chance, 3),
                              "pca32_space": round(pur_p, 3)},
        "neighbour_overlap_globe_vs_full_at6": round(overlap, 3),
        "neighbour_overlap_globe_vs_pca32_at6": round(overlap_p, 3),
        "overlap_chance_at6": round(NN / (N - 1), 4),
        "mapping_check": {"docs_xyz_mapping_purity": round(pur_g, 3), "literal_latlon_reading_purity": round(pur_alt, 3)},
        "globe_nn_deg": {"median": round(float(np.median(np.take_along_axis(G, gnn, 1))), 2),
                         "p90": round(pct(np.take_along_axis(G, gnn, 1), 90), 2)},
        "holes": {"n": len(holes), "on_land": int(sum(h["on_land"] for h in holes)),
                  "degenerate": int(sum(h["degenerate"] for h in holes)),
                  "diffuse": int(sum(h["diffuse"] for h in holes)),
                  "sep_deg_median": round(float(np.median([h["sep_deg"] for h in holes])), 1) if holes else None},
        "n_continents": len(conts), "n_islands": len(islands),
        "items_on_land": int(on_land.sum()), "items_offshore": int(offshore.sum()),
    }

    # ---- land.png (8 bit: pixel = round(255 * density / density_max))
    from PIL import Image
    png = np.round(255 * dens / dens.max()).astype(np.uint8)
    Image.fromarray(png, "L").save(out / "land.png", optimize=True)
    thr8 = int(round(255 * thr / dens.max()))
    land_meta = {"png": "land.png", "width": W, "height": H, "lat_top": 89.5, "lon_left": -179.5, "step_deg": 1,
                 "row0": "north", "col0": "west (lon -180)",
                 "png_scale": "pixel = round(255 * density / density_max); density = pixel / 255 * density_max",
                 "density_max": float(dens.max()), "density_min": float(dens.min()),
                 "threshold": thr, "threshold_8bit": thr8, "land_if": "density >= threshold  (pixel >= threshold_8bit)",
                 "coverage_target": args.cover, "coverage": round(coverage, 4), "kappa": args.kappa,
                 "kernel": "von Mises-Fisher KDE of the item positions, density per steradian"}

    # ---- globe.json (live-layer validation is appended below, but globe.json is written first)
    points = []
    for i in range(N):
        p = {"id": ids[i], "lat": round(float(lat[i]), 3), "lon": round(float(lon[i]), 3),
             "nn": [[ids[j], round(float(G[i, j]), 2)] for j in gnn[i]], "cont": int(item_cont[i])}
        if offshore[i]:
            p["offshore"] = True
        points.append(p)
    globe = {
        "version": 1, "run": run_name, "n": N,
        "projection": {"method": "UMAP", "output_metric": "haversine", "metric": "cosine", "n_neighbors": 15,
                       "min_dist": 0.1, "random_state": args.seed, "input": "centered PCA-32 (unit) from the run",
                       "xyz": "x=sin(e0)cos(e1), y=sin(e0)sin(e1), z=cos(e0) from the UMAP columns (e0,e1); "
                              "lat=asin(z), lon=atan2(y,x)"},
        "land": land_meta,
        "points": points, "continents": conts, "islands": islands, "holes": holes, "stats": stats,
    }
    write_json(out / "globe.json", globe)
    log("globe.json, land.png written")

    make_preview(out / "preview.png", dens, thr, comp, len(conts), conts, lon, lat, dom, holes, glat, glon)
    log("preview.png written")

    # ---- live layer
    live_report = None
    if not args.skip_live:
        model_dir = Path(args.model_dir)
        V, _ = embed_small(texts, out / "bge_small_f32.npy", model_dir, args.force_embed)
        pool = pooling_check(model_dir, texts)
        log("pooling check:", pool)
        k = args.live_k
        # variants: raw cosine vs corpus-mean-centered cosine
        mu = V.mean(0)
        variants = {"raw": (V, None), "centered": (l2n(V - mu).astype(np.float32), mu)}
        schemes = [("uniform", 0), ("softmax", 0.01), ("softmax", 0.02), ("softmax", 0.05), ("shifted", 0.02)]
        results = {}
        for name, (Vv, m_) in variants.items():
            q, scale = quantize_int8(Vv)
            deq = dequant(q, scale)
            deqn = (deq / np.maximum(np.linalg.norm(deq, axis=1, keepdims=True), 1e-12)).astype(np.float32)
            sims, nbr, rows, errs = live_validation(Vv, deqn, xyz, tags, ids, k, schemes)
            results[name] = {"q": q, "scale": scale, "deqn": deqn, "sims": sims, "nbr": nbr, "rows": rows, "errs": errs, "mu": m_}
            log(name, [(r["weights"], r["tau"], r["median_deg"], r["p90_deg"]) for r in rows])
        # pick: lowest median error; prefer the simpler raw variant unless centering wins by > 0.5 deg
        best = {}
        for name, r in results.items():
            b = min(r["rows"], key=lambda x: (x["median_deg"], x["p90_deg"]))
            best[name] = b
        choose = "raw"
        if best["centered"]["median_deg"] < best["raw"]["median_deg"] - 0.5:
            choose = "centered"
        R = results[choose]
        bsch = best[choose]
        scheme = (bsch["weights"], bsch["tau"] or 0)
        pos, w = place(R["sims"], R["nbr"], xyz, scheme)
        err = np.degrees(np.arccos(np.clip((pos * xyz).sum(1), -1, 1)))

        # float vs int8 index: does quantisation move the neighbours?
        Vc = variants[choose][0]
        sf, nf = topk_sims(Vc, Vc, k)
        agree_q = float(np.mean([len(set(nf[i]) & set(R["nbr"][i])) / k for i in range(N)]))
        cosfid = (R["deqn"] * Vc).sum(1)

        # baselines for the placement error
        rng = np.random.default_rng(0)
        a, b_ = rng.integers(0, N, 20000), rng.integers(0, N, 20000)
        rand_pair = np.degrees(np.arccos(np.clip((xyz[a] * xyz[b_]).sum(1), -1, 1)))
        k1pos, _ = place(R["sims"][:, :1], R["nbr"][:, :1], xyz, ("uniform", 0))
        err1 = np.degrees(np.arccos(np.clip((k1pos * xyz).sum(1), -1, 1)))
        top1 = R["sims"][:, 0]
        qs = np.quantile(top1, [1 / 3, 2 / 3])
        strata = []
        for lab_, lo_, hi_ in (("lowest third of top-1 similarity", -9, qs[0]), ("middle third", qs[0], qs[1]),
                               ("highest third", qs[1], 9)):
            m = (top1 > lo_) & (top1 <= hi_)
            strata.append({"stratum": lab_, "n": int(m.sum()),
                           "top1_sim_range": [round(float(top1[m].min()), 3), round(float(top1[m].max()), 3)],
                           "median_deg": round(pct(err[m], 50), 2), "p90_deg": round(pct(err[m], 90), 2)})
        # built-in confidence signal: mean resultant length of the weighted neighbour positions (1 = neighbours agree)
        resultant = np.linalg.norm((w[:, :, None] * xyz[R["nbr"]]).sum(1), axis=1) / w.sum(1)
        rbins = []
        for lo_, hi_, lab_ in ((0.9, 1.01, "R >= 0.9"), (0.7, 0.9, "0.7 <= R < 0.9"), (0.0, 0.7, "R < 0.7")):
            m = (resultant >= lo_) & (resultant < hi_)
            if m.sum():
                rbins.append({"bin": lab_, "n": int(m.sum()), "coverage": round(float(m.mean()), 3),
                              "median_deg": round(pct(err[m], 50), 2), "p90_deg": round(pct(err[m], 90), 2)})
        within = {f"within_{t}deg": round(float((err <= t).mean()), 3) for t in (5, 10, 20, 30)}

        # facet guessing by neighbour majority vote (k neighbours, tie -> summed weight)
        facet = {}
        agree_rate = holes_doc.get("tagging", {}).get("agreement", {})
        for ax in AXES + ["domain"]:
            labels = np.array([tags[i][ax] if ax in AXES else items[j]["domain"] for j, i in enumerate(ids)], dtype=object)
            guess, share = vote(labels, R["nbr"], w, None)
            ok = guess == labels
            maj = collections.Counter(labels).most_common(1)[0]
            cc = collections.Counter(labels)
            chance_ax = sum(c * (c - 1) for c in cc.values()) / (N * (N - 1))
            votes = np.rint(share * k).astype(int)
            bins = []
            for lo_, hi_ in ((1, k // 2), (k // 2 + 1, (3 * k) // 4), ((3 * k) // 4 + 1, k)):
                m = (votes >= lo_) & (votes <= hi_)
                if m.sum():
                    bins.append({"winning_votes": f"{lo_}-{hi_} of {k}", "n": int(m.sum()),
                                 "coverage": round(float(m.mean()), 3), "accuracy": round(float(ok[m].mean()), 3)})
            facet[ax] = {"accuracy": round(float(ok.mean()), 3), "majority_class_baseline": round(maj[1] / N, 3),
                         "majority_class": maj[0], "n_values": len(cc),
                         "random_neighbour_baseline": round(chance_ax, 3),
                         "tagger_self_agreement": agree_rate.get(ax, {}).get("rate"),
                         "by_vote_share": bins}

        # ---- write the index
        q, scale = R["q"], R["scale"]
        (out / "live_index.bin").write_bytes(q.tobytes(order="C"))
        recipe = {
            "embed": {"model_id": LIVE_BROWSER_ID, "library": "@huggingface/transformers (or @xenova/transformers v2)",
                      "task": "feature-extraction", "pooling": "cls", "normalize": True, "prefix": "",
                      "call": "extractor(text, { pooling: 'cls', normalize: true })",
                      "note": "no query/instruction prefix: gapfind compares text with text; max 512 tokens"},
            "vector": ("v = embedding (384 floats, unit length)" if choose == "raw" else
                       "v = normalize(embedding - mean)   // mean from live_index.json, then re-normalise"),
            "index": "row i of live_index.bin (int8, row-major, dims columns) = round(vec_i / scale[d]); "
                     "dequantise x_id = q_id * scale[d]; use cosine, i.e. divide each dequantised row by its L2 norm "
                     "(precompute once at load)",
            "neighbours": k, "exclude_self": "only when validating on corpus items; a new report has no self row",
            "weights": ({"scheme": "uniform"} if scheme[0] == "uniform" else
                        {"scheme": "softmax", "formula": "w_j = exp((cos_j - cos_best) / tau)", "tau": scheme[1]}
                        if scheme[0] == "softmax" else
                        {"scheme": "shifted", "formula": "w_j = max(cos_j - cos_kth + tau, 1e-9)", "tau": scheme[1]}),
            "position": "p = normalize(sum_j w_j * xyz_j), xyz_j = (cos lat cos lon, cos lat sin lon, sin lat) of neighbour j "
                        "from globe.json; lat = asin(p.z), lon = atan2(p.y, p.x)",
            "facet_guess": f"majority vote among the {k} neighbours' tags (ties: larger summed weight); "
                           "vote share is the reliability signal (see validation.facet_guess.<axis>.by_vote_share)",
        }
        validation = {
            "protocol": f"leave-one-out over all {N} corpus items: query = the item's float bge-small vector, index = the "
                        f"int8 dequantised corpus without the item itself, {k} nearest by cosine; error = great-circle "
                        "degrees between the placed position and the item's true globe position",
            "chosen_variant": choose, "chosen_weights": bsch,
            "placement_error_deg": {"median": round(pct(err, 50), 2), "p90": round(pct(err, 90), 2),
                                    "p75": round(pct(err, 75), 2), "p95": round(pct(err, 95), 2),
                                    "mean": round(float(err.mean()), 2), **within},
            "baselines_deg": {"random_pair_median": round(pct(rand_pair, 50), 1), "random_pair_p90": round(pct(rand_pair, 90), 1),
                              "nearest_neighbour_only_median": round(pct(err1, 50), 2),
                              "nearest_neighbour_only_p90": round(pct(err1, 90), 2)},
            "by_top1_similarity": strata,
            "by_neighbour_agreement": {"definition": "R = |sum_j w_j xyz_j| / sum_j w_j, computed in the browser before "
                                                     "normalising; R near 1 means the neighbours sit together on the globe, "
                                                     "low R means they are scattered and the placed point is a compromise",
                                       "bins": rbins},
            "all_variants": {name: r["rows"] for name, r in results.items()},
            "selection_note": "weights/variant picked by lowest median error on this same leave-one-out run "
                              "(2 variants x 5 schemes, 1-2 free parameters); expect the honest error to be a little above it",
            "int8_vs_float": {"neighbour_overlap_at_k": round(agree_q, 4), "dequantised_cosine_to_float_min": round(float(cosfid.min()), 5),
                              "mean": round(float(cosfid.mean()), 5)},
            "facet_guess": facet,
            "caveat": "corpus items have near-duplicates and same-source siblings among their neighbours (see by_top1_similarity); "
                      "a genuinely new report resembles the corpus less, so use the lowest-similarity stratum as the pessimistic number. "
                      "Browser embeddings come from the Xenova ONNX export, fastembed's index from Qdrant's quantised ONNX: "
                      "same weights and pooling, small numeric differences, not measured here.",
        }
        # three worked examples so the browser implementation can be unit-tested (skip the item's own row)
        selftest = []
        for t in (0, N // 3, (2 * N) // 3):
            selftest.append({"item": ids[t], "skip_row": t, "vector": [round(float(x), 6) for x in Vc[t]],
                             "neighbours": [ids[j] for j in R["nbr"][t]], "cos": [round(float(x), 5) for x in R["sims"][t]],
                             "weights": [round(float(x), 5) for x in w[t]],
                             "lat": round(float(ll_deg(pos[t])[0]), 3), "lon": round(float(ll_deg(pos[t])[1]), 3),
                             "true_lat": round(float(lat[t]), 3), "true_lon": round(float(lon[t]), 3)})
        try:
            import importlib.metadata as md
            fe_ver = md.version("fastembed")
        except Exception:
            fe_ver = None
        live = {
            "version": 1, "run": run_name, "n": N, "dims": int(q.shape[1]), "dtype": "int8", "layout": "row-major (n, dims)",
            "file": "live_index.bin", "bytes": int(q.nbytes),
            "scale": [float(f"{s:.8g}") for s in scale],
            "quantisation": "per-dimension symmetric: scale[d] = max_i |v_id| / 127; q = round(v / scale[d]), range -127..127",
            "ids": ids,
            "model": {"name": LIVE_MODEL, "fastembed_model": LIVE_MODEL, "fastembed_version": fe_ver, "fastembed_cache_dir": ".cache/models",
                      "transformers_js_model_id": LIVE_BROWSER_ID, "pooling": "cls", "normalize": True,
                      "pooling_check": pool, "embedded_field": "items.jsonl text, verbatim, no prefix"},
            "mean": None if choose == "raw" else [float(f"{s:.8g}") for s in R["mu"]],
            "recipe": recipe, "validation": validation,
            "selftest": {"note": "vector = the float query vector AFTER the recipe's centering/normalising step (i.e. "
                                 "what is dotted with the dequantised, row-normalised index); skip row skip_row; "
                                 "lat/lon = expected placement, true_lat/true_lon = where globe.json puts the item",
                         "cases": selftest},
        }
        write_json(out / "live_index.json", live)
        live_report = {"chosen": choose, "scheme": scheme, "err": validation["placement_error_deg"],
                       "baselines": validation["baselines_deg"], "facet": {a: (f["accuracy"], f["majority_class_baseline"]) for a, f in facet.items()}}
        # fold the headline numbers into globe.json stats so the UI has one file to read
        globe["stats"]["live_placement"] = {"median_deg": validation["placement_error_deg"]["median"],
                                           "p90_deg": validation["placement_error_deg"]["p90"],
                                           "facet_guess_accuracy": {a: f["accuracy"] for a, f in facet.items() if a in ("material", "for")},
                                           "details": "live_index.json validation"}
        write_json(out / "globe.json", globe)

    summary = {"stats": globe["stats"], "land": {k: land_meta[k] for k in ("threshold", "threshold_8bit", "coverage")}}
    print(json.dumps(summary, indent=1))
    for c in conts:
        print(c["id"], c["name"], "area%", c["area_pct"], "items", c["n_items_on_land"], c["lat"], c["lon"],
              [(str(d["domain"]), d["n"]) for d in c["top_domains"][:3]])
    print("islands:", len(islands))
    if live_report:
        print(json.dumps(live_report, indent=1))


if __name__ == "__main__":
    main()
