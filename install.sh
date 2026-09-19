#!/usr/bin/env bash
set -e

# Windows Runner — installer for Unix-like systems.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/StepenkoAnatoli/WindowsRunner/main/install.sh | bash
#   ./install.sh [--no-start]
#
# Override the clone source for forks/local testing:
#   WINDOWS_RUNNER_REPO_URL=https://github.com/you/WindowsRunner.git ./install.sh
#
# Status: this path is *experimental* (see docs/INSTALL.md). It has been run on
# Linux against a local checkout; macOS is untested. Prefer
# `npm install -g windows-runner` or the clone + `npm run setup` flow.

REPO_URL="${WINDOWS_RUNNER_REPO_URL:-https://github.com/StepenkoAnatoli/WindowsRunner.git}"

# `bash install.sh --no-start`
NO_START=0
for arg in "$@"; do
  case "$arg" in
    --no-start) NO_START=1 ;;
    -h|--help)
      echo "usage: install.sh [--no-start]"
      exit 0
      ;;
  esac
done

# When this script is piped (`curl … | bash`) from a non-interactive context,
# $0 is "bash" and BASH_SOURCE is unset: treat it as "not inside a checkout".
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT_PATH" ] && [ -f "$SCRIPT_PATH" ]; then
  ROOT="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
else
  ROOT=""
fi

echo ""
echo "  ┌─────────────────────────────────────────┐"
echo "  │  windows-runner — installer (Unix)      │"
echo "  └─────────────────────────────────────────┘"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  ✕ Node.js not found."
  echo "    Install Node >= 20.10 from https://nodejs.org and re-run this script."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "  ✕ npm not found (it ships with Node >= 20.10)."
  echo "    Reinstall Node from https://nodejs.org and re-run this script."
  exit 1
fi

NODE_VERSION="$(node -v | sed 's/v//')"
NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
NODE_MINOR="$(echo "$NODE_VERSION" | cut -d. -f2)"

if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 10 ]; }; then
  echo "  ✕ Node $NODE_VERSION is too old — windows-runner needs >= 20.10."
  echo "    Install a current release from https://nodejs.org and re-run."
  exit 1
fi

echo "  ✓ Node $NODE_VERSION"

if ! command -v git >/dev/null 2>&1; then
  echo "  ✕ git not found — it is required to download the source."
  echo "    Install git, or use 'npm install -g windows-runner' instead."
  exit 1
fi

IN_CHECKOUT=0
if [ -n "$ROOT" ] && [ -f "$ROOT/package.json" ] && grep -q '"name": "windows-runner"' "$ROOT/package.json" 2>/dev/null; then
  IN_CHECKOUT=1
fi

if [ "$IN_CHECKOUT" -eq 1 ]; then
  cd "$ROOT"
else
  TARGET="${WINDOWS_RUNNER_HOME:-$HOME/windows-runner}"
  if [ -d "$TARGET/.git" ]; then
    echo "  → Updating existing checkout at $TARGET…"
    cd "$TARGET"
    git pull --ff-only
  else
    echo "  → Cloning to $TARGET…"
    git clone "$REPO_URL" "$TARGET"
    cd "$TARGET"
  fi
fi

echo ""
echo "  Installing dependencies and building (one time, ~30s)…"
# WINDOWS_RUNNER_SKIP_POSTINSTALL avoids the install hook fighting this step.
WINDOWS_RUNNER_SKIP_POSTINSTALL=1 npm run setup

echo ""
echo "  ✓ Installed in $(pwd)"
echo ""
echo "  Start:"
echo "    npm start            → http://127.0.0.1:7634"
echo "    npx windows-runner   → CLI from this checkout"
echo "    wr                   → after 'npm install -g windows-runner'"
echo ""

if [ "$NO_START" -eq 1 ]; then
  exit 0
fi

# Only prompt when a human is attached: `curl … | bash` feeds the script itself
# on stdin, so reading would consume the rest of the script.
if [ -t 0 ] && [ -t 1 ]; then
  printf "  Start the server now? [Y/n] "
  read -r reply || reply=""
  case "$reply" in
    [Nn]*) ;;
    *) npm start ;;
  esac
else
  echo "  Non-interactive shell: not starting the server. Run 'npm start' when ready."
fi
