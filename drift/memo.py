"""Dated data-validity memo: a study window in, a Markdown and an HTML memo out.

The memo is built as a list of blocks (headings, paragraphs, tables, lists) that is rendered twice, so the two files
always say the same thing.  Every number comes from the metrics dict (drift.metrics.compute_metrics / its JSON); the
only hand-written facts are the citations below, each checked against its source on 2026-11-03.
"""
from __future__ import annotations

import html as _html
import re
from dataclasses import dataclass
from datetime import date, timedelta

from drift import __version__, generated_date
from drift.metrics import DEFAULT_THRESHOLD_PCT, GAIT_NAMES, GAITS, verdict

EXAMPLE_WINDOW = (date(2021, 5, 1), date(2022, 6, 30))
EXAMPLE_POPULATION = "older adults, regular gait"

# ---- evidence: paraphrased from the sources, each opened and read before writing ---------------------------------
EVIDENCE = [
    {"key": "ravanelli2025",
     "cite": "Ravanelli N, Lefebvre K, Brough A, Paquette S, Lin W. Validation of an Open-Source Smartwatch for "
             "Continuous Monitoring of Physical Activity and Heart Rate in Adults. Sensors 2025;25(9):2926.",
     "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC12074211/",
     "text": "Validated the step counter of the Bangle.js 2, the watch whose firmware Drift replays, against a Fitbit "
             "Charge 5 (47 adults, 24 h free-living, plus a treadmill and stair session). A firmware update (V2.19) "
             "landed during data collection; the paper describes it as replacing the filter used for heart-beat "
             "detection, and two participants did the 24 h condition once before and once after it. The paper does "
             "not report a before/after comparison of step counts, so what that update did to steps is unmeasured. "
             "The Bangle.js 2 undercounted at every treadmill speed, heavily at slow ones (mean absolute percent error "
             "56.0% at 2 mph, 14.3% at 3, 14.6% at 4, 6.1% at 5 mph), so a near-zero bias measured on young adults "
             "walking at a normal pace does not carry over to slow or older walkers. The authors describe its step "
             "algorithm as a finite state machine."},
    # Woolley et al. 2019 is CC BY-NC: paraphrased here, with the source linked.
    {"key": "woolley2019",
     "cite": "Woolley SI, Collins T, Mitchell J, Fredericks D. Investigation of wearable health tracker version "
             "updates. BMJ Health Care Inform 2019;26(1):e100083.",
     "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC7062347/",
     "text": "Read the changelogs of six wrist-worn trackers (device models used in clinical-trial registrations): "
             "194 update items, 32% judged as possibly affecting device validation. Only the Polar changelog carried "
             "dates, and for that one the intervals between updates ranged from 5 to 218 days. Because devices can "
             "update during synchronisation, firmware changes can be applied in the middle of a study without the "
             "researchers noticing. The authors conclude that firmware updates can nullify device validations."},
    {"key": "collins2019",
     "cite": "Collins T, Woolley SI, Oniani S, Pires IM, Garcia NM, Ledger SJ, Pandyan A. Version Reporting and "
             "Assessment Approaches for New and Updated Activity and Heart Rate Monitors. Sensors 2019;19(7):1705.",
     "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC6480461/",
     "text": "Argues that validity is not maintained when firmware and software updates change device performance, "
             "that devices with the same model name but different versions are distinct devices, and that version "
             "numbers belong in the study report. As an illustration they note that one Garmin model went through "
             "14 versions in about 30 months. Their own experiment tested a single version, so it demonstrates the "
             "problem and a re-assessment method rather than measuring an update's effect."},
    {"key": "koffman2024",
     "cite": "Koffman L, Crainiceanu C, Muschelli J. Comparing Step Counting Algorithms for High-Resolution Wrist "
             "Accelerometry Data in NHANES 2011-2014. arXiv:2410.11040 (2024).",
     "url": "https://arxiv.org/abs/2410.11040",
     "text": "Ran five step-counting algorithms on the same NHANES wrist recordings. The estimates were correlated and "
             "predicted mortality about equally well, but the population mean daily step counts ranged from 2,453 "
             "to 12,169 and the hazard ratio for a 500-step increase ranged from 0.88 to 0.96. This is algorithm "
             "choice, not firmware version; it shows how far the same raw data can move when the step algorithm "
             "changes, which is the question Drift asks of each release."},
    {"key": "williams",
     "cite": "Williams G. step-count: offline test harness for the Espruino step counter (GitHub repository).",
     "url": "https://github.com/gfwilliams/step-count",
     "text": "The technique Drift builds on: a small C harness that runs Espruino's own step-counter code over "
             "recorded accelerometer files and prints the difference between the expected and the calculated "
             "count. Drift applies that idea to every released version of the code, adds the Clemson recordings, and "
             "turns the differences into dated, uncertainty-bounded shifts. Its recordings are used here by "
             "reference and are not redistributed."},
]


# ---- tiny block model rendered to Markdown and HTML -----------------------------------------------------------------
@dataclass
class Memo:
    title: str
    blocks: list
    markdown: str
    html: str
    facts: dict


def _inline_html(s: str) -> str:
    s = _html.escape(s, quote=False)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', s)
    return s


def _md_cell(s: str) -> str:
    return str(s).replace("|", "\\|")


