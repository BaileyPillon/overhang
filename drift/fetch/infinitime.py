"""InfiniTime firmware source (GPL-3.0-or-later) as a blobless git clone, plus the pinned arduinoFFT library that
InfiniTime >= 1.13.0 pulls in as a git submodule (GPL-3.0-or-later).  Neither is vendored into the Drift repo:
both live in the cache and are only read (git trees/blobs for the heart-rate files; header-only FFT sources)."""
from __future__ import annotations

from pathlib import Path

from drift import CACHE_DIR, RECON_DL
from drift.fetch.common import copy_tree, run_git

REPO_URL = "https://github.com/InfiniTimeOrg/InfiniTime.git"
FFT_URL = "https://github.com/kosme/arduinoFFT.git"
# The submodule commit InfiniTime pins at every release tag from 1.13.0 to 1.16.1 (src/libs/arduinoFFT gitlink).
FFT_COMMIT = "419d7b044e56b87de8efbcf76f09c04759628fb4"
NAME = "infinitime"


def repo_path(cache: Path = CACHE_DIR) -> Path:
    return Path(cache) / "infinitime" / "InfiniTime"


def fft_path(cache: Path = CACHE_DIR) -> Path:
    return Path(cache) / "infinitime" / "arduinoFFT"


def _ok(p: Path) -> bool:
    return (p / ".git").exists() or (p / "HEAD").exists()


def fetch(cache: Path = CACHE_DIR, update: bool = False) -> dict:
    dest = repo_path(cache)
    how = []
    if not _ok(dest):
        recon = RECON_DL / "infinitime"
        if _ok(recon):
            copy_tree(recon, dest)
            how.append(f"InfiniTime copied from {recon}")
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            run_git("clone", "--filter=blob:none", "--no-checkout", "--tags", REPO_URL, str(dest))
            how.append(f"cloned {REPO_URL} (blobless)")
    if update:
        run_git("fetch", "--tags", "--filter=blob:none", "origin", cwd=dest)
        how.append("fetched tags")
    fft = fft_path(cache)
    if not _ok(fft):
        recon = RECON_DL / "arduinoFFT"
        if _ok(recon):
            copy_tree(recon, fft)
            how.append(f"arduinoFFT copied from {recon}")
        else:
            fft.parent.mkdir(parents=True, exist_ok=True)
            run_git("clone", "--no-checkout", FFT_URL, str(fft))
            how.append(f"cloned {FFT_URL}")
    if run_git("rev-parse", "HEAD", cwd=fft) != FFT_COMMIT or run_git("status", "--porcelain", "--untracked-files=no", cwd=fft):
        run_git("checkout", "--force", "--detach", FFT_COMMIT, cwd=fft)
        how.append(f"arduinoFFT checked out {FFT_COMMIT[:7]}")
    return {"name": NAME, "path": str(dest), "how": "; ".join(how) or "present", "url": REPO_URL,
            "head": run_git("rev-parse", "HEAD", cwd=dest), "arduinoFFT": {"url": FFT_URL, "commit": FFT_COMMIT}}
