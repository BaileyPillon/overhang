"""python -m drift fetch|build|replay|metrics|memo|export|all --target espruino_stepcount

fetch    download datasets + firmware source into .cache/drift/ (copies recon downloads when present)
build    firmware history -> generations -> compile each unique blob set once (cached by blob SHA)
replay   run every generation on every recording; writes .cache/drift/replay/<target>.json (+ .events.npz)
metrics  count error, per-step matching, false positives, paired drift with bootstrap CIs -> .cache/drift/metrics/<target>.json
memo     study window -> dated data-validity memo (Markdown + HTML) in results/drift/
export   results/drift/<target>.json and app/public/data/winner.json
all      fetch -> build -> replay -> metrics -> memo (worked example window) -> export
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import date
from pathlib import Path

from drift import CACHE_DIR
from drift import buildcache, history, replay as replay_mod
from drift.targets import TARGETS, get_target

# extra stages that register themselves: callables taking (args, target, result); they run after replay, before metrics
STAGES_AFTER_REPLAY: list = []


def _history(target, cache: Path):
    """(firmware repo, generations).  A target may define repo_path(cache) and generations(repo) when its firmware
    is not Espruino or when its tag history needs more than "one generation per distinct blob set"."""
    if hasattr(target, "repo_path"):
        repo = target.repo_path(cache)
    else:
        from drift.fetch import espruino
        repo = espruino.repo_path(cache)
    if not repo.exists():
        raise SystemExit(f"firmware source not found at {repo}; run: python -m drift fetch --target {target.name}")
    if hasattr(target, "generations"):
        return repo, target.generations(repo)
    tag_max = getattr(target, "tag_max", None)
    if tag_max and getattr(target, "tag_pin", None):
        target.tag_pin_info = history.check_tag_pin(repo, target.tag_glob, target.tag_min, tag_max, target.tag_pin)
    gens = history.build_history(repo, target.algo_files, target.tag_glob, tag_min=target.tag_min, tag_max=tag_max)
    for g in gens:
        d = target.describe(g)
        g.label = f"{g.label} ({d})" if d else g.label
    return repo, gens


def cmd_fetch(args, target) -> int:
    from drift.fetch import fetch_all
    for info in fetch_all(target.datasets, Path(args.cache)):
        print(f"fetch {info['name']}: {info['how']} -> {info['path']}")
    return 0


def cmd_build(args, target) -> int:
    repo, gens = _history(target, Path(args.cache))
    dlls = buildcache.build_all(target, gens, repo, Path(args.cache), force=args.force)
    print(f"{target.name}: {len(gens)} generations")
    for g in gens:
        last = g.last_date.isoformat() if g.last_date else "now"
        print(f"  {g.gen_id}  {g.commit[:8]}  {g.first_date}..{last}  {g.label}  -> {dlls[g.gen_id].name}")
    return 0


def _run_replay(args, target):
    cache = Path(args.cache)
    repo, gens = _history(target, cache)
    dlls = buildcache.build_all(target, gens, repo, cache)
    recs = target.recordings(cache)
    if args.only:
        recs = [r for r in recs if any(s in r.rec_id for s in args.only)]
    res = replay_mod.replay(target, gens, dlls, recs,
                            progress=(lambda i, n, rid: print(f"  replay {i}/{n} {rid}", flush=True)
                                      if i % 30 == 0 or i == n else None))
    out = res.save(replay_mod.default_path(target.name, cache, partial=bool(args.only or args.flush)))
    print(f"replayed {len(recs)} recordings x {len(gens)} generations -> {out}")
    return res


def _print_table(res, kinds=("walk",), limit=12) -> None:
    gens = res.generations
    recs = [r for r in res.recordings if r.kind in kinds or "steps_total" in r.truth][:limit]
    print("recording".ljust(34) + "true".rjust(8) + "".join(g.label.split(" ")[0].rjust(12) for g in gens))
    for r in recs:
        print(r.rec_id[:33].ljust(34) + str(r.truth.get("steps_total", "?")).rjust(8) +
              "".join(str(res.total(g.gen_id, r.rec_id)).rjust(12) for g in gens))


def cmd_replay(args, target) -> int:
    res = _run_replay(args, target)
    (target.print_table if hasattr(target, "print_table") else _print_table)(res)
    return 0


# --------------------------------------------------------------------------------------------------------------
# metrics / memo / export
# --------------------------------------------------------------------------------------------------------------
def _load_full_replay(args, target):
    """The saved full replay table (device-faithful, no tail flush) as a ReplayResult; replays when it is missing."""
    cache = Path(args.cache)
    path = replay_mod.default_path(target.name, cache)
    if not path.exists() or not path.with_suffix(".events.npz").exists():
        print(f"no replay table at {path}; replaying first")
        args.only, args.flush = None, False
        _run_replay(args, target)
    repo, gens = _history(target, cache)
    return replay_mod.load(path, gens, target.recordings(cache))


def _metrics_path(target, cache: Path) -> Path:
    return Path(cache) / "metrics" / f"{target.name}.json"


def _cohort_context(cache: Path) -> dict:
    from drift.fetch import clemson
    ctx = {}
    demo = Path(clemson.base_dir(cache)) / "demographics.csv"
    if demo.exists():
        with demo.open(encoding="utf-8") as fh:
            ages = sorted(int(r["age(years)"]) for r in csv.DictReader(fh))
        n = len(ages)
        med = ages[n // 2] if n % 2 else (ages[n // 2 - 1] + ages[n // 2]) / 2
        ctx["clemson_age"] = {"n": n, "min": ages[0], "max": ages[-1], "median": med}
    return ctx


def _resampler_sensitivity(args, target, res) -> dict:
    """Replay the Clemson recordings with the alternative 15 -> 12.5 Hz resampler (linear interpolation, no
    anti-aliasing) through the same compiled generations and compare count error and boundary shifts with the default
    (polyphase).  The choice moves the semi-regular / irregular medians and the boundary CIs materially."""
    from drift import metrics as M
    if not hasattr(target, "resample_method"):
        return {}
    cache = Path(args.cache)
    repo, gens = _history(target, cache)
    dlls = buildcache.build_all(target, gens, repo, cache)
    alt = type(target)(flush=False, resample_method="linear")
    clem = [r for r in res.recordings if r.source == "clemson"]
    alt_res = replay_mod.replay(alt, res.generations, dlls, clem)
    return {"resampler_sensitivity": M.resampler_sensitivity(res, alt_res, target.resample_method, "linear",
                                                             threshold_pct=getattr(args, "threshold", None) or M.DEFAULT_THRESHOLD_PCT)}


def stage_metrics(args, target, res) -> dict:
    from drift import metrics as M
    from drift.export import dump_json
    gens = {("inline" if not g.blobs else g.commit[:8]): g.gen_id for g in res.generations}
    nulls = {gens[c]: gens[ref] for c, ref in getattr(target, "null_controls", {}).items() if c in gens and ref in gens}
    desc = {g.gen_id: target.describe(g) for g in res.generations}
    m = M.compute_metrics(res, nulls, descriptions=desc, context=_cohort_context(Path(args.cache)),
                          threshold_pct=getattr(args, "threshold", None) or M.DEFAULT_THRESHOLD_PCT,
                          extra=_resampler_sensitivity(args, target, res))
    out = _metrics_path(target, Path(args.cache))
    dump_json(m, out)
    print(f"metrics -> {out}")
    print("generation (median count error, %)".ljust(36) + "regular".rjust(10) + "semireg".rjust(10) + "irreg".rjust(10)
          + "F1@250".rjust(9) + "phase s".rjust(8) + "FP/h".rjust(8))
    for g in m["generations"]:
        ce, sm = m["count_error"][g["gen_id"]], m["step_match"]["results"][g["gen_id"]]["all"]["tol_250ms"]
        print(g["label"][:35].ljust(36) + "".join(f"{ce[k]['median_pct']:+.1f}".rjust(10) for k in M.GAITS)
              + f"{sm['f1']:.3f}".rjust(9) + f"{m['step_match']['latency_s'][g['gen_id']]:.2f}".rjust(8)
              + f"{m['false_positives'][g['gen_id']]['drive_train']['fp_per_hour']:.0f}".rjust(8))
    for n in m["null_controls"]:
        print(f"null control {n['control']} == {n['reference']}: {'PASS' if n['passed'] else 'FAIL'} ({n['recordings']} recordings)")
    return m


def _get_metrics(args, target) -> dict:
    p = _metrics_path(target, Path(args.cache))
    if not p.exists():
        print(f"no metrics at {p}; computing")
        return stage_metrics(args, target, _load_full_replay(args, target))
    return json.loads(p.read_text(encoding="utf-8"))


def _rel(p: Path) -> str:
    from drift import REPO_ROOT
    try:
        return Path(p).resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(p)


def stage_memo(args, target, metrics: dict | None = None) -> dict:
    from drift import export, memo as memo_mod
    metrics = metrics or _get_metrics(args, target)
    example = not (args.start or args.end)
    start = date.fromisoformat(args.start) if args.start else memo_mod.EXAMPLE_WINDOW[0]
    end = date.fromisoformat(args.end) if args.end else memo_mod.EXAMPLE_WINDOW[1]
    population = args.population or memo_mod.EXAMPLE_POPULATION
    m = memo_mod.build_memo(metrics, start, end, population=population, gait=args.gait,
                            threshold_pct=args.threshold or memo_mod.DEFAULT_THRESHOLD_PCT,
                            memo_date=None, target_name=target.name)
    base = Path(args.out) if args.out else export.RESULTS_DIR / ("memo-example" if example else f"memo-{start}_{end}")
    base.parent.mkdir(parents=True, exist_ok=True)
    md_path, html_path = base.with_suffix(".md"), base.with_suffix(".html")
    md_path.write_text(m.markdown, encoding="utf-8")
    html_path.write_text(m.html, encoding="utf-8")
    print(f"memo -> {md_path}\n        {html_path}")
    info = {"markdown": _rel(md_path), "html": _rel(html_path), "window": [start.isoformat(), end.isoformat()],
            "population": population, **m.facts}
    args._memo_info = info
    return info


def stage_export(args, target, res=None, metrics=None) -> int:
    from drift import export
    cache = Path(args.cache)
    res = res or _load_full_replay(args, target)
    metrics = metrics or _get_metrics(args, target)
    info = getattr(args, "_memo_info", None)
    if info is None:
        ex = export.RESULTS_DIR / "memo-example.md"
        if ex.exists():
            from drift import memo as memo_mod
            info = {"markdown": _rel(ex), "html": _rel(ex.with_suffix(".html")),
                    "window": [d.isoformat() for d in memo_mod.EXAMPLE_WINDOW], "population": memo_mod.EXAMPLE_POPULATION}
    results = export.build_results(metrics, res, target, cache, replay_mod.default_path(target.name, cache), info)
    rdir = Path(args.results_dir) if args.results_dir else export.RESULTS_DIR
    out = export.dump_json(results, rdir / f"{target.name}.json")
    print(f"export -> {out}")
    if not args.no_winner:
        wp = Path(args.winner_path) if args.winner_path else export.WINNER_PATH
        export.write_winner(results, wp, info)
        print(f"export -> {wp}")
    return 0


def _target_stages(args, target) -> int:
    """Targets that are not step counters (infinitime_hr) bring their own post-replay stages (metrics + export in one:
    the hook list `target.stages_after_replay`), because the step metrics/memo/winner.json do not apply to them."""
    args.only, args.flush = None, False
    res = _run_replay(args, target)
    for stage in target.stages_after_replay:
        stage(args, target, res)
    return 0


def cmd_metrics(args, target) -> int:
    if hasattr(target, "stages_after_replay"):
        return _target_stages(args, target)
    stage_metrics(args, target, _load_full_replay(args, target))
    return 0


def cmd_memo(args, target) -> int:
    if hasattr(target, "stages_after_replay"):
        raise SystemExit(f"{target.name}: no study-window memo for this target (step-count metrics only)")
    stage_memo(args, target)
    return 0


def cmd_export(args, target) -> int:
    if hasattr(target, "stages_after_replay"):
        return _target_stages(args, target)
    return stage_export(args, target)


def cmd_all(args, target) -> int:
    for fn in (cmd_fetch, cmd_build):
        rc = fn(args, target)
        if rc:
            return rc
    if hasattr(target, "stages_after_replay"):
        return _target_stages(args, target)
    # the table that metrics/memo/export use is always the full device-faithful one
    args.only, args.flush = None, False
    res = _run_replay(args, target)
    for stage in STAGES_AFTER_REPLAY:
        stage(args, target, res)
    metrics = stage_metrics(args, target, res)
    stage_memo(args, target, metrics)
    return stage_export(args, target, res, metrics)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m drift", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn, helptext in (("fetch", cmd_fetch, "download datasets and firmware source"),
                               ("build", cmd_build, "compile each distinct firmware generation"),
                               ("replay", cmd_replay, "run every generation on every recording"),
                               ("metrics", cmd_metrics, "count error, step matching, false positives, paired drift"),
                               ("memo", cmd_memo, "write the data-validity memo for a study window"),
                               ("export", cmd_export, "write results/drift/<target>.json and app winner.json"),
                               ("all", cmd_all, "fetch, build, replay, metrics, memo, export")):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("--target", default="espruino_stepcount", choices=TARGETS)
        p.add_argument("--cache", default=str(CACHE_DIR), help="cache dir (default .cache/drift)")
        if name in ("fetch", "build", "replay", "all"):
            p.add_argument("--flush", action="store_true", help="append 7 repeated samples like upstream main.c (device does not)")
            p.add_argument("--force", action="store_true", help="rebuild even if cached")
            p.add_argument("--only", nargs="*", help="replay only recordings whose id contains one of these strings")
        if name in ("metrics", "memo", "all"):
            p.add_argument("--threshold", type=float, default=None,
                           help="comparability threshold in percentage points (default 2.0)")
        p.add_argument("--date", help="date stamped into results and memos, YYYY-MM-DD (default: DRIFT_DATE, "
                                      "SOURCE_DATE_EPOCH, else today); pin it for byte-identical re-runs")
        if name in ("memo", "all"):
            p.add_argument("--start", help="study window start, YYYY-MM-DD (default: the worked example, 2021-05-01)")
            p.add_argument("--end", help="study window end, YYYY-MM-DD (default: the worked example, 2022-06-30)")
            p.add_argument("--population", help='free text, e.g. "older adults, regular gait"')
            p.add_argument("--gait", choices=["regular", "semiregular", "irregular", "all"],
                           help="gait type to report (default: read from --population)")
            p.add_argument("--out", help="output path without extension (default results/drift/memo-example or memo-<start>_<end>)")
        if name in ("export", "all"):
            p.add_argument("--results-dir", help="where to write <target>.json (default results/drift)")
            p.add_argument("--winner-path", help="winner.json to write (default app/public/data/winner.json)")
            p.add_argument("--no-winner", action="store_true", help="do not write winner.json")
        p.set_defaults(fn=fn)
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if getattr(args, "date", None):
        date.fromisoformat(args.date)             # validate early
        os.environ["DRIFT_DATE"] = args.date
    flush = getattr(args, "flush", False)
    target = get_target(args.target, flush=flush)
    if hasattr(target, "cache"):          # targets that read the firmware clone / datasets themselves
        target.cache = Path(args.cache)
    return args.fn(args, target)


if __name__ == "__main__":
    sys.exit(main())
