#!/usr/bin/env bash
# Migration latest-pin lint (#3189, sub-issue of #2323).
#
# Why this script exists: every D1 migration used to break unrelated
# tests that pin "latest is N" (e.g. PR #3176 failed CI shards 1+4 on
# three such pins for migration 0038). Those pins are undiscoverable
# from the diff, and their count grows with every slice.
#
# The fix is ownership, not vigilance: the registry's "latest" is owned
# by exactly one test, tests/migration_registry.test.ts, which asserts
# only derived structural invariants (no hardcoded latest version).
# No other test may assert on ALL_MIGRATIONS[last] or the max version.
# Per-feature migration tests assert only their own migration's
# registration (position-independent containment) and their own
# DDL/schema parity.
#
# This script enforces that ownership. It runs in CI (Fast gates) and
# in scripts/verify-before-merge.sh, so a new latest pin fails before
# push, not after CI. See gitops §7, pin rule 5.
set -uo pipefail

cd "$(dirname "$0")/.."

CANONICAL="tests/migration_registry.test.ts"

if [ ! -f "$CANONICAL" ]; then
  echo "MIGRATION LATEST-PIN LINT FAILED: canonical owner $CANONICAL is missing." >&2
  echo "Restore it; deleting the owner to dodge this lint is not a fix." >&2
  exit 1
fi

# Latest-assertion shapes: last-index access (incl. .at(-1)/.slice(-1)
# spellings) and max-version computation over the registry. Mere
# registration assertions (toContain of a specific migration) are the
# approved pattern and are NOT flagged.
PATTERN='ALL_MIGRATIONS\[ALL_MIGRATIONS\.length - 1\]|ALL_MIGRATIONS\.at\(-1\)|ALL_MIGRATIONS\.slice\(-1\)|Math\.max\(\.\.\.ALL_MIGRATIONS'

violations=$(grep -rnE --include='*.test.ts' --include='*.test.tsx' "$PATTERN" tests/ 2>/dev/null | grep -v "^${CANONICAL}:" || true)

if [ -n "$violations" ]; then
  echo "MIGRATION LATEST-PIN LINT FAILED: latest assertions outside the canonical owner:" >&2
  echo "$violations" >&2
  echo "Migration 'latest' belongs only in $CANONICAL (#3189; gitops §7 rule 5)." >&2
  echo "Remove the latest assertion (keep the test's own feature assertions); do not bump the pinned version." >&2
  exit 1
fi

echo "Migration latest-pin lint OK: no latest assertions outside $CANONICAL."
