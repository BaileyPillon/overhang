"""Bangle.js step-count recordings: github.com/gfwilliams/step-count pinned at d4b015c (no licence in the repo, so
Drift only references it by URL + commit and downloads it to the local cache; it is never redistributed)."""
from __future__ import annotations

from pathlib import Path

from drift import CACHE_DIR, RECON_DL
from drift.fetch.common import copy_tree, run_git

REPO_URL = "https://github.com/gfwilliams/step-count.git"
COMMIT = "d4b015c09483ff671f5b3998b2aefdfe67ac27e6"
NAME = "bangle"


def repo_path(cache: Path = CACHE_DIR) -> Path:
    return Path(cache) / "datasets" / "bangle-step-count"


def data_dir(cache: Path = CACHE_DIR) -> Path:
    return repo_path(cache) / "data"


def fetch(cache: Path = CACHE_DIR) -> dict:
    dest = repo_path(cache)
    how = "present"
    if not (dest / ".git").exists():
        recon = RECON_DL / "espruino" / "step-count"
        if (recon / ".git").exists():
            copy_tree(recon, dest)
            how = f"copied from {recon}"
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            run_git("clone", "--no-checkout", REPO_URL, str(dest))
            how = f"cloned {REPO_URL}"
    head = run_git("rev-parse", "HEAD", cwd=dest)
    dirty = run_git("status", "--porcelain", "--untracked-files=no", cwd=dest)
    if head != COMMIT or dirty or not data_dir(cache).exists():
        run_git("checkout", "--force", "--detach", COMMIT, cwd=dest)
        how += f"; checked out {COMMIT[:7]}"
    n = len(list(data_dir(cache).glob("*.csv")))
    return {"name": NAME, "path": str(dest), "how": how, "url": REPO_URL, "commit": run_git("rev-parse", "HEAD", cwd=dest),
            "files": n}
