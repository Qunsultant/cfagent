## Agent

#ceo-aimp

## Completion report (§15)

### Issue / Pull request / Integration
- Issue: #3444 — Automated PR Closure Watchdog: Prevent Unmerged Work Discard on GitHub
- PR: #3445 — merged into `main` at commit `eb71418e06970800dbd1435f4f60b7b34247c835`.

### Implementation
- **GitHub Actions Watchdog (`.github/workflows/pr-closure-watchdog.yml`)**:
  - Automatically triggered on `pull_request_target: [closed]` whenever a PR closes without merging (`github.event.pull_request.merged == false`).
  - Fetches the PR commit and base `main` tree, and executes `python3 scripts/ci/verify_pr_closure.py "$HEAD_SHA" --base origin/main --ignore-changelog --json`.
  - If unmerged functional code is detected (`exit code != 0`), it automatically posts a detailed comment on the PR outlining all discarded files, applies label `unmerged-work-detected`, and **reopens the pull request** via `gh pr reopen`.
  - If the branch was deleted prior to closure preventing reopen, it files an incident issue containing the commit SHA and instructions to salvage the delta into a new branch.
- **Workflow Pin Standards**:
  - Pinned to `runs-on: ubuntu-24.04`, permissions restricted to `contents: read`, `pull-requests: write`, `issues: write`.
- **Test Coverage**:
  - Added unit test in `tests/pr_closure_watchdog_workflow.test.ts` (6/6 passing).

### Test evidence
- `tests/pr_closure_watchdog_workflow.test.ts` (6/6 passing).
- `tests/auto_update_prs_workflow.test.ts` (374/374 passing across all worktrees).
- PR #3445 CI: Fast gates, Secret scan, Policy Gate, 4/4 Test Shards, CodeQL all green.
- Merge Queue execution verified and merged at `eb71418e`.

### Change management
- Change type: GitHub Actions CI/CD workflow, automated backstop.
- Rollback: Revert merge commit `eb71418e`.
- Changelog: `changelog.d/3444-pr-closure-watchdog.md`.

### Process docs updated
- None — workflow implementation operationalizing established gitops §11/§24 policy.

### Value and impact
- Closes the loophole where a user or agent could bypass the local pre-close script. GitHub Actions now automatically detects discarded work on unmerged PR closures and reopens the PR.

