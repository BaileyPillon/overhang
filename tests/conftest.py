"""Shared synthetic data: clusters on a high-dimensional sphere with one
deliberately empty region between two of them."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from gapfind.core import center, l2_normalize

DIM = 128
PER_CLUSTER = 60
N_BRIDGE = 80  # points spread evenly over the arc between clusters 4 and 7
BRIDGE_ARC = (215.0, 320.0)  # a "populated bridge": same width as the hole, but full
# Cluster centers sit on a great circle (a 2D plane inside the 128D sphere).
# Neighbors are 35 degrees apart, except between 70 and 180 degrees: that
# 110-degree stretch is the planted hole, centered at 125 degrees. A second
# stretch of about the same width (215 to 320 degrees) is deliberately full.
ANGLES = [0, 35, 70, 180, 215, 250, 285, 320]
HOLE_DEG = 125.0


def make_planted(seed: int = 0, sigma: float = 0.25, spread_deg: float = 7.0) -> SimpleNamespace:
    rng = np.random.default_rng(seed)
    q, _ = np.linalg.qr(rng.normal(size=(DIM, DIM)))
    e1, e2, rest = q[:, 0], q[:, 1], q[:, 2:]
    pts, label = [], []
    for k, a in enumerate(ANGLES):
        th = np.deg2rad(a + rng.normal(scale=spread_deg, size=PER_CLUSTER))
        ring = np.outer(np.cos(th), e1) + np.outer(np.sin(th), e2)
        noise = rng.normal(size=(PER_CLUSTER, DIM - 2)) / np.sqrt(DIM - 2) * sigma
        pts.append(ring + noise @ rest.T)
        label += [k] * PER_CLUSTER
    # a populated bridge: a continuum of points from cluster 4 (215 deg) to cluster 7 (320 deg)
    th = np.deg2rad(rng.uniform(*BRIDGE_ARC, size=N_BRIDGE))
    ring = np.outer(np.cos(th), e1) + np.outer(np.sin(th), e2)
    pts.append(ring + rng.normal(size=(N_BRIDGE, DIM - 2)) / np.sqrt(DIM - 2) * sigma @ rest.T)
    label += [len(ANGLES)] * N_BRIDGE
    raw = l2_normalize(np.vstack(pts))
    label = np.array(label)
    raw_centers = l2_normalize(np.vstack([raw[label == k].mean(axis=0) for k in range(len(ANGLES))]))
    raw_hole = l2_normalize(np.cos(np.deg2rad(HOLE_DEG)) * e1 + np.sin(np.deg2rad(HOLE_DEG)) * e2)

    def anchor(k):  # the member of cluster k that sits closest to the cluster center
        members = np.flatnonzero(label == k)
        return int(members[np.argmax(raw[members] @ raw_centers[k])])

    mean = raw.mean(axis=0)
    items = [{"id": f"p{i:03d}", "title": f"point {i}", "text": f"synthetic point {i}",
              "domain": f"cluster-{label[i]}"} for i in range(len(raw))]
    return SimpleNamespace(
        raw=raw, label=label, mean=mean, items=items,
        pair_empty=(anchor(2), anchor(3)),      # parents on either side of the planted hole
        pair_populated=(anchor(4), anchor(7)),  # parents on either side of the populated bridge
        X=center(raw, mean),                    # centered corpus
        centers=center(raw_centers, mean),      # centered cluster centers
        hole=center(raw_hole[None], mean)[0],   # centered planted hole center
        raw_hole=raw_hole, raw_centers=raw_centers)


@pytest.fixture(scope="session")
def planted() -> SimpleNamespace:
    return make_planted()
