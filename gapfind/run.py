"""A run directory: items.jsonl, emb.npy, mean.npy, meta.json (+ derived files)."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .core import Space, center, loo_knn_distance
from .io import InputError, read_json, read_jsonl

# files computed from the corpus; `embed` deletes them because they go stale
DERIVED = ("gaps.json", "novelty.npy", "pca.npz", "checks.json", "stability.json",
           "map.json", "map.png", "holes.json", "holes_pca.npz", "holes_novelty.npy",
           "checks_holes.json", "map_holes.json", "map_holes.png")


class Run:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        mp = self.path / "meta.json"
        if not mp.is_file():
            raise InputError(f"{self.path} is not a run directory (no meta.json); run `embed` first")
        self.meta = read_json(mp)
        self.items = read_jsonl(self.path / self.meta.get("items_path", "items.jsonl"))
        for it in self.items:
            it.pop("__src__", None)
        self.raw = np.load(self.path / self.meta["emb_path"])
        self.mean = np.load(self.path / self.meta["mean_path"])
        if len(self.items) != self.raw.shape[0]:
            raise InputError("items.jsonl and emb.npy disagree on the number of rows")
        self._X = None

    @property
    def X(self) -> np.ndarray:
        """The centered, re-normalized corpus in full dimension."""
        if self._X is None:
            self._X = center(self.raw, self.mean)
        return self._X

    def gaps_file(self, name: str = "gaps.json") -> Path:
        """Resolve a gaps document: a path, or a file name in the run directory
        (`holes` is short for `holes.json`)."""
        p = Path(name)
        if p.is_file():
            return p
        q = self.path / (name if name.endswith(".json") else name + ".json")
        if q.is_file():
            return q
        raise InputError(f"{q} not found; run `find` (gaps.json) or `facets` (holes.json) first")

    def gaps_doc(self, name: str = "gaps.json") -> dict:
        return read_json(self.gaps_file(name))

    def space(self, gdoc: dict | None = None) -> Space:
        """The working space `find` used (components stored in pca.npz), so
        concepts and the map are projected exactly like the corpus was.
        Without a gaps.json the working space is the full centered one."""
        if gdoc is not None and gdoc.get("params", {}).get("pca", 0) > 0:
            p = self.path / ((gdoc.get("pca") or {}).get("path") or "pca.npz")
            if not p.is_file():
                raise InputError(f"{p} not found; re-run `find`")
            return Space.load(p)
        return Space(None)

    def novelty(self, gdoc: dict, Y: np.ndarray) -> np.ndarray:
        """Leave-one-out k-NN distance of every item in the working space Y
        (written by `find` to novelty.npy; recomputed if missing)."""
        p = self.path / gdoc.get("novelty_path", "novelty.npy")
        if p.is_file():
            d = np.load(p)
            if d.shape[0] == len(self.items):
                return d
        d = loo_knn_distance(Y, gdoc["params"]["k"])
        np.save(p, d)
        return d
