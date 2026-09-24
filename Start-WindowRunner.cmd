@echo off
rem WindowRunner - start the app.
rem
rem Double-click this file after Setup-WindowRunner.cmd has run once. It runs
rem `npm start`, the same command docs/INSTALL.md verifies. The console window
rem must stay open while you use the app.
rem
rem Usage:
rem   Start-WindowRunner.cmd              normal double-click use (waits for a key at the end)
rem   Start-WindowRunner.cmd -NoPause     automation/CI: never waits for a keypress
rem
rem Encoding rules (pinned by packages/server/test/packaging.test.ts): plain
rem ASCII, CRLF line endings, NO byte-order mark.
setlocal EnableExtensions
cd /d "%~dp0"
title WindowRunner

set "NOPAUSE="
if /i "%~1"=="-NoPause" set "NOPAUSE=1"

if not exist "package.json" goto wrong_folder
where node >nul 2>nul
if errorlevel 1 goto no_node
if not exist "node_modules" goto needs_setup

echo ============================================================
echo   Starting WindowRunner
echo ============================================================
echo.
echo Leave this window open while you use WindowRunner.
echo.
echo Below you will see a line that starts with  ui:
echo Hold the Ctrl key and click that address to open the app.
echo.
echo To stop WindowRunner: close this window or press Ctrl+C.
echo.
call npm start

echo.
echo WindowRunner has stopped.
call :finish
endlocal
exit /b 0

:needs_setup
echo ------------------------------------------------------------
echo   WindowRunner is not set up yet
echo ------------------------------------------------------------
echo.
echo Step 1: double-click  Setup-WindowRunner.cmd  (one time only)
echo Step 2: double-click  Start-WindowRunner.cmd  again
echo.
call :finish
endlocal
exit /b 1

:no_node
echo ------------------------------------------------------------
echo   Node.js is missing
echo ------------------------------------------------------------
echo.
echo WindowRunner needs Node.js 22 or newer. Install the "LTS"
echo version from https://nodejs.org, then run
echo Setup-WindowRunner.cmd and try again.
echo.
call :finish
endlocal
exit /b 1

:wrong_folder
echo ------------------------------------------------------------
echo   Wrong folder
echo ------------------------------------------------------------
echo.
echo Please keep Start-WindowRunner.cmd inside the WindowRunner
echo folder - the one that also contains package.json.
echo.
call :finish
endlocal
exit /b 1

rem Pause so a double-clicked window cannot vanish before it can be read.
rem -NoPause skips it, which is how CI drives this script.
:finish
if defined NOPAUSE goto :eof
pause
goto :eof
