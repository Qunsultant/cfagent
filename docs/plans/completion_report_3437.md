## Agent

#ceo-aimp

## Completion report (§15)

### Issue / Pull request / Integration
- Issue: #3437 — Anti-Work-Loss Guardrails: Diff-Before-Close Verification & Single-Lease Claiming
- PR: #3438 — merged into `main` at commit `6d7fba54196decd9bf42992da1ad71ade306dc2d`.

### Implementation
- **Diff-Before-Close Rule (§11, §24)**:
  - Added `scripts/ci/verify_pr_closure.py` and bash wrapper `scripts/verify-superseded.sh`.
  - Mechanically verifies whether candidate PRs or branches have unmerged functional code against `origin/main` before closure.
  - Exits with return code 1 if unmerged files exist, blocking premature closure and instructing the operator to either rebase or carve out the delta into a follow-up issue.
  - Supports `--ignore-changelog` for superseded fragment handling and `--allow-override` for owner emergencies.
- **Single-Lease Claiming & PR Dedup Check**:
  - Mandated that agents inspect active PRs (`gh pr list --search "<issue> in:title"`) before cutting parallel branches.
- **Policy Documentation**:
  - Updated `docs/agents/gitops.md` (§11, §24) and `AGENTS.md` (Pre-merge checklist) with explicit prohibitions against closing PRs with non-empty diffs.
- **Automated Test Coverage**:
  - Added hermetic git test suite in `tests/safe_pr_closure_workflow.test.ts` (5/5 passing) validating merged branches, unmerged branches, override flags, and changelog exclusions.

### Test evidence
- `tests/safe_pr_closure_workflow.test.ts` (5/5 passing).
- PR #3438 CI: Fast gates, Secret scan, Policy Gate, 4/4 Test Shards, CodeQL all green.
- Merge Queue integration verified and merged at `6d7fba54`.

### Change management
- Change type: Process documentation, CI verification script, test suite.
- Rollback: Revert merge commit `6d7fba54`.
- Changelog: `changelog.d/3437-anti-work-loss-guardrails.md`.

### Process docs updated
- `docs/agents/gitops.md` (§11, §24) and `AGENTS.md`.

### Value and impact
- Protects engineering effort across parallel agent operations, making work loss through unverified PR closure mechanically detectable and strictly prohibited.

