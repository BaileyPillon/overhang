@echo off
rem usage: build.bat   (builds all versions into harness\bin\)
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
set SRC=D:\Projects\overhang\drift\recon\dl\infinitime-src
set OUT=D:\Projects\overhang\drift\recon\harness\bin
if not exist %OUT% mkdir %OUT%
cd /d D:\Projects\overhang\drift\recon\harness
call :old 0.11.0 1
call :old 1.0.0 1
call :old 1.1.0 1
call :old 1.2.0 2
call :old 1.8.0 2
call :old 1.12.0 3
call :new 1.13.0
call :new 1.15.0
call :new 1.16.1
goto :eof

:old
rem MSVC x64 has no inline asm; <=1.1.0 Ppg.cpp has an asm("nop") debug leftover -> neutralised via macro, source untouched
if not exist %OUT%\obj_%1 mkdir %OUT%\obj_%1
cl /nologo /std:c++17 /O2 /EHsc /w /FI%SRC%\stubs\msvc_compat.h /DAPI=%2 /I%SRC%\stubs /I%SRC%\%1 /I%SRC%\%1\components\heartrate ppg_harness.cpp %SRC%\%1\components\heartrate\Ppg.cpp %SRC%\%1\components\heartrate\Biquad.cpp %SRC%\%1\components\heartrate\Ptagc.cpp /Fo%OUT%\obj_%1\ /Fe%OUT%\ppg_%1.exe || echo FAIL %1
goto :eof

:new
if not exist %OUT%\obj_%1 mkdir %OUT%\obj_%1
cl /nologo /std:c++17 /O2 /EHsc /w /DAPI=4 /FI%SRC%\stubs\msvc_compat.h /I%SRC%\stubs /I%SRC%\%1 /I%SRC%\%1\components\heartrate ppg_harness.cpp %SRC%\%1\components\heartrate\Ppg.cpp /Fo%OUT%\obj_%1\ /Fe%OUT%\ppg_%1.exe || echo FAIL %1
goto :eof
