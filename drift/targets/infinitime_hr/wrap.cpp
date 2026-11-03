// Drift wrapper for InfiniTime's heart-rate algorithm (src/components/heartrate/Ppg.{h,cpp}).
//
// Compiled once per distinct algorithm blob set into its own shared library.  The same source builds every release
// from 0.11.0 to 1.16.1: the three API eras are told apart at compile time with traits (no per-version macro):
//   0.11.0 - 1.1.0   explicit Ppg(float), SetOffset(uint16_t), Reset(), Preprocess(float)    (autocorrelation, "gen A")
//   1.2.0  - 1.12.0  Ppg(),               SetOffset(uint16_t), Reset(), Preprocess(float)    (autocorrelation, "gen A")
//   1.13.0 - 1.16.1  Ppg(),               Reset(bool), Preprocess(hrs, als)                  (FFT, "gen B")
//
// Exports (the whole ABI that drift/targets/infinitime_hr/target.py relies on):
//   drift_abi()            -> 3
//   drift_rate_hz()        the sampling rate the algorithm assumes: 24 Hz (gen A, 60*24*4/lag), 10 Hz (gen B, 100 ms)
//   drift_init(first)      fresh Ppg; gen A is primed with SetOffset(first sample) like HeartRateTask::Work() does
//   drift_run(hrs, als, n, ret, shown)
//                          n raw HRS3300 counts (als may be NULL = ambient 0).  ret[i] = Ppg::HeartRate() after
//                          sample i (>0 bpm, 0 = nothing yet, -1 = reset request, -2 = not enough data, 1.16.0+);
//                          shown[i] = the value the watch face would show (last non-zero bpm; cleared on a reset),
//                          mirroring the HeartRateTask branches of 1.13-1.15.  Returns the number of positive ret.
//
// HeartRateTask itself (FreeRTOS timing, background measurement of 1.16) is NOT replayed: algorithm layer only.
#include <cstdint>
#include <memory>
#include <type_traits>
#include <utility>

#include "components/heartrate/Ppg.h"

#ifdef _WIN32
#define EXPORT extern "C" __declspec(dllexport)
#else
#define EXPORT extern "C"
#endif

using Pinetime::Controllers::Ppg;

template <class T, class = void> struct has_reset_bool : std::false_type {};
template <class T> struct has_reset_bool<T, std::void_t<decltype(std::declval<T&>().Reset(true))>> : std::true_type {};

template <class T, class = void> struct has_two_arg_preprocess : std::false_type {};
template <class T>
struct has_two_arg_preprocess<T, std::void_t<decltype(std::declval<T&>().Preprocess(uint16_t{}, uint16_t{}))>>
    : std::true_type {};

// Everything that differs between API eras lives in templates on P, so the branch that does not apply to the
// release being compiled is discarded instead of instantiated (if constexpr only discards inside templates).
template <class P> constexpr bool is_frequency_v = has_reset_bool<P>::value && has_two_arg_preprocess<P>::value;

static constexpr bool kFrequencyAlgorithm = is_frequency_v<Ppg>;

static std::unique_ptr<Ppg> g_ppg;

template <class P> static std::unique_ptr<P> make_t(int first) {
  if constexpr (is_frequency_v<P>) {
    auto p = std::make_unique<P>();
    p->Reset(true);
    (void) first;
    return p;
  } else if constexpr (std::is_default_constructible_v<P>) {
    auto p = std::make_unique<P>();
    p->SetOffset(static_cast<uint16_t>(first));
    return p;
  } else {
    auto p = std::make_unique<P>(static_cast<float>(first));
    p->SetOffset(static_cast<uint16_t>(first));
    return p;
  }
}

static std::unique_ptr<Ppg> make(int first) { return make_t<Ppg>(first); }

template <class P> static int run_t(P& ppg, const int32_t* hrs, const int32_t* als, int n, int32_t* ret, int32_t* shown) {
  int last_bpm = 0, positives = 0;
  for (int i = 0; i < n; i++) {
    int r;
    if constexpr (is_frequency_v<P>) {
      // HeartRateTask 1.13-1.15: ambient-light jump or a -1 from the algorithm resets acquisition
      int8_t ambient = ppg.Preprocess(static_cast<uint16_t>(hrs[i]), static_cast<uint16_t>(als ? als[i] : 0));
      r = ppg.HeartRate();
      int bpm = r;
      if (ambient > 0) {
        ppg.Reset(true);
        last_bpm = 0;
        bpm = 0;
      } else if (bpm == -1) {
        ppg.Reset(false);
        bpm = 0;
        last_bpm = 0;
      } else if (bpm == -2) {
        bpm = 0;
      }
      if (bpm != 0) last_bpm = bpm;
    } else {
      ppg.Preprocess(static_cast<float>(hrs[i]));
      r = static_cast<int>(ppg.HeartRate());
      if (r != 0) last_bpm = r;
    }
    if (r > 0) positives++;
    if (ret) ret[i] = r;
    if (shown) shown[i] = last_bpm;
  }
  return positives;
}

EXPORT int drift_abi(void) { return 3; }
EXPORT double drift_rate_hz(void) { return kFrequencyAlgorithm ? 10.0 : 24.0; }
EXPORT void drift_init(int first) { g_ppg = make(first); }

EXPORT int drift_run(const int32_t* hrs, const int32_t* als, int n, int32_t* ret, int32_t* shown) {
  if (!g_ppg) g_ppg = make(n > 0 ? hrs[0] : 0);
  return run_t<Ppg>(*g_ppg, hrs, als, n, ret, shown);
}
