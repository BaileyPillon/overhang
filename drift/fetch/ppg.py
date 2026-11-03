"""Heart-rate recordings for the InfiniTime target.  Fetched into the cache, never committed.

* PhysioNet "Wrist PPG During Exercise" v1.0.0 (Jarchi & Casson, Data 2017, 2(1):1, doi:10.3390/data2010001),
  Open Data Commons Attribution v1.0.  8 subjects, 19 records, 256 Hz wrist PPG + hand-annotated ECG R-peaks.
* Six real PineTime recordings (firmware 1.14, 10 Hz HRS3300 counts, no ground truth) from the community fork
  marcinkosztolowicz/InfiniTime, branch heart-rate-debug-tools, pinned commit.  The data files carry no separate
  license statement; they are used here for algorithm-agreement checks only and are not redistributed.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from drift import CACHE_DIR, RECON_DL
from drift.fetch.common import download, sha256_file

WRIST_BASE = "https://physionet.org/files/wrist/1.0.0/"
WRIST_DOI = "10.3390/data2010001"
WRIST_RECORDS = [
    "s1_high_resistance_bike", "s1_low_resistance_bike", "s1_walk", "s2_high_resistance_bike",
    "s2_low_resistance_bike", "s2_walk", "s3_high_resistance_bike", "s3_low_resistance_bike", "s3_run", "s3_walk",
    "s4_run", "s5_low_resistance_bike", "s5_run", "s6_low_resistance_bike", "s6_run", "s6_walk", "s8_run", "s8_walk",
    "s9_walk",
]
FORK_REPO = "https://github.com/marcinkosztolowicz/InfiniTime"
FORK_COMMIT = "11989240743a3ebbfccdf5242dc1b062a54161c0"
FORK_PATH = "ppg_analysis/data"
FORK_STAMPS = ["1727532341", "1727535175", "1727535595", "1727536786", "1727537070", "1727541509"]
FORK_SUFFIXES = ["_data.csv", "_metadatadata.json", "_time.csv"]
# SHA-256 of the 18 fork files as first fetched (a moving branch/raw URL would otherwise go unnoticed)
FORK_SHA256 = {
    "1727532341_data.csv": "b4668e205935e6ac0c9cd37266abd3c886a006cfc17d7db6520245c9fe757903",
    "1727532341_metadatadata.json": "b4cbfa40b296b354604ead49f09289098e08d2ab2e8106eba6383d5dd5a46008",
    "1727532341_time.csv": "8820e710c3b8fabeefbb5ca38a90478f3c1b18d60689b13a684380a00de6703a",
    "1727535175_data.csv": "154cc30c1d68c9b6fe2762fb2553cb16856203552965d73f35fff846d8bcdad4",
    "1727535175_metadatadata.json": "00634e703341458af8b62abfdaa4b5ba8ac32107155634af91d438276e97710a",
    "1727535175_time.csv": "e39056e577002fde7c2b04ab8b089cca3bc701b54eb890331e2ae2b2842f9fb3",
    "1727535595_data.csv": "88fa5b120bc3b0f7e57f22869b82ecc1f1eaa0eb3ed4fd1c088bc2adf9def12e",
    "1727535595_metadatadata.json": "a977cb8a3c5e17c66e1c432f9623cc233d61bba962a0a2fdbd59541d7fbdfc26",
    "1727535595_time.csv": "9bc6c5dc4a0350c1643f97b5a513a1cf0318f9baf0da0e3cc903e781fccd1211",
    "1727536786_data.csv": "567268e088b11efcb95fb9e2bb20c94b975bb2dcb55bfc1bf857ea9a54e18841",
    "1727536786_metadatadata.json": "927f60312251ed90fdcc1485a44650e37322c77d19eb84d65e2c251d35534357",
    "1727536786_time.csv": "b32106809be5418913a50466ba97795ffb32c471afe8d573ff4b457395cc03f9",
    "1727537070_data.csv": "6114824775a989cd21db2ce7274b871d6f97b9289439d42eafa11be9fb4cb964",
    "1727537070_metadatadata.json": "d6c048a6a10e5a0e35c6ce1e0d993a04578065a38d162da78b6eb6df7c5d7827",
    "1727537070_time.csv": "a03b9389a962a50d6d43a0745d71721e221ae82ae83e57b8fd63f2b5f703f52a",
    "1727541509_data.csv": "4a0d9824a4965b44b3866e768dd94bc290e297923e65e7e8852da79ccf5a9c70",
    "1727541509_metadatadata.json": "b351d6a05c6eab7737b9e00d7315b8d8f66030bc4440a061e6d3a92bb4905592",
    "1727541509_time.csv": "abb97ae517865ec5311e7c9730de1b17ca11d95317d74644e8d5fa1384323e3c",
}


def wrist_dir(cache: Path = CACHE_DIR) -> Path:
    return Path(cache) / "datasets" / "physionet-wrist"


def fork_dir(cache: Path = CACHE_DIR) -> Path:
    return Path(cache) / "datasets" / "infinitime-fork-ppg"


def fetch_wrist(cache: Path = CACHE_DIR) -> dict:
    base = wrist_dir(cache)
    base.mkdir(parents=True, exist_ok=True)
    sums = base / "SHA256SUMS.txt"
    recon = RECON_DL / "datasets" / "physionet-wrist"
    if not sums.exists():
        if (recon / "SHA256SUMS.txt").exists():
            shutil.copyfile(recon / "SHA256SUMS.txt", sums)
        else:
            download(WRIST_BASE + "SHA256SUMS.txt", sums)
    expected = {}
    for line in sums.read_text().splitlines():
        parts = line.split()
        if len(parts) == 2:
            expected[parts[1]] = parts[0]
    n_new = 0
    for rec in WRIST_RECORDS:
        for ext in (".hea", ".dat", ".atr"):
            name = rec + ext
            dest = base / name
            if dest.exists() and sha256_file(dest) == expected.get(name):
                continue
            if (recon / name).exists() and sha256_file(recon / name) == expected.get(name):
                shutil.copyfile(recon / name, dest)
            else:
                download(WRIST_BASE + name, dest)
            if sha256_file(dest) != expected.get(name):
                dest.unlink()
                raise RuntimeError(f"{name}: SHA-256 does not match PhysioNet SHA256SUMS.txt")
            n_new += 1
    how = f"{n_new} files fetched/copied, SHA-256 verified" if n_new else "present, SHA-256 verified"
    return {"name": "ppg-wrist", "path": str(base), "how": how, "url": WRIST_BASE, "doi": WRIST_DOI,
            "records": len(WRIST_RECORDS)}


def fetch_fork(cache: Path = CACHE_DIR) -> dict:
    base = fork_dir(cache)
    base.mkdir(parents=True, exist_ok=True)
    recon = RECON_DL / "infinitime-fork-ppg"
    n_new = 0
    for stamp in FORK_STAMPS:
        for suf in FORK_SUFFIXES:
            name = stamp + suf
            dest = base / name
            if dest.exists() and sha256_file(dest) == FORK_SHA256[name]:
                continue
            if (recon / name).exists() and sha256_file(recon / name) == FORK_SHA256[name]:
                shutil.copyfile(recon / name, dest)
            else:
                url = f"https://raw.githubusercontent.com/marcinkosztolowicz/InfiniTime/{FORK_COMMIT}/{FORK_PATH}/{name}"
                download(url, dest)
            if sha256_file(dest) != FORK_SHA256[name]:
                dest.unlink()
                raise RuntimeError(f"{name}: SHA-256 does not match the pinned value")
            n_new += 1
    man = base / "MANIFEST.json"
    if not man.exists() or n_new:
        man.write_text(json.dumps({"repo": FORK_REPO, "commit": FORK_COMMIT, "path": FORK_PATH,
                                   "sha256": {p.name: sha256_file(p) for p in sorted(base.glob("17*"))}}, indent=1))
    return {"name": "ppg-fork", "path": str(base), "how": f"{n_new} files fetched/copied" if n_new else "present",
            "url": FORK_REPO, "commit": FORK_COMMIT, "recordings": len(FORK_STAMPS)}
