"""Build cache: compile each unique algorithm blob set once.

Key = sha256(target name, algo blob set, contents of the target's recipe files (wrapper, shim), compiler version/flags).
Layout: <cache>/build/<target>/<key16>/{src/<algo basenames>, <target>_<gen_id>.dll, build.json}
Algo files are written from git blobs by SHA (git cat-file blob), so a build never depends on a checkout.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import time
from pathlib import Path

from drift import CACHE_DIR
from drift.targets.base import Generation


def recipe_hash(target) -> str:
    h = hashlib.sha256(str(getattr(target, "recipe_extra", "")).encode())
    for p in sorted(Path(f) for f in target.recipe_files):
        h.update(p.name.encode())
        h.update(p.read_bytes())
    return h.hexdigest()


def build_key(target, gen: Generation, toolchain: str) -> str:
    blob = json.dumps({"target": target.name, "blobs": sorted(gen.blobs.items()), "recipe": recipe_hash(target),
                       "toolchain": toolchain}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


def materialize(repo: Path, gen: Generation, src_dir: Path) -> None:
    """Write the generation's algorithm files (flat, by basename) from git blobs into src_dir."""
    src_dir.mkdir(parents=True, exist_ok=True)
    seen = set()
    for path, sha in gen.blobs.items():
        name = Path(path).name
        if name in seen:
            raise ValueError(f"algo files share a basename: {name}")
        seen.add(name)
        r = subprocess.run(["git", "-C", str(repo), "cat-file", "blob", sha], capture_output=True)
        if r.returncode:
            raise RuntimeError(f"git cat-file blob {sha} ({path}) failed: {r.stderr.decode(errors='replace')}")
        (src_dir / name).write_bytes(r.stdout)


def build_generation(target, gen: Generation, repo: Path, cache: Path = CACHE_DIR, force: bool = False) -> Path:
    """Return the compiled library for gen, building it only if this blob set was not built before."""
    from drift.toolchain import zig_version
    tc = f"zig {zig_version()}"
    key = build_key(target, gen, tc)
    d = Path(cache) / "build" / target.name / key[:16]
    meta = d / "build.json"
    if meta.exists() and not force:
        dll = d / json.loads(meta.read_text())["dll"]
        if dll.exists():
            return dll
    src = d / "src"
    if d.exists():
        import shutil
        shutil.rmtree(d)
    materialize(Path(repo), gen, src)
    t0 = time.time()
    dll = Path(target.build(gen, src))
    meta.write_text(json.dumps({
        "target": target.name, "gen_id": gen.gen_id, "commit": gen.commit, "blobs": gen.blobs, "key": key,
        "toolchain": tc, "dll": dll.name, "built_s": round(time.time() - t0, 2),
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }, indent=1))
    return dll


def build_all(target, generations: list[Generation], repo: Path, cache: Path = CACHE_DIR, force: bool = False) -> dict[str, Path]:
    return {g.gen_id: build_generation(target, g, repo, cache, force) for g in generations}
