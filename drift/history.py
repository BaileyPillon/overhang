"""Firmware history: release tag -> algorithm blob map, collapsed into generations.

A generation is a maximal run of consecutive release tags (in version order) whose algorithm files are byte-identical
(equal git blob SHAs).  Only tree lookups are needed, so a blobless clone is enough to build the history; blobs are
fetched lazily when a generation is built.
"""
from __future__ import annotations

import hashlib
import re
import subprocess
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from drift.targets.base import Generation


class GitError(RuntimeError):
    pass


def git(repo: Path, *args: str, text: bool = True) -> str | bytes:
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True)
    if r.returncode:
        raise GitError(f"git {' '.join(args)} failed in {repo}: {r.stderr.decode(errors='replace').strip()}")
    return r.stdout.decode().strip() if text else r.stdout


def natural_key(tag: str) -> tuple[int, ...]:
    """RELEASE_2V09 -> (2, 9); RELEASE_2V10 -> (2, 10).  Tags are ordered by version, never by date."""
    nums = tuple(int(n) for n in re.findall(r"\d+", tag))
    if not nums:
        raise ValueError(f"tag without a version number: {tag}")
    return nums


def list_tags(repo: Path, tag_glob: str, tag_min: str | None = None, tag_max: str | None = None) -> list[str]:
    out = git(repo, "tag", "--list", tag_glob)
    tags = sorted((t for t in out.splitlines() if t.strip() and re.search(r"\d", t)), key=natural_key)
    if tag_min:
        tags = [t for t in tags if natural_key(t) >= natural_key(tag_min)]
    if tag_max:
        tags = [t for t in tags if natural_key(t) <= natural_key(tag_max)]
    return tags


def tag_date(repo: Path, tag: str) -> date:
    """Committer date (as written in the commit, i.e. its own timezone) of the commit the tag points at."""
    iso = git(repo, "log", "-1", "--format=%cI", f"refs/tags/{tag}^{{commit}}")
    return date.fromisoformat(iso[:10])


def blob_at(repo: Path, rev: str, path: str) -> str | None:
    r = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "--quiet", f"{rev}:{path}"],
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def last_commit_touching(repo: Path, rev: str, paths: list[str]) -> str | None:
    out = git(repo, "log", "-1", "--format=%H", rev, "--", *paths)
    return out or None


def gen_id_for(blobs: dict[str, str | None], algo_files: list[str]) -> str:
    """Short id of a blob set; absent files are part of the identity ("path:-")."""
    lines = [f"{p}:{blobs.get(p) or '-'}" for p in sorted(algo_files)]
    return hashlib.sha1("\n".join(lines).encode()).hexdigest()[:8]


@dataclass
class TagInfo:
    tag: str
    date: date
    blobs: dict[str, str | None]      # algo path -> blob sha, None when the file does not exist at that tag
    commit: str                       # representative commit for this tag's algorithm state


def default_label(tags: list[str]) -> str:
    def short(t: str) -> str:
        return t.split("_", 1)[-1].lower()
    return short(tags[0]) if len(tags) == 1 else f"{short(tags[0])}–{short(tags[-1])}"


def collapse(infos: list[TagInfo], algo_files: list[str]) -> list[Generation]:
    """Collapse consecutive TagInfos with identical blob sets into Generations (pure function; input in version order).

    Non-consecutive repeats stay separate generations (an algorithm that is reverted to an earlier state is a new
    release in time, and the memo reasons in time).  last_date of a generation is the first_date of the next one.
    """
    gens: list[Generation] = []
    last_key = None
    for info in infos:
        key = tuple(info.blobs.get(p) for p in algo_files)
        if gens and last_key == key:
            g = gens[-1]
            g.tags.append(info.tag)
            g.last_tag = info.tag
            continue
        g = Generation(
            gen_id=gen_id_for(info.blobs, algo_files),
            blobs={p: b for p, b in info.blobs.items() if b},
            first_tag=info.tag, last_tag=info.tag, tags=[info.tag],
            first_date=info.date, last_date=None, commit=info.commit,
        )
        last_key = key
        gens.append(g)
    for a, b in zip(gens, gens[1:]):
        a.last_date = b.first_date
    for g in gens:
        g.label = default_label(g.tags)
    ids = [g.gen_id for g in gens]
    if len(set(ids)) != len(ids):
        # same blob set reappearing later: keep both generations but make ids unique and stable
        seen: dict[str, int] = {}
        for g in gens:
            n = seen.get(g.gen_id, 0)
            seen[g.gen_id] = n + 1
            if n:
                g.gen_id = f"{g.gen_id}-{n + 1}"
    return gens


