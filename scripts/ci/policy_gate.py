#!/usr/bin/env python3
"""Policy Gate for cfagent (issue #1487, #1684).

Evaluates GitOps compliance:
(a) Linked issue reference
(b) Lane label (lane:*)
(c) Agent hashtag (#<agent>-<id>)
(d) CHANGELOG entry under ## [Unreleased], or a changelog.d fragment
    (issue #1801: fragments end the prepend race — a PR adds one file
    under changelog.d/ and never touches CHANGELOG.md)
(e) Docs scope guard (docs PR cannot touch src/ or tests/)
(f) Stale base reversion guard (cannot delete files added to main since branching)
(g) superseded by (i) (owner direction 2026-10-27, issue #1894):
    no file may be deleted at all — see (i), including its
    test-rename allowance (owner direction 2026-10-27, issue #1917)
(i) No-deletion rule (owner direction 2026-10-27, issue #1894;
    rename allowance owner direction 2026-10-27, issue #1917):
    any file deletion fails, with no label bypass. Retire by deprecating
    in place (see (j)), never by deleting. Pure renames pass.
    Exception: a deleted TEST file passes when an added test file
    preserves every one of its test names (exact match, or fuzzy match
    at ratio >= 0.55 under a distinct assignment, so titles may be
    renamed along with the file but none may disappear) and git pairs
    the two as a rename at a 20% threshold (or the coverage is exact).
    The rule proves no test title disappeared; it does not audit
    assertion strength — that is the suite's and review's job.
(j) Deprecation completeness (owner direction 2026-10-27, issue #1894):
    a new deprecation marker in code must name what superseded it, e.g.
    'superseded by src/new_module.ts'. Deprecated code must not be used.
Head evaluation: a merge-commit HEAD (CI checkout default on
pull_request events) resolves to its second parent, the PR branch head,
so (d)/(e)/(f)/(i)/(j) evaluate the branch tree, not the merge tree.
Attribution: (a)/(b)/(c) read the PR body and labels ONLY — commit
messages are not fallback context.
(h) Process documentation line (gitops §23: PR body must carry the §9
    "Process documentation impact:" checklist line — presence only,
    never a judgment of the decision's quality)
"""

import argparse
import json
import os
import re
import subprocess
import sys
from typing import Any, Dict, List, Optional, Set


def unreleased_section(text_content: str) -> List[str]:
    """Extract non-empty lines under the ## [Unreleased] section."""
    lines = text_content.splitlines()
    section = []
    in_section = False
    for line in lines:
        if line.startswith("## [Unreleased]"):
            in_section = True
            continue
        if in_section and line.startswith("## "):
            break
        if in_section:
            section.append(line)
    return section


def resolve_effective_head(head: str, base: str = "origin/main") -> str:
    """Resolve the tree the gate must evaluate.

    In CI, actions/checkout on pull_request events checks out the MERGE
    commit (the workflow passes no ref), and the gate runs with HEAD set
    to it. Evaluating the merge tree makes check (f) vacuous: the merge
    base of main and a merge commit is main itself, so no file ever
    counts as added-to-main-since-branching. A merge commit's second
    parent is the PR branch head in GitHub-synthesized merge commits (where
    parent 0 is main). When main has been merged into a PR branch, parent 0
    is the PR branch and parent 1 is main. The gate dynamically selects the
    parent that is NOT an ancestor of base so it always inspects the branch
    tree, falling back to parent 1 or head. A single-parent head resolves to
    itself. Unresolvable heads fall back to the given ref rather than
    crashing the gate.
    """
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "--verify", f"{head}^{{commit}}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        ).stdout.strip()
    except Exception:
        return head
    try:
        out = subprocess.run(
            ["git", "cat-file", "-p", sha],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        ).stdout
        parents = [line.split()[1] for line in out.splitlines() if line.startswith("parent ")]
    except Exception:
        return head
    if len(parents) >= 2:
        try:
            r0 = subprocess.run(
                ["git", "merge-base", "--is-ancestor", parents[0], base],
                capture_output=True,
            ).returncode
            r1 = subprocess.run(
                ["git", "merge-base", "--is-ancestor", parents[1], base],
                capture_output=True,
            ).returncode
            if r0 == 0 and r1 != 0:
                return parents[1]
            if r1 == 0 and r0 != 0:
                # Parent 1 is an ancestor of base (e.g. main was merged into the PR branch).
                # The tree at head already integrates base. Returning parents[0] would strip
                # away the merge of base and evaluate an outdated tree lacking files added to base.
                return head
        except Exception:
            pass
        return parents[1]
    return head


