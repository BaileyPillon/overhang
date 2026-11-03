"""Recordings: one dataclass plus loaders/adapters for the public datasets Drift replays.

Native units are kept in Recording.data; a Target.adapt() converts to the device's native input.
Loaders read from the fetch cache (drift.fetch), never from the repo.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path

import numpy as np

COUNTS_PER_G = 8192          # Bangle.js accelerometer scale: 8192 counts = 1 g
BANGLE_RATE_HZ = 12.5
CLEMSON_RATE_HZ = 15.0


@dataclass
class Recording:
    rec_id: str
    source: str                 # "bangle-step-count" | "clemson" | ...
    subject: str | None
    kind: str                   # walk / regular / semiregular / irregular / drive / train / static / mixed / unlabelled / hr
    rate_hz: float
    data: np.ndarray            # native units of the source; (n, 3) wrist acceleration for the step datasets
    truth: dict = field(default_factory=dict)   # {"steps_total": int} and/or {"step_times_s": ndarray} and/or {"hr_bpm": (t, bpm)}
    unit: str = "g"             # "g" or "counts" (8192 = 1 g)
    meta: dict = field(default_factory=dict)

    @property
    def n(self) -> int:
        return int(self.data.shape[0])

    @property
    def duration_s(self) -> float:
        return self.n / self.rate_hz


# --------------------------------------------------------------------------------------------------------------
# resampling
# --------------------------------------------------------------------------------------------------------------
def resample(x: np.ndarray, rate_in: float, rate_out: float, method: str = "poly") -> np.ndarray:
    """Resample (n, ...) along axis 0 from rate_in to rate_out; output sample j sits at t = j / rate_out, so the
    first sample stays aligned at t = 0 and no time shift is introduced.

    method="poly":   scipy.signal.resample_poly with the exact rational ratio (15 -> 12.5 Hz is 5/6), zero-phase
                     Kaiser anti-alias FIR, edges extended by a straight line (padtype="line") so the ~1 g DC
                     offset does not create an edge transient.  Drift's default; documented in the results.
    method="linear": np.interp at the new sample times (no anti-aliasing; kept for sensitivity checks).
    """
    x = np.asarray(x, dtype=np.float64)
    if rate_in == rate_out:
        return x.copy()
    if method == "linear":
        t_in = np.arange(x.shape[0]) / rate_in
        n_out = int(math.ceil(x.shape[0] * rate_out / rate_in))
        t_out = np.arange(n_out) / rate_out
        t_out = t_out[t_out <= t_in[-1]]
        flat = x.reshape(x.shape[0], -1)
        out = np.stack([np.interp(t_out, t_in, flat[:, k]) for k in range(flat.shape[1])], axis=1)
        return out.reshape((len(t_out),) + x.shape[1:])
    if method != "poly":
        raise ValueError(f"unknown resample method {method!r}")
    from scipy.signal import resample_poly
    ratio = Fraction(rate_out).limit_denominator(1000) / Fraction(rate_in).limit_denominator(1000)
    return resample_poly(x, ratio.numerator, ratio.denominator, axis=0, padtype="line")


def g_to_counts(a_g: np.ndarray) -> np.ndarray:
    """g -> int16 Bangle counts (8192 = 1 g), rounded, saturated to the int16 range."""
    return np.clip(np.rint(np.asarray(a_g, dtype=np.float64) * COUNTS_PER_G), -32768, 32767).astype(np.int16)


# --------------------------------------------------------------------------------------------------------------
# Bangle.js step-count recordings (gfwilliams/step-count @ d4b015c)
# --------------------------------------------------------------------------------------------------------------
# Ground truth is a per-file expected step total taken from the file name / upstream main.c EXPECTED_STEPS.  How the
# totals were produced is not documented in the step-count repository (presumably counted by hand).  In
# "aN-bM" names the code uses N; the meaning of M is undocumented.  Files without a number are unlabelled.
_BANGLE_TRUTH: dict[str, tuple[int | None, str]] = {
    "HughB-walk-6605": (6605, "walk"),
    "HughB-walk-2350": (2350, "walk"),
    "HughB-walk-a3070-b3046": (3070, "walk"),
    "HughB-walk-a10021-b10248": (10021, "walk"),
    "HughB-walk-1834": (1834, "walk"),
    "HughB-walk-2331": (2331, "walk"),
    "HughB-drive-36min-0": (0, "drive"),
    "HughB-drive-29min-0": (0, "drive"),
    "HughB-drive-a3-b136": (3, "drive"),
    "HughB-drive-18": (18, "drive"),
    "0_HughB_train_journey_b31": (0, "train"),
    "HughB-work-66": (66, "mixed"),
    "HughB-work-0": (0, "mixed"),
    "HughB-mixed-390": (390, "mixed"),
    "HughB-general-a260-b573": (260, "mixed"),
    "HughB-housework-a958-b2658": (958, "mixed"),
    "MrPloppy-stationary-0": (0, "static"),
    "HughB-nosteps1": (0, "static"),
    "HughB-nosteps2": (0, "static"),
    "HughB-nosteps3": (0, "static"),
    "HughB-static-0": (0, "static"),
}


def _bangle_subject(stem: str) -> str | None:
    m = re.search(r"(HughB|MrPloppy|Guillaume_G|Pablo|cartron|d3nd3-o0)", stem)
    return m.group(1) if m else None


def load_bangle_file(path: Path) -> Recording:
    path = Path(path)
    stem = path.stem
    raw = np.loadtxt(path, delimiter=",", skiprows=1, usecols=(0, 1, 2, 3), dtype=np.int64)
    t_ms, xyz = raw[:, 0], raw[:, 1:4]
    if np.abs(xyz).max() > 32767:
        raise ValueError(f"{path.name}: sample outside int16 range")
    truth_n, kind = _BANGLE_TRUTH.get(stem, (None, "unlabelled"))
    truth = {} if truth_n is None else {"steps_total": int(truth_n)}
    return Recording(
        rec_id=stem, source="bangle-step-count", subject=_bangle_subject(stem), kind=kind,
        rate_hz=BANGLE_RATE_HZ, data=np.ascontiguousarray(xyz.astype(np.int16)), truth=truth, unit="counts",
        meta={"file": path.name, "median_dt_ms": float(np.median(np.diff(t_ms))),
              # timestamp span of the file, in seconds: (last - first) + one sample interval.  Samples are occasionally
              # dropped, so this is 0.1 to 1.2% longer than n / 12.5; per-hour rates use it.
              "span_s": float((t_ms[-1] - t_ms[0]) / 1000.0 + 1.0 / BANGLE_RATE_HZ),
              "truth_is_manual_count": True},
    )


def load_bangle(data_dir: Path) -> list[Recording]:
    files = sorted(Path(data_dir).glob("*.csv"), key=lambda p: p.name.lower())
    if not files:
        raise FileNotFoundError(f"no Bangle CSVs in {data_dir} (run: python -m drift fetch)")
    return [load_bangle_file(p) for p in files]


# --------------------------------------------------------------------------------------------------------------
# Clemson Pedometer Evaluation Project (Data.zip): wrist accel at 15 Hz in g, video-annotated steps
# --------------------------------------------------------------------------------------------------------------
GAITS = {"Regular": "regular", "SemiRegular": "semiregular", "Irregular": "irregular"}


def load_clemson_recording(rec_dir: Path) -> Recording:
    """rec_dir = Data/Pxxx/<Gait>.  Columns of the data file: wrist xyz, hip xyz, ankle xyz (all in g); only the
    wrist triple is used.  steps.txt holds '<row index> <left|right|leftshift|rightshift>' per annotated step;
    the index is a row of the 15 Hz data file (treated as 0-based, t = index / 15 s; a +-1 row (67 ms) offset in
    that convention is far below the matching tolerance and is absorbed by the per-generation latency estimate).

    Out-of-range indices (a step annotated after the data file ends: 1 step each in P010_Regular and
    P019_Irregular) are clipped away: a step the sensor never recorded cannot be counted, so it is removed from the
    truth for that window instead of being stacked at the last sample.  truth["steps_annotated"] keeps the raw
    count and truth["n_clipped"] says how many were removed.
    """
    rec_dir = Path(rec_dir)
    gait = rec_dir.name
    pid = rec_dir.parent.name
    data_file = rec_dir / f"{pid}_{gait}.txt"
    a = np.loadtxt(data_file, dtype=np.float64)
    if a.ndim != 2 or a.shape[1] != 9:
        raise ValueError(f"{data_file}: expected 9 columns, got {a.shape}")
    wrist = np.ascontiguousarray(a[:, 0:3])
    idx, side = [], []
    for line in (rec_dir / "steps.txt").read_text().splitlines():
        parts = line.split()
        if len(parts) == 2:
            idx.append(int(parts[0]))
            side.append(parts[1])
    idx = np.asarray(idx, dtype=np.int64)
    side = np.asarray(side)
    keep = (idx >= 0) & (idx <= wrist.shape[0] - 1)
    n_clipped = int((~keep).sum())
    idx, side = idx[keep], side[keep]
    order = np.argsort(idx, kind="stable")
    idx, side = idx[order], side[order]
    return Recording(
        rec_id=f"{pid}_{gait}", source="clemson", subject=pid, kind=GAITS.get(gait, gait.lower()),
        rate_hz=CLEMSON_RATE_HZ, data=wrist,
        truth={"steps_total": int(len(idx)), "step_times_s": idx / CLEMSON_RATE_HZ,
               "steps_annotated": int(len(idx)) + n_clipped, "n_clipped": n_clipped},
        unit="g", meta={"step_side": side, "gait": gait},
    )


def load_clemson(data_dir: Path) -> list[Recording]:
    """data_dir = the extracted 'Data' folder (Pxxx/<Gait>/...)."""
    dirs = sorted(d for d in Path(data_dir).glob("P*/*") if (d / "steps.txt").exists())
    if not dirs:
        raise FileNotFoundError(f"no Clemson recordings in {data_dir} (run: python -m drift fetch)")
    return [load_clemson_recording(d) for d in dirs]


# --------------------------------------------------------------------------------------------------------------
# adapter shared by the Bangle step targets
# --------------------------------------------------------------------------------------------------------------
def to_bangle_native(rec: Recording, method: str = "poly") -> np.ndarray:
    """Recording -> int16 (n, 3) at 12.5 Hz, 8192 counts = 1 g (the input of Espruino stepcount).

    Bangle recordings pass through untouched; g-unit recordings (Clemson, 15 Hz) are resampled to 12.5 Hz
    (polyphase 5/6, see resample()), scaled by 8192 and saturated to int16.
    """
    if rec.unit == "counts":
        if rec.rate_hz != BANGLE_RATE_HZ:
            y = resample(rec.data.astype(np.float64), rec.rate_hz, BANGLE_RATE_HZ, method)
            return np.ascontiguousarray(np.clip(np.rint(y), -32768, 32767).astype(np.int16))
        return np.ascontiguousarray(rec.data.astype(np.int16))
    if rec.unit == "g":
        y = resample(rec.data, rec.rate_hz, BANGLE_RATE_HZ, method)
        return np.ascontiguousarray(g_to_counts(y))
    raise ValueError(f"unknown unit {rec.unit!r}")