def render_markdown(blocks: list) -> str:
    out: list[str] = []
    for b in blocks:
        kind = b[0]
        if kind == "h1":
            out.append(f"# {b[1]}")
        elif kind == "h2":
            out.append(f"## {b[1]}")
        elif kind == "meta":
            out.append(b[1])
        elif kind == "p":
            out.append(b[1])
        elif kind == "callout":
            out.append("\n".join(f"> {line}" if line else ">" for line in b[1].split("\n")))
        elif kind == "ul":
            out.append("\n".join(f"- {x}" for x in b[1]))
        elif kind == "ol":
            out.append("\n".join(f"{i}. {x}" for i, x in enumerate(b[1], 1)))
        elif kind == "table":
            header, rows = b[1], b[2]
            lines = ["| " + " | ".join(_md_cell(h) for h in header) + " |",
                     "|" + "|".join(" --- " for _ in header) + "|"]
            lines += ["| " + " | ".join(_md_cell(c) for c in r) + " |" for r in rows]
            out.append("\n".join(lines))
        elif kind == "small":
            out.append(b[1])
        else:
            raise ValueError(kind)
    return "\n\n".join(out) + "\n"


CSS = """
:root{--bg:#fbfaf7;--fg:#1c1b19;--muted:#6a675f;--rule:#dcd8cf;--accent:#8a3b12;--ok:#2d6a3e;--bad:#a1281e;--panel:#f1eee6}
@media (prefers-color-scheme:dark){:root{--bg:#171614;--fg:#ebe8e0;--muted:#a09b90;--rule:#38352f;--accent:#e0a37b;--ok:#7fc48f;--bad:#f08a80;--panel:#1f1e1b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.55 Georgia,"Iowan Old Style","Times New Roman",serif}
main{max-width:46rem;margin:0 auto;padding:2.5rem 1rem 4rem}
h1{font-size:1.9rem;line-height:1.2;margin:0 0 .4rem;letter-spacing:-.01em}
h2{font-size:1.2rem;margin:2.2rem 0 .6rem;padding-top:.8rem;border-top:1px solid var(--rule)}
p,ul,ol{margin:.7rem 0}
li{margin:.25rem 0}
.meta{color:var(--muted);font:.85rem/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0 0 1.4rem}
.callout{background:var(--panel);border-left:4px solid var(--accent);padding:.7rem 1rem;margin:1.2rem 0;border-radius:2px}
.callout p{margin:.45rem 0}
.tablewrap{overflow-x:auto;margin:1rem 0}
table{border-collapse:collapse;width:100%;font:.84rem/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid var(--rule);padding:.4rem .55rem;text-align:left;vertical-align:top}
th{font-weight:600;border-bottom:2px solid var(--fg)}
code{font:.85em ui-monospace,Consolas,monospace;background:var(--panel);padding:.05em .3em;border-radius:3px}
a{color:var(--accent)}
.small{color:var(--muted);font-size:.85rem}
.yes{color:var(--ok);font-weight:600}.no{color:var(--bad);font-weight:600}
@media print{body{background:#fff;color:#000;font-size:11pt}main{max-width:none;padding:0}a{color:#000}}
"""


def render_html(title: str, blocks: list, lang: str = "en") -> str:
    parts: list[str] = []
    for b in blocks:
        kind = b[0]
        if kind == "h1":
            parts.append(f"<h1>{_inline_html(b[1])}</h1>")
        elif kind == "h2":
            parts.append(f"<h2>{_inline_html(b[1])}</h2>")
        elif kind == "meta":
            parts.append(f'<p class="meta">{_inline_html(b[1])}</p>')
        elif kind == "p":
            parts.append(f"<p>{_inline_html(b[1])}</p>")
        elif kind == "small":
            parts.append(f'<p class="small">{_inline_html(b[1])}</p>')
        elif kind == "callout":
            inner = "".join(f"<p>{_inline_html(x)}</p>" for x in b[1].split("\n") if x)
            parts.append(f'<div class="callout">{inner}</div>')
        elif kind in ("ul", "ol"):
            parts.append(f"<{kind}>" + "".join(f"<li>{_inline_html(x)}</li>" for x in b[1]) + f"</{kind}>")
        elif kind == "table":
            head = "".join(f"<th>{_inline_html(h)}</th>" for h in b[1])
            body = "".join("<tr>" + "".join(f"<td>{_inline_html(c)}</td>" for c in r) + "</tr>" for r in b[2])
            parts.append(f'<div class="tablewrap"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>')
        else:
            raise ValueError(kind)
    body = "\n".join(parts)
    return (f'<!doctype html>\n<html lang="{lang}">\n<head>\n<meta charset="utf-8">\n'
            f'<meta name="viewport" content="width=device-width,initial-scale=1">\n'
            f"<title>{_html.escape(title)}</title>\n<style>{CSS}</style>\n</head>\n<body>\n<main>\n{body}\n</main>\n</body>\n</html>\n")


# ---- helpers ---------------------------------------------------------------------------------------------------------
def gait_from_population(text: str) -> str:
    """'older adults, regular gait' -> 'regular'; 'irregular' and 'semi' are checked first because they contain 'regular'."""
    t = text.lower()
    if "semi" in t:
        return "semiregular"
    if "irregular" in t:
        return "irregular"
    if "regular" in t:
        return "regular"
    return "all"


def _fmt_date(d: str | None) -> str:
    return d if d else "present"


