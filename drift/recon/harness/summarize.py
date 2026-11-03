import subprocess, glob, os, statistics, sys
here = os.path.dirname(os.path.abspath(__file__))
vers = ['0.11.0','1.0.0','1.1.0','1.2.0','1.8.0','1.12.0','1.13.0','1.15.0','1.16.1']
files = sorted(glob.glob(os.path.join(here,'data','*.csv')))
print('%-28s' % 'input' + ''.join('%9s' % v for v in vers))
for f in files:
    cells = []
    for v in vers:
        exe = os.path.join(here,'bin','ppg_%s.exe' % v)
        r = subprocess.run([exe, f], capture_output=True, text=True)
        os.makedirs(os.path.join(here,'out'), exist_ok=True)
        open(os.path.join(here,'out','%s__%s.csv' % (os.path.basename(f)[:-4], v)),'w').write(r.stdout)
        rets = [int(l.split(',')[1]) for l in r.stdout.splitlines()]
        pos = [x for x in rets if x > 0]
        med = statistics.median(pos) if pos else 0
        cells.append('%d/%d' % (med, len(pos)))   # median positive bpm / number of positive outputs
    print('%-28s' % os.path.basename(f)[:-4] + ''.join('%9s' % c for c in cells))
