### Added

- Added 24-hour non-transitive tree-hash deduplication to `.github/workflows/codeql.yml` for `merge_group` commits. When `HEAD^{tree}` was already analyzed in a successful CodeQL run within 24 hours, CodeQL skips `init`, `autobuild`, and `analyze`, completing the required check in ~5 seconds and posting a deduplication audit trail to `$GITHUB_STEP_SUMMARY`.
- Added dual `workflow_run` monitoring in `.github/workflows/auto-update-prs-app.yml` for both `Continuous Integration & Test Verification` and `CodeQL`. Whichever completes last triggers immediate PR evaluation and Merge Queue enqueuing without waiting for the 5-minute recurring cron backstop.
