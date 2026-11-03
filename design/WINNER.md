# What gets built, and why

Decided 2026-11-03 by the lead session. Bailey asked to be surprised, so the pick was the lead session's to make.

## The hole

**material = consumer-device firmware or hardware × for = researchers or science.**

- **Pooled data, N = 1,563.** Observed 0. E is 10.5 under quasi-independence and 14.0 under plain independence. Pooled q = 0.003, bootstrap stability 0.89, tag-robust.
- **Pre-registered test.** The pre-registered verdict is **underpowered**: the new blind sample had 0 observed with E_new = 1.5 under quasi, which is below the E ≥ 2 bar. Under plain independence the new sample alone gives E_new = 9.5 with 0 observed, q < 0.001, so it replicates. Under quasi at z = 4 or 5 it stays underpowered. Both are reported, and the official verdict stays as pre-registered.
- **Tagging audit.** Three auditors gave hole_weakened (strict), hole_refuted (lenient) and hole_weakened (adversarial). Reverse-engineering of *scientific-grade instruments* for research does exist: g-revenge-046 (a proprietary imaging-station camera) and g-revenge-007 (a lab instrument's raw data format). The vocabulary files those under "molecules and lab experiments". No report applies Claude to *consumer-grade* devices (wearables, phones, cheap gadgets) for research. Honest scope: **consumer hardware in research.**
- **What's on either side.** 116 firmware hacks: 106 for the self, 5 for the public, 3 for a child, 2 for family, 0 for science. 188 research uses spread across codebases, robots, games and text, but never consumer devices.

## The pick: Drift, firmware forensics for science (from concept H1-c1)

Consumer wearables are used as research instruments, and vendors change their step, heart-rate and sleep algorithms in firmware updates, which can make cohort data from before and after an update non-comparable. The literature argues the risk rather than measuring it: Collins et al. 2019 (Sensors 19(7):1705) argue that validity is not maintained when updates change device performance and recommend version reporting (their own experiment tested a single firmware version), and Woolley et al. 2019 (BMJ Health Care Inform 26(1):e100083) found that 32% of 194 changelog items across six trackers could affect validation. Neither measures an update's effect on a metric; that is what Drift's own differential runs do. (The 2017 BJSM blog post "Not all steps are equal", Alharbi et al., is about a Fitbit change in how moderate-to-vigorous activity minutes are counted in 10-minute bouts; it is a blog post, not a study of step or firmware drift, and is not used as support.) Drift:

1. Takes two or more firmware versions of an **open-source** wearable (Bangle.js / Espruino, PineTime / InfiniTime). The firmware is open source; the recordings are third-party data that are fetched from their owners, cited and never redistributed.
2. Locates the code on the metric path, from sensor input to reported metric, and shows what changed.
3. Runs **differential execution**: it compiles the metric algorithm from each version for the host and feeds every version the *same recorded raw sensor data*, so the effect is a measured number, not a guess.
4. Writes a dated **data-validity memo** for a research team: which date ranges are not comparable, by how much, and a suggested sensitivity check.

**Why this one over the judges' top scorers:**
- It sits in the only hole with strong statistical support.
- It answers a documented scientific problem.
- It's software-only on public firmware.
- It produces hard numbers a viewer can check.
- It bridges the video's device hacking and science, which are exactly the two coastlines the data says never meet.

The alternatives:
- **H5-c2, family recipe reconciliation:** close prior art exists (Heirloom AI, Achiote).
- **H4-c3, dead-server resurrection:** strong product prior art (wire-pod, TeddyCloud) and a 30-hour build behind a mocked demo.
- **H2-c2, game-balance spreadsheet lift:** the most novel concept in embedding space (99th percentile in both models), but its hole is weak under quasi-independence (q = 0.29). It's listed in the app as the runner-up.

## Honesty requirements

- Drift's own prior art gets checked again in its refined form (differential execution), and the result is reported.
- Every number Drift reports comes from a script in the repo that anyone can rerun.
- If differential execution turns out infeasible for a given algorithm, say so, and fall back to a static diff clearly labeled as such.
