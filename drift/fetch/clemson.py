"""Clemson Pedometer Evaluation Project (Mattfeld, Jesch, Hoover; IEEE BIBM 2017; Sensors 21(13):4260, 2021).
Data.zip = 30 subjects x 3 gaits, wrist/hip/ankle accelerometer at 15 Hz in g, video-annotated step indices.
Downloaded to the local cache only (redistribution terms are not stated on the project page)."""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

from drift import CACHE_DIR, RECON_DL
from drift.fetch.common import download, sha256_file

PAGE = "https://cecas.clemson.edu/~ahoover/pedometer/"
DATA_URL = "https://cecas.clemson.edu/tracking/Pedometer/Data.zip"
DATA_SIZE = 31_661_301
# Pinned digests (first fetched 2026-11-03).  The project page states no licence or citation request; if the files
# change upstream these checks fail loudly instead of silently changing the results.
DATA_SHA256 = "ce37832d5e234f6f014193a3a2af2f3162ab90905f303d473849512d690885da"
DEMOGRAPHICS_SHA256 = "1621a94e53dfad7440f1ecea59b579b99830f4cb0a368db2120a7aeb358b2480"
DEMOGRAPHICS_URL = "https://cecas.clemson.edu/tracking/Pedometer/demographics.csv"
NAME = "clemson"


def base_dir(cache: Path = CACHE_DIR) -> Path:
    return Path(cache) / "datasets" / "clemson"


def data_dir(cache: Path = CACHE_DIR) -> Path:
    return base_dir(cache) / "Data"


def _safe_extract(zf: zipfile.ZipFile, out: Path) -> None:
    out = out.resolve()
    for m in zf.infolist():
        target = (out / m.filename).resolve()
        if out != target and out not in target.parents:
            raise RuntimeError(f"unsafe path in zip: {m.filename}")
    zf.extractall(out)


def fetch(cache: Path = CACHE_DIR) -> dict:
    base = base_dir(cache)
    zip_path = base / "Data.zip"
    how = []
    if not zip_path.exists() or zip_path.stat().st_size != DATA_SIZE or sha256_file(zip_path) != DATA_SHA256:
        recon = RECON_DL / "datasets" / "clemson" / "Data.zip"
        base.mkdir(parents=True, exist_ok=True)
        if recon.exists() and recon.stat().st_size == DATA_SIZE and sha256_file(recon) == DATA_SHA256:
            import shutil
            shutil.copyfile(recon, zip_path)
            how.append(f"copied Data.zip from {recon}")
        else:
            download(DATA_URL, zip_path, expected_size=DATA_SIZE)
            how.append(f"downloaded {DATA_URL}")
        if sha256_file(zip_path) != DATA_SHA256:
            got = sha256_file(zip_path)
            zip_path.unlink()
            raise RuntimeError(f"Data.zip SHA-256 {got} does not match the pinned {DATA_SHA256}")
    if not any(data_dir(cache).glob("P*/*/steps.txt")):
        with zipfile.ZipFile(zip_path) as zf:
            # the archive's top level is expected to be Data/; extract so that base/Data exists either way
            names = zf.namelist()
            if names and all(n.startswith("Data/") for n in names):
                _safe_extract(zf, base)
            else:
                _safe_extract(zf, data_dir(cache))
        how.append("extracted")
    demo = base / "demographics.csv"
    if not demo.exists():
        src = RECON_DL / "datasets" / "clemson" / "demographics.csv"
        if src.exists():
            import shutil
            shutil.copyfile(src, demo)
        else:
            download(DEMOGRAPHICS_URL, demo)
    if sha256_file(demo) != DEMOGRAPHICS_SHA256:
        got = sha256_file(demo)
        demo.unlink()
        raise RuntimeError(f"demographics.csv SHA-256 {got} does not match the pinned {DEMOGRAPHICS_SHA256}")
    manifest = base / "MANIFEST.json"
    if not manifest.exists():
        manifest.write_text(json.dumps({"url": DATA_URL, "bytes": zip_path.stat().st_size,
                                        "sha256": sha256_file(zip_path), "page": PAGE}, indent=1))
    n = len(list(data_dir(cache).glob("P*/*/steps.txt")))
    return {"name": NAME, "path": str(data_dir(cache)), "how": "; ".join(how) or "present", "url": DATA_URL,
            "sha256": json.loads(manifest.read_text())["sha256"], "recordings": n}
