/* Portions of this file are taken from Espruino (https://github.com/espruino/Espruino), libs/banglejs/jswrap_bangle.c
 * at RELEASE_2V09, licensed under the Mozilla Public License 2.0 (https://mozilla.org/MPL/2.0/).
 * Copyright (c) Gordon Williams and Espruino contributors. The transcribed lines (the step-counter thresholds and the
 * hysteresis in drift_feed) remain under MPL-2.0; the rest of this file is part of Drift (MIT). See NOTICE.md. */
/* Drift: Bangle.js firmware <= 2v09 step counter (no stepcount.c yet), transcribed verbatim from
 * jswrap_bangle.c (RELEASE_2V09 lines ~499-501 and 917-922): hysteresis on x*x+y*y+z*z around 1 g (+-80 counts).
 * Same exported ABI as wrap.c (drift_abi/drift_init/drift_feed/drift_run with per-sample step events and peaks). */
#include <stdbool.h>
#ifdef _WIN32
#define EXPORT __declspec(dllexport)
#else
#define EXPORT
#endif
static int stepCounterThresholdLow = (8192-80)*(8192-80);
static int stepCounterThresholdHigh = (8192+80)*(8192+80);
static bool stepWasLow = false;
static unsigned stepCounter = 0;
EXPORT int drift_abi(void) { return 4; }
EXPORT int drift_flush_tail(void) { return 7; }   /* upstream main.c, built against any 2v11+ stepcount.c, appends 7 samples */
EXPORT void drift_init(void) { stepWasLow = false; stepCounter = 0; }
EXPORT int drift_feed(int accMagSquared) {
  int r = 0;
  if (accMagSquared < stepCounterThresholdLow) stepWasLow = true;
  else if ((accMagSquared > stepCounterThresholdHigh) && stepWasLow) { stepWasLow = false; stepCounter++; r = 1; }
  return r;
}
EXPORT int drift_run(const short *xyz, int n, int *perSample, int *peak) {
  int total = 0;
  for (int i = 0; i < n; i++) {
    int x = xyz[3*i], y = xyz[3*i+1], z = xyz[3*i+2];
    int s = drift_feed(x*x + y*y + z*z);
    if (perSample) perSample[i] = s;
    if (peak) peak[i] = s;      /* each counted step is its own peak */
    total += s;
  }
  return total;
}
