#!/usr/bin/env bash
# nvim-test-verified-edit.sh — verified-edit workflow for the nvim-test harness.
#
# Mandates: never edit scripts/nvim-test.sh directly. Instead copy -> edit
# candidate -> verify (A/B gate) -> promote-with-archive. Promote is impossible
# without a logged verified A/B win, preventing harness regressions on a hunch.
#
# Subcommands:
#   copy                                             # cp nvim-test.sh -> candidate
#   verify --old F --new F -c CFG -f TEST [-l L] [--reason TXT]
#   promote                                          # archive main, candidate -> main
#   status                                           # show main/candidate/archive/last verify
#   diff                                             # diff main vs candidate
#
# A/B gate ("better"):
#   (new PASS) AND (old FAIL OR --reason given)
# Result is appended to scripts/nvim-test.verify.log.
# Promote refuses unless a recent verify PASS exists for the current candidate.

set -euo pipefail

# Resolve the script's own dir (the skill scripts/ directory).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN="$SCRIPT_DIR/nvim-test.sh"
CAND="$SCRIPT_DIR/nvim-test.candidate.sh"
LOG="$SCRIPT_DIR/nvim-test.verify.log"
SELF="$0"

# -------- shared helpers ------------------------------------------------------

next_archive_version() {
  local n=0
  local f
  for f in "$SCRIPT_DIR"/nvim-test.old.v*.sh; do
    [[ -e "$f" ]] || continue
    local vn
    vn="${f##*nvim-test.old.v}"
    vn="${vn%.sh}"
    if [[ "$vn" =~ ^[0-9]+$ ]] && (( vn > n )); then n=$vn; fi
  done
  echo $(( n + 1 ))
}

pass() { echo "$SELF: $*"; }
die()  { echo "$SELF: ERROR: $*" >&2; exit 1; }

# Run the given harness with the given test args, capture stdout, parse result.
# Args: HARNESS [HARNESS_ARGS...]   (args are forwarded verbatim to the harness)
# Prints one line: "PASS" or "FAIL|<reason>"  (reason empty on PASS).
run_one() {
  local harness="$1"; shift
  local out
  out="$(bash "$harness" "$@" 2>/dev/null)" || true
  # parse the harness's own report: "=== nvim-test: PASS ===" or "... FAIL ===\nreason: ..."
  if printf '%s\n' "$out" | grep -qE '^=== nvim-test: PASS ==='; then
    echo "PASS"
  else
    local reason
    reason="$(printf '%s\n' "$out" | sed -n 's/^reason: //p' | head -1)"
    [[ -z "$reason" ]] && reason="$(printf '%s\n' "$out" | grep -E '^(=== nvim-test:|reason:)' | tail -1)"
    echo "FAIL|$reason"
  fi
}

usage() {
  cat <<EOF
nvim-test-verified-edit.sh — verified-edit workflow for the nvim-test harness

Usage:
  $SELF copy
  $SELF verify --old H --new H -c CFG -f TEST [-l EXPR] [-C DIR] [-t SECS] [-v] [--reason TXT]
  $SELF promote
  $SELF status
  $SELF diff
  $SELF help

Subcommands:
  copy               Copy scripts/nvim-test.sh to nvim-test.candidate.sh.
  verify             Run the same test under --old and --new harnesses; decide
                     if the candidate is "better" (new PASS AND (old FAIL OR
                     --reason given)). Appends a record to nvim-test.verify.log.
                     Exits 0 if better, 1 otherwise.
  promote            Archive nvim-test.sh as nvim-test.old.v{N}.sh and make the
                     candidate the new main. Requires a recent verify PASS for
                     the current candidate. Refuses if candidate==main.
  status             Show main, candidate, latest archive, last verify result.
  diff               Diff the current candidate against the main harness.

Paths (all under scripts/):
  main:      $MAIN
  candidate: $CAND
  log:       $LOG
EOF
}

# -------- subcommands ---------------------------------------------------------

