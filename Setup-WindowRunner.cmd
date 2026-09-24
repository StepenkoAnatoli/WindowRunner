@echo off
rem WindowRunner - one-time setup for Windows.
rem
rem Double-click this file. It checks that Node.js 22 or newer is installed and
rem then runs `npm run setup` (install dependencies, typecheck, build) - the same
rem verified path install.ps1 and CI use. Nothing here starts the app; that is
rem Start-WindowRunner.cmd.
rem
rem Usage:
rem   Setup-WindowRunner.cmd              normal double-click use (waits for a key at the end)
rem   Setup-WindowRunner.cmd -NoPause     automation/CI: never waits for a keypress
rem
rem Encoding rules (pinned by packages/server/test/packaging.test.ts): plain
rem ASCII, CRLF line endings, NO byte-order mark - a BOM makes cmd.exe try to
rem execute the first line and fail before this script starts.
setlocal EnableExtensions
cd /d "%~dp0"
title WindowRunner - Setup

set "NOPAUSE="
if /i "%~1"=="-NoPause" set "NOPAUSE=1"

echo ============================================================
echo   WindowRunner - one-time setup
echo ============================================================
echo.
echo This window prepares WindowRunner for you. It takes about a
echo minute and you only have to do it once.
echo.

rem ---- 1. Is Node.js installed and new enough? ------------------------------
where node >nul 2>nul
if errorlevel 1 goto no_node

for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
node -e "process.exit(parseInt(process.versions.node, 10) >= 22 ? 0 : 1)"
if errorlevel 1 goto old_node
echo [1/2] Node.js %NODE_VERSION% is installed. OK

rem ---- 2. Install everything and build -------------------------------------
echo [2/2] Downloading and building WindowRunner. Please wait...
echo.
call npm run setup
if errorlevel 1 goto failed

echo.
echo ============================================================
echo   Setup finished - WindowRunner is ready to use.
echo ============================================================
echo.
echo To start it, double-click:  Start-WindowRunner.cmd
echo.
call :finish
endlocal
exit /b 0

:no_node
echo ------------------------------------------------------------
echo   Node.js is not installed yet
echo ------------------------------------------------------------
echo.
echo WindowRunner needs Node.js 22 (free). It installs like any
echo other Windows program: Next, Next, Finish.
echo.
echo Step 1: this window is opening the download page for you.
echo Step 2: on that page choose the button that says "LTS".
echo Step 3: open the downloaded installer, click Next until Finish.
echo Step 4: double-click Setup-WindowRunner.cmd again.
echo.
if not defined NOPAUSE start "" "https://nodejs.org/en/download"
call :finish
endlocal
exit /b 1

:old_node
echo ------------------------------------------------------------
echo   Your Node.js is too old
echo ------------------------------------------------------------
echo.
echo Found %NODE_VERSION%. WindowRunner needs Node.js 22 or newer.
echo.
echo Step 1: this window is opening the download page for you.
echo Step 2: install the "LTS" version, then double-click
echo         Setup-WindowRunner.cmd again.
echo.
if not defined NOPAUSE start "" "https://nodejs.org/en/download"
call :finish
endlocal
exit /b 1

:failed
echo ------------------------------------------------------------
echo   Setup did not finish
echo ------------------------------------------------------------
echo.
echo Scroll up to the last message that mentions an error.
echo The two usual causes are:
echo   - no internet connection while downloading the pieces
echo   - antivirus software blocking files in this folder
echo.
echo If it still fails, open a GitHub issue and paste the messages:
echo   https://github.com/StepenkoAnatoli/WindowRunner/issues
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
