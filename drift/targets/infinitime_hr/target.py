"""InfiniTime (PineTime) heart rate: src/components/heartrate/Ppg.{cpp,h} from 0.11.0 to 1.16.1.

Two real algorithm generations exist (recon/infinitime.md, re-verified by this target):
  gen A  0.11.0 - 1.12.0  wasp-os time-domain autocorrelation, constants assume 24 Hz  (Ppg + Biquad + Ptagc)
  gen B  1.13.0 - 1.16.1  Ceimour's FFT algorithm (arduinoFFT), 10 Hz, 64-sample window    (Ppg only)

The history yields 10 distinct blob sets ("variants": 7 in gen A, 3 in gen B).  Drift builds and replays ALL of them
once to *verify* that outputs are identical within a generation (stored in the results JSON), and then keeps only the
distinct generations, plus one null control (the last gen-A variant, 1.12.0, which carries the largest refactor of
gen A: int8 narrowing, float -> int locals).  Each generation is fed at its own native rate.

SCOPE: Drift replays the ALGORITHM LAYER only.  Sensor-driver changes (HRS3300 gain 64x -> 8x in 1.9.0, the 1.13.0
retune of LED current/resolution/wait, atomic reads in 1.15.0) and the HeartRateTask layer (FreeRTOS timing,
1.16 background measurement) change the raw counts or the output schedule and cannot be replayed from a recording.
"""
from __future__ import annotations

import ctypes
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from drift import CACHE_DIR
from drift import history
from drift.targets.base import Generation, Recording, RunOut
from drift.toolchain import compile_cpp

HERE = Path(__file__).resolve().parent
SO_SUFFIX = ".dll" if sys.platform == "win32" else ".so"
HR_DIR = "src/components/heartrate"
FFT_GITLINK = "src/libs/arduinoFFT"
RATE_A, RATE_B = 24.0, 10.0
RELEASE_TAG = re.compile(r"\d+\.\d+\.\d+")

CAVEAT = ("Algorithm layer only: Drift compiles InfiniTime's Ppg.cpp (and its Biquad/Ptagc/arduinoFFT dependencies) "
          "and replays recorded PPG counts through it. Sensor-driver changes (HRS3300 gain 64x -> 8x in 1.9.0, the 1.13.0 "
          "LED-current/resolution/wait retune, atomic reads in 1.15.0) alter the raw counts themselves and the HeartRateTask "
          "layer (timing, 1.16 background measurement) alters when values are shown; neither can be replayed from a "
          "recording. The public PPG data are not HRS3300 data: they are rescaled to HRS3300-like counts under stated "
          "assumptions. Results describe the algorithms on this data, not the PineTime as shipped.")


@dataclass
class HRInput:
    """Native input of one recording for each generation: HRS3300-like int32 counts at the generation's own rate."""
    by_rate: dict[float, np.ndarray] = field(default_factory=dict)

    def __len__(self) -> int:
        return len(self.by_rate)