def _pm(x: float, nd: int = 1) -> str:
    return f"{x:+.{nd}f}"


def _ci(ci, nd: int = 1) -> str:
    return f"[{ci[0]:+.{nd}f}, {ci[1]:+.{nd}f}]"


def live_generations(gens: list[dict], start: date, end: date) -> list[dict]:
    """Generations whose release interval [first_date, next generation's first_date) overlaps [start, end]."""
    out = []
    for g in gens:
        first = date.fromisoformat(g["first_date"])
        last = date.fromisoformat(g["last_date"]) if g["last_date"] else None
        if first <= end and (last is None or last > start):
            lo = max(first, start)
            hi = min(last - timedelta(days=1), end) if last else end
            out.append({**g, "days_in_window": (hi - lo).days + 1, "live_from": lo.isoformat(), "live_to": hi.isoformat()})
    return out


def _find_drift(metrics: dict, a: str, b: str, gait: str) -> dict:
    for d in metrics["drift"]:
        if d["from"] == a and d["to"] == b and d["gait"] == gait:
            return d
    raise KeyError((a, b, gait))


def _basis(d: dict, threshold: float) -> str:
    lo, hi = d["ci_pct"]
    if verdict((lo, hi), threshold):
        return f"CI inside ±{threshold:g}"
    if lo > 0 or hi < 0:
        return "shift differs from zero and the CI leaves the band"
    return f"point estimate is small but the CI is wider than ±{threshold:g}"


def _short(label: str) -> str:
    return label.split(" ")[0]


def _find_sens(metrics: dict, a: str, b: str, gait: str) -> dict | None:
    for d in (metrics.get("resampler_sensitivity") or {}).get("drift", []):
        if d["from"] == a and d["to"] == b and d["gait"] == gait:
            return d
    return None


def _find_native(metrics: dict, a: str, b: str) -> dict | None:
    for d in (metrics.get("native_walk_check") or {}).get("pairs", []):
        if d["from"] == a and d["to"] == b:
            return d
    return None


def native_within(nat: dict | None, threshold: float) -> bool | None:
    """Do the native Bangle.js walking recordings agree that the shift is small?  Mean AND median over the files must
    be within +-threshold points.  None = no native data."""
    if not nat:
        return None
    return bool(abs(nat["mean_pct"]) <= threshold and abs(nat["median_pct"]) <= threshold)


def overall_verdict(d: dict, nat: dict | None, threshold: float) -> str:
    """Clemson verdict conditioned on the native walking recordings.
    'comparable' only when BOTH say the mean shift is within +-threshold; a Clemson 'comparable' that the native
    recordings contradict is 'not confirmed'; everything else is 'not comparable'."""
    nw = native_within(nat, threshold)
    if d["comparable"] and nw is None:
        return "comparable on Clemson only (no native check)"
    if d["comparable"] and nw:
        return "comparable"
    if d["comparable"] and not nw:
        return "not confirmed (native walks disagree)"
    return "not comparable"


def _nat_cell(nat: dict | None) -> str:
    if not nat:
        return "-"
    return f"{_pm(nat['mean_pct'])} (median {_pm(nat['median_pct'])}; range {_pm(nat['min_pct'])} to {_pm(nat['max_pct'])})"


def _fp_phrase(fp: dict, live: list[dict]) -> tuple[str, float, float]:
    vals = {g["gen_id"]: fp[g["gen_id"]]["drive_train"]["fp_per_hour"] for g in live}
    one = fp[live[0]["gen_id"]]["drive_train"]
    wearers = one["wearers"]
    who = "one wearer" if len(wearers) == 1 else f"{len(wearers)} wearers"
    return (f"{one['n_files']} drive and train recordings from {who} ({', '.join(wearers)}; {one['hours']:.2f} h in total)",
            min(vals.values()), max(vals.values()))


