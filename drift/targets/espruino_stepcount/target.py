"""Bangle.js (Espruino) step counter: libs/misc/stepcount.c from 2v10 on, an inline counter in jswrap_bangle.c
before that (2v09 is the first tag Drift covers, transcribed in wrap_2v09.c).

Native input: 12.5 Hz, int16 x,y,z, 8192 counts = 1 g; the wrapper forms |a|^2 = x*x+y*y+z*z in C with the same int
width as jswrap_bangle.c, so overflow behaviour matches the device.
"""
from __future__ import annotations

import ctypes
import sys
from pathlib import Path

import numpy as np

from drift import CACHE_DIR
from drift import recordings as rec_mod
from drift.recordings import Recording
from drift.targets.base import Generation, RunOut
from drift.toolchain import compile_c

HERE = Path(__file__).resolve().parent
SO_SUFFIX = ".dll" if sys.platform == "win32" else ".so"

# What each distinct stepcount.c state changed, keyed by the commit the generation builds from
# (mapping verified in recon by comparing blob SHAs at every RELEASE_2Vxx tag).
_NOTES = {
    "9c2c3738": "bandpass FIR + history gate",
    "e33e1183": "state machine + raw gate",
    "afb4943c": "DC filter",
    "3138205d": "cosmetic, null control",
    "2913ca0a": "clamp fix, null control",
}


class EspruinoStepcount:
    name = "espruino_stepcount"
    repo_url = "https://github.com/espruino/Espruino.git"
    algo_files = ["libs/misc/stepcount.c", "libs/misc/stepcount.h"]
    tag_glob = "RELEASE_2V*"
    tag_min = "RELEASE_2V09"           # first tag with a Bangle.js step counter Drift transcribes
    tag_max = "RELEASE_2V29"           # last tag Drift was verified on; newer tags are ignored (and warned about)
    # sha256 (16 hex) of the "tag<TAB>commit" lines for RELEASE_2V09..RELEASE_2V29 (21 tags): the clone must agree
    tag_pin = "d7866f91e66b7bd9"
    datasets = ["espruino", "bangle", "clemson"]
    recipe_files = [HERE / "wrap.c", HERE / "wrap_2v09.c", HERE / "shim" / "jsutils.h"]
    std = "-std=c99"
    # -fwrapv: the device wraps on int32 overflow of x*x+y*y+z*z; make that defined here instead of undefined.
    cflags = ["-fwrapv"]
    recipe_extra = "std=c99 O2 fwrapv"   # compiler settings that are part of the build-cache key
    # generations that must reproduce another one bit for bit: {commit prefix: reference commit prefix}
    null_controls = {"3138205d": "afb4943c", "2913ca0a": "afb4943c"}

    def __init__(self, flush: bool = False, resample_method: str = "poly"):
        self.flush = flush
        self.resample_method = resample_method

    # ---- adapter ------------------------------------------------------------------------------------------
    def adapt(self, rec: Recording) -> np.ndarray:
        return rec_mod.to_bangle_native(rec, self.resample_method)

    # ---- labels -------------------------------------------------------------------------------------------
    def describe(self, gen: Generation) -> str:
        if not gen.blobs:
            return "inline hysteresis"
        return _NOTES.get(gen.commit[:8], "")

    def boundaries(self) -> dict:
        """Plain-language diff summaries between consecutive generations (written by Claude from the code diff)."""
        import json
        return json.loads((HERE / "boundaries.json").read_text(encoding="utf-8"))

    # ---- build --------------------------------------------------------------------------------------------
    def build(self, gen: Generation, src_dir: Path) -> Path:
        src_dir = Path(src_dir)
        out = src_dir.parent / f"{self.name}_{gen.gen_id}{SO_SUFFIX}"
        if not gen.blobs:
            compile_c([HERE / "wrap_2v09.c"], out, shared=True, std=self.std, extra=self.cflags)
        else:
            compile_c([HERE / "wrap.c"], out, shared=True, std=self.std,
                      includes=[HERE / "shim", src_dir], extra=self.cflags)
        return Path(out)

    # ---- run ----------------------------------------------------------------------------------------------
    _libs: dict[str, ctypes.CDLL] = {}

    @classmethod
    def _load(cls, dll: Path) -> ctypes.CDLL:
        key = str(Path(dll).resolve())
        lib = cls._libs.get(key)
        if lib is None:
            lib = ctypes.CDLL(key)
            lib.drift_abi.restype = ctypes.c_int
            lib.drift_init.restype = None
            lib.drift_run.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
            lib.drift_run.restype = ctypes.c_int
            lib.drift_flush_tail.restype = ctypes.c_int
            if lib.drift_abi() != 4:
                raise RuntimeError(f"{dll}: unexpected drift ABI {lib.drift_abi()}")
            cls._libs[key] = lib
        return lib

    def run(self, dll: Path, native: np.ndarray) -> RunOut:
        x = np.asarray(native)
        if x.dtype != np.int16 or x.ndim != 2 or x.shape[1] != 3:
            raise ValueError("native input must be int16 with shape (n, 3)")
        lib = self._load(dll)
        tail = 0
        if self.flush and len(x):
            # upstream main.c repeats the last sample ACCELFILTER_TAP_NUM times to flush the FIR: 57 for the 2v10
            # blob, 7 for 2v11 and later (and for the 2v09 inline counter); the device does neither.
            tail = int(lib.drift_flush_tail())
            x = np.vstack([x, np.repeat(x[-1:], tail, axis=0)])
        x = np.ascontiguousarray(x)
        n = int(x.shape[0])
        events = np.zeros(n, dtype=np.int32)
        peaks = np.zeros(n, dtype=np.int32)
        lib.drift_init()
        total = lib.drift_run(x.ctypes.data, n, events.ctypes.data, peaks.ctypes.data)
        return RunOut(total=int(total), events=events, peaks=peaks.astype(np.int8), n_samples=n, meta={"flush": bool(self.flush), "flush_tail": tail})

    # ---- data ---------------------------------------------------------------------------------------------
    def recordings(self, cache: Path = CACHE_DIR) -> list[Recording]:
        from drift.fetch import bangle, clemson
        return rec_mod.load_bangle(bangle.data_dir(cache)) + rec_mod.load_clemson(clemson.data_dir(cache))

    def provenance(self, cache: Path = CACHE_DIR) -> dict:
        from drift.fetch import bangle, clemson, espruino
        from drift.fetch.common import run_git
        from drift.toolchain import zig_version
        repo = espruino.repo_path(cache)
        return {
            "target": self.name, "firmware_repo": self.repo_url, "firmware_clone_head": run_git("rev-parse", "HEAD", cwd=repo),
            "firmware_tag_pin": getattr(self, "tag_pin_info", None),
            "toolchain": f"zig cc {zig_version()} {self.std} -O2 {' '.join(self.cflags)}",
            "datasets": {
                "bangle-step-count": {"url": bangle.REPO_URL, "commit": bangle.COMMIT},
                "clemson": {"url": clemson.DATA_URL, "page": clemson.PAGE},
            },
            "resample": f"{self.resample_method} (15 -> 12.5 Hz), x8192 counts per g, int16 saturation",
            "tail_flush": bool(self.flush),
        }


TARGET_CLASS = EspruinoStepcount
