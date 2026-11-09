#!/usr/bin/env bash
# Pre-merge verification (gitops §17.4, §18.1, §19.5).
#
# Why this script exists: a green result on a stale base proves nothing
# about the merge, and a rebase merge creates a commit CI has never
# tested. This script enforces the cheap half mechanically before any
# merge: the branch must be rebased onto current origin/main, and
# typecheck + the full test suite must pass on that rebased head.
# It does NOT replace the CI gate: after merging, the agent MUST still
# verify the CI run on main for the merged commit (§17.4 step 2), and
# if that run is red, restoring green is the next issue (§18.2).
#
# Usage: run from the repository root, on the branch to be merged.
# Exit 0 = safe to proceed to the merge step; non-zero = stop, fix,
# and re-run. Never bypass a failure by merging anyway outside the
# §18.1 emergency exception (owner-authorized, restore-green issue
# created in the same action).
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "VERIFY-BEFORE-MERGE FAILED: $*" >&2; exit 1; }

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != "main" ] || fail "refusing to verify main itself; run on the PR branch"
git fetch origin main || fail "could not fetch origin/main; a merge on an unverified base is a hard stop (gitops §6)"

BASE="$(git merge-base HEAD origin/main)"
MAIN_HEAD="$(git rev-parse origin/main)"
[ "$BASE" = "$MAIN_HEAD" ] || fail "branch '$BRANCH' is not rebased onto current origin/main (merge-base $BASE != origin/main $MAIN_HEAD). Rebase first, then re-run this script."

[ -z "$(git status --porcelain)" ] || fail "working tree is dirty; commit or stash before verifying, so the checks test exactly what will merge"

echo "Base OK: $BRANCH is rebased onto origin/main ($MAIN_HEAD)"

echo "--- TypeScript strict type check ---"
npm run typecheck || fail "typecheck failed"

echo "--- Migration latest-pin lint (#3189) ---"
bash scripts/check-migration-pins.sh || fail "migration latest-pin lint failed"

echo "--- Full test suite ---"
npm run test:pins || fail "pin suites failed (accounting, censuses, router inventory, policy gate)"
npm run test:ci || fail "test suite failed"

echo "--- Policy gate regression check ---"
python3 scripts/ci/policy_gate.py --diff-only --base origin/main --head HEAD || fail "policy gate regression check failed"

echo "VERIFY-BEFORE-MERGE OK: $BRANCH @ $(git rev-parse --short HEAD) is rebased onto origin/main and passes typecheck + full suite."
echo "Next (gitops §17.4): merge, then verify the CI run on main for the merged commit before marking this issue Done. Unrelated work may continue in parallel."
