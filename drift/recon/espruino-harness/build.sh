#!/bin/sh
# Rebuild all Drift/Espruino step-count DLLs. Needs D:\Projects\overhang\.venv with pip "ziglang" (0.16.0 used).
cd "$(dirname "$0")"; PY=/d/Projects/overhang/.venv/Scripts/python.exe
for c in $(ls src); do $PY -m ziglang cc -std=c99 -O2 -Wall -shared -I shim -I src/$c wrap.c -o bin/sc_$c.dll || echo "FAIL $c"; done
$PY -m ziglang cc -O2 -shared wrap_2v09.c -o bin/sc_2v09.dll
# run:  $PY -I run.py ../dl/espruino/step-count/data --flush
