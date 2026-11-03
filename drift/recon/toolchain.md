# Host C/C++ toolchain (key: toolchain)

## Survey (2026-11-03)
- Not on PATH: gcc, g++, clang, cc, tcc, zig, make, cmake, ninja. Present: uv (C:\Python314\Scripts), winget.
- MSVC exists (vswhere): VS2022 Community (`C:\Program Files\Microsoft Visual Studio\2022\Community`, MSVC 14.16/14.29/14.44) and BuildTools 2022. cl.exe needs vcvars and is not on PATH; not used.
- The venv had no pip: `D:\Projects\overhang\.venv\Scripts\python.exe -m ensurepip` fixed it.

## Chosen: ziglang 0.16.0 (pip, MIT, bundles clang; no system changes)
    D:\Projects\overhang\.venv\Scripts\python.exe -m pip install ziglang
    D:\Projects\overhang\.venv\Scripts\python.exe -m ziglang version        # 0.16.0
Driver: `python -m ziglang cc` (C) / `python -m ziglang c++` (C++, bundled libc++). Default target = host x86_64-windows-gnu.

## Proven commands (run in drift/recon/tc_test, all passed)
    PY=D:/Projects/overhang/.venv/Scripts/python.exe
    $PY -m ziglang cc  -std=c11 -O2 hello.c -o out/hello.exe              # prints "hello C"
    $PY -m ziglang c++ -std=c++17 -O2 -DNVAL=3 t.cpp -o out/t.exe         # <cmath>,<array>,<vector>: "C++17 1.0 2.0 3.0 N=3"
    $PY -m ziglang cc  -std=c11 -O2 -DMAIN fx.c -o out/fx.exe             # int16 Q15: 0.5*0.5=8192, sat(-32768*-32768)=32767
    $PY -m ziglang cc  -std=c11 -O2 -shared fx.c -o out/fx.dll            # DLL; also emits fx.lib, fx.pdb
ctypes: `ctypes.CDLL(r"...\fx.dll")` -> q15_mul(16384,16384)=8192, q15_mul(-32768,-32768)=32767, sum_abs=21. Works.
Mark exports with `__declspec(dllexport)` (see fx.c); set argtypes/restype (int16 default restype is int).
Test driver: tc_test/run.py (uses the helper below).

## Helper: D:\Projects\overhang\drift\toolchain.py
    from toolchain import compile_c, compile_cpp
    exe = compile_c(["a.c","b.c"], "out/name", defines={"FOO":1,"BAR":None}, includes=["inc"])   # -> ...\name.exe
    dll = compile_cpp("algo.cpp", "out/algo", shared=True)                                          # -> ...\algo.dll
Signature: compile_c/compile_cpp(sources, out, defines=None, includes=None, shared=False, std="-std=c11"|"-std=c++17", opt="-O2", extra=None). Adds .exe/.dll if `out` has no suffix; raises RuntimeError with command+stderr on failure; flags `-Wall -fno-sanitize=undefined` (the latter avoids ubsan runtime link issues).

## Notes
- Cross-compiling for embedded targets (e.g. `-target thumb-freestanding-eabi -mcpu=cortex_m4`) is available through zig but untested here; for Drift we build for host.
- Sources downloaded under recon/dl must be read before compiling; vendor headers (CMSIS etc.) are passed via `includes`.
