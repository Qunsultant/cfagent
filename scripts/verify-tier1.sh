#!/usr/bin/env bash
# Tier 1 fast gate — gitops §7 (§15 step 1), issue #4082.
#
# WHY THIS SCRIPT EXISTS
# §7 has named `scripts/verify-tier1.sh` as "one shared Tier 1 script …
# identical for every lane" since the tiered-verify decision (#4052), but the
# file was never committed: the gate existed only as a list of steps in a doc.
# Every lane then either retyped the steps (drift) or skipped some (silent
# gap). This script is the composition — the doc and the repository now agree.
#
# WHAT TIER 1 IS (and is not)
# Fast, pre-publish, minutes:
#   1. typecheck                 — strict, whole repo
#   2. affected suites           — tests that touch what this branch changed
#   3. pin suites                — the accounting/census pins (npm run test:pins)
#   4. migration-pin lint        — the "latest is N" ownership rule (#3189)
#   5. changed-file lint         — defect-class ratchet (#3926)
#   6. policy-gate diff checks   — changelog, docs scope, stale base, test deletion
# Tier 1 does NOT run the full suite, does not build, and does not merge.
# The full suite is Tier 2 and runs in CI on the PR head and the merge-group
# commit (gitops §7 step 5, §10). A green Tier 1 is permission to publish, not
# permission to merge.
#
# USAGE
#   scripts/verify-tier1.sh                 # run the gate on the current branch
#   scripts/verify-tier1.sh --list          # print the selected affected suites and exit
#   scripts/verify-tier1.sh --no-fetch      # do not fetch origin/main (offline)
#   scripts/verify-tier1.sh --max-affected 60
#
# EXIT: 0 = Tier 1 green; non-zero = stop, fix, re-run. Never bypass a failure
# by publishing anyway; the merge gate is the queue plus required checks.
set -uo pipefail

cd "$(dirname "$0")/.."

FETCH=1
LIST_ONLY=0
MAX_AFFECTED=40

while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST_ONLY=1; shift ;;
    --no-fetch) FETCH=0; shift ;;
    --max-affected) MAX_AFFECTED="${2:-40}"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "verify-tier1: unknown argument '$1' (see --help)" >&2; exit 2 ;;
  esac
done

FAILED=0
declare -a SUMMARY=()

fail() {
  echo "" >&2
  echo "TIER 1 FAILED: $*" >&2
  echo "Fix the failure and re-run. Tier 2 (CI on the PR head) still runs after publish." >&2
  exit 1
}

note() { printf '%s\n' "$*"; }

step() { # step <label> <command...>
  local label="$1"; shift
  local start end
  note ""
  note "--- $label ---"
  start=$(date +%s)
  if "$@"; then
    end=$(date +%s)
    SUMMARY+=("PASS  $label  ($((end - start))s)")
  else
    end=$(date +%s)
    SUMMARY+=("FAIL  $label  ($((end - start))s)")
    fail "$label"
  fi
}

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != "main" ] || fail "refusing to run Tier 1 on main; run it on the PR branch"

if [ -z "$(git status --porcelain)" ]; then
  : # clean tree — the normal case
else
  note "note: working tree has uncommitted changes; the gate runs against HEAD, not those files."
fi

if [ "$FETCH" = "1" ]; then
  git fetch origin main --quiet 2>/dev/null || note "note: could not fetch origin/main; diffing against the local origin/main ref (use --no-fetch to silence)"
fi
git rev-parse --verify --quiet origin/main >/dev/null || fail "origin/main is not available; cannot compute the changed set"

BASE="origin/main"
CHANGED="$(git diff --name-only "$BASE"...HEAD)"
CHANGED_COUNT="$(printf '%s\n' "$CHANGED" | grep -c . || true)"
note ""
note "Tier 1 — branch '$BRANCH' vs $BASE ($CHANGED_COUNT changed file(s))"

# ---------------------------------------------------------------------------
# Affected suites: the tests that read what this branch changed.
# A changed test file is always included. A changed module pulls in the tests
# that reference it by path (e.g. `services/stockCopilotLearningPolicy`).
# A rename or a pure-docs diff selects nothing — the pin suites still run.
# ---------------------------------------------------------------------------
select_affected() {
  local out
  out="$(
    {
      printf '%s\n' "$CHANGED" | grep -E '^tests/.*\.test\.(ts|tsx)$' || true
      printf '%s\n' "$CHANGED" | grep -E '^src/.*\.(ts|tsx)$' | while IFS= read -r file; do
        [ -n "$file" ] || continue
        stem="${file#src/}"
        stem="${stem%.ts}"
        stem="${stem%.tsx}"
        # Tests reference modules by import path; match the stem without the
        # extension (`services/foo` matches `../src/services/foo`).
        grep -rlF --include='*.test.ts' --include='*.test.tsx' "$stem" tests 2>/dev/null || true
      done
    } | sort -u
  )"
  printf '%s\n' "$out" | grep -c . >/dev/null 2>&1 || true
  printf '%s\n' "$out" | grep . | head -n "$MAX_AFFECTED"
}

AFFECTED="$(select_affected)"
AFFECTED_COUNT="$(printf '%s\n' "$AFFECTED" | grep -c . || true)"

if [ "$LIST_ONLY" = "1" ]; then
  note ""
  note "Affected suites ($AFFECTED_COUNT selected, cap $MAX_AFFECTED):"
  if [ "$AFFECTED_COUNT" = "0" ]; then note "  (none — docs-only or no referencing test)"; else printf '%s\n' "$AFFECTED" | sed 's/^/  /'; fi
  exit 0
fi

step "TypeScript strict type check" npm run typecheck

if [ "$AFFECTED_COUNT" = "0" ]; then
  note "--- Affected suites ---"
  note "skip: no changed test and no src module with a referencing test"
  SUMMARY+=("SKIP  Affected suites  (0 selected)")
else
  # Word-splitting is intended: vitest takes the file list as argv.
  # shellcheck disable=SC2086
  step "Affected suites ($AFFECTED_COUNT)" npx vitest run $AFFECTED
fi

step "Pin suites (accounting, censuses, router inventory, policy-gate guards)" npm run test:pins
step "Migration latest-pin lint (#3189)" bash scripts/check-migration-pins.sh
step "Changed-file lint ratchet (#3926)" node scripts/lint-changed.mjs

if command -v python3 >/dev/null 2>&1; then PY=python3; else PY=python; fi
step "Policy Gate diff checks (changelog, docs scope, stale base, test deletion)" \
  "$PY" scripts/ci/policy_gate.py --diff-only --base "$BASE" --head HEAD

note ""
note "================ TIER 1 SUMMARY ================"
for line in "${SUMMARY[@]}"; do note "  $line"; done
note "==============================================="
note "Tier 1 green on $BRANCH @ $(git rev-parse --short HEAD)."
note "Next: publish (push, draft PR) — Tier 2 (CI on the PR head and the merge-group commit) is the merge gate."
exit 0
