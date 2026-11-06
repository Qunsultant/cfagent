### Added

- **Automated PR closure watchdog (#3444):**
  - Added `.github/workflows/pr-closure-watchdog.yml` triggered on unmerged PR closures (`pull_request_target: types: [closed]`).
  - Automatically runs `scripts/ci/verify_pr_closure.py` to detect discarded functional diffs against `main`.
  - Reopens PRs that were closed with unmerged functional changes and labels them `unmerged-work-detected`.
  - Added test coverage in `tests/pr_closure_watchdog_workflow.test.ts`.
