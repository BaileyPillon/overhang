"""Dataset and firmware-source fetchers.  Everything lands under CACHE_DIR (.cache/drift/, gitignored); recon
downloads under drift/recon/dl/ are copied instead of re-downloaded when present."""
from __future__ import annotations

from drift import CACHE_DIR
from drift.fetch import bangle, clemson, espruino, infinitime, ppg

FETCHERS = {"espruino": espruino.fetch, "bangle": bangle.fetch, "clemson": clemson.fetch,
            "infinitime": infinitime.fetch, "ppg-wrist": ppg.fetch_wrist, "ppg-fork": ppg.fetch_fork}


def fetch_all(names: list[str], cache=CACHE_DIR) -> list[dict]:
    out = []
    for n in names:
        if n not in FETCHERS:
            raise KeyError(f"unknown fetcher {n!r}; known: {', '.join(FETCHERS)}")
        out.append(FETCHERS[n](cache))
    return out
