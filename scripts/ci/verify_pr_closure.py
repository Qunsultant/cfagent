#!/usr/bin/env python3
"""Verify PR / Branch Closure Anti-Work-Loss Guardrail (issue #3437, gitops §11, §24).

Prevents engineering work from being lost when an agent or script closes a PR
as 'superseded' or 'duplicate' without diff verification.

Rules enforced:
1. Diff-before-close: A branch or PR cannot be closed as superseded if it has
   unmerged functional changes (diff against origin/main is non-empty).
2. Delta preservation: If unique code or test coverage exists on the branch,
   the worker must either rebase and merge the delta or carve it out into a
   follow-up issue before closure.
3. Safe closure: Only branches whose delta against base is completely empty
   (fully absorbed by an earlier merge) may be closed without follow-up.

Usage:
    python3 scripts/ci/verify_pr_closure.py <branch_or_commit> [--base <base_ref>] [--ignore-changelog]
"""

import argparse
import json
import subprocess
import sys
from typing import Dict, List, Optional, Tuple


def run_git(args: List[str]) -> Tuple[int, str, str]:
    """Execute a git command and return (returncode, stdout, stderr)."""
    res = subprocess.run(
        ["git"] + args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return res.returncode, res.stdout.strip(), res.stderr.strip()


def resolve_commit_or_pr(target: str) -> str:
    """Resolve target if it is a PR number (e.g. '3428' or '#3428')."""
    raw = target.lstrip("#")
    if raw.isdigit():
        code, out, _ = run_git(["ls-remote", "origin", f"pull/{raw}/head"])
        if code == 0 and out:
            return out.split()[0]
    return target


def check_unmerged_diff(
    target: str,
    base: str = "origin/main",
    ignore_changelog: bool = False,
) -> Tuple[bool, List[Dict[str, str]], str]:
    """Check whether target contains unmerged functional differences against base.

    Returns:
        (is_safe_to_close, changed_files, summary_message)
    """
    resolved_target = resolve_commit_or_pr(target)

    # Verify target commit exists
    code, sha, err = run_git(["rev-parse", "--verify", f"{resolved_target}^{{commit}}"])
    if code != 0:
        return False, [], f"Target ref or commit '{target}' could not be resolved: {err}"

    # Verify base commit exists
    code, base_sha, err = run_git(["rev-parse", "--verify", f"{base}^{{commit}}"])
    if code != 0:
        return False, [], f"Base ref or commit '{base}' could not be resolved: {err}"

    # Find merge base
    code, merge_base, err = run_git(["merge-base", base_sha, sha])
    if code != 0 or not merge_base:
        return False, [], f"No common ancestor between '{base}' and '{target}': {err}"

    # Run git diff between merge base / base and target (three-dot diff)
    code, diff_out, err = run_git(["diff", f"{base}...{sha}", "--name-status"])
    if code != 0:
        return False, [], f"git diff failed: {err}"

    changed_files: List[Dict[str, str]] = []
    if diff_out:
        for line in diff_out.splitlines():
            parts = line.strip().split(maxsplit=1)
            if len(parts) == 2:
                status, path = parts[0], parts[1]
                if ignore_changelog and path.startswith("changelog.d/"):
                    continue
                changed_files.append({"status": status, "path": path})

    if not changed_files:
        return True, [], f"Zero unmerged functional differences between '{target}' and '{base}'."

    file_summary = "\n".join(f"  {f['status']}\t{f['path']}" for f in changed_files)
    message = (
        f"Branch '{target}' contains {len(changed_files)} unmerged file(s) relative to '{base}':\n"
        f"{file_summary}\n\n"
        f"Work-loss prevention rule (gitops §11 / §24):\n"
        f"Refusing closure: work on '{target}' is NOT fully absorbed by '{base}'.\n"
        f"Closing this PR as superseded would result in unreviewed data loss.\n\n"
        f"Required remediation:\n"
        f"  1. Rebase this branch onto '{base}' to inspect and merge the remaining delta, OR\n"
        f"  2. Carve out the unique delta into a separate issue/PR before closing."
    )
    return False, changed_files, message


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify whether a branch or PR can be safely closed as superseded without work loss."
    )
    parser.add_argument("target", help="Branch name, commit SHA, or PR number to evaluate")
    parser.add_argument("--base", default="origin/main", help="Base branch (default: origin/main)")
    parser.add_argument(
        "--ignore-changelog",
        action="store_true",
        help="Ignore unmerged changelog fragments under changelog.d/ if issue was merged",
    )
    parser.add_argument(
        "--allow-override",
        action="store_true",
        help="Emergency override (logs a warning instead of failing)",
    )
    parser.add_argument("--json", action="store_true", help="Output machine-readable JSON result")

    args = parser.parse_args()

    safe, changes, msg = check_unmerged_diff(
        target=args.target,
        base=args.base,
        ignore_changelog=args.ignore_changelog,
    )

    if args.json:
        payload = {
            "target": args.target,
            "base": args.base,
            "safe_to_close": safe,
            "changed_files_count": len(changes),
            "changed_files": changes,
            "message": msg,
        }
        print(json.dumps(payload, indent=2))
        return 0 if (safe or args.allow_override) else 1

    if safe:
        print(f"VERIFY-PR-CLOSURE OK: {msg}")
        return 0
    else:
        if args.allow_override:
            print(f"VERIFY-PR-CLOSURE OVERRIDE WARNING:\n{msg}")
            return 0
        print(f"VERIFY-PR-CLOSURE FAILED:\n{msg}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

