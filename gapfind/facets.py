"""Facet co-occurrence holes: morphological analysis (a Zwicky box) with an
independence model and a bootstrap, validated in embedding space.

Every item is tagged on a few categorical axes (for example move, material,
for). For each pair of axes the items form a contingency table. Under
independence a cell is expected to hold E = n_row * n_col / N items. A cell
that holds none although E is large is a *hole*: a combination of two things
that are each common but never appear together. Embeddings are then only the
validation layer: the hole's vector (the normalized sum of the two value
centroids) is scored with the same k-NN novelty as a blend gap, so we can see
whether the embedding space also finds that spot empty.
"""

from __future__ import annotations

import itertools
import math
from collections import Counter

import numpy as np

from .core import l2_normalize, neighbor_records
from .io import InputError, read_json, read_jsonl


# ---------------------------------------------------------------- inputs

def load_vocab(path) -> tuple[dict[str, list[str]], dict[tuple[str, str], str | None]]:
    """vocab.json -> ({axis: [values in file order]}, {(axis, value): definition})."""
    doc = read_json(path)
    axes = doc.get("axes") if isinstance(doc, dict) else None
    if not isinstance(axes, dict) or not axes:
        raise InputError(f'{path}: expected {{"axes": {{"move": [{{"value": ..., "definition": ...}}], ...}}}}')
    vocab: dict[str, list[str]] = {}
    defs: dict[tuple[str, str], str | None] = {}
    for ax, vals in axes.items():
        names: list[str] = []
        for v in vals:
            name, d = (v, None) if isinstance(v, str) else (v.get("value"), v.get("definition"))
            if name is None or not str(name).strip():
                raise InputError(f"{path}: axis {ax!r} has a value without a name")
            name = str(name).strip()
            if name in names:
                raise InputError(f"{path}: axis {ax!r} lists {name!r} twice")
            names.append(name)
            defs[(ax, name)] = d
        vocab[ax] = names
    return vocab, defs


class Tags:
    """Tags aligned with the run's items. `primary[axis][i]` and `alt[axis][i]`
    are a vocabulary value or None (missing / not in the vocabulary)."""

    def __init__(self, items: list[dict], axes: list[str], vocab: dict[str, list[str]], path):
        rows: dict[str, dict] = {}
        for r in read_jsonl(path):
            r.pop("__src__", None)
            rid = str(r.get("id"))
            if rid in rows:
                raise InputError(f"{path}: duplicate id {rid!r}")
            rows[rid] = r
        n = len(items)
        ids = {it["id"] for it in items}
        self.axes = axes
        self.primary = {ax: [None] * n for ax in axes}
        self.alt = {ax: [None] * n for ax in axes}
        self.unknown: dict[str, Counter] = {ax: Counter() for ax in axes}
        self.unknown_alt: dict[str, Counter] = {ax: Counter() for ax in axes}
        self.agree: dict[str, list[bool]] = {ax: [] for ax in axes}
        self.not_in_run = sum(1 for rid in rows if rid not in ids)
        self.untagged = 0
        for i, it in enumerate(items):
            r = rows.get(it["id"])
            if r is None:
                self.untagged += 1
                continue
            ag = r.get("agree") if isinstance(r.get("agree"), dict) else {}
            for ax in axes:
                v = self._clean(r.get(ax), vocab[ax], self.unknown[ax])
                a = self._clean(r.get(f"{ax}_alt"), vocab[ax], self.unknown_alt[ax])
                self.primary[ax][i], self.alt[ax][i] = v, a
                if ax in ag:
                    self.agree[ax].append(bool(ag[ax]))
                elif a is not None and v is not None:
                    self.agree[ax].append(a == v)

    @staticmethod
    def _clean(v, values, unknown: Counter):
        if v is None or str(v).strip() == "":
            return None
        v = str(v).strip()
        if v in values:
            return v
        unknown[v] += 1
        return None

    def effective_alt(self, ax: str) -> list:
        """The second tagger's label wherever present, the primary label elsewhere."""
        return [a if a is not None else p for a, p in zip(self.alt[ax], self.primary[ax])]

    def has_alt(self, ax: str) -> bool:
        return any(a is not None for a in self.alt[ax])

    def summary(self, n_items: int) -> dict:
        return {
            "n_items": n_items,
            "untagged_items": self.untagged,
            "tag_rows_not_in_run": self.not_in_run,
            "tagged": {ax: sum(v is not None for v in self.primary[ax]) for ax in self.axes},
            "unknown_values": {ax: dict(c) for ax, c in self.unknown.items() if c},
            "alt_labels": {ax: sum(a is not None for a in self.alt[ax]) for ax in self.axes},
            "agreement": {ax: {"n": len(v), "rate": round(sum(v) / len(v), 4)}
                          for ax, v in self.agree.items() if v},
        }


