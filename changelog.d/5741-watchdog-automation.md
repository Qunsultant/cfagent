### Changed
- Automated `.github/workflows/pr-closure-watchdog.yml` and `scripts/ci/verify_pr_closure.py` (#5741):
  - Minted `AUTO_UPDATE_APP_CLIENT_ID` / `AUTO_UPDATE_APP_PRIVATE_KEY` App token before `gh pr reopen` so reopened PRs are not gated behind `action_required` ("Approve workflows to run").
  - Skipped reopening PRs labeled `superseded`, added `git cherry` patch-equivalence detection to `verify_pr_closure.py`, and auto-deleted stale same-repo head branches when safe to close.
