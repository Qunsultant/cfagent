#!/usr/bin/env bash
# Verification before closing a pull request as superseded (gitops §11, §24).
#
# Prevents engineering work from being lost when an agent or script closes
# a PR without diff verification.
#
# Usage:
#   scripts/verify-superseded.sh <branch_or_commit> [--ignore-changelog]
set -euo pipefail

cd "$(dirname "$0")/.."

if [ $# -lt 1 ]; then
  echo "Usage: scripts/verify-superseded.sh <branch_or_commit> [--ignore-changelog]" >&2
  exit 1
fi

python3 scripts/ci/verify_pr_closure.py "$@"

