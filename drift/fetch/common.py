"""Shared fetch helpers: git, resumable-free atomic download, hashing, copying recon downloads."""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from pathlib import Path


def run_git(*args: str, cwd: Path | None = None) -> str:
    r = subprocess.run(["git", *args], cwd=str(cwd) if cwd else None, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout.strip()


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                return h.hexdigest()
            h.update(b)


def download(url: str, dest: Path, expected_size: int | None = None, timeout: int = 60) -> Path:
    """Stream url to dest atomically (via dest.part).  Verifies the size when given."""
    import requests
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    with requests.get(url, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        with open(part, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    size = part.stat().st_size
    if expected_size is not None and size != expected_size:
        part.unlink()
        raise RuntimeError(f"{url}: got {size} bytes, expected {expected_size}")
    os.replace(part, dest)
    return dest


def copy_tree(src: Path, dst: Path) -> None:
    """Copy a directory tree (used to reuse recon downloads); leaves nothing half-copied at dst."""
    tmp = dst.with_name(dst.name + ".copying")
    if tmp.exists():
        shutil.rmtree(tmp)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, tmp)
    os.replace(tmp, dst)
