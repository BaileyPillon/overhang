// Drift/InfiniTime host harness. Build per release with -DAPI=1..4 (see build.bat).
// stdin or argv[1]: one raw HRS3300 count per line (optional 2nd column = ALS count).
// stdout: "idx,ret,bpm_shown" per input sample. ret = value returned by Ppg::HeartRate();
// bpm_shown mimics HeartRateTask (last non-zero bpm; 0 until first valid).
#include <cstdio>
#include <cstdlib>
#include <vector>
#include "components/heartrate/Ppg.h"
using namespace Pinetime::Controllers;

int main(int argc, char** argv) {
  std::vector<double> hrs, als;
  FILE* f = argc > 1 ? fopen(argv[1], "r") : stdin;
  if (!f) return 2;
  char line[256];
  while (fgets(line, sizeof line, f)) {
    double a = 0, b = 0;
    int n = sscanf(line, "%lf,%lf", &a, &b);
    if (n < 1) continue;
    hrs.push_back(a);
    als.push_back(n > 1 ? b : 0);
  }
  if (hrs.empty()) return 3;
  int lastBpm = 0;
#if API == 1          // <=1.1.0: Ppg(float spl), SetOffset
  Ppg ppg(static_cast<float>(hrs[0]));
  ppg.SetOffset(static_cast<uint16_t>(hrs[0]));
#elif API == 2 || API == 3   // 1.2.0-1.12.0: Ppg(), SetOffset
  Ppg ppg;
  ppg.SetOffset(static_cast<uint16_t>(hrs[0]));
#else                 // >=1.13.0: frequency algorithm
  Ppg ppg;
  ppg.Reset(true);
#endif
  for (size_t i = 0; i < hrs.size(); i++) {
    int ret;
#if API <= 3
    ppg.Preprocess(static_cast<float>(hrs[i]));
    ret = static_cast<int>(ppg.HeartRate());
    if (ret != 0) lastBpm = ret;
#else
    // mirrors HeartRateTask::HandleSensorData / Work() of 1.13-1.15 (1.16 adds -2 "not enough data")
    int8_t ambient = ppg.Preprocess(static_cast<uint16_t>(hrs[i]), static_cast<uint16_t>(als[i]));
    ret = ppg.HeartRate();
    int bpm = ret;
    if (ambient > 0) { ppg.Reset(true); lastBpm = 0; bpm = 0; }
    else if (bpm == -1) { ppg.Reset(false); bpm = 0; lastBpm = 0; }
    else if (bpm == -2) { bpm = 0; }
    if (bpm != 0) lastBpm = bpm;
#endif
    printf("%zu,%d,%d\n", i, ret, lastBpm);
  }
  return 0;
}
