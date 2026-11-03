"""Heart-rate recordings and the adapter from public PPG data to HRS3300-like counts.

Sources (fetched by drift.fetch.ppg into the cache, never committed):
  * PhysioNet "Wrist PPG During Exercise" v1.0.0 (ODC-By): Shimmer3 wrist PPG, 256 Hz, int16 ADC, with
    hand-annotated ECG R-peaks -> ground-truth HR.  8 subjects, 19 records (walk / run / low and high resistance bike).
  * Six real PineTime 1.14 recordings (10 Hz HRS3300 counts, window snapshots read over BLE): no ground truth.

SCALING ASSUMPTIONS (the HRS3300 is not the Shimmer sensor; the numbers below are choices, not measurements of
the device, and the results JSON reports a sensitivity run over the AC amplitude):
  1. anti-aliased polyphase resampling (scipy resample_poly, Kaiser FIR, edges extended linearly) from 256 Hz to the
     generation's native rate: 24 Hz (gen A, 3/32) or 10 Hz (gen B, 5/128);
  2. the AC amplitude is set so the robust sigma (1.4826 * MAD) of the 0.5-4 Hz band-passed signal equals ac_std
     counts (default 25; the six real PineTime recordings span 10-66 counts of AC sigma at 40 mA);
  3. the slowly varying baseline is kept, offset so the median is dc counts (default 3600, the DC level of the
     real 1.14 recordings in 15-bit mode);
  4. round to integers and clip to the 15-bit range 0..32767 (HRS3300 conversion, as recorded by 1.14).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from drift import CACHE_DIR
from drift.recordings import Recording, resample

WRIST_RATE_HZ = 256.0
WINDOW_S = 10.0           # truth/evaluation window; >= one gen-A emission period (200 samples / 24 Hz = 8.33 s)
FORK_RATE_HZ = 10.0
HRS_MAX = 32767           # 15-bit HRS3300 conversion as configured by InfiniTime 1.13+

_KIND = {"walk": "walk", "run": "run", "low_resistance_bike": "bike_low", "high_resistance_bike": "bike_high"}


# --------------------------------------------------------------------------------------------------------------
# WFDB (just enough of it: format-16 interleaved .dat, .hea signal names, .atr beat annotations)
# --------------------------------------------------------------------------------------------------------------
def read_header(path: Path) -> dict:
    lines = [l for l in Path(path).read_text().splitlines() if l.strip() and not l.startswith("#")]
    name, nsig, fs, nsamp = lines[0].split()[:4]
    names = [ln.split()[-1] for ln in lines[1:1 + int(nsig)]]
    return {"record": name, "nsig": int(nsig), "fs": float(fs), "nsamp": int(nsamp), "signals": names}


def read_beats(path: Path) -> np.ndarray:
    """Sample indices of beat annotations (code 1) in a WFDB .atr file.  A SKIP (59) carries a signed 32-bit time
    increment in the next two words; NOTE/AUX (22/63) annotations carry text and no time of their own."""
    w = np.fromfile(path, dtype="<u2")
    i, t, beats = 0, 0, []
    while i < len(w):
        x = int(w[i])
        i += 1
        if x == 0:
            break
        code, dt = x >> 10, x & 1023
        if code == 59:
            skip = (int(w[i]) << 16) | int(w[i + 1])
            i += 2
            t += skip - (1 << 32) if skip >= (1 << 31) else skip
            continue
        if code == 63:
            i += (dt + 1) // 2
            continue
        if code in (60, 61, 62):
            continue
        t += dt
        if code == 1:
            beats.append(t)
    return np.asarray(beats, dtype=np.int64)


def window_hr(beat_times_s: np.ndarray, duration_s: float, window_s: float = WINDOW_S) -> tuple[np.ndarray, np.ndarray]:
    """ECG heart rate per non-overlapping window [k*W, (k+1)*W): 60 / mean RR over the beats inside the window;
    NaN when the window holds fewer than 3 beats.  Returns (window end times in s, bpm)."""
    n = int(duration_s // window_s)
    t_end = (np.arange(n) + 1) * window_s
    bpm = np.full(n, np.nan)
    for k in range(n):
        b = beat_times_s[(beat_times_s >= k * window_s) & (beat_times_s < (k + 1) * window_s)]
        if len(b) >= 3:
            bpm[k] = 60.0 / float(np.mean(np.diff(b)))
    return t_end, bpm


def wrist_dir(cache: Path) -> Path:
    from drift.fetch import ppg
    return ppg.wrist_dir(cache)


def load_wrist_record(base: Path, rec: str) -> Recording:
    hdr = read_header(base / f"{rec}.hea")
    if hdr["fs"] != WRIST_RATE_HZ or hdr["nsig"] != 15:
        raise ValueError(f"{rec}: unexpected header {hdr}")
    col = hdr["signals"].index("wrist_ppg")
    raw = np.fromfile(base / f"{rec}.dat", dtype="<i2")
    if raw.size != hdr["nsamp"] * hdr["nsig"]:
        raise ValueError(f"{rec}.dat has {raw.size} values, header says {hdr['nsamp'] * hdr['nsig']}")
    ppg = raw.reshape(-1, hdr["nsig"])[:, col].astype(np.float64)
    beats = read_beats(base / f"{rec}.atr") / WRIST_RATE_HZ
    t_end, bpm = window_hr(beats, len(ppg) / WRIST_RATE_HZ)
    subject, _, activity = rec.partition("_")
    return Recording(
        rec_id=rec, source="physionet-wrist", subject=subject, kind=_KIND[activity], rate_hz=WRIST_RATE_HZ, data=ppg,
        truth={"hr_bpm": (t_end, bpm), "beat_times_s": beats, "window_s": WINDOW_S},
        unit="adc", meta={"activity": activity, "n_beats": int(len(beats)), "n_adc_clipped": int((np.abs(ppg) >= 32767).sum())},
    )


def load_wrist(cache: Path = CACHE_DIR) -> list[Recording]:
    base = wrist_dir(cache)
    recs = [p.stem for p in sorted(base.glob("*.hea"))]
    if not recs:
        raise FileNotFoundError(f"no PhysioNet wrist records in {base} (run: python -m drift fetch --target infinitime_hr)")
    return [load_wrist_record(base, r) for r in recs]


# --------------------------------------------------------------------------------------------------------------
# six real PineTime 1.14 recordings (BLE snapshots of the dataHRS[64] window, ~1.07 s apart)
# --------------------------------------------------------------------------------------------------------------
def stitch_windows(rows: list[list[int]], min_match: int = 20, min_frac: float = 0.8) -> tuple[list[int], int]:
    """Rebuild a continuous stream from overlapping sliding-window snapshots: each new row repeats the previous row
    shifted left by k samples (1 <= k <= 32); append only the k new samples.  When no shift matches, the whole row is
    appended and counted as a gap.  Returns (stream, number of gaps)."""
    stream = list(rows[0])
    gaps = 0
    for prev, cur in zip(rows, rows[1:]):
        best_k, best_m = None, 0
        for k in range(1, 33):
            m = sum(1 for a, b in zip(prev[k:], cur[:64 - k]) if a == b)
            if m > best_m:
                best_k, best_m = k, m
        if best_k and best_m >= min_match and best_m >= (64 - best_k) * min_frac:
            stream += cur[64 - best_k:]
        else:
            stream += cur
            gaps += 1
    return stream, gaps


def load_fork(cache: Path = CACHE_DIR) -> list[Recording]:
    from drift.fetch import ppg
    base = ppg.fork_dir(cache)
    files = sorted(base.glob("*_data.csv"))
    if not files:
        raise FileNotFoundError(f"no PineTime recordings in {base} (run: python -m drift fetch --target infinitime_hr)")
    out = []
    for f in files:
        stamp = f.name.split("_")[0]
        rows = [[int(v) for v in line.strip().split(",") if v] for line in f.read_text().splitlines() if line.strip()]
        rows = [r for r in rows if len(r) == 64]
        stream, gaps = stitch_windows(rows)
        meta_file = base / f"{stamp}_metadatadata.json"
        meta = json.loads(meta_file.read_text()) if meta_file.exists() else {}
        tfile = base / f"{stamp}_time.csv"
        row_dt = None
        if tfile.exists():
            ts = np.array([float(v) for v in tfile.read_text().split() if v.strip()])
            row_dt = float(np.median(np.diff(ts))) if len(ts) > 1 else None
        out.append(Recording(
            rec_id=f"pinetime-{stamp}", source="infinitime-fork-ppg", subject=None, kind="hr_nogt", rate_hz=FORK_RATE_HZ,
            data=np.asarray(stream, dtype=np.int32), truth={}, unit="counts",
            meta={"firmware": meta.get("infinitime_version"), "led_current_mA": meta.get("led_current_mA"),
                  "delay_ms": meta.get("delay_ms"), "activity": meta.get("description"), "n_rows": len(rows),
                  "stitch_gaps": gaps, "median_row_dt_s": row_dt}))
    return out


# --------------------------------------------------------------------------------------------------------------
# adapter
# --------------------------------------------------------------------------------------------------------------
def robust_ac_sigma(x: np.ndarray, rate: float, band: tuple[float, float] = (0.5, 4.0)) -> float:
    """1.4826 * MAD of the zero-phase band-passed signal: the AC amplitude without the motion-artifact outliers."""
    from scipy.signal import butter, sosfiltfilt
    sos = butter(2, [band[0] / (rate / 2), band[1] / (rate / 2)], btype="band", output="sos")
    y = sosfiltfilt(sos, x)
    return float(1.4826 * np.median(np.abs(y - np.median(y))))


def to_hrs_counts(rec: Recording, rate_out: float, ac_std: float = 25.0, dc: float = 3600.0) -> np.ndarray:
    """Recording -> int32 HRS3300-like counts at rate_out (see the module docstring for the assumptions)."""
    if rec.unit == "counts":            # already HRS counts at 10 Hz (real PineTime): resample only if the rate differs
        if rec.rate_hz == rate_out:
            return np.ascontiguousarray(rec.data.astype(np.int32))
        y = resample(rec.data.astype(np.float64), rec.rate_hz, rate_out, "poly")
        return np.ascontiguousarray(np.clip(np.rint(y), 0, HRS_MAX).astype(np.int32))
    if rec.unit != "adc":
        raise ValueError(f"unknown unit {rec.unit!r}")
    x = rec.data.astype(np.float64)
    sigma = robust_ac_sigma(x, rec.rate_hz)
    if not np.isfinite(sigma) or sigma <= 0:
        raise ValueError(f"{rec.rec_id}: flat PPG signal")
    y = resample(x, rec.rate_hz, rate_out, "poly")
    y = (y - np.median(y)) * (ac_std / sigma) + dc
    return np.ascontiguousarray(np.clip(np.rint(y), 0, HRS_MAX).astype(np.int32))


def reference_check(rec: Recording, rate: float = 25.6, lo: float = 40.0, hi: float = 200.0) -> np.ndarray:
    """Firmware-independent sanity reference: per-window spectral-peak HR of the PPG (Hann FFT, 40-200 bpm) so the
    ECG truth and the PPG can be confirmed to be time-aligned and usable.  Returns bpm per truth window (NaN if flat)."""
    from scipy.signal import resample_poly
    t_end, _ = rec.truth["hr_bpm"]
    y = resample_poly(rec.data.astype(np.float64), 1, 10, padtype="line")        # 256 -> 25.6 Hz
    n_w = int(WINDOW_S * rate)
    out = np.full(len(t_end), np.nan)
    nfft = 8192
    freqs = np.fft.rfftfreq(nfft, 1 / rate) * 60.0
    band = (freqs >= lo) & (freqs <= hi)
    for k in range(len(t_end)):
        seg = y[k * n_w:(k + 1) * n_w]
        if len(seg) < n_w:
            continue
        seg = (seg - seg.mean()) * np.hanning(len(seg))
        spec = np.abs(np.fft.rfft(seg, nfft)) ** 2
        out[k] = freqs[band][int(np.argmax(spec[band]))]
    return out
