"""Geometry: centering, PCA working space, blend sampling, k-NN gap scoring,
NMS, novelty, concept checks.

Pipeline: raw embeddings -> subtract the corpus mean and re-normalize
("centered", full dimension) -> optionally project on the top principal axes
and re-normalize again (the "working space", see `Space`). Sampling, scoring,
NMS, novelty and concept checks all happen in the working space. Large
similarity products are chunked so that no temporary block exceeds roughly
_BUDGET bytes, whatever the corpus size.
"""

from __future__ import annotations

import time
from collections import Counter

import numpy as np

from .io import InputError

EPS = 1e-12
_BUDGET = 192 << 20  # bytes for the largest temporary similarity block
DEFAULT_BAND = (0.3, 0.8)  # coherence quantile band kept by `find`


# ---------------------------------------------------------------- basics

def l2_normalize(a) -> np.ndarray:
    a = np.asarray(a, dtype=np.float32)
    return a / np.maximum(np.linalg.norm(a, axis=-1, keepdims=True), EPS)


def center(raw, mean) -> np.ndarray:
    """Subtract the corpus mean vector, then L2-renormalize. Used for the
    corpus and for every concept, with the mean stored at embed time."""
    return l2_normalize(np.asarray(raw, np.float32) - np.asarray(mean, np.float32))


class Space:
    """The working space: the centered corpus projected on its top principal
    axes (PCA without a second centering: the origin stays the corpus mean)
    and re-normalized. `components=None` means the full centered dimension.

    Fit on the corpus once, saved in the run, and applied identically to gap
    candidates, concepts and the map."""

    def __init__(self, components: np.ndarray | None = None, explained: float = 1.0):
        self.components = None if components is None else np.asarray(components, np.float32)
        self.explained = float(explained)

    @property
    def dim(self) -> int:
        """Number of principal axes, 0 for the full dimension."""
        return 0 if self.components is None else int(self.components.shape[0])

    @classmethod
    def fit(cls, Xc: np.ndarray, dim: int) -> "Space":
        n, D = Xc.shape
        d = min(int(dim), D, n - 1)
        if dim <= 0 or d >= D or d < 1:
            return cls(None, 1.0)
        C = np.zeros((D, D), np.float64)  # second-moment matrix, float64 accumulation
        for s in range(0, n, 16384):
            blk = Xc[s:s + 16384].astype(np.float64)
            C += blk.T @ blk
        evals, evecs = np.linalg.eigh(C)
        top = np.argsort(evals)[::-1][:d]
        comps = evecs[:, top].T
        sign = np.sign(comps[np.arange(d), np.abs(comps).argmax(axis=1)])
        sign[sign == 0] = 1.0  # deterministic orientation of every axis
        comps = comps * sign[:, None]
        # rows of Xc are unit length, so the total second moment is n; the
        # kept share is the fraction of the centered corpus's squared length
        explained = float(evals[top].sum() / max(evals.sum(), EPS))
        return cls(comps.astype(np.float32), explained)

    def project(self, Xc) -> np.ndarray:
        Xc = np.asarray(Xc, np.float32)
        if self.components is None:
            return l2_normalize(Xc)
        return l2_normalize(Xc @ self.components.T)

    def save(self, path) -> None:
        np.savez(path, components=self.components, explained=np.float64(self.explained))

    @classmethod
    def load(cls, path) -> "Space":
        z = np.load(path)
        return cls(z["components"], float(z["explained"]))


# ---------------------------------------------------- similarity kernels

