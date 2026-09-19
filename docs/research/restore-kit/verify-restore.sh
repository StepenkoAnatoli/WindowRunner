#!/usr/bin/env bash
# verify-restore.sh — objective acceptance test for restoring the WindowsRunner implementation.
#
# Written 2026-09-19 against docs-only commit 7c25254, so that the moment the original
# source is restored there is a mechanical, non-negotiable definition of "restored".
#
# Usage:
#   bash docs/research/restore-kit/verify-restore.sh            # filesystem + manifest checks
#   bash docs/research/restore-kit/verify-restore.sh --full     # + npm test / typecheck / build
#   bash docs/research/restore-kit/verify-restore.sh --full --boot  # + boot server and HTTP check
#
# Exit code 0 only if every enabled check passes.
# No API keys are required or used. No network calls except those npm itself makes.

set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$KIT_DIR/../../.." && pwd)"
MANIFEST="$KIT_DIR/required-paths.txt"
PORT="${PORT:-7634}"

FULL=0; BOOT=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --boot) BOOT=1; FULL=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cd "$ROOT" || exit 2
echo "verify-restore: root=$ROOT  node=$(node -v 2>/dev/null || echo MISSING)  $( [ "$FULL" = 1 ] && echo "(full)" || echo "(paths only)" )"

# ---------------------------------------------------------------- 1. required paths
head_ "1. Documented source paths"
if [ ! -f "$MANIFEST" ]; then
  bad "manifest missing: $MANIFEST"
else
  miss=0; total=0
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    total=$((total+1))
    if [ ! -e "$p" ]; then miss=$((miss+1)); printf '      missing: %s\n' "$p"; fi
  done < "$MANIFEST"
  if [ "$miss" -eq 0 ]; then ok "all $total documented paths present"
  else bad "$miss of $total documented paths still missing"; fi
fi

# ------------------------------------------------------- 2. package.json integrity
head_ "2. package.json manifest consistency"
if [ ! -f package.json ]; then
  bad "package.json absent"
else
  n=$(node -e 'const p=require("./package.json");console.log((p.files||[]).length)' 2>/dev/null || echo 0)
  if [ "$n" -eq 0 ]; then
    bad "could not read package.json files[]"
  else
    bad_n=0
    while IFS= read -r entry; do
      clean="${entry%/}"
      [ -e "$clean" ] || { bad_n=$((bad_n+1)); printf '      missing from files[]: %s\n' "$entry"; }
    done < <(node -e 'const p=require("./package.json");for(const f of p.files||[])console.log(f)')
    [ "$bad_n" -eq 0 ] && ok "all $n files[] entries exist" || bad "$bad_n of $n files[] entries missing (npm pack would ship a broken tarball)"
  fi

  bin_bad=0
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    [ -e "$b" ] || { bin_bad=$((bin_bad+1)); printf '      missing bin target: %s\n' "$b"; }
  done < <(node -e 'const p=require("./package.json");for(const v of Object.values(p.bin||{}))console.log(v)')
  [ "$bin_bad" -eq 0 ] && ok "bin targets exist" || bad "$bin_bad bin target(s) missing"
fi

# --------------------------------------------------------------- 3. workspaces exist
head_ "3. Declared workspaces"
ws_missing=0
while IFS= read -r w; do
  [ -n "$w" ] || continue
  if [ -d "$w" ]; then ok "workspace present: $w"; else ws_missing=$((ws_missing+1)); bad "workspace absent: $w"; fi
done < <(node -e 'const p=require("./package.json");for(const w of p.workspaces||[])console.log(w)' 2>/dev/null)
[ "$ws_missing" -eq 0 ] || echo "      (npm run build/test/typecheck cannot work while this is true)"

# -------------------------------------------------------------- 4. npm script checks
if [ "$FULL" = 1 ]; then
  head_ "4. Documented commands"
  run_cmd() { # label, timeout, command...
    local label="$1" t="$2"; shift 2
    local out; out="$(timeout "$t" "$@" 2>&1)"; local rc=$?
    if [ $rc -eq 0 ]; then ok "$label"
    else bad "$label (exit $rc)"; printf '      %s\n' "$(echo "$out" | grep -m1 -E 'error|Error|not found|found' | cut -c1-140)"; fi
  }
  [ -d node_modules ] || run_cmd "npm ci" 300 npm ci --ignore-scripts --no-audit --no-fund
  run_cmd "npm run typecheck" 300 npm run typecheck
  run_cmd "npm test"          600 npm test
  run_cmd "npm run build"     600 npm run build
fi

# ------------------------------------------------------------------- 5. boot check
if [ "$BOOT" = 1 ]; then
  head_ "5. Server boots and serves the UI"
  if [ ! -e packages/server/dist/index.cjs ]; then
    bad "packages/server/dist/index.cjs absent — run 'npm run build' first"
  else
    npm start >/tmp/wr-boot.log 2>&1 &
    boot_pid=$!
    up=0
    for _ in $(seq 1 30); do
      if (exec 3<>/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then up=1; break; fi
      kill -0 "$boot_pid" 2>/dev/null || break
      sleep 1
    done
    if [ "$up" = 1 ]; then
      code="$(curl -s -o /tmp/wr-index.html -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null || echo 000)"
      [ "$code" = "200" ] && ok "GET / returned 200 on port $PORT" || bad "GET / returned $code"
    else
      bad "server did not open port $PORT within 30s"
      printf '      %s\n' "$(grep -m1 -E 'error|Error' /tmp/wr-boot.log 2>/dev/null | cut -c1-140)"
    fi
    kill "$boot_pid" 2>/dev/null
    pkill -P "$boot_pid" 2>/dev/null
    wait "$boot_pid" 2>/dev/null
  fi
fi

# --------------------------------------------------------------------- 6. verdict
head_ "Verdict"
printf '  passed: %d   failed: %d\n' "$pass" "$fail"
if [ "$fail" -eq 0 ]; then
  echo "  RESULT: PASS — the checkout matches its documentation."
  exit 0
fi
echo "  RESULT: FAIL — the checkout does not match its documentation."
[ "$FULL" = 0 ] && echo "  Re-run with --full (and --boot) for the executable checks."
exit 1
