import sys, subprocess, ctypes
sys.path.insert(0, r"D:\Projects\overhang\drift")
from toolchain import compile_c, compile_cpp
for exe in (compile_c("hello.c","out/hello"), compile_cpp("t.cpp","out/t",defines={"NVAL":3}), compile_c("fx.c","out/fx",defines={"MAIN":None})):
    print(exe, subprocess.run([exe],capture_output=True,text=True).stdout.strip())
dll = compile_c("fx.c","out/fx",shared=True)
L = ctypes.CDLL(dll); L.q15_mul.restype=ctypes.c_int16; L.q15_mul.argtypes=[ctypes.c_int16]*2
arr=(ctypes.c_int16*3)(-5,7,-9); L.sum_abs.argtypes=[ctypes.c_void_p,ctypes.c_int]
print(dll, L.q15_mul(16384,16384), L.q15_mul(-32768,-32768), L.sum_abs(arr,3))