class InfiniTimeHR:
    name = "infinitime_hr"
    repo_url = "https://github.com/InfiniTimeOrg/InfiniTime.git"
    algo_files = [f"{HR_DIR}/{n}" for n in ("Ppg.cpp", "Ppg.h", "Biquad.cpp", "Biquad.h", "Ptagc.cpp", "Ptagc.h")]
    tag_glob = "[0-9]*.[0-9]*.[0-9]*"
    tag_min = "0.11.0"                     # first release with heart-rate code
    tag_max = "1.16.1"                     # last release Drift was verified on; newer tags are ignored (and warned about)
    # sha256 (16 hex) of the "tag<TAB>commit" lines of the 27 release tags 0.11.0..1.16.1 (x.y.z only; -RC/-develop excluded)
    tag_pin = "8e4579794cecdcb1"
    datasets = ["infinitime", "ppg-wrist", "ppg-fork"]
    recipe_files = [HERE / "wrap.cpp", HERE / "shim" / "nrf_log.h"]
    std = "-std=c++17"
    recipe_extra = "std=c++17 O2 (zig c++, libc++) arduinoFFT@419d7b044e56"
    ac_std_counts = 25.0                   # scaling assumption, see data.py
    dc_counts = 3600.0

    def __init__(self, cache: Path = CACHE_DIR, ac_std: float | None = None, **_ignored):
        self.cache = Path(cache)
        self.ac_std = float(ac_std) if ac_std is not None else self.ac_std_counts
        self.variant_info: dict[str, dict] = {}     # gen_id -> {"tags", "role", ...} for every distinct blob set

    # ---- paths ---------------------------------------------------------------------------------------------
    def repo_path(self, cache: Path | None = None) -> Path:
        from drift.fetch import infinitime
        return infinitime.repo_path(cache or self.cache)

    # ---- history -------------------------------------------------------------------------------------------
    def variants(self, repo: Path) -> list[Generation]:
        """Every distinct algorithm blob set between 0.11.0 and the latest release (10 of them), oldest first."""
        self.tag_pin_info = history.check_tag_pin(repo, self.tag_glob, self.tag_min, self.tag_max, self.tag_pin,
                                                  only=RELEASE_TAG)
        tags = [t for t in history.list_tags(repo, self.tag_glob, self.tag_min, self.tag_max) if RELEASE_TAG.fullmatch(t)]
        infos = []
        for tag in tags:
            ref = f"refs/tags/{tag}"
            blobs = {p: history.blob_at(repo, ref, p) for p in self.algo_files}
            commit = history.last_commit_touching(repo, ref, [p for p in self.algo_files if blobs[p]])
            infos.append(history.TagInfo(tag, history.tag_date(repo, tag), blobs, commit))
        return history.collapse(infos, self.algo_files)

    @staticmethod
    def is_frequency(v: Generation) -> bool:
        """Gen B has no Biquad/Ptagc files (deleted by the 1.13.0 refactor)."""
        return not any(p.endswith("Ptagc.cpp") for p in v.blobs)

    def generations(self, repo: Path) -> list[Generation]:
        """[gen A, gen B, null control of gen A].  The 7+3 variants are in self.variant_info / self.variant_list."""
        from drift.fetch import infinitime
        vs = self.variants(repo)
        self.variant_list = vs
        a_vars = [v for v in vs if not self.is_frequency(v)]
        b_vars = [v for v in vs if self.is_frequency(v)]
        if not a_vars or not b_vars or vs.index(b_vars[0]) != len(a_vars):
            raise RuntimeError("expected autocorrelation variants followed by FFT variants")
        for v in b_vars:      # the FFT library must be the pinned one at every FFT release
            link = history.blob_at(repo, f"refs/tags/{v.first_tag}", FFT_GITLINK)
            if link != infinitime.FFT_COMMIT:
                raise RuntimeError(f"{v.first_tag}: arduinoFFT gitlink {link} != pinned {infinitime.FFT_COMMIT}")
        self.variant_info = {}
        for v in vs:
            self.variant_info[v.gen_id] = {"first_tag": v.first_tag, "last_tag": v.last_tag, "tags": v.tags,
                                           "family": "B" if self.is_frequency(v) else "A", "commit": v.commit,
                                           "blobs": v.blobs}

        def merge(group: list[Generation], gid: str, label: str, rep: Generation) -> Generation:
            tags = [t for v in group for t in v.tags]
            return Generation(gen_id=rep.gen_id, blobs=dict(rep.blobs), first_tag=tags[0], last_tag=tags[-1], tags=tags,
                              first_date=group[0].first_date, last_date=None, commit=rep.commit, label=label)

        gen_a = merge(a_vars, "A", f"{a_vars[0].first_tag}-{a_vars[-1].last_tag} autocorrelation, 24 Hz", a_vars[0])
        gen_b = merge(b_vars, "B", f"{b_vars[0].first_tag}-{b_vars[-1].last_tag} FFT, 10 Hz", b_vars[0])
        gen_a.last_date = gen_b.first_date
        null = Generation(gen_id=a_vars[-1].gen_id, blobs=dict(a_vars[-1].blobs), first_tag=a_vars[-1].first_tag,
                          last_tag=a_vars[-1].last_tag, tags=list(a_vars[-1].tags), first_date=a_vars[-1].first_date,
                          last_date=gen_b.first_date, commit=a_vars[-1].commit,
                          label=f"{a_vars[-1].first_tag} null control of gen A")
        if null.gen_id == gen_a.gen_id:
            raise RuntimeError("null control is the same blob set as gen A")
        self.roles = {gen_a.gen_id: "A", gen_b.gen_id: "B", null.gen_id: "A_null"}
        return [gen_a, gen_b, null]

    def describe(self, gen: Generation) -> str:
        return ""

    # ---- adapter -------------------------------------------------------------------------------------------
    def adapt(self, rec: Recording) -> HRInput:
        from drift.targets.infinitime_hr import data
        return HRInput({rate: data.to_hrs_counts(rec, rate, ac_std=self.ac_std, dc=self.dc_counts)
                        for rate in (RATE_A, RATE_B)})

    # ---- build ---------------------------------------------------------------------------------------------
    def build(self, gen: Generation, src_dir: Path) -> Path:
        """src_dir holds the algorithm files flat (basenames, written from git blobs).  They are laid out the way the
        firmware's include root sees them (components/heartrate/*, libs/arduinoFFT/src/*) and compiled with wrap.cpp."""
        from drift.fetch import infinitime
        src_dir = Path(src_dir)
        inc = src_dir.parent / "inc"
        hr = inc / "components" / "heartrate"
        if inc.exists():
            shutil.rmtree(inc)
        hr.mkdir(parents=True)
        sources = [HERE / "wrap.cpp"]
        for f in sorted(src_dir.iterdir()):
            shutil.copyfile(f, hr / f.name)
            if f.suffix == ".cpp":
                sources.append(hr / f.name)
        if not (src_dir / "Ptagc.cpp").exists():       # FFT generation: add the pinned arduinoFFT headers
            dest = inc / "libs" / "arduinoFFT" / "src"
            dest.mkdir(parents=True)
            for name in ("arduinoFFT.h", "defs.h", "types.h"):
                (dest / name).write_bytes(_git_show(infinitime.fft_path(self.cache), infinitime.FFT_COMMIT, f"src/{name}"))
        out = src_dir.parent / f"{self.name}_{gen.gen_id}{SO_SUFFIX}"
        compile_cpp(sources, out, shared=True, std=self.std, includes=[inc, HERE / "shim"])
        return Path(out)

    # ---- run -----------------------------------------------------------------------------------------------
    _libs: dict[str, ctypes.CDLL] = {}

    @classmethod
    def _load(cls, dll: Path) -> ctypes.CDLL:
        key = str(Path(dll).resolve())
        lib = cls._libs.get(key)
        if lib is None:
            lib = ctypes.CDLL(key)
            lib.drift_abi.restype = ctypes.c_int
            lib.drift_rate_hz.restype = ctypes.c_double
            lib.drift_init.argtypes = [ctypes.c_int]
            lib.drift_init.restype = None
            lib.drift_run.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
            lib.drift_run.restype = ctypes.c_int
            if lib.drift_abi() != 3:
                raise RuntimeError(f"{dll}: unexpected drift ABI {lib.drift_abi()}")
            cls._libs[key] = lib
        return lib

    def rate_of(self, dll: Path) -> float:
        return float(self._load(dll).drift_rate_hz())

    def run(self, dll: Path, native) -> RunOut:
        lib = self._load(dll)
        rate = float(lib.drift_rate_hz())
        x = native.by_rate[rate] if isinstance(native, HRInput) else native
        x = np.ascontiguousarray(x, dtype=np.int32)
        n = int(x.shape[0])
        ret = np.zeros(n, dtype=np.int32)
        shown = np.zeros(n, dtype=np.int32)
        lib.drift_init(int(x[0]) if n else 0)
        positives = lib.drift_run(x.ctypes.data, None, n, ret.ctypes.data, shown.ctypes.data)
        t = (np.arange(n) + 1) / rate            # time at which each output is available (after the sample is fed)
        return RunOut(total=int(positives), events=None, n_samples=n, hr=(t, ret),
                      meta={"rate_hz": rate, "shown": shown})

    # ---- CLI hooks -----------------------------------------------------------------------------------------
    @property
    def stages_after_replay(self):
        from drift.targets.infinitime_hr.export import export_stage
        return [export_stage]

    def print_table(self, res, limit: int = 40) -> None:
        """Per recording: ECG median HR and the median positive output of each generation (bpm)."""
        roles = getattr(self, "roles", {})
        gens = res.generations
        print("recording".ljust(28) + "ECG".rjust(6) + "".join((roles.get(g.gen_id) or g.gen_id).rjust(8) for g in gens))
        for rec in res.recordings[:limit]:
            truth = rec.truth.get("hr_bpm")
            ecg = f"{np.nanmedian(truth[1]):.0f}" if truth is not None else "-"
            cells = []
            for g in gens:
                ret = res.runs[(g.gen_id, rec.rec_id)].hr[1]
                pos = ret[ret > 0]
                cells.append((f"{np.median(pos):.0f}" if len(pos) else "-").rjust(8))
            print(rec.rec_id[:27].ljust(28) + ecg.rjust(6) + "".join(cells))

    # ---- data ----------------------------------------------------------------------------------------------
    def recordings(self, cache: Path = CACHE_DIR) -> list[Recording]:
        from drift.targets.infinitime_hr import data
        return data.load_wrist(cache) + data.load_fork(cache)

    def provenance(self, cache: Path = CACHE_DIR) -> dict:
        from drift.fetch import infinitime, ppg
        from drift.fetch.common import run_git
        from drift.toolchain import zig_version
        repo = infinitime.repo_path(cache)
        return {
            "target": self.name, "firmware_repo": self.repo_url, "firmware_clone_head": run_git("rev-parse", "HEAD", cwd=repo),
            "firmware_tag_pin": getattr(self, "tag_pin_info", None),
            "arduinoFFT": {"url": infinitime.FFT_URL, "commit": infinitime.FFT_COMMIT},
            "toolchain": f"zig c++ {zig_version()} {self.std} -O2 (libc++), MSVC 14.44 cross-check in recon",
            "datasets": {
                "physionet-wrist": {"url": ppg.WRIST_BASE, "doi": ppg.WRIST_DOI, "license": "ODC-By 1.0"},
                "infinitime-fork-ppg": {"url": ppg.FORK_REPO, "commit": ppg.FORK_COMMIT, "path": ppg.FORK_PATH,
                                        "license": "data files unlabelled (repo GPL-3.0); agreement checks only"},
            },
        }


def _git_show(repo: Path, rev: str, path: str) -> bytes:
    r = subprocess.run(["git", "-C", str(repo), "show", f"{rev}:{path}"], capture_output=True)
    if r.returncode:
        raise RuntimeError(f"git show {rev}:{path} failed: {r.stderr.decode(errors='replace')}")
    return r.stdout


TARGET_CLASS = InfiniTimeHR