def evaluate_policy(
    base: str = "origin/main",
    head: str = "HEAD",
    title: str = "",
    body: str = "",
    labels: Optional[List[str]] = None,
    diff_only: bool = False,
    skip_stale_base: bool = False,
) -> List[str]:
    """Run all policy gate evaluations and return any failure reasons."""
    labels = labels or []
    # Evaluate the branch tree, not a merge-commit tree (see
    # resolve_effective_head), except when evaluating the aggregate
    # merge_group tree where HEAD is already the queue-constructed target tree.
    original_head = head
    if os.environ.get("GITHUB_EVENT_NAME") != "merge_group":
        head = resolve_effective_head(head, base=base)
    # Attribution reads the PR body and labels ONLY (owner direction
    # 2026-10-27, issue #1894). Commit messages are NOT fallback context:
    # a bot must not satisfy (a)/(b)/(c) by pasting an issue ref or a
    # hashtag into a commit message while the PR body carries neither.
    text = body
    full_body = body
    failures: List[str] = []

    # Detect pure documentation PRs (#2555): changes strictly confined to docs/
    # or markdown files outside code, tests, scripts, and workflows.
    touched_files: List[str] = []
    try:
        touched_files = [
            f.strip()
            for f in subprocess.run(
                ["git", "diff", "--name-only", f"{base}...{head}"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=True,
            ).stdout.splitlines()
            if f.strip()
        ]
    except Exception:
        pass

    is_pure_docs = (
        len(touched_files) > 0
        and all(
            (f.startswith("docs/") or f.endswith(".md"))
            and not f.startswith("changelog.d/")
            and not f.startswith("src/")
            and not f.startswith("tests/")
            and not f.startswith("scripts/")
            and not f.startswith(".github/")
            for f in touched_files
        )
    )

    if not diff_only and not is_pure_docs:
        # (a) Linked issue
        if not re.search(r"(?i)\b(fixes|closes|resolves)\s+#\d+", text) and not re.search(
            r"(OpenAIMP|Qunsultant)/cfagent#\d+", text
        ):
            failures.append(
                "(a) linked issue: PR body/title has no "
                "'Fixes #N' / 'Closes #N' / 'Resolves #N' "
                "and no OpenAIMP/cfagent#N or Qunsultant/cfagent#N reference"
            )

        # (b) Lane label
        has_lane_label = any(label.startswith("lane:") for label in labels) or bool(
            re.search(r"lane:[a-zA-Z0-9_-]+", full_body)
        )
        has_agent_hashtag = bool(re.search(r"#[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+", full_body))
        if not (has_lane_label or has_agent_hashtag):
            failures.append(
                "(b) lane label: PR carries no 'lane:*' label "
                "and no valid '#<agent>-<id>' hashtag in body (see gitops §21)"
            )

        # (c) Agent hashtag
        if not re.search(r"#[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+", full_body):
            failures.append(
                "(c) agent hashtag: PR body has no '#<agent>-<id>' "
                "hashtag (see AGENTS.md hashtag rule)"
            )

        # (h) Process documentation line (gitops §23). Presence only:
        # the gate checks that the §9 checklist line exists in the PR
        # body, never whether the decision it points at was correctly
        # recorded. Checked against the PR body alone (not commit
        # messages), because §23 names the PR body as the pointer.
        if not re.search(r"(?i)process documentation impact\s*:", body):
            failures.append(
                "(h) process documentation: PR body has no "
                "'Process documentation impact:' checklist line "
                "(see gitops §9/§23)"
            )

    # (d) CHANGELOG entry under ## [Unreleased], or a changelog.d fragment.
    # Fragments (issue #1801) end the prepend race: a PR adds one file
    # under changelog.d/ and never touches CHANGELOG.md, so no two PRs
    # write the same file. A direct CHANGELOG entry still passes.
    # Pure documentation PRs (#2555) do not require a changelog fragment or entry.
    if not is_pure_docs:
        try:
            base_changelog = subprocess.run(
                ["git", "show", f"{base}:CHANGELOG.md"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=True,
            ).stdout
            head_changelog_proc = subprocess.run(
                ["git", "show", f"{head}:CHANGELOG.md"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            if head_changelog_proc.returncode == 0:
                head_changelog = head_changelog_proc.stdout
            else:
                with open("CHANGELOG.md", encoding="utf-8") as handle:
                    head_changelog = handle.read()

            base_lines = {line for line in unreleased_section(base_changelog) if line.strip()}
            head_lines = unreleased_section(head_changelog)
            added_entry = any(
                line.strip() and line not in base_lines for line in head_lines
            )
            added_fragment = False
            if not added_entry:
                added_files = subprocess.run(
                    ["git", "diff", "--name-only", "--diff-filter=A", f"{base}...{head}"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=True,
                ).stdout.splitlines()
                for candidate in added_files:
                    if not candidate.startswith("changelog.d/"):
                        continue
                    try:
                        fragment_text = subprocess.run(
                            ["git", "show", f"{head}:{candidate}"],
                            capture_output=True,
                            text=True,
                            encoding="utf-8",
                            errors="replace",
                            check=True,
                        ).stdout
                    except Exception:
                        continue
                    first = next(
                        (line.strip() for line in fragment_text.splitlines() if line.strip()),
                        "",
                    )
                    non_empty = [line.strip() for line in fragment_text.splitlines() if line.strip()]
                    has_bullet = len(non_empty) > 1
                    if first.startswith("### ") and has_bullet:
                        added_fragment = True
                        break
            if not added_entry and not added_fragment:
                failures.append(
                    "(d) CHANGELOG: PR adds no entry under ## [Unreleased] in CHANGELOG.md "
                    "and no changelog.d fragment (an added fragment whose first "
                    "non-empty line is a '### ' section header followed by at least "
                    "one entry line)"
                )
        except Exception as e:
            failures.append(f"(d) CHANGELOG verification error: {e}")

    # (e) Docs scope guard: docs-only PR cannot touch src/ or tests/
    is_docs_pr = bool(
        re.search(r"^(docs(\([^\)]+\))?:|\[docs\])", title.strip(), re.IGNORECASE)
    )
    try:
        touched_files = subprocess.run(
            ["git", "diff", "--name-only", f"{base}...{head}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        ).stdout.splitlines()

        if is_docs_pr:
            disallowed_code_files = [
                f for f in touched_files if f.startswith("src/") or f.startswith("tests/")
            ]
            if disallowed_code_files:
                sample = ", ".join(disallowed_code_files[:5])
                suffix = "..." if len(disallowed_code_files) > 5 else ""
                failures.append(
                    f"(e) docs scope: PR is scoped as documentation ('{title[:30]}...') "
                    f"but touches {len(disallowed_code_files)} code/test file(s): {sample}{suffix}. "
                    "Code changes must not ride in docs PRs."
                )
    except Exception as e:
        failures.append(f"(e) docs scope verification error: {e}")

    deleted_files: set[str] = set()
    head_missing_files: set[str] = set()
    try:
        merge_base = subprocess.run(
            ["git", "merge-base", base, head],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        ).stdout.strip()
    except Exception:
        merge_base = base

    # (f) Stale base reversion guard: ensure branch does not delete files added to base
    # Pure documentation PRs (#2555) cannot touch code files and bypass check (f).
    # Per-PR checks in merge_group bypass check (f) because the aggregate check evaluates
    # the actual queue-rebased tree against base.
    if not is_pure_docs and not skip_stale_base:
        try:

            # Files added to base (e.g. main) since the merge base
            main_added_files = set(
                subprocess.run(
                    ["git", "diff", "--name-only", "--diff-filter=A", merge_base, base],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=True,
                ).stdout.splitlines()
            )

            # Files present in base but missing in head
            head_missing_files = set(
                subprocess.run(
                    ["git", "diff", "--name-only", "--diff-filter=D", base, head],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=True,
                ).stdout.splitlines()
            )

            # Also collect files explicitly deleted in the PR branch relative to merge_base
            deleted_files = set(
                subprocess.run(
                    ["git", "diff", "--name-only", "--diff-filter=D", f"{merge_base}...{head}"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=True,
                ).stdout.splitlines()
            )

            reverted_main_additions = [f for f in head_missing_files if f in main_added_files]
            if reverted_main_additions:
                sample = ", ".join(reverted_main_additions[:5])
                suffix = "..." if len(reverted_main_additions) > 5 else ""
                failures.append(
                    f"(f) stale base reversion: PR branch was cut from a stale base and "
                    f"reverts/deletes {len(reverted_main_additions)} file(s) added to main since branching: {sample}{suffix}. "
                    "Rebase cleanly onto fresh main before merging."
                )
        except Exception as e:
            failures.append(f"(f) stale base verification error: {e}")

    # (i) No-deletion rule (owner direction 2026-10-27, issue #1894)
    # with the test-rename allowance (owner direction 2026-10-27,
    # issue #1917): NO file may be deleted in a PR — any deletion
    # fails, with no label bypass — EXCEPT a deleted test file whose
    # tests all survive in an added test file (see below). Retire by
    # deprecating in place (see (j)): keep the file, mark it
    # deprecated with its superseding reference, and remove it from
    # exports/indexes instead of deleting it. Pure renames (git R
    # status) are moves, not deletions, and pass. If a listed file is
    # one the branch simply lacks because main moved, update the
    # branch to current main. Genuine exceptions (e.g. removing an
    # accidentally committed secret, legal takedown) are owner
    # emergency exceptions: the gate stays red and only an owner admin
    # bypass with an exception record merges.
    #
    # Rename allowance, and why each condition exists:
    # - Both files must be test files (tests/ dir, or .test./.spec.
    #   in the name). A heavily-edited non-test rename still fails:
    #   source files retire via deprecation in place, not deletion.
    # - Every test name of the deleted file must have a DISTINCT
    #   counterpart in the added file: exact equality, or
    #   SequenceMatcher ratio >= 0.55. Titles may be renamed along
    #   with the file, but none may disappear, and one new title may
    #   not cover two old ones. The 0.55 floor sits below the
    #   observed #1906 minimum (0.615 over 39 names, greedy distinct
    #   assignment) with margin, and above unrelated-title similarity.
    # - The covering file must plausibly be the same file renamed:
    #   git pairs the two at a 20% rename threshold (the #1906 pair
    #   sits at 41%; unrelated files sit near 0%), OR every old title
    #   appears verbatim in the new file (a verbatim move needs no
    #   pairing proof; adding titles does not break exactness).
    # - The deleted file must carry at least one extractable test
    #   name; a file with no literal-named tests cannot use the
    #   allowance. Only literal it/test/describe titles are
    #   extracted — parameterized (it.each/test.each), skipped, and
    #   template-literal titles are not, and such files keep the old
    #   behavior (fail). Matching is by maximum bipartite matching
    #   (Kuhn's algorithm), not greedy order, so assignment cannot
    #   steal a title another old name needs.
    # - Fail-closed: any error inside this block fails (i) outright;
    #   an error never excuses a deletion.
    # - The allowance proves no test TITLE disappeared. It does not
    #   audit assertion strength: a test kept by title but weakened
    #   in body passes this check and is the suite's/review's job.
    try:
        import difflib

        def _is_test_file(path: str) -> bool:
            return path.startswith("tests/") or ".test." in path or ".spec." in path

        def _test_names(content: str) -> List[str]:
            return [
                match.group(1).strip()
                for match in re.finditer(
                    r"\b(?:it|test|describe)\s*\(\s*[\"'`]([^\"'`]+)[\"'`]",
                    content,
                )
            ]

        def _show(ref: str, path: str) -> Optional[str]:
            try:
                return subprocess.run(
                    ["git", "show", f"{ref}:{path}"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=True,
                ).stdout
            except Exception:
                return None

        def _exact_covers(old_names: List[str], new_names: List[str]) -> bool:
            # Every old title appears verbatim (as a multiset subset) in
            # the new file. Adding titles (a new describe wrapper, new
            # tests) does not break exactness — only losing one does.
            remaining = list(new_names)
            for old in old_names:
                if old in remaining:
                    remaining.remove(old)
                else:
                    return False
            return True

        def _covers(old_names: List[str], new_names: List[str]) -> bool:
            # Maximum bipartite matching: edge old->new when titles are
            # equal or fuzzy-similar. Passes only if every old title
            # matches a distinct new title.
            if not old_names:
                return False
            adjacency: List[List[int]] = []
            for old in old_names:
                edges = [
                    j
                    for j, new in enumerate(new_names)
                    if old == new
                    or difflib.SequenceMatcher(None, old, new).ratio() >= 0.55
                ]
                adjacency.append(edges)
            match_to_old: List[int] = [-1] * len(new_names)

            def _augment(i: int, seen: List[bool]) -> bool:
                for j in adjacency[i]:
                    if seen[j]:
                        continue
                    seen[j] = True
                    if match_to_old[j] == -1 or _augment(match_to_old[j], seen):
                        match_to_old[j] = i
                        return True
                return False

            for i in range(len(old_names)):
                if not _augment(i, [False] * len(new_names)):
                    return False
            return True

        status_lines = subprocess.run(
            ["git", "diff", "--name-status", "-M", f"{merge_base}...{head}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        ).stdout.splitlines()
        deleted_all = [
            line.split("\t", 1)[1] for line in status_lines if line.startswith("D\t")
        ]
        added_all = [
            line.split("\t", 1)[1] for line in status_lines if line.startswith("A\t")
        ]
        allowed: List[str] = []
        if deleted_all:
            paired_lines = subprocess.run(
                ["git", "diff", "--name-status", "--find-renames=20%", f"{merge_base}...{head}"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=True,
            ).stdout.splitlines()
            paired = set()
            for line in paired_lines:
                parts = line.split("\t")
                if len(parts) == 3 and parts[0].startswith("R"):
                    paired.add((parts[1], parts[2]))
            remaining = []
            for deleted in deleted_all:
                excused_with = None
                if _is_test_file(deleted):
                    old_content = _show(merge_base, deleted)
                    old_names = _test_names(old_content) if old_content is not None else []
                    if old_names:
                        for added in added_all:
                            if not _is_test_file(added):
                                continue
                            new_content = _show(head, added)
                            if new_content is None:
                                continue
                            new_names = _test_names(new_content)
                            if (deleted, added) in paired or _exact_covers(
                                old_names, new_names
                            ):
                                if _covers(old_names, new_names):
                                    excused_with = added
                                    break
                if excused_with is not None:
                    allowed.append(f"{deleted} -> {excused_with}")
                else:
                    remaining.append(deleted)
            for pair in allowed:
                print(f"(i) allowed rename: {pair} (test names preserved)")
            deleted_all = remaining
        if deleted_all:
            sample = ", ".join(sorted(deleted_all)[:5])
            suffix = "..." if len(deleted_all) > 5 else ""
            failures.append(
                f"(i) no deletion: PR deletes {len(deleted_all)} file(s): {sample}{suffix}. "
                "No file may be deleted — mark the code deprecated in place (see (j)) "
                "and remove it from exports/indexes instead. "
                "The 'allow-test-deletion' label no longer permits deletions. "
                "A deleted test file passes only when an added test file preserves "
                "all of its test names (see (i) rename allowance). "
                "If a listed file is one the branch simply lacks because main moved, "
                "update the branch to current main."
            )
    except Exception as e:
        failures.append(f"(i) no-deletion verification error: {e}")

    # (j) Deprecation completeness (owner direction 2026-10-27, #1894):
    # Deprecated code must not be used, and a deprecation must name what
    # superseded it — e.g. 'superseded by src/new_module.ts'. Applies to
    # ADDED lines in code files only (src/, scripts/); tests, docs, and
    # prose are excluded because their comments routinely mention
    # already-deprecated APIs without declaring a new deprecation.
    # Lines negating deprecation ("not deprecated", "never deprecated")
    # are not markers. File-level: if a file's added lines contain any
    # marker but no superseding reference anywhere in that file's added
    # lines, the deprecation is incomplete.
    try:
        diff_text = subprocess.run(
            ["git", "diff", base, head],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        ).stdout
        deprecation_re = re.compile(r"@deprecated|\bdeprecated\b", re.IGNORECASE)
        negation_re = re.compile(
            r"\b(not|never|isn'?t)\s+deprecated\b|not-deprecated", re.IGNORECASE
        )
        superseding_re = re.compile(
            r"superseded\s+by|superseded-by|replaced\s+by|in\s+favor\s+of|use\s+.+\s+instead",
            re.IGNORECASE,
        )
        current_path = None
        current_added: List[str] = []
        file_chunks = []

        def flush():
            if current_path is not None:
                file_chunks.append((current_path, list(current_added)))

        for line in diff_text.splitlines():
            if line.startswith("diff --git "):
                flush()
                current_path = None
                current_added = []
                continue
            if line.startswith("+++ "):
                target = line[4:].strip()
                if target.startswith("b/"):
                    target = target[2:]
                current_path = target
                continue
            if current_path is not None and line.startswith("+") and not line.startswith("+++"):
                current_added.append(line[1:])
        flush()
        for path, added in file_chunks:
            if not (path.startswith("src/") or path.startswith("scripts/")):
                continue
            if path.endswith(".md"):
                continue
            markers = [
                line.strip()
                for line in added
                if deprecation_re.search(line) and not negation_re.search(line)
            ]
            if markers and not any(superseding_re.search(line) for line in added):
                marker = markers[0][:100]
                failures.append(
                    f"(j) deprecation incomplete: {path} adds a deprecation marker "
                    f"({marker}) but no superseding reference in the same file's added lines. "
                    "Deprecated code must not be used — name what superseded it, "
                    "e.g. 'superseded by src/new_module.ts'."
                )
    except Exception as e:
        failures.append(f"(j) deprecation verification error: {e}")

    return failures


def resolve_merge_group_prs(base: str, head: str) -> List[Dict[str, Any]]:
    """Resolve the individual PRs in a merge_group for per-PR policy evaluation (#2499).

    Supports MERGE_GROUP_PRS_JSON for deterministic offline unit tests in
    tests/policy_gate_guards.test.ts, and queries the GitHub API in CI using
    both the gh-readonly-queue ref name and commits/<sha>/pulls for every
    commit in base..head.
    """
    override_json = os.environ.get("MERGE_GROUP_PRS_JSON")
    if override_json:
        return json.loads(override_json)

    repo = os.environ.get("GITHUB_REPOSITORY") or ""
    ref_name = os.environ.get("GITHUB_REF_NAME") or ""
    pr_numbers: List[int] = []

    ref_match = re.match(r"^gh-readonly-queue/[^/]+/pr-(\d+)-", ref_name)
    if ref_match:
        pr_numbers.append(int(ref_match.group(1)))

    if repo:
        try:
            commits = subprocess.run(
                ["git", "rev-list", f"{base}..{head}"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=True,
            ).stdout.splitlines()
            for sha in commits:
                sha = sha.strip()
                if not sha:
                    continue
                res = subprocess.run(
                    [
                        "gh",
                        "api",
                        f"repos/{repo}/commits/{sha}/pulls",
                        "--jq",
                        ".[].number",
                    ],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )
                if res.returncode == 0:
                    for line in res.stdout.splitlines():
                        line = line.strip()
                        if line.isdigit():
                            num = int(line)
                            if num not in pr_numbers:
                                pr_numbers.append(num)
        except Exception:
            pass

    prs: List[Dict[str, Any]] = []
    for num in pr_numbers:
        if not repo:
            continue
        res = subprocess.run(
            ["gh", "api", f"repos/{repo}/pulls/{num}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if res.returncode != 0:
            continue
        try:
            pr_data = json.loads(res.stdout)
        except Exception:
            continue
        pr_head_sha = (pr_data.get("head") or {}).get("sha") or ""
        if pr_head_sha:
            subprocess.run(
                ["git", "fetch", "--no-tags", "origin", f"pull/{num}/head"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        labels = [
            lbl.get("name", "")
            for lbl in (pr_data.get("labels") or [])
            if isinstance(lbl, dict) and lbl.get("name")
        ]
        prs.append(
            {
                "number": num,
                "title": pr_data.get("title") or "",
                "body": pr_data.get("body") or "",
                "labels": labels,
                "head": pr_head_sha or head,
            }
        )
    return prs


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate cfagent Policy Gate.")
    parser.add_argument("--base", default="origin/main", help="Base git ref to compare against")
    parser.add_argument("--head", default="HEAD", help="Head git ref to check")
    parser.add_argument(
        "--diff-only",
        action="store_true",
        help="Run only git diff checks (changelog, docs scope, stale base, test deletion)",
    )
    args = parser.parse_args()

    body = os.environ.get("PR_BODY") or ""
    title = os.environ.get("PR_TITLE") or ""
    labels = (os.environ.get("PR_LABELS") or "").split()
    is_merge_group = os.environ.get("GITHUB_EVENT_NAME") == "merge_group"

    failures: List[str] = []
    if is_merge_group and not args.diff_only:
        queued_prs = resolve_merge_group_prs(args.base, args.head)
        if not queued_prs and os.environ.get("GITHUB_REPOSITORY"):
            failures.append(
                "(merge_group) could not resolve queued PR metadata from GitHub API "
                "for per-PR policy evaluation"
            )
        for pr in queued_prs:
            pr_head = pr.get("head") or args.head
            # Compute the merge-base between origin/main and the PR's authored
            # head so that per-PR checks only see the PR's own authored diff,
            # not new commits that landed on main after the PR was cut.
            # Without this, git-diff(origin/main, pr.head) treats every file
            # added to main since branching as "deleted by this PR", producing
            # spurious (f)/(i) failures whenever main advances while a PR waits
            # in the queue (issue #2519 root cause).  The aggregate check below
            # (diff_only=True, head=args.head) validates the combined merged
            # tree for real deletions, so narrowing the per-PR base cannot
            # mask true deletions.
            try:
                pr_base = subprocess.run(
                    ["git", "merge-base", args.base, pr_head],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=True,
                ).stdout.strip() or args.base
            except Exception:
                pr_base = args.base
            pr_failures = evaluate_policy(
                base=pr_base,
                head=pr_head,
                title=pr.get("title") or "",
                body=pr.get("body") or "",
                labels=pr.get("labels") or [],
                diff_only=False,
                skip_stale_base=True,
            )
            for pf in pr_failures:
                failures.append(f"[PR #{pr.get('number')}] {pf}")
        # Also evaluate the aggregate queue tree so combined tree invariants hold
        agg_failures = evaluate_policy(
            base=args.base,
            head=args.head,
            title="",
            body="",
            labels=[],
            diff_only=True,
        )
        for af in agg_failures:
            failures.append(f"[merge_group aggregate] {af}")
    else:
        failures = evaluate_policy(
            base=args.base,
            head=args.head,
            title=title,
            body=body,
            labels=labels,
            diff_only=args.diff_only,
        )

    if failures:
        print("Policy gate FAILED:")
        for failure in failures:
            print("  - " + failure)
        return 1

    print(
        "Policy gate passed: linked issue, lane label, agent hashtag, "
        "CHANGELOG [Unreleased] entry or changelog.d fragment, docs scope, "
        "non-regression guards, no uncovered deletions, deprecation completeness, "
        "and process documentation line verified."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