def max_cos(U: np.ndarray, X: np.ndarray) -> np.ndarray:
    """max_j cos(u_i, x_j) for each row of U, chunked over the rows of X."""
    m, n = U.shape[0], X.shape[0]
    cols = max(256, _BUDGET // (4 * max(m, 1)))
    best = np.full(m, -np.inf, np.float32)
    for s in range(0, n, cols):
        np.maximum(best, (U @ X[s:s + cols].T).max(axis=1), out=best)
    return best


def topk_sims(U: np.ndarray, X: np.ndarray, k: int, self_offset: int | None = None) -> np.ndarray:
    """The k largest cosines of each row of U against the rows of X, sorted
    descending, shape (m, k). Chunked over X, merging a running top-k.
    `self_offset=s` declares that row i of U *is* row s+i of X and excludes
    that self-match (leave-one-out)."""
    m, n = U.shape[0], X.shape[0]
    kk = max(1, min(k, n - (1 if self_offset is not None else 0)))
    cols = max(256, _BUDGET // (4 * max(m, 1)))
    best = np.full((m, kk), -np.inf, np.float32)
    rows = np.arange(m)
    for s in range(0, n, cols):
        sims = U @ X[s:s + cols].T
        C = sims.shape[1]
        if self_offset is not None:
            gi = rows + self_offset
            hit = (gi >= s) & (gi < s + C)
            sims[rows[hit], gi[hit] - s] = -np.inf
        part = np.partition(sims, C - kk, axis=1)[:, C - kk:] if C > kk else sims
        merged = np.concatenate([best, part], axis=1)
        best = np.partition(merged, merged.shape[1] - kk, axis=1)[:, merged.shape[1] - kk:]
    return -np.sort(-best, axis=1)


def knn_score(U: np.ndarray, X: np.ndarray, k: int,
              self_offset: int | None = None) -> tuple[np.ndarray, np.ndarray]:
    """(g_k, g1): mean cosine distance to the k nearest items, and the
    1-nearest-neighbor distance, for each row of U."""
    top = topk_sims(U, X, k, self_offset)
    return np.maximum(1.0 - top.mean(axis=1), 0.0), np.maximum(1.0 - top[:, 0], 0.0)


def top_k_cos(U: np.ndarray, X: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    """Indices and cosines of the k nearest rows of X for each row of U,
    sorted by descending cosine."""
    k = max(1, min(k, X.shape[0]))
    m, n = U.shape[0], X.shape[0]
    idx = np.empty((m, k), np.int64)
    cs = np.empty((m, k), np.float32)
    rows = max(1, _BUDGET // (4 * max(n, 1)))
    for s in range(0, m, rows):
        sims = U[s:s + rows] @ X.T
        part = np.argpartition(-sims, k - 1, axis=1)[:, :k]
        ps = np.take_along_axis(sims, part, 1)
        order = np.argsort(-ps, axis=1, kind="stable")
        idx[s:s + rows] = np.take_along_axis(part, order, 1)
        cs[s:s + rows] = np.take_along_axis(ps, order, 1)
    return idx, cs


# --------------------------------------------------------------- novelty

def loo_knn_distance(X: np.ndarray, k: int = 5) -> np.ndarray:
    """d_i = mean cosine distance from item i to its k nearest *other* items:
    the corpus's own novelty scale, the same quantity a gap is scored with."""
    n = X.shape[0]
    out = np.empty(n, np.float32)
    rows = max(16, _BUDGET // (4 * max(n, 1)))
    for s in range(0, n, rows):
        e = min(n, s + rows)
        top = topk_sims(X[s:e], X, k, self_offset=s)
        out[s:e] = np.maximum(1.0 - top.mean(axis=1), 0.0)
    return out


def loo_nn_distance(X: np.ndarray) -> np.ndarray:
    """k=1 case: 1 - max_{j != i} cos(x_i, x_j)."""
    return loo_knn_distance(X, 1)


def percentile_of(d_sorted: np.ndarray, values):
    """Percent (0-100) of corpus items whose leave-one-out distance is smaller
    than `values`, i.e. 'emptier than the space around X% of items'."""
    d_sorted = np.asarray(d_sorted)
    return 100.0 * np.searchsorted(d_sorted, values, side="left") / len(d_sorted)


def novelty_summary(d: np.ndarray, k: int) -> dict:
    q = np.quantile(d, [0.5, 0.9, 0.95, 0.99])
    return {"k": int(k), "n": int(len(d)), "mean": round(float(d.mean()), 6),
            "p50": round(float(q[0]), 6), "p90": round(float(q[1]), 6),
            "p95": round(float(q[2]), 6), "p99": round(float(q[3]), 6),
            "max": round(float(d.max()), 6)}


# -------------------------------------------------------------- sampling

def blend(X: np.ndarray, idx: np.ndarray, w: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """v = sum_i w_i x_i over the parents; returns (u = v/|v|, coherence = |v|)."""
    v = (w[:, 0:1] * X[idx[:, 0]] + w[:, 1:2] * X[idx[:, 1]] + w[:, 2:3] * X[idx[:, 2]])
    c = np.linalg.norm(v, axis=1)
    return (v / np.maximum(c, EPS)[:, None]).astype(np.float32), c.astype(np.float32)


def sample_blends(X: np.ndarray, n_samples: int, *, seed: int = 42, p_k2: float = 0.6,
                  batch: int = 8192, k: int = 1, progress=None) -> dict:
    """Draw `n_samples` blends. Parents: k=2 with prob p_k2 else k=3, chosen
    uniformly (distinct) from the corpus; weights ~ Dirichlet(1). Stores only
    parent indices, weights, coherence c, the k-NN gap score g and the 1-NN
    score g1 per sample (~32 bytes per sample whatever the dimension)."""
    n = X.shape[0]
    if n < 3:
        raise InputError("need at least 3 items to sample blends")
    rng = np.random.default_rng(seed)
    idx = np.empty((n_samples, 3), np.int32)
    w = np.empty((n_samples, 3), np.float32)
    c = np.empty(n_samples, np.float32)
    g = np.empty(n_samples, np.float32)
    g1 = np.empty(n_samples, np.float32)
    done_marks = 0
    for s in range(0, n_samples, batch):
        B = min(batch, n_samples - s)
        three = rng.random(B) >= p_k2
        a = rng.integers(0, n, B)
        b = rng.integers(0, n - 1, B)
        b += (b >= a)
        r = rng.integers(0, n - 2, B)
        lo, hi = np.minimum(a, b), np.maximum(a, b)
        r += (r >= lo)
        r += (r >= hi)
        p = np.stack([a, b, r], axis=1)
        e = rng.exponential(size=(B, 3))  # Dirichlet(1) = normalized Exp(1)
        e[~three, 2] = 0.0
        wt = (e / e.sum(axis=1, keepdims=True)).astype(np.float32)
        u, cb = blend(X, p, wt)
        idx[s:s + B], w[s:s + B], c[s:s + B] = p, wt, cb
        g[s:s + B], g1[s:s + B] = knn_score(u, X, k)
        if progress and (s + B) * 10 // n_samples > done_marks:
            done_marks = (s + B) * 10 // n_samples
            progress(f"sampled {s + B:,}/{n_samples:,}")
    return {"idx": idx, "w": w, "c": c, "g": g, "g1": g1}


def resolve_band(band=None, coh_q: float | None = None) -> tuple[float, float]:
    """Coherence quantile band (lo, hi). `coh_q` is the old single-floor flag:
    it overrides only the lower edge."""
    lo, hi = (float(band[0]), float(band[1])) if band is not None else DEFAULT_BAND
    if coh_q is not None:
        lo = float(coh_q)
    if not 0.0 <= lo < hi <= 1.0:
        raise InputError(f"coherence band must satisfy 0 <= lo < hi <= 1, got ({lo}, {hi})")
    return lo, hi


def candidate_mask(S: dict, band=DEFAULT_BAND, min_weight: float = 0.0):
    """Boolean mask of the samples allowed to become gaps: coherence inside the
    band's quantile range and, if `min_weight` > 0, every parent's weight at
    least that (drops lopsided blends that are really one item plus a whisper
    of the others). Returns (mask, c_lo, c_hi)."""
    c = S["c"]
    c_lo, c_hi = (float(v) for v in np.quantile(c, band))
    mask = (c >= c_lo) & (c <= c_hi)
    if min_weight > 0:
        w_min = np.where(S["w"] > 0, S["w"], np.inf).min(axis=1)
        mask &= w_min >= min_weight
    return mask, c_lo, c_hi


def select_gaps(X: np.ndarray, S: dict, *, band=DEFAULT_BAND, top: int = 30,
                nms: float = 0.25, min_weight: float = 0.0, block: int = 2048):
    """Candidate filter, then greedy non-max suppression, streamed.

    Candidates (see `candidate_mask`) are visited in descending g. A candidate
    is taken iff no already-taken gap is within cosine distance `nms` of it,
    which is exactly 'take the best, suppress its neighbors, repeat'. Visiting
    in blocks means we stop as soon as `top` gaps exist and never hold more
    than one block of blended vectors.
    Returns (c_lo, c_hi, candidate count, selected sample indices, U)."""
    g = S["g"]
    mask, c_lo, c_hi = candidate_mask(S, band, min_weight)
    kept = np.flatnonzero(mask)
    order = kept[np.argsort(-g[kept], kind="stable")]
    cos_limit = 1.0 - nms
    sel: list[int] = []
    sel_u: list[np.ndarray] = []
    pos = 0
    while pos < len(order) and len(sel) < top:
        blk = order[pos:pos + block]
        pos += block
        U, _ = blend(X, S["idx"][blk], S["w"][blk])
        alive = np.ones(len(blk), bool)
        if sel_u:
            alive &= (U @ np.stack(sel_u).T).max(axis=1) < cos_limit
        while len(sel) < top:
            nz = np.flatnonzero(alive)
            if nz.size == 0:
                break
            j = int(nz[0])
            sel.append(int(blk[j]))
            sel_u.append(U[j])
            alive &= (U @ U[j]) < cos_limit
            alive[j] = False
    U_sel = np.stack(sel_u) if sel_u else np.zeros((0, X.shape[1]), np.float32)
    return c_lo, c_hi, int(len(kept)), sel, U_sel


def _title(it: dict):
    return it.get("title")


def find_gaps(X: np.ndarray, items: list[dict], *, samples: int = 320000, top: int = 30,
              seed: int = 42, coh_band=None, coh_q: float | None = None, nms: float = 0.25,
              min_weight: float = 0.0, p_k2: float = 0.6, n_neighbors: int = 8, batch: int = 8192,
              group_field: str = "domain", k: int = 5, pca: int = 32,
              space: Space | None = None, d_nn: np.ndarray | None = None,
              progress=None) -> tuple[dict, np.ndarray]:
    """Full gap search on the centered corpus X (full dimension).

    Everything is done in the working space (`space`, or a PCA fit with
    `pca` axes; 0 = full dimension). Returns (gaps.json dict, d_knn) where
    d_knn is the leave-one-out k-NN distance of every corpus item."""
    t0 = time.time()
    band = resolve_band(coh_band, coh_q)
    if space is None:
        space = Space.fit(X, pca)
    Y = space.project(X)
    k = max(1, min(int(k), len(Y) - 1))
    if d_nn is None:
        d_nn = loo_knn_distance(Y, k)
    d_sorted = np.sort(d_nn)
    S = sample_blends(Y, samples, seed=seed, p_k2=p_k2, batch=batch, k=k, progress=progress)
    c_lo, c_hi, n_kept, sel, U = select_gaps(Y, S, band=band, top=top, nms=nms,
                                             min_weight=min_weight)
    kept_g = np.sort(S["g"][candidate_mask(S, band, min_weight)[0]])  # all candidate blends
    n_nn = max(n_neighbors, k)
    nn_idx, nn_cos = top_k_cos(U, Y, n_nn) if len(sel) else (
        np.zeros((0, 0), np.int64), np.zeros((0, 0), np.float32))
    Uf = blend(X, S["idx"][sel], S["w"][sel])[0] if len(sel) else np.zeros((0, X.shape[1]), np.float32)

    width = max(2, len(str(top)))
    gaps = []
    for r, s in enumerate(sel):
        score = float(1.0 - nn_cos[r, :k].mean())
        parents = [{"id": items[int(S["idx"][s, j])]["id"],
                    "title": _title(items[int(S["idx"][s, j])]),
                    "text": items[int(S["idx"][s, j])]["text"],
                    "weight": round(float(S["w"][s, j]), 4)}
                   for j in range(3) if S["w"][s, j] > 0]
        nbrs = [{"id": items[int(j)]["id"], "title": _title(items[int(j)]),
                 "domain": items[int(j)].get(group_field), "cos": round(float(cs), 4),
                 "text": items[int(j)]["text"]}
                for j, cs in zip(nn_idx[r][:n_neighbors], nn_cos[r][:n_neighbors])]
        mix = Counter(str(n["domain"]) if n["domain"] is not None else "unknown" for n in nbrs)
        gaps.append({
            "id": f"gap-{r + 1:0{width}d}",
            "score": round(score, 6),
            "g1": round(float(1.0 - nn_cos[r, 0]), 6),
            "percentile": round(float(percentile_of(d_sorted, score)), 2),
            "blend_percentile": round(float(percentile_of(kept_g, score)), 2),
            "coherence": round(float(S["c"][s]), 4),
            "stability": None,
            "parents": parents,
            "neighbors": nbrs,
            "domain_mix": dict(sorted(mix.items(), key=lambda kv: (-kv[1], kv[0]))),
            "vector": np.round(U[r], 6).tolist(),
            "vector_full": np.round(Uf[r], 5).tolist(),
        })

    sep = None
    if len(sel) > 1:
        sims = U @ U.T
        np.fill_diagonal(sims, -np.inf)
        sep = round(float(1.0 - sims.max()), 4)
    result = {
        "params": {"samples": samples, "top": top, "seed": seed, "k": k,
                   "pca": space.dim, "coh_band": list(band), "min_weight": min_weight,
                   "nms": nms, "p_k2": p_k2,
                   "neighbors": n_neighbors, "group_field": group_field},
        "pca": {"dim": space.dim, "full_dim": int(X.shape[1]),
                "explained_variance": round(space.explained, 4),
                "path": "pca.npz" if space.dim else None},
        "novelty": novelty_summary(d_nn, k),
        "sampling": {"coherence_range": [round(c_lo, 6), round(c_hi, 6)], "kept": n_kept,
                     "max_score_all_samples": round(float(S["g"].max()), 6),
                     "min_gap_separation": sep, "found": len(sel),
                     "seconds": round(time.time() - t0, 2)},
        "gaps": gaps,
    }
    return result, d_nn


def neighbor_records(U: np.ndarray, Y: np.ndarray, items: list[dict], d_sorted: np.ndarray, *,
                     k: int = 5, n_neighbors: int = 8, group_field: str = "domain") -> list[dict]:
    """For unit working-space vectors U (candidate gap points that did not come
    from blending): k-NN score, 1-NN score g1, percentile against the corpus's
    leave-one-out k-NN distances, the nearest items and their domain mix."""
    kk = max(1, min(int(k), len(Y)))
    nn_idx, nn_cos = top_k_cos(U, Y, max(n_neighbors, kk))
    out = []
    for r in range(len(U)):
        score = float(max(1.0 - nn_cos[r, :kk].mean(), 0.0))
        nbrs = [{"id": items[int(j)]["id"], "title": _title(items[int(j)]),
                 "domain": items[int(j)].get(group_field), "cos": round(float(cs), 4),
                 "text": items[int(j)]["text"]}
                for j, cs in zip(nn_idx[r][:n_neighbors], nn_cos[r][:n_neighbors])]
        mix = Counter(str(n["domain"]) if n["domain"] is not None else "unknown" for n in nbrs)
        out.append({"score": round(score, 6), "g1": round(float(1.0 - nn_cos[r, 0]), 6),
                    "percentile": round(float(percentile_of(d_sorted, score)), 2),
                    "neighbors": nbrs,
                    "domain_mix": dict(sorted(mix.items(), key=lambda kv: (-kv[1], kv[0])))})
    return out


# ----------------------------------------------------------------- check

def resolve_gap(ref, gap_ids: list[str]) -> int:
    """Map 'gap-03' / 'gap-3' / '3' / 3 to an index into gap_ids."""
    s = str(ref).strip()
    if s in gap_ids:
        return gap_ids.index(s)
    digits = s.lower().removeprefix("gap-").removeprefix("gap")
    if digits.isdigit():
        for i, gid in enumerate(gap_ids):
            if gid.lower().removeprefix("gap-").lstrip("0") == digits.lstrip("0"):
                return i
    raise InputError(f"unknown target_gap {ref!r}; gaps.json has {gap_ids[0]}..{gap_ids[-1]}"
                     if gap_ids else f"unknown target_gap {ref!r}; gaps.json has no gaps")


def concept_novelty(Zs: np.ndarray, Y: np.ndarray, d_sorted: np.ndarray, k: int):
    """(k-NN score, percentile vs the corpus's leave-one-out k-NN distances)
    of working-space concept vectors Zs against the working-space corpus Y."""
    g, _ = knn_score(Zs, Y, k)
    return g, percentile_of(d_sorted, g)


def check_concepts(Zs: np.ndarray, concepts: list[dict], Y: np.ndarray, items: list[dict],
                   gaps: list[dict], d_sorted: np.ndarray, *, k: int = 5, n_neighbors: int = 5,
                   min_percentile: float = 90.0, group_field: str = "domain") -> list[dict]:
    """Score working-space concept vectors Zs against the working-space
    corpus Y and the gaps (whose `vector` lives in the same space).

    score: mean cosine distance to the concept's k nearest items, compared
    with the corpus items' own leave-one-out k-NN distances (`d_sorted`,
    same k) to give `percentile`. `g1` is the 1-NN distance for reference.

    lands_in_gap: the concept is closer (higher cosine) to its reference gap
    vector than to ANY corpus item, and its percentile is at least
    `min_percentile`. The reference gap is `target_gap` when set, else the
    concept's nearest gap (lands_basis says which)."""
    gap_ids = [g["id"] for g in gaps]
    G = l2_normalize(np.asarray([g["vector"] for g in gaps], np.float32)) if gaps else \
        np.zeros((0, Y.shape[1]), np.float32)
    kk = max(1, min(int(k), len(Y)))
    nn_idx, nn_cos = top_k_cos(Zs, Y, max(n_neighbors, kk))
    best = nn_cos[:, 0]
    score = np.maximum(1.0 - nn_cos[:, :kk].mean(axis=1), 0.0)
    pct = percentile_of(d_sorted, score)
    gsim = Zs @ G.T if len(gaps) else np.zeros((len(Zs), 0), np.float32)

    out = []
    for i, concept in enumerate(concepts):
        tgt = concept.get("target_gap")
        t_idx = resolve_gap(tgt, gap_ids) if tgt not in (None, "") else None
        near = int(np.argmax(gsim[i])) if len(gaps) else None
        ref = t_idx if t_idx is not None else near
        lands = bool(ref is not None and gsim[i, ref] > best[i] and pct[i] >= min_percentile)
        rec = dict(concept)
        rec.update({
            "score": round(float(score[i]), 6),
            "g1": round(float(1.0 - best[i]), 6),
            "percentile": round(float(pct[i]), 2),
            "nearest_items": [{"id": items[int(j)]["id"], "title": _title(items[int(j)]),
                               "domain": items[int(j)].get(group_field),
                               "cos": round(float(cs), 4), "text": items[int(j)]["text"]}
                              for j, cs in zip(nn_idx[i][:n_neighbors], nn_cos[i][:n_neighbors])],
            "nearest_gap": gap_ids[near] if near is not None else None,
            "nearest_gap_cos": round(float(gsim[i, near]), 4) if near is not None else None,
            "target_gap_cos": round(float(gsim[i, t_idx]), 4) if t_idx is not None else None,
            "lands_in_gap": lands,
            "lands_basis": "target" if t_idx is not None else "nearest",
        })
        out.append(rec)
    return out
