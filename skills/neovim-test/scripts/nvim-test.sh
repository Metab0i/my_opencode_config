#!/usr/bin/env bash
# nvim-test.sh — Run a headless Neovim test against a config owned by another user.
#
# Loads the target config via normal XDG discovery (so rtp is populated and
# require() works) while isolating ALL writable state to a temp HOME owned by
# the caller. Guarantees the nvim process is killed and exited after the run.
#
# Usage:
#   nvim-test.sh -c /home/metab0i/.config/nvim -f tests/foo.lua
#   nvim-test.sh -c /path/to/config -l 'vim.api.nvim_out_write("hi\n")' -v
#   nvim-test.sh -c /path/to/config -- --headless extra-args
#
# Result protocol: the Lua test body must print to stdout exactly one line:
#     TEST_RESULT: PASS
#     TEST_RESULT: FAIL: <reason>
# Exit codes: 0 = PASS, non-zero = FAIL/timeout/error.

set -euo pipefail

CONFIG_DIR=""
LUA_EXPR=""
LUA_FILE=""
TIMEOUT=15
VERBOSE=0
PASSTHROUGH=()

usage() {
  cat <<'EOF'
nvim-test.sh — headless Neovim config test harness

Usage: nvim-test.sh -c CONFIG_DIR [-f LUA_FILE | -l LUA_EXPR] [-t TIMEOUT] [-v] [-- NVIM_ARGS...]

Options:
  -c, --config DIR   (required) Path to the nvim config directory to test.
  -f, --luafile FILE Path to a .lua file whose body is the test.
  -l, --lua EXPR     Inline Lua expression to run as the test.
  -t, --timeout SECS Kill nvim after this many seconds (default 15).
  -v, --verbose      Include nvim stdout/stderr in the report.
  --                 All args after this are passed to nvim verbatim.
  -h, --help         Show this help.

Exactly one of -f or -l must be given.

Result protocol: the Lua test must print a single line to stdout:
    TEST_RESULT: PASS
    TEST_RESULT: FAIL: <reason>
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--config)   CONFIG_DIR="$2"; shift 2 ;;
    -f|--luafile)  LUA_FILE="$2"; shift 2 ;;
    -l|--lua)      LUA_EXPR="$2"; shift 2 ;;
    -t|--timeout)  TIMEOUT="$2"; shift 2 ;;
    -v|--verbose)  VERBOSE=1; shift ;;
    --)            shift; while [[ $# -gt 0 ]]; do PASSTHROUGH+=("$1"); shift; done ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "nvim-test.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$CONFIG_DIR" ]]; then
  echo "nvim-test.sh: -c/--config is required" >&2
  usage >&2
  exit 2
fi
if [[ ! -d "$CONFIG_DIR" ]]; then
  echo "nvim-test.sh: config dir does not exist: $CONFIG_DIR" >&2
  exit 2
fi
if [[ -z "$LUA_FILE" && -z "$LUA_EXPR" ]]; then
  echo "nvim-test.sh: one of -f/--luafile or -l/--lua is required" >&2
  exit 2
fi
if [[ -n "$LUA_FILE" && -n "$LUA_EXPR" ]]; then
  echo "nvim-test.sh: -f/--luafile and -l/--lua are mutually exclusive" >&2
  exit 2
fi

if ! command -v nvim >/dev/null 2>&1; then
  echo "nvim-test.sh: nvim not found on PATH" >&2
  exit 3
fi

# Resolve the test body. The Lua runs AFTER the config loads (via a -c lua
# command), so require() calls inside the user's init already succeeded.
INLINE_FILE=""
if [[ -n "$LUA_FILE" ]]; then
  if [[ ! -f "$LUA_FILE" ]]; then
    echo "nvim-test.sh: luafile not found: $LUA_FILE" >&2
    exit 2
  fi
  TEST_BODY="dofile([[$(readlink -f "$LUA_FILE")]])"
else
  # Inline body: support arbitrary Lua statements (not just a single expression)
  # by writing it to a temp file and dofile-ing it. This mirrors -f semantics
  # so the body can use `local`, `if/then`, `return`, etc. — and so the
  # TEST_RESULT: protocol is the single source of truth (no implicit return
  # printing). The temp file is cleaned up by the trap.
  INLINE_FILE="$(mktemp --suffix=.lua)"
  printf '%s\n' "$LUA_EXPR" > "$INLINE_FILE"
  TEST_BODY="dofile([[$INLINE_FILE]])"
fi

# --- Isolated writable state via a temp HOME -------------------------------
TMPHOME="$(mktemp -d)"
LOG_OUT="$(mktemp)"
LOG_ERR="$(mktemp)"
NVIM_PID=""

cleanup() {
  local ec=$?
  if [[ -n "$NVIM_PID" ]] && kill -0 "$NVIM_PID" >/dev/null 2>&1; then
    kill -KILL "$NVIM_PID" >/dev/null 2>&1 || true
    wait "$NVIM_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMPHOME" "$LOG_OUT" "$LOG_ERR" "$INLINE_FILE" 2>/dev/null || true
  exit "$ec"
}
trap cleanup EXIT INT TERM

mkdir -p "$TMPHOME/.config"
ln -s "$(readlink -f "$CONFIG_DIR")" "$TMPHOME/.config/nvim"

# --- Launch ----------------------------------------------------------------
# Normal XDG discovery populates rtp so require() works. +qa! + timeout + the
# trap guarantee the process exits. Keystroke-style tests must use vim.wait()
# in-Lua since +qa! runs immediately after the -c lua body.
HOME="$TMPHOME" XDG_CONFIG_HOME="$TMPHOME/.config" \
  timeout --signal=KILL "$TIMEOUT" nvim \
    --headless \
    "${PASSTHROUGH[@]}" \
    -c "lua $TEST_BODY" \
    +qa! \
    >"$LOG_OUT" 2>"$LOG_ERR" &
NVIM_PID=$!
wait "$NVIM_PID"
NVIM_EXIT=$?
NVIM_PID=""   # consumed by trap

# --- Evaluate result -------------------------------------------------------
OUT="$(cat "$LOG_OUT")"
ERR="$(cat "$LOG_ERR")"

report() { # exit_code label reason
  echo "=== nvim-test: $2 ==="
  if [[ -n "${3:-}" ]]; then echo "reason: $3"; fi
  if [[ $VERBOSE -eq 1 || $1 -ne 0 ]]; then
    if [[ -n "$OUT" ]]; then echo "--- stdout ---"; echo "$OUT"; fi
    if [[ -n "$ERR" ]]; then echo "--- stderr ---"; echo "$ERR"; fi
  fi
}

# Was it killed by timeout?
if [[ $NVIM_EXIT -eq 137 || $NVIM_EXIT -eq 124 ]]; then
  report 1 "FAIL" "nvim did not exit within ${TIMEOUT}s (killed)"
  exit 1
fi

# Parse the TEST_RESULT marker from stdout.
RESULT_LINE="$(printf '%s\n' "$OUT" | grep -m1 -E '^TEST_RESULT: ' || true)"
if [[ -z "$RESULT_LINE" ]]; then
  # No marker: likely a config-load error.
  err_summary="$(printf '%s\n' "$ERR" | grep -E '^E[0-9]+' | head -5 | tr '\n' ';' || true)"
  if [[ -n "$err_summary" ]]; then
    report 1 "FAIL" "config load failed: $err_summary"
  else
    report 1 "FAIL" "no TEST_RESULT marker emitted (exit=$NVIM_EXIT)"
  fi
  exit 1
fi

if [[ "$RESULT_LINE" == "TEST_RESULT: PASS" ]]; then
  report 0 "PASS"
  exit 0
elif [[ "$RESULT_LINE" == TEST_RESULT:\ FAIL:* ]]; then
  reason="${RESULT_LINE#TEST_RESULT: FAIL: }"
  report 1 "FAIL" "$reason"
  exit 1
else
  report 1 "FAIL" "unrecognized result line: $RESULT_LINE"
  exit 1
fi