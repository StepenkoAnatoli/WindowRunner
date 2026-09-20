# Windows Runner - installer for Windows (PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/StepenkoAnatoli/WindowRunner/main/install.ps1 | iex
#   .\install.ps1 [-NoStart]
#
# Override the clone source for forks/local testing:
#   $env:WINDOWS_RUNNER_REPO_URL = "https://github.com/you/WindowRunner.git"
#
# Status: EXPERIMENTAL (see docs/INSTALL.md). CI executes this script on Windows
# in checkout mode with -NoStart (gap G-06 lifecycle coverage); fresh-clone and
# interactive-prompt modes are untested. The packed
# `npm install -g windows-runner` / `npx windows-runner` alternative is NOT
# available either: the package declares no bin and is not published (gaps G-01
# and G-05). The clone + `npm run setup` flow below is the verified path (Linux).
#
# This installer sets up a source checkout and then offers to run `npm start`
# when a console is attached. -NoStart skips the offer; when no console is
# available (or the prompt fails) it prints the command instead of blocking.

param(
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$RepoUrl = $env:WINDOWS_RUNNER_REPO_URL
if (-not $RepoUrl) { $RepoUrl = "https://github.com/StepenkoAnatoli/WindowRunner.git" }

Write-Host ""
Write-Host "  ┌─────────────────────────────────────────┐"
Write-Host "  │  Windows Runner — installer (Windows)   │"
Write-Host "  └─────────────────────────────────────────┘"
Write-Host ""

# --- Prerequisites -----------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "  ✕ Node.js not found."
  Write-Host "    Install Node >= 20.10 (LTS) from https://nodejs.org, reopen the terminal, then re-run."
  exit 1
}

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
  Write-Host "  ✕ npm not found (it ships with Node >= 20.10)."
  Write-Host "    Reinstall Node from https://nodejs.org and re-run."
  exit 1
}

$nodeVersion = (node -v) -replace '^v',''
$parts = $nodeVersion.Split('.')
$major = [int]$parts[0]
$minor = [int]$parts[1]
if ($major -lt 20 -or ($major -eq 20 -and $minor -lt 10)) {
  Write-Host "  ✕ Node $nodeVersion is too old — Windows Runner needs >= 20.10."
  Write-Host "    Install a current release from https://nodejs.org and re-run."
  exit 1
}
Write-Host "  ✓ Node $nodeVersion"

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
  Write-Host "  ✕ git not found — it is required to download the source."
  Write-Host "    Install git from https://git-scm.com, or use 'npm install -g windows-runner' instead."
  exit 1
}

# --- Locate or clone a checkout ---------------------------------------------
# When run through `irm | iex`, $PSScriptRoot is empty; fall back to the shell's
# current directory and only treat it as a checkout if it really is one.
$Root = $PSScriptRoot
if (-not $Root) { $Root = (Get-Location).Path }

$InCheckout = $false
if ($Root) {
  $PackageJson = Join-Path $Root "package.json"
  if (Test-Path $PackageJson) {
    $content = Get-Content $PackageJson -Raw
    if ($content -match '"name"\s*:\s*"windows-runner"') { $InCheckout = $true }
  }
}

if ($InCheckout) {
  Set-Location -LiteralPath $Root
} else {
  $Target = if ($env:WINDOWS_RUNNER_HOME) { $env:WINDOWS_RUNNER_HOME } else { Join-Path $HOME "windows-runner" }
  if (Test-Path (Join-Path $Target ".git")) {
    Write-Host "  → Updating existing checkout at $Target…"
    Set-Location -LiteralPath $Target
    git pull --ff-only
  } else {
    Write-Host "  → Cloning to $Target…"
    git clone $RepoUrl $Target
    Set-Location -LiteralPath $Target
  }
}

Write-Host ""
Write-Host "  Installing dependencies and building (one time, ~30s)…"
$env:WINDOWS_RUNNER_SKIP_POSTINSTALL = "1"
npm run setup
if ($LASTEXITCODE -ne 0) {
  Write-Host "  ✕ Setup failed. Run 'npm install' and 'npm run build' to see the error."
  exit $LASTEXITCODE
}

Write-Host ""
Write-Host "  ✓ Installed in $(Get-Location)"
Write-Host ""
Write-Host "  Available now:"
Write-Host "    npm start             start the server on http://127.0.0.1:7634"
Write-Host "                          (offline mock provider, no tools — see docs/INSTALL.md)"
Write-Host "    npm test              run the test suite"
Write-Host "    npm run build         emit packages/*/dist"
Write-Host "    npm run smoke:packed  verify the packed artifact"
Write-Host "    npm run smoke:start   boot the built server and run a turn against it"
Write-Host ""
Write-Host "  Not available yet (see docs/INSTALL.md):"
Write-Host "    npx windows-runner    no bin, package unpublished (gaps G-01, G-05)"
Write-Host "    docker compose up     dist/ is not self-contained (gaps G-03, G-04)"
Write-Host ""

if ($NoStart) { exit 0 }

# Only prompt when someone can answer; under automation, print the command.
$answer = $null
if ([Environment]::UserInteractive) {
  try {
    $answer = Read-Host "  Start the server now? [Y/n]"
  } catch {
    $answer = $null
  }
}

if ($null -eq $answer) {
  Write-Host "  To start the server: cd '$(Get-Location)'; npm start"
  exit 0
}

if ($answer -match '^(n|no)$') {
  Write-Host "  Run 'npm start' when you are ready."
  exit 0
}

Write-Host ""
npm start
exit $LASTEXITCODE
