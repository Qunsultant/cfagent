### Fixed

- **#5727**: `verify_pr_closure.py` now extracts bare leading issue numbers from commit subjects (e.g. `3515 S3 batch 6: ...`) and accepts the head branch name via `--head-ref`, so a SHA invocation — as the PR Closure Watchdog makes — reaches the same superseded verdict as a branch-name invocation. (Script part only; the one-line watchdog workflow wiring follows separately.)
