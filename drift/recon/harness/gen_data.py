# Generates input streams for ppg_harness: synthetic PPG at 10 Hz and 24 Hz, and stitched real recordings from the
# marcinkosztolowicz/InfiniTime fork (64-sample sliding-window snapshots -> continuous 10 Hz stream).
import math, random, os, glob, sys
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data'); os.makedirs(out, exist_ok=True)
random.seed(1)
def synth(fs, bpm, secs, name, dc=3600, amp=40, noise=3):
    f = bpm/60.0
    with open(os.path.join(out, name), 'w') as fh:
        for i in range(int(fs*secs)):
            t = i/fs
            v = dc + amp*math.sin(2*math.pi*f*t) + 0.35*amp*math.sin(4*math.pi*f*t+0.8) + random.gauss(0, noise)
            fh.write('%d\n' % round(v))
for bpm in (60, 72, 100):
    synth(10, bpm, 120, 'synth_10hz_%dbpm.csv' % bpm)
    synth(24, bpm, 120, 'synth_24hz_%dbpm.csv' % bpm)
# real recordings
src = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dl', 'infinitime-fork-ppg')
for fn in sorted(glob.glob(os.path.join(src, '*_data.csv'))):
    rows = [[int(x) for x in l.strip().split(',') if x] for l in open(fn) if l.strip()]
    rows = [r for r in rows if len(r) == 64]
    stream = list(rows[0]); gaps = 0
    for prev, cur in zip(rows, rows[1:]):
        best_k, best_m = None, 0
        for k in range(1, 33):
            m = sum(1 for a, b in zip(prev[k:], cur[:64-k]) if a == b)
            if m > best_m: best_k, best_m = k, m
        if best_k and best_m >= 20 and best_m >= (64-best_k)*0.8:
            stream += cur[64-best_k:]
        else:
            stream += cur; gaps += 1
    name = 'real_%s.csv' % os.path.basename(fn).split('_')[0]
    open(os.path.join(out, name), 'w').write('\n'.join(map(str, stream)) + '\n')
    print(name, 'rows', len(rows), 'samples', len(stream), 'gaps/resets', gaps)
