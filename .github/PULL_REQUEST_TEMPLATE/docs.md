<!-- Docs / chore variant — use with ?template=docs.md on the compare URL.
GitHub shows no chooser for PR templates: the single file
.github/pull_request_template.md auto-fills every new PR body, and the
templates in .github/PULL_REQUEST_TEMPLATE/ fill the body only when
selected with the template query parameter. This variant is the
docs-only / chore shape of that default template.
Before creating the PR from the web editor, make sure the body carries:
1. An agent hashtag in the ## Agent field, in the form #<agent>-<id>.
2. A linked issue as a full reference in the form OpenAIMP/cfagent#<number>
   (a zero-touch docs-only PR is exempt from the issue-linking
   requirement — gitops §22; link the issue when one exists).
3. A changelog entry: add a second file on the same patch branch at
   changelog.d/<issue>-<slug>.md (see gitops §9) — do not edit CHANGELOG.md.
   (Zero-touch docs-only PRs are exempt from the fragment requirement
   too — gitops §22.)
The gate checks the body, not just the file.
-->
<!-- Policy Gate (i)/(j) (gitops §22) — applies to every PR:
- No file deleted: retire by deprecating in place and naming what
  superseded it. Pure renames pass; deletions fail with no bypass.
- Any new deprecation in code files must name what superseded it. -->
## Agent
#<your-agent-hashtag>

## Summary
What docs / chore change this PR makes:

## Type
- [x] Docs / Chore (no type label required)

## Linked issue
OpenAIMP/cfagent#<number> (or none for a zero-touch docs-only change — gitops §22; add a closing keyword only when this PR fully resolves the issue)

## Related issues
Parent epic:
Blocks / Blocked by:
Related:
Supersedes:

## What changed
Docs / files touched, and what changed in each:

## Verification
How the change was checked (read-through, render check — no code or tests ride in this PR):

## Checklist
- [ ] No code or tests ride in this PR (docs / chore only — a `docs(...)` title marks this PR docs-only for the gate; never use one when a code or test file rides along)
- [ ] This PR completes its linked issue in full (or none, for a zero-touch docs change — gitops §5, issue #4072)
- [ ] No file deleted in this PR (pure renames only; deprecate in place instead — gitops §22, gate check (i))
- [ ] Linked issue's completion report updated with this PR's full report (or none, for a zero-touch docs change)

## Process documentation impact
Process documentation impact: <none, or what process docs this PR changes>
