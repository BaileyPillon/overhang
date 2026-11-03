"""Drift: firmware forensics for science.

Differential execution: compile the metric algorithm from every released firmware version for the host and replay
the same recordings through all of them.  Third-party datasets and firmware source are never vendored; they live
under CACHE_DIR (.cache/drift/, gitignored) and are fetched by drift.fetch.
"""
import os
from datetime import date, datetime, timezone
from pathlib import Path

__version__ = "0.1.0"

PKG_DIR = Path(__file__).resolve().parent
REPO_ROOT = PKG_DIR.parent
# Override with DRIFT_CACHE (the tests use it to build in a scratch dir when asked to).
CACHE_DIR = Path(os.environ.get("DRIFT_CACHE") or (REPO_ROOT / ".cache" / "drift")).resolve()
# Optional local downloads made during recon; fetch/ copies from here instead of downloading when present.
RECON_DL = PKG_DIR / "recon" / "dl"


def generated_date() -> date:
    """The date stamped into results and memos.  DRIFT_DATE=YYYY-MM-DD (set by every command's --date) or the
    reproducible-builds variable SOURCE_DATE_EPOCH pins it, so a re-run on another day gives the same bytes;
    otherwise it is today.  The reproducibility contract is the NUMBERS (every value except dates is a pure
    function of the pinned inputs); byte-identity additionally needs the same date, library versions and platform."""
    v = os.environ.get("DRIFT_DATE")
    if v:
        return date.fromisoformat(v)
    e = os.environ.get("SOURCE_DATE_EPOCH")
    if e:
        return datetime.fromtimestamp(int(e), tz=timezone.utc).date()
    return date.today()
