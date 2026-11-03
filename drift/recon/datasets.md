# Drift recon: datasets (key: datasets), 2026-11-03

Downloaded under D:\Projects\overhang\drift\recon\dl\datasets\ (untrusted data, parsed only with venv python -I).

## (a) Wrist accelerometer + ground-truth steps

### A1. Bangle.js / Espruino step-count test data (RECOMMENDED #1 for Drift; same firmware family)
- Repo: https://github.com/gfwilliams/step-count, commit d4b015c09483ff671f5b3998b2aefdfe67ac27e6 (2022-01-25), master. Cloned to dl\datasets\bangle-step-count\
- License: NONE in repo (GitHub license=null), so all rights reserved by default. Data are forum-contributed Bangle.js logs (http://forum.espruino.com/conversations/359542). Fine for private recon/testing; do not redistribute in Drift's repo without asking gfwilliams / contributors. Espruino itself is MPL-2.0.
- Data: data\*.csv, 36 files, 18 MB, 741,761 samples = 16.5 h. Header "Time (ms),X,Y,Z", int16 raw counts, 8192 = 1 g (mean |a| about 8300 at rest), dt = 80 ms exactly = 12.5 Hz. This is exactly the input of Espruino libs/misc/stepcount.c (the repo's main.c does `#include "../Espruino/libs/misc/stepcount.c"` and feeds short x,y,z).
- Sensor: Bangle.js on wrist; mostly one subject (HughB), plus a few others (Guillaume_G, Pablo, cartron, d3nd3-o0, MrPloppy, 100*.csv "150 paces" tests).
- Ground truth: WEAK. Only a per-file total in the filename / main.c EXPECTED_STEPS (HughB-walk-6605 = 6605, walk-2350 = 2350, walk-a3070-b3046 = 3070, walk-a10021-b10248 = 10021, drive-* about 0, nosteps/static = 0, work-66 = 66, mixed-390, general-a260-b573 = 260, housework-a958-b2658 = 958). No per-step timestamps, no running, essentially one main subject. Ideal for the Espruino-version differential (stepcount.c across Espruino firmware tags) because it is native format and rate; weak as an independent accuracy reference.
- Download: `git clone https://github.com/gfwilliams/step-count.git` (no login).
- Parse check: np.loadtxt(csv, delimiter=',', skiprows=1) OK for all 36 files, median dt 80.0 ms.

### A2. Clemson Pedometer Evaluation Project (RECOMMENDED #2; best ground truth that is downloadable)
- Page: https://cecas.clemson.edu/~ahoover/pedometer/ (Mattfeld, Jesch, Hoover; IEEE BIBM 2017; Sensors 21(13):4260, 2021)
- License: none stated on the page (public download, papers to be cited). Treat as free to use with citation; redistribution unconfirmed.
- Direct files, no login:
  - https://cecas.clemson.edu/tracking/Pedometer/Data.zip, 31,661,301 B (synced + resampled) DOWNLOADED
  - https://cecas.clemson.edu/tracking/Pedometer/demographics.csv, 900 B DOWNLOADED
  - https://cecas.clemson.edu/tracking/Pedometer/RawData.zip, 289,715,185 B (original unsynced accel+gyro+mag; not downloaded, just under 300 MB)
  - https://cecas.clemson.edu/tracking/Pedometer/Videos.zip, 11.7 GB (not needed)
- Local: dl\datasets\clemson\Data.zip, extracted to dl\datasets\clemson\Data\Pxxx\{Regular,SemiRegular,Irregular}\{Pxxx_*.txt, steps.txt}
- Content: 30 subjects x 3 gait types = 90 recordings, 951,425 rows = 17.6 h at exactly 15 Hz. Data file: 9 whitespace-separated columns in g (wrist xyz, hip xyz, ankle xyz; wrist |a| about 1.06 g). steps.txt: "<row index> left|right" per step, video-annotated; 60,801 steps total (page says 60,805). Walking only, no running.
- Quirks: P010_Regular and P019_Irregular have a few step indices past end of data (9233 > 9192 rows, 10092 > 9968 rows): clip. 15 Hz is not the Bangle native rate (12.5 Hz), so resample (already smoothed by the project's resampling).
- Parse check: np.loadtxt on all 90 data files OK, 9 columns each; steps parse as "idx side".

### A3. OxWalk (Oxford, OxWearables) (best in principle; NOT downloaded)
- Record: https://ora.ox.ac.uk/objects/uuid:19d3cb34-e2b3-4177-91b6-1bad0e0163e7, DOI 10.5287/bodleian:ORQ2abnbR (Small, von Fritsch, Doherty, Khalid, Price, 2022; used by https://github.com/OxWearables/stepcount).
- Content (secondary sources only): 39 participants aged 19-81, free-living, 4 Axivity AX3 (2 dominant wrist, 2 dominant hip), CSV per recording with a step column ("1" at approx heel strike, from synchronized video), README.txt in the download. Sample rate and size NOT verified. Terms: "free to download and use" (license id unverified).
- BLOCKER: ora.ox.ac.uk answers curl with HTTP 403 and a Cloudflare "Just a moment" bot challenge. I did not try to bypass it. A human must download in a browser and drop it in dl\datasets\oxwalk\. The stepcount repo does not mirror the data.

### A4. Others checked
- Clemson All-Day Dataset (CAD), https://cecas.clemson.edu/ahoover/allday: 351 people, wrist accel/gyro/mag all day, but labels are eating episodes. No step ground truth. Not useful.
- WISDM Smartphone and Smartwatch Activity and Biometrics (UCI 507, CC BY 4.0, 295.4 MB zip, https://archive.ics.uci.edu/static/public/507/wisdm+smartphone+and+smartwatch+activity+and+biometrics+dataset.zip): 51 subjects, 18 activities x 3 min, watch accel+gyro at 20 Hz. Activity labels (walking, jogging, stairs) but no step counts. Fallback only; not downloaded.
- PhysioNet wrist (below) has walk/run accel but no step labels.

## (b) Wrist PPG (+accel) with ground-truth HR

### B1. PhysioNet "Wrist PPG During Exercise" v1.0.0 (RECOMMENDED #1 for HR; raw, small, ODC-BY)
- https://physionet.org/content/wrist/1.0.0/ (Jarchi and Casson, Data 2017, 2(1):1, doi:10.3390/data2010001)
- License: Open Data Commons Attribution v1.0 (redistributable with attribution). 49.8 MB, 19 records.
- Local: dl\datasets\physionet-wrist\ (60 files: 19 x .hea/.dat/.atr plus ANNOTATORS, RECORDS, SHA256SUMS.txt). All SHA256 verified OK.
- Format: WFDB, 15 interleaved int16 signals at 256 Hz: chest_ecg, wrist_ppg, wrist_gyro_xyz, wrist_low_noise_accelerometer_xyz, wrist_wide_range_accelerometer_xyz, wrist_mag_xyz, sample_times. Header holds gain/baseline. Reference = hand-annotated ECG R-peaks in .atr (annotation code 1); median HR from them parsed OK (57 to 175 bpm).
- 8 subjects (s1-s6, s8, s9); walk, run, low/high-resistance bike; 3.7 to 9.8 min per record. Sensor = Shimmer3 GSR+ optical PPG on the left wrist (not a smartwatch PPG chip). Walk/run PPG is unfiltered beyond hardware; cycling PPG was 15 Hz low-passed. Needs resampling/requantisation to the target device's PPG rate and ADC range.
- Download (no login): per record `curl -O https://physionet.org/files/wrist/1.0.0/<rec>.{hea,dat,atr}` (list in RECORDS), or `wget -r -N -c -np https://physionet.org/files/wrist/1.0.0/`, or `aws s3 sync --no-sign-request s3://physionet-open/wrist/1.0.0/ DEST`. (No wget in this Git Bash; curl worked.)
- Parse: wfdb is NOT in the venv (nor pandas; numpy and scipy are). I parsed with numpy: np.fromfile(dat, '<i2').reshape(-1, 15); .atr = 16-bit words, code = w>>10, delta = w&1023, SKIP code 59 followed by 2 words, code 1 = beat. Or `pip install wfdb`.

### B2. IEEE SP Cup 2015 via Monash "IEEEPPG" (Zenodo 3902710) (RECOMMENDED #2; standard HR benchmark)
- https://zenodo.org/records/3902710, DOI 10.5281/zenodo.3902710, CC BY 4.0 on Zenodo. Original terms: free for the SP Cup or own academic research with citation (Zhang, Pi, Liu, TROIKA, IEEE TBME 62(2):522-531, 2015). Original raw set: http://www.zhilinzhang.com/spcup2015/ (not fetched).
- Direct files: https://zenodo.org/api/records/3902710/files/IEEEPPG_TRAIN.ts/content (81,417,396 B) and .../IEEEPPG_TEST.ts/content (60,248,857 B). BOTH DOWNLOADED to dl\datasets\ieeeppg\ (141.7 MB).
- Format: sktime .ts text; per line 5 channels separated by ':' then HR label; 1000 samples per channel = 8 s windows at 125 Hz (2 s shift, overlapping). Channels PPG1, PPG2 (green), accX, accY, accZ; label = HR in bpm from ECG. TRAIN 1768 windows, TEST 1328. 12 subjects on a treadmill (sources disagree between 12 and 23 subjects).
- CAVEATS: preprocessed and windowed. PPG mean about 0 and std about 38 (DC/band-pass already removed); accel roughly in g (std about 0.4). Continuous record reconstruction (taking each window's last 2 s) is unverified. Not suitable if the firmware under test needs raw ADC with DC offset.
- Parse check: both files parse, 1768 + 1328 windows, 5 x 1000 each.

### B3. PPG-DaLiA (UCI 495 / Zenodo 3902728) (NOT downloaded: too big)
- https://archive.ics.uci.edu/dataset/495/ppg+dalia, DOI 10.24432/C53890, CC BY 4.0, 2.7 GB zip (https://archive.ics.uci.edu/static/public/495/ppg+dalia.zip; a range request hung past 120 s, so partial per-subject fetch is not available). 15 subjects, Empatica E4 wrist BVP 64 Hz + ACC 32 Hz (+EDA/TEMP 4 Hz), RespiBAN chest 700 Hz; HR label from ECG. Daily-life activities (driving, cycling, stairs, walking, table soccer, lunch, working).
- Zenodo Monash mirror https://zenodo.org/records/3902728 (CC BY 4.0): PPGDalia_TEST.ts 212,538,529 B and PPGDalia_TRAIN.ts 423,905,299 B, 64,700 windows x 4 dims, pre-windowed. TEST is under 300 MB but pre-windowed and not a raw feed; not fetched.
- Best-quality choice if size is no object (real watch-class PPG chip, 64 Hz, 15 subjects).

### B4. Others
- WESAD: E4 wrist BVP 64 Hz / ACC 32 Hz, 15 subjects, about 3.5 GB (secondhand); official host and license not verified. Skipped.
- PhysioNet "Wearable Exam Stress" (ODC-BY): HR comes from the E4's own estimate, not ground truth. Skipped.

## Ranked recommendation
(a) Steps: 1) Bangle.js step-count repo (native Espruino rate/units, 16.5 h, trivial to feed; weak per-file totals, no license so keep local), 2) Clemson Data.zip (30 subjects, per-step video GT, 15 Hz, walking only; resample to 12.5 Hz), 3) OxWalk (best but Cloudflare-blocked, needs a human download), 4) WISDM (no step GT).
(b) HR: 1) PhysioNet wrist (raw 256 Hz PPG+accel, ECG R-peaks, ODC-BY, 50 MB), 2) IEEEPPG / SPC 2015 (8 s windows, 125 Hz, HR labels, preprocessed), 3) PPG-DaLiA (2.7 GB, deliberate big download).
