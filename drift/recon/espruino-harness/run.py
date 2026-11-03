"""Drift/Espruino differential run: feed every recorded CSV to every compiled stepcount version.
usage: python -I run.py <data_dir> [--flush]"""
import sys, ctypes, os, glob, numpy as np
here = os.path.dirname(os.path.abspath(__file__))
data = sys.argv[1]; flush = '--flush' in sys.argv
# versions: label -> (dll, firmware)
V = [("2v09 inline","sc_2v09","<=2v09"),("9c2c3738","sc_9c2c3738","2v10"),("e33e1183","sc_e33e1183","2v11"),
     ("afb4943c","sc_afb4943c","2v12-2v21"),("3138205d","sc_3138205d","2v22-2v28"),("2913ca0a","sc_2913ca0a","2v29"),
     ("d338bfbf","sc_d338bfbf","(dev)"),("e12de357","sc_e12de357","(dev)"),("7003b2bb","sc_7003b2bb","(dev)"),("6bf72283","sc_6bf72283","(dev)"),
     ("1fb87396","sc_1fb87396","(dev)"),("ea8733c1","sc_ea8733c1","(dev)")]
# expected steps from upstream main.c / file names
EXP = {"HughB-walk-6605":6605,"HughB-walk-2350":2350,"HughB-walk-a3070-b3046":3070,"HughB-walk-a10021-b10248":10021,
 "HughB-drive-36min-0":0,"HughB-drive-29min-0":0,"HughB-drive-a3-b136":3,"HughB-work-66":66,"HughB-mixed-390":390,
 "HughB-general-a260-b573":260,"HughB-housework-a958-b2658":958,"MrPloppy-stationary-0":0,"HughB-walk-1834":1834,"HughB-walk-2331":2331,"HughB-work-0":0,
 "HughB-drive-18":18,"0_HughB_train_journey_b31":0}
libs = {}
for lab,dll,fw in V:
    L = ctypes.CDLL(os.path.join(here,"bin",dll+".dll"))
    L.drift_init.restype=None; L.drift_run.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.c_void_p]; L.drift_run.restype=ctypes.c_int
    libs[lab]=L
print("file,n,expected," + ",".join(l for l,_,_ in V))
for name,exp in EXP.items():
    p = os.path.join(data,name+".csv")
    if not os.path.exists(p): continue
    a = np.loadtxt(p, delimiter=",", skiprows=1, usecols=(1,2,3), dtype=np.int64)
    a16 = np.ascontiguousarray(a.astype(np.int16))
    if flush: a16 = np.ascontiguousarray(np.vstack([a16, np.repeat(a16[-1:],7,axis=0)]))
    row=[]
    for lab,_,_ in V:
        L=libs[lab]; L.drift_init(); row.append(str(L.drift_run(a16.ctypes.data,len(a16),None)))
    print(f"{name},{len(a16)},{exp},"+",".join(row))
