"""Host C/C++ toolchain for Drift: zig cc / zig c++ (pip 'ziglang') inside the project venv."""
import functools, os, subprocess, sys
from pathlib import Path

ZIG = [sys.executable, "-m", "ziglang"]

def _build(driver, sources, out, defines, includes, std, shared, opt, extra):
    sources = [sources] if isinstance(sources, (str, os.PathLike)) else list(sources)
    out = Path(out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = ZIG + [driver, std, opt, "-Wall", "-fno-sanitize=undefined"]
    if shared:
        cmd += ["-shared"]
        if sys.platform == "win32" and out.suffix == "":
            out = out.with_suffix(".dll")
    elif sys.platform == "win32" and out.suffix == "":
        out = out.with_suffix(".exe")
    for k, v in (defines or {}).items():
        cmd.append(f"-D{k}" if v is None else f"-D{k}={v}")
    for inc in includes or []:
        cmd.append(f"-I{inc}")
    cmd += [str(Path(s).resolve()) for s in sources] + (extra or []) + ["-o", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"compile failed ({' '.join(cmd)})\n{r.stdout}\n{r.stderr}")
    return str(out)

def compile_c(sources, out, defines=None, includes=None, shared=False, std="-std=c11", opt="-O2", extra=None):
    """Build C sources to exe (or .dll if shared=True). defines: dict (value None => -DNAME)."""
    return _build("cc", sources, out, defines, includes, std, shared, opt, extra)

def compile_cpp(sources, out, defines=None, includes=None, shared=False, std="-std=c++17", opt="-O2", extra=None):
    return _build("c++", sources, out, defines, includes, std, shared, opt, extra)

@functools.lru_cache(maxsize=1)
def zig_version():
    """Version string of the bundled zig (recorded in results provenance)."""
    r = subprocess.run(ZIG + ["version"], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"zig version failed: {r.stderr}")
    return r.stdout.strip()
