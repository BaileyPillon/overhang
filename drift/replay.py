"""Differential execution: run every generation on every recording and keep the results table.

Each recording is adapted once (target.adapt) and fed, identically, to every generation.  The per-sample events are
kept (sparsely when saved) so per-step matching can be done downstream by metrics.py.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from drift import CACHE_DIR
from drift.targets.base import Generation, Recording, RunOut


@dataclass
class ReplayResult:
    target: str
    generations: list[Generation]
    recordings: list[Recording]                       # data kept in native units; truth attached
    runs: dict[tuple[str, str], RunOut] = field(default_factory=dict)    # (gen_id, rec_id) -> RunOut
    n_native: dict[str, int] = field(default_factory=dict)               # rec_id -> samples after adapt()

    def total(self, gen_id: str, rec_id: str) -> int:
        return self.runs[(gen_id, rec_id)].total

    def totals(self) -> dict[str, dict[str, int]]:
        """gen_id -> rec_id -> steps counted."""
        out: dict[str, dict[str, int]] = {g.gen_id: {} for g in self.generations}
        for (gid, rid), r in self.runs.items():
            out[gid][rid] = r.total
        return out

    def rows(self) -> list[dict]:
        """Flat results table: one row per (generation, recording)."""
        truth = {r.rec_id: r for r in self.recordings}
        rows = []
        for g in self.generations:
            for rec in self.recordings:
                run = self.runs[(g.gen_id, rec.rec_id)]
                if run.hr is not None:       # heart-rate targets: no step counts; ret > 0 outputs per recording
                    rows.append({"gen_id": g.gen_id, "gen_label": g.label, "rec_id": rec.rec_id, "source": rec.source,
                                 "subject": rec.subject, "kind": rec.kind, "hr_outputs": run.total,
                                 "n_samples": run.n_samples, "rate_hz": run.meta.get("rate_hz"),
                                 "duration_s": truth[rec.rec_id].n / rec.rate_hz})
                    continue
                t = rec.truth.get("steps_total")
                rows.append({
                    "gen_id": g.gen_id, "gen_label": g.label, "rec_id": rec.rec_id, "source": rec.source,
                    "subject": rec.subject, "kind": rec.kind, "steps_counted": run.total, "steps_true": t,
                    "error": None if not t else (run.total - t) / t,
                    "duration_s": truth[rec.rec_id].n / rec.rate_hz,
                })
        return rows

    def save(self, path: Path) -> Path:
        """JSON rows plus a sidecar .npz with sparse per-sample events (sample index and count of every firing) and the
        sample indices of the step-candidate peaks."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"target": self.target, "rows": self.rows()}, indent=1))
        arrs = {}
        for (gid, rid), run in self.runs.items():
            ev = run.events
            if ev is not None:
                nz = np.flatnonzero(ev)
                arrs[f"{gid}|{rid}|idx"] = nz.astype(np.int32)
                arrs[f"{gid}|{rid}|cnt"] = ev[nz].astype(np.int16)
            if run.hr is not None:       # sparse non-zero Ppg::HeartRate() returns (bpm, -1 reset, -2 not enough data)
                ret = run.hr[1]
                nz = np.flatnonzero(ret)
                arrs[f"{gid}|{rid}|hr_idx"] = nz.astype(np.int32)
                arrs[f"{gid}|{rid}|hr_val"] = ret[nz].astype(np.int16)
            arrs[f"{gid}|{rid}|n"] = np.array([run.n_samples], dtype=np.int32)
            if run.peaks is not None:
                arrs[f"{gid}|{rid}|pk"] = np.flatnonzero(run.peaks).astype(np.int32)
        np.savez_compressed(path.with_suffix(".events.npz"), **arrs)
        return path


def load(path: Path, generations: list[Generation], recordings: list[Recording]) -> ReplayResult:
    """Rebuild a ReplayResult from what save() wrote (the JSON rows give the totals, the .npz the sparse per-sample
    events and peaks).  The caller supplies the generations and recordings (history + loaders), so a stale table is
    caught by the consistency checks below instead of silently mixed with new data."""
    path = Path(path)
    rows = json.loads(path.read_text())["rows"]
    npz = np.load(path.with_suffix(".events.npz"))
    res = ReplayResult(target=json.loads(path.read_text())["target"], generations=list(generations),
                       recordings=list(recordings))
    totals = {(r["gen_id"], r["rec_id"]): r["steps_counted"] for r in rows}
    for g in generations:
        for rec in recordings:
            key = (g.gen_id, rec.rec_id)
            if key not in totals or f"{g.gen_id}|{rec.rec_id}|idx" not in npz:
                raise KeyError(f"{path.name} has no result for {key}; re-run: python -m drift replay")
            n = int(npz[f"{g.gen_id}|{rec.rec_id}|n"][0])
            ev = np.zeros(n, dtype=np.int32)
            ev[npz[f"{g.gen_id}|{rec.rec_id}|idx"]] = npz[f"{g.gen_id}|{rec.rec_id}|cnt"]
            pk = None
            if f"{g.gen_id}|{rec.rec_id}|pk" in npz:
                pk = np.zeros(n, dtype=np.int8)
                pk[npz[f"{g.gen_id}|{rec.rec_id}|pk"]] = 1
            if int(ev.sum()) != totals[key]:
                raise ValueError(f"{path.name}: events do not sum to the total for {key}")
            res.runs[key] = RunOut(total=int(totals[key]), events=ev, peaks=pk, n_samples=n)
            res.n_native[rec.rec_id] = n
    return res


def replay(target, generations: list[Generation], dlls: dict[str, Path], recordings: list[Recording],
           progress=None) -> ReplayResult:
    res = ReplayResult(target=target.name, generations=list(generations), recordings=list(recordings))
    for i, rec in enumerate(recordings):
        native = target.adapt(rec)
        res.n_native[rec.rec_id] = int(len(native))
        for g in generations:
            res.runs[(g.gen_id, rec.rec_id)] = target.run(dlls[g.gen_id], native)
        if progress:
            progress(i + 1, len(recordings), rec.rec_id)
    return res


def default_path(target_name: str, cache: Path = CACHE_DIR, partial: bool = False) -> Path:
    """The full device-faithful table is <target>.json; --only / --flush runs go to <target>.partial.json."""
    return Path(cache) / "replay" / f"{target_name}{'.partial' if partial else ''}.json"
