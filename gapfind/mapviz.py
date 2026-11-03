"""2D picture of the corpus, gaps and concepts. The map is only a picture:
all scoring happens in the full-dimensional centered space (see core.py)."""

from __future__ import annotations

import warnings
from collections import Counter

import numpy as np


def umap_project(X: np.ndarray, extra: list[np.ndarray], *, n_neighbors: int = 15,
                 min_dist: float = 0.1, seed: int = 42):
    """Fit UMAP (cosine) on the centered corpus; transform each array in `extra`
    with the fitted model. Returns (corpus_xy, [extra_xy, ...])."""
    import umap  # imported lazily: numba start-up is slow

    n = X.shape[0]
    reducer = umap.UMAP(n_components=2, n_neighbors=max(2, min(n_neighbors, n - 1)),
                        min_dist=min_dist, metric="cosine", random_state=seed)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        xy = reducer.fit_transform(X)
        outs = [reducer.transform(e) if len(e) else np.zeros((0, 2), np.float32) for e in extra]
    return np.asarray(xy, np.float32), [np.asarray(o, np.float32) for o in outs]


def draw_png(path, points_xy, groups: list[str], gaps: list[dict], gaps_xy, concepts: list[dict],
             concepts_xy, *, group_field: str = "domain", max_groups: int = 20) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D
    from matplotlib.patheffects import withStroke

    counts = Counter(groups)
    keep = [g for g, _ in counts.most_common(max_groups - 1 if len(counts) > max_groups else max_groups)]
    cmap = plt.get_cmap("tab20")
    palette = [cmap(i) for i in range(0, 20, 2)] + [cmap(i) for i in range(1, 20, 2)]  # dark first
    color_of = {g: palette[i % 20] for i, g in enumerate(keep)}
    labels = np.array([g if g in color_of else "other (rest)" for g in groups])
    if "other (rest)" in set(labels):
        color_of["other (rest)"] = (0.6, 0.6, 0.6, 1.0)

    fig, ax = plt.subplots(figsize=(13, 9), dpi=150)
    for g in color_of:
        m = labels == g
        ax.scatter(points_xy[m, 0], points_xy[m, 1], s=14, color=color_of[g], alpha=0.8,
                   linewidths=0, label=f"{g} ({int(m.sum())})")
    handles, names = ax.get_legend_handles_labels()
    halo = [withStroke(linewidth=2.5, foreground="white")]
    if len(gaps):
        # blend gaps: hollow black circles; facet holes: hollow teal diamonds (their own marker)
        is_hole = np.array([g.get("source") == "facet" for g in gaps])
        for mask, marker, color, name, size in (
                (~is_hole, "o", "black", "gap (blend)", 190),
                (is_hole, "D", "#00838f", "hole (facet co-occurrence)", 120)):
            if not mask.any():
                continue
            ax.scatter(gaps_xy[mask, 0], gaps_xy[mask, 1], s=size, marker=marker,
                       facecolors="none", edgecolors=color, linewidths=1.6, zorder=5)
            handles.append(Line2D([], [], marker=marker, ls="", mfc="none", mec=color, mew=1.4,
                                  ms=9 if marker == "o" else 8))
            names.append(name)
        for g, (x, y), h in zip(gaps, gaps_xy, is_hole):
            ax.annotate(g["id"].removeprefix("hole-") if h else g["id"], (x, y), xytext=(6, 6),
                        textcoords="offset points", fontsize=7 if h else 8, fontweight="bold",
                        color="#00838f" if h else "black", path_effects=halo, zorder=6)
    if len(concepts):
        ok = np.array([bool(c.get("lands_in_gap")) for c in concepts])
        ax.scatter(concepts_xy[:, 0], concepts_xy[:, 1], s=260, marker="*",
                   c=np.where(ok, "#d62728", "#ffffff"), edgecolors="#d62728", linewidths=1.4,
                   zorder=7)
        handles.append(Line2D([], [], marker="*", ls="", mfc="#d62728", mec="#d62728", ms=13))
        names.append("concept (filled = lands in gap)")
        for c, (x, y) in zip(concepts, concepts_xy):
            ax.annotate(str(c["id"]), (x, y), xytext=(8, -10), textcoords="offset points",
                        fontsize=8, color="#d62728", path_effects=halo, zorder=8)
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    ax.set_title(f"UMAP of the centered corpus, colored by {group_field}. "
                 "A picture only: gaps and concepts are scored in full dimension.", fontsize=10)
    ax.legend(handles, names, loc="center left", bbox_to_anchor=(1.01, 0.5), fontsize=8,
              frameon=False, markerscale=1.6)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