cmd_copy() {
  [[ -f "$MAIN" ]] || die "main harness not found: $MAIN"
  cp "$MAIN" "$CAND"
  chmod +x "$CAND"
  pass "copied $MAIN -> $CAND (edit it now, then 'verify')"
}

cmd_verify() {
  local old="" new="" cfg="" luafile="" luaexpr="" reason="" cwd="" timeout="" verbose=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --old)    old="$2"; shift 2 ;;
      --new)    new="$2"; shift 2 ;;
      -c|--config) cfg="$2"; shift 2 ;;
      -f|--luafile) luafile="$2"; shift 2 ;;
      -l|--lua) luaexpr="$2"; shift 2 ;;
      -C|--cwd) cwd="$2"; shift 2 ;;
      -t|--timeout) timeout="$2"; shift 2 ;;
      -v|--verbose) verbose=1; shift ;;
      --reason) reason="$2"; shift 2 ;;
      *) die "verify: unknown arg: $1" ;;
    esac
  done
  [[ -n "$old" && -n "$new" ]] || die "verify: --old and --new are required"
  [[ -n "$cfg" ]] || die "verify: -c/--config is required"
  [[ -f "$old" ]] || die "verify: old harness not found: $old"
  [[ -f "$new" ]] || die "verify: new harness not found: $new"
  (( ${#luafile} + ${#luaexpr} > 0 )) || die "verify: one of -f/--luafile or -l/--lua is required"
  [[ -z "$luaexpr" || -z "$luafile" ]] || die "verify: -f and -l are mutually exclusive"

  # Build the exact arg list forwarded to BOTH harnesses (old harness ignores
  # unknown flags by erroring, which the A/B gate treats as a FAIL).
  local args=(-c "$cfg")
  if [[ -n "$cwd" ]];     then args+=(-C "$cwd"); fi
  if [[ -n "$timeout" ]]; then args+=(-t "$timeout"); fi
  (( verbose == 1 ))      && args+=(-v)
  if [[ -n "$luafile" ]]; then args+=(-f "$luafile"); else args+=(-l "$luaexpr"); fi

  local res_old res_new
  res_old="$(run_one "$old" "${args[@]}")"
  res_new="$(run_one "$new" "${args[@]}")"
  local old_state="${res_old%%|*}" old_reason="${res_old#*|}"; [[ "$old_reason" == "$res_old" ]] && old_reason=""
  local new_state="${res_new%%|*}" new_reason="${res_new#*|}"; [[ "$new_reason" == "$res_new" ]] && new_reason=""

  local better=n
  if [[ "$new_state" == "PASS" ]]; then
    if [[ "$old_state" == "FAIL" ]] || [[ -n "$reason" ]]; then
      better=y
    fi
  fi

  # Tie the BETTER verdict to the EXACT candidate content via sha256, so a stale
  # BETTER record can't authorize a different candidate later.
  local cand_hash=""
  if command -v sha256sum >/dev/null 2>&1; then
    cand_hash="$(sha256sum "$new" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    cand_hash="$(shasum -a 256 "$new" | cut -d' ' -f1)"
  fi

  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  {
    echo "[$ts] verify"
    echo "  cfg=$cfg luafile=${luafile:-} luaexpr_len=${#luaexpr} cwd=${cwd:-} timeout=${timeout:-} verbose=$verbose"
    echo "  reason=${reason:-}"
    echo "  old=$old -> $old_state : $old_reason"
    echo "  new=$new -> $new_state : $new_reason"
    echo "  cand=$new"
    echo "  cand_hash=$cand_hash"
    if [[ "$better" == y ]]; then
      echo "  result=BETTER (promote permitted)"
    else
      echo "  result=NOT_BETTER (promote blocked)"
    fi
    echo
  } >> "$LOG"

  if [[ "$better" == y ]]; then
    pass "verify: candidate is BETTER (old=$old_state new=$new_state reason=${reason:-none})"
    exit 0
  else
    pass "verify: candidate is NOT better (old=$old_state new=$new_state). Promote blocked."
    [[ -z "$reason" && "$new_state" == "PASS" && "$old_state" == "PASS" ]] && \
      pass "  hint: both PASS; supply --reason to justify a clarity/observability improvement."
    exit 1
  fi
}

# Returns 0 (success) iff the LATEST verify log block is result=BETTER AND its
# recorded cand_hash matches the sha256 of the CURRENT candidate file. This
# prevents a stale BETTER record from authorizing a different candidate.
last_verify_better_for_candidate() {
  [[ -f "$LOG" && -f "$CAND" ]] || return 1
  local newest_block better rec_hash cur_hash
  newest_block="$(awk 'BEGIN{RS=""} {b=$0} END{print b}' "$LOG")"
  better="$(printf '%s\n' "$newest_block" | sed -n 's/^\s*result=//p' | head -1)"
  [[ "$better" == BETTER* ]] || return 1
  rec_hash="$(printf '%s\n' "$newest_block" | sed -n 's/^\s*cand_hash=//p' | head -1)"
  [[ -n "$rec_hash" ]] || return 1   # no hash recorded → refuse (can't tie)
  if command -v sha256sum >/dev/null 2>&1; then
    cur_hash="$(sha256sum "$CAND" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    cur_hash="$(shasum -a 256 "$CAND" | cut -d' ' -f1)"
  else
    return 1
  fi
  [[ "$rec_hash" == "$cur_hash" ]]
}

cmd_promote() {
  [[ -f "$CAND" ]] || die "promote: no candidate found at $CAND (run 'copy' first)"
  if cmp -s "$MAIN" "$CAND"; then
    die "promote: candidate is identical to main — nothing to promote."
  fi
  if ! last_verify_better_for_candidate; then
    die "promote: the latest verify record is not a BETTER verdict for the current candidate's exact content. Run 'verify ... --reason' (or with a failing-then-passing test) first; ensure it reports BETTER, and don't modify the candidate afterward."
  fi
  local n archive
  n="$(next_archive_version)"
  archive="$SCRIPT_DIR/nvim-test.old.v${n}.sh"
  mv "$MAIN" "$archive"
  mv "$CAND" "$MAIN"
  chmod +x "$MAIN"
  pass "promoted: old main archived as $(basename "$archive"); candidate is now nvim-test.sh"
}

cmd_status() {
  pass "main:      $MAIN ($(test -f "$MAIN" && echo exists || echo MISSING))"
  pass "candidate: $CAND ($(test -f "$CAND" && echo exists || echo absent))"
  local n archive
  n="$(next_archive_version)"
  pass "next archive version: v$n -> nvim-test.old.v${n}.sh"
  if ls "$SCRIPT_DIR"/nvim-test.old.v*.sh >/dev/null 2>&1; then
    pass "archives:"
    for f in "$SCRIPT_DIR"/nvim-test.old.v*.sh; do echo "    $(basename "$f")"; done
  fi
  if [[ -f "$LOG" ]]; then
    pass "last verify:"
    awk 'BEGIN{RS=""} {b=$0} END{print b}' "$LOG" | sed 's/^/    /'
  else
    pass "verify log: (none yet)"
  fi
}

cmd_diff() {
  [[ -f "$CAND" ]] || die "diff: no candidate found at $CAND"
  diff -- "$MAIN" "$CAND" || true
}

# -------- dispatch ------------------------------------------------------------

[[ $# -ge 1 ]] || { usage; exit 2; }
sub="$1"; shift
case "$sub" in
  copy)    cmd_copy "$@" ;;
  verify)  cmd_verify "$@" ;;
  promote) cmd_promote "$@" ;;
  status)  cmd_status "$@" ;;
  diff)    cmd_diff "$@" ;;
  help|-h|--help) usage; exit 0 ;;
  *) echo "$SELF: unknown subcommand: $sub" >&2; usage >&2; exit 2 ;;
esac