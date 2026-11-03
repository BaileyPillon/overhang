"""Target registry. A target lives in drift/targets/<name>/target.py and exposes TARGET_CLASS."""
from __future__ import annotations

import importlib

TARGETS = ["espruino_stepcount", "infinitime_hr"]


def get_target(name: str, **options):
    if name not in TARGETS:
        raise KeyError(f"unknown target {name!r}; known: {', '.join(TARGETS)}")
    mod = importlib.import_module(f"drift.targets.{name}.target")
    return mod.TARGET_CLASS(**options)
