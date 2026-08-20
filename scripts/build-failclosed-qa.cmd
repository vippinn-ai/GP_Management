@echo off
setlocal
set "VITE_QA_NORMALIZED_READ_FAILURES=true"
set "VITE_QA_FAIL_CLOSED_BUILD_ID=release-a-failclosed-qa-v1"
call ".\node_modules\.bin\tsc.cmd" -b
if errorlevel 1 exit /b 1
call ".\node_modules\.bin\vite.cmd" build --mode staging --configLoader runner
if errorlevel 1 exit /b 1
endlocal
