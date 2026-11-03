"""Espruino firmware source (MPL-2.0), as a blobless git clone: history is complete (trees, tags, commits) and the
algorithm blobs are fetched lazily when a generation is built.  Never vendored into the repo."""
from __future__ import annotations

from pathlib import Path

from drift import CACHE_DIR, RECON_DL
from drift.fetch.common import copy_tree, run_git

REPO_URL = "https://github.com/espruino/Espruino.git"
NAME = "espruino"


def repo_path(cache: Path = CACHE_DIR) -> Path:
    return Path(cache) / "espruino" / "Espruino"


def _ok(p: Path) -> bool:
    return (p / ".git").exists() or (p / "HEAD").exists()


def fetch(cache: Path = CACHE_DIR, update: bool = False) -> dict:
    dest = repo_path(cache)
    how = "present"
    if not _ok(dest):
        recon = RECON_DL / "espruino" / "src"
        if _ok(recon):
            copy_tree(recon, dest)
            how = f"copied from {recon}"
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            run_git("clone", "--filter=blob:none", "--no-checkout", "--tags", REPO_URL, str(dest))
            how = f"cloned {REPO_URL} (blobless)"
    if update:
        run_git("fetch", "--tags", "--filter=blob:none", "origin", cwd=dest)
        how += "; fetched tags"
    return {"name": NAME, "path": str(dest), "how": how, "url": REPO_URL, "head": run_git("rev-parse", "HEAD", cwd=dest)}