# ------------------------------------------------------------ statistics

def poisson_cdf(k: int, mu: float) -> float:
    """P(X <= k) for X ~ Poisson(mu)."""
    if mu <= 0:
        return 1.0
    term = math.exp(-mu)
    total = term
    for i in range(1, int(k) + 1):
        term *= mu / i
        total += term
    return min(total, 1.0)


def codes(labels: list, values: list[str]) -> np.ndarray:
    index = {v: i for i, v in enumerate(values)}
    return np.array([index.get(v, -1) if v is not None else -1 for v in labels], np.int64)


def contingency(ca: np.ndarray, cb: np.ndarray, na: int, nb: int) -> np.ndarray:
    """Counts of items per (row value, column value); items missing either tag are skipped."""
    ok = (ca >= 0) & (cb >= 0)
    O = np.zeros((na, nb), np.int64)
    np.add.at(O, (ca[ok], cb[ok]), 1)
    return O


def expected(O: np.ndarray) -> np.ndarray:
    N = O.sum()
    if N == 0:
        return np.zeros(O.shape)
    return np.outer(O.sum(axis=1), O.sum(axis=0)) / N


def bootstrap_stability(O: np.ndarray, boot: int, rng: np.random.Generator,
                        min_expected: float = 2.0) -> np.ndarray:
    """Per cell: the fraction of bootstrap resamples in which the cell is still
    empty AND its expected count is at least `min_expected`.

    Resampling the N items with replacement gives cell counts that are
    Multinomial(N, O/N), so the resamples are drawn directly from that
    distribution (identical in law to resampling items one by one, and fast)."""
    N = int(O.sum())
    if N == 0 or boot <= 0:
        return np.zeros(O.shape)
    na, nb = O.shape
    Ob = rng.multinomial(N, (O / N).ravel(), size=boot).reshape(boot, na, nb)
    Eb = Ob.sum(axis=2)[:, :, None] * Ob.sum(axis=1)[:, None, :] / N
    return ((Ob == 0) & (Eb >= min_expected)).mean(axis=0)


# ------------------------------------------------------------ the finder

def _item_ref(it: dict) -> dict:
    return {"id": it["id"], "title": it.get("title"), "text": it["text"]}


