# Windows Runner - installer for Windows (PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/StepenkoAnatoli/WindowsRunner/main/install.ps1 | iex
#   .\install.ps1 [-NoStart]
#
# Override the clone source for forks/local testing:
#   $env:WINDOWS_RUNNER_REPO_URL = "https://github.com/you/WindowsRunner.git"
#
# Status: EXPERIMENTAL and untested (see docs/INSTALL.md). No Windows machine was
# available when this script was last changed, so it has no recorded smoke-test
# result. Prefer `npm install -g windows-runner` or `npx windows-runner`.

param(
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$RepoUrl = $env:WINDOWS_RUNNER_REPO_URL
if (-not $RepoUrl) { $RepoUrl = "https://github.com/StepenkoAnatoli/WindowsRunner.git" }

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
Write-Host "  Start:"
Write-Host "    npm start             → http://127.0.0.1:7634"
Write-Host "    npx windows-runner    → CLI from this checkout"
Write-Host "    wr                    → after 'npm install -g windows-runner'"
Write-Host ""

if ($NoStart) { exit 0 }

# Only prompt when a human is attached; `irm | iex` runs unattended.
if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
  $answer = Read-Host "  Start the server now? [Y/n]"
  if ($answer -notmatch "^[Nn]") { npm start }
} else {
  Write-Host "  Non-interactive shell: not starting the server. Run 'npm start' when ready."
}
