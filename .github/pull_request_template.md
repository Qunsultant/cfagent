<!-- Web UI single-file submits: the gate checks the body, not just the file.
Before creating the PR from the web editor, make sure the body carries:
1. An agent hashtag in the ## Agent field, in the form #<agent>-<id>
   (the lane that owns the work, e.g. the issue's lane).
2. A linked issue as a full reference in the form OpenAIMP/cfagent#<number>
   (no closing keyword unless the issue should actually close on merge).
3. A changelog entry: add a second file on the same patch branch at
   changelog.d/<issue>-<slug>.md (see gitops §9) — do not edit CHANGELOG.md.
If the gate still shows a stale failure after fixing the body, it re-runs
on body edits; a stale-base failure means update the branch to current main.
Workflow files can ONLY arrive via the web UI (the API refuses them).
-->
<!-- Policy Gate (i)/(j) (gitops §22) — applies to every PR:
- No file deleted: retire by deprecating in place and naming what
  superseded it. Pure renames pass; deletions fail with no bypass.
- Any new deprecation in code files must name what superseded it.
The gate enforces both; this note exists so you meet them before
tripping the gate. -->
## Agent
#<your-agent-hashtag>

## Summary

## Type
- [ ] Bug fix (`bug`)
- [ ] Enhancement (`enhancement`)
- [ ] Fix (`fix`)
- [ ] Hotfix (`hotfix`)
- [ ] Enterprise Architecture (`ent-arch`, `architecture`)
- [ ] Docs / Chore (no type label required)

## Linked issue
OpenAIMP/cfagent#<number> (add a closing keyword only when this PR fully resolves the issue)

## Related issues
Parent epic:
Blocks / Blocked by:
Related:
Supersedes:

## Full report
The full report for this PR — implementation, test evidence, change management, value and impact, risk, delivery, and release — lives in the linked issue's completion report (gitops §15). This PR body is a pointer, not a second record.

This PR completes its linked issue in full (gitops §5, issue #4072: one sub-issue = one PR). If the issue's work does not fit this PR, split the issue first — do not split the work across PRs.

## Checklist
- [ ] Required checks green on the current merge with `main`
- [ ] Pins my change alters are updated in this PR (gitops §7)
- [ ] UX changes use ui/ primitives and tokens only (docs/agents/ux-architecture.md §20)
- [ ] CHANGELOG fragment added (changelog.d/, preferred) or entry added (additive, under Unreleased)
- [ ] No file deleted in this PR (pure renames only; deprecate in place instead — gitops §22, gate check (i))
- [ ] Any new deprecation names what superseded it (gitops §22, gate check (j))
- [ ] Linked issue's completion report updated with this PR's full report
- [ ] This PR completes its linked issue in full — no follow-up PR carries the rest of this issue's work (gitops §5, issue #4072)
- [ ] Related issues recorded above (parent epic, blocks/blocked-by, related, supersedes — or none)
- [ ] Surfaces touched named (UX / CLI / API / MCP — or none)

## Pre-merge checklist — first-attempt merge
- [ ] Linked issue uses the full reference OpenAIMP/cfagent#<number> (a bare #N fails gate check (a); add a closing keyword only when this PR fully resolves the issue)
- [ ] Every pin file this change affects is updated in this PR, including counts in files the slice did not otherwise touch (nav counts, panel/page pins, route inventory, orchestrator budgets — gitops §7)
- [ ] PR CI green on its head, with the full check set present — a head showing only the label check after ~15 min is a dropped trigger: re-trigger (no-op push) and re-judge; never mark ready on a partial tab
- [ ] Mark ready with auto-merge on as soon as PR CI is green, and let the merge queue validate (merge_group) against current main and merge — do NOT hold the PR as a draft while main moves. Manual base-update-judge cycles are the failure mode, not the fix: the queue absorbs main movement, and gate check (f) is bypassed in merge_group mode, so a stale-but-non-conflicting branch merges via the queue
- [ ] Intervene only if the queue kicks the PR out: conflict → rebuild once (keep both blocks, fix pins, verify the stacked tree); merge_group CI failure → fix the real failure once, then re-ready
- [ ] Multiple ready + auto-merge PRs are fine — the queue serializes them. A 405 means the queue owns the merge; never force-push; rebase merges only
- [ ] Latest run per check name governs — a Cancelled run with a later Success is not a failure

## Process documentation impact
Process documentation impact: <none, or what process docs this PR changes>
