<!-- Hotfix variant — use with ?template=hotfix.md on the compare URL.
GitHub shows no chooser for PR templates: the single file
.github/pull_request_template.md auto-fills every new PR body, and the
templates in .github/PULL_REQUEST_TEMPLATE/ fill the body only when
selected with the template query parameter. This variant is the urgent
production-fix shape of that default template.
Before creating the PR from the web editor, make sure the body carries:
1. An agent hashtag in the ## Agent field, in the form #<agent>-<id>.
2. A linked issue as a full reference in the form OpenAIMP/cfagent#<number>
   (no closing keyword unless the issue should actually close on merge).
3. A changelog entry: add a second file on the same patch branch at
   changelog.d/<issue>-<slug>.md (see gitops §9) — do not edit CHANGELOG.md.
The gate checks the body, not just the file.
-->
<!-- Policy Gate (i)/(j) (gitops §22) — applies to every PR, hotfix included:
- No file deleted: retire by deprecating in place and naming what
  superseded it. Pure renames pass; deletions fail with no bypass.
- Any new deprecation in code files must name what superseded it.
Emergency rules (gitops §18.2) still apply — urgency does not bypass
the gate. A merge over red needs the owner-authorized §18.1 emergency
exception, with a restore-green issue created in the same action. -->
## Agent
#<agent-hashtag>

## Summary
Urgent production fix — what is broken, and what this PR does about it:

## Type
- [x] Hotfix (`hotfix`) — urgent production fix (emergency rules, gitops §18.2, still apply)

## Linked issue
OpenAIMP/cfagent#<number> (add a closing keyword only when this PR fully resolves the issue)

## Related issues
Parent epic:
Blocks / Blocked by:
Related:
Supersedes:

## Impact
What is down or degraded, and who is affected:

## Fix
What changed, and why this is the fix (not just the symptom patch):

## Verification
How the fix was proven (red/green, production check after merge):

## Rollback plan
How to undo this PR if the fix makes things worse:

## Checklist
- [ ] Required checks green on the current merge with `main`
- [ ] Pins my change alters are updated in this PR (gitops §7)
- [ ] CHANGELOG fragment added (changelog.d/, preferred) or entry added (additive, under Unreleased)
- [ ] No file deleted in this PR (pure renames only; deprecate in place instead — gitops §22, gate check (i))
- [ ] Any new deprecation names what superseded it (gitops §22, gate check (j))
- [ ] Linked issue's completion report updated with this PR's full report
- [ ] This PR completes its linked issue in full — no follow-up PR carries the rest of this issue's work (gitops §5, issue #4072)

## Process documentation impact
Process documentation impact: <none, or what process docs this PR changes>
