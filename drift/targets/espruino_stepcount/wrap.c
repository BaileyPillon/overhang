/* Drift wrapper for Espruino libs/misc/stepcount.c (2v10 and later).
 * Compiled once per distinct stepcount.c blob (-I<dir with that stepcount.{c,h}> -I shim) into its own shared
 * library, because the upstream algorithm keeps its state in globals (one instance per process).
 *
 * Exports (the whole ABI that drift/targets/espruino_stepcount/target.py relies on):
 *   drift_abi()            -> 4
 *   drift_init()           reset the algorithm (stepcount_init) AND the file-scope gate state that 2v11+ stepcount_init()
 *                          does not reset (gate_open, active_sample_count), so a recording never sees its predecessor
 *   drift_flush_tail()     ACCELFILTER_TAP_NUM of this blob: the number of repeated samples upstream main.c appends to
 *                          flush the FIR (57 for 2v10, 7 for 2v11 and later); used by --flush to reproduce main.c
 *   drift_feed(mag2)       one 12.5 Hz sample, mag2 = x*x+y*y+z*z (int, 8192 = 1 g); returns the steps to add
 *   drift_run(xyz, n, ev, pk)
 *                          n samples of int16 x,y,z; returns the total; if ev != NULL, ev[i] = steps added by
 *                          sample i (the per-sample step events; sum(ev) == return value). The firmware adds
 *                          steps in bursts (e.g. 6 at once when a run of steps is confirmed), so ev[i] can be > 1.
 *                          if pk != NULL, pk[i] = 1 when sample i was a step-candidate peak that the algorithm
 *                          processed (the moment the credited step physically happened, before any retroactive
 *                          confirmation); for generations without a state machine every step is its own peak.
 *                          metrics.py uses it to put a burst of k steps back on the last k peaks.
 */
#include "stepcount.c"
#ifdef _WIN32
#define EXPORT __declspec(dllexport)
#else
#define EXPORT
#endif
EXPORT int drift_abi(void) { return 4; }
EXPORT int drift_flush_tail(void) { return ACCELFILTER_TAP_NUM; }
EXPORT void drift_init(void) {
  stepcount_init();
#ifdef T_MAX_STEP
  /* 2v11+: these two globals are not touched by stepcount_init(); zero them so results never depend on the
   * recording that ran before (the stepcount.c sources are included above, so the globals are visible here). */
  gate_open = false;
  active_sample_count = 0;
#endif
}
EXPORT int drift_feed(int accMagSquared) { return (int)stepcount_new(accMagSquared); }
EXPORT int drift_run(const short *xyz, int n, int *perSample, int *peak) {
  int total = 0;
  for (int i = 0; i < n; i++) {
    int x = xyz[3*i], y = xyz[3*i+1], z = xyz[3*i+2];
    int s = (int)stepcount_new(x*x + y*y + z*z);   /* same expression & int width as jswrap_bangle.c */
    if (perSample) perSample[i] = s;
#ifdef T_MAX_STEP
    /* state-machine generations (2v11+): stepLength is zeroed exactly when a peak was handed to the state machine */
    if (peak) peak[i] = (stepLength == 0);
#else
    /* 2v10: a step is reported at the moment of its (threshold-crossing) peak */
    if (peak) peak[i] = (s != 0);
#endif
    total += s;
  }
  return total;
}
