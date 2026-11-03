#!/bin/sh
# Rebuild all Drift/Espruino step-count DLLs. Needs the project venv (.venv at the repo root) with pip "ziglang" (0.16.0 used).
# Set PY to use another interpreter, e.g.  PY=python ./build.sh
cd "$(dirname "$0")" || exit 1
ROOT=$(cd ../../.. && pwd)
if [ -z "$PY" ]; then
  if [ -x "$ROOT/.venv/Scripts/python.exe" ]; then PY="$ROOT/.venv/Scripts/python.exe"   # Windows venv
  elif [ -x "$ROOT/.venv/bin/python" ]; then PY="$ROOT/.venv/bin/python"                 # macOS / Linux venv
  else PY=python; fi
fi
for c in $(ls src); do $PY -m ziglang cc -std=c99 -O2 -Wall -shared -I shim -I src/$c wrap.c -o bin/sc_$c.dll || echo "FAIL $c"; done
$PY -m ziglang cc -O2 -shared wrap_2v09.c -o bin/sc_2v09.dll
# run:  $PY -I run.py ../dl/espruino/step-count/data --flush
