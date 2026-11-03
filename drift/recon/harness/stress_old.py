# Randomised differential test between adjacent "old" (time-domain) releases at 24 Hz. Usage: python -I stress_old.py
import random, math, subprocess, os
here = os.path.dirname(os.path.abspath(__file__)); random.seed(7)
vers = ['0.11.0','1.0.0','1.1.0','1.2.0','1.8.0','1.12.0']
def run(v, f): return subprocess.run([os.path.join(here,'bin','ppg_%s.exe' % v), f], capture_output=True, text=True).stdout
diff = {}; N = 60
for trial in range(N):
    fs = 24; n = fs*90
    bpm = random.choice([50,65,80,110,140,170]); noise = random.choice([3,30,150]); amp = random.choice([5,40,300])
    f = os.path.join(here,'out','stress.csv')
    with open(f,'w') as fh:
        for i in range(n):
            t = i/fs
            v = 3600 + amp*math.sin(2*math.pi*bpm/60*t) + random.gauss(0,noise) + (random.random()<0.01)*random.choice([-1,1])*2000
            fh.write('%d\n' % round(v))
    o = {v: run(v,f) for v in vers}
    for a,b in zip(vers, vers[1:]):
        if o[a] != o[b]: diff[(a,b)] = diff.get((a,b),0)+1
print('trials', N, 'differing adjacent pairs:', diff)
