"""Target protocol and the dataclasses shared by history, buildcache, replay and the targets."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Protocol, runtime_checkable

import numpy as np

from drift.recordings import Recording

__all__ = ["Generation", "Recording", "RunOut", "Target"]


@dataclass
class Generation:
    """One distinct algorithm implementation (a maximal run of consecutive release tags whose algo blobs are equal)."""
    gen_id: str                    # short hash of the blob set (sha1 of "path:blob" lines, 8 hex chars)
    blobs: dict[str, str]          # algo path -> git blob sha at the first tag; paths absent from the tag are omitted
    first_tag: str
    last_tag: str
    tags: list[str]
    first_date: date               # release (tag commit) date of first_tag
    last_date: date | None         # release date of the NEXT generation's first tag; None = still the latest generation
    commit: str                    # representative commit to build from: last commit touching the algo files at first_tag
    label: str = ""                # e.g. "2v12-2v21 (DC filter)"

    @property
    def short(self) -> str:
        return self.commit[:8]


@dataclass
class RunOut:
    """Result of running one generation on one recording."""
    total: int                                  # total steps (step targets) or 0
    events: np.ndarray | None = None            # per-sample step events (int32, length = samples fed); sum(events) == total
    peaks: np.ndarray | None = None             # per-sample 0/1: a step-candidate peak was processed (step targets)
    n_samples: int = 0                          # samples fed to the firmware (includes any tail flush)
    hr: tuple[np.ndarray, np.ndarray] | None = None   # (t_s, bpm) series for HR targets
    meta: dict = field(default_factory=dict)


@runtime_checkable
class Target(Protocol):
    name: str
    repo_url: str
    algo_files: list[str]
    tag_glob: str
    tag_min: str | None             # first tag of interest (natural order); earlier tags are ignored
    datasets: list[str]             # fetchers needed: names registered in drift.fetch.FETCHERS
    recipe_files: list[Path]        # shim/wrapper files that define the build; hashed into the build-cache key

    def adapt(self, rec: Recording) -> np.ndarray:
        """Resample/scale a recording to the device's native input."""

    def build(self, gen: Generation, src_dir: Path) -> Path:
        """Compile gen from the algo files materialised in src_dir (basenames); return the shared library path."""

    def run(self, dll: Path, native: np.ndarray) -> RunOut:
        """Feed native input through a built generation: totals plus per-sample events (steps) or an HR series."""

    def describe(self, gen: Generation) -> str:
        """Short human description of what this generation changed (used in labels)."""

    def recordings(self, cache: Path) -> list[Recording]:
        """Load every recording this target replays from the fetch cache."""