def facet_holes(items: list[dict], Y: np.ndarray, d_nn: np.ndarray, tags: Tags,
                vocab: dict[str, list[str]], defs: dict, *, pairs: list[tuple[str, str]],
                top: int = 30, boot: int = 1000, seed: int = 42, min_expected: float = 1.0,
                thin_frac: float = 0.25, k: int = 5, n_neighbors: int = 8,
                group_field: str = "domain", n_examples: int = 3) -> dict:
    """Holes for every axis pair. `Y` is the run's working-space corpus (the same
    centering and PCA projection `find` uses) and `d_nn` its leave-one-out k-NN
    distances. Returns {"pairs": [...], "gaps": [hole entries]}."""
    d_sorted = np.sort(d_nn)
    k = max(1, min(int(k), len(Y) - 1))
    prim = {ax: codes(tags.primary[ax], vocab[ax]) for ax in tags.axes}
    alt = {ax: codes(tags.effective_alt(ax), vocab[ax]) for ax in tags.axes}
    use_alt = {ax: tags.has_alt(ax) for ax in tags.axes}
    centroids: dict[tuple[str, int], tuple] = {}

    def value_info(ax: str, vi: int):
        """(centroid, member indices, example indices) of items tagged (ax, value)."""
        key = (ax, vi)
        if key not in centroids:
            members = np.flatnonzero(prim[ax] == vi)
            if len(members) == 0:
                centroids[key] = (np.zeros(Y.shape[1], np.float32), members, members)
                return centroids[key]
            c = Y[members].mean(axis=0)
            order = np.argsort(-(Y[members] @ l2_normalize(c)), kind="stable")
            centroids[key] = (c, members, members[order[:n_examples]])
        return centroids[key]

    pair_docs: list[dict] = []
    entries: list[dict] = []
    vectors: list[np.ndarray] = []
    width = max(2, len(str(top)))
    for pi, (a, b) in enumerate(pairs):
        va, vb = vocab[a], vocab[b]
        O = contingency(prim[a], prim[b], len(va), len(vb))
        E = expected(O)
        N = int(O.sum())
        stab = bootstrap_stability(O, boot, np.random.default_rng([seed, pi]))
        alt_on = use_alt[a] or use_alt[b]
        if alt_on:
            O2 = contingency(alt[a], alt[b], len(va), len(vb))
            E2 = expected(O2)
        empty = [(i, j) for i in range(len(va)) for j in range(len(vb)) if O[i, j] == 0]
        listed = [(i, j) for (i, j) in empty if E[i, j] >= min_expected]
        # most-expected-but-absent first; the Poisson p (= exp(-E) for an empty cell) breaks ties
        listed.sort(key=lambda c: (-E[c], poisson_cdf(0, E[c])))
        thin = [(i, j) for i in range(len(va)) for j in range(len(vb))
                if 1 <= O[i, j] <= E[i, j] * thin_frac]
        thin.sort(key=lambda c: (poisson_cdf(int(O[c]), E[c]), -E[c]))

        ids = []
        for rank, (i, j) in enumerate(listed[:top], 1):
            ci, mi, ei = value_info(a, i)
            cj, mj, ej = value_info(b, j)
            if len(mi) == 0 or len(mj) == 0:
                continue
            v = ci + cj
            norm = float(np.linalg.norm(v))
            if norm < 1e-6:
                continue  # the two centroids cancel: no direction to report
            hid = f"hole-{a}-{b}-{rank:0{width}d}"
            ids.append(hid)
            entry = {
                "id": hid, "source": "facet", "axes": [a, b], "rank": rank,
                "cell": {a: va[i], b: vb[j]},
                "observed": 0, "expected": round(float(E[i, j]), 4),
                "p": float(poisson_cdf(0, E[i, j])),
                "n_row": int(O[i].sum()), "n_col": int(O[:, j].sum()), "N": N,
                "stability": round(float(stab[i, j]), 4),
                "alt": None, "tag_robust": None,
                "coherence": round(norm / 2, 4),
                "examples": {
                    a: {"value": va[i], "definition": defs.get((a, va[i])), "n": int(len(mi)),
                        "items": [_item_ref(items[int(t)]) for t in ei]},
                    b: {"value": vb[j], "definition": defs.get((b, vb[j])), "n": int(len(mj)),
                        "items": [_item_ref(items[int(t)]) for t in ej]},
                },
            }
            if alt_on:
                o2, e2 = int(O2[i, j]), float(E2[i, j])
                survives = bool(o2 == 0 and e2 >= min_expected)
                entry["alt"] = {"observed": o2, "expected": round(e2, 4), "survives": survives}
                entry["tag_robust"] = survives
            parents = [(role, int(t)) for role, ex in ((f"{a}={va[i]}", ei), (f"{b}={vb[j]}", ej))
                       for t in ex]
            entry["parents"] = [dict(_item_ref(items[t]), weight=round(1 / len(parents), 4),
                                     role=role) for role, t in parents]
            entries.append(entry)
            vectors.append(v / norm)

        pair_docs.append({
            "axes": [a, b], "N": N, "rows": va, "cols": vb,
            "observed": O.tolist(), "expected": np.round(E, 3).tolist(),
            "n_cells": int(O.size), "n_empty": len(empty),
            "n_empty_below_min_expected": len(empty) - len(listed),
            "holes": ids,
            "thin": [{"cell": {a: va[i], b: vb[j]}, "observed": int(O[i, j]),
                      "expected": round(float(E[i, j]), 3),
                      "p": float(poisson_cdf(int(O[i, j]), E[i, j])),
                      "stability_empty": round(float(stab[i, j]), 4)}
                     for (i, j) in thin[:top]],
            "n_thin": len(thin),
        })

    # embedding validation: same k-NN novelty and leave-one-out scale as `find`
    if vectors:
        U = np.stack(vectors).astype(np.float32)
        recs = neighbor_records(U, Y, items, d_sorted, k=k, n_neighbors=n_neighbors,
                                group_field=group_field)
        for e, u, r in zip(entries, U, recs):
            e.update(r)
            e["vector"] = np.round(u, 6).tolist()
    return {"pairs": pair_docs, "gaps": entries}


def resolve_axes(vocab: dict[str, list[str]], axes: list[str] | None) -> list[tuple[str, str]]:
    """Axis pairs to analyze: every pair among `axes` (default: all vocabulary axes)."""
    axes = list(axes) if axes else list(vocab)
    unknown = [a for a in axes if a not in vocab]
    if unknown:
        raise InputError(f"axes {unknown} are not in the vocabulary (has {list(vocab)})")
    if len(axes) < 2:
        raise InputError("need at least two axes")
    return list(itertools.combinations(axes, 2))
