@echo off
rem usage: build.bat   (builds all versions into harness\bin\; works from any directory)
rem Needs the MSVC x64 compiler (cl.exe): run it from an "x64 Native Tools Command Prompt for VS", or set VCVARS to the
rem full path of vcvars64.bat (VS 2022 Community default: <Program Files>\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat).
rem Needs the InfiniTime source in ..\dl\infinitime-src (downloaded during the recon, gitignored).
where $PATH:cl.exe >nul 2>&1 || if defined VCVARS call "%VCVARS%" >nul 2>&1
where $PATH:cl.exe >nul 2>&1 || (echo cl.exe not found: use an x64 Native Tools prompt or set VCVARS to vcvars64.bat & exit /b 1)
rem all paths below derive from this script's folder, so the clone can live anywhere (absolute, because cl resolves /FI against the source file, not the cwd)
cd /d "%~dp0"
for %%I in ("%~dp0..\dl\infinitime-src") do set "SRC=%%~fI"
set "OUT=%~dp0bin"
if not exist "%OUT%" mkdir "%OUT%"
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
if not exist "%OUT%\obj_%1" mkdir "%OUT%\obj_%1"
cl /nologo /std:c++17 /O2 /EHsc /w /FI"%SRC%\stubs\msvc_compat.h" /DAPI=%2 /I"%SRC%\stubs" /I"%SRC%\%1" /I"%SRC%\%1\components\heartrate" ppg_harness.cpp "%SRC%\%1\components\heartrate\Ppg.cpp" "%SRC%\%1\components\heartrate\Biquad.cpp" "%SRC%\%1\components\heartrate\Ptagc.cpp" /Fo"%OUT%\obj_%1/" /Fe"%OUT%\ppg_%1.exe" || echo FAIL %1
goto :eof

:new
if not exist "%OUT%\obj_%1" mkdir "%OUT%\obj_%1"
cl /nologo /std:c++17 /O2 /EHsc /w /DAPI=4 /FI"%SRC%\stubs\msvc_compat.h" /I"%SRC%\stubs" /I"%SRC%\%1" /I"%SRC%\%1\components\heartrate" ppg_harness.cpp "%SRC%\%1\components\heartrate\Ppg.cpp" /Fo"%OUT%\obj_%1/" /Fe"%OUT%\ppg_%1.exe" || echo FAIL %1
goto :eof