def build_history(repo: Path, algo_files: list[str], tag_glob: str, tag_min: str | None = None,
                  tag_max: str | None = None) -> list[Generation]:
    """Tag -> blob map for every matching release tag, collapsed into generations (oldest first)."""
    infos = []
    for tag in list_tags(repo, tag_glob, tag_min, tag_max):
        blobs = {p: blob_at(repo, f"refs/tags/{tag}", p) for p in algo_files}
        commit = None
        if any(blobs.values()):
            commit = last_commit_touching(repo, f"refs/tags/{tag}", [p for p in algo_files if blobs[p]])
        if commit is None:
            commit = git(repo, "rev-parse", f"refs/tags/{tag}^{{commit}}")
        infos.append(TagInfo(tag, tag_date(repo, tag), blobs, commit))
    return collapse(infos, algo_files)


def tag_set_digest(repo: Path, tags: list[str]) -> str:
    """SHA-256 (first 16 hex) of the "tag<TAB>commit" lines of a tag list: pins WHICH commits the tags point at."""
    h = hashlib.sha256()
    for t in tags:
        commit = git(repo, "rev-parse", f"refs/tags/{t}^{{commit}}")
        h.update(f"{t}\t{commit}\n".encode())
    return h.hexdigest()[:16]


def check_tag_pin(repo: Path, tag_glob: str, tag_min: str, tag_max: str, expected_digest: str,
                  only: "re.Pattern | None" = None, strict: bool | None = None) -> dict:
    """Firmware clones move: new release tags appear and (rarely) tags are re-pointed.  Drift pins the tag window
    [tag_min, tag_max] and the commit every tag in it points at (expected_digest).  Tags NEWER than tag_max are ignored
    (and reported); a different digest changes the generations, dates and results, so it is an error unless
    DRIFT_ALLOW_UNPINNED=1 (then it is only a warning).  Returns a dict for the provenance block."""
    import os
    import sys
    tags = [t for t in list_tags(repo, tag_glob, tag_min, tag_max) if only is None or only.fullmatch(t)]
    digest = tag_set_digest(repo, tags)
    newer = [t for t in list_tags(repo, tag_glob, tag_min) if (only is None or only.fullmatch(t)) and t not in tags]
    ok = digest == expected_digest
    info = {"tag_window": [tag_min, tag_max], "n_tags": len(tags), "tags_sha256_16": digest,
            "pinned_sha256_16": expected_digest, "matches_pin": ok, "newer_tags_ignored": newer}
    if newer:
        print(f"warning: {len(newer)} release tag(s) newer than the pinned {tag_max} exist in {repo.name} and are ignored: "
              f"{', '.join(newer[:5])}{' ...' if len(newer) > 5 else ''}", file=sys.stderr)
    if not ok:
        msg = (f"{repo.name}: the tags {tag_min}..{tag_max} point at different commits than the pinned set "
               f"({digest} != {expected_digest}); generations, dates and results may differ from the published ones")
        if strict is None:
            strict = os.environ.get("DRIFT_ALLOW_UNPINNED") != "1"
        if strict:
            raise RuntimeError(msg + " (set DRIFT_ALLOW_UNPINNED=1 to continue anyway)")
        print("warning: " + msg, file=sys.stderr)
    return info


def tag_blob_map(repo: Path, algo_files: list[str], tag_glob: str, tag_min: str | None = None) -> dict[str, dict]:
    """Plain tag -> {path: blob} map (for provenance and the results JSON)."""
    return {t: {p: blob_at(repo, f"refs/tags/{t}", p) for p in algo_files} for t in list_tags(repo, tag_glob, tag_min)}
