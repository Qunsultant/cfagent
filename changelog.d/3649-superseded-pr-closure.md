### Fixed

- **Safe superseded PR closure recognition (#3649):**
  - Enhanced `scripts/ci/verify_pr_closure.py` to filter byte-for-byte identical files between target and base.
  - Added issue-absorption detection: verifies whether a superseded branch's issue has already landed on `main` and all additive files exist on `main`.
  - Prevents false-alarm PR reopenings by `pr-closure-watchdog` when superseded PRs are closed.
  - Added unit test cases for superseded branches with evolved files and missing files in `tests/safe_pr_closure_workflow.test.ts`.