# ---- the memo --------------------------------------------------------------------------------------------------------
def build_memo(metrics: dict, start: date, end: date, population: str = EXAMPLE_POPULATION, gait: str | None = None,
               threshold_pct: float = DEFAULT_THRESHOLD_PCT, memo_date: date | None = None,
               target_name: str = "espruino_stepcount", device: str = "Bangle.js (Espruino) step counter") -> Memo:
    memo_date = memo_date or generated_date()
    gait = gait or gait_from_population(population)
    if gait not in (*GAITS, "all"):
        raise ValueError(f"unknown gait type {gait!r}")
    if end < start:
        raise ValueError("window end is before its start")
    gname = GAIT_NAMES[gait]
    live = live_generations(metrics["generations"], start, end)
    if not live:
        raise ValueError("no firmware generation overlaps the study window")
    ids = [g["gen_id"] for g in live]
    ce, fp, sm = metrics["count_error"], metrics["false_positives"], metrics["step_match"]["results"]
    base = metrics["step_match"].get("baselines")
    cfg = metrics["config"]
    ctx = metrics.get("context", {})
    timing = metrics.get("step_timing") or {}
    native_all = metrics.get("native_walk_check") or {}
    sens = metrics.get("resampler_sensitivity") or {}
    window_txt = f"{start.isoformat()} to {end.isoformat()}"
    title = f"Data-validity memo: {device}, {window_txt}"
    nulls = {n["control"]: n["reference"] for n in metrics.get("null_controls", [])}

    pairs_all = [(live[i], live[j]) for i in range(len(live)) for j in range(i + 1, len(live))]
    cons = [(live[i], live[i + 1]) for i in range(len(live) - 1)]

    def D(a, b, k=None):
        return _find_drift(metrics, a["gen_id"], b["gen_id"], k or gait)

    def N(a, b):
        return _find_native(metrics, a["gen_id"], b["gen_id"])

    drifts = {(a["gen_id"], b["gen_id"]): D(a, b) for a, b in pairs_all}
    overall = {(a["gen_id"], b["gen_id"]): overall_verdict(drifts[(a["gen_id"], b["gen_id"])], N(a, b), threshold_pct)
               for a, b in pairs_all}
    cons_names = {k: f"{_short(a['label'])} → {_short(b['label'])}" for k, (a, b) in
                  {(a["gen_id"], b["gen_id"]): (a, b) for a, b in cons}.items()}
    cons_ov = {(a["gen_id"], b["gen_id"]): overall[(a["gen_id"], b["gen_id"])] for a, b in cons}
    n_ok = [k for k, v in cons_ov.items() if v == "comparable"]
    n_unconf = [k for k, v in cons_ov.items() if v.startswith("not confirmed")]
    n_bad = [k for k, v in cons_ov.items() if v == "not comparable"]
    n_clem_only = [k for k, v in cons_ov.items() if v.startswith("comparable on Clemson only")]
    big = max(cons, key=lambda ab: abs(drifts[(ab[0]["gen_id"], ab[1]["gen_id"])]["shift_pct"])) if cons else None
    fp_text, fp_lo, fp_hi = _fp_phrase(fp, live)
    live_fp = {g["gen_id"]: fp[g["gen_id"]]["drive_train"]["fp_per_hour"] for g in live}
    first_gen = metrics["generations"][0]
    covers_start = live[0]["gen_id"] == first_gen["gen_id"]

    # ---- bottom line
    bl = []
    if len(live) == 1:
        bl.append(f"One firmware generation ({_short(live[0]['label'])}) covers the whole window, so there is no "
                  f"within-window boundary to correct for.")
    else:
        bl.append(f"**{len(live)} different step-counting algorithms were live during this window** "
                  f"({', '.join(_short(g['label']) for g in live)}), with {len(cons)} "
                  f"{'boundary' if len(cons) == 1 else 'boundaries'}. Which one a participant's watch ran depends on when "
                  f"they updated, which is unknown unless the firmware version was logged."
                  + (f" Drift covers firmware from {_short(first_gen['label'])} on; anything older is not covered." if covers_start else ""))
        n_wide = sum(1 for k in cons_ov if drifts[k]["ci_pct"][0] < -threshold_pct or drifts[k]["ci_pct"][1] > threshold_pct)
        zero_in = [k for k in cons_ov if drifts[k]["ci_pct"][0] <= 0 <= drifts[k]["ci_pct"][1]]
        if len(zero_in) == len(cons):
            bl.append(f"For {gname} gait on the Clemson recordings the data cannot tell the generations apart on average: "
                      f"the 95% CI of the mean shift includes 0 at every adjacent boundary: "
                      + "; ".join(f"{cons_names[k]} {_ci(drifts[k]['ci_pct'])}" for k in cons_ov) + ". "
                      f"That is absence of evidence of a mean shift, not evidence that counts are interchangeable: the same "
                      f"intervals are too wide to rule out shifts larger than ±{threshold_pct:g} points at {n_wide} of {len(cons)} boundaries.")
        else:
            nz = [cons_names[k] for k in cons_ov if k not in zero_in]
            bl.append(f"For {gname} gait on the Clemson recordings the mean shift differs from zero (95% CI excludes 0) at: "
                      f"{'; '.join(nz)}.")
        parts = []
        if n_ok:
            parts.append("comparable: " + "; ".join(cons_names[k] for k in n_ok))
        if n_clem_only:
            parts.append("comparable on Clemson only (no native check): " + "; ".join(cons_names[k] for k in n_clem_only))
        if n_unconf:
            parts.append("not confirmed (the Clemson CI is inside ±" + f"{threshold_pct:g}"
                         + " points but the native Bangle.js walking recordings disagree): " + "; ".join(cons_names[k] for k in n_unconf))
        if n_bad:
            parts.append("not comparable: " + "; ".join(cons_names[k] for k in n_bad))
        bl.append(f"Verdict per adjacent boundary, after the native cross-check below: " + "; ".join(parts) + ". "
                  f"'Comparable' here means only that the mean paired shift is within ±{threshold_pct:g} points; individual "
                  f"participants' counts can still differ (section 3).")
        if big:
            d = drifts[(big[0]["gen_id"], big[1]["gen_id"])]
            bl.append(f"Largest point shift in walking count error for {gname} gait on Clemson: {_pm(d['shift_pct'])} points "
                      f"{_ci(d['ci_pct'])} at {_short(big[0]['label'])} → {_short(big[1]['label'])}.")
    if native_all and cons:
        # the boundary where the native walks and Clemson disagree most
        worst_n = max(cons, key=lambda ab: abs((N(*ab) or {"mean_pct": 0})["mean_pct"] - drifts[(ab[0]["gen_id"], ab[1]["gen_id"])]["shift_pct"]))
        nn, dd = N(*worst_n), drifts[(worst_n[0]["gen_id"], worst_n[1]["gen_id"])]
        bl.append(f"**The native Bangle.js walking recordings ({native_all['n_files']} files, {len(native_all['wearers'])} wearer) "
                  f"disagree with Clemson.** At {_short(worst_n[0]['label'])} → {_short(worst_n[1]['label'])} the Clemson "
                  f"mean shift is {_pm(dd['shift_pct'])} points but the native walks move by a mean of {_pm(nn['mean_pct'])} "
                  f"(range {_pm(nn['min_pct'])} to {_pm(nn['max_pct'])}). The transfer from the Clemson recordings "
                  f"(young adults, 15 Hz sensor resampled to 12.5 Hz) to Bangle.js data is **unvalidated**; treat the Clemson "
                  f"shifts as estimates for that cohort and resampler only.")
    if gait != "all" and cons:
        worst = max(((abs(_find_drift(metrics, a["gen_id"], b["gen_id"], k)["shift_pct"]), k, a, b)
                     for a, b in cons for k in GAITS if k != gait), default=None)
        if worst and worst[0] > 2 * threshold_pct:
            d = _find_drift(metrics, worst[2]["gen_id"], worst[3]["gen_id"], worst[1])
            bl.append(f"For other gait types the generations do differ clearly: {GAIT_NAMES[worst[1]]} gait shifts "
                      f"{_pm(d['shift_pct'])} points {_ci(d['ci_pct'])} at {_short(worst[2]['label'])} → "
                      f"{_short(worst[3]['label'])} (Clemson).")
    bl.append(f"Outside walking the generations differ in what they count: on {fp_text} they count between "
              f"{fp_lo:.0f} and {fp_hi:.0f} steps per hour above the expected total of each file. This rests on a handful of "
              f"files from one wearer and carries no confidence interval.")

    # ---- timeline
    tl_rows = []
    for gi, g in enumerate(live):
        nxt = next((x for x in metrics["generations"][[y["gen_id"] for y in metrics["generations"]].index(g["gen_id"]) + 1:][:1]), None)
        if g["last_date"] and nxt and nulls.get(nxt["gen_id"]) == g["gen_id"]:
            sup = f"{g['last_date']} (next code change; behaviourally identical on every recording)"
        else:
            sup = _fmt_date(g["last_date"])
        tl_rows.append([_short(g["label"]) if g["first_tag"] == g["last_tag"] else
                        f"{g['first_tag'].split('_')[-1].lower()} to {g['last_tag'].split('_')[-1].lower()}",
                        g["description"] or "-", g["first_date"], sup,
                        f"{g['days_in_window']} d", f"`{g['commit'][:8]}`" if g["blobs"] else "inline in jswrap_bangle.c"])

    # ---- bias
    def f1c(m):
        return f"{m['f1']:.2f} [{m['f1_ci'][0]:.2f}, {m['f1_ci'][1]:.2f}]"
    bias_rows = []
    for g in live:
        e = ce[g["gen_id"]][gait]
        m100, m250 = sm[g["gen_id"]][gait]["tol_100ms"], sm[g["gen_id"]][gait]["tol_250ms"]
        r100 = base["random_timing"][g["gen_id"]][gait]["tol_100ms"]["f1"] if base else float("nan")
        r250 = base["random_timing"][g["gen_id"]][gait]["tol_250ms"]["f1"] if base else float("nan")
        bias_rows.append([_short(g["label"]) if g["first_tag"] == g["last_tag"] else
                          f"{g['first_tag'].split('_')[-1].lower()} to {g['last_tag'].split('_')[-1].lower()}",
                          f"{_pm(e['mean_pct'])} {_ci(e['mean_ci_pct'])}",
                          f"{_pm(e['median_pct'])} ({_pm(e['q25_pct'])} to {_pm(e['q75_pct'])})",
                          f1c(m100), f1c(m250), f"{r100:.2f} / {r250:.2f}", f"{live_fp[g['gen_id']]:.0f}"])
    if base:
        o100, o250 = base["oracle_metronome"][gait]["tol_100ms"], base["oracle_metronome"][gait]["tol_250ms"]
        bias_rows.append(["Oracle metronome (not a firmware)", "-", "-", f1c(o100), f1c(o250), "-", "-"])

    # ---- shifts
    shift_rows, native_rows = [], []
    for a, b in pairs_all:
        d = drifts[(a["gen_id"], b["gen_id"])]
        s = _find_sens(metrics, a["gen_id"], b["gen_id"], gait)
        name = f"{_short(a['label'])} → {_short(b['label'])}"
        shift_rows.append([name, "yes" if (a, b) in cons else "no", f"{_pm(d['shift_pct'], 2)}", _ci(d["ci_pct"], 2),
                           f"{d['sd_pct']:.2f}", f"{d['n_beyond_threshold']} of {d['n']}", f"{d['max_abs_subject_change_pct']:.2f}",
                           (f"{_pm(s['shift_pct'], 2)} {_ci(s['ci_pct'], 2)}" if s else "-"),
                           ("**mean shift within ±%g**" % threshold_pct) if d["comparable"] else "mean shift not shown to be within ±%g" % threshold_pct,
                           _basis(d, threshold_pct)])
        nat = N(a, b)
        native_rows.append([name, "yes" if (a, b) in cons else "no", _nat_cell(nat),
                            f"{nat['n_files_beyond_threshold']} of {nat['n_files']}" if nat else "-",
                            f"{_pm(d['shift_pct'], 2)} {_ci(d['ci_pct'], 2)}", f"**{overall[(a['gen_id'], b['gen_id'])]}**"])
    other_rows = []
    for a, b in cons:
        row = [f"{_short(a['label'])} → {_short(b['label'])}"]
        for k in (*GAITS, "all"):
            d = _find_drift(metrics, a["gen_id"], b["gen_id"], k)
            row.append(f"{_pm(d['shift_pct'])} {_ci(d['ci_pct'])}" + ("" if d["comparable"] else " *"))
        other_rows.append(row)

    # resampler sensitivity paragraph
    sens_par = None
    if sens:
        flips = [(a, b) for a, b in pairs_all if (s := _find_sens(metrics, a["gen_id"], b["gen_id"], gait))
                 and s["comparable"] != drifts[(a["gen_id"], b["gen_id"])]["comparable"]]
        shifts_txt = "; ".join(
            f"{_short(a['label'])} → {_short(b['label'])} {_pm(drifts[(a['gen_id'], b['gen_id'])]['shift_pct'], 2)} "
            f"→ {_pm(s['shift_pct'], 2)} {_ci(s['ci_pct'], 2)}"
            for a, b in cons if (s := _find_sens(metrics, a["gen_id"], b["gen_id"], gait)))
        last = live[-1]["gen_id"]
        med_txt = "; ".join(
            f"{GAIT_NAMES[k]} {_short(live[-1]['label'])} median {_pm(sens['count_error'][last][k]['median_pct_base'])} → "
            f"{_pm(sens['count_error'][last][k]['median_pct'])}" for k in GAITS)
        sens_par = (f"**Resampler sensitivity.** The Clemson sensor runs at 15 Hz and the watch at 12.5 Hz, so every recording "
                    f"is resampled; Drift's default is a polyphase filter. Re-running with plain linear interpolation (same "
                    f"firmware, same recordings) changes the {gname} shift at the adjacent boundaries as follows ({sens['base']} "
                    f"→ {sens['alternative']}): {shifts_txt}. Median count errors of the newest live generation move too "
                    f"({med_txt}). The comparability verdict for {gname} gait changes at {len(flips)} of {len(pairs_all)} "
                    f"generation pairs. Count-error medians for the semi-regular and irregular gaits are resampler-sensitive "
                    f"and should not be quoted without this caveat.")

    pop_note = ""
    if ctx.get("clemson_age"):
        ca = ctx["clemson_age"]
        pop_note = (f" The calibration cohort is the Clemson Pedometer Evaluation Project: {ca['n']} adults aged "
                    f"{ca['min']} to {ca['max']} (median {ca['median']:g}), each walking a regular, a semi-regular and an "
                    f"irregular course with wrist, hip and ankle sensors and video-annotated steps. "
                    f"The requested population ('{population}') is not represented by an age-matched cohort, so treat "
                    f"the numbers as the best available proxy for gait type '{gname}', not as measurements of that population. "
                    f"An independent treadmill study of the Bangle.js 2 found heavy undercounting at slow speeds (see the "
                    f"Ravanelli et al. entry below), so the near-zero Regular-gait bias of young adults must not be read as "
                    f"applying to slow or older walkers.")
    timing_txt = ""
    if timing:
        tg = timing["by_gait"][gait if gait in GAITS else "regular"]
        w250 = tg["window_fraction_of_median_interval"]["tol_250ms"]
        w100 = tg["window_fraction_of_median_interval"]["tol_100ms"]
        timing_txt = (f" In {GAIT_NAMES[gait if gait in GAITS else 'regular']} gait the median interval between annotated steps is "
                      f"{tg['median_step_interval_s']:.2f} s, so a ±250 ms window spans {100 * w250:.0f}% of it "
                      f"and a ±100 ms window {100 * w100:.0f}%. A wide window barely separates a step detector from "
                      f"guessing: the table therefore also shows the F1 of the same number of detections at random times and "
                      f"of an oracle metronome (the file's own mean cadence at the best phase, no sensor data). Read the F1 "
                      f"columns against those two rows, and prefer ±100 ms.")
    ex = metrics.get("count_error_excluding_shift_steps") or {}
    shift_txt = ""
    if ex:
        last = live[-1]["gen_id"]
        gk = gait if gait in GAITS else "regular"
        shift_txt = (f" {100 * ex['fraction_shift_steps']:.1f}% of the annotated Clemson steps are weight-shift steps "
                     f"('leftshift'/'rightshift') and are counted as true steps; removing them from the truth moves the "
                     f"{GAIT_NAMES[gk]} median error of {_short(live[-1]['label'])} from {_pm(ce[last][gk]['median_pct'])} to "
                     f"{_pm(ex['count_error'][last][gk]['median_pct'])} (full table in the results JSON).")
    fp_desc = metrics["false_positives"][live[0]["gen_id"]]["drive_train"]
    fp_files = ", ".join(f"{f['rec_id']} ({f['steps_true']} expected)" for f in metrics["false_positives"][live[0]["gen_id"]]["files"]
                         if f["kind"] in ("drive", "train"))

    blocks: list = [
        ("h1", title),
        ("meta", f"Prepared {memo_date.isoformat()} · Drift {__version__} · target `{target_name}` · population: {population} · "
                 f"gait type used: {gname} · comparability threshold ±{threshold_pct:g} percentage points"),
        ("callout", "**Bottom line**\n" + "\n".join(bl)),
        ("h2", "1. Which firmware was live"),
        ("p", "Each row is a distinct step-counting algorithm, found by comparing the git blob of the algorithm source at "
              "every release tag. Dates are the commit dates of the release tags. A watch only runs a version after its owner "
              "installs it, and owners update on their own schedule, so the real switch date of any participant is later than "
              "the tag date and is unknown unless the firmware version was logged. Firmware older than 2v09 is not covered."),
        ("table", ["Release tags", "What the algorithm does", "Released", "Superseded", "Days in window", "Source"], tl_rows),
        ("h2", f"2. Expected bias of each generation ({gname} gait)"),
        ("p", f"Count error is (counted − true) / true, in percent, per Clemson subject and gait type (n = {len(cfg['subjects'])} "
              f"subjects). Positive means over-counting. The step-level F1 matches each detected step to a video-annotated step within "
              f"±100 ms or ±250 ms after aligning the two event trains by a constant (estimated on the other half of the subjects; "
              f"it is a phase, not a device latency, see section 6). Steps per hour is the count above the expected total on "
              f"{fp_text}: {fp_files}." + timing_txt + pop_note + shift_txt),
        ("table", ["Generation", "Mean error, % [95% CI]", "Median error, % (IQR)",
                   f"Step F1 at ±100 ms [95% CI], {len(cfg['test_subjects'])} test subjects",
                   f"Step F1 at ±250 ms [95% CI]", "F1 of the same number of detections at random times (±100 / ±250 ms)",
                   "Steps/h while driving or on a train"], bias_rows),
        ("h2", "3. Shift between generations and comparability"),
        ("p", f"The shift is the mean over subjects of the paired difference in count error (later minus earlier generation), in "
              f"percentage points of the true count, with a 95% bootstrap CI over subjects ({cfg['n_boot']:,} resamples, seed {cfg['seed']}). "
              f"**'Mean shift within ±{threshold_pct:g}' means only that the whole CI of the MEAN shift lies within ±{threshold_pct:g} "
              f"points.** It does not mean that individual counts agree: the table also gives the SD of the per-subject changes, "
              f"how many subjects move by more than ±{threshold_pct:g} points, and the largest single change. Anything else is "
              f"'not shown to be within', including the case where the estimate is small but the CI is too wide to show it."),
        ("table", ["Generation pair", "Adjacent", "Mean shift, points", "95% CI", "SD of per-subject changes",
                   f"Subjects changing by more than ±{threshold_pct:g}", "Largest single change",
                   f"Mean shift with linear resampling [95% CI]", "Clemson verdict", "Basis"], shift_rows),
    ]
    if sens_par:
        blocks.append(("p", sens_par))
    blocks += [
        ("p", f"**Cross-check on the native Bangle.js walking recordings.** The only data that went through the firmware "
              f"exactly as recorded are the {native_all.get('n_files', 0)} labelled walking files "
              f"({', '.join(native_all.get('wearers', []))}, one wearer, 12.5 Hz, no resampling). Per-file shift = error after minus "
              f"error before, in points of the file's expected total (no CI: six files, one wearer). The overall verdict is "
              f"'comparable' only when both the Clemson CI and the native walks (mean and median) are within ±{threshold_pct:g}."),
        ("table", ["Generation pair", "Adjacent", "Native walks: mean (median; range)", f"Files moving by more than ±{threshold_pct:g}",
                   "Clemson mean shift [95% CI]", "Overall verdict"], native_rows),
        ("p", f"Same adjacent boundaries for the other gait types on Clemson (shift in points with 95% CI; * = mean shift not shown "
              f"to be within ±{threshold_pct:g}):"),
        ("table", ["Boundary", *[GAIT_NAMES[k] for k in (*GAITS, "all")]], other_rows),
        ("p", f"Multiplicity and margin: {len(pairs_all)} generation pairs × 4 gait types are examined here without correction for "
              f"multiple comparisons, and the ±{threshold_pct:g}-point margin is a convention, not derived from any study's "
              f"tolerance. The percentile bootstrap intervals are a few percent narrower than t-intervals at n = {len(cfg['subjects'])} "
              f"(the t-interval of every shift is in the results JSON as ci_t_pct), so a verdict close to the margin is fragile."),
        ("h2", "4. Recommendations"),
        ("ul", [
            "**Record the firmware version of every participant's device at every sync**, not the model name alone. "
            "Without it, the table above cannot be applied to your data.",
            "**Stratify by generation** in any analysis that spans a boundary that is not established as comparable, or include "
            "generation as a covariate; do not pool pre- and post-boundary counts as one measurement.",
            "**Where raw acceleration exists, re-derive steps with one fixed algorithm version.** Drift can replay every "
            "participant's raw data through a single generation (python -m drift replay), which removes the firmware effect "
            "instead of modelling it.",
            "**Treat non-walking time separately.** On the few non-walking recordings available the generations differ in what "
            "they count while the wearer is not walking. Drift has not computed daily totals, so how much this changes a "
            "participant's day is not measured here.",
            "**Report the version in the paper.** The sources below show that unreported version changes are a known threat to validity.",
        ]),
        ("h2", "5. Why this matters: evidence"),
        ("ul", [f"**{e['cite']}** {e['text']} [Source]({e['url']})" for e in EVIDENCE]),
        ("h2", "6. Method and limits"),
        ("ul", [
            "Differential execution: the step-counter source of each generation is compiled for the host and every recording is "
            "replayed through all of them, identical input each time. Null controls: generations that differ from 2v12–2v21 only "
            "cosmetically (2v22–2v28) or by an unreachable clamp fix (2v29) produce identical counts and step events on all "
            f"{metrics['null_controls'][0]['recordings'] if metrics['null_controls'] else 'n/a'} recordings, as the tests assert.",
            "Only the step-counting function is replayed. Changes to the sensor driver, sampling or device settings would not show up here.",
            "Clemson data (15 Hz, g) is resampled to the device's 12.5 Hz, 8192 counts per g; the results depend on the resampler "
            "(section 3). The Clemson wrist sensor recorded raw acceleration only between −2 and +2 g (Mattfeld et al. 2021), so "
            "strong peaks are clipped; the Bangle.js counter works on a wider range (int16 at 8192 counts per g, about ±4 g). "
            "Part of the Irregular and SemiRegular error may reflect that and the resampling rather than the algorithms. "
            "Clemson's ground truth is video-annotated steps, including weight-shift steps. The data files carry no header or "
            "documentation: that the first three of the nine columns are the wrist sensor is an assumption (the paper lists "
            "wrist, hip and ankle; the ankle triple is clearly the most energetic in all 90 files, but wrist and hip cannot be "
            "told apart by amplitude).",
            "The Bangle.js recordings' ground truth is a per-file expected total taken from the file name and upstream main.c; "
            "how those totals were produced is not documented in the repository. Most files come from one wearer.",
            "The Clemson subjects are a small cohort of young adults; CIs reflect between-subject variation only, not population "
            "mismatch. The Clemson-to-Bangle.js transfer is unvalidated: the native walking files disagree (section 3).",
            "The per-step alignment value is the maximum of a cross-correlation estimated on the even-numbered subjects and "
            "applied to the odd-numbered ones. Gait is periodic, so it is identified only modulo the step period (~0.5 to 0.6 s): it is "
            "a phase for aligning the event trains, not a device latency, and it is published only for transparency. The CIs for step "
            f"metrics use the {len(cfg['test_subjects'])} test subjects.",
            "'All gaits' means different things for different columns: for count error it is the equal-weight mean of a subject's three "
            "per-gait errors (dominated by the Irregular gait); for step matching it pools the step counts of the three gaits.",
            "The plain-language description of each generation is written by Claude from the code diff.",
        ]),
        ("h2", "7. Data sources and citations"),
        ("ul", [
            "**Clemson Pedometer Evaluation Project** (30 subjects × 3 gaits, 15 Hz, video-annotated steps): Mattfeld R, Jesch E, "
            "Hoover A. A new dataset for evaluating pedometer performance. IEEE International Conference on Bioinformatics and "
            "Biomedicine (BIBM) 2017:865-869; Mattfeld R, Jesch E, Hoover A. Evaluating Pedometer Algorithms on Semi-Regular and "
            "Unstructured Gaits. Sensors 2021;21(13):4260, doi:10.3390/s21134260. Data page: "
            "[cecas.clemson.edu/~ahoover/pedometer](https://cecas.clemson.edu/~ahoover/pedometer/). The page states no licence; "
            "the data is fetched from there and not redistributed.",
            "**Bangle.js step-count harness and recordings**: Gordon Williams, [gfwilliams/step-count](https://github.com/gfwilliams/step-count) "
            "(no licence stated; referenced at a pinned commit, not redistributed). The recordings were contributed by Espruino forum "
            "users (HughB, cartron, d3nd3-o0, Pablo, Guillaume_G, MrPloppy) for calibrating the step counter, in the threads "
            "[Better Pedometer - HELP NEEDED!](http://web.archive.org/web/20241221151609/https://forum.espruino.com/conversations/359542/) and "
            "[Pebble vs Bangle](http://web.archive.org/web/20241221145916/https://forum.espruino.com/conversations/371740/) "
            "(Wayback copies; the live URLs now redirect to the Espruino GitHub discussions).",
            "**Espruino firmware** (MPL-2.0): [espruino/Espruino](https://github.com/espruino/Espruino), fetched at the pinned release tags and compiled locally.",
        ]),
        ("small", f"Reproduce: python -m drift memo --target {target_name} --start {start.isoformat()} --end {end.isoformat()} "
                  f'--population "{population}" · python -m drift all runs the whole pipeline from a clean cache. '
                  f"Algorithm commits: " + ", ".join(f"{_short(g['label'])} {g['commit'][:8]}" for g in live if g["blobs"]) + "."),
    ]
    md = render_markdown(blocks)
    htm = render_html(title, blocks)
    facts = {"generations_live": ids, "gait": gait, "n_boundaries": len(cons),
             "n_not_comparable": len(n_bad), "n_not_confirmed": len(n_unconf), "n_comparable": len(n_ok),
             "overall_verdicts": {cons_names[k]: v for k, v in cons_ov.items()},
             "threshold_pct": threshold_pct, "window": [start.isoformat(), end.isoformat()], "date": memo_date.isoformat()}
    return Memo(title=title, blocks=blocks, markdown=md, html=htm, facts=facts)
